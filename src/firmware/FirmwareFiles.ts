import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, opendir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { FirmwareRequest } from "../domain/firmware/firmwareAnalysis.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

/** One regular file or unpublished filesystem entry in a private extraction. */
export interface FirmwareEntry {
  readonly relativePath: string;
  readonly path: string;
  readonly size: number;
  readonly kind: "file" | "symlink" | "special";
  readonly linkTarget: string | null;
}

const throwIfFirmwareInventoryCancelled = (
  signal: AbortSignal | undefined,
  operation: string,
): void => {
  if (signal?.aborted === true) throw new AnalysisCancelledError(operation);
};

/** Hash a regular tool or extracted file without retaining its bytes in memory. */
export const hashFirmwareFile = async (
  path: string,
  options?:
    | {
        signal?: AbortSignal;
        retainFailedClose?: (owner: OwnedFileHandle) => void;
      }
    | AbortSignal,
): Promise<string> => {
  const opts =
    options instanceof AbortSignal ? { signal: options } : (options ?? {});
  return withOwnedRegularFile(
    path,
    {
      symlinks: "reject",
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.retainFailedClose !== undefined
        ? { retainFailedClose: opts.retainFailedClose }
        : {}),
    },
    async (handle) => {
      if (!(await handle.stat()).isFile())
        throw new Error(`Not a regular file: ${path}`);
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        opts.signal?.throwIfAborted();
        hash.update(chunk);
      }
      return hash.digest("hex");
    },
  );
};

/** Copy and identify the exact bytes consumed by firmware providers. */
export const snapshotFirmware = async (
  request: FirmwareRequest,
  root: string,
  signal: AbortSignal,
  retainFailedClose?: (owner: OwnedFileHandle) => void,
) => {
  const sourcePath = absoluteCallerPath(request.input.path);
  const source = await realpath(sourcePath);
  const fullPath = join(root, "firmware.bin");
  const hash = createHash("sha256");
  let size = 0;
  await withOwnedRegularFile(
    source,
    {
      symlinks: "reject",
      signal,
      ...(retainFailedClose !== undefined ? { retainFailedClose } : {}),
    },
    async (handle) => {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size === 0 ||
        stat.size > FIRMWARE_LIMITS.inputBytes
      )
        throw new AnalysisInputError(request.operation, undefined, [
          {
            path: ["path"],
            reason: "out_of_range",
            message: `Firmware must be a nonempty regular file no larger than ${FIRMWARE_LIMITS.inputBytes} bytes`,
          },
        ]);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > FIRMWARE_LIMITS.inputBytes) {
            callback(new Error("Firmware grew beyond the input byte budget"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        meter,
        createWriteStream(fullPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
    },
  );
  await chmod(fullPath, 0o400);
  const sha256 = hash.digest("hex");
  const selected =
    request.operation === "extract_firmware" ? request.input.range : undefined;
  const offset = selected?.offset ?? 0;
  const length = selected?.length ?? size;
  if (length === 0 || offset > size || length > size - offset)
    throw new AnalysisInputError(request.operation, undefined, [
      {
        path: ["range"],
        reason: "out_of_range",
        message: `Selected range must be within the ${size}-byte firmware file`,
      },
    ]);
  let inputPath = fullPath;
  if (selected !== undefined) {
    inputPath = join(root, "selected.bin");
    await pipeline(
      createReadStream(fullPath, { start: offset, end: offset + length - 1 }),
      createWriteStream(inputPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    await chmod(inputPath, 0o400);
  }
  return {
    subject: { path: sourcePath, sha256, format: "file" as const },
    size,
    inputPath,
    selection: {
      offset,
      length,
      sha256:
        selected === undefined
          ? sha256
          : await hashFirmwareFile(inputPath, {
              signal,
              ...(retainFailedClose !== undefined ? { retainFailedClose } : {}),
            }),
    },
  };
};

/** Read a complete bounded report; oversized data is never reported as complete. */
export const readFirmwareReport = async (
  path: string,
  operation: string,
  options?: {
    signal?: AbortSignal;
    retainFailedClose?: (owner: OwnedFileHandle) => void;
  },
): Promise<unknown> => {
  return withOwnedRegularFile(
    path,
    {
      symlinks: "reject",
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.retainFailedClose !== undefined
        ? { retainFailedClose: options.retainFailedClose }
        : {}),
    },
    async (handle) => {
      if (!(await handle.stat()).isFile())
        throw new AnalysisOutputError(
          operation,
          "Report is not a regular file",
        );
      const bytes = await readBoundedFileBytes(
        handle,
        FIRMWARE_LIMITS.reportBytes,
        options?.signal,
      );
      if (bytes === undefined)
        throw new AnalysisOutputError(
          operation,
          `Report exceeded ${FIRMWARE_LIMITS.reportBytes} bytes`,
        );
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            bytes,
          ),
        );
        return value;
      } catch (cause: unknown) {
        throw new AnalysisOutputError(
          operation,
          "Tool report is not valid complete JSON",
          { cause },
        );
      }
    },
  );
};

/** Inventory private output without following links, enforcing aggregate staging budgets. */
export const inventoryFirmwareOutput = async (
  root: string,
  maxBytes: number,
  maxEntries: number,
  operation: string,
  signal?: AbortSignal,
): Promise<FirmwareEntry[]> => {
  const entries: FirmwareEntry[] = [];
  const pending = [root];
  let bytes = 0;
  let count = 0;
  while (pending.length > 0) {
    throwIfFirmwareInventoryCancelled(signal, operation);
    const directory = pending.pop();
    if (directory === undefined) break;
    const directoryStat = await lstat(directory).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return undefined;
      throw cause;
    });
    if (
      directoryStat === undefined ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink()
    )
      continue;
    const handle = await opendir(directory).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return undefined;
      throw cause;
    });
    if (handle === undefined) continue;
    const names: string[] = [];
    for await (const entry of handle) {
      throwIfFirmwareInventoryCancelled(signal, operation);
      count++;
      if (count > maxEntries)
        throw new AnalysisOutputError(
          operation,
          `Staging entry budget exceeded (${maxEntries})`,
        );
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      const path = join(directory, name);
      const stat = await lstat(path).catch((cause: unknown) => {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return undefined;
        throw cause;
      });
      if (stat === undefined) continue;
      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (stat.isFile()) bytes += stat.size;
      if (bytes > maxBytes)
        throw new AnalysisOutputError(
          operation,
          `Staging byte budget exceeded (${maxBytes})`,
        );
      entries.push({
        path,
        relativePath: relative(root, path).split(sep).join("/"),
        size: stat.size,
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : "special",
        linkTarget: stat.isSymbolicLink() ? await readlink(path) : null,
      });
    }
  }
  return entries.sort((a, b) =>
    compareUnicodeCodePoints(a.relativePath, b.relativePath),
  );
};

/** Bind producer paths to the selected input or private extraction tree. */
export const firmwareLogicalPath = (
  path: string,
  inputPath: string,
  outputRoot: string,
): string => {
  if (path === inputPath) return "$input";
  const rel = relative(outputRoot, path);
  if (
    !isAbsolute(path) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new AnalysisOutputError(
      "extract_firmware",
      `Provider reported a path outside its owned output: ${path}`,
    );
  return rel === "" ? "$output" : `$output/${rel.split(sep).join("/")}`;
};
