/**
 * Assemble debugging-readiness facts from a framed DEX file: a whole-file
 * summary (tallies + a conservative readiness label) and, for one selected
 * class, full per-method detail with names/types/scopes resolved from the string
 * and type pools.
 *
 * Every decode is charged to one call-wide {@link DexWorkBudget} and polls a
 * cancellation callback, so neither many methods nor many DEX members can
 * multiply the per-method guard. The summary only counts (no per-position or
 * per-local allocation) and decodes each distinct debug stream + parameter
 * layout once. The class detail projects its serialized size from memoised
 * per-string bounds while it decodes, and refuses before materialising a report
 * past the caller's output limit.
 */
import { encodeModifiedUtf8 } from "../modifiedUtf8.js";
import {
  type DexClassDef,
  type DexEncodedMethod,
  type DexFile,
  readClassDef,
  walkClassData,
  parseCodeItem,
} from "./dexFile.js";
import {
  absentMethodDebug,
  decodeDebugInfo,
  type DexDecodeOptions,
  DEX_THIS_NAME,
  type DexMethodDebug,
  type DexWorkBudget,
  chargeWork,
} from "./dexDebugInfo.js";
import { type Result, err, ok } from "../result.js";
import { DexStringResolver } from "./dexStrings.js";

export type DexMethodState =
  | "present" // positions and locals both decoded
  | "partial" // one present, the other absent
  | "stripped" // code exists but carries no debug_info
  | "malformed" // a present debug_info failed to decode fully
  | "not-applicable"; // abstract/native: no code_item

export interface DexLocalResolved {
  readonly register: number;
  readonly name: string | null;
  readonly type: string | null;
  readonly signature: string | null;
  readonly startAddress: number;
  readonly endAddress: number;
  readonly outOfRange: boolean;
}

export interface DexMethodDetail {
  readonly name: string | null;
  readonly descriptor: string | null;
  readonly state: DexMethodState;
  readonly hasCode: boolean;
  readonly lineCount: number;
  readonly parameterNames: readonly (string | null)[];
  readonly locals: readonly DexLocalResolved[];
  readonly setFileEvents: number;
}

export interface DexClassDetail {
  readonly descriptor: string | null;
  readonly sourceFile: string | null;
  readonly methods: readonly DexMethodDetail[];
}

export type DexReadiness = "present" | "partial" | "stripped" | "unknown";

export interface DexSummary {
  readonly dexVersion: string;
  readonly classCount: number;
  readonly methodsWithCode: number;
  readonly methodsWithDebugInfo: number;
  readonly methodsWithParameterNames: number;
  readonly linePositions: number;
  /** Every local dexdump lists, including implicit `this`/parameter locals. */
  readonly localDeclarations: number;
  /** Locals the debug streams declare themselves (DBG_START_LOCAL*). */
  readonly explicitLocalDeclarations: number;
  readonly setFileEvents: number;
  readonly sourceFilePresent: number;
  readonly distinctSourceFiles: {
    readonly count: number;
    readonly sample: readonly string[];
  };
  /** Structures that could not be read (their debug metadata is unknown). */
  readonly unreadable: {
    readonly classData: number;
    readonly codeItems: number;
    readonly debugInfo: number;
  };
  readonly readiness: DexReadiness;
}

const SOURCE_FILE_SAMPLE_CAP = 16;
/** Longest source-file name (JSON bytes) included in the sample; longer ones are counted only. */
const SOURCE_FILE_SAMPLE_MAX_BYTES = 1024;

/** Why a summary or detail was refused before completing. */
export type DexWorkError =
  | { readonly kind: "work-budget-exceeded"; readonly limit: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "malformed-class-data"; readonly classDataOff: number }
  /** class_defs whose identity could not be read: presence is unknown. */
  | { readonly kind: "unreadable-class-identity"; readonly count: number }
  /** More than one class_def declares the class (ART rejects the DEX). */
  | { readonly kind: "duplicate-class-definition"; readonly count: number }
  | {
      readonly kind: "output-budget-exceeded";
      readonly projectedBytes: number;
      readonly limit: number;
    };

/** Call-wide work accounting shared by every member of one inspection. */
export interface DexWork {
  readonly budget: DexWorkBudget;
  readonly cancelled: () => boolean;
}

