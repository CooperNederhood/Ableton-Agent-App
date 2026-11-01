import { z } from "zod";

export const MAX_METRIC_LISTENING_SECONDS = 30;
export const MAX_METRIC_REPORT_ROWS = 2_000;
export const METRIC_REPORT_BEATS = 0.25;
export const METRIC_FFT_SAMPLES = 2_048;

const sample = z
  .number()
  .int()
  .nonnegative()
  .max(2 ** 44 - 1);
const beat = z.number().finite().min(0).max(1_576_800);
export const metricListeningGeometryInputSchema = z.strictObject({
  sampleRate: z.union([z.literal(44_100), z.literal(48_000)]),
  vectorSize: z
    .number()
    .int()
    .min(1)
    .max(1_024)
    .refine((value) => (value & (value - 1)) === 0),
  tempoBpm: z.number().finite().min(20).max(999),
  startBeat: beat,
  endBeat: beat,
  startSample: sample,
});

export const metricReportingRowSchema = z
  .strictObject({
    startBeat: beat,
    endBeat: beat,
    startSample: sample,
    endSample: sample,
  })
  .refine(
    (value) =>
      value.endBeat > value.startBeat && value.endSample > value.startSample,
    "Reporting interval must have positive musical and sample duration",
  );
export type MetricReportingRow = z.infer<typeof metricReportingRowSchema>;

function calculate(input: z.infer<typeof metricListeningGeometryInputSchema>) {
  const durationBeats = input.endBeat - input.startBeat;
  const samplesPerBeat = (input.sampleRate * 60) / input.tempoBpm;
  const totalSamples = Math.round(durationBeats * samplesPerBeat);
  const maximumBeats = (MAX_METRIC_LISTENING_SECONDS * input.tempoBpm) / 60;
  // Subtracting large song positions loses a few ULPs, not an audio sample.
  const coordinateRoundoff =
    2 * Number.EPSILON * Math.max(1, input.startBeat, input.endBeat);
  if (
    durationBeats <= 0 ||
    durationBeats - maximumBeats > coordinateRoundoff ||
    totalSamples < 1 ||
    totalSamples > MAX_METRIC_LISTENING_SECONDS * input.sampleRate ||
    input.startSample + totalSamples > 2 ** 44 - 1
  ) {
    throw new RangeError("unsupported_metric_listening_duration");
  }
  const boundarySample = (position: number) =>
    input.startSample +
    Math.round((position - input.startBeat) * samplesPerBeat);
  const rows: MetricReportingRow[] = [];
  let startBeat = input.startBeat;
  let index = Math.floor(startBeat / METRIC_REPORT_BEATS) + 1;
  while (startBeat < input.endBeat) {
    if (rows.length >= MAX_METRIC_REPORT_ROWS)
      throw new RangeError("metric_report_row_limit");
    const endBeat = Math.min(index * METRIC_REPORT_BEATS, input.endBeat);
    const row = metricReportingRowSchema.parse({
      startBeat,
      endBeat,
      startSample: boundarySample(startBeat),
      endSample: boundarySample(endBeat),
    });
    rows.push(row);
    startBeat = endBeat;
    index++;
  }
  return {
    ...input,
    schema: "metric-listening-geometry/v1" as const,
    reportBeats: METRIC_REPORT_BEATS,
    totalSamples,
    endSample: input.startSample + totalSamples,
    rows,
    budgets: {
      levelRecords: rows.length,
      // Allows the two analysis windows intersecting the capture boundaries.
      spectrumRecords: Math.ceil(totalSamples / METRIC_FFT_SAMPLES) + 2,
      attackDetectorWindows: Math.ceil(
        totalSamples / Math.round(input.sampleRate / 10),
      ),
    },
  };
}

export const metricListeningGeometrySchema = metricListeningGeometryInputSchema
  .extend({
    schema: z.literal("metric-listening-geometry/v1"),
    reportBeats: z.literal(METRIC_REPORT_BEATS),
    totalSamples: sample.min(1),
    endSample: sample,
    rows: z.array(metricReportingRowSchema).min(1).max(MAX_METRIC_REPORT_ROWS),
    budgets: z.strictObject({
      levelRecords: z.number().int().min(1).max(MAX_METRIC_REPORT_ROWS),
      spectrumRecords: z.number().int().min(1).max(706),
      attackDetectorWindows: z.number().int().min(1).max(300),
    }),
  })
  .superRefine((value, ctx) => {
    const input = {
      sampleRate: value.sampleRate,
      vectorSize: value.vectorSize,
      tempoBpm: value.tempoBpm,
      startBeat: value.startBeat,
      endBeat: value.endBeat,
      startSample: value.startSample,
    };
    let expected: ReturnType<typeof calculate>;
    try {
      expected = calculate(input);
    } catch (cause) {
      ctx.addIssue({
        code: "custom",
        message:
          cause instanceof Error ? cause.message : "invalid_metric_geometry",
      });
      return;
    }
    if (
      value.totalSamples !== expected.totalSamples ||
      value.endSample !== expected.endSample ||
      value.budgets.levelRecords !== expected.budgets.levelRecords ||
      value.budgets.spectrumRecords !== expected.budgets.spectrumRecords ||
      value.budgets.attackDetectorWindows !==
        expected.budgets.attackDetectorWindows ||
      value.rows.length !== expected.rows.length ||
      value.rows.some((row, index) => {
        const canonical = expected.rows[index];
        return (
          canonical === undefined ||
          row.startBeat !== canonical.startBeat ||
          row.endBeat !== canonical.endBeat ||
          row.startSample !== canonical.startSample ||
          row.endSample !== canonical.endSample
        );
      })
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Metric geometry must match the admitted musical sample grid",
      });
    }
  });
export type MetricListeningGeometry = z.infer<
  typeof metricListeningGeometrySchema
>;

/** Bounded coordinate arithmetic only; not source identity or timing proof. */
export function createMetricListeningGeometry(
  input: z.input<typeof metricListeningGeometryInputSchema>,
): Readonly<MetricListeningGeometry> {
  const value = metricListeningGeometrySchema.parse(
    calculate(metricListeningGeometryInputSchema.parse(input)),
  );
  value.rows.forEach(Object.freeze);
  Object.freeze(value.rows);
  Object.freeze(value.budgets);
  return Object.freeze(value);
}
