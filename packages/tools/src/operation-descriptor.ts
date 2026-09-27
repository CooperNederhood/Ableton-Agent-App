import {
  audioClipsOperationParamsSchema,
  audioClipsOperationResultSchema,
  browserAdapterOperationParamsSchema,
  browserAdapterOperationResultSchema,
  chainLocationTargetSchema,
  createArrangementMidiClipResultSchema,
  createMidiClipResultSchema,
  cuePointMutationResultSchema,
  deleteArrangementClipResultSchema,
  deleteSessionClipResultSchema,
  duplicateClipToArrangementResultSchema,
  duplicateSessionClipResultSchema,
  fillArrangementRegionResultSchema,
  findDevicePositionResultSchema,
  clipAutomationOperationParamsSchema,
  clipAutomationOperationResultSchema,
  grooveOperationParamsSchema,
  grooveOperationResultSchema,
  liveHistoryOperationParamsSchema,
  liveHistoryOperationResultSchema,
  inspectChainMixerResultSchema,
  inspectArrangementResultSchema,
  inspectArrangementTransportResultSchema,
  inspectBrowserChildrenResultSchema,
  inspectBrowserRootsResultSchema,
  inspectDeviceParametersResultSchema,
  inspectDevicesResultSchema,
  inspectDrumPadChainDevicesResultSchema,
  inspectDrumPadChainsResultSchema,
  inspectDrumRackPadsResultSchema,
  inspectRackChainDevicesResultSchema,
  inspectRackChainsResultSchema,
  launchSessionClipResultSchema,
  loadBrowserItemResultSchema,
  midiNotesOperationParamsSchema,
  midiNotesOperationResultSchema,
  mixerRoutingOperationParamsSchema,
  mixerRoutingOperationResultSchema,
  moveDeviceResultSchema,
  renameTrackResultSchema,
  replaceArrangementMidiNotesResultSchema,
  replaceMidiNotesResultSchema,
  scenesOperationParamsSchema,
  scenesOperationResultSchema,
  recordingOperationParamsSchema,
  recordingOperationResultSchema,
  selectionViewOperationParamsSchema,
  selectionViewOperationResultSchema,
  specializedDeviceOperationParamsSchema,
  specializedDeviceOperationResultSchema,
  setChainMixerResultSchema,
  setChainPropertiesResultSchema,
  setArrangementClipPropertiesResultSchema,
  setArrangementLoopResultSchema,
  setDeviceEnabledResultSchema,
  setDeviceParameterResultSchema,
  setPlayingResultSchema,
  setSessionClipPropertiesResultSchema,
  setTempoResultSchema,
  setTrackMixerResultSchema,
  sessionSnapshotSchema,
  searchBrowserResultSchema,
  trackMutationResultSchema,
  tracksOperationParamsSchema,
  tracksOperationResultSchema,
  transportOperationParamsSchema,
  transportOperationResultSchema,
  warpMarkerOperationParamsSchema,
  warpMarkerOperationResultSchema,
  workflowJobOperationParamsSchema,
  workflowJobOperationResultSchema,
  type CommandName,
} from "@ableton-agent/protocol";
import { z, type ZodType } from "zod";

import type {
  AbletonToolMetadata,
  AbletonToolServices,
  ToolDuration,
  ToolRisk,
} from "./index.js";
import {
  arrangementCreateMidiClipParamsSchema,
  arrangementDeleteClipParamsSchema,
  arrangementDuplicateClipParamsSchema,
  arrangementFillRegionParamsSchema,
  arrangementInspectParamsSchema,
  arrangementReplaceNotesParamsSchema,
  arrangementSetClipPropertiesParamsSchema,
  browserChildrenParamsSchema,
  browserLoadItemParamsSchema,
  browserRootsParamsSchema,
  browserSearchExternalPluginsParamsSchema,
  browserSearchParamsSchema,
  devicesFindPositionParamsSchema,
  devicesInspectChainMixerParamsSchema,
  devicesInspectDrumPadChainDevicesParamsSchema,
  devicesInspectDrumPadChainsParamsSchema,
  devicesInspectDrumRackPadsParamsSchema,
  devicesInspectParametersParamsSchema,
  devicesInspectRackChainDevicesParamsSchema,
  devicesInspectRackChainsParamsSchema,
  devicesInspectParamsSchema,
  devicesMoveParamsSchema,
  devicesSetChainMixerParamsSchema,
  devicesSetChainPropertiesParamsSchema,
  devicesSetEnabledParamsSchema,
  devicesSetParameterParamsSchema,
  mixerRoutingSetTrackMixerParamsSchema,
  sessionClipsCreateMidiParamsSchema,
  sessionClipsDeleteParamsSchema,
  sessionClipsDuplicateParamsSchema,
  sessionClipsLaunchParamsSchema,
  sessionClipsReplaceNotesParamsSchema,
  sessionClipsSetPropertiesParamsSchema,
  sessionConnectionStatusParamsSchema,
  sessionInspectParamsSchema,
  tracksCreateParamsSchema,
  tracksRenameParamsSchema,
  transportCreateCuePointParamsSchema,
  transportDeleteCuePointParamsSchema,
  transportInspectArrangementParamsSchema,
  transportSetArrangementLoopParamsSchema,
  transportSetPlayingParamsSchema,
  transportSetTempoParamsSchema,
} from "./grouped-tool-schemas.js";
import type { MutationTarget } from "./mutation-policy.js";

export type AbletonOperationEditScope = "none" | "session" | "affected-tracks";

export interface AbletonOperationLifecycleIdentity {
  readonly domain: string;
  readonly action: string;
  readonly targetKind: string;
  readonly targetReferences: readonly string[];
}

