import { z } from "zod";
import { MAX_METRIC_OBSERVATION_BYTES } from "./audio-observation-limits.js";
import {
  METRIC_FFT_SAMPLES,
  MAX_METRIC_REPORT_ROWS,
  metricListeningGeometrySchema,
  type MetricListeningGeometry,
} from "./metric-listening-geometry.js";
import { listeningAlignmentQualitySchema } from "./listening-timing-schemas.js";
import { inspectSessionListeningSourceParamsSchema } from "./session-listening-source-schemas.js";

const sample = z
  .number()
  .int()
  .min(0)
  .max(2 ** 44 - 1);
const count = z.number().int().min(0).max(MAX_METRIC_REPORT_ROWS);
const identifier = z.string().min(1).max(200);
const beat = z.number().finite().min(0).max(1_576_800);
export const MAX_METRIC_OBSERVATION_AMPLITUDE = 64;
const ATTACK_FLOOR_DBFS = -120;
// Detector history starts at -120 dBFS; supported RMS can exceed unity.
export const MAX_METRIC_ATTACK_STRENGTH_DB =
  20 * Math.log10(MAX_METRIC_OBSERVATION_AMPLITUDE) - ATTACK_FLOOR_DBFS;
const amplitude = z
  .number()
  .finite()
  .min(0)
  .max(MAX_METRIC_OBSERVATION_AMPLITUDE);
const interval = z
  .strictObject({ startSample: sample, endSample: sample })
  .refine(
    (v) => v.endSample > v.startSample,
    "Positive half-open support required",
  );
type Interval = z.infer<typeof interval>;

export const metricObservationMetricSchema = z.enum([
  "level",
  "spectral-centroid",
  "attacks",
]);
export const metricObservationStatusSchema = z.enum([
  "complete",
  "partial",
  "failed",
  "not-requested",
]);
export const metricObservationGapSchema = z.strictObject({
  firstIndex: count,
  count: count.min(1),
  ...interval.shape,
  reason: z.enum([
    "unavailable",
    "malformed-record",
    "sequence-gap",
    "overflow",
    "drain-timeout",
    "dependency-unavailable",
  ]),
  detail: z.string().min(1).max(160),
});

const baseMetric = {
  status: metricObservationStatusSchema,
  expectedRecords: count,
  gaps: z.array(metricObservationGapSchema).max(MAX_METRIC_REPORT_ROWS),
  limitations: z.array(z.string().min(1).max(240)).max(8),
};
const baseRecord = { index: count, support: interval };
const levelValues = {
  peak: z.tuple([amplitude, amplitude]),
  rms: z.tuple([amplitude, amplitude]),
};
function rmsWithinPeak(value: {
  peak: [number, number];
  rms: [number, number];
}): boolean {
  return value.rms.every((rms, channel) => rms <= value.peak[channel]!);
}
const inputLevelSchema = z
  .strictObject(levelValues)
  .refine(rmsWithinPeak, "Linear RMS cannot exceed peak");
export const metricLevelRecordSchema = z
  .strictObject({
    ...baseRecord,
    ...levelValues,
  })
  .refine(rmsWithinPeak, "Linear RMS cannot exceed peak");
export const metricSpectralRecordSchema = z
  .strictObject({
    ...baseRecord,
    spectralEnergy: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
    centroidHz: z.number().finite().min(0).max(24_000).nullable(),
  })
  .refine(
    (v) => (v.spectralEnergy === 0) === (v.centroidHz === null),
    "Zero spectral energy is valid silence; missing frames are not zero energy",
  );
export const metricAttackRecordSchema = z.strictObject({
  ...baseRecord,
  // Sufficient detector input from the independently retained 100ms accumulator,
  // never reconstructed from musical reporting rows. Native count/sum-of-squares
  // derivation and physical provenance remain runtime verification obligations.
  inputLevel: inputLevelSchema,
  // Support is [start,end); sample is the detector's end-of-window timestamp,
  // not a claim that the physical transient began at this sample.
  events: z
    .array(
      z.strictObject({
        sample,
        strength: z.number().finite().min(0).max(MAX_METRIC_ATTACK_STRENGTH_DB),
      }),
    )
    .max(512),
});

