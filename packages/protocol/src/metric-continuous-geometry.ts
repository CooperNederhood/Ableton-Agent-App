import { z } from "zod";
import {
  metricListeningGeometryInputSchema,
  metricReportingRowSchema,
  METRIC_REPORT_BEATS,
  METRIC_FFT_SAMPLES,
} from "./metric-listening-geometry.js";

export const MAX_CONTINUOUS_METRIC_LISTENING_SECONDS = 600;
export const MAX_ARRANGEMENT_LISTENING_EXECUTION_MS = 900_000;
export const MAX_CONTINUOUS_METRIC_REPORT_ROWS = 39_961;
export const MAX_CONTINUOUS_METRIC_SPECTRUM_RECORDS = 14_065;
export const MAX_CONTINUOUS_METRIC_ATTACK_RECORDS = 6_000;
export const METRIC_CONTINUOUS_LISTENING_CAPABILITY =
  "audio-listener/finite-metric-stream-v1" as const;

export const metricContinuousListeningGeometryInputSchema =
  metricListeningGeometryInputSchema.extend({
    captureMode: z.literal("finite-metric-stream"),
  });

function calculate(
  input: z.infer<typeof metricContinuousListeningGeometryInputSchema>,
) {
  const durationBeats = input.endBeat - input.startBeat;
  const samplesPerBeat = (input.sampleRate * 60) / input.tempoBpm;
  const totalSamples = Math.round(durationBeats * samplesPerBeat);
  const maximumBeats =
    (MAX_CONTINUOUS_METRIC_LISTENING_SECONDS * input.tempoBpm) / 60;
  const roundoff =
    2 * Number.EPSILON * Math.max(1, input.startBeat, input.endBeat);
  if (
    durationBeats <= 0 ||
    durationBeats - maximumBeats > roundoff ||
    totalSamples < 1 ||
    totalSamples > MAX_CONTINUOUS_METRIC_LISTENING_SECONDS * input.sampleRate ||
    input.startSample + totalSamples > 2 ** 44 - 1
  )
    throw new RangeError("unsupported_continuous_metric_listening_duration");
  const boundary = (beat: number) =>
    input.startSample + Math.round((beat - input.startBeat) * samplesPerBeat);
  const rows: z.infer<typeof metricReportingRowSchema>[] = [];
  let startBeat = input.startBeat;
  let index = Math.floor(startBeat / METRIC_REPORT_BEATS) + 1;
  while (startBeat < input.endBeat) {
    if (rows.length >= MAX_CONTINUOUS_METRIC_REPORT_ROWS)
      throw new RangeError("continuous_metric_report_row_limit");
    const endBeat = Math.min(index++ * METRIC_REPORT_BEATS, input.endBeat);
    rows.push(
      metricReportingRowSchema.parse({
        startBeat,
        endBeat,
        startSample: boundary(startBeat),
        endSample: boundary(endBeat),
      }),
    );
    startBeat = endBeat;
  }
  return {
    ...input,
    schema: "metric-listening-geometry/v2" as const,
    reportBeats: METRIC_REPORT_BEATS,
    totalSamples,
    endSample: input.startSample + totalSamples,
    rows,
    budgets: {
      levelRecords: rows.length,
      spectrumRecords: Math.ceil(totalSamples / METRIC_FFT_SAMPLES) + 2,
      attackDetectorWindows: Math.ceil(
        totalSamples / Math.round(input.sampleRate / 10),
      ),
    },
  };
}

export const metricContinuousListeningGeometrySchema =
  metricContinuousListeningGeometryInputSchema
    .extend({
      schema: z.literal("metric-listening-geometry/v2"),
      reportBeats: z.literal(METRIC_REPORT_BEATS),
      totalSamples: z.number().int().min(1).max(28_800_000),
      endSample: metricListeningGeometryInputSchema.shape.startSample,
      rows: z
        .array(metricReportingRowSchema)
        .min(1)
        .max(MAX_CONTINUOUS_METRIC_REPORT_ROWS),
      budgets: z.strictObject({
        levelRecords: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONTINUOUS_METRIC_REPORT_ROWS),
        spectrumRecords: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONTINUOUS_METRIC_SPECTRUM_RECORDS),
        attackDetectorWindows: z
          .number()
          .int()
          .min(1)
          .max(MAX_CONTINUOUS_METRIC_ATTACK_RECORDS),
      }),
    })
    .superRefine((value, ctx) => {
      try {
        const expected = calculate(
          metricContinuousListeningGeometryInputSchema.parse({
            sampleRate: value.sampleRate,
            vectorSize: value.vectorSize,
            tempoBpm: value.tempoBpm,
            startBeat: value.startBeat,
            endBeat: value.endBeat,
            startSample: value.startSample,
            captureMode: value.captureMode,
          }),
        );
        if (
          value.totalSamples !== expected.totalSamples ||
          value.endSample !== expected.endSample ||
          JSON.stringify(value.rows) !== JSON.stringify(expected.rows) ||
          JSON.stringify(value.budgets) !== JSON.stringify(expected.budgets)
        )
          throw new Error("continuous_metric_geometry_mismatch");
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "invalid_geometry",
        });
      }
    });

export type MetricContinuousListeningGeometry = z.infer<
  typeof metricContinuousListeningGeometrySchema
>;

/** Finite capture geometry shared by Session and Arrangement playback adapters. */
export function createContinuousMetricListeningGeometry(
  input: z.input<typeof metricContinuousListeningGeometryInputSchema>,
): Readonly<MetricContinuousListeningGeometry> {
  const value = metricContinuousListeningGeometrySchema.parse(
    calculate(metricContinuousListeningGeometryInputSchema.parse(input)),
  );
  value.rows.forEach(Object.freeze);
  Object.freeze(value.rows);
  Object.freeze(value.budgets);
  return Object.freeze(value);
}
