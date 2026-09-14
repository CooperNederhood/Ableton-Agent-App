import type {
  AudioClipsOperationParams,
  AudioClipsOperationResult,
  BrowserAdapterOperationParams,
  BrowserAdapterOperationResult,
  CreateTrackParams,
  CreateMidiClipParams,
  CreateMidiClipResult,
  ClipAutomationOperationParams,
  ClipAutomationOperationResult,
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
  FindDevicePositionParams,
  FindDevicePositionResult,
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
  InspectChainMixerParams,
  InspectChainMixerResult,
  SearchBrowserParams,
  SearchBrowserResult,
  LoadBrowserItemParams,
  LoadBrowserItemResult,
  GrooveOperationParams,
  GrooveOperationResult,
  LiveHistoryOperationParams,
  LiveHistoryOperationResult,
  MidiNotesOperationParams,
  MidiNotesOperationResult,
  MixerRoutingOperationParams,
  MixerRoutingOperationResult,
  MoveDeviceParams,
  MoveDeviceResult,
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
  SetChainMixerParams,
  SetChainMixerResult,
  SetChainPropertiesParams,
  SetChainPropertiesResult,
  SetSessionClipPropertiesParams,
  SetSessionClipPropertiesResult,
  ScenesOperationParams,
  ScenesOperationResult,
  SessionSnapshot,
  SetPlayingParams,
  SetPlayingResult,
  SetTempoParams,
  SetTempoResult,
  RecordingOperationParams,
  RecordingOperationResult,
  SelectionViewOperationParams,
  SelectionViewOperationResult,
  SpecializedDeviceOperationParams,
  SpecializedDeviceOperationResult,
  SetTrackMixerParams,
  SetTrackMixerResult,
  SetDeviceEnabledParams,
  SetDeviceEnabledResult,
  SetDeviceParameterParams,
  SetDeviceParameterResult,
  TrackMutationResult,
  TracksOperationParams,
  TracksOperationResult,
  TransportOperationParams,
  TransportOperationResult,
  WarpMarkerOperationParams,
  WarpMarkerOperationResult,
  WorkflowJobOperationParams,
  WorkflowJobOperationResult,
} from "@ableton-agent/protocol";
import {
  audioClipsOperationParamsSchema,
  audioClipsOperationResultSchema,
  browserAdapterOperationParamsSchema,
  browserAdapterOperationResultSchema,
  clipAutomationOperationParamsSchema,
  clipAutomationOperationResultSchema,
  grooveOperationParamsSchema,
  grooveOperationResultSchema,
  liveHistoryOperationParamsSchema,
  liveHistoryOperationResultSchema,
  midiNotesOperationParamsSchema,
  midiNotesOperationResultSchema,
  mixerRoutingOperationParamsSchema,
  mixerRoutingOperationResultSchema,
  scenesOperationParamsSchema,
  scenesOperationResultSchema,
  tracksOperationParamsSchema,
  tracksOperationResultSchema,
  transportOperationParamsSchema,
  transportOperationResultSchema,
  recordingOperationParamsSchema,
  recordingOperationResultSchema,
  selectionViewOperationParamsSchema,
  selectionViewOperationResultSchema,
  specializedDeviceOperationParamsSchema,
  specializedDeviceOperationResultSchema,
  warpMarkerOperationParamsSchema,
  warpMarkerOperationResultSchema,
  workflowJobOperationParamsSchema,
  workflowJobOperationResultSchema,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";
import { withCorrelation } from "@ableton-agent/correlation";
import {
  defineTool,
  type PermissionHandler,
  type Tool,
  type ToolResultObject,
} from "@github/copilot-sdk";
import { z, type ZodType } from "zod";
import type { MutationTarget } from "./mutation-policy.js";
import {
  abletonOperationDescriptors,
  resolveAbletonOperation,
  type AbletonOperationEditScope,
  type AbletonOperationLifecycleIdentity,
} from "./operation-descriptor.js";

export type ToolRisk = "read" | "reversible" | "destructive" | "broad";
export type ToolDuration = "instant" | "short" | "long";

export interface AbletonToolMetadata {
  name: string;
  title: string;
  risk: ToolRisk;
  duration: ToolDuration;
  mutationTarget: MutationTarget;
  requiredCapability?: string;
  operationId?: string;
  action?: string;
  editScope?: AbletonOperationEditScope;
  lifecycleIdentity?: AbletonOperationLifecycleIdentity;
}

export interface AbletonToolServices {
  getConnectionStatus(): Promise<ConnectionStatus>;
  inspectSession(): Promise<SessionSnapshot>;
  executeScenesOperation?(
    params: ScenesOperationParams,
  ): Promise<ScenesOperationResult>;
  executeTracksOperation?(
    params: TracksOperationParams,
  ): Promise<TracksOperationResult>;
  executeMixerRoutingOperation?(
    params: MixerRoutingOperationParams,
  ): Promise<MixerRoutingOperationResult>;
  executeTransportOperation?(
    params: TransportOperationParams,
  ): Promise<TransportOperationResult>;
  executeMidiNotesOperation?(
    params: MidiNotesOperationParams,
  ): Promise<MidiNotesOperationResult>;
  executeAudioClipsOperation?(
    params: AudioClipsOperationParams,
  ): Promise<AudioClipsOperationResult>;
  executeRecordingOperation?(
    params: RecordingOperationParams,
  ): Promise<RecordingOperationResult>;
  executeGrooveOperation?(
    params: GrooveOperationParams,
  ): Promise<GrooveOperationResult>;
  executeSelectionViewOperation?(
    params: SelectionViewOperationParams,
  ): Promise<SelectionViewOperationResult>;
  executeLiveHistoryOperation?(
    params: LiveHistoryOperationParams,
  ): Promise<LiveHistoryOperationResult>;
  executeBrowserAdapterOperation?(
    params: BrowserAdapterOperationParams,
  ): Promise<BrowserAdapterOperationResult>;
  executeClipAutomationOperation?(
    params: ClipAutomationOperationParams,
  ): Promise<ClipAutomationOperationResult>;
  executeWarpMarkerOperation?(
    params: WarpMarkerOperationParams,
  ): Promise<WarpMarkerOperationResult>;
  executeSpecializedDeviceOperation?(
    params: SpecializedDeviceOperationParams,
  ): Promise<SpecializedDeviceOperationResult>;
  executeWorkflowJobOperation?(
    params: WorkflowJobOperationParams,
  ): Promise<WorkflowJobOperationResult>;
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
  inspectChainMixer(
    params: InspectChainMixerParams,
  ): Promise<InspectChainMixerResult>;
  findDevicePosition(
    params: FindDevicePositionParams,
  ): Promise<FindDevicePositionResult>;
  moveDevice(params: MoveDeviceParams): Promise<MoveDeviceResult>;
  setChainProperties(
    params: SetChainPropertiesParams,
  ): Promise<SetChainPropertiesResult>;
  setChainMixer(params: SetChainMixerParams): Promise<SetChainMixerResult>;
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
    mutationTarget: "read",
  },
  {
    name: "ableton_session_inspect",
    title: "Inspect Ableton session",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "session.inspect",
  },
  {
    name: "ableton_transport_set_tempo",
    title: "Set Ableton tempo",
    risk: "reversible",
    duration: "instant",
    mutationTarget: "session",
    requiredCapability: "transport.set_tempo",
  },
  {
    name: "ableton_transport_set_playing",
    title: "Set Ableton transport playback",
    risk: "reversible",
    duration: "instant",
    mutationTarget: "session",
    requiredCapability: "transport.set_playing",
  },
  {
    name: "ableton_transport_inspect_arrangement",
    title: "Inspect Arrangement transport",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "transport.inspect_arrangement",
  },
  {
    name: "ableton_transport_set_arrangement_loop",
    title: "Set Arrangement loop",
    risk: "reversible",
    duration: "instant",
    mutationTarget: "session",
    requiredCapability: "transport.set_arrangement_loop",
  },
  {
    name: "ableton_transport_create_cue_point",
    title: "Create Arrangement cue point",
    risk: "reversible",
    duration: "short",
    mutationTarget: "session",
    requiredCapability: "transport.create_cue_point",
  },
  {
    name: "ableton_transport_delete_cue_point",
    title: "Delete Arrangement cue point",
    risk: "destructive",
    duration: "short",
    mutationTarget: "session",
    requiredCapability: "transport.delete_cue_point",
  },
  {
    name: "ableton_tracks_create",
    title: "Create Ableton track",
    risk: "reversible",
    duration: "short",
    mutationTarget: "session",
    requiredCapability: "tracks.create",
  },
  {
    name: "ableton_tracks_delete",
    title: "Delete Ableton track",
    risk: "destructive",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "tracks.delete",
  },
  {
    name: "ableton_tracks_rename",
    title: "Rename Ableton track",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "tracks.rename",
  },
  {
    name: "ableton_tracks_set_mixer",
    title: "Set Ableton track mixer",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "tracks.set_mixer",
  },
  {
    name: "ableton_clips_create_midi",
    title: "Create Ableton MIDI clip",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "clips.create_midi",
  },
  {
    name: "ableton_clips_replace_notes",
    title: "Replace Ableton MIDI notes",
    risk: "destructive",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "clips.replace_notes",
  },
  {
    name: "ableton_clips_launch",
    title: "Launch Session clip",
    risk: "reversible",
    duration: "instant",
    mutationTarget: "track",
    requiredCapability: "clips.launch",
  },
  {
    name: "ableton_clips_duplicate",
    title: "Duplicate Session clip",
    risk: "reversible",
    duration: "short",
    mutationTarget: "tracks",
    requiredCapability: "clips.duplicate",
  },
  {
    name: "ableton_clips_delete",
    title: "Delete Session clip",
    risk: "destructive",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "clips.delete",
  },
  {
    name: "ableton_clips_set_properties",
    title: "Set Session clip properties",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "clips.set_properties",
  },
  {
    name: "ableton_arrangement_create_midi_clip",
    title: "Create Arrangement MIDI clip",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "arrangement.create_midi_clip",
  },
  {
    name: "ableton_arrangement_inspect",
    title: "Inspect Ableton Arrangement",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "arrangement.inspect",
  },
  {
    name: "ableton_arrangement_delete_clip",
    title: "Delete Arrangement clip",
    risk: "destructive",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "arrangement.delete_clip",
  },
  {
    name: "ableton_arrangement_replace_notes",
    title: "Replace Arrangement MIDI notes",
    risk: "destructive",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "arrangement.replace_notes",
  },
  {
    name: "ableton_arrangement_duplicate_clip",
    title: "Duplicate Session clip to Arrangement",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "arrangement.duplicate_clip",
  },
  {
    name: "ableton_arrangement_set_clip_properties",
    title: "Set Arrangement clip properties",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "arrangement.set_clip_properties",
  },
  {
    name: "ableton_devices_inspect",
    title: "Inspect track devices",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect",
  },
  {
    name: "ableton_device_parameters_inspect",
    title: "Inspect device parameters",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect_parameters",
  },
  {
    name: "ableton_rack_chains_inspect",
    title: "Inspect rack chains",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect_rack_chains",
  },
  {
    name: "ableton_rack_chain_devices_inspect",
    title: "Inspect rack chain devices",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect_rack_chain_devices",
  },
  {
    name: "ableton_drum_rack_pads_inspect",
    title: "Inspect Drum Rack pads",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect_drum_rack_pads",
  },
  {
    name: "ableton_drum_pad_chains_inspect",
    title: "Inspect Drum Rack pad chains",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect_drum_pad_chains",
  },
  {
    name: "ableton_drum_pad_chain_devices_inspect",
    title: "Inspect Drum Rack pad chain devices",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "devices.inspect_drum_pad_chain_devices",
  },
  {
    name: "ableton_device_set_enabled",
    title: "Enable or disable device",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "devices.set_enabled",
  },
  {
    name: "ableton_device_set_parameter",
    title: "Set normalized device parameter",
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    requiredCapability: "devices.set_parameter",
  },
  {
    name: "ableton_browser_roots_inspect",
    title: "Inspect Ableton browser roots",
    risk: "read",
    duration: "instant",
    mutationTarget: "read",
    requiredCapability: "browser.inspect_roots",
  },
  {
    name: "ableton_browser_children_inspect",
    title: "Inspect Ableton browser category",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "browser.inspect_children",
  },
  {
    name: "ableton_browser_search",
    title: "Search Ableton browser",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "browser.search",
  },
  {
    name: "ableton_browser_search_external_plugins",
    title: "Search installed external plug-ins",
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    requiredCapability: "browser.search",
  },
  {
    name: "ableton_browser_load_item",
    title: "Load built-in Ableton browser item",
    risk: "reversible",
    duration: "long",
    mutationTarget: "track",
    requiredCapability: "browser.load_item",
  },
  ...new Map(
    abletonOperationDescriptors.map((descriptor) => [
      descriptor.toolName,
      {
        name: descriptor.toolName,
        title: descriptor.title,
        risk: descriptor.risk,
        duration: descriptor.duration,
        mutationTarget: descriptor.mutationTarget,
        requiredCapability: descriptor.requiredCapability,
        operationId: descriptor.operationId,
        action: descriptor.action,
        editScope: descriptor.editScope,
      },
    ]),
  ).values(),
] as const satisfies readonly AbletonToolMetadata[];