const levelMetric = z.strictObject({
  ...baseMetric,
  algorithm: z
    .strictObject({
      name: z.literal("sample-grid-peak-rms"),
      version: z.literal(1),
      units: z.literal("linear-amplitude"),
    })
    .nullable(),
  records: z.array(metricLevelRecordSchema).max(MAX_METRIC_REPORT_ROWS),
});
const spectralMetric = z.strictObject({
  ...baseMetric,
  algorithm: z
    .strictObject({
      name: z.literal("fft-energy-centroid"),
      version: z.literal(1),
      fftSamples: z.literal(METRIC_FFT_SAMPLES),
      hopSamples: z.literal(METRIC_FFT_SAMPLES),
      firstFrameEndSample: sample.nullable(),
      units: z.literal("Hz"),
    })
    .nullable(),
  records: z.array(metricSpectralRecordSchema).max(706),
});
export const metricAttackAlgorithmSchema = z.strictObject({
  name: z.literal("level-window-rise"),
  version: z.literal(1),
  dependency: z.literal("level"),
  inputSource: z.literal("independent-100ms-level-windows"),
  windowSamples: z.number().int().min(4_410).max(4_800),
  thresholdDb: z.number().finite().min(0).max(120),
  minSpacingSamples: sample,
  units: z.literal("dB-rise"),
});
const attackMetric = z.strictObject({
  ...baseMetric,
  algorithm: metricAttackAlgorithmSchema.nullable(),
  records: z.array(metricAttackRecordSchema).max(300),
});
const metricsSchema = z.strictObject({
  level: levelMetric,
  "spectral-centroid": spectralMetric,
  attacks: attackMetric,
});
type Metrics = z.infer<typeof metricsSchema>;
type Metric = keyof Metrics;

export type MetricAttackAlgorithm = z.infer<typeof metricAttackAlgorithmSchema>;
export type MetricAttackInputRecord = Pick<
  z.infer<typeof metricAttackRecordSchema>,
  "index" | "support" | "inputLevel"
>;
export type MetricAttackEvent = z.infer<
  typeof metricAttackRecordSchema
>["events"][number];
const attackInputRecordSchema = z.strictObject({
  ...baseRecord,
  inputLevel: inputLevelSchema,
});

/**
 * Canonical arithmetic over a bounded declared input prefix; existing event
 * claims are ignored. Only the final window may be clipped. The caller still
 * must verify capture geometry, native FIFO derivation, ownership and physical
 * source provenance; replay does not establish any of those facts.
 */
export function deriveMetricAttackEvents(
  records: readonly MetricAttackInputRecord[],
  algorithm: MetricAttackAlgorithm,
): MetricAttackEvent[] {
  if (records.length > 300) throw new RangeError("metric_attack_prefix_limit");
  const settings = metricAttackAlgorithmSchema.parse(algorithm);
  const events: MetricAttackEvent[] = [];
  let previousLevel = ATTACK_FLOOR_DBFS;
  let lastAttack = -Infinity;
  let riseHasAttack = false;
  let previousEnd: number | undefined;
  for (const [index, raw] of records.entries()) {
    const window = attackInputRecordSchema.parse({
      index: raw.index,
      support: raw.support,
      inputLevel: raw.inputLevel,
    });
    const duration = window.support.endSample - window.support.startSample;
    if (
      window.index !== index ||
      (previousEnd !== undefined &&
        window.support.startSample !== previousEnd) ||
      duration > settings.windowSamples ||
      (index !== records.length - 1 && duration !== settings.windowSamples)
    ) {
      throw new RangeError("invalid_metric_attack_input_prefix");
    }
    const level = Math.max(
      ...window.inputLevel.rms.map((rms) =>
        rms <= 10 ** (ATTACK_FLOOR_DBFS / 20)
          ? ATTACK_FLOOR_DBFS
          : 20 * Math.log10(rms),
      ),
    );
    const rise = level - previousLevel;
    if (rise <= 0) riseHasAttack = false;
    if (
      !riseHasAttack &&
      level > ATTACK_FLOOR_DBFS &&
      rise > 0 &&
      rise >= settings.thresholdDb &&
      window.support.endSample - lastAttack >= settings.minSpacingSamples
    ) {
      events.push({ sample: window.support.endSample, strength: rise });
      lastAttack = window.support.endSample;
      riseHasAttack = true;
    }
    previousLevel = level;
    previousEnd = window.support.endSample;
  }
  return events;
}