export interface AbletonOperationDescriptor {
  readonly operationId: string;
  readonly action: string;
  readonly toolName: string;
  readonly title: string;
  readonly inputSchema: ZodType;
  readonly resultSchema: ZodType;
  readonly risk: ToolRisk;
  readonly duration: ToolDuration;
  readonly mutationTarget: MutationTarget;
  readonly editScope: AbletonOperationEditScope;
  readonly requiredCapability: string;
  readonly protocolCommand: CommandName;
  readonly lifecycleEvents: {
    readonly requested: "agent.operation.requested";
    readonly policyEvaluated: "agent.operation.policy";
    readonly queued: "agent.operation.queued";
    readonly started: "agent.operation.started";
    readonly progress: "workflow_job.progress";
    readonly verification: "agent.operation.verification";
    readonly completed: "agent.operation.completed";
    readonly failed: "agent.operation.failed";
    readonly cancelled: "agent.operation.cancelled";
  };
  readonly handlerBinding:
    | "findDevicePosition"
    | "inspectChainMixer"
    | "moveDevice"
    | "setChainProperties"
    | "setChainMixer"
    | "executeScenesOperation"
    | "executeTracksOperation"
    | "executeMixerRoutingOperation"
    | "executeTransportOperation"
    | "executeMidiNotesOperation"
    | "executeAudioClipsOperation"
    | "executeRecordingOperation"
    | "executeGrooveOperation"
    | "executeSelectionViewOperation"
    | "executeLiveHistoryOperation"
    | "executeBrowserAdapterOperation"
    | "executeClipAutomationOperation"
    | "executeWarpMarkerOperation"
    | "executeSpecializedDeviceOperation"
    | "executeWorkflowJobOperation"
    | keyof Pick<
        AbletonToolServices,
        | "getConnectionStatus"
        | "inspectSession"
        | "setTempo"
        | "setPlaying"
        | "inspectArrangementTransport"
        | "setArrangementLoop"
        | "createCuePoint"
        | "deleteCuePoint"
        | "createTrack"
        | "renameTrack"
        | "setTrackMixer"
        | "createMidiClip"
        | "replaceMidiNotes"
        | "launchSessionClip"
        | "duplicateSessionClip"
        | "deleteSessionClip"
        | "setSessionClipProperties"
        | "createArrangementMidiClip"
        | "inspectArrangement"
        | "deleteArrangementClip"
        | "replaceArrangementMidiNotes"
        | "duplicateClipToArrangement"
        | "fillArrangementRegion"
        | "setArrangementClipProperties"
        | "inspectDevices"
        | "inspectDeviceParameters"
        | "inspectRackChains"
        | "inspectRackChainDevices"
        | "inspectDrumRackPads"
        | "inspectDrumPadChains"
        | "inspectDrumPadChainDevices"
        | "inspectChainMixer"
        | "findDevicePosition"
        | "moveDevice"
        | "setChainProperties"
        | "setChainMixer"
        | "setDeviceEnabled"
        | "setDeviceParameter"
        | "inspectBrowserRoots"
        | "inspectBrowserChildren"
        | "searchBrowser"
        | "loadBrowserItem"
      >;
  readonly affectedTrackReferences: (input: unknown) => readonly string[];
  readonly lifecycleIdentity: (
    input: unknown,
  ) => AbletonOperationLifecycleIdentity;
}

export interface ResolvedAbletonOperation {
  readonly descriptor: AbletonOperationDescriptor;
  readonly metadata: AbletonToolMetadata;
  readonly input: unknown;
  readonly affectedTrackReferences: readonly string[];
  readonly lifecycleIdentity: AbletonOperationLifecycleIdentity;
}

function normalizeReferences(references: readonly string[]): readonly string[] {
  return [...new Set(references)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function collectExpectedReferences(
  value: unknown,
  references: string[] = [],
): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectExpectedReferences(item, references);
    return references;
  }
  if (value === null || typeof value !== "object") return references;
  for (const [key, child] of Object.entries(value)) {
    if (
      key.toLowerCase().includes("expected") &&
      key.toLowerCase().includes("reference") &&
      typeof child === "string"
    ) {
      references.push(child);
    } else {
      collectExpectedReferences(child, references);
    }
  }
  return references;
}

function collectTrackReferences(
  value: unknown,
  references: string[] = [],
): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTrackReferences(item, references);
    return references;
  }
  if (value === null || typeof value !== "object") return references;
  const record = value as Record<string, unknown>;
  if (
    ["regular", "return", "master"].includes(String(record.kind)) &&
    typeof record.expectedReference === "string"
  ) {
    references.push(record.expectedReference);
  }
  for (const child of Object.values(record)) {
    collectTrackReferences(child, references);
  }
  return references;
}

function operationTargetKind(input: unknown): string {
  if (input === null || typeof input !== "object") return "session";
  const record = input as Record<string, unknown>;
  const value =
    record.value && typeof record.value === "object"
      ? (record.value as Record<string, unknown>)
      : undefined;
  const targetValue = record.target ?? value?.target;
  const target =
    targetValue && typeof targetValue === "object"
      ? (targetValue as Record<string, unknown>)
      : undefined;
  if (typeof target?.kind === "string") return target.kind;
  if (typeof target?.view === "string") return `${target.view}-clip`;
  return "session";
}

interface CoreOperationDefinition {
  readonly operationId: string;
  readonly action: string;
  readonly toolName: string;
  readonly title: string;
  readonly inputSchema: ZodType;
  readonly resultSchema: ZodType;
  readonly risk: ToolRisk;
  readonly mutationTarget: MutationTarget;
  readonly editScope: AbletonOperationEditScope;
  readonly requiredCapability: string;
  readonly protocolCommand?: CommandName;
  readonly handlerBinding: AbletonOperationDescriptor["handlerBinding"];
}

const operationLifecycleEvents = {
  requested: "agent.operation.requested",
  policyEvaluated: "agent.operation.policy",
  queued: "agent.operation.queued",
  started: "agent.operation.started",
  progress: "workflow_job.progress",
  verification: "agent.operation.verification",
  completed: "agent.operation.completed",
  failed: "agent.operation.failed",
  cancelled: "agent.operation.cancelled",
} as const;

function coreOperationDescriptor(
  definition: CoreOperationDefinition,
): AbletonOperationDescriptor {
  return {
    ...definition,
    duration: "short",
    protocolCommand:
      definition.protocolCommand ?? (definition.operationId as CommandName),
    lifecycleEvents: operationLifecycleEvents,
    affectedTrackReferences: (input) =>
      normalizeReferences(collectTrackReferences(input)),
    lifecycleIdentity: (input) => ({
      domain: definition.operationId.split(".")[0] ?? "ableton",
      action: definition.action,
      targetKind: operationTargetKind(input),
      targetReferences: normalizeReferences(collectExpectedReferences(input)),
    }),
  };
}

function operationCapability(domain: string, action: string): string {
  return `${domain}.${action.replaceAll("-", "_")}`;
}

