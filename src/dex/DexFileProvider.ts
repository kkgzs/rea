import { createHash } from "node:crypto";

import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type {
  DexDebugMetadataExecution,
  DexDebugMetadataPort,
} from "../application/dex/DexDebugMetadataPort.js";
import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import {
  looksLikeZip,
  normalizeArchiveMemberPath,
  readArchiveMember,
} from "../artifacts/archiveMember.js";
import { hashStableRootArtifactHandle } from "../artifacts/inventory/hashStableRootArtifact.js";
import {
  peekArtifactMagic,
  readStableArtifact,
} from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { dexWorkBudget } from "../domain/dex/dexDebugInfo.js";
import {
  assembleClassDetail,
  type DexClassDetail,
  type DexWork,
  summarizeDex,
} from "../domain/dex/dexDebugMetadata.js";
import {
  buildDexClassDetailResult,
  buildDexSummaryResult,
  type DexDebugMetadataResult,
  type DexSummaryMember,
  type InspectDexDebugMetadataInput,
} from "../domain/dex/dexDebugMetadataReport.js";
import { parseDexFile } from "../domain/dex/dexFile.js";
import { err, ok, type Result } from "../domain/result.js";
import { zipPackageFormatForPath } from "../domain/zipPackageFormat.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
} from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  dexFileFailure,
  mapDexParseError,
  mapDexWorkError,
} from "./dexFailures.js";
import { autoLoadedDexMembers, multidexIndex } from "./dexEntry.js";
import { DEX_LIMITS, DEX_PROVIDER_IDENTITY } from "./DexFileRelease.js";

const OPERATION = "inspect_dex_debug_metadata";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * A selected DEX member, read on demand. Members are loaded, analysed and
 * released one at a time, so peak memory holds one member, not all 64.
 */
interface MemberSource {
  readonly entry: string | null;
  readonly load: () => Promise<Uint8Array>;
  /** Where a parse error is reported (`path` or `path!entry`). */
  readonly label: string;
}

/** What one inspection keeps from its members after each is released. */
type MemberFindings =
  | { readonly mode: "summary"; readonly members: DexSummaryMember[] }
  | {
      readonly mode: "detail";
      readonly found: {
        readonly entry: string | null;
        readonly detail: DexClassDetail;
      }[];
    };

const execution = (
  result: DexDebugMetadataResult,
  path: string,
  subjectSha256: string,
  format: "file" | "apk" | "zip",
): DexDebugMetadataExecution =>
  createAnalysisExecution(result, DEX_PROVIDER_IDENTITY, {
    subject: { path, format, sha256: subjectSha256 },
    locations: [{ kind: "artifact-path", path }],
    limitations: result.limitations,
  });

/** Read exactly the selected DEX bytes and report compiler-emitted debug metadata. */
export class DexFileProvider implements DexDebugMetadataPort {
  /** Handles whose close failed stay owned here and are retried by `close()`. */
  readonly #resources = new ArtifactResourceScope();

