import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
  type OwnedProviderProcessSpawnOptions,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";
import {
  hashFirmwareFile,
  inventoryFirmwareOutput,
  readFirmwareReport,
} from "./FirmwareFiles.js";

/** Injectable owned launcher for production protocol and lifecycle tests. */
export type FirmwareLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Refuse an unmet host or tool requirement, which another target cannot satisfy. */
export const firmwareToolUnavailable = (
  engine: string,
  operation: string,
  reason: string,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(engine, operation, reason, {
    userMessage: reason,
  });

/** Preserve the operation's typed failure while attaching descriptor cleanup. */
export const firmwareFileCleanupError = (
  failure: RegularFileCleanupFailure,
  engine: string,
  operation: string,
  execution?: {
    exit_code?: number | null;
    signal?: string | null;
    stdout: { bytes: number; text: string };
    stderr: { bytes: number; text: string };
  },
): AnalysisError => {
  const cleanup = new ProviderCleanupError(
    engine,
    [failure.path],
    {
      reason:
        failure.cleanupCause instanceof Error
          ? failure.cleanupCause.message
          : String(failure.cleanupCause),
    },
    { cause: failure, operation },
  );
  if (failure.outcome.kind === "completed") return cleanup;
  const primaryCause = failure.outcome.cause;
  let primary: AnalysisError;
  if (primaryCause instanceof AnalysisError) {
    primary = primaryCause;
  } else if (execution?.exit_code === 1) {
    primary = new ProviderAdapterError(engine, operation, {
      cause: primaryCause,
      diagnostics: {
        reason:
          "Tool exited 1 without a usable analysis report; inspect stderr for startup, sandbox or dependency failures",
        report_failure:
          primaryCause instanceof Error
            ? primaryCause.message
            : String(primaryCause),
        exit_code: 1,
        signal: execution.signal ?? null,
        stdout: execution.stdout.text,
        stderr: execution.stderr.text,
        stdout_bytes: execution.stdout.bytes,
        stderr_bytes: execution.stderr.bytes,
      },
    });
  } else {
    const diagnostics =
      execution !== undefined
        ? `stdout (${execution.stdout.bytes} bytes): ${execution.stdout.text}; stderr (${execution.stderr.bytes} bytes): ${execution.stderr.text}`
        : "";
    primary = new AnalysisOutputError(
      operation,
      diagnostics.length > 0
        ? `Tool did not produce the expected complete report: ${failure.path}; ${diagnostics}`
        : `Tool did not produce the expected complete report: ${failure.path}`,
      { cause: primaryCause },
    );
  }
  return analysisErrorWithCleanupFailure(primary, cleanup, operation);
};

/** Resolve explicitly supplied executable paths; never install or search for engines. */
export const resolveFirmwareCommand = async (
  environment: Readonly<Record<string, string | undefined>>,
  engine: "binwalk" | "unblob",
  operation: string,
  retainFailedClose?: (owner: OwnedFileHandle, path: string) => void,
) => {
  const variable =
    engine === "binwalk" ? "REA_BINWALK_COMMAND" : "REA_UNBLOB_COMMAND";
  const configured = environment[variable];
  if (
    process.platform !== "linux" ||
    configured === undefined ||
    !isAbsolute(configured)
  )
    throw firmwareToolUnavailable(
      engine,
      operation,
      `This integration requires Linux and an absolute ${variable} path to the caller-supplied tool`,
    );
  const command = await realpath(configured).catch((cause: unknown) => {
    throw firmwareToolUnavailable(
      engine,
      operation,
      `${variable} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  });
  let sha256: string;
  try {
    await access(command, constants.R_OK | constants.X_OK);
    if (!(await stat(command)).isFile())
      throw new TypeError("Configured path is not a regular file");
    sha256 = await hashFirmwareFile(command, {
      retainFailedClose: (owner) => retainFailedClose?.(owner, command),
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      throw firmwareFileCleanupError(cause, engine, operation);
    }
    throw firmwareToolUnavailable(
      engine,
      operation,
      `${variable} is not a readable executable regular file: ${command}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const limiter =
    environment.REA_FIRMWARE_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
  if (!isAbsolute(limiter))
    throw firmwareToolUnavailable(
      engine,
      operation,
      "REA_FIRMWARE_PRLIMIT_COMMAND must be absolute",
    );
  try {
    await access(limiter, constants.X_OK);
    if (!(await stat(limiter)).isFile())
      throw new TypeError("Configured path is not a regular file");
  } catch (cause: unknown) {
    throw firmwareToolUnavailable(
      engine,
      operation,
      `Resource limiter is not an executable regular file: ${limiter}: ${cause instanceof Error ? cause.message : String(cause)}; provide util-linux prlimit`,
    );
  }
  return { command, limiter, sha256 };
};

/** Execute one bounded provider command and verify its owned descendants have stopped. */
export const runFirmwareCommand = async (context: {
  engine: string;
  operation: string;
  command: string;
  limiter: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  launcher?: FirmwareLauncher;
  outputBudget?: { root: string; bytes: number; entries: number };
  acceptReportedExtractionFailure?: boolean;
  retainCleanup(supervisor: ProviderProcessSupervisor): void;
}) => {
  const { engine, operation, signal } = context;
  signal.throwIfAborted();
  const runId = `rea-firmware-${randomUUID()}`;
  const spawned = await (context.launcher ?? spawnOwnedProviderProcess)({
    command: context.limiter,
    arguments: [
      `--as=${FIRMWARE_LIMITS.addressSpaceBytes}`,
      `--fsize=${context.outputBudget?.bytes ?? FIRMWARE_LIMITS.reportBytes}`,
      "--core=0",
      "--cpu=120",
      "--",
      context.command,
      ...context.args,
    ],
    expectedCommand: null,
    runId,
    cwd: context.cwd,
    hostEnvironment: context.environment,
    signal,
    env: {
      TMPDIR: context.cwd,
      OMP_NUM_THREADS: "1",
      OPENBLAS_NUM_THREADS: "1",
      RAYON_NUM_THREADS: "1",
      NO_COLOR: "1",
    },
  });
  let diagnosticTruncated = false;
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    {
      maxDiagnosticBytes: FIRMWARE_LIMITS.diagnosticBytes,
      onDiagnostic: (event) => {
        if (event.type === "output" && event.truncated === true)
          diagnosticTruncated = true;
      },
    },
  );
  const checkDiagnostics = () => {
    if (diagnosticTruncated) {
      const snapshot = supervisor.snapshot();
      throw new AnalysisOutputError(
        operation,
        `Tool diagnostics exceeded the ${FIRMWARE_LIMITS.diagnosticBytes}-byte capture budget`,
        {
          capturedOutput: {
            stdout: snapshot.stdout.text,
            stderr: snapshot.stderr.text,
            truncated: true,
          },
        },
      );
    }
  };
  let failure: unknown;
  try {
    const deadline = performance.now() + FIRMWARE_LIMITS.timeoutMs;
    while (!(await supervisor.waitForOutputClose(100))) {
      checkDiagnostics();
      if (signal.aborted) throw new AnalysisCancelledError(operation);
      if (performance.now() >= deadline)
        throw new AnalysisTimeoutError(operation, FIRMWARE_LIMITS.timeoutMs);
      if (context.outputBudget !== undefined)
        await inventoryFirmwareOutput(
          context.outputBudget.root,
          context.outputBudget.bytes,
          context.outputBudget.entries,
          operation,
          signal,
        );
    }
    checkDiagnostics();
    if (signal.aborted) throw new AnalysisCancelledError(operation);
  } catch (cause: unknown) {
    failure = cause;
  }
  const stopped = await supervisor.stop();
  const snapshot = supervisor.snapshot();
  if (stopped.status === "incomplete") {
    context.retainCleanup(supervisor);
    throw new ProviderCleanupError(engine, [runId, context.cwd], {
      reason: stopped.reason,
      leader_pid: spawned.ownership.leaderPid,
      process_group_id: spawned.ownership.processGroupId,
      exit_code: snapshot.exitCode ?? null,
      signal: snapshot.signal ?? null,
      stdout: snapshot.stdout.text,
      stderr: snapshot.stderr.text,
      stdout_bytes: snapshot.stdout.bytes,
      stderr_bytes: snapshot.stderr.bytes,
      previous_error: failure instanceof Error ? failure.message : null,
    });
  }
  if (failure !== undefined) throw failure;
  if (
    snapshot.exitCode !== 0 &&
    !(
      context.acceptReportedExtractionFailure === true &&
      snapshot.exitCode === 1
    )
  )
    throw new ProviderAdapterError(engine, operation, {
      diagnostics: {
        reason:
          "Tool failed; inspect exit status and stderr for format, dependency, sandbox or resource-limit failures",
        exit_code: snapshot.exitCode ?? null,
        signal: snapshot.signal ?? null,
        stdout: snapshot.stdout.text,
        stderr: snapshot.stderr.text,
        stdout_bytes: snapshot.stdout.bytes,
        stderr_bytes: snapshot.stderr.bytes,
      },
    });
  return {
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    exit_code: snapshot.exitCode,
    signal: snapshot.signal ?? null,
    command: context.command,
    args: [...context.args],
    resource_limiter: context.limiter,
  };
};

/** Preserve tool failure diagnostics when an accepted exit 1 has no usable report. */
export const readFirmwareCommandReport = async (context: {
  path: string;
  engine: string;
  operation: string;
  execution: Awaited<ReturnType<typeof runFirmwareCommand>>;
  signal?: AbortSignal;
  retainFailedClose?: (owner: OwnedFileHandle) => void;
}): Promise<unknown> => {
  try {
    return await readFirmwareReport(context.path, context.operation, {
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(context.retainFailedClose !== undefined
        ? { retainFailedClose: context.retainFailedClose }
        : {}),
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) {
      const cleanupError = firmwareFileCleanupError(
        cause,
        context.engine,
        context.operation,
        context.execution,
      );
      if (cause.outcome.kind === "completed") {
        Object.assign(cleanupError, { completedReport: cause.outcome.value });
      }
      throw cleanupError;
    }
    if (context.execution.exit_code === 1)
      throw new ProviderAdapterError(context.engine, context.operation, {
        cause,
        diagnostics: {
          reason:
            "Tool exited 1 without a usable analysis report; inspect stderr for startup, sandbox or dependency failures",
          report_failure:
            cause instanceof Error ? cause.message : String(cause),
          exit_code: 1,
          signal: context.execution.signal,
          stdout: context.execution.stdout.text,
          stderr: context.execution.stderr.text,
          stdout_bytes: context.execution.stdout.bytes,
          stderr_bytes: context.execution.stderr.bytes,
        },
      });
    const diagnostics = `stdout (${context.execution.stdout.bytes} bytes): ${context.execution.stdout.text}; stderr (${context.execution.stderr.bytes} bytes): ${context.execution.stderr.text}`;
    if (cause instanceof AnalysisOutputError)
      throw new AnalysisOutputError(
        context.operation,
        `${cause.reason}; ${diagnostics}`,
        { cause },
      );
    throw new AnalysisOutputError(
      context.operation,
      `Tool did not produce the expected complete report: ${context.path}; ${diagnostics}`,
      { cause },
    );
  }
};
