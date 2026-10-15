import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export function createNativeRunnerLifecycle({
  telemetry,
  sanitize,
  trace,
  signal,
}) {
  const events = [];
  const stage = async (name, operation) => {
    const started = performance.now();
    let cause = trace.causationId;
    const emit = (phase, attributes = {}) => {
      const id = randomUUID();
      const event = {
        version: 2,
        id,
        occurredAt: new Date().toISOString(),
        name: `integration.native_listening.${name}.${phase}`,
        source: "application",
        category: "context",
        stage: phase,
        level: phase === "failed" ? "error" : "info",
        outcome:
          phase === "completed"
            ? "success"
            : phase === "failed"
              ? "failure"
              : phase === "cancelled"
                ? "cancelled"
                : "unknown",
        durationMs: performance.now() - started,
        trace: { traceId: trace.traceId, spanId: id },
        correlationId: trace.correlationId,
        causationId: cause,
        attributes: sanitize(attributes),
      };
      cause = id;
      if (events.length < 128) events.push(event);
      telemetry.enqueue(event);
    };
    emit("queued");
    try {
      signal?.throwIfAborted();
      emit("started");
      emit("progress");
      const result = await operation();
      emit("completed");
      return result;
    } catch (error) {
      emit(
        signal?.aborted || ["AbortError", "TimeoutError"].includes(error?.name)
          ? "cancelled"
          : "failed",
        {
          message: String(error?.message ?? error).slice(0, 2048),
        },
      );
      throw error;
    }
  };
  return { stage, events };
}
