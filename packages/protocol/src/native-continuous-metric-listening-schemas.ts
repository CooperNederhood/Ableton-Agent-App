import { z } from "zod";
import {
  metricContinuousListeningGeometrySchema,
  metricContinuousListeningGeometryInputSchema,
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "./metric-continuous-geometry.js";
import {
  metricObservationMetricSchema,
  metricObservationSourceSchema,
} from "./metric-observation-schemas.js";
import {
  nativeMetricAttackSettingsSchema,
  NATIVE_METRIC_ALGORITHM_VERSION,
  nativeMetricListeningConfigSchema,
  nativeMetricReadyProofSchema,
  nativeMetricArmProofSchema,
  nativeMetricDspReceiptSchema,
  nativeMetricLaunchProofSchema,
  nativeMetricOwnershipSchema,
  nativeMetricEvidenceLaunchCoordinates,
  nativeMetricEvidenceSourceCoverage,
  nativeMetricSourceCoverageProofSchema,
  validateNativeMetricDspReceiptEvidence,
  validateNativeMetricReadyEvidence,
  validateNativeMetricArmEvidence,
  type NativeMetricListeningExpectation,
} from "./native-metric-listening-schemas.js";
import { listeningTimingPolicySchema } from "./listening-timing-schemas.js";
import { sessionNativeSourceSchema } from "./native-session-listening-schemas.js";
import {
  MAX_METRIC_RECORD_CHUNK_BYTES,
  MAX_METRIC_RECORD_PENDING_CHUNKS,
  nativeContinuousMetricConfigurationReadbackSchema,
  canonicalMetricRecordJson,
} from "./metric-record-stream.js";

export const NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE =
  "finite-metric-stream/v1" as const;

/** Admission uses local counters; the verified descriptor pins the native origin. */
export const nativeContinuousMetricListeningConfigSchema = z
  .strictObject({
    scope: z.literal(NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE),
    capability: z.literal(METRIC_CONTINUOUS_LISTENING_CAPABILITY),
    algorithmVersion: z.literal(NATIVE_METRIC_ALGORITHM_VERSION),
    mode: z.enum(["arrangement", "session"]),
    captureMode: z.literal("finite-metric-stream"),
    sourceEvidence: z.enum(["transport-only", "expected-context-only"]),
    stoppedBeat: z.number().finite().min(0).max(1_576_800).optional(),
    source: sessionNativeSourceSchema.optional(),
    geometry: metricContinuousListeningGeometrySchema,
    timingPolicy: listeningTimingPolicySchema,
    grid: z.strictObject({
      beats: z.literal(0.25),
      anchor: z.literal("global-beat-grid"),
      rounding: z.literal("nearest-sample"),
      coordinates: z.literal("capture-local"),
    }),
    requestedMetrics: z
      .array(metricObservationMetricSchema)
      .min(1)
      .max(6)
      .refine((metrics) => new Set(metrics).size === metrics.length),
    sourceContext: metricObservationSourceSchema.optional(),
    attacks: nativeMetricAttackSettingsSchema.nullable().optional(),
    maxPendingChunks: z
      .number()
      .int()
      .min(1)
      .max(MAX_METRIC_RECORD_PENDING_CHUNKS),
    maxChunkBytes: z.literal(MAX_METRIC_RECORD_CHUNK_BYTES),
  })
  .superRefine((value, ctx) => {
    const g = value.geometry;
    const dspSample = (beat: number) =>
      Math.round(((beat - g.startBeat) * g.sampleRate * 60) / g.tempoBpm);
    if (
      g.startSample !== 0 ||
      g.totalSamples !== dspSample(g.endBeat) ||
      g.rows.some(
        (row) =>
          row.startSample !== dspSample(row.startBeat) ||
          row.endSample !== dspSample(row.endBeat),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Continuous admission must match the executed local DSP grid",
      });
    if (
      value.requestedMetrics.includes("attacks")
        ? value.attacks == null
        : value.attacks != null
    )
      ctx.addIssue({
        code: "custom",
        path: ["attacks"],
        message:
          "Explicit detector settings are required only for requested attacks",
      });
    const source = value.sourceContext;
    if (
      source === undefined ||
      source.view !== value.mode ||
      source.transport.startBeat !== g.startBeat ||
      source.transport.endBeat !== g.endBeat ||
      (source.view === "arrangement" &&
        (source.target.kind === "master") !== (source.target.index === null)) ||
      (value.mode === "session"
        ? value.sourceEvidence !== "expected-context-only" ||
          value.stoppedBeat === undefined ||
          value.source === undefined ||
          source?.view !== "session" ||
          Math.abs(source.coordinate.endBeat - (g.endBeat - g.startBeat)) >
            1e-8 ||
          source.clipReference !== value.source.target.expectedClipReference ||
          canonicalMetricRecordJson(source.target) !==
            canonicalMetricRecordJson(value.source.target)
        : value.sourceEvidence !== "transport-only" ||
          value.stoppedBeat !== undefined ||
          value.source !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["sourceContext"],
        message:
          "Stream source must match the admitted mode, exact target and range",
      });
  });

export type NativeContinuousMetricListeningConfig = z.infer<
  typeof nativeContinuousMetricListeningConfigSchema
>;

export const nativeContinuousMetricDspReceiptSchema = z
  .strictObject({
    ...nativeMetricDspReceiptSchema.shape,
    fields: nativeContinuousMetricConfigurationReadbackSchema,
    confirmedFields: nativeContinuousMetricConfigurationReadbackSchema,
  })
  .superRefine(validateNativeMetricDspReceiptEvidence);
export type NativeContinuousMetricDspReceipt = z.infer<
  typeof nativeContinuousMetricDspReceiptSchema
>;

export const nativeContinuousMetricReadyProofSchema = z
  .strictObject({
    ...nativeMetricReadyProofSchema.shape,
    scope: z.literal(NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE),
    config: nativeContinuousMetricListeningConfigSchema,
  })
  .superRefine(validateNativeMetricReadyEvidence);
export type NativeContinuousMetricReadyProof = z.infer<
  typeof nativeContinuousMetricReadyProofSchema
>;

export const nativeContinuousMetricArmProofSchema = z
  .strictObject({
    ...nativeMetricArmProofSchema.shape,
    scope: z.literal(NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE),
    config: nativeContinuousMetricListeningConfigSchema,
    receipt: nativeContinuousMetricDspReceiptSchema,
  })
  .superRefine(validateNativeMetricArmEvidence);
export type NativeContinuousMetricArmProof = z.infer<
  typeof nativeContinuousMetricArmProofSchema
>;
export const nativeContinuousMetricSourceCoverageProofSchema = z.strictObject({
  ...nativeMetricSourceCoverageProofSchema.shape,
  armed: nativeContinuousMetricArmProofSchema,
  completion: nativeContinuousMetricDspReceiptSchema,
});
export type NativeContinuousMetricSourceCoverageProof = z.infer<
  typeof nativeContinuousMetricSourceCoverageProofSchema
>;

export function assertNativeContinuousMetricSourceCoverage(
  input: unknown,
  expected: NativeContinuousMetricListeningExpectation,
) {
  if (expected.generation === undefined || expected.nativeEpoch === undefined)
    throw new Error("native_metric_missing_owner_pin");
  const proof = nativeContinuousMetricSourceCoverageProofSchema.parse(input);
  const armed = assertNativeContinuousMetricArmProof(proof.armed, expected);
  return nativeMetricEvidenceSourceCoverage(proof, armed);
}

/** Compact wire inputs expand before the same authoritative admission guards. */
export const nativeContinuousMetricListeningConfigWireSchema = z
  .strictObject({
    ...nativeContinuousMetricListeningConfigSchema.shape,
    geometry: metricContinuousListeningGeometryInputSchema,
  })
  .transform((value, ctx) => {
    try {
      return nativeContinuousMetricListeningConfigSchema.parse({
        ...value,
        geometry: createContinuousMetricListeningGeometry(value.geometry),
      });
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid compact continuous native admission",
      });
      return z.NEVER;
    }
  });
