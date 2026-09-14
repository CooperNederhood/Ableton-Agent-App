import {
  audioClipsOperationParamsSchema,
  audioClipsOperationResultSchema,
  chainLocationTargetSchema,
  findDevicePositionParamsSchema,
  findDevicePositionResultSchema,
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
  setChainMixerParamsSchema,
  setChainMixerResultSchema,
  setChainPropertiesParamsSchema,
  setChainPropertiesResultSchema,
  tracksOperationParamsSchema,
  tracksOperationResultSchema,
  transportOperationParamsSchema,
  transportOperationResultSchema,
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
    | "executeAudioClipsOperation";
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
  readonly handlerBinding: AbletonOperationDescriptor["handlerBinding"];
}

function coreOperationDescriptor(
  definition: CoreOperationDefinition,
): AbletonOperationDescriptor {
  return {
    ...definition,
    duration: "short",
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
    readonly trackActions?: ReadonlySet<string>;
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
  return options.map((inputSchema, index) => {
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
        : configuration.destructiveActions?.has(action)
          ? "destructive"
          : "reversible",
      mutationTarget: isRead ? "read" : isTrackMutation ? "tracks" : "session",
      editScope: isRead
        ? "none"
        : isTrackMutation
          ? "affected-tracks"
          : "session",
      requiredCapability: operationCapability(configuration.domain, action),
      handlerBinding: configuration.handlerBinding,
    });
  });
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
] as const satisfies readonly AbletonOperationDescriptor[];

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
