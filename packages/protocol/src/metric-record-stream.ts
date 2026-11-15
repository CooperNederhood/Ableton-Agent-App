import { z } from "zod";
import {
  metricAudioObservationSchema,
  metricAttackRecordSchema,
  metricLevelRecordSchema,
  metricObservationMetricSchema,
  metricObservationSourceSchema,
  metricSpectralRecordSchema,
  MAX_METRIC_ATTACK_STRENGTH_DB,
  metricAttackStrengthMatches,
} from "./metric-observation-schemas.js";
import {
  pitchTimelineFrameSchema,
  spectralShapeTimelineFrameSchema,
} from "./analyzer-timeline.js";
import {
  pitchProfileSchema,
  spectralShapeProfileSchema,
} from "./analyzer-profile.js";
import { melBandTimelineFrameSchema } from "./mel-band-timeline.js";
import { melBandProfileSchema } from "./mel-band-profile.js";
import {
  metricContinuousListeningGeometrySchema,
  metricContinuousListeningGeometryInputSchema,
  createContinuousMetricListeningGeometry,
  MAX_CONTINUOUS_METRIC_REPORT_ROWS,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "./metric-continuous-geometry.js";
import {
  nativeMetricCompactTimingSchema,
  nativeMetricLaunchProofSchema,
  nativeMetricOwnershipSchema,
  nativeMetricSpectrumCleanupSchema,
  nativeMetricSpectrumPhaseSchema,
  nativeMetricFirstSpectrumEndpoint,
} from "./native-metric-listening-schemas.js";
import {
  assertNativeCheckedTransportSourceCoverage,
  isCoherentNativeTransportClock,
  nativeCheckedTransportClockBindingSchema,
  nativeTransportTimingWitnessesSchema,
} from "./native-listening-v2-schemas.js";
import { encodedJsonBytes } from "./schema-byte-budget.js";
import { listeningTimingPolicySchema } from "./listening-timing-schemas.js";

export const MAX_METRIC_RECORD_CHUNK_BYTES = 128 * 1_024;
export const MAX_METRIC_RECORD_CHUNK_RECORDS = 256;
export const MAX_METRIC_RECORD_PENDING_CHUNKS = 8;
export const MAX_METRIC_RECORD_MANIFEST_BYTES = 128 * 1_024;
export const metricRecordStreamCapabilitySchema = z.strictObject({
  capability: z.literal(METRIC_CONTINUOUS_LISTENING_CAPABILITY),
  mode: z.literal("arrangement"),
  maxDurationSeconds: z.literal(600),
  maxListeners: z.literal(1),
  maxChunkBytes: z.literal(MAX_METRIC_RECORD_CHUNK_BYTES),
  maxChunkRecords: z.literal(MAX_METRIC_RECORD_CHUNK_RECORDS),
  maxPendingChunks: z.literal(MAX_METRIC_RECORD_PENDING_CHUNKS),
  metrics: z.tuple([
    z.literal("level"),
    z.literal("spectral-centroid"),
    z.literal("attacks"),
    z.literal("mel-bands"),
    z.literal("pitch"),
    z.literal("spectral-shape"),
  ]),
  terminal: z.literal("manifest-only"),
});
export type MetricRecordStreamCapability = z.infer<
  typeof metricRecordStreamCapabilitySchema
>;
export const METRIC_RECORD_STREAM_CAPABILITY = Object.freeze(
  metricRecordStreamCapabilitySchema.parse({
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    mode: "arrangement",
    maxDurationSeconds: 600,
    maxListeners: 1,
    maxChunkBytes: MAX_METRIC_RECORD_CHUNK_BYTES,
    maxChunkRecords: MAX_METRIC_RECORD_CHUNK_RECORDS,
    maxPendingChunks: MAX_METRIC_RECORD_PENDING_CHUNKS,
    metrics: [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ],
    terminal: "manifest-only",
  }),
);
export const metricRecordDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().min(0).max(MAX_CONTINUOUS_METRIC_REPORT_ROWS);
const index = count.max(MAX_CONTINUOUS_METRIC_REPORT_ROWS - 1);
const support = metricLevelRecordSchema.shape.support;
const ownership = nativeMetricOwnershipSchema;
const availability = z.enum(["available", "unavailable"]);
const gapReason = z.enum([
  "unavailable",
  "malformed-record",
  "sequence-gap",
  "overflow",
  "drain-timeout",
  "dependency-unavailable",
  "capture-failed",
  "cancelled",
]);
const algorithmMetadata = {
  availability,
  unavailableReason: z.string().min(1).max(240).nullable(),
};
const metrics = metricAudioObservationSchema.shape.metrics.shape;

/** Profiles and phase are immutable for the entire continuous acquisition. */
export const metricRecordStreamAlgorithmSchema = z
  .discriminatedUnion("metric", [
    z.strictObject({
      ...algorithmMetadata,
      metric: z.literal("level"),
      algorithm: metrics.level.shape.algorithm,
    }),
    z.strictObject({
      ...algorithmMetadata,
      metric: z.literal("spectral-centroid"),
      algorithm: metrics["spectral-centroid"].shape.algorithm,
    }),
    z.strictObject({
      ...algorithmMetadata,
      metric: z.literal("attacks"),
      algorithm: metrics.attacks.shape.algorithm,
    }),
    z.strictObject({
      ...algorithmMetadata,
      metric: z.literal("mel-bands"),
      algorithm: melBandProfileSchema.nullable(),
    }),
    z.strictObject({
      ...algorithmMetadata,
      metric: z.literal("pitch"),
      algorithm: pitchProfileSchema.nullable(),
    }),
    z.strictObject({
      ...algorithmMetadata,
      metric: z.literal("spectral-shape"),
      algorithm: spectralShapeProfileSchema.nullable(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      (value.availability === "available") !==
        (value.unavailableReason === null) ||
      (value.availability === "available" && value.algorithm === null) ||
      (value.metric === "spectral-centroid" &&
        value.availability === "available" &&
        value.algorithm?.firstFrameEndSample == null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Available metrics require a qualified algorithm and phase",
      });
  });
export type MetricRecordStreamAlgorithm = z.infer<
  typeof metricRecordStreamAlgorithmSchema
>;
export type MetricRecordStreamMetric = z.infer<
  typeof metricObservationMetricSchema
>;

export const metricRecordStreamDescriptorSchema = z
  .strictObject({
    schema: z.literal("metric-record-stream/v1"),
    capability: z.literal(METRIC_CONTINUOUS_LISTENING_CAPABILITY),
    ownership,
    source: metricObservationSourceSchema.options[0],
    geometry: metricContinuousListeningGeometrySchema,
    timingPolicy: listeningTimingPolicySchema,
    requestedMetrics: z.array(metricObservationMetricSchema).min(1).max(6),
    algorithms: z.array(metricRecordStreamAlgorithmSchema).min(1).max(6),
    maxPendingChunks: z
      .number()
      .int()
      .min(1)
      .max(MAX_METRIC_RECORD_PENDING_CHUNKS),
  })
  .superRefine((value, ctx) => {
    const { geometry: g, source } = value;
    if (
      new Set(value.requestedMetrics).size !== value.requestedMetrics.length ||
      new Set(value.algorithms.map((item) => item.metric)).size !==
        value.algorithms.length ||
      value.algorithms.length !== value.requestedMetrics.length ||
      !value.algorithms.every((item) =>
        value.requestedMetrics.includes(item.metric),
      ) ||
      source.transport.startBeat !== g.startBeat ||
      source.transport.endBeat !== g.endBeat ||
      (source.target.kind === "master") !== (source.target.index === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Stream source, metrics and geometry must agree",
      });
    for (const item of value.algorithms) {
      if (
        item.metric === "attacks" &&
        item.algorithm !== null &&
        item.algorithm.windowSamples !== Math.round(g.sampleRate / 10)
      )
        ctx.addIssue({
          code: "custom",
          message: "Attack window must match sample rate",
        });
      if (
        item.metric === "spectral-centroid" &&
        item.algorithm?.firstFrameEndSample != null
      ) {
        const end = item.algorithm.firstFrameEndSample;
        if (end < 2048 || end <= g.startSample || end > g.startSample + 2048)
          ctx.addIssue({
            code: "custom",
            message:
              "FFT phase must be the first full endpoint intersecting the source",
          });
      }
    }
  });
export type MetricRecordStreamDescriptor = z.infer<
  typeof metricRecordStreamDescriptorSchema
>;

/** Compact persisted admission; the complete canonical grid is deterministic. */
export const metricRecordStreamAdmissionSchema = z
  .strictObject({
    ...metricRecordStreamDescriptorSchema.shape,
    schema: z.literal("metric-record-stream-admission/v1"),
    geometry: metricContinuousListeningGeometryInputSchema,
  })
  .superRefine((value, ctx) => {
    try {
      metricRecordStreamDescriptorSchema.parse({
        ...value,
        schema: "metric-record-stream/v1",
        geometry: createContinuousMetricListeningGeometry(value.geometry),
      });
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "invalid_metric_stream_admission",
      });
    }
  });
export type MetricRecordStreamAdmission = z.infer<
  typeof metricRecordStreamAdmissionSchema
>;

export function compactMetricRecordStreamDescriptor(
  input: MetricRecordStreamDescriptor,
): MetricRecordStreamAdmission {
  const descriptor = metricRecordStreamDescriptorSchema.parse(input);
  const g = descriptor.geometry;
  return metricRecordStreamAdmissionSchema.parse({
    ...descriptor,
    schema: "metric-record-stream-admission/v1",
    geometry: {
      captureMode: g.captureMode,
      sampleRate: g.sampleRate,
      vectorSize: g.vectorSize,
      tempoBpm: g.tempoBpm,
      startBeat: g.startBeat,
      endBeat: g.endBeat,
      startSample: g.startSample,
    },
  });
}

export function expandMetricRecordStreamAdmission(
  input: MetricRecordStreamAdmission,
): MetricRecordStreamDescriptor {
  const admission = metricRecordStreamAdmissionSchema.parse(input);
  return metricRecordStreamDescriptorSchema.parse({
    ...admission,
    schema: "metric-record-stream/v1",
    geometry: createContinuousMetricListeningGeometry(admission.geometry),
  });
}

/** Canonical record fields/values/supports; only the continuous index bound differs. */
export const metricStreamLevelRecordSchema = metricLevelRecordSchema.safeExtend(
  { index },
);
export const metricStreamSpectralRecordSchema =
  metricSpectralRecordSchema.safeExtend({ index });
export const metricStreamAttackRecordSchema = metricAttackRecordSchema.extend({
  index,
});
export const metricStreamMelBandRecordSchema = melBandTimelineFrameSchema
  .unwrap()
  .extend({ index })
  .readonly();
export const metricStreamPitchRecordSchema = pitchTimelineFrameSchema
  .unwrap()
  .extend({ index })
  .readonly();
export const metricStreamSpectralShapeRecordSchema =
  spectralShapeTimelineFrameSchema.unwrap().extend({ index }).readonly();
export type MetricStreamLevelRecord = z.infer<
  typeof metricStreamLevelRecordSchema
>;
export type MetricStreamSpectralRecord = z.infer<
  typeof metricStreamSpectralRecordSchema
>;
export type MetricStreamAttackRecord = z.infer<
  typeof metricStreamAttackRecordSchema
>;
export type MetricStreamMelBandRecord = z.infer<
  typeof metricStreamMelBandRecordSchema
>;
export type MetricStreamPitchRecord = z.infer<
  typeof metricStreamPitchRecordSchema
>;
export type MetricStreamSpectralShapeRecord = z.infer<
  typeof metricStreamSpectralShapeRecordSchema
>;

export const metricRecordStreamGapSchema = z.strictObject({
  firstIndex: index,
  count: count.min(1),
  support,
  reason: gapReason,
  detail: z.string().min(1).max(160),
});
export type MetricRecordStreamGap = z.infer<typeof metricRecordStreamGapSchema>;
const chunkBase = {
  schema: z.literal("metric-record-chunk/v1"),
  descriptorDigest: metricRecordDigestSchema,
  ownership,
  chunkSequence: count,
  recordOffset: count,
  slotOffset: count,
  previousDigest: metricRecordDigestSchema,
  digest: metricRecordDigestSchema,
  gaps: z
    .array(metricRecordStreamGapSchema)
    .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
};
export const metricRecordChunkSchema = z
  .discriminatedUnion("metric", [
    z.strictObject({
      ...chunkBase,
      metric: z.literal("level"),
      records: z
        .array(metricStreamLevelRecordSchema)
        .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
    }),
    z.strictObject({
      ...chunkBase,
      metric: z.literal("spectral-centroid"),
      records: z
        .array(metricStreamSpectralRecordSchema)
        .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
    }),
    z.strictObject({
      ...chunkBase,
      metric: z.literal("attacks"),
      records: z
        .array(metricStreamAttackRecordSchema)
        .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
    }),
    z.strictObject({
      ...chunkBase,
      metric: z.literal("mel-bands"),
      records: z
        .array(metricStreamMelBandRecordSchema)
        .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
    }),
    z.strictObject({
      ...chunkBase,
      metric: z.literal("pitch"),
      records: z
        .array(metricStreamPitchRecordSchema)
        .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
    }),
    z.strictObject({
      ...chunkBase,
      metric: z.literal("spectral-shape"),
      records: z
        .array(metricStreamSpectralShapeRecordSchema)
        .max(MAX_METRIC_RECORD_CHUNK_RECORDS),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.records.length + value.gaps.length === 0 ||
      value.records.length + value.gaps.length >
        MAX_METRIC_RECORD_CHUNK_RECORDS ||
      encodedJsonBytes(value) > MAX_METRIC_RECORD_CHUNK_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Metric chunks must contain 1..256 entries and encode to at most 128 KiB",
      });
    for (const entries of [value.records, value.gaps]) {
      let previous = -1;
      for (const entry of entries) {
        const current = "index" in entry ? entry.index : entry.firstIndex;
        if (current <= previous)
          ctx.addIssue({
            code: "custom",
            message: "Chunk records and gaps must be strictly ordered",
          });
        previous = current;
      }
    }
  });
export type MetricRecordChunk = z.infer<typeof metricRecordChunkSchema>;

export const metricRecordStreamMetricStateSchema = z.strictObject({
  metric: metricObservationMetricSchema,
  nextChunkSequence: count,
  nextRecordOffset: count,
  nextIndex: count,
  missingRecords: count,
  gapReasons: z.array(gapReason).max(gapReason.options.length),
  lastDigest: metricRecordDigestSchema,
  lastRecordEndSample:
    metricContinuousListeningGeometrySchema.shape.startSample.nullable(),
  attackReplay: z
    .strictObject({
      previousLevelDb: z
        .number()
        .finite()
        .min(-120)
        .max(MAX_METRIC_ATTACK_STRENGTH_DB - 120),
      lastAttackSample:
        metricContinuousListeningGeometrySchema.shape.startSample.nullable(),
      riseHasAttack: z.boolean(),
    })
    .nullable(),
});
export type MetricRecordStreamMetricState = z.infer<
  typeof metricRecordStreamMetricStateSchema
>;
export const metricRecordStreamStateSchema = z
  .strictObject({
    schema: z.literal("metric-record-stream-state/v1"),
    descriptorDigest: metricRecordDigestSchema,
    metrics: z.array(metricRecordStreamMetricStateSchema).min(1).max(6),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.metrics.map((item) => item.metric)).size !==
        value.metrics.length ||
      value.metrics.some(
        (item) =>
          item.nextIndex !== item.nextRecordOffset + item.missingRecords ||
          (item.nextRecordOffset === 0) !==
            (item.lastRecordEndSample === null) ||
          (item.metric === "attacks") !== (item.attackReplay !== null) ||
          new Set(item.gapReasons).size !== item.gapReasons.length ||
          (item.missingRecords === 0) !== (item.gapReasons.length === 0),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Stream state must preserve independent per-metric coverage",
      });
  });
