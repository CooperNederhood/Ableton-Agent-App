import { describe, expect, it, vi } from "vitest";
import type { CopilotAgentServiceOptions } from "@ableton-agent/application";
import type { NonBlockingObservabilityRecorder } from "@ableton-agent/observability";
import { createDesktopContextReader } from "./desktop-context-reader.js";

type Execute = NonNullable<
  CopilotAgentServiceOptions["executeContextOperation"]
>;
const request = { sessionId: "session", includeHistorical: false, limit: 20 };

describe("typed application-owned Desktop context reads", () => {
  it("accepts omitted query defaults at the public input boundary", async () => {
    const execute = vi.fn<Execute>(async (parameters) => {
      if (parameters.action === "get") throw new Error("Context not found");
      return { action: "list", entries: [] };
    });
    const reader = createDesktopContextReader({ execute });
    await reader.list({ sessionId: "session" });
    expect(execute.mock.calls[0]?.[0]).toEqual({
      action: "list",
      includeHistorical: false,
      limit: 20,
    });
    await expect(
      reader.get({ sessionId: "session", contextId: "missing" }),
    ).rejects.toThrow("Context not found");
    expect(execute.mock.calls[1]?.[0]).toEqual({
      action: "get",
      contextId: "missing",
      includeHistorical: false,
    });
  });

  it("uses explicit session ownership and fresh UI traces without impersonating an agent", async () => {
    const execute = vi.fn<Execute>(async () => ({
      action: "list",
      entries: [],
    }));
    const reader = createDesktopContextReader({ execute });
    await reader.list(request);
    await reader.list({ ...request, sessionId: "other-session" });
    const first = execute.mock.calls[0];
    if (first === undefined) throw new Error("Missing query invocation");
    expect(first[0]).toEqual({
      action: "list",
      includeHistorical: false,
      limit: 20,
    });
    expect(first[1]).toMatchObject({
      sessionId: "session",
      actorKind: "application",
      agentId: "desktop-context",
    });
    for (const id of Object.values(first[1].trace)) {
      expect(id).toMatch(/^[a-f0-9-]{36}$/u);
    }
    expect(execute.mock.calls[1]?.[1].sessionId).toBe("other-session");
    expect(execute.mock.calls[1]?.[1].trace.traceId).not.toBe(
      execute.mock.calls[0]?.[1].trace.traceId,
    );
  });

  it("propagates the validated preload trace to the application repository boundary", async () => {
    const execute = vi.fn<Execute>(async () => ({
      action: "list",
      entries: [],
    }));
    const reader = createDesktopContextReader({ execute });
    const trace = {
      traceId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000002",
      causationId: "00000000-0000-4000-8000-000000000003",
    };
    await reader.list({ ...request, trace });
    expect(execute.mock.calls[0]?.[1].trace).toEqual(trace);
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("trace");
  });
  it("rejects renderer SQL, paths, writes, oversize pages and mismatched result actions", async () => {
    const execute = vi.fn<Execute>(async () => ({
      action: "list",
      entries: [],
    }));
    const reader = createDesktopContextReader({ execute });
    for (const invalid of [
      { ...request, sql: "SELECT * FROM entries" },
      { ...request, path: "/tmp/foreign.sqlite" },
      { ...request, action: "prune" },
      { ...request, limit: 101 },
    ]) {
      await expect(reader.list(invalid)).rejects.toThrow();
    }
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ action: "prune", prunedContextIds: [] });
    await expect(reader.list(request)).rejects.toThrow();
  });

  it("surfaces redacted recovery errors instead of returning an empty page", async () => {
    const execute = vi.fn<Execute>(async () => {
      throw new Error(
        "Context file missing; Authorization: Bearer super-secret-fixture",
      );
    });
    const reader = createDesktopContextReader({ execute });
    await expect(reader.list(request)).rejects.toThrow("Context file missing");
    await expect(reader.list(request)).rejects.not.toThrow(
      "super-secret-fixture",
    );
  });

  it("records ordered, timed application query events with the same explicit trace", async () => {
    const enqueue = vi.fn<NonBlockingObservabilityRecorder["enqueue"]>();
    const execute = vi.fn<Execute>(async () => ({
      action: "list",
      entries: [],
    }));
    const reader = createDesktopContextReader({
      execute,
      telemetry: { enqueue },
    });
    await reader.list(request);
    const events = enqueue.mock.calls.map(([event]) => event);
    expect(events.map((event) => event.name)).toEqual([
      "desktop.entity_context.queued",
      "desktop.entity_context.started",
      "desktop.entity_context.completed",
    ]);
    const trace = execute.mock.calls[0]?.[1].trace;
    for (const event of events) {
      expect(event).toMatchObject({
        category: "application",
        sessionId: "session",
        correlationId: trace?.correlationId,
        causationId: trace?.causationId,
        trace: { traceId: trace?.traceId },
        attributes: { action: "list", actorKind: "application" },
      });
      expect(event).not.toHaveProperty("activeAgentId");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(events.map((event) => event.trace?.spanId)).size).toBe(1);
  });

  it.each(["Error", "AbortError"])(
    "records bounded redacted %s failures without a success event",
    async (name) => {
      const enqueue = vi.fn<NonBlockingObservabilityRecorder["enqueue"]>();
      const execute = vi.fn<Execute>(async () => {
        const error = new Error(
          `Authorization: Bearer fixture-secret-token ${"x".repeat(10_000)}`,
        );
        error.name = name;
        throw error;
      });
      const reader = createDesktopContextReader({
        execute,
        telemetry: { enqueue },
      });
      await expect(reader.list(request)).rejects.not.toThrow(
        "fixture-secret-token",
      );
      const events = enqueue.mock.calls.map(([event]) => event);
      expect(events.map((event) => event.name)).toEqual([
        "desktop.entity_context.queued",
        "desktop.entity_context.started",
        `desktop.entity_context.${name === "AbortError" ? "cancelled" : "failed"}`,
      ]);
      expect(JSON.stringify(events)).not.toContain("fixture-secret-token");
      expect(String(events[2]?.attributes.error).length).toBeLessThanOrEqual(
        2048,
      );
    },
  );
});
