import { z } from "zod";

import {
  MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH,
  MAX_AGENT_INSTANCE_ASSIGNMENT_ID_LENGTH,
} from "./assignment-id.js";

export const SIGNAL_PROTOCOL_VERSION = 1 as const;
export const MAX_SIGNAL_PAYLOAD_BYTES = 64 * 1024;
export const MAX_AUDIO_FEATURES = 256;
export const MAX_AUDIO_ASSET_BYTES = 32 * 1024 * 1024;

export const signalKindSchema = z.enum(["midi", "audio"]);
export type SignalKind = z.infer<typeof signalKindSchema>;

const identifierSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH);
const jsonScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const outputProducerSchema = z
  .object({
    producerId: identifierSchema,
    instanceId: identifierSchema,
    displayName: z.string().min(1).max(256),
    signalKind: signalKindSchema,
    schemaVersion: identifierSchema,
    track: z
      .object({
        id: identifierSchema.optional(),
        index: z.number().int().nonnegative().optional(),
        name: z.string().min(1).max(256).optional(),
      })
      .optional(),
    device: z
      .object({
        id: identifierSchema.optional(),
        name: z.string().min(1).max(256).optional(),
      })
      .optional(),
    capabilities: z.record(z.string(), jsonScalarSchema).optional(),
  })
  .refine(
    (producer) =>
      producer.schemaVersion ===
      (producer.signalKind === "midi"
        ? "midi-sample/v1"
        : "audio-reference/v1"),
    {
      path: ["schemaVersion"],
      message: "Schema version must match the producer signal kind",
    },
  );
export type OutputProducer = z.infer<typeof outputProducerSchema>;

export const outputConnectionStatusSchema = z.enum([
  "connected",
  "stale",
  "disconnected",
]);

export const outputConnectionSchema = z.object({
  connectionId: identifierSchema,
  producer: outputProducerSchema,
  status: outputConnectionStatusSchema,
  connectedAt: z.number().int().nonnegative(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  disconnectedAt: z.number().int().nonnegative().optional(),
});
export type OutputConnection = z.infer<typeof outputConnectionSchema>;

export const midiNoteSchema = z.object({
  channel: z.number().int().min(1).max(16),
  pitch: z.number().int().min(0).max(127),
  name: z.string().min(1).max(8),
  velocity: z.number().int().min(0).max(127),
  onset_beats: z.number().finite().nonnegative(),
  duration_beats: z.number().finite().nonnegative(),
  continued_from_previous: z.boolean(),
  continues_into_next: z.boolean(),
});

export const midiSampleV1Schema = z
  .object({
    schema: z.literal("midi-sample/v1"),
    sample_index: z.number().int().nonnegative(),
    complete: z.boolean(),
    end_reason: z.string().min(1).max(128),
    start_tick: z.number().finite(),
    end_tick: z.number().finite(),
    ppq: z.number().int().positive(),
    start_beat: z.number().finite(),
    end_beat: z.number().finite(),
    length_beats: z.number().finite().nonnegative(),
    tempo_bpm_at_start: z.number().finite().positive().nullable(),
    time_signature_at_start: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .nullable(),
    notes: z.array(midiNoteSchema).max(4096),
  })
  .superRefine((sample, context) => {
    if (
      sample.end_tick < sample.start_tick ||
      sample.end_beat < sample.start_beat
    ) {
      context.addIssue({
        code: "custom",
        message: "MIDI sample end must not precede its start",
      });
    }
  });
export type MidiSampleV1 = z.infer<typeof midiSampleV1Schema>;

const audioFeatureSchema = z.object({
  name: identifierSchema,
  value: z.number().finite(),
  unit: z.string().min(1).max(64).optional(),
});

const boundedMetadataSchema = z
  .record(z.string().min(1).max(128), jsonScalarSchema)
  .refine((metadata) => Object.keys(metadata).length <= 64, {
    message: "Audio metadata is limited to 64 entries",
  });

export const audioSignalReferenceSchema = z
  .object({
    schema: z.literal("audio-reference/v1"),
    durationMs: z.number().finite().nonnegative(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().max(64).optional(),
    metadata: boundedMetadataSchema.optional(),
    features: z.array(audioFeatureSchema).max(MAX_AUDIO_FEATURES).optional(),
    asset: z
      .object({
        assetId: identifierSchema,
        mediaType: z.string().min(1).max(128),
        byteLength: z.number().int().nonnegative().max(MAX_AUDIO_ASSET_BYTES),
      })
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.metadata !== undefined ||
      value.features !== undefined ||
      value.asset !== undefined,
    {
      message:
        "Audio references require bounded metadata, features, or an asset reference",
    },
  );
export type AudioSignalReference = z.infer<typeof audioSignalReferenceSchema>;

export const signalPayloadSchema = z.union([
  midiSampleV1Schema,
  audioSignalReferenceSchema,
]);
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export const signalEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(SIGNAL_PROTOCOL_VERSION),
    connectionId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative(),
    payload: signalPayloadSchema,
  })
  .superRefine((envelope, context) => {
    if (jsonByteLength(envelope.payload) > MAX_SIGNAL_PAYLOAD_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: `Signal payload exceeds ${MAX_SIGNAL_PAYLOAD_BYTES} bytes`,
      });
    }
  });
