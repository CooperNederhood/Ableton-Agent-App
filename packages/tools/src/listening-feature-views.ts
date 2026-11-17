import { createHash } from "node:crypto";
import {
  canonicalMetricRecordJson,
  contextFeatureSchema,
  contextFeatureDerivationSchema,
  listeningFeatureDefinition,
  listeningFeatureGridSchema,
  listeningFeatureSchema,
  MAX_CONTEXT_FEATURES_PER_DERIVATION,
  MAX_ANALYZER_FRAMES,
  type ContextFeature,
  type ContextFeatureDerivation,
  type ListeningFeature,
  type ContextSegment,
  clipLocationSchema,
  trackLocationSchema,
  listeningFeatureTypeSchema,
  listeningFeatureComparisonSchema,
  LISTENING_FEATURE_DEFINITIONS,
  listeningMusicalAlignmentSchema,
  listeningFeatureDefinitionSchema,
  audioObservationKindSchema,
  metricRecordChunkSchema,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamManifestSchema,
  metricContinuousListeningGeometrySchema,
  metricListeningReportSchema,
} from "@ableton-agent/protocol";
import { z } from "zod";

export const MAX_FEATURE_PAGE_CELLS = 32;

const analysisId = z.string().min(1).max(256);
export const analysisRangeSchema = z
  .strictObject({
    startBeat: z.number().finite().nonnegative(),
    endBeat: z.number().finite().positive(),
  })
  .refine((value) => value.endBeat > value.startBeat);
const featureSelection = z.array(listeningFeatureTypeSchema).min(1).max(15);
export const captureAnalysisTargetSchema = z.strictObject({
  kind: z.literal("capture"),
  sessionId: analysisId,
  liveSetId: analysisId,
  contextId: analysisId,
  coordinate: z.enum(["clip-local-beats", "transport-beats"]),
  range: analysisRangeSchema,
  featureTypes: featureSelection.optional(),
});
export const sourceAnalysisTargetSchema = z.strictObject({
  kind: z.literal("source"),
  source: z.union([
    clipLocationSchema.options[0],
    z.strictObject({
      view: z.literal("arrangement"),
      track: trackLocationSchema,
    }),
  ]),
  range: analysisRangeSchema.optional(),
  featureTypes: featureSelection.optional(),
});
export const passageAnalysisTargetSchema = z.union([
  sourceAnalysisTargetSchema,
  captureAnalysisTargetSchema,
]);
export const comparisonAnalysisTargetSchema = z.strictObject({
  kind: z.literal("comparison"),
  left: captureAnalysisTargetSchema,
  right: captureAnalysisTargetSchema,
});
export const analysisTargetSchema = z.union([
  passageAnalysisTargetSchema,
  comparisonAnalysisTargetSchema,
]);
const analysisCursor = z.string().min(1).max(32768);
export const analysisReadParamsSchema = z.strictObject({
  action: z.literal("read"),
  target: analysisTargetSchema,
  includeHistorical: z.boolean().default(false),
  cursor: analysisCursor.optional(),
  detail: z
    .enum(["feature-shapes", "evidence", "original-measurements"])
    .optional()
    .describe(
      "Omit for compact musical values and coverage. Use feature-shapes for complete per-segment feature types, dimensions, actual stored value/cell counts and availability without numeric arrays. Shapes describe whole stored segments overlapping the target, not cropped or recomputed features. Use evidence for canonical metadata, definitions and complete native support intervals, or original-measurements for original analyzer frames. A continuation cursor retains the original target, detail and historical scope.",
    ),
});
export const analysisOperationParamsSchema = z.discriminatedUnion("action", [
  analysisReadParamsSchema
    .extend({
      target: analysisTargetSchema.optional(),
      includeHistorical: z.boolean().optional(),
    })
    .refine(
      (value) => value.target !== undefined || value.cursor !== undefined,
      "Read requires a target or a continuation cursor",
    )
    .refine(
      (value) =>
        value.detail !== "original-measurements" ||
        value.target?.kind !== "comparison",
      "Original measurements require a single source or capture target",
    ),
  z.strictObject({
    action: z.literal("compare"),
    left: passageAnalysisTargetSchema,
    right: passageAnalysisTargetSchema,
    featureTypes: featureSelection.optional(),
    includeHistorical: z.boolean().default(false),
    cursor: analysisCursor.optional(),
  }),
  z.strictObject({
    action: z.literal("search"),
    query: passageAnalysisTargetSchema,
    scope: z.array(passageAnalysisTargetSchema).min(1).max(100),
    featureType: listeningFeatureTypeSchema.default("mel-grid/v1"),
    topK: z.number().int().min(1).max(20).default(10),
    withinCapture: z.boolean().default(false),
    includeHistorical: z.boolean().default(false),
    cursor: analysisCursor.optional(),
  }),
]);
export const LISTENING_FEATURE_CATALOG = LISTENING_FEATURE_DEFINITIONS.map(
  (definition) =>
    `${definition.type} (${definition.units}): ${definition.description}.`,
).join(" ");