function domainOperationDescriptors(
  options: readonly ZodType[],
  configuration: {
    readonly domain: string;
    readonly toolName: string;
    readonly title: string;
    readonly resultSchemas: readonly ZodType[];
    readonly handlerBinding: AbletonOperationDescriptor["handlerBinding"];
    readonly actions: readonly string[];
    readonly readActions: ReadonlySet<string>;
    readonly destructiveActions?: ReadonlySet<string>;
    readonly broadActions?: ReadonlySet<string>;
    readonly longActions?: ReadonlySet<string>;
    readonly trackActions?: ReadonlySet<string>;
    readonly granularProtocol?: boolean;
  },
): readonly AbletonOperationDescriptor[] {
  if (
    options.length !== configuration.actions.length ||
    options.length !== configuration.resultSchemas.length
  ) {
    throw new Error(
      `Operation action/schema mismatch for ${configuration.domain}`,
    );
  }
  return options
    .map((inputSchema, index) => {
      const action = configuration.actions[index]!;
      const isRead = configuration.readActions.has(action);
      const isTrackMutation = configuration.trackActions?.has(action) ?? false;
      return coreOperationDescriptor({
        operationId: `${configuration.domain}.${action.replaceAll("-", "_")}`,
        action,
        toolName: configuration.toolName,
        title: `${configuration.title}: ${action}`,
        inputSchema,
        resultSchema: configuration.resultSchemas[index]!,
        risk: isRead
          ? "read"
          : configuration.broadActions?.has(action)
            ? "broad"
            : configuration.destructiveActions?.has(action)
              ? "destructive"
              : "reversible",
        mutationTarget: isRead
          ? "read"
          : isTrackMutation
            ? "tracks"
            : "session",
        editScope: isRead
          ? "none"
          : isTrackMutation
            ? "affected-tracks"
            : "session",
        requiredCapability: operationCapability(configuration.domain, action),
        protocolCommand: (configuration.granularProtocol
          ? operationCapability(configuration.domain, action)
          : `${configuration.domain}.${isRead ? "inspect" : "mutate"}`) as CommandName,
        handlerBinding: configuration.handlerBinding,
      });
    })
    .map((descriptor) => ({
      ...descriptor,
      duration: configuration.longActions?.has(descriptor.action)
        ? "long"
        : descriptor.duration,
    }));
}

function findDeviceTrackReferences(input: unknown): readonly string[] {
  const parsed = devicesFindPositionParamsSchema.parse(input);
  return normalizeReferences([
    parsed.source.track.expectedReference,
    parsed.destination.track.expectedReference,
  ]);
}

function moveDeviceTrackReferences(input: unknown): readonly string[] {
  const parsed = devicesMoveParamsSchema.parse(input);
  return normalizeReferences([
    parsed.source.track.expectedReference,
    parsed.destination.track.expectedReference,
  ]);
}

function chainTrackReferences(input: unknown): readonly string[] {
  const parsed = z
    .object({ target: chainLocationTargetSchema })
    .passthrough()
    .parse(input);
  return [parsed.target.track.expectedReference];
}

interface ConsolidatedOperationDefinition {
  readonly operationId: string;
  readonly action: string;
  readonly toolName: string;
  readonly title: string;
  readonly inputSchema: ZodType;
  readonly resultSchema: ZodType;
  readonly risk: ToolRisk;
  readonly duration: ToolDuration;
  readonly mutationTarget: MutationTarget;
  readonly editScope: AbletonOperationEditScope;
  readonly requiredCapability: string;
  readonly protocolCommand: CommandName;
  readonly handlerBinding: AbletonOperationDescriptor["handlerBinding"];
  readonly targetKind: string | ((input: unknown) => string);
  readonly affectedTrackReferences?: (input: unknown) => readonly string[];
}

function rootString(input: unknown, field: string): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function rootTrackReferences(input: unknown): readonly string[] {
  const reference = rootString(input, "expectedReference");
  return reference === undefined ? [] : [reference];
}

function duplicateSessionTrackReferences(input: unknown): readonly string[] {
  return normalizeReferences(
    [
      rootString(input, "expectedReference"),
      rootString(input, "expectedDestinationTrackReference"),
    ].filter((reference): reference is string => reference !== undefined),
  );
}

function consolidatedOperationDescriptor(
  definition: ConsolidatedOperationDefinition,
): AbletonOperationDescriptor {
  return {
    operationId: definition.operationId,
    action: definition.action,
    toolName: definition.toolName,
    title: definition.title,
    inputSchema: definition.inputSchema,
    resultSchema: definition.resultSchema,
    risk: definition.risk,
    duration: definition.duration,
    mutationTarget: definition.mutationTarget,
    editScope: definition.editScope,
    requiredCapability: definition.requiredCapability,
    protocolCommand: definition.protocolCommand,
    lifecycleEvents: operationLifecycleEvents,
    handlerBinding: definition.handlerBinding,
    affectedTrackReferences: definition.affectedTrackReferences ?? (() => []),
    lifecycleIdentity: (input) => ({
      domain: definition.operationId.split(".")[0] ?? "ableton",
      action: definition.action,
      targetKind:
        typeof definition.targetKind === "function"
          ? definition.targetKind(input)
          : definition.targetKind,
      targetReferences: normalizeReferences(collectExpectedReferences(input)),
    }),
  };
}

