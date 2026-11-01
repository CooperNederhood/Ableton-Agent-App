import { z } from "zod";
import {
  metricAudioObservationSchema,
  metricLevelRecordSchema,
  metricObservationStatusSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";
import type { MetricReportingRow } from "./metric-listening-geometry.js";

export const MAX_METRIC_REPORT_PAGE_ROWS = 32;
export const MAX_METRIC_REPORT_PAGE_BYTES = 48 * 1_024;

const reportSupportSchema = metricLevelRecordSchema.shape.support;
const reportGapSchema = z.strictObject({
  firstIndex: z.number().int().min(0).max(1_999),
  count: z.number().int().min(1).max(2_000),
  support: reportSupportSchema,
  reason:
    metricAudioObservationSchema.shape.metrics.shape.level.shape.gaps.element
      .shape.reason,
});
const reportAvailabilitySchema =
  metricAudioObservationSchema.shape.rows.element.shape.level.shape
    .availability;
const metadataPick = {
  algorithm: true,
  expectedRecords: true,
  limitations: true,
} as const;
const metadataCounts = {
  retainedRecords: z.number().int().min(0).max(2_000),
  missingRecords: z.number().int().min(0).max(2_000),
};
const reportRowSchema = z.strictObject({
  index: z.number().int().min(0).max(1_999),
  startBeat: z.number().finite().nonnegative(),
  endBeat: z.number().finite().positive(),
  ...reportSupportSchema.shape,
  level: z.strictObject({
    availability: reportAvailabilitySchema,
    records: z.array(metricLevelRecordSchema).max(1),
    gaps: z.array(reportGapSchema).max(1),
  }),
  "spectral-centroid": z.strictObject({
    availability: reportAvailabilitySchema,
    frameCount: z.number().int().min(0).max(706),
    centroidHz: z.number().finite().min(0).max(24_000).nullable(),
    spectralEnergy: z.number().finite().min(0).max(706e20).nullable(),
    aggregation: z.literal("spectral-energy-weighted-endpoint-frames"),
    supports: z.array(reportSupportSchema).max(706),
    gaps: z.array(reportGapSchema).max(706),
  }),
  attacks: z.strictObject({
    availability: reportAvailabilitySchema,
    events: z
      .array(
        metricAudioObservationSchema.shape.metrics.shape.attacks.shape.records
          .element.shape.events.element,
      )
      .max(300),
    supports: z.array(reportSupportSchema).max(300),
    gaps: z.array(reportGapSchema).max(300),
  }),
});

export const metricListeningReportSchema = z
  .strictObject({
    schema: z.literal("metric-listening-report/v1"),
    observationOutcome: metricAudioObservationSchema.shape.outcome,
    sampleRate: metricAudioObservationSchema.shape.geometry.shape.sampleRate,
    tempoBpm: metricAudioObservationSchema.shape.geometry.shape.tempoBpm,
    reportBeats: z.literal(0.25),
    source: metricAudioObservationSchema.shape.source,
    sourceCoverage: metricAudioObservationSchema.shape.sourceCoverage,
    alignment: metricAudioObservationSchema.shape.alignment,
    requestedMetrics: metricAudioObservationSchema.shape.requestedMetrics,
    limitations: metricAudioObservationSchema.shape.limitations,
    metricMetadata: z.strictObject({
      level: metricAudioObservationSchema.shape.metrics.shape.level
        .pick(metadataPick)
        .extend(metadataCounts),
      "spectral-centroid": metricAudioObservationSchema.shape.metrics.shape[
        "spectral-centroid"
      ]
        .pick(metadataPick)
        .extend(metadataCounts),
      attacks: metricAudioObservationSchema.shape.metrics.shape.attacks
        .pick(metadataPick)
        .extend(metadataCounts),
    }),
    metricStatus: z.strictObject({
      level: metricObservationStatusSchema,
      "spectral-centroid": metricObservationStatusSchema,
      attacks: metricObservationStatusSchema,
    }),
    reduction: metricAudioObservationSchema.shape.reduction,
    totalRows: z.number().int().min(0).max(2_000),
    offset: z.number().int().min(0).max(2_000),
    nextOffset: z.number().int().min(0).max(2_000).nullable(),
    pageBudget: z.strictObject({
      byteLimit: z.literal(MAX_METRIC_REPORT_PAGE_BYTES),
      requestedRowLimit: z
        .number()
        .int()
        .min(1)
        .max(MAX_METRIC_REPORT_PAGE_ROWS),
      byteLimited: z.boolean(),
    }),
    rows: z.array(reportRowSchema).max(MAX_METRIC_REPORT_PAGE_ROWS),
  })
  .superRefine((value, ctx) => {
    const end = value.offset + value.rows.length;
    if (
      value.offset > value.totalRows ||
      value.totalRows !== value.reduction.retainedReportRows ||
      value.totalRows > value.reduction.originalReportRows ||
      (value.reduction.mode === "none") !==
        (value.totalRows === value.reduction.originalReportRows) ||
      end > value.totalRows ||
      value.nextOffset !== (end < value.totalRows ? end : null) ||
      (end < value.totalRows && value.rows.length === 0) ||
      value.rows.length > value.pageBudget.requestedRowLimit ||
      (value.pageBudget.byteLimited &&
        value.rows.length >= value.pageBudget.requestedRowLimit)
    )
      ctx.addIssue({ code: "custom", message: "Invalid metric report paging" });
    for (const metric of ["level", "spectral-centroid", "attacks"] as const) {
      const metadata = value.metricMetadata[metric];
      const status = value.metricStatus[metric];
      if (
        metadata.retainedRecords + metadata.missingRecords !==
          metadata.expectedRecords ||
        (status === "not-requested") !==
          !value.requestedMetrics.includes(metric) ||
        (metadata.algorithm === null) !== (status === "not-requested") ||
        (status === "complete" && metadata.missingRecords !== 0)
      )
        ctx.addIssue({
          code: "custom",
          message: "Metric report acquisition metadata is inconsistent",
        });
    }
    for (const [index, row] of value.rows.entries()) {
      const previous = value.rows[index - 1];
      if (
        row.index < value.offset + index ||
        row.index >
          value.reduction.originalReportRows -
            value.totalRows +
            value.offset +
            index ||
        row.endBeat <= row.startBeat ||
        row.startSample < value.sourceCoverage.startSample ||
        row.endSample > value.sourceCoverage.endSample ||
        (previous !== undefined &&
          (row.index <= previous.index ||
            (row.index === previous.index + 1
              ? previous.endSample !== row.startSample ||
                previous.endBeat !== row.startBeat
              : previous.endSample >= row.startSample ||
                previous.endBeat >= row.startBeat))) ||
        row.level.records.some(
          (record) =>
            record.index !== row.index ||
            record.support.startSample !== row.startSample ||
            record.support.endSample !== row.endSample,
        )
      )
        ctx.addIssue({ code: "custom", message: "Invalid metric report row" });
      const spectral = row["spectral-centroid"];
      if (
        spectral.frameCount !== spectral.supports.length ||
        (spectral.centroidHz !== null &&
          spectral.centroidHz > value.sampleRate / 2) ||
        (spectral.frameCount === 0 &&
          (spectral.spectralEnergy !== null || spectral.centroidHz !== null)) ||
        (spectral.frameCount > 0 &&
          (spectral.spectralEnergy === null ||
            (spectral.spectralEnergy === 0) !== (spectral.centroidHz === null)))
      )
        ctx.addIssue({
          code: "custom",
          message: "Missing spectral frames are not measured silence",
        });
      for (const event of row.attacks.events)
        if (
          event.sample < row.startSample ||
          event.sample > row.endSample ||
          (event.sample === row.endSample &&
            (row.index !== value.reduction.originalReportRows - 1 ||
              event.sample !== value.sourceCoverage.endSample))
        )
          ctx.addIssue({
            code: "custom",
            message: "Attack event belongs to a different musical row",
          });
    }
    if (encodedBytes(value) > MAX_METRIC_REPORT_PAGE_BYTES)
      ctx.addIssue({
        code: "custom",
        message: "Metric report exceeds 48 KiB UTF-8 budget",
      });
  });

export type MetricListeningReport = z.infer<typeof metricListeningReportSchema>;

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export interface MetricListeningReportPage {
  readonly offset?: number;
  readonly limit?: number;
}

type MetricGap = MetricAudioObservation["metrics"]["level"]["gaps"][number];
type MetricTimeline =
  MetricAudioObservation["metrics"][keyof MetricAudioObservation["metrics"]];

function metricMetadata<T extends MetricTimeline>(
  metric: T,
): Pick<T, "algorithm" | "expectedRecords" | "limitations"> & {
  retainedRecords: number;
  missingRecords: number;
} {
  return {
    algorithm: metric.algorithm,
    expectedRecords: metric.expectedRecords,
    retainedRecords: metric.records.length,
    missingRecords: metric.gaps.reduce((sum, gap) => sum + gap.count, 0),
    limitations: metric.limitations,
  };
}

function indexed<T extends { index: number }>(
  records: readonly T[],
  indices: readonly number[],
): T[] {
  const byIndex = new Map(records.map((record) => [record.index, record]));
  return indices.map((index) => {
    const record = byIndex.get(index);
    if (record === undefined)
      throw new Error("metric_report_missing_authoritative_record");
    return record;
  });
}

function endpointInRow(
  sample: number,
  row: MetricReportingRow,
  captureEnd: number,
): boolean {
  return (
    sample >= row.startSample &&
    (sample < row.endSample ||
      (row.endSample === captureEnd && sample === captureEnd))
  );
}

function reportGaps(gaps: readonly MetricGap[]) {
  return gaps.map((gap) => ({
    firstIndex: gap.firstIndex,
    count: gap.count,
    support: { startSample: gap.startSample, endSample: gap.endSample },
    reason: gap.reason,
  }));
}

/**
 * Projects a bounded view, not new measurements. FFT support remains native;
 * an endpoint-assigned frame is never represented as a whole-row average.
 */
export function projectMetricListeningReport(
  input: MetricAudioObservation,
  page: MetricListeningReportPage = {},
): MetricListeningReport {
  const offset = page.offset ?? 0;
  const limit = page.limit ?? 8;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > input.rows.length ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_METRIC_REPORT_PAGE_ROWS
  )
    throw new RangeError("invalid_metric_report_page");

  const observation = metricAudioObservationSchema.parse(input);
  const { geometry, metrics } = observation;
  const rows = observation.rows
    .slice(offset, offset + limit)
    .map((references) => {
      const row = geometry.rows[references.index];
      if (row === undefined) throw new Error("metric_report_missing_geometry");
      const overlaps = (gap: MetricGap) =>
        gap.startSample < row.endSample && gap.endSample > row.startSample;
      const levels = indexed(
        metrics.level.records,
        references.level.recordIndices,
      );
      const spectra = indexed(
        metrics["spectral-centroid"].records,
        references["spectral-centroid"].recordIndices,
      );
      const detectors = indexed(
        metrics.attacks.records,
        references.attacks.recordIndices,
      );
      const eventDetectors = indexed(
        metrics.attacks.records,
        references.attacks.eventRecordIndices,
      );
      const energy = spectra.reduce(
        (sum, record) => sum + record.spectralEnergy,
        0,
      );
      const weighted = spectra.reduce(
        (sum, record) =>
          sum +
          (record.centroidHz === null
            ? 0
            : record.centroidHz * record.spectralEnergy),
        0,
      );
      const spectralGaps = metrics["spectral-centroid"].gaps.filter((gap) => {
        const algorithm = metrics["spectral-centroid"].algorithm;
        if (algorithm === null)
          throw new Error("metric_report_missing_spectral_geometry");
        const { firstFrameEndSample, hopSamples } = algorithm;
        if (firstFrameEndSample === null)
          throw new Error("metric_report_unknown_spectral_gap_geometry");
        for (
          let index = gap.firstIndex;
          index < gap.firstIndex + gap.count;
          index++
        ) {
          const endpoint = firstFrameEndSample + index * hopSamples;
          if (endpointInRow(endpoint, row, geometry.endSample)) return true;
        }
        return false;
      });
      return {
        index: references.index,
        ...row,
        level: {
          availability: references.level.availability,
          records: levels,
          gaps: reportGaps(metrics.level.gaps.filter(overlaps)),
        },
        "spectral-centroid": {
          availability: references["spectral-centroid"].availability,
          frameCount: spectra.length,
          centroidHz: energy === 0 ? null : weighted / energy,
          spectralEnergy: spectra.length === 0 ? null : energy,
          aggregation: "spectral-energy-weighted-endpoint-frames" as const,
          supports: spectra.map((record) => record.support),
          gaps: reportGaps(spectralGaps),
        },
        attacks: {
          availability: references.attacks.availability,
          events: eventDetectors.flatMap((record) =>
            record.events.filter((event) =>
              endpointInRow(event.sample, row, geometry.endSample),
            ),
          ),
          supports: detectors.map((record) => record.support),
          gaps: reportGaps(metrics.attacks.gaps.filter(overlaps)),
        },
      };
    });
  const report: MetricListeningReport = {
    schema: "metric-listening-report/v1" as const,
    observationOutcome: observation.outcome,
    sampleRate: geometry.sampleRate,
    tempoBpm: geometry.tempoBpm,
    reportBeats: geometry.reportBeats,
    source: observation.source,
    sourceCoverage: observation.sourceCoverage,
    alignment: observation.alignment,
    requestedMetrics: observation.requestedMetrics,
    limitations: observation.limitations,
    metricMetadata: {
      level: metricMetadata(metrics.level),
      "spectral-centroid": metricMetadata(metrics["spectral-centroid"]),
      attacks: metricMetadata(metrics.attacks),
    },
    metricStatus: {
      level: metrics.level.status,
      "spectral-centroid": metrics["spectral-centroid"].status,
      attacks: metrics.attacks.status,
    },
    reduction: observation.reduction,
    totalRows: observation.rows.length,
    offset,
    nextOffset:
      offset + rows.length < observation.rows.length
        ? offset + rows.length
        : null,
    pageBudget: {
      byteLimit: MAX_METRIC_REPORT_PAGE_BYTES,
      requestedRowLimit: limit,
      byteLimited: false,
    },
    rows,
  };
  if (encodedBytes({ ...report, rows: [] }) > MAX_METRIC_REPORT_PAGE_BYTES)
    throw new RangeError("metric_report_metadata_exceeds_byte_limit");
  while (encodedBytes(report) > MAX_METRIC_REPORT_PAGE_BYTES) {
    if (rows.length <= 1)
      throw new RangeError("metric_report_row_exceeds_byte_limit");
    rows.pop();
    report.nextOffset = offset + rows.length;
    report.pageBudget.byteLimited = true;
  }
  return metricListeningReportSchema.parse(report);
}
