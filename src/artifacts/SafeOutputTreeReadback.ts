import { createHash } from "node:crypto";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { streamChunkToBuffer } from "./StreamBytes.js";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  assertFilePathIdentity,
  readFileIdentity,
  type FileIdentity,
} from "./SafeOutputTreeIdentity.js";

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const isCancellationError = (cause: unknown, signal?: AbortSignal): boolean => {
  if (isAborted(signal) && cause === signal?.reason) return true;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return true;
  if (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.message.includes("aborted"))
  )
    return true;
  return false;
};

const cancellationFailure = (signal?: AbortSignal, cause?: unknown) =>
  new ArtifactReaderFailure("cancelled", "Artifact extraction cancelled", {
    cause: signal?.reason ?? cause,
  });

/** Hash one retained readback descriptor and confirm it still names the output file. */
export const hashOutputFile = async (
  owner: OwnedFileHandle,
  path: string,
  identity: FileIdentity,
  options: {
    readonly maximum: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<{ readonly sha256: string; readonly bytes: number }> => {
  if (isAborted(options.signal)) throw cancellationFailure(options.signal);
  const admittedIdentity = await readFileIdentity(owner.handle, path);
  await assertFilePathIdentity(path, identity);
  if (
    admittedIdentity.dev !== identity.dev ||
    admittedIdentity.ino !== identity.ino
  )
    throw new ArtifactReaderFailure(
      "path",
      `Extraction file identity changed: ${path}`,
    );
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of readFileHandleChunks(owner.handle, options)) {
      if (isAborted(options.signal)) throw cancellationFailure(options.signal);
      const chunk = streamChunkToBuffer(raw);
      bytes += chunk.length;
      if (bytes > options.maximum)
        throw new ArtifactReaderFailure(
          "integrity",
          "Readback exceeded the bytes written",
        );
      hash.update(chunk);
    }
  } catch (cause: unknown) {
    if (isCancellationError(cause, options.signal))
      throw cancellationFailure(options.signal, cause);
    throw cause;
  }
  if (isAborted(options.signal)) throw cancellationFailure(options.signal);
  await assertFilePathIdentity(path, identity);
  if (isAborted(options.signal)) throw cancellationFailure(options.signal);
  return { sha256: hash.digest("hex"), bytes };
};