const consolidatedOperationDescriptors = [
  consolidatedOperationDescriptor({
    operationId: "session.connection_status",
    action: "connection-status",
    toolName: "ableton_session",
    title: "Check Ableton connection",
    inputSchema: sessionConnectionStatusParamsSchema,
    resultSchema: z.unknown(),
    risk: "read",
    duration: "instant",
    mutationTarget: "read",
    editScope: "none",
    requiredCapability: "system.ping",
    protocolCommand: "system.ping",
    handlerBinding: "getConnectionStatus",
    targetKind: "connection",
  }),
  consolidatedOperationDescriptor({
    operationId: "session.inspect",
    action: "inspect",
    toolName: "ableton_session",
    title: "Inspect Ableton session",
    inputSchema: sessionInspectParamsSchema,
    resultSchema: sessionSnapshotSchema,
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    editScope: "none",
    requiredCapability: "session.inspect",
    protocolCommand: "session.inspect",
    handlerBinding: "inspectSession",
    targetKind: "session",
  }),
  consolidatedOperationDescriptor({
    operationId: "tracks.create",
    action: "create",
    toolName: "ableton_tracks",
    title: "Create Ableton track",
    inputSchema: tracksCreateParamsSchema,
    resultSchema: trackMutationResultSchema,
    risk: "reversible",
    duration: "short",
    mutationTarget: "session",
    editScope: "session",
    requiredCapability: "tracks.create",
    protocolCommand: "tracks.create",
    handlerBinding: "createTrack",
    targetKind: "track",
  }),
  consolidatedOperationDescriptor({
    operationId: "tracks.rename",
    action: "rename",
    toolName: "ableton_tracks",
    title: "Rename Ableton track",
    inputSchema: tracksRenameParamsSchema,
    resultSchema: renameTrackResultSchema,
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    editScope: "affected-tracks",
    requiredCapability: "tracks.rename",
    protocolCommand: "tracks.rename",
    handlerBinding: "renameTrack",
    targetKind: "track",
    affectedTrackReferences: rootTrackReferences,
  }),
  consolidatedOperationDescriptor({
    operationId: "tracks.set_mixer",
    action: "set-track-mixer",
    toolName: "ableton_mixer_routing",
    title: "Set Ableton track mixer",
    inputSchema: mixerRoutingSetTrackMixerParamsSchema,
    resultSchema: setTrackMixerResultSchema,
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    editScope: "affected-tracks",
    requiredCapability: "tracks.set_mixer",
    protocolCommand: "tracks.set_mixer",
    handlerBinding: "setTrackMixer",
    targetKind: "track",
    affectedTrackReferences: rootTrackReferences,
  }),
  ...[
    {
      operationId: "transport.set_tempo",
      action: "set-tempo",
      title: "Set Ableton tempo",
      inputSchema: transportSetTempoParamsSchema,
      resultSchema: setTempoResultSchema,
      risk: "reversible",
      duration: "instant",
      mutationTarget: "session",
      editScope: "session",
      requiredCapability: "transport.set_tempo",
      protocolCommand: "transport.set_tempo",
      handlerBinding: "setTempo",
      targetKind: "transport",
    },
    {
      operationId: "transport.set_playing",
      action: "set-playing",
      title: "Set Ableton transport playback",
      inputSchema: transportSetPlayingParamsSchema,
      resultSchema: setPlayingResultSchema,
      risk: "reversible",
      duration: "instant",
      mutationTarget: "session",
      editScope: "session",
      requiredCapability: "transport.set_playing",
      protocolCommand: "transport.set_playing",
      handlerBinding: "setPlaying",
      targetKind: "transport",
    },
    {
      operationId: "transport.inspect_arrangement",
      action: "inspect-arrangement",
      title: "Inspect Arrangement transport",
      inputSchema: transportInspectArrangementParamsSchema,
      resultSchema: inspectArrangementTransportResultSchema,
      risk: "read",
      duration: "short",
      mutationTarget: "read",
      editScope: "none",
      requiredCapability: "transport.inspect_arrangement",
      protocolCommand: "transport.inspect_arrangement",
      handlerBinding: "inspectArrangementTransport",
      targetKind: "arrangement-transport",
    },
    {
      operationId: "transport.set_arrangement_loop",
      action: "set-arrangement-loop",
      title: "Set Arrangement loop",
      inputSchema: transportSetArrangementLoopParamsSchema,
      resultSchema: setArrangementLoopResultSchema,
      risk: "reversible",
      duration: "instant",
      mutationTarget: "session",
      editScope: "session",
      requiredCapability: "transport.set_arrangement_loop",
      protocolCommand: "transport.set_arrangement_loop",
      handlerBinding: "setArrangementLoop",
      targetKind: "arrangement-loop",
    },
    {
      operationId: "transport.create_cue_point",
      action: "create-cue-point",
      title: "Create Arrangement cue point",
      inputSchema: transportCreateCuePointParamsSchema,
      resultSchema: cuePointMutationResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "session",
      editScope: "session",
      requiredCapability: "transport.create_cue_point",
      protocolCommand: "transport.create_cue_point",
      handlerBinding: "createCuePoint",
      targetKind: "cue-point",
    },
    {
      operationId: "transport.delete_cue_point",
      action: "delete-cue-point",
      title: "Delete Arrangement cue point",
      inputSchema: transportDeleteCuePointParamsSchema,
      resultSchema: cuePointMutationResultSchema,
      risk: "destructive",
      duration: "short",
      mutationTarget: "session",
      editScope: "session",
      requiredCapability: "transport.delete_cue_point",
      protocolCommand: "transport.delete_cue_point",
      handlerBinding: "deleteCuePoint",
      targetKind: "cue-point",
    },
  ].map((definition) =>
    consolidatedOperationDescriptor({
      ...definition,
      toolName: "ableton_transport",
    } as ConsolidatedOperationDefinition),
  ),
  ...[
    {
      operationId: "clips.create_midi",
      action: "create-midi",
      title: "Create Ableton MIDI clip",
      inputSchema: sessionClipsCreateMidiParamsSchema,
      resultSchema: createMidiClipResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "clips.create_midi",
      protocolCommand: "clips.create_midi",
      handlerBinding: "createMidiClip",
      targetKind: "session-clip",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "clips.replace_notes",
      action: "replace-notes",
      title: "Replace Ableton MIDI notes",
      inputSchema: sessionClipsReplaceNotesParamsSchema,
      resultSchema: replaceMidiNotesResultSchema,
      risk: "destructive",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "clips.replace_notes",
      protocolCommand: "clips.replace_notes",
      handlerBinding: "replaceMidiNotes",
      targetKind: "session-clip",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "clips.launch",
      action: "launch",
      title: "Launch Session clip",
      inputSchema: sessionClipsLaunchParamsSchema,
      resultSchema: launchSessionClipResultSchema,
      risk: "reversible",
      duration: "instant",
      mutationTarget: "track",
      requiredCapability: "clips.launch",
      protocolCommand: "clips.launch",
      handlerBinding: "launchSessionClip",
      targetKind: "session-clip",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "clips.duplicate",
      action: "duplicate",
      title: "Duplicate Session clip",
      inputSchema: sessionClipsDuplicateParamsSchema,
      resultSchema: duplicateSessionClipResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "tracks",
      requiredCapability: "clips.duplicate",
      protocolCommand: "clips.duplicate",
      handlerBinding: "duplicateSessionClip",
      targetKind: "session-clip",
      affectedTrackReferences: duplicateSessionTrackReferences,
    },
    {
      operationId: "clips.delete",
      action: "delete",
      title: "Delete Session clip",
      inputSchema: sessionClipsDeleteParamsSchema,
      resultSchema: deleteSessionClipResultSchema,
      risk: "destructive",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "clips.delete",
      protocolCommand: "clips.delete",
      handlerBinding: "deleteSessionClip",
      targetKind: "session-clip",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "clips.set_properties",
      action: "set-properties",
      title: "Set Session clip properties",
      inputSchema: sessionClipsSetPropertiesParamsSchema,
      resultSchema: setSessionClipPropertiesResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "clips.set_properties",
      protocolCommand: "clips.set_properties",
      handlerBinding: "setSessionClipProperties",
      targetKind: "session-clip",
      affectedTrackReferences: rootTrackReferences,
    },
  ].map((definition) =>
    consolidatedOperationDescriptor({
      ...definition,
      toolName: "ableton_session_clips",
      editScope: "affected-tracks",
    } as ConsolidatedOperationDefinition),
  ),
  ...[
    {
      operationId: "arrangement.create_midi_clip",
      action: "create-midi-clip",
      title: "Create Arrangement MIDI clip",
      inputSchema: arrangementCreateMidiClipParamsSchema,
      resultSchema: createArrangementMidiClipResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "arrangement.create_midi_clip",
      protocolCommand: "arrangement.create_midi_clip",
      handlerBinding: "createArrangementMidiClip",
      targetKind: "arrangement-clip",
    },
    {
      operationId: "arrangement.inspect",
      action: "inspect",
      title: "Inspect Ableton Arrangement",
      inputSchema: arrangementInspectParamsSchema,
      resultSchema: inspectArrangementResultSchema,
      risk: "read",
      duration: "short",
      mutationTarget: "read",
      requiredCapability: "arrangement.inspect",
      protocolCommand: "arrangement.inspect",
      handlerBinding: "inspectArrangement",
      targetKind: "arrangement",
    },
    {
      operationId: "arrangement.delete_clip",
      action: "delete-clip",
      title: "Delete Arrangement clip",
      inputSchema: arrangementDeleteClipParamsSchema,
      resultSchema: deleteArrangementClipResultSchema,
      risk: "destructive",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "arrangement.delete_clip",
      protocolCommand: "arrangement.delete_clip",
      handlerBinding: "deleteArrangementClip",
      targetKind: "arrangement-clip",
    },
    {
      operationId: "arrangement.replace_notes",
      action: "replace-notes",
      title: "Replace Arrangement MIDI notes",
      inputSchema: arrangementReplaceNotesParamsSchema,
      resultSchema: replaceArrangementMidiNotesResultSchema,
      risk: "destructive",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "arrangement.replace_notes",
      protocolCommand: "arrangement.replace_notes",
      handlerBinding: "replaceArrangementMidiNotes",
      targetKind: "arrangement-clip",
    },
    {
      operationId: "arrangement.duplicate_clip",
      action: "duplicate-clip",
      title: "Duplicate Session clip to Arrangement",
      inputSchema: arrangementDuplicateClipParamsSchema,
      resultSchema: duplicateClipToArrangementResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "arrangement.duplicate_clip",
      protocolCommand: "arrangement.duplicate_clip",
      handlerBinding: "duplicateClipToArrangement",
      targetKind: "arrangement-clip",
    },
    {
      operationId: "arrangement.fill_region",
      action: "fill-region",
      title: "Fill Arrangement region",
      inputSchema: arrangementFillRegionParamsSchema,
      resultSchema: fillArrangementRegionResultSchema,
      risk: "reversible",
      duration: "long",
      mutationTarget: "track",
      requiredCapability: "arrangement.fill_region",
      protocolCommand: "arrangement.fill_region",
      handlerBinding: "fillArrangementRegion",
      targetKind: "arrangement-region",
    },
    {
      operationId: "arrangement.set_clip_properties",
      action: "set-clip-properties",
      title: "Set Arrangement clip properties",
      inputSchema: arrangementSetClipPropertiesParamsSchema,
      resultSchema: setArrangementClipPropertiesResultSchema,
      risk: "reversible",
      duration: "short",
      mutationTarget: "track",
      requiredCapability: "arrangement.set_clip_properties",
      protocolCommand: "arrangement.set_clip_properties",
      handlerBinding: "setArrangementClipProperties",
      targetKind: "arrangement-clip",
    },
  ].map((definition) =>
    consolidatedOperationDescriptor({
      ...definition,
      toolName: "ableton_arrangement",
      editScope:
        definition.mutationTarget === "read" ? "none" : "affected-tracks",
      affectedTrackReferences:
        definition.mutationTarget === "read" ? undefined : rootTrackReferences,
    } as ConsolidatedOperationDefinition),
  ),
  ...[
    {
      operationId: "devices.inspect",
      action: "inspect",
      title: "Inspect track devices",
      inputSchema: devicesInspectParamsSchema,
      resultSchema: inspectDevicesResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect",
      protocolCommand: "devices.inspect",
      handlerBinding: "inspectDevices",
      targetKind: "track-devices",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_parameters",
      action: "inspect-parameters",
      title: "Inspect device parameters",
      inputSchema: devicesInspectParametersParamsSchema,
      resultSchema: inspectDeviceParametersResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_parameters",
      protocolCommand: "devices.inspect_parameters",
      handlerBinding: "inspectDeviceParameters",
      targetKind: "device",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_rack_chains",
      action: "inspect-rack-chains",
      title: "Inspect rack chains",
      inputSchema: devicesInspectRackChainsParamsSchema,
      resultSchema: inspectRackChainsResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_rack_chains",
      protocolCommand: "devices.inspect_rack_chains",
      handlerBinding: "inspectRackChains",
      targetKind: "rack",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_rack_chain_devices",
      action: "inspect-rack-chain-devices",
      title: "Inspect rack chain devices",
      inputSchema: devicesInspectRackChainDevicesParamsSchema,
      resultSchema: inspectRackChainDevicesResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_rack_chain_devices",
      protocolCommand: "devices.inspect_rack_chain_devices",
      handlerBinding: "inspectRackChainDevices",
      targetKind: "rack-chain",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_drum_rack_pads",
      action: "inspect-drum-rack-pads",
      title: "Inspect Drum Rack pads",
      inputSchema: devicesInspectDrumRackPadsParamsSchema,
      resultSchema: inspectDrumRackPadsResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_drum_rack_pads",
      protocolCommand: "devices.inspect_drum_rack_pads",
      handlerBinding: "inspectDrumRackPads",
      targetKind: "drum-rack",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_drum_pad_chains",
      action: "inspect-drum-pad-chains",
      title: "Inspect Drum Rack pad chains",
      inputSchema: devicesInspectDrumPadChainsParamsSchema,
      resultSchema: inspectDrumPadChainsResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_drum_pad_chains",
      protocolCommand: "devices.inspect_drum_pad_chains",
      handlerBinding: "inspectDrumPadChains",
      targetKind: "drum-pad",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_drum_pad_chain_devices",
      action: "inspect-drum-pad-chain-devices",
      title: "Inspect Drum Rack pad chain devices",
      inputSchema: devicesInspectDrumPadChainDevicesParamsSchema,
      resultSchema: inspectDrumPadChainDevicesResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_drum_pad_chain_devices",
      protocolCommand: "devices.inspect_drum_pad_chain_devices",
      handlerBinding: "inspectDrumPadChainDevices",
      targetKind: "drum-pad-chain",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.inspect_chain_mixer",
      action: "inspect-chain-mixer",
      title: "Inspect rack chain mixer",
      inputSchema: devicesInspectChainMixerParamsSchema,
      resultSchema: inspectChainMixerResultSchema,
      risk: "read",
      requiredCapability: "devices.inspect_chain_mixer",
      protocolCommand: "devices.inspect_chain_mixer",
      handlerBinding: "inspectChainMixer",
      targetKind: "chain",
      affectedTrackReferences: chainTrackReferences,
    },
    {
      operationId: "devices.find_position",
      action: "find-position",
      title: "Validate device destination",
      inputSchema: devicesFindPositionParamsSchema,
      resultSchema: findDevicePositionResultSchema,
      risk: "read",
      requiredCapability: "devices.find_position",
      protocolCommand: "devices.find_position",
      handlerBinding: "findDevicePosition",
      targetKind: (input: unknown) => {
        const parsed = devicesFindPositionParamsSchema.parse(input);
        return `${parsed.source.kind}-to-${parsed.destination.kind}`;
      },
      affectedTrackReferences: findDeviceTrackReferences,
    },
    {
      operationId: "devices.move",
      action: "move",
      title: "Move existing device",
      inputSchema: devicesMoveParamsSchema,
      resultSchema: moveDeviceResultSchema,
      risk: "reversible",
      requiredCapability: "devices.move",
      protocolCommand: "devices.move",
      handlerBinding: "moveDevice",
      targetKind: (input: unknown) => {
        const parsed = devicesMoveParamsSchema.parse(input);
        return `${parsed.source.kind}-to-${parsed.destination.kind}`;
      },
      affectedTrackReferences: moveDeviceTrackReferences,
    },
    {
      operationId: "devices.set_chain_properties",
      action: "set-chain-properties",
      title: "Rename or recolor rack chain",
      inputSchema: devicesSetChainPropertiesParamsSchema,
      resultSchema: setChainPropertiesResultSchema,
      risk: "reversible",
      requiredCapability: "devices.set_chain_properties",
      protocolCommand: "devices.set_chain_properties",
      handlerBinding: "setChainProperties",
      targetKind: "chain",
      affectedTrackReferences: chainTrackReferences,
    },
    {
      operationId: "devices.set_chain_mixer",
      action: "set-chain-mixer",
      title: "Set rack chain mixer",
      inputSchema: devicesSetChainMixerParamsSchema,
      resultSchema: setChainMixerResultSchema,
      risk: "reversible",
      requiredCapability: "devices.set_chain_mixer",
      protocolCommand: "devices.set_chain_mixer",
      handlerBinding: "setChainMixer",
      targetKind: "chain",
      affectedTrackReferences: chainTrackReferences,
    },
    {
      operationId: "devices.set_enabled",
      action: "set-enabled",
      title: "Enable or disable device",
      inputSchema: devicesSetEnabledParamsSchema,
      resultSchema: setDeviceEnabledResultSchema,
      risk: "reversible",
      requiredCapability: "devices.set_enabled",
      protocolCommand: "devices.set_enabled",
      handlerBinding: "setDeviceEnabled",
      targetKind: "device",
      affectedTrackReferences: rootTrackReferences,
    },
    {
      operationId: "devices.set_parameter",
      action: "set-parameter",
      title: "Set normalized device parameter",
      inputSchema: devicesSetParameterParamsSchema,
      resultSchema: setDeviceParameterResultSchema,
      risk: "reversible",
      requiredCapability: "devices.set_parameter",
      protocolCommand: "devices.set_parameter",
      handlerBinding: "setDeviceParameter",
      targetKind: "device-parameter",
      affectedTrackReferences: rootTrackReferences,
    },
  ].map((definition) =>
    consolidatedOperationDescriptor({
      ...definition,
      toolName: "ableton_devices",
      duration: "short",
      mutationTarget:
        definition.risk === "read"
          ? "read"
          : definition.action === "move"
            ? "tracks"
            : "track",
      editScope: definition.risk === "read" ? "none" : "affected-tracks",
      affectedTrackReferences:
        definition.affectedTrackReferences ??
        (definition.risk === "read" ? () => [] : rootTrackReferences),
    } as ConsolidatedOperationDefinition),
  ),
  ...[
    {
      operationId: "browser.inspect_roots",
      action: "roots",
      title: "Inspect Ableton browser roots",
      inputSchema: browserRootsParamsSchema,
      resultSchema: inspectBrowserRootsResultSchema,
      risk: "read",
      duration: "instant",
      mutationTarget: "read",
      editScope: "none",
      requiredCapability: "browser.inspect_roots",
      protocolCommand: "browser.inspect_roots",
      handlerBinding: "inspectBrowserRoots",
      targetKind: "browser",
    },
    {
      operationId: "browser.inspect_children",
      action: "children",
      title: "Inspect Ableton browser category",
      inputSchema: browserChildrenParamsSchema,
      resultSchema: inspectBrowserChildrenResultSchema,
      risk: "read",
      duration: "short",
      mutationTarget: "read",
      editScope: "none",
      requiredCapability: "browser.inspect_children",
      protocolCommand: "browser.inspect_children",
      handlerBinding: "inspectBrowserChildren",
      targetKind: "browser-item",
    },
    {
      operationId: "browser.search",
      action: "search",
      title: "Search Ableton browser",
      inputSchema: browserSearchParamsSchema,
      resultSchema: searchBrowserResultSchema,
      risk: "read",
      duration: "short",
      mutationTarget: "read",
      editScope: "none",
      requiredCapability: "browser.search",
      protocolCommand: "browser.search",
      handlerBinding: "searchBrowser",
      targetKind: "browser",
    },
    {
      operationId: "browser.search_external_plugins",
      action: "search-external-plugins",
      title: "Search installed external plug-ins",
      inputSchema: browserSearchExternalPluginsParamsSchema,
      resultSchema: searchBrowserResultSchema,
      risk: "read",
      duration: "short",
      mutationTarget: "read",
      editScope: "none",
      requiredCapability: "browser.search",
      protocolCommand: "browser.search",
      handlerBinding: "searchBrowser",
      targetKind: "browser-plugins",
    },
    {
      operationId: "browser.load_item",
      action: "load-item",
      title: "Load built-in Ableton browser item",
      inputSchema: browserLoadItemParamsSchema,
      resultSchema: loadBrowserItemResultSchema,
      risk: "reversible",
      duration: "long",
      mutationTarget: "track",
      editScope: "affected-tracks",
      requiredCapability: "browser.load_item",
      protocolCommand: "browser.load_item",
      handlerBinding: "loadBrowserItem",
      targetKind: "browser-item",
      affectedTrackReferences: rootTrackReferences,
    },
  ].map((definition) =>
    consolidatedOperationDescriptor({
      ...definition,
      toolName: "ableton_browser",
    } as ConsolidatedOperationDefinition),
  ),
] as const;

