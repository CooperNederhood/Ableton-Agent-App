import { z } from "zod";
import {
  audioObservationSchema,
  listenerNativeStatusSchema,
  listeningCanonicalDevicePathSchema,
  listeningCanonicalTrackPathSchema,
  nativeArmProofSchema,
  nativeCaptureProofSchema,
  nativeLaunchProofSchema,
  nativeListenerLifecycleSchema,
} from "@ableton-agent/protocol";
import type { OutputProducer } from "./contracts.js";

export const LISTENER_VERSION = 1 as const;
export const LISTENER_CAPABILITY = "audio-listener/v1" as const;
const id = z.string().min(1).max(128);
const safeSequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function listenerPathsHaveSameOwner(value: {
  readonly deviceCanonicalPath?: string | undefined;
  readonly trackCanonicalPath?: string | undefined;
}): boolean {
  return (
    value.deviceCanonicalPath === undefined ||
    value.trackCanonicalPath === undefined ||
    value.deviceCanonicalPath.split(" devices ")[0] === value.trackCanonicalPath
  );
}

export const listenerRegistrationSchema = z
  .object({
    version: z.literal(LISTENER_VERSION),
    connectionEpoch: id,
    capabilities: z.tuple([z.literal(LISTENER_CAPABILITY)]),
    sampleRate: z.number().int().min(8000).max(384000),
    algorithmVersion: id,
    deviceCanonicalPath: listeningCanonicalDevicePathSchema.optional(),
    trackCanonicalPath: listeningCanonicalTrackPathSchema.optional(),
    nativeStatus: listenerNativeStatusSchema.optional(),
  })
  .strict()
  .refine(listenerPathsHaveSameOwner, {
    message: "Reported listener paths must have the same owning track",
  });

export const listenerConfigSchema = z
  .object({
    durationMs: z.number().int().min(1).max(120000),
    maxWindows: z.number().int().min(1).max(512),
    source: z
      .object({
        mode: z.enum(["session", "arrangement"]),
        startBeat: z.number().finite().nonnegative(),
        endBeat: z.number().finite().nonnegative(),
      })
      .strict()
      .refine((value) => value.endBeat > value.startBeat, "Invalid beat range"),
  })
  .strict();

const context = {
  jobId: id,
  passId: id,
  traceId: id,
  correlationId: id,
  causationId: id,
};
export const listenerControlInputSchema = z
  .object({
    ...context,
    action: z.enum(["prepare", "arm", "cancel"]),
    config: listenerConfigSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.action !== "prepare" || value.config !== undefined,
    "Prepare requires capture bounds",
  );
export type ListenerControlInput = z.infer<typeof listenerControlInputSchema>;

const wire = {
  ...context,
  protocolVersion: z.literal(1),
  listenerVersion: z.literal(LISTENER_VERSION),
  requestId: id,
  connectionEpoch: id,
};
export const listenerControlSchema = z
  .object({
    ...wire,
    type: z.literal("listener.control"),
    action: z.enum(["prepare", "arm", "cancel"]),
    config: listenerConfigSchema.optional(),
  })
  .strict();
export type ListenerControl = z.infer<typeof listenerControlSchema>;

export const listenerReplySchema = z
  .object({
    ...wire,
    type: z.literal("listener.reply"),
    sequence: safeSequence,
    status: z.enum(["ready", "armed", "cancelled", "failed"]),
    reason: z.string().min(1).max(512).optional(),
    nativeArm: nativeArmProofSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.nativeArm === undefined || value.status === "armed",
    "Native arm evidence belongs only to an armed reply",
  );
export type ListenerReply = z.infer<typeof listenerReplySchema>;

export const listenerResultSchema = z
  .object({
    ...wire,
    type: z.literal("listener.result"),
    sequence: safeSequence,
    status: z.enum(["progress", "completed", "partial", "failed"]),
    observation: audioObservationSchema.optional(),
    reason: z.string().min(1).max(512).optional(),
    nativeLaunch: nativeLaunchProofSchema.optional(),
    nativeCapture: nativeCaptureProofSchema.optional(),
    nativeLifecycle: nativeListenerLifecycleSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.status !== "completed" || value.observation !== undefined,
    "Completed results require an observation",
  )
  .refine(
    (value) =>
      (value.nativeLaunch === undefined &&
        value.nativeLifecycle === undefined) ||
      value.status === "progress",
    "Native launch and lifecycle events require progress results",
  )
  .refine(
    (value) =>
      value.nativeCapture === undefined || value.status === "completed",
    "Native capture evidence requires a completed result",
  );
export type ListenerResult = z.infer<typeof listenerResultSchema>;
/**
 * Self-reported Max LiveAPI physical-ID namespace, not Remote Script UUID
 * references or verified cross-boundary identity. Names/path hashes cannot certify it.
 */
export interface ReportedMaxLiveApiBinding {
  readonly trackId: string;
  readonly deviceId: string;
}

export interface ListenerDescriptor {
  readonly connectionId: string;
  readonly binding: ReportedMaxLiveApiBinding;
  readonly producer: OutputProducer;
  readonly registration: z.infer<typeof listenerRegistrationSchema>;
  readonly phase:
    "idle" | "preparing" | "ready" | "arming" | "armed" | "cancelling";
  readonly jobId?: string;
  readonly passId?: string;
}
export interface ListenerResultEvent {
  readonly connectionId: string;
  readonly binding: ListenerDescriptor["binding"];
  readonly producer: OutputProducer;
  readonly result: ListenerResult;
}
export interface ListenerControlOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface ListenerService {
  inspectListeners(): readonly ListenerDescriptor[];
  requestListenerControl(
    connectionId: string,
    input: ListenerControlInput,
    options?: ListenerControlOptions,
  ): Promise<ListenerReply>;
  onListenerResult(listener: (event: ListenerResultEvent) => void): () => void;
}
