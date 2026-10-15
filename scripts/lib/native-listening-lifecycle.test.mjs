import { describe, expect, it, vi } from "vitest";
import {
  sanitizeTelemetryAttributes,
  telemetryEventEnvelopeSchema,
} from "@ableton-agent/observability";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";

function fixture(signal) {
  const enqueue = vi.fn();
  return {
    enqueue,
    ...createNativeRunnerLifecycle({
      telemetry: { enqueue },
      sanitize: sanitizeTelemetryAttributes,
      signal,
      trace: {
        traceId: "00000000-0000-4000-8000-000000000001",
        correlationId: "run",
        causationId: "request",
      },
    }),
  };
}
describe("native runner application lifecycle", () => {
  it("records ordered timing and causal IDs for success", async () => {
    const f = fixture();
    expect(await f.stage("fixture-stage", async () => 42)).toBe(42);
    expect(f.events.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    for (const [index, event] of f.events.entries()) {
      expect(() => telemetryEventEnvelopeSchema.parse(event)).not.toThrow();
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.causationId).toBe(
        index === 0 ? "request" : f.events[index - 1].id,
      );
    }
    expect(f.enqueue).toHaveBeenCalledTimes(4);
  });
  it("records bounded redacted failure and cancellation without starting aborted operations", async () => {
    const f = fixture();
    await expect(
      f.stage("actor-turn", async () => {
        throw new Error(`Bearer ghp_${"a".repeat(40)}`);
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(f.events)).not.toContain("ghp_");
    expect(f.events.at(-1).stage).toBe("failed");
    const abort = new globalThis.AbortController();
    abort.abort(new Error("cancelled"));
    const cancelled = fixture(abort.signal);
    const operation = vi.fn();
    await expect(cancelled.stage("fixture-stage", operation)).rejects.toThrow(
      "cancelled",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(cancelled.events.map((event) => event.stage)).toEqual([
      "queued",
      "cancelled",
    ]);
  });
});
