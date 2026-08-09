import type {
  CreateTrackParams,
  CreateMidiClipParams,
  CreateMidiClipResult,
  CreateArrangementMidiClipParams,
  CreateArrangementMidiClipResult,
  CreateCuePointParams,
  CuePointMutationResult,
  DeleteArrangementClipParams,
  DeleteArrangementClipResult,
  DeleteCuePointParams,
  DuplicateClipToArrangementParams,
  DuplicateClipToArrangementResult,
  DuplicateSessionClipParams,
  DuplicateSessionClipResult,
  DeleteTrackParams,
  DeleteSessionClipParams,
  DeleteSessionClipResult,
  RenameTrackParams,
  InspectArrangementParams,
  InspectArrangementResult,
  InspectArrangementTransportParams,
  InspectArrangementTransportResult,
  InspectDeviceParametersParams,
  InspectDeviceParametersResult,
  InspectDevicesParams,
  InspectDevicesResult,
  InspectBrowserRootsResult,
  InspectBrowserChildrenParams,
  InspectBrowserChildrenResult,
  SearchBrowserParams,
  SearchBrowserResult,
  LoadBrowserItemParams,
  LoadBrowserItemResult,
  InspectDrumPadChainDevicesParams,
  InspectDrumPadChainDevicesResult,
  InspectDrumPadChainsParams,
  InspectDrumPadChainsResult,
  InspectDrumRackPadsParams,
  InspectDrumRackPadsResult,
  InspectRackChainDevicesParams,
  InspectRackChainDevicesResult,
  InspectRackChainsParams,
  InspectRackChainsResult,
  LaunchSessionClipParams,
  LaunchSessionClipResult,
  RenameTrackResult,
  ReplaceMidiNotesParams,
  ReplaceMidiNotesResult,
  ReplaceArrangementMidiNotesParams,
  ReplaceArrangementMidiNotesResult,
  SetArrangementClipPropertiesParams,
  SetArrangementClipPropertiesResult,
  SetArrangementLoopParams,
  SetArrangementLoopResult,
  SetSessionClipPropertiesParams,
  SetSessionClipPropertiesResult,
  SessionSnapshot,
  SetPlayingParams,
  SetPlayingResult,
  SetTempoParams,
  SetTempoResult,
  SetTrackMixerParams,
  SetTrackMixerResult,
  SetDeviceEnabledParams,
  SetDeviceEnabledResult,
  SetDeviceParameterParams,
  SetDeviceParameterResult,
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
  inspectArrangementTransport(
    params: InspectArrangementTransportParams,
  ): Promise<InspectArrangementTransportResult>;
  setArrangementLoop(
    params: SetArrangementLoopParams,
  ): Promise<SetArrangementLoopResult>;
  createCuePoint(params: CreateCuePointParams): Promise<CuePointMutationResult>;
  deleteCuePoint(params: DeleteCuePointParams): Promise<CuePointMutationResult>;
  createTrack(params: CreateTrackParams): Promise<TrackMutationResult>;
  deleteTrack(params: DeleteTrackParams): Promise<TrackMutationResult>;
  renameTrack(params: RenameTrackParams): Promise<RenameTrackResult>;
  setTrackMixer(params: SetTrackMixerParams): Promise<SetTrackMixerResult>;
  inspectDevices(params: InspectDevicesParams): Promise<InspectDevicesResult>;
  inspectBrowserRoots(): Promise<InspectBrowserRootsResult>;
  inspectBrowserChildren(
    params: InspectBrowserChildrenParams,
  ): Promise<InspectBrowserChildrenResult>;
  searchBrowser(params: SearchBrowserParams): Promise<SearchBrowserResult>;
  loadBrowserItem(
    params: LoadBrowserItemParams,
  ): Promise<LoadBrowserItemResult>;
  inspectDeviceParameters(
    params: InspectDeviceParametersParams,
  ): Promise<InspectDeviceParametersResult>;
  inspectRackChains(
    params: InspectRackChainsParams,
  ): Promise<InspectRackChainsResult>;
  inspectRackChainDevices(
    params: InspectRackChainDevicesParams,
  ): Promise<InspectRackChainDevicesResult>;
  inspectDrumRackPads(
    params: InspectDrumRackPadsParams,
  ): Promise<InspectDrumRackPadsResult>;
  inspectDrumPadChains(
    params: InspectDrumPadChainsParams,
  ): Promise<InspectDrumPadChainsResult>;
  inspectDrumPadChainDevices(
    params: InspectDrumPadChainDevicesParams,
  ): Promise<InspectDrumPadChainDevicesResult>;
  setDeviceEnabled(
    params: SetDeviceEnabledParams,
  ): Promise<SetDeviceEnabledResult>;
  setDeviceParameter(
    params: SetDeviceParameterParams,
  ): Promise<SetDeviceParameterResult>;
  createMidiClip(params: CreateMidiClipParams): Promise<CreateMidiClipResult>;
  replaceMidiNotes(
    params: ReplaceMidiNotesParams,
  ): Promise<ReplaceMidiNotesResult>;
  launchSessionClip(
    params: LaunchSessionClipParams,
  ): Promise<LaunchSessionClipResult>;
  duplicateSessionClip(
    params: DuplicateSessionClipParams,
  ): Promise<DuplicateSessionClipResult>;
  deleteSessionClip(
    params: DeleteSessionClipParams,
  ): Promise<DeleteSessionClipResult>;
  setSessionClipProperties(
    params: SetSessionClipPropertiesParams,
  ): Promise<SetSessionClipPropertiesResult>;
  createArrangementMidiClip(
    params: CreateArrangementMidiClipParams,
  ): Promise<CreateArrangementMidiClipResult>;
  inspectArrangement(
    params: InspectArrangementParams,
  ): Promise<InspectArrangementResult>;
  deleteArrangementClip(
    params: DeleteArrangementClipParams,
  ): Promise<DeleteArrangementClipResult>;
  replaceArrangementMidiNotes(
    params: ReplaceArrangementMidiNotesParams,
  ): Promise<ReplaceArrangementMidiNotesResult>;
  duplicateClipToArrangement(
    params: DuplicateClipToArrangementParams,
  ): Promise<DuplicateClipToArrangementResult>;
  setArrangementClipProperties(
    params: SetArrangementClipPropertiesParams,
  ): Promise<SetArrangementClipPropertiesResult>;
}