export const analysisSourceSchema = z.strictObject({
  schema: z
    .union([
      audioObservationKindSchema,
      z.literal("metric-record-stream-context/v1"),
    ])
    .optional(),
  name: z.string().max(128),
  nameTruncated: z.boolean(),
  location: z.string().max(128),
  capturedAt: z.string().datetime().max(40),
  coordinate: captureAnalysisTargetSchema.shape.coordinate,
  observedRange: analysisRangeSchema,
  requestedRange: analysisRangeSchema,
  readTarget: captureAnalysisTargetSchema,
  freshness: z.enum(["fresh", "stale", "unknown", "unresolved", "historical"]),
  geometry: z
    .strictObject({
      sampleRate: z.number().positive(),
      tempoBpm: z.number().positive(),
      captureStartSample: z.number().nonnegative(),
      transportStartBeat: z.number().nonnegative(),
    })
    .optional(),
});
const analysisFeatureBlockSchema = z.strictObject({
  featureId: analysisId.optional(),
  segmentId: analysisId.optional(),
  sourceFingerprint: z.string().length(64).optional(),
  readTarget: captureAnalysisTargetSchema.optional(),
  type: listeningFeatureTypeSchema,
  units: listeningFeatureSchema.shape.units,
  normalization: listeningFeatureSchema.shape.normalization,
  dimensions: z.array(z.string().max(64)).max(48),
  dimensionOffset: z.number().int().nonnegative().optional(),
  totalDimensions: z.number().int().positive().max(48).optional(),
  status: listeningFeatureSchema.shape.status,
  reason: z.string().max(512).nullable(),
  values: z.array(z.number().finite().nullable()).max(48).nullable(),
  coveredSamples: z.number().nonnegative(),
  expectedSamples: z.number().nonnegative(),
  channelReasons: listeningFeatureSchema.shape.channelReasons,
  channelCoveredSamples:
    listeningFeatureGridSchema.shape.cells.element.shape.channelCoveredSamples,
  supportExtent: listeningFeatureSchema.shape.support.element
    .refine(([start, end]) => end > start)
    .nullable()
    .optional()
    .describe(
      "Bounding native support intersecting this interval, in segment-relative samples; not a claim of continuous support. Use read detail=evidence for complete support intervals.",
    ),
});
const analysisFeatureShapeSchema = z
  .strictObject({
    type: listeningFeatureTypeSchema,
    units: listeningFeatureSchema.shape.units,
    normalization: listeningFeatureSchema.shape.normalization,
    status: listeningFeatureSchema.shape.status,
    reason: listeningFeatureSchema.shape.reason,
    dimensions: z.number().int().min(1).max(48),
    valueCount: z
      .number()
      .int()
      .min(0)
      .max(2000 * 48),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .describe(
        "SHA-256 of the canonical full stored feature, including numeric values, grid validity and supports. An equality fingerprint, not independently recomputed DSP ground truth.",
      ),
    grid: z.lazy(() => gridMetadataSchema).nullable(),
    coveredSamples: listeningFeatureSchema.shape.coveredSamples,
    expectedSamples: listeningFeatureSchema.shape.expectedSamples,
    channelReasons: listeningFeatureSchema.shape.channelReasons,
  })
  .superRefine((shape, context) => {
    const definition = listeningFeatureDefinition(shape.type);
    if (
      shape.dimensions !== definition.dimensions ||
      !featureShapeMetadataValid(shape)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid stored feature shape",
      });
  });
export const analysisTimelineItemSchema = z
  .strictObject({
    kind: z.enum([
      "segment-summary",
      "interval",
      "availability",
      "support",
      "feature-metadata",
      "feature-shapes",
    ]),
    segment: z.strictObject({
      id: analysisId.optional(),
      entryId: analysisId.optional(),
      sessionId: analysisId.optional(),
      liveSetId: analysisId.optional(),
      order: z.number().int().nonnegative().optional(),
      coordinate: captureAnalysisTargetSchema.shape.coordinate.optional(),
      startBeat: z.number().finite(),
      endBeat: z.number().finite(),
      startSample: z.number().nonnegative(),
      endSample: z.number().nonnegative(),
      sampleRate: z.number().positive(),
      kind: z.enum(["unaligned", "short", "bar", "partial"]),
      alignment: listeningMusicalAlignmentSchema.nullable().optional(),
      meter: listeningMusicalAlignmentSchema.shape.meter.optional(),
      barOriginBeat:
        listeningMusicalAlignmentSchema.shape.barOriginBeat.optional(),
      alignmentReason: z.string().max(128).nullable(),
    }),
    startBeat: z.number().finite(),
    endBeat: z.number().finite(),
    elapsedStartSeconds: z.number().finite(),
    elapsedEndSeconds: z.number().finite(),
    fragment: z.number().int().nonnegative(),
    fragmentCount: z.number().int().positive().optional(),
    complete: z.boolean(),
    features: z.array(analysisFeatureBlockSchema).max(15),
    shapeScope: z.literal("whole-stored-segment").optional(),
    featureShapes: z
      .array(analysisFeatureShapeSchema)
      .min(1)
      .max(15)
      .optional(),
    featureType: listeningFeatureTypeSchema.optional(),
    featureRecord: z.lazy(() => contextFeatureMetadataSchema).optional(),
    definition: listeningFeatureDefinitionSchema.optional(),
    featureStatus: listeningFeatureSchema.shape.status.optional(),
    reason: z.string().max(512).nullable().optional(),
    readTarget: captureAnalysisTargetSchema.optional(),
    support: z.tuple([z.number(), z.number()]).optional(),
    supportCoordinate: z.literal("segment-relative-samples").optional(),
    supportChannel: z.enum(["aggregate", "left", "right"]).optional(),
    supportOffset: z.number().int().nonnegative().optional(),
    profileKey: z.string().max(1024).optional(),
    limitations: z.array(z.string().max(256)).max(8).optional(),
  })
  .superRefine((row, context) => {
    if (
      row.kind === "feature-shapes"
        ? row.featureShapes === undefined ||
          row.shapeScope === undefined ||
          row.features.length !== 0
        : row.featureShapes !== undefined || row.shapeScope !== undefined
    )
      context.addIssue({
        code: "custom",
        message: "Feature shapes require an explicit shape row",
      });
  });
