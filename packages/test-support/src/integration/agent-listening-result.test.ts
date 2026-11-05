import { describe, expect, it, vi } from "vitest";
import { createDefaultAssertions } from "./assertions.js";
import {
  collectAgentListeningEvidence,
  validateAgentListeningEvidence,
  verifyAgentListeningResult,
  verifyRestoredAgentListeningEvidence,
} from "./agent-listening-result.js";
import {
  agentHistoryPage,
  agentListeningFixture,
} from "./agent-listening-test-support.js";
import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import { validateTurn } from "./validation.js";

describe("agent listening result acceptance", () => {
  it("requires typed agent consumption rather than backend-only success", () => {
    const registry = createDefaultAssertions();
    const { fixture, baseline } = agentListeningFixture().input;
    expect(registry.names.has("agent-listening-result")).toBe(true);
    expect(
      registry.evaluate(
        { name: "agent-listening-result", parameters: { sourceId: "a" } },
        { fixture, baseline, turns: [] },
      ).passed,
    ).toBe(false);
  });
  it.each(["get", "report"] as const)(
    "proves SDK %s content before the final answer",
    async (action) => {
      const f = agentListeningFixture(action);
      expect(() => verifyAgentListeningResult(f.input, "a")).not.toThrow();
      const read = vi
        .fn()
        .mockResolvedValueOnce(
          agentHistoryPage(f.records.slice(0, 3), "next", 6),
        )
        .mockResolvedValueOnce(
          agentHistoryPage(f.records.slice(3), undefined, 6),
        );
      const evidence = await collectAgentListeningEvidence(
        f.owner,
        false,
        read,
      );
      expect(evidence).toEqual(f.turn.agentListening);
      validateTurn(f.turn);
      const receipt = {
        turns: [f.turn],
        evidence: {
          agentListening: [{ ...evidence, afterOwnedRestart: true }],
        },
      };
      expect(sanitizeTelemetryAttributes(receipt)).toEqual(receipt);
      expect(read).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ...{
            appSessionId: "app",
            agentSessionId: "sdk",
            activeAgentId: "default",
            turnId: f.owner.sdkTurnId,
          },
          cursor: "next",
        }),
      );
      verifyRestoredAgentListeningEvidence(
        [f.turn],
        [{ ...evidence, afterOwnedRestart: true }],
      );
    },
  );
  it.each([
    "queued",
    "partial",
    "wrong-pass",
    "wrong-context",
    "missing-read",
    "runner-read",
    "agent",
    "app-session",
    "conversation",
    "turn",
    "trace",
    "correlation",
    "causation",
    "failure",
    "cancelled",
    "structured-failure",
    "late-result",
    "early-read",
    "additional-capture",
    "orphan-result",
    "truncated",
    "missing-content",
    "wrong-measurement",
    "wrong-answer",
    "failed-turn",
    "missing-duration",
  ])("rejects %s even with successful backend capture/publication", (fault) => {
    const f = agentListeningFixture();
    const startResult = f.records.find(
      (r) => r.kind === "tool_result" && r.toolCallId === "start",
    )!;
    const contextResult = f.records.find(
      (r) => r.kind === "tool_result" && r.toolCallId === "context",
    )!;
    const call = f.records.find(
      (r) => r.kind === "tool_call" && r.toolCallId === "context",
    )!;
    if (
      startResult.kind !== "tool_result" ||
      contextResult.kind !== "tool_result" ||
      call.kind !== "tool_call"
    )
      throw new Error("fixture");
    if (fault === "queued" || fault === "partial") f.start.job.stage = fault;
    if (fault === "wrong-pass")
      f.start.job.passId = "1b295ab8-5018-4ce6-8966-8e6b4ce40454";
    if (fault === "wrong-context") f.start.job.contextIds = ["foreign"];
    startResult.result = { result: { content: JSON.stringify(f.start) } };
    if (fault === "missing-read" || fault === "runner-read")
      f.records.splice(2, 2);
    if (fault === "agent") contextResult.activeAgentId = "runner";
    if (fault === "app-session") contextResult.appSessionId = "foreign";
    if (fault === "conversation") contextResult.agentSessionId = "foreign";
    if (fault === "turn") contextResult.turnId = "foreign";
    if (fault === "trace")
      contextResult.traceId = "00000000-0000-4000-8000-000000000099";
    if (fault === "correlation") contextResult.correlationId = "foreign";
    if (fault === "causation") contextResult.causationId = "foreign";
    if (fault === "failure") contextResult.outcome = "failure";
    if (fault === "cancelled") contextResult.outcome = "cancelled";
    if (fault === "structured-failure")
      contextResult.result = {
        result: { content: JSON.stringify({ resultType: "failure" }) },
      };
    if (fault === "late-result")
      contextResult.occurredAt = "2026-11-05T00:00:07.000Z";
    if (fault === "early-read") contextResult.durationMs = 3000;
    if (fault === "additional-capture") {
      const startCall = f.records.find(
        (r) => r.kind === "tool_call" && r.toolCallId === "start",
      )!;
      if (startCall.kind !== "tool_call") throw new Error("fixture");
      f.records.push(
        {
          ...startCall,
          id: "extra-call",
          toolCallId: "extra",
          correlationId: "extra",
        },
        {
          ...startResult,
          id: "extra-result",
          toolCallId: "extra",
          correlationId: "extra",
        },
      );
    }
    if (fault === "orphan-result") f.records.splice(0, 1);
    if (fault === "truncated") contextResult.result = { truncated: true };
    if (fault === "missing-content") contextResult.result = {};
    if (fault === "wrong-measurement") {
      f.context.entry.passId = "foreign";
      contextResult.result = { result: { content: JSON.stringify(f.context) } };
    }
    if (fault === "wrong-answer")
      f.records.find((r) => r.kind === "message")!.content = "Foreign answer";
    if (fault === "failed-turn") {
      const terminal = f.records.find((r) => r.kind === "turn")!;
      terminal.status = "failed";
    }
    if (fault === "missing-duration") delete contextResult.durationMs;
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow();
  });
  it("reproduces run-GUn1Ho: backend completes, queued original result, wrong-ID denials, no context read", () => {
    const f = agentListeningFixture();
    f.records.splice(2, 2);
    const original = f.records[1]!;
    if (original.kind !== "tool_result") throw new Error("fixture");
    original.result = {
      result: {
        content: JSON.stringify({
          ...f.start,
          job: { ...f.start.job, stage: "queued", contextIds: [] },
        }),
      },
    };
    for (const [index, passId] of [
      "1b295ab8-5018-4ce6-8966-8e6b4caf0454-malformed-long-id",
      "1b295ab8-5018-4ce6-8966-8e6b4ce40454",
    ].entries()) {
      const call = f.records[0]!;
      if (call.kind !== "tool_call") throw new Error("fixture");
      f.records.push(
        {
          ...call,
          id: `bad-call-${index}`,
          toolCallId: `bad-${index}`,
          correlationId: `bad-${index}`,
          status: "failed",
          arguments: { action: "get-pass", passId },
        },
        {
          ...original,
          id: `bad-result-${index}`,
          toolCallId: `bad-${index}`,
          correlationId: `bad-${index}`,
          outcome: "failure",
          result: undefined,
          error: "permission_denied passExists=false",
        },
      );
    }
    expect(f.turn.captures[0]?.complete).toBe(true);
    expect(f.turn.contexts[0]?.readable).toBe(true);
    expect(
      createDefaultAssertions().evaluate(
        { name: "agent-listening-result", parameters: { sourceId: "a" } },
        f.input,
      ).passed,
    ).toBe(false);
  });
  it("allows explicit successful same-pass inspection but never uses it to repair a queued original result", () => {
    const f = agentListeningFixture();
    const call = f.records.find((r) => r.kind === "tool_call")!;
    const result = f.records.find((r) => r.kind === "tool_result")!;
    const inspection = {
      ...f.start,
      action: "get-pass",
      job: { ...f.start.job },
    };
    f.records.push(
      {
        ...call,
        id: "inspect-call",
        toolCallId: "inspect",
        correlationId: "inspect",
        arguments: { action: "get-pass", passId: f.passId },
      },
      {
        ...result,
        id: "inspect-result",
        toolCallId: "inspect",
        correlationId: "inspect",
        result: { result: { content: inspection } },
      },
    );
    expect(() => verifyAgentListeningResult(f.input, "a")).not.toThrow();
    f.start.job.stage = "queued";
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow(
      "original start",
    );
  });
  it.each(["wrong-context", "empty-rows", "wrong-coverage"] as const)(
    "rejects %s report content",
    (fault) => {
      const f = agentListeningFixture("report");
      if (!("report" in f.context)) throw new Error("fixture");
      if (fault === "wrong-context") f.context.entry.contextId = "foreign";
      if (fault === "empty-rows") f.context.report.rows = [];
      if (fault === "wrong-coverage")
        f.context.report.sourceCoverage.endSample += 1;
      expect(() => verifyAgentListeningResult(f.input, "a")).toThrow();
    },
  );
  it("sanitizes retained credentials and fails omitted audio/truncation rather than accepting partial evidence", async () => {
    const f = agentListeningFixture();
    const call = f.records.find((r) => r.kind === "tool_call")!;
    call.metadata.note = "Bearer very-private";
    const evidence = await collectAgentListeningEvidence(
      f.owner,
      false,
      async () => agentHistoryPage(f.records),
    );
    expect(JSON.stringify(evidence)).not.toContain("very-private");
    expect(JSON.stringify(evidence)).toContain("[REDACTED]");
    call.metadata.audioBody = "audio-bytes";
    await expect(
      collectAgentListeningEvidence(f.owner, false, async () =>
        agentHistoryPage(f.records),
      ),
    ).rejects.toThrow("truncated");
  });
  it.each([
    "cursor",
    "missing-page",
    "oversize",
    "duplicate",
    "absent",
    "foreign",
    "failed-query",
  ])("rejects %s typed collection", async (fault) => {
    const f = agentListeningFixture();
    if (fault === "oversize")
      f.records.find((r) => r.kind === "tool_call")!.metadata.note = "x".repeat(
        9 * 1024 * 1024,
      );
    if (fault === "duplicate") f.records.push(f.records[0]!);
    if (fault === "absent") f.records.splice(0);
    if (fault === "foreign") f.records[0]!.appSessionId = "other";
    const read = vi.fn(async () => {
      if (fault === "failed-query") throw new Error("journal unavailable");
      const page = agentHistoryPage(
        f.records,
        fault === "cursor" ? "repeat" : undefined,
      );
      if (fault === "missing-page") page.page.hasMore = true;
      return page;
    });
    await expect(
      collectAgentListeningEvidence(f.owner, false, read),
    ).rejects.toThrow();
  });
  it("rejects edited, missing, cached and unsanitized persisted records", () => {
    const f = agentListeningFixture();
    expect(() => verifyRestoredAgentListeningEvidence([f.turn], [])).toThrow();
    expect(() =>
      verifyRestoredAgentListeningEvidence([f.turn], [f.turn.agentListening!]),
    ).toThrow();
    const restored = structuredClone({
      ...f.turn.agentListening!,
      afterOwnedRestart: true,
    });
    const call = restored.records.find((r) => r.kind === "tool_call")!;
    call.metadata.changed = true;
    expect(() =>
      verifyRestoredAgentListeningEvidence([f.turn], [restored]),
    ).toThrow();
    call.metadata.secret = "private";
    expect(() => validateAgentListeningEvidence(restored)).toThrow(
      "unsanitized",
    );
  });
});
