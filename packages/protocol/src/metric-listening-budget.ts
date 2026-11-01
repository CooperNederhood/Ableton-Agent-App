import { z } from "zod";
import { MAX_METRIC_OBSERVATION_BYTES } from "./audio-observation-limits.js";
import { METRIC_FFT_SAMPLES } from "./metric-listening-geometry.js";
import {
  metricAudioObservationSchema,
  metricObservationMetricSchema,
  metricObservationSourceSchema,
} from "./metric-observation-schemas.js";
import {
  nativeMetricListeningConfigSchema,
  nativeMetricOwnershipSchema,
  nativeMetricSourceCoverageProofSchema,
} from "./native-metric-listening-schemas.js";

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
type Schema = z.core.JSONSchema.JSONSchema;
type Override = (path: string) => number | undefined;
type Outcome = "complete" | "partial";
type Metric = z.infer<typeof metricObservationMetricSchema>;

const encoder = new TextEncoder();
const bytes = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).byteLength;
const arrayBytes = (count: number, itemBytes: number): number =>
  2 + count * itemBytes + Math.max(0, count - 1);
const objectBytes = (fields: Record<string, number>): number =>
  2 +
  Object.entries(fields).reduce(
    (sum, [key, size]) => sum + bytes(key) + 1 + size,
    0,
  ) +
  Math.max(0, Object.keys(fields).length - 1);
const jsonSchema = (schema: z.ZodType): Schema =>
  z.toJSONSchema(schema, { target: "draft-7", reused: "inline" });
const observationSchema = jsonSchema(metricAudioObservationSchema);
const proofSchema = jsonSchema(nativeMetricSourceCoverageProofSchema);

function property(schema: Schema, name: string): Schema {
  const result = schema.properties?.[name];
  if (!result || typeof result === "boolean")
    throw new Error(`metric_budget_missing_schema_property:${name}`);
  return result;
}

function item(schema: Schema): Schema {
  if (
    !schema.items ||
    typeof schema.items === "boolean" ||
    Array.isArray(schema.items)
  )
    throw new Error("metric_budget_missing_array_item_schema");
  return schema.items;
}

/**
 * Bounding, not validation. Canonical Zod schemas validate inputs; their JSON
 * schemas supply finite field/array/string bounds. Unknown constructs fail
 * explicitly rather than quietly underestimating a future protocol revision.
 */
function bound(
  schema: Schema | boolean,
  path = "",
  override: Override = () => undefined,
): number {
  const replacement = override(path);
  if (replacement !== undefined) return replacement;
  if (typeof schema === "boolean")
    throw new Error(`metric_budget_unbounded_schema:${path}`);
  if (Object.hasOwn(schema, "const")) return bytes(schema.const);
  if (schema.enum) return Math.max(...schema.enum.map(bytes));
  if (schema.anyOf)
    return Math.max(...schema.anyOf.map((item) => bound(item, path, override)));
  switch (schema.type) {
    case "null":
      return 4;
    case "boolean":
      return 5;
    case "integer":
      if (
        typeof schema.minimum === "number" &&
        typeof schema.maximum === "number" &&
        Number.isSafeInteger(schema.minimum) &&
        Number.isSafeInteger(schema.maximum)
      )
        return Math.max(bytes(schema.minimum), bytes(schema.maximum));
      break;
    case "number":
      // Binary64 shortest-roundtrip has at most 17 significant digits. Fixed
      // notation at 1e-6 needs 2+5+17=24 chars; scientific notation is shorter.
      // Include a possible minus sign unless the canonical schema forbids it.
      return typeof schema.minimum === "number" && schema.minimum >= 0
        ? 24
        : 25;
    case "string":
      if (schema.format === "uuid") return 38;
      // JSON escapes each UTF-16 code unit using at most six ASCII bytes.
      if (typeof schema.maxLength === "number") return 2 + 6 * schema.maxLength;
      break;
    case "array":
      if (Array.isArray(schema.items))
        return (
          2 +
          schema.items.reduce(
            (sum, item, index) =>
              sum + bound(item, `${path}.${index}`, override),
            0,
          ) +
          Math.max(0, schema.items.length - 1)
        );
      if (schema.items && typeof schema.maxItems === "number")
        return arrayBytes(
          schema.maxItems,
          bound(schema.items, `${path}[]`, override),
        );
      break;
    case "object":
      if (schema.additionalProperties === false && schema.properties)
        return objectBytes(
          Object.fromEntries(
            Object.entries(schema.properties).map(([key, child]) => [
              key,
              bound(child, path ? `${path}.${key}` : key, override),
            ]),
          ),
        );
      break;
  }
  throw new Error(`metric_budget_unbounded_schema:${path}`);
}

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
  };
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
      if (Object.hasOwn(geometry, p))
        return bytes(geometry[p as keyof typeof geometry]);
      return undefined;
    },
  );
  const metricSchemas = property(observationSchema, "metrics");
  const metricsBytes = { complete: 0, partial: 0 };
  for (const outcome of ["complete", "partial"] as const) {
    const sizes: Record<string, number> = {};
    for (const metric of metricObservationMetricSchema.options) {
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
    metricsBytes[outcome] = objectBytes(sizes);
  }
  const rowSchema = item(property(observationSchema, "rows"));
  const rowSizes = geometry.rows.map((row) =>
    bound(rowSchema, "", (p) => {
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