export const analysisOverviewSchema = z
  .array(
    z.strictObject({
      type: listeningFeatureTypeSchema,
      units: listeningFeatureSchema.shape.units,
      basis: z.enum(["grid-cells", "segment-summaries"]),
      availableSegments: z.number().int().nonnegative(),
      totalSegments: z.number().int().nonnegative(),
      validValues: z.number().int().nonnegative(),
      expectedValues: z.number().int().nonnegative(),
      minimum: z.number().finite().nullable(),
      maximum: z.number().finite().nullable(),
      reason: z.string().max(512).nullable(),
    }),
  )
  .max(15);
export const analysisPageSchema = z.strictObject({
  detail: z.strictObject({
    offset: z.number().int().nonnegative(),
    returnedItems: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
    truncated: z.boolean(),
    nextCursor: analysisCursor.nullable(),
  }),
  source: analysisSourceSchema,
  readTarget: captureAnalysisTargetSchema,
  status: z.enum([
    "pending",
    "ready",
    "unavailable",
    "failed",
    "cancelled",
    "timed-out",
  ]),
  reason: z.string().max(512).nullable(),
  overview: analysisOverviewSchema,
  overviewIncluded: z.boolean(),
  timeline: z.array(analysisTimelineItemSchema),
  overviewExtent: analysisRangeSchema,
});
export const captureAnalysisFailureSchema = z.strictObject({
  contextId: captureAnalysisTargetSchema.shape.contextId,
  readTarget: captureAnalysisTargetSchema.optional(),
  status: z.literal("failed"),
  code: z.string().min(1).max(128),
  reason: z.string().max(512),
});
const { rows: _streamRows, ...streamGeometryShape } =
  metricContinuousListeningGeometrySchema.shape;
void _streamRows;
export const metricStreamOverviewSchema = z
  .strictObject({
    descriptorDigest: metricRecordChunkSchema.options[0].shape.descriptorDigest,
    geometry: z.strictObject(streamGeometryShape),
    source: metricRecordStreamDescriptorSchema.shape.source,
    timingPolicy: metricRecordStreamDescriptorSchema.shape.timingPolicy,
    algorithms: metricRecordStreamDescriptorSchema.shape.algorithms,
    metrics: metricRecordStreamManifestSchema.shape.metrics,
    outcome: z.enum(["complete", "partial"]),
    nativeStatus: z.literal("completed"),
    nativeCoverage: z.strictObject({
      capturedSamples:
        metricRecordStreamManifestSchema.shape.nativeProof.shape
          .capturedSamples,
      sourceOrigin:
        metricRecordStreamManifestSchema.shape.nativeProof.shape.sourceOrigin,
      sourceEnd:
        metricRecordStreamManifestSchema.shape.nativeProof.shape.sourceEnd,
      drain: z.literal("completed"),
    }),
    chunkCount: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
    limitations: metricRecordStreamManifestSchema.shape.limitations,
    featureDerivation: z.literal("supported"),
  })
  .superRefine((value, ctx) => {
    if (
      value.nativeCoverage.capturedSamples !== value.geometry.totalSamples ||
      value.nativeCoverage.sourceOrigin !== value.geometry.startSample ||
      value.nativeCoverage.sourceEnd !== value.geometry.endSample
    )
      ctx.addIssue({
        code: "custom",
        message: "Completed stream native coverage must match its geometry",
      });
  });
const streamRecordProjections = metricRecordChunkSchema.options.map((chunk) =>
  z.strictObject({
    kind: z.literal("metric-record-chunk-projection/v1"),
    metric: chunk.shape.metric,
    descriptorDigest: chunk.shape.descriptorDigest,
    chunkDigest: chunk.shape.digest,
    previousDigest: chunk.shape.previousDigest,
    chunkSequence: chunk.shape.chunkSequence,
    recordOffset: chunk.shape.recordOffset,
    slotOffset: chunk.shape.slotOffset,
    totalRecords: z.number().int().min(0).max(256),
    totalGaps: z.number().int().min(0).max(256),
    entryOffset: z.number().int().min(0).max(255),
    records: chunk.shape.records.max(64),
    gaps: chunk.shape.gaps.max(64),
  }),
);
export const metricStreamRecordPageSchema = z
  .discriminatedUnion("metric", [
    streamRecordProjections[0]!,
    ...streamRecordProjections.slice(1),
  ])
  .superRefine((value, ctx) => {
    const count = value.records.length + value.gaps.length;
    if (
      count > 64 ||
      (count === 0 && value.entryOffset !== 0) ||
      value.records.length > value.totalRecords ||
      value.gaps.length > value.totalGaps ||
      value.totalRecords + value.totalGaps < 1 ||
      value.totalRecords + value.totalGaps > 256 ||
      value.entryOffset + count > value.totalRecords + value.totalGaps
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid bounded stream record projection",
      });
  });
