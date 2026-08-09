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

  return {
    tools: [
      connectionStatusTool,
      inspectSessionTool,
      setTempoTool,
      setPlayingTool,
      inspectArrangementTransportTool,
      setArrangementLoopTool,
      createCuePointTool,
      deleteCuePointTool,
      createTrackTool,
      deleteTrackTool,
      renameTrackTool,
      setTrackMixerTool,
      createMidiClipTool,
      replaceMidiNotesTool,
      launchSessionClipTool,
      duplicateSessionClipTool,
      deleteSessionClipTool,
      setSessionClipPropertiesTool,
      createArrangementMidiClipTool,
      inspectArrangementTool,
      deleteArrangementClipTool,
      replaceArrangementMidiNotesTool,
      duplicateClipToArrangementTool,
      setArrangementClipPropertiesTool,
    ],
    availableTools: abletonToolMetadata.map(
      (metadata) => `custom:${metadata.name}`,
    ),
  };
}
