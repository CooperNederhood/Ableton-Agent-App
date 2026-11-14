import { z } from "zod";
import {
  metricAudioObservationSchema,
  metricObservationMetricSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";
import {
  metricRecordStreamManifestSchema,
  type MetricRecordStreamManifest,
} from "./metric-record-stream.js";
import {
  MAX_CONTINUOUS_METRIC_REPORT_ROWS,
  MAX_CONTINUOUS_METRIC_SPECTRUM_RECORDS,
  MAX_CONTINUOUS_METRIC_ATTACK_RECORDS,
} from "./metric-continuous-geometry.js";

const metricIds = ["level", "spectral-centroid", "attacks"] as const;
const gapReasons = [
  "unavailable",
  "malformed-record",
  "sequence-gap",
  "overflow",
  "drain-timeout",
  "dependency-unavailable",
  "capture-failed",
  "cancelled",
] as const;
const metricRecordLimits = {
  level: MAX_CONTINUOUS_METRIC_REPORT_ROWS,
  "spectral-centroid": MAX_CONTINUOUS_METRIC_SPECTRUM_RECORDS,
  attacks: MAX_CONTINUOUS_METRIC_ATTACK_RECORDS,
  "mel-bands": Math.floor((48_000 * 600) / 2048),
  pitch: Math.floor((48_000 * 600) / 2048),
  "spectral-shape": Math.floor((48_000 * 600) / 2048),
} as const;
const summaryCount = z
  .number()
  .int()
  .min(0)
  .max(MAX_CONTINUOUS_METRIC_REPORT_ROWS);

const metricSummarySchema = z
  .strictObject({
    metric: metricObservationMetricSchema,
    status: z.enum(["complete", "partial", "failed", "not-requested"]),
    expectedRecords: summaryCount,
    retainedRecords: summaryCount,
    missingRecords: summaryCount,
    gapReasons: z.array(z.enum(gapReasons)).max(gapReasons.length),
  })
  .superRefine((value, ctx) => {
    if (
      value.retainedRecords + value.missingRecords !== value.expectedRecords ||
      value.expectedRecords > metricRecordLimits[value.metric] ||
      new Set(value.gapReasons).size !== value.gapReasons.length ||
      (value.missingRecords === 0) !== (value.gapReasons.length === 0) ||
      (value.status === "complete" && value.missingRecords !== 0) ||
      (value.status === "failed" && value.retainedRecords !== 0) ||
      (value.status === "partial" &&
        (value.retainedRecords === 0 || value.missingRecords === 0)) ||
      (value.status === "not-requested" && value.expectedRecords !== 0)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Metric lifecycle summary must preserve actual indexed coverage",
      });
  });

export const metricListeningResultSummarySchema = z
  .strictObject({
    listenerId: z.string().min(1).max(128),
    outcome: z.enum(["complete", "partial"]),
    nativeStatus: z.enum(["completed", "failed"]).optional(),
    metrics: z
      .array(metricSummarySchema)
      .min(metricIds.length)
      .max(metricIds.length + 3),
  })
  .superRefine((value, ctx) => {
    const requested = value.metrics.filter(
      (metric) => metric.status !== "not-requested",
    );
    if (
      new Set(value.metrics.map((metric) => metric.metric)).size !==
        value.metrics.length ||
      !metricIds.every((id) =>
        value.metrics.some((metric) => metric.metric === id),
      ) ||
      value.metrics.some(
        (metric) =>
          ["mel-bands", "pitch", "spectral-shape"].includes(metric.metric) &&
          metric.status === "not-requested",
      ) ||
      !requested.some(
        (metric) =>
          metric.retainedRecords > 0 ||
          (["mel-bands", "pitch", "spectral-shape"].includes(metric.metric) &&
            metric.status === "complete" &&
            metric.expectedRecords === 0),
      ) ||
      (value.outcome === "complete") !==
        (value.nativeStatus !== "failed" &&
          requested.every((metric) => metric.status === "complete"))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Published outcome must match useful requested metric coverage",
      });
  });
export type MetricListeningResultSummary = z.infer<
  typeof metricListeningResultSummarySchema