export function resolveAbletonToolMetadata(
  toolName: string,
  args: unknown,
): AbletonToolMetadata | undefined {
  const operation = resolveAbletonOperation(toolName, args);
  if (operation !== undefined) return operation.metadata;
  return abletonToolMetadata.find((candidate) => candidate.name === toolName);
}

export interface ToolApprovalRequest {
  metadata: AbletonToolMetadata;
  arguments: Readonly<Record<string, unknown>>;
  agentInstanceId?: string;
  sdkSessionId?: string;
}

export type ToolApprovalRequester = (
  request: ToolApprovalRequest,
) => Promise<boolean>;

export type AskForReadApproval = boolean | (() => boolean);

function requiresExplicitTarget(risk: ToolRisk): boolean {
  return risk === "destructive" || risk === "broad";
}

export function createAbletonPermissionHandler(
  requestApproval?: ToolApprovalRequester,
  askForReads: AskForReadApproval = false,
): PermissionHandler {
  return async (request, invocation) => {
    if (invocation.managedSettingsEnabled || request.kind !== "custom-tool") {
      return { kind: "no-result" };
    }
    const metadata = resolveAbletonToolMetadata(
      request.toolName,
      request.args ?? {},
    );
    if (!metadata) {
      return { kind: "reject", feedback: "Unknown Ableton tool" };
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
    if (metadata.risk === "read") {
      const shouldAskForReads =
        typeof askForReads === "function" ? askForReads() : askForReads;
      if (!shouldAskForReads) {
        return { kind: "approve-once" };
      }
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
    Tool<InspectChainMixerParams>,
    Tool<FindDevicePositionParams>,
    Tool<MoveDeviceParams>,
    Tool<SetChainPropertiesParams>,
    Tool<SetChainMixerParams>,
    Tool<ScenesOperationParams>,
    Tool<TracksOperationParams>,
    Tool<MixerRoutingOperationParams>,
    Tool<TransportOperationParams>,
    Tool<MidiNotesOperationParams>,
    Tool<AudioClipsOperationParams>,
    Tool<RecordingOperationParams>,
    Tool<GrooveOperationParams>,
    Tool<SelectionViewOperationParams>,
    Tool<LiveHistoryOperationParams>,
    Tool<BrowserAdapterOperationParams>,
    Tool<ClipAutomationOperationParams>,
    Tool<WarpMarkerOperationParams>,
    Tool<SpecializedDeviceOperationParams>,
    Tool<WorkflowJobOperationParams>,
  ];
  availableTools: string[];
}

export const toolCatalogPolicy = {
  mode: "eager",
  maximumEagerTools: 64,
} as const;

/**
 * Exact-name compatibility aliases are intentionally explicit. A name belongs
 * here only after its handler has been migrated to the same canonical
 * operation descriptor and protocol route.
 */
export const abletonCompatibilityAliases = {
  ableton_tracks_delete: "tracks.delete",
} as const satisfies Readonly<Record<string, string>>;

export class AbletonToolPreconditionError extends Error {
  public readonly code: string;
  public readonly retryable = true;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AbletonToolPreconditionError";
    this.code = code;
  }
}

function verifyOperationResultAction<T extends { action: string }>(
  expectedAction: string,
  result: T,
): T {
  if (result.action !== expectedAction) {
    throw new Error(
      `Ableton operation returned '${result.action}' for '${expectedAction}'`,
    );
  }
  return result;
}

export interface AbletonToolFailurePayload {
  readonly version: 1;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

const abletonToolFailurePrefix = "ABLETON_TOOL_FAILURE:";
const failureSanitizerOptions = {
  maxDepth: 6,
  maxStringCharacters: 2_048,
  maxArrayItems: 32,
  maxObjectFields: 32,
  maxBytes: 16_384,
} as const;
const maximumFailureStringLength = failureSanitizerOptions.maxStringCharacters;
const maximumFailureArrayLength = failureSanitizerOptions.maxArrayItems;
const maximumFailureObjectEntries = failureSanitizerOptions.maxObjectFields;
const maximumFailureDepth = failureSanitizerOptions.maxDepth;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const credentialAssignment =
  /\b(token|secret|password|api[_ -]?key|authorization)\s*[:=]\s*[^\s,;]+/giu;
const truncatedFailureValue = "[TRUNCATED]";

function isCredentialKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return [
    "token",
    "secret",
    "credential",
    "authorization",
    "password",
    "passphrase",
    "apikey",
    "privatekey",
  ].some((suffix) => normalized.endsWith(suffix));
}

function sanitizeFailureValue(
  value: unknown,
  key: string,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (isCredentialKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const redacted = value.replace(bearerToken, "Bearer [REDACTED]");
    const scrubbed = redacted.replace(credentialAssignment, "$1=[REDACTED]");
    return scrubbed.length <= maximumFailureStringLength
      ? scrubbed
      : `${scrubbed.slice(0, maximumFailureStringLength)}${truncatedFailureValue}`;
  }
  if (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return "[OMITTED BINARY DATA]";
  }
  if (
    depth >= maximumFailureDepth &&
    value !== null &&
    typeof value === "object"
  ) {
    return truncatedFailureValue;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, maximumFailureArrayLength)
      .map((item) => sanitizeFailureValue(item, "", depth + 1, ancestors));
    if (value.length > maximumFailureArrayLength)
      items.push(truncatedFailureValue);
    return items;
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) return "[CIRCULAR]";
    ancestors.add(value);
    const entries = Object.entries(value);
    const sanitized = Object.fromEntries(
      entries
        .slice(0, maximumFailureObjectEntries)
        .map(([childKey, child]) => [
          childKey,
          sanitizeFailureValue(child, childKey, depth + 1, ancestors),
        ]),
    );
    if (entries.length > maximumFailureObjectEntries) {
      sanitized.__truncated__ = `${entries.length - maximumFailureObjectEntries} entries`;
    }
    ancestors.delete(value);
    return sanitized;
  }
  return value;
}