export const originalMeasurementsSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("stream-overview"),
    source: analysisSourceSchema,
    overview: metricStreamOverviewSchema,
  }),
  z.strictObject({
    kind: z.literal("stream-records"),
    source: analysisSourceSchema,
    page: metricStreamRecordPageSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("report"),
    source: analysisSourceSchema,
    report: metricListeningReportSchema,
  }),
]);
export const analysisComparisonItemSchema = z.strictObject({
  type: listeningFeatureTypeSchema,
  left: analysisRangeSchema,
  right: analysisRangeSchema.nullable(),
  comparison: listeningFeatureComparisonSchema.nullable(),
  reason: z.string().max(512).nullable(),
  definition: listeningFeatureDefinitionSchema.optional(),
  leftFeature: z
    .strictObject({
      featureId: analysisId,
      segmentId: analysisId,
      sourceFingerprint: z.string().length(64),
      readTarget: captureAnalysisTargetSchema,
    })
    .optional(),
  rightFeature: z
    .strictObject({
      featureId: analysisId,
      segmentId: analysisId,
      sourceFingerprint: z.string().length(64),
      readTarget: captureAnalysisTargetSchema,
    })
    .optional(),
  evidence: z
    .strictObject({
      units: listeningFeatureSchema.shape.units,
      normalization: listeningFeatureSchema.shape.normalization,
      leftRange: analysisRangeSchema,
      rightRange: analysisRangeSchema,
      leftValues: z.array(z.number().finite().nullable()).max(48).nullable(),
      rightValues: z.array(z.number().finite().nullable()).max(48).nullable(),
      scope: z.enum(["first-canonical-cell", "segment-summary"]),
    })
    .optional(),
});
const comparisonResultFields = {
  nextCursor: analysisCursor.nullable(),
  truncated: z.boolean(),
  readTarget: comparisonAnalysisTargetSchema,
  left: analysisSourceSchema,
  right: analysisSourceSchema,
  comparisons: z.array(analysisComparisonItemSchema),
  completeExtent: z.boolean(),
};
export const analysisOperationResultSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("read"),
      nextCursor: analysisCursor.nullable(),
      analyses: z.array(analysisPageSchema).max(2),
      originalMeasurements: originalMeasurementsSchema.optional(),
      comparison: z
        .strictObject({
          action: z.literal("compare"),
          ...comparisonResultFields,
        })
        .optional(),
    })
    .refine(
      (value) =>
        value.originalMeasurements
          ? value.analyses.length === 0 && value.comparison === undefined
          : value.analyses.length > 0,
      "A read returns either canonical analyses or original measurement evidence",
    ),
  z.strictObject({ action: z.literal("compare"), ...comparisonResultFields }),
  z.strictObject({
    action: z.literal("search"),
    nextCursor: analysisCursor.nullable(),
    truncated: z.boolean(),
    query: analysisSourceSchema,
    featureType: listeningFeatureTypeSchema,
    distanceUnits: listeningFeatureSchema.shape.distanceUnits,
    aggregation: z.literal("compared-value-weighted-rms-of-segment-distances"),
    requestedTopK: z.number().int().min(1).max(20),
    selectedCount: z.number().int().min(0).max(20),
    returnedCount: z.number().int().min(0).max(20),
    scannedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    exhaustive: z.boolean(),
    matches: z
      .array(
        z.strictObject({
          rank: z.number().int().min(1).max(20),
          source: analysisSourceSchema,
          match: analysisSourceSchema,
          distance: z.number().finite().nonnegative(),
          comparisons: z.array(analysisComparisonItemSchema),
          evidence: z.strictObject({
            offset: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
            complete: z.boolean(),
          }),
        }),
      )
      .max(20),
  }),
]);
export type CaptureAnalysisTarget = z.infer<typeof captureAnalysisTargetSchema>;
export type PassageAnalysisTarget = z.infer<typeof passageAnalysisTargetSchema>;
export type AnalysisSource = z.infer<typeof analysisSourceSchema>;
export type AnalysisPage = z.infer<typeof analysisPageSchema>;
export type AnalysisOperationParams = z.infer<
  typeof analysisOperationParamsSchema
>;
export type AnalysisOperationResult = z.infer<
  typeof analysisOperationResultSchema
>;
export type AnalysisTimelineItem = z.infer<typeof analysisTimelineItemSchema>;
export interface ListeningAnalysisFeature {
  record: ContextFeature;
  segment: ContextSegment;
}

function dimensionLabels(feature: ListeningFeature): string[] {
  const definition = listeningFeatureDefinition(feature.type);
  if (definition.dimensions === 48)
    return ["left", "right"].flatMap((channel) =>
      Array.from(
        { length: 24 },
        (_, index) => `${channel}.mel-band-${index + 1}`,
      ),
    );
  if (definition.dimensions === 2) return ["left", "right"];
  if (feature.type === "mel-region-summary/v1")
    return ["left", "right"].flatMap((channel) =>
      ["low", "mid", "high"].map((region) => `${channel}.${region}`),
    );
  if (feature.type === "mel-ratio-summary/v1")
    return ["left", "right"].flatMap((channel) =>
      ["low/mid", "high/mid"].map((ratio) => `${channel}.${ratio}`),
    );
  return Array.from({ length: definition.dimensions }, (_, index) =>
    definition.dimensions === 1
      ? definition.measurement
      : `${definition.measurement}.${index + 1}`,
  );
}