export type MetricRecordStreamState = z.infer<
  typeof metricRecordStreamStateSchema
>;

/** Application-owned stage events; pure validators do not emit observations. */
export const metricRecordStreamLifecycleSchema = z
  .strictObject({
    schema: z.literal("metric-record-stream-lifecycle/v1"),
    descriptorDigest: metricRecordDigestSchema,
    ownership,
    stage: z.enum([
      "admission",
      "capture",
      "drain",
      "persistence",
      "publication",
      "cleanup",
    ]),
    status: z.enum([
      "queued",
      "started",
      "progress",
      "completed",
      "failed",
      "cancelled",
    ]),
    elapsedMs: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
    requestedSamples: z.number().int().min(1).max(28_800_000),
    capturedSamples: z.number().int().min(0).max(28_800_000).nullable(),
    durablyPersistedSamples: z.number().int().min(0).max(28_800_000).nullable(),
    pendingChunks: z
      .number()
      .int()
      .min(0)
      .max(MAX_METRIC_RECORD_PENDING_CHUNKS)
      .nullable(),
    metric: metricObservationMetricSchema.nullable(),
    chunkSequence: count.nullable(),
    retainedRecords: count,
    missingRecords: count,
    reason: z.string().min(1).max(240).nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (["failed", "cancelled"].includes(value.status) &&
        value.reason === null) ||
      (value.chunkSequence !== null && value.metric === null) ||
      (value.capturedSamples !== null &&
        value.capturedSamples > value.requestedSamples) ||
      (value.durablyPersistedSamples !== null &&
        (value.durablyPersistedSamples > value.requestedSamples ||
          (value.capturedSamples !== null &&
            value.durablyPersistedSamples > value.capturedSamples)))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Stream lifecycle requires attributed reasons, metric chunk progress and bounded captured/durable sample progress",
      });
  });
