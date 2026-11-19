import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  LISTENING_FEATURE_DEFINITIONS,
  metricAudioObservationSchema,
  type MetricAudioObservation,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamManifest,
} from "@ableton-agent/protocol";
import {
  streamProofContentSha256,
  type ArrangementStreamProof,
} from "./arrangement-stream.js";
import type { TelemetryEventPage } from "@ableton-agent/observability";
import {
  contextOperationResultSchema,
  type expandListeningFeatureInventory,
} from "@ableton-agent/tools";
import type { AssertionInput } from "./contracts.js";
import {
  readFeatureToolPairs,
  readCompleteAnalyses,
  deliveredAnalysisRowGroups,
  immutableDeliveredAnalysis,
  type CompleteAnalysis,
} from "./feature-search.js";
import {
  requireListeningSummary,
  validateAgentListeningEvidence,
  type AgentListeningEvidence,
} from "./agent-listening-result.js";
import {
  identifier,
  rejectUnknownFields,
  requireCondition,
} from "./validation.js";

function object(value: unknown): asserts value is Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected storage metadata object",
  );
}
function list(value: unknown, maximum: number): asserts value is unknown[] {
  requireCondition(
    Array.isArray(value) && value.length <= maximum,
    "Invalid bounded storage inventory",
  );
}

/** Counts are local integrity checks, never cross-capture native frame comparisons. */
export interface StorageShapeEvidence {
  readonly geometry?: {
    readonly sampleRate: number;
    readonly tempoBpm: number;
    readonly startSample: number;
    readonly endSample: number;
  };
  readonly incrementalDurability?: {
    readonly captureStartedAt: string;
    readonly firstDurableAt: string;
    readonly durationMs: number;
    readonly durableChunks: number;
    readonly durableBytes: number;
  };
  readonly contentSha256?: string;
  readonly contextId: string;
  readonly passId: string;
  readonly schema: string;
  readonly metricSchemas: readonly string[];
  readonly startBeat: number;
  readonly endBeat: number;
  readonly afterOwnedRestart: boolean;
  readonly metrics: readonly {
    readonly metric: string;
    readonly expectedRecords: number;
    readonly retainedRecords: number;
    readonly missingRecords: number;
    readonly acquiredSupport?: readonly (readonly [number, number])[];
  }[];
}
function acquiredSupport(
  supports: readonly { startSample: number; endSample: number }[],
): [number, number][] {
  const intervals: [number, number][] = [];
  for (const support of [...supports].sort(
    (a, b) => a.startSample - b.startSample,
  )) {
    const previous = intervals.at(-1);
    if (previous && support.startSample <= previous[1])
      previous[1] = Math.max(previous[1], support.endSample);
    else intervals.push([support.startSample, support.endSample]);
  }
  return intervals;
}

export function projectIncrementalDurability(
  descriptor: MetricRecordStreamDescriptor,
  input: {
    readonly captureId: string;
    readonly startedAt: string | null;
    readonly sessionId: string;
    readonly agentId: string;
    readonly events: TelemetryEventPage["items"];
  },
): StorageShapeEvidence["incrementalDurability"] {
  const startedAt = Date.parse(input.startedAt ?? "");
  const durationMs =
    ((descriptor.geometry.endSample - descriptor.geometry.startSample) /
      descriptor.geometry.sampleRate) *
    1_000;
  // Pass admission precedes DSP start, so this deadline cannot admit a post-DSP bulk write.
  const event = input.events.find((event) => {
    const time = Date.parse(event.occurredAt);
    return (
      event.name === "context.metric-chunk.progress" &&
      event.trace?.traceId === descriptor.ownership.traceId &&
      event.correlationId === descriptor.ownership.correlationId &&
      event.sessionId === input.sessionId &&
      event.activeAgentId === input.agentId &&
      event.attributes.captureId === input.captureId &&
      Number.isSafeInteger(event.attributes.durableChunks) &&
      Number(event.attributes.durableChunks) > 0 &&
      Number.isSafeInteger(event.attributes.durableBytes) &&
      Number(event.attributes.durableBytes) > 0 &&
      time >= startedAt &&
      time < startedAt + durationMs
    );
  });
  if (!event || input.startedAt === null) return undefined;
  return {
    captureStartedAt: input.startedAt,
    firstDurableAt: event.occurredAt,
    durationMs,
    durableChunks: Number(event.attributes.durableChunks),
    durableBytes: Number(event.attributes.durableBytes),
  };
}

