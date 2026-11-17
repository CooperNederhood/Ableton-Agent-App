import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  agentHistoryPageSchema,
  journaledAgentHistoryRecordSchema,
  sanitizeTelemetryAttributes,
  type AgentHistoryPage,
  type AgentHistoryQuery,
} from "@ableton-agent/observability";
import {
  metricAudioObservationSchema,
  metricListeningReportSchema,
  projectMetricListeningReport,
  metricRecordStreamContextReferenceSchema,
  MEL_BAND_PROFILE,
  listeningFeatureDefinition,
  isListeningFeatureValueValid,
} from "@ableton-agent/protocol";
import {
  analysisOperationResultSchema,
  analysisPageSchema,
  metricStreamOverviewSchema,
  metricStreamRecordPageSchema,
  type AnalysisPage,
} from "@ableton-agent/tools";
import { streamProofContentSha256 } from "./arrangement-stream.js";
import type {
  AssertionInput,
  SessionIdentity,
  TurnEvidence,
} from "./contracts.js";

export interface AgentListeningEvidence extends SessionIdentity {
  readonly sdkTurnId: string;
  readonly afterOwnedRestart: boolean;
  /** Complete typed record set; full-feature receipts may project validated report bodies. */
  readonly records: AgentHistoryPage["items"];
}