export type MetricRecordStreamLifecycle = z.infer<
  typeof metricRecordStreamLifecycleSchema
>;

/** Executed native evidence, not a certificate manufactured by schema parsing. */
export const nativeContinuousMetricConfigurationReadbackSchema = z.tuple([
  nativeMetricOwnershipSchema.shape.nativeEpoch,
  z.number().int().min(1).max(28_800_000),
  z.union([z.literal(4_410), z.literal(4_800)]),
  metricContinuousListeningGeometrySchema.shape.tempoBpm,
  z.number().finite().min(0).lt(1),
  metricContinuousListeningGeometrySchema.shape.vectorSize,
  z.literal(1),
  metricContinuousListeningGeometrySchema.shape.startBeat,
  metricContinuousListeningGeometrySchema.shape.endBeat,
  count.min(1),
  nativeMetricOwnershipSchema.shape.nativeEpoch,
  nativeMetricOwnershipSchema.shape.nativeEpoch,
]);
export type NativeContinuousMetricConfigurationReadback = z.infer<
  typeof nativeContinuousMetricConfigurationReadbackSchema
>;

export const metricRecordStreamTerminalProofSchema = z
  .strictObject({
    schema: z.literal("metric-record-stream-terminal/v1"),
    ownership,
    status: z.enum(["completed", "failed", "cancelled"]),
    launch: nativeMetricLaunchProofSchema,
    timing: nativeMetricCompactTimingSchema,
    confirmedTiming: nativeMetricCompactTimingSchema,
    configuration: nativeContinuousMetricConfigurationReadbackSchema,
    confirmedConfiguration: nativeContinuousMetricConfigurationReadbackSchema,
    before: nativeCheckedTransportClockBindingSchema(false),
    after: nativeCheckedTransportClockBindingSchema(true),
    timingWitnesses: nativeTransportTimingWitnessesSchema,
    clock: nativeCheckedTransportClockBindingSchema(true),
    capturedSamples: z.number().int().min(0).max(28_800_000),
    sourceOrigin: metricContinuousListeningGeometrySchema.shape.startSample,
    sourceEnd: metricContinuousListeningGeometrySchema.shape.startSample,
    drain: z.enum(["completed", "failed", "cancelled"]),
    spectrumCleanup: nativeMetricSpectrumCleanupSchema,
    spectrumPhase: nativeMetricSpectrumPhaseSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      canonicalMetricRecordJson(value.ownership) !==
        canonicalMetricRecordJson(value.launch.ownership) ||
      value.launch.timing[6] !== value.sourceOrigin ||
      value.timing[0] !== value.ownership.nativeEpoch ||
      value.timing[1] < 0 ||
      value.timing[3] !== 0 ||
      value.timing[4] < 0 ||
      value.timing[5] !== value.launch.timing[5] ||
      value.timing.some(
        (cell, index) =>
          cell !== value.confirmedTiming[index] ||
          cell !== (index === 3 ? 0 : value.launch.timing[index]),
      ) ||
      value.configuration.some(
        (cell, index) => cell !== value.confirmedConfiguration[index],
      ) ||
      value.timing[6] !== value.sourceOrigin ||
      value.sourceEnd !== value.sourceOrigin + value.capturedSamples ||
      !value.clock.frames.every(isCoherentNativeTransportClock) ||
      value.clock.frames[0]![4] < value.sourceEnd ||
      value.spectrumCleanup.generation !== value.ownership.generation ||
      value.spectrumCleanup.nativeEpoch !== value.ownership.nativeEpoch ||
      value.spectrumCleanup.status !== "completed" ||
      value.spectrumCleanup.stopWatermark === null ||
      value.spectrumCleanup.stopWatermark < value.sourceEnd ||
      (value.status === "completed" && value.drain !== "completed")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Terminal native ownership, source counters, drain and disabled cleanup must agree",
      });
  });