export const abletonOperationDescriptors = [
  ...consolidatedOperationDescriptors,
  ...domainOperationDescriptors(scenesOperationParamsSchema.options, {
    domain: "scenes",
    toolName: "ableton_scenes",
    title: "Scene operation",
    resultSchemas: scenesOperationResultSchema.options,
    handlerBinding: "executeScenesOperation",
    actions: [
      "list",
      "get",
      "create",
      "duplicate",
      "rename",
      "set-color",
      "set-tempo-time-signature",
      "fire",
      "delete",
    ],
    readActions: new Set(["list", "get"]),
    destructiveActions: new Set(["delete"]),
  }),
  ...domainOperationDescriptors(tracksOperationParamsSchema.options, {
    domain: "tracks",
    toolName: "ableton_tracks",
    title: "Track operation",
    resultSchemas: tracksOperationResultSchema.options,
    handlerBinding: "executeTracksOperation",
    actions: [
      "list",
      "get",
      "create-return",
      "duplicate",
      "set-color",
      "set-monitoring",
      "set-fold",
      "stop-clips",
      "back-to-arrangement",
      "delete",
    ],
    readActions: new Set(["list", "get"]),
    destructiveActions: new Set(["delete"]),
    trackActions: new Set([
      "duplicate",
      "set-color",
      "set-monitoring",
      "set-fold",
      "stop-clips",
      "back-to-arrangement",
      "delete",
    ]),
  }),
  ...domainOperationDescriptors(mixerRoutingOperationParamsSchema.options, {
    domain: "mixer_routing",
    toolName: "ableton_mixer_routing",
    title: "Mixer and routing operation",
    resultSchemas: mixerRoutingOperationResultSchema.options,
    handlerBinding: "executeMixerRoutingOperation",
    actions: [
      "inspect",
      "meters",
      "set-volume",
      "set-pan",
      "set-send",
      "set-activator",
      "set-crossfade-assignment",
      "set-master-crossfader",
      "set-cue-volume",
      "routing-options",
      "set-routing",
    ],
    readActions: new Set(["inspect", "meters", "routing-options"]),
    trackActions: new Set([
      "set-volume",
      "set-pan",
      "set-send",
      "set-activator",
      "set-crossfade-assignment",
      "set-master-crossfader",
      "set-cue-volume",
      "set-routing",
    ]),
  }),
  ...domainOperationDescriptors(transportOperationParamsSchema.options, {
    domain: "transport",
    toolName: "ableton_transport",
    title: "Transport operation",
    resultSchemas: transportOperationResultSchema.options,
    handlerBinding: "executeTransportOperation",
    actions: [
      "get",
      "seek",
      "jump",
      "set-time-signature",
      "set-metronome",
      "set-launch-quantization",
      "set-record-quantization",
      "set-link",
      "rename-cue",
      "jump-to-cue",
      "back-to-arrangement",
    ],
    readActions: new Set(["get"]),
  }),
  ...domainOperationDescriptors(midiNotesOperationParamsSchema.options, {
    domain: "midi_notes",
    toolName: "ableton_midi_notes",
    title: "MIDI note operation",
    resultSchemas: midiNotesOperationResultSchema.options,
    handlerBinding: "executeMidiNotesOperation",
    actions: ["query", "add", "update", "remove", "duplicate", "quantize"],
    readActions: new Set(["query"]),
    destructiveActions: new Set(["remove"]),
    trackActions: new Set(["add", "update", "remove", "duplicate", "quantize"]),
  }),
  ...domainOperationDescriptors(audioClipsOperationParamsSchema.options, {
    domain: "audio_clips",
    toolName: "ableton_audio_clips",
    title: "Audio clip operation",
    resultSchemas: audioClipsOperationResultSchema.options,
    handlerBinding: "executeAudioClipsOperation",
    actions: [
      "inspect",
      "set-gain",
      "set-pitch",
      "set-warp",
      "set-warp-mode",
      "set-markers",
      "set-ram-mode",
      "warp-markers",
    ],
    readActions: new Set(["inspect", "warp-markers"]),
    trackActions: new Set([
      "set-gain",
      "set-pitch",
      "set-warp",
      "set-warp-mode",
      "set-markers",
      "set-ram-mode",
    ]),
  }),
  ...domainOperationDescriptors(recordingOperationParamsSchema.options, {
    domain: "recording",
    toolName: "ableton_recording",
    title: "Recording and capture operation",
    resultSchemas: recordingOperationResultSchema.options,
    handlerBinding: "executeRecordingOperation",
    actions: [
      "inspect",
      "set-arrangement-record",
      "set-session-record",
      "set-overdub",
      "set-session-automation-record",
      "set-punch",
      "capture-midi",
      "record-session-slot",
    ],
    readActions: new Set(["inspect"]),
    broadActions: new Set([
      "set-arrangement-record",
      "set-session-record",
      "set-overdub",
      "set-session-automation-record",
      "set-punch",
      "capture-midi",
    ]),
    trackActions: new Set(["record-session-slot"]),
    longActions: new Set(["record-session-slot"]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(grooveOperationParamsSchema.options, {
    domain: "grooves",
    toolName: "ableton_grooves",
    title: "Groove operation",
    resultSchemas: grooveOperationResultSchema.options,
    handlerBinding: "executeGrooveOperation",
    actions: [
      "list",
      "get",
      "inspect-clip",
      "set-clip-groove",
      "clear-clip-groove",
      "set-properties",
      "set-global-amount",
    ],
    readActions: new Set(["list", "get", "inspect-clip"]),
    trackActions: new Set(["set-clip-groove", "clear-clip-groove"]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(selectionViewOperationParamsSchema.options, {
    domain: "selection_view",
    toolName: "ableton_selection_view",
    title: "Selection and view operation",
    resultSchemas: selectionViewOperationResultSchema.options,
    handlerBinding: "executeSelectionViewOperation",
    actions: [
      "inspect-selection",
      "inspect-view",
      "select-track",
      "select-scene",
      "select-slot",
      "select-clip",
      "select-device",
      "select-chain",
      "set-view",
      "set-follow",
      "set-draw-mode",
      "set-track-fold",
      "set-device-collapsed",
    ],
    readActions: new Set(["inspect-selection", "inspect-view"]),
    trackActions: new Set([
      "select-track",
      "select-slot",
      "select-clip",
      "select-device",
      "select-chain",
      "set-track-fold",
      "set-device-collapsed",
    ]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(liveHistoryOperationParamsSchema.options, {
    domain: "live_history",
    toolName: "ableton_live_history",
    title: "Global Live history operation",
    resultSchemas: liveHistoryOperationResultSchema.options,
    handlerBinding: "executeLiveHistoryOperation",
    actions: ["inspect", "undo", "redo"],
    readActions: new Set(["inspect"]),
    broadActions: new Set(["undo", "redo"]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(browserAdapterOperationParamsSchema.options, {
    domain: "browser_adapters",
    toolName: "ableton_browser_adapters",
    title: "Tested private Browser adapter",
    resultSchemas: browserAdapterOperationResultSchema.options,
    handlerBinding: "executeBrowserAdapterOperation",
    actions: [
      "preview",
      "stop-preview",
      "hot-swap",
      "insert-adjacent",
      "load-empty-drum-pad",
    ],
    readActions: new Set(),
    trackActions: new Set([
      "hot-swap",
      "insert-adjacent",
      "load-empty-drum-pad",
    ]),
    longActions: new Set([
      "hot-swap",
      "insert-adjacent",
      "load-empty-drum-pad",
    ]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(clipAutomationOperationParamsSchema.options, {
    domain: "clip_automation",
    toolName: "ableton_clip_automation",
    title: "Session clip automation operation",
    resultSchemas: clipAutomationOperationResultSchema.options,
    handlerBinding: "executeClipAutomationOperation",
    actions: [
      "list-envelopes",
      "sample",
      "insert-step",
      "clear-envelope",
      "clear-all",
    ],
    readActions: new Set(["list-envelopes", "sample"]),
    destructiveActions: new Set(["clear-envelope", "clear-all"]),
    trackActions: new Set(["insert-step", "clear-envelope", "clear-all"]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(warpMarkerOperationParamsSchema.options, {
    domain: "warp_markers",
    toolName: "ableton_warp_markers",
    title: "Warp marker operation",
    resultSchemas: warpMarkerOperationResultSchema.options,
    handlerBinding: "executeWarpMarkerOperation",
    actions: ["inspect", "add", "move", "remove"],
    readActions: new Set(["inspect"]),
    destructiveActions: new Set(["remove"]),
    trackActions: new Set(["add", "move", "remove"]),
    granularProtocol: true,
  }),
  ...domainOperationDescriptors(
    specializedDeviceOperationParamsSchema.options,
    {
      domain: "special_devices",
      toolName: "ableton_special_devices",
      title: "Live 11 specialized device operation",
      resultSchemas: specializedDeviceOperationResultSchema.options,
      handlerBinding: "executeSpecializedDeviceOperation",
      actions: [
        "inspect-simpler",
        "set-simpler-markers",
        "set-simpler-slices",
        "inspect-looper",
        "control-looper",
        "export-looper",
        "inspect-wavetable",
        "set-wavetable-modulation",
      ],
      readActions: new Set([
        "inspect-simpler",
        "inspect-looper",
        "inspect-wavetable",
      ]),
      destructiveActions: new Set(["control-looper"]),
      trackActions: new Set([
        "set-simpler-markers",
        "set-simpler-slices",
        "control-looper",
        "export-looper",
        "set-wavetable-modulation",
      ]),
      longActions: new Set(["export-looper"]),
      granularProtocol: true,
    },
  ),
  ...domainOperationDescriptors(workflowJobOperationParamsSchema.options, {
    domain: "workflow_jobs",
    toolName: "ableton_workflow_jobs",
    title: "Workflow job operation",
    resultSchemas: workflowJobOperationResultSchema.options,
    handlerBinding: "executeWorkflowJobOperation",
    actions: ["get", "list", "cancel"],
    readActions: new Set(["get", "list"]),
    granularProtocol: true,
  }),
] as const satisfies readonly AbletonOperationDescriptor[];

export const abletonToolOperationPatterns = abletonOperationDescriptors.map(
  ({ operationId, toolName }) => ({ operationId, toolName }),
);

const operationsByToolName = new Map<string, AbletonOperationDescriptor[]>();
for (const descriptor of abletonOperationDescriptors) {
  const descriptors = operationsByToolName.get(descriptor.toolName) ?? [];
  descriptors.push(descriptor);
  operationsByToolName.set(descriptor.toolName, descriptors);
}

export function resolveAbletonOperation(
  toolName: string,
  input: unknown,
): ResolvedAbletonOperation | undefined {
  const descriptors = operationsByToolName.get(toolName);
  if (descriptors === undefined) return undefined;
  const match = descriptors
    .map((descriptor) => ({
      descriptor,
      parsed: descriptor.inputSchema.safeParse(input),
    }))
    .find((candidate) => candidate.parsed.success);
  if (match === undefined) {
    descriptors[0]?.inputSchema.parse(input);
    return undefined;
  }
  const descriptor = match.descriptor;
  const parsed = match.parsed.data;
  return {
    descriptor,
    metadata: {
      name: descriptor.toolName,
      title: descriptor.title,
      risk: descriptor.risk,
      duration: descriptor.duration,
      mutationTarget: descriptor.mutationTarget,
      requiredCapability: descriptor.requiredCapability,
      operationId: descriptor.operationId,
      action: descriptor.action,
      editScope: descriptor.editScope,
      lifecycleIdentity: descriptor.lifecycleIdentity(parsed),
    },
    input: parsed,
    affectedTrackReferences: descriptor.affectedTrackReferences(parsed),
    lifecycleIdentity: descriptor.lifecycleIdentity(parsed),
  };
}

export function getAbletonOperationDescriptor(
  toolName: string,
): AbletonOperationDescriptor | undefined {
  return operationsByToolName.get(toolName)?.[0];
}

export function getAbletonOperationDescriptorForAction(
  toolName: string,
  action: string,
): AbletonOperationDescriptor | undefined {
  return operationsByToolName
    .get(toolName)
    ?.find((descriptor) => descriptor.action === action);
}
