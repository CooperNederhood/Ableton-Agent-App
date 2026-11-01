import { describe, expect, it, vi } from "vitest";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";

import { createIntegrationTelemetry } from "./ableton-integrations-observability.js";

describe("integration installation telemetry", () => {
  it("propagates one trace with component child spans and redacts before persistence", async () => {
    const sink = {
      enqueue: vi.fn<(event: TelemetryEventEnvelope) => void>(),
      enqueueConfigurationSnapshot: vi.fn(),
    };
    const onFailure = vi.fn();
    const record = createIntegrationTelemetry({
      sink,
      trace: {
        traceId: "00000000-0000-4000-8000-000000000001",
        correlationId: "reinstall",
        causationId: "reinstall-start",
      },
      profile: "studio",
      now: () => new Date("2026-10-24T20:00:00Z"),
      onFailure,
    });
    record({
      name: "ableton.integrations.install",
      stage: "started",
      durationMs: 0,
    });
    for (const stage of ["queued", "started", "progress", "completed"] as const)
      record({
        name: "ableton.integrations.component",
        component: "machine-listening",
        stage,
        durationMs: 12,
        attributes: {
          message: "Authorization: Bearer installation-secret",
          content: Buffer.from([1, 2, 3]),
        },
      });
    await new Promise<void>((done) => setImmediate(done));
    const events = sink.enqueue.mock.calls.map(([event]) => event);
    expect(events).toHaveLength(5);
    expect(events.map(({ stage }) => stage)).toEqual([
      "started",
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    expect(
      events.every(
        ({ trace }) =>
          trace?.traceId === "00000000-0000-4000-8000-000000000001",
      ),
    ).toBe(true);
    expect(
      events.every(
        ({ correlationId, causationId }) =>
          correlationId === "reinstall" && causationId === "reinstall-start",
      ),
    ).toBe(true);
    const root = events[0]?.trace?.spanId;
    expect(root).toBeDefined();
    expect(
      events.slice(1).every(({ trace }) => trace?.parentSpanId === root),
    ).toBe(true);
    expect(
      new Set(events.slice(1).map(({ trace }) => trace?.spanId)).size,
    ).toBe(1);
    expect(events[4]).toMatchObject({ durationMs: 12, outcome: "success" });
    expect(JSON.stringify(events)).not.toContain("installation-secret");
    expect(JSON.stringify(events)).toContain("omitted");
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("records failure/cancellation and explicitly reports a persistence failure", async () => {
    const events: unknown[] = [];
    const onFailure = vi.fn();
    const record = createIntegrationTelemetry({
      sink: {
        enqueue: (event) => {
          events.push(event);
          if (event.stage === "cancelled")
            throw new Error("journal unavailable");
        },
        enqueueConfigurationSnapshot: () => undefined,
      },
      trace: {
        traceId: "00000000-0000-4000-8000-000000000001",
        correlationId: "trace",
        causationId: "cause",
      },
      profile: "default",
      onFailure,
    });
    record({
      name: "ableton.integrations.install",
      stage: "failed",
      durationMs: 4,
    });
    record({
      name: "ableton.integrations.install",
      stage: "cancelled",
      durationMs: 5,
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(events).toMatchObject([
      { stage: "failed", level: "error", outcome: "failure", durationMs: 4 },
      { stage: "cancelled", outcome: "cancelled", durationMs: 5 },
    ]);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "journal unavailable" }),
    );
  });
});
