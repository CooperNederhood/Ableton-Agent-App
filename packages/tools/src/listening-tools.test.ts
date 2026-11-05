import { describe, expect, it, vi } from "vitest";
import {
  summarizeMetricListeningResult,
  projectMetricListeningReport,
} from "@ableton-agent/protocol";
import {
  createSyntheticPartialMetricListeningObservation,
  createSyntheticMetricListeningObservation,
} from "@ableton-agent/protocol/testing";

import {
  contextOperationParamsSchema,
  contextOperationResultSchema,
  MAX_METRIC_CONTEXT_RESPONSE_BYTES,
  createListeningTools,
  listeningOperationParamsSchema,
  listeningOperationResultSchema,
  LISTENING_AGENT_GUIDANCE,
} from "./listening-tools.js";
import {
  createAbletonMutationAuthorizer,
  resolveAbletonOperation,
} from "./index.js";

const reference = "00000000-0000-4000-8000-000000000001";
const sessionInput = {
  action: "play-session-and-listen",
  target: {
    view: "session",
    track: {
      kind: "regular",
      index: 0,
      expectedReference: reference,
      expectedName: "Audio",
    },
    sceneIndex: 0,
    expectedClipReference: "00000000-0000-4000-8000-000000000002",
    expectedClipName: "Sample",
  },
  listenerIds: ["tap-after"],
};

