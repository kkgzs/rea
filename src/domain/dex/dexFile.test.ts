import { describe, expect, it } from "vitest";

import {
  DEX_NO_INDEX,
  readClassDef,
  walkClassData,
  parseCodeItem,
  parseDexFile,
} from "./dexFile.js";

/**
 * Assemble a minimal valid DEX with one class carrying one direct method whose
 * code_item references a debug_info_item. Layout (little-endian):
 *   header[0x70] | class_def[32] @0x70 | code_item[16] @0x90 | class_data @0xA0
 * The id pools are empty (size 0); framing never resolves their contents.
 */
const CLASS_DEFS_OFF = 0x70;
const CODE_ITEM_OFF = 0x90;
const CLASS_DATA_OFF = 0xa0;
const DEBUG_INFO_OFF = 500; // sentinel; framing reads the field, never follows it

const uleb = (value: number): number[] => {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
};

const minimalDex = (version = "035"): Uint8Array => {
  const classData = [
    ...uleb(0), // static_fields_size
    ...uleb(0), // instance_fields_size
    ...uleb(1), // direct_methods_size
    ...uleb(0), // virtual_methods_size
    ...uleb(0), // method_idx_diff
    ...uleb(1), // access_flags
    ...uleb(CODE_ITEM_OFF), // code_off
  ];
  const total = CLASS_DATA_OFF + classData.length;
  const bytes = new Uint8Array(total);
  const dv = new DataView(bytes.buffer);
  // magic
  bytes.set([0x64, 0x65, 0x78, 0x0a], 0); // "dex\n"
  bytes.set(
    [...version].map((c) => c.charCodeAt(0)),
    4,
  );
  bytes[7] = 0x00;
  dv.setUint32(32, total, true); // file_size
  dv.setUint32(36, 0x70, true); // header_size
  dv.setUint32(40, 0x12345678, true); // endian_tag
  dv.setUint32(96, 1, true); // class_defs_size
  dv.setUint32(100, CLASS_DEFS_OFF, true); // class_defs_off
  // class_def_item @ 0x70
  dv.setUint32(CLASS_DEFS_OFF + 0, 0, true); // class_idx
  dv.setUint32(CLASS_DEFS_OFF + 4, 1, true); // access_flags
  dv.setUint32(CLASS_DEFS_OFF + 8, DEX_NO_INDEX, true); // superclass_idx
  dv.setUint32(CLASS_DEFS_OFF + 16, 0, true); // source_file_idx -> string 0
  dv.setUint32(CLASS_DEFS_OFF + 24, CLASS_DATA_OFF, true); // class_data_off
  // code_item @ 0x90
  dv.setUint16(CODE_ITEM_OFF + 0, 2, true); // registers_size
  dv.setUint16(CODE_ITEM_OFF + 2, 1, true); // ins_size
  dv.setUint16(CODE_ITEM_OFF + 4, 0, true); // outs_size
  dv.setUint16(CODE_ITEM_OFF + 6, 0, true); // tries_size
  dv.setUint32(CODE_ITEM_OFF + 8, DEBUG_INFO_OFF, true); // debug_info_off
  dv.setUint32(CODE_ITEM_OFF + 12, 0, true); // insns_size
  // class_data_item @ 0xA0
  bytes.set(classData, CLASS_DATA_OFF);
  return bytes;
};