const rowMetric = z.strictObject({
  availability: z.enum([
    "available",
    "partial",
    "missing",
    "not-requested",
    "no-frame",
    "unknown-phase",
  ]),
  // Expected-slot indices, not offsets in the retained records array.
  recordIndices: z.array(count).max(300),
});
export const metricObservationReportRowSchema = z.strictObject({
  index: count,
  level: rowMetric,
  "spectral-centroid": rowMetric,
  attacks: rowMetric.extend({
    // Detection endpoints can belong to a row their input support does not overlap.
    // These are event ownership only, never additional detector coverage.
    eventRecordIndices: z.array(count).max(300),
  }),
});
type ReportRow = z.infer<typeof metricObservationReportRowSchema>;

export const metricObservationSourceSchema = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("arrangement"),
    target: z.strictObject({
      kind: z.enum(["regular", "return", "master"]),
      index: z.number().int().min(0).max(255).nullable(),
      expectedReference: z.string().uuid(),
    }),
    transport: z.strictObject({ startBeat: beat, endBeat: beat }),
  }),
  z.strictObject({
    view: z.literal("session"),
    target: inspectSessionListeningSourceParamsSchema.shape.target,
    clipReference: z.string().uuid(),
    kind: z.enum(["midi", "warped-audio"]),
    coordinate: z.strictObject({
      unit: z.literal("beats"),
      iteration: z.literal(0),
      startBeat: z.literal(0),
      endBeat: beat,
    }),
    transport: z.strictObject({ startBeat: beat, endBeat: beat }),
    clipStartTimeBeats: beat,
    synchronization: z.literal("transport-coupled-first-iteration"),
  }),
]);

const body = z.strictObject({
  schema: z.literal("metric-audio-observation/v1"),
  outcome: z.enum(["complete", "partial"]),
  ownership: z.strictObject({
    listenerId: identifier,
    passId: identifier,
    connectionId: z.string().uuid(),
    connectionEpoch: z.string().uuid(),
    generation: z.string().uuid(),
    nativeEpoch: z.number().int().min(1).max(1_000_000),
    traceId: z.string().uuid(),
    correlationId: identifier,
    causationId: identifier,
  }),
  // Assertions by the trusted producer, not certificates created by parsing.
  sharedIntegrity: z.literal("validated"),
  source: metricObservationSourceSchema,
  geometry: metricListeningGeometrySchema,
  sourceCoverage: interval,
  alignment: listeningAlignmentQualitySchema,
  requestedMetrics: z.array(metricObservationMetricSchema).min(1).max(3),
  metrics: metricsSchema,
  rows: z.array(metricObservationReportRowSchema).max(MAX_METRIC_REPORT_ROWS),
  reduction: z.strictObject({
    mode: z.enum(["none", "selected-report-rows"]),
    originalReportRows: count.min(1),
    retainedReportRows: count,
    // Authoritative sufficient records and gaps must never be silently reduced.
    authoritativeTimelines: z.literal("retained"),
  }),
  limitations: z.array(z.string().min(1).max(240)).max(16),
});
type Body = z.infer<typeof body>;

