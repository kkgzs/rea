import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  CDP_WORKER_NETWORK_LIMITS,
  CdpWorkerNetworkObservation,
} from "./CdpPageCaptureWorkerNetwork.js";

const origin = "http://127.0.0.1:43127";

const observation = (
  options: { readonly includeWebSocketShapes?: boolean } = {},
) => {
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: origin,
    allowed_origins: [origin],
    target_id: "page",
    include_websocket_shapes: options.includeWebSocketShapes ?? false,
  });
  const events = new CdpCaptureEvents(input, new Set([origin]));
  events.beginAuthorizedFrame("frame-main");
  const sent: {
    method: string;
    params: unknown;
    sessionId: string | undefined;
  }[] = [];
  const connection = {
    async send(method: string, params: unknown, sessionId?: string) {
      sent.push({ method, params, sessionId });
      return {};
    },
  } as unknown as CdpConnection;
  const workers = new CdpWorkerNetworkObservation(
    { connection, sessionId: "page-session" },
    events,
    new Set([origin]),
    [],
  );
  return { events, sent, workers };
};

const attached = (sessionId: string) => ({
  sessionId: "page-session",
  method: "Target.attachedToTarget",
  params: {
    sessionId,
    targetInfo: { targetId: sessionId, type: "worker", url: `${origin}/w.js` },
    waitingForDebugger: false,
  },
});

const requested = (sessionId: string, requestId: string) => ({
  sessionId,
  method: "Network.requestWillBeSent",
  params: {
    requestId,
    type: "Fetch",
    request: { url: `${origin}/data`, method: "GET" },
    initiator: { type: "script" },
  },
});

describe("CDP worker network admission", () => {
  it("admits at most the worker budget and counts omitted workers", async () => {
    const { events, sent, workers } = observation();
    await workers.start();
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.workers + 3;
      index += 1
    )
      workers.ingest(attached(`worker-${String(index)}`));
    await workers.settle();

    expect(
      sent.filter(({ method }) => method === "Network.enable"),
    ).toHaveLength(CDP_WORKER_NETWORK_LIMITS.workers);
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining(
        ["network_requests", "websocket_connections", "websocket_frames"].map(
          (section) => ({
            section,
            reason: "resource_budget_exhausted",
            count: null,
          }),
        ),
      ),
    );
    expect(events.completeness.snapshot().truncated_sections).toContain(
      "network_requests",
    );
    expect(
      sent
        .filter(({ method }) => method === "Target.detachFromTarget")
        .map(({ params, sessionId }) => [sessionId, params]),
    ).toEqual(
      [0, 1, 2].map((offset) => [
        "page-session",
        {
          sessionId: `worker-${String(CDP_WORKER_NETWORK_LIMITS.workers + offset)}`,
        },
      ]),
    );
  });

  it("stops retaining worker requests and WebSockets past the request budget", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.requests + 2;
      index += 1
    )
      workers.ingest(requested("worker-0", `request-${String(index)}`));

    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });

    expect(events.network.size).toBe(CDP_WORKER_NETWORK_LIMITS.requests);
    expect(events.webSocketConnectionsById.size).toBe(0);
    const { excluded, truncated_sections } = events.completeness.snapshot();
    expect(excluded).toEqual(
      expect.arrayContaining([
        {
          section: "network_requests",
          reason: "resource_budget_exhausted",
          count: 2,
        },
        {
          section: "websocket_connections",
          reason: "resource_budget_exhausted",
          count: 1,
        },
        {
          section: "websocket_frames",
          reason: "resource_budget_exhausted",
          count: null,
        },
      ]),
    );
    expect(truncated_sections).toEqual(
      expect.arrayContaining(["websocket_connections", "websocket_frames"]),
    );
  });

  it("bounds releases of refused workers and stops them after admission closes", async () => {
    const { sent, workers } = observation();
    await workers.start();
    const excess = CDP_WORKER_NETWORK_LIMITS.releases + 5;
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.workers + excess;
      index += 1
    )
      workers.ingest(attached(`worker-${String(index)}`));
    await workers.settle();
    workers.ingest(attached("after-settle"));
    await workers.close();

    const released = sent.filter(
      ({ method }) => method === "Target.detachFromTarget",
    );
    expect(released).toHaveLength(CDP_WORKER_NETWORK_LIMITS.releases);
    expect(released.map(({ params }) => params)).not.toContainEqual({
      sessionId: "after-settle",
    });
  });
});

