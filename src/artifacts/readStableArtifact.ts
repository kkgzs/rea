import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

/** Filesystem boundary for stable reads, including deterministic replacement probes. */
export interface StableArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};

const afterValidation = async <T>(
  path: string,
  stage: string,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed ${stage}: ${path}`,
        { cause },
      );
    throw cause;
  }
};

const assertReadActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted)
    throw new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
      cause: signal.reason,
    });
};

/**
 * The descriptor must be the regular file the path named when it was
 * validated: a replacement between `lstat` and `open` is refused.
 */
const openedIdentity = async (
  file: FileHandle,
  before: BigIntStats,
  path: string,
): Promise<BigIntStats> => {
  const initial = await file.stat({ bigint: true });
  if (
    !initial.isFile() ||
    initial.dev !== before.dev ||
    initial.ino !== before.ino
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact changed before open: ${path}`,
    );
  return initial;
};

/**
 * Read only the leading bytes of a regular file, independent of its total size,
 * to sniff a container magic before deciding how to read the whole artifact. A
 * large archive must be classifiable without first admitting it under a
 * single-file byte budget. Uses the same no-symlink, no-follow open as
 * {@link readStableArtifact}; returns fewer bytes when the file is shorter.
 */
export const peekArtifactMagic = async (
  path: string,
  byteCount: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<Buffer> => {
  assertReadActive(signal);
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
    );
  const file = await afterValidation(path, "before open", () =>
    fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  // With a caller scope, a failed close is retained there for retry instead
  // of being lost with this stack frame.
  const owner =
    resourceScope === undefined ? undefined : new OwnedFileHandle(file);
  let failure: unknown;
  try {
    await openedIdentity(file, before, path);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await file.read(buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead);
  } catch (cause: unknown) {
    failure = cause;
    throw cause;
  } finally {
    if (owner === undefined || resourceScope === undefined) await file.close();
    else {
      const cleanup = await resourceScope.release({
        kind: "file-handle",
        resource: path,
        handle: owner,
      });
      if (cleanup.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          failure ?? cleanup.cause,
          ArtifactReaderFailure.cleanupObservation(cleanup.cause, path),
        );
    }
  }
};

/** Read one bounded regular file and reject replacement or in-place changes. */
export const readStableArtifact = async (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<{ readonly bytes: Buffer; readonly sha256: string }> => {
  assertReadActive(signal);
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
    );
  if (before.size > BigInt(maximumBytes))
    throw new ArtifactReaderFailure(
      "limit",
      `Selected artifact exceeds ${String(maximumBytes)} bytes: ${path}`,
    );
  const file = await afterValidation(path, "before open", () =>
    fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  const owner =
    resourceScope === undefined ? undefined : new OwnedFileHandle(file);
  let failure: unknown;
  try {
    const initial = await openedIdentity(file, before, path);
    const chunks: Buffer[] = [];
    let count = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 65536,
    })) {
      assertReadActive(signal);
      const value: unknown = chunk;
      if (!Buffer.isBuffer(value))
        throw new ArtifactReaderFailure(
          "format",
          `Artifact stream did not return bytes: ${path}`,
        );
      const bytes = value;
      count += bytes.length;
      if (count > maximumBytes)
        throw new ArtifactReaderFailure(
          "limit",
          `Selected artifact grew beyond its byte limit: ${path}`,
        );
      chunks.push(bytes);
    }
    const after = await file.stat({ bigint: true });
    const current = await afterValidation(path, "during read", () =>
      fileSystem.lstat(path),
    );
    if (
      [after, current].some(
        (stat) =>
          !stat.isFile() ||
          stat.dev !== initial.dev ||
          stat.ino !== initial.ino ||
          stat.size !== initial.size ||
          stat.mtimeNs !== initial.mtimeNs ||
          stat.ctimeNs !== initial.ctimeNs,
      ) ||
      BigInt(count) !== initial.size
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed during read: ${path}`,
      );
    assertReadActive(signal);
    const bytes = Buffer.concat(chunks, count);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (cause: unknown) {
    failure = cause;
    throw cause;
  } finally {
    if (owner === undefined || resourceScope === undefined) await file.close();
    else {
      const cleanup = await resourceScope.release({
        kind: "file-handle",
        resource: path,
        handle: owner,
      });
      if (cleanup.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          failure ?? cleanup.cause,
          ArtifactReaderFailure.cleanupObservation(cleanup.cause, path),
        );
    }
  }
};
