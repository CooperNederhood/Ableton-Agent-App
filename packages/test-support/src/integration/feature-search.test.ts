import { describe, expect, it } from "vitest";
import {
  TRANSPORT_SOURCE_FLAG_GUIDANCE,
  VERIFIED_TOOL_RESULT_GUIDANCE,
} from "@ableton-agent/application";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  LISTENING_FEATURE_DEFINITIONS,
  metricAudioObservationSchema,
  createMetricObservationReportRows,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  projectMetricListeningReport,
  metricRecordDigest,
  type MetricRecordChunk,
  segmentListeningObservation,
  extractListeningFeature,
  compareListeningFeatures,
  type ContextFeature,
} from "@ableton-agent/protocol";
import {
  withSyntheticAnalyzerTimelines,
  createSyntheticMetricRecordStreamFixture,
} from "@ableton-agent/protocol/testing";
import {
  projectListeningFeatureInventory,
  expandListeningFeatureInventory,
  contextFeatureViewSchema,
  metricStreamRecordPageSchema,
  analysisPageSchema,
  projectListeningTimeline,
  projectListeningOverview,
  type AnalysisPage,
} from "@ableton-agent/tools";
import type { AgentHistoryPage } from "@ableton-agent/observability";
import { melSmokeFixture } from "./mel-smoke-test-support.js";
import {
  cachedFixture,
  listeningSummaryFixture,
} from "./agent-listening-test-support.js";
import {
  projectFeatureSource,
  validateFeatureSources,
  verifyFeatureSearch,
  projectFeatureSearchHistory,
  readFeatureToolPairs,
  readCompleteAnalyses,
  deliveredAnalysisFeatures,
  verifyStreamFeatureReads,
} from "./feature-search.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateFixture, validateScenario } from "./validation.js";
import type { AssertionInput, TurnEvidence } from "./contracts.js";
import { streamProofContentSha256 } from "./arrangement-stream.js";

function deliveredAnalysisFixture() {
  const base = melSmokeFixture();
  const turn = structuredClone(base.turn);
  const target = {
    kind: "capture" as const,
    sessionId: turn.appSessionId,
    liveSetId: "set",
    contextId: "context-1",
    coordinate: "clip-local-beats" as const,
    range: { startBeat: 0, endBeat: 4 },
  };
  const page = analysisPageSchema.parse({
    source: {
      name: "Clip",
      nameTruncated: false,
      location: "Session clip",
      capturedAt: "2026-11-05T00:00:00.000Z",
      coordinate: target.coordinate,
      observedRange: target.range,
      requestedRange: target.range,
      freshness: "fresh",
      readTarget: target,
    },
    readTarget: target,
    status: "ready",
    reason: null,
    overview: [],
    overviewIncluded: true,
    timeline: [],
    overviewExtent: target.range,
    detail: {
      offset: 0,
      returnedItems: 0,
      totalItems: 0,
      truncated: false,
      nextCursor: null,
    },
  });
  const history = turn.agentListening!;
  const call = history.records.find((record) => record.kind === "tool_call")!;
  const result = history.records.find(
    (record) => record.kind === "tool_result",
  )!;
  if (call.kind !== "tool_call" || result.kind !== "tool_result")
    throw new Error("fixture");
  const terminals = history.records.filter(
    (record) => record.kind === "message" || record.kind === "turn",
  );
  const setPairs = (
    pairs: {
      tool?: string;
      arguments: Record<string, unknown>;
      data: Record<string, unknown>;
    }[],
  ) =>
    Reflect.set(history, "records", [
      ...pairs.flatMap((pair, index) => {
        const toolName = pair.tool ?? "ableton_context";
        const toolCallId = `analysis-call-${index}`;
        return [
          {
            ...call,
            id: `analysis-call-record-${index}`,
            correlationId: toolCallId,
            toolCallId,
            toolName,
            arguments: pair.arguments,
          },
          {
            ...result,
            id: `analysis-result-record-${index}`,
            correlationId: toolCallId,
            toolCallId,
            metadata: { toolName },
            result: { result: { content: pair.data } },
          },
        ];
      }),
      ...terminals,
    ]);
  const data = { action: "read", analyses: [page], nextCursor: null };
  setPairs([{ arguments: { action: "read", target }, data }]);
  return { turn, target, page, data, setPairs };
}
describe("delivered musical analysis evidence", () => {
  it("accepts a genuine read result without inventing legacy discovery calls", () => {
    const { turn, data, page, target } = deliveredAnalysisFixture();
    expect(readFeatureToolPairs(turn).map((pair) => pair.action)).toEqual([
      "read",
    ]);
    expect(readFeatureToolPairs(turn)[0]!.data).toEqual(data);
    expect(readCompleteAnalyses([turn])).toEqual([
      {
        source: page.source,
        readTarget: target,
        overview: [],
        timeline: [],
      },
    ]);
  });
  function pagedFixture() {
    const fixture = deliveredAnalysisFixture();
    const row = {
      kind: "segment-summary" as const,
      segment: {
        startBeat: 0,
        endBeat: 4,
        startSample: 0,
        endSample: 90000,
        sampleRate: 48000,
        kind: "bar" as const,
        alignment: null,
        alignmentReason: null,
      },
      startBeat: 0,
      endBeat: 4,
      elapsedStartSeconds: 0,
      elapsedEndSeconds: 1.875,
      fragment: 0,
      complete: true,
      features: [],
    };
    const first = {
      ...fixture.page,
      timeline: [row],
      detail: {
        offset: 0,
        returnedItems: 1,
        totalItems: 2,
        truncated: true,
        nextCursor: "next-page",
      },
    };
    const last = {
      ...fixture.page,
      overviewIncluded: false,
      timeline: [
        {
          ...row,
          kind: "feature-metadata" as const,
          featureType: "peak-summary/v1" as const,
        },
      ],
      detail: {
        offset: 1,
        returnedItems: 1,
        totalItems: 2,
        truncated: false,
        nextCursor: null,
      },
    };
    const pairs = [
      {
        tool: "ableton_listening",
        arguments: { action: "play-session-and-listen" },
        data: {
          action: "play-session-and-listen",
          summaries: [
            listeningSummaryFixture(fixture.target, first.source.capturedAt),
          ],
        },
      },
      {
        tool: "ableton_context",
        arguments: { action: "read", target: fixture.target },
        data: { action: "read", analyses: [first], nextCursor: "next-page" },
      },
      {
        tool: "ableton_context",
        arguments: {
          action: "read",
          target: fixture.target,
          cursor: "next-page",
        },
        data: { action: "read", analyses: [last], nextCursor: null },
      },
    ];
    fixture.setPairs(pairs);
    return { ...fixture, pairs, first, last };
  }
  it.each([false, true])(
    "counts actual pinned continuation consumption (cursor-only=%s)",
    (cursorOnly) => {
      const { turn, first, last, pairs, setPairs } = pagedFixture();
      if (cursorOnly) Reflect.deleteProperty(pairs[2]!.arguments, "target");
      setPairs(pairs);
      expect(readCompleteAnalyses([turn])[0]!.timeline).toEqual([
        ...first.timeline,
        ...last.timeline,
      ]);
    },
  );
  it.each([
    [
      "unread continuation",
      (f: ReturnType<typeof pagedFixture>) => {
        f.pairs.pop();
      },
    ],
    [
      "no explicit first page",
      (f: ReturnType<typeof pagedFixture>) => {
        f.pairs.splice(1, 1);
      },
    ],
    [
      "wrong cursor",
      (f: ReturnType<typeof pagedFixture>) => {
        Reflect.set(f.pairs[2]!.arguments, "cursor", "wrong-page");
        Reflect.deleteProperty(f.pairs[2]!.arguments, "target");
      },
    ],
    [
      "changed historical scope",
      (f: ReturnType<typeof pagedFixture>) => {
        Reflect.set(f.pairs[2]!.arguments, "includeHistorical", true);
      },
    ],
    [
      "changed detail",
      (f: ReturnType<typeof pagedFixture>) => {
        Reflect.set(f.pairs[2]!.arguments, "detail", "evidence");
      },
    ],
    [
      "foreign owner",
      (f: ReturnType<typeof pagedFixture>) => {
        f.target.sessionId = "foreign";
      },
    ],
    [
      "changed range",
      (f: ReturnType<typeof pagedFixture>) => {
        Reflect.set(f.pairs[2]!.arguments, "target", {
          ...f.target,
          range: { startBeat: 0, endBeat: 1 },
        });
      },
    ],
    [
      "skipped rows",
      (f: ReturnType<typeof pagedFixture>) => {
        f.last.detail.offset = 2;
      },
    ],
    [
      "changed total",
      (f: ReturnType<typeof pagedFixture>) => {
        f.last.detail.totalItems = 3;
      },
    ],
    [
      "false row count",
      (f: ReturnType<typeof pagedFixture>) => {
        f.last.detail.returnedItems = 0;
      },
    ],
    [
      "failed analysis",
      (f: ReturnType<typeof pagedFixture>) => {
        Reflect.set(f.first, "status", "failed");
      },
    ],
  ])("rejects %s without filling evidence from old calls", (_name, mutate) => {
    const fixture = pagedFixture();
    mutate(fixture);
    fixture.setPairs(fixture.pairs);
    expect(() => readCompleteAnalyses([fixture.turn])).toThrow();
  });
});

describe("canonical stream feature-source reads", () => {
  it("binds original records and feature provenance separately and rejects unread or changed measurements", async () => {
    const base = melSmokeFixture();
    const native = await createSyntheticMetricRecordStreamFixture({
      seconds: 1.875,
      tempoBpm: 128,
      source: base.observation.source,
      ownership: base.observation.ownership,
      sourceOrigin: 100_000,
      records: {
        "spectral-shape": Array.from({ length: 43 }, (_, index) => ({
          index,
          support: {
            startSample: 100_000 + index * 2048,
            endSample: 100_000 + (index + 1) * 2048,
          },
          channels: [
            { state: "valid", flatnessDb: -20, spreadHz: 500, rolloffHz: 1000 },
            { state: "valid", flatnessDb: -30, spreadHz: 600, rolloffHz: 1200 },
          ],
        })),
      },
    });
    const chunks: MetricRecordChunk[] = [];
    for await (const chunk of native.chunks()) chunks.push(chunk);
    const { rows, ...geometry } = native.descriptor.geometry;
    void rows;
    const reference = {
      schema: "metric-record-stream-context/v1" as const,
      captureId: "context-stream",
      descriptorDigest: native.state.descriptorDigest,
      descriptor: { ...native.descriptor, geometry },
    };
    const proof = {
      contextId: reference.captureId,
      passId: native.descriptor.ownership.passId,
      listenerId: native.descriptor.ownership.listenerId,
      descriptorDigest: native.state.descriptorDigest,
      manifestSha256: await metricRecordDigest(native.manifest),
      recordsSha256: createHash("sha256")
        .update(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(""))
        .digest("hex"),
      chunkCount: chunks.length,
      afterOwnedRestart: false,
    };
    const sourceFingerprint = createHash("sha256")
      .update(JSON.stringify(native.manifest))
      .digest("hex");
    const source = projectFeatureSource(
      reference.captureId,
      reference,
      false,
      "full",
      {
        chunks,
        contentSha256: streamProofContentSha256(proof),
        sourceFingerprint,
      },
    );
    expect(source.stream?.sourceFingerprint).toBe(sourceFingerprint);
    expect(source.contentSha256).not.toBe(sourceFingerprint);
    expect(source.analyzers?.pitch.frames).toHaveLength(43);
    const template = readFeatureToolPairs(base.turn).find(
      (pair) => pair.action === "get",
    )!;
    const entry = {
      ...base.context.entry,
      contextId: reference.captureId,
      passId: proof.passId,
      listenerId: proof.listenerId,
      kind: "metric-record-stream-context/v1",
    };
    const pair = (
      action: string,
      data: Record<string, unknown>,
      metric?: string,
    ): typeof template => ({
      ...structuredClone(template),
      action,
      call: {
        ...template.call,
        arguments: {
          action,
          contextId: reference.captureId,
          ...(metric ? { metric } : {}),
        },
      },
      data: { action, entry, ...data },
    });
    const reads = [
      pair("stream-overview", {
        overview: {
          descriptorDigest: reference.descriptorDigest,
          geometry,
          source: native.descriptor.source,
          timingPolicy: native.descriptor.timingPolicy,
          algorithms: native.descriptor.algorithms,
          metrics: native.manifest.metrics,
          outcome: "complete",
          nativeStatus: "completed",
          nativeCoverage: {
            capturedSamples: native.manifest.nativeProof.capturedSamples,
            sourceOrigin: native.manifest.nativeProof.sourceOrigin,
            sourceEnd: native.manifest.nativeProof.sourceEnd,
            drain: "completed",
          },
          chunkCount: chunks.length,
          storedBytes: Buffer.byteLength(JSON.stringify(chunks)),
          limitations: native.manifest.limitations,
          featureDerivation: "supported",
        },
      }),
      ...chunks
        .filter((chunk) =>
          ["level", "pitch", "spectral-shape"].includes(chunk.metric),
        )
        .map((chunk) =>
          pair(
            "stream-records",
            {
              page: {
                kind: "metric-record-chunk-projection/v1",
                metric: chunk.metric,
                descriptorDigest: chunk.descriptorDigest,
                chunkDigest: chunk.digest,
                previousDigest: chunk.previousDigest,
                chunkSequence: chunk.chunkSequence,
                recordOffset: chunk.recordOffset,
                slotOffset: chunk.slotOffset,
                totalRecords: chunk.records.length,
                totalGaps: 0,
                entryOffset: 0,
                records: chunk.records,
                gaps: [],
              },
            },
            chunk.metric,
          ),
        ),
    ];
    const expected = base.input.baseline.sources!.a!.source;
    for (const phase of ["first", "restored"])
      expect(() =>
        verifyStreamFeatureReads(source, reads, expected, phase, "full"),
      ).not.toThrow();
    const peak = projectFeatureSource(
      reference.captureId,
      reference,
      false,
      "peak-only",
      {
        chunks,
        contentSha256: source.contentSha256,
        sourceFingerprint,
      },
    );
    expect(peak.analyzers).toBeUndefined();
    expect(() =>
      verifyStreamFeatureReads(
        peak,
        reads.filter(
          (read) =>
            read.action === "stream-overview" ||
            read.call.arguments.metric === "level",
        ),
        expected,
        "first",
        "peak-only",
      ),
    ).not.toThrow();
    expect(() =>
      verifyStreamFeatureReads(peak, reads, expected, "first", "peak-only"),
    ).toThrow("missing authoritative analyzer evidence");
    expect(() =>
      verifyStreamFeatureReads(
        source,
        reads.slice(0, 1),
        expected,
        "first",
        "full",
      ),
    ).toThrow();
    for (const mutation of [
      "descriptor",
      "pass",
      "peak",
      "pitch",
      "truncated",
    ] as const) {
      const changed = structuredClone(reads);
      if (mutation === "descriptor")
        Object.assign(changed[0]!.data.overview!, {
          descriptorDigest: "f".repeat(64),
        });
      else if (mutation === "pass")
        Object.assign(changed[0]!.data.entry!, { passId: "foreign" });
      else {
        const index = changed.findIndex(
          (read) =>
            read.call.arguments.metric ===
            (mutation === "peak" ? "level" : "pitch"),
        );
        const page = metricStreamRecordPageSchema.parse(
          changed[index]!.data.page,
        );
        const first = page.records[0]!;
        changed[index]!.data.page = {
          ...page,
          records:
            mutation === "truncated"
              ? page.records.slice(1)
              : [
                  {
                    ...first,
                    ...(mutation === "peak"
                      ? { peak: [0.2, 0.3] }
                      : {
                          channels: [0, 1].map(() => ({
                            state: "low-confidence",
                            hz: 100,
                            confidence: 0.1,
                          })),
                        }),
                  },
                  ...page.records.slice(1),
                ],
        };
      }
      expect(() =>
        verifyStreamFeatureReads(source, changed, expected, "first", "full"),
      ).toThrow();
    }
  });
});