describe("parseDexFile framing", () => {
  it("frames the header and a class_def with its source-file index", () => {
    const result = parseDexFile(minimalDex());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.header.version).toBe("035");
    expect(result.value.header.classDefsSize).toBe(1);
    const def = readClassDef(minimalDex(), result.value.header, 0);
    expect(def.sourceFileIdx).toBe(0);
    expect(def.superclassIdx).toBe(DEX_NO_INDEX);
    expect(def.classDataOff).toBe(CLASS_DATA_OFF);
  });

  it("decodes the class_data method list and reaches the code item's debug_info_off", () => {
    const bytes = minimalDex();
    const methods: { codeOff: number }[] = [];
    const data = walkClassData(
      bytes,
      CLASS_DATA_OFF,
      () => true,
      (m) => {
        methods.push(m);
        return true;
      },
    );
    expect(data).toEqual({ ok: true, value: { methodCount: 1 } });
    expect(methods).toHaveLength(1);
    const method = methods[0]!;
    expect(method.codeOff).toBe(CODE_ITEM_OFF);
    const code = parseCodeItem(bytes, method.codeOff);
    expect(code.ok).toBe(true);
    if (!code.ok) return;
    expect(code.value.debugInfoOff).toBe(DEBUG_INFO_OFF);
    expect(code.value.insnsSize).toBe(0);
  });

  it("refuses a file_size that disagrees with the buffer, as ART does", () => {
    const bytes = minimalDex();
    new DataView(bytes.buffer).setUint32(32, 999999, true);
    const result = parseDexFile(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "bad-header", offset: 32 });
  });

  it("refuses a non-dex buffer as bad-magic", () => {
    const bytes = minimalDex();
    bytes[1] = 0x00;
    const result = parseDexFile(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad-magic");
  });

  it("refuses compact dex (cdex) with its own reason", () => {
    const bytes = minimalDex();
    bytes.set([0x63, 0x64, 0x65, 0x0a], 0); // "cde\n"
    const result = parseDexFile(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("compact-dex");
  });

  it("refuses a reverse-endian file distinctly from an unsupported version", () => {
    const bytes = minimalDex();
    new DataView(bytes.buffer).setUint32(40, 0x78563412, true);
    const result = parseDexFile(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("reverse-endian");
  });

  it("refuses a withdrawn/future version (036, 041)", () => {
    for (const v of ["036", "041"]) {
      const result = parseDexFile(minimalDex(v));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("unsupported-version");
    }
  });

  it("reports truncation rather than throwing on a short header", () => {
    const result = parseDexFile(new Uint8Array(16));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("truncated");
  });

  it("refuses an impossible class_defs count instead of allocating", () => {
    const bytes = minimalDex();
    new DataView(bytes.buffer).setUint32(96, 0xffff, true); // class_defs_size
    const result = parseDexFile(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("budget-exceeded");
  });
});

describe("parseClassData bounds", () => {
  /** class_data at offset 1: field/method counts, then filler bytes. */
  const classData = (fields: number, filler: number): Uint8Array =>
    Uint8Array.from([
      0xff,
      ...uleb(fields),
      ...uleb(0),
      ...uleb(0),
      ...uleb(0),
      ...Array.from({ length: filler }, () => 0),
    ]);

  it("refuses a field count that cannot fit before walking it", () => {
    const result = walkClassData(classData(1_000_000, 64), 1, () => true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "budget-exceeded",
      resource: "class-data",
    });
  });

  it("charges every skipped field to the caller's work and stops when spent", () => {
    let units = 3;
    const result = walkClassData(classData(10, 64), 1, () => units-- > 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: "budget-exceeded",
      resource: "work",
    });
  });
});

describe("walkClassData streaming", () => {
  it("validates without a visitor and lets a visitor stop early", () => {
    const methods = 5;
    const data = Uint8Array.from([
      0xff,
      ...uleb(0),
      ...uleb(0),
      ...uleb(methods),
      ...uleb(0),
      ...Array.from({ length: methods }, () => [
        ...uleb(1),
        ...uleb(1),
        ...uleb(0),
      ]).flat(),
    ]);
    expect(walkClassData(data, 1, () => true)).toEqual({
      ok: true,
      value: { methodCount: methods },
    });
    let seen = 0;
    const stopped = walkClassData(
      data,
      1,
      () => true,
      () => ++seen < 2,
    );
    expect(stopped.ok).toBe(true);
    expect(seen).toBe(2);
  });
});