export type NativeContinuousMetricListeningConfigWire = z.input<
  typeof nativeContinuousMetricListeningConfigWireSchema
>;

export const nativeContinuousMetricReadyProofWireSchema = z
  .strictObject({
    ...nativeContinuousMetricReadyProofSchema.shape,
    config: nativeContinuousMetricListeningConfigWireSchema,
  })
  .superRefine(validateNativeMetricReadyEvidence);
export type NativeContinuousMetricReadyProofWire = z.input<
  typeof nativeContinuousMetricReadyProofWireSchema
>;

export const nativeContinuousMetricArmProofWireSchema = z
  .strictObject({
    ...nativeContinuousMetricArmProofSchema.shape,
    config: nativeContinuousMetricListeningConfigWireSchema,
    receipt: nativeContinuousMetricDspReceiptSchema,
  })
  .superRefine(validateNativeMetricArmEvidence);
export type NativeContinuousMetricArmProofWire = z.input<
  typeof nativeContinuousMetricArmProofWireSchema
>;

export function compactNativeContinuousMetricListeningConfig(
  input: NativeContinuousMetricListeningConfig,
): NativeContinuousMetricListeningConfigWire {
  const config = nativeContinuousMetricListeningConfigSchema.parse(input);
  const g = config.geometry;
  return {
    ...config,
    geometry: {
      captureMode: g.captureMode,
      sampleRate: g.sampleRate,
      vectorSize: g.vectorSize,
      tempoBpm: g.tempoBpm,
      startBeat: g.startBeat,
      endBeat: g.endBeat,
      startSample: g.startSample,
    },
  };
}