export type ExternalPluginSearchParams = Omit<SearchBrowserParams, "roots">;

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
    name: "ableton_transport_inspect_arrangement",
    title: "Inspect Arrangement transport",
    risk: "read",
    duration: "short",
    requiredCapability: "transport.inspect_arrangement",
  },
  {
    name: "ableton_transport_set_arrangement_loop",
    title: "Set Arrangement loop",
    risk: "reversible",
    duration: "instant",
    requiredCapability: "transport.set_arrangement_loop",
  },
  {
    name: "ableton_transport_create_cue_point",
    title: "Create Arrangement cue point",
    risk: "reversible",
    duration: "short",
    requiredCapability: "transport.create_cue_point",
  },
  {
    name: "ableton_transport_delete_cue_point",
    title: "Delete Arrangement cue point",
    risk: "destructive",
    duration: "short",
    requiredCapability: "transport.delete_cue_point",
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
  {
    name: "ableton_tracks_rename",
    title: "Rename Ableton track",
    risk: "reversible",
    duration: "short",
    requiredCapability: "tracks.rename",
  },
  {
    name: "ableton_tracks_set_mixer",
    title: "Set Ableton track mixer",
    risk: "reversible",
    duration: "short",
    requiredCapability: "tracks.set_mixer",
  },
  {
    name: "ableton_clips_create_midi",
    title: "Create Ableton MIDI clip",
    risk: "reversible",
    duration: "short",
    requiredCapability: "clips.create_midi",
  },
  {
    name: "ableton_clips_replace_notes",
    title: "Replace Ableton MIDI notes",
    risk: "destructive",
    duration: "short",
    requiredCapability: "clips.replace_notes",
  },
  {
    name: "ableton_clips_launch",
    title: "Launch Session clip",
    risk: "reversible",
    duration: "instant",
    requiredCapability: "clips.launch",
  },
  {
    name: "ableton_clips_duplicate",
    title: "Duplicate Session clip",
    risk: "reversible",
    duration: "short",
    requiredCapability: "clips.duplicate",
  },
  {
    name: "ableton_clips_delete",
    title: "Delete Session clip",
    risk: "destructive",
    duration: "short",
    requiredCapability: "clips.delete",
  },
  {
    name: "ableton_clips_set_properties",
    title: "Set Session clip properties",
    risk: "reversible",
    duration: "short",
    requiredCapability: "clips.set_properties",
  },
  {
    name: "ableton_arrangement_create_midi_clip",
    title: "Create Arrangement MIDI clip",
    risk: "reversible",
    duration: "short",
    requiredCapability: "arrangement.create_midi_clip",
  },
  {
    name: "ableton_arrangement_inspect",
    title: "Inspect Ableton Arrangement",
    risk: "read",
    duration: "short",
    requiredCapability: "arrangement.inspect",
  },
  {
    name: "ableton_arrangement_delete_clip",
    title: "Delete Arrangement clip",
    risk: "destructive",
    duration: "short",
    requiredCapability: "arrangement.delete_clip",
  },
  {
    name: "ableton_arrangement_replace_notes",
    title: "Replace Arrangement MIDI notes",
    risk: "destructive",
    duration: "short",
    requiredCapability: "arrangement.replace_notes",
  },
  {
    name: "ableton_arrangement_duplicate_clip",
    title: "Duplicate Session clip to Arrangement",
    risk: "reversible",
    duration: "short",
    requiredCapability: "arrangement.duplicate_clip",
  },
  {
    name: "ableton_arrangement_set_clip_properties",
    title: "Set Arrangement clip properties",
    risk: "reversible",
    duration: "short",
    requiredCapability: "arrangement.set_clip_properties",
  },
  {
    name: "ableton_devices_inspect",
    title: "Inspect track devices",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect",
  },
  {
    name: "ableton_device_parameters_inspect",
    title: "Inspect device parameters",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect_parameters",
  },
  {
    name: "ableton_rack_chains_inspect",
    title: "Inspect rack chains",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect_rack_chains",
  },
  {
    name: "ableton_rack_chain_devices_inspect",
    title: "Inspect rack chain devices",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect_rack_chain_devices",
  },
  {
    name: "ableton_drum_rack_pads_inspect",
    title: "Inspect Drum Rack pads",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect_drum_rack_pads",
  },
  {
    name: "ableton_drum_pad_chains_inspect",
    title: "Inspect Drum Rack pad chains",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect_drum_pad_chains",
  },
  {
    name: "ableton_drum_pad_chain_devices_inspect",
    title: "Inspect Drum Rack pad chain devices",
    risk: "read",
    duration: "short",
    requiredCapability: "devices.inspect_drum_pad_chain_devices",
  },
  {
    name: "ableton_device_set_enabled",
    title: "Enable or disable device",
    risk: "reversible",
    duration: "short",
    requiredCapability: "devices.set_enabled",
  },
  {
    name: "ableton_device_set_parameter",
    title: "Set normalized device parameter",
    risk: "reversible",
    duration: "short",
    requiredCapability: "devices.set_parameter",
  },
  {
    name: "ableton_browser_roots_inspect",
    title: "Inspect Ableton browser roots",
    risk: "read",
    duration: "instant",
    requiredCapability: "browser.inspect_roots",
  },
  {
    name: "ableton_browser_children_inspect",
    title: "Inspect Ableton browser category",
    risk: "read",
    duration: "short",
    requiredCapability: "browser.inspect_children",
  },
  {
    name: "ableton_browser_search",
    title: "Search Ableton browser",
    risk: "read",
    duration: "short",
    requiredCapability: "browser.search",
  },
  {
    name: "ableton_browser_search_external_plugins",
    title: "Search installed external plug-ins",
    risk: "read",
    duration: "short",
    requiredCapability: "browser.search",
  },
  {
    name: "ableton_browser_load_item",
    title: "Load built-in Ableton browser item",
    risk: "reversible",
    duration: "long",
    requiredCapability: "browser.load_item",
  },
] as const satisfies readonly AbletonToolMetadata[];