>;
export const metricListeningResultSummariesSchema = z
  .array(metricListeningResultSummarySchema)
  .min(1)
  .max(8)
  .refine(
    (values) =>
      new Set(values.map((value) => value.listenerId)).size === values.length,
    "Metric summaries require distinct listeners",
  );

export function validateMetricListeningJobOutcome(
  job: {
    readonly stage: string;
    readonly contextIds: readonly string[];
    readonly metricResults?:
      readonly MetricListeningResultSummary[] | undefined;
    readonly error?: string | undefined;
    readonly failureEvidence?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  const summaries = job.metricResults;
  if (
    (job.stage === "partial" &&
      (summaries === undefined ||
        !summaries.some((result) => result.outcome === "partial") ||
        job.contextIds.length !== summaries.length ||
        job.error !== undefined ||
        job.failureEvidence !== undefined)) ||
    (job.stage === "completed" &&
      summaries !== undefined &&
      (summaries.some((result) => result.outcome !== "complete") ||
        job.contextIds.length !== summaries.length))
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Published metric lifecycle requires matching contexts and honest outcomes",
    });
}

export function summarizeMetricListeningResult(input: MetricAudioObservation) {
  const observation = metricAudioObservationSchema.parse(input);
  const mel = observation.metrics["mel-bands"];
  return metricListeningResultSummarySchema.parse({
    listenerId: observation.ownership.listenerId,
    outcome: observation.outcome,
    metrics: [
      ...metricIds.map((metric) => {
        const timeline = observation.metrics[metric];
        return {
          metric,
          status: timeline.status,
          expectedRecords: timeline.expectedRecords,
          retainedRecords: timeline.records.length,
          missingRecords: timeline.gaps.reduce(
            (sum, gap) => sum + gap.count,
            0,
          ),
          gapReasons: [...new Set(timeline.gaps.map((gap) => gap.reason))],
        };
      }),
      ...(mel === undefined
        ? []
        : [
            {
              metric: "mel-bands",
              status: mel.status,
              expectedRecords: mel.expectedRecords,
              retainedRecords: mel.frames.length,
              missingRecords: mel.gaps.reduce((sum, gap) => sum + gap.count, 0),
              gapReasons: [...new Set(mel.gaps.map((gap) => gap.reason))],
            },
          ]),
      ...(["pitch", "spectral-shape"] as const).flatMap((metric) => {
        const timeline = observation.metrics[metric];
        return timeline === undefined
          ? []
          : [
              {
                metric,
                status: timeline.status,
                expectedRecords: timeline.expectedRecords,
                retainedRecords: timeline.frames.length,
                missingRecords: timeline.gaps.reduce(
                  (sum, gap) => sum + gap.count,
                  0,
                ),
                gapReasons: [
                  ...new Set(timeline.gaps.map((gap) => gap.reason)),
                ],
              },
            ];
      }),
    ],
  });
}

/** Call only after native/durable-prefix verification; never reconstructs records. */
export function summarizeMetricListeningStreamManifest(
  input: MetricRecordStreamManifest,
): MetricListeningResultSummary {
  const manifest = metricRecordStreamManifestSchema.parse(input);
  if (
    manifest.outcome === "failed" ||
    manifest.outcome === "cancelled" ||
    manifest.nativeProof.status === "cancelled"
  )
    throw new RangeError("metric_stream_manifest_not_publishable");
  const summary = (metric: MetricRecordStreamManifest["metrics"][number]) => ({
    metric: metric.metric,
    status: metric.status,
    expectedRecords: metric.expectedRecords,
    retainedRecords: metric.nextRecordOffset,
    missingRecords: metric.missingRecords,
    gapReasons: metric.gapReasons,
  });
  return metricListeningResultSummarySchema.parse({
    listenerId: manifest.ownership.listenerId,
    outcome: manifest.outcome,
    nativeStatus: manifest.nativeProof.status,
    metrics: [
      ...metricIds.map((id) => {
        const metric = manifest.metrics.find((metric) => metric.metric === id);
        return metric === undefined
          ? {
              metric: id,
              status: "not-requested",
              expectedRecords: 0,
              retainedRecords: 0,
              missingRecords: 0,
              gapReasons: [],
            }
          : summary(metric);
      }),
      ...manifest.metrics
        .filter((metric) => !metricIds.some((id) => id === metric.metric))
        .map(summary),
    ],
  });
}
