import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import {
  allowedSanitizedUrl,
  cdpStringValue,
  isHttpUrl,
  recordValue,
} from "./CdpCaptureValues.js";

/**
 * Bounds one capture's worker attachments, the detach commands that release
 * refused workers, and retained worker request identities and WebSocket
 * frames. Each admitted worker holds a browser session and two commands; the
 * request and frame bounds match the script metadata record bound, and the
 * frame payload bound, applied when WebSocket shapes are inferred, matches the
 * script metadata byte bound.
 */
export const CDP_WORKER_NETWORK_LIMITS = {
  workers: 256,
  releases: 256,
  requests: 50_000,
  frames: 50_000,
  frameBytes: 8 * 1024 * 1024,
} as const;

/** Auto-attach dedicated workers on a session without pausing their start. */
const WORKER_AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "worker" }],
} as const;

/** Sections one unobserved worker leaves incomplete; its counts are unknown. */
const WORKER_TRAFFIC_SECTIONS = [
  "network_requests",
  "websocket_connections",
  "websocket_frames",
] as const;

/** Chrome's reply for a command sent to a session that no longer exists. */
const SESSION_NOT_FOUND = -32_001;

/** Events that open a request or WebSocket lifecycle on one session. */
const REQUEST_START_EVENTS: ReadonlySet<string> = new Set([
  "Network.requestWillBeSent",
  "Network.webSocketCreated",
]);

/** Events that each retain one WebSocket frame. */
const WEBSOCKET_FRAME_EVENTS: ReadonlySet<string> = new Set([
  "Network.webSocketFrameSent",
  "Network.webSocketFrameReceived",
]);

interface WorkerNetworkContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal?: AbortSignal;
}

/**
 * Observe the network activity of the page's own dedicated workers.
 *
 * Chrome reports a dedicated worker's requests on the worker target rather
 * than on the page that created it. REA auto-attaches those workers, and the
 * workers they start, without pausing them, enables only their Network
 * domain, and routes their Network events through the page's origin policy.
 * Auto-attached sessions belong to the page session, so detaching the page
 * session also releases them.
 */
export class CdpWorkerNetworkObservation {
  /** Admitted worker sessions; each signal aborts when its session detaches. */
  readonly #workerSessions = new Map<string, AbortController>();
  readonly #requestSessions = new Map<string, string>();
  readonly #pending = new Set<Promise<void>>();
  #admittedWorkers = 0;
  #releases = 0;
  #workerFrames = 0;
  #workerFrameBytes = 0;
  #failure: { readonly cause: unknown } | undefined;
  /** Workers are admitted only from `start()` until `settle()` or `close()`. */
  #admitting = false;

  constructor(
    private readonly context: WorkerNetworkContext,
    private readonly events: CdpCaptureEvents,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly limitations: string[],
  ) {}

  /** Auto-attach existing and new dedicated workers without pausing them. */
  async start(): Promise<void> {
    // Chrome can report existing workers before it answers this command.
    this.#admitting = true;
    const result = await optionalCdpCommand(
      this.context,
      "Target.setAutoAttach",
      WORKER_AUTO_ATTACH,
      this.limitations,
    );
    if (result === undefined) {
      this.#admitting = false;
      this.#workerTrafficOmitted("provider_unavailable");
      return;
    }
    this.limitations.push(
      "Dedicated worker network activity, including workers started by other workers, is observed from when REA attaches to each worker; requests a worker sends before then, and service or shared worker requests, are unavailable.",
    );
  }

