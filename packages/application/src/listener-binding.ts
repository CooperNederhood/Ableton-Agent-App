import { z } from "zod";
import {
  inspectListeningContextResultSchema,
  listeningCanonicalDevicePathSchema,
  listeningCanonicalTrackPathSchema,
  listeningPathSelectorSchema,
  listenerNativeStatusSchema,
  listenerNativeStatusV2Schema,
  type ListenerNativeStatus,
  type ListenerNativeStatusV2,
  type InspectListeningContextResult,
  type ListeningPathAttestation,
} from "@ableton-agent/protocol";

export type ListenerBridgeTarget =
  InspectListeningContextResult["listeners"][number]["binding"];

const id = z.string().min(1).max(128);
const nativeStatusSchema = z.union([
  listenerNativeStatusSchema,
  listenerNativeStatusV2Schema,
]);
const rawConnectionSchema = z
  .object({
    connectionId: id,
    producerId: id,
    instanceId: id,
    connectionEpoch: id,
    canonicalPath: listeningPathSelectorSchema.shape.canonicalPath,
    canonicalTrackPath: listeningCanonicalTrackPathSchema,
    nativeStatus: nativeStatusSchema,
    signalKind: z.enum(["audio", "midi"]),
    schemaVersion: id,
    status: z.enum(["connected", "stale", "disconnected"]),
  })
  .strict();
const connectionSchema = rawConnectionSchema.refine(
  (value) =>
    (value.nativeStatus.version === 2) ===
    (value.schemaVersion === "audio-observation/v2"),
);

/** Canonical path comes from authenticated producer metadata, never its ID hash. */
export type ConnectedListenerBinding = z.infer<typeof connectionSchema>;
export type ListenerBindingSelection = Pick<
  ConnectedListenerBinding,
  | "connectionId"
  | "producerId"
  | "instanceId"
  | "connectionEpoch"
  | "canonicalPath"
> & { readonly expectedTarget?: ListenerBridgeTarget };

export type ListenerBindingFailure =
  | "invalid-input"
  | "missing-canonical-path"
  | "missing-native-status"
  | "unsupported-placement"
  | "unavailable"
  | "stale-connection"
  | "collision"
  | "non-audio-producer"
  | "stale-inspection"
  | "unattested-path"
  | "ambiguous"
  | "non-audio-effect"
  | "inactive"
  | "stale-target";
/** Structural view of authenticated, current ListenerService descriptors. */
export interface ListenerBindingDescriptor {
  readonly connectionId: string;
  readonly producer: {
    readonly producerId: string;
    readonly instanceId: string;
    readonly signalKind: "audio" | "midi";
    readonly schemaVersion: string;
    readonly capabilities?: Readonly<Record<string, unknown>>;
  };
  readonly registration: {
    readonly connectionEpoch: string;
    readonly deviceCanonicalPath?: string;
    readonly trackCanonicalPath?: string;
    readonly nativeStatus?: ListenerNativeStatus | ListenerNativeStatusV2;
  };
  readonly status?: "connected" | "stale" | "disconnected";
}
export type ListenerBindingCandidateResult =
  | { readonly ok: true; readonly connection: ConnectedListenerBinding }
  | { readonly ok: false; readonly reason: ListenerBindingFailure };

const descriptorHeaderSchema = z
  .object({
    connectionId: id,
    producer: z
      .object({
        producerId: id,
        instanceId: id,
        signalKind: z.enum(["audio", "midi"]),
        schemaVersion: id,
      })
      .strip(),
    registration: z
      .object({
        connectionEpoch: id,
        deviceCanonicalPath: listeningCanonicalDevicePathSchema.optional(),
        trackCanonicalPath: listeningCanonicalTrackPathSchema.optional(),
        nativeStatus: nativeStatusSchema.optional(),
      })
      .strip(),
    status: z.enum(["connected", "stale", "disconnected"]).optional(),
  })
  .strip();

/** Read the actual producer.hello.listener registration; capability aliases are ignored. */
export function readConnectedListenerBinding(
  descriptor: ListenerBindingDescriptor,
): ListenerBindingCandidateResult {
  const header = descriptorHeaderSchema.safeParse(descriptor);
  if (!header.success) return { ok: false, reason: "invalid-input" };
  if (
    !Object.hasOwn(descriptor.registration, "deviceCanonicalPath") ||
    !Object.hasOwn(descriptor.registration, "trackCanonicalPath") ||
    header.data.registration.deviceCanonicalPath === undefined ||
    header.data.registration.trackCanonicalPath === undefined
  ) {
    return { ok: false, reason: "missing-canonical-path" };
  }
  if (
    !Object.hasOwn(descriptor.registration, "nativeStatus") ||
    header.data.registration.nativeStatus === undefined
  ) {
    return { ok: false, reason: "missing-native-status" };
  }
  const connection = connectionSchema.safeParse({
    connectionId: header.data.connectionId,
    producerId: header.data.producer.producerId,
    instanceId: header.data.producer.instanceId,
    connectionEpoch: header.data.registration.connectionEpoch,
    signalKind: header.data.producer.signalKind,
    schemaVersion: header.data.producer.schemaVersion,
    status: header.data.status ?? "connected",
    canonicalPath: header.data.registration.deviceCanonicalPath,
    canonicalTrackPath: header.data.registration.trackCanonicalPath,
    nativeStatus: header.data.registration.nativeStatus,
  });
  if (!connection.success) return { ok: false, reason: "invalid-input" };
  if (
    connection.data.canonicalPath.split(" devices ")[0] !==
    connection.data.canonicalTrackPath
  ) {
    return { ok: false, reason: "unattested-path" };
  }
  return { ok: true, connection: connection.data };
}
export type ListenerBindingResolution =
  | {
      readonly ok: true;
      readonly target: ListenerBridgeTarget;
      readonly connection: ConnectedListenerBinding;
      readonly attestation: ListeningPathAttestation;
      readonly queryId: string;
      readonly basis: "canonical-path-join";
    }
  | { readonly ok: false; readonly reason: ListenerBindingFailure };