export type MetricRecordStreamTerminalProof = z.infer<
  typeof metricRecordStreamTerminalProofSchema
>;

const summary = metricRecordStreamMetricStateSchema.extend({
  status: z.enum(["complete", "partial", "failed"]),
  expectedRecords: count,
  availability,
  trailingSupport: support.nullable(),
});
export const metricRecordStreamManifestSchema = z
  .strictObject({
    schema: z.literal("metric-record-stream-manifest/v1"),
    descriptorDigest: metricRecordDigestSchema,
    ownership,
    outcome: z.enum(["complete", "partial", "failed", "cancelled"]),
    algorithms: z.array(metricRecordStreamAlgorithmSchema).min(1).max(6),
    metrics: z.array(summary).min(1).max(6),
    nativeProof: metricRecordStreamTerminalProofSchema,
    limitations: z.array(z.string().min(1).max(240)).max(16),
  })
  .superRefine((value, ctx) => {
    if (
      encodedJsonBytes(value) > MAX_METRIC_RECORD_MANIFEST_BYTES ||
      new Set(value.metrics.map((item) => item.metric)).size !==
        value.metrics.length ||
      new Set(value.algorithms.map((item) => item.metric)).size !==
        value.algorithms.length ||
      value.algorithms.length !== value.metrics.length ||
      value.algorithms.some(
        (algorithm) =>
          !value.metrics.some(
            (metric) =>
              metric.metric === algorithm.metric &&
              metric.availability === algorithm.availability,
          ),
      ) ||
      canonicalMetricRecordJson(value.ownership) !==
        canonicalMetricRecordJson(value.nativeProof.ownership) ||
      value.metrics.some(
        (item) =>
          item.nextIndex !== item.expectedRecords ||
          item.nextRecordOffset + item.missingRecords !==
            item.expectedRecords ||
          item.status !==
            metricStatus(
              item.availability,
              item.nextRecordOffset,
              item.missingRecords,
            ) ||
          new Set(item.gapReasons).size !== item.gapReasons.length ||
          (item.missingRecords === 0) !== (item.gapReasons.length === 0),
      ) ||
      value.outcome !==
        (value.nativeProof.status === "cancelled"
          ? "cancelled"
          : value.nativeProof.status === "completed" &&
              value.metrics.every((item) => item.status === "complete")
            ? "complete"
            : value.metrics.some(
                  (item) =>
                    item.nextRecordOffset > 0 || item.status === "complete",
                )
              ? "partial"
              : "failed")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Manifest must preserve honest counts, availability, outcome and terminal native proof",
      });
  });