export interface ToolApprovalRequest {
  metadata: AbletonToolMetadata;
  arguments: Readonly<Record<string, unknown>>;
}

export type ToolApprovalRequester = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

function requiresExplicitTarget(risk: ToolRisk): boolean {
  return risk === "destructive" || risk === "broad";
}

export function createAbletonPermissionHandler(
  requestApproval?: ToolApprovalRequester,
  askForReads = false,
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
    if (metadata.risk === "read" && !askForReads) {
      return { kind: "approve-once" };
    }
    if (
      requiresExplicitTarget(metadata.risk) &&
      Object.keys(request.args ?? {}).length === 0
    ) {
      return {
        kind: "reject",
        feedback:
          "Destructive and broad operations require explicit target arguments",
      };
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
    Tool<InspectArrangementTransportParams>,
    Tool<SetArrangementLoopParams>,
    Tool<CreateCuePointParams>,
    Tool<DeleteCuePointParams>,
    Tool<CreateTrackParams>,
    Tool<DeleteTrackParams>,
    Tool<RenameTrackParams>,
    Tool<SetTrackMixerParams>,
    Tool<CreateMidiClipParams>,
    Tool<ReplaceMidiNotesParams>,
    Tool<LaunchSessionClipParams>,
    Tool<DuplicateSessionClipParams>,
    Tool<DeleteSessionClipParams>,
    Tool<SetSessionClipPropertiesParams>,
    Tool<CreateArrangementMidiClipParams>,
    Tool<InspectArrangementParams>,
    Tool<DeleteArrangementClipParams>,
    Tool<ReplaceArrangementMidiNotesParams>,
    Tool<DuplicateClipToArrangementParams>,
    Tool<SetArrangementClipPropertiesParams>,
    Tool<InspectDevicesParams>,
    Tool<InspectDeviceParametersParams>,
    Tool<InspectRackChainsParams>,
    Tool<InspectRackChainDevicesParams>,
    Tool<InspectDrumRackPadsParams>,
    Tool<InspectDrumPadChainsParams>,
    Tool<InspectDrumPadChainDevicesParams>,
    Tool<SetDeviceEnabledParams>,
    Tool<SetDeviceParameterParams>,
    Tool<Record<string, never>>,
    Tool<InspectBrowserChildrenParams>,
    Tool<SearchBrowserParams>,
    Tool<ExternalPluginSearchParams>,
    Tool<LoadBrowserItemParams>,
  ];
  availableTools: string[];
}