describe("CDP worker network request ownership", () => {
  it("drops worker WebSocket frames past the frame budget", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });
    for (
      let index = 0;
      index < CDP_WORKER_NETWORK_LIMITS.frames + 3;
      index += 1
    )
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.webSocketFrameReceived",
        params: {
          requestId: "socket-0",
          timestamp: index,
          response: { opcode: 1, mask: false, payloadData: "x" },
        },
      });

    expect(
      events.webSocketConnectionsById.get("socket-0")?.events,
    ).toHaveLength(CDP_WORKER_NETWORK_LIMITS.frames);
    const { dropped_events, truncated_sections } =
      events.completeness.snapshot();
    expect(dropped_events.websocket_frames).toBe(3);
    expect(truncated_sections).toContain("websocket_frames");
  });

  it("reports a worker request whose ID another session already owns", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    workers.ingest(attached("worker-1"));
    await workers.settle();
    events.ingest(requested("page-session", "page-owned"));
    workers.ingest(requested("worker-0", "page-owned"));
    workers.ingest(requested("worker-0", "worker-owned"));
    workers.ingest(requested("worker-1", "worker-owned"));
    workers.ingest({
      sessionId: "worker-1",
      method: "Network.webSocketCreated",
      params: { requestId: "worker-owned", url: "ws://127.0.0.1:43127/live" },
    });

    expect(events.network.size).toBe(2);
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining([
        {
          section: "network_requests",
          reason: "invalid_protocol_value",
          count: 2,
        },
        {
          section: "websocket_connections",
          reason: "invalid_protocol_value",
          count: 1,
        },
      ]),
    );
  });

  it("does not spend worker budgets on traffic the origin policy excludes", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    const socket = (requestId: string, url: string) => ({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId, url },
    });
    const frame = (requestId: string, timestamp: number) => ({
      sessionId: "worker-0",
      method: "Network.webSocketFrameReceived",
      params: {
        requestId,
        timestamp,
        response: { opcode: 1, mask: false, payloadData: "x" },
      },
    });
    workers.ingest(socket("foreign-socket", "ws://foreign.example.test/live"));
    for (let index = 0; index < CDP_WORKER_NETWORK_LIMITS.frames; index += 1)
      workers.ingest(frame("foreign-socket", index));
    for (let index = 0; index < CDP_WORKER_NETWORK_LIMITS.requests; index += 1)
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.requestWillBeSent",
        params: {
          requestId: `foreign-${String(index)}`,
          type: "Fetch",
          request: { url: "https://foreign.example.test/data", method: "GET" },
          initiator: { type: "script" },
        },
      });
    workers.ingest(socket("allowed-socket", "ws://127.0.0.1:43127/live"));
    workers.ingest(frame("allowed-socket", 0));
    workers.ingest(requested("worker-0", "allowed-request"));

    expect(
      events.webSocketConnectionsById.get("allowed-socket")?.events,
    ).toHaveLength(1);
    expect(events.network.has("allowed-request")).toBe(true);
    const { dropped_events, excluded } = events.completeness.snapshot();
    expect(dropped_events.websocket_frames).toBe(0);
    expect(excluded).not.toContainEqual(
      expect.objectContaining({ reason: "resource_budget_exhausted" }),
    );
  });
});

describe("CDP worker network shapes, page ownership and malformed attachments", () => {
  it("bounds retained worker frame payload bytes when shapes are captured", async () => {
    const { events, workers } = observation({ includeWebSocketShapes: true });
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest({
      sessionId: "worker-0",
      method: "Network.webSocketCreated",
      params: { requestId: "socket-0", url: "ws://127.0.0.1:43127/live" },
    });
    const payloadData = JSON.stringify({ value: "x".repeat(1024 * 1024) });
    const payloadBytes = Buffer.byteLength(payloadData);
    const retained = Math.floor(
      CDP_WORKER_NETWORK_LIMITS.frameBytes / payloadBytes,
    );
    for (let index = 0; index < retained + 2; index += 1)
      workers.ingest({
        sessionId: "worker-0",
        method: "Network.webSocketFrameReceived",
        params: {
          requestId: "socket-0",
          timestamp: index,
          response: { opcode: 1, mask: false, payloadData },
        },
      });

    expect(
      events.webSocketConnectionsById.get("socket-0")?.events,
    ).toHaveLength(retained);
    const { dropped_events, truncated_sections } =
      events.completeness.snapshot();
    expect(dropped_events.websocket_frames).toBe(2);
    expect(truncated_sections).toContain("websocket_frames");
  });

  it("keeps page Network events off a record a worker owns", async () => {
    const { events, workers } = observation();
    await workers.start();
    workers.ingest(attached("worker-0"));
    await workers.settle();
    workers.ingest(requested("worker-0", "shared-id"));
    const page = (method: string, params: Record<string, unknown>) => {
      const event = { sessionId: "page-session", method, params };
      if (workers.admitsPageEvent(event)) events.ingest(event);
    };
    page("Network.requestWillBeSent", {
      requestId: "shared-id",
      type: "Fetch",
      request: { url: `${origin}/page-data`, method: "POST" },
      initiator: { type: "script" },
    });
    page("Network.responseReceived", {
      requestId: "shared-id",
      response: {
        url: `${origin}/page-data`,
        status: 500,
        mimeType: "text/html",
      },
    });

    expect(events.network.get("shared-id")).toMatchObject({
      url: `${origin}/data`,
      method: "GET",
      status: null,
    });
    expect(workers.responseBodySession("shared-id")?.sessionId).toBe(
      "worker-0",
    );
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: 1,
    });
  });

  it("releases a malformed attachment that still names a session", async () => {
    const { events, sent, workers } = observation();
    await workers.start();
    workers.ingest({
      sessionId: "page-session",
      method: "Target.attachedToTarget",
      params: { sessionId: "malformed-session", waitingForDebugger: false },
    });
    await workers.settle();

    expect(sent).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "malformed-session" },
      sessionId: "page-session",
    });
    expect(events.completeness.snapshot().excluded).toEqual(
      expect.arrayContaining(
        ["network_requests", "websocket_connections", "websocket_frames"].map(
          (section) => ({
            section,
            reason: "invalid_protocol_value",
            count: null,
          }),
        ),
      ),
    );
  });
});
