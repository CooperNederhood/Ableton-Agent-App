import { describe, expect, it, vi } from "vitest";
import { denseSyntheticMetricObservation } from "./listening-report-test-support.js";
import {
  summarizeMetricListeningResult,
  projectMetricListeningReport,
  nativeMetricObservationMetricSchema,
  deriveMelBandFrame,
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
  it("classifies feature derivation as local mutation, while comparisons and search are reads", () => {
    expect(
      resolveAbletonOperation("ableton_context", {
        action: "derive-features",
        contextIds: ["entry"],
      })?.descriptor,
    ).toMatchObject({
      operationId: "context.derive-features",
      risk: "reversible",
      mutationTarget: "session",
    });
    for (const action of [
      "feature-definitions",
      "list-features",
      "search-features",
    ]) {
      const input =
        action === "search-features"
          ? { action, featureId: "feature" }
          : { action };
      expect(
        resolveAbletonOperation("ableton_context", input)?.descriptor,
      ).toMatchObject({
        risk: "read",
        mutationTarget: "read",
      });
    }
  });
  it("bounds feature access and rejects implicit capture, arbitrary distance and raw query inputs", () => {
    expect(
      contextOperationParamsSchema.parse({
        action: "search-features",
        featureId: "feature",
      }),
    ).toMatchObject({
      limit: 10,
      candidateLimit: 1_000,
      excludeContextIds: [],
    });
    for (const extra of [
      { candidateLimit: 1_001 },
      { limit: 21 },
      { distance: "custom" },
      { sql: "SELECT *" },
      { capture: true },
    ]) {
      expect(
        contextOperationParamsSchema.safeParse({
          action: "search-features",
          featureId: "feature",
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      contextOperationParamsSchema.safeParse({
        action: "derive-features",
        contextIds: ["same", "same"],
      }).success,
    ).toBe(false);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "derive-features",
        contextIds: ["source"],
        musicalAlignment: {
          barOriginBeat: 0,
          meter: { numerator: 4, denominator: 4 },
        },
      }).success,
    ).toBe(false);
  });
  it("distinguishes authoritative pitch from historical diagnostics and limits accuracy claims", () => {
    for (const statement of [
      "monophonic-pitch smoke diagnostics",
      "YinFFT",
      "50-2000 Hz",
      "0 Hz is the undefined sentinel",
      "not a calibrated probability",
      "not proof of noise",
      "Historical polled diagnostics cannot be promoted into frames",
      "not verified pitch or input class",
      "2000 Hz sine produces a high-confidence estimate near 1000 Hz",
      "zero confidence is a legitimate score",
      "octave errors",
      "polyphonic mixtures",
    ])
      expect(LISTENING_AGENT_GUIDANCE).toContain(statement);
    expect(
      listeningOperationParamsSchema.safeParse({
        ...sessionInput,
        requestedMetrics: ["monophonic-pitch"],
      }).success,
    ).toBe(false);
  });
  it("directs pitch requests to bounded authoritative reports without filesystem fallback or retries", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      'For pitch requests, use ableton_context action "report"',
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "read authoritative pitch frames and their paired Hz/confidence when present",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "If authoritative pitch is absent or unavailable, report that rather than inventing fields or retrying",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Do not search tool-output files or use shell/filesystem commands to find pitch",
    );
  });
  it("directs mel reads to typed contexts without promoting SpectralShape diagnostics", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain("all 24 bands");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      'metricMetadata["mel-bands"].profile',
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "uncalibrated linear FFT magnitudes",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "zero-denominator and below-floor",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "No-frame and missing support are not measured silence",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not SpectralShape smoke diagnostics",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Historical smoke diagnostics remain in typed Desktop History and cannot substitute for an absent authoritative timeline",
    );
  });
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
  it("denies oversized full metric get at the agent boundary without restricting full typed Desktop reads", async () => {
    const observation = denseSyntheticMetricObservation();
    const raw = { action: "get" as const, entry: reportEntry, observation };
    const serialized = JSON.stringify(raw);
    expect(observation.geometry.totalSamples).toBe(90000);
    expect(observation.metrics.pitch?.frames).toHaveLength(43);
    expect(observation.metrics["spectral-shape"]?.frames).toHaveLength(43);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(
      MAX_METRIC_CONTEXT_RESPONSE_BYTES,
    );
    expect(contextOperationResultSchema.parse(raw)).toEqual(raw);
    const executeContextOperation = vi.fn(async () => raw);
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation,
    });
    const params = contextOperationParamsSchema.parse({
      action: "get",
      contextId: "context",
    });
    await expect(
      tool.handler?.(params, {
        sessionId: "sdk",
        toolCallId: "dense-get",
        toolName: "ableton_context",
        arguments: params,
      }),
    ).rejects.toThrow(
      /64 KiB.*action.*report.*offset.*0.*limit.*8.*nextOffset/,
    );
    expect(executeContextOperation).toHaveBeenCalledOnce();
    expect(JSON.stringify(raw)).toBe(serialized);
  });
  it("keeps small full metric get responses available without replacing them with reports", async () => {
    const raw = {
      action: "get" as const,
      entry: reportEntry,
      observation: createSyntheticMetricListeningObservation(),
    };
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(
      MAX_METRIC_CONTEXT_RESPONSE_BYTES,
    );
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => raw,
    });
    const params = contextOperationParamsSchema.parse({
      action: "get",
      contextId: "context",
    });
    expect(
      await tool.handler?.(params, {
        sessionId: "sdk",
        toolCallId: "small-get",
        toolName: "ableton_context",
        arguments: params,
      }),
    ).toEqual(raw);
  });
  it("pages every dense all-six-family original measurement through the actual report handler at default limit eight", async () => {
    const observation = denseSyntheticMetricObservation();
    const before = JSON.stringify(observation);
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async (request) => {
        if (request.action !== "report")
          throw new Error("Expected report read");
        return {
          action: "report",
          entry: reportEntry,
          report: projectMetricListeningReport(observation, request),
        };
      },
    });
    let offset: number | null = 0;
    const indices: number[] = [];
    const frames = {
      pitch: new Map<number, unknown>(),
      "spectral-shape": new Map<number, unknown>(),
      "mel-bands": new Map<number, unknown>(),
    };
    while (offset !== null) {
      const params = contextOperationParamsSchema.parse({
        action: "report",
        contextId: "context",
        offset,
      });
      const result = contextOperationResultSchema.parse(
        await tool.handler?.(params, {
          sessionId: "sdk",
          toolCallId: `report-${offset}`,
          toolName: "ableton_context",
          arguments: params,
        }),
      );
      if (result.action !== "report") throw new Error("Expected typed report");
      expect(result.report.pageBudget.requestedRowLimit).toBe(8);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        MAX_METRIC_CONTEXT_RESPONSE_BYTES,
      );
      expect(
        Buffer.byteLength(JSON.stringify(result.report)),
      ).toBeLessThanOrEqual(48 * 1024);
      expect(result.report.requestedMetrics).toEqual(
        observation.requestedMetrics,
      );
      expect(Object.values(result.report.metricStatus)).toEqual(
        Array(6).fill("complete"),
      );
      for (const row of result.report.rows) {
        indices.push(row.index);
        for (const metric of ["pitch", "spectral-shape", "mel-bands"] as const)
          for (const frame of row[metric]!.frames)
            frames[metric].set(frame.index, frame);
      }
      if (result.report.nextOffset !== null)
        expect(result.report.nextOffset).toBeGreaterThan(offset);
      offset = result.report.nextOffset;
    }
    expect(indices).toEqual(observation.rows.map((row) => row.index));
    for (const metric of ["pitch", "spectral-shape"] as const)
      expect([...frames[metric].values()]).toEqual(
        observation.metrics[metric]!.frames,
      );
    expect([...frames["mel-bands"].values()]).toEqual(
      observation.metrics["mel-bands"]!.frames.map((frame) => ({
        index: frame.index,
        support: frame.support,
        analysis: deriveMelBandFrame(frame.magnitudes),
      })),
    );
    expect(JSON.stringify(observation)).toBe(before);
  });
  it("enforces the complete 64 KiB UTF-8 budget when a valid 48 KiB report fits but its entry does not", () => {
    expect(MAX_METRIC_CONTEXT_RESPONSE_BYTES).toBe(64 * 1024);
    const observation = createSyntheticMetricListeningObservation({
      tempoBpm: 20,
      endBeat: 10,
    });
    observation.limitations = Array.from({ length: 16 }, () =>
      "界".repeat(240),
    );
    for (const name of nativeMetricObservationMetricSchema.options) {
      observation.metrics[name].limitations = Array.from({ length: 8 }, () =>
        "界".repeat(240),
      );
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
  it("uses supported spectral descriptors without promoting historical diagnostics or inventing arguments", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not an extra capture or invented requestedMetrics argument",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "read the authoritative spectral-shape timeline and bounded report when present",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Complete acquisition does not imply defined descriptors",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "do not invent flatness report values",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "spread report values or rolloff report values",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Rolloff is explicitly configured at 95 percent",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "not an actual synth/filter cutoff or an automatic EQ prescription",
    );
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

  it.each(["list-features", "compare-features", "search-features"])(
    "distinguishes %s summary metadata from requested numeric value detail",
    (action) => {
      const schema = contextOperationParamsSchema.options.find(
        (option) => option.shape.action.value === action,
      );
      expect(schema?.description).toContain(
        "metadata and distances, not feature value arrays",
      );
      expect(schema?.description).toContain(
        "If the user requested values or persisted rereads",
      );
      expect(schema?.description).toContain(
        "Comparison/search alone does not require these extra reads",
      );
    },
  );

  it("requires current-operation persisted feature rereads and separate requested comparison and search", () => {
    const [listening, context] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    for (const guidance of [
      LISTENING_AGENT_GUIDANCE,
      listening.description,
      context.description,
    ]) {
      expect(guidance).toContain(
        "call get-feature for each requested feature from every requested context in the current operation",
      );
      expect(guidance).toContain(
        "Conversation memory or a previous turn's read does not satisfy an explicit persisted reread",
      );
      expect(guidance).toContain(
        "call compare-features with pairs of leftFeatureId and rightFeatureId, and call search-features separately",
      );
      expect(guidance).toContain(
        "A search hit or its distance is not a substitute for the requested pair comparison",
      );
    }
  });

  it("explains exact arguments, terminal delivery and known-context retrieval before a call", () => {
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
      "Both listening start calls wait for terminal",
    );
    expect(listening.description).toContain("No get-pass polling is needed");
    expect(listening.description).toContain("before answering");
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
      "For other or small contexts, use get",
    );
    expect(context.description).toContain("list does not accept contextId");
    expect(context.description).toContain(
      "list-features uses singular contextId, not contextIds",
    );
    expect(context.description).toContain(
      'read the original stored metric-audio-observation/v1 measurement with action "report"',
    );
    expect(context.description).not.toContain("get or report");
    expect(listening.description).not.toContain("get or report");
    expect(listening.description).toContain(
      'for metric-audio-observation/v1 use action "report", offset=0, limit=8',
    );
    expect(context.description).toContain(
      "get-feature reads derived values and does not replace",
    );
    expect(context.description).toContain(
      "derive-features uses the contextIds array",
    );
    expect(context.description).toContain(
      "compare-features uses pairs of leftFeatureId and rightFeatureId",
    );
    expect(context.description).toContain(
      "search-features uses featureId and excludeContextIds",
    );
    expect(
      contextOperationParamsSchema.safeParse({
        action: "list-features",
        contextId: "source",
        featureType: "peak-summary/v1",
      }).success,
    ).toBe(true);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "list-features",
        contextIds: ["source"],
        featureType: "peak-summary/v1",
      }).success,
    ).toBe(false);
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
