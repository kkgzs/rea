import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  inventoryFirmwareOutput,
  readFirmwareReport,
} from "../../../src/firmware/FirmwareFiles.js";
import { readFirmwareCommandReport } from "../../../src/firmware/FirmwareCommand.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { RegularFileCleanupFailure } from "../../../src/filesystem/OwnedRegularFile.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["invalid leading byte", [0xff]],
  ["incomplete sequence", [0xe2, 0x82]],
  ["overlong sequence", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
])(
  "rejects complete JSON containing %s without repairing producer bytes",
  async (_name, bytes) => {
    const root = await createTestTempDirectory("rea-firmware-report-");
    const path = join(root, "report.json");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from('{"description":"'),
        Buffer.from(bytes),
        Buffer.from('"}'),
      ]),
    );
    await expect(
      readFirmwareReport(path, "inspect_firmware_regions"),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "Tool report is not valid complete JSON",
    });
  },
);

it("preserves valid Unicode and a literal replacement character in producer JSON", async () => {
  const root = await createTestTempDirectory("rea-firmware-report-");
  const path = join(root, "report.json");
  const report = { description: "固件 🧩 \ufffd", path: "/输入/firmware.bin" };
  await writeFile(path, JSON.stringify(report));
  expect(await readFirmwareReport(path, "inspect_firmware_regions")).toEqual(
    report,
  );
});

it("orders extracted firmware paths by code point independently of host locale", async () => {
  const root = await createTestTempDirectory("rea-firmware-inventory-");
  await mkdir(join(root, "Lib"));
  for (const path of ["a.bin", "z.bin", "\u00e4.bin", "B.bin", "Lib/x.bin"])
    await writeFile(join(root, path), "");
  const entries = await inventoryFirmwareOutput(
    root,
    1024,
    16,
    "inspect_firmware_regions",
  );
  // Locale collation would interleave case and place "ä" by language rules.
  expect(entries.map(({ relativePath }) => relativePath)).toEqual([
    "B.bin",
    "Lib/x.bin",
    "a.bin",
    "z.bin",
    "\u00e4.bin",
  ]);
});

it("preserves completed report and yields retained descriptor when handle close fails", async () => {
  const root = await createTestTempDirectory("rea-firmware-report-close-");
  const path = join(root, "report.json");
  const report = { description: "valid", regions: [1, 2, 3] };
  await writeFile(path, JSON.stringify(report));

  const closeCause = new Error("injected report close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  const retained: OwnedFileHandle[] = [];

  const closeSpy = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });

  try {
    let failure: unknown;
    try {
      await readFirmwareReport(path, "inspect_firmware_regions", {
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    expect(retained).toHaveLength(1);
    if (!(failure instanceof RegularFileCleanupFailure)) {
      throw new Error("Expected RegularFileCleanupFailure");
    }
    expect(failure.outcome).toEqual({
      kind: "completed",
      value: report,
    });
    expect(failure.cleanupCause).toBe(closeCause);
    expect(failure.retention).toEqual({ kind: "callback_returned" });
    expect(failure.owner).toBe(retained[0]);
  } finally {
    closeSpy.mockRestore();
    if (retained[0] !== undefined && retained[0].handle.fd >= 0) {
      await originalClose.call(retained[0]);
    }
  }
});

it("transforms completed report close failure into ProviderCleanupError retaining output and resources", async () => {
  const root = await createTestTempDirectory("rea-firmware-cmd-close-");
  const path = join(root, "report.json");
  const report = [{ offset: 0, description: "header" }];
  await writeFile(path, JSON.stringify(report));

  const closeCause = new Error("injected report close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  const retained: OwnedFileHandle[] = [];

  const closeSpy = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });

  try {
    let failure: unknown;
    try {
      await readFirmwareCommandReport({
        path,
        engine: "binwalk",
        operation: "inspect_firmware_regions",
        execution: {
          exit_code: 0,
          signal: null,
          stdout: { bytes: 0, text: "", observedBytes: 0 },
          stderr: { bytes: 0, text: "", observedBytes: 0 },
          command: "/usr/bin/true",
          args: [],
          resource_limiter: "/usr/bin/prlimit",
        },
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }

    expect(retained).toHaveLength(1);
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [path],
      completedReport: report,
    });
  } finally {
    closeSpy.mockRestore();
    if (retained[0] !== undefined && retained[0].handle.fd >= 0) {
      await originalClose.call(retained[0]);
    }
  }
});

it("composes primary report failure and handle close failure when both fail", async () => {
  const root = await createTestTempDirectory("rea-firmware-cmd-double-fault-");
  const path = join(root, "report.json");
  await writeFile(path, "{ invalid json");

  const closeCause = new Error("injected report close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  const retained: OwnedFileHandle[] = [];

  const closeSpy = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });

  try {
    let failure: unknown;
    try {
      await readFirmwareCommandReport({
        path,
        engine: "binwalk",
        operation: "inspect_firmware_regions",
        execution: {
          exit_code: 0,
          signal: null,
          stdout: { bytes: 0, text: "", observedBytes: 0 },
          stderr: { bytes: 0, text: "", observedBytes: 0 },
          command: "/usr/bin/true",
          args: [],
          resource_limiter: "/usr/bin/prlimit",
        },
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }

    expect(retained).toHaveLength(1);
    const projected = projectAnalysisError(failure as never);
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          primary_error: { code: "unreadable_output" },
          cleanup_error: {
            code: "cleanup_incomplete",
            details: {
              diagnostics: { reason: "injected report close failure" },
            },
          },
        },
        resources: [path],
      },
    });
  } finally {
    closeSpy.mockRestore();
    if (retained[0] !== undefined && retained[0].handle.fd >= 0) {
      await originalClose.call(retained[0]);
    }
  }
});
