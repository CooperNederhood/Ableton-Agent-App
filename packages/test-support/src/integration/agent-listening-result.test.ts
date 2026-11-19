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
import { analysisPageSchema } from "@ableton-agent/tools";
import {
  extractListeningFeature,
  listeningFeatureDefinition,
} from "@ableton-agent/protocol";
import { melSmokeFixture } from "./mel-smoke-test-support.js";

function pinnedAnalysisFixture() {
  const f = melSmokeFixture();
  const geometry = f.observation.geometry;
  const range = { startBeat: 0, endBeat: 4 };
  const target = {
    kind: "capture",
    sessionId: f.owner.appSessionId,
    liveSetId: "set",
    contextId: f.contextId,
    coordinate: "clip-local-beats",
    range,
  };
  const features = (
    [
      "peak-summary/v1",
      "mel-shape/v1",
      "mel-region-summary/v1",
      "mel-ratio-summary/v1",
    ] as const
  ).map((type) => {
    const feature = extractListeningFeature(type, f.observation);
    const definition = listeningFeatureDefinition(type);
    return {
      type,
      units: definition.units,
      normalization: definition.normalization,
      dimensions: Array.from({ length: definition.dimensions }, (_, index) =>
        String(index),
      ),
      status: feature.status,
      reason: feature.reason,
      values: feature.values,
      coveredSamples: feature.coveredSamples,
      expectedSamples: feature.expectedSamples,
    };
  });
  const analysis = analysisPageSchema.parse({
    source: {
      name: "clip-1",
      nameTruncated: false,
      location: "Session",
      capturedAt: f.start.job.createdAt,
      coordinate: target.coordinate,
      observedRange: range,
      requestedRange: range,
      readTarget: target,
      freshness: "fresh",
      geometry: {
        sampleRate: geometry.sampleRate,
        tempoBpm: geometry.tempoBpm,
        captureStartSample: geometry.startSample,
        transportStartBeat: 0,
      },
    },
    readTarget: target,
    status: "ready",
    reason: null,
    overview: [],
    overviewIncluded: true,
    overviewExtent: range,
    timeline: [
      {
        kind: "segment-summary",
        segment: {
          ...range,
          kind: "unaligned",
          alignment: null,
          alignmentReason: "musical-bar-alignment-not-established",
          startSample: geometry.startSample,
          endSample: geometry.endSample,
          sampleRate: geometry.sampleRate,
        },
        ...range,
        elapsedStartSeconds: 0,
        elapsedEndSeconds: (4 * 60) / geometry.tempoBpm,
        fragment: 0,
        complete: true,
        features,
      },
    ],
    detail: {
      offset: 0,
      returnedItems: 1,
      totalItems: 1,
      truncated: false,
      nextCursor: null,
    },
  });
  const [call, result] = f.records.slice(2, 4);
  if (call?.kind !== "tool_call" || result?.kind !== "tool_result")
    throw new Error("fixture");
  call.arguments = { action: "read", target: f.start.summaries[0]!.readTarget };
  result.result = {
    result: {
      content: { action: "read", analyses: [analysis], nextCursor: null },
    },
  };
  return { ...f, analysis };
}

