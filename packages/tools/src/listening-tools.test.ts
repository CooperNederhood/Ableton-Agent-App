import { describe, expect, it, vi } from "vitest";
import { denseSyntheticMetricObservation } from "./listening-report-test-support.js";
import {
  summarizeMetricListeningResult,
  projectMetricListeningReport,
  nativeMetricObservationMetricSchema,
  deriveMelBandFrame,
  MEL_BAND_PROFILE,
} from "@ableton-agent/protocol";
import {
  createSyntheticPartialMetricListeningObservation,
  createSyntheticMetricListeningObservation,
} from "@ableton-agent/protocol/testing";

import {
  contextOperationParamsSchema,
  contextOperationResultSchema,
  MAX_METRIC_CONTEXT_RESPONSE_BYTES,
  createListeningTools as createRegisteredListeningTools,
  executeContextDiagnosticOperation,
  agentContextOperationParamsSchema,
  type ListeningToolServices,
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

// Storage contracts remain exercised through the typed application boundary,
// independently of the smaller registered agent union tested below.
function createListeningTools(services: ListeningToolServices) {
  const [listening, context] = createRegisteredListeningTools(services);
  return [
    listening,
    {
      ...context,
      handler: (
        ...args: Parameters<typeof executeContextDiagnosticOperation> extends [
          unknown,
          ...infer Rest,
        ]
          ? Rest
          : never
      ) => executeContextDiagnosticOperation(services, ...args),
    },
  ] as const;
}

describe("optional listening tool contracts", () => {
  it("binds feature selection to the stored type rather than inventory position", () => {
    const [listening, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    for (const guidance of [LISTENING_AGENT_GUIDANCE, tool.description]) {
      expect(guidance).toContain("readTarget");
      expect(guidance).toContain("level-grid/v1");
      expect(guidance).not.toContain("list-features");
    }
    for (const guidance of [listening.description, tool.description]) {
      expect(guidance).toContain("freshness is unknown");
      expect(guidance).toContain("does not prove the live source unchanged");
      expect(guidance).toContain(
        "Ordinary source lookups require positive freshness",
      );
    }
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "puts next-capture prerequisites beside a successful Session result, not a %s recovery instruction",
    async (stage) => {
      const request = listeningOperationParamsSchema.parse(sessionInput);
      const execute = vi.fn(async () => ({
        action: "play-session-and-listen" as const,
        job: {
          passId: "pass",
          stage,
          createdAt: "2026-10-25T23:00:00.000Z",
          updatedAt: "2026-10-25T23:00:01.000Z",
          durationMs: 1000,
          cleanupPolicy: "leave-running" as const,
          contextIds: stage === "completed" ? ["context"] : [],
          ...(stage === "completed"
            ? {
                metricResults: [
                  summarizeMetricListeningResult(
                    createSyntheticMetricListeningObservation(),
                  ),
                ],
              }
            : {}),
        },
      }));
      const [tool] = createListeningTools({
        executeListeningOperation: execute,
        executeContextOperation: async () => ({ action: "list", entries: [] }),
      });
      const result = await tool.handler?.(request, {
        sessionId: "sdk",
        toolCallId: "listen",
        toolName: "ableton_listening",
        arguments: request,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      if (stage === "completed") {
        if (result === null || typeof result !== "object")
          throw new Error("Expected a structured capture result");
        expect(Object.keys(result)[0]).toBe("nextCaptureGuidance");
        expect(result).toHaveProperty(
          "nextCaptureGuidance",
          expect.stringContaining("Before the next Session listen"),
        );
        expect(result).toHaveProperty(
          "nextCaptureGuidance",
          expect.stringContaining(
            "restore Arrangement before submitting the Arrangement listen",
          ),
        );
      } else expect(result).not.toHaveProperty("nextCaptureGuidance");
    },
  );

  it("returns typed measured values without storage discovery", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "automatically derived musical values",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "no playback, derivation or inventory call is needed",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("Follow nextCursor");
  });

  it("explains safe consecutive-listen preparation before submitting another capture", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain("Prepare stopped transport");
    const [listening] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });

    for (const guidance of [
      listeningOperationParamsSchema.options[1].description,
    ]) {
      expect(guidance).toContain(
        "Every successful Session listen leaves playback running",
      );
      expect(guidance).toContain("Before the next Session listen");
      expect(guidance).toContain("set-playing");
      expect(guidance).toContain("stop-clips");
      expect(guidance).toContain("does not stop song transport");
      expect(guidance).toContain(
        "Remembered Session clips are supported while transport is stopped",
      );
      expect(guidance).not.toContain("If a different clip remains remembered");
      expect(guidance).toContain(
        "not permission to repair or retry a failed pass",
      );
    }
    for (const guidance of [
      listeningOperationParamsSchema.options[2].description,
    ]) {
      expect(guidance).toContain("planned Session-to-Arrangement handoff");
      expect(guidance).toContain("actual Arrangement clips");
      expect(guidance).toContain("loop length is not the Arrangement duration");
    }
    expect(listeningOperationParamsSchema.options[2].description).not.toContain(
      "Returns a queued job",
    );
    expect(listening.description).toContain("STOP and Back to Arrangement");
  });

  it("shares finite streaming admission across Session and Arrangement", () => {
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "600-second acquisition ceiling",
    );
    expect(LISTENING_AGENT_GUIDANCE).not.toContain(
      "Session requests exceeding thirty seconds are rejected",
    );
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "Never seek or change launch settings",
    );
  });
  it("registers musical reads and removes explicit derivation from agent authorization", () => {
    expect(
      agentContextOperationParamsSchema.safeParse({
        action: "derive-features",
        contextIds: ["entry"],
      }).success,
    ).toBe(false);
    const target = {
      kind: "capture",
      sessionId: "session",
      liveSetId: "set",
      contextId: "entry",
      coordinate: "transport-beats",
      range: { startBeat: 0, endBeat: 4 },
    };
    for (const input of [
      { action: "read", target },
      { action: "compare", left: target, right: target },
      { action: "search", query: target, scope: [target] },
    ]) {
      expect(
        resolveAbletonOperation("ableton_context", input)?.descriptor,
      ).toMatchObject({
        risk: "read",
        mutationTarget: "read",
      });
    }
  });
  it("advertises shared stream derivation and bounded original reads", () => {
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "list-passes",
        jobs: [],
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    expect(tool.description).toContain("Read stored musical analysis");
    expect(tool.description).not.toContain("derive-features");
    const derive = contextOperationParamsSchema.options.find(
      (option) => option.shape.action.value === "derive-features",
    );
    expect(derive?.description).toContain(
      "either playback view and any supported capture duration",
    );
    expect(derive?.description).toContain(
      "bounded immutable measurement ranges across chunks",
    );
    expect(derive?.description).not.toContain(
      "Unsupported sources return unavailable",
    );
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
      "pitch-grid/v1",
      "midi-semitones",
      "continuous MIDI-semitone log pitch",
      "pitch-confidence-summary/v1",
      "not probability",
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
    expect(LISTENING_AGENT_GUIDANCE).toContain("ableton_context read");
    expect(LISTENING_AGENT_GUIDANCE).toContain("pitch-grid/v1");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Missing evidence never authorizes replay",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "no playback, derivation or inventory call is needed",
    );
  });
  it("directs mel reads to typed contexts without promoting SpectralShape diagnostics", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain("mel-grid/v1");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "one joint L2 normalization across the sequence",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("normalized-magnitude");
    expect(LISTENING_AGENT_GUIDANCE).toContain("Low/mid and high/mid ratios");
    expect(LISTENING_AGENT_GUIDANCE).toContain("never averaged frame ratios");
    expect(LISTENING_AGENT_GUIDANCE).toContain("mel-shape/v1");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Follow nextCursor for remaining values",
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
  it("classifies bounded stream readers as read-only and rejects raw/unbounded arguments", () => {
    for (const action of [
      "stream-overview",
      "stream-records",
      "stream-summary",
    ]) {
      expect(
        agentContextOperationParamsSchema.safeParse({
          action,
          contextId: "context",
          ...(action === "stream-summary"
            ? { range: { startSample: 10_000, endSample: 14_096 } }
            : {}),
        }).success,
      ).toBe(false);
      expect(
        contextOperationParamsSchema.safeParse({
          action,
          contextId: "context",
          sql: "SELECT *",
        }).success,
      ).toBe(false);
    }
    expect(
      contextOperationParamsSchema.parse({
        action: "stream-records",
        contextId: "context",
      }),
    ).toMatchObject({ limit: 8, includeHistorical: false });
    for (const extra of [
      { limit: 65 },
      { cursor: "x".repeat(4097) },
      { range: { startSample: 10, endSample: 9 } },
      { path: "/file" },
    ])
      expect(
        contextOperationParamsSchema.safeParse({
          action: "stream-records",
          contextId: "context",
          ...extra,
        }).success,
      ).toBe(false);
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Follow nextCursor for remaining values",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "automatically derived musical values",
    );
  });
  it("validates explicitly labelled stream projections, context identity and the total UTF8 tool budget", async () => {
    const entry = {
      ...reportEntry,
      kind: "metric-record-stream-context/v1" as const,
    };
    const page = {
      kind: "metric-record-chunk-projection/v1" as const,
      metric: "level" as const,
      descriptorDigest: "a".repeat(64),
      chunkDigest: "b".repeat(64),
      previousDigest: "c".repeat(64),
      chunkSequence: 0,
      recordOffset: 0,
      slotOffset: 0,
      totalRecords: 256,
      totalGaps: 0,
      entryOffset: 0,
      records: [
        createSyntheticMetricListeningObservation().metrics.level.records[0]!,
      ],
      gaps: [],
    };
    const result = contextOperationResultSchema.parse({
      action: "stream-records",
      entry,
      page,
    });
    expect(result).toMatchObject({
      page: { kind: "metric-record-chunk-projection/v1" },
    });
    const oversized = {
      action: "stream-records",
      entry,
      page: {
        ...page,
        metric: "mel-bands",
        totalRecords: 64,
        records: Array.from({ length: 64 }, (_, index) => ({
          index,
          support: {
            startSample: 10_000 + index * 2048,
            endSample: 12_048 + index * 2048,
          },
          magnitudes: [Array(24).fill(1 / 7), Array(24).fill(1 / 7)],
        })),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(65536);
    expect(contextOperationResultSchema.safeParse(oversized).success).toBe(
      false,
    );
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => result,
    });
    const request = contextOperationParamsSchema.parse({
      action: "stream-records",
      contextId: "foreign",
    });
    await expect(
      tool.handler?.(request, {
        sessionId: "sdk",
        toolCallId: "stream-read",
        toolName: "ableton_context",
        arguments: request,
      }),
    ).rejects.toThrow("Stream context result does not match request");
  });
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
  it("binds complete bounded summaries to their requested context and range at the SDK boundary", async () => {
    const result = contextOperationResultSchema.parse({
      action: "stream-summary",
      entry: { ...reportEntry, kind: "metric-record-stream-context/v1" },
      summary: {
        kind: "mel-band-range-summary/v1",
        descriptorDigest: "a".repeat(64),
        range: { startSample: 10_000, endSample: 14_096 },
        supportPolicy: "intersecting-native-frames",
        availability: "available",
        profile: MEL_BAND_PROFILE,
        chunkDigests: ["b".repeat(64)],
        gaps: [],
        aggregation: {
          status: "completed",
          frameCount: 2,
          analysis: deriveMelBandFrame([Array(24).fill(1), Array(24).fill(1)]),
        },
      },
    });
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => result,
    });
    const invoke = (extra: object) => {
      const request = contextOperationParamsSchema.parse({
        action: "stream-summary",
        contextId: "context",
        range: { startSample: 10_000, endSample: 14_096 },
        ...extra,
      });
      return tool.handler?.(request, {
        sessionId: "sdk",
        toolCallId: "compact-mel",
        toolName: "ableton_context",
        arguments: request,
      });
    };
    await expect(invoke({})).resolves.toEqual(result);
    await expect(invoke({ contextId: "foreign" })).rejects.toThrow(
      "Stream context result does not match request",
    );
    await expect(
      invoke({ range: { startSample: 10_001, endSample: 14_096 } }),
    ).rejects.toThrow("Stream summary does not match request");
    if (result.action !== "stream-summary") throw new Error("Expected summary");
    expect(
      contextOperationResultSchema.safeParse({
        ...result,
        summary: {
          ...result.summary,
          aggregation: { ...result.summary.aggregation, frameCount: 257 },
        },
      }).success,
    ).toBe(false);
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
      action: "read",
      target: {
        kind: "capture",
        contextId: "context",
        sessionId: "session",
        liveSetId: "set",
        coordinate: "transport-beats",
        range: { startBeat: 0, endBeat: 4 },
      },
    });
    expect(operation?.descriptor).toMatchObject({
      operationId: "context.read",
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
        action: "read",
        contextId: "context",
      }),
    ).toMatchObject({ domain: "context", action: "read" });
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
    expect(tool.description).toContain(
      'Read continuations need only {action:"read",cursor:nextCursor}',
    );
    expect(tool.description).toContain("Null/unavailable is not zero");
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
      "Missing evidence never authorizes replay",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("linear-amplitude");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "zero only for fully covered event-free cells",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("detector endpoints");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "timing is descriptive, not sample-accurate",
    );
  });
  it("preserves zero-based beat phase and tempo-dependent interpretation", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain("source/range");
    expect(LISTENING_AGENT_GUIDANCE).toContain("detector endpoints");
    expect(LISTENING_AGENT_GUIDANCE).toContain("readTarget");
    expect(LISTENING_AGENT_GUIDANCE).toContain("not sample-accurate");
  });
  it("uses supported spectral descriptors without promoting historical diagnostics or inventing arguments", () => {
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "no playback, derivation or inventory call is needed",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("flatness-summary/v1");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "silence and undefined output are not zero",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("signed dB flatness");
    expect(LISTENING_AGENT_GUIDANCE).toContain("spread-summary/v1");
    expect(LISTENING_AGENT_GUIDANCE).toContain("95-percent magnitude rolloff");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "magnitude-weighted spectral spread in Hz",
    );
    expect(LISTENING_AGENT_GUIDANCE).toContain("rolloff-summary/v1 (Hz)");
    expect(LISTENING_AGENT_GUIDANCE).toContain("support-weighted valid");
    expect(LISTENING_AGENT_GUIDANCE).toContain(
      "Source attribution is not exclusive",
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
    expect(listeningOperationParamsSchema.options[0].description).toContain(
      "not a permanent commissioning failure",
    );
    expect(listeningOperationParamsSchema.options[0].description).toContain(
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

  it("publishes shared comparison semantics in the agent-facing tool description", () => {
    const [, context] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    expect(context.description).toContain(
      "measures the loudness envelope, not timbre or source identity",
    );
    expect(context.description).toContain("mel-grid/v1");
    expect(context.description).toContain("complete requested extent");
    expect(context.description).toContain("not identity probabilities");
    expect(context.description).toContain("Null/unavailable is not zero");
  });

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
      expect(guidance).toContain("readTarget");
      expect(guidance).not.toContain("get-feature");
      expect(guidance).not.toContain("compare-features");
      expect(guidance).not.toContain("search-features");
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
      "Listen returns capture status and automatically derived musical values",
    );
    expect(listening.description).toContain(
      "Session clips and Arrangement are distinct",
    );
    expect(listening.description).toContain(
      "Missing evidence never authorizes replay",
    );
    expect(listening.description).toContain(
      "no playback, derivation or inventory call is needed",
    );
    expect(listening.description).toContain(
      "Follow nextCursor for remaining values",
    );
    expect(listening.description).toContain("Read stored values");
    expect(listening.description).toContain("through ordinary approvals");
    expect(listening.description).toContain("STOP and Back to Arrangement");
    expect(listening.description).toContain(
      "Session clips and Arrangement are distinct",
    );
    expect(listening.description).toContain(
      "Never repair/retry a rejected pass automatically",
    );
    expect(context.description).toContain("Read stored musical analysis");
    expect(context.description).not.toContain("list-features");
    expect(context.description).toContain(
      "copy a returned readTarget unchanged",
    );
    expect(context.description).toContain(
      "temporal coverage and pinned continuations",
    );
    expect(context.description).not.toContain("get or report");
    expect(listening.description).not.toContain("get or report");
    expect(listening.description).toContain(
      "automatically derived musical values",
    );
    expect(context.description).toContain("actual canonical values");
    expect(context.description).toContain(
      "newest positively fresh covering capture",
    );
    expect(context.description).toContain(
      "Compare returns separate canonical feature distances",
    );
    expect(context.description).toContain("Search defaults to mel-grid/v1");
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
    expect(tool.description).toContain("Capture leaves playback running");
    expect(tool.description).toContain("Source attribution is not exclusive");
    expect(tool.description).toContain(
      "Missing evidence never authorizes replay",
    );
    expect(tool.description).not.toContain("wire3 or wire4");
    expect(tool.description).toContain("Prepare stopped transport");
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "stopped transport at a nonnegative position",
    );
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "clip Global or One Bar quantization",
    );
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "remembered active clips while transport is stopped",
    );
    expect(tool.description).not.toContain(
      "one-bar and nonzero stopped anchors are not qualified",
    );
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "Cancellation never retracts an accepted launch or stops transport",
    );
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "600-second acquisition ceiling",
    );
    expect(listeningOperationParamsSchema.options[0].description).toContain(
      "native_per_pass_validation_required",
    );
    expect(tool.description).toContain("not sample-accurate");
    expect(tool.description).not.toContain("Descriptive v2");
    expect(tool.description).not.toContain(
      "one approximately 100 ms reporting hop",
    );
  });

  it("requires exact Session identity and defaults bounded capture", () => {
    expect(listeningOperationParamsSchema.parse(sessionInput)).toMatchObject({
      maximumDurationMs: 900_000,
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

  it("shares a finite execution allowance without an unbounded capture escape", () => {
    const arrangement = {
      action: "play-arrangement-and-listen",
      listenerIds: ["tap-after"],
      startBeat: 0,
      endBeat: 1280,
    };
    expect(listeningOperationParamsSchema.parse(arrangement)).toMatchObject({
      maximumDurationMs: 900_000,
    });
    expect(
      listeningOperationParamsSchema.safeParse({
        ...arrangement,
        maximumDurationMs: 900_001,
      }).success,
    ).toBe(false);
    expect(
      listeningOperationParamsSchema.safeParse({
        ...sessionInput,
        maximumDurationMs: 900_000,
      }).success,
    ).toBe(true);
  });

  it.each([
    { listenerIds: [] },
    { listenerIds: ["tap", "tap"] },
    { listenerIds: Array.from({ length: 9 }, (_, index) => `tap-${index}`) },
    { maximumDurationMs: 900_001 },
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
        cursor: "a".repeat(4097),
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
