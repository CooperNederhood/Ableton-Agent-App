import { randomUUID } from "node:crypto";

import {
  createNonBlockingObservabilityRecorder,
  sanitizeTelemetryAttributes,
  type ObservabilitySink,
} from "@ableton-agent/observability";

import type { IntegrationInstallEvent } from "./ableton-integrations-install.js";

export interface IntegrationTrace {
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

export function createIntegrationTelemetry(options: {
  readonly sink: ObservabilitySink;
  readonly trace: IntegrationTrace;
  readonly profile: string;
  readonly onFailure: (error: unknown) => void;
  readonly now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const rootSpanId = randomUUID();
  const spans = new Map<string, ReturnType<typeof randomUUID>>();
  const recorder = createNonBlockingObservabilityRecorder(options.sink, {
    onFailure: ({ error }) => options.onFailure(error),
  });
  return (event: IntegrationInstallEvent): void => {
    const key = event.component;
    let spanId = rootSpanId;
    if (key !== undefined) {
      spanId = spans.get(key) ?? randomUUID();
      spans.set(key, spanId);
    }
    recorder.enqueue({
      version: 2,
      id: randomUUID(),
      occurredAt: now().toISOString(),
      name: event.name,
      source: "desktop.integrations",
      stage: event.stage,
      level: event.stage === "failed" ? "error" : "info",
      ...(event.stage === "completed"
        ? { outcome: "success" }
        : event.stage === "failed"
          ? { outcome: "failure" }
          : event.stage === "cancelled"
            ? { outcome: "cancelled" }
            : {}),
      durationMs: event.durationMs,
      correlationId: options.trace.correlationId,
      causationId: options.trace.causationId,
      trace: {
        traceId: options.trace.traceId,
        spanId,
        ...(key === undefined ? {} : { parentSpanId: rootSpanId }),
      },
      attributes: sanitizeTelemetryAttributes({
        ...event.attributes,
        profile: options.profile,
        ...(key === undefined ? {} : { component: key }),
      }),
    });
  };
}