describe("optional listening tool contracts", () => {
  const reportEntry = {
    contextId: "context",
    passId: "pass",
    listenerId: "listener",
    subjectId: "subject",
    kind: "metric-audio-observation/v1" as const,
    createdAt: "2026-10-25T23:00:00.000Z",
    freshness: "unknown" as const,
    summary: "Stored metric report; not current source proof",
  };
  it("enforces the complete 64 KiB UTF-8 budget when a valid 48 KiB report fits but its entry does not", () => {
    expect(MAX_METRIC_CONTEXT_RESPONSE_BYTES).toBe(64 * 1024);
    const observation = createSyntheticMetricListeningObservation({
      tempoBpm: 20,
      endBeat: 10,
    });
    observation.limitations = Array.from({ length: 16 }, () =>
      "界".repeat(240),
    );
    for (const metric of Object.values(observation.metrics)) {
      metric.limitations = Array.from({ length: 8 }, () => "界".repeat(240));
    }
    const report = projectMetricListeningReport(observation, { limit: 32 });
    const valid = { action: "report", entry: reportEntry, report };
    expect(contextOperationResultSchema.parse(valid)).toEqual(valid);
    expect(
      new TextEncoder().encode(JSON.stringify(report)).byteLength,
    ).toBeLessThanOrEqual(48 * 1024);
    const oversized = {
      ...valid,
      entry: {
        ...reportEntry,
        createdAt: `2026-10-25T23:00:00.${"0".repeat(30_000)}Z`,
      },
    };
    expect(JSON.stringify(oversized).length).toBeLessThan(
      MAX_METRIC_CONTEXT_RESPONSE_BYTES,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeGreaterThan(MAX_METRIC_CONTEXT_RESPONSE_BYTES);
    const parsed = contextOperationResultSchema.safeParse(oversized);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Oversized response was accepted");
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0]?.message).toContain("64 KiB UTF-8");
  });
  it("defines strict deterministic report paging and a read-only attributed lifecycle", () => {
    expect(
      contextOperationParamsSchema.parse({
        action: "report",
        contextId: "context",
      }),
    ).toEqual({
      action: "report",
      contextId: "context",
      includeHistorical: false,
      offset: 0,
      limit: 8,
    });
    for (const extra of [
      { offset: -1 },
      { offset: 0.1 },
      { limit: 33 },
      { limit: 0 },
      { path: "audio.wav" },
      { sql: "select 1" },
    ]) {
      expect(
        contextOperationParamsSchema.safeParse({
          action: "report",
          contextId: "context",
          ...extra,
        }).success,
      ).toBe(false);
    }
    const operation = resolveAbletonOperation("ableton_context", {
      action: "report",
      contextId: "context",
    });
    expect(operation?.descriptor).toMatchObject({
      operationId: "context.report",
      risk: "read",
      mutationTarget: "read",
      editScope: "none",
      lifecycleEvents: {
        queued: "agent.operation.queued",
        started: "agent.operation.started",
        progress: "workflow_job.progress",
        completed: "agent.operation.completed",
        failed: "agent.operation.failed",
        cancelled: "agent.operation.cancelled",
      },
    });
    expect(
      operation?.descriptor.lifecycleIdentity({
        action: "report",
        contextId: "context",
      }),
    ).toMatchObject({ domain: "context", action: "report" });
  });

  it("accepts retained-position paging without renumbering selected metric rows", async () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.rows = [observation.rows[0]!, observation.rows[2]!];
    observation.reduction = {
      mode: "selected-report-rows",
      originalReportRows: 4,
      retainedReportRows: 2,
      authoritativeTimelines: "retained",
    };
    const report = projectMetricListeningReport(observation, {
      offset: 1,
      limit: 1,
    });
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({
        action: "report",
        entry: reportEntry,
        report,
      }),
    });
    const params = contextOperationParamsSchema.parse({
      action: "report",
      contextId: "context",
      offset: 1,
      limit: 1,
    });
    expect(
      await tool.handler?.(params, {
        sessionId: "sdk",
        toolCallId: "selected-row-call",
        toolName: "ableton_context",
        arguments: params,
      }),
    ).toMatchObject({
      action: "report",
      report: {
        offset: 1,
        nextOffset: null,
        totalRows: 2,
        reduction: observation.reduction,
        rows: [{ index: 2 }],
      },
    });
  });

  it("returns bounded stacked rows through the actual context handler and forwards explicit paging", async () => {
    const report = projectMetricListeningReport(
      createSyntheticMetricListeningObservation({ endBeat: 4 }),
      { offset: 8, limit: 2 },
    );
    const executeContextOperation = vi.fn(async () => ({
      action: "report" as const,
      entry: reportEntry,
      report,
    }));
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation,
    });
    const params = contextOperationParamsSchema.parse({
      action: "report",
      contextId: "context",
      offset: 8,
      limit: 2,
      includeHistorical: true,
    });
    const invocation = {
      sessionId: "sdk",
      toolCallId: "call",
      toolName: "ableton_context",
      arguments: params,
    };
    expect(await tool.handler?.(params, invocation)).toMatchObject({
      action: "report",
      report: { offset: 8, nextOffset: 10 },
    });
    expect(executeContextOperation).toHaveBeenCalledWith(params, invocation);
    expect(tool.description).toContain("follow report.nextOffset");
    expect(tool.description).toContain("missing/no-frame is not silence");
    expect(
      JSON.stringify(await tool.handler?.(params, invocation)),
    ).not.toContain('"observation":');
    for (const invalid of [
      projectMetricListeningReport(
        createSyntheticMetricListeningObservation({ endBeat: 4 }),
        { offset: 7, limit: 2 },
      ),
      projectMetricListeningReport(
        createSyntheticMetricListeningObservation({ endBeat: 4 }),
        { offset: 8, limit: 3 },
      ),
      projectMetricListeningReport(
        createSyntheticMetricListeningObservation({ endBeat: 4 }),
        { offset: 8, limit: 1 },
      ),
    ]) {
      executeContextOperation.mockResolvedValueOnce({
        action: "report",
        entry: reportEntry,
        report: invalid,
      });
      await expect(tool.handler?.(params, invocation)).rejects.toThrow(
        "page mismatch",
      );
    }
  });

  it("rejects fake spectral silence, excessive rows, unknown payloads and nonprogressing report responses", () => {
    const report = projectMetricListeningReport(
      createSyntheticMetricListeningObservation({ endBeat: 0.01 }),
    );
    const valid = { action: "report", entry: reportEntry, report };
    expect(contextOperationResultSchema.parse(valid)).toEqual(valid);
    const row = report.rows[0]!;
    for (const invalid of [
      {
        ...report,
        rows: [
          {
            ...row,
            "spectral-centroid": {
              ...row["spectral-centroid"],
              spectralEnergy: 0,
            },
          },
        ],
      },
      { ...report, rows: Array.from({ length: 33 }, () => row) },
      { ...report, nextOffset: 0 },
      { ...report, rows: [], totalRows: 2, nextOffset: 0 },
      { ...report, rawAudio: "forbidden" },
    ]) {
      expect(
        contextOperationResultSchema.safeParse({ ...valid, report: invalid })
          .success,
      ).toBe(false);
    }
    expect(
      contextOperationResultSchema.safeParse({
        ...valid,
        entry: { ...reportEntry, kind: "audio-observation/v1" },
      }).success,
    ).toBe(false);
  });

  it("guides the agent to read usable partial context without inventing evidence or retrying", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "stage=completed or stage=partial",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not full success or a failed tool",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "disclose missing metrics and intervals",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "silence and empty attack lists are evidence",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not a universal 300-row assumption",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "retry automatically to fill gaps",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("linear amplitudes, not dBFS");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "detector-window end, not a precise onset",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Partial attack coverage cannot establish absence",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Descriptive mode can accept disagreement above that advisory target",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("not a uniform audio delay");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Completion is not proof that observed disagreement is within the configured target",
    );
  });
  it("preserves zero-based beat phase and tempo-dependent interpretation", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "integer zero-based beat positions are on-beats; n+0.5 positions are offbeats",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Do not round fractional detector-window endpoints onto integer beats",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("sampleRate * 60 / tempoBpm");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "corroborate placement with native support and level-row intervals",
    );
  });
  it("keeps shared flatness/spread smoke diagnostics distinct from qualified context and forbids invented arguments", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not an extra capture or invented requestedMetrics argument",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "typed Desktop History, not the metric context/report",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "unqualified frame support and silence validity",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "do not invent flatness report values",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("or spread report values");
    expect(LISTENING_AGENT_GUIDANCE).toContain("nonnegative Hz values");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Delivery counts are not FFT frame counts",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not physical filter bandwidth or source count",
    );
  });
  it("returns partial as a published outcome rather than a failure or full success", () => {
    const job = {
      passId: "pass",
      stage: "partial",
      createdAt: "2026-10-25T23:00:00.000Z",
      updatedAt: "2026-10-25T23:00:01.000Z",
      durationMs: 1_000,
      contextIds: ["context"],
      metricResults: [
        summarizeMetricListeningResult(
          createSyntheticPartialMetricListeningObservation(),
        ),
      ],
    };
    expect(
      listeningOperationResultSchema.parse({ action: "get-pass", job }),
    ).toEqual({
      action: "get-pass",
      job,
    });
    for (const invalid of [
      { ...job, metricResults: undefined },
      { ...job, contextIds: [] },
      { ...job, error: "cleanup_failed" },
      { ...job, stage: "completed" },
    ])
      expect(
        listeningOperationResultSchema.safeParse({
          action: "get-pass",
          job: invalid,
        }).success,
      ).toBe(false);
  });
  it("preserves strict structured rejection evidence and optional absence in public jobs", () => {
    const job = {
      passId: "pass",
      stage: "failed",
      createdAt: "2026-10-25T23:00:00.000Z",
      updatedAt: "2026-10-25T23:00:01.000Z",
      durationMs: 1000,
      contextIds: [],
      error: "stale_native_preflight",
      failureEvidence: {
        schema: "listening-failure/v1",
        code: "stale_native_preflight",
        phase: "preflight",
        component: "native-controller",
        checkId: "native.preflight.accepted-clock",
        summary: "No accepted clocks",
        coverage: "complete",
        coverageReasons: [],
        facts: [
          {
            field: "acceptedClocks",
            actual: { state: "observed", value: 0 },
            expected: { state: "observed", value: 1 },
            comparison: "at-least",
          },
        ],
        reference: { passId: "pass", traceId: reference },
      },
    };
    expect(
      listeningOperationResultSchema.parse({ action: "get-pass", job }),
    ).toEqual({ action: "get-pass", job });
    expect(
      listeningOperationResultSchema.safeParse({
        action: "get-pass",
        job: {
          ...job,
          failureEvidence: { ...job.failureEvidence, rawAudio: [1] },
        },
      }).success,
    ).toBe(false);
    expect(
      listeningOperationResultSchema.safeParse({
        action: "get-pass",
        job: {
          ...job,
          failureEvidence: {
            ...job.failureEvidence,
            reference: { passId: "foreign", traceId: reference },
          },
        },
      }).success,
    ).toBe(false);
    const { failureEvidence: _evidence, ...legacy } = job;
    expect(_evidence).toBeDefined();
    expect(
      listeningOperationResultSchema.parse({ action: "get-pass", job: legacy }),
    ).not.toHaveProperty("job.failureEvidence");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not a permanent commissioning failure",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "An error code alone is not a precise cause",
    );
    expect(listeningOperationParamsSchema.options[0].description).toContain(
      "not evidence of an identity mismatch",
    );
  });

  it("explains exact action arguments, queued status and known-context retrieval before a call", () => {
    const [listening, context] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    expect(listening.description).toContain(
      "play-arrangement-and-listen requires listenerIds, startBeat and endBeat",
    );
    expect(listening.description).toContain("durationBeats is Session-only");
    expect(listening.description).toContain(
      "Queued or arming is not completion or failure",
    );
    expect(listening.description).toContain(
      "Use get-pass with the returned passId",
    );
    expect(listening.description).toContain("Never use bash or sleep to wait");
    expect(listening.description).toContain(
      "Arrangement capture is not read-only",
    );
    expect(listening.description).toContain(
      "Back to Arrangement restores the playback source, not the view",
    );
    expect(listening.description).toContain(
      "Switching views, stopping playback or deselecting a clip does not clear this override",
    );
    expect(listening.description).toContain(
      "never repair source selection or retry automatically",
    );
    expect(context.description).toContain(
      "When a contextId is already known, use get",
    );
    expect(context.description).toContain("list does not accept contextId");
    expect(context.description).not.toContain(
      "List compact summaries before requesting observation detail",
    );
  });

  it("describes guarded Session launch and uncertainty without promising isolation or cancellation rollback", () => {
    const [tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({
        action: "list",
        entries: [],
      }),
    });
    expect(tool.description).toContain(
      "Playback continues after completion, cancellation, failure, or timeout",
    );
    expect(tool.description).toContain("cancel stops capture, not transport");
    expect(tool.description).toContain(
      "Session requires a matching native listener supporting explicit Session mode (wire5)",
    );
    expect(tool.description).toContain(
      "independent level, spectral-centroid and attack timelines during one playback",
    );
    expect(tool.description).toContain(
      "A locally unavailable analyzer does not block healthy metrics",
    );
    expect(tool.description).not.toContain("wire3 or wire4");
    expect(tool.description).toContain(
      "stopped transport at a nonnegative position",
    );
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "stopped transport at a nonnegative position",
    );
    expect(tool.description).toContain("clip Global or One Bar quantization");
    expect(tool.description).toContain(
      "remembered active clips while transport is stopped",
    );
    expect(tool.description).not.toContain(
      "one-bar and nonzero stopped anchors are not qualified",
    );
    expect(tool.description).toContain(
      "unknown follow-action settings remain explicit",
    );
    expect(tool.description).toContain(
      "does not retract an accepted or queued launch",
    );
    expect(tool.description).toContain("otherwise no context is published");
    expect(tool.description).toContain("native_per_pass_validation_required");
    expect(tool.description).toContain("nonzero/fractional Arrangement starts");
    expect(tool.description).toContain("through 30 seconds");
    expect(tool.description).toContain(
      "Tempo stability is assumed, not independently verified",
    );
    expect(tool.description).toContain("tempo automation is unsupported");
    expect(tool.description).toContain("not absolute accuracy");
    expect(tool.description).toContain("There is no automatic legacy fallback");
    expect(tool.description).toContain("trusted Settings once per pass");
    expect(tool.description).toContain("even while ready=false");
    expect(tool.description).toContain(
      "genuine per-pass arm proof is required before playback",
    );
    expect(tool.description).toContain("complete coverage before publication");
    expect(tool.description).toContain(
      "Unsupported or unbound listeners remain denied",
    );
    expect(tool.description).toContain(
      "globally anchored quarter-beat report grid",
    );
    expect(tool.description).toContain(
      "independent 100 ms attack-detector cadence",
    );
    expect(tool.description).not.toContain("Descriptive v2");
    expect(tool.description).not.toContain(
      "one approximately 100 ms reporting hop",
    );
  });

  it("requires exact Session identity and defaults bounded capture", () => {
    expect(listeningOperationParamsSchema.parse(sessionInput)).toMatchObject({
      maximumDurationMs: 300_000,
    });
    expect(
      listeningOperationParamsSchema.parse(sessionInput),
    ).not.toHaveProperty("durationBeats");
    expect(
      listeningOperationParamsSchema.parse({
        ...sessionInput,
        durationBeats: 8.125,
      }),
    ).toMatchObject({ durationBeats: 8.125 });
    expect(
      listeningOperationParamsSchema.safeParse({
        ...sessionInput,
        target: { ...sessionInput.target, expectedClipReference: undefined },
      }).success,
    ).toBe(false);
  });

  it.each([
    { listenerIds: [] },
    { listenerIds: ["tap", "tap"] },
    { listenerIds: Array.from({ length: 9 }, (_, index) => `tap-${index}`) },
    { maximumDurationMs: 300_001 },
    { durationBeats: -1 },
    { listenerIds: ["tap-before", "tap-after"] },
    { durationBeats: Infinity },
    { rawAudio: [1, 2] },
  ])("rejects unsafe capture parameters %j", (patch) => {
    expect(
      listeningOperationParamsSchema.safeParse({
        ...sessionInput,
        ...patch,
      }).success,
    ).toBe(false);
  });

  it("rejects reversed Arrangement ranges without reaching a service", () => {
    expect(
      listeningOperationParamsSchema.safeParse({
        action: "play-arrangement-and-listen",
        listenerIds: ["tap"],
        startBeat: 16,
        endBeat: 8,
      }).success,
    ).toBe(false);
  });

  it("requires bounded explicit pruning and refuses arbitrary context writes", () => {
    expect(
      contextOperationParamsSchema.safeParse({
        action: "prune",
        contextIds: ["context-1"],
        confirm: "prune-session-context",
      }).success,
    ).toBe(true);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "prune",
        contextIds: ["context-1"],
      }).success,
    ).toBe(false);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "write",
        subjectId: "clip",
        value: { notes: "arbitrary" },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded opaque repository cursors independently of entity ID limits", () => {
    expect(
      contextOperationParamsSchema.safeParse({
        action: "list",
        cursor: "a".repeat(2048),
      }).success,
    ).toBe(true);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "list",
        cursor: "a".repeat(2049),
      }).success,
    ).toBe(false);
    expect(
      listeningOperationParamsSchema.safeParse({
        action: "list-passes",
        cursor: "a".repeat(2048),
      }).success,
    ).toBe(true);
  });

  it("preserves bounded repository continuation cursors in typed results", async () => {
    const nextCursor = "a".repeat(2048);
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({
        action: "list",
        entries: [],
        nextCursor,
      }),
    });
    const params = contextOperationParamsSchema.parse({ action: "list" });
    expect(
      await tool.handler?.(params, {
        sessionId: "sdk",
        toolCallId: "call",
        toolName: "ableton_context",
        arguments: params,
      }),
    ).toMatchObject({ action: "list", nextCursor });
  });

  it("classifies playback as session mutation and context pruning as destructive", () => {
    expect(
      resolveAbletonOperation("ableton_listening", sessionInput)?.descriptor,
    ).toMatchObject({
      risk: "reversible",
      mutationTarget: "session",
      editScope: "session",
      duration: "long",
    });
    expect(
      resolveAbletonOperation("ableton_context", {
        action: "prune",
        contextIds: ["context-1"],
        confirm: "prune-session-context",
      })?.descriptor,
    ).toMatchObject({ risk: "destructive", mutationTarget: "session" });
    const authorizer = createAbletonMutationAuthorizer([
      { name: "ableton_listening", mutationTarget: "session" },
    ]);
    expect(
      authorizer.authorize(
        {
          activeAgentConfig: {
            resolvedTools: ["ableton_listening"],
            editScope: [],
          },
          editScopeBindings: [],
        },
        { toolName: "ableton_listening", args: sessionInput },
      ),
    ).toMatchObject({ kind: "deny", code: "session_scope_required" });
  });

  it("uses the service only through bounded typed results and rejects action mismatch", async () => {
    const executeListeningOperation = vi.fn(async () => ({
      action: "inspect-listeners" as const,
      listeners: [],
      truncated: false,
    }));
    const [tool] = createListeningTools({
      executeListeningOperation,
      executeContextOperation: async () => ({
        action: "list",
        entries: [],
      }),
    });
    expect(
      await tool.handler?.(
        { action: "inspect-listeners" },
        {
          sessionId: "sdk",
          toolCallId: "call",
          toolName: "ableton_listening",
          arguments: { action: "inspect-listeners" },
        },
      ),
    ).toMatchObject({ action: "inspect-listeners", listeners: [] });
    expect(executeListeningOperation).toHaveBeenCalledOnce();
    expect(executeListeningOperation).toHaveBeenCalledWith(
      { action: "inspect-listeners" },
      expect.objectContaining({ sessionId: "sdk", toolCallId: "call" }),
    );
    await expect(
      tool.handler?.(
        { action: "get-pass", passId: "owned-pass" },
        {
          sessionId: "sdk",
          toolCallId: "call",
          toolName: "ableton_listening",
          arguments: { action: "get-pass", passId: "owned-pass" },
        },
      ),
    ).rejects.toThrow("action mismatch");
  });
});