export type MetricRecordStreamManifest = z.infer<
  typeof metricRecordStreamManifestSchema
>;

function metricStatus(available: string, retained: number, missing: number) {
  return available === "unavailable"
    ? "failed"
    : missing === 0
      ? "complete"
      : retained === 0
        ? "failed"
        : "partial";
}

/** Stable sorted-key JSON; hashes are integrity bindings, never authentication. */
export function canonicalMetricRecordJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalMetricRecordJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${canonicalMetricRecordJson(child)}`,
    )
    .join(",")}}`;
}

export async function metricRecordDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalMetricRecordJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function metricRecordStreamDescriptorDigest(
  input: MetricRecordStreamDescriptor,
): Promise<string> {
  return metricRecordDigest(metricRecordStreamDescriptorSchema.parse(input));
}

export async function metricRecordChunkDigest(
  input: MetricRecordChunk,
): Promise<string> {
  const body: Partial<MetricRecordChunk> = metricRecordChunkSchema.parse(input);
  delete body.digest;
  return metricRecordDigest(body);
}

export function encodeMetricRecordChunk(input: MetricRecordChunk): string {
  return canonicalMetricRecordJson(metricRecordChunkSchema.parse(input));
}

/** Reject before JSON parsing; encoded bounds include whitespace and escapes. */
export function parseMetricRecordChunkWire(
  input: string | Uint8Array,
): MetricRecordChunk {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_METRIC_RECORD_CHUNK_BYTES)
    throw new RangeError("metric_stream_chunk_wire_byte_limit");
  return metricRecordChunkSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

export async function createMetricRecordStreamState(
  input: MetricRecordStreamDescriptor,
): Promise<MetricRecordStreamState> {
  const descriptor = metricRecordStreamDescriptorSchema.parse(input);
  const descriptorDigest = await metricRecordStreamDescriptorDigest(descriptor);
  return metricRecordStreamStateSchema.parse({
    schema: "metric-record-stream-state/v1",
    descriptorDigest,
    metrics: descriptor.requestedMetrics.map((metric) => ({
      metric,
      nextChunkSequence: 0,
      nextRecordOffset: 0,
      nextIndex: 0,
      missingRecords: 0,
      gapReasons: [],
      lastDigest: descriptorDigest,
      lastRecordEndSample: null,
      attackReplay:
        metric === "attacks"
          ? {
              previousLevelDb: -120,
              lastAttackSample: null,
              riseHasAttack: false,
            }
          : null,
    })),
  });
}

