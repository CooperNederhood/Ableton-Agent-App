import { Buffer } from "node:buffer";
import { z } from "zod";
import { stableTelemetryId, type SignalTelemetryInput } from "./telemetry.js";

export const WRITE_DIAGNOSTIC_CAPABILITY = "write-backpressure/v1" as const;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(128);
export const writeDiagnosticEventSchema = z
  .object({
    eventId: z.string().uuid(),
    stage: z.enum([
      "queued",
      "started",
      "progress",
      "completed",
      "failed",
      "cancelled",
    ]),
    sourceTime: counter.max(8_640_000_000_000_000),
    order: counter,
    elapsedMs: z.number().finite().min(0).max(60_000),
    requestId: identifier,
    originConnectionId: identifier,
    connectionEpoch: identifier,
    traceId: identifier.optional(),
    correlationId: identifier.optional(),
    causationId: identifier.optional(),
    jobId: identifier.optional(),
    passId: identifier.optional(),
    queueCount: counter,
    queueBytes: counter,
    reason: z.enum([
      "write_backpressure",
      "drain",
      "pending_quota_exceeded",
      "outbound_queue_quota_exceeded",
      "outbound_write_failed",
      "outbound_drain_timeout",
      "disconnected",
      "stopped",
    ]),
    writeReturn: z.boolean().optional(),
    writableLength: counter.optional(),
    writableHighWaterMark: counter.optional(),
  })
  .strict();
export const producerDiagnosticsSchema = z
  .object({
    schema: z.literal(WRITE_DIAGNOSTIC_CAPABILITY),
    events: z.array(writeDiagnosticEventSchema).max(8),
    gaps: z
      .object({
        overflow: counter,
        expired: counter,
        unsupported: counter,
        invalid: counter.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 8192,
    "Diagnostic batch exceeds 8192 bytes",
  );
export type WriteDiagnosticEvent = z.infer<typeof writeDiagnosticEventSchema>;

export interface DiagnosticOrigin {
  producerId: string;
  instanceId: string;
  connectionId: string;
  connectionEpoch: string;
  requestId: string;
  traceId?: string;
  correlationId?: string;
  causationId?: string;
  jobId?: string;
  passId?: string;
}

/** Audit receipts never participate in listener authority or mutation sequencing. */
export class ProducerDiagnosticReceipts {
  readonly #receipts = new Map<
    string,
    { origin: DiagnosticOrigin; at: number }
  >();
  readonly #seen = new Map<string, number>();
  readonly #orders = new Map<string, { order: number; at: number }>();
  constructor(readonly now: () => number) {}
  #key(
    origin: Pick<
      DiagnosticOrigin,
      "producerId" | "instanceId" | "connectionId" | "requestId"
    >,
  ) {
    return JSON.stringify([
      origin.producerId,
      origin.instanceId,
      origin.connectionId,
      origin.requestId,
    ]);
  }
  #expire() {
    for (const map of [this.#receipts, this.#seen, this.#orders]) {
      for (const [key, value] of map) {
        const at = typeof value === "number" ? value : value.at;
        if (this.now() - at >= 60_000) map.delete(key);
      }
    }
  }
  remember(origin: DiagnosticOrigin) {
    this.#expire();
    const key = this.#key(origin);
    if (!this.#receipts.has(key))
      this.#receipts.set(key, { origin: { ...origin }, at: this.now() });
    if (this.#receipts.size > 2048)
      this.#receipts.delete(this.#receipts.keys().next().value!);
  }
  accept(
    producerId: string,
    instanceId: string,
    event: WriteDiagnosticEvent,
  ):
    | { kind: "accepted"; origin: DiagnosticOrigin }
    | { kind: "duplicate"; reason: string }
    | { kind: "rejected"; reason: string } {
    this.#expire();
    const origin = this.#receipts.get(
      this.#key({
        producerId,
        instanceId,
        connectionId: event.originConnectionId,
        requestId: event.requestId,
      }),
    )?.origin;
    if (
      !origin ||
      [
        "connectionEpoch",
        "traceId",
        "correlationId",
        "causationId",
        "jobId",
        "passId",
      ].some(
        (key) =>
          origin[key as keyof DiagnosticOrigin] !==
          event[key as keyof WriteDiagnosticEvent],
      )
    )
      return { kind: "rejected", reason: "unverified_origin" };
    if (
      this.now() - event.sourceTime >= 60_000 ||
      event.sourceTime > this.now() + 1000
    )
      return { kind: "rejected", reason: "source_time_out_of_bounds" };
    const identity = JSON.stringify([producerId, instanceId, event.eventId]);
    if (this.#seen.has(identity))
      return { kind: "duplicate", reason: "duplicate" };
    const stream = JSON.stringify([
      producerId,
      instanceId,
      event.originConnectionId,
      event.connectionEpoch,
    ]);
    const previous = this.#orders.get(stream);
    if (previous && event.order <= previous.order)
      return { kind: "rejected", reason: "source_order_regression" };
    this.#orders.set(stream, { order: event.order, at: this.now() });
    this.#seen.set(identity, this.now());
    if (this.#seen.size > 4096)
      this.#seen.delete(this.#seen.keys().next().value!);
    if (this.#orders.size > 2048)
      this.#orders.delete(this.#orders.keys().next().value!);
    return { kind: "accepted", origin };
  }
  clear() {
    this.#receipts.clear();
    this.#seen.clear();
    this.#orders.clear();
  }
}

export function writeDiagnosticTelemetry(
  event: WriteDiagnosticEvent,
  origin: DiagnosticOrigin,
  deliveryConnectionId: string,
  receivedAt: number,
): SignalTelemetryInput {
  const traceId =
    origin.traceId ??
    stableTelemetryId(`output-ingress-request:${origin.requestId}`);
  return {
    id: stableTelemetryId(
      `write-diagnostic:${origin.producerId}:${origin.instanceId}:${event.eventId}`,
    ),
    name: `output.producer.write-backpressure.${event.stage}`,
    source: "output-ingress",
    occurredAt: new Date(event.sourceTime).toISOString(),
    durationMs: event.elapsedMs,
    correlationId: origin.correlationId ?? origin.requestId,
    ...(origin.causationId === undefined
      ? {}
      : { causationId: origin.causationId }),
    trace: {
      traceId: stableTelemetryIdIfNeeded(traceId),
      spanId: event.eventId,
    },
    outcome:
      event.stage === "failed"
        ? "failure"
        : event.stage === "cancelled"
          ? "cancelled"
          : event.stage === "completed"
            ? "success"
            : "unknown",
    attributes: {
      ...event,
      producerId: origin.producerId,
      instanceId: origin.instanceId,
      deliveryConnectionId,
      originVerified: true,
      deliveryDelayMs: Math.max(0, receivedAt - event.sourceTime),
    },
  };
}
function stableTelemetryIdIfNeeded(value: string) {
  return z.string().uuid().safeParse(value).success
    ? value
    : stableTelemetryId(value);
}