  /** Retry retained cleanup without discarding handles that still cannot close. */
  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      const cleanup =
        cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
      throw new ProviderCleanupError(
        DEX_PROVIDER_IDENTITY.id,
        cleanup?.resources ?? ["artifact-resources"],
        {
          reason:
            cleanup?.reason ??
            (cause instanceof Error ? cause.message : String(cause)),
        },
        { operation: OPERATION, cause },
      );
    }
  }

  /** Close now; on failure the scope retains the owner for `close()` and the call fails. */
  async #releaseOrRetain(
    owner: Parameters<ArtifactResourceScope["release"]>[0],
  ): Promise<void> {
    const attempt = await this.#resources.release(owner);
    if (attempt.kind === "failed") throw attempt.cause;
  }

  async inspect(
    input: InspectDexDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDebugMetadataExecution, AnalysisError>> {
    try {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      return await this.#resources.run(async () => {
        if (input.entry !== undefined)
          return this.#inspectArchive(input.path, input, options);
        const magic = await peekArtifactMagic(
          input.path,
          8,
          options?.signal,
          undefined,
          this.#resources,
        );
        return looksLikeZip(magic)
          ? this.#inspectArchive(input.path, input, options)
          : this.#inspectLooseDex(input.path, input, options);
      });
    } catch (cause: unknown) {
      return err(dexFileFailure(cause, input.path));
    }
  }

  async #inspectLooseDex(
    path: string,
    input: InspectDexDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDebugMetadataExecution, AnalysisError>> {
    const selected = await readStableArtifact(
      path,
      DEX_LIMITS.inputBytes,
      options?.signal,
      undefined,
      this.#resources,
    );
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const findings = await this.#analyse(
      [
        {
          entry: null,
          load: () => Promise.resolve(selected.bytes),
          label: path,
        },
      ],
      input,
      options?.signal,
    );
    if (!findings.ok) return findings;
    return this.#assemble(findings.value, input, {
      artifact: {
        path,
        sha256: selected.sha256,
        bytes: selected.bytes.length,
      },
      container: "dex-file",
      format: "file",
    });
  }

  async #inspectArchive(
    path: string,
    input: InspectDexDebugMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<DexDebugMetadataExecution, AnalysisError>> {
    let handle;
    try {
      handle = await openRegularFile(path, {
        symlinks: "reject",
        signal: options?.signal,
      });
    } catch (cause: unknown) {
      // Admission failed and its descriptor close failed too: keep that owner
      // so a later close() retries it instead of leaking the descriptor.
      if (cause instanceof RegularFileAdmissionFailure)
        await this.#resources.release({
          kind: "file-handle",
          resource: path,
          handle: cause.owner,
        });
      throw cause;
    }
    const owner = new OwnedFileHandle(handle);
    try {
      const initial = await handle.stat();
      if (initial.size > DEX_LIMITS.archiveBytes)
        return err(
          new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            `Selected archive exceeds ${String(DEX_LIMITS.archiveBytes)} bytes: ${path}`,
            { maximum_archive_bytes: DEX_LIMITS.archiveBytes },
          ),
        );
      const zipFormat = zipPackageFormatForPath(path) ?? "zip";
      const reader = new ZipArtifactReader(
        path,
        zipFormat,
        DEX_LIMITS.archiveMetadataBytes,
        { handle, initial },
      );
      try {
        const selected = await this.#selectDexMembers(
          reader,
          input.entry,
          path,
          options?.signal,
        );
        if (!selected.ok) return err(selected.error);
        const findings = await this.#analyse(
          selected.value.map(({ entry, member }) => ({
            entry,
            label: `${path}!${entry}`,
            load: () =>
              readArchiveMember(
                reader,
                member,
                DEX_LIMITS.inputBytes,
                options?.signal,
              ),
          })),
          input,
          options?.signal,
        );
        if (!findings.ok) return findings;
        const digest = await hashStableRootArtifactHandle(
          path,
          handle,
          initial,
          options?.signal,
        );
        const format = zipFormat === "apk" ? "apk" : "zip";
        return this.#assemble(findings.value, input, {
          artifact: { path, sha256: digest.sha256, bytes: digest.bytes },
          container: format,
          format,
        });
      } finally {
        await this.#releaseOrRetain({ kind: "reader", resource: path, reader });
      }
    } finally {
      await this.#releaseOrRetain({
        kind: "file-handle",
        resource: path,
        handle: owner,
      });
    }
  }

  /** Choose the archive's DEX members: the explicit entry, or the auto-loaded multidex sequence. */
  async #selectDexMembers(
    reader: ZipArtifactReader,
    entry: string | undefined,
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<
    Result<{ entry: string; member: ArtifactEntry }[], AnalysisError>
  > {
    const requested =
      entry === undefined ? undefined : normalizeArchiveMemberPath(entry);
    // Only members this call may open are kept (the reader retains ~8 KB of
    // decoded metadata per kept entry): the requested name, or the canonical
    // names up to one past the member cap (enough to detect "over the cap").
    // Two occurrences of a name already prove it ambiguous, so no more are kept.
    const candidates: { entry: string; member: ArtifactEntry }[] = [];
    const occurrences = new Map<string, number>();
    const keep = (member: ArtifactEntry): boolean => {
      if (member.kind !== "file") return false;
      const index = multidexIndex(member.path);
      const wanted =
        requested !== undefined
          ? member.path === requested
          : index !== null && index <= DEX_LIMITS.maxDexMembers;
      const seen = occurrences.get(member.path) ?? 0;
      if (!wanted || seen >= 2) return false;
      occurrences.set(member.path, seen + 1);
      candidates.push({ entry: member.path, member });
      return true;
    };
    for await (const member of reader.entries(signal, { retain: keep }))
      void member;
    if (requested !== undefined)
      return this.#resolveRequested(candidates, requested, path);
    // Only the contiguous sequence Android loads is promised; a member after a
    // gap is never loaded, so it can neither fail nor shadow the inspection.
    const sequence = autoLoadedDexMembers(candidates.map(({ entry }) => entry));
    const loadOrder = new Map(sequence.map((name, index) => [name, index]));
    const matches = candidates.filter(({ entry }) => loadOrder.has(entry));
    // Every root member is promised, so one that cannot be read is refused,
    // never silently skipped (that would turn unknown into absent).
    const encrypted = matches.filter((m) => m.member.encrypted);
    if (encrypted.length > 0)
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          path,
          `${path} has encrypted root DEX member(s) (${encrypted.map((m) => m.entry).join(", ")}); their debug metadata is unavailable, not absent.`,
          {
            remediationAction:
              "Select a readable member with entry to inspect it alone.",
          },
        ),
      );
    // A reported entry must identify exactly one member.
    const names = new Set<string>();
    for (const { entry: name } of matches) {
      if (names.has(name))
        return err(
          this.#inputError(
            "entry",
            `${path} holds more than one member named ${name}; the identity is ambiguous.`,
          ),
        );
      names.add(name);
    }
    if (matches.length === 0)
      return err(
        this.#inputError(
          "entry",
          `${path} holds no classes.dex for Android to load; select a .dex with entry.`,
        ),
      );
    if (matches.length > DEX_LIMITS.maxDexMembers)
      return err(
        new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          `${path} auto-loads more than ${String(DEX_LIMITS.maxDexMembers)} dex members, over the limit; select one with entry.`,
          { maximum_dex_members: DEX_LIMITS.maxDexMembers },
          {
            remediationAction:
              "Select one member with entry; members are inspected one at a time.",
          },
        ),
      );
    matches.sort(
      (a, b) => (loadOrder.get(a.entry) ?? 0) - (loadOrder.get(b.entry) ?? 0),
    );
    return ok(matches);
  }

  #resolveRequested(
    matches: readonly { entry: string; member: ArtifactEntry }[],
    requested: string,
    path: string,
  ): Result<{ entry: string; member: ArtifactEntry }[], AnalysisError> {
    if (matches.length === 0)
      return err(
        this.#inputError("entry", `No member ${requested} exists in ${path}.`),
      );
    if (matches.length > 1)
      return err(
        this.#inputError(
          "entry",
          `${path} holds ${String(matches.length)} members named ${requested}; the identity is ambiguous.`,
        ),
      );
    const only = matches[0]!;
    if (only.member.encrypted)
      return err(
        new AnalysisUnsupportedTargetError(
          OPERATION,
          path,
          `The selected member ${requested} is encrypted and cannot be read without a key; unavailable, not absent.`,
        ),
      );
    return ok([only]);
  }

  /**
   * Load, frame and analyse each member in turn, each under a work budget
   * proportional to its own bytes, keeping only its summary or matching class
   * detail before the next member is read.
   */
  async #analyse(
    sources: readonly MemberSource[],
    input: InspectDexDebugMetadataInput,
    signal: AbortSignal | undefined,
  ): Promise<Result<MemberFindings, AnalysisError>> {
    const cancelled = (): boolean => signal?.aborted === true;
    const summaries: DexSummaryMember[] = [];
    const found: { entry: string | null; detail: DexClassDetail }[] = [];
    for (const source of sources) {
      if (signal?.aborted) return err(new AnalysisCancelledError(OPERATION));
      const buffer = await source.load();
      const parsed = parseDexFile(buffer);
      if (!parsed.ok) return err(mapDexParseError(parsed.error, source.label));
      const work: DexWork = {
        budget: dexWorkBudget(
          Math.max(
            DEX_LIMITS.minWorkUnits,
            DEX_LIMITS.workUnitsPerByte * buffer.length,
          ),
        ),
        cancelled,
      };
      if (input.class_descriptor === undefined) {
        const summary = summarizeDex(parsed.value, buffer, work);
        if (!summary.ok) return err(mapDexWorkError(summary.error));
        summaries.push({
          entry: source.entry,
          sha256: sha256(buffer),
          bytes: buffer.length,
          summary: summary.value,
        });
        continue;
      }
      const detail = assembleClassDetail(
        parsed.value,
        buffer,
        input.class_descriptor,
        work,
        DEX_LIMITS.outputBytes,
      );
      if (!detail.ok) return err(mapDexWorkError(detail.error));
      if (detail.value !== null)
        found.push({ entry: source.entry, detail: detail.value });
      // A second match is already ambiguous; reading further members is waste.
      if (found.length > 1) break;
    }
    return ok(
      input.class_descriptor === undefined
        ? { mode: "summary", members: summaries }
        : { mode: "detail", found },
    );
  }

  /** Decide summary vs class-detail over the decoded members and build the result. */
  #assemble(
    findings: MemberFindings,
    input: InspectDexDebugMetadataInput,
    context: {
      readonly artifact: { path: string; sha256: string; bytes: number };
      readonly container: DexDebugMetadataResult["container"];
      readonly format: "file" | "apk" | "zip";
    },
  ): Result<DexDebugMetadataExecution, AnalysisError> {
    const { artifact, container, format } = context;
    const result: Result<DexDebugMetadataResult, AnalysisError> =
      findings.mode === "summary"
        ? ok(buildDexSummaryResult(artifact, container, findings.members))
        : this.#classDetail(
            findings.found,
            input.class_descriptor ?? "",
            artifact,
            container,
          );
    if (!result.ok) return result;
    const tooLarge = this.#rejectIfOversized(result.value, artifact.path);
    if (tooLarge) return err(tooLarge);
    return ok(execution(result.value, artifact.path, artifact.sha256, format));
  }

  #classDetail(
    found: readonly {
      readonly entry: string | null;
      readonly detail: DexClassDetail;
    }[],
    descriptor: string,
    artifact: { path: string; sha256: string; bytes: number },
    container: DexDebugMetadataResult["container"],
  ): Result<DexDebugMetadataResult, AnalysisError> {
    if (found.length === 0)
      return err(
        this.#inputError(
          "class_descriptor",
          `No class ${descriptor} exists in the selected DEX member(s).`,
        ),
      );
    if (found.length > 1)
      return err(
        this.#inputError(
          "class_descriptor",
          `Class ${descriptor} appears in more than one dex member; select one with entry.`,
        ),
      );
    return ok(buildDexClassDetailResult(artifact, container, found[0]!));
  }

  #rejectIfOversized(
    result: DexDebugMetadataResult,
    path: string,
  ): AnalysisResourceConstraintError | undefined {
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") <=
      DEX_LIMITS.outputBytes
    )
      return undefined;
    return new AnalysisResourceConstraintError(
      OPERATION,
      "transport",
      `Decoded DEX detail for ${path} exceeds the inline output budget; select a narrower class.`,
      { maximum_output_bytes: DEX_LIMITS.outputBytes },
    );
  }

  #inputError(
    field: "entry" | "class_descriptor",
    message: string,
  ): AnalysisInputError {
    return new AnalysisInputError(OPERATION, undefined, [
      { path: [field], reason: "invalid_value", message },
    ]);
  }
}
