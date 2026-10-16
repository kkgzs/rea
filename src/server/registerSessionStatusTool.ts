import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { JebAnalysisAvailability } from "../application/jeb/JebAnalysisPort.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  buildCapabilityInventory,
  compactToolAvailability,
} from "../application/CapabilityInventory.js";
import { toolContract } from "../contracts/toolContracts.js";
import type {
  ClientFeatureAvailability,
  ToolAvailability,
} from "../contracts/toolOutputSchemaPrimitives.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { createServerIdentity } from "../serverIdentity.js";
import { mcpClientMetadata } from "./mcpClientMetadata.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { err } from "../domain/result.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";

/** Provider-owned live probes used by session discovery. */
export interface SessionAvailabilityProbes {
  readonly androidAnalysisAvailability: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly adbAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly apktoolAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<ProviderAvailability>;
  readonly jebAnalysisAvailability?: (
    signal: AbortSignal,
  ) => Promise<JebAnalysisAvailability>;
}

/** Inputs required to register the binary session status tool. */
export interface SessionStatusToolOptions extends SessionAvailabilityProbes {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort;
  readonly contract: ReturnType<typeof toolContract<"binary_session">>;
  readonly startedAt: string;
  readonly availabilityPolicy: () => AvailabilityPolicy;
}

/** Register the read-only provider and target status operation. */
export const registerSessionStatusTool = (
  options: SessionStatusToolOptions,
): void => {
  const {
    server,
    session,
    contract,
    startedAt,
    availabilityPolicy,
    androidAnalysisAvailability,
    adbAnalysisAvailability,
    apktoolAnalysisAvailability,
    jebAnalysisAvailability,
  } = options;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const { client, clientFeatures, protocolVersion } = mcpClientMetadata(
        context,
        server.server,
      );
      let androidAvailability: ProviderAvailability | undefined;
      let adbAvailability: ProviderAvailability | undefined;
      let apktoolAvailability: ProviderAvailability | undefined;
      let jebAvailability: JebAnalysisAvailability | undefined;
      try {
        // Probe only families this registration advertises. Scoped-out
        // providers keep the established not-configured shape instead of
        // launching probes whose tools cannot appear in the response.
        const [android, adb, apktool, jeb] = await Promise.all([
          server.advertisesFamily("android")
            ? androidAnalysisAvailability(context.mcpReq.signal)
            : undefined,
          server.advertisesFamily("adb")
            ? (adbAnalysisAvailability?.(context.mcpReq.signal) ?? undefined)
            : undefined,
          server.advertisesFamily("apktool")
            ? (apktoolAnalysisAvailability?.(context.mcpReq.signal) ??
              undefined)
            : undefined,
          server.advertisesFamily("jeb")
            ? (jebAnalysisAvailability?.(context.mcpReq.signal) ?? undefined)
            : undefined,
        ] as const);
        androidAvailability = android;
        adbAvailability = adb;
        apktoolAvailability = apktool;
        jebAvailability = jeb;
      } catch (cause) {
        if (!context.mcpReq.signal.aborted) throw cause;
        return server.delivery.toCallToolResult(
          err(new AnalysisCancelledError("binary_session")),
          contract,
        );
      }
      const status = session.status();
      const statusObject = jsonObjectSchema.parse(status);
      const toolAvailability = buildCapabilityInventory(
        status,
        {
          ...availabilityPolicy(),
          ...(androidAvailability === undefined
            ? {}
            : { androidAnalysisAvailability: androidAvailability }),
          ...(adbAvailability === undefined
            ? {}
            : { adbAnalysisAvailability: adbAvailability }),
          ...(apktoolAvailability === undefined
            ? {}
            : { apktoolAnalysisAvailability: apktoolAvailability }),
          ...(jebAvailability === undefined
            ? {}
            : { jebAnalysisAvailability: jebAvailability }),
        },
        clientFeatures,
      ).filter(({ name }) => server.advertisesTool(name));
      const serverIdentity = createServerIdentity({
        startedAt,
        commandPath: CURRENT_ENTRYPOINT_PATH,
        catalog: server.catalogIdentity,
        expected: {
          ...(input.expected_package_version === undefined
            ? {}
            : { package_version: input.expected_package_version }),
          ...(input.expected_catalog_digest === undefined
            ? {}
            : { catalog_digest: input.expected_catalog_digest }),
          ...(input.expected_server_path === undefined
            ? {}
            : { server_path: input.expected_server_path }),
        },
        ...(client === undefined ? {} : { client }),
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
      });
      return server.delivery.toCallToolResult(
        {
          ok: true,
          value: projectSessionStatus({
            status: statusObject,
            toolAvailability,
            serverIdentity,
            clientFeatures,
          }),
        },
        contract,
      );
    },
  );
};

const projectSessionStatus = (options: {
  readonly status: Readonly<
    Record<string, import("../domain/jsonValue.js").JsonValue>
  >;
  readonly toolAvailability: readonly ToolAvailability[];
  readonly serverIdentity: ReturnType<typeof createServerIdentity>;
  readonly clientFeatures: ClientFeatureAvailability;
}) =>
  jsonObjectSchema.parse({
    ...options.status,
    tool_availability: compactToolAvailability(options.toolAvailability),
    client_features: options.clientFeatures,
    server_identity: options.serverIdentity,
  });