describe("agent listening result acceptance", () => {
  it.each(["native", "sum-and-mean"] as const)(
    "accepts a measured %s summary for basic listening without a detail read",
    (aggregation) => {
      const f = agentListeningFixture();
      const stepBeats = aggregation === "native" ? 0.25 : 0.5;
      const binCount = 4 / stepBeats;
      f.records.splice(2, 2);
      f.start.summaries[0]!.grid = {
        startBeat: 0,
        firstBinBeats: stepBeats,
        stepBeats,
        binCount,
        aggregation,
        attacks: [],
        attackCoverage: [],
        rmsAmplitude: Array<number>(binCount).fill(0.25),
        centroidHz: Array<null>(binCount).fill(null),
      };
      expect(() => verifyAgentListeningResult(f.input, "a")).not.toThrow();
    },
  );

  it("accepts a measured peak with no aligned summary grid", () => {
    const f = agentListeningFixture();
    f.records.splice(2, 2);
    f.start.summaries[0]!.peakAmplitude = 0.25;
    expect(() => verifyAgentListeningResult(f.input, "a")).not.toThrow();
  });

  it("does not substitute a measured grid for required mel detail", () => {
    const f = melSmokeFixture();
    f.records.splice(2, 2);
    f.start.summaries[0]!.grid = {
      startBeat: 0,
      firstBinBeats: 4,
      stepBeats: 4,
      binCount: 1,
      aggregation: "sum-and-mean",
      attacks: [],
      attackCoverage: [[0, 1]],
      rmsAmplitude: [0.25],
      centroidHz: [400],
    };
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow(
      "missing agent context consumption",
    );
  });

  it.each([
    "request",
    "summary",
    "unread-continuation",
    "initial-analyses",
  ] as const)("rejects %s when verifying mel detail", (fault) => {
    const f = pinnedAnalysisFixture();
    const [start, read] = f.records.slice(1, 3);
    if (start?.kind !== "tool_result" || read?.kind !== "tool_call")
      throw new Error("fixture");
    if (fault === "request") Reflect.deleteProperty(read.arguments, "target");
    if (fault === "summary")
      f.start.summaries[0]!.readTarget.sessionId = "foreign";
    if (fault === "unread-continuation") {
      const result = f.records[3];
      if (result?.kind !== "tool_result") throw new Error("fixture");
      Object.assign(f.analysis.detail, {
        totalItems: 2,
        truncated: true,
        nextCursor: "unread",
      });
      result.result = {
        result: {
          content: {
            action: "read",
            analyses: [f.analysis],
            nextCursor: "unread",
          },
        },
      };
    }
    if (fault === "initial-analyses")
      start.result = {
        result: { content: { ...f.start, analyses: [f.analysis] } },
      };
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow();
  });

  it.each([false, true])(
    "verifies mel values through a pinned detail read (resolved listener=%s)",
    (resolved) => {
      const f = pinnedAnalysisFixture();
      const call = f.records[0];
      if (call?.kind !== "tool_call") throw new Error("fixture");
      if (resolved) delete call.arguments.listenerIds;
      expect(() => verifyAgentListeningResult(f.input, "a")).not.toThrow();
    },
  );

  it.each([
    "context",
    "owner",
    "listener",
    "sample-rate",
    "extent",
    "units",
    "value",
    "missing-bands",
    "metadata-only",
  ])("rejects %s in delivered pinned analysis", (fault) => {
    const f = pinnedAnalysisFixture();
    const row = f.analysis.timeline[0]!;
    if (fault === "context") f.analysis.readTarget.contextId = "foreign";
    if (fault === "owner") f.analysis.readTarget.sessionId = "foreign";
    if (fault === "listener") {
      const call = f.records[0];
      if (call?.kind !== "tool_call") throw new Error("fixture");
      call.arguments.listenerIds = ["foreign"];
    }
    if (fault === "sample-rate") f.analysis.source.geometry!.sampleRate = 44100;
    if (fault === "extent") row.endBeat = 5;
    if (fault === "units") row.features[0]!.units = "Hz";
    if (fault === "value") row.features[1]!.values![0] = 0.99;
    if (fault === "missing-bands") {
      row.features[1]!.values!.pop();
      row.features[1]!.dimensions.pop();
    }
    if (fault === "metadata-only") row.features = [];
    expect(() => verifyAgentListeningResult(f.input, "a")).toThrow();
  });
  it("retains complete typed history of an explicitly paginated analysis result", () => {
    const f = agentListeningFixture();
    const record = f.records.find(
      (item) => item.kind === "tool_result" && item.toolCallId === "context",
    );
    if (record?.kind !== "tool_result") throw new Error("fixture");
    const target = {
      kind: "capture",
      sessionId: f.owner.appSessionId,
      liveSetId: "set",
      contextId: "context",
      coordinate: "clip-local-beats",
      range: { startBeat: 0, endBeat: 4 },
    };
    const analysis = {
      source: {
        name: "clip",
        nameTruncated: false,
        location: "Session",
        capturedAt: "2026-11-05T00:00:00.000Z",
        coordinate: "clip-local-beats",
        observedRange: target.range,
        requestedRange: target.range,
        readTarget: target,
        freshness: "fresh",
      },
      readTarget: target,
      status: "ready",
      reason: null,
      overview: [],
      overviewIncluded: true,
      timeline: [
        {
          kind: "support",
          segment: {
            ...target.range,
            startSample: 0,
            endSample: 96000,
            sampleRate: 48000,
            kind: "unaligned",
            alignment: null,
            alignmentReason: "musical-bar-alignment-not-established",
          },
          ...target.range,
          elapsedStartSeconds: 0,
          elapsedEndSeconds: 2,
          fragment: 0,
          complete: true,
          features: [],
          featureType: "peak-summary/v1",
          support: [0, 96000],
          supportCoordinate: "segment-relative-samples",
          supportChannel: "aggregate",
          supportOffset: 0,
        },
      ],
      overviewExtent: target.range,
      detail: {
        offset: 0,
        returnedItems: 1,
        totalItems: 2,
        truncated: true,
        nextCursor: "analysis-page-2",
      },
    };
    record.result = {
      result: {
        content: {
          action: "read",
          analyses: [analysis],
          nextCursor: "analysis-page-2",
        },
      },
    };
    expect(() =>
      validateAgentListeningEvidence(f.turn.agentListening),
    ).not.toThrow();
    analysis.detail.nextCursor = "";
    expect(() =>
      validateAgentListeningEvidence(f.turn.agentListening),
    ).toThrow();
    analysis.detail.nextCursor = "analysis-page-2";
    record.result = { ...record.result, truncated: true };
    expect(() =>
      validateAgentListeningEvidence(f.turn.agentListening),
    ).toThrow();
  });

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
    { count: 720, fieldLength: 12_000, admitted: true },
    { count: 1025, fieldLength: 0, admitted: false },
    { count: 900, fieldLength: 14_000, admitted: false },
  ])(
    "bounds complete paged History ($count records, $fieldLength-character fields)",
    async ({ count, fieldLength, admitted }) => {
      const f = agentListeningFixture();
      const original = f.records.find((record) => record.kind === "tool_call");
      if (!original) throw new Error("Missing fixture tool call");
      const records = Array.from({ length: count }, (_, index) => ({
        ...original,
        id: `page-call-${index}`,
        toolCallId: `page-call-${index}`,
        correlationId: `page-call-${index}`,
        metadata: {
          ...original.metadata,
          first: "x".repeat(fieldLength),
          second: "y".repeat(fieldLength),
        },
      }));
      let offset = 0;
      const collected = collectAgentListeningEvidence(
        f.owner,
        true,
        async () => {
          const page = records.slice(offset, offset + 100);
          offset += page.length;
          return agentHistoryPage(
            page,
            offset < records.length ? String(offset) : undefined,
            records.length,
          );
        },
      );
      if (admitted) {
        const evidence = await collected;
        expect(evidence.records).toHaveLength(count);
        expect(evidence.afterOwnedRestart).toBe(true);
        expect(evidence.records.at(-1)?.id).toBe(`page-call-${count - 1}`);
      } else {
        await expect(collected).rejects.toThrow("history bound exceeded");
      }
    },
  );
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
