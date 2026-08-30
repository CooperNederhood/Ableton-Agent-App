import { describe, expect, it } from "vitest";

import {
  currentCorrelationContext,
  currentCorrelationId,
  registerCorrelationContext,
  unregisterCorrelationContext,
  withCorrelation,
} from "./index.js";

describe("correlation context", () => {
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
      toolName: "ableton_connection_status",
    });
    expect(
      withCorrelation("tool-2", () => currentCorrelationContext()),
    ).toMatchObject({
      correlationId: "tool-2",
      traceId: "00000000-0000-4000-8000-000000000001",
      parentSpanId: "00000000-0000-4000-8000-000000000002",
      toolName: "ableton_connection_status",
    });
    unregisterCorrelationContext("tool-2");
    expect(
      withCorrelation("tool-2", () => currentCorrelationContext()),
    ).toEqual({ correlationId: "tool-2" });
  });
});