/** Project the stored canonical grid, never resample or normalize a page. */
export function projectListeningTimeline(
  views: readonly ListeningAnalysisFeature[],
  captureStartSample: number,
  target?: CaptureAnalysisTarget,
  detail?: "evidence" | "feature-shapes",
): AnalysisTimelineItem[] {
  const rows = new Map<string, AnalysisTimelineItem>();
  const details: AnalysisTimelineItem[] = [];
  for (const { record, segment } of views) {
    if (
      target &&
      (segment.endBeat <= target.range.startBeat ||
        segment.startBeat >= target.range.endBeat)
    )
      continue;
    const feature = record.feature;
    const definition = listeningFeatureDefinition(feature.type);
    const featureReadTarget = target
      ? {
          ...target,
          range: {
            startBeat: Math.max(target.range.startBeat, segment.startBeat),
            endBeat: Math.min(target.range.endBeat, segment.endBeat),
          },
          featureTypes: [feature.type],
        }
      : undefined;
    const base = {
      segment: {
        ...(detail === "evidence"
          ? {
              id: segment.id,
              entryId: segment.entryId,
              sessionId: segment.sessionId,
              liveSetId: segment.liveSetId,
            }
          : {}),
        order: segment.order,
        coordinate: segment.coordinate,
        startBeat: segment.startBeat,
        endBeat: segment.endBeat,
        startSample: segment.startSample,
        endSample: segment.endSample,
        sampleRate: segment.sampleRate,
        kind: segment.kind,
        ...(detail === "evidence"
          ? { alignment: segment.alignment ?? null }
          : segment.alignment
            ? {
                meter: segment.alignment.meter,
                barOriginBeat: segment.alignment.barOriginBeat,
              }
            : {}),
        alignmentReason: segment.alignmentReason,
      },
      fragment: 0,
      complete: true,
    };
    const bounds = (startBeat: number, endBeat: number) => ({
      startBeat,
      endBeat,
      elapsedStartSeconds:
        (segment.startSample - captureStartSample) / segment.sampleRate +
        ((startBeat - segment.startBeat) /
          (segment.endBeat - segment.startBeat)) *
          feature.durationSeconds,
      elapsedEndSeconds:
        (segment.startSample - captureStartSample) / segment.sampleRate +
        ((endBeat - segment.startBeat) /
          (segment.endBeat - segment.startBeat)) *
          feature.durationSeconds,
    });
    if (detail === "feature-shapes") {
      const metadata = projectListeningFeatureRecord(record).feature;
      const key = `${segment.id}:feature-shapes`;
      const row: AnalysisTimelineItem = rows.get(key) ?? {
        ...base,
        ...bounds(segment.startBeat, segment.endBeat),
        kind: "feature-shapes",
        features: [],
        shapeScope: "whole-stored-segment",
        featureShapes: [],
      };
      row.featureShapes!.push({
        type: metadata.type,
        units: metadata.units,
        normalization: metadata.normalization,
        status: metadata.status,
        reason: metadata.reason,
        dimensions: definition.dimensions,
        valueCount: metadata.valueCount,
        contentSha256: createHash("sha256")
          .update(
            canonicalMetricRecordJson({
              schema: "stored-listening-feature/v1",
              feature,
            }),
          )
          .digest("hex"),
        grid: metadata.grid,
        coveredSamples: metadata.coveredSamples,
        expectedSamples: metadata.expectedSamples,
        ...(metadata.channelReasons
          ? { channelReasons: metadata.channelReasons }
          : {}),
      });
      rows.set(key, row);
      continue;
    }
    const partialSummary =
      feature.values !== null &&
      !definition.grid &&
      target !== undefined &&
      (segment.startBeat < target.range.startBeat ||
        segment.endBeat > target.range.endBeat);
    const unavailable = feature.values === null || partialSummary;
    const cells =
      detail === "evidence"
        ? []
        : unavailable
          ? [null]
          : definition.grid
            ? (feature.grid?.cells ?? [])
            : [null];
    for (const [index, cell] of cells.entries()) {
      const startBeat = segment.startBeat + (cell?.startBeat ?? 0);
      const endBeat = cell ? segment.startBeat + cell.endBeat : segment.endBeat;
      if (
        target &&
        (endBeat <= target.range.startBeat || startBeat >= target.range.endBeat)
      )
        continue;
      const kind = unavailable
        ? "availability"
        : definition.grid
          ? "interval"
          : "segment-summary";
      const key = `${segment.id}:${kind}:${startBeat}:${endBeat}`;
      const row: AnalysisTimelineItem = rows.get(key) ?? {
        ...base,
        ...bounds(startBeat, endBeat),
        kind,
        features: [],
        supportCoordinate: "segment-relative-samples" as const,
      };
      const sampleStart =
        ((startBeat - segment.startBeat) /
          (segment.endBeat - segment.startBeat)) *
        feature.expectedSamples;
      const sampleEnd =
        ((endBeat - segment.startBeat) /
          (segment.endBeat - segment.startBeat)) *
        feature.expectedSamples;
      const extent = (
        support: readonly (readonly [number, number])[],
      ): [number, number] | null => {
        let start = Infinity,
          end = -Infinity;
        for (const [left, right] of support)
          if (right > sampleStart && left < sampleEnd) {
            start = Math.min(start, left);
            end = Math.max(end, right);
          }
        return Number.isFinite(start) ? [start, end] : null;
      };
      row.features.push({
        type: feature.type,
        units: feature.units,
        normalization: feature.normalization,
        dimensions: dimensionLabels(feature),
        status: partialSummary ? "unavailable" : feature.status,
        reason: partialSummary
          ? "partial-segment-summary-not-aggregated"
          : (cell?.reason ?? feature.reason),
        values: unavailable
          ? null
          : (feature.values?.slice(
              index * definition.dimensions,
              (index + 1) * definition.dimensions,
            ) ?? null),
        coveredSamples: cell?.coveredSamples ?? feature.coveredSamples,
        expectedSamples: cell?.expectedSamples ?? feature.expectedSamples,
        supportExtent: extent(feature.support),
        ...(feature.channelReasons
          ? { channelReasons: cell?.channelReasons ?? feature.channelReasons }
          : {}),
        ...(cell?.channelCoveredSamples
          ? { channelCoveredSamples: cell.channelCoveredSamples }
          : {}),
      });
      rows.set(key, row);
    }
    if (detail !== "evidence") continue;
    const detailBase = {
      ...base,
      ...bounds(segment.startBeat, segment.endBeat),
      features: [],
      featureType: feature.type,
    };
    details.push({
      ...detailBase,
      kind: "feature-metadata",
      featureRecord: projectListeningFeatureRecord(record),
      definition,
      profileKey: feature.profileKey,
      featureStatus: partialSummary ? "unavailable" : feature.status,
      reason: partialSummary
        ? "partial-segment-summary-not-aggregated"
        : feature.reason,
      limitations: feature.limitations,
      ...(featureReadTarget ? { readTarget: featureReadTarget } : {}),
    });
    const supports = [
      { channel: "aggregate" as const, values: feature.support },
      ...(feature.channelSupport
        ? [
            { channel: "left" as const, values: feature.channelSupport[0] },
            { channel: "right" as const, values: feature.channelSupport[1] },
          ]
        : []),
    ];
    for (const { channel, values } of supports)
      for (const [offset, support] of values.entries()) {
        const startBeat =
          segment.startBeat +
          (support[0] / feature.expectedSamples) *
            (segment.endBeat - segment.startBeat);
        const endBeat =
          segment.startBeat +
          (support[1] / feature.expectedSamples) *
            (segment.endBeat - segment.startBeat);
        if (
          target &&
          (endBeat <= target.range.startBeat ||
            startBeat >= target.range.endBeat)
        )
          continue;
        details.push({
          ...detailBase,
          ...bounds(startBeat, endBeat),
          kind: "support",
          support,
          supportCoordinate: "segment-relative-samples",
          supportChannel: channel,
          supportOffset: offset,
        });
      }
  }
  const rank = {
    "segment-summary": 0,
    interval: 1,
    availability: 2,
    "feature-metadata": 3,
    "feature-shapes": 3,
    support: 4,
  };
  const ordered = [...rows.values(), ...details].sort(
    (a, b) =>
      a.segment.startBeat - b.segment.startBeat ||
      rank[a.kind] - rank[b.kind] ||
      a.startBeat - b.startBeat,
  );
  return ordered.flatMap((row) => {
    if (new TextEncoder().encode(JSON.stringify(row)).byteLength <= 2048)
      return [row];
    const groupBlocks = <T>(
      blocks: readonly T[],
      build: (items: T[]) => AnalysisTimelineItem,
    ): AnalysisTimelineItem[] => {
      const groups: T[][] = [];
      for (const block of blocks) {
        const last = groups.at(-1);
        if (
          last &&
          new TextEncoder().encode(JSON.stringify(build([...last, block])))
            .byteLength <= 1984
        )
          last.push(block);
        else groups.push([block]);
      }
      return groups.map((items, index) => ({
        ...build(items),
        fragment: index,
        fragmentCount: groups.length,
        complete: index === groups.length - 1,
      }));
    };
    if (row.featureShapes)
      return groupBlocks(row.featureShapes, (featureShapes) => ({
        ...row,
        featureShapes,
      }));
    if (row.kind === "feature-metadata") {
      const fragments = [
        { ...row, limitations: [] },
        ...(row.limitations ?? []).map((limitation) => ({
          ...row,
          profileKey: undefined,
          featureRecord: undefined,
          definition: undefined,
          limitations: [limitation],
        })),
      ];
      return fragments.map((fragment, index) => ({
        ...fragment,
        fragment: index,
        fragmentCount: fragments.length,
        complete: index === fragments.length - 1,
      }));
    }
    if (row.features.length === 0) return [row];
    const size = (features: typeof row.features) =>
      new TextEncoder().encode(JSON.stringify({ ...row, features })).byteLength;
    const blocks = row.features.flatMap((feature) => {
      if (size([feature]) <= 1984) return [feature];
      const fragments: typeof row.features = [];
      let offset = 0;
      while (offset < feature.dimensions.length) {
        let end = offset + 1;
        const fragment = (end: number) => ({
          ...feature,
          dimensionOffset: offset,
          totalDimensions: feature.dimensions.length,
          dimensions: feature.dimensions.slice(offset, end),
          values: feature.values?.slice(offset, end) ?? null,
        });
        while (
          end < feature.dimensions.length &&
          size([fragment(end + 1)]) <= 1984
        )
          end++;
        fragments.push(fragment(end));
        offset = end;
      }
      return fragments;
    });
    return groupBlocks(blocks, (features) => ({ ...row, features }));
  });
}