const selectionSchema = rawConnectionSchema
  .pick({
    connectionId: true,
    producerId: true,
    instanceId: true,
    connectionEpoch: true,
    canonicalPath: true,
  })
  .extend({
    expectedTarget:
      inspectListeningContextResultSchema.shape.listeners.element.shape.binding.optional(),
  })
  .strip();

function sameTargetIdentity(
  a: ListenerBridgeTarget,
  b: ListenerBridgeTarget,
): boolean {
  return (
    a.expectedDeviceReference === b.expectedDeviceReference &&
    a.track.expectedReference === b.track.expectedReference &&
    a.track.kind === b.track.kind &&
    a.track.index === b.track.index &&
    a.deviceIndex === b.deviceIndex
  );
}

/**
 * Pure per-query join of a connected producer with independent LOM placement.
 * Proves a path's current bridge binding, not numeric-ID equivalence, producer
 * firmware authenticity, audio timing, or durable identity. Re-query after moves.
 */
export function resolveListenerBinding(input: {
  readonly selected: ListenerBindingSelection;
  readonly connected: readonly (
    ConnectedListenerBinding | ListenerBindingDescriptor
  )[];
  readonly inspection: InspectListeningContextResult;
  /** Fresh app-owned nonce echoed by this inspection, not a reused pass ID. */
  readonly queryId: string;
}): ListenerBindingResolution {
  const selected = selectionSchema.safeParse(input.selected);
  if (input.connected.length > 128)
    return { ok: false, reason: "invalid-input" };
  const candidates: ConnectedListenerBinding[] = [];
  for (const item of input.connected) {
    if ("producer" in item) {
      const candidate = readConnectedListenerBinding(item);
      if (!candidate.ok) return candidate;
      candidates.push(candidate.connection);
    } else candidates.push(item);
  }
  const connected = z.array(connectionSchema).max(128).safeParse(candidates);
  const queryId = z.string().uuid().safeParse(input.queryId);
  const inspection = inspectListeningContextResultSchema.safeParse(
    input.inspection,
  );
  if (
    !selected.success ||
    !connected.success ||
    !queryId.success ||
    !inspection.success
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  if (
    !listeningCanonicalDevicePathSchema.safeParse(selected.data.canonicalPath)
      .success
  ) {
    return { ok: false, reason: "unsupported-placement" };
  }
  const matches = connected.data.filter(
    (item) => item.connectionId === selected.data.connectionId,
  );
  if (matches.length === 0) return { ok: false, reason: "unavailable" };
  if (matches.length !== 1) return { ok: false, reason: "ambiguous" };
  const connection = matches[0]!;
  if (connection.status !== "connected")
    return { ok: false, reason: "unavailable" };
  if (
    connection.instanceId !== selected.data.instanceId ||
    connection.connectionEpoch !== selected.data.connectionEpoch ||
    connection.producerId !== selected.data.producerId ||
    connection.canonicalPath !== selected.data.canonicalPath
  ) {
    return { ok: false, reason: "stale-connection" };
  }
  if (
    connection.signalKind !== "audio" ||
    !["audio-observation/v1", "audio-observation/v2"].includes(
      connection.schemaVersion,
    )
  ) {
    return { ok: false, reason: "non-audio-producer" };
  }
  if (
    connected.data.some(
      (item) =>
        item !== connection &&
        item.status === "connected" &&
        (item.canonicalPath === connection.canonicalPath ||
          item.instanceId === connection.instanceId ||
          item.producerId === connection.producerId),
    )
  ) {
    return { ok: false, reason: "collision" };
  }
  if (inspection.data.bindingQueryId !== queryId.data) {
    return { ok: false, reason: "stale-inspection" };
  }
  const attestations = inspection.data.listeners.filter(
    (item) => item.canonicalPath === connection.canonicalPath,
  );
  if (attestations.length > 1) return { ok: false, reason: "ambiguous" };
  const listener = attestations[0];
  if (listener?.pathAttestation === undefined)
    return { ok: false, reason: "unattested-path" };
  if (
    connection.canonicalTrackPath !==
    listener.pathAttestation.canonicalTrackPath
  ) {
    return { ok: false, reason: "unattested-path" };
  }
  if (
    inspection.data.listeners.some(
      (item) =>
        item !== listener &&
        (item.binding.expectedDeviceReference ===
          listener.binding.expectedDeviceReference ||
          (item.binding.track.expectedReference ===
            listener.binding.track.expectedReference &&
            item.pathAttestation?.canonicalTrackPath !==
              listener.pathAttestation?.canonicalTrackPath)),
    )
  ) {
    return { ok: false, reason: "ambiguous" };
  }
  if (listener.binding.expectedClassName !== "MxDeviceAudioEffect") {
    return { ok: false, reason: "non-audio-effect" };
  }
  if (listener.enabled !== true) return { ok: false, reason: "inactive" };
  if (
    selected.data.expectedTarget !== undefined &&
    !sameTargetIdentity(selected.data.expectedTarget, listener.binding)
  ) {
    return { ok: false, reason: "stale-target" };
  }
  return {
    ok: true,
    target: listener.binding,
    connection,
    attestation: listener.pathAttestation,
    queryId: queryId.data,
    basis: "canonical-path-join",
  };
}
