import type {
  CreateTrackParams,
  DeleteTrackParams,
  SessionSnapshot,
  SetPlayingParams,
  SetPlayingResult,
  SetTempoParams,
  SetTempoResult,
  TrackMutationResult,
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
  setPlaying(isPlaying: boolean): Promise<SetPlayingResult>;
  createTrack(params: CreateTrackParams): Promise<TrackMutationResult>;
  deleteTrack(params: DeleteTrackParams): Promise<TrackMutationResult>;
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
  {
    name: "ableton_transport_set_playing",
    title: "Set Ableton transport playback",
    risk: "reversible",
    duration: "instant",
    requiredCapability: "transport.set_playing",
  },
  {
    name: "ableton_tracks_create",
    title: "Create Ableton track",
    risk: "reversible",
    duration: "short",
    requiredCapability: "tracks.create",
  },
  {
    name: "ableton_tracks_delete",
    title: "Delete Ableton track",
    risk: "destructive",
    duration: "short",
    requiredCapability: "tracks.delete",
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
    Tool<SetPlayingParams>,
    Tool<CreateTrackParams>,
    Tool<DeleteTrackParams>,
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
  const setPlayingTool = defineTool("ableton_transport_set_playing", {
    description:
      "Starts or stops Ableton Live transport and returns verified before and after playback state.",
    parameters: z
      .object({
        isPlaying: z
          .boolean()
          .describe("True to start playback, false to stop playback"),
      })
      .strict(),
    handler: async ({ isPlaying }) => services.setPlaying(isPlaying),
  });
  const createTrackTool = defineTool("ableton_tracks_create", {
    description:
      "Creates a MIDI or audio track at the end of the Ableton Live set and verifies the resulting track count.",
    parameters: z
      .object({
        kind: z.enum(["midi", "audio"]),
        name: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
    handler: async (params) => services.createTrack(params),
  });
  const deleteTrackTool = defineTool("ableton_tracks_delete", {
    description:
      "Deletes a track by zero-based index after approval. Refuses to delete the last remaining track.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        expectedKind: z.enum(["midi", "audio"]),
      })
      .strict(),
    handler: async (params) => services.deleteTrack(params),
  });

  return {
    tools: [
      connectionStatusTool,
      inspectSessionTool,
      setTempoTool,
      setPlayingTool,
      createTrackTool,
      deleteTrackTool,
    ],
    availableTools: abletonToolMetadata.map(
      (metadata) => `custom:${metadata.name}`,
    ),
  };
}