const methodState = (
  hasCode: boolean,
  debug: DexMethodDebug,
): DexMethodState => {
  if (!hasCode) return "not-applicable";
  if (debug.malformed) return "malformed";
  const hasLines = debug.positionCount > 0;
  // Implicit `this`/parameter locals are synthesised from the method layout
  // whenever a stream exists (an R8 release keeps streams for lines); only
  // declared locals or named parameters show local debug info survived.
  const hasLocals =
    debug.explicitLocalCount > 0 ||
    debug.parameterNames.some((idx) => idx >= 0);
  if (!debug.present || (!hasLines && !hasLocals)) return "stripped";
  return hasLines && hasLocals ? "present" : "partial";
};

/** A method's code_item facts that decoding and the summary memo key need. */
interface MethodCode {
  readonly debugInfoOff: number;
  readonly insnsSize: number;
  readonly firstRegister: number;
  readonly registersSize: number;
}

/** The method's code_item facts, or null with no code or no debug_info. O(1). */
const methodCode = (
  bytes: Uint8Array,
  method: DexEncodedMethod,
): MethodCode | null | "unreadable" => {
  if (method.codeOff === 0) return null;
  const code = parseCodeItem(bytes, method.codeOff);
  // An unreadable code_item leaves debug metadata unknown, never absent.
  if (!code.ok) return "unreadable";
  // Incoming arguments occupy the top of the frame, so they cannot outnumber it.
  if (code.value.insSize > code.value.registersSize) return "unreadable";
  if (code.value.debugInfoOff === 0) return null;
  return {
    debugInfoOff: code.value.debugInfoOff,
    insnsSize: code.value.insnsSize,
    firstRegister: code.value.registersSize - code.value.insSize,
    registersSize: code.value.registersSize,
  };
};

/**
 * Decode a method's debug_info with its implicit parameter locals (and `this`)
 * seeded at address 0 from the code_item register layout and the proto, as the
 * DEX format and dexdump/ART do. Parameters are resolved only here, when a
 * decode actually runs.
 */
const decodeMethodDebug = (
  bytes: Uint8Array,
  method: DexEncodedMethod,
  code: MethodCode | null | "unreadable",
  classTypeIdx: number,
  resolver: DexStringResolver,
  options: DexDecodeOptions,
): DexMethodDebug => {
  if (code === null) return absentMethodDebug();
  const malformed = { ...absentMethodDebug(), present: true, malformed: true };
  if (code === "unreadable") return malformed;
  const paramTypes = resolver.methodParameters(method.methodIdx);
  // ins_size must be the receiver plus one word per parameter (two for
  // long/double); otherwise `this` and the parameters would be seeded into
  // registers the method does not use.
  if (paramTypes !== null) {
    const words =
      ((method.accessFlags & ACC_STATIC) === 0 ? 1 : 0) +
      paramTypes.reduce((sum, { wide }) => sum + (wide ? 2 : 1), 0);
    if (words !== code.registersSize - code.firstRegister) return malformed;
  }
  return decodeDebugInfo(
    bytes,
    code.debugInfoOff,
    code.insnsSize,
    {
      firstRegister: code.firstRegister,
      registersSize: code.registersSize,
      accessFlags: method.accessFlags,
      thisTypeIdx: classTypeIdx,
      paramTypes,
    },
    options,
  );
};

const ACC_STATIC = 0x8;

/** Methods between cancellation/budget polls inside one class. */
const METHOD_POLL_INTERVAL = 4096;

/**
 * Visit a class's methods one at a time, never materialising them. The
 * class_data is validated first with an allocation-free pass, so a malformed
 * class contributes nothing (not a partial list), then walked again with the
 * visitor; both passes are charged to the call-wide budget, because many
 * class_defs may share one (or overlapping) class_data. The visitor returns
 * `false` to stop.
 */
const forEachMethod = (
  bytes: Uint8Array,
  classDef: DexClassDef,
  work: DexWork,
  visit: (method: DexEncodedMethod) => boolean,
): "visited" | "no-class-data" | "unreadable" => {
  if (classDef.classDataOff === 0) return "no-class-data";
  const charge = (): boolean => chargeWork(work.budget);
  const valid = walkClassData(bytes, classDef.classDataOff, charge);
  if (!valid.ok) {
    // A spent budget is reported by the caller's budget check, not as damage.
    const spent =
      valid.error.kind === "budget-exceeded" && valid.error.resource === "work";
    return spent ? "visited" : "unreadable";
  }
  walkClassData(bytes, classDef.classDataOff, charge, visit);
  return "visited";
};

const outOfWork = (work: DexWork): DexWorkError | null =>
  work.cancelled()
    ? { kind: "cancelled" }
    : work.budget.remaining <= 0
      ? { kind: "work-budget-exceeded", limit: work.budget.limit }
      : null;