function errorProperty(error: unknown, key: string): unknown {
  return error !== null && typeof error === "object"
    ? Reflect.get(error, key)
    : undefined;
}

export function abletonToolFailurePayload(
  error: unknown,
): AbletonToolFailurePayload {
  const rawCode = errorProperty(error, "code");
  const rawRetryable = errorProperty(error, "retryable");
  const rawDetails = errorProperty(error, "details");
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Ableton tool execution failed";
  const details = sanitizeFailureValue(rawDetails, "details", 0, new WeakSet());
  const payload: AbletonToolFailurePayload = {
    version: 1,
    code:
      typeof rawCode === "string" && rawCode.length > 0
        ? rawCode.slice(0, 128)
        : "tool_execution_failed",
    message: String(sanitizeFailureValue(message, "message", 0, new WeakSet())),
    retryable: typeof rawRetryable === "boolean" ? rawRetryable : false,
    details:
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? (details as Readonly<Record<string, unknown>>)
        : {},
  };
  if (JSON.stringify(payload).length <= failureSanitizerOptions.maxBytes) {
    return payload;
  }
  return {
    ...payload,
    details: { truncated: "Failure details exceeded the bounded payload size" },
  };
}

export function serializeAbletonToolFailure(error: unknown): string {
  return `${abletonToolFailurePrefix}${JSON.stringify(
    abletonToolFailurePayload(error),
  )}`;
}

