# Android DEX debug metadata

REA reads compiler-emitted debug metadata from a selected local Android DEX so an
analyst can judge **debugging readiness before attaching a debugger or reading a
decompilation**. The reader is in-process and dependency-free: it decodes the
DEX `debug_info_item` and string/type pools only, never executes Android code,
never involves a device or `adb`, and refuses device-optimized formats
(`odex`/`vdex`/`oat`/`cdex`). Acquisition from a device is the existing
`pull_adb_*` tools' job — this tool reads a caller-selected local file.

CLI and MCP share one workflow and return artifact-bound Evidence inline.

## Answer an analyst question

```sh
# Summarize debug readiness across the DEX members an APK auto-loads:
rea inspect-dex-debug-metadata /path/app.apk
# A standalone .dex:
rea inspect-dex-debug-metadata /path/classes.dex
# Select one dex member inside the archive:
rea inspect-dex-debug-metadata /path/app.apk --entry classes2.dex
# Drill into one class for full per-method detail:
rea inspect-dex-debug-metadata /path/classes.dex --class-descriptor 'Lcom/example/Service;'
```

## Two output modes

Unlike a JVM `.class` (one class), a DEX holds thousands of classes, so the tool
works at two granularities:

- **Summary (default).** One entry per DEX member (for an APK, the members
  Android auto-loads: `classes.dex`, `classes2.dex`, … up to the first missing
  name; select any other `.dex` with `entry`). Each reports `dex_version`, `class_count`, method tallies
  (`methods_with_code`, `methods_with_debug_info`, `methods_with_parameter_names`),
  `line_positions`, `local_declarations`, `explicit_local_declarations`,
  `set_file_events`, `source_file_present`,
  `distinct_source_files` (count + bounded sample), and a derived `readiness`.
- **Per-class detail (`--class-descriptor Lpkg/Name;`).** Full per-method
  `name`, JVM-form `descriptor`, `state`, and `locals` (name, type, signature,
  `register`, scope `start_address`/`end_address` in 16-bit code units,
  `out_of_range`), with parameter names. The implicit `this` and the method's
  parameters are reported as locals, exactly as `dexdump` does.

## Readiness is a derived label

`readiness` is a conservative label over what the debug streams themselves
carry, not a guarantee:

- `stripped` — no declared locals and no parameter names across code-bearing
  methods (the classic R8/ProGuard or `d8 --release` build: names gone, even
  when line tables are kept).
- `present` — line positions plus declared locals or parameter names.
- `partial` — local evidence without any line positions.
- `unknown` — no local evidence was found, but some class data, code items or
  debug streams could not be read (counted in `unreadable`), so absence is not
  established. A damaged file never reads as `stripped`.
  Whenever `unreadable` is non-zero, every other count is a lower bound over
  what could be read.

`local_declarations` counts every local `dexdump` lists, including the implicit
`this` and parameter locals that are synthesised from a method's register
layout whenever it has a debug stream. Because a release build keeps streams
for its line tables, those implicit locals appear even when no local debug info
survived, so `readiness` and the per-method `state` use
`explicit_local_declarations` (locals the stream declares with
`DBG_START_LOCAL`) and named parameters instead.

`line_positions` counts positions inside each method's code (`address <
insns_size`). R8 shares one debug stream across many methods, so a stream can
run past a method's code; those rows belong to no instruction of that method and
are not counted. `dexdump` additionally stops printing at the start of a
method's last instruction, so on R8 output that ends in a multi-unit
instruction or a data payload it lists slightly fewer rows (0.2–0.7% on the
members of a real release APK); on debug builds and d8 output the counts are
equal. Local scopes of zero length cover no instruction and are not counted. This
matches `dexdump` on compiler output, where they arise when kotlinc re-declares
a generic parameter's register at address 0 (verified exact on 15 real members).
On hand-crafted streams with zero-length scopes elsewhere, `dexdump` may list
rows REA omits.

Cancellation is honoured between DEX members. One member is analysed in a
single synchronous pass, bounded by its per-member work budget (a few seconds
for a maximal 64 MiB member), so cancelling mid-member takes effect when that
member finishes.

## What the facts do and do not mean

Line positions are compiler-emitted; under R8 they are frequently **renumbered
synthetic lines that need a `mapping.txt` to retrace**, not asserted source
lines. A single `distinct_source_files` value (e.g. `"SourceFile"`) signals
`-renamesourcefileattribute`; note that d8 can also introduce a synthetic source
name (`D8$$SyntheticClass`), so the distinct count is not purely the real
source-file cardinality. SHA-256 identifies the exact selected bytes, not
authenticity or which compiler produced the artifact.

Malformed or truncated DEX is reported through the tagged error algebra rather
than throwing. Reverse-endian files and unsupported/withdrawn versions
(036, 041) are refused with distinct reasons; a compact dex (`cdex`) is refused
with guidance to supply a canonical `.dex`. Every length and offset is bounded
against the buffer before allocation; a crafted `class_data` method count is
refused structurally; archive members are read under a size budget so a
decompression bomb cannot be buffered; the archive is admitted once through a
no-follow descriptor and hashed only after a member is selected.

Verified by the `verify:dex` real lane, which compiles an owned Java fixture with
`-g` and `-g:none`, dexes each with the Android SDK's `d8`, and cross-checks the
decoded facts — including the `this` and parameter locals — against `dexdump`,
then exercises the CLI and MCP in Evidence parity.