  /** Track worker sessions and forward Network events of requests they started. */
  ingest(event: CdpEvent): void {
    const fromWorker =
      event.sessionId !== undefined &&
      this.#workerSessions.has(event.sessionId);
    if (event.sessionId === this.context.sessionId || fromWorker) {
      if (event.method === "Target.attachedToTarget") {
        this.#attached(event.sessionId, event.params);
        return;
      }
      if (event.method === "Target.detachedFromTarget") {
        this.#detached(event.params);
        return;
      }
    }
    if (
      !fromWorker ||
      event.sessionId === undefined ||
      !event.method.startsWith("Network.")
    )
      return;
    const requestId = cdpStringValue(recordValue(event.params)?.requestId);
    if (requestId !== undefined) {
      const owner = this.#requestSessions.get(requestId);
      const starts = REQUEST_START_EVENTS.has(event.method);
      if (owner === undefined) {
        // Chrome announces a worker's own script on the page session and
        // completes it on the worker session. Keep page-owned records and
        // requests that began before attachment out of the worker lifecycle.
        if (!starts) return;
        if (
          this.events.network.has(requestId) ||
          this.events.webSocketConnectionsById.has(requestId)
        ) {
          this.#requestOmitted(event.method, "invalid_protocol_value");
          return;
        }
        if (this.#requestSessions.size >= CDP_WORKER_NETWORK_LIMITS.requests) {
          this.#requestOmitted(event.method, "resource_budget_exhausted");
          return;
        }
        this.#requestSessions.set(requestId, event.sessionId);
      } else if (owner !== event.sessionId) {
        // Each session has its own Network domain, so an ID another session
        // already owns cannot be attributed; report it instead of merging.
        if (starts)
          this.#requestOmitted(event.method, "invalid_protocol_value");
        return;
      } else if (WEBSOCKET_FRAME_EVENTS.has(event.method)) {
        // Only frames of a connection the origin policy kept are retained.
        if (!this.events.webSocketConnectionsById.has(requestId)) return;
        // Shape inference retains names from the payload, so bound its bytes.
        const payloadBytes = this.events.input.include_websocket_shapes
          ? Buffer.byteLength(
              cdpStringValue(
                recordValue(recordValue(event.params)?.response)?.payloadData,
              ) ?? "",
            )
          : 0;
        if (
          this.#workerFrames >= CDP_WORKER_NETWORK_LIMITS.frames ||
          this.#workerFrameBytes + payloadBytes >
            CDP_WORKER_NETWORK_LIMITS.frameBytes
        ) {
          this.events.completeness.drop("websocket_frames");
          return;
        }
        this.#workerFrames += 1;
        this.#workerFrameBytes += payloadBytes;
      }
    }
    this.events.ingest(event);
    // A start the origin policy rejected keeps no record; free its budget slot.
    if (
      requestId !== undefined &&
      REQUEST_START_EVENTS.has(event.method) &&
      !this.events.network.has(requestId) &&
      !this.events.webSocketConnectionsById.has(requestId)
    )
      this.#requestSessions.delete(requestId);
  }

  /**
   * Whether a page-session event may reach the shared capture state. Network
   * events for an ID a worker session owns would merge two producers, so a
   * page start on such an ID is reported and the page's events are kept off
   * the worker's record.
   */
  admitsPageEvent(event: CdpEvent): boolean {
    if (!event.method.startsWith("Network.")) return true;
    const requestId = cdpStringValue(recordValue(event.params)?.requestId);
    if (requestId === undefined || !this.#requestSessions.has(requestId))
      return true;
    if (REQUEST_START_EVENTS.has(event.method))
      this.#requestOmitted(event.method, "invalid_protocol_value");
    return false;
  }

  /** Report an omitted request or WebSocket in the section callers read for it. */
  #requestOmitted(method: string, reason: BrowserExclusionReason): void {
    const { completeness } = this.events;
    if (method !== "Network.webSocketCreated") {
      completeness.exclude("network_requests", reason);
      return;
    }
    completeness.exclude("websocket_connections", reason);
    // The omitted connection's frames are never observed, so their count is unknown.
    completeness.exclude("websocket_frames", reason, null);
  }

  /**
   * Select the session that can return a request's response body. `undefined`
   * means the request came from a worker whose session has already detached.
   */
  responseBodySession(requestId: string):
    | {
        readonly sessionId: string | undefined;
        /** Aborts when the owning worker detaches; Chrome then never replies. */
        readonly detached?: AbortSignal;
      }
    | undefined {
    const workerSession = this.#requestSessions.get(requestId);
    if (workerSession === undefined)
      return { sessionId: this.context.sessionId };
    const detach = this.#workerSessions.get(workerSession);
    return detach === undefined
      ? undefined
      : { sessionId: workerSession, detached: detach.signal };
  }

