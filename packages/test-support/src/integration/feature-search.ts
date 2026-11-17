import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  TRANSPORT_SOURCE_FLAG_GUIDANCE,
  VERIFIED_TOOL_RESULT_GUIDANCE,
} from "@ableton-agent/application";
import {
  metricAudioObservationSchema,
  metricRecordStreamContextReferenceSchema,
  projectMetricFeatureSource,
  metricRecordStreamExpectedCoverage,
  metricListeningReportSchema,
  contextSegmentSchema,
  listeningFeatureDefinitionSchema,
  listeningFeatureComparisonSchema,
  listeningFeatureSchema,
  listeningFeatureGridSchema,
  LISTENING_FEATURE_DEFINITIONS,
  MAX_CONTEXT_FEATURES_PER_DERIVATION,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  transportInspectParamsSchema,
  transportOperationResultSchema,
  inspectArrangementParamsSchema,
  inspectArrangementResultSchema,
  sessionSnapshotSchema,
  type PitchTimeline,
  type SpectralShapeTimeline,
  type MetricListeningReport,
  type MetricRecordChunk,
} from "@ableton-agent/protocol";
import {
  sessionInspectParamsSchema,
  contextOperationResultSchema,
  expandListeningFeatureInventory,
  metricStreamOverviewSchema,
  metricStreamRecordPageSchema,
  analysisOperationParamsSchema,
  analysisOperationResultSchema,
  analysisPageSchema,
  captureAnalysisTargetSchema,
  type AnalysisPage,
  type AnalysisTimelineItem,
  type AnalysisOperationResult,
} from "@ableton-agent/tools";
import type {
  AssertionInput,
  TurnEvidence,
  SourceIdentity,
} from "./contracts.js";
import {
  validateAgentListeningEvidence,
  type AgentListeningEvidence,
} from "./agent-listening-result.js";
import { expandArrangementDescriptor } from "./arrangement-stream.js";