function expectedSupports(
  geometry: MetricListeningGeometry,
  metrics: Metrics,
  metric: Metric,
): Interval[] {
  if (metrics[metric].status === "not-requested") return [];
  if (metric === "level") return geometry.rows;
  const result: Interval[] = [];
  if (metric === "spectral-centroid") {
    const algorithm = metrics[metric].algorithm;
    if (!algorithm || algorithm.firstFrameEndSample === null) return [];
    for (
      let end = algorithm.firstFrameEndSample;
      end <= geometry.endSample && result.length <= 706;
      end += METRIC_FFT_SAMPLES
    ) {
      result.push({ startSample: end - METRIC_FFT_SAMPLES, endSample: end });
    }
  } else {
    const hop = Math.round(geometry.sampleRate / 10);
    for (
      let start = geometry.startSample;
      start < geometry.endSample && result.length <= 300;
      start += hop
    ) {
      result.push({
        startSample: start,
        endSample: Math.min(start + hop, geometry.endSample),
      });
    }
  }
  return result;
}

function sameSupport(left: Interval, right: Interval): boolean {
  return (
    left.startSample === right.startSample && left.endSample === right.endSample
  );
}

/**
 * References only: no averaged FFT values, fabricated silence, or source proof.
 * A frame is assigned by endpoint to [row.start,row.end), except capture-end
 * belongs to the last row. Its full 2048-sample support remains on the timeline.
 * Attack recordIndices reference overlapping input support; eventRecordIndices
 * independently assign detection endpoints, including preceding-window events.
 * Neither reference list duplicates event values or extends source coverage.
 */
export function createMetricObservationReportRows(
  value: Pick<Body, "geometry" | "metrics">,
): ReportRow[] {
  const { geometry, metrics } = value;
  const expected = Object.fromEntries(
    metricObservationMetricSchema.options.map((metric) => [
      metric,
      expectedSupports(geometry, metrics, metric),
    ]),
  ) as Record<Metric, Interval[]>;
  const retained = Object.fromEntries(
    metricObservationMetricSchema.options.map((metric) => [
      metric,
      new Set(metrics[metric].records.map((record) => record.index)),
    ]),
  ) as Record<Metric, Set<number>>;
  return geometry.rows.map((row, index) => {
    const ownsEndpoint = (sample: number): boolean =>
      sample >= row.startSample &&
      (sample < row.endSample ||
        (index === geometry.rows.length - 1 && sample === row.endSample));
    const projection = (metric: Metric): ReportRow["level"] => {
      if (metrics[metric].status === "not-requested") {
        return { availability: "not-requested", recordIndices: [] };
      }
      if (
        metric === "spectral-centroid" &&
        metrics[metric].algorithm?.firstFrameEndSample === null
      )
        return { availability: "unknown-phase", recordIndices: [] };
      const slots = expected[metric].flatMap((support, slot) => {
        const belongs =
          metric === "spectral-centroid"
            ? ownsEndpoint(support.endSample)
            : support.startSample < row.endSample &&
              support.endSample > row.startSample;
        return belongs ? [slot] : [];
      });
      const recordIndices = slots.filter((slot) => retained[metric].has(slot));
      return {
        availability:
          slots.length === 0
            ? "no-frame"
            : recordIndices.length === slots.length
              ? "available"
              : recordIndices.length === 0
                ? "missing"
                : "partial",
        recordIndices,
      };
    };
    return {
      index,
      level: projection("level"),
      "spectral-centroid": projection("spectral-centroid"),
      attacks: {
        ...projection("attacks"),
        eventRecordIndices: metrics.attacks.records
          .filter((record) =>
            record.events.some((event) => ownsEndpoint(event.sample)),
          )
          .map((record) => record.index),
      },
    };
  });
}

/**
 * Structural publication contract only. The runtime must independently establish
 * source identity, clocks/ownership, immutable exactly-once records and DSP
 * provenance. Arithmetic consistency cannot prove physical audio, FFT energy,
 * peak/RMS correctness, attack detection, or a verified timing error bound.
 * All records inherit the enclosing ownership; receipt time is not source time.
 */
