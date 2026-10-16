import { createHash } from "node:crypto";
import {
  lstat,
  open,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads exact binary and empty bytes and rejects symlink/size/cancellation boundaries", async () => {
  const root = await createTestTempDirectory("rea-stable-artifact-");
  const path = join(root, "source.bin");
  await writeFile(path, Buffer.from([0, 255, 254]));
  expect((await readStableArtifact(path, 3)).bytes).toEqual(
    Buffer.from([0, 255, 254]),
  );
  await expect(readStableArtifact(path, 2)).rejects.toMatchObject({
    reason: "limit",
  });
  await writeFile(path, "");
  expect((await readStableArtifact(path, 0)).bytes.length).toBe(0);
  const real = join(root, "original.bin");
  await rename(path, real);
  await symlink(real, path);
  await expect(readStableArtifact(path, 3)).rejects.toMatchObject({
    reason: "path",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    readStableArtifact(real, 3, controller.signal),
  ).rejects.toMatchObject({
    reason: "cancelled",
    cause: controller.signal.reason,
  });
});

const checkChange = async (
  stage: "before-open" | "after-read" | "symlink-replacement",
): Promise<void> => {
  const root = await createTestTempDirectory("rea-stable-read-");
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  const reading = readStableArtifact(path, 1024, undefined, {
    async lstat(selected) {
      inspected++;
      if (stage === "after-read" && inspected === 2) await unlink(selected);
      const metadata = await lstat(selected, { bigint: true });
      if (inspected === 1 && stage !== "after-read") {
        await unlink(selected);
        if (stage === "symlink-replacement") await symlink("missing", selected);
      }
      return metadata;
    },
    open,
  });
  await expect(reading).rejects.toMatchObject({ reason: "integrity" });
};

it.each(["before-open", "after-read"] as const)(
  "retains an actual post-validation %s change as integrity failure",
  checkChange,
);

it.skipIf(process.platform === "win32")(
  "retains a post-validation symlink replacement as an integrity failure",
  () => checkChange("symlink-replacement"),
);

it("keeps initially missing inputs distinguishable from later changes", async () => {
  const root = await createTestTempDirectory("rea-stable-missing-");
  await expect(
    readStableArtifact(join(root, "missing"), 1024),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  { kind: "completed", primary: undefined },
  { kind: "primary-error", primary: new Error("controlled read rejection") },
  { kind: "undefined-failure", primary: undefined },
  { kind: "null-failure", primary: null },
] as const)(
  "retains the %s operation outcome when an unscoped close rejects",
  async ({ kind, primary }) => {
    const root = await createTestTempDirectory("rea-stable-close-");
    const path = join(root, "input.bin");
    await writeFile(path, "caller-selected evidence");
    const handle = await open(path, "r");
    const nativeClose = handle.close.bind(handle);
    const closeFailure = new Error("controlled close rejection");
    let closeAttempts = 0;
    handle.close = async () => {
      closeAttempts += 1;
      throw closeFailure;
    };
    if (kind !== "completed") {
      const nativeStat = handle.stat.bind(handle);
      let statCalls = 0;
      handle.stat = (async (...arguments_) => {
        statCalls += 1;
        if (statCalls === 2) throw primary;
        return nativeStat(...arguments_);
      }) as typeof handle.stat;
    }

    try {
      const failure = await readStableArtifact(path, 1024, undefined, {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async () => handle,
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure)) return;
      expect(failure.owner).toBeInstanceOf(OwnedFileHandle);
      expect(failure.owner?.handle).toBe(handle);
      expect(failure.cleanup).toEqual({
        reason: closeFailure.message,
        resources: [path],
      });
      expect(failure.outcome).toEqual(
        kind === "completed"
          ? {
              kind: "completed",
              value: {
                bytes: Buffer.from("caller-selected evidence"),
                sha256: createHash("sha256")
                  .update("caller-selected evidence")
                  .digest("hex"),
              },
            }
          : { kind: "failed", cause: primary },
      );
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      handle.close = nativeClose;
      await failure.owner?.close();
      expect(handle.fd).toBe(-1);
      expect(closeAttempts).toBe(1);
    } finally {
      handle.close = nativeClose;
      if (handle.fd >= 0) await nativeClose();
    }
  },
);

it("retains a scoped owner for close retry", async () => {
  const root = await createTestTempDirectory("rea-stable-scoped-close-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const handle = await open(path, "r");
  const nativeClose = handle.close.bind(handle);
  const closeFailure = new Error("controlled scoped close rejection");
  let closeAttempts = 0;
  handle.close = async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw closeFailure;
    return nativeClose();
  };
  const scope = new ArtifactResourceScope();
  try {
    const failure = await readStableArtifact(
      path,
      1024,
      undefined,
      {
        lstat: (selected) => lstat(selected, { bigint: true }),
        open: async () => handle,
      },
      scope,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure)) return;
    expect(failure.owner?.handle).toBe(handle);
    expect(failure.outcome?.kind).toBe("completed");
    expect(failure.cleanup).toEqual({
      reason: closeFailure.message,
      resources: [path],
    });
    expect(scope.hasPending).toBe(true);
    await expect(scope.close()).resolves.toBeUndefined();
    expect(scope.hasPending).toBe(false);
    expect(handle.fd).toBe(-1);
    expect(closeAttempts).toBeGreaterThanOrEqual(2);
  } finally {
    handle.close = nativeClose;
    if (handle.fd >= 0) await nativeClose();
    await scope.close().catch(() => undefined);
  }
});

it("retains completed bytes when cancellation arrives during close", async () => {
  const root = await createTestTempDirectory("rea-stable-close-cancel-");
  const path = join(root, "input.bin");
  await writeFile(path, "caller-selected evidence");
  const handle = await open(path, "r");
  const nativeClose = handle.close.bind(handle);
  const controller = new AbortController();
  const reason = new Error("cancelled during close");
  handle.close = async () => {
    controller.abort(reason);
    return nativeClose();
  };
  try {
    const failure = await readStableArtifact(path, 1024, controller.signal, {
      lstat: (selected) => lstat(selected, { bigint: true }),
      open: async () => handle,
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      reason: "cancelled",
      cause: reason,
      outcome: { kind: "completed" },
    });
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(handle.fd).toBe(-1);
  } finally {
    handle.close = nativeClose;
    if (handle.fd >= 0) await nativeClose();
  }
});
