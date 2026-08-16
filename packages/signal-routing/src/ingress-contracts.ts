import { z } from "zod";

import { outputProducerSchema, signalPayloadSchema } from "./contracts.js";

export const PRODUCER_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_SIGNAL_INGRESS_HOST = "127.0.0.1";
export const DEFAULT_SIGNAL_INGRESS_PORT = 45_832;
export const DEFAULT_MAX_INGRESS_FRAME_BYTES = 128 * 1024;

const requestIdSchema = z.string().min(1).max(128);

export const producerHelloSchema = z
  .object({
    type: z.literal("producer.hello"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    secret: z.string().min(32).max(4096),
    producer: outputProducerSchema,
  })
  .strict();

export const producerSignalFrameSchema = z
  .object({
    type: z.literal("signal.frame"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    sequence: z.number().int().nonnegative(),
    capturedAt: z.number().int().nonnegative(),
    payload: signalPayloadSchema,
  })
  .strict();

export const producerHeartbeatSchema = z
  .object({
    type: z.literal("producer.heartbeat"),
    protocolVersion: z.literal(PRODUCER_PROTOCOL_VERSION),
    requestId: requestIdSchema,
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
  readonly action: "hello" | "signal" | "heartbeat" | "disconnect";
  readonly connectionId?: string;
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
}