/** Distinct (stream, layout) tallies kept for reuse; bounds the summary's memo. */
const MEMO_LIMIT = 65_536;

/** Serialized overhead per projected object (keys, numbers, punctuation). */
const METHOD_OVERHEAD = 320;
const LOCAL_OVERHEAD = 192;

/**
 * Find the class_def whose type descriptor matches, scanning the whole table in
 * place. Every descriptor read is charged by the resolver, and the scan polls
 * the work budget and cancellation, so an absent class in a crafted table
 * cannot cost unbounded work before the answer. A definition whose identity
 * cannot be read might be the requested class, so absence or uniqueness is then
 * unknown, never asserted; a second matching definition is malformed.
 */
const findClassDef = (
  dex: DexFile,
  bytes: Uint8Array,
  resolver: DexStringResolver,
  classDescriptor: string,
  work: DexWork,
): Result<DexClassDef | undefined, DexWorkError> => {
  // Compared as raw modified-UTF-8 bytes: no class name is decoded.
  const wanted = encodeModifiedUtf8(classDescriptor);
  let match: DexClassDef | undefined;
  let matches = 0;
  let unreadable = 0;
  for (let i = 0; i < dex.header.classDefsSize; i += 1) {
    // Checked per class: one descriptor read can cost as much as its string.
    const stop = outOfWork(work);
    if (stop !== null) return err(stop);
    const def = readClassDef(bytes, dex.header, i);
    const identity = resolver.typeIdentity(def.classIdx, wanted);
    if (identity === "unreadable") unreadable += 1;
    else if (identity === "match") {
      matches += 1;
      match ??= def;
    }
  }
  const spent = outOfWork(work);
  if (spent !== null) return err(spent);
  if (matches > 1)
    return err({ kind: "duplicate-class-definition", count: matches });
  if (unreadable > 0)
    return err({ kind: "unreadable-class-identity", count: unreadable });
  return ok(match);
};

/**
 * Full per-method detail for the one class whose descriptor matches (`null`
 * when absent). Methods are visited one at a time; locals are collected under
 * a cap derived from the output limit (each serialises to at least
 * {@link LOCAL_OVERHEAD} bytes) and every emitted string is charged its
 * memoised JSON bound, so an oversized class is refused before its report is
 * built.
 */
export const assembleClassDetail = (
  dex: DexFile,
  bytes: Uint8Array,
  classDescriptor: string,
  work: DexWork,
  outputLimit: number,
): Result<DexClassDetail | null, DexWorkError> => {
  const resolver = new DexStringResolver(
    bytes,
    dex.header,
    (units) => {
      work.budget.remaining -= units;
    },
    () => work.budget.remaining <= 0,
  );
  const found = findClassDef(dex, bytes, resolver, classDescriptor, work);
  // An absent class is only an answer when the lookup stayed within budget.
  if (!found.ok) return found;
  const classDef = found.value;
  if (classDef === undefined) return ok(null);
  let projected =
    1024 +
    resolver.typeJsonBound(classDef.classIdx) +
    resolver.jsonBound(classDef.sourceFileIdx);
  // Checked before any method is visited: a methodless class never reaches the
  // per-method check, and its source_file must not be decoded past the limit.
  if (projected > outputLimit)
    return err({
      kind: "output-budget-exceeded",
      projectedBytes: projected,
      limit: outputLimit,
    });
  let failure: DexWorkError | null = null;
  const methods: DexMethodDetail[] = [];
  const walked = forEachMethod(bytes, classDef, work, (method) => {
    const stop = outOfWork(work);
    if (stop !== null) {
      failure = stop;
      return false;
    }
    const debug = decodeMethodDebug(
      bytes,
      method,
      methodCode(bytes, method),
      classDef.classIdx,
      resolver,
      {
        budget: work.budget,
        cancelled: work.cancelled,
        collectPositions: false,
        collectLocals: true,
        maxLocals: Math.max(
          0,
          Math.floor((outputLimit - projected) / LOCAL_OVERHEAD),
        ),
      },
    );
    const after = outOfWork(work);
    if (after !== null) {
      failure = after;
      return false;
    }
    // Bound the name and descriptor from type ids before building them.
    projected += METHOD_OVERHEAD + resolver.methodJsonBound(method.methodIdx);
    if (projected > outputLimit) {
      failure = {
        kind: "output-budget-exceeded",
        projectedBytes: projected,
        limit: outputLimit,
      };
      return false;
    }
    const name = resolver.methodName(method.methodIdx);
    const descriptor = resolver.methodDescriptor(method.methodIdx);
    // Each name plus its array separator.
    for (const idx of debug.parameterNames)
      projected += resolver.jsonBound(idx) + 1;
    if (debug.localLimitExceeded)
      projected += (debug.localCount - debug.locals.length) * LOCAL_OVERHEAD;
    else
      for (const local of debug.locals)
        projected +=
          LOCAL_OVERHEAD +
          (local.nameIdx === DEX_THIS_NAME
            ? 6
            : resolver.jsonBound(local.nameIdx)) +
          resolver.typeJsonBound(local.typeIdx) +
          resolver.jsonBound(local.signatureIdx);
    if (debug.localLimitExceeded || projected > outputLimit) {
      failure = {
        kind: "output-budget-exceeded",
        projectedBytes: projected,
        limit: outputLimit,
      };
      return false;
    }
    const hasCode = method.codeOff !== 0;
    methods.push({
      name,
      descriptor,
      state: methodState(hasCode, debug),
      hasCode,
      lineCount: debug.positionCount,
      parameterNames: debug.parameterNames.map((idx) => resolver.string(idx)),
      locals: debug.locals.map((local) => ({
        register: local.register,
        name:
          local.nameIdx === DEX_THIS_NAME
            ? "this"
            : resolver.string(local.nameIdx),
        type: resolver.typeDescriptor(local.typeIdx),
        signature: resolver.string(local.signatureIdx),
        startAddress: local.startAddress,
        endAddress: local.endAddress,
        outOfRange: local.outOfRange,
      })),
      setFileEvents: debug.setFileEvents,
    });
    return true;
  });
  // The class exists but its member list is unreadable: unknown, not empty.
  if (walked === "unreadable" && failure === null)
    failure = {
      kind: "malformed-class-data",
      classDataOff: classDef.classDataOff,
    };
  if (failure !== null) return err(failure);
  const spent = outOfWork(work);
  if (spent !== null) return err(spent);
  return ok({
    descriptor: resolver.typeDescriptor(classDef.classIdx),
    sourceFile: resolver.string(classDef.sourceFileIdx),
    methods,
  });
};

