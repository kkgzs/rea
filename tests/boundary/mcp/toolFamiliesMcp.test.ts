import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { TOOL_FAMILY_DEFINITIONS } from "../../../src/contracts/toolFamilies.js";
import { registerSessionStatusTool } from "../../../src/server/registerSessionStatusTool.js";
import type { BinarySessionPort } from "../../../src/application/binary/BinarySessionPort.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

const scopedServer = (
  advertisedToolFamilies: ReadonlySet<string> | undefined,
): EvidenceMcpServer =>
  new EvidenceMcpServer(
    { name: "tool-families", version: "0" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    undefined,
    false,
    advertisedToolFamilies,
  );

const registerCatalog = (server: EvidenceMcpServer): void => {
  for (const contract of TOOL_CONTRACTS)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({ content: [] }),
    );
};

const withClient = async (
  server: EvidenceMcpServer,
  use: (client: Client) => Promise<void>,
): Promise<void> => {
  const client = new Client({ name: "tool-families", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await use(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
};

const familyTools = (...ids: readonly string[]): readonly string[] =>
  TOOL_FAMILY_DEFINITIONS.filter(({ id }) => ids.includes(id)).flatMap(
    ({ contracts }) => contracts.map(({ name }) => name),
  );

describe("MCP tool family advertising", () => {
  it("advertises every catalog tool when no scope is set", async () => {
    const server = scopedServer(undefined);
    registerCatalog(server);
    await withClient(server, async (client) => {
      expect(
        (await client.listTools()).tools.map(({ name }) => name).sort(),
      ).toEqual(TOOL_CONTRACTS.map(({ name }) => name).sort());
    });
  });

  it("advertises only the scoped families", async () => {
    const server = scopedServer(new Set(["session", "javascript-runtime"]));
    registerCatalog(server);
    await withClient(server, async (client) => {
      const advertised = (await client.listTools()).tools
        .map(({ name }) => name)
        .sort();
      expect(advertised).toEqual(
        [...familyTools("session", "javascript-runtime")].sort(),
      );
      expect(advertised).not.toContain("inspect_macho");
    });
  });

  it("fails calls to out-of-scope tools with the disabled-tool error", async () => {
    const server = scopedServer(new Set(["session"]));
    registerCatalog(server);
    await withClient(server, async (client) => {
      await expect(
        client.callTool({ name: "list_frida_devices" }),
      ).rejects.toThrow(/disabled/u);
    });
  });

  it("reflects the scope in availability reports", () => {
    const server = scopedServer(new Set(["session"]));
    registerCatalog(server);
    // Status reporting must not advertise a tool the registration disables.
    expect(server.advertisesTool("open_binary")).toBe(true);
    expect(server.advertisesTool("analyze_javascript_application")).toBe(false);
    expect(server.advertisesTool("inspect_macho")).toBe(false);
  });

  it("advertises every tool in availability reports when no scope is set", () => {
    const server = scopedServer(undefined);
    registerCatalog(server);
    for (const { name } of TOOL_CONTRACTS)
      expect(server.advertisesTool(name)).toBe(true);
  });

  it.each([
    { scope: ["session"], probed: [] },
    { scope: ["session", "android", "adb"], probed: ["android", "adb"] },
  ])(
    "probes only advertised families for binary_session status ($scope)",
    async ({ scope, probed }) => {
      const server = scopedServer(new Set(scope));
      const calls: string[] = [];
      const probe = (name: string) => async () => {
        calls.push(name);
        return {
          status: "unavailable",
          code: "runtime_missing",
          reason: `${name} runtime is unavailable`,
          diagnostics: {},
        } as const;
      };
      registerSessionStatusTool({
        server,
        session: { status: () => ({}) } as unknown as BinarySessionPort,
        contract: toolContract("binary_session"),
        startedAt: new Date().toISOString(),
        availabilityPolicy: () => ({ processCaptureEnabled: false }),
        androidAnalysisAvailability: probe("android"),
        adbAnalysisAvailability: probe("adb"),
        apktoolAnalysisAvailability: probe("apktool"),
        jebAnalysisAvailability: probe("jeb"),
      });
      await withClient(server, async (client) => {
        await client.callTool({ name: "binary_session", arguments: {} });
      });
      expect(calls.sort()).toEqual([...probed].sort());
    },
  );
});