const fixture = cachedFixture(buildFixture);
function buildFixture(
  reportPages = false,
  unavailableConfidence = false,
  reportRowLimit = 1,
  equalPeaks = false,
) {
  const base = melSmokeFixture();
  const baseTurn = { ...base.turn };
  delete baseTurn.melSmoke;
  const firstObservation = withSyntheticAnalyzerTimelines(
    metricAudioObservationSchema.parse(base.observation),
  );
  firstObservation.metrics.pitch = pitchTimelineSchema.parse({
    ...firstObservation.metrics.pitch,
    frames: firstObservation.metrics.pitch!.frames.map((frame) => ({
      ...frame,
      channels: [0.2, 0.3].map((confidence) =>
        unavailableConfidence
          ? { state: "silence", hz: null, confidence: null }
          : { state: "low-confidence", hz: 100, confidence },
      ),
    })),
  });
  firstObservation.metrics["spectral-shape"] =
    spectralShapeTimelineSchema.parse({
      ...firstObservation.metrics["spectral-shape"],
      frames: firstObservation.metrics["spectral-shape"]!.frames.map(
        (frame) => ({
          ...frame,
          channels: [
            { state: "valid", flatnessDb: -20, spreadHz: 500, rolloffHz: 1000 },
            { state: "valid", flatnessDb: -30, spreadHz: 600, rolloffHz: 1200 },
          ],
        }),
      ),
    });
  firstObservation.rows = createMetricObservationReportRows(firstObservation);
  const secondObservation = structuredClone(firstObservation);
  secondObservation.ownership.passId = "pass-2";
  secondObservation.ownership.traceId = "00000000-0000-4000-8000-000000000002";
  secondObservation.ownership.correlationId =
    secondObservation.ownership.traceId;
  if (!equalPeaks)
    for (const record of secondObservation.metrics.level.records)
      record.peak = [0.7, 0.3];
  secondObservation.rows = createMetricObservationReportRows(secondObservation);
  const observations = [firstObservation, secondObservation];
  const source1 = projectFeatureSource("context-1", firstObservation, false);
  const source2 = projectFeatureSource("context-2", secondObservation, false);
  const sources = [source1, source2];
  const views = sources.map((source, index) => ({
    record: {
      id: `feature-${index + 1}`,
      entryId: source.contextId,
      segmentId: `segment-${index + 1}`,
      sessionId: base.owner.appSessionId,
      liveSetId: "set",
      createdAt: base.context.entry.createdAt,
      trace: {
        traceId: observations[index]!.ownership.traceId,
        correlationId: observations[index]!.ownership.correlationId,
        causationId: observations[index]!.ownership.causationId,
      },
      sourceFingerprint: source.contentSha256,
      feature: {
        ...canonicalMetadata("peak-summary/v1"),
        type: "peak-summary/v1",
        status: "ready",
        distanceDefinition: "euclidean-linear-amplitude/v1",
        distanceUnits: "linear-amplitude",
        coveredSamples: 90000,
        expectedSamples: 90000,
      },
    },
    segment: {
      id: `segment-${index + 1}`,
      entryId: source.contextId,
      sessionId: base.owner.appSessionId,
      liveSetId: "set",
      order: 0,
      kind: "unaligned",
      coordinate: "clip-local-beats",
      startBeat: 0,
      endBeat: 4,
      startSample: 0,
      endSample: 90000,
      sampleRate: 48000,
      alignmentReason: "musical-bar-alignment-not-established",
    },
    source: {
      ...base.context.entry,
      contextId: source.contextId,
      passId: source.passId,
    },
  }));
  const values = sources.map((source) => [
    Math.max(...source.records.map((r) => r.peak[0])),
    Math.max(...source.records.map((r) => r.peak[1])),
  ]);
  const analyzerValues = [
    ["pitch-confidence-summary/v1", [0.2, 0.3]],
    ["flatness-summary/v1", [-20, -30]],
    ["spread-summary/v1", [500, 600]],
    ["rolloff-summary/v1", [1000, 1200]],
  ] as const;
  const analyzerViews = views.map((view) =>
    analyzerValues.map(([type, values]) => {
      const definition = LISTENING_FEATURE_DEFINITIONS.find(
        (item) => item.type === type,
      )!;
      const unavailable =
        unavailableConfidence && type === "pitch-confidence-summary/v1";
      return {
        feature: {
          ...view,
          record: {
            ...view.record,
            id: `${view.record.id}-${type.split("/")[0]}`,
            feature: {
              type,
              status: unavailable ? "unavailable" : "ready",
              reason: unavailable ? "silence" : null,
              channelReasons: unavailable
                ? ["silence", "silence"]
                : [null, null],
              profile: definition.profile,
              units: definition.units,
              distanceDefinition: definition.distanceDefinition,
              distanceUnits: definition.distanceUnits,
              expectedSamples: 90000,
              coveredSamples: 43 * 2048,
            },
          },
        },
        page: {
          offset: 0,
          nextOffset: null,
          values: unavailable ? null : [...values],
        },
      };
    }),
  );
  const distance = Math.hypot(
    values[0]![0]! - values[1]![0]!,
    values[0]![1]! - values[1]![1]!,
  );
  const evidence = views.map((view) => ({
    contextId: view.record.entryId,
    segmentId: view.segment.id,
    startBeat: 0,
    endBeat: 4,
    coveredSamples: 90000,
    expectedSamples: 90000,
  }));
  const comparison = {
    action: "compare-features",
    comparisons: [
      {
        leftFeatureId: "feature-1",
        rightFeatureId: "feature-2",
        leftEvidence: evidence[0],
        rightEvidence: evidence[1],
        result: {
          status: "comparable",
          distanceDefinition: "euclidean-linear-amplitude/v1",
          units: "linear-amplitude",
          distance,
        },
      },
    ],
  };
  const search = {
    action: "search-features",
    query: views[0],
    matches: [{ feature: views[1], distance }],
    distanceDefinition: "euclidean-linear-amplitude/v1",
    distanceUnits: "linear-amplitude",
    scannedCount: 1,
    comparableCount: 1,
    eligibleCount: 1,
    excludedCount: 1,
    exhaustive: true,
    limitsHit: [],
    exclusionReasons: { "source-excluded": 1 },
  };
  const turns = [0, 1, 2].map((index): TurnEvidence => {
    const records: AgentHistoryPage["items"] = [];
    const sdkTurnId = `00000000-0000-4000-8000-00000000000${index + 1}`;
    const recordBase = {
      version: 1 as const,
      appSessionId: base.owner.appSessionId,
      agentSessionId: base.owner.conversationId,
      activeAgentId: base.owner.agentId,
      turnId: sdkTurnId,
      traceId: sdkTurnId,
      causationId: sdkTurnId,
      occurredAt: "2026-11-05T00:00:02.000Z",
      recordedAt: "2026-11-05T00:00:02.000Z",
    };
    const pair = (
      toolName: string,
      args: Record<string, unknown>,
      data: Record<string, unknown>,
    ) => {
      if (reportPages && args.action === "get") {
        const observation = metricAudioObservationSchema.parse(
          data.observation,
        );
        let offset: number | null = 0;
        while (offset !== null) {
          const report = projectMetricListeningReport(observation, {
            offset,
            limit: reportRowLimit,
          });
          pair(
            toolName,
            { ...args, action: "report", offset, limit: reportRowLimit },
            { action: "report", entry: data.entry, report },
          );
          offset = report.nextOffset;
        }
        return;
      }
      const toolCallId = `tool-${records.length}`;
      const { features, ...metadata } = data;
      const content =
        data.action === "list-features"
          ? {
              ...metadata,
              inventory: projectListeningFeatureInventory(
                contextFeatureViewSchema.array().parse(features),
              ),
            }
          : data;
      records.push(
        {
          ...recordBase,
          correlationId: toolCallId,
          kind: "tool_call",
          id: `${sdkTurnId}-${toolCallId}-call`,
          toolCallId,
          toolName,
          arguments: args,
          status: "completed",
          metadata: {},
        },
        {
          ...recordBase,
          correlationId: toolCallId,
          kind: "tool_result",
          id: `${sdkTurnId}-${toolCallId}-result`,
          toolCallId,
          outcome: "success",
          durationMs: 1,
          result: { result: { content } },
          metadata: { toolName },
        },
      );
    };
    if (index < 2) {
      pair(
        "ableton_listening",
        {
          action: "play-session-and-listen",
          target:
            firstObservation.source.view === "session"
              ? firstObservation.source.target
              : null,
          listenerIds: ["listener"],
        },
        {
          action: "play-session-and-listen",
          job: {
            stage: "completed",
            passId: sources[index]!.passId,
            contextIds: [sources[index]!.contextId],
          },
          summaries: [
            listeningSummaryFixture(
              {
                kind: "capture",
                sessionId: base.owner.appSessionId,
                liveSetId: "set",
                contextId: sources[index]!.contextId,
                coordinate: "clip-local-beats",
                range: { startBeat: 0, endBeat: 4 },
              },
              "2026-11-05T00:00:00.000Z",
            ),
          ],
        },
      );
      pair(
        "ableton_context",
        { action: "get", contextId: sources[index]!.contextId },
        {
          action: "get",
          entry: {
            contextId: sources[index]!.contextId,
            passId: sources[index]!.passId,
          },
          observation: observations[index],
        },
      );
      pair(
        "ableton_context",
        { action: "list-features", contextId: sources[index]!.contextId },
        { action: "list-features", features: [views[index]] },
      );
    }
    if (index === 2)
      for (const [sourceIndex, source] of sources.entries())
        pair(
          "ableton_context",
          { action: "get", contextId: source.contextId },
          {
            action: "get",
            entry: { contextId: source.contextId, passId: source.passId },
            observation: observations[sourceIndex],
          },
        );
    if (index === 1)
      pair(
        "ableton_context",
        {
          action: "derive-features",
          contextIds: [sources[1]!.contextId],
          includeHistorical: false,
        },
        {
          action: "derive-features",
          derivations: [
            {
              entryId: sources[1]!.contextId,
              definitionSet: "qualified-listening/v1",
              status: "ready",
              reason: null,
              featureCount: 15,
            },
          ],
        },
      );
    for (const [viewIndex, view] of views
      .slice(0, index === 0 ? 1 : 2)
      .entries())
      pair(
        "ableton_context",
        { action: "get-feature", featureId: view.record.id },
        {
          action: "get-feature",
          feature: view,
          page: { offset: 0, nextOffset: null, values: values[viewIndex] },
        },
      );
    for (const sourceFeatures of analyzerViews.slice(0, index === 0 ? 1 : 2))
      for (const feature of sourceFeatures)
        pair(
          "ableton_context",
          { action: "get-feature", featureId: feature.feature.record.id },
          { action: "get-feature", ...structuredClone(feature) },
        );
    if (index > 0)
      pair(
        "ableton_context",
        {
          action: "compare-features",
          pairs: [{ leftFeatureId: "feature-1", rightFeatureId: "feature-2" }],
        },
        structuredClone(comparison),
      );
    if (index === 1) {
      pair(
        "ableton_context",
        {
          action: "search-features",
          featureId: "feature-1",
          excludeContextIds: ["context-1"],
        },
        search,
      );
      pair(
        "ableton_context",
        { action: "feature-definitions" },
        {
          action: "feature-definitions",
          definitions: LISTENING_FEATURE_DEFINITIONS,
        },
      );
      pair(
        "ableton_context",
        { action: "list-features" },
        {
          action: "list-features",
          features: [
            ...views.map((view) => ({
              ...view,
              record: {
                ...view.record,
                id: `${view.record.id}-pitch`,
                feature: {
                  ...canonicalMetadata("pitch-grid/v1"),
                  type: "pitch-grid/v1",
                  status: "unavailable",
                  reason: "missing-alignment",
                },
              },
            })),
            {
              ...views[1],
              record: {
                ...views[1]!.record,
                id: `${views[1]!.record.id}-level`,
                feature: {
                  ...canonicalMetadata("level-grid/v1"),
                  type: "level-grid/v1",
                  status: "unavailable",
                  reason: "missing-alignment",
                },
              },
            },
          ],
        },
      );
    }
    records.push(
      {
        ...recordBase,
        id: `${sdkTurnId}-answer`,
        correlationId: sdkTurnId,
        kind: "message",
        role: "assistant",
        content: "Measured.",
        messageIndex: 1,
        occurredAt: "2026-11-05T00:00:03.000Z",
        metadata: {},
      },
      {
        ...recordBase,
        id: `${sdkTurnId}-terminal`,
        correlationId: sdkTurnId,
        kind: "turn",
        status: "completed",
        occurredAt: "2026-11-05T00:00:00.000Z",
        completedAt: "2026-11-05T00:00:04.000Z",
        metadata: {},
      },
    );
    return {
      ...baseTurn,
      userMessageId: `user-${index}`,
      assistantMessageId: `assistant-${index}`,
      operationId: `operation-${index}`,
      captures:
        index === 2
          ? []
          : [
              {
                ...base.turn.captures[0]!,
                metricFamilies: [...firstObservation.requestedMetrics],
                passId: sources[index]!.passId,
                native: {
                  generation: base.owner.sdkTurnId,
                  connectionId: base.owner.sdkTurnId,
                  connectionEpoch: base.owner.sdkTurnId,
                  nativeEpoch: 1,
                },
              },
            ],
      contexts: sources.slice(0, index === 0 ? 1 : 2).map((source) => ({
        ...base.turn.contexts[0]!,
        contextId: source.contextId,
        passId: source.passId,
        contentSha256: source.contentSha256,
        afterOwnedRestart: index === 2,
      })),
      featureSources: sources
        .slice(0, index === 0 ? 1 : 2)
        .map((source) => ({ ...source, afterOwnedRestart: index === 2 })),
      facts: { sdkTurnId },
      agentListening: {
        ...base.owner,
        sdkTurnId,
        afterOwnedRestart: index === 2,
        records,
      },
    };
  });
  const input: AssertionInput = {
    ...base.input,
    turns,
    turn: turns[2]!,
    evidence: {
      schemaVersion: 1,
      facts: {},
      contexts: turns[2]!.contexts,
      unchanged: [],
      capturePassIds: sources.map((source) => source.passId),
      featureSources: turns[2]!.featureSources!,
      setupActions: (["stop-transport", "restart-owned-desktop"] as const).map(
        (action, index) => ({
          ...base.owner,
          action,
          stepId: `step-${index}`,
          completed: true,
          traceId: "trace",
          correlationId: "correlation",
          causationId: "cause",
          ...(action === "stop-transport"
            ? {
                transport: {
                  command: "transport.set_playing" as const,
                  dispatchedCount: 1 as const,
                  beforePlaying: true,
                  afterPlaying: false as const,
                  verified: true as const,
                },
              }
            : {}),
        }),
      ),
    },
  };
  return { input, turns, search, comparison, observations };
}
const deliveredFeatureFixture = cachedFixture(buildDeliveredFeatureFixture);
function buildDeliveredFeatureFixture(unavailableConfidence = false) {
  const f = fixture(false, unavailableConfidence);
  const sources = f.turns[1]!.featureSources!;
  const groups = f.observations.map((observation, index) => {
    const source = sources[index]!;
    const range = segmentListeningObservation(observation)[0]!;
    const segment = {
      ...range,
      id: `segment-modern-${index}`,
      entryId: source.contextId,
      sessionId: f.turns[0]!.appSessionId,
      liveSetId: "set",
      order: 0,
    };
    return LISTENING_FEATURE_DEFINITIONS.map((definition) => ({
      segment,
      record: {
        id: `feature-modern-${index}-${definition.type.replace("/", "-")}`,
        entryId: source.contextId,
        segmentId: segment.id,
        sessionId: segment.sessionId,
        liveSetId: segment.liveSetId,
        createdAt: "2026-11-05T00:00:00.000Z",
        sourceFingerprint: source.contentSha256,
        trace: {
          traceId: observation.ownership.traceId,
          correlationId: observation.ownership.correlationId,
          causationId: observation.ownership.causationId,
        },
        feature: extractListeningFeature(definition.type, observation, range),
      } satisfies ContextFeature,
    }));
  });
  const allPages = groups.map((group, index) => {
    const target = {
      kind: "capture" as const,
      sessionId: f.turns[0]!.appSessionId,
      liveSetId: "set",
      contextId: sources[index]!.contextId,
      coordinate: "clip-local-beats" as const,
      range: { startBeat: 0, endBeat: 4 },
    };
    const timeline = projectListeningTimeline(group, 0, target);
    return Array.from(
      { length: Math.ceil(timeline.length / 20) },
      (_, page): AnalysisPage => ({
        source: {
          schema: "metric-audio-observation/v1",
          name: "clip-1",
          nameTruncated: false,
          location: "Session",
          capturedAt: "2026-11-05T00:00:00.000Z",
          coordinate: target.coordinate,
          observedRange: target.range,
          requestedRange: target.range,
          readTarget: target,
          freshness: "fresh",
          geometry: {
            sampleRate: 48000,
            tempoBpm: 128,
            captureStartSample: 0,
            transportStartBeat: 0,
          },
        },
        readTarget: target,
        status: "ready",
        reason: null,
        overview: page === 0 ? projectListeningOverview(group, target) : [],
        overviewIncluded: page === 0,
        overviewExtent: target.range,
        timeline: timeline.slice(page * 20, (page + 1) * 20),
        detail: {
          offset: page * 20,
          returnedItems: Math.min(20, timeline.length - page * 20),
          totalItems: timeline.length,
          truncated: (page + 1) * 20 < timeline.length,
          nextCursor:
            (page + 1) * 20 < timeline.length
              ? `modern-${index}-${page + 1}`
              : null,
        },
      }),
    );
  });
  const left = allPages[0]![0]!,
    right = allPages[1]![0]!;
  const peak = groups.map((group) =>
    group.find((item) => item.record.feature.type === "peak-summary/v1")!,
  );
  const comparison = {
    type: "peak-summary/v1",
    left: left.readTarget.range,
    right: right.readTarget.range,
    comparison: compareListeningFeatures(
      peak[0]!.record.feature,
      peak[1]!.record.feature,
    ),
    reason: null,
  };
  for (const [index, turn] of f.turns.entries()) {
    const history = turn.agentListening!;
    const old = readFeatureToolPairs(turn);
    const seedCall = history.records.find(
      (record) => record.kind === "tool_call",
    )!;
    const seedResult = history.records.find(
      (record) => record.kind === "tool_result",
    )!;
    if (seedCall.kind !== "tool_call" || seedResult.kind !== "tool_result")
      throw new Error("Missing seed");
    const records: AgentHistoryPage["items"] = [];
    const pair = (
      toolName: string,
      args: Record<string, unknown>,
      data: unknown,
    ) => {
      const toolCallId = `modern-${index}-${records.length}`;
      records.push(
        {
          ...seedCall,
          id: `${toolCallId}-call`,
          toolCallId,
          correlationId: toolCallId,
          toolName,
          arguments: args,
        },
        {
          ...seedResult,
          id: `${toolCallId}-result`,
          toolCallId,
          correlationId: toolCallId,
          metadata: { toolName },
          result: {
            result: { content: JSON.parse(JSON.stringify(data)) as unknown },
          },
        },
      );
    };
    const pages = structuredClone(allPages);
    if (index === 2)
      for (const capture of pages)
        for (const page of capture) page.source.freshness = "historical";
    if (index < 2) {
      const capture = old.find(
        (pair) => pair.action === "play-session-and-listen",
      )!;
      pair("ableton_listening", capture.call.arguments, capture.data);
    }
    for (const [sourceIndex, capture] of pages.entries()) {
      if (index === 0 && sourceIndex === 1) continue;
      for (const [pageIndex, page] of capture.entries()) {
        pair(
          "ableton_context",
          {
            action: "read",
            target: page.readTarget,
            includeHistorical: index === 2,
            ...(pageIndex
              ? { cursor: capture[pageIndex - 1]!.detail.nextCursor }
              : {}),
          },
          {
            action: "read",
            analyses: [page],
            nextCursor: page.detail.nextCursor,
          },
        );
      }
    }
    if (index > 0) {
      pair(
        "ableton_context",
        {
          action: "compare",
          left: left.readTarget,
          right: right.readTarget,
          featureTypes: ["peak-summary/v1"],
          includeHistorical: index === 2,
        },
        {
          action: "compare",
          readTarget: {
            kind: "comparison",
            left: left.readTarget,
            right: right.readTarget,
          },
          left: pages[0]![0]!.source,
          right: pages[1]![0]!.source,
          comparisons: [comparison],
          completeExtent: true,
          nextCursor: null,
          truncated: false,
        },
      );
      if (index === 1) {
        const distance =
          comparison.comparison.status === "comparable"
            ? comparison.comparison.distance
            : null;
        pair(
          "ableton_context",
          {
            action: "search",
            query: left.readTarget,
            scope: [right.readTarget],
            featureType: "peak-summary/v1",
            withinCapture: false,
          },
          {
            action: "search",
            query: left.source,
            featureType: "peak-summary/v1",
            distanceUnits: "linear-amplitude",
            aggregation: "compared-value-weighted-rms-of-segment-distances",
            requestedTopK: 10,
            selectedCount: 1,
            returnedCount: 1,
            scannedCount: 1,
            skippedCount: 0,
            exhaustive: true,
            matches: [
              {
                rank: 1,
                source: right.source,
                match: right.source,
                distance,
                comparisons: [comparison],
                evidence: { offset: 0, total: 1, complete: true },
              },
            ],
            nextCursor: null,
            truncated: false,
          },
        );
      }
    }
    records.push(
      ...history.records.filter(
        (record) => record.kind === "turn" || record.kind === "message",
      ),
    );
    Reflect.set(history, "records", records);
  }
  return f;
}
describe("direct musical feature-search evidence", () => {
  it("accepts explicitly unavailable confidence without inventing empty measured rows", () => {
    const f = deliveredFeatureFixture(true);
    expect(() => verifyFeatureSearch(f.input, "final")).not.toThrow();
    const feature = deliveredAnalysisFeatures(
      readCompleteAnalyses([f.turns[0]!])[0]!,
    ).find((item) => item.definition.type === "pitch-confidence-summary/v1")!;
    expect(feature.blocks).toEqual([]);
    expect(feature.supports).toEqual([]);
    expect(feature.availability).toHaveLength(1);
    expect(feature.availability[0]!.block.values).toBeNull();
  });
  it.each([
    "numeric",
    "status",
    "units",
    "reason",
    "canonical-reason",
    "owner",
    "time",
    "expected",
    "covered",
    "missing",
  ] as const)(
    "rejects identical unavailable confidence marker %s tampering",
    (mode) => {
      const f = deliveredFeatureFixture(true);
      expect(() => verifyFeatureSearch(f.input, "final")).not.toThrow();
      let changed = 0;
      for (const turn of f.turns)
        for (const pair of readFeatureToolPairs(turn))
          for (const page of (pair.data.analyses ?? []) as AnalysisPage[]) {
            if (mode === "canonical-reason")
              for (const overview of page.overview)
                if (overview.type === "pitch-confidence-summary/v1")
                  overview.reason = "low-confidence";
            for (const row of page.timeline) {
              if (row.kind !== "availability") continue;
              const block = row.features.find(
                (item) => item.type === "pitch-confidence-summary/v1",
              );
              if (!block) continue;
              changed++;
              if (mode === "numeric") block.values = [0.2, 0.3];
              if (mode === "status") block.status = "ready";
              if (mode === "units") block.units = "Hz";
              if (mode === "reason") block.reason = "";
              if (mode === "canonical-reason") {
                block.reason = "low-confidence";
                block.channelReasons = ["low-confidence", "low-confidence"];
              }
              if (mode === "owner") row.segment.sessionId = "foreign";
              if (mode === "time") row.startBeat += 0.25;
              if (mode === "expected") block.expectedSamples++;
              if (mode === "covered") block.coveredSamples--;
              if (mode === "missing")
                row.features = row.features.filter((item) => item !== block);
            }
          }
      expect(changed).toBeGreaterThan(0);
      expect(() => verifyFeatureSearch(f.input, "final")).toThrow();
    },
  );
  it("rejects unavailable confidence markers when independent native confidence is measured", () => {
    const f = deliveredFeatureFixture(true);
    expect(() => verifyFeatureSearch(f.input, "final")).not.toThrow();
    for (const turn of f.turns)
      for (const source of turn.featureSources ?? []) {
        const pitch = source.analyzers!.pitch;
        Reflect.set(source, "analyzers", {
          ...source.analyzers,
          pitch: pitchTimelineSchema.parse({
            ...pitch,
            frames: pitch.frames.map((frame) => ({
              ...frame,
              channels: [
                { state: "low-confidence", hz: 100, confidence: 0.2 },
                { state: "low-confidence", hz: 100, confidence: 0.3 },
              ],
            })),
          }),
        });
      }
    expect(() => verifyFeatureSearch(f.input, "final")).toThrow(
      /native measurements|channel validity|missing delivered/u,
    );
  });
  it("requires explicit unavailable grid evidence even when default unaligned analysis has no grid rows", () => {
    const f = deliveredFeatureFixture();
    expect(() => verifyFeatureSearch(f.input, "final")).not.toThrow();
    for (const turn of f.turns)
      for (const pair of readFeatureToolPairs(turn))
        for (const page of (pair.data.analyses ?? []) as AnalysisPage[])
          page.overview = page.overview.filter(
            (item) => item.type !== "pitch-grid/v1",
          );
    expect(() => verifyFeatureSearch(f.input, "final")).toThrow(
      "missing delivered canonical feature families",
    );
  });
  it.each(["history", "sources", "both", "second"] as const)(
    "rejects modern %s restart-provenance corruption",
    (mode) => {
      const f = deliveredFeatureFixture();
      const turn = mode === "second" ? f.turns[1]! : f.turns[2]!;
      if (mode !== "sources")
        Reflect.set(
          turn.agentListening!,
          "afterOwnedRestart",
          mode === "second",
        );
      if (mode !== "history")
        for (const source of turn.featureSources!)
          Reflect.set(source, "afterOwnedRestart", mode === "second");
      expect(() => verifyFeatureSearch(f.input, "final")).toThrow(
        mode === "second"
          ? "second-turn evidence mismatch"
          : "no owned restart evidence",
      );
    },
  );
  it("verifies actual listen analyses, read continuations, comparison, search and restored numbers", () => {
    const f = deliveredFeatureFixture();
    expect(() => verifyFeatureSearch(f.input, "final")).not.toThrow();
    expect(
      JSON.stringify(f.turns.map((turn) => turn.agentListening)),
    ).not.toContain("get-feature");
  });
  it("uses pinned source/range/type identity without requiring storage IDs or raw measurement reads", () => {
    const f = deliveredFeatureFixture();
    for (const turn of f.turns)
      for (const pair of readFeatureToolPairs(turn))
        for (const page of (pair.data.analyses ?? []) as AnalysisPage[])
          for (const row of page.timeline) {
            delete row.featureRecord;
            delete row.definition;
            for (const key of [
              "id",
              "entryId",
              "sessionId",
              "liveSetId",
              "order",
              "coordinate",
            ])
              Reflect.deleteProperty(row.segment, key);
          }
    expect(() => verifyFeatureSearch(f.input, "final")).not.toThrow();
  });
  it.each([
    "peak",
    "flatness",
    "confidence",
    "coverage",
    "units",
    "range",
    "owner",
    "comparison",
    "search",
    "compare-continuation",
    "search-continuation",
    "missing-page",
    "restored",
  ] as const)("rejects actual delivered %s corruption", (mode) => {
    const f = deliveredFeatureFixture();
    const turn = mode === "restored" ? f.turns[2]! : f.turns[1]!;
    const pairs = readFeatureToolPairs(turn);
    if (mode === "compare-continuation" || mode === "search-continuation") {
      const data = pairs.find(
        (pair) =>
          pair.action ===
          (mode === "compare-continuation" ? "compare" : "search"),
      )!.data;
      data.nextCursor = "unread-continuation";
      data.truncated = true;
    } else if (mode === "comparison")
      Reflect.set(
        pairs.find((pair) => pair.action === "compare")!.data,
        "completeExtent",
        false,
      );
    else if (mode === "search") {
      const data = pairs.find((pair) => pair.action === "search")!.data;
      Reflect.set((data.matches as { distance: number }[])[0]!, "distance", 99);
    } else if (mode === "missing-page") {
      const page = (
        pairs.find((pair) => Array.isArray(pair.data.analyses))!.data
          .analyses as AnalysisPage[]
      )[0]!;
      page.detail.totalItems++;
      page.detail.truncated = true;
      page.detail.nextCursor = "missing-musical-continuation";
    } else {
      const pages = pairs.flatMap(
        (pair) => (pair.data.analyses ?? []) as AnalysisPage[],
      );
      if (mode === "range") pages[0]!.readTarget.range.endBeat = 3;
      else if (mode === "owner") pages[0]!.readTarget.sessionId = "foreign";
      else {
        const type =
          mode === "flatness"
            ? "flatness-summary/v1"
            : mode === "confidence"
              ? "pitch-confidence-summary/v1"
              : "peak-summary/v1";
        const block = pages
          .flatMap((page) => page.timeline)
          .flatMap((row) => row.features)
          .find((block) => block.type === type)!;
        if (mode === "coverage") block.coveredSamples--;
        else if (mode === "units") Reflect.set(block, "units", "hz");
        else block.values![0] = 123;
      }
    }
    expect(() => verifyFeatureSearch(f.input, "final")).toThrow();
  });
});
function result(turn: TurnEvidence, action: string) {
  const found = turn.agentListening!.records.find(
    (record) =>
      record.kind === "tool_result" &&
      (record.result?.result as { content?: { action?: string } })?.content
        ?.action === action,
  );
  if (!found || found.kind !== "tool_result")
    throw new Error("Missing synthetic result");
  return (found.result!.result as { content: Record<string, unknown> }).content;
}
function analyzerResult(turn: TurnEvidence, type: string) {
  for (const record of turn.agentListening!.records) {
    if (record.kind !== "tool_result") continue;
    const data = (
      record.result?.result as { content?: Record<string, unknown> }
    )?.content;
    if (
      data?.action === "get-feature" &&
      (data.feature as { record: { feature: { type: string } } }).record.feature
        .type === type
    )
      return data as {
        feature: {
          record: {
            id: string;
            feature: {
              type: string;
              status: string;
              channelReasons: (string | null)[];
            };
          };
        };
        page: { values: (number | null)[] };
      };
  }
  throw new Error("Missing synthetic analyzer feature");
}
const peakFixture = cachedFixture(buildPeakFixture);
function buildPeakFixture(equalPeaks = false) {
  const full = fixture(false, false, 1, equalPeaks);
  const turns = full.turns.slice(0, 2);
  for (const [index, turn] of turns.entries()) {
    const omitted = new Set<string>();
    for (const record of turn.agentListening!.records) {
      if (record.kind !== "tool_result") continue;
      const data = (
        record.result?.result as {
          content: {
            action: string;
            feature?: { record: { feature: { type: string } } };
            features?: { record: { feature: { type: string } } }[];
            inventory?: Parameters<typeof expandListeningFeatureInventory>[0];
          };
        }
      ).content;
      if (
        data.action === "feature-definitions" ||
        (data.action === "get-feature" &&
          data.feature?.record.feature.type !== "peak-summary/v1") ||
        (data.action === "list-features" &&
          !expandListeningFeatureInventory(data.inventory!).some(
            (feature) => feature.record.feature.type === "peak-summary/v1",
          ))
      )
        omitted.add(record.toolCallId);
    }
    Object.assign(turn.agentListening!, {
      records: turn.agentListening!.records.filter(
        (record) =>
          !("toolCallId" in record) ||
          record.toolCallId === undefined ||
          !omitted.has(record.toolCallId),
      ),
    });
    Object.assign(turn, {
      featureSources: turn.featureSources!.map((source) => {
        const copy = { ...source };
        delete copy.analyzers;
        return copy;
      }),
      captures: turn.captures.map((capture) => ({
        ...capture,
        operationId: turn.operationId,
        native: {
          ...capture.native!,
          generation: turn.facts.sdkTurnId,
          nativeEpoch: index + 1,
        },
      })),
    });
  }
  const input: AssertionInput = {
    ...full.input,
    turns,
    turn: turns[1]!,
    evidence: {
      ...full.input.evidence!,
      contexts: turns[1]!.contexts,
      featureSources: turns[1]!.featureSources!,
      setupActions: full.input.evidence!.setupActions!.slice(0, 1),
      unchanged: [
        "session-structure",
        "source-settings",
        "fixture-media",
        "unrelated-playback",
      ].map((scope) => ({
        scope,
        beforeSha256: "a".repeat(64),
        afterSha256: "a".repeat(64),
      })),
    },
  };
  return { input, turns };
}
function omitTool(turn: TurnEvidence, action: string, featureId?: string) {
  const records = turn.agentListening!.records;
  const omitted = new Set(
    records
      .filter(
        (record) =>
          record.kind === "tool_call" &&
          record.arguments.action === action &&
          (featureId === undefined || record.arguments.featureId === featureId),
      )
      .map((record) =>
        "toolCallId" in record ? record.toolCallId : undefined,
      ),
  );
  Object.assign(turn.agentListening!, {
    records: records.filter(
      (record) => !("toolCallId" in record) || !omitted.has(record.toolCallId),
    ),
  });
}
const priorPeakFixture = cachedFixture(buildPriorPeakFixture);
function buildPriorPeakFixture() {
  const value = peakFixture();
  omitTool(value.turns[1]!, "get-feature", "feature-1");
  return value;
}
function canonicalMetadata(type: string) {
  const definition = LISTENING_FEATURE_DEFINITIONS.find(
    (item) => item.type === type,
  )!;
  const unavailable = definition.grid;
  const channelAware = [
    "pitch-profile/v1",
    "spectral-shape-profile/v1",
  ].includes(definition.profile);
  return {
    type,
    profile: definition.profile,
    units: definition.units,
    distanceDefinition: definition.distanceDefinition,
    distanceUnits: definition.distanceUnits,
    normalization: definition.normalization,
    status: unavailable ? "unavailable" : "ready",
    reason: unavailable ? "missing-alignment" : null,
    coveredSamples: 90000,
    expectedSamples: 90000,
    durationSeconds: 1.875,
    sampleRate: 48000,
    supportPolicy: definition.grid
      ? "matching-cell-mask"
      : type === "peak-summary/v1"
        ? "complete-required"
        : "retained-overlap",
    valueCount: unavailable ? 0 : definition.dimensions,
    supportIntervalCount: 1,
    grid: null,
    ...(channelAware
      ? { channelSupportIntervalCounts: [1, 1], channelReasons: [null, null] }
      : {}),
  };
}
function completeInventory(turn: TurnEvidence) {
  const inventory = result(turn, "list-features");
  const original = inventoryViews(inventory)[0]!;
  inventory.inventory = projectListeningFeatureInventory(
    LISTENING_FEATURE_DEFINITIONS.map((definition) => {
      const feature = structuredClone(original);
      if (definition.type !== "peak-summary/v1")
        feature.record.id += `-${definition.type.split("/")[0]}`;
      return contextFeatureViewSchema.parse({
        ...feature,
        record: {
          ...feature.record,
          feature: canonicalMetadata(definition.type),
        },
      });
    }),
  );
}
function inventoryViews(data: Record<string, unknown>) {
  return expandListeningFeatureInventory(
    data.inventory as Parameters<typeof expandListeningFeatureInventory>[0],
  ).map((feature) => ({
    ...feature,
    source: { ...feature.source, summary: "Controlled feature inventory" },
  }));
}
const equalityFixture = cachedFixture(buildEqualityFixture);
function buildEqualityFixture(coverage: "full" | "peak-only") {
  const value =
    coverage === "full" ? fixture(false, false, 1, true) : peakFixture(true);
  for (const id of firstFeatureIds)
    omitTool(value.turns[1]!, "get-feature", id);
  omitTool(value.turns[1]!, "get-feature", "feature-2");
  if (coverage === "full") {
    completeInventory(value.turns[1]!);
    omitTool(value.turns[1]!, "feature-definitions");
  }
  return value;
}
describe.each(["full", "peak-only"] as const)(
  "evidence-established peaks (%s)",
  (coverage) => {
    it("accepts exact equality and canonical discovery without inventing calls or altering History", () => {
      const { input, turns } = equalityFixture(coverage);
      const history = JSON.stringify(turns);
      expect(() => verifyFeatureSearch(input, "final", coverage)).not.toThrow();
      expect(JSON.stringify(turns)).toBe(history);
    });
    it("independently rejects a false zero comparison between genuinely unequal measured vectors", () => {
      const { input, turns } = coverage === "full" ? fixture() : peakFixture();
      omitTool(turns[1]!, "get-feature", "feature-2");
      (
        result(turns[1]!, "compare-features").comparisons as {
          result: { distance: number };
        }[]
      )[0]!.result.distance = 0;
      (
        result(turns[1]!, "search-features").matches as { distance: number }[]
      )[0]!.distance = 0;
      expect(() => verifyFeatureSearch(input, "final", coverage)).toThrow(
        "exact peak equality",
      );
    });
    it.each([
      "nonzero",
      "tiny-nonzero",
      "missing-comparison",
      "missing-search",
      "source",
      "identity",
      "range",
      "units",
      "normalization",
      "corrupt-source",
      "bad-direct-read",
      "foreign-owner",
      "inventory-request",
    ] as const)(
      "rejects insufficient or contradictory equality evidence (%s)",
      (mode) => {
        const { input, turns } = equalityFixture(coverage);
        const second = turns[1]!;
        const comparison = (
          result(second, "compare-features").comparisons as {
            rightFeatureId: string;
            result: { distance: number };
          }[]
        )[0]!;
        const search = result(second, "search-features");
        const match = (
          search.matches as {
            feature: {
              source: { passId: string };
              record: { id: string; feature: Record<string, unknown> };
              segment: { startSample: number };
            };
          }[]
        )[0]!;
        match.feature = structuredClone(match.feature);
        if (mode === "nonzero") comparison.result.distance = 1;
        if (mode === "tiny-nonzero") comparison.result.distance = 1e-14;
        if (mode === "missing-comparison") omitTool(second, "compare-features");
        if (mode === "missing-search") omitTool(second, "search-features");
        if (mode === "source") match.feature.source.passId = "foreign";
        if (mode === "identity") comparison.rightFeatureId = "foreign";
        if (mode === "range") match.feature.segment.startSample++;
        if (mode === "units") match.feature.record.feature.units = "Hz";
        if (mode === "normalization")
          match.feature.record.feature.normalization = "joint-l2";
        if (mode === "foreign-owner")
          second.agentListening!.records[0]!.appSessionId = "foreign";
        if (mode === "inventory-request")
          for (const record of second.agentListening!.records)
            if (
              record.kind === "tool_call" &&
              record.arguments.action === "list-features"
            )
              record.arguments.contextId = "foreign";
        if (mode === "corrupt-source")
          Object.assign(second.featureSources![1]!.records[0]!, {
            peak: [20, 20],
          });
        if (mode === "bad-direct-read") {
          const fresh =
            coverage === "full"
              ? fixture(false, false, 1, true)
              : peakFixture(true);
          const records = fresh.turns[1]!.agentListening!.records;
          const call = records.find(
            (record) =>
              record.kind === "tool_call" &&
              record.arguments.featureId === "feature-2",
          )!;
          const direct = records.filter(
            (record) =>
              "toolCallId" in record &&
              record.toolCallId === (call as { toolCallId: string }).toolCallId,
          );
          const response = direct.find(
            (record) => record.kind === "tool_result",
          )!;
          (
            response.result!.result as {
              content: { page: { values: number[] } };
            }
          ).content.page.values = [42, 42];
          second.agentListening!.records.push(...direct);
        }
        expect(() => verifyFeatureSearch(input, "final", coverage)).toThrow();
      },
    );
  },
);
describe("inventory discovery and equality persistence", () => {
  it("establishes target metadata from genuine search when only the first peak appears in the inventory", () => {
    const { input, turns } = equalityFixture("peak-only");
    const second = turns[1]!;
    result(second, "list-features").inventory =
      projectListeningFeatureInventory([
        contextFeatureViewSchema.parse(result(second, "search-features").query),
      ]);
    for (const record of second.agentListening!.records)
      if (
        record.kind === "tool_call" &&
        record.arguments.action === "list-features"
      )
        record.arguments.contextId = "context-1";
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
  });
  it("accepts complete canonical inventory without a catalog even for unequal directly-read peaks", () => {
    const { input, turns } = fixture();
    completeInventory(turns[1]!);
    omitTool(turns[1]!, "feature-definitions");
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
  });
  it.each([
    "missing-type",
    "duplicate-type",
    "profile",
    "units",
    "distance",
    "normalization",
    "status",
    "reason",
    "count",
    "sample-rate",
    "source",
    "hash",
    "range",
    "session",
    "bad-catalog",
  ] as const)("rejects incomplete or invalid discovery (%s)", (mode) => {
    const { input, turns } = equalityFixture("full");
    const inventory = result(turns[1]!, "list-features");
    const indexed = inventory.inventory as ReturnType<
      typeof projectListeningFeatureInventory
    >;
    const features = indexed.features.map((reference) => ({
      record: indexed.provenance[reference.provenance]!,
      metadata: indexed.metadata[reference.metadata]!,
      source: indexed.sources[reference.source]!,
      segment: indexed.segments[reference.segment]!,
    })) as {
      record: {
        sessionId: string;
        sourceFingerprint: string;
      };
      metadata: Record<string, unknown>;
      source: { passId: string };
      segment: { endSample: number };
    }[];
    const feature = features.find(
      (feature) => feature.metadata.type === "mel-shape/v1",
    )!;
    const index = features.indexOf(feature);
    if (mode === "missing-type") indexed.features.splice(index, 1);
    if (mode === "duplicate-type")
      indexed.features[index] = indexed.features[0]!;
    if (mode === "profile")
      feature.metadata.profile = "sample-grid-peak-rms/v1";
    if (mode === "units") feature.metadata.units = "Hz";
    if (mode === "distance") feature.metadata.distanceDefinition = "rms-hz/v1";
    if (mode === "normalization") feature.metadata.normalization = "none";
    if (mode === "status") feature.metadata.status = "failed";
    if (mode === "reason") feature.metadata.reason = "missing-alignment";
    if (mode === "count") feature.metadata.valueCount = 0;
    if (mode === "sample-rate") feature.metadata.sampleRate = 44100;
    if (mode === "source") feature.source.passId = "foreign";
    if (mode === "hash") feature.record.sourceFingerprint = "b".repeat(64);
    if (mode === "range") feature.segment.endSample++;
    if (mode === "session") feature.record.sessionId = "foreign";
    if (mode === "bad-catalog") {
      const donor = fixture().turns[1]!;
      const call = donor.agentListening!.records.find(
        (record) =>
          record.kind === "tool_call" &&
          record.arguments.action === "feature-definitions",
      )!;
      result(donor, "feature-definitions").definitions = [];
      turns[1]!.agentListening!.records.push(
        ...donor.agentListening!.records.filter(
          (record) =>
            "toolCallId" in record &&
            record.toolCallId === (call as { toolCallId: string }).toolCallId,
        ),
      );
    }
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it.each([
    "missing",
    "identity",
    "metadata",
    "values",
    "source",
    "cached",
  ] as const)(
    "requires fresh unchanged equality-established target after restart (%s)",
    (mode) => {
      const { input, turns } = equalityFixture("full");
      const restored = turns[2]!;
      if (mode === "missing") omitTool(restored, "get-feature", "feature-2");
      else if (mode === "cached")
        Object.assign(restored.agentListening!, { afterOwnedRestart: false });
      else {
        const read = restored.agentListening!.records.find(
          (record) =>
            record.kind === "tool_result" &&
            (
              record.result?.result as {
                content?: { feature?: { record: { id: string } } };
              }
            )?.content?.feature?.record.id === "feature-2",
        )!;
        if (read.kind !== "tool_result")
          throw new Error("Missing restored read");
        const data = (
          read.result!.result as {
            content: {
              feature: {
                record: { id: string; feature: Record<string, unknown> };
                source: { passId: string };
              };
              page: { values: number[] };
            };
          }
        ).content;
        data.feature = structuredClone(data.feature);
        if (mode === "identity") {
          data.feature.record.id = "new-feature";
          for (const record of restored.agentListening!.records)
            if (
              record.kind === "tool_call" &&
              record.arguments.featureId === "feature-2"
            )
              record.arguments.featureId = "new-feature";
          (
            result(restored, "compare-features").comparisons as {
              rightFeatureId: string;
            }[]
          )[0]!.rightFeatureId = "new-feature";
          for (const record of restored.agentListening!.records)
            if (
              record.kind === "tool_call" &&
              record.arguments.action === "compare-features"
            )
              record.arguments.pairs = [
                { leftFeatureId: "feature-1", rightFeatureId: "new-feature" },
              ];
        }
        if (mode === "metadata")
          data.feature.record.feature.supportIntervalCount = 2;
        if (mode === "values") data.page.values = [10, 10];
        if (mode === "source") data.feature.source.passId = "different-pass";
      }
      expect(() => verifyFeatureSearch(input, "restored")).toThrow();
    },
  );
});
describe("same-session peak fundamentals coverage", () => {
  it("accepts omitted public listener IDs only with independently admitted native capture ownership", () => {
    const { input, turns } = peakFixture();
    for (const turn of turns)
      for (const record of turn.agentListening!.records)
        if (
          record.kind === "tool_call" &&
          record.arguments.action === "play-session-and-listen"
        )
          delete record.arguments.listenerIds;
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
    Reflect.set(turns[0]!.captures[0]!, "listenerId", "other-listener");
    expect(() => verifyFeatureSearch(input, "final", "peak-only")).toThrow(
      "foreign capture source",
    );
  });
  it("rejects a wrong explicitly requested listener even when native ownership matches", () => {
    const { input, turns } = peakFixture();
    for (const record of turns[0]!.agentListening!.records)
      if (
        record.kind === "tool_call" &&
        record.arguments.action === "play-session-and-listen"
      )
        record.arguments.listenerIds = ["other-listener"];
    expect(() => verifyFeatureSearch(input, "final", "peak-only")).toThrow(
      "capture tool result is foreign",
    );
  });
  it("accepts a prior immutable typed first-feature read, with genuine second-turn read/comparison/search", () => {
    const { input } = priorPeakFixture();
    expect(() =>
      verifyFeatureSearch(input, "second", "peak-only"),
    ).not.toThrow();
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
  });
  it("does not carry prior reads into the restored turn", () => {
    const { input, turns } = fixture();
    omitTool(turns[2]!, "get-feature", "feature-1");
    expect(() => verifyFeatureSearch(input, "final")).toThrow(
      "missing typed peak",
    );
  });
  it("cannot replace the first turn's genuine read with a later read", () => {
    const { input, turns } = peakFixture();
    omitTool(turns[0]!, "get-feature");
    expect(() => verifyFeatureSearch(input, "second", "peak-only")).toThrow(
      "missing typed peak",
    );
  });
  it.each([
    "app-session",
    "agent",
    "conversation",
    "raw-owner",
    "wrong-feature",
    "first-read",
    "first-call",
    "first-result",
    "second-read",
    "comparison",
    "search",
    "swapped-history",
    "swapped-source",
    "swapped-comparison",
    "query-provenance",
    "query-metadata",
    "match-provenance",
    "first-values",
  ] as const)("rejects invalid prior-read evidence (%s)", (mode) => {
    const { input, turns } = priorPeakFixture();
    const first = turns[0]!;
    const second = turns[1]!;
    if (mode === "app-session")
      Object.assign(first, { appSessionId: "foreign" });
    if (mode === "agent") Object.assign(first, { agentId: "foreign" });
    if (mode === "conversation")
      Object.assign(first, { conversationId: "foreign" });
    if (mode === "raw-owner")
      Object.assign(first.agentListening!.records[0]!, {
        appSessionId: "00000000-0000-4000-8000-000000000099",
      });
    if (mode === "wrong-feature")
      for (const record of first.agentListening!.records)
        if (
          record.kind === "tool_call" &&
          record.arguments.action === "get-feature"
        )
          record.arguments.featureId = "different-feature";
    if (mode === "first-read") omitTool(first, "get-feature");
    if (mode === "first-call")
      Object.assign(first.agentListening!, {
        records: first.agentListening!.records.filter(
          (record) =>
            record.kind !== "tool_call" ||
            record.arguments.action !== "get-feature",
        ),
      });
    if (mode === "first-result")
      Object.assign(first.agentListening!, {
        records: first.agentListening!.records.filter(
          (record) =>
            record.kind !== "tool_result" ||
            (record.result?.result as { content?: { action?: string } })
              ?.content?.action !== "get-feature",
        ),
      });
    if (mode === "second-read") omitTool(second, "get-feature");
    if (mode === "comparison") omitTool(second, "compare-features");
    if (mode === "search") omitTool(second, "search-features");
    if (mode === "swapped-history") {
      const history = first.agentListening;
      Object.assign(first, { agentListening: second.agentListening });
      Object.assign(second, { agentListening: history });
    }
    if (mode === "swapped-source")
      Object.assign(second, {
        featureSources: [...second.featureSources!].reverse(),
      });
    if (mode === "swapped-comparison") {
      const comparison = (
        result(second, "compare-features").comparisons as {
          leftEvidence: unknown;
          rightEvidence: unknown;
        }[]
      )[0]!;
      [comparison.leftEvidence, comparison.rightEvidence] = [
        comparison.rightEvidence,
        comparison.leftEvidence,
      ];
    }
    if (mode === "query-provenance" || mode === "query-metadata") {
      const search = result(second, "search-features");
      const query = structuredClone(search.query) as {
        record: { sourceFingerprint: string; feature: { profile: string } };
      };
      search.query = query;
      if (mode === "query-provenance")
        query.record.sourceFingerprint = "c".repeat(64);
      else query.record.feature.profile = "different-profile";
    }
    if (mode === "match-provenance") {
      const search = result(second, "search-features");
      const matches = structuredClone(search.matches) as {
        feature: { source: { passId: string } };
      }[];
      search.matches = matches;
      matches[0]!.feature.source.passId = "different-pass";
    }
    if (mode === "first-values")
      (result(first, "get-feature").page as { values: number[] }).values = [
        10, 20,
      ];
    expect(() => verifyFeatureSearch(input, "second", "peak-only")).toThrow();
    expect(() => verifyFeatureSearch(input, "final", "peak-only")).toThrow();
  });
  it("rejects changed first-feature content on a second-turn reread", () => {
    const { input, turns } = peakFixture();
    const read = result(turns[1]!, "get-feature");
    const feature = structuredClone(read.feature) as {
      record: { feature: { profile: string } };
    };
    read.feature = feature;
    feature.record.feature.profile = "different-profile";
    expect(() => verifyFeatureSearch(input, "second", "peak-only")).toThrow();
  });
  it("verifies exactly two ordinary captures without catalog/analyzer reads or restart", () => {
    const { input, turns } = peakFixture();
    expect(() =>
      verifyFeatureSearch(input, "final", "peak-only"),
    ).not.toThrow();
    expect(
      turns.every((turn) => turn.captures[0]!.metricFamilies.length === 6),
    ).toBe(true);
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
    expect(() => validateFeatureSources(turns[0]!.featureSources)).toThrow(
      "analyzer",
    );
  });
  it("keeps full projection strict by default without changing the observation or capture request", () => {
    const observation = melSmokeFixture().observation;
    const original = JSON.stringify(observation);
    expect(
      projectFeatureSource("context", observation, false, "peak-only")
        .analyzers,
    ).toBeUndefined();
    expect(() => projectFeatureSource("context", observation, false)).toThrow(
      "metric family",
    );
    expect(JSON.stringify(observation)).toBe(original);
  });
  it("admits the registered peak scope while preserving the original full/restart contract", async () => {
    const root = new URL("../../../../integration/", import.meta.url);
    const read = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, root), "utf8")) as unknown;
    const fixtureManifest = await read(
      "fixtures/session-clip-identify/fixture.json",
    );
    const scenario = await read(
      "acceptance-scenarios/session-listening-peak-smoke.json",
    );
    const original = await read(
      "acceptance-scenarios/session-listening-feature-search.json",
    );
    const registry = createDefaultAssertions();
    validateFixture(fixtureManifest);
    validateScenario(scenario, fixtureManifest, registry.names);
    validateScenario(original, fixtureManifest, registry.names);
    expect(scenario.requiredCapabilities).not.toContain("persistence");
    expect(scenario.steps).toHaveLength(2);
    expect(scenario.steps.flatMap((step) => step.setupActions ?? [])).toEqual([
      "stop-transport",
    ]);
    expect(original.requiredCapabilities).toContain("persistence");
    expect(original.steps).toHaveLength(3);
    expect(original.steps[2]!.setupActions).toEqual(["restart-owned-desktop"]);
    expect(original.steps.map((step) => step.timeoutMs)).toEqual([
      150_000, 300_000, 300_000,
    ]);
    expect(original.budget.runMs).toBe(
      original.steps.reduce((total, step) => total + step.timeoutMs, 0) +
        30_000,
    );
    expect(
      [
        ...original.assertions,
        ...original.steps.flatMap((step) => step.assertions),
      ]
        .filter((assertion) => assertion.name === "feature-search")
        .every((assertion) => assertion.parameters.coverage === undefined),
    ).toBe(true);
    const { input, turns } = peakFixture();
    for (const [index, step] of scenario.steps.entries())
      for (const assertion of step.assertions)
        expect(
          registry.evaluate(assertion, {
            ...input,
            turns: turns.slice(0, index + 1),
            turn: turns[index]!,
          }).passed,
        ).toBe(true);
    for (const assertion of scenario.assertions)
      expect(registry.evaluate(assertion, input).passed).toBe(true);
    expect(() =>
      registry.validate({
        name: "feature-search",
        parameters: { phase: "restored", coverage: "peak-only" },
      }),
    ).toThrow();
    expect(() =>
      registry.validate({
        name: "feature-search",
        parameters: { phase: "final", coverage: "peaks" },
      }),
    ).toThrow();
  });
  it.each([
    "distance",
    "exclusion",
    "self-match",
    "owner",
    "restart",
    "capture-cleanup",
    "extra-capture",
    "source-hash",
  ] as const)("rejects broken same-session peak evidence (%s)", (mode) => {
    const { input, turns } = peakFixture();
    if (mode === "distance")
      (
        result(turns[1]!, "compare-features").comparisons as {
          result: { distance: number };
        }[]
      )[0]!.result.distance = 100;
    if (mode === "exclusion")
      for (const record of turns[1]!.agentListening!.records)
        if (
          record.kind === "tool_call" &&
          record.arguments.action === "search-features"
        )
          record.arguments.excludeContextIds = [];
    if (mode === "self-match") {
      const search = result(turns[1]!, "search-features");
      (search.matches as { feature: unknown }[])[0]!.feature = search.query;
    }
    if (mode === "owner") Object.assign(turns[1]!, { agentId: "foreign" });
    if (mode === "restart")
      Object.assign(turns[1]!.agentListening!, { afterOwnedRestart: true });
    if (mode === "capture-cleanup")
      Object.assign(turns[1]!.captures[0]!, { cleanupComplete: false });
    if (mode === "extra-capture")
      Object.assign(turns[1]!, {
        captures: [...turns[1]!.captures, turns[0]!.captures[0]!],
      });
    if (mode === "source-hash")
      Object.assign(turns[1]!.featureSources![0]!, {
        contentSha256: "c".repeat(64),
      });
    expect(() => verifyFeatureSearch(input, "final", "peak-only")).toThrow();
  });
  it("retains final native freshness and protected fixture assertions", () => {
    const { input, turns } = peakFixture();
    const registry = createDefaultAssertions();
    Object.assign(turns[1]!.captures[0]!.native!, { nativeEpoch: 1 });
    expect(
      registry.evaluate({ name: "native-freshness", parameters: {} }, input)
        .passed,
    ).toBe(false);
    Object.assign(input.evidence!.unchanged[0]!, {
      afterSha256: "b".repeat(64),
    });
    expect(
      registry.evaluate(
        { name: "unchanged", parameters: { scopes: "session-structure" } },
        input,
      ).passed,
    ).toBe(false);
  });
});
const firstFeatureIds = [
  "feature-1",
  "feature-1-pitch-confidence-summary",
  "feature-1-flatness-summary",
  "feature-1-spread-summary",
  "feature-1-rolloff-summary",
];
const priorFullFixture = cachedFixture(buildPriorFullFixture);
function buildPriorFullFixture() {
  const value = fixture(true, false, 32);
  for (const id of firstFeatureIds)
    omitTool(value.turns[1]!, "get-feature", id);
  return value;
}
const priorPitchInventoryFixture = cachedFixture(
  buildPriorPitchInventoryFixture,
);
function buildPriorPitchInventoryFixture() {
  const value = priorFullFixture();
  const first = value.turns[0]!;
  const second = value.turns[1]!;
  type PitchInventory = ReturnType<typeof inventoryViews>[number];
  let pitch: PitchInventory | undefined;
  for (const record of second.agentListening!.records) {
    if (record.kind !== "tool_result") continue;
    const data = (
      record.result?.result as { content?: Record<string, unknown> }
    )?.content;
    if (data?.action !== "list-features") continue;
    const features = inventoryViews(data);
    data.inventory = projectListeningFeatureInventory(
      features.filter((feature) => {
        if (
          feature.record.entryId === first.featureSources![0]!.contextId &&
          feature.record.feature.type === "pitch-grid/v1"
        ) {
          pitch = structuredClone(feature);
          return false;
        }
        return true;
      }),
    );
  }
  if (!pitch) throw new Error("Missing synthetic pitch inventory");
  const firstInventory = result(first, "list-features");
  firstInventory.inventory = projectListeningFeatureInventory([
    ...inventoryViews(firstInventory),
    pitch,
  ]);
  return { ...value, pitch };
}
describe("same-conversation immutable full-feature reads", () => {
  it("accepts prior pitch availability from a direct feature result instead of inventory", () => {
    const { input, turns, pitch } = priorPitchInventoryFixture();
    const call = turns[0]!.agentListening!.records.find(
      (record) =>
        record.kind === "tool_call" &&
        record.arguments.action === "list-features",
    );
    if (call?.kind !== "tool_call")
      throw new Error("Missing synthetic inventory call");
    const records = turns[0]!.agentListening!.records;
    const response = records.find(
      (record) =>
        record.kind === "tool_result" && record.toolCallId === call.toolCallId,
    );
    if (response?.kind !== "tool_result")
      throw new Error("Missing synthetic inventory result");
    const data = result(turns[0]!, "list-features");
    data.inventory = projectListeningFeatureInventory(
      inventoryViews(data).filter(
        (feature) => feature.record.id !== pitch.record.id,
      ),
    );
    const directCall = structuredClone(call);
    const directResult = structuredClone(response);
    directCall.id += "-pitch";
    directCall.toolCallId += "-pitch";
    directCall.correlationId = directCall.toolCallId;
    directCall.arguments = {
      action: "get-feature",
      featureId: pitch.record.id,
    };
    directResult.id += "-pitch";
    directResult.toolCallId = directCall.toolCallId;
    directResult.correlationId = directCall.toolCallId;
    Object.assign(directResult.result!.result!, {
      content: {
        action: "get-feature",
        feature: pitch,
        page: { offset: 0, nextOffset: null, values: null },
      },
    });
    records.push(directCall, directResult);
    verifyFeatureSearch(input, "final");
  });
  it("does not let earlier availability hide a contradictory later result", () => {
    const { input, turns, pitch } = priorPitchInventoryFixture();
    const data = result(turns[1]!, "list-features");
    data.inventory = projectListeningFeatureInventory([
      ...inventoryViews(data),
      pitch,
    ]);
    const page = data.inventory as ReturnType<
      typeof projectListeningFeatureInventory
    >;
    page.metadata[page.features.at(-1)!.metadata]!.status = "ready";
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it.each([false, true])(
    "accepts pitch availability already established in conversation (projected=%s)",
    (projected) => {
      const { input, turns } = priorPitchInventoryFixture();
      if (projected)
        for (const turn of turns)
          Object.assign(turn, {
            agentListening: projectFeatureSearchHistory(turn.agentListening!),
          });
      verifyFeatureSearch(input, "final");
    },
  );
  it.each([
    "missing",
    "session",
    "pass",
    "fingerprint",
    "false-ready",
    "changed-source",
    "conversation",
    "restart",
  ] as const)("rejects invalid reused pitch availability (%s)", (mode) => {
    const { input, turns, pitch } = priorPitchInventoryFixture();
    const page = result(turns[0]!, "list-features").inventory as ReturnType<
      typeof projectListeningFeatureInventory
    >;
    const reference = page.features.find(
      (feature) => feature.id === pitch.record.id,
    )!;
    if (mode === "missing") page.features.pop();
    if (mode === "session")
      page.provenance[reference.provenance]!.sessionId = "foreign";
    if (mode === "pass") page.sources[reference.source]!.passId = "foreign";
    if (mode === "fingerprint")
      page.provenance[reference.provenance]!.sourceFingerprint = "c".repeat(64);
    if (mode === "false-ready")
      page.metadata[reference.metadata]!.status = "ready";
    if (mode === "changed-source")
      Object.assign(turns[1]!.featureSources![0]!, {
        contentSha256: "c".repeat(64),
      });
    if (mode === "conversation")
      Object.assign(turns[0]!, { conversationId: "foreign" });
    if (mode === "restart")
      Object.assign(turns[1]!.agentListening!, { afterOwnedRestart: true });
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it.each([false, true])(
    "verifies restored acquisition with a fresh report page and independent complete source evidence (changed=%s)",
    (changed) => {
      const { input, turns } = priorFullFixture();
      const restored = turns[2]!;
      const skipped = new Set(
        restored
          .agentListening!.records.filter(
            (record) =>
              record.kind === "tool_call" &&
              record.arguments.action === "report" &&
              Number(record.arguments.offset) > 0,
          )
          .map((record) => ("toolCallId" in record ? record.toolCallId : "")),
      );
      Object.assign(restored.agentListening!, {
        records: restored.agentListening!.records.filter(
          (record) =>
            !("toolCallId" in record && skipped.has(record.toolCallId)),
        ),
      });
      if (changed) {
        Object.assign(restored, {
          featureSources: structuredClone(restored.featureSources),
        });
        Object.assign(
          restored.featureSources![0]!.analyzers!.pitch.frames.at(-1)!
            .channels[0],
          {
            state: "accepted-estimate",
            hz: 123,
            confidence: 0.99,
          },
        );
      }
      const verify = () => verifyFeatureSearch(input, "final");
      if (changed) expect(verify).toThrow();
      else expect(verify).not.toThrow();
    },
  );
  it.each([false, true])(
    "reuses all five first-source reads only before restart (projected=%s)",
    (projected) => {
      const { input, turns } = priorFullFixture();
      if (projected)
        for (const turn of turns)
          Object.assign(turn, {
            agentListening: projectFeatureSearchHistory(turn.agentListening!),
          });
      expect(() =>
        verifyFeatureSearch(
          { ...input, turns: turns.slice(0, 2), turn: turns[1]! },
          "second",
        ),
      ).not.toThrow();
      expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
    },
  );
  it.each(firstFeatureIds)(
    "rejects an absent original typed read (%s)",
    (id) => {
      const { input, turns } = priorFullFixture();
      omitTool(turns[0]!, "get-feature", id);
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it.each(firstFeatureIds)(
    "requires the new capture's genuine same-turn read (%s)",
    (id) => {
      const { input, turns } = priorFullFixture();
      omitTool(turns[1]!, "get-feature", id.replace("feature-1", "feature-2"));
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it.each([
    "appSessionId",
    "agentId",
    "conversationId",
    "source",
    "attribution",
    "restart",
    "comparison",
    "search",
  ] as const)("rejects broken pre-restart reuse (%s)", (mode) => {
    const { input, turns } = priorFullFixture();
    if (["appSessionId", "agentId", "conversationId"].includes(mode))
      Object.assign(turns[0]!, { [mode]: "foreign" });
    if (mode === "source")
      Object.assign(turns[1]!.featureSources![0]!, {
        contentSha256: "c".repeat(64),
      });
    if (mode === "attribution")
      turns[0]!.agentListening!.records[0]!.appSessionId = "foreign";
    if (mode === "restart")
      Object.assign(turns[1]!.agentListening!, { afterOwnedRestart: true });
    if (mode === "comparison") omitTool(turns[1]!, "compare-features");
    if (mode === "search") omitTool(turns[1]!, "search-features");
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it.each(["identity", "metadata", "values", "support"] as const)(
    "rejects changed immutable analyzer rereads (%s)",
    (mode) => {
      const { input, turns } = fixture(true, false, 32);
      const reread = analyzerResult(turns[1]!, "flatness-summary/v1");
      // The fixture shares source views; make this a distinct second-turn read.
      const changed = structuredClone(reread);
      Object.assign(reread, changed);
      if (mode === "identity") {
        const previousId = reread.feature.record.id;
        reread.feature.record.id = "different-feature";
        for (const record of turns[1]!.agentListening!.records)
          if (
            record.kind === "tool_call" &&
            record.arguments.featureId === previousId
          )
            record.arguments.featureId = "different-feature";
      }
      if (mode === "metadata")
        Object.assign(reread.feature.record.feature, {
          supportPolicy: "changed",
        });
      if (mode === "values") reread.page.values[0]! += 1e-12;
      if (mode === "support")
        Object.assign(reread.page, { supportIntervals: [[1, 90000]] });
      expect(() =>
        verifyFeatureSearch(
          { ...input, turns: turns.slice(0, 2), turn: turns[1]! },
          "second",
        ),
      ).toThrow();
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it.each(
    firstFeatureIds.flatMap((id) => [id, id.replace("feature-1", "feature-2")]),
  )("requires a fresh post-restart typed read (%s)", (id) => {
    const { input, turns } = priorFullFixture();
    omitTool(turns[2]!, "get-feature", id);
    expect(() => verifyFeatureSearch(input, "restored")).toThrow();
  });
  it("binds restored first-source identities even when turn two reused their reads", () => {
    const { input, turns } = priorFullFixture();
    const read = analyzerResult(turns[2]!, "flatness-summary/v1");
    const previousId = read.feature.record.id;
    read.feature.record.id = "different-restored-feature";
    for (const record of turns[2]!.agentListening!.records)
      if (
        record.kind === "tool_call" &&
        record.arguments.featureId === previousId
      )
        record.arguments.featureId = "different-restored-feature";
    expect(() => verifyFeatureSearch(input, "restored")).toThrow();
  });
  it("still requires fresh post-restart source reads", () => {
    const { input, turns } = priorFullFixture();
    omitTool(turns[2]!, "report");
    expect(() => verifyFeatureSearch(input, "restored")).toThrow(
      "stored measurements",
    );
  });
});
const transportReadSuffix = `\n\nTool "ableton_transport" succeeded. Additional guidance from postToolUse hooks:\n${VERIFIED_TOOL_RESULT_GUIDANCE}\n${TRANSPORT_SOURCE_FLAG_GUIDANCE}`;

function addTransportRead(
  turn: TurnEvidence,
  framing: "object" | "json" | "hook",
) {
  const records = turn.agentListening!.records;
  const originalCall = records.find((record) => record.kind === "tool_call")!;
  const originalResult = records.find(
    (record) => record.kind === "tool_result",
  )!;
  const call = {
    ...structuredClone(originalCall),
    id: `${originalCall.id}-transport`,
    toolCallId: "transport-read",
    correlationId: "transport-read",
    toolName: "ableton_transport",
    arguments: { action: "get" },
  };
  const payload = {
    action: "get",
    transport: {
      currentSongTime: 0,
      isPlaying: false,
      tempo: 128,
      timeSignature: { numerator: 4, denominator: 4 },
      metronome: false,
      launchQuantization: 0,
      recordQuantization: 0,
      linkEnabled: false,
      backToArrangement: false,
    },
    cuePoints: [],
    totalCuePoints: 0,
    offset: 0,
    limit: 32,
  };
  const response = {
    ...structuredClone(originalResult),
    id: `${originalResult.id}-transport`,
    toolCallId: "transport-read",
    correlationId: "transport-read",
    metadata: { toolName: "ableton_transport" },
    result: {
      result: {
        content:
          framing === "object"
            ? payload
            : JSON.stringify(payload) +
              (framing === "hook" ? transportReadSuffix : ""),
      },
    },
  };
  records.unshift(call, response);
  return { call, response, payload };
}

describe("bounded independent feature search oracle", () => {
  it.each(["object", "json", "hook"] as const)(
    "allows only validated transport inspection (%s) across all phases",
    (framing) => {
      for (const coverage of ["full", "peak-only"] as const) {
        const { input, turns } =
          coverage === "full" ? fixture() : peakFixture();
        for (const turn of turns) addTransportRead(turn, framing);
        expect(() =>
          verifyFeatureSearch(input, "final", coverage),
        ).not.toThrow();
      }
    },
  );
  it.each([
    "seek",
    "stop",
    "reset",
    "extra-argument",
    "wrong-result-action",
    "invalid-state",
    "extra-result-field",
    "changed-suffix",
    "duplicate-suffix",
    "foreign-suffix",
    "foreign-tool",
    "failed",
    "missing-result",
    "foreign-trace",
  ])("rejects unsafe or unverified transport inspection (%s)", (mode) => {
    const { input, turns } = fixture();
    const { call, response, payload } = addTransportRead(turns[0]!, "object");
    if (["seek", "stop", "reset"].includes(mode)) {
      call.arguments.action = mode;
      payload.action = mode;
    }
    if (mode === "extra-argument") Object.assign(call.arguments, { time: 4 });
    if (mode === "wrong-result-action") payload.action = "seek";
    if (mode === "invalid-state") payload.transport.tempo = 0;
    if (mode === "extra-result-field")
      Object.assign(payload, { verified: true });
    if (mode === "changed-suffix")
      response.result.result.content =
        JSON.stringify(payload) + transportReadSuffix + "untrusted";
    if (mode === "duplicate-suffix")
      response.result.result.content =
        JSON.stringify(payload) + transportReadSuffix + transportReadSuffix;
    if (mode === "foreign-suffix")
      response.result.result.content =
        JSON.stringify(payload) +
        transportReadSuffix.replace("ableton_transport", "ableton_context");
    if (mode === "foreign-tool") {
      call.toolName = "ableton_devices";
      response.metadata.toolName = "ableton_devices";
    }
    if (mode === "failed") response.outcome = "failure";
    if (mode === "missing-result")
      turns[0]!.agentListening!.records.splice(1, 1);
    if (mode === "foreign-trace") response.traceId = "foreign";
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it("fits all three strict turns with four-page reports, complete catalog and both sources' feature reads in the existing receipt budget", () => {
    const { input, turns } = fixture(true, false, 32);
    const inventory = result(turns[1]!, "list-features");
    const templates = [
      result(turns[0]!, "get-feature").feature,
      (
        result(turns[1]!, "search-features").matches as { feature: unknown }[]
      )[0]!.feature,
    ] as { record: { id: string; feature: object } }[];
    const fullInventory: unknown[] = templates.flatMap((template) =>
      LISTENING_FEATURE_DEFINITIONS.map((definition) => ({
        ...template,
        record: {
          ...template.record,
          id: `${template.record.id}-${definition.type.replace("/", "-")}`,
          feature: canonicalMetadata(definition.type),
        },
      })),
    );
    // Keep the exact peak inventory entry consumed by the frozen oracle.
    fullInventory.push(templates[1]!);
    inventory.inventory = projectListeningFeatureInventory(
      contextFeatureViewSchema.array().parse(fullInventory),
    );
    const decorate = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (item.record && item.source) {
        Object.assign(item.record, {
          freshness: {
            status: "unknown",
            reason: "Historical capture evidence; ".repeat(5),
          },
        });
        Object.assign(item.source, {
          freshness: "unknown",
          summary: "Human-readable feature presentation. ".repeat(12),
        });
      }
      if (item.action === "report" && item.entry)
        Object.assign(item.entry, {
          summary: "Human-readable capture presentation. ".repeat(12),
        });
      for (const child of Object.values(item)) decorate(child);
    };
    for (const turn of turns) decorate(turn.agentListening);
    const raw = structuredClone(turns);
    const reports = (turn: TurnEvidence) =>
      turn.agentListening!.records.filter(
        (record) =>
          record.kind === "tool_call" && record.arguments.action === "report",
      );
    expect(reports(turns[0]!)).toHaveLength(4);
    expect(reports(turns[1]!)).toHaveLength(4);
    expect(reports(turns[2]!)).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(turns))).toBeGreaterThan(524_288);
    for (const turn of turns)
      Object.assign(turn, {
        agentListening: projectFeatureSearchHistory(turn.agentListening!),
      });
    expect(Buffer.byteLength(JSON.stringify(turns))).toBeLessThanOrEqual(
      524_288,
    );
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
    expect(turns.map((turn) => turn.agentListening!.records.length)).toEqual(
      raw.map((turn) => turn.agentListening!.records.length),
    );
    for (const [index, turn] of turns.entries()) {
      expect(JSON.stringify(turn.agentListening)).not.toContain(
        "Human-readable",
      );
      expect(
        turn.agentListening!.records.filter(
          (record) => record.kind !== "tool_result",
        ),
      ).toEqual(
        raw[index]!.agentListening!.records.filter(
          (record) => record.kind !== "tool_result",
        ),
      );
      expect(
        projectFeatureSearchHistory({
          ...raw[index]!.agentListening!,
          afterOwnedRestart: true,
        }),
      ).toEqual({ ...turn.agentListening, afterOwnedRestart: true });
    }
  });
  it.each([
    "overflow",
    "duplicate",
    "foreign",
    "malformed-report",
    "truncated",
  ] as const)(
    "rejects unsafe History before report projection (%s)",
    (mode) => {
      const { turns } = fixture(true, false, 32);
      const history = turns[0]!.agentListening!;
      if (mode === "overflow")
        Object.assign(history, {
          records: Array.from({ length: 257 }, () => history.records[0]!),
        });
      if (mode === "duplicate")
        Object.assign(history, {
          records: [...history.records, history.records[0]!],
        });
      if (mode === "foreign") history.records[0]!.appSessionId = "foreign";
      if (mode === "malformed-report")
        (
          result(turns[0]!, "report").report as { sampleRate: number }
        ).sampleRate = 0;
      if (mode === "truncated")
        history.records.find(
          (record) => record.kind === "tool_call",
        )!.metadata.note = "[truncated]";
      expect(() => projectFeatureSearchHistory(history)).toThrow();
    },
  );
  it.each([
    "nonterminal",
    "frame",
    "duplicate-frame",
    "missing-frame",
    "profile",
    "missing-read",
    "missing-feature-read",
  ] as const)(
    "preserves strict report/feature guards after projection (%s)",
    (mode) => {
      const { input, turns } = fixture(true, false, 32);
      for (const turn of turns)
        Object.assign(turn, {
          agentListening: projectFeatureSearchHistory(turn.agentListening!),
        });
      const first = turns[0]!;
      const report = result(first, "report").featureReport as {
        analyzers: {
          pitch: {
            profileSha256: string;
            frames: { index: number; sha256: string }[];
          };
        };
      };
      if (mode === "nonterminal")
        first.agentListening!.records.find(
          (record) => record.kind === "turn",
        )!.status = "failed";
      if (mode === "frame")
        report.analyzers.pitch.frames[0]!.sha256 = "a".repeat(64);
      if (mode === "duplicate-frame")
        report.analyzers.pitch.frames.push(report.analyzers.pitch.frames[0]!);
      if (mode === "profile")
        report.analyzers.pitch.profileSha256 = "b".repeat(64);
      if (mode === "missing-frame") report.analyzers.pitch.frames.shift();
      if (mode === "missing-read") omitTool(first, "report");
      if (mode === "missing-feature-read")
        omitTool(turns[1]!, "get-feature", "feature-2-flatness-summary");
      expect(() => verifyFeatureSearch(input, "final")).toThrow();
    },
  );
  it("verifies nonzero measured Euclidean distance and original IDs after one owned restart", () => {
    const { input, turns } = fixture();
    expect(() =>
      verifyFeatureSearch(
        { ...input, turns: turns.slice(0, 1), turn: turns[0]! },
        "first",
      ),
    ).not.toThrow();
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
  });
  it("accepts paginated analyzer reports and low-confidence kick pitch without claiming accuracy", () => {
    const { input } = fixture(true);
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
    expect(
      input.turns[0]!.featureSources![0]!.analyzers!.pitch.frames.every(
        (frame) =>
          frame.channels.every((channel) => channel.state === "low-confidence"),
      ),
    ).toBe(true);
  });
  it("preserves honestly unavailable confidence instead of inventing a score from acquired silence", () => {
    const { input } = fixture(false, true);
    expect(() => verifyFeatureSearch(input, "final")).not.toThrow();
  });
  it("rejects omitted analyzer report continuation", () => {
    const { input, turns } = fixture(true);
    const call = turns[1]!.agentListening!.records.find(
      (record) =>
        record.kind === "tool_call" &&
        record.arguments.action === "report" &&
        record.arguments.offset === 15,
    )!;
    if (call.kind !== "tool_call")
      throw new Error("Missing synthetic final report page");
    Object.assign(turns[1]!.agentListening!, {
      records: turns[1]!.agentListening!.records.filter(
        (record) =>
          !("toolCallId" in record) || record.toolCallId !== call.toolCallId,
      ),
    });
    expect(() => verifyFeatureSearch(input, "final")).toThrow(
      "all analyzer report pages",
    );
  });
  it.each([
    [
      "missing authoritative analyzer",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!.featureSources![0]!, {
          analyzers: {
            spectralShape:
              turns[0]!.featureSources![0]!.analyzers!.spectralShape,
          },
        });
      },
    ],
    [
      "diagnostic promotion",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, {
          pitch: { latestHz: 440, latestConfidence: 0.99 },
        });
      },
    ],
    [
      "failed analyzer acquisition",
      (turns: TurnEvidence[]) => {
        const pitch = turns[0]!.featureSources![0]!.analyzers!.pitch;
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, {
          pitch: {
            ...pitch,
            status: "failed",
            frames: [],
            gaps: pitch.frames.map((frame) => ({
              firstIndex: frame.index,
              count: 1,
              support: frame.support,
              reason: "dependency-unavailable",
            })),
          },
        });
      },
    ],
    [
      "false accepted pitch validity",
      (turns: TurnEvidence[]) => {
        const pitch = structuredClone(
          turns[0]!.featureSources![0]!.analyzers!.pitch,
        );
        Object.assign(pitch.frames[0]!.channels[0], {
          state: "accepted-estimate",
        });
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, { pitch });
      },
    ],
    [
      "false shape validity",
      (turns: TurnEvidence[]) => {
        const spectralShape = structuredClone(
          turns[0]!.featureSources![0]!.analyzers!.spectralShape,
        );
        Object.assign(spectralShape.frames[0]!.channels[0], {
          state: "silence",
        });
        Object.assign(turns[0]!.featureSources![0]!.analyzers!, {
          spectralShape,
        });
      },
    ],
    [
      "missing captured family",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!.captures[0]!, {
          metricFamilies: [
            "level",
            "spectral-centroid",
            "attacks",
            "mel-bands",
          ],
        });
      },
    ],
    [
      "incomplete fifteen-definition catalog",
      (turns: TurnEvidence[]) => {
        const catalog = result(turns[1]!, "feature-definitions");
        catalog.definitions = (
          catalog.definitions as { type: string }[]
        ).filter((definition) => definition.type !== "spread-summary/v1");
      },
    ],
    [
      "false ready pitch grid on low-confidence source",
      (turns: TurnEvidence[]) => {
        for (const record of turns[1]!.agentListening!.records) {
          if (record.kind !== "tool_result") continue;
          const data = (
            record.result?.result as {
              content?: {
                action: string;
                inventory?: ReturnType<typeof projectListeningFeatureInventory>;
              };
            }
          )?.content;
          if (data?.action === "list-features")
            for (const feature of data.inventory!.metadata)
              if (feature.type === "pitch-grid/v1") feature.status = "ready";
        }
      },
    ],
    [
      "missing confidence feature",
      (turns: TurnEvidence[]) => {
        analyzerResult(
          turns[1]!,
          "pitch-confidence-summary/v1",
        ).feature.record.feature.type = "level-grid/v1";
      },
    ],
    [
      "failed shape feature",
      (turns: TurnEvidence[]) => {
        analyzerResult(
          turns[1]!,
          "flatness-summary/v1",
        ).feature.record.feature.status = "unavailable";
      },
    ],
    [
      "false confidence arithmetic",
      (turns: TurnEvidence[]) => {
        analyzerResult(turns[1]!, "pitch-confidence-summary/v1").page.values = [
          1, 1,
        ];
      },
    ],
    [
      "false shape channel validity",
      (turns: TurnEvidence[]) => {
        analyzerResult(
          turns[1]!,
          "spread-summary/v1",
        ).feature.record.feature.channelReasons[0] = "invalid-output";
      },
    ],
    [
      "changed analyzer ID after restart",
      (turns: TurnEvidence[]) => {
        analyzerResult(turns[2]!, "rolloff-summary/v1").feature.record.id =
          "replacement-feature";
      },
    ],
    [
      "changed analyzer evidence after restart",
      (turns: TurnEvidence[]) => {
        const sources = structuredClone(turns[2]!.featureSources!);
        Object.assign(
          sources[0]!.analyzers!.spectralShape.frames[0]!.channels[0],
          { flatnessDb: -25 },
        );
        Object.assign(turns[2]!, { featureSources: sources });
      },
    ],
    [
      "bad measured peak page",
      (turns: TurnEvidence[]) => {
        (result(turns[1]!, "get-feature").page as { values: number[] }).values =
          [9, 9];
      },
    ],
    [
      "unavailable peak",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "get-feature").feature as {
            record: { feature: { status: string } };
          }
        ).record.feature.status = "unavailable";
      },
    ],
    [
      "changed restored feature ID",
      (turns: TurnEvidence[]) => {
        (
          result(turns[2]!, "get-feature").feature as { record: { id: string } }
        ).record.id = "new-feature";
      },
    ],
    [
      "foreign additional search feature",
      (turns: TurnEvidence[]) => {
        const search = result(turns[1]!, "search-features") as {
          matches: {
            feature: { record: { id: string; sessionId: string } };
            distance: number;
          }[];
        };
        const foreign = structuredClone(search.matches[0]!);
        foreign.feature.record.id = "foreign-feature";
        foreign.feature.record.sessionId = "foreign-session";
        search.matches.push(foreign);
      },
    ],
    [
      "missing feature catalog",
      (turns: TurnEvidence[]) => {
        result(turns[1]!, "feature-definitions").definitions = [];
      },
    ],
    [
      "cancelled turn",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[1]!, { status: "cancelled" });
      },
    ],
    [
      "missing native ownership",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[0]!, {
          captures: turns[0]!.captures.map((capture) => {
            const copy = { ...capture };
            delete copy.native;
            return copy;
          }),
        });
      },
    ],
    [
      "failed capture cleanup",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[1]!, {
          captures: turns[1]!.captures.map((capture) => ({
            ...capture,
            cleanupComplete: false,
          })),
        });
      },
    ],
    [
      "missing result",
      (turns: TurnEvidence[]) => {
        turns[1]!.agentListening!.records.pop();
      },
    ],
    [
      "foreign history",
      (turns: TurnEvidence[]) => {
        turns[1]!.agentListening!.records[0]!.appSessionId = "foreign";
      },
    ],
    [
      "failed tool",
      (turns: TurnEvidence[]) => {
        const r = turns[1]!.agentListening!.records.find(
          (r) => r.kind === "tool_result",
        )!;
        if (r.kind === "tool_result") r.outcome = "failure";
      },
    ],
    [
      "bad comparison",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "compare-features").comparisons as {
            result: { distance: number };
          }[]
        )[0]!.result.distance = 100;
      },
    ],
    [
      "obsolete derivation definition set",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "derive-features").derivations as {
            definitionSet: string;
          }[]
        )[0]!.definitionSet = "stored-listening/v1";
      },
    ],
    [
      "unbounded derivation feature count",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "derive-features").derivations as {
            featureCount: number;
          }[]
        )[0]!.featureCount = 7681;
      },
    ],
    [
      "wrong comparison distance units",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "compare-features").comparisons as {
            result: { units: string };
          }[]
        )[0]!.result.units = "cents";
      },
    ],
    [
      "wrong search distance units",
      (turns: TurnEvidence[]) => {
        result(turns[1]!, "search-features").distanceUnits = "cents";
      },
    ],
    [
      "bad search arithmetic",
      (turns: TurnEvidence[]) => {
        (
          result(turns[1]!, "search-features").matches as { distance: number }[]
        )[0]!.distance = 100;
      },
    ],
    [
      "self match",
      (turns: TurnEvidence[]) => {
        const data = result(turns[1]!, "search-features");
        (data.matches as { feature: unknown }[])[0]!.feature = data.query;
      },
    ],
    [
      "omitted exclusion",
      (turns: TurnEvidence[]) => {
        const call = turns[1]!.agentListening!.records.find(
          (r) =>
            r.kind === "tool_call" && r.arguments.action === "search-features",
        )!;
        if (call.kind === "tool_call") call.arguments.excludeContextIds = [];
      },
    ],
    [
      "extra capture",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[2]!, { captures: turns[0]!.captures });
      },
    ],
    [
      "reset tool",
      (turns: TurnEvidence[]) => {
        const call = turns[1]!.agentListening!.records[0]!;
        if (call.kind === "tool_call") call.toolName = "ableton_transport";
      },
    ],
    [
      "changed source",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[2]!, {
          featureSources: turns[2]!.featureSources!.map((source) => ({
            ...source,
            contentSha256: "c".repeat(64),
          })),
        });
      },
    ],
    [
      "missing restart",
      (turns: TurnEvidence[]) => {
        Object.assign(turns[2]!, {
          agentListening: {
            ...turns[2]!.agentListening!,
            afterOwnedRestart: false,
          },
        });
      },
    ],
  ] as const)("fails closed for %s", (_name, mutate) => {
    const { input, turns } = fixture();
    mutate(turns);
    expect(() => verifyFeatureSearch(input, "final")).toThrow();
  });
  it("requires the exact declared stop and restart receipts", () => {
    const { input } = fixture();
    expect(() =>
      verifyFeatureSearch(
        { ...input, evidence: { ...input.evidence!, setupActions: [] } },
        "final",
      ),
    ).toThrow("stop/restart");
  });
});
