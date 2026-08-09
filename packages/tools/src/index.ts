import type {
  SessionSnapshot,
  SetTempoParams,
  SetTempoResult,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import {
  defineTool,
  type PermissionHandler,
  type Tool,
} from "@github/copilot-sdk";
import { z } from "zod";

export type ToolRisk = "read" | "reversible" | "destructive" | "broad";
export type ToolDuration = "instant" | "short" | "long";

export interface AbletonToolMetadata {
  name: string;
  title: string;
  risk: ToolRisk;
  duration: ToolDuration;
  requiredCapability?: string;
}

export interface AbletonToolServices {
  getConnectionStatus(): Promise<ConnectionStatus>;
  inspectSession(): Promise<SessionSnapshot>;
  setTempo(tempo: number): Promise<SetTempoResult>;
}

export const abletonToolMetadata = [
  {
    name: "ableton_connection_status",
    title: "Check Ableton connection",
    risk: "read",
    duration: "instant",
  },
  {
    name: "ableton_session_inspect",
    title: "Inspect Ableton session",
    risk: "read",
    duration: "short",
    requiredCapability: "session.inspect",
  },
  {
    name: "ableton_transport_set_tempo",
    title: "Set Ableton tempo",
    risk: "reversible",
    duration: "instant",
    requiredCapability: "transport.set_tempo",
  },
] as const satisfies readonly AbletonToolMetadata[];

export interface ToolApprovalRequest {
  metadata: AbletonToolMetadata;
  arguments: Readonly<Record<string, unknown>>;
}

export type ToolApprovalRequester = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

export function createAbletonPermissionHandler(
  requestApproval?: ToolApprovalRequester,
): PermissionHandler {
  return async (request, invocation) => {
    if (invocation.managedSettingsEnabled || request.kind !== "custom-tool") {
      return { kind: "no-result" };
    }
    const metadata = abletonToolMetadata.find(
      (candidate) => candidate.name === request.toolName,
    );
    if (!metadata) {
      return { kind: "reject", feedback: "Unknown Ableton tool" };
    }
    if (metadata.risk === "read") {
      return { kind: "approve-once" };
    }
    if (!requestApproval) {
      return {
        kind: "reject",
        feedback: "Mutating Ableton tools require explicit user approval",
      };
    }
    return (await requestApproval({
      metadata,
      arguments: request.args ?? {},
    }))
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: "User denied the Ableton mutation" };
  };
}

export interface AbletonToolSet {
  tools: [
    Tool<Record<string, never>>,
    Tool<Record<string, never>>,
    Tool<SetTempoParams>,
  ];
  availableTools: string[];
}

export function createAbletonTools(
  services: AbletonToolServices,
): AbletonToolSet {
  const connectionStatusTool = defineTool("ableton_connection_status", {
    description:
      "Returns the current connection status for the Ableton Live Remote Script bridge.",
    parameters: z.object({}),
    handler: async () => services.getConnectionStatus(),
  });
  const inspectSessionTool = defineTool("ableton_session_inspect", {
    description:
      "Inspects the current Ableton Live set, including transport, tempo, time signature, and track summaries.",
    parameters: z.object({}),
    handler: async () => services.inspectSession(),
  });
  const setTempoTool = defineTool("ableton_transport_set_tempo", {
    description:
      "Sets the Ableton Live tempo in BPM and returns the before and verified after values.",
    parameters: z
      .object({
        tempo: z.number().min(20).max(999).describe("Target tempo in BPM"),
      })
      .strict(),
    handler: async ({ tempo }) => services.setTempo(tempo),
  });

  return {
    tools: [connectionStatusTool, inspectSessionTool, setTempoTool],
    availableTools: abletonToolMetadata.map(
      (metadata) => `custom:${metadata.name}`,
    ),
  };
}
