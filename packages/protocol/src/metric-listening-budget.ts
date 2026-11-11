import { z } from "zod";
import { MAX_METRIC_OBSERVATION_BYTES } from "./audio-observation-limits.js";
import { METRIC_FFT_SAMPLES } from "./metric-listening-geometry.js";
import {
  metricAudioObservationSchema,
  type metricObservationMetricSchema,
  nativeMetricObservationMetricSchema,
  metricObservationSourceSchema,
} from "./metric-observation-schemas.js";
import {
  nativeMetricListeningConfigSchema,
  nativeMetricOwnershipSchema,
  nativeMetricSourceCoverageProofSchema,
} from "./native-metric-listening-schemas.js";
import {
  encodedJsonBytes as bytes,
  jsonArrayByteBound as arrayBytes,
  jsonObjectByteBound as objectBytes,
  toBoundJsonSchema as jsonSchema,
  jsonSchemaProperty as property,
  jsonSchemaItem as item,
  boundJsonSchemaBytes as bound,
} from "./schema-byte-budget.js";
import {
  admitMelBandBudget,
  MAX_MEL_BAND_TIMELINE_BYTES,
} from "./mel-band-budget.js";
import { MEL_BAND_PROFILE } from "./mel-band-profile.js";
import { boundAnalyzerTimelineBytes } from "./analyzer-budget.js";

// The version 5 terminal listener.result contract has a 2 MiB ingress ceiling.
// This module cannot import signal-routing, which itself imports protocol.
export const MAX_METRIC_RESULT_FRAME_BYTES = 2 * 1_024 * 1_024;

const wireIdentifier = nativeMetricOwnershipSchema.shape.listenerId.max(128);
export const metricListeningBudgetInputSchema = z.strictObject({
  config: nativeMetricListeningConfigSchema,
  ownership: nativeMetricOwnershipSchema.extend({
    listenerId: wireIdentifier,
    passId: wireIdentifier,
    correlationId: wireIdentifier,
    causationId: wireIdentifier,
  }),
  source: metricObservationSourceSchema,
  jobId: wireIdentifier,
});
export type MetricListeningBudgetInput = z.input<
  typeof metricListeningBudgetInputSchema
>;
type Snapshot = z.output<typeof metricListeningBudgetInputSchema>;
type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };
type Outcome = "complete" | "partial";
type Metric = z.infer<typeof metricObservationMetricSchema>;

const observationSchema = jsonSchema(metricAudioObservationSchema);
const proofSchema = jsonSchema(nativeMetricSourceCoverageProofSchema);

function frozen<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

export interface MetricListeningBudgetOperands {
  readonly reportRows: number;
  readonly totalSamples: number;
  readonly sampleRate: number;
  readonly expectedRecords: Readonly<Record<Metric, number>>;
  readonly geometryBytes: number;
  readonly reportRowsBytes: number;
  readonly nativeSourceCoverageBytes: number;
  readonly wireHeaderBytes: number;
  readonly metricsBytes: Readonly<Record<Outcome, number>>;
  readonly melTimelineBytes?: Readonly<Record<Outcome, number>>;
  readonly analyzerTimelineBytes?: Readonly<
    Partial<Record<"pitch" | "spectral-shape", number>>
  >;
}
export interface MetricListeningBudgetBounds {
  readonly observationBytes: number;
  readonly frameBytes: number;
}
export interface MetricListeningBudgetViolation {
  readonly outcome: Outcome;
  readonly boundary: "observation" | "frame";
  readonly upperBoundBytes: number;
  readonly byteLimit: number;
  readonly excessBytes: number;
}
interface BudgetResult {
  readonly schema: "metric-listening-budget/v1";
  /** Caller must bind subsequent publication to this immutable admission. */
  readonly snapshot: Immutable<Snapshot>;
  readonly operands: Readonly<MetricListeningBudgetOperands>;
  readonly upperBounds: Readonly<Record<Outcome, MetricListeningBudgetBounds>>;
  readonly limits: {
    readonly observationBytes: number;
    readonly frameBytes: number;
  };
}
export type MetricListeningBudgetAdmission =
  | (BudgetResult & { readonly admitted: true })
  | (BudgetResult & {
      readonly admitted: false;
      readonly reason: "metric_result_budget_exceeded";
      readonly violations: readonly MetricListeningBudgetViolation[];
    });

/**
 * Pre-playback compact-JSON/UTF8 upper bound for complete AND possible partial
 * version 5 publications. No capture, reduction, source proof, or authorization
 * is established here. The caller still owns all identity/source/proof guards.
 *
 * Bounds every schema-valid limitation/gap string, not just today's collector
 * literals, and retains ALL musical rows and authoritative timelines. Source
 * origin and FFT phase are unknown before playback, so native sample operands
 * reserve their full 14 decimal digits. The proof repeats the immutable config
 * and owner, plus both 32-frame clock brackets, witnesses and DSP receipts.
 */