export function metricRecordStreamExpectedCoverage(
  descriptor: MetricRecordStreamDescriptor,
  metric: MetricRecordStreamMetric,
): {
  expectedRecords: number;
  trailingSupport: z.infer<typeof support> | null;
} {
  const g = descriptor.geometry;
  const definition = descriptor.algorithms.find(
    (item) => item.metric === metric,
  );
  if (!definition) throw new Error("metric_stream_unrequested_metric");
  if (metric === "level")
    return { expectedRecords: g.rows.length, trailingSupport: null };
  if (metric === "attacks")
    return {
      expectedRecords: Math.ceil(
        g.totalSamples / Math.round(g.sampleRate / 10),
      ),
      trailingSupport: null,
    };
  let first = g.startSample + 2048;
  if (definition.metric === "spectral-centroid") {
    const phase = definition.algorithm?.firstFrameEndSample;
    if (phase == null)
      return {
        expectedRecords: 0,
        trailingSupport: { startSample: g.startSample, endSample: g.endSample },
      };
    first = phase;
  }
  const expectedRecords = Math.max(
    0,
    Math.floor((g.endSample - first) / 2048) + 1,
  );
  const trailingStart =
    expectedRecords === 0
      ? g.startSample
      : first + (expectedRecords - 1) * 2048;
  return {
    expectedRecords,
    trailingSupport:
      trailingStart < g.endSample
        ? { startSample: trailingStart, endSample: g.endSample }
        : null,
  };
}

/** An aborted acquisition's physical trailing samples are not a padded record. */
export function metricRecordStreamCapturedTrailingSupport(
  descriptor: MetricRecordStreamDescriptor,
  metric: MetricRecordStreamMetric,
  sourceEnd = descriptor.geometry.endSample,
): z.infer<typeof support> | null {
  const g = descriptor.geometry;
  if (!descriptor.requestedMetrics.includes(metric))
    throw new Error("metric_stream_unrequested_metric");
  if (
    !Number.isSafeInteger(sourceEnd) ||
    sourceEnd < g.startSample ||
    sourceEnd > g.endSample
  )
    throw new RangeError("metric_stream_captured_support_outside_geometry");
  if (sourceEnd === g.startSample) return null;
  if (sourceEnd === g.endSample)
    return metricRecordStreamExpectedCoverage(descriptor, metric)
      .trailingSupport;
  if (metric === "level") {
    const row = g.rows.find(
      (row) => row.startSample < sourceEnd && row.endSample > sourceEnd,
    );
    return row ? { startSample: row.startSample, endSample: sourceEnd } : null;
  }
  if (metric === "attacks") {
    const hop = Math.round(g.sampleRate / 10);
    const startSample =
      g.startSample + Math.floor((sourceEnd - g.startSample) / hop) * hop;
    return startSample === sourceEnd
      ? null
      : { startSample, endSample: sourceEnd };
  }
  return metricRecordStreamExpectedCoverage(
    {
      ...descriptor,
      geometry: {
        ...g,
        totalSamples: sourceEnd - g.startSample,
        endSample: sourceEnd,
      },
    },
    metric,
  ).trailingSupport;
}

function slotSupport(
  descriptor: MetricRecordStreamDescriptor,
  metric: MetricRecordStreamMetric,
  slot: number,
) {
  const g = descriptor.geometry;
  if (metric === "level") {
    const row = g.rows[slot];
    if (!row) throw new Error("metric_stream_slot_outside_geometry");
    return { startSample: row.startSample, endSample: row.endSample };
  }
  if (metric === "attacks") {
    const hop = Math.round(g.sampleRate / 10);
    return {
      startSample: g.startSample + slot * hop,
      endSample: Math.min(g.startSample + (slot + 1) * hop, g.endSample),
    };
  }
  const definition = descriptor.algorithms.find(
    (item) => item.metric === metric,
  );
  const first =
    definition?.metric === "spectral-centroid"
      ? definition.algorithm?.firstFrameEndSample
      : g.startSample + 2048;
  if (first == null) throw new Error("metric_stream_unknown_fft_phase");
  return {
    startSample: first + (slot - 1) * 2048,
    endSample: first + slot * 2048,
  };
}