export class AbletonToolPreconditionError extends Error {
  public readonly code: string;
  public readonly retryable = true;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AbletonToolPreconditionError";
    this.code = code;
  }
}

function requireConnectedTool<T extends Record<string, unknown>>(
  tool: Tool<T>,
  services: AbletonToolServices,
): Tool<T> {
  const handler = tool.handler;
  if (handler === undefined) return tool;
  return {
    ...tool,
    handler: async (params, invocation) => {
      const status = await services.getConnectionStatus();
      if (status.state !== "connected") {
        throw new AbletonToolPreconditionError(
          status.state === "error" ? status.code : "not_connected",
          status.state === "error"
            ? status.message
            : "Ableton Live must be connected before using this tool",
        );
      }
      return handler(params, invocation);
    },
  };
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
  const inspectArrangementTransportTool = defineTool(
    "ableton_transport_inspect_arrangement",
    {
      description:
        "Returns the Arrangement loop state and a bounded page of identity-bound cue points.",
      parameters: z
        .object({
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(512).default(100),
        })
        .strict(),
      handler: async (params) => services.inspectArrangementTransport(params),
    },
  );
  const setArrangementLoopTool = defineTool(
    "ableton_transport_set_arrangement_loop",
    {
      description:
        "Updates one or more Arrangement loop properties, verifies the full before/after state, and restores prior values if a partial update fails.",
      parameters: z
        .object({
          enabled: z.boolean().optional(),
          start: z.number().finite().nonnegative().max(1576800).optional(),
          length: z.number().finite().positive().max(1576800).optional(),
        })
        .strict()
        .refine(
          (params) =>
            params.enabled !== undefined ||
            params.start !== undefined ||
            params.length !== undefined,
          { message: "At least one Arrangement loop property is required" },
        )
        .refine(
          (params) =>
            params.start === undefined ||
            params.length === undefined ||
            params.start + params.length <= 1576800,
          { message: "Arrangement loop end exceeds Live's maximum time" },
        ),
      handler: async (params) => services.setArrangementLoop(params),
    },
  );
  const createCuePointTool = defineTool("ableton_transport_create_cue_point", {
    description:
      "Creates a cue point at an unoccupied Arrangement time, assigns a stable runtime reference, verifies it, and removes it if creation partially fails.",
    parameters: z
      .object({
        time: z.number().finite().nonnegative().max(1576800),
        name: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
    handler: async (params) => services.createCuePoint(params),
  });
  const deleteCuePointTool = defineTool("ableton_transport_delete_cue_point", {
    description:
      "Destructively deletes the exact cue point identified by a recent Arrangement transport inspection after revalidating its runtime reference, name, and time.",
    parameters: z
      .object({
        expectedReference: z.string().uuid(),
        expectedName: z.string(),
        expectedTime: z.number().finite().nonnegative().max(1576800),
      })
      .strict(),
    handler: async (params) => services.deleteCuePoint(params),
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
  const renameTrackTool = defineTool("ableton_tracks_rename", {
    description:
      "Renames the exact Ableton track identified by a recent session inspection.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        name: z.string().trim().min(1).max(128),
      })
      .strict(),
    handler: async (params) => services.renameTrack(params),
  });
  const setTrackMixerTool = defineTool("ableton_tracks_set_mixer", {
    description:
      "Updates mute, solo, arm, normalized volume, or pan for an identity-bound Ableton track.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        isMuted: z.boolean().optional(),
        isSoloed: z.boolean().optional(),
        isArmed: z.boolean().optional(),
        volume: z.number().min(0).max(1).optional(),
        pan: z.number().min(-1).max(1).optional(),
      })
      .strict()
      .refine(
        (params) =>
          params.isMuted !== undefined ||
          params.isSoloed !== undefined ||
          params.isArmed !== undefined ||
          params.volume !== undefined ||
          params.pan !== undefined,
        { message: "At least one mixer property is required" },
      ),
    handler: async (params) => services.setTrackMixer(params),
  });
  const createMidiClipTool = defineTool("ableton_clips_create_midi", {
    description:
      "Creates a MIDI clip in an empty Session View clip slot on an identity-bound MIDI track.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        sceneIndex: z.number().int().nonnegative(),
        length: z.number().positive().max(4096),
        name: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
    handler: async (params) => services.createMidiClip(params),
  });
  const replaceMidiNotesTool = defineTool("ableton_clips_replace_notes", {
    description:
      "Destructively replaces every MIDI note in an identity-bound Session View clip. Existing per-note MPE/expression cannot be preserved, so allowPerNoteExpressionLoss must be explicitly approved for non-empty clips.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        sceneIndex: z.number().int().nonnegative(),
        expectedClipReference: z.string().uuid(),
        allowPerNoteExpressionLoss: z.boolean(),
        notes: z
          .array(
            z
              .object({
                pitch: z.number().int().min(0).max(127),
                startTime: z.number().nonnegative(),
                duration: z.number().positive(),
                velocity: z.number().int().min(1).max(127),
                mute: z.boolean().default(false),
              })
              .strict(),
          )
          .max(2048),
      })
      .strict(),
    handler: async (params) => services.replaceMidiNotes(params),
  });
  const launchSessionClipTool = defineTool("ableton_clips_launch", {
    description:
      "Launches the exact identity-bound MIDI or audio Session View clip, verifies playing or triggered state, and restores prior Session playback if launch fails. Refuses to replace Arrangement playback or another pending trigger.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        sceneIndex: z.number().int().nonnegative(),
        expectedClipReference: z.string().uuid(),
      })
      .strict(),
    handler: async (params) => services.launchSessionClip(params),
  });
  const duplicateSessionClipTool = defineTool("ableton_clips_duplicate", {
    description:
      "Duplicates the exact identity-bound MIDI or audio Session View clip into an empty slot on an exact identity-bound destination track, verifies the copy, and removes it on failure.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        sceneIndex: z.number().int().nonnegative(),
        expectedClipReference: z.string().uuid(),
        destinationTrackIndex: z.number().int().nonnegative(),
        expectedDestinationTrackReference: z.string().uuid(),
        expectedDestinationTrackName: z.string().min(1),
        destinationSceneIndex: z.number().int().nonnegative(),
      })
      .strict(),
    handler: async (params) => services.duplicateSessionClip(params),
  });
  const deleteSessionClipTool = defineTool("ableton_clips_delete", {
    description:
      "Destructively deletes the exact identity-bound MIDI or audio Session View clip from its exact track and scene after approval.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        sceneIndex: z.number().int().nonnegative(),
        expectedClipReference: z.string().uuid(),
      })
      .strict(),
    handler: async (params) => services.deleteSessionClip(params),
  });
  const setSessionClipPropertiesTool = defineTool(
    "ableton_clips_set_properties",
    {
      description:
        "Conservatively updates name, mute, or supported loop state on the exact identity-bound MIDI or audio Session View clip and restores prior values on failure.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          sceneIndex: z.number().int().nonnegative(),
          expectedClipReference: z.string().uuid(),
          name: z.string().trim().min(1).max(128).optional(),
          muted: z.boolean().optional(),
          looping: z.boolean().optional(),
        })
        .strict()
        .refine(
          (params) =>
            params.name !== undefined ||
            params.muted !== undefined ||
            params.looping !== undefined,
          { message: "At least one clip property is required" },
        ),
      handler: async (params) => services.setSessionClipProperties(params),
    },
  );
  const createArrangementMidiClipTool = defineTool(
    "ableton_arrangement_create_midi_clip",
    {
      description:
        "Creates an empty MIDI clip in a non-overlapping Arrangement range on an identity-bound MIDI track.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          startTime: z.number().nonnegative().max(1576800),
          length: z.number().positive().max(4096),
          name: z.string().trim().min(1).max(128).optional(),
        })
        .strict()
        .refine((params) => params.startTime + params.length <= 1576800, {
          message: "Arrangement clip end exceeds Live's maximum time",
        }),
      handler: async (params) => services.createArrangementMidiClip(params),
    },
  );
  const inspectArrangementTool = defineTool("ableton_arrangement_inspect", {
    description:
      "Returns a bounded page of Arrangement clips ordered by start time and track.",
    parameters: z
      .object({
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(512).default(100),
      })
      .strict(),
    handler: async (params) => services.inspectArrangement(params),
  });
  const deleteArrangementClipTool = defineTool(
    "ableton_arrangement_delete_clip",
    {
      description:
        "Destructively deletes an identity-bound Arrangement clip after revalidating its track and start time.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          expectedClipReference: z.string().uuid(),
          expectedStartTime: z.number().nonnegative(),
        })
        .strict(),
      handler: async (params) => services.deleteArrangementClip(params),
    },
  );
  const replaceArrangementMidiNotesTool = defineTool(
    "ableton_arrangement_replace_notes",
    {
      description:
        "Destructively replaces every note in an identity-bound Arrangement MIDI clip. Existing per-note MPE/expression cannot be preserved, so explicit opt-in is required for non-empty clips.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          expectedClipReference: z.string().uuid(),
          expectedStartTime: z.number().nonnegative(),
          allowPerNoteExpressionLoss: z.boolean(),
          notes: z
            .array(
              z
                .object({
                  pitch: z.number().int().min(0).max(127),
                  startTime: z.number().nonnegative(),
                  duration: z.number().positive(),
                  velocity: z.number().int().min(1).max(127),
                  mute: z.boolean().default(false),
                })
                .strict(),
            )
            .max(2048),
        })
        .strict(),
      handler: async (params) => services.replaceArrangementMidiNotes(params),
    },
  );
  const duplicateClipToArrangementTool = defineTool(
    "ableton_arrangement_duplicate_clip",
    {
      description:
        "Duplicates an identity-bound Session View MIDI clip to a verified, non-overlapping Arrangement destination on the same track.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          sceneIndex: z.number().int().nonnegative(),
          expectedClipReference: z.string().uuid(),
          destinationTime: z.number().nonnegative().max(1576800),
        })
        .strict(),
      handler: async (params) => services.duplicateClipToArrangement(params),
    },
  );
  const setArrangementClipPropertiesTool = defineTool(
    "ableton_arrangement_set_clip_properties",
    {
      description:
        "Conservatively updates name, mute, or loop state on an identity-bound Arrangement clip and restores prior values if verification fails.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          expectedClipReference: z.string().uuid(),
          expectedStartTime: z.number().nonnegative(),
          name: z.string().trim().min(1).max(128).optional(),
          muted: z.boolean().optional(),
          looping: z.boolean().optional(),
        })
        .strict()
        .refine(
          (params) =>
            params.name !== undefined ||
            params.muted !== undefined ||
            params.looping !== undefined,
          { message: "At least one clip property is required" },
        ),
      handler: async (params) => services.setArrangementClipProperties(params),
    },
  );
  const inspectDevicesTool = defineTool("ableton_devices_inspect", {
    description:
      "Returns one bounded page of top-level devices on an exact regular track. Return tracks, group tracks, rack chains, and recursive device traversal are not included.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(128).default(32),
      })
      .strict(),
    handler: async (params) => services.inspectDevices(params),
  });
  const inspectDeviceParametersTool = defineTool(
    "ableton_device_parameters_inspect",
    {
      description:
        "Returns one bounded page of parameters for an exact runtime-identity-bound top-level device on a regular track.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          deviceIndex: z.number().int().nonnegative(),
          expectedDeviceReference: z.string().uuid(),
          expectedDeviceName: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(256).default(64),
        })
        .strict(),
      handler: async (params) => services.inspectDeviceParameters(params),
    },
  );
  const inspectRackChainsTool = defineTool("ableton_rack_chains_inspect", {
    description:
      "Returns one bounded page of direct chains for one exact top-level rack device. It never recursively expands nested racks.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        deviceIndex: z.number().int().nonnegative(),
        expectedDeviceReference: z.string().uuid(),
        expectedDeviceName: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(64).default(16),
      })
      .strict(),
    handler: async (params) => services.inspectRackChains(params),
  });
  const inspectRackChainDevicesTool = defineTool(
    "ableton_rack_chain_devices_inspect",
    {
      description:
        "Returns one bounded page of direct devices in one exact chain of one exact top-level rack. Nested rack contents are not expanded.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          deviceIndex: z.number().int().nonnegative(),
          expectedDeviceReference: z.string().uuid(),
          expectedDeviceName: z.string(),
          chainIndex: z.number().int().nonnegative(),
          expectedChainReference: z.string().uuid(),
          expectedChainName: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(128).default(32),
        })
        .strict(),
      handler: async (params) => services.inspectRackChainDevices(params),
    },
  );
  const inspectDrumRackPadsTool = defineTool("ableton_drum_rack_pads_inspect", {
    description:
      "Returns one bounded page of pads for one exact top-level Drum Rack using documented Drum Rack APIs.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        deviceIndex: z.number().int().nonnegative(),
        expectedDeviceReference: z.string().uuid(),
        expectedDeviceName: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(128).default(32),
      })
      .strict(),
    handler: async (params) => services.inspectDrumRackPads(params),
  });
  const inspectDrumPadChainsTool = defineTool(
    "ableton_drum_pad_chains_inspect",
    {
      description:
        "Returns one bounded page of chains for one exact pad in one exact top-level Drum Rack.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          deviceIndex: z.number().int().nonnegative(),
          expectedDeviceReference: z.string().uuid(),
          expectedDeviceName: z.string(),
          padIndex: z.number().int().nonnegative(),
          expectedPadReference: z.string().uuid(),
          expectedPadNote: z.number().int().min(0).max(127),
          expectedPadName: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(64).default(8),
        })
        .strict(),
      handler: async (params) => services.inspectDrumPadChains(params),
    },
  );
  const inspectDrumPadChainDevicesTool = defineTool(
    "ableton_drum_pad_chain_devices_inspect",
    {
      description:
        "Returns one bounded page of direct devices in one exact Drum Rack pad chain. Nested rack contents are not expanded.",
      parameters: z
        .object({
          index: z.number().int().nonnegative(),
          expectedReference: z.string().uuid(),
          expectedName: z.string().min(1),
          deviceIndex: z.number().int().nonnegative(),
          expectedDeviceReference: z.string().uuid(),
          expectedDeviceName: z.string(),
          padIndex: z.number().int().nonnegative(),
          expectedPadReference: z.string().uuid(),
          expectedPadNote: z.number().int().min(0).max(127),
          expectedPadName: z.string(),
          chainIndex: z.number().int().nonnegative(),
          expectedChainReference: z.string().uuid(),
          expectedChainName: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(128).default(32),
        })
        .strict(),
      handler: async (params) => services.inspectDrumPadChainDevices(params),
    },
  );
  const setDeviceEnabledTool = defineTool("ableton_device_set_enabled", {
    description:
      "Enables or disables an exact top-level device through its documented Device On parameter, with before/after verification and rollback.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        deviceIndex: z.number().int().nonnegative(),
        expectedDeviceReference: z.string().uuid(),
        expectedDeviceName: z.string(),
        enabled: z.boolean(),
      })
      .strict(),
    handler: async (params) => services.setDeviceEnabled(params),
  });
  const setDeviceParameterTool = defineTool("ableton_device_set_parameter", {
    description:
      "Sets a writable enabled parameter on an exact top-level device using normalized 0..1 input mapped through its current min/max range. Quantized parameters snap to the nearest discrete value; the update is verified and rolled back on failure.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        deviceIndex: z.number().int().nonnegative(),
        expectedDeviceReference: z.string().uuid(),
        expectedDeviceName: z.string(),
        parameterIndex: z.number().int().nonnegative(),
        expectedParameterReference: z.string().uuid(),
        expectedParameterName: z.string(),
        normalizedValue: z.number().finite().min(0).max(1),
      })
      .strict(),
    handler: async (params) => services.setDeviceParameter(params),
  });
  const inspectBrowserRootsTool = defineTool("ableton_browser_roots_inspect", {
    description:
      "Returns the bounded documented Ableton Browser root categories and runtime-stable references. It does not traverse their trees.",
    parameters: z.object({}).strict(),
    handler: async () => services.inspectBrowserRoots(),
  });
  const browserItemTargetParameters = {
    expectedItemReference: z.string().uuid(),
    expectedItemRoot: z.enum([
      "sounds",
      "drums",
      "instruments",
      "audio_effects",
      "midi_effects",
      "max_for_live",
      "plugins",
      "clips",
      "samples",
      "packs",
      "user_library",
      "current_project",
    ]),
    expectedItemPath: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative().max(1_000_000),
            name: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(16),
    expectedItemName: z.string().min(1).max(256),
    expectedItemUri: z.string().max(2048),
  } as const;
  const inspectBrowserChildrenTool = defineTool(
    "ableton_browser_children_inspect",
    {
      description:
        "Returns one bounded page of direct children for an exact identity-bound Ableton Browser folder. It never recursively traverses the browser tree.",
      parameters: z
        .object({
          ...browserItemTargetParameters,
          offset: z.number().int().nonnegative().max(4096).default(0),
          limit: z.number().int().min(1).max(64).default(32),
        })
        .strict()
        .refine((params) => params.offset + params.limit - 1 <= 4096, {
          message: "Browser page exceeds the maximum addressable child index",
        }),
      handler: async (params) => services.inspectBrowserChildren(params),
    },
  );
  const searchBrowserTool = defineTool("ableton_browser_search", {
    description:
      "Performs a deterministic breadth-first Ableton Browser search with strict node, result, depth, query-length, and main-thread time limits. Results are runtime identity-bound; truncation and the stop reason are always reported.",
    parameters: z
      .object({
        query: z.string().trim().min(1).max(128),
        roots: z
          .array(
            z.enum([
              "sounds",
              "drums",
              "instruments",
              "audio_effects",
              "midi_effects",
              "max_for_live",
              "plugins",
              "clips",
              "samples",
              "packs",
              "user_library",
              "current_project",
            ]),
          )
          .min(1)
          .max(12)
          .refine((roots) => new Set(roots).size === roots.length)
          .default(["instruments", "audio_effects", "midi_effects"]),
        maxNodes: z.number().int().min(1).max(256).default(128),
        maxResults: z.number().int().min(1).max(32).default(20),
        maxDepth: z.number().int().min(0).max(6).default(4),
        maxDurationMs: z.number().int().min(10).max(250).default(100),
      })
      .strict(),
    handler: async (params) => services.searchBrowser(params),
  });
  const searchExternalPluginsTool = defineTool(
    "ableton_browser_search_external_plugins",
    {
      description:
        "Searches only Ableton's Plug-ins browser root using bounded breadth-first traversal. Results use runtime-cached identity references for inspection and selection; this tool does not load a plug-in.",
      parameters: z
        .object({
          query: z.string().trim().min(1).max(128),
          maxNodes: z.number().int().min(1).max(256).default(128),
          maxResults: z.number().int().min(1).max(32).default(20),
          maxDepth: z.number().int().min(0).max(6).default(4),
          maxDurationMs: z.number().int().min(10).max(250).default(100),
        })
        .strict(),
      handler: async (params) =>
        services.searchBrowser({ ...params, roots: ["plugins"] }),
    },
  );
  const loadBrowserItemTool = defineTool("ableton_browser_load_item", {
    description:
      "Loads one explicitly selected, exact runtime identity-bound built-in instrument, audio effect, or MIDI effect onto one exact regular track. It rejects plug-ins, arbitrary paths, folders, incompatible tracks, and active hotswap; captures bounded before/after device and clip state and succeeds only after observing added top-level devices.",
    parameters: z
      .object({
        index: z.number().int().nonnegative(),
        expectedReference: z.string().uuid(),
        expectedName: z.string().min(1),
        ...browserItemTargetParameters,
      })
      .strict(),
    handler: async (params) => services.loadBrowserItem(params),
  });

  return {
    tools: [
      connectionStatusTool,
      requireConnectedTool(inspectSessionTool, services),
      requireConnectedTool(setTempoTool, services),
      requireConnectedTool(setPlayingTool, services),
      requireConnectedTool(inspectArrangementTransportTool, services),
      requireConnectedTool(setArrangementLoopTool, services),
      requireConnectedTool(createCuePointTool, services),
      requireConnectedTool(deleteCuePointTool, services),
      requireConnectedTool(createTrackTool, services),
      requireConnectedTool(deleteTrackTool, services),
      requireConnectedTool(renameTrackTool, services),
      requireConnectedTool(setTrackMixerTool, services),
      requireConnectedTool(createMidiClipTool, services),
      requireConnectedTool(replaceMidiNotesTool, services),
      requireConnectedTool(launchSessionClipTool, services),
      requireConnectedTool(duplicateSessionClipTool, services),
      requireConnectedTool(deleteSessionClipTool, services),
      requireConnectedTool(setSessionClipPropertiesTool, services),
      requireConnectedTool(createArrangementMidiClipTool, services),
      requireConnectedTool(inspectArrangementTool, services),
      requireConnectedTool(deleteArrangementClipTool, services),
      requireConnectedTool(replaceArrangementMidiNotesTool, services),
      requireConnectedTool(duplicateClipToArrangementTool, services),
      requireConnectedTool(setArrangementClipPropertiesTool, services),
      requireConnectedTool(inspectDevicesTool, services),
      requireConnectedTool(inspectDeviceParametersTool, services),
      requireConnectedTool(inspectRackChainsTool, services),
      requireConnectedTool(inspectRackChainDevicesTool, services),
      requireConnectedTool(inspectDrumRackPadsTool, services),
      requireConnectedTool(inspectDrumPadChainsTool, services),
      requireConnectedTool(inspectDrumPadChainDevicesTool, services),
      requireConnectedTool(setDeviceEnabledTool, services),
      requireConnectedTool(setDeviceParameterTool, services),
      requireConnectedTool(inspectBrowserRootsTool, services),
      requireConnectedTool(inspectBrowserChildrenTool, services),
      requireConnectedTool(searchBrowserTool, services),
      requireConnectedTool(searchExternalPluginsTool, services),
      requireConnectedTool(loadBrowserItemTool, services),
    ],
    availableTools: abletonToolMetadata.map(
      (metadata) => `custom:${metadata.name}`,
    ),
  };
}
