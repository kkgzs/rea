import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { RustBinaryProvider } from "../../../src/rust/RustBinaryProvider.js";
import { createRustImage } from "../../fixtures/rust/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains a failed artifact close under the Rust provider lifetime", async () => {
  const root = await createTestTempDirectory("rea-rust-provider-close-");
  const path = join(root, "image.bin");
  await writeFile(path, createRustImage({ format: "elf" }));
  const closeFailure = new Error("controlled Rust artifact close failure");
  let retained: OwnedFileHandle | undefined;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedFileHandle) {
      retained = this;
      throw closeFailure;
    });
  const provider = new RustBinaryProvider();
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [path],
      cleanup: { resources: [path] },
    });
    expect(retained?.handle.fd).toBeGreaterThanOrEqual(0);

    close.mockRestore();
    await expect(provider.close()).resolves.toBeUndefined();
    expect(retained?.handle.fd).toBe(-1);
  } finally {
    close.mockRestore();
    await provider.close().catch(() => undefined);
    if (retained !== undefined && retained.handle.fd >= 0)
      await retained.handle.close();
  }
});
