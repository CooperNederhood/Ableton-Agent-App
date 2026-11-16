import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  LISTENING_FEATURE_DEFINITIONS,
  metricAudioObservationSchema,
  contextSegmentSchema,
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
  expandListeningFeatureInventory,
} from "@ableton-agent/tools";
import type { AssertionInput, TurnEvidence } from "./contracts.js";
import { readFeatureToolPairs } from "./feature-search.js";
import {
  validateAgentListeningEvidence,
  type AgentListeningEvidence,
} from "./agent-listening-result.js";
import {
  identifier,
  listenerIdentifier,
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
  }[];
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
    metrics: manifest.metrics.map((metric) => ({
      metric: metric.metric,
      expectedRecords: metric.expectedRecords,
      retainedRecords: metric.nextRecordOffset,
      missingRecords: metric.missingRecords,
    })),
  };
}

export function projectObservationStorageShape(
  contextId: string,
  input: MetricAudioObservation,
  afterOwnedRestart: boolean,
): StorageShapeEvidence {
  const observation = metricAudioObservationSchema.parse(input);
  return {
    contextId,
    passId: observation.ownership.passId,
    schema: observation.schema,
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
  ]);
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
    ]);
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
function compactFeature(view: FeatureView) {
  const { id, entryId, segmentId, sessionId, liveSetId, sourceFingerprint } =
    view.record;
  return {
    id,
    entryId,
    segmentId,
    sessionId,
    liveSetId,
    sourceFingerprint,
    passId: view.source.passId,
    segment: view.segment,
    shape: featureShape(view.record.feature),
    valueCount: view.record.feature.valueCount,
  };
}
type StoredShape = ReturnType<typeof compactFeature>;
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

