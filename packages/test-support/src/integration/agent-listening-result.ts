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
} from "@ableton-agent/protocol";
import type {
  AssertionInput,
  SessionIdentity,
  TurnEvidence,
} from "./contracts.js";

export interface AgentListeningEvidence extends SessionIdentity {
  readonly sdkTurnId: string;
  readonly afterOwnedRestart: boolean;
  /** Complete typed query, not generic event attributes or runner context reads. */
  readonly records: AgentHistoryPage["items"];
}

const MAX_RECORDS = 256;
const MAX_BYTES = 8 * 1024 * 1024;
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
function complete(value: unknown): void {
  if (typeof value === "string")
    requireEvidence(
      value.length <= 16_384 &&
        !/\[truncated\]|\[(?:Binary|Audio) data omitted\]|\[Circular\]/iu.test(
          value,
        ),
      "truncated result",
    );
  else if (Array.isArray(value)) value.forEach(complete);
  else if (value && typeof value === "object") {
    const record = object(value);
    requireEvidence(record.truncated !== true, "truncated result");
    Object.values(record).forEach(complete);
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
      JSON.stringify(start.call.arguments.listenerIds) ===
        JSON.stringify([source.listenerId]) &&
      job.stage === "completed" &&
      (job.error === undefined || job.error === null) &&
      job.passId === capture.passId &&
      JSON.stringify(job.contextIds) === JSON.stringify([context.contextId]),
    "original start did not deliver the completed matching pass/context",
  );
  const reads = pairs.filter(
    ({ call }) =>
      call.toolName === "ableton_context" &&
      ["get", "report"].includes(String(call.arguments.action)),
  );
  requireEvidence(reads.length > 0, "missing agent context consumption");
  const melSmoke = turn.melSmoke?.[0];
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
      if (melSmoke)
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
      if (melSmoke)
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