/**
 * Conservative readiness from what the streams themselves carry: declared
 * locals or named parameters are local-variable evidence (implicit `this` and
 * unnamed parameter locals are synthesised from the layout, so they are not).
 */
const classifyReadiness = (
  explicitLocalDeclarations: number,
  methodsWithParameterNames: number,
  linePositions: number,
  unreadable: number,
): DexReadiness => {
  const hasLocals =
    explicitLocalDeclarations > 0 || methodsWithParameterNames > 0;
  // No evidence found is only "stripped" when nothing was unreadable.
  if (!hasLocals) return unreadable > 0 ? "unknown" : "stripped";
  return linePositions > 0 ? "present" : "partial";
};

/** What the summary keeps from one decoded method. */
interface MethodTally {
  readonly present: boolean;
  readonly positions: number;
  readonly locals: number;
  readonly explicitLocals: number;
  readonly setFileEvents: number;
  readonly hasParameterNames: boolean;
  readonly malformed: boolean;
}

/**
 * Whole-file tally and a conservative readiness label. Methods are decoded in
 * counts-only mode, and methods that share a debug stream and the same implicit
 * parameter layout (d8/R8 share streams) reuse one decode: the result depends
 * only on that key.
 */
export const summarizeDex = (
  dex: DexFile,
  bytes: Uint8Array,
  work: DexWork,
): Result<DexSummary, DexWorkError> => {
  const resolver = new DexStringResolver(
    bytes,
    dex.header,
    (units) => {
      work.budget.remaining -= units;
    },
    () => work.budget.remaining <= 0,
  );
  const tallies = new Map<string, MethodTally>();
  let methodsWithCode = 0;
  let methodsWithDebugInfo = 0;
  let methodsWithParameterNames = 0;
  let linePositions = 0;
  let localDeclarations = 0;
  let explicitLocalDeclarations = 0;
  let setFileEvents = 0;
  let sourceFilePresent = 0;
  // Distinct source files are counted with two bitmaps over the string-id
  // space (each string_id is at least 4 bytes, so this is at most 1/32 of the
  // file) and only the bounded sample is decoded and kept.
  const idSpace = Math.min(
    dex.header.stringIdsSize,
    Math.floor(bytes.length / 4),
  );
  const seenSource = new Uint8Array(Math.ceil(idSpace / 8));
  const validSource = new Uint8Array(Math.ceil(idSpace / 8));
  let distinctSources = 0;
  const sourceSample: string[] = [];

  let failure: DexWorkError | null = null;
  let visited = 0;
  let unreadableClassData = 0;
  let unreadableCodeItems = 0;
  let malformedDebugInfo = 0;
  for (let c = 0; c < dex.header.classDefsSize; c += 1) {
    const stop = outOfWork(work);
    if (stop !== null) return err(stop);
    const classDef = readClassDef(bytes, dex.header, c);
    const idx = classDef.sourceFileIdx;
    if (idx >= 0 && idx < idSpace) {
      const at = idx >>> 3;
      const bit = 1 << (idx & 7);
      if ((seenSource[at]! & bit) === 0) {
        seenSource[at]! |= bit;
        // Validity is checked without decoding; only short names are
        // decoded into the bounded sample, so a multi-megabyte name is
        // counted but never materialised.
        if (resolver.isValid(idx)) {
          validSource[at]! |= bit;
          // A single distinct value signals -renamesourcefileattribute.
          distinctSources += 1;
          if (
            sourceSample.length < SOURCE_FILE_SAMPLE_CAP &&
            resolver.jsonBound(idx) <= SOURCE_FILE_SAMPLE_MAX_BYTES
          ) {
            const source = resolver.string(idx);
            if (source !== null) sourceSample.push(source);
          }
        }
      }
      if ((validSource[at]! & bit) !== 0) sourceFilePresent += 1;
    }
    const walked = forEachMethod(bytes, classDef, work, (method) => {
      visited += 1;
      if (visited % METHOD_POLL_INTERVAL === 0) {
        failure = outOfWork(work);
        if (failure !== null) return false;
      }
      if (method.codeOff === 0) return true;
      methodsWithCode += 1;
      const code = methodCode(bytes, method);
      if (code === null) return true;
      if (code === "unreadable") {
        unreadableCodeItems += 1;
        return true;
      }
      // O(1) key: the implicit parameter layout is fixed by the proto, so its
      // index stands in for the (up to 255) parameter types.
      const isStatic = (method.accessFlags & 0x8) !== 0;
      const key = `${String(code.debugInfoOff)}:${String(code.insnsSize)}:${String(code.firstRegister)}:${String(code.registersSize)}:${isStatic ? "s" : `i${String(classDef.classIdx)}`}:${String(resolver.methodProtoIndex(method.methodIdx))}`;
      let tally = tallies.get(key);
      if (tally === undefined) {
        const debug = decodeMethodDebug(
          bytes,
          method,
          code,
          classDef.classIdx,
          resolver,
          {
            budget: work.budget,
            cancelled: work.cancelled,
            collectPositions: false,
            collectLocals: false,
          },
        );
        failure = outOfWork(work);
        if (failure !== null) return false;
        tally = {
          present: debug.present,
          positions: debug.positionCount,
          locals: debug.localCount,
          explicitLocals: debug.explicitLocalCount,
          setFileEvents: debug.setFileEvents,
          hasParameterNames: debug.parameterNames.some((idx) => idx >= 0),
          malformed: debug.malformed,
        };
        // The memo is an optimisation, not a working set: past its cap a
        // repeat is decoded again (still charged), never retained.
        if (tallies.size < MEMO_LIMIT) tallies.set(key, tally);
      }
      if (tally.malformed) malformedDebugInfo += 1;
      if (!tally.present) return true;
      methodsWithDebugInfo += 1;
      linePositions += tally.positions;
      localDeclarations += tally.locals;
      explicitLocalDeclarations += tally.explicitLocals;
      setFileEvents += tally.setFileEvents;
      if (tally.hasParameterNames) methodsWithParameterNames += 1;
      return true;
    });
    if (walked === "unreadable") unreadableClassData += 1;
    if (failure !== null) return err(failure);
  }
  const spent = outOfWork(work);
  if (spent !== null) return err(spent);

  return ok({
    dexVersion: dex.header.version,
    classCount: dex.header.classDefsSize,
    methodsWithCode,
    methodsWithDebugInfo,
    methodsWithParameterNames,
    linePositions,
    localDeclarations,
    explicitLocalDeclarations,
    setFileEvents,
    sourceFilePresent,
    distinctSourceFiles: {
      count: distinctSources,
      sample: sourceSample,
    },
    unreadable: {
      classData: unreadableClassData,
      codeItems: unreadableCodeItems,
      debugInfo: malformedDebugInfo,
    },
    readiness: classifyReadiness(
      explicitLocalDeclarations,
      methodsWithParameterNames,
      linePositions,
      unreadableClassData + unreadableCodeItems + malformedDebugInfo,
    ),
  });
};
