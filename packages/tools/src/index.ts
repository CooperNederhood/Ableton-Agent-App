import type { SessionSnapshot } from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import {
  defineTool,
  type PermissionHandler,
  type Tool,
} from "@github/copilot-sdk";
import { z } from "zod";

export type ToolRisk = "read" | "write" | "destructive";
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
] as const satisfies readonly AbletonToolMetadata[];

export const handleAbletonToolPermission: PermissionHandler = (
  request,
  invocation,
) => {
  if (invocation.managedSettingsEnabled || request.kind !== "custom-tool") {
    return { kind: "no-result" };
  }
  const metadata = abletonToolMetadata.find(
    (candidate) => candidate.name === request.toolName,
  );
  return metadata?.risk === "read"
    ? { kind: "approve-once" }
    : { kind: "no-result" };
};

export interface AbletonToolSet {
  tools: Tool<Record<string, never>>[];
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

  return {
    tools: [connectionStatusTool, inspectSessionTool],
    availableTools: abletonToolMetadata.map(
      (metadata) => `custom:${metadata.name}`,
    ),
  };
}
