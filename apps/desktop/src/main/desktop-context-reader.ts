import { randomUUID } from "node:crypto";
import {
  sanitizePersistedText,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import type { CopilotAgentServiceOptions } from "@ableton-agent/application";
import {
  desktopContextDetailSchema,
  desktopContextGetRequestSchema,
  desktopContextListRequestSchema,
  desktopContextPageSchema,
  type DesktopContextListRequest,
  type DesktopEntityContextApi,
} from "../context-contracts.js";

export function createDesktopContextReader({
  execute,
  telemetry,
}: {
  execute: NonNullable<CopilotAgentServiceOptions["executeContextOperation"]>;
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
    action: "list" | "get",
    execution: ReturnType<typeof context>,
    task: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    const spanId = randomUUID();
    const record = (
      phase: "queued" | "started" | "completed" | "failed" | "cancelled",
      error?: string,
    ) =>
      telemetry?.enqueue({
        version: 2,
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        name: `desktop.entity_context.${phase}`,
        source: "desktop-context-reader",
        category: "application",
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
  const read: DesktopEntityContextApi = {
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