export function projectStreamStorageShape(
  descriptor: MetricRecordStreamDescriptor,
  manifest: MetricRecordStreamManifest,
  proof: ArrangementStreamProof,
  incrementalDurability?: StorageShapeEvidence["incrementalDurability"],
): StorageShapeEvidence {
  return {
    ...(incrementalDurability ? { incrementalDurability } : {}),
    contextId: proof.contextId,
    passId: proof.passId,
    schema: "metric-record-stream-context/v1",
    contentSha256: streamProofContentSha256(proof),
    geometry: {
      sampleRate: descriptor.geometry.sampleRate,
      tempoBpm: descriptor.geometry.tempoBpm,
      startSample: descriptor.geometry.startSample,
      endSample: descriptor.geometry.endSample,
    },
    metricSchemas: descriptor.requestedMetrics
      .map((metric) => `${descriptor.schema}:${metric}`)
      .sort(),
    startBeat:
      descriptor.source.view === "session" ? 0 : descriptor.geometry.startBeat,
    endBeat:
      descriptor.source.view === "session"
        ? descriptor.geometry.endBeat - descriptor.geometry.startBeat
        : descriptor.geometry.endBeat,
    afterOwnedRestart: proof.afterOwnedRestart,
    metrics: manifest.metrics.map((metric) => {
      const algorithm = descriptor.algorithms.find(
        (item) => item.metric === metric.metric,
      );
      const first =
        algorithm?.metric === "spectral-centroid"
          ? algorithm.algorithm?.firstFrameEndSample
          : undefined;
      const start =
        first == null
          ? descriptor.geometry.startSample
          : Math.max(descriptor.geometry.startSample, first - 2048);
      return {
        metric: metric.metric,
        expectedRecords: metric.expectedRecords,
        retainedRecords: metric.nextRecordOffset,
        missingRecords: metric.missingRecords,
        acquiredSupport:
          metric.nextRecordOffset > 0 && metric.lastRecordEndSample !== null
            ? [[start, metric.lastRecordEndSample] as const]
            : [],
      };
    }),
  };
}

export function projectObservationStorageShape(
  contextId: string,
  input: MetricAudioObservation,
  afterOwnedRestart: boolean,
): StorageShapeEvidence {
  const observation = metricAudioObservationSchema.parse(input);
  const startSample =
    observation.metrics.level.records[0]?.support.startSample ?? 0;
  const endSample =
    observation.metrics.level.records.at(-1)?.support.endSample ?? 0;
  return {
    contextId,
    passId: observation.ownership.passId,
    schema: observation.schema,
    geometry: {
      sampleRate: observation.geometry.sampleRate,
      tempoBpm: observation.geometry.tempoBpm,
      startSample,
      endSample,
    },
    contentSha256: createHash("sha256")
      .update(JSON.stringify(observation))
      .digest("hex"),
    metricSchemas: observation.requestedMetrics
      .map((name) => {
        const metric = observation.metrics[name]!;
        return "schema" in metric
          ? metric.schema
          : JSON.stringify({
              name,
              algorithm: metric.algorithm?.name,
              version: metric.algorithm?.version,
            });
      })
      .sort(),
    startBeat: observation.geometry.startBeat,
    endBeat: observation.geometry.endBeat,
    afterOwnedRestart,
    metrics: observation.requestedMetrics.map((name) => {
      const metric = observation.metrics[name]!;
      return {
        metric: name,
        expectedRecords: metric.expectedRecords,
        retainedRecords:
          "records" in metric ? metric.records.length : metric.frames.length,
        missingRecords: metric.gaps.reduce((sum, gap) => sum + gap.count, 0),
        acquiredSupport: acquiredSupport(
          ("records" in metric ? metric.records : metric.frames)
            .map((record) => ({
              startSample: Math.max(startSample, record.support.startSample),
              endSample: Math.min(endSample, record.support.endSample),
            }))
            .filter((support) => support.endSample > support.startSample),
        ),
      };
    }),
  };
}