function inventoryPage(data: Record<string, unknown>) {
  if (data.projection !== "acceptance-storage-inventory/v1") {
    const page = contextOperationResultSchema.parse(data);
    requireCondition(
      page.action === "list-features",
      "Expected typed feature inventory",
    );
    return {
      ...page,
      features: expandListeningFeatureInventory(page.inventory).map(
        compactFeature,
      ),
    };
  }
  rejectUnknownFields(data, [
    "action",
    "projection",
    "inventory",
    "derivation",
    "nextCursor",
  ]);
  object(data.inventory);
  const inventory = data.inventory;
  const tables = [
    "features",
    "provenance",
    "segments",
    "alignments",
    "sources",
    "metadata",
  ] as const;
  rejectUnknownFields(inventory, [...tables, "featureFields"]);
  list(inventory.featureFields, FEATURE_REFERENCE_FIELDS.length);
  requireCondition(
    inventory.featureFields.length === FEATURE_REFERENCE_FIELDS.length &&
      inventory.featureFields.every(
        (field, index) => field === FEATURE_REFERENCE_FIELDS[index],
      ),
    "Invalid feature reference field order",
  );
  for (const table of tables) list(inventory[table], 100);
  const reference = (table: (typeof tables)[number], index: unknown) => {
    requireCondition(
      Number.isSafeInteger(index) && Number(index) >= 0,
      "Invalid inventory table index",
    );
    const values = inventory[table] as unknown[];
    const value = values[Number(index)];
    requireCondition(value !== undefined, "Missing inventory table reference");
    return value;
  };
  const features = (inventory.features as unknown[]).map((row) => {
    list(row, FEATURE_REFERENCE_FIELDS.length);
    requireCondition(
      row.length === FEATURE_REFERENCE_FIELDS.length,
      "Invalid feature reference row width",
    );
    const raw = Object.fromEntries(
      FEATURE_REFERENCE_FIELDS.map((field, index) => [field, row[index]]),
    );
    const provenance = reference("provenance", raw.provenance);
    object(provenance);
    rejectUnknownFields(provenance, [
      "entryId",
      "sessionId",
      "liveSetId",
      "sourceFingerprint",
    ]);
    const source = reference("sources", raw.source);
    object(source);
    rejectUnknownFields(source, ["passId"]);
    const metadata = reference("metadata", raw.metadata);
    object(metadata);
    rejectUnknownFields(metadata, ["shape", "valueCount"]);
    const compactSegment = reference("segments", raw.segment);
    object(compactSegment);
    const alignment = reference("alignments", compactSegment.alignment);
    const originalSegment: Record<string, unknown> = {
      ...compactSegment,
      alignment: alignment === null ? undefined : alignment,
    };
    const value: Record<string, unknown> = {
      id: raw.id,
      ...provenance,
      segmentId: originalSegment.id,
      segment: originalSegment,
      passId: source.passId,
      ...metadata,
    };
    object(value);
    rejectUnknownFields(value, [
      "id",
      "entryId",
      "segmentId",
      "sessionId",
      "liveSetId",
      "sourceFingerprint",
      "passId",
      "segment",
      "shape",
      "valueCount",
    ]);
    for (const id of [
      value.id,
      value.entryId,
      value.segmentId,
      value.sessionId,
      value.liveSetId,
      value.passId,
    ])
      listenerIdentifier(id);
    requireCondition(
      typeof value.sourceFingerprint === "string" &&
        /^[a-f0-9]{64}$/u.test(value.sourceFingerprint),
      "Invalid stored feature source fingerprint",
    );
    const segment = contextSegmentSchema.parse(value.segment);
    requireCondition(
      segment.id === value.segmentId &&
        segment.entryId === value.entryId &&
        segment.sessionId === value.sessionId &&
        segment.liveSetId === value.liveSetId,
      "Foreign feature segment ownership",
    );
    object(value.shape);
    const shape = value.shape;
    rejectUnknownFields(shape, [
      "type",
      "units",
      "profile",
      "distanceDefinition",
      "distanceUnits",
      "normalization",
      "supportPolicy",
      "sampleRate",
      "durationSeconds",
      "dimensions",
      "channels",
      "grid",
    ]);
    const definition = LISTENING_FEATURE_DEFINITIONS.find(
      ({ type }) => type === shape.type,
    );
    requireCondition(
      definition &&
        shape.units === definition.units &&
        shape.profile === definition.profile &&
        shape.distanceDefinition === definition.distanceDefinition &&
        shape.distanceUnits === definition.distanceUnits &&
        shape.normalization === definition.normalization &&
        shape.dimensions === definition.dimensions &&
        [44100, 48000].includes(Number(shape.sampleRate)) &&
        typeof shape.durationSeconds === "number" &&
        Number.isFinite(shape.durationSeconds) &&
        shape.durationSeconds > 0 &&
        shape.durationSeconds <= 30,
      "Invalid canonical feature shape",
    );
    const analyzer =
      definition.profile === "pitch-profile/v1" ||
      definition.profile === "spectral-shape-profile/v1";
    requireCondition(
      shape.channels === (analyzer ? 2 : null) &&
        shape.supportPolicy ===
          (definition.grid
            ? "matching-cell-mask"
            : definition.type === "peak-summary/v1"
              ? "complete-required"
              : "retained-overlap"),
      "Invalid channel/support dimensions",
    );
    if (definition.grid) {
      object(shape.grid);
      object(shape.grid.meter);
      rejectUnknownFields(shape.grid, [
        "stepBeats",
        "meter",
        "phaseBeats",
        "cellCount",
      ]);
      rejectUnknownFields(shape.grid.meter, ["numerator", "denominator"]);
      requireCondition(
        shape.grid.stepBeats === 0.25 &&
          shape.grid.cellCount === 16 &&
          shape.grid.phaseBeats === 0 &&
          shape.grid.meter.numerator === 4 &&
          shape.grid.meter.denominator === 4,
        "Invalid applicable grid dimensions",
      );
    } else requireCondition(shape.grid === null, "Unexpected feature grid");
    requireCondition(
      value.valueCount === 0 ||
        value.valueCount === definition.dimensions * (definition.grid ? 16 : 1),
      "Invalid stored vector count",
    );
    return value as unknown as StoredShape;
  });
  const derivation =
    data.derivation === undefined
      ? undefined
      : contextOperationResultSchema.parse({
          action: "derive-features",
          derivations: [data.derivation],
        });
  requireCondition(
    data.nextCursor === undefined ||
      (typeof data.nextCursor === "string" &&
        /^[A-Za-z0-9_-]{1,2048}$/u.test(data.nextCursor)),
    "Invalid inventory continuation",
  );
  return {
    action: "list-features",
    features,
    derivation:
      derivation?.action === "derive-features"
        ? derivation.derivations[0]
        : undefined,
    nextCursor: data.nextCursor,
  };
}
function inventory(
  turns: readonly TurnEvidence[],
  contextId: string,
  restored: boolean,
) {
  const features: StoredShape[] = [];
  let cursor: string | undefined;
  let started = false;
  let finished = false;
  let expectedCount: number | undefined;
  for (const turn of turns) {
    if (turn.agentListening?.afterOwnedRestart !== restored) continue;
    for (const pair of readFeatureToolPairs(turn, true)) {
      if (restored)
        requireCondition(
          pair.action !== "derive-features" && !pair.action.startsWith("play-"),
          "Restart must not recapture or rederive",
        );
      if (
        pair.action !== "list-features" ||
        pair.call.arguments.contextId !== contextId
      )
        continue;
      requireCondition(
        pair.call.arguments.featureType === undefined &&
          !finished &&
          pair.call.arguments.cursor === cursor,
        "Missing, duplicate or out-of-order feature inventory page",
      );
      const page = inventoryPage(pair.data);
      requireCondition(
        page.features.every(
          (feature) => feature.sessionId === turn.appSessionId,
        ),
        "Feature inventory belongs to another App session",
      );
      started = true;
      if (page.derivation) {
        requireCondition(
          page.derivation.entryId === contextId &&
            page.derivation.status === "ready" &&
            page.derivation.definitionSet === "qualified-listening/v1",
          "Missing canonical stored feature derivation",
        );
        requireCondition(
          expectedCount === undefined ||
            expectedCount === page.derivation.featureCount,
          "Feature count changed during inventory",
        );
        expectedCount = page.derivation.featureCount;
      }
      features.push(...page.features);
      cursor = page.nextCursor;
      finished = cursor === undefined;
    }
  }
  requireCondition(
    started &&
      finished &&
      expectedCount === features.length &&
      features.length <= 512 * 15,
    "Missing or truncated stored feature inventory",
  );
  requireCondition(
    new Set(features.map(({ id }) => id)).size === features.length &&
      features.every((feature) => feature.entryId === contextId),
    "Duplicate or foreign feature inventory",
  );
  return features;
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

function measureShapes(
  features: readonly StoredShape[],
  source: StorageShapeEvidence,
  measures: number,
  view: "session" | "arrangement",
) {
  const segments = new Map(features.map((f) => [f.segment.id, f.segment]));
  const ordered = [...segments.values()].sort((a, b) => a.order - b.order);
  requireCondition(
    ordered.length === measures &&
      features.length === measures * LISTENING_FEATURE_DEFINITIONS.length,
    "Unexpected complete measure or fifteen-definition feature count",
  );
  return ordered.map((segment, index) => {
    requireCondition(
      segment.kind === "bar" &&
        segment.order === index &&
        segment.coordinate ===
          (view === "session" ? "clip-local-beats" : "transport-beats") &&
        segment.startBeat === source.startBeat + index * 4 &&
        segment.endBeat === source.startBeat + (index + 1) * 4 &&
        segment.alignment?.meter.numerator === 4 &&
        segment.alignment.meter.denominator === 4,
      "Missing or incompatible corresponding 4/4 measure",
    );
    const records = features.filter((f) => f.segment.id === segment.id);
    requireCondition(
      records.length === 15 &&
        new Set(records.map((f) => f.shape.type)).size === 15,
      "Missing canonical feature definition on a measure",
    );
    return LISTENING_FEATURE_DEFINITIONS.map((definition) => {
      const record = records.find((f) => f.shape.type === definition.type)!;
      requireCondition(
        record && record.passId === source.passId,
        "Feature source pass differs from persisted capture",
      );
      const shape = record.shape;
      requireCondition(
        definition.grid
          ? shape.grid?.cellCount === 16 &&
              shape.grid.stepBeats === 0.25 &&
              shape.grid.meter.numerator === 4 &&
              shape.grid.meter.denominator === 4 &&
              shape.grid.phaseBeats === 0
          : shape.grid === null,
        "Invalid applicable sixteenth-note grid",
      );
      return shape;
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
    object(job);
    requireCondition(
      job.passId === capture.passId &&
        job.stage === "completed" &&
        isDeepStrictEqual(job.contextIds, [source.contextId]),
      "Tool result is not the completed original persisted capture",
    );
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
    const before = inventory(turns, source.contextId, false);
    const after = inventory(turns, source.contextId, true);
    requireCondition(
      isDeepStrictEqual(before, after),
      "Original feature identities, inventories or shapes changed after restart",
    );
    return measureShapes(before, source, expectedMeasures, view);
  });
  requireCondition(
    isDeepStrictEqual(inventories[0], inventories[1]),
    "Corresponding canonical feature shapes/dimensions differ",
  );
}
