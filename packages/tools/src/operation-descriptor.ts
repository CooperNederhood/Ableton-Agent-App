import {
  audioClipsOperationParamsSchema,
  audioClipsOperationResultSchema,
  browserAdapterOperationParamsSchema,
  browserAdapterOperationResultSchema,
  chainLocationTargetSchema,
  findDevicePositionParamsSchema,
  findDevicePositionResultSchema,
  clipAutomationOperationParamsSchema,
  clipAutomationOperationResultSchema,
  grooveOperationParamsSchema,
  grooveOperationResultSchema,
  liveHistoryOperationParamsSchema,
  liveHistoryOperationResultSchema,
  inspectChainMixerParamsSchema,
  inspectChainMixerResultSchema,
  midiNotesOperationParamsSchema,
  midiNotesOperationResultSchema,
  mixerRoutingOperationParamsSchema,
  mixerRoutingOperationResultSchema,
  moveDeviceParamsSchema,
  moveDeviceResultSchema,
  scenesOperationParamsSchema,
  scenesOperationResultSchema,
  recordingOperationParamsSchema,
  recordingOperationResultSchema,
  selectionViewOperationParamsSchema,
  selectionViewOperationResultSchema,
  specializedDeviceOperationParamsSchema,
  specializedDeviceOperationResultSchema,
  setChainMixerParamsSchema,
  setChainMixerResultSchema,
  setChainPropertiesParamsSchema,
  setChainPropertiesResultSchema,
  tracksOperationParamsSchema,
  tracksOperationResultSchema,
  transportOperationParamsSchema,
  transportOperationResultSchema,
  warpMarkerOperationParamsSchema,
  warpMarkerOperationResultSchema,
  workflowJobOperationParamsSchema,
  workflowJobOperationResultSchema,
  type CommandName,
  type ChainLocationTarget,
  type DeviceDestinationTarget,
  type DeviceLocationTarget,
} from "@ableton-agent/protocol";
import { z, type ZodType } from "zod";

import type { AbletonToolMetadata, ToolDuration, ToolRisk } from "./index.js";
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
    | "executeWorkflowJobOperation";
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

