import { describe, expect, it } from "vitest";

import { normalizeSharedEvent } from "./shared-event-adapter.js";

describe("shared application event adapter", () => {
  it("validates artifact review requests and results for the renderer", () => {
    const request = {
      requestId: "review-1",
      draftId: "draft-1",
      kind: "memory" as const,
      summary: "Remember the mixing habit",
      revision: 1,
      maxTopicsPerScope: 19,
      scopes: [
        {
          scope: "profile" as const,
          label: "Profile",
          meaning: "Everything you make",
          available: true,
          topicCount: 0,
        },
        {
          scope: "session" as const,
          label: "Session",
          meaning: "This conversation only",
          available: false,
          unavailableReason: "not saved",
        },
      ],
      files: [
        {
          id: "memory:mixing@profile",
          kind: "memory_topic" as const,
          name: "mixing",
          change: "added" as const,
          scope: "profile" as const,
          movable: true,
          after: "---\nname: mixing\ndescription: Mix.\n---\n",
          currentByScope: {},
        },
      ],
    };
    expect(
      normalizeSharedEvent(
        {
          type: "agent.artifact_review_requested",
          agentInstanceId: "00000000-0000-4000-8000-000000000001",
          request,
        },
        () => "message-1",
      ),
    ).toEqual({
      type: "agent.artifact_review_requested",
      agentInstanceId: "00000000-0000-4000-8000-000000000001",
      request,
    });
    expect(
      normalizeSharedEvent(
        {
          type: "agent.artifact_review_completed",
          requestId: "review-1",
          draftId: "draft-1",
          kind: "memory",
          outcome: "published",
          published: [
            { scope: "profile", path: "/memory/mixing.md", change: "added" },
          ],
        },
        () => "message-1",
      ),
    ).toMatchObject({ outcome: "published" });
    expect(() =>
      normalizeSharedEvent(
        {
          type: "agent.artifact_review_requested",
          request: { ...request, files: [] },
        },
        () => "message-1",
      ),
    ).toThrow();
  });

  it("maps shared operation events into stable desktop view models", () => {
    expect(
      normalizeSharedEvent(
        {
          type: "operation.failed",
          operationId: "op-1",
          label: "Inspect Ableton session",
          code: "bridge_timeout",
          message: "Timed out",
          retryable: true,
          arguments: { action: "inspect" },
          durationMs: 5_120,
          failureSource: "runtime",
          recovery: "Reconnect Ableton and retry.",
          toolName: "ableton_session",
          operationDescriptorId: "session.inspect",
          action: "inspect",
        } as never,
        () => "message-1",
      ),
    ).toMatchObject({
      type: "operation.changed",
      operation: {
        id: "op-1",
        status: "failed",
        retryable: true,
        toolName: "ableton_session",
        operationDescriptorId: "session.inspect",
        action: "inspect",
        durationMs: 5_120,
        failure: {
          source: "runtime",
          code: "bridge_timeout",
          message: "Timed out",
          recovery: "Reconnect Ableton and retry.",
        },
      },
    });
  });

  it("summarizes successful inspection inputs and structured results", () => {
    const event = normalizeSharedEvent(
      {
        type: "operation.completed",
        operationId: "op-parameters",
        label: "Inspect device parameters",
        summary: "Inspect device parameters completed",
        toolName: "ableton_devices",
        operationDescriptorId: "devices.inspect_parameters",
        action: "inspect-parameters",
        arguments: {
          action: "inspect-parameters",
          expectedName: "sine-kick",
          expectedDeviceName: "Operator",
          limit: 128,
        },
        result: JSON.stringify({
          totalParameters: 195,
          parameters: Array.from({ length: 128 }, (_, index) => ({
            index,
          })),
        }),
        durationMs: 420,
      },
      () => "message-parameters",
    );

    expect(event.type).toBe("operation.changed");
    if (event.type !== "operation.changed") {
      throw new Error("Expected an operation event");
    }
    expect(event.operation).toMatchObject({
      label: "Inspect device parameters · sine-kick › Operator",
      status: "completed",
      durationMs: 420,
      changed: [],
    });
    expect(event.operation.request?.details).toEqual([
      { label: "Expected Name", value: "sine-kick" },
      { label: "Expected Device Name", value: "Operator" },
      { label: "Limit", value: "128" },
    ]);
    expect(event.operation.outcome).toMatchObject({ kind: "observed" });
    expect(event.operation.outcome?.details).toEqual([
      { label: "Total Parameters", value: "195" },
      { label: "Parameters", value: "128 items" },
    ]);
  });

  it("sanitizes shell commands and attributes automatic policy blocks", () => {
    const spillPath =
      "/Users/test/.live-agent/profiles/default/copilot/tool-output/123-copilot-tool-output-abcdef.txt";
    const event = normalizeSharedEvent(
      {
        type: "operation.failed",
        operationId: "op-shell",
        label: "Run shell command",
        toolName: "bash",
        arguments: {
          command: `jq '.' '${spillPath}' --arg authorization 'Bearer abcdefghijklmnop'`,
        },
        code: "shell_policy_blocked",
        message: "Blocked by shell safety policy",
        failureSource: "application_policy",
        recovery:
          "tail from a starting line reads through end-of-file. Use bounded 'tail -n N' or select a bounded slice with jq.",
        details: {
          shellPolicy: { stage: "unbounded_output" },
        },
      },
      () => "message-shell",
    );

    expect(JSON.stringify(event)).not.toContain(spillPath);
    expect(JSON.stringify(event)).not.toContain("abcdefghijklmnop");
    expect(event.type).toBe("operation.changed");
    if (event.type !== "operation.changed") {
      throw new Error("Expected an operation event");
    }
    expect(event.operation.label).toBe("Run shell command");
    expect(event.operation.request?.details[0]).toMatchObject({
      label: "Command",
      format: "code",
    });
    expect(event.operation.request?.details[0]?.value).toContain(
      "<spill-file>",
    );
    expect(event.operation.failure).toMatchObject({
      source: "application_policy",
      code: "shell_policy_blocked",
      message: "Blocked by shell safety policy",
    });
    expect(event.operation.failure?.recovery).toContain("tail -n N");
    expect(event.operation.failure?.details[0]).toMatchObject({
      label: "Shell Policy",
      format: "code",
    });
    expect(event.operation.failure?.details[0]?.value).toContain(
      "unbounded_output",
    );
  });

  it("preserves grouped action metadata from operation arguments", () => {
    expect(
      normalizeSharedEvent(
        {
          type: "operation.started",
          operationId: "op-2",
          label: "Set Ableton tempo",
          toolName: "ableton_transport",
          arguments: { action: "set-tempo", tempo: 128 },
        },
        () => "message-2",
      ),
    ).toMatchObject({
      type: "operation.changed",
      operation: {
        toolName: "ableton_transport",
        action: "set-tempo",
      },
    });
  });

  it("carries sub-agent attribution into operation views", () => {
    expect(
      normalizeSharedEvent(
        {
          type: "operation.started",
          operationId: "op-sub",
          label: "Compose: Read session",
          toolName: "ableton_session",
          subagentLabel: ` ${"C".repeat(200)} `,
        },
        () => "message-sub",
      ),
    ).toMatchObject({
      type: "operation.changed",
      operation: { subagentLabel: "C".repeat(128) },
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
      () => "message-3",
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
        () => "message-4",
      ),
    ).toEqual({
      type: "diagnostic",
      level: "info",
      message:
        "Ableton workflow job 11111111-1111-4111-8111-111111111111: completed",
    });
  });
});