export function projectListeningOverview(
  views: readonly ListeningAnalysisFeature[],
  target: CaptureAnalysisTarget,
): z.infer<typeof analysisOverviewSchema> {
  return LISTENING_FEATURE_DEFINITIONS.filter(
    (definition) =>
      target.featureTypes === undefined ||
      target.featureTypes.includes(definition.type),
  ).map((definition) => {
    const selected = views.filter(
      ({ record }) => record.feature.type === definition.type,
    );
    const values: (number | null)[] = [];
    let expectedValues = 0;
    for (const {
      record: { feature },
      segment,
    } of selected) {
      if (definition.grid) {
        for (const [index, cell] of (feature.grid?.cells ?? []).entries()) {
          if (
            segment.startBeat + cell.endBeat <= target.range.startBeat ||
            segment.startBeat + cell.startBeat >= target.range.endBeat
          )
            continue;
          expectedValues += definition.dimensions;
          values.push(
            ...(feature.values?.slice(
              index * definition.dimensions,
              (index + 1) * definition.dimensions,
            ) ?? []),
          );
        }
      } else if (
        segment.startBeat >= target.range.startBeat &&
        segment.endBeat <= target.range.endBeat
      ) {
        expectedValues += definition.dimensions;
        values.push(...(feature.values ?? []));
      }
    }
    const valid = values.filter((value): value is number => value !== null);
    return {
      type: definition.type,
      units: definition.units,
      basis: definition.grid
        ? ("grid-cells" as const)
        : ("segment-summaries" as const),
      availableSegments: selected.filter(
        ({ record }) => record.feature.status === "ready",
      ).length,
      totalSegments: selected.length,
      validValues: valid.length,
      expectedValues,
      minimum: valid.length ? valid.reduce((a, b) => Math.min(a, b)) : null,
      maximum: valid.length ? valid.reduce((a, b) => Math.max(a, b)) : null,
      reason: valid.length
        ? null
        : [
            ...new Set(
              selected
                .map(({ record }) => record.feature.reason)
                .filter((reason) => reason !== null),
            ),
          ]
            .join("; ")
            .slice(0, 512) ||
          (!definition.grid &&
          selected.some(
            ({ segment }) =>
              segment.startBeat < target.range.startBeat ||
              segment.endBeat > target.range.endBeat,
          )
            ? "partial-segment-summary-not-aggregated"
            : "unavailable-for-selected-extent"),
    };
  });
}
export const contextFeatureDerivationViewSchema = z
  .strictObject(contextFeatureDerivationSchema.shape)
  .omit({ featureIds: true })
  .extend({
    featureCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTEXT_FEATURES_PER_DERIVATION),
  })
  .superRefine((value, context) => {
    if (
      (value.status === "ready" &&
        (value.featureCount === 0 || value.reason !== null)) ||
      (value.status === "pending" &&
        (value.featureCount !== 0 || value.reason !== null)) ||
      (!["ready", "pending"].includes(value.status) && value.reason === null) ||
      (["failed", "cancelled"].includes(value.status) &&
        value.featureCount !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid derivation summary",
      });
  });