export function admitMetricListeningBudget(
  input: MetricListeningBudgetInput,
): MetricListeningBudgetAdmission {
  const snapshot = metricListeningBudgetInputSchema.parse(input);
  const { config, ownership, source } = snapshot;
  if (source.view !== config.mode)
    throw new RangeError("metric_budget_source_mode_mismatch");
  if (
    config.sourceContext !== undefined &&
    JSON.stringify(source) !== JSON.stringify(config.sourceContext)
  )
    throw new RangeError("metric_budget_source_context_mismatch");
  const geometry = config.geometry;
  const requested = new Set(config.requestedMetrics);
  const expectedRecords = {
    level: requested.has("level") ? geometry.rows.length : 0,
    "spectral-centroid": requested.has("spectral-centroid")
      ? Math.ceil(geometry.totalSamples / METRIC_FFT_SAMPLES)
      : 0,
    attacks: requested.has("attacks")
      ? Math.ceil(geometry.totalSamples / Math.round(geometry.sampleRate / 10))
      : 0,
    "mel-bands": requested.has("mel-bands")
      ? Math.floor(geometry.totalSamples / MEL_BAND_PROFILE.windowSamples)
      : 0,
    pitch: requested.has("pitch")
      ? Math.floor(geometry.totalSamples / 2048)
      : 0,
    "spectral-shape": requested.has("spectral-shape")
      ? Math.floor(geometry.totalSamples / 2048)
      : 0,
  };
  const analyzerTimelineBytes = Object.fromEntries(
    (["pitch", "spectral-shape"] as const)
      .filter((metric) => requested.has(metric))
      .map((metric) => [
        metric,
        boundAnalyzerTimelineBytes(metric, expectedRecords[metric]),
      ]),
  );
  // The standalone estimator reserves 14-digit absolute supports even though
  // the admitted request grid is capture-local and the physical origin is unknown.
  const melBudget = requested.has("mel-bands")
    ? admitMelBandBudget({
        sampleRate: geometry.sampleRate,
        sourceSupport: { startSample: 0, endSample: geometry.totalSamples },
        profile: MEL_BAND_PROFILE,
        byteLimit: MAX_MEL_BAND_TIMELINE_BYTES,
      })
    : undefined;
  const geometryBytes = bound(
    property(observationSchema, "geometry"),
    "",
    (p) => {
      if (p === "startSample" || p === "endSample") return 14;
      if (p === "rows")
        return (
          2 +
          geometry.rows.reduce(
            (sum, row) =>
              sum +
              objectBytes({
                startBeat: bytes(row.startBeat),
                endBeat: bytes(row.endBeat),
                startSample: 14,
                endSample: 14,
              }),
            0,
          ) +
          Math.max(0, geometry.rows.length - 1)
        );
      if (Object.prototype.hasOwnProperty.call(geometry, p))
        return bytes(geometry[p as keyof typeof geometry]);
      return undefined;
    },
  );
  const metricSchemas = property(observationSchema, "metrics");
  const metricsBytes = { complete: 0, partial: 0 };
  for (const outcome of ["complete", "partial"] as const) {
    const sizes: Record<string, number> = {};
    for (const metric of nativeMetricObservationMetricSchema.options) {
      const schema = property(metricSchemas, metric);
      if (!requested.has(metric)) {
        sizes[metric] = bytes({
          status: "not-requested",
          algorithm: null,
          expectedRecords: 0,
          records: [],
          gaps: [],
          limitations: [],
        });
        continue;
      }
      const recordSchema = item(property(schema, "records"));
      const recordBytes = bound(recordSchema, "", (p) =>
        p === "events"
          ? arrayBytes(
              1,
              // Canonical detector replay permits at most ONE endpoint event
              // per independently retained input window, not 512 per window.
              bound(item(property(recordSchema, "events"))),
            )
          : undefined,
      );
      const gapBytes = bound(item(property(schema, "gaps")));
      const metadataBytes = bound(schema, "", (p) => {
        if (p === "records" || p === "gaps") return 2;
        if (p === "expectedRecords") return bytes(expectedRecords[metric]);
        return undefined;
      });
      // Every record occupies one expected slot, every gap at least one.
      // Disjointness is enforced by the canonical observation schema. Reserve
      // an extra comma per slot across the two arrays (also safe for zero).
      sizes[metric] =
        metadataBytes +
        expectedRecords[metric] *
          (1 +
            (outcome === "complete"
              ? recordBytes
              : Math.max(recordBytes, gapBytes)));
    }
    if (melBudget !== undefined)
      sizes["mel-bands"] = melBudget.upperBounds[outcome];
    Object.assign(sizes, analyzerTimelineBytes);
    metricsBytes[outcome] = objectBytes(sizes);
  }
  const rowSchema = item(property(observationSchema, "rows"));
  const activeRowSchema = {
    ...rowSchema,
    properties: Object.fromEntries(
      Object.entries(rowSchema.properties ?? {}).filter(
        ([key]) =>
          !["mel-bands", "pitch", "spectral-shape"].includes(key) ||
          requested.has(key as Metric),
      ),
    ),
  };
  const rowSizes = geometry.rows.map((row) =>
    bound(activeRowSchema, "", (p) => {
      if (!p.endsWith("recordIndices") && p !== "attacks.eventRecordIndices")
        return undefined;
      const metric = p.split(".")[0] as Metric;
      const width = row.endSample - row.startSample;
      const count = !requested.has(metric)
        ? 0
        : metric === "level"
          ? 1
          : Math.min(
              expectedRecords[metric],
              Math.ceil(
                width /
                  (metric === "attacks"
                    ? Math.round(geometry.sampleRate / 10)
                    : METRIC_FFT_SAMPLES),
              ) + 1,
            );
      return arrayBytes(count, bytes(Math.max(0, expectedRecords[metric] - 1)));
    }),
  );
  const reportRowsBytes =
    2 + rowSizes.reduce((sum, size) => sum + size, 0) + rowSizes.length - 1;
  const nativeSourceCoverageBytes = bound(proofSchema, "", (p) => {
    if (p === "armed.config") return bytes(config);
    if (p === "armed.ownership" || p === "launched.ownership")
      return bytes(ownership);
    return undefined;
  });
  const wireOwner = Object.fromEntries(
    Object.entries(ownership).filter(([key]) => key !== "nativeEpoch"),
  );
  const wireHeader = {
    ...wireOwner,
    protocolVersion: 1,
    listenerVersion: 5,
    mode: config.mode,
    jobId: snapshot.jobId,
    sequence: Number.MAX_SAFE_INTEGER,
    type: "listener.result",
  };
  // The actual client generates terminal requestIds after playback; a prepare
  // requestId cannot be pinned here. Reserve the entire allowed escaped field.
  const wireHeaderBytes = objectBytes({
    ...Object.fromEntries(
      Object.entries(wireHeader).map(([key, value]) => [key, bytes(value)]),
    ),
    requestId: bound(jsonSchema(wireIdentifier)),
  });
  const upperBounds = Object.fromEntries(
    (["complete", "partial"] as const).map((outcome) => {
      const observationBytes = bound(observationSchema, "", (p) => {
        if (p === "ownership") return bytes(ownership);
        if (p === "source") return bytes(source);
        if (p === "geometry") return geometryBytes;
        if (p === "metrics") return metricsBytes[outcome];
        if (p === "rows") return reportRowsBytes;
        if (p === "alignment.policy") return bytes(config.timingPolicy);
        if (p === "requestedMetrics") return bytes(config.requestedMetrics);
        return undefined;
      });
      return [
        outcome,
        {
          observationBytes,
          frameBytes:
            wireHeaderBytes -
            2 +
            objectBytes({
              status: bytes(outcome === "complete" ? "completed" : "partial"),
              observation: observationBytes,
              nativeSourceCoverage: nativeSourceCoverageBytes,
              // Optional terminal reason is bounded even though the current
              // emitter doesn't need it for a successful publication.
              reason: 2 + 6 * 512,
            }) +
            1,
        },
      ];
    }),
  ) as Record<Outcome, MetricListeningBudgetBounds>;
  const limits = {
    observationBytes: MAX_METRIC_OBSERVATION_BYTES,
    frameBytes: MAX_METRIC_RESULT_FRAME_BYTES,
  };
  const violations: MetricListeningBudgetViolation[] = [];
  for (const outcome of ["complete", "partial"] as const) {
    for (const boundary of ["observation", "frame"] as const) {
      const key = `${boundary}Bytes` as const;
      const upperBoundBytes = upperBounds[outcome][key];
      const byteLimit = limits[key];
      if (upperBoundBytes > byteLimit)
        violations.push({
          outcome,
          boundary,
          upperBoundBytes,
          byteLimit,
          excessBytes: upperBoundBytes - byteLimit,
        });
    }
  }
  const result: BudgetResult = {
    schema: "metric-listening-budget/v1",
    snapshot,
    operands: {
      reportRows: geometry.rows.length,
      totalSamples: geometry.totalSamples,
      sampleRate: geometry.sampleRate,
      expectedRecords,
      geometryBytes,
      reportRowsBytes,
      nativeSourceCoverageBytes,
      wireHeaderBytes,
      metricsBytes,
      ...(Object.keys(analyzerTimelineBytes).length === 0
        ? {}
        : { analyzerTimelineBytes }),
      ...(melBudget === undefined
        ? {}
        : { melTimelineBytes: melBudget.upperBounds }),
    },
    upperBounds,
    limits,
  };
  return frozen(
    violations.length === 0
      ? { ...result, admitted: true as const }
      : {
          ...result,
          admitted: false as const,
          reason: "metric_result_budget_exceeded" as const,
          violations,
        },
  );
}