function deviceTrackReferences(input: unknown): readonly string[] {
  const parsed = findDevicePositionParamsSchema.parse(input);
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

function sourceIdentity(source: DeviceLocationTarget): string[] {
  switch (source.kind) {
    case "track-device":
      return [source.track.expectedReference, source.device.expectedReference];
    case "rack-chain-device":
      return [
        source.track.expectedReference,
        source.rack.expectedReference,
        source.chain.expectedReference,
        source.device.expectedReference,
      ];
    case "drum-pad-chain-device":
      return [
        source.track.expectedReference,
        source.rack.expectedReference,
        source.pad.expectedReference,
        source.chain.expectedReference,
        source.device.expectedReference,
      ];
  }
}

function destinationIdentity(destination: DeviceDestinationTarget): string[] {
  switch (destination.kind) {
    case "track":
      return [destination.track.expectedReference];
    case "rack-chain":
      return [
        destination.track.expectedReference,
        destination.rack.expectedReference,
        destination.chain.expectedReference,
      ];
    case "drum-pad-chain":
      return [
        destination.track.expectedReference,
        destination.rack.expectedReference,
        destination.pad.expectedReference,
        destination.chain.expectedReference,
      ];
  }
}

function chainIdentity(target: ChainLocationTarget): string[] {
  switch (target.kind) {
    case "rack-chain":
      return [
        target.track.expectedReference,
        target.rack.expectedReference,
        target.chain.expectedReference,
      ];
    case "drum-pad-chain":
      return [
        target.track.expectedReference,
        target.rack.expectedReference,
        target.pad.expectedReference,
        target.chain.expectedReference,
      ];
  }
}

export const abletonOperationDescriptors = [
  {
    operationId: "devices.inspect_chain_mixer",
    action: "inspect-chain-mixer",
    toolName: "ableton_rack_chain_mixer_inspect",
    title: "Inspect rack chain mixer",
    inputSchema: inspectChainMixerParamsSchema,
    resultSchema: inspectChainMixerResultSchema,
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    editScope: "none",
    requiredCapability: "devices.inspect_chain_mixer",
    protocolCommand: "devices.inspect_chain_mixer",
    lifecycleEvents: operationLifecycleEvents,
    handlerBinding: "inspectChainMixer",
    affectedTrackReferences: chainTrackReferences,
    lifecycleIdentity: (input: unknown) => {
      const parsed = inspectChainMixerParamsSchema.parse(input);
      return {
        domain: "devices",
        action: "inspect-chain-mixer",
        targetKind: parsed.target.kind,
        targetReferences: chainIdentity(parsed.target),
      };
    },
  },
  {
    operationId: "devices.find_position",
    action: "find-position",
    toolName: "ableton_device_find_position",
    title: "Validate device destination",
    inputSchema: findDevicePositionParamsSchema,
    resultSchema: findDevicePositionResultSchema,
    risk: "read",
    duration: "short",
    mutationTarget: "read",
    editScope: "none",
    requiredCapability: "devices.find_position",
    protocolCommand: "devices.find_position",
    lifecycleEvents: operationLifecycleEvents,
    handlerBinding: "findDevicePosition",
    affectedTrackReferences: deviceTrackReferences,
    lifecycleIdentity: (input: unknown) => {
      const parsed = findDevicePositionParamsSchema.parse(input);
      return {
        domain: "devices",
        action: "find-position",
        targetKind: `${parsed.source.kind}-to-${parsed.destination.kind}`,
        targetReferences: [
          ...sourceIdentity(parsed.source),
          ...destinationIdentity(parsed.destination),
        ],
      };
    },
  },
  {
    operationId: "devices.move",
    action: "move",
    toolName: "ableton_device_move",
    title: "Move existing device",
    inputSchema: moveDeviceParamsSchema,
    resultSchema: moveDeviceResultSchema,
    risk: "reversible",
    duration: "short",
    mutationTarget: "tracks",
    editScope: "affected-tracks",
    requiredCapability: "devices.move",
    protocolCommand: "devices.move",
    lifecycleEvents: operationLifecycleEvents,
    handlerBinding: "moveDevice",
    affectedTrackReferences: deviceTrackReferences,
    lifecycleIdentity: (input: unknown) => {
      const parsed = moveDeviceParamsSchema.parse(input);
      return {
        domain: "devices",
        action: "move",
        targetKind: `${parsed.source.kind}-to-${parsed.destination.kind}`,
        targetReferences: [
          ...sourceIdentity(parsed.source),
          ...destinationIdentity(parsed.destination),
        ],
      };
    },
  },
  {
    operationId: "devices.set_chain_properties",
    action: "set-chain-properties",
    toolName: "ableton_rack_chain_set_properties",
    title: "Rename or recolor rack chain",
    inputSchema: setChainPropertiesParamsSchema,
    resultSchema: setChainPropertiesResultSchema,
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    editScope: "affected-tracks",
    requiredCapability: "devices.set_chain_properties",
    protocolCommand: "devices.set_chain_properties",
    lifecycleEvents: operationLifecycleEvents,
    handlerBinding: "setChainProperties",
    affectedTrackReferences: chainTrackReferences,
    lifecycleIdentity: (input: unknown) => {
      const parsed = setChainPropertiesParamsSchema.parse(input);
      return {
        domain: "devices",
        action: "set-chain-properties",
        targetKind: parsed.target.kind,
        targetReferences: chainIdentity(parsed.target),
      };
    },
  },
  {
    operationId: "devices.set_chain_mixer",
    action: "set-chain-mixer",
    toolName: "ableton_rack_chain_set_mixer",
    title: "Set rack chain mixer",
    inputSchema: setChainMixerParamsSchema,
    resultSchema: setChainMixerResultSchema,
    risk: "reversible",
    duration: "short",
    mutationTarget: "track",
    editScope: "affected-tracks",
    requiredCapability: "devices.set_chain_mixer",
    protocolCommand: "devices.set_chain_mixer",
    lifecycleEvents: operationLifecycleEvents,
    handlerBinding: "setChainMixer",
    affectedTrackReferences: chainTrackReferences,
    lifecycleIdentity: (input: unknown) => {
      const parsed = setChainMixerParamsSchema.parse(input);
      return {
        domain: "devices",
        action: "set-chain-mixer",
        targetKind: parsed.target.kind,
        targetReferences: chainIdentity(parsed.target),
      };
    },
  },
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