export function parseAbletonToolFailure(
  value: string | undefined,
): AbletonToolFailurePayload | undefined {
  if (value === undefined || !value.startsWith(abletonToolFailurePrefix)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      value.slice(abletonToolFailurePrefix.length),
    ) as Partial<AbletonToolFailurePayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.code !== "string" ||
      typeof parsed.message !== "string" ||
      typeof parsed.retryable !== "boolean" ||
      parsed.details === null ||
      typeof parsed.details !== "object" ||
      Array.isArray(parsed.details)
    ) {
      return undefined;
    }
    return parsed as AbletonToolFailurePayload;
  } catch {
    return undefined;
  }
}

function failureToolResult(error: unknown): ToolResultObject {
  const payload = abletonToolFailurePayload(error);
  const serialized = `${abletonToolFailurePrefix}${JSON.stringify(payload)}`;
  const details = Object.keys(payload.details).length
    ? ` Details: ${JSON.stringify(payload.details)}`
    : "";
  return {
    resultType: "failure",
    textResultForLlm: `Ableton tool failed (${payload.code}): ${payload.message}.${details}`,
    error: serialized,
    sessionLog: serialized,
  };
}

function withStructuredFailures<T>(tool: Tool<T>): Tool<T> {
  const handler = tool.handler;
  if (handler === undefined) return tool;
  return {
    ...tool,
    handler: async (params, invocation) => {
      try {
        return await handler(params, invocation);
      } catch (error) {
        return failureToolResult(error);
      }
    },
  };
}