/** Commit returned state with chunk rows in the same transaction. No records are retained here. */
export async function acceptMetricRecordChunk(
  rawDescriptor: MetricRecordStreamDescriptor,
  rawState: MetricRecordStreamState,
  rawChunk: MetricRecordChunk,
): Promise<MetricRecordStreamState> {
  const descriptor = metricRecordStreamDescriptorSchema.parse(rawDescriptor);
  const state = metricRecordStreamStateSchema.parse(rawState);
  const chunk = metricRecordChunkSchema.parse(rawChunk);
  const descriptorDigest = await metricRecordStreamDescriptorDigest(descriptor);
  const previous = state.metrics.find((item) => item.metric === chunk.metric);
  if (
    state.descriptorDigest !== descriptorDigest ||
    chunk.descriptorDigest !== descriptorDigest ||
    !previous ||
    state.metrics.length !== descriptor.requestedMetrics.length ||
    !state.metrics.every((item) =>
      descriptor.requestedMetrics.includes(item.metric),
    ) ||
    canonicalMetricRecordJson(chunk.ownership) !==
      canonicalMetricRecordJson(descriptor.ownership) ||
    chunk.chunkSequence !== previous.nextChunkSequence ||
    chunk.recordOffset !== previous.nextRecordOffset ||
    chunk.slotOffset !== previous.nextIndex ||
    chunk.previousDigest !== previous.lastDigest ||
    chunk.digest !== (await metricRecordChunkDigest(chunk))
  )
    throw new Error("metric_stream_identity_sequence_or_digest_mismatch");
  const definition = descriptor.algorithms.find(
    (item) => item.metric === chunk.metric,
  )!;
  if (definition.availability === "unavailable" && chunk.records.length !== 0)
    throw new Error("metric_stream_unavailable_records");
  const { expectedRecords } = metricRecordStreamExpectedCoverage(
    descriptor,
    chunk.metric,
  );
  const entries = [
    ...chunk.records.map((record) => ({
      index: record.index,
      count: 1,
      support: record.support,
    })),
    ...chunk.gaps.map((gap) => ({
      index: gap.firstIndex,
      count: gap.count,
      support: gap.support,
    })),
  ].sort((a, b) => a.index - b.index);
  let nextIndex = previous.nextIndex;
  for (const entry of entries) {
    if (
      entry.index !== nextIndex ||
      entry.index + entry.count > expectedRecords
    )
      throw new Error("metric_stream_noncontiguous_coverage");
    const start = slotSupport(
      descriptor,
      chunk.metric,
      entry.index,
    ).startSample;
    const end = slotSupport(
      descriptor,
      chunk.metric,
      entry.index + entry.count - 1,
    ).endSample;
    if (entry.support.startSample !== start || entry.support.endSample !== end)
      throw new Error("metric_stream_support_mismatch");
    nextIndex += entry.count;
  }
  if (chunk.metric === "attacks") {
    if (
      chunk.records.length !== 0 &&
      (previous.missingRecords !== 0 ||
        chunk.records.some((record) =>
          chunk.gaps.some((gap) => gap.firstIndex < record.index),
        ))
    )
      throw new Error("metric_stream_attack_history_gap");
    const algorithm =
      definition.metric === "attacks" ? definition.algorithm : null;
    if (chunk.records.length !== 0 && algorithm === null)
      throw new Error("metric_stream_attack_algorithm_missing");
    const replay = previous.attackReplay!;
    for (const record of chunk.records) {
      const level = Math.max(
        ...record.inputLevel.rms.map((rms) =>
          rms <= 10 ** (-120 / 20) ? -120 : 20 * Math.log10(rms),
        ),
      );
      const rise = level - replay.previousLevelDb;
      if (rise <= 0) replay.riseHasAttack = false;
      const detects =
        !replay.riseHasAttack &&
        level > -120 &&
        rise > 0 &&
        rise >= algorithm!.thresholdDb &&
        (replay.lastAttackSample === null ||
          record.support.endSample - replay.lastAttackSample >=
            algorithm!.minSpacingSamples);
      if (
        detects
          ? record.events.length !== 1 ||
            record.events[0]!.sample !== record.support.endSample ||
            !metricAttackStrengthMatches(record.events[0]!.strength, rise)
          : record.events.length !== 0
      )
        throw new Error("metric_stream_attack_replay_mismatch");
      if (detects) {
        replay.lastAttackSample = record.support.endSample;
        replay.riseHasAttack = true;
      }
      replay.previousLevelDb = level;
    }
  }
  if (
    chunk.metric === "spectral-centroid" &&
    chunk.records.some(
      (record) =>
        record.centroidHz !== null &&
        record.centroidHz > descriptor.geometry.sampleRate / 2,
    )
  )
    throw new Error("metric_stream_centroid_above_nyquist");
  const next = {
    ...previous,
    nextChunkSequence: previous.nextChunkSequence + 1,
    nextRecordOffset: previous.nextRecordOffset + chunk.records.length,
    nextIndex,
    missingRecords:
      previous.missingRecords +
      chunk.gaps.reduce((sum, gap) => sum + gap.count, 0),
    gapReasons: [
      ...new Set([
        ...previous.gapReasons,
        ...chunk.gaps.map((gap) => gap.reason),
      ]),
    ],
    lastDigest: chunk.digest,
    lastRecordEndSample:
      chunk.records.at(-1)?.support.endSample ?? previous.lastRecordEndSample,
  };
  return metricRecordStreamStateSchema.parse({
    ...state,
    metrics: state.metrics.map((item) =>
      item.metric === chunk.metric ? next : item,
    ),
  });
}

