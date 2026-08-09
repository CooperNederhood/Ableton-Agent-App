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

export const trackKindSchema = z.enum(["midi", "audio"]);

export const trackSummarySchema = z.object({
  index: z.number().int().nonnegative(),
  reference: z.string().uuid(),
  name: z.string(),
  kind: trackKindSchema,
  color: z.number().int().nullable(),
  isMuted: z.boolean(),
  isSoloed: z.boolean(),
  isArmed: z.boolean(),
  volume: z.number().min(0).max(1),
  pan: z.number().min(-1).max(1),
});

export const sessionViewClipSummarySchema = z.object({
  reference: z.string().uuid(),
  trackReference: z.string().uuid(),
  trackIndex: z.number().int().nonnegative(),
  sceneIndex: z.number().int().nonnegative(),
  name: z.string(),
  kind: trackKindSchema,
  length: z.number().positive(),
  noteCount: z.number().int().nonnegative().nullable(),
  muted: z.boolean().nullable().optional(),
  looping: z.boolean().nullable().optional(),
  isPlaying: z.boolean().optional(),
  isTriggered: z.boolean().optional(),
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
  clips: z.array(sessionViewClipSummarySchema).optional(),
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

export const arrangementLoopStateSchema = z.object({
  enabled: z.boolean(),
  start: z.number().finite().nonnegative(),
  length: z.number().finite().positive(),
});

export const cuePointSummarySchema = z.object({
  reference: z.string().uuid(),
  name: z.string(),
  time: z.number().finite().nonnegative(),
});

export const inspectArrangementTransportParamsSchema = z
  .object({
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(512).default(100),
  })
  .strict();

export const inspectArrangementTransportResultSchema = z.object({
  loop: arrangementLoopStateSchema,
  cuePoints: z.array(cuePointSummarySchema),
  totalCuePoints: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export const setArrangementLoopParamsSchema = z
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
  );

export const setArrangementLoopResultSchema = z.object({
  before: arrangementLoopStateSchema,
  after: arrangementLoopStateSchema,
  verified: z.literal(true),
});

export const createCuePointParamsSchema = z
  .object({
    time: z.number().finite().nonnegative().max(1576800),
    name: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const cuePointMutationResultSchema = z.object({
  cuePoint: cuePointSummarySchema,
  beforeCuePointCount: z.number().int().nonnegative(),
  afterCuePointCount: z.number().int().nonnegative(),
  verified: z.literal(true),
});

export const deleteCuePointParamsSchema = z
  .object({
    expectedReference: z.string().uuid(),
    expectedName: z.string(),
    expectedTime: z.number().finite().nonnegative().max(1576800),
  })
  .strict();

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

export const createMidiClipParamsSchema = trackTargetSchema.extend({
  sceneIndex: z.number().int().nonnegative(),
  length: z.number().positive().max(4096),
  name: z.string().trim().min(1).max(128).optional(),
});

export const midiNoteSchema = z.object({
  pitch: z.number().int().min(0).max(127),
  startTime: z.number().nonnegative(),
  duration: z.number().positive(),
  velocity: z.number().int().min(1).max(127),
  mute: z.boolean().default(false),
});

export const clipSummarySchema = z.object({
  reference: z.string().uuid(),
  trackReference: z.string().uuid(),
  trackIndex: z.number().int().nonnegative(),
  sceneIndex: z.number().int().nonnegative(),
  name: z.string(),
  length: z.number().positive(),
  noteCount: z.number().int().nonnegative(),
});

export const createMidiClipResultSchema = z.object({
  clip: clipSummarySchema,
  verified: z.literal(true),
});

export const replaceMidiNotesParamsSchema = trackTargetSchema.extend({
  sceneIndex: z.number().int().nonnegative(),
  expectedClipReference: z.string().uuid(),
  allowPerNoteExpressionLoss: z.boolean(),
  notes: z.array(midiNoteSchema).max(2048),
});

export const replaceMidiNotesResultSchema = z.object({
  clip: clipSummarySchema,
  beforeNoteCount: z.number().int().nonnegative(),
  afterNoteCount: z.number().int().nonnegative(),
  verified: z.literal(true),
});

export const sessionClipTargetSchema = trackTargetSchema.extend({
  sceneIndex: z.number().int().nonnegative(),
  expectedClipReference: z.string().uuid(),
});

export const sessionClipLaunchStateSchema = z.object({
  trackPlayingSceneIndex: z.number().int().nonnegative().nullable(),
  trackPlayingClipReference: z.string().uuid().nullable(),
  targetIsPlaying: z.boolean(),
  targetIsTriggered: z.boolean(),
});

export const launchSessionClipParamsSchema = sessionClipTargetSchema;

export const launchSessionClipResultSchema = z.object({
  clip: sessionViewClipSummarySchema,
  before: sessionClipLaunchStateSchema,
  after: sessionClipLaunchStateSchema,
  verified: z.literal(true),
});

export const duplicateSessionClipParamsSchema = sessionClipTargetSchema.extend({
  destinationTrackIndex: z.number().int().nonnegative(),
  expectedDestinationTrackReference: z.string().uuid(),
  expectedDestinationTrackName: z.string().min(1),
  destinationSceneIndex: z.number().int().nonnegative(),
});

export const duplicateSessionClipResultSchema = z.object({
  sourceClip: sessionViewClipSummarySchema,
  clip: sessionViewClipSummarySchema,
  verified: z.literal(true),
});

export const deleteSessionClipParamsSchema = sessionClipTargetSchema;

export const deleteSessionClipResultSchema = z.object({
  clip: sessionViewClipSummarySchema,
  beforeClipCount: z.number().int().nonnegative(),
  afterClipCount: z.number().int().nonnegative(),
  verified: z.literal(true),
});

export const sessionClipPropertiesSchema = z.object({
  name: z.string(),
  muted: z.boolean().nullable(),
  looping: z.boolean().nullable(),
});

export const setSessionClipPropertiesParamsSchema = sessionClipTargetSchema
  .extend({
    name: z.string().trim().min(1).max(128).optional(),
    muted: z.boolean().optional(),
    looping: z.boolean().optional(),
  })
  .refine(
    (params) =>
      params.name !== undefined ||
      params.muted !== undefined ||
      params.looping !== undefined,
    { message: "At least one clip property is required" },
  );

export const setSessionClipPropertiesResultSchema = z.object({
  clip: sessionViewClipSummarySchema,
  before: sessionClipPropertiesSchema,
  after: sessionClipPropertiesSchema,
  verified: z.literal(true),
});

export const createArrangementMidiClipParamsSchema = trackTargetSchema.extend({
  startTime: z.number().nonnegative().max(1576800),
  length: z.number().positive().max(4096),
  name: z.string().trim().min(1).max(128).optional(),
});

export const arrangementClipSummarySchema = z.object({
  reference: z.string().uuid(),
  trackReference: z.string().uuid(),
  trackIndex: z.number().int().nonnegative(),
  name: z.string(),
  kind: trackKindSchema,
  startTime: z.number().nonnegative(),
  endTime: z.number().positive(),
  length: z.number().positive(),
  noteCount: z.number().int().nonnegative().nullable(),
  muted: z.boolean().optional(),
  looping: z.boolean().nullable().optional(),
});

export const createArrangementMidiClipResultSchema = z.object({
  clip: arrangementClipSummarySchema,
  verified: z.literal(true),
});

export const inspectArrangementParamsSchema = z.object({
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(512).default(100),
});

export const inspectArrangementResultSchema = z.object({
  clips: z.array(arrangementClipSummarySchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export const deleteArrangementClipParamsSchema = trackTargetSchema.extend({
  expectedClipReference: z.string().uuid(),
  expectedStartTime: z.number().nonnegative(),
});

export const deleteArrangementClipResultSchema = z.object({
  clip: arrangementClipSummarySchema,
  beforeClipCount: z.number().int().nonnegative(),
  afterClipCount: z.number().int().nonnegative(),
  verified: z.literal(true),
});

export const replaceArrangementMidiNotesParamsSchema = trackTargetSchema.extend(
  {
    expectedClipReference: z.string().uuid(),
    expectedStartTime: z.number().nonnegative(),
    allowPerNoteExpressionLoss: z.boolean(),
    notes: z.array(midiNoteSchema).max(2048),
  },
);

export const replaceArrangementMidiNotesResultSchema = z.object({
  clip: arrangementClipSummarySchema,
  beforeNoteCount: z.number().int().nonnegative(),
  afterNoteCount: z.number().int().nonnegative(),
  verified: z.literal(true),
});

export const duplicateClipToArrangementParamsSchema = trackTargetSchema.extend({
  sceneIndex: z.number().int().nonnegative(),
  expectedClipReference: z.string().uuid(),
  destinationTime: z.number().nonnegative().max(1576800),
});

export const duplicateClipToArrangementResultSchema = z.object({
  sourceClip: sessionViewClipSummarySchema,
  clip: arrangementClipSummarySchema,
  beforeClipCount: z.number().int().nonnegative(),
  afterClipCount: z.number().int().nonnegative(),
  verified: z.literal(true),
});

export const arrangementClipPropertiesSchema = z.object({
  name: z.string(),
  muted: z.boolean(),
  looping: z.boolean().nullable(),
});

export const setArrangementClipPropertiesParamsSchema = trackTargetSchema
  .extend({
    expectedClipReference: z.string().uuid(),
    expectedStartTime: z.number().nonnegative(),
    name: z.string().trim().min(1).max(128).optional(),
    muted: z.boolean().optional(),
    looping: z.boolean().optional(),
  })
  .refine(
    (params) =>
      params.name !== undefined ||
      params.muted !== undefined ||
      params.looping !== undefined,
    { message: "At least one clip property is required" },
  );

export const setArrangementClipPropertiesResultSchema = z.object({
  clip: arrangementClipSummarySchema,
  before: arrangementClipPropertiesSchema,
  after: arrangementClipPropertiesSchema,
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
export type ArrangementLoopState = z.infer<typeof arrangementLoopStateSchema>;
export type CuePointSummary = z.infer<typeof cuePointSummarySchema>;
export type InspectArrangementTransportParams = z.infer<
  typeof inspectArrangementTransportParamsSchema
>;
export type InspectArrangementTransportResult = z.infer<
  typeof inspectArrangementTransportResultSchema
>;
export type SetArrangementLoopParams = z.infer<
  typeof setArrangementLoopParamsSchema
>;
export type SetArrangementLoopResult = z.infer<
  typeof setArrangementLoopResultSchema
>;
export type CreateCuePointParams = z.infer<typeof createCuePointParamsSchema>;
export type CuePointMutationResult = z.infer<
  typeof cuePointMutationResultSchema
>;
export type DeleteCuePointParams = z.infer<typeof deleteCuePointParamsSchema>;
export type CreateTrackParams = z.infer<typeof createTrackParamsSchema>;
export type DeleteTrackParams = z.infer<typeof deleteTrackParamsSchema>;
export type TrackMutationResult = z.infer<typeof trackMutationResultSchema>;
export type RenameTrackParams = z.infer<typeof renameTrackParamsSchema>;
export type RenameTrackResult = z.infer<typeof renameTrackResultSchema>;
export type SetTrackMixerParams = z.infer<typeof setTrackMixerParamsSchema>;
export type SetTrackMixerResult = z.infer<typeof setTrackMixerResultSchema>;
export type CreateMidiClipParams = z.infer<typeof createMidiClipParamsSchema>;
export type CreateMidiClipResult = z.infer<typeof createMidiClipResultSchema>;
export type ReplaceMidiNotesParams = z.infer<
  typeof replaceMidiNotesParamsSchema
>;
export type ReplaceMidiNotesResult = z.infer<
  typeof replaceMidiNotesResultSchema
>;
export type LaunchSessionClipParams = z.infer<
  typeof launchSessionClipParamsSchema
>;
export type LaunchSessionClipResult = z.infer<
  typeof launchSessionClipResultSchema
>;
export type DuplicateSessionClipParams = z.infer<
  typeof duplicateSessionClipParamsSchema
>;
export type DuplicateSessionClipResult = z.infer<
  typeof duplicateSessionClipResultSchema
>;
export type DeleteSessionClipParams = z.infer<
  typeof deleteSessionClipParamsSchema
>;
export type DeleteSessionClipResult = z.infer<
  typeof deleteSessionClipResultSchema
>;
export type SessionClipProperties = z.infer<typeof sessionClipPropertiesSchema>;
export type SetSessionClipPropertiesParams = z.infer<
  typeof setSessionClipPropertiesParamsSchema
>;
export type SetSessionClipPropertiesResult = z.infer<
  typeof setSessionClipPropertiesResultSchema
>;
export type CreateArrangementMidiClipParams = z.infer<
  typeof createArrangementMidiClipParamsSchema
>;
export type CreateArrangementMidiClipResult = z.infer<
  typeof createArrangementMidiClipResultSchema
>;
export type InspectArrangementParams = z.infer<
  typeof inspectArrangementParamsSchema
>;
export type InspectArrangementResult = z.infer<
  typeof inspectArrangementResultSchema
>;
export type DeleteArrangementClipParams = z.infer<
  typeof deleteArrangementClipParamsSchema
>;
export type DeleteArrangementClipResult = z.infer<
  typeof deleteArrangementClipResultSchema
>;
export type ReplaceArrangementMidiNotesParams = z.infer<
  typeof replaceArrangementMidiNotesParamsSchema
>;
export type ReplaceArrangementMidiNotesResult = z.infer<
  typeof replaceArrangementMidiNotesResultSchema
>;
export type DuplicateClipToArrangementParams = z.infer<
  typeof duplicateClipToArrangementParamsSchema
>;
export type DuplicateClipToArrangementResult = z.infer<
  typeof duplicateClipToArrangementResultSchema
>;
export type ArrangementClipProperties = z.infer<
  typeof arrangementClipPropertiesSchema
>;
export type SetArrangementClipPropertiesParams = z.infer<
  typeof setArrangementClipPropertiesParamsSchema
>;
export type SetArrangementClipPropertiesResult = z.infer<
  typeof setArrangementClipPropertiesResultSchema
>;