function requireConnectedTool<T extends Record<string, unknown>>(
  tool: Tool<T>,
  services: AbletonToolServices,
): Tool<T> {
  const handler = tool.handler;
  if (handler === undefined) return tool;
  return withStructuredFailures({
    ...tool,
    handler: async (params, invocation) => {
      return withCorrelation(invocation.toolCallId, async () => {
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
      });
    },
  });
}

export function createAbletonTools(
  services: AbletonToolServices,
): AbletonToolSet {
  if (abletonToolMetadata.length > toolCatalogPolicy.maximumEagerTools) {
    throw new Error(
      "Ableton tool catalog exceeds the eager-registration limit; split it into deferred groups",
    );
  }
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
  const scenesTool = defineTool("ableton_scenes", {
    description:
      "Lists, inspects, creates, duplicates, renames, recolors, configures, fires, or deletes Live 11 scenes using strict action variants and exact runtime identities. Scene stop is intentionally unavailable because Live 11 does not expose a scene-scoped stop operation.",
    parameters: scenesOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        scenesOperationResultSchema.parse(
          await services.executeScenesOperation!(params),
        ),
      ),
  });
  const tracksTool = defineTool("ableton_tracks", {
    description:
      "Lists and inspects regular, group, return, and master tracks, or performs supported Live 11 track actions with exact identity checks. It does not provide arbitrary track reordering.",
    parameters: tracksOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        tracksOperationResultSchema.parse(
          await services.executeTracksOperation!(params),
        ),
      ),
  });
  const mixerRoutingTool = defineTool("ableton_mixer_routing", {
    description:
      "Inspects or changes Live 11 track, return, and master mixer state; reads bounded meters; and discovers or assigns routing through exact recent snapshot tokens with feedback and external-MIDI warnings.",
    parameters: mixerRoutingOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        mixerRoutingOperationResultSchema.parse(
          await services.executeMixerRoutingOperation!(params),
        ),
      ),
  });
  const transportTool = defineTool("ableton_transport", {
    description:
      "Inspects and controls Live 11 song position, time signature, metronome, launch and record quantization, Link when exposed, cue names/jumps, and Back to Arrangement. Recording controls are intentionally excluded.",
    parameters: transportOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        transportOperationResultSchema.parse(
          await services.executeTransportOperation!(params),
        ),
      ),
  });
  const midiNotesTool = defineTool("ableton_midi_notes", {
    description:
      "Queries and edits identity-bound Live 11 MIDI notes through modern note IDs, including destructive removal and probability, velocity deviation, and release velocity. It does not edit per-note expression.",
    parameters: midiNotesOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        midiNotesOperationResultSchema.parse(
          await services.executeMidiNotesOperation!(params),
        ),
      ),
  });
  const audioClipsTool = defineTool("ableton_audio_clips", {
    description:
      "Inspects and updates identity-bound Live 11 audio clip gain, pitch, warp, markers, and RAM state, and reads bounded warp markers. Warp-marker edits are exposed separately through ableton_warp_markers; unrestricted file import is unavailable.",
    parameters: audioClipsOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        audioClipsOperationResultSchema.parse(
          await services.executeAudioClipsOperation!(params),
        ),
      ),
  });
  const recordingTool = defineTool("ableton_recording", {
    description:
      "Inspects and controls explicit Live 11 recording state, Capture MIDI to selected armed tracks, and exact empty-slot timed Session recording jobs. Launch and recording intent are distinct.",
    parameters: recordingOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        recordingOperationResultSchema.parse(
          await services.executeRecordingOperation!(params),
        ),
      ),
  });
  const groovesTool = defineTool("ableton_grooves", {
    description:
      "Inspects Live 11 Groove Pool entries with revision-bound runtime handles, assigns or clears clip grooves, edits supported groove properties, and sets global groove amount. Groove creation, import, and removal are unavailable.",
    parameters: grooveOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        grooveOperationResultSchema.parse(
          await services.executeGrooveOperation!(params),
        ),
      ),
  });
  const selectionViewTool = defineTool("ableton_selection_view", {
    description:
      "Reads and semantically updates exact Live selection and major view state without arbitrary property access.",
    parameters: selectionViewOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        selectionViewOperationResultSchema.parse(
          await services.executeSelectionViewOperation!(params),
        ),
      ),
  });
  const liveHistoryTool = defineTool("ableton_live_history", {
    description:
      "Inspects or invokes Live's global undo/redo history. Undo and redo require the exact global-history confirmation because they can affect changes made outside Ableton Agent.",
    parameters: liveHistoryOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        liveHistoryOperationResultSchema.parse(
          await services.executeLiveHistoryOperation!(params),
        ),
      ),
  });
  const browserAdaptersTool = defineTool("ableton_browser_adapters", {
    description:
      "Uses capability-detected Live 11 Browser preview and tested private Hot-Swap/insertion adapters while restoring selection and Browser state. No deterministic direct native insertion or empty-chain creation is claimed.",
    parameters: browserAdapterOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        browserAdapterOperationResultSchema.parse(
          await services.executeBrowserAdapterOperation!(params),
        ),
      ),
  });
  const clipAutomationTool = defineTool("ableton_clip_automation", {
    description:
      "Discovers, samples, inserts bounded steps into, or explicitly clears Session clip automation envelopes. Arrangement automation is unavailable.",
    parameters: clipAutomationOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        clipAutomationOperationResultSchema.parse(
          await services.executeClipAutomationOperation!(params),
        ),
      ),
  });
  const warpMarkersTool = defineTool("ableton_warp_markers", {
    description:
      "Inspects or mutates identity-bound audio clip warp markers using an exact marker snapshot revision, ordered coordinates, bounded BPM, verified readback, and safe compensation when possible.",
    parameters: warpMarkerOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        warpMarkerOperationResultSchema.parse(
          await services.executeWarpMarkerOperation!(params),
        ),
      ),
  });
  const specializedDevicesTool = defineTool("ableton_special_devices", {
    description:
      "Provides only capability-detected Live 11 Simpler marker/slice, Looper control/export, and Wavetable modulation operations for exact devices.",
    parameters: specializedDeviceOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        specializedDeviceOperationResultSchema.parse(
          await services.executeSpecializedDeviceOperation!(params),
        ),
      ),
  });
  const workflowJobsTool = defineTool("ableton_workflow_jobs", {
    description:
      "Lists, inspects, or cancels bounded asynchronous Live workflow jobs with lifecycle, progress, result, failure, and indeterminate reconnect state.",
    parameters: workflowJobOperationParamsSchema,
    handler: async (params) =>
      verifyOperationResultAction(
        params.action,
        workflowJobOperationResultSchema.parse(
          await services.executeWorkflowJobOperation!(params),
        ),
      ),
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
      "Creates exactly one MIDI or audio track at the end of the Ableton Live set and verifies its resulting identity and state. For requests that also load Browser content, resolve a supported exact Browser item before creating the track. If this mutation reports an indeterminate outcome, inspect the session and never retry creation unchanged.",
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
  const inspectChainMixerDescriptor = abletonOperationDescriptors[0];
  const inspectChainMixerTool = defineTool("ableton_rack_chain_mixer_inspect", {
    description:
      "Inspects mute, solo, volume, pan, and exposed sends for one exact existing rack or Drum Rack pad chain, including runtime parameter identities required for safe mixer edits.",
    parameters: inspectChainMixerDescriptor.inputSchema,
    handler: async (params) =>
      inspectChainMixerDescriptor.resultSchema.parse(
        await services.inspectChainMixer(params),
      ),
  });
  const findPositionDescriptor = abletonOperationDescriptors[1];
  const findDevicePositionTool = defineTool("ableton_device_find_position", {
    description:
      "Preflights the exact Live 11 destination position for an existing top-level or existing rack/Drum Rack chain device using Song.find_device_position. It does not mutate, create chains, or traverse unsupported nested topology.",
    parameters: findPositionDescriptor.inputSchema,
    handler: async (params) =>
      findPositionDescriptor.resultSchema.parse(
        await services.findDevicePosition(params),
      ),
  });
  const moveDescriptor = abletonOperationDescriptors[2];
  const moveDeviceTool = defineTool("ableton_device_move", {
    description:
      "Moves or reorders one exact existing device within a track, within an existing rack or Drum Rack pad chain, or between those existing parents using Live 11 Song.find_device_position and Song.move_device. It verifies the canonical parent and final index; it never creates a chain or inserts a new device.",
    parameters: moveDescriptor.inputSchema,
    handler: async (params) =>
      moveDescriptor.resultSchema.parse(await services.moveDevice(params)),
  });
  const chainPropertiesDescriptor = abletonOperationDescriptors[3];
  const setChainPropertiesTool = defineTool(
    "ableton_rack_chain_set_properties",
    {
      description:
        "Renames and/or recolors one exact existing rack or Drum Rack pad chain, with verified before/after state and rollback on failure. It cannot create, delete, or reorder chains.",
      parameters: chainPropertiesDescriptor.inputSchema,
      handler: async (params) =>
        chainPropertiesDescriptor.resultSchema.parse(
          await services.setChainProperties(params),
        ),
    },
  );
  const chainMixerDescriptor = abletonOperationDescriptors[4];
  const setChainMixerTool = defineTool("ableton_rack_chain_set_mixer", {
    description:
      "Sets mute, solo, and exposed chain mixer volume, pan, or sends on one exact existing rack or Drum Rack pad chain. Parameter changes use normalized values plus exact runtime parameter identities, and the full update is verified and rolled back on failure.",
    parameters: chainMixerDescriptor.inputSchema,
    handler: async (params) =>
      chainMixerDescriptor.resultSchema.parse(
        await services.setChainMixer(params),
      ),
  });
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
        "Returns one bounded page of direct children for an exact identity-bound Ableton Browser container, including Live virtual categories that expose children without reporting themselves as folders. It never recursively traverses the browser tree.",
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
      'Performs a deterministic bounded Ableton Browser search. Search each distinct requested sound separately and choose roots by intent: instruments for stock instruments/devices, sounds for curated playable presets, drums for kits and Drum Racks, packs for installed Pack content, user_library for user presets, and audio_effects/midi_effects only for effects. Examples: piano or warm pad -> ["sounds","instruments","packs","user_library"]; 808 kit -> ["drums","packs","user_library"]; "my preset" -> ["user_library"]. Prefer exact loadable device/preset results. Always inspect truncated and stopReason; when results are weak or truncated, retry with narrower roots or a literal synonym such as upright bass/double bass rather than loading the first loose substring match. Results are runtime identity-bound and report whether each item has a supported load target.',
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
      "Loads one explicitly selected, exact runtime identity-bound device or device preset from the Ableton Browser onto one exact compatible regular track. Supported items may come from any Browser root, but folders, samples, clips, grooves, unknown load types, arbitrary paths, incompatible tracks, and active hotswap are rejected before mutation. Live may add a top-level device or apply a preset by reconfiguring an existing device; the operation captures bounded before/after state and reports the verified mutation mode.",
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
      withStructuredFailures(connectionStatusTool),
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
      requireConnectedTool(inspectChainMixerTool, services),
      requireConnectedTool(findDevicePositionTool, services),
      requireConnectedTool(moveDeviceTool, services),
      requireConnectedTool(setChainPropertiesTool, services),
      requireConnectedTool(setChainMixerTool, services),
      requireConnectedTool(scenesTool, services),
      requireConnectedTool(tracksTool, services),
      requireConnectedTool(mixerRoutingTool, services),
      requireConnectedTool(transportTool, services),
      requireConnectedTool(midiNotesTool, services),
      requireConnectedTool(audioClipsTool, services),
      requireConnectedTool(recordingTool, services),
      requireConnectedTool(groovesTool, services),
      requireConnectedTool(selectionViewTool, services),
      requireConnectedTool(liveHistoryTool, services),
      requireConnectedTool(browserAdaptersTool, services),
      requireConnectedTool(clipAutomationTool, services),
      requireConnectedTool(warpMarkersTool, services),
      requireConnectedTool(specializedDevicesTool, services),
      requireConnectedTool(workflowJobsTool, services),
    ],
    availableTools: [
      ...new Set(
        abletonToolMetadata.map((metadata) => `custom:${metadata.name}`),
      ),
    ],
  };
}