/** Checks a staged prefix without reconstructing any terminal record arrays. */
export async function verifyMetricRecordStreamManifest(
  rawDescriptor: MetricRecordStreamDescriptor,
  rawState: MetricRecordStreamState,
  rawManifest: MetricRecordStreamManifest,
): Promise<MetricRecordStreamManifest> {
  const descriptor = metricRecordStreamDescriptorSchema.parse(rawDescriptor);
  const state = metricRecordStreamStateSchema.parse(rawState);
  const manifest = metricRecordStreamManifestSchema.parse(rawManifest);
  const digest = await metricRecordStreamDescriptorDigest(descriptor);
  const g = descriptor.geometry;
  if (
    state.descriptorDigest !== digest ||
    manifest.descriptorDigest !== digest ||
    canonicalMetricRecordJson(manifest.ownership) !==
      canonicalMetricRecordJson(descriptor.ownership) ||
    canonicalMetricRecordJson(manifest.algorithms) !==
      canonicalMetricRecordJson(descriptor.algorithms) ||
    manifest.metrics.length !== descriptor.requestedMetrics.length ||
    state.metrics.length !== descriptor.requestedMetrics.length ||
    manifest.nativeProof.sourceOrigin !== g.startSample ||
    manifest.nativeProof.clock.dsp[1] !== g.sampleRate ||
    manifest.nativeProof.clock.dsp[2] !== g.vectorSize ||
    manifest.nativeProof.capturedSamples > g.totalSamples ||
    (manifest.nativeProof.status === "completed" &&
      manifest.nativeProof.capturedSamples !== g.totalSamples)
  )
    throw new Error(
      "metric_stream_manifest_identity_or_native_coverage_mismatch",
    );
  for (const definition of descriptor.algorithms) {
    const item = manifest.metrics.find(
      (item) => item.metric === definition.metric,
    );
    const prefix = state.metrics.find(
      (item) => item.metric === definition.metric,
    );
    const expected = metricRecordStreamExpectedCoverage(
      descriptor,
      definition.metric,
    );
    if (
      !item ||
      !prefix ||
      item.availability !== definition.availability ||
      item.expectedRecords !== expected.expectedRecords ||
      (item.lastRecordEndSample !== null &&
        item.lastRecordEndSample > manifest.nativeProof.sourceEnd) ||
      canonicalMetricRecordJson(item.trailingSupport) !==
        canonicalMetricRecordJson(
          metricRecordStreamCapturedTrailingSupport(
            descriptor,
            definition.metric,
            manifest.nativeProof.sourceEnd,
          ),
        ) ||
      Object.entries(prefix).some(
        ([key, value]) =>
          canonicalMetricRecordJson(item[key as keyof typeof item]) !==
          canonicalMetricRecordJson(value),
      )
    )
      throw new Error("metric_stream_manifest_prefix_or_metadata_mismatch");
  }
  const proof = manifest.nativeProof;
  const epoch = descriptor.ownership.nativeEpoch;
  const configuration = [
    epoch,
    g.totalSamples,
    Math.round(g.sampleRate / 10),
    g.tempoBpm,
    g.startBeat - Math.floor(g.startBeat),
    g.vectorSize,
    1,
    g.startBeat,
    g.endBeat,
    g.rows.length,
    epoch,
    epoch,
  ];
  const launch = proof.launch;
  const timing = launch.timing;
  const before = proof.before;
  const hostOffsetSamples = before.frames[0]![2] - before.frames[0]![4];
  if (
    proof.configuration.some((cell, index) => cell !== configuration[index]) ||
    before.dsp[1] !== g.sampleRate ||
    before.dsp[2] !== g.vectorSize ||
    timing[5] < before.frames.at(-1)![4] ||
    timing[5] - before.frames.at(-1)![4] > g.sampleRate ||
    timing[4] > g.vectorSize ||
    timing[1] < timing[4] ||
    timing[1] > 10 * g.sampleRate ||
    timing[5] + timing[1] - timing[4] !== g.startSample ||
    g.endSample + g.vectorSize >= 2 ** 44 ||
    launch.clock[4] < g.startSample ||
    (timing[3] === 0 && launch.clock[4] < proof.sourceEnd + g.vectorSize - 1) ||
    (descriptor.timingPolicy.mode === "strict" &&
      launch.clock[2] - g.startSample - hostOffsetSamples >
        g.sampleRate / 10 + g.vectorSize)
  )
    throw new Error("metric_stream_native_configuration_or_launch_mismatch");
  assertNativeCheckedTransportSourceCoverage({
    policy: descriptor.timingPolicy,
    geometry: { ...g, totalSamples: proof.capturedSamples },
    before,
    after: proof.after,
    timingWitnesses: proof.timingWitnesses,
    launchedHost: {
      sample: launch.clock[2],
      beat: launch.clock[1],
      flags: launch.clock[3],
      playing: true,
    },
    coordinates: {
      startSample: g.startSample + hostOffsetSamples,
      originCounter: g.startSample,
      hostOffsetSamples,
    },
    additionalClocks: [launch.clock],
    errorPrefix: "native_metric",
  });
  const spectrum = descriptor.algorithms.find(
    (item) => item.metric === "spectral-centroid",
  );
  if (
    spectrum?.metric === "spectral-centroid" &&
    spectrum.availability === "available" &&
    (proof.spectrumPhase === null ||
      canonicalMetricRecordJson(proof.spectrumPhase.ownership) !==
        canonicalMetricRecordJson(descriptor.ownership) ||
      proof.spectrumPhase.clock.dsp[1] !== g.sampleRate ||
      proof.spectrumPhase.clock.dsp[2] !== g.vectorSize ||
      nativeMetricFirstSpectrumEndpoint(proof.spectrumPhase, g.startSample) !==
        spectrum.algorithm?.firstFrameEndSample)
  )
    throw new Error("metric_stream_native_spectrum_phase_mismatch");
  return manifest;
}