export const metricAudioObservationSchema = body.superRefine((value, ctx) => {
  const issue = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };
  const { geometry, metrics, source } = value;
  if (
    value.alignment.sampleRate !== geometry.sampleRate ||
    value.alignment.vectorSize !== geometry.vectorSize ||
    !sameSupport(value.sourceCoverage, geometry)
  ) {
    issue("Shared source coverage and alignment must match admitted geometry");
  }
  if (source.view === "session") {
    if (
      geometry.startBeat !== 0 ||
      source.transport.startBeat !== 0 ||
      source.clipReference !== source.target.expectedClipReference ||
      source.coordinate.endBeat !== geometry.endBeat ||
      source.clipStartTimeBeats !== source.transport.startBeat ||
      Math.abs(
        source.transport.endBeat -
          source.transport.startBeat -
          geometry.endBeat,
      ) > 1e-8
    ) {
      issue("Session clip-local coordinates and transport origin must agree");
    }
  } else if (
    source.transport.startBeat !== geometry.startBeat ||
    source.transport.endBeat !== geometry.endBeat ||
    (source.target.kind === "master") !== (source.target.index === null)
  ) {
    issue("Arrangement source coordinates or target are inconsistent");
  }
  if (new Set(value.requestedMetrics).size !== value.requestedMetrics.length) {
    issue("Requested metrics must be unique");
  }
  const spectralAlgorithm = metrics["spectral-centroid"].algorithm;
  if (
    spectralAlgorithm &&
    spectralAlgorithm.firstFrameEndSample !== null &&
    (spectralAlgorithm.firstFrameEndSample <= geometry.startSample ||
      spectralAlgorithm.firstFrameEndSample >
        geometry.startSample + METRIC_FFT_SAMPLES ||
      spectralAlgorithm.firstFrameEndSample < METRIC_FFT_SAMPLES)
  ) {
    issue(
      "FFT phase must identify the first real nonnegative 2048-sample support",
    );
  }
  if (
    metrics.attacks.algorithm &&
    metrics.attacks.algorithm.windowSamples !==
      Math.round(geometry.sampleRate / 10)
  ) {
    issue("Attack cadence is independent of reporting rows");
  }
  let useful = false;
  for (const metric of metricObservationMetricSchema.options) {
    const acquisition = metrics[metric];
    const requested = value.requestedMetrics.includes(metric);
    if (requested !== (acquisition.status !== "not-requested")) {
      issue(`${metric}: request and status disagree`);
    }
    if (!requested) {
      if (
        acquisition.algorithm !== null ||
        acquisition.expectedRecords !== 0 ||
        acquisition.records.length !== 0 ||
        acquisition.gaps.length !== 0 ||
        acquisition.limitations.length !== 0
      ) {
        issue(`${metric}: unrequested metrics cannot carry data`);
      }
      continue;
    }
    if (acquisition.algorithm === null)
      issue(`${metric}: algorithm is required`);
    if (
      metric === "spectral-centroid" &&
      metrics[metric].algorithm?.firstFrameEndSample === null
    ) {
      if (
        !["failed", "cancelled"].includes(acquisition.status) ||
        acquisition.expectedRecords !== 0 ||
        acquisition.records.length !== 0 ||
        acquisition.gaps.length !== 0 ||
        acquisition.limitations.length === 0
      )
        issue(
          "Unknown FFT phase must retain explicit failure/cancellation without invented cadence or records",
        );
      continue;
    }
    const expected = expectedSupports(geometry, metrics, metric);
    if (expected.length !== acquisition.expectedRecords) {
      issue(`${metric}: expected records must match admitted analysis cadence`);
    }
    const occupied = new Set<number>();
    let previous = -1;
    for (const record of acquisition.records) {
      const support = expected[record.index];
      if (
        !support ||
        !sameSupport(record.support, support) ||
        record.index <= previous
      ) {
        issue(
          `${metric}: record coordinates, ordering or slot ownership mismatch`,
        );
      }
      occupied.add(record.index);
      previous = record.index;
    }
    previous = -1;
    for (const gap of acquisition.gaps) {
      const first = expected[gap.firstIndex];
      const last = expected[gap.firstIndex + gap.count - 1];
      if (
        !first ||
        !last ||
        gap.startSample !== first.startSample ||
        gap.endSample !== last.endSample ||
        gap.firstIndex <= previous
      ) {
        issue(
          `${metric}: missing intervals must identify ordered expected support`,
        );
        continue;
      }
      for (
        let index = gap.firstIndex;
        index < gap.firstIndex + gap.count;
        index++
      ) {
        if (occupied.has(index))
          issue(`${metric}: data and missing support overlap`);
        occupied.add(index);
      }
      previous = gap.firstIndex + gap.count - 1;
    }
    if (
      occupied.size !== expected.length ||
      expected.some((_, index) => !occupied.has(index))
    ) {
      issue(
        `${metric}: every expected record needs validated data or an explicit gap`,
      );
    }
    const all =
      acquisition.records.length === expected.length &&
      acquisition.gaps.length === 0;
    const some = acquisition.records.length > 0;
    if (
      (acquisition.status === "complete") !== all ||
      (acquisition.status === "partial" && (!some || all)) ||
      (acquisition.status === "failed" && some)
    ) {
      issue(`${metric}: contradictory acquisition status`);
    }
    useful ||= some;
  }
  for (const frame of metrics["spectral-centroid"].records) {
    if (
      frame.centroidHz !== null &&
      frame.centroidHz > geometry.sampleRate / 2
    ) {
      issue("Centroid cannot exceed actual Nyquist");
    }
  }
  let events = 0;
  let expectedEvents: MetricAttackEvent[] = [];
  if (metrics.attacks.algorithm !== null) {
    try {
      expectedEvents = deriveMetricAttackEvents(
        metrics.attacks.records,
        metrics.attacks.algorithm,
      );
    } catch (cause) {
      if (!(cause instanceof RangeError) && !(cause instanceof z.ZodError))
        throw cause;
      issue(
        "Attack input records must retain a validated contiguous 100ms prefix",
      );
    }
  }
  const expectedBySample = new Map(
    expectedEvents.map((event) => [event.sample, event]),
  );
  for (const window of metrics.attacks.records) {
    const expected = expectedBySample.get(window.support.endSample);
    const actual = window.events[0];
    if (
      expected
        ? window.events.length !== 1 ||
          actual?.sample !== expected.sample ||
          actual.strength !== expected.strength
        : window.events.length !== 0
    ) {
      issue(
        "Attack events must exactly match the detector replay over retained input",
      );
    }
    events += window.events.length;
  }
  if (events > 512) issue("Attack event budget exceeded");
  if (!useful) issue("No trustworthy requested metric data is publishable");
  const complete = value.requestedMetrics.every(
    (metric) => metrics[metric].status === "complete",
  );
  if ((value.outcome === "complete") !== complete) {
    issue("Overall outcome must reflect every requested acquisition");
  }
  const canonicalRows = createMetricObservationReportRows(value);
  let previousRow = -1;
  for (const row of value.rows) {
    if (
      row.index <= previousRow ||
      JSON.stringify(row) !== JSON.stringify(canonicalRows[row.index])
    ) {
      issue(
        "Report rows must be ordered reference-only projections of authoritative timelines",
      );
    }
    previousRow = row.index;
  }
  if (
    value.reduction.originalReportRows !== geometry.rows.length ||
    value.reduction.retainedReportRows !== value.rows.length ||
    (value.reduction.mode === "none") !==
      (value.rows.length === geometry.rows.length)
  ) {
    issue(
      "Display-detail reduction must explicitly declare every omitted report row",
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_METRIC_OBSERVATION_BYTES
  ) {
    issue("Observation exceeds encoded payload quota");
  }
});

export type MetricAudioObservation = z.infer<
  typeof metricAudioObservationSchema
>;
export type MetricObservationReportRow = z.infer<
  typeof metricObservationReportRowSchema
>;
