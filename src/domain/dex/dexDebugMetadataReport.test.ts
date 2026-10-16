import { describe, expect, it } from "vitest";

import {
  type DexDebugMetadataResult,
  dexReportMatchesSelection,
} from "./dexDebugMetadataReport.js";

const base = {
  artifact: { path: "/a/app.apk", sha256: "0".repeat(64), bytes: 1 },
  container: "apk",
  runtime_execution: "not-performed",
  limitations: [],
} as const;

const summary = (entries: string[]): DexDebugMetadataResult =>
  ({
    ...base,
    mode: "summary",
    members: entries.map((entry) => ({ entry })),
    class_detail: null,
  }) as unknown as DexDebugMetadataResult;

const detail = (
  entry: string | null,
  descriptor: string,
): DexDebugMetadataResult =>
  ({
    ...base,
    mode: "class-detail",
    members: [],
    class_detail: { entry, descriptor, source_file: null, methods: [] },
  }) as unknown as DexDebugMetadataResult;

describe("dexReportMatchesSelection", () => {
  it("accepts a report that answers exactly the requested selection", () => {
    expect(
      dexReportMatchesSelection(summary(["classes.dex", "classes2.dex"]), {}),
    ).toBe(true);
    expect(
      dexReportMatchesSelection(summary(["classes2.dex"]), {
        entry: "./classes2.dex",
      }),
    ).toBe(true);
    expect(
      dexReportMatchesSelection(detail("classes.dex", "LFoo;"), {
        entry: "classes.dex",
        class_descriptor: "LFoo;",
      }),
    ).toBe(true);
  });

  it("rejects a different mode, class, or member than requested", () => {
    expect(
      dexReportMatchesSelection(summary(["classes.dex"]), {
        class_descriptor: "LFoo;",
      }),
    ).toBe(false);
    expect(
      dexReportMatchesSelection(detail(null, "LBar;"), {
        class_descriptor: "LFoo;",
      }),
    ).toBe(false);
    expect(
      dexReportMatchesSelection(summary(["classes3.dex"]), {
        entry: "classes2.dex",
      }),
    ).toBe(false);
    expect(
      dexReportMatchesSelection(detail("classes3.dex", "LFoo;"), {
        entry: "classes2.dex",
        class_descriptor: "LFoo;",
      }),
    ).toBe(false);
  });
});

describe("archive member identity", () => {
  it("keeps backslashes and a leading slash as part of the stored name", () => {
    expect(
      dexReportMatchesSelection(summary(["dir/classes.dex"]), {
        entry: "dir\\classes.dex",
      }),
    ).toBe(false);
    expect(
      dexReportMatchesSelection(summary(["dir\\classes.dex"]), {
        entry: "dir\\classes.dex",
      }),
    ).toBe(true);
    expect(
      dexReportMatchesSelection(summary(["classes2.dex"]), {
        entry: "/classes2.dex",
      }),
    ).toBe(false);
  });
});
