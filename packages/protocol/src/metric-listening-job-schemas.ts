import { z } from "zod";
import {
  metricAudioObservationSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";

const metricIds = ["level", "spectral-centroid", "attacks"] as const;
const gapReasons = [
  "unavailable",
  "malformed-record",
  "sequence-gap",
  "overflow",
  "drain-timeout",
  "dependency-unavailable",
] as const;

const metricSummarySchema = z
  .strictObject({
    metric: z.enum(metricIds),
    status: z.enum(["complete", "partial", "failed", "not-requested"]),
    expectedRecords: z.number().int().min(0).max(2_000),
    retainedRecords: z.number().int().min(0).max(2_000),
    missingRecords: z.number().int().min(0).max(2_000),
    gapReasons: z.array(z.enum(gapReasons)).max(gapReasons.length),
  })
  .superRefine((value, ctx) => {
    if (
      value.retainedRecords + value.missingRecords !== value.expectedRecords ||
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
    metrics: z.array(metricSummarySchema).length(metricIds.length),
  })
  .superRefine((value, ctx) => {
    const requested = value.metrics.filter(
      (metric) => metric.status !== "not-requested",
    );
    if (
      new Set(value.metrics.map((metric) => metric.metric)).size !==
        metricIds.length ||
      !requested.some((metric) => metric.retainedRecords > 0) ||
      (value.outcome === "complete") !==
        requested.every((metric) => metric.status === "complete")
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
  return metricListeningResultSummarySchema.parse({
    listenerId: observation.ownership.listenerId,
    outcome: observation.outcome,
    metrics: metricIds.map((metric) => {
      const timeline = observation.metrics[metric];
      return {
        metric,
        status: timeline.status,
        expectedRecords: timeline.expectedRecords,
        retainedRecords: timeline.records.length,
        missingRecords: timeline.gaps.reduce((sum, gap) => sum + gap.count, 0),
        gapReasons: [...new Set(timeline.gaps.map((gap) => gap.reason))],
      };
    }),
  });
}