export function validateStorageShapeEvidence(
  value: unknown,
): asserts value is StorageShapeEvidence {
  object(value);
  rejectUnknownFields(value, [
    "contextId",
    "passId",
    "schema",
    "metricSchemas",
    "startBeat",
    "endBeat",
    "afterOwnedRestart",
    "metrics",
    "contentSha256",
    "incrementalDurability",
    "geometry",
  ]);
  if (value.geometry !== undefined) {
    object(value.geometry);
    rejectUnknownFields(value.geometry, [
      "sampleRate",
      "tempoBpm",
      "startSample",
      "endSample",
    ]);
    requireCondition(
      Object.values(value.geometry).every(
        (number) => typeof number === "number" && Number.isFinite(number),
      ) &&
        Number(value.geometry.sampleRate) > 0 &&
        Number(value.geometry.tempoBpm) > 0 &&
        Number.isSafeInteger(value.geometry.startSample) &&
        Number(value.geometry.startSample) >= 0 &&
        Number.isSafeInteger(value.geometry.endSample) &&
        Number(value.geometry.endSample) > Number(value.geometry.startSample),
      "Invalid independent native storage geometry",
    );
  }
  if (value.incrementalDurability !== undefined) {
    object(value.incrementalDurability);
    const proof = value.incrementalDurability;
    rejectUnknownFields(proof, [
      "captureStartedAt",
      "firstDurableAt",
      "durationMs",
      "durableChunks",
      "durableBytes",
    ]);
    requireCondition(
      typeof proof.captureStartedAt === "string" &&
        typeof proof.firstDurableAt === "string" &&
        typeof proof.durationMs === "number" &&
        Number.isFinite(proof.durationMs) &&
        proof.durationMs > 0 &&
        proof.durationMs <= 600_000 &&
        Date.parse(proof.firstDurableAt) >=
          Date.parse(proof.captureStartedAt) &&
        Date.parse(proof.firstDurableAt) <
          Date.parse(proof.captureStartedAt) + proof.durationMs &&
        Number.isSafeInteger(proof.durableChunks) &&
        Number(proof.durableChunks) > 0 &&
        Number(proof.durableChunks) <= 4_096 &&
        Number.isSafeInteger(proof.durableBytes) &&
        Number(proof.durableBytes) > 0 &&
        Number(proof.durableBytes) <= 32 * 1_024 * 1_024,
      "Invalid durable append evidence during native capture",
    );
  }
  identifier(value.contextId);
  identifier(value.passId);
  if (value.contentSha256 !== undefined)
    requireCondition(
      typeof value.contentSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.contentSha256),
      "Invalid persisted observation fingerprint",
    );
  requireCondition(
    typeof value.schema === "string" &&
      [
        "metric-audio-observation/v1",
        "metric-record-stream-context/v1",
      ].includes(value.schema),
    "Invalid persisted schema",
  );
  list(value.metricSchemas, 6);
  requireCondition(
    value.metricSchemas.length === 6 &&
      new Set(value.metricSchemas).size === 6 &&
      value.metricSchemas.every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 512,
      ),
    "Invalid metric schema inventory",
  );
  requireCondition(
    typeof value.startBeat === "number" &&
      Number.isFinite(value.startBeat) &&
      value.startBeat >= 0 &&
      typeof value.endBeat === "number" &&
      Number.isFinite(value.endBeat) &&
      value.endBeat > value.startBeat &&
      typeof value.afterOwnedRestart === "boolean",
    "Invalid storage range/restart evidence",
  );
  list(value.metrics, 6);
  requireCondition(
    value.metrics.length === 6 &&
      new Set(
        value.metrics.map((v) => {
          object(v);
          return v.metric;
        }),
      ).size === 6,
    "Missing or duplicate metric families",
  );
  for (const metric of value.metrics) {
    object(metric);
    rejectUnknownFields(metric, [
      "metric",
      "expectedRecords",
      "retainedRecords",
      "missingRecords",
      "acquiredSupport",
    ]);
    if (metric.acquiredSupport !== undefined) {
      list(metric.acquiredSupport, 4096);
      let end = -1;
      for (const support of metric.acquiredSupport) {
        list(support, 2);
        requireCondition(
          support.length === 2 &&
            Number.isSafeInteger(support[0]) &&
            Number.isSafeInteger(support[1]) &&
            Number(support[0]) >= 0 &&
            Number(support[0]) >= end &&
            Number(support[1]) > Number(support[0]) &&
            (value.geometry === undefined ||
              (Number(support[0]) >= Number(value.geometry.startSample) &&
                Number(support[1]) <= Number(value.geometry.endSample))),
          "Invalid independent native acquisition support",
        );
        end = Number(support[1]);
      }
    }
    requireCondition(
      [
        "level",
        "spectral-centroid",
        "attacks",
        "mel-bands",
        "pitch",
        "spectral-shape",
      ].includes(String(metric.metric)),
      "Unknown metric family",
    );
    for (const count of [
      metric.expectedRecords,
      metric.retainedRecords,
      metric.missingRecords,
    ])
      requireCondition(
        Number.isSafeInteger(count) &&
          Number(count) >= 0 &&
          Number(count) <= 1_000_000,
        "Invalid measurement record count",
      );
    requireCondition(
      metric.expectedRecords ===
        Number(metric.retainedRecords) + Number(metric.missingRecords) &&
        metric.missingRecords === 0,
      "Missing or truncated persisted measurement records",
    );
  }
}

