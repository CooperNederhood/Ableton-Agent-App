import { z } from "zod";
import {
  listeningCanonicalDevicePathSchema,
  listeningCanonicalTrackPathSchema,
  nativeMetricListeningConfigSchema,
  type ListeningFailureEvidence,
} from "@ableton-agent/protocol";
import type { OutputProducer } from "./contracts.js";
import type {
  ListenerRegistrationMetric,
  ListenerReplyMetric,
  ListenerResultMetric,
} from "./listener-metric-contracts.js";

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

/** Placement data shared without inheriting a superseded wire contract. */
export const listenerRegistrationBaseSchema = z.strictObject({
  sampleRate: z.number().int().min(8000).max(384000),
  deviceCanonicalPath: listeningCanonicalDevicePathSchema.optional(),
  trackCanonicalPath: listeningCanonicalTrackPathSchema.optional(),
});

const identifier = z.string().min(1).max(128);
export const listenerControlInputSchema = z
  .strictObject({
    jobId: identifier,
    passId: identifier,
    traceId: z.string().uuid(),
    correlationId: identifier,
    causationId: identifier,
    action: z.enum(["prepare", "arm", "cancel"]),
    config: nativeMetricListeningConfigSchema.optional(),
  })
  .refine(
    (value) => (value.action === "prepare") === (value.config !== undefined),
    "Only prepare carries immutable metric configuration",
  );
export type ListenerControlInput = z.infer<typeof listenerControlInputSchema>;

/**
 * Self-reported Max LiveAPI physical-ID namespace, not Remote Script UUID
 * references or verified cross-boundary identity.
 */
export interface ReportedMaxLiveApiBinding {
  readonly trackId: string;
  readonly deviceId: string;
}

export interface ListenerDescriptor {
  readonly connectionId: string;
  readonly binding: ReportedMaxLiveApiBinding;
  readonly producer: OutputProducer;
  readonly registration: ListenerRegistrationMetric;
  readonly phase:
    "idle" | "preparing" | "ready" | "arming" | "armed" | "cancelling";
  readonly jobId?: string;
  readonly passId?: string;
}

export interface ListenerResultEvent {
  readonly connectionId: string;
  readonly binding: ListenerDescriptor["binding"];
  readonly producer: OutputProducer;
  readonly result: ListenerResultMetric;
  readonly failureEvidence?: ListeningFailureEvidence;
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
  ): Promise<ListenerReplyMetric>;
  onListenerResult(listener: (event: ListenerResultEvent) => void): () => void;
}
