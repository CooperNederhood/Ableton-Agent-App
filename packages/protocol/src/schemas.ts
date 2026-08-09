import { z } from "zod";

import { PROTOCOL_VERSION } from "./constants.js";

export const requestIdSchema = z.string().uuid();

export const protocolErrorCodeSchema = z.enum([
  "authentication_failed",
  "protocol_version_unsupported",
  "invalid_request",
  "unknown_command",
  "invalid_params",
  "unsupported_capability",
  "not_found",
  "ambiguous_reference",
  "stale_reference",
  "conflict",
  "operation_timeout",
  "queue_full",
  "lom_error",
  "internal_error",
]);

export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>;

export const protocolErrorSchema = z.object({
  code: protocolErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
});

const envelopeBaseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

export const requestEnvelopeSchema = envelopeBaseSchema.extend({
  kind: z.literal("request"),
  requestId: requestIdSchema,
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  projectRevision: z.number().int().nonnegative().optional(),
});

export const successResponseEnvelopeSchema = envelopeBaseSchema.extend({
  kind: z.literal("response"),
  requestId: requestIdSchema,
  ok: z.literal(true),
  result: z.unknown(),
  projectRevision: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()).default([]),
});

export const failureResponseEnvelopeSchema = envelopeBaseSchema.extend({
  kind: z.literal("response"),
  requestId: requestIdSchema,
  ok: z.literal(false),
  error: protocolErrorSchema,
});

export const eventEnvelopeSchema = envelopeBaseSchema.extend({
  kind: z.literal("event"),
  event: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  payload: z.unknown(),
  projectRevision: z.number().int().nonnegative().optional(),
});

export const messageEnvelopeSchema = z.union([
  requestEnvelopeSchema,
  successResponseEnvelopeSchema,
  failureResponseEnvelopeSchema,
  eventEnvelopeSchema,
]);

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type ResponseEnvelope =
  | z.infer<typeof successResponseEnvelopeSchema>
  | z.infer<typeof failureResponseEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;

export const helloParamsSchema = z.object({
  authenticationToken: z.string().min(32),
  supportedProtocolVersions: z.array(z.number().int().positive()).min(1),
  appVersion: z.string().min(1),
  eventSubscriptions: z.array(z.string()).default([]),
});

export const capabilityDocumentSchema = z.object({
  selectedProtocolVersion: z.literal(PROTOCOL_VERSION),
  liveVersion: z.string().min(1),
  remoteScriptVersion: z.string().min(1),
  projectId: z.string().min(1),
  capabilities: z.record(z.string(), z.boolean()),
  limits: z.object({
    maxFrameBytes: z.number().int().positive(),
    maxBatchItems: z.number().int().positive(),
  }),
});

export const pingResultSchema = z.object({
  pong: z.literal(true),
});

export const trackSummarySchema = z.object({
  index: z.number().int().nonnegative(),
  reference: z.string().uuid(),
  name: z.string(),
  kind: z.enum(["midi", "audio"]),
  color: z.number().int().nullable(),
  isMuted: z.boolean(),
  isSoloed: z.boolean(),
  isArmed: z.boolean(),
  volume: z.number().min(0).max(1),
  pan: z.number().min(-1).max(1),
});

export const sessionSnapshotSchema = z.object({
  tempo: z.number().positive(),
  timeSignature: z.object({
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
  }),
  isPlaying: z.boolean(),
  trackCount: z.number().int().nonnegative(),
  tracks: z.array(trackSummarySchema),
});

export const setTempoParamsSchema = z.object({
  tempo: z.number().min(20).max(999),
});

export const setTempoResultSchema = z.object({
  beforeTempo: z.number().positive(),
  afterTempo: z.number().positive(),
  verified: z.boolean(),
});

export const setPlayingParamsSchema = z.object({
  isPlaying: z.boolean(),
});

export const setPlayingResultSchema = z.object({
  beforeIsPlaying: z.boolean(),
  afterIsPlaying: z.boolean(),
  verified: z.boolean(),
});

export const trackKindSchema = z.enum(["midi", "audio"]);

export const createTrackParamsSchema = z.object({
  kind: trackKindSchema,
  name: z.string().trim().min(1).max(128).optional(),
});

export const deleteTrackParamsSchema = z.object({
  index: z.number().int().nonnegative(),
  expectedReference: z.string().uuid(),
  expectedName: z.string().min(1),
  expectedKind: trackKindSchema,
});

export const trackMutationResultSchema = z.object({
  beforeTrackCount: z.number().int().nonnegative(),
  afterTrackCount: z.number().int().nonnegative(),
  track: z.object({
    index: z.number().int().nonnegative(),
    reference: z.string().uuid(),
    name: z.string(),
    kind: trackKindSchema,
  }),
  verified: z.boolean(),
});

export const trackTargetSchema = z.object({
  index: z.number().int().nonnegative(),
  expectedReference: z.string().uuid(),
  expectedName: z.string().min(1),
});

export const renameTrackParamsSchema = trackTargetSchema.extend({
  name: z.string().trim().min(1).max(128),
});

export const renameTrackResultSchema = z.object({
  reference: z.string().uuid(),
  index: z.number().int().nonnegative(),
  beforeName: z.string(),
  afterName: z.string(),
  verified: z.literal(true),
});

export const trackMixerStateSchema = z.object({
  isMuted: z.boolean(),
  isSoloed: z.boolean(),
  isArmed: z.boolean(),
  volume: z.number().min(0).max(1),
  pan: z.number().min(-1).max(1),
});

export const setTrackMixerParamsSchema = trackTargetSchema
  .extend({
    isMuted: z.boolean().optional(),
    isSoloed: z.boolean().optional(),
    isArmed: z.boolean().optional(),
    volume: z.number().min(0).max(1).optional(),
    pan: z.number().min(-1).max(1).optional(),
  })
  .refine(
    (params) =>
      params.isMuted !== undefined ||
      params.isSoloed !== undefined ||
      params.isArmed !== undefined ||
      params.volume !== undefined ||
      params.pan !== undefined,
    { message: "At least one mixer property is required" },
  );

export const setTrackMixerResultSchema = z.object({
  reference: z.string().uuid(),
  index: z.number().int().nonnegative(),
  before: trackMixerStateSchema,
  after: trackMixerStateSchema,
  verified: z.literal(true),
});

export type HelloParams = z.infer<typeof helloParamsSchema>;
export type CapabilityDocument = z.infer<typeof capabilityDocumentSchema>;
export type PingResult = z.infer<typeof pingResultSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SetTempoParams = z.infer<typeof setTempoParamsSchema>;
export type SetTempoResult = z.infer<typeof setTempoResultSchema>;
export type SetPlayingParams = z.infer<typeof setPlayingParamsSchema>;
export type SetPlayingResult = z.infer<typeof setPlayingResultSchema>;
export type CreateTrackParams = z.infer<typeof createTrackParamsSchema>;
export type DeleteTrackParams = z.infer<typeof deleteTrackParamsSchema>;
export type TrackMutationResult = z.infer<typeof trackMutationResultSchema>;
export type RenameTrackParams = z.infer<typeof renameTrackParamsSchema>;
export type RenameTrackResult = z.infer<typeof renameTrackResultSchema>;
export type SetTrackMixerParams = z.infer<typeof setTrackMixerParamsSchema>;
export type SetTrackMixerResult = z.infer<typeof setTrackMixerResultSchema>;
