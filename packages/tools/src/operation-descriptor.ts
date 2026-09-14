import {
  chainLocationTargetSchema,
  findDevicePositionParamsSchema,
  findDevicePositionResultSchema,
  inspectChainMixerParamsSchema,
  inspectChainMixerResultSchema,
  moveDeviceParamsSchema,
  moveDeviceResultSchema,
  setChainMixerParamsSchema,
  setChainMixerResultSchema,
  setChainPropertiesParamsSchema,
  setChainPropertiesResultSchema,
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
    | "setChainMixer";
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
] as const satisfies readonly AbletonOperationDescriptor[];

const operationByToolName = new Map<string, AbletonOperationDescriptor>(
  abletonOperationDescriptors.map((descriptor) => [
    descriptor.toolName,
    descriptor,
  ]),
);

export function resolveAbletonOperation(
  toolName: string,
  input: unknown,
): ResolvedAbletonOperation | undefined {
  const descriptor = operationByToolName.get(toolName);
  if (descriptor === undefined) return undefined;
  const parsed = descriptor.inputSchema.parse(input);
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
  return operationByToolName.get(toolName);
}