export interface ScopeAbletonToolsOptions {
  readonly allowedToolNames: readonly string[];
  readonly allowedOperationIds?: readonly string[];
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export function scopeAbletonTools(
  toolSet: AbletonToolSet,
  options: ScopeAbletonToolsOptions,
): Tool[] {
  const allowedTools = new Set(options.allowedToolNames);
  const allowedOperations =
    options.allowedOperationIds === undefined
      ? undefined
      : new Set(options.allowedOperationIds);
  return (toolSet.tools as unknown as Tool[]).flatMap((tool) => {
    if (!allowedTools.has(tool.name)) return [];
    const descriptors = abletonOperationDescriptors.filter(
      (descriptor) => descriptor.toolName === tool.name,
    );
    if (descriptors.length === 0) return [tool];
    const selected = descriptors.filter(
      (descriptor) =>
        (allowedOperations === undefined ||
          allowedOperations.has(descriptor.operationId)) &&
        (options.capabilities === undefined ||
          options.capabilities[descriptor.requiredCapability] === true),
    );
    if (selected.length === 0) return [];
    if (selected.length === descriptors.length) return [tool];
    const parameters =
      selected.length === 1
        ? selected[0]!.inputSchema
        : z.union(
            selected.map((descriptor) => descriptor.inputSchema) as [
              ZodType,
              ZodType,
              ...ZodType[],
            ],
          );
    return [{ ...tool, parameters }];
  });
}

export * from "./mutation-policy.js";
export * from "./operation-descriptor.js";