const MAX_RECORDS = 1024;
const MAX_BYTES = 24 * 1024 * 1024;
function requireEvidence(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Agent listening evidence: ${detail}`);
}
function object(value: unknown): Record<string, unknown> {
  requireEvidence(
    value && typeof value === "object" && !Array.isArray(value),
    "missing structured result",
  );
  return value as Record<string, unknown>;
}
function complete(value: unknown, typedPagination = false): void {
  if (typeof value === "string")
    requireEvidence(
      value.length <= 16_384 &&
        !/\[truncated\]|\[(?:Binary|Audio) data omitted\]|\[Circular\]/iu.test(
          value,
        ),
      "truncated result",
    );
  else if (Array.isArray(value))
    value.forEach((item) => complete(item, typedPagination));
  else if (value && typeof value === "object") {
    const record = object(value);
    if (!typedPagination) {
      if (
        (record.action === "read" && "analyses" in record) ||
        (record.action === "compare" && "comparisons" in record) ||
        (record.action === "search" && "matches" in record)
      ) {
        requireEvidence(
          analysisOperationResultSchema.safeParse(record).success,
          "invalid typed analysis result",
        );
        typedPagination = true;
      } else if ("readTarget" in record && "timeline" in record) {
        requireEvidence(
          analysisPageSchema.safeParse(record).success,
          "invalid typed analysis page",
        );
        typedPagination = true;
      }
    }
    requireEvidence(
      record.truncated !== true ||
        (typedPagination &&
          typeof record.nextCursor === "string" &&
          record.nextCursor.length > 0),
      "truncated result",
    );
    Object.values(record).forEach((item) => complete(item, typedPagination));
  }
}

export function validateAgentListeningEvidence(
  value: unknown,
): asserts value is AgentListeningEvidence {
  const evidence = object(value);
  requireEvidence(
    Object.keys(evidence).every((key) =>
      [
        "appSessionId",
        "conversationId",
        "agentId",
        "sdkTurnId",
        "afterOwnedRestart",
        "records",
      ].includes(key),
    ),
    "unknown evidence field",
  );
  for (const key of ["appSessionId", "conversationId", "agentId", "sdkTurnId"])
    requireEvidence(
      typeof evidence[key] === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(evidence[key]),
      `invalid ${key}`,
    );
  requireEvidence(
    typeof evidence.afterOwnedRestart === "boolean",
    "missing restart provenance",
  );
  requireEvidence(
    Array.isArray(evidence.records) &&
      evidence.records.length > 0 &&
      evidence.records.length <= MAX_RECORDS,
    "missing or excessive records",
  );
  requireEvidence(
    Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES,
    "oversize history",
  );
  const items = evidence.records.map((record) =>
    journaledAgentHistoryRecordSchema.parse(record),
  );
  requireEvidence(
    new Set(items.map(({ id }) => id)).size === items.length,
    "duplicate history record",
  );
  for (const record of evidence.records)
    requireEvidence(
      isDeepStrictEqual(sanitizeTelemetryAttributes(object(record)), record),
      "unsanitized history",
    );
  complete(value);
  for (const record of items) {
    requireEvidence(
      record.appSessionId === evidence.appSessionId &&
        record.agentSessionId === evidence.conversationId &&
        record.activeAgentId === evidence.agentId &&
        "turnId" in record &&
        record.turnId === evidence.sdkTurnId &&
        record.traceId === evidence.sdkTurnId &&
        (record.kind === "tool_call" || record.kind === "tool_result"
          ? record.correlationId === record.toolCallId &&
            record.causationId === evidence.sdkTurnId
          : record.correlationId === evidence.sdkTurnId),
      "foreign or unattributable record",
    );
  }
}

/** Read the existing typed journal with bounded pagination; no partial success. */
export async function collectAgentListeningEvidence(
  owner: SessionIdentity & { sdkTurnId: string },
  afterOwnedRestart: boolean,
  read: (query: AgentHistoryQuery) => Promise<AgentHistoryPage>,
): Promise<AgentListeningEvidence> {
  const records: AgentHistoryPage["items"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let totalItems: number | undefined;
  do {
    const page = agentHistoryPageSchema.parse(
      await read({
        appSessionId: owner.appSessionId,
        agentSessionId: owner.conversationId,
        activeAgentId: owner.agentId,
        turnId: owner.sdkTurnId,
        kinds: ["turn", "message", "tool_call", "tool_result"],
        order: "asc",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    requireEvidence(
      page.page.returnedItems === page.items.length &&
        page.page.hasMore === (page.nextCursor !== undefined) &&
        page.page.order === "asc" &&
        (totalItems === undefined || totalItems === page.page.totalItems),
      "incomplete or changing history page",
    );
    totalItems = page.page.totalItems;
    records.push(...page.items);
    requireEvidence(
      records.length <= MAX_RECORDS &&
        Buffer.byteLength(JSON.stringify(records)) <= MAX_BYTES,
      "history bound exceeded",
    );
    cursor = page.nextCursor;
    requireEvidence(
      !cursor || !cursors.has(cursor),
      "pagination did not advance",
    );
    if (cursor) cursors.add(cursor);
  } while (cursor);
  requireEvidence(records.length === totalItems, "incomplete history query");
  // The journal already sanitizes; sanitize again before retaining driver artifacts.
  const evidence = {
    appSessionId: owner.appSessionId,
    conversationId: owner.conversationId,
    agentId: owner.agentId,
    sdkTurnId: owner.sdkTurnId,
    afterOwnedRestart,
    records: records.map((record) => {
      if (
        record.kind === "tool_result" &&
        ["ableton_listening", "ableton_context"].includes(
          String(record.metadata.toolName),
        ) &&
        record.outcome === "success"
      ) {
        const envelope = object(record.result?.result);
        // SDK JSON text must become structured evidence before the receipt's
        // per-string bound; otherwise a valid measurement is silently clipped.
        const content: unknown =
          typeof envelope.content === "string"
            ? JSON.parse(envelope.content)
            : envelope.content;
        complete(content);
        return sanitizeTelemetryAttributes({
          ...record,
          result: {
            ...record.result,
            result: { ...envelope, content: object(content) },
          },
        });
      }
      return sanitizeTelemetryAttributes(record);
    }),
  };
  validateAgentListeningEvidence(evidence);
  return evidence;
}

function payload(
  record: Extract<AgentHistoryPage["items"][number], { kind: "tool_result" }>,
): Record<string, unknown> {
  requireEvidence(
    record.outcome === "success" && record.error === undefined,
    "failed tool result",
  );
  const envelope = object(record.result?.result);
  const content: unknown =
    typeof envelope.content === "string"
      ? JSON.parse(envelope.content)
      : envelope.content;
  const result = object(content);
  complete(result);
  requireEvidence(
    result.resultType !== "failure" &&
      result.isError !== true &&
      result.error === undefined,
    "structured tool failure",
  );
  return result;
}

function verifyAnalysisValues(
  analyses: readonly AnalysisPage[],
  turn: TurnEvidence,
  contextId: string,
): void {
  const capture = turn.captures[0]!;
  const initial = analyses[0]!;
  requireEvidence(
    initial.readTarget.range.startBeat === 0 &&
      initial.readTarget.coordinate === "clip-local-beats",
    "analysis did not describe the original Session extent",
  );
  let measuredValues = 0;
  for (const analysis of analyses) {
    const target = analysis.readTarget;
    const geometry = analysis.source.geometry;
    requireEvidence(
      target.contextId === contextId &&
        target.sessionId === turn.appSessionId &&
        target.liveSetId === initial.readTarget.liveSetId &&
        target.coordinate === initial.readTarget.coordinate &&
        analysis.status === "ready" &&
        geometry?.sampleRate === capture.sampleRate &&
        geometry.captureStartSample === capture.startSample &&
        isDeepStrictEqual(target, analysis.source.readTarget) &&
        analysis.overviewExtent.startBeat === target.range.startBeat &&
        analysis.overviewExtent.endBeat === target.range.endBeat &&
        Math.abs(
          ((analysis.source.observedRange.endBeat -
            analysis.source.observedRange.startBeat) *
            60) /
            geometry.tempoBpm -
            (capture.endSample - capture.startSample) / capture.sampleRate,
        ) <
          1 / capture.sampleRate,
      "analysis ownership, geometry or source extent differs from capture",
    );
    for (const row of analysis.timeline) {
      requireEvidence(
        row.startBeat >= target.range.startBeat &&
          row.endBeat <= target.range.endBeat &&
          row.endBeat > row.startBeat &&
          row.elapsedEndSeconds > row.elapsedStartSeconds,
        "analysis row falls outside its declared extent",
      );
      for (const feature of row.features) {
        const definition = listeningFeatureDefinition(feature.type);
        requireEvidence(
          feature.units === definition.units &&
            feature.normalization === definition.normalization &&
            feature.coveredSamples <= feature.expectedSamples &&
            (feature.values === null
              ? feature.status === "unavailable" && feature.reason !== null
              : feature.status === "ready" &&
                feature.values.length === feature.dimensions.length &&
                (feature.dimensionOffset ?? 0) + feature.values.length <=
                  definition.dimensions &&
                feature.values.every((value) =>
                  isListeningFeatureValueValid(
                    feature.type,
                    value,
                    capture.sampleRate,
                  ),
                )),
          "invalid canonical feature values or coverage",
        );
        measuredValues +=
          feature.values?.filter((value) => value !== null).length ?? 0;
      }
    }
  }
  requireEvidence(
    measuredValues > 0,
    "analysis contains metadata but no measured values",
  );

  const mel = turn.melSmoke?.[0];
  if (!mel) return;
  const frames =
    "chunks" in mel
      ? mel.chunks.flatMap((chunk) =>
          chunk.metric === "mel-bands" ? [...chunk.records] : [],
        )
      : [...(mel.observation.metrics["mel-bands"]?.frames ?? [])];
  requireEvidence(frames.length > 0, "missing independent mel measurements");
  const found = new Set<string>();
  for (const analysis of analyses) {
    const geometry = analysis.source.geometry!;
    const sampleAt = (beat: number) =>
      geometry.captureStartSample +
      Math.round(
        ((beat - analysis.source.observedRange.startBeat) *
          capture.sampleRate *
          60) /
          geometry.tempoBpm,
      );
    for (const row of analysis.timeline) {
      if (row.kind !== "segment-summary") continue;
      const start = sampleAt(row.startBeat);
      const end = sampleAt(row.endBeat);
      let weight = 0;
      const means = Array.from({ length: 48 }, () => 0);
      for (const frame of frames) {
        const overlap = Math.max(
          0,
          Math.min(end, frame.support.endSample) -
            Math.max(start, frame.support.startSample),
        );
        if (overlap === 0) continue;
        weight += overlap;
        frame.magnitudes.flat().forEach((value, index) => {
          means[index] = means[index]! + value * overlap;
        });
      }
      if (weight === 0) continue;
      for (let index = 0; index < means.length; index++)
        means[index] = means[index]! / weight;
      const norm = Math.hypot(...means);
      const regions = [0, 1].map((channel) => {
        const sums = { low: 0, mid: 0, high: 0 };
        MEL_BAND_PROFILE.bands.forEach((band, index) => {
          sums[band.region] += means[channel * 24 + index]!;
        });
        return sums;
      });
      for (const feature of row.features) {
        const expected =
          feature.type === "mel-shape/v1"
            ? means.map((value) => value / norm)
            : feature.type === "mel-region-summary/v1"
              ? regions.flatMap((value) => [value.low, value.mid, value.high])
              : feature.type === "mel-ratio-summary/v1"
                ? regions.flatMap((value) => [
                    value.low / value.mid,
                    value.high / value.mid,
                  ])
                : undefined;
        if (!expected) continue;
        requireEvidence(
          feature.values !== null &&
            feature.values.every((value, index) => {
              const original = expected[(feature.dimensionOffset ?? 0) + index];
              return (
                value !== null &&
                original !== undefined &&
                Number.isFinite(original) &&
                Math.abs(value - original) <=
                  1e-10 * Math.max(1, Math.abs(original))
              );
            }),
          "analysis mel values differ from independent original measurements",
        );
        feature.values.forEach((_, index) =>
          found.add(
            `${feature.type}:${(feature.dimensionOffset ?? 0) + index}`,
          ),
        );
      }
    }
  }
  for (const [type, dimensions] of [
    ["mel-shape/v1", 48],
    ["mel-region-summary/v1", 6],
    ["mel-ratio-summary/v1", 4],
  ] as const)
    requireEvidence(
      Array.from({ length: dimensions }, (_, index) =>
        found.has(`${type}:${index}`),
      ).every(Boolean),
      "agent did not consume all mel summary dimensions and ratios",
    );
}

export function verifyAgentListeningResult(
  input: AssertionInput,
  sourceId: string,
): void {
  const turn =
    input.turn ?? (input.turns.length === 1 ? input.turns[0] : undefined);
  requireEvidence(turn?.status === "completed", "missing completed turn");
  const evidence = turn.agentListening;
  validateAgentListeningEvidence(evidence);
  requireEvidence(
    !evidence.afterOwnedRestart &&
      evidence.appSessionId === turn.appSessionId &&
      evidence.conversationId === turn.conversationId &&
      evidence.agentId === turn.agentId &&
      evidence.sdkTurnId === turn.facts.sdkTurnId,
    "submission ownership mismatch",
  );
  const capture = turn.captures[0];
  const source = input.baseline.sources?.[sourceId];
  requireEvidence(
    turn.captures.length === 1 &&
      capture &&
      source &&
      capture.complete &&
      !capture.failure &&
      capture.operationId === turn.operationId &&
      capture.listenerId === source.listenerId &&
      isDeepStrictEqual(capture.source, source.source),
    "independent capture mismatch",
  );
  const contexts = turn.contexts.filter(
    (entry) => entry.passId === capture.passId,
  );
  const context = contexts[0];
  requireEvidence(
    contexts.length === 1 && context?.readable,
    "missing independently published context",
  );
  const records = evidence.records;
  const final = records
    .filter((entry) => entry.kind === "message" && entry.role === "assistant")
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const terminal = records.filter((entry) => entry.kind === "turn");
  requireEvidence(
    final[0]?.kind === "message" &&
      (final.length === 1 || final[0].occurredAt !== final[1]?.occurredAt) &&
      final[0].content === turn.assistantText &&
      terminal.length === 1 &&
      terminal[0]?.kind === "turn" &&
      terminal[0].status === "completed" &&
      terminal[0].completedAt &&
      Date.parse(terminal[0].completedAt) >= Date.parse(final[0].occurredAt),
    "missing attributable final answer/terminal turn",
  );
  const calls = records.filter((entry) => entry.kind === "tool_call");
  const results = records.filter((entry) => entry.kind === "tool_result");
  requireEvidence(
    calls.length === results.length &&
      new Set(calls.map((entry) => entry.toolCallId)).size === calls.length &&
      new Set(results.map((entry) => entry.toolCallId)).size ===
        results.length &&
      results.every((entry) =>
        calls.some((call) => call.toolCallId === entry.toolCallId),
      ),
    "incomplete tool history",
  );
  const relevant = calls.filter((entry) =>
    ["ableton_listening", "ableton_context"].includes(entry.toolName),
  );
  const pairs = relevant.map((call) => {
    const result = results.find(
      (entry) => entry.toolCallId === call.toolCallId,
    );
    requireEvidence(
      call.status === "completed" &&
        result &&
        result.metadata.toolName === call.toolName &&
        typeof result.durationMs === "number" &&
        Date.parse(call.occurredAt) <= Date.parse(result.occurredAt) &&
        Date.parse(result.occurredAt) < Date.parse(final[0]!.occurredAt),
      "failed, missing or late listening/context call",
    );
    return { call, result, data: payload(result) };
  });
  const starts = pairs.filter(
    ({ call }) =>
      call.toolName === "ableton_listening" &&
      ["play-session-and-listen", "play-arrangement-and-listen"].includes(
        String(call.arguments.action),
      ),
  );
  requireEvidence(starts.length === 1, "requires exactly one original start");
  const start = starts[0]!;
  requireEvidence(
    Date.parse(start.result.occurredAt) - start.result.durationMs! >=
      Date.parse(terminal[0].occurredAt),
    "start predates submitted turn",
  );
  const job = object(start.data.job);
  const target = object(start.call.arguments.target);
  const track = object(target.track);
  requireEvidence(
    start.call.arguments.action === "play-session-and-listen" &&
      start.data.action === start.call.arguments.action &&
      target.view === "session" &&
      track.expectedReference === source.source.trackId &&
      target.expectedClipReference === source.source.clipId &&
      target.sceneIndex === source.source.slotIndex &&
      (start.call.arguments.listenerIds === undefined ||
        JSON.stringify(start.call.arguments.listenerIds) ===
          JSON.stringify([source.listenerId])) &&
      job.stage === "completed" &&
      (job.error === undefined || job.error === null) &&
      job.passId === capture.passId &&
      JSON.stringify(job.contextIds) === JSON.stringify([context.contextId]),
    "original start did not deliver the completed matching pass/context",
  );
  const analyses: AnalysisPage[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair.data.analyses)) continue;
    requireEvidence(
      pair === start ||
        (pair.call.toolName === "ableton_context" &&
          pair.call.arguments.action === "read" &&
          pair.data.action === "read" &&
          Date.parse(pair.result.occurredAt) - pair.result.durationMs! >=
            Date.parse(start.result.occurredAt)),
      "analysis was not delivered by the listen or a subsequent typed read",
    );
    analyses.push(
      ...pair.data.analyses.map((page) => analysisPageSchema.parse(page)),
    );
  }
  if (analyses.length > 0) {
    verifyAnalysisValues(analyses, turn, context.contextId);
    return;
  }
  const reads = pairs.filter(
    ({ call }) =>
      call.toolName === "ableton_context" &&
      ["get", "report", "stream-overview", "stream-records"].includes(
        String(call.arguments.action),
      ),
  );
  requireEvidence(reads.length > 0, "missing agent context consumption");
  const melSmoke = turn.melSmoke?.[0];
  if (melSmoke && "chunks" in melSmoke)
    requireEvidence(
      capture.stream,
      "stream mel evidence lacks its original capture proof",
    );
  if (capture.stream) {
    requireEvidence(
      capture.stream.contextId === context.contextId &&
        capture.stream.passId === capture.passId &&
        context.contentSha256 === streamProofContentSha256(capture.stream) &&
        reads.some(({ data }) => data.action === "stream-overview"),
      "missing matching original stream overview",
    );
    const melFrames =
      melSmoke && "chunks" in melSmoke
        ? melSmoke.chunks.flatMap((chunk) =>
            chunk.metric === "mel-bands" ? chunk.records : [],
          )
        : undefined;
    const consumed = new Set<number>();
    let valueRecords = 0;
    for (const read of reads) {
      const entry = object(read.data.entry);
      requireEvidence(
        read.call.arguments.contextId === context.contextId &&
          read.data.action === read.call.arguments.action &&
          entry.contextId === context.contextId &&
          entry.passId === capture.passId &&
          entry.listenerId === capture.listenerId &&
          entry.kind === "metric-record-stream-context/v1" &&
          Date.parse(read.result.occurredAt) - read.result.durationMs! >=
            Date.parse(start.result.occurredAt),
        "foreign context or stream read before delivery",
      );
      if (read.data.action === "get") {
        const reference = metricRecordStreamContextReferenceSchema.parse(
          read.data.observation,
        );
        requireEvidence(
          reference.captureId === context.contextId &&
            reference.descriptorDigest === capture.stream.descriptorDigest,
          "foreign immutable stream reference",
        );
      } else if (read.data.action === "stream-overview") {
        const overview = metricStreamOverviewSchema.parse(read.data.overview);
        requireEvidence(
          overview.descriptorDigest === capture.stream.descriptorDigest &&
            overview.source.view === "session" &&
            overview.source.target.track.expectedReference ===
              source.source.trackId &&
            overview.source.clipReference === source.source.clipId &&
            overview.source.target.sceneIndex === source.source.slotIndex &&
            overview.outcome === "complete" &&
            overview.geometry.sampleRate === capture.sampleRate &&
            overview.geometry.startSample === capture.startSample &&
            overview.geometry.endSample === capture.endSample &&
            capture.metricFamilies.every((family) =>
              overview.metrics.some(
                (metric) =>
                  metric.metric === family &&
                  metric.availability === "available" &&
                  metric.missingRecords === 0,
              ),
            ),
          "original stream overview differs from captured source",
        );
      } else {
        requireEvidence(
          read.data.action === "stream-records",
          "historical report cannot consume a new stream",
        );
        if (read.data.page === null) continue;
        const page = metricStreamRecordPageSchema.parse(read.data.page);
        requireEvidence(
          page.descriptorDigest === capture.stream.descriptorDigest &&
            page.metric === read.call.arguments.metric &&
            page.gaps.length === 0,
          "foreign or incomplete original stream page",
        );
        valueRecords += page.records.length;
        if (page.metric === "mel-bands" && melFrames)
          for (const frame of page.records) {
            requireEvidence(
              isDeepStrictEqual(
                frame,
                melFrames.find((original) => original.index === frame.index),
              ),
              "agent stream read did not consume matching mel vectors",
            );
            consumed.add(frame.index);
          }
      }
    }
    requireEvidence(
      valueRecords > 0 && (!melFrames || consumed.size === melFrames.length),
      "agent did not consume original stream measurements",
    );
    return;
  }
  for (const read of reads) {
    const entry = object(read.data.entry);
    requireEvidence(
      read.call.arguments.contextId === context.contextId &&
        read.data.action === read.call.arguments.action &&
        entry.contextId === context.contextId &&
        entry.passId === capture.passId &&
        entry.listenerId === capture.listenerId &&
        entry.kind === "metric-audio-observation/v1" &&
        Date.parse(read.result.occurredAt) - read.result.durationMs! >=
          Date.parse(start.result.occurredAt),
      "foreign context or context read before delivery",
    );
    const measurement =
      read.data.action === "get"
        ? metricAudioObservationSchema.parse(read.data.observation)
        : metricListeningReportSchema.parse(read.data.report);
    const measuredSource = measurement.source;
    requireEvidence(
      measuredSource.view === "session" &&
        measuredSource.target.track.expectedReference ===
          source.source.trackId &&
        measuredSource.clipReference === source.source.clipId &&
        measuredSource.target.sceneIndex === source.source.slotIndex,
      "measurement source mismatch",
    );
    if ("ownership" in measurement) {
      if (melSmoke && "reportProjection" in melSmoke)
        requireEvidence(
          isDeepStrictEqual(measurement, melSmoke.observation),
          "agent context did not consume matching mel vectors",
        );
      requireEvidence(
        measurement.ownership.passId === capture.passId &&
          measurement.ownership.listenerId === capture.listenerId &&
          measurement.ownership.traceId === evidence.sdkTurnId &&
          measurement.ownership.correlationId === evidence.sdkTurnId &&
          createHash("sha256")
            .update(JSON.stringify(measurement))
            .digest("hex") === context.contentSha256,
        "measurement content mismatch",
      );
    } else {
      requireEvidence(
        measurement.rows.length > 0 &&
          measurement.observationOutcome === "complete" &&
          measurement.offset === (read.call.arguments.offset ?? 0) &&
          measurement.sampleRate === capture.sampleRate &&
          measurement.sourceCoverage.startSample === capture.startSample &&
          measurement.sourceCoverage.endSample === capture.endSample &&
          capture.metricFamilies.every((metric) =>
            measurement.requestedMetrics.some(
              (requested) =>
                requested === metric &&
                measurement.metricStatus[requested] === "complete",
            ),
          ),
        "missing measurement report content",
      );
      if (melSmoke && "reportProjection" in melSmoke)
        requireEvidence(
          isDeepStrictEqual(
            measurement,
            projectMetricListeningReport(melSmoke.observation, {
              offset: measurement.offset,
              limit: measurement.pageBudget.requestedRowLimit,
            }),
          ) &&
            measurement.metricStatus["mel-bands"] === "complete" &&
            measurement.rows.some((row) => row["mel-bands"]?.recordCount),
          "agent report did not consume matching mel vectors and ratios",
        );
    }
  }
}

export function verifyRestoredAgentListeningEvidence(
  turns: readonly Pick<TurnEvidence, "agentListening">[],
  restored: readonly AgentListeningEvidence[],
): void {
  const originals = turns.flatMap((turn) =>
    turn.agentListening ? [turn.agentListening] : [],
  );
  requireEvidence(
    restored.length === originals.length,
    "missing restored history",
  );
  for (const original of originals) {
    const matches = restored.filter(
      (entry) => entry.sdkTurnId === original.sdkTurnId,
    );
    requireEvidence(matches.length === 1, "ambiguous restored history");
    validateAgentListeningEvidence(matches[0]);
    requireEvidence(
      matches[0].afterOwnedRestart &&
        isDeepStrictEqual({ ...original, afterOwnedRestart: true }, matches[0]),
      "persisted history changed after restart",
    );
  }
}
