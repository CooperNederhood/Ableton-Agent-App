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
  liveVersion: z.string().min(1),
  remoteScriptVersion: z.string().min(1),
  projectId: z.string().min(1),
  capabilities: z.record(z.string(), z.boolean()),
  limits: z.object({
    maxFrameBytes: z.number().int().positive(),
    maxBatchItems: z.number().int().positive(),
  }),
});

export type HelloParams = z.infer<typeof helloParamsSchema>;
export type CapabilityDocument = z.infer<typeof capabilityDocumentSchema>;
