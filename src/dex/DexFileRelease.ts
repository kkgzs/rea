/** Identity of REA's in-process DEX reader (no external engine, no device). */
export const DEX_PROVIDER_IDENTITY = {
  id: "dex-file",
  name: "REA DEX reader",
  version: null,
} as const;

export const DEX_LIMITS = {
  /** A single `.dex` far exceeding this is rejected before allocation (real dex ~tens of MiB). */
  inputBytes: 64 * 1024 * 1024,
  /** Ceiling on a selected APK/ZIP's size (its digest is streamed, not retained). */
  archiveBytes: 512 * 1024 * 1024,
  /** Ceiling on an archive's central-directory metadata read. */
  archiveMetadataBytes: 16 * 1024 * 1024,
  /** Inline result ceiling; a decoded result past this is refused, not truncated. */
  outputBytes: 8 * 1024 * 1024,
  /** Cap on auto-loaded multidex members summarized for an archive; refuse past it. */
  maxDexMembers: 64,
  /**
   * Work units (debug opcodes, parameter-name reads, class_data entries walked)
   * allowed per member, per byte of that member. Each opcode, encoded_field and
   * encoded_method is at least one byte, class_data is walked twice, and a debug
   * stream is decoded once per distinct (stream, register layout, proto)
   * combination. Compiler output shares a stream only across identical layouts,
   * so real DEX members measure at most ~0.45 units per byte (R8 release) while
   * work stays bounded by the member's size; a crafted file that re-decodes one
   * long stream under many layouts is refused rather than run unbounded.
   */
  workUnitsPerByte: 2,
  /** Floor for the per-member budget, so a tiny member is not over-constrained. */
  minWorkUnits: 1024 * 1024,
} as const;