export type SignalEnvelope = z.infer<typeof signalEnvelopeSchema>;

export const signalConsumerEndpointSchema = z
  .object({
    kind: z.string().min(1).max(128),
    id: identifierSchema,
  })
  .passthrough();
export type SignalConsumerEndpoint = z.infer<
  typeof signalConsumerEndpointSchema
>;

export const AGENT_INSTANCE_CONSUMER_KIND = "agent-instance" as const;
export const LEGACY_AGENT_SESSION_CONSUMER_KIND = "agent-session" as const;

export function isAgentInstanceConsumer(
  consumer: SignalConsumerEndpoint,
  agentInstanceId?: string,
): boolean {
  return (
    (consumer.kind === AGENT_INSTANCE_CONSUMER_KIND ||
      consumer.kind === LEGACY_AGENT_SESSION_CONSUMER_KIND) &&
    (agentInstanceId === undefined || consumer.id === agentInstanceId)
  );
}

export const deliveryModeSchema = z.enum([
  "next-prompt",
  "automatic-analysis",
  "automatic-action",
]);

export const assignmentIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_INSTANCE_ASSIGNMENT_ID_LENGTH);

export const outputAssignmentSchema = z.object({
  assignmentId: assignmentIdentifierSchema,
  producerId: identifierSchema,
  consumer: signalConsumerEndpointSchema,
  deliveryMode: deliveryModeSchema,
  enabled: z.boolean(),
  usageInstruction: z.string().min(1).max(4096),
  processingPolicyIds: z.array(identifierSchema).max(64),
});
export type OutputAssignment = z.infer<typeof outputAssignmentSchema>;

export const translatedSignalContextSchema = z.object({
  assignmentId: assignmentIdentifierSchema,
  producerId: identifierSchema,
  consumer: signalConsumerEndpointSchema,
  deliveryMode: deliveryModeSchema,
  sequence: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
  sourceIdentity: z.string().min(1).max(1024),
  content: z.string().min(1).max(MAX_SIGNAL_PAYLOAD_BYTES),
});
export type TranslatedSignalContext = z.infer<
  typeof translatedSignalContextSchema
>;

export const filterDecisionSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    reason: z.string().min(1),
  }),
  z.object({
    accepted: z.literal(false),
    reason: z.string().min(1),
    code: z.enum([
      "invalid-schema",
      "sequence-replay",
      "exact-duplicate",
      "payload-too-large",
      "queue-bound",
      "unsupported-payload",
      "connection-unavailable",
      "producer-mismatch",
    ]),
  }),
]);
export type FilterDecision = z.infer<typeof filterDecisionSchema>;