type FeatureView = ReturnType<typeof expandListeningFeatureInventory>[number];
const FEATURE_REFERENCE_FIELDS = [
  "id",
  "provenance",
  "segment",
  "source",
  "metadata",
] as const;

function internShapeTable<T>(values: readonly T[]) {
  const items: T[] = [];
  const byValue = new Map<string, number>();
  const indices = values.map((value) => {
    const key = JSON.stringify(value);
    const existing = byValue.get(key);
    if (existing !== undefined) return existing;
    const index = items.length;
    items.push(value);
    byValue.set(key, index);
    return index;
  });
  return { items, indices };
}

/** Project validated metadata only; never collect or synthesize feature values. */
export function projectStorageShapeHistory(
  history: AgentListeningEvidence,
): AgentListeningEvidence {
  validateAgentListeningEvidence(history);
  const projected = {
    ...history,
    records: history.records.map((record) => {
      if (
        record.kind !== "tool_result" ||
        record.metadata.toolName !== "ableton_context" ||
        record.outcome !== "success"
      )
        return record;
      const envelope = record.result?.result;
      object(envelope);
      const data: unknown =
        typeof envelope.content === "string"
          ? JSON.parse(envelope.content)
          : envelope.content;
      object(data);
      if (data.action !== "list-features") return record;
      const page = contextOperationResultSchema.parse(data);
      requireCondition(
        page.action === "list-features",
        "Expected canonical feature inventory",
      );
      const { inventory, ...metadata } = page;
      const alignments = internShapeTable(
        inventory.segments.map((segment) => segment.alignment ?? null),
      );
      const shapes = internShapeTable(
        inventory.metadata.map((feature) => ({
          shape: featureShape(feature),
          valueCount: feature.valueCount,
        })),
      );
      return {
        ...record,
        result: {
          ...record.result,
          result: {
            ...envelope,
            content: {
              ...metadata,
              projection: "acceptance-storage-inventory/v1",
              inventory: {
                featureFields: [...FEATURE_REFERENCE_FIELDS],
                features: inventory.features.map((feature) =>
                  FEATURE_REFERENCE_FIELDS.map((field) =>
                    field === "metadata"
                      ? shapes.indices[feature.metadata]!
                      : feature[field],
                  ),
                ),
                provenance: inventory.provenance.map(
                  ({ entryId, sessionId, liveSetId, sourceFingerprint }) => ({
                    entryId,
                    sessionId,
                    liveSetId,
                    sourceFingerprint,
                  }),
                ),
                segments: inventory.segments.map(
                  ({ alignment, ...segment }, index) => {
                    void alignment;
                    return {
                      ...segment,
                      alignment: alignments.indices[index]!,
                    };
                  },
                ),
                alignments: alignments.items,
                sources: inventory.sources.map(({ passId }) => ({ passId })),
                metadata: shapes.items,
              },
            },
          },
        },
      };
    }),
  };
  validateAgentListeningEvidence(projected);
  return projected;
}

function featureShape(f: FeatureView["record"]["feature"]) {
  const definition = LISTENING_FEATURE_DEFINITIONS.find(
    ({ type }) => type === f.type,
  )!;
  return {
    type: f.type,
    units: f.units,
    profile: f.profile,
    distanceDefinition: f.distanceDefinition,
    distanceUnits: f.distanceUnits,
    normalization: f.normalization,
    supportPolicy: f.supportPolicy,
    sampleRate: f.sampleRate,
    durationSeconds: f.durationSeconds,
    dimensions: definition.dimensions,
    channels: f.channelSupportIntervalCounts?.length ?? null,
    grid: f.grid,
  };
}