export function projectListeningFeatureDerivation(
  derivation: ContextFeatureDerivation,
) {
  const { featureIds, ...metadata } = derivation;
  return contextFeatureDerivationViewSchema.parse({
    ...metadata,
    featureCount: featureIds.length,
  });
}
const index = z.number().int().min(0).max(2000);
const channelSupportCountsSchema = z.tuple([
  index.max(MAX_ANALYZER_FRAMES),
  index.max(MAX_ANALYZER_FRAMES),
]);
const gridMetadataSchema = z
  .strictObject(listeningFeatureGridSchema.shape)
  .omit({ cells: true })
  .extend({
    cellCount: index,
  });
function featureShapeMetadataValid(
  feature: Pick<
    ListeningFeature,
    | "type"
    | "units"
    | "normalization"
    | "status"
    | "reason"
    | "coveredSamples"
    | "expectedSamples"
    | "channelReasons"
  > & { valueCount: number; grid: { cellCount: number } | null },
): boolean {
  const definition = listeningFeatureDefinition(feature.type);
  const count = definition.grid ? (feature.grid?.cellCount ?? 0) : 1;
  const channelAware =
    definition.profile === "pitch-profile/v1" ||
    definition.profile === "spectral-shape-profile/v1";
  return (
    feature.units === definition.units &&
    feature.normalization === definition.normalization &&
    channelAware === (feature.channelReasons !== undefined) &&
    feature.coveredSamples <= feature.expectedSamples &&
    (definition.grid || feature.grid === null) &&
    (feature.status !== "ready" ||
      (feature.reason === null &&
        count > 0 &&
        feature.valueCount === count * definition.dimensions)) &&
    (feature.status !== "unavailable" ||
      (feature.reason !== null && feature.valueCount === 0))
  );
}
const featureIdentitySchema = z
  .strictObject(listeningFeatureSchema.shape)
  .omit({
    values: true,
    support: true,
    channelSupport: true,
    grid: true,
    profileKey: true,
    limitations: true,
  });
const featureMetadataSchema = featureIdentitySchema
  .extend({
    valueCount: z
      .number()
      .int()
      .min(0)
      .max(2000 * 48),
    supportIntervalCount: index,
    channelSupportIntervalCounts: channelSupportCountsSchema.optional(),
    grid: gridMetadataSchema.nullable(),
  })
  .superRefine((feature, context) => {
    const definition = listeningFeatureDefinition(feature.type);
    const channelAware =
      definition.profile === "pitch-profile/v1" ||
      definition.profile === "spectral-shape-profile/v1";
    if (
      feature.distanceDefinition !== definition.distanceDefinition ||
      feature.distanceUnits !== definition.distanceUnits ||
      feature.profile !== definition.profile ||
      channelAware !== (feature.channelSupportIntervalCounts !== undefined) ||
      !featureShapeMetadataValid(feature)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid canonical feature metadata",
      });
  });
export const contextFeatureMetadataSchema = z
  .strictObject(contextFeatureSchema.shape)
  .extend({
    feature: featureMetadataSchema,
  });