export function projectFeatureSearchHistory(
  history: AgentListeningEvidence,
): AgentListeningEvidence {
  validateAgentListeningEvidence(history);
  const projected = {
    ...history,
    records: history.records.map((record) => {
      if (
        record.kind !== "tool_result" ||
        record.outcome !== "success" ||
        record.metadata.toolName !== "ableton_context"
      )
        return record;
      const envelope = object(record.result?.result);
      const data = object(
        typeof envelope.content === "string"
          ? JSON.parse(envelope.content)
          : envelope.content,
      );
      let content: Record<string, unknown>;
      if (data.action === "report") {
        const { report, ...rest } = data;
        const entry = { ...object(data.entry) };
        delete entry.summary;
        content = {
          ...rest,
          entry,
          featureReport: projectFeatureReport(
            metricListeningReportSchema.parse(report),
          ),
        };
      } else if (data.action === "get-feature") {
        content = { ...data, feature: immutableFeature(data.feature) };
      } else if (data.action === "list-features") {
        return record;
      } else if (data.action === "search-features") {
        content = {
          ...data,
          query: immutableFeature(data.query),
          matches: array(data.matches).map((value) => {
            const match = object(value);
            return { ...match, feature: immutableFeature(match.feature) };
          }),
        };
      } else return record;
      return {
        ...record,
        result: {
          ...record.result,
          result: {
            ...envelope,
            content,
          },
        },
      };
    }),
  };
  validateAgentListeningEvidence(projected);
  return projected;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
interface ReportAnalyzerProof {
  profileSha256: string;
  expectedRecords: number;
  retainedRecords: number;
  missingRecords: number;
  trailingSupport: { startSample: number; endSample: number } | null;
  frames: { index: number; sha256: string }[];
}
function projectFeatureReport(report: MetricListeningReport) {
  const analyzers: Partial<
    Record<"pitch" | "spectral-shape", ReportAnalyzerProof>
  > = {};
  for (const family of ["pitch", "spectral-shape"] as const) {
    const metadata = report.metricMetadata[family];
    if (!metadata) continue;
    const frames = new Map<number, string>();
    for (const row of report.rows)
      for (const frame of row[family]?.frames ?? []) {
        const sha256 = fingerprint(frame);
        check(
          !frames.has(frame.index) || frames.get(frame.index) === sha256,
          "conflicting report frame",
        );
        frames.set(frame.index, sha256);
      }
    analyzers[family] = {
      profileSha256: fingerprint(metadata.profile),
      expectedRecords: metadata.expectedRecords,
      retainedRecords: metadata.retainedRecords,
      missingRecords: metadata.missingRecords,
      trailingSupport: metadata.trailingSupport,
      frames: [...frames].map(([index, sha256]) => ({ index, sha256 })),
    };
  }
  return {
    schema: "acceptance-feature-report/v1" as const,
    reportSha256: fingerprint(report),
    source: report.source,
    sourceCoverage: report.sourceCoverage,
    sampleRate: report.sampleRate,
    metricStatus: report.metricStatus,
    offset: report.offset,
    nextOffset: report.nextOffset,
    totalRows: report.totalRows,
    rowCount: report.rows.length,
    analyzers,
  };
}
function readFeatureReport(
  value: unknown,
): ReturnType<typeof projectFeatureReport> {
  const report = object(value);
  check(
    report.schema === "acceptance-feature-report/v1",
    "unknown report projection",
  );
  check(
    typeof report.reportSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(report.reportSha256),
    "invalid report fingerprint",
  );
  metricAudioObservationSchema.shape.source.parse(report.source);
  const support = object(report.sourceCoverage);
  check(
    [support.startSample, support.endSample].every(
      (v) => Number.isSafeInteger(v) && Number(v) >= 0,
    ) &&
      Number(support.endSample) > Number(support.startSample) &&
      [44100, 48000].includes(Number(report.sampleRate)),
    "invalid report source support",
  );
  check(
    [report.offset, report.totalRows, report.rowCount].every(
      (v) => Number.isSafeInteger(v) && Number(v) >= 0,
    ) &&
      Number(report.totalRows) <= 2000 &&
      Number(report.rowCount) <= 32 &&
      Number(report.offset) + Number(report.rowCount) <=
        Number(report.totalRows) &&
      (report.nextOffset === null
        ? Number(report.offset) + Number(report.rowCount) ===
          Number(report.totalRows)
        : report.nextOffset ===
            Number(report.offset) + Number(report.rowCount) &&
          Number(report.nextOffset) > Number(report.offset)),
    "invalid report pagination",
  );
  object(report.metricStatus);
  for (const metadata of Object.values(object(report.analyzers))) {
    const proof = object(metadata);
    check(
      typeof proof.profileSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(proof.profileSha256),
      "invalid report profile fingerprint",
    );
    const frames = array(proof.frames).map(object);
    check(
      frames.length <= 64 &&
        new Set(frames.map((frame) => frame.index)).size === frames.length &&
        frames.every(
          (frame) =>
            Number.isSafeInteger(frame.index) &&
            Number(frame.index) >= 0 &&
            Number(frame.index) < 64 &&
            typeof frame.sha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(frame.sha256),
        ),
      "invalid or duplicate report frame proof",
    );
  }
  return report as ReturnType<typeof projectFeatureReport>;
}

export interface FeatureSourceEvidence {
  readonly contextId: string;
  readonly passId: string;
  readonly contentSha256: string;
  readonly afterOwnedRestart: boolean;
  readonly sampleRate: number;
  readonly stream?: {
    readonly descriptorDigest: string;
    readonly sourceFingerprint: string;
  };
  readonly analyzers?: {
    readonly pitch: PitchTimeline;
    readonly spectralShape: SpectralShapeTimeline;
  };
  readonly records: readonly {
    readonly startSample: number;
    readonly endSample: number;
    readonly peak: readonly [number, number];
  }[];
}
export type FeatureSearchCoverage = "full" | "peak-only";
const metricFamilies = [
  "level",
  "spectral-centroid",
  "attacks",
  "mel-bands",
  "pitch",
  "spectral-shape",
] as const;
function check(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Feature search evidence: ${detail}`);
}
function object(value: unknown): Record<string, unknown> {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "missing object",
  );
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  check(Array.isArray(value), "missing array");
  return value;
}
export function projectFeatureSource(
  contextId: string,
  raw: unknown,
  afterOwnedRestart: boolean,
  coverage: FeatureSearchCoverage = "full",
  stream?: {
    readonly chunks: readonly MetricRecordChunk[];
    readonly contentSha256: string;
    readonly sourceFingerprint: string;
  },
): FeatureSourceEvidence {
  check(
    coverage === "full" || coverage === "peak-only",
    "invalid feature coverage",
  );
  const reference = metricRecordStreamContextReferenceSchema.safeParse(raw);
  const observation = reference.success
    ? (() => {
        check(stream, "missing original stream records");
        const descriptor = expandArrangementDescriptor(
          reference.data.descriptor,
        );
        check(
          (coverage === "peak-only"
            ? (["level"] as const)
            : metricFamilies
          ).every(
            (metric) =>
              descriptor.requestedMetrics.includes(metric) &&
              descriptor.algorithms.some(
                (algorithm) =>
                  algorithm.metric === metric &&
                  algorithm.availability === "available",
              ),
          ),
          "missing or incomplete authoritative metric family",
        );
        const projected = projectMetricFeatureSource(
          reference.data,
          stream.chunks,
        );
        const timeline = (metric: "pitch" | "spectral-shape") => ({
          schema:
            metric === "pitch"
              ? "pitch-timeline/v1"
              : "spectral-shape-timeline/v1",
          ...projected.metrics[metric],
          ...metricRecordStreamExpectedCoverage(descriptor, metric),
          status: "complete",
          gaps: [],
        });
        return {
          ...projected,
          ownership: descriptor.ownership,
          metrics: {
            ...projected.metrics,
            pitch:
              coverage === "full"
                ? pitchTimelineSchema.parse(timeline("pitch"))
                : undefined,
            "spectral-shape":
              coverage === "full"
                ? spectralShapeTimelineSchema.parse(timeline("spectral-shape"))
                : undefined,
          },
        };
      })()
    : metricAudioObservationSchema.parse(raw);
  check(observation.source.view === "session", "not a Session source");
  check(
    (coverage === "peak-only" ? (["level"] as const) : metricFamilies).every(
      (family) =>
        observation.requestedMetrics.includes(family) &&
        (reference.success
          ? reference.data.descriptor.algorithms.some(
              (algorithm) =>
                algorithm.metric === family &&
                algorithm.availability === "available",
            )
          : (() => {
              const timeline = observation.metrics[family];
              return (
                timeline !== undefined &&
                "status" in timeline &&
                timeline.status === "complete"
              );
            })()),
    ),
    "missing or incomplete authoritative metric family",
  );
  const value = {
    contextId,
    passId: observation.ownership.passId,
    contentSha256: reference.success
      ? stream!.contentSha256
      : createHash("sha256").update(JSON.stringify(observation)).digest("hex"),
    afterOwnedRestart,
    sampleRate: observation.geometry.sampleRate,
    ...(reference.success
      ? {
          stream: {
            descriptorDigest: reference.data.descriptorDigest,
            sourceFingerprint: stream!.sourceFingerprint,
          },
        }
      : {}),
    ...(coverage === "full"
      ? {
          analyzers: {
            pitch: pitchTimelineSchema.parse(observation.metrics.pitch),
            spectralShape: spectralShapeTimelineSchema.parse(
              observation.metrics["spectral-shape"],
            ),
          },
        }
      : {}),
    records: observation.metrics.level.records.map(({ support, peak }) => ({
      ...support,
      peak,
    })),
  };
  validateFeatureSources([value], coverage);
  return value;
}
export function validateFeatureSources(
  value: unknown,
  coverage: FeatureSearchCoverage = "full",
): asserts value is FeatureSourceEvidence[] {
  const sources = array(value);
  check(sources.length <= 2, "more than two source observations");
  const ids = new Set<unknown>();
  for (const raw of sources) {
    const source = object(raw);
    check(
      Object.keys(source).every((key) =>
        [
          "contextId",
          "passId",
          "contentSha256",
          "afterOwnedRestart",
          "sampleRate",
          "records",
          "analyzers",
          "stream",
        ].includes(key),
      ),
      "unknown source field",
    );
    for (const key of ["contextId", "passId"])
      check(
        typeof source[key] === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(source[key]),
        "invalid source identity",
      );
    check(!ids.has(source.contextId), "duplicate source");
    ids.add(source.contextId);
    if (source.stream !== undefined) {
      const stream = object(source.stream);
      check(
        Object.keys(stream).sort().join() ===
          "descriptorDigest,sourceFingerprint" &&
          typeof stream.descriptorDigest === "string" &&
          /^[a-f0-9]{64}$/u.test(stream.descriptorDigest) &&
          typeof stream.sourceFingerprint === "string" &&
          /^[a-f0-9]{64}$/u.test(stream.sourceFingerprint),
        "invalid stream source provenance",
      );
    }
    check(
      typeof source.contentSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(source.contentSha256),
      "invalid observation hash",
    );
    check(
      typeof source.afterOwnedRestart === "boolean" &&
        [44100, 48000].includes(Number(source.sampleRate)),
      "invalid source provenance",
    );
    const records = array(source.records);
    check(
      records.length > 0 && records.length <= 128,
      "unbounded level records",
    );
    let previous = -1;
    for (const rawRecord of records) {
      const record = object(rawRecord);
      check(
        Object.keys(record).every((key) =>
          ["startSample", "endSample", "peak"].includes(key),
        ),
        "unknown level field",
      );
      check(
        Number.isSafeInteger(record.startSample) &&
          Number.isSafeInteger(record.endSample) &&
          Number(record.startSample) >= Math.max(0, previous) &&
          Number(record.endSample) > Number(record.startSample),
        "invalid level support",
      );
      previous = Number(record.endSample);
      const peak = array(record.peak);
      check(
        peak.length === 2 &&
          peak.every(
            (number) =>
              typeof number === "number" &&
              Number.isFinite(number) &&
              number >= 0 &&
              number <= 64,
          ),
        "invalid measured peaks",
      );
    }
    if (source.analyzers === undefined) {
      check(
        coverage === "peak-only",
        "missing authoritative analyzer evidence",
      );
      continue;
    }
    const analyzers = object(source.analyzers);
    check(Object.keys(analyzers).length === 2, "unknown analyzer field");
    const pitch = pitchTimelineSchema.parse(analyzers.pitch);
    const shape = spectralShapeTimelineSchema.parse(analyzers.spectralShape);
    for (const timeline of [pitch, shape]) {
      check(
        timeline.status === "complete" &&
          timeline.gaps.length === 0 &&
          timeline.sampleRate === source.sampleRate &&
          timeline.frames.length > 0 &&
          timeline.frames.length <= 64 &&
          timeline.sourceSupport.startSample ===
            object(records[0]).startSample &&
          timeline.sourceSupport.endSample === object(records.at(-1)).endSample,
        "failed, foreign or unbounded analyzer acquisition",
      );
    }
    check(
      shape.frames.some((frame) =>
        frame.channels.some((channel) => channel.state === "valid"),
      ),
      "shape acquisition has no usable validity",
    );
  }
}
export function readFeatureToolPairs(turn: TurnEvidence, storageShape = false) {
  const history = turn.agentListening;
  validateAgentListeningEvidence(history);
  check(
    history.appSessionId === turn.appSessionId &&
      history.conversationId === turn.conversationId &&
      history.agentId === turn.agentId &&
      history.sdkTurnId === turn.facts.sdkTurnId,
    "foreign tool turn",
  );
  const calls = history.records.filter((record) => record.kind === "tool_call");
  const results = history.records.filter(
    (record) => record.kind === "tool_result",
  );
  const terminals = history.records.filter((record) => record.kind === "turn");
  const messages = history.records
    .filter(
      (record) => record.kind === "message" && record.role === "assistant",
    )
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
  const final = messages.at(-1);
  check(
    terminals.length === 1 &&
      terminals[0]?.status === "completed" &&
      final?.kind === "message" &&
      final.content === turn.assistantText &&
      Date.parse(terminals[0].completedAt ?? "") >=
        Date.parse(final.occurredAt),
    "missing attributable terminal turn",
  );
  check(
    calls.length === results.length &&
      new Set(calls.map((call) => call.toolCallId)).size === calls.length &&
      new Set(results.map((result) => result.toolCallId)).size ===
        results.length,
    "missing or duplicate tool result",
  );
  return calls.map((call) => {
    const result = results.find(
      (result) => result.toolCallId === call.toolCallId,
    );
    check(
      call.status === "completed" &&
        result &&
        result.outcome === "success" &&
        !result.error &&
        result.metadata.toolName === call.toolName &&
        result.durationMs !== undefined &&
        Date.parse(result.occurredAt) >= Date.parse(call.occurredAt) &&
        Date.parse(result.occurredAt) < Date.parse(final.occurredAt),
      "failed or foreign tool result",
    );
    const envelope = object(result.result?.result);
    const transportRead =
      call.toolName === "ableton_transport" && call.arguments.action === "get";
    let content = envelope.content;
    if (transportRead) {
      transportInspectParamsSchema.parse(call.arguments);
      const suffix = `\n\nTool "ableton_transport" succeeded. Additional guidance from postToolUse hooks:\n${VERIFIED_TOOL_RESULT_GUIDANCE}\n${TRANSPORT_SOURCE_FLAG_GUIDANCE}`;
      if (typeof content === "string" && content.endsWith(suffix))
        content = content.slice(0, -suffix.length);
    } else {
      const suffix = `\n\nTool "${call.toolName}" succeeded. Additional guidance from postToolUse hooks:\n${VERIFIED_TOOL_RESULT_GUIDANCE}`;
      if (typeof content === "string" && content.endsWith(suffix))
        content = content.slice(0, -suffix.length);
    }
    let data = object(
      typeof content === "string" ? JSON.parse(content) : content,
    );
    if (
      !storageShape &&
      data.action === "list-features" &&
      data.projection !== "acceptance-storage-inventory/v1"
    ) {
      const page = contextOperationResultSchema.parse(data);
      check(
        page.action === "list-features",
        "invalid feature inventory action",
      );
      data = {
        ...data,
        features: expandListeningFeatureInventory(page.inventory),
      };
    }
    if (transportRead) transportOperationResultSchema.options[0].parse(data);
    const arrangementRead =
      storageShape &&
      call.toolName === "ableton_arrangement" &&
      call.arguments.action === "inspect";
    if (arrangementRead) {
      inspectArrangementParamsSchema.parse(call.arguments);
      inspectArrangementResultSchema.parse(data);
    }
    const sessionRead =
      call.toolName === "ableton_session" &&
      call.arguments.action === "inspect";
    if (sessionRead) {
      sessionInspectParamsSchema.parse(call.arguments);
      sessionSnapshotSchema.parse(data);
    }
    check(
      data.error === undefined &&
        data.resultType !== "failure" &&
        data.isError !== true &&
        (data.action === call.arguments.action ||
          ((arrangementRead || sessionRead) && data.action === undefined)),
      "structured tool failure",
    );
    const action = String(call.arguments.action);
    if (
      call.toolName === "ableton_context" &&
      ["read", "compare", "search"].includes(action)
    ) {
      analysisOperationParamsSchema.parse(call.arguments);
      analysisOperationResultSchema.parse(data);
    }
    check(
      (call.toolName === "ableton_context" &&
        [
          "read",
          "compare",
          "search",
          "feature-definitions",
          "derive-features",
          "list-features",
          "get-feature",
          "compare-features",
          "search-features",
          "get",
          "report",
          "list",
          "stream-overview",
          "stream-records",
          "stream-summary",
        ].includes(action)) ||
        (call.toolName === "ableton_listening" &&
          [
            "play-session-and-listen",
            "inspect-listeners",
            "get-pass",
            "list-passes",
            ...(storageShape ? ["play-arrangement-and-listen"] : []),
          ].includes(action)) ||
        sessionRead ||
        transportRead ||
        arrangementRead,
      "forbidden capture/reset/mutation tool",
    );
    return { call, data, action };
  });
}
export interface CompleteAnalysis {
  detail?: "evidence";
  source: AnalysisPage["source"];
  readTarget: AnalysisPage["readTarget"];
  overview: AnalysisPage["overview"];
  timeline: AnalysisPage["timeline"];
}
export function immutableDeliveredAnalysis(analysis: CompleteAnalysis) {
  const { freshness, ...source } = analysis.source;
  void freshness;
  const timeline = structuredClone(analysis.timeline);
  for (const row of timeline)
    if (row.featureRecord)
      Reflect.deleteProperty(row.featureRecord, "freshness");
  return { ...analysis, source, timeline };
}

/** Collect delivered pages, including listen's first page, without manufacturing tool calls. */
export function readCompleteAnalyses(
  turns: readonly TurnEvidence[],
  storageShape = false,
): CompleteAnalysis[] {
  type Chain = {
    request: Record<string, unknown>;
    analyses: CompleteAnalysis[];
    totals: number[];
  };
  const pending = new Map<string, Chain>();
  const complete: CompleteAnalysis[] = [];
  const accept = (
    pages: AnalysisPage[],
    supplied: Record<string, unknown>,
    cursor: string | undefined,
    nextCursor: string | null,
  ) => {
    const chain = cursor ? pending.get(cursor) : undefined;
    const request: Record<string, unknown> = {
      ...(chain?.request ?? { includeHistorical: false }),
      ...Object.fromEntries(
        Object.entries(supplied).filter(([, value]) => value !== undefined),
      ),
    };
    check(
      !cursor || (chain && isDeepStrictEqual(chain.request, request)),
      "analysis continuation changed its request or skipped a page",
    );
    if (cursor) pending.delete(cursor);
    const target = object(request.target);
    const targets =
      target.kind === "comparison" ? [target.left, target.right] : [target];
    check(pages.length === targets.length, "analysis target count changed");
    const state: Chain = chain ?? {
      request,
      analyses: pages.map((page) => ({
        ...(request.detail === "evidence"
          ? { detail: "evidence" as const }
          : {}),
        source: page.source,
        readTarget: page.readTarget,
        overview: page.overview,
        timeline: [],
      })),
      totals: pages.map((page) => page.detail.totalItems),
    };
    check(
      state.analyses.length === pages.length,
      "analysis page count changed",
    );
    pages.forEach((page, index) => {
      const previous = state.analyses[index]!;
      check(
        isDeepStrictEqual(
          captureAnalysisTargetSchema.parse(targets[index]),
          page.readTarget,
        ) &&
          isDeepStrictEqual(page.source.readTarget, page.readTarget) &&
          page.readTarget.sessionId === turns[0]?.appSessionId &&
          page.status === "ready" &&
          page.reason === null &&
          isDeepStrictEqual(page.source, previous.source) &&
          isDeepStrictEqual(page.overviewExtent, page.readTarget.range),
        "analysis source, ownership, range or status changed",
      );
      check(
        page.detail.offset === previous.timeline.length &&
          page.detail.returnedItems === page.timeline.length &&
          page.detail.totalItems === state.totals[index] &&
          page.detail.offset + page.detail.returnedItems <=
            page.detail.totalItems &&
          page.detail.truncated ===
            page.detail.offset + page.detail.returnedItems <
              page.detail.totalItems &&
          page.detail.nextCursor === nextCursor &&
          (chain
            ? !page.overviewIncluded && page.overview.length === 0
            : page.overviewIncluded),
        "analysis pagination is incomplete or inconsistent",
      );
      previous.timeline.push(...page.timeline);
    });
    if (nextCursor) {
      check(
        !pending.has(nextCursor) &&
          pages.some((page) => page.detail.returnedItems > 0),
        "analysis pagination failed to advance",
      );
      pending.set(nextCursor, state);
    } else {
      check(
        state.analyses.every(
          (analysis, index) => analysis.timeline.length === state.totals[index],
        ),
        "analysis omitted terminal detail",
      );
      complete.push(...state.analyses);
    }
  };
  for (const turn of turns) {
    for (const pair of readFeatureToolPairs(turn, storageShape)) {
      if (
        pair.call.toolName === "ableton_listening" &&
        Array.isArray(pair.data.analyses)
      ) {
        for (const raw of pair.data.analyses) {
          const page = analysisPageSchema.parse(raw);
          accept(
            [page],
            {
              action: "read",
              target: page.readTarget,
              includeHistorical: false,
            },
            undefined,
            page.detail.nextCursor,
          );
        }
      } else if (
        pair.call.toolName === "ableton_context" &&
        pair.action === "read"
      ) {
        const query = analysisOperationParamsSchema.parse(pair.call.arguments);
        const result = analysisOperationResultSchema.parse(pair.data);
        check(
          query.action === "read" && result.action === "read",
          "invalid analysis read",
        );
        if (result.originalMeasurements) continue;
        const { cursor, ...request } = query;
        accept(result.analyses, request, cursor, result.nextCursor);
      }
    }
  }
  check(pending.size === 0, "analysis continuation was not consumed");
  return complete;
}
export function deliveredAnalysisFeatures(analysis: CompleteAnalysis) {
  const grouped = new Map<string, AnalysisTimelineItem[]>();
  for (const row of analysis.timeline) {
    check(
      (row.segment.entryId === undefined ||
        row.segment.entryId === analysis.readTarget.contextId) &&
        (row.segment.sessionId === undefined ||
          row.segment.sessionId === analysis.readTarget.sessionId) &&
        (row.segment.liveSetId === undefined ||
          row.segment.liveSetId === analysis.readTarget.liveSetId) &&
        (row.segment.coordinate === undefined ||
          row.segment.coordinate === analysis.readTarget.coordinate),
      "analysis segment has foreign source ownership",
    );
    check(
      row.segment.startBeat >= analysis.readTarget.range.startBeat &&
        row.segment.endBeat <= analysis.readTarget.range.endBeat &&
        row.startBeat >= row.segment.startBeat &&
        row.endBeat <= row.segment.endBeat &&
        row.startBeat < row.endBeat &&
        row.segment.startSample < row.segment.endSample,
      "analysis row exceeds its pinned segment or capture",
    );
    if (row.kind === "availability")
      check(
        row.startBeat === row.segment.startBeat &&
          row.endBeat === row.segment.endBeat &&
          row.features.length > 0 &&
          row.supportCoordinate === "segment-relative-samples" &&
          row.support === undefined &&
          row.featureRecord === undefined &&
          row.definition === undefined,
        "invalid segment availability marker",
      );
    if (analysis.source.geometry) {
      const start =
        (row.segment.startSample -
          analysis.source.geometry.captureStartSample) /
        row.segment.sampleRate;
      const duration =
        (row.segment.endSample - row.segment.startSample) /
        row.segment.sampleRate;
      const elapsed = (beat: number) =>
        start +
        ((beat - row.segment.startBeat) /
          (row.segment.endBeat - row.segment.startBeat)) *
          duration;
      check(
        Math.abs(row.elapsedStartSeconds - elapsed(row.startBeat)) < 1e-9 &&
          Math.abs(row.elapsedEndSeconds - elapsed(row.endBeat)) < 1e-9,
        "delivered elapsed timing differs from native segment coordinates",
      );
    }
    const key = JSON.stringify([
      row.kind,
      row.segment,
      row.startBeat,
      row.endBeat,
      row.featureType,
      row.supportChannel,
      row.supportOffset,
    ]);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const rows = [...grouped.values()].map((fragments) => {
    const first = fragments[0]!;
    const count = first.fragmentCount ?? 1;
    check(
      fragments.length === count &&
        fragments.every(
          (row, index) =>
            row.fragment === index &&
            (row.fragmentCount ?? 1) === count &&
            row.complete === (index === count - 1) &&
            row.featureStatus === first.featureStatus &&
            row.reason === first.reason &&
            isDeepStrictEqual(row.readTarget, first.readTarget) &&
            (row.profileKey === undefined ||
              row.profileKey === first.profileKey) &&
            (row.featureRecord === undefined ||
              isDeepStrictEqual(row.featureRecord, first.featureRecord)) &&
            (row.definition === undefined ||
              isDeepStrictEqual(row.definition, first.definition)),
        ),
      "analysis row fragments are missing, duplicated or reordered",
    );
    const byType = new Map<string, AnalysisTimelineItem["features"]>();
    for (const row of fragments)
      for (const block of row.features) {
        const blocks = byType.get(block.type) ?? [];
        blocks.push(block);
        byType.set(block.type, blocks);
      }
    const features = [...byType.values()].map((blocks) => {
      const base = blocks[0]!;
      const dimensions: string[] = [];
      const values: (number | null)[] = [];
      for (const block of blocks) {
        const {
          dimensions: names,
          values: numbers,
          dimensionOffset,
          totalDimensions,
          ...metadata
        } = block;
        const {
          dimensions: _names,
          values: _numbers,
          dimensionOffset: _offset,
          totalDimensions: _total,
          ...expected
        } = base;
        void _names;
        void _numbers;
        void _offset;
        void _total;
        check(
          isDeepStrictEqual(metadata, expected) &&
            (dimensionOffset ?? 0) === dimensions.length &&
            (totalDimensions ?? names.length) ===
              (base.totalDimensions ?? base.dimensions.length) &&
            (numbers === null) === (base.values === null) &&
            (numbers === null || numbers.length === names.length),
          "analysis dimensions or values are incomplete",
        );
        dimensions.push(...names);
        if (numbers) values.push(...numbers);
      }
      const definition = LISTENING_FEATURE_DEFINITIONS.find(
        (item) => item.type === base.type,
      )!;
      const names =
        definition.dimensions === 2
          ? ["left", "right"]
          : definition.dimensions === 48
            ? ["left", "right"].flatMap((channel) =>
                Array.from(
                  { length: 24 },
                  (_, index) => `${channel}.mel-band-${index + 1}`,
                ),
              )
            : definition.type === "mel-region-summary/v1"
              ? ["left", "right"].flatMap((channel) =>
                  ["low", "mid", "high"].map(
                    (region) => `${channel}.${region}`,
                  ),
                )
              : definition.type === "mel-ratio-summary/v1"
                ? ["left", "right"].flatMap((channel) =>
                    ["low/mid", "high/mid"].map(
                      (ratio) => `${channel}.${ratio}`,
                    ),
                  )
                : Array.from({ length: definition.dimensions }, (_, index) =>
                    definition.dimensions === 1
                      ? definition.measurement
                      : `${definition.measurement}.${index + 1}`,
                  );
      check(
        dimensions.length === definition.dimensions &&
          isDeepStrictEqual(dimensions, names) &&
          new Set(dimensions).size === dimensions.length &&
          base.units === definition.units &&
          base.normalization === definition.normalization &&
          base.coveredSamples <= base.expectedSamples,
        "analysis canonical dimensions, units or coverage changed",
      );
      const { dimensionOffset, totalDimensions, ...metadata } = base;
      void dimensionOffset;
      void totalDimensions;
      if (base.supportExtent !== undefined) {
        const extent = base.supportExtent;
        const span = first.segment.endSample - first.segment.startSample;
        const position = (beat: number) =>
          ((beat - first.segment.startBeat) /
            (first.segment.endBeat - first.segment.startBeat)) *
          span;
        check(
          first.supportCoordinate === "segment-relative-samples" &&
            (extent === null
              ? base.coveredSamples === 0
              : extent[0] >= 0 &&
                extent[1] > extent[0] &&
                extent[1] <= span &&
                base.coveredSamples > 0 &&
                base.coveredSamples <=
                  Math.max(
                    0,
                    Math.min(Math.ceil(position(first.endBeat)), extent[1]) -
                      Math.max(
                        Math.floor(position(first.startBeat)),
                        extent[0],
                      ),
                  )),
          "compact support extent contradicts native coverage",
        );
      }
      return {
        ...metadata,
        dimensions,
        values: base.values === null ? null : values,
      };
    });
    return {
      ...first,
      fragment: 0,
      fragmentCount: 1,
      complete: true,
      features,
      limitations: fragments.flatMap((row) => row.limitations ?? []),
    };
  });
  const identities = new Map<
    string,
    {
      row: AnalysisTimelineItem;
      type: AnalysisTimelineItem["features"][number]["type"];
      status: AnalysisTimelineItem["features"][number]["status"];
    }
  >();
  for (const row of rows) {
    if (analysis.detail === "evidence") {
      if (row.kind !== "feature-metadata") continue;
      check(
        row.featureType && row.featureStatus,
        "evidence omitted canonical feature identity",
      );
      const key = JSON.stringify([row.segment, row.featureType]);
      check(!identities.has(key), "duplicate delivered feature identity");
      identities.set(key, {
        row,
        type: row.featureType,
        status: row.featureStatus,
      });
    } else {
      check(
        row.kind === "segment-summary" ||
          row.kind === "interval" ||
          row.kind === "availability",
        "default analysis contains unrequested verbose evidence",
      );
      for (const block of row.features) {
        check(
          row.kind === "availability"
            ? block.status === "unavailable" &&
                block.values === null &&
                block.reason !== null &&
                listeningFeatureSchema.shape.reason.safeParse(block.reason)
                  .success &&
                block.expectedSamples ===
                  row.segment.endSample - row.segment.startSample &&
                block.supportExtent !== undefined &&
                block.channelCoveredSamples === undefined &&
                (block.channelReasons === undefined ||
                  block.channelReasons.every(
                    (reason) =>
                      reason !== null &&
                      listeningFeatureSchema.shape.reason.safeParse(reason)
                        .success,
                  ))
            : block.status === "ready",
          "invalid availability marker status, values, reason or coverage",
        );
        const key = JSON.stringify([row.segment, block.type]);
        const previous = identities.get(key);
        check(
          !previous || previous.status === block.status,
          "feature status changed within its segment",
        );
        if (!previous)
          identities.set(key, { row, type: block.type, status: block.status });
      }
    }
  }
  check(identities.size > 0, "analysis omitted canonical musical features");
  const features = [...identities.values()].map(({ row, type, status }) => {
    const definition = LISTENING_FEATURE_DEFINITIONS.find(
      (item) => item.type === type,
    );
    check(definition, "analysis has unknown feature definition");
    if (analysis.detail === "evidence")
      check(
        row.readTarget &&
          isDeepStrictEqual(row.readTarget, {
            ...analysis.readTarget,
            range: {
              startBeat: row.segment.startBeat,
              endBeat: row.segment.endBeat,
            },
            featureTypes: [type],
          }) &&
          typeof row.profileKey === "string" &&
          (row.definition === undefined ||
            isDeepStrictEqual(row.definition, definition)),
        "analysis feature target or canonical definition changed",
      );
    const matchingBlocks = (kind: AnalysisTimelineItem["kind"]) =>
      rows.flatMap((value) =>
        isDeepStrictEqual(value.segment, row.segment) && value.kind === kind
          ? value.features
              .filter((block) => block.type === type)
              .map((block) => ({
                startBeat: value.startBeat,
                endBeat: value.endBeat,
                block,
              }))
          : [],
      );
    const blocks = matchingBlocks(
      definition.grid ? "interval" : "segment-summary",
    );
    const availability = matchingBlocks("availability");
    check(
      availability.every(
        ({ block }) =>
          ["pitch-profile/v1", "spectral-shape-profile/v1"].includes(
            definition.profile,
          ) ===
          (block.channelReasons !== undefined),
      ),
      "availability marker omitted or changed canonical channel validity",
    );
    if (analysis.detail !== "evidence")
      check(
        status === "unavailable"
          ? availability.length === 1 && blocks.length === 0
          : availability.length === 0,
        "contradictory measured values and segment availability",
      );
    const supports = rows.filter(
      (value) =>
        value.kind === "support" &&
        value.featureType === type &&
        isDeepStrictEqual(value.segment, row.segment),
    );
    for (const channel of ["aggregate", "left", "right"] as const) {
      const intervals = supports.filter(
        (value) => value.supportChannel === channel,
      );
      intervals.forEach((value, index) =>
        check(
          value.supportCoordinate === "segment-relative-samples" &&
            value.supportOffset === index &&
            value.support &&
            value.support[0] >= 0 &&
            value.support[1] > value.support[0] &&
            value.support[1] <= row.segment.endSample - row.segment.startSample,
          "invalid delivered native feature support",
        ),
      );
    }
    if (analysis.detail !== "evidence" && status === "ready") {
      check(
        blocks.some(({ block }) =>
          block.values?.some((value) => value !== null),
        ),
        "ready feature validity lacks measured numeric values",
      );
      let end = row.segment.startBeat;
      for (const block of blocks) {
        check(
          block.startBeat === end && block.endBeat > end,
          "feature interval gap or overlap",
        );
        end = block.endBeat;
      }
      check(
        end === row.segment.endBeat,
        "feature intervals omit the requested extent",
      );
    }
    return { row, definition, status, blocks, availability, supports };
  });
  for (const row of rows)
    for (const block of row.features)
      check(
        features.some(
          (feature) =>
            feature.definition.type === block.type &&
            isDeepStrictEqual(feature.row.segment, row.segment),
        ),
        "delivered values have no matching musical identity",
      );
  return features;
}
export function declaresUnavailableFeature(
  analysis: CompleteAnalysis,
  features: ReturnType<typeof deliveredAnalysisFeatures>,
  definition: (typeof LISTENING_FEATURE_DEFINITIONS)[number],
  expectedSegments: number,
  expectedValues: number,
) {
  const observed = features.filter(
    (feature) => feature.definition.type === definition.type,
  );
  const values = observed
    .flatMap((feature) =>
      feature.blocks.flatMap(({ block }) => block.values ?? []),
    )
    .filter((value): value is number => value !== null);
  const summaries = analysis.overview.filter(
    (item) => item.type === definition.type,
  );
  const summary = summaries[0];
  const reasons = [
    ...new Set(
      observed.flatMap((feature) =>
        feature.availability.map(({ block }) => block.reason),
      ),
    ),
  ].sort();
  return (
    summaries.length === 1 &&
    observed.length === expectedSegments &&
    summary !== undefined &&
    summary.units === definition.units &&
    summary.basis === (definition.grid ? "grid-cells" : "segment-summaries") &&
    summary.totalSegments === expectedSegments &&
    summary.availableSegments ===
      observed.filter((feature) => feature.status === "ready").length &&
    summary.availableSegments < expectedSegments &&
    summary.validValues === values.length &&
    summary.expectedValues === expectedValues &&
    summary.minimum ===
      (values.length ? values.reduce((a, b) => Math.min(a, b)) : null) &&
    summary.maximum ===
      (values.length ? values.reduce((a, b) => Math.max(a, b)) : null) &&
    (values.length
      ? summary.reason === null
      : typeof summary.reason === "string" &&
        isDeepStrictEqual(summary.reason.split("; ").sort(), reasons))
  );
}
const toolPairs = (turn: TurnEvidence) => readFeatureToolPairs(turn);
function view(value: unknown) {
  const feature = object(value);
  const record = object(feature.record);
  const segment = contextSegmentSchema.parse(feature.segment);
  const source = object(feature.source);
  check(
    record.entryId === segment.entryId &&
      record.entryId === source.contextId &&
      record.segmentId === segment.id &&
      record.sessionId === segment.sessionId &&
      record.liveSetId === segment.liveSetId,
    "foreign feature provenance",
  );
  return { record, segment, source, metadata: object(record.feature) };
}
function immutableFeature(value: unknown) {
  const feature = view(value);
  const record = { ...feature.record };
  const source = { ...feature.source };
  // Read-time freshness and its presentation are not immutable stored content.
  delete record.freshness;
  delete source.freshness;
  delete source.summary;
  return { record, segment: feature.segment, source };
}
function sameFeatureRead(
  before: ReturnType<typeof toolPairs>[number],
  after: ReturnType<typeof toolPairs>[number],
): boolean {
  const beforePage = { ...object(before.data.page) };
  const afterPage = { ...object(after.data.page) };
  delete beforePage.limit;
  delete afterPage.limit;
  return (
    isDeepStrictEqual(
      immutableFeature(before.data.feature),
      immutableFeature(after.data.feature),
    ) && isDeepStrictEqual(beforePage, afterPage)
  );
}
function measuredPeak(
  source: FeatureSourceEvidence,
  start: number,
  end: number,
) {
  const records = source.records.filter(
    (record) => record.startSample >= start && record.endSample <= end,
  );
  check(
    records.length > 0 &&
      records[0]!.startSample === start &&
      records.at(-1)!.endSample === end &&
      records.every(
        (record, index) =>
          index === 0 || records[index - 1]!.endSample === record.startSample,
      ),
    "feature range lacks wholly measured support",
  );
  return [
    Math.max(...records.map((record) => record.peak[0])),
    Math.max(...records.map((record) => record.peak[1])),
  ];
}
function canonicalMetadata(feature: ReturnType<typeof view>) {
  const metadata = feature.metadata;
  for (const [key, schema] of Object.entries(listeningFeatureSchema.shape))
    if (
      ![
        "values",
        "profileKey",
        "support",
        "channelSupport",
        "grid",
        "limitations",
      ].includes(key)
    )
      schema.parse(metadata[key]);
  const definition = LISTENING_FEATURE_DEFINITIONS.find(
    (item) => item.type === metadata.type,
  )!;
  const grid = feature.metadata.grid;
  if (grid !== null) {
    check(
      Number.isSafeInteger(object(grid).cellCount),
      "invalid inventory grid count",
    );
    for (const [key, schema] of Object.entries(
      listeningFeatureGridSchema.shape,
    ))
      if (key !== "cells") schema.parse(object(grid)[key]);
  }
  const count = definition.grid
    ? grid === null
      ? 0
      : Number(object(grid).cellCount)
    : 1;
  const channelAware = [
    "pitch-profile/v1",
    "spectral-shape-profile/v1",
  ].includes(definition.profile);
  const supportCounts = feature.metadata.channelSupportIntervalCounts;
  check(
    [
      "profile",
      "units",
      "distanceDefinition",
      "distanceUnits",
      "normalization",
    ].every(
      (key) =>
        feature.metadata[key] === definition[key as keyof typeof definition],
    ) &&
      metadata.supportPolicy ===
        (definition.grid
          ? "matching-cell-mask"
          : metadata.type === "peak-summary/v1"
            ? "complete-required"
            : "retained-overlap") &&
      metadata.sampleRate === feature.segment.sampleRate &&
      metadata.expectedSamples ===
        feature.segment.endSample - feature.segment.startSample &&
      Number(metadata.coveredSamples) <= Number(metadata.expectedSamples) &&
      Math.abs(
        Number(metadata.durationSeconds) -
          Number(metadata.expectedSamples) / Number(metadata.sampleRate),
      ) <= 1e-12 &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      count <= 2000 &&
      (definition.grid || grid === null) &&
      Number.isSafeInteger(feature.metadata.supportIntervalCount) &&
      Number(feature.metadata.supportIntervalCount) >= 0 &&
      Number(feature.metadata.supportIntervalCount) <= 2000 &&
      (metadata.status === "ready"
        ? metadata.reason === null &&
          count > 0 &&
          feature.metadata.valueCount === count * definition.dimensions
        : metadata.reason !== null && feature.metadata.valueCount === 0) &&
      channelAware === (metadata.channelReasons !== undefined) &&
      (channelAware
        ? Array.isArray(supportCounts) &&
          supportCounts.length === 2 &&
          supportCounts.every(
            (value) => Number.isSafeInteger(value) && value >= 0 && value <= 64,
          )
        : supportCounts === undefined),
    "invalid canonical feature metadata",
  );
}
function boundFeature(
  value: unknown,
  sources: readonly FeatureSourceEvidence[],
  sessionId: string,
) {
  const feature = view(value);
  const source = sources.find(
    (source) => source.contextId === feature.record.entryId,
  );
  canonicalMetadata(feature);
  check(
    source &&
      feature.record.sessionId === sessionId &&
      typeof feature.record.id === "string" &&
      feature.record.id.length > 0 &&
      feature.source.passId === source.passId &&
      feature.record.sourceFingerprint ===
        (source.stream?.sourceFingerprint ?? source.contentSha256) &&
      feature.segment.sampleRate === source.sampleRate &&
      feature.segment.startSample >= source.records[0]!.startSample &&
      feature.segment.endSample <= source.records.at(-1)!.endSample,
    "foreign feature inventory provenance",
  );
  return { feature, source };
}
type ToolPair = ReturnType<typeof toolPairs>[number];

export function verifyStreamFeatureReads(
  source: FeatureSourceEvidence,
  pairs: readonly ToolPair[],
  expectedSource: SourceIdentity,
  phase: string,
  coverage: FeatureSearchCoverage,
): void {
  check(source.stream, "missing stream source provenance");
  const reads = pairs.filter(
    (pair) =>
      pair.call.arguments.contextId === source.contextId &&
      ["stream-overview", "stream-records"].includes(pair.action),
  );
  const overviews = reads.filter((read) => read.action === "stream-overview");
  check(overviews.length > 0, "agent did not read stored stream overview");
  for (const read of reads) {
    const entry = object(read.data.entry);
    check(
      entry.contextId === source.contextId && entry.passId === source.passId,
      "foreign measurement tool result",
    );
  }
  for (const read of overviews) {
    const overview = metricStreamOverviewSchema.parse(read.data.overview);
    check(
      overview.descriptorDigest === source.stream.descriptorDigest &&
        overview.source.view === "session" &&
        overview.source.target.track.expectedReference ===
          expectedSource.trackId &&
        overview.source.clipReference === expectedSource.clipId &&
        overview.geometry.sampleRate === source.sampleRate &&
        overview.geometry.startSample === source.records[0]!.startSample &&
        overview.geometry.endSample === source.records.at(-1)!.endSample &&
        overview.outcome === "complete" &&
        (coverage === "peak-only" ? ["level"] : metricFamilies).every(
          (family) =>
            overview.metrics.some(
              (metric) =>
                metric.metric === family &&
                metric.availability === "available" &&
                metric.missingRecords === 0,
            ),
        ),
      "stream overview differs from original measured source",
    );
  }
  const consumed = {
    level: new Set<number>(),
    pitch: new Set<number>(),
    "spectral-shape": new Set<number>(),
  };
  for (const read of reads.filter((read) => read.action === "stream-records")) {
    if (read.data.page === null) continue;
    const page = metricStreamRecordPageSchema.parse(read.data.page);
    check(
      page.descriptorDigest === source.stream.descriptorDigest &&
        page.metric === read.call.arguments.metric &&
        page.gaps.length === 0,
      "foreign or incomplete original stream page",
    );
    if (page.metric === "level")
      for (const record of page.records) {
        check("peak" in record, "invalid original level record");
        check(
          isDeepStrictEqual(source.records[record.index], {
            ...record.support,
            peak: record.peak,
          }),
          "stream level differs from original measurement",
        );
        consumed.level.add(record.index);
      }
    else if (page.metric === "pitch" || page.metric === "spectral-shape") {
      const timeline =
        page.metric === "pitch"
          ? source.analyzers?.pitch
          : source.analyzers?.spectralShape;
      check(timeline, "missing authoritative analyzer evidence");
      for (const frame of page.records) {
        check(
          isDeepStrictEqual(
            timeline.frames.find((item) => item.index === frame.index),
            frame,
          ),
          "stream analyzer differs from original measurement",
        );
        consumed[page.metric].add(frame.index);
      }
    }
  }
  check(
    consumed.level.size === source.records.length &&
      (coverage === "peak-only" ||
        (phase === "restored"
          ? consumed.pitch.size > 0 && consumed["spectral-shape"].size > 0
          : consumed.pitch.size === source.analyzers?.pitch.frames.length &&
            consumed["spectral-shape"].size ===
              source.analyzers?.spectralShape.frames.length)),
    "agent did not consume required original stream records",
  );
}
type EstablishedPeak = {
  id: string;
  feature: unknown;
  values: number[];
  evidence:
    | { kind: "direct"; read: ToolPair }
    | { kind: "equality"; comparison: ToolPair };
};
function verifyCatalogs(pairs: ToolPair[]): boolean {
  const catalogs = pairs.filter(
    (pair) => pair.action === "feature-definitions",
  );
  for (const catalog of catalogs) {
    const definitions = array(catalog.data.definitions).map((definition) =>
      listeningFeatureDefinitionSchema.parse(definition),
    );
    check(
      definitions.length === 15 &&
        new Set(definitions.map((definition) => definition.type)).size === 15 &&
        LISTENING_FEATURE_DEFINITIONS.every((definition) =>
          definitions.some((actual) => isDeepStrictEqual(actual, definition)),
        ),
      "incomplete catalog",
    );
  }
  return catalogs.length > 0;
}
function establishPeaks(
  reads: ToolPair[],
  pairs: ToolPair[],
  sources: readonly FeatureSourceEvidence[],
  sessionId: string,
  allowEquality: boolean,
) {
  const bySource = new Map<string, EstablishedPeak>();
  const peaks = reads.filter(
    (pair) => view(pair.data.feature).metadata.type === "peak-summary/v1",
  );
  for (const pair of peaks) {
    const { feature, source } = boundFeature(
      pair.data.feature,
      sources,
      sessionId,
    );
    check(
      pair.call.arguments.featureId === feature.record.id &&
        feature.metadata.status === "ready",
      "foreign/unavailable peak feature",
    );
    const values = measuredPeak(
      source,
      feature.segment.startSample,
      feature.segment.endSample,
    );
    const page = object(pair.data.page);
    check(
      page.offset === 0 &&
        page.nextOffset === null &&
        isDeepStrictEqual(page.values, values) &&
        feature.metadata.coveredSamples === feature.metadata.expectedSamples,
      "bad peak arithmetic or coverage",
    );
    const previous = bySource.get(source.contextId);
    if (previous)
      check(
        previous.evidence.kind === "direct" &&
          sameFeatureRead(previous.evidence.read, pair),
        "immutable peak feature changed",
      );
    bySource.set(source.contextId, {
      id: String(feature.record.id),
      feature: pair.data.feature,
      values,
      evidence: { kind: "direct", read: pair },
    });
  }
  const first = bySource.get(sources[0]!.contextId);
  if (allowEquality && first && !bySource.has(sources[1]!.contextId)) {
    // Only exact zero identifies the unread vector; retained source samples must
    // independently establish that same vector. This is not a synthetic read.
    const candidates = pairs.flatMap((pair) => {
      const features =
        pair.action === "list-features"
          ? array(pair.data.features)
          : pair.action === "search-features"
            ? array(pair.data.matches).map((match) => object(match).feature)
            : [];
      check(
        features.length <= (pair.action === "search-features" ? 20 : 100),
        "unbounded equality metadata",
      );
      return features.map((feature) => ({ pair, feature }));
    });
    for (const pair of pairs.filter(
      (pair) => pair.action === "compare-features",
    )) {
      for (const raw of array(pair.data.comparisons)) {
        const comparison = object(raw);
        const result = listeningFeatureComparisonSchema.parse(
          comparison.result,
        );
        if (
          comparison.leftFeatureId !== first.id ||
          result.status !== "comparable" ||
          result.distanceDefinition !== "euclidean-linear-amplitude/v1" ||
          result.units !== "linear-amplitude" ||
          !("distance" in result) ||
          result.distance !== 0
        )
          continue;
        check(
          array(pair.call.arguments.pairs)
            .map(object)
            .some(
              (requested) =>
                requested.leftFeatureId === first.id &&
                requested.rightFeatureId === comparison.rightFeatureId,
            ),
          "equality comparison was not requested",
        );
        const matches = candidates.filter(
          (candidate) =>
            view(candidate.feature).record.id === comparison.rightFeatureId,
        );
        check(matches.length > 0, "missing equality target metadata");
        check(
          !reads.some(
            (read) =>
              read.call.arguments.featureId === comparison.rightFeatureId ||
              view(read.data.feature).record.id === comparison.rightFeatureId,
          ),
          "contradictory target feature read",
        );
        const target = matches[0]!.feature;
        const { feature, source } = boundFeature(target, sources, sessionId);
        const values = measuredPeak(
          source,
          feature.segment.startSample,
          feature.segment.endSample,
        );
        check(
          source.contextId === sources[1]!.contextId &&
            feature.record.liveSetId === view(first.feature).record.liveSetId &&
            feature.metadata.type === "peak-summary/v1" &&
            feature.metadata.status === "ready" &&
            feature.metadata.coveredSamples ===
              feature.metadata.expectedSamples &&
            isDeepStrictEqual(values, first.values) &&
            matches.every(
              (match) =>
                (match.pair.action !== "list-features" ||
                  match.pair.call.arguments.contextId === undefined ||
                  match.pair.call.arguments.contextId === source.contextId) &&
                isDeepStrictEqual(
                  immutableFeature(match.feature),
                  immutableFeature(target),
                ),
            ),
          "invalid exact peak equality proof",
        );
        const previous = bySource.get(source.contextId);
        check(
          !previous ||
            isDeepStrictEqual(
              immutableFeature(previous.feature),
              immutableFeature(target),
            ),
          "contradictory equality target",
        );
        bySource.set(source.contextId, {
          id: String(feature.record.id),
          feature: target,
          values,
          evidence: { kind: "equality", comparison: pair },
        });
      }
    }
  }
  check(
    bySource.size === sources.length &&
      new Set([...bySource.values()].map((peak) => peak.id)).size ===
        sources.length,
    "missing typed peak feature reads or exact equality proof",
  );
  return bySource;
}
const analyzerFeatureTypes = [
  "pitch-confidence-summary/v1",
  "flatness-summary/v1",
  "spread-summary/v1",
  "rolloff-summary/v1",
] as const;
function verifyAnalyzerFeatures(
  pairs: ReturnType<typeof toolPairs>,
  sources: FeatureSourceEvidence[],
  sessionId: string,
) {
  const reads = pairs.filter((pair) => pair.action === "get-feature");
  for (const source of sources)
    for (const type of analyzerFeatureTypes) {
      check(source.analyzers, "missing authoritative analyzer evidence");
      const matches = reads.filter((pair) => {
        const feature = view(pair.data.feature);
        return (
          feature.record.entryId === source.contextId &&
          feature.metadata.type === type
        );
      });
      check(matches.length > 0, `missing typed ${type} read`);
      for (const pair of matches) {
        const feature = view(pair.data.feature);
        const { startSample: start, endSample: end } = feature.segment;
        const timeline =
          type === "pitch-confidence-summary/v1"
            ? source.analyzers.pitch
            : source.analyzers.spectralShape;
        const definition = LISTENING_FEATURE_DEFINITIONS.find(
          (value) => value.type === type,
        );
        check(
          definition &&
            feature.record.sessionId === sessionId &&
            pair.call.arguments.featureId === feature.record.id &&
            feature.record.sourceFingerprint ===
              (source.stream?.sourceFingerprint ?? source.contentSha256) &&
            feature.source.passId === source.passId &&
            feature.metadata.profile === definition.profile &&
            feature.metadata.distanceDefinition ===
              definition.distanceDefinition &&
            feature.metadata.units === definition.units &&
            feature.metadata.distanceUnits === definition.distanceUnits &&
            feature.metadata.expectedSamples === end - start &&
            start >= timeline.sourceSupport.startSample &&
            end <= timeline.sourceSupport.endSample,
          "foreign or unavailable analyzer feature",
        );
        const overlap = (support: { startSample: number; endSample: number }) =>
          Math.max(
            0,
            Math.min(end, support.endSample) -
              Math.max(start, support.startSample),
          );
        const values = [0, 1].map((channelIndex) => {
          let weightedSum = 0,
            weight = 0;
          for (const frame of timeline.frames) {
            const channel = frame.channels[channelIndex]!;
            const value =
              "confidence" in channel
                ? channel.state !== "invalid"
                  ? channel.confidence
                  : null
                : channel.state !== "valid"
                  ? null
                  : type === "flatness-summary/v1"
                    ? channel.flatnessDb
                    : type === "spread-summary/v1"
                      ? channel.spreadHz
                      : channel.rolloffHz;
            if (value !== null) {
              const samples = overlap(frame.support);
              weightedSum += samples * value;
              weight += samples;
            }
          }
          return weight === 0 ? null : weightedSum / weight;
        });
        const page = object(pair.data.page);
        const available = values.some((value) => value !== null);
        const actual = available ? array(page.values) : [null, null];
        check(
          (available || type === "pitch-confidence-summary/v1") &&
            feature.metadata.status === (available ? "ready" : "unavailable") &&
            (available
              ? feature.metadata.reason === null
              : typeof feature.metadata.reason === "string" &&
                feature.metadata.reason.length > 0 &&
                page.values === null) &&
            page.offset === 0 &&
            page.nextOffset === null &&
            actual.length === 2 &&
            actual.every((value, index) => {
              const expected = values[index]!;
              return expected === null
                ? value === null
                : typeof value === "number" &&
                    Number.isFinite(value) &&
                    Math.abs(value - expected) <=
                      1e-10 * Math.max(1, Math.abs(expected));
            }) &&
            feature.metadata.coveredSamples ===
              timeline.frames.reduce(
                (count, frame) => count + overlap(frame.support),
                0,
              ),
          "bad analyzer arithmetic, validity or acquisition coverage",
        );
        const reasons = array(feature.metadata.channelReasons);
        check(
          reasons.length === 2 &&
            reasons.every((reason, index) =>
              values[index] === null
                ? typeof reason === "string" && reason.length > 0
                : reason === null,
            ),
          "false analyzer channel validity",
        );
      }
    }
}
function verifyDeliveredFeatures(
  turns: readonly TurnEvidence[],
  selected: TurnEvidence,
  sources: FeatureSourceEvidence[],
  phase: string,
  coverage: FeatureSearchCoverage,
) {
  const available = readCompleteAnalyses(
    phase === "restored" ? [selected] : turns,
  );
  const bySource = new Map<
    string,
    {
      analysis: CompleteAnalysis;
      peaks: ReturnType<typeof deliveredAnalysisFeatures>;
    }
  >();
  const close = (actual: unknown, expected: number) =>
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
  for (const analysis of available)
    check(
      sources.some(
        (source) => source.contextId === analysis.readTarget.contextId,
      ),
      "delivered analysis contains a foreign capture",
    );
  for (const source of sources) {
    const analyses = available.filter(
      (analysis) =>
        analysis.detail === undefined &&
        analysis.readTarget.contextId === source.contextId &&
        analysis.readTarget.featureTypes === undefined &&
        isDeepStrictEqual(
          analysis.readTarget.range,
          analysis.source.observedRange,
        ),
    );
    check(analyses.length > 0, "missing complete pinned capture analysis");
    const analysis = analyses[0]!;
    check(
      analyses.every((other) =>
        isDeepStrictEqual(
          immutableDeliveredAnalysis(other),
          immutableDeliveredAnalysis(analysis),
        ),
      ),
      "delivered original capture content changed",
    );
    const geometry = analysis.source.geometry;
    const start = source.records[0]!.startSample;
    const end = source.records.at(-1)!.endSample;
    check(
      geometry &&
        geometry.sampleRate === source.sampleRate &&
        geometry.captureStartSample === start &&
        analysis.readTarget.coordinate === "clip-local-beats" &&
        analysis.source.coordinate === analysis.readTarget.coordinate &&
        isDeepStrictEqual(
          analysis.source.requestedRange,
          analysis.readTarget.range,
        ) &&
        close(
          ((analysis.readTarget.range.endBeat -
            analysis.readTarget.range.startBeat) *
            source.sampleRate *
            60) /
            geometry.tempoBpm,
          end - start,
        ),
      "delivered geometry differs from independent original acquisition",
    );
    const features = deliveredAnalysisFeatures(analysis);
    const segments = [
      ...new Map(
        features.map((feature) => [
          JSON.stringify(feature.row.segment),
          feature.row.segment,
        ]),
      ).values(),
    ].sort((a, b) => a.startBeat - b.startBeat);
    const explicitlyUnavailable = (type: string) => {
      const definition = LISTENING_FEATURE_DEFINITIONS.find(
        (item) => item.type === type,
      )!;
      const expectedValues =
        definition.dimensions *
        (definition.grid
          ? segments.reduce((sum, segment) => {
              if (segment.kind === "unaligned") return sum;
              const origin =
                segment.barOriginBeat ?? segment.alignment?.barOriginBeat ?? 0;
              return (
                sum +
                Math.ceil((segment.endBeat - origin) / 0.25) -
                Math.floor((segment.startBeat - origin) / 0.25)
              );
            }, 0)
          : segments.length);
      return declaresUnavailableFeature(
        analysis,
        features,
        definition,
        segments.length,
        expectedValues,
      );
    };
    let nextBeat = analysis.readTarget.range.startBeat;
    for (const segment of segments) {
      check(
        segment.startBeat === nextBeat &&
          segment.sampleRate === source.sampleRate &&
          close(
            segment.startSample,
            start +
              ((segment.startBeat - analysis.readTarget.range.startBeat) *
                source.sampleRate *
                60) /
                geometry.tempoBpm,
          ) &&
          close(
            segment.endSample,
            start +
              ((segment.endBeat - analysis.readTarget.range.startBeat) *
                source.sampleRate *
                60) /
                geometry.tempoBpm,
          ),
        "delivered segment omits or changes original acquisition extent",
      );
      nextBeat = segment.endBeat;
      const onSegment = features.filter((feature) =>
        isDeepStrictEqual(feature.row.segment, segment),
      );
      check(
        coverage === "peak-only" ||
          LISTENING_FEATURE_DEFINITIONS.every((definition) =>
            onSegment.some(
              (feature) =>
                feature.definition.type === definition.type &&
                (feature.status === "ready" ||
                  explicitlyUnavailable(definition.type)),
            ),
          ),
        "missing delivered canonical feature families",
      );
      for (const feature of onSegment) {
        const record = feature.row.featureRecord;
        if (record)
          check(
            record.entryId === source.contextId &&
              record.sessionId === selected.appSessionId &&
              record.liveSetId === analysis.readTarget.liveSetId &&
              record.sourceFingerprint ===
                (source.stream?.sourceFingerprint ?? source.contentSha256) &&
              record.feature.type === feature.definition.type,
            "delivered feature attribution differs from original source",
          );
      }
      for (const type of [
        "peak-summary/v1",
        ...(coverage === "full" ? analyzerFeatureTypes : []),
      ]) {
        const feature = onSegment.find((item) => item.definition.type === type);
        const block =
          feature?.blocks[0]?.block ?? feature?.availability[0]?.block;
        let expected: (number | null)[];
        let covered: number;
        const expectedReasons: (string | null)[] = [];
        if (type === "peak-summary/v1") {
          expected = measuredPeak(
            source,
            segment.startSample,
            segment.endSample,
          );
          covered = segment.endSample - segment.startSample;
        } else {
          check(source.analyzers, "missing independent native analyzers");
          const timeline =
            type === "pitch-confidence-summary/v1"
              ? source.analyzers.pitch
              : source.analyzers.spectralShape;
          const overlap = (support: {
            startSample: number;
            endSample: number;
          }) =>
            Math.max(
              0,
              Math.min(segment.endSample, support.endSample) -
                Math.max(segment.startSample, support.startSample),
            );
          expected = [0, 1].map((channelIndex) => {
            let sum = 0,
              weight = 0;
            let reason: string | null = null;
            for (const frame of timeline.frames) {
              const channel = frame.channels[channelIndex]!;
              const n = overlap(frame.support);
              if (n === 0) continue;
              const value =
                "confidence" in channel
                  ? channel.state === "invalid"
                    ? null
                    : channel.confidence
                  : channel.state !== "valid"
                    ? null
                    : type === "flatness-summary/v1"
                      ? channel.flatnessDb
                      : type === "spread-summary/v1"
                        ? channel.spreadHz
                        : channel.rolloffHz;
              if (value !== null) {
                sum += value * n;
                weight += n;
              } else
                reason ??=
                  channel.state === "silence" ||
                  channel.state === "low-confidence" ||
                  channel.state === "outside-qualified-range"
                    ? channel.state
                    : channel.state === "undefined"
                      ? "undefined-descriptor"
                      : "invalid-output";
            }
            expectedReasons.push(
              weight ? null : (reason ?? "insufficient-support"),
            );
            return weight ? sum / weight : null;
          });
          covered = timeline.frames.reduce(
            (count, frame) => count + overlap(frame.support),
            0,
          );
          if (block)
            check(
              isDeepStrictEqual(block.channelReasons, expectedReasons),
              "delivered analyzer channel validity changed",
            );
        }
        const ready = expected.some((value) => value !== null);
        check(
          feature &&
            block &&
            (ready
              ? feature.blocks.length === 1
              : feature.availability.length === 1 &&
                explicitlyUnavailable(type)),
          `missing delivered ${type} values`,
        );
        check(
          feature.status === (ready ? "ready" : "unavailable") &&
            block.status === (ready ? "ready" : "unavailable") &&
            block.expectedSamples === segment.endSample - segment.startSample &&
            block.coveredSamples === covered &&
            (ready
              ? block.reason === null &&
                block.values?.length === 2 &&
                block.values.every((value, index) =>
                  expected[index] === null
                    ? value === null
                    : close(value, expected[index]!),
                )
              : block.values === null && block.reason === expectedReasons[0]),
          "delivered values, acquisition coverage or validity differ from independent native measurements",
        );
      }
    }
    check(
      nextBeat === analysis.readTarget.range.endBeat,
      "analysis omitted final captured segment",
    );
    bySource.set(source.contextId, {
      analysis,
      peaks: features.filter(
        (feature) => feature.definition.type === "peak-summary/v1",
      ),
    });
    if (phase === "restored") {
      const originals = readCompleteAnalyses(turns.slice(0, -1)).filter(
        (page) =>
          page.detail === undefined &&
          page.readTarget.contextId === source.contextId &&
          page.readTarget.featureTypes === undefined,
      );
      check(
        originals.some((page) =>
          isDeepStrictEqual(
            immutableDeliveredAnalysis(page),
            immutableDeliveredAnalysis(analysis),
          ),
        ),
        "restored pinned analysis changed original numeric data or feature content",
      );
    }
  }
  if (phase === "first") return;
  const first = bySource.get(sources[0]!.contextId)!;
  const second = bySource.get(sources[1]!.contextId)!;
  const targetMatches = (target: unknown, expected: CompleteAnalysis) => {
    const { featureTypes, ...scope } =
      captureAnalysisTargetSchema.parse(target);
    const { featureTypes: _types, ...expectedScope } = expected.readTarget;
    void _types;
    return (
      (featureTypes === undefined ||
        featureTypes.includes("peak-summary/v1")) &&
      isDeepStrictEqual(scope, expectedScope)
    );
  };
  const sourceMatches = (
    actual: AnalysisPage["source"],
    expected: CompleteAnalysis,
  ) => {
    const { freshness, readTarget, ...source } = actual;
    const {
      freshness: _freshness,
      readTarget: _target,
      ...original
    } = expected.source;
    void freshness;
    void _freshness;
    void _target;
    return (
      targetMatches(readTarget, expected) && isDeepStrictEqual(source, original)
    );
  };
  const compareItems = (
    items: Extract<
      AnalysisOperationResult,
      { action: "compare" }
    >["comparisons"],
  ) => {
    const peaks = items.filter((item) => item.type === "peak-summary/v1");
    check(
      peaks.length === first.peaks.length &&
        peaks.length === second.peaks.length,
      "comparison omitted the complete peak extent",
    );
    const distances: number[] = [];
    for (const [index, item] of peaks.entries()) {
      const left = first.peaks[index]!,
        right = second.peaks[index]!;
      check(
        isDeepStrictEqual(item.left, {
          startBeat: left.row.segment.startBeat,
          endBeat: left.row.segment.endBeat,
        }) &&
          isDeepStrictEqual(item.right, {
            startBeat: right.row.segment.startBeat,
            endBeat: right.row.segment.endBeat,
          }) &&
          item.reason === null,
        "comparison selected foreign or incomplete segment ranges",
      );
      const distance = Math.hypot(
        ...left.blocks[0]!.block.values!.map(
          (value, channel) =>
            Number(value) - Number(right.blocks[0]!.block.values![channel]),
        ),
      );
      const result = item.comparison;
      check(
        result?.status === "comparable" &&
          result.distanceDefinition === "euclidean-linear-amplitude/v1" &&
          result.units === "linear-amplitude" &&
          "distance" in result &&
          close(result.distance, distance),
        "bad independently verified Euclidean comparison",
      );
      if (item.evidence)
        check(
          item.evidence.scope === "segment-summary" &&
            isDeepStrictEqual(
              item.evidence.leftValues,
              left.blocks[0]!.block.values,
            ) &&
            isDeepStrictEqual(
              item.evidence.rightValues,
              right.blocks[0]!.block.values,
            ) &&
            isDeepStrictEqual(item.evidence.leftRange, item.left) &&
            isDeepStrictEqual(item.evidence.rightRange, item.right),
          "comparison evidence differs from delivered original values",
        );
      distances.push(distance);
    }
    return Math.sqrt(
      distances.reduce((sum, distance) => sum + distance * distance, 0) /
        distances.length,
    );
  };
  const pairs = readFeatureToolPairs(selected);
  let compared = false,
    searched = false;
  for (const action of ["compare", "search"] as const) {
    let cursor: string | null = null;
    let request: unknown;
    let items: Extract<
      AnalysisOperationResult,
      { action: "compare" }
    >["comparisons"] = [];
    let searchDistance: number | undefined;
    let searchTotal: number | undefined;
    for (const pair of pairs.filter((pair) => pair.action === action)) {
      const parsed = analysisOperationParamsSchema.parse(pair.call.arguments);
      const result = analysisOperationResultSchema.parse(pair.data);
      const { cursor: supplied, ...query } = parsed;
      check(
        (supplied ?? null) === cursor &&
          (!cursor || isDeepStrictEqual(request, query)),
        "comparison/search continuation changed request or skipped a page",
      );
      if (!cursor) {
        request = query;
        items = [];
        searchDistance = undefined;
        searchTotal = undefined;
      }
      if (parsed.action === "compare" && result.action === "compare") {
        check(
          targetMatches(parsed.left, first.analysis) &&
            targetMatches(parsed.right, second.analysis) &&
            targetMatches(result.readTarget.left, first.analysis) &&
            targetMatches(result.readTarget.right, second.analysis) &&
            sourceMatches(result.left, first.analysis) &&
            sourceMatches(result.right, second.analysis) &&
            result.completeExtent &&
            result.truncated === (result.nextCursor !== null),
          "comparison changed pinned source ownership or complete extent",
        );
        items.push(...result.comparisons);
        cursor = result.nextCursor;
        if (!cursor) {
          compareItems(items);
          compared = true;
        }
      } else {
        check(
          parsed.action === "search" && result.action === "search",
          "unexpected analysis action",
        );
        check(
          targetMatches(parsed.query, first.analysis) &&
            parsed.scope.length === 1 &&
            targetMatches(parsed.scope[0], second.analysis) &&
            !parsed.withinCapture &&
            parsed.featureType === "peak-summary/v1" &&
            result.featureType === "peak-summary/v1" &&
            sourceMatches(result.query, first.analysis) &&
            result.distanceUnits === "linear-amplitude" &&
            result.exhaustive &&
            result.scannedCount === 1 &&
            result.skippedCount === 0 &&
            result.selectedCount === 1 &&
            result.returnedCount === result.matches.length &&
            result.requestedTopK === parsed.topK &&
            result.matches.length === 1 &&
            result.truncated === (result.nextCursor !== null),
          "search changed query exclusion, bounded scope or coverage",
        );
        const match = result.matches[0]!;
        check(
          match.rank === 1 &&
            sourceMatches(match.source, second.analysis) &&
            sourceMatches(match.match, second.analysis) &&
            match.evidence.offset === items.length &&
            (searchTotal === undefined ||
              searchTotal === match.evidence.total) &&
            (searchDistance === undefined || searchDistance === match.distance),
          "search changed original match or skipped evidence",
        );
        items.push(...match.comparisons);
        searchTotal = match.evidence.total;
        searchDistance = match.distance;
        check(
          match.evidence.complete === (items.length === searchTotal),
          "search evidence extent changed",
        );
        cursor = result.nextCursor;
        if (!cursor) {
          check(
            items.length === searchTotal &&
              close(searchDistance, compareItems(items)),
            "search distance differs from independently measured complete extent",
          );
          searched = true;
        }
      }
    }
    check(cursor === null, "comparison/search continuation was not consumed");
  }
  check(
    compared && (phase !== "second" || searched),
    "missing actual pinned comparison or search",
  );
}
/** Independent oracle: no product distance/extractor calls and no assistant-text claims. */
export function verifyFeatureSearch(
  input: AssertionInput,
  phase: string,
  coverage: FeatureSearchCoverage = "full",
): void {
  check(
    coverage === "full" || coverage === "peak-only",
    "invalid feature coverage",
  );
  check(
    coverage !== "peak-only" || phase !== "restored",
    "peak-only smoke cannot restart",
  );
  const turns = input.turns;
  const expectedTurns = coverage === "peak-only" ? 2 : 3;
  if (phase === "final") {
    check(
      turns.length === expectedTurns &&
        input.evidence?.capturePassIds?.length === 2,
      "final capture inventory mismatch",
    );
    validateFeatureSources(input.evidence.featureSources, coverage);
    verifyFeatureSearch(
      { ...input, turns: turns.slice(0, 1), turn: turns[0]! },
      "first",
      coverage,
    );
    verifyFeatureSearch(
      { ...input, turns: turns.slice(0, 2), turn: turns[1]! },
      "second",
      coverage,
    );
    if (coverage === "full")
      verifyFeatureSearch({ ...input, turn: turns[2]! }, "restored");
    const setup = input.evidence.setupActions;
    check(
      setup?.length === expectedTurns - 1 &&
        setup[0]?.action === "stop-transport" &&
        (coverage === "peak-only" ||
          setup[1]?.action === "restart-owned-desktop"),
      "declared stop/restart evidence missing",
    );
    check(
      input.evidence.featureSources?.length === 2 &&
        input.evidence.featureSources.every((source) =>
          turns
            .at(-1)!
            .featureSources?.some(
              (restored) =>
                restored.contextId === source.contextId &&
                restored.contentSha256 === source.contentSha256 &&
                JSON.stringify(restored.analyzers) ===
                  JSON.stringify(source.analyzers) &&
                JSON.stringify(restored.records) ===
                  JSON.stringify(source.records),
            ),
        ),
      "final persisted observations changed",
    );
    return;
  }
  check(turns.length >= 1 && turns.length <= 3, "invalid turn count");
  const selected = input.turn ?? turns.at(-1)!;
  for (const turn of turns)
    check(
      turn.status === "completed" &&
        turn.appSessionId === turns[0]!.appSessionId &&
        turn.agentId === turns[0]!.agentId &&
        turn.conversationId === turns[0]!.conversationId,
      "conversation changed",
    );
  const sources = selected.featureSources;
  validateFeatureSources(sources, coverage);
  check(
    coverage !== "full" ||
      sources.every((source) => source.analyzers !== undefined),
    "missing authoritative analyzer evidence",
  );
  if (coverage === "peak-only")
    check(
      turns.length <= 2 &&
        turns.every(
          (turn) =>
            !turn.agentListening?.afterOwnedRestart &&
            turn.featureSources?.every((source) => !source.afterOwnedRestart),
        ),
      "peak-only smoke must remain in the same session without restart",
    );
  const pairs = toolPairs(selected);
  if (phase === "restored")
    check(
      selected.agentListening?.afterOwnedRestart &&
        sources.every((source) => source.afterOwnedRestart),
      "no owned restart evidence",
    );
  if (phase === "second") {
    check(
      turns.length === 2 &&
        isDeepStrictEqual(selected, turns[1]) &&
        turns[0]!.facts.sdkTurnId !== selected.facts.sdkTurnId &&
        turns.every(
          (turn) =>
            !turn.agentListening?.afterOwnedRestart &&
            turn.featureSources?.every((source) => !source.afterOwnedRestart),
        ),
      "second-turn evidence mismatch",
    );
    check(
      isDeepStrictEqual(turns[0]!.featureSources![0], sources[0]),
      "prior stored source changed",
    );
  }
  const consumedCatalog = verifyCatalogs(pairs);
  const captures = turns.flatMap((turn) => turn.captures);
  const expected = phase === "first" ? 1 : 2;
  check(
    captures.length === expected &&
      sources.length === expected &&
      new Set(captures.map((capture) => capture.passId)).size === expected,
    "extra or missing capture/source",
  );
  check(
    captures.every(
      (capture) =>
        capture.complete &&
        capture.cleanupComplete &&
        capture.native &&
        (coverage === "peak-only"
          ? capture.metricFamilies.includes("level")
          : capture.metricFamilies.length === metricFamilies.length &&
            metricFamilies.every((family) =>
              capture.metricFamilies.includes(family),
            )) &&
        !capture.failure &&
        sources.some((source) => source.passId === capture.passId),
    ),
    "capture cleanup/source mismatch",
  );
  const expectedSource = input.baseline.sources?.a?.source;
  check(
    expectedSource &&
      captures.every(
        (capture) =>
          capture.listenerId === input.baseline.sources?.a?.listenerId &&
          JSON.stringify(capture.source) === JSON.stringify(expectedSource),
      ),
    "foreign capture source",
  );
  check(
    sources.every((source) =>
      selected.contexts.some(
        (context) =>
          context.contextId === source.contextId &&
          context.passId === source.passId &&
          context.contentSha256 === source.contentSha256,
      ),
    ),
    "source projection is not persisted context evidence",
  );
  const derivations = pairs.filter((pair) => pair.action === "derive-features");
  check(
    derivations.length <= (phase === "restored" ? 0 : 1) &&
      derivations.every(
        (pair) =>
          JSON.stringify(pair.call.arguments.contextIds) ===
          JSON.stringify([sources.at(-1)!.contextId]),
      ),
    "forbidden derivation scope or extra mutation",
  );
  for (const derivation of derivations) {
    const records = array(derivation.data.derivations).map(object);
    check(
      records.length === 1 &&
        records[0]!.entryId === sources.at(-1)!.contextId &&
        records[0]!.status === "ready" &&
        records[0]!.definitionSet === "qualified-listening/v1" &&
        records[0]!.reason === null &&
        Number.isInteger(records[0]!.featureCount) &&
        Number(records[0]!.featureCount) > 0 &&
        Number(records[0]!.featureCount) <= MAX_CONTEXT_FEATURES_PER_DERIVATION,
      "failed or foreign derivation result",
    );
  }
  const starts = pairs.filter(
    (pair) => pair.action === "play-session-and-listen",
  );
  check(
    starts.length === (phase === "restored" ? 0 : 1),
    "forbidden extra capture",
  );
  if (phase === "first" || phase === "second") {
    const source = sources.at(-1)!;
    const start = starts[0]!;
    const target = object(start.call.arguments.target);
    const job = object(start.data.job);
    check(
      target.view === "session" &&
        object(target.track).expectedReference === expectedSource.trackId &&
        target.expectedClipReference === expectedSource.clipId &&
        target.sceneIndex === expectedSource.slotIndex &&
        (start.call.arguments.listenerIds === undefined ||
          JSON.stringify(start.call.arguments.listenerIds) ===
            JSON.stringify([input.baseline.sources.a!.listenerId])) &&
        job.stage === "completed" &&
        job.passId === source.passId &&
        JSON.stringify(job.contextIds) === JSON.stringify([source.contextId]),
      "capture tool result is foreign or incomplete",
    );
  }
  if (
    pairs.some(
      (pair) =>
        Array.isArray(pair.data.analyses) ||
        ["read", "compare", "search"].includes(pair.action),
    )
  ) {
    check(
      derivations.length === 0,
      "modern listening must not explicitly derive",
    );
    verifyDeliveredFeatures(turns, selected, sources, phase, coverage);
    return;
  }
  for (const source of phase === "restored" ? sources : [sources.at(-1)!]) {
    if (source.stream) {
      verifyStreamFeatureReads(source, pairs, expectedSource, phase, coverage);
      continue;
    }

    const reads = pairs.filter(
      (pair) =>
        ["get", "report"].includes(pair.action) &&
        pair.call.arguments.contextId === source.contextId,
    );
    check(reads.length > 0, "agent did not read stored measurements");
    let fullObservation = false;
    const reportFrames = {
      pitch: new Set<number>(),
      spectralShape: new Set<number>(),
    };
    for (const read of reads) {
      const entry = object(read.data.entry);
      check(
        entry.contextId === source.contextId && entry.passId === source.passId,
        "foreign measurement tool result",
      );
      const measured =
        read.action === "get"
          ? metricAudioObservationSchema.parse(read.data.observation)
          : readFeatureReport(
              read.data.report === undefined
                ? read.data.featureReport
                : projectFeatureReport(
                    metricListeningReportSchema.parse(read.data.report),
                  ),
            );
      check(
        measured.source.view === "session" &&
          measured.source.target.track.expectedReference ===
            expectedSource.trackId &&
          measured.source.clipReference === expectedSource.clipId,
        "foreign measured source",
      );
      if ("ownership" in measured) {
        check(
          projectFeatureSource(source.contextId, measured, false, coverage)
            .contentSha256 === source.contentSha256,
          "agent read does not match persisted measurement",
        );
        fullObservation = true;
      } else {
        if (coverage === "peak-only") {
          check(
            measured.metricStatus.level === "complete",
            "report missing measured levels",
          );
          continue;
        }
        check(source.analyzers, "missing authoritative analyzer evidence");
        check(
          measured.sampleRate === source.sampleRate &&
            measured.sourceCoverage.startSample ===
              source.records[0]!.startSample &&
            measured.sourceCoverage.endSample ===
              source.records.at(-1)!.endSample,
          "report source support differs from stored source",
        );
        check(
          metricFamilies.every(
            (family) => measured.metricStatus[family] === "complete",
          ),
          "report missing authoritative family",
        );
        for (const [family, key] of [
          ["pitch", "pitch"],
          ["spectral-shape", "spectralShape"],
        ] as const) {
          const timeline = source.analyzers[key];
          const metadata = measured.analyzers[family];
          check(
            metadata &&
              metadata.profileSha256 === fingerprint(timeline.profile) &&
              metadata.expectedRecords === timeline.expectedRecords &&
              metadata.retainedRecords === timeline.frames.length &&
              metadata.missingRecords === 0 &&
              JSON.stringify(metadata.trailingSupport) ===
                JSON.stringify(timeline.trailingSupport),
            "report analyzer acquisition differs from stored source",
          );
          for (const frame of metadata.frames) {
            const original = timeline.frames.find(
              (value) => value.index === frame.index,
            );
            check(
              original && frame.sha256 === fingerprint(original),
              "report analyzer validity differs from stored source",
            );
            reportFrames[key].add(frame.index);
          }
        }
      }
    }
    check(
      coverage === "peak-only" ||
        fullObservation ||
        (phase === "restored" &&
          reportFrames.pitch.size > 0 &&
          reportFrames.spectralShape.size > 0) ||
        (source.analyzers &&
          reportFrames.pitch.size === source.analyzers.pitch.frames.length &&
          reportFrames.spectralShape.size ===
            source.analyzers.spectralShape.frames.length),
      "agent did not consume all analyzer report pages",
    );
  }
  const reads = pairs.filter((pair) => pair.action === "get-feature");
  let priorReads: typeof reads = [];
  if (phase === "second") {
    const prior = turns[0]!;
    verifyFeatureSearch(
      { ...input, turns: [prior], turn: prior },
      "first",
      coverage,
    );
    priorReads = toolPairs(prior).filter((pair) => {
      if (pair.action !== "get-feature") return false;
      const feature = view(pair.data.feature);
      return (
        feature.record.entryId === sources[0]!.contextId &&
        (feature.metadata.type === "peak-summary/v1" ||
          (coverage === "full" &&
            analyzerFeatureTypes.some(
              (type) => type === feature.metadata.type,
            )))
      );
    });
  }
  if (coverage === "full")
    verifyAnalyzerFeatures(
      [...priorReads, ...pairs],
      sources,
      selected.appSessionId,
    );
  for (const read of reads) {
    const feature = view(read.data.feature);
    const original = priorReads.find(
      (prior) => view(prior.data.feature).record.id === feature.record.id,
    );
    if (
      original ||
      (feature.record.entryId === sources[0]!.contextId &&
        priorReads.some(
          (prior) =>
            view(prior.data.feature).metadata.type === feature.metadata.type,
        ))
    )
      check(
        original && sameFeatureRead(original, read),
        "immutable feature changed",
      );
  }
  const bySource = establishPeaks(
    [...priorReads, ...reads],
    pairs,
    sources,
    selected.appSessionId,
    phase === "second",
  );
  const peakIds = new Set([...bySource.values()].map((peak) => peak.id));
  if (phase !== "restored")
    check(
      pairs.some(
        (pair) =>
          pair.action === "list-features" &&
          array(pair.data.features).some((item) =>
            peakIds.has(String(view(item).record.id)),
          ),
      ),
      "missing typed feature inventory consumption",
    );
  if (phase === "first") return;
  const first = bySource.get(sources[0]!.contextId)!;
  const second = bySource.get(sources[1]!.contextId)!;
  const distance = Math.hypot(
    first.values[0]! - second.values[0]!,
    first.values[1]! - second.values[1]!,
  );
  check(
    pairs.some(
      (pair) =>
        pair.action === "compare-features" &&
        array(pair.call.arguments.pairs)
          .map(object)
          .some(
            (requested) =>
              requested.leftFeatureId === first.id &&
              requested.rightFeatureId === second.id,
          ),
    ),
    "comparison was not requested for the original feature IDs",
  );
  const compare = pairs
    .filter((pair) => pair.action === "compare-features")
    .flatMap((pair) => array(pair.data.comparisons).map(object))
    .find(
      (comparison) =>
        comparison.leftFeatureId === first.id &&
        comparison.rightFeatureId === second.id,
    );
  check(compare, "missing independently sourced comparison");
  for (const [side, peak] of [
    ["left", first],
    ["right", second],
  ] as const) {
    const feature = view(peak.feature);
    const evidence = object(compare[`${side}Evidence`]);
    check(
      evidence.contextId === feature.record.entryId &&
        evidence.segmentId === feature.segment.id &&
        evidence.startBeat === feature.segment.startBeat &&
        evidence.endBeat === feature.segment.endBeat &&
        evidence.coveredSamples === feature.metadata.coveredSamples &&
        evidence.expectedSamples === feature.metadata.expectedSamples,
      "comparison provenance/coverage mismatch",
    );
  }
  const comparison = listeningFeatureComparisonSchema.parse(compare.result);
  check(
    comparison.status === "comparable" &&
      comparison.distanceDefinition === "euclidean-linear-amplitude/v1" &&
      comparison.units === "linear-amplitude" &&
      "distance" in comparison &&
      (second.evidence.kind !== "equality" || comparison.distance === 0) &&
      Math.abs(Number(comparison.distance) - distance) <= 1e-12,
    "bad Euclidean comparison",
  );
  if (phase === "second") {
    const search = pairs.find(
      (pair) =>
        pair.action === "search-features" &&
        pair.call.arguments.featureId === first.id,
    );
    check(
      search &&
        array(search.call.arguments.excludeContextIds).includes(
          sources[0]!.contextId,
        ),
      "search must exclude entire first source",
    );
    check(
      view(search.data.query).record.id === first.id &&
        search.data.distanceDefinition === "euclidean-linear-amplitude/v1" &&
        search.data.distanceUnits === "linear-amplitude",
      "search query definition mismatch",
    );
    const matches = array(search.data.matches).map(object);
    const secondMatch = matches.find(
      (match) => view(match.feature).record.id === second.id,
    );
    check(
      isDeepStrictEqual(
        immutableFeature(search.data.query),
        immutableFeature(first.feature),
      ) &&
        secondMatch &&
        isDeepStrictEqual(
          immutableFeature(secondMatch.feature),
          immutableFeature(second.feature),
        ),
      "search differs from immutable typed feature reads",
    );
    check(
      matches.length <= 20 &&
        typeof search.data.exhaustive === "boolean" &&
        [
          "scannedCount",
          "comparableCount",
          "eligibleCount",
          "excludedCount",
        ].every(
          (key) =>
            Number.isSafeInteger(search.data[key]) &&
            Number(search.data[key]) >= 0,
        ) &&
        Number(search.data.scannedCount) <= 1000 &&
        Number(search.data.comparableCount) >= matches.length &&
        array(search.data.limitsHit).every((limit) =>
          ["candidates", "bytes", "time"].includes(String(limit)),
        ),
      "invalid bounded search coverage",
    );
    object(search.data.exclusionReasons);
    check(
      matches.length > 0 &&
        matches.every((match) => {
          const feature = view(match.feature);
          return (
            feature.record.entryId === sources[1]!.contextId &&
            feature.record.id !== first.id &&
            feature.record.sessionId === selected.appSessionId &&
            feature.record.liveSetId ===
              view(search.data.query).record.liveSetId &&
            feature.metadata.type === "peak-summary/v1"
          );
        }) &&
        matches.some(
          (match) =>
            view(match.feature).record.id === second.id &&
            typeof match.distance === "number" &&
            Number.isFinite(match.distance) &&
            Math.abs(match.distance - distance) <= 1e-12,
        ),
      "self/foreign match or bad search arithmetic",
    );
    if (coverage === "peak-only") return;
    if (!consumedCatalog) {
      const inventory = pairs
        .filter((pair) => pair.action === "list-features")
        .flatMap((pair) => {
          const features = array(pair.data.features);
          check(features.length <= 100, "unbounded discovery inventory");
          return features.map((item) => {
            const { feature, source } = boundFeature(
              item,
              sources,
              selected.appSessionId,
            );
            check(
              feature.record.liveSetId ===
                view(first.feature).record.liveSetId &&
                (pair.call.arguments.contextId === undefined ||
                  pair.call.arguments.contextId === source.contextId),
              "foreign inventory request",
            );
            return feature;
          });
        });
      check(
        LISTENING_FEATURE_DEFINITIONS.length === 15 &&
          LISTENING_FEATURE_DEFINITIONS.every((definition) =>
            inventory.some(
              (feature) => feature.metadata.type === definition.type,
            ),
          ),
        "missing consumed feature catalog or complete canonical inventory",
      );
    }
    check(
      pairs.some(
        (pair) =>
          pair.action === "list-features" &&
          array(pair.data.features).some(
            (item) => view(item).metadata.type !== "peak-summary/v1",
          ),
      ),
      "other stored families were not inspected",
    );
    const knownFeatures = [...toolPairs(turns[0]!), ...pairs].flatMap((pair) =>
      pair.action === "list-features"
        ? array(pair.data.features)
        : pair.action === "get-feature"
          ? [pair.data.feature]
          : [],
    );
    for (const source of sources) {
      check(source.analyzers, "missing authoritative analyzer evidence");
      const pitchEvidence = knownFeatures
        .map(view)
        .filter(
          (feature) =>
            feature.record.entryId === source.contextId &&
            feature.metadata.type === "pitch-grid/v1",
        );
      check(
        pitchEvidence.length > 0,
        "missing or falsely valid pitch-grid inventory",
      );
      for (const pitch of pitchEvidence) {
        check(
          pitch.record.sessionId === selected.appSessionId &&
            pitch.source.passId === source.passId &&
            pitch.record.sourceFingerprint ===
              (source.stream?.sourceFingerprint ?? source.contentSha256) &&
            ((pitch.metadata.status === "unavailable" &&
              typeof pitch.metadata.reason === "string" &&
              pitch.metadata.reason.length > 0) ||
              (pitch.metadata.status === "ready" &&
                source.analyzers.pitch.frames.some((frame) =>
                  frame.channels.some(
                    (channel) => channel.state === "accepted-estimate",
                  ),
                ))),
          "missing or falsely valid pitch-grid inventory",
        );
      }
    }
  }
  if (phase === "restored") {
    const original = turns[1]!;
    verifyFeatureSearch(
      { ...input, turns: turns.slice(0, 2), turn: original },
      "second",
      coverage,
    );
    const originalPairs = toolPairs(original);
    const originalPeaks = establishPeaks(
      turns
        .slice(0, 2)
        .flatMap(toolPairs)
        .filter((pair) => pair.action === "get-feature"),
      originalPairs,
      original.featureSources!,
      selected.appSessionId,
      true,
    );
    for (const peak of originalPeaks.values()) {
      const after = [...bySource.values()].find(
        (value) => value.id === peak.id,
      );
      check(
        after &&
          after.evidence.kind === "direct" &&
          isDeepStrictEqual(
            immutableFeature(peak.feature),
            immutableFeature(after.feature),
          ) &&
          isDeepStrictEqual(peak.values, after.values),
        "established peak changed after restart",
      );
    }
    const originalReads = turns
      .slice(0, 2)
      .flatMap(toolPairs)
      .filter(
        (pair) =>
          pair.action === "get-feature" &&
          ["peak-summary/v1", ...analyzerFeatureTypes].includes(
            String(view(pair.data.feature).metadata.type),
          ),
      );
    const originalIds = originalReads.map((pair) =>
      String(view(pair.data.feature).record.id),
    );
    check(
      originalIds.every((id) =>
        reads.some((pair) => view(pair.data.feature).record.id === id),
      ),
      "feature IDs changed after restart",
    );
    for (const before of originalReads) {
      const originalFeature = view(before.data.feature);
      const after = reads.find(
        (pair) =>
          view(pair.data.feature).record.id === originalFeature.record.id,
      );
      check(
        after && sameFeatureRead(before, after),
        "feature provenance changed after restart",
      );
    }
    for (const source of sources)
      check(
        original.featureSources?.some(
          (before) =>
            before.contextId === source.contextId &&
            before.contentSha256 === source.contentSha256 &&
            JSON.stringify(before.records) === JSON.stringify(source.records) &&
            JSON.stringify(before.analyzers) ===
              JSON.stringify(source.analyzers),
        ),
        "source changed after restart",
      );
  }
}