export function compactNativeContinuousMetricReadyProof(
  input: NativeContinuousMetricReadyProof,
): NativeContinuousMetricReadyProofWire {
  const proof = nativeContinuousMetricReadyProofSchema.parse(input);
  return {
    ...proof,
    config: compactNativeContinuousMetricListeningConfig(proof.config),
  };
}

export function compactNativeContinuousMetricArmProof(
  input: NativeContinuousMetricArmProof,
): NativeContinuousMetricArmProofWire {
  const proof = nativeContinuousMetricArmProofSchema.parse(input);
  return {
    ...proof,
    config: compactNativeContinuousMetricListeningConfig(proof.config),
  };
}

export const nativeMetricControlConfigSchema = z.union([
  nativeMetricListeningConfigSchema,
  nativeContinuousMetricListeningConfigSchema,
]);
export const nativeMetricControlReadyProofSchema = z.union([
  nativeMetricReadyProofSchema,
  nativeContinuousMetricReadyProofSchema,
]);
export const nativeMetricControlArmProofSchema = z.union([
  nativeMetricArmProofSchema,
  nativeContinuousMetricArmProofSchema,
]);
export const nativeMetricControlConfigWireSchema = z.union([
  nativeMetricListeningConfigSchema,
  nativeContinuousMetricListeningConfigWireSchema,
]);
export const nativeMetricControlReadyProofWireSchema = z.union([
  nativeMetricReadyProofSchema,
  nativeContinuousMetricReadyProofWireSchema,
]);
export const nativeMetricControlArmProofWireSchema = z.union([
  nativeMetricArmProofSchema,
  nativeContinuousMetricArmProofWireSchema,
]);
export type NativeMetricControlConfigWire = z.input<
  typeof nativeMetricControlConfigWireSchema
>;
export type NativeMetricControlReadyProofWire = z.input<
  typeof nativeMetricControlReadyProofWireSchema
>;
export type NativeMetricControlArmProofWire = z.input<
  typeof nativeMetricControlArmProofWireSchema
>;
export type NativeMetricControlConfig = z.infer<
  typeof nativeMetricControlConfigSchema
>;
export type NativeMetricControlReadyProof = z.infer<
  typeof nativeMetricControlReadyProofSchema
>;
export type NativeMetricControlArmProof = z.infer<
  typeof nativeMetricControlArmProofSchema
>;

export type NativeContinuousMetricListeningExpectation = Omit<
  NativeMetricListeningExpectation,
  "config"
> & { readonly config: Readonly<NativeContinuousMetricListeningConfig> };