function deliveredMeasureShapes(
  analysis: CompleteAnalysis,
  source: StorageShapeEvidence,
  measures: number,
) {
  const geometry = source.geometry;
  requireCondition(
    geometry &&
      analysis.source.geometry?.sampleRate === geometry.sampleRate &&
      analysis.source.geometry.tempoBpm === geometry.tempoBpm &&
      analysis.source.geometry.captureStartSample === geometry.startSample,
    "Delivered storage geometry differs from independent original acquisition",
  );
  const groups = deliveredAnalysisRowGroups(analysis).sort(
    (a, b) => a[0]!.segment.startBeat - b[0]!.segment.startBeat,
  );
  requireCondition(
    groups.length === measures,
    "Incomplete delivered feature-shape measure inventory",
  );
  return groups.map((fragments, index) => {
    const row = fragments[0]!;
    const segment = row.segment;
    requireCondition(
      fragments.every(
        (part) =>
          part.kind === "feature-shapes" &&
          part.shapeScope === "whole-stored-segment" &&
          part.features.length === 0 &&
          part.startBeat === segment.startBeat &&
          part.endBeat === segment.endBeat,
      ) &&
        segment.kind === "bar" &&
        segment.sampleRate === geometry.sampleRate &&
        Math.abs(
          segment.startSample -
            (geometry.startSample +
              (index * 4 * geometry.sampleRate * 60) / geometry.tempoBpm),
        ) < 1 &&
        Math.abs(
          segment.endSample -
            (geometry.startSample +
              ((index + 1) * 4 * geometry.sampleRate * 60) / geometry.tempoBpm),
        ) < 1 &&
        segment.endSample <= geometry.endSample &&
        segment.startBeat === source.startBeat + index * 4 &&
        segment.endBeat === source.startBeat + (index + 1) * 4 &&
        (segment.meter ?? segment.alignment?.meter)?.numerator === 4 &&
        (segment.meter ?? segment.alignment?.meter)?.denominator === 4,
      "Delivered feature shapes lack corresponding complete 4/4 measures",
    );
    const shapes = fragments.flatMap((part) => part.featureShapes ?? []);
    requireCondition(
      shapes.length === LISTENING_FEATURE_DEFINITIONS.length &&
        new Set(shapes.map((shape) => shape.type)).size === shapes.length,
      "Missing or duplicate delivered canonical feature shape",
    );
    return LISTENING_FEATURE_DEFINITIONS.map((definition) => {
      const shape = shapes.find((item) => item.type === definition.type);
      requireCondition(shape, "Missing delivered canonical feature shape");
      const metric = {
        "sample-grid-peak-rms/v1": "level",
        "fft-energy-centroid/v1": "spectral-centroid",
        "level-window-rise/v1": "attacks",
        "mel-band-profile/v1": "mel-bands",
        "pitch-profile/v1": "pitch",
        "spectral-shape-profile/v1": "spectral-shape",
      }[definition.profile];
      const acquisition = source.metrics.find(
        (item) => item.metric === metric,
      )?.acquiredSupport;
      requireCondition(
        acquisition,
        "Missing independent native acquisition coverage",
      );
      const covered = acquisition.reduce(
        (sum, [a, b]) =>
          sum +
          Math.max(
            0,
            Math.min(segment.endSample, b) - Math.max(segment.startSample, a),
          ),
        0,
      );
      requireCondition(
        typeof shape.contentSha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(shape.contentSha256) &&
          shape.units === definition.units &&
          shape.normalization === definition.normalization &&
          shape.dimensions === definition.dimensions &&
          shape.expectedSamples === segment.endSample - segment.startSample &&
          shape.coveredSamples === covered &&
          (shape.status === "unavailable"
            ? shape.valueCount === 0 &&
              shape.reason !== null &&
              !["peak-summary/v1", "level-grid/v1"].includes(shape.type) &&
              (shape.channelReasons === undefined ||
                shape.channelReasons.every((reason) => reason !== null))
            : shape.status === "ready" &&
              shape.reason === null &&
              shape.valueCount ===
                definition.dimensions * (definition.grid ? 16 : 1)),
        "Delivered feature shape, availability or native coverage changed",
      );
      requireCondition(
        definition.grid
          ? (shape.status === "unavailable" && shape.grid === null) ||
              (shape.grid?.cellCount === 16 &&
                shape.grid.stepBeats === 0.25 &&
                shape.grid.phaseBeats === 0 &&
                shape.grid.meter.numerator === 4 &&
                shape.grid.meter.denominator === 4)
          : shape.grid === null,
        "Invalid delivered applicable sixteenth-note grid",
      );
      return {
        type: shape.type,
        units: shape.units,
        normalization: shape.normalization,
        dimensions: shape.dimensions,
        sampleRate: segment.sampleRate,
        durationSeconds:
          (segment.endSample - segment.startSample) / segment.sampleRate,
        grid: definition.grid,
      };
    });
  });
}

