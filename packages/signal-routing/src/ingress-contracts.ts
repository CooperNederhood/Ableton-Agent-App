import { z } from "zod";
import {
  producerDiagnosticsSchema,
  type WRITE_DIAGNOSTIC_CAPABILITY,
} from "./producer-diagnostics.js";

import { outputProducerSchema, signalPayloadSchema } from "./contracts.js";
import {
  listenerRegistrationSchema,
  listenerReplySchema,
  listenerResultSchema,
} from "./listener-contracts.js";
import {
  listenerRegistrationV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema,
} from "./listener-v2-contracts.js";

export const PRODUCER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_SIGNAL_INGRESS_HOST = "127.0.0.1";
export const DEFAULT_SIGNAL_INGRESS_PORT = 45_832;
export { DEFAULT_MAX_INGRESS_FRAME_BYTES } from "./contracts.js";

const requestIdSchema = z.string().min(1).max(128);

export const producerHelloSchema = z
  .object({
    type: z.literal("producer.hello"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    secret: z.string().min(32).max(4096),
    producer: outputProducerSchema,
    listener: z
      .union([listenerRegistrationSchema, listenerRegistrationV2Schema])
      .optional(),
  })
  .strict();

export const producerSignalFrameSchema = z
  .object({
    type: z.literal("signal.frame"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capturedAt: z.number().int().nonnegative(),
    payload: signalPayloadSchema,
  })
  .strict();

export const producerHeartbeatSchema = z
  .object({
    type: z.literal("producer.heartbeat"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    diagnostics: producerDiagnosticsSchema.optional(),
  })
  .strict();

export const producerDisconnectSchema = z
  .object({
    type: z.literal("producer.disconnect"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
  })
  .strict();

export const producerMessageSchema = z.discriminatedUnion("type", [
  producerHelloSchema,
  producerSignalFrameSchema,
  producerHeartbeatSchema,
  producerDisconnectSchema,
  z.discriminatedUnion("listenerVersion", [
    listenerReplySchema,
    listenerReplyV2Schema,
  ]),
  z.discriminatedUnion("listenerVersion", [
    listenerResultSchema,
    listenerResultV2Schema,
  ]),
]);
export type ProducerMessage = z.infer<typeof producerMessageSchema>;

export const ingressErrorCodeSchema = z.enum([
  "malformed-json",
  "invalid-message",
  "unsupported-version",
  "authentication-failed",
  "authentication-required",
  "already-authenticated",
  "duplicate-instance",
  "frame-too-large",
  "sequence-replay",
  "route-rejected",
  "backpressure",
  "idle-timeout",
  "server-shutdown",
  "internal-error",
]);
export type IngressErrorCode = z.infer<typeof ingressErrorCodeSchema>;

export interface ProducerAcknowledgement {
  readonly type: "producer.ack";
  readonly protocolVersion: typeof PRODUCER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly action: "hello" | "signal" | "heartbeat" | "disconnect" | "listener";
  readonly connectionId?: string;
  readonly producerDiagnostics?: readonly [typeof WRITE_DIAGNOSTIC_CAPABILITY];
}

export interface ProducerErrorResponse {
  readonly type: "producer.error";
  readonly protocolVersion: typeof PRODUCER_PROTOCOL_VERSION;
  readonly requestId?: string;
  readonly code: IngressErrorCode;
  readonly message: string;
  readonly fatal: boolean;
}

export type ProducerResponse = ProducerAcknowledgement | ProducerErrorResponse;

export interface SignalIngressDiscoveryDescriptor {
  readonly host: string;
  readonly port: number;
  readonly protocol: "newline-delimited-json";
  readonly protocolVersion: typeof PRODUCER_PROTOCOL_VERSION;
  readonly maxFrameBytes: number;
  readonly secretPath?: string;
  readonly producerDiagnostics?: readonly [typeof WRITE_DIAGNOSTIC_CAPABILITY];
  readonly listenerVersions?: readonly [1] | readonly [1, 2];
  readonly listenerCapabilities?:
    | readonly ["audio-listener/v1"]
    | readonly ["audio-listener/v1", "audio-listener/v2"];
}