function assertContinuousExpectation(
  proof: Pick<NativeContinuousMetricArmProof, "ownership" | "config">,
  input: NativeContinuousMetricListeningExpectation,
): void {
  const expected = snapshotNativeContinuousMetricListeningExpectation(input);
  const owner = nativeMetricOwnershipSchema
    .omit({
      generation: true,
      nativeEpoch: true,
    })
    .parse({
      listenerId: expected.listenerId,
      passId: expected.passId,
      connectionId: expected.connectionId,
      connectionEpoch: expected.connectionEpoch,
      traceId: expected.traceId,
      correlationId: expected.correlationId,
      causationId: expected.causationId,
    });
  if (
    Object.entries(owner).some(
      ([field, value]) =>
        proof.ownership[field as keyof typeof owner] !== value,
    ) ||
    (expected.generation !== undefined &&
      (proof.ownership.generation !== expected.generation ||
        proof.ownership.nativeEpoch !== expected.nativeEpoch)) ||
    canonicalMetricRecordJson(proof.config) !==
      canonicalMetricRecordJson(
        nativeContinuousMetricListeningConfigSchema.parse(expected.config),
      )
  )
    throw new Error("native_metric_owner_or_config_mismatch");
}

function freezeEvidence<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeEvidence);
    Object.freeze(value);
  }
  return value;
}

export function snapshotNativeContinuousMetricListeningExpectation(
  input: NativeContinuousMetricListeningExpectation,
): Readonly<NativeContinuousMetricListeningExpectation> {
  if ((input.generation === undefined) !== (input.nativeEpoch === undefined))
    throw new Error("native_metric_incomplete_owner_pin");
  return freezeEvidence({
    ...nativeMetricOwnershipSchema
      .omit({
        generation: true,
        nativeEpoch: true,
      })
      .parse({
        listenerId: input.listenerId,
        passId: input.passId,
        connectionId: input.connectionId,
        connectionEpoch: input.connectionEpoch,
        traceId: input.traceId,
        correlationId: input.correlationId,
        causationId: input.causationId,
      }),
    config: nativeContinuousMetricListeningConfigSchema.parse(input.config),
    ...(input.generation === undefined
      ? {}
      : {
          generation: nativeMetricOwnershipSchema.shape.generation.parse(
            input.generation,
          ),
          nativeEpoch: nativeMetricOwnershipSchema.shape.nativeEpoch.parse(
            input.nativeEpoch,
          ),
        }),
  });
}

export function assertNativeContinuousMetricReadyProof(
  input: unknown,
  expected: NativeContinuousMetricListeningExpectation,
): Readonly<NativeContinuousMetricReadyProof> {
  const proof = nativeContinuousMetricReadyProofSchema.parse(input);
  assertContinuousExpectation(proof, expected);
  return freezeEvidence(proof);
}

export function assertNativeContinuousMetricArmProof(
  input: unknown,
  expected: NativeContinuousMetricListeningExpectation,
): Readonly<NativeContinuousMetricArmProof> {
  const proof = nativeContinuousMetricArmProofSchema.parse(input);
  assertContinuousExpectation(proof, expected);
  return freezeEvidence(proof);
}

/** Launch DSP tuple is unchanged; only admission geometry/delivery is continuous. */
export function nativeContinuousMetricLaunchCoordinates(
  rawArm: NativeContinuousMetricArmProof,
  rawLaunch: unknown,
  expected: NativeContinuousMetricListeningExpectation,
) {
  if (expected.generation === undefined || expected.nativeEpoch === undefined)
    throw new Error("native_metric_missing_owner_pin");
  const armed = assertNativeContinuousMetricArmProof(rawArm, expected);
  const launch = nativeMetricLaunchProofSchema.parse(rawLaunch);
  const coordinates = nativeMetricEvidenceLaunchCoordinates(armed, launch);
  return Object.freeze({
    startSample: coordinates.originCounter,
    endSample: coordinates.originCounter + armed.config.geometry.totalSamples,
    originCounter: coordinates.originCounter,
    hostOffsetSamples: coordinates.hostOffsetSamples,
    hostStartSample: coordinates.startSample,
    hostEndSample: coordinates.startSample + armed.config.geometry.totalSamples,
  });
}