export function verifyStorageShape(
  input: AssertionInput,
  expectedMeasures: number,
): void {
  requireCondition(
    expectedMeasures === 1 || expectedMeasures === 20,
    "Expected one or twenty complete measures",
  );
  const turns = input.turns;
  const captures = turns.flatMap((turn) => [
    ...turn.captures.map((capture) => ({
      turn,
      capture,
      view: "session" as const,
    })),
    ...(turn.arrangementCaptures ?? []).map((capture) => ({
      turn,
      capture,
      view: "arrangement" as const,
    })),
  ]);
  requireCondition(
    captures.length === 2 &&
      captures[0]!.view === "session" &&
      captures[1]!.view === "arrangement",
    "Exactly two message-owned Session then Arrangement captures required",
  );
  requireCondition(
    captures[0]!.capture.source.trackId === captures[1]!.capture.source.trackId,
    "Session and Arrangement must use the same admitted track",
  );
  const original = turns.flatMap((turn) => turn.storageShapes ?? []);
  const restored = input.evidence?.storageShapes ?? [];
  requireCondition(
    input.evidence?.setupActions?.some(
      (action) => action.action === "restart-owned-desktop" && action.completed,
    ) &&
      isDeepStrictEqual(
        [...(input.evidence.capturePassIds ?? [])].sort(),
        captures.map(({ capture }) => capture.passId).sort(),
      ),
    "Missing owned restart or hidden capture passes",
  );
  requireCondition(
    original.length === 2 &&
      restored.length === 2 &&
      new Set(original.map((s) => s.contextId)).size === 2 &&
      new Set(original.map((s) => s.passId)).size === 2,
    "Exactly two original and restored persisted context shapes required",
  );
  const shapes = captures.map(({ turn, capture, view }) => {
    requireCondition(
      turn.status === "completed" &&
        turn.facts.sdkTurnId === turn.agentListening?.sdkTurnId &&
        capture.operationId === turn.operationId &&
        capture.complete &&
        !capture.truncated &&
        capture.failure === null,
      "Capture is not a complete real message turn",
    );
    const owned =
      turn.storageShapes?.filter((s) => s.passId === capture.passId) ?? [];
    requireCondition(
      owned.length === 1,
      "Storage shape belongs to another capture turn",
    );
    const source = owned[0]!;
    validateStorageShapeEvidence(source);
    requireCondition(
      expectedMeasures === 1 || source.incrementalDurability !== undefined,
      "Long capture lacks a durable append before native capture could finish",
    );
    requireCondition(
      source.metrics.find(({ metric }) => metric === "level")
        ?.expectedRecords ===
        expectedMeasures * 16,
      "Incorrect expected logical sixteenth-note measurement count",
    );
    const starts = readFeatureToolPairs(turn, true).filter((pair) =>
      pair.action.startsWith("play-"),
    );
    requireCondition(
      starts.length === 1 &&
        starts[0]!.action ===
          (view === "session"
            ? "play-session-and-listen"
            : "play-arrangement-and-listen"),
      "Missing or additional actual SDK capture tool call",
    );
    const job = starts[0]!.data.job;
    requireCondition(
      starts[0]!.call.arguments.listenerIds === undefined ||
        isDeepStrictEqual(starts[0]!.call.arguments.listenerIds, [
          capture.listenerId,
        ]),
      "Requested listener differs from admitted native capture",
    );
    object(job);
    requireCondition(
      job.passId === capture.passId &&
        job.stage === "completed" &&
        isDeepStrictEqual(job.contextIds, [source.contextId]),
      "Tool result is not the completed original persisted capture",
    );
    requireListeningSummary(starts[0]!.data, {
      contextId: source.contextId,
      sessionId: turn.appSessionId,
      liveSetId: starts[0]!.call.liveSetId,
      coordinate: view === "session" ? "clip-local-beats" : "transport-beats",
      range: { startBeat: source.startBeat, endBeat: source.endBeat },
    });
    if ("cleanupComplete" in capture) {
      requireCondition(
        capture.cleanupComplete &&
          capture.missingRecords === 0 &&
          turn.contexts.some(
            (context) =>
              context.contextId === source.contextId &&
              context.passId === source.passId &&
              context.readable,
          ),
        "Missing original Session context or cleanup",
      );
      requireCondition(
        Object.values(input.baseline.sources ?? {}).some(
          (baseline) =>
            baseline.listenerId === capture.listenerId &&
            isDeepStrictEqual(baseline.source, capture.source),
        ),
        "Session capture is not an admitted source",
      );
    } else {
      requireCondition(
        (capture.stream?.contextId === source.contextId ||
          (capture.contextId === source.contextId &&
            source.contentSha256 !== undefined)) &&
          capture.cleanup.captureReleased &&
          capture.cleanup.sourceRestored &&
          capture.cleanup.failure === null,
        "Missing original Arrangement context or cleanup",
      );
      requireCondition(
        Object.values(input.baseline.arrangementSources ?? {}).some(
          (baseline) =>
            baseline.listenerId === capture.listenerId &&
            isDeepStrictEqual(baseline.source, capture.source),
        ),
        "Arrangement capture is not an admitted source",
      );
    }
    requireCondition(
      !source.afterOwnedRestart &&
        source.endBeat - source.startBeat === expectedMeasures * 4,
      "Incorrect original persisted range",
    );
    const reread = restored.filter((s) => s.contextId === source.contextId);
    requireCondition(
      reread.length === 1 && reread[0]!.afterOwnedRestart,
      "Original context not restored after owned restart",
    );
    validateStorageShapeEvidence(reread[0]);
    requireCondition(
      isDeepStrictEqual(source, { ...reread[0], afterOwnedRestart: false }),
      "Persisted schema/counts changed after restart",
    );
    return { source, view };
  });
  requireCondition(
    shapes[0]!.source.schema === "metric-record-stream-context/v1" &&
      shapes[0]!.source.schema === shapes[1]!.source.schema &&
      isDeepStrictEqual(
        shapes[0]!.source.metricSchemas,
        shapes[1]!.source.metricSchemas,
      ),
    "Production persisted measurement schemas differ (no test-side normalization)",
  );
  const inventories = shapes.map(({ source, view }) => {
    const read = (restored: boolean) => {
      const selected = turns.filter(
        (turn) => turn.agentListening?.afterOwnedRestart === restored,
      );
      requireCondition(
        selected.every(
          (turn) =>
            turn.status === "completed" &&
            (!restored ||
              readFeatureToolPairs(turn, true).every(
                (pair) =>
                  pair.action !== "derive-features" &&
                  !pair.action.startsWith("play-"),
              )),
        ),
        "Shape reads require completed turns without restart recapture or rederivation",
      );
      const pages = readCompleteAnalyses(
        selected,
        true,
        "feature-shapes",
      ).filter(
        (page) =>
          page.detail === "feature-shapes" &&
          page.readTarget.contextId === source.contextId,
      );
      requireCondition(pages.length > 0, "Missing delivered original analysis");
      for (const page of pages)
        requireCondition(
          page.readTarget.featureTypes === undefined &&
            page.readTarget.coordinate ===
              (view === "session" ? "clip-local-beats" : "transport-beats") &&
            isDeepStrictEqual(page.readTarget.range, {
              startBeat: source.startBeat,
              endBeat: source.endBeat,
            }) &&
            isDeepStrictEqual(
              page.source.observedRange,
              page.readTarget.range,
            ) &&
            isDeepStrictEqual(
              page.source.requestedRange,
              page.readTarget.range,
            ) &&
            page.source.schema === source.schema &&
            isDeepStrictEqual(
              immutableDeliveredAnalysis(page),
              immutableDeliveredAnalysis(pages[0]!),
            ),
          "Delivered analysis changed original source, extent or inventory",
        );
      return pages[0]!;
    };
    const before = read(false);
    const after = read(true);
    requireCondition(
      isDeepStrictEqual(
        immutableDeliveredAnalysis(before),
        immutableDeliveredAnalysis(after),
      ),
      "Original pinned analysis values, coverage or shapes changed after restart",
    );
    return deliveredMeasureShapes(before, source, expectedMeasures);
  });
  requireCondition(
    isDeepStrictEqual(inventories[0], inventories[1]),
    "Corresponding canonical feature shapes/dimensions differ",
  );
}
