import { describe, expect, it } from "vitest";

import {
  currentCorrelationContext,
  currentCorrelationId,
  registerCorrelationContext,
  unregisterCorrelationContext,
  withCorrelation,
  type CorrelationTraceContext,
} from "./index.js";

describe("correlation context", () => {
  it("carries explicit deferred-job traces without mutating the SDK registration", async () => {
    const upstream: CorrelationTraceContext = {
      correlationId: "shared",
      traceId: "sdk-trace",
      activeAgentId: "sdk-agent",
    };
    registerCorrelationContext(upstream);
    try {
      await withCorrelation(
        {
          correlationId: upstream.correlationId,
          traceId: "capture-trace",
          causationId: "capture-stage",
          sessionId: "app-session",
          liveSetId: "live-set",
          activeAgentId: "capture-agent",
        },
        async () => {
          await Promise.resolve();
          expect(currentCorrelationContext()).toEqual({
            correlationId: upstream.correlationId,
            traceId: "capture-trace",
            causationId: "capture-stage",
            sessionId: "app-session",
            liveSetId: "live-set",
            activeAgentId: "capture-agent",
          });
        },
      );
      expect(withCorrelation("shared", currentCorrelationContext)).toEqual(
        upstream,
      );
      expect(currentCorrelationContext()).toBeUndefined();
    } finally {
      unregisterCorrelationContext("shared");
    }
  });

  it("isolates concurrent explicit contexts and restores parent scope after failure", async () => {
    await withCorrelation("parent", async () => {
      await Promise.all(
        ["first", "second"].map(async (activeAgentId) => {
          await withCorrelation(
            { correlationId: "same", activeAgentId },
            async () => {
              await Promise.resolve();
              expect(currentCorrelationContext()?.activeAgentId).toBe(
                activeAgentId,
              );
            },
          );
        }),
      );
      await expect(
        withCorrelation(
          { correlationId: "child", activeAgentId: "failed" },
          async () => {
            await Promise.resolve();
            throw new Error("capture failed");
          },
        ),
      ).rejects.toThrow("capture failed");
      expect(currentCorrelationContext()).toEqual({ correlationId: "parent" });
    });
    expect(currentCorrelationContext()).toBeUndefined();
  });

  it("preserves an operation ID across asynchronous boundaries", async () => {
    expect(currentCorrelationId()).toBeUndefined();
    await withCorrelation("tool-1", async () => {
      await Promise.resolve();
      expect(currentCorrelationId()).toBe("tool-1");
    });
    expect(currentCorrelationId()).toBeUndefined();
  });

  it("attaches and removes registered upstream trace context", () => {
    registerCorrelationContext({
      correlationId: "tool-2",
      traceId: "00000000-0000-4000-8000-000000000001",
      parentSpanId: "00000000-0000-4000-8000-000000000002",
      toolName: "ableton_session",
      operationId: "session.connection_status",
      action: "connection-status",
    });
    expect(
      withCorrelation("tool-2", () => currentCorrelationContext()),
    ).toMatchObject({
      correlationId: "tool-2",
      traceId: "00000000-0000-4000-8000-000000000001",
      parentSpanId: "00000000-0000-4000-8000-000000000002",
      toolName: "ableton_session",
      operationId: "session.connection_status",
      action: "connection-status",
    });
    unregisterCorrelationContext("tool-2");
    expect(
      withCorrelation("tool-2", () => currentCorrelationContext()),
    ).toEqual({ correlationId: "tool-2" });
  });
});