export const listeningFeaturePageSchema = z
  .strictObject({
    offset: index,
    limit: z.number().int().min(1).max(MAX_FEATURE_PAGE_CELLS),
    totalCells: index,
    nextOffset: index.nullable(),
    dimensions: z.number().int().min(1).max(48),
    values: z
      .array(listeningFeatureSchema.shape.values.unwrap().element)
      .max(MAX_FEATURE_PAGE_CELLS * 48)
      .nullable(),
    cells: z
      .array(listeningFeatureGridSchema.shape.cells.element)
      .max(MAX_FEATURE_PAGE_CELLS),
    supportOffset: index,
    supportIntervals: listeningFeatureSchema.shape.support.max(
      MAX_FEATURE_PAGE_CELLS,
    ),
    totalSupportIntervals: index,
    nextSupportOffset: index.nullable(),
    channelSupportIntervals: z
      .tuple([
        listeningFeatureSchema.shape.support.max(MAX_FEATURE_PAGE_CELLS),
        listeningFeatureSchema.shape.support.max(MAX_FEATURE_PAGE_CELLS),
      ])
      .optional(),
    totalChannelSupportIntervals: channelSupportCountsSchema.optional(),
    nextChannelSupportOffsets: z
      .tuple([index.nullable(), index.nullable()])
      .optional(),
    profileKey: listeningFeatureSchema.shape.profileKey,
    limitations: listeningFeatureSchema.shape.limitations,
  })
  .superRefine((page, context) => {
    const {
      channelSupportIntervals,
      totalChannelSupportIntervals,
      nextChannelSupportOffsets,
    } = page;
    if (
      channelSupportIntervals !== undefined ||
      totalChannelSupportIntervals !== undefined ||
      nextChannelSupportOffsets !== undefined
    ) {
      if (
        channelSupportIntervals === undefined ||
        totalChannelSupportIntervals === undefined ||
        nextChannelSupportOffsets === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Incomplete channel support page",
        });
      } else {
        for (const channel of [0, 1] as const) {
          const total = totalChannelSupportIntervals[channel];
          const count = Math.max(
            0,
            Math.min(page.limit, total - page.supportOffset),
          );
          if (
            channelSupportIntervals[channel].length !== count ||
            nextChannelSupportOffsets[channel] !==
              (page.supportOffset + count < total
                ? page.supportOffset + count
                : null)
          )
            context.addIssue({
              code: "custom",
              message: "Invalid channel support continuation",
            });
        }
      }
    }
    const count = Math.max(
      0,
      Math.min(page.limit, page.totalCells - page.offset),
    );
    const supportCount = Math.max(
      0,
      Math.min(page.limit, page.totalSupportIntervals - page.supportOffset),
    );
    if (
      (page.values !== null &&
        page.values.length !== count * page.dimensions) ||
      (page.cells.length !== 0 && page.cells.length !== count) ||
      page.supportIntervals.length !== supportCount ||
      page.nextOffset !==
        (page.offset + count < page.totalCells ? page.offset + count : null) ||
      page.nextSupportOffset !==
        (page.supportOffset + supportCount < page.totalSupportIntervals
          ? page.supportOffset + supportCount
          : null)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid feature value/support page continuation",
      });
  });

export function listeningFeaturePageMasksMatch(
  feature: z.infer<typeof featureMetadataSchema>,
  page: z.infer<typeof listeningFeaturePageSchema>,
): boolean {
  const definition = listeningFeatureDefinition(feature.type);
  const channelAware = feature.channelReasons !== undefined;
  if (
    page.cells.some(
      (cell) =>
        channelAware !== (cell.channelReasons !== undefined) ||
        channelAware !== (cell.channelCoveredSamples !== undefined) ||
        (cell.reason === null &&
          cell.coveredSamples !== cell.expectedSamples) ||
        cell.channelCoveredSamples?.some(
          (covered, channel) =>
            covered > cell.coveredSamples ||
            (cell.channelReasons?.[channel] === null &&
              covered !== cell.expectedSamples),
        ),
    )
  )
    return false;
  return (
    page.values === null ||
    page.values.every((value, index) => {
      const channel = index % definition.dimensions;
      const cell = page.cells[Math.floor(index / definition.dimensions)];
      const reason = definition.grid
        ? channelAware
          ? cell?.channelReasons?.[channel]
          : cell?.reason
        : channelAware
          ? feature.channelReasons?.[channel]
          : null;
      return (value === null) === (reason !== null);
    })
  );
}

export function projectListeningFeatureRecord(record: ContextFeature) {
  const { values, support, channelSupport, grid } = record.feature;
  const metadata = featureIdentitySchema.strip().parse(record.feature);
  const gridMetadata =
    grid === null
      ? null
      : {
          stepBeats: grid.stepBeats,
          meter: grid.meter,
          phaseBeats: grid.phaseBeats,
          cellCount: grid.cells.length,
        };
  return contextFeatureMetadataSchema.parse({
    ...record,
    feature: {
      ...metadata,
      valueCount: values?.length ?? 0,
      supportIntervalCount: support.length,
      ...(channelSupport === undefined
        ? {}
        : {
            channelSupportIntervalCounts: channelSupport.map(
              (intervals) => intervals.length,
            ),
          }),
      grid: gridMetadata,
    },
  });
}

export function projectListeningFeaturePage(
  feature: ListeningFeature,
  offset: number,
  limit: number,
  supportOffset: number,
) {
  const definition = listeningFeatureDefinition(feature.type);
  const totalCells = definition.grid ? (feature.grid?.cells.length ?? 0) : 1;
  const end = Math.min(totalCells, offset + limit);
  const supportEnd = Math.min(feature.support.length, supportOffset + limit);
  return listeningFeaturePageSchema.parse({
    offset,
    limit,
    totalCells,
    nextOffset: end < totalCells ? end : null,
    dimensions: definition.dimensions,
    values:
      feature.values?.slice(
        offset * definition.dimensions,
        end * definition.dimensions,
      ) ?? null,
    cells: feature.grid?.cells.slice(offset, end) ?? [],
    supportOffset,
    supportIntervals: feature.support.slice(supportOffset, supportEnd),
    totalSupportIntervals: feature.support.length,
    nextSupportOffset: supportEnd < feature.support.length ? supportEnd : null,
    ...(feature.channelSupport === undefined
      ? {}
      : {
          channelSupportIntervals: feature.channelSupport.map((intervals) =>
            intervals.slice(supportOffset, supportOffset + limit),
          ),
          totalChannelSupportIntervals: feature.channelSupport.map(
            (intervals) => intervals.length,
          ),
          nextChannelSupportOffsets: feature.channelSupport.map((intervals) =>
            supportOffset + limit < intervals.length
              ? supportOffset + limit
              : null,
          ),
        }),
    profileKey: feature.profileKey,
    limitations: feature.limitations,
  });
}