  /**
   * Stop admitting workers, drain their commands, and surface transport or
   * cancellation failures. Call before the final page check so nothing a
   * worker command does can land after that check.
   */
  async settle(): Promise<void> {
    this.#admitting = false;
    await this.#drain();
    if (this.#failure !== undefined) throw this.#failure.cause;
  }

  /** Stop admitting workers and wait for issued commands before the session closes. */
  async close(): Promise<void> {
    this.#admitting = false;
    await this.#drain();
  }

  #attached(parentSessionId: string | undefined, value: unknown): void {
    const params = recordValue(value);
    const sessionId = cdpStringValue(params?.sessionId);
    const targetInfo = recordValue(params?.targetInfo);
    const type = cdpStringValue(targetInfo?.type);
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      targetInfo === undefined ||
      type === undefined
    ) {
      this.#workerTrafficOmitted("invalid_protocol_value");
      // Chrome created the child session even if it described it badly.
      if (sessionId !== undefined && sessionId.length > 0)
        this.#release(parentSessionId, sessionId);
      return;
    }
    // Browsers that ignore the auto-attach filter may still report frames.
    if (type !== "worker" || !this.#admitting) {
      this.#release(parentSessionId, sessionId);
      return;
    }
    const rawUrl = cdpStringValue(targetInfo.url);
    const refusal =
      allowedSanitizedUrl(rawUrl, this.allowedOrigins) === undefined
        ? rawUrl === undefined || rawUrl === ""
          ? "unattributed_origin"
          : isHttpUrl(rawUrl)
            ? "disallowed_origin"
            : "unsupported_url"
        : this.#admittedWorkers >= CDP_WORKER_NETWORK_LIMITS.workers
          ? "resource_budget_exhausted"
          : undefined;
    if (refusal !== undefined) {
      this.#workerTrafficOmitted(refusal);
      this.#release(parentSessionId, sessionId);
      return;
    }
    this.#admittedWorkers += 1;
    const detach = new AbortController();
    this.#workerSessions.set(sessionId, detach);
    this.#track(this.#observeWorker(parentSessionId, sessionId, detach.signal));
  }

  /** Record that one whole worker's requests and WebSockets are unobserved. */
  #workerTrafficOmitted(reason: BrowserExclusionReason): void {
    for (const section of WORKER_TRAFFIC_SECTIONS)
      this.events.completeness.exclude(section, reason, null);
  }

  /**
   * Detach an auto-attached session REA does not observe; Chrome keeps the
   * worker running. Best effort and bounded: at most `releases` per capture
   * and none once admission closes, so `settle()` always finishes. Turning
   * auto-attach off instead would also detach admitted workers. Any session
   * left attached is released with the page session.
   */
  #release(parentSessionId: string | undefined, sessionId: string): void {
    if (
      !this.#admitting ||
      this.#releases >= CDP_WORKER_NETWORK_LIMITS.releases
    )
      return;
    this.#releases += 1;
    const signals = [
      this.context.signal,
      parentSessionId === undefined
        ? undefined
        : this.#workerSessions.get(parentSessionId)?.signal,
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    this.#track(
      this.context.connection
        .send(
          "Target.detachFromTarget",
          { sessionId },
          parentSessionId,
          signals.length === 0 ? undefined : AbortSignal.any(signals),
        )
        .then(
          () => undefined,
          () => undefined,
        ),
    );
  }

  #detached(value: unknown): void {
    const sessionId = cdpStringValue(recordValue(value)?.sessionId);
    if (sessionId === undefined) return;
    // Chrome does not answer commands pending on a session that detaches.
    this.#workerSessions.get(sessionId)?.abort();
    this.#workerSessions.delete(sessionId);
  }

  /** Enable the worker's Network domain, then auto-attach the workers it starts. */
  async #observeWorker(
    parentSessionId: string | undefined,
    sessionId: string,
    detached: AbortSignal,
  ): Promise<void> {
    try {
      await this.#send("Network.enable", {}, sessionId, detached);
    } catch (cause: unknown) {
      const live = this.#rejected(sessionId, cause, detached);
      this.#workerSessions.delete(sessionId);
      if (live) this.#release(parentSessionId, sessionId);
      return;
    }
    try {
      await this.#send(
        "Target.setAutoAttach",
        WORKER_AUTO_ATTACH,
        sessionId,
        detached,
      );
    } catch (cause: unknown) {
      this.#rejected(sessionId, cause, detached);
    }
  }

  async #send(
    method: string,
    parameters: Readonly<Record<string, unknown>>,
    sessionId: string,
    detached: AbortSignal,
  ): Promise<void> {
    await this.context.connection.send(
      method,
      parameters,
      sessionId,
      this.context.signal === undefined
        ? detached
        : AbortSignal.any([this.context.signal, detached]),
    );
  }

  /**
   * Classify a rejected worker command. A worker can exit before its session
   * accepts or answers commands; network coverage is already attach-limited,
   * so that does not invalidate the page capture. Any other rejection from a live
   * worker leaves its traffic unobserved and is reported as unavailable.
   * Transport and cancellation failures propagate. Returns whether the
   * worker session is still live.
   */
  #rejected(sessionId: string, cause: unknown, detached: AbortSignal): boolean {
    if (
      cause instanceof AnalysisCancelledError &&
      detached.aborted &&
      this.context.signal?.aborted !== true
    )
      return false;
    if (!(cause instanceof CdpCommandRejection)) throw cause;
    if (
      !this.#workerSessions.has(sessionId) ||
      cause.code === SESSION_NOT_FOUND
    ) {
      this.#workerSessions.delete(sessionId);
      return false;
    }
    this.#workerTrafficOmitted("provider_unavailable");
    return true;
  }

  #track(operation: Promise<void>): void {
    const tracked: Promise<void> = operation
      .catch((cause: unknown) => {
        this.#failure ??= { cause };
      })
      .finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  async #drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }
}
