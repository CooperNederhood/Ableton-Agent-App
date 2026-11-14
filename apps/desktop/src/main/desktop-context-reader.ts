import { randomUUID } from "node:crypto";
import {
  sanitizePersistedText,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import type { CopilotAgentServiceOptions } from "@ableton-agent/application";
import type {
  ListeningExecutionContext,
  SessionContextHostOptions,
} from "@ableton-agent/application";
import type { MetricCaptureRecord } from "@ableton-agent/project-state/metric-capture-schemas";
import {
  desktopContextDetailSchema,
  desktopContextGetRequestSchema,
  desktopContextListRequestSchema,
  desktopContextPageSchema,
  type DesktopContextListRequest,
  type DesktopEntityContextApi,
  desktopMetricCaptureGetRequestSchema,
  desktopMetricChunksRequestSchema,
  desktopMetricCaptureSchema,
  desktopMetricChunkPageSchema,
} from "../context-contracts.js";

export function createDesktopContextReader({
  execute,
  resolveRepository,
  telemetry,
}: {
  execute: NonNullable<CopilotAgentServiceOptions["executeContextOperation"]>;
  resolveRepository?: SessionContextHostOptions["resolveRepository"];
  telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
}): DesktopEntityContextApi {
  const context = (
    sessionId: string,
    trace: DesktopContextListRequest["trace"],
  ) => ({
    sessionId,
    agentId: "desktop-context",
    actorKind: "application" as const,
    trace: trace ?? {
      traceId: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    },
  });
  const query = async <T>(
    action: "list" | "get" | "metric-overview" | "metric-chunks",
    execution: ReturnType<typeof context>,
    task: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    const spanId = randomUUID();
    const record = (
      phase:
        | "queued"
        | "started"
        | "progress"
        | "completed"
        | "failed"
        | "cancelled",
      error?: string,
    ) =>
      telemetry?.enqueue({
        version: 2,
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        name: `desktop.entity_context.${phase}`,
        source: "desktop-context-reader",
        category: "application",
        stage: phase,
        outcome:
          phase === "completed"
            ? "success"
            : phase === "failed"
              ? "failure"
              : phase === "cancelled"
                ? "cancelled"
                : "unknown",
        level: phase === "failed" ? "error" : "info",
        sessionId: execution.sessionId,
        correlationId: execution.trace.correlationId,
        causationId: execution.trace.causationId,
        trace: { traceId: execution.trace.traceId, spanId },
        durationMs: Math.max(0, performance.now() - startedAt),
        attributes: {
          action,
          actorKind: "application",
          ...(error === undefined ? {} : { error }),
        },
      });
    record("queued");
    record("started");
    if (action === "metric-overview" || action === "metric-chunks")
      record("progress");
    try {
      const result = await task();
      record("completed");
      return result;
    } catch (error) {
      const message = sanitizePersistedText(
        error instanceof Error ? error.message : "Context query failed",
      ).slice(0, 2048);
      const cancelled = error instanceof Error && error.name === "AbortError";
      record(cancelled ? "cancelled" : "failed", message);
      const failure = new Error(message);
      if (cancelled) failure.name = "AbortError";
      throw failure;
    }
  };
  const repositoryFor = async (execution: ListeningExecutionContext) => {
    if (resolveRepository === undefined)
      throw new Error("Typed metric context reads are unavailable");
    const repository = await resolveRepository(execution);
    if (
      repository.sessionId !== execution.sessionId ||
      repository.incrementalMetrics === undefined
    )
      throw new Error(
        "Metric context repository does not belong to this App session",
      );
    return { repository, metrics: repository.incrementalMetrics };
  };
  const checkCapture = (
    record: MetricCaptureRecord,
    id: string,
    sessionId: string,
    liveSetId: string,
  ) => {
    if (
      record.metadata.id !== id ||
      record.metadata.pass.sessionId !== sessionId ||
      record.metadata.subject.sessionId !== sessionId ||
      record.metadata.pass.liveSetId !== liveSetId ||
      record.metadata.subject.liveSetId !== liveSetId
    )
      throw new Error(
        "Metric capture does not match the invoking session and Set ownership",
      );
  };
  const read: DesktopEntityContextApi = {
    getMetricCapture: async (input) => {
      const { sessionId, contextId, trace } =
        desktopMetricCaptureGetRequestSchema.parse(input);
      const execution = context(sessionId, trace);
      return query("metric-overview", execution, async () => {
        const { repository, metrics } = await repositoryFor(execution);
        const record = desktopMetricCaptureSchema.parse(
          await metrics.getMetricCapture(contextId, { trace: execution.trace }),
        );
        if (record !== undefined)
          checkCapture(record, contextId, sessionId, repository.liveSetId);
        return record;
      });
    },
    listMetricChunks: async (input) => {
      const { sessionId, trace, ...parameters } =
        desktopMetricChunksRequestSchema.parse(input);
      const execution = context(sessionId, trace);
      return query("metric-chunks", execution, async () => {
        const { repository, metrics } = await repositoryFor(execution);
        const operation = { trace: execution.trace };
        const record = desktopMetricCaptureSchema.parse(
          await metrics.getMetricCapture(parameters.captureId, operation),
        );
        if (record === undefined)
          throw new Error("Metric capture is unavailable");
        checkCapture(
          record,
          parameters.captureId,
          sessionId,
          repository.liveSetId,
        );
        const page = desktopMetricChunkPageSchema.parse(
          await metrics.listMetricChunks(parameters, operation),
        );
        if (
          page.items.length > parameters.limit ||
          page.encodedBytes > parameters.maxBytes ||
          page.items.some(
            (chunk) =>
              chunk.descriptorDigest !== record.state.descriptorDigest ||
              JSON.stringify(chunk.ownership) !==
                JSON.stringify(record.descriptor.ownership),
          )
        )
          throw new Error(
            "Metric chunk page does not match its capture or bounded request",
          );
        return page;
      });
    },
    list: async (input) => {
      const { sessionId, trace, ...parameters } =
        desktopContextListRequestSchema.parse(input);
      const execution = context(sessionId, trace);
      return query("list", execution, async () => {
        return desktopContextPageSchema.parse(
          await execute({ action: "list", ...parameters }, execution),
        );
      });
    },
    get: async (input) => {
      const { sessionId, trace, ...parameters } =
        desktopContextGetRequestSchema.parse(input);
      const execution = context(sessionId, trace);
      return query("get", execution, async () => {
        const result = desktopContextDetailSchema.parse(
          await execute({ action: "get", ...parameters }, execution),
        );
        if (result.entry.contextId !== parameters.contextId) {
          throw new Error("Context detail identity mismatch");
        }
        return result;
      });
    },
  };
  return read;
}
