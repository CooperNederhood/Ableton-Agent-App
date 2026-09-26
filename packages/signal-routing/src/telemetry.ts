import { createHash, randomUUID } from "node:crypto";

import type {
  NonBlockingObservabilityRecorder,
  SanitizedAttributes,
  TelemetryEventEnvelope,
  TraceContext,
} from "@ableton-agent/observability";
import {
  telemetryEntityIdSchema,
  telemetryNameSchema,
} from "@ableton-agent/observability";

function entityId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return telemetryEntityIdSchema.safeParse(value).success
    ? value
    : stableTelemetryId(`telemetry-entity:${value}`);
}

export interface SignalTelemetryInput {
  readonly name: string;
  readonly source: string;
  readonly level?: TelemetryEventEnvelope["level"];
  readonly outcome?: TelemetryEventEnvelope["outcome"];
  readonly durationMs?: number;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly liveSetId?: string;
  readonly liveProjectId?: string;
  readonly sessionId?: string;
  readonly activeAgentId?: string;
  readonly liveEventId?: string;
  readonly outputId?: string;
  readonly toolName?: string;
  readonly trace?: TraceContext;
  readonly attributes?: SanitizedAttributes;
  readonly occurredAt?: string;
}

export function stableTelemetryId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function recordSignalTelemetry(
  recorder: Pick<NonBlockingObservabilityRecorder, "enqueue"> | undefined,
  input: SignalTelemetryInput,
): void {
  if (recorder === undefined) return;
  const correlationId = entityId(input.correlationId);
  const causationId = entityId(input.causationId);
  const liveSetId = entityId(input.liveSetId);
  const liveProjectId = entityId(input.liveProjectId);
  const sessionId = entityId(input.sessionId);
  const activeAgentId = entityId(input.activeAgentId);
  const liveEventId = entityId(input.liveEventId);
  const outputId = entityId(input.outputId);
  const toolName =
    input.toolName !== undefined &&
    telemetryNameSchema.safeParse(input.toolName).success
      ? input.toolName
      : undefined;
  const event: TelemetryEventEnvelope = {
    version: 2,
    id: randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    name: input.name,
    source: input.source,
    level: input.level ?? "info",
    ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    ...(input.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, input.durationMs) }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(causationId === undefined ? {} : { causationId }),
    ...(liveSetId === undefined ? {} : { liveSetId }),
    ...(liveProjectId === undefined ? {} : { liveProjectId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(activeAgentId === undefined ? {} : { activeAgentId }),
    ...(liveEventId === undefined ? {} : { liveEventId }),
    ...(outputId === undefined ? {} : { outputId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(input.trace === undefined ? {} : { trace: input.trace }),
    attributes: input.attributes ?? {},
  };
  try {
    recorder.enqueue(event);
  } catch {
    // Instrumentation must never disrupt signal ingress or routing.
  }
}
