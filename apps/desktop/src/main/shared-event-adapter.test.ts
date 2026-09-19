import { describe, expect, it } from "vitest";

import { normalizeSharedEvent } from "./shared-event-adapter.js";

describe("shared application event adapter", () => {
  it("maps shared operation events into stable desktop view models", () => {
    expect(
      normalizeSharedEvent(
        {
          type: "operation.failed",
          operationId: "op-1",
          code: "bridge_timeout",
          message: "Timed out",
          retryable: true,
          toolName: "ableton_session_inspect",
        },
        () => "message-1",
      ),
    ).toMatchObject({
      type: "operation.changed",
      operation: {
        id: "op-1",
        status: "failed",
        retryable: true,
        toolName: "ableton_session_inspect",
      },
    });
  });

  it("bounds shared tool names without rejecting shared punctuation", () => {
    const event = normalizeSharedEvent(
      {
        type: "operation.started",
        operationId: "op-2",
        label: "Custom tool",
        toolName: `custom:${"x".repeat(150)}`,
      },
      () => "message-2",
    );

    expect(event).toMatchObject({
      type: "operation.changed",
      operation: { toolName: `custom:${"x".repeat(121)}` },
    });
  });

  it("maps workflow jobs to bounded diagnostics", () => {
    expect(
      normalizeSharedEvent(
        {
          type: "ableton.event_received",
          event: "workflow_job.completed",
          sequence: 8,
          payload: {
            jobId: "11111111-1111-4111-8111-111111111111",
            status: "completed",
          },
        },
        () => "message-3",
      ),
    ).toEqual({
      type: "diagnostic",
      level: "info",
      message:
        "Ableton workflow job 11111111-1111-4111-8111-111111111111: completed",
    });
  });
});
