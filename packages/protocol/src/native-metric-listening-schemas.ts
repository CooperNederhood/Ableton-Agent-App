import { z } from "zod";
import { ANALYZER_PRODUCER_ABI } from "./analyzer-profile.js";
import {
  metricAudioObservationSchema,
  metricAttackAlgorithmSchema,
  metricObservationSourceSchema,
  metricObservationMetricSchema,
  type MetricAudioObservation,
} from "./metric-observation-schemas.js";
import {
  createMetricListeningGeometry,
  metricListeningGeometrySchema,
  type MetricListeningGeometry,
} from "./metric-listening-geometry.js";
import {
  evaluateListeningAlignment,
  listeningTimingPolicySchema,
} from "./listening-timing-schemas.js";
import { nativeHostClockRowSchema } from "./native-listening-schemas.js";
import { sessionNativeSourceSchema } from "./native-session-listening-schemas.js";
import {
  assertNativeCheckedTransportSourceCoverage,
  isCoherentNativeTransportClock,
  nativeCheckedTransportClockBindingSchema,
  nativeTransportTimingWitnessesSchema,
} from "./native-listening-v2-schemas.js";

export const NATIVE_METRIC_LISTENING_SCOPE =
  "independent-metric-timelines/v1" as const;
export const NATIVE_METRIC_LISTENING_CAPABILITY =
  "audio-listener/independent-metric-timelines-v1" as const;
export const NATIVE_MEL_BAND_LISTENING_CAPABILITY =
  "audio-listener/mel-band-timelines-v1" as const;
export const NATIVE_METRIC_ALGORITHM_VERSION = "3.0.0" as const;
export const nativeAnalyzerProducerAbiSchema = z.literal(ANALYZER_PRODUCER_ABI);
function validateAnalyzerProducer(
  value: {
    config: { requestedMetrics: readonly string[] };
    analyzerProducerAbi?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    value.config.requestedMetrics.some(
      (metric) => metric === "pitch" || metric === "spectral-shape",
    ) &&
    value.analyzerProducerAbi !== ANALYZER_PRODUCER_ABI
  )
    ctx.addIssue({
      code: "custom",
      path: ["analyzerProducerAbi"],
      message:
        "Authoritative analyzers require actual native producer ABI3 readiness",
    });
}
const LIMIT = 2 ** 44;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signed = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
const counter = integer.max(LIMIT - 1);
const epoch = integer.min(1).max(1_000_000);
const beat = z.number().finite().min(0).max(1_576_800);

/**
 * Node admission only, not DSP histories. Trusted admission explicitly supplies
 * the legacy6dB / round(rate/10) spacing when those defaults are selected.
 */
export const nativeMetricAttackSettingsSchema =
  metricAttackAlgorithmSchema.pick({
    thresholdDb: true,
    minSpacingSamples: true,
  });
export type NativeMetricAttackSettings = z.infer<
  typeof nativeMetricAttackSettingsSchema
>;

const config = {
  scope: z.literal(NATIVE_METRIC_LISTENING_SCOPE),
  algorithmVersion: z.literal(NATIVE_METRIC_ALGORITHM_VERSION),
  geometry: metricListeningGeometrySchema,
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
};

/**
 * One sample..30s; unlike legacy native geometry, no artificial100ms minimum.
 * Request sample coordinates are capture-local0..total. Persisted metric grids
 * and supports use the verified native source origin, never host/song samples.
 * Session source is expected context only; launch/source/ownership admission
 * and exact clip identity remain independently enforced by application guards.
 */
export const nativeMetricListeningConfigSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({
      ...config,
      mode: z.literal("arrangement"),
      sourceEvidence: z.literal("transport-only"),
    }),
    z.strictObject({
      ...config,
      mode: z.literal("session"),
      stoppedBeat: beat,
      sourceEvidence: z.literal("expected-context-only"),
      source: sessionNativeSourceSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    const source = value.sourceContext;
    if (
      source !== undefined &&
      (source.view !== value.mode ||
        source.transport.startBeat !== value.geometry.startBeat ||
        source.transport.endBeat !== value.geometry.endBeat ||
        (value.mode === "session" &&
          source.view === "session" &&
          (Math.abs(
            source.coordinate.endBeat -
              (value.geometry.endBeat - value.geometry.startBeat),
          ) > 1e-8 ||
            source.clipReference !==
              value.source.target.expectedClipReference ||
            JSON.stringify(source.target) !==
              JSON.stringify(value.source.target))))
    )
      ctx.addIssue({
        code: "custom",
        path: ["sourceContext"],
        message:
          "Expected source context must match the admitted mode, target and range",
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
    const g = value.geometry;
    const dspSample = (position: number) =>
      Math.round(((position - g.startBeat) * g.sampleRate * 60) / g.tempoBpm);
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
        message: "Metric capture must match the executed local DSP grid",
      });
  });
export type NativeMetricListeningConfig = z.infer<
  typeof nativeMetricListeningConfigSchema
>;

export const nativeMetricOwnershipSchema =
  metricAudioObservationSchema.shape.ownership;
export const nativeMetricOwnerSchema = nativeMetricOwnershipSchema;
export type NativeMetricOwner = z.infer<typeof nativeMetricOwnerSchema>;
export type NativeMetricOwnership = NativeMetricOwner;

/** Actual compact8: seenEpoch,launchClock,rejected,active,phase,arm,origin,ABI. */
export const nativeMetricCompactTimingSchema = z.tuple([
  epoch,
  signed.max(480_000),
  z.literal(0),
  z.union([z.literal(0), z.literal(1)]),
  signed.max(1_024),
  counter,
  signed.max(LIMIT - 1),
  z.literal(3),
]);
export type NativeMetricCompactTiming = z.infer<
  typeof nativeMetricCompactTimingSchema
>;

/** Exactly MUSICAL_CONFIGURATION_FIELDS; these are DSP histories, not setters. */
export const nativeMetricConfigurationReadbackSchema = z.tuple([
  epoch, // seenEpoch
  integer.min(1).max(1_440_000), // passTotal
  z.union([z.literal(4_410), z.literal(4_800)]), // passHop: physical100ms
  z.number().finite().min(20).max(999), // passTempo
  z.number().finite().min(0).lt(1), // passFraction
  metricListeningGeometrySchema.shape.vectorSize, // passVector
  z.literal(1), // passLevelVersion
  beat, // passReportStartBeat
  beat, // passReportEndBeat
  integer.min(1).max(2_000), // passReportRows
  epoch, // sealedEpoch
  epoch, // seenEpoch bookend
]);
export type NativeMetricConfigurationReadback = z.infer<
  typeof nativeMetricConfigurationReadbackSchema
>;
export const nativeMetricDspReceiptSchema = z
  .strictObject({
    fields: nativeMetricConfigurationReadbackSchema,
    confirmedFields: nativeMetricConfigurationReadbackSchema,
    timing: nativeMetricCompactTimingSchema,
    confirmedTiming: nativeMetricCompactTimingSchema,
    elapsedMs: z.number().finite().min(0).max(1_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.fields[0] !== value.fields[10] ||
      value.fields[0] !== value.fields[11] ||
      value.fields[0] !== value.timing[0] ||
      value.confirmedFields.some(
        (cell, index) => cell !== value.fields[index],
      ) ||
      value.confirmedTiming.some((cell, index) => cell !== value.timing[index])
    )
      ctx.addIssue({
        code: "custom",
        message: "Native metric DSP readback seal or immutable hold mismatch",
      });
  });
export type NativeMetricDspReceipt = z.infer<
  typeof nativeMetricDspReceiptSchema
>;

const idleEpoch = integer.max(1_000_000);
const priorHistory = z
  .number()
  .finite()
  .min(1 - LIMIT)
  .max(LIMIT - 1);

/** Unsealed prior histories, not readback of the newly admitted configuration. */
export const nativeMetricIdleConfigurationReadbackSchema = z.tuple([
  idleEpoch,
  priorHistory,
  priorHistory,
  priorHistory,
  priorHistory,
  priorHistory,
  priorHistory,
  priorHistory,
  priorHistory,
  priorHistory,
  z.literal(0),
  idleEpoch,
]);
export const nativeMetricIdleTimingSchema = z.tuple([
  z.literal(0),
  signed.max(480_000),
  integer.max(15),
  z.literal(0),
  signed.max(1_024),
  signed.max(LIMIT - 1),
  signed.max(LIMIT - 1),
  z.literal(3),
]);

export const nativeMetricIdleReceiptSchema = z
  .strictObject({
    fields: nativeMetricIdleConfigurationReadbackSchema,
    confirmedFields: nativeMetricIdleConfigurationReadbackSchema,
    timing: nativeMetricIdleTimingSchema,
    confirmedTiming: nativeMetricIdleTimingSchema,
    configurationCounter: counter,
    confirmedConfigurationCounter: counter,
    timingCounter: counter,
    confirmedTimingCounter: counter,
    elapsedMs: z.number().finite().min(0).max(1_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.fields[0] !== value.fields[11] ||
      value.confirmedFields.some(
        (cell, index) => cell !== value.fields[index],
      ) ||
      value.confirmedTiming.some(
        (cell, index) => cell !== value.timing[index],
      ) ||
      value.confirmedConfigurationCounter <= value.configurationCounter ||
      value.confirmedTimingCounter <= value.timingCounter
    )
      ctx.addIssue({
        code: "custom",
        message: "Native metric idle readback changed or regressed",
      });
  });
export type NativeMetricIdleReceipt = z.infer<
  typeof nativeMetricIdleReceiptSchema
>;

/**
 * Non-arming preflight only. Epoch is a future reservation; old launch/history
 * latches are deliberately not interpreted as a new launch or configuration.
 */
export const nativeMetricReadyProofSchema = z
  .strictObject({
    analyzerProducerAbi: nativeAnalyzerProducerAbiSchema.optional(),
    scope: z.literal(NATIVE_METRIC_LISTENING_SCOPE),
    phase: z.literal("idle-preflight"),
    configurationEvidence: z.literal("admitted-not-executed"),
    ownership: nativeMetricOwnershipSchema,
    config: nativeMetricListeningConfigSchema,
    disarmCounter: counter,
    before: nativeCheckedTransportClockBindingSchema(false),
    idle: nativeMetricIdleReceiptSchema,
    elapsedMs: z.number().finite().min(0).max(2_000),
  })
  .superRefine((value, ctx) => {
    validateAnalyzerProducer(value, ctx);
    const g = value.config.geometry;
    const first = value.before.frames[0]![4];
    const last = value.before.frames.at(-1)![4];
    const idle = value.idle;
    if (
      value.before.dsp[1] !== g.sampleRate ||
      value.before.dsp[2] !== g.vectorSize ||
      value.before.frames.some(
        (row) =>
          row[1] !==
          (value.config.mode === "session"
            ? value.config.stoppedBeat
            : g.startBeat),
      ) ||
      (value.config.timingPolicy.mode === "strict" &&
        value.before.frames.some(
          (row) => row[2] - row[4] !== value.before.frames[0]![2] - first,
        )) ||
      last +
        10 * g.sampleRate +
        Math.ceil(g.totalSamples / (g.sampleRate / 10)) * (g.sampleRate / 10) +
        g.vectorSize >=
        LIMIT ||
      value.disarmCounter >= first ||
      idle.fields[0] >= value.ownership.nativeEpoch ||
      idle.elapsedMs > value.elapsedMs ||
      [
        idle.configurationCounter,
        idle.confirmedConfigurationCounter,
        idle.timingCounter,
        idle.confirmedTimingCounter,
      ].some((sample) => sample < first || sample > last)
    )
      ctx.addIssue({
        code: "custom",
        message: "Native metric idle preflight ownership or freshness mismatch",
      });
  });
export type NativeMetricReadyProof = z.infer<
  typeof nativeMetricReadyProofSchema
>;

export const nativeMetricArmProofSchema = z
  .strictObject({
    analyzerProducerAbi: nativeAnalyzerProducerAbiSchema.optional(),
    scope: z.literal(NATIVE_METRIC_LISTENING_SCOPE),
    ownership: nativeMetricOwnershipSchema,
    config: nativeMetricListeningConfigSchema,
    before: nativeCheckedTransportClockBindingSchema(false),
    receipt: nativeMetricDspReceiptSchema,
  })
  .superRefine((value, ctx) => {
    validateAnalyzerProducer(value, ctx);
    const g = value.config.geometry;
    const first = value.before.frames[0]!;
    const last = value.before.frames.at(-1)!;
    const timing = value.receipt.timing;
    const fields = value.receipt.fields;
    const expected = [
      value.ownership.nativeEpoch,
      g.totalSamples,
      g.sampleRate / 10,
      g.tempoBpm,
      g.startBeat - Math.floor(g.startBeat),
      g.vectorSize,
      1,
      g.startBeat,
      g.endBeat,
      g.rows.length,
      value.ownership.nativeEpoch,
      value.ownership.nativeEpoch,
    ];
    if (
      fields.some((cell, index) => cell !== expected[index]) ||
      timing[0] !== value.ownership.nativeEpoch ||
      timing[1] !== -1 ||
      timing[3] !== 0 ||
      timing[4] !== -1 ||
      timing[6] !== -1 ||
      value.before.dsp[1] !== g.sampleRate ||
      value.before.dsp[2] !== g.vectorSize ||
      timing[5] < last[4] ||
      timing[5] - last[4] > g.sampleRate ||
      timing[5] +
        10 * g.sampleRate +
        Math.ceil(g.totalSamples / (g.sampleRate / 10)) * (g.sampleRate / 10) +
        g.vectorSize >=
        LIMIT ||
      value.before.frames.some(
        (row) =>
          row[1] !==
          (value.config.mode === "session"
            ? value.config.stoppedBeat
            : g.startBeat),
      ) ||
      (value.config.timingPolicy.mode === "strict" &&
        value.before.frames.some(
          (row) => row[2] - row[4] !== first[2] - first[4],
        ))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Native metric arm execution receipt or stopped binding mismatch",
      });
  });
export type NativeMetricArmProof = z.infer<typeof nativeMetricArmProofSchema>;

export const nativeMetricLaunchProofSchema = z
  .strictObject({
    scope: z.literal(NATIVE_METRIC_LISTENING_SCOPE),
    ownership: nativeMetricOwnershipSchema,
    timing: nativeMetricCompactTimingSchema,
    clock: nativeHostClockRowSchema,
    elapsedMs: z.number().finite().min(0).max(10_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.timing[0] !== value.ownership.nativeEpoch ||
      value.timing[1] < 0 ||
      value.timing[4] < 0 ||
      value.timing[6] < 0 ||
      value.clock[0] !== 1 ||
      !isCoherentNativeTransportClock(value.clock)
    )
      ctx.addIssue({ code: "custom", message: "Invalid native metric launch" });
  });
export type NativeMetricLaunchProof = z.infer<
  typeof nativeMetricLaunchProofSchema
>;

export const nativeMetricSpectrumPhaseSchema = z
  .strictObject({
    scope: z.literal("native-metric-spectrum-phase/v1"),
    ownership: nativeMetricOwnershipSchema,
    fftInformation: z.tuple([
      z.literal(2048),
      z.literal(2048),
      z.literal(2048),
      z.literal(1),
    ]),
    binding: z.strictObject({
      abi: z.literal(2),
      ready: z.tuple([z.literal(2), z.literal(1), epoch]),
    }),
    clock: nativeCheckedTransportClockBindingSchema(false),
    acquisitions: z.tuple([
      z.tuple([epoch, counter, counter, counter.min(2048)]),
      z.tuple([epoch, counter, counter, counter.min(2048)]),
    ]),
  })
  .superRefine((value, ctx) => {
    const [first, second] = value.acquisitions;
    const low = value.clock.frames[0]![4];
    const high = value.clock.frames[31]![4];
    if (
      first[0] !== value.ownership.nativeEpoch ||
      value.binding.ready[2] !== value.ownership.nativeEpoch ||
      second[0] !== value.ownership.nativeEpoch ||
      first[1] !== first[2] ||
      second[1] !== second[2] ||
      second[1] <= first[1] ||
      second[3] !== first[3] + 2048 ||
      value.acquisitions.some(
        (row) =>
          row[1] < low ||
          row[1] > high ||
          row[3] > row[1] + 1 ||
          row[1] - row[3] > value.clock.dsp[1],
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["acquisitions"],
        message:
          "FFT phase requires two actual consecutive endpoints in a coherent shared-clock bracket",
      });
  });
export type NativeMetricSpectrumPhase = z.infer<
  typeof nativeMetricSpectrumPhaseSchema
>;

export function nativeMetricFirstSpectrumEndpoint(
  raw: NativeMetricSpectrumPhase,
  startSample: number,
): number {
  const phase = nativeMetricSpectrumPhaseSchema.parse(raw);
  counter.parse(startSample);
  if (startSample < phase.acquisitions[1][1])
    throw new Error("native_metric_spectrum_phase_not_precapture");
  const offset =
    (((phase.acquisitions[0][3] - startSample) % 2048) + 2048) % 2048;
  return counter.parse(startSample + (offset || 2048));
}

const spectrumExecutedReceiptSchema = z
  .strictObject({
    raw: z.array(z.number().finite()).length(20),
    counterBefore: counter,
    counterAfter: counter,
    nativeSourceCounter: counter,
    observedHostReceiptMs: z
      .number()
      .finite()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((value, ctx) => {
    if (
      value.counterBefore !== value.counterAfter ||
      value.nativeSourceCounter !== value.counterBefore
    )
      ctx.addIssue({
        code: "custom",
        message: "Spectrum receipt counter bookends must agree",
      });
  });
const spectrumReceiptAvailabilitySchema = z
  .strictObject({
    available: z.boolean(),
    value: spectrumExecutedReceiptSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.available !== (value.value !== null))
      ctx.addIssue({
        code: "custom",
        message: "Spectrum receipt availability must preserve actual evidence",
      });
  });
const hostTime = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
export const nativeMetricSpectrumCleanupSchema = z
  .strictObject({
    type: z.literal("native-metric-spectrum-cleanup/v1"),
    generation: nativeMetricOwnershipSchema.shape.generation,
    nativeEpoch: epoch,
    status: z.enum(["pending", "completed", "failed"]),
    phase: z.enum([
      "acquiring-watermark",
      "awaiting-disabled",
      "disabled-confirmed",
      "failed",
    ]),
    outcome: z.enum(["complete", "failed", "cancelled"]),
    diagnosticOnly: z.boolean(),
    inputFailureReason: z.string().max(128).nullable(),
    reason: z.string().max(128).nullable(),
    stopWatermark: counter.nullable(),
    deadlineMs: hostTime,
    requestedHostMs: hostTime,
    completedHostMs: hostTime.nullable(),
    watermarkReceipt: spectrumReceiptAvailabilitySchema,
    receipt: spectrumReceiptAvailabilitySchema,
  })
  .superRefine((value, ctx) => {
    const watermark = value.watermarkReceipt.value;
    const receipt = value.receipt.value;
    if (
      value.deadlineMs <= value.requestedHostMs ||
      value.deadlineMs > value.requestedHostMs + 2000 ||
      (watermark !== null &&
        watermark.nativeSourceCounter !== value.stopWatermark) ||
      (value.status === "completed" &&
        (value.phase !== "disabled-confirmed" ||
          !watermark ||
          !receipt ||
          receipt.nativeSourceCounter <= watermark.nativeSourceCounter ||
          value.completedHostMs !== receipt.observedHostReceiptMs ||
          receipt.observedHostReceiptMs >= value.deadlineMs ||
          receipt.observedHostReceiptMs < watermark.observedHostReceiptMs ||
          receipt.raw[0] !== 1 ||
          receipt.raw[2] !== receipt.raw[18] ||
          !counter.safeParse(receipt.raw[2]).success ||
          receipt.raw.some(
            (cell, index) => ![0, 2, 18].includes(index) && cell !== 0,
          )))
    )
      ctx.addIssue({
        code: "custom",
        message: "FFT cleanup requires the actual newer cleared native bank",
      });
  });

export const nativeMetricSourceCoverageProofSchema = z.strictObject({
  armed: nativeMetricArmProofSchema,
  launched: nativeMetricLaunchProofSchema,
  completion: nativeMetricDspReceiptSchema,
  after: nativeCheckedTransportClockBindingSchema(true),
  timingWitnesses: nativeTransportTimingWitnessesSchema,
  postElapsedMs: z.number().finite().min(0).max(2_000),
  spectrumPhase: nativeMetricSpectrumPhaseSchema.optional(),
  spectrumCleanup: nativeMetricSpectrumCleanupSchema.optional(),
});
export type NativeMetricSourceCoverageProof = z.infer<
  typeof nativeMetricSourceCoverageProofSchema
>;

export interface NativeMetricListeningExpectation {
  readonly listenerId: string;
  readonly passId: string;
  readonly connectionId: string;
  readonly connectionEpoch: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly config: Readonly<NativeMetricListeningConfig>;
  /** Pin both from the authenticated arm reply before accepting terminal proof. */
  readonly generation?: string;
  readonly nativeEpoch?: number;
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshotNativeMetricListeningExpectation(
  input: NativeMetricListeningExpectation,
): Readonly<NativeMetricListeningExpectation> {
  if ((input.generation === undefined) !== (input.nativeEpoch === undefined))
    throw new Error("native_metric_incomplete_owner_pin");
  return freeze({
    ...nativeMetricOwnershipSchema
      .omit({ generation: true, nativeEpoch: true })
      .parse({
        listenerId: input.listenerId,
        passId: input.passId,
        connectionId: input.connectionId,
        connectionEpoch: input.connectionEpoch,
        traceId: input.traceId,
        correlationId: input.correlationId,
        causationId: input.causationId,
      }),
    config: nativeMetricListeningConfigSchema.parse(input.config),
    ...(input.generation === undefined
      ? {}
      : {
          generation: z.string().uuid().parse(input.generation),
          nativeEpoch: epoch.parse(input.nativeEpoch),
        }),
  });
}

function assertMetricCaptureExpectation(
  proof: Pick<NativeMetricArmProof, "ownership" | "config">,
  input: NativeMetricListeningExpectation,
) {
  const expected = snapshotNativeMetricListeningExpectation(input);
  if (
    (
      [
        "listenerId",
        "passId",
        "connectionId",
        "connectionEpoch",
        "traceId",
        "correlationId",
        "causationId",
      ] as const
    ).some((field) => proof.ownership[field] !== expected[field]) ||
    (expected.generation !== undefined &&
      (proof.ownership.generation !== expected.generation ||
        proof.ownership.nativeEpoch !== expected.nativeEpoch)) ||
    JSON.stringify(proof.config) !== JSON.stringify(expected.config)
  )
    throw new Error("native_metric_owner_or_config_mismatch");
}

export function assertNativeMetricReadyProof(
  raw: unknown,
  input: NativeMetricListeningExpectation,
): Readonly<NativeMetricReadyProof> {
  const proof = nativeMetricReadyProofSchema.parse(raw);
  assertMetricCaptureExpectation(proof, input);
  return freeze(proof);
}

export function assertNativeMetricArmProof(
  raw: NativeMetricArmProof,
  input: NativeMetricListeningExpectation,
): Readonly<NativeMetricArmProof> {
  const proof = nativeMetricArmProofSchema.parse(raw);
  assertMetricCaptureExpectation(proof, input);
  return freeze(proof);
}

/** Host projection is for clock alignment only, never metric coordinates. */
function launchCoordinates(
  armed: NativeMetricArmProof,
  launched: NativeMetricLaunchProof,
) {
  const g: MetricListeningGeometry = armed.config.geometry;
  const timing = launched.timing;
  const armCounter = armed.receipt.timing[5];
  const hostOffsetSamples =
    armed.before.frames[0]![2] - armed.before.frames[0]![4];
  const originCounter = armCounter + timing[1] - timing[4];
  const startSample = originCounter + hostOffsetSamples;
  const endSample = startSample + g.totalSamples;
  if (
    JSON.stringify(armed.ownership) !== JSON.stringify(launched.ownership) ||
    timing[5] !== armCounter ||
    timing[4] > g.vectorSize ||
    timing[1] < timing[4] ||
    timing[1] > 10 * g.sampleRate ||
    timing[6] !== originCounter ||
    originCounter + g.totalSamples + g.vectorSize >= LIMIT ||
    launched.clock[4] < originCounter ||
    (timing[3] === 0 &&
      launched.clock[4] < originCounter + g.totalSamples + g.vectorSize - 1) ||
    !Number.isSafeInteger(startSample) ||
    !Number.isSafeInteger(endSample) ||
    startSample < 0 ||
    (armed.config.timingPolicy.mode === "strict" &&
      launched.clock[2] - startSample > g.sampleRate / 10 + g.vectorSize)
  )
    throw new Error("native_metric_launch_binding_mismatch");
  const residual =
    launched.clock[2] -
    Math.round(
      ((launched.clock[1] - g.startBeat) * g.sampleRate * 60) / g.tempoBpm,
    ) -
    startSample;
  evaluateListeningAlignment(armed.config.timingPolicy, {
    sampleRate: g.sampleRate,
    vectorSize: g.vectorSize,
    observedClockDisagreementSamples: Math.abs(
      launched.clock[2] - launched.clock[4] - hostOffsetSamples,
    ),
    observedBeatDisagreementSamples: Math.abs(residual),
  });
  return { startSample, originCounter, hostOffsetSamples };
}

export function nativeMetricLaunchCoordinates(
  rawArm: NativeMetricArmProof,
  rawLaunch: NativeMetricLaunchProof,
  expected: NativeMetricListeningExpectation,
) {
  if (expected.generation === undefined || expected.nativeEpoch === undefined)
    throw new Error("native_metric_missing_owner_pin");
  const armed = assertNativeMetricArmProof(rawArm, expected);
  const launched = nativeMetricLaunchProofSchema.parse(rawLaunch);
  const coordinates = launchCoordinates(armed, launched);
  return Object.freeze({
    startSample: coordinates.originCounter,
    endSample: coordinates.originCounter + armed.config.geometry.totalSamples,
    originCounter: coordinates.originCounter,
    hostOffsetSamples: coordinates.hostOffsetSamples,
    hostStartSample: coordinates.startSample,
    hostEndSample: coordinates.startSample + armed.config.geometry.totalSamples,
  });
}

/**
 * Metric geometry/source coverage uses native source counters: origin..end.
 * Local records map as originCounter+localSample, including pre-onset supports.
 * Host projections are separate alignment diagnostics, not absolute accuracy.
 * No optional metric or clip identity claim.
 */
export function assertNativeMetricSourceCoverage(
  raw: NativeMetricSourceCoverageProof,
  expected: NativeMetricListeningExpectation,
) {
  if (expected.generation === undefined || expected.nativeEpoch === undefined)
    throw new Error("native_metric_missing_owner_pin");
  const proof = nativeMetricSourceCoverageProofSchema.parse(raw);
  const armed = assertNativeMetricArmProof(proof.armed, expected);
  const coordinates = launchCoordinates(armed, proof.launched);
  if (
    proof.completion.fields.some(
      (cell, index) => cell !== armed.receipt.fields[index],
    ) ||
    proof.completion.timing.some(
      (cell, index) =>
        cell !== (index === 3 ? 0 : proof.launched.timing[index]),
    ) ||
    proof.after.frames[0]![4] <
      coordinates.originCounter +
        armed.config.geometry.totalSamples +
        armed.config.geometry.vectorSize -
        1
  )
    throw new Error("native_metric_completion_receipt_mismatch");
  const checked = assertNativeCheckedTransportSourceCoverage({
    policy: armed.config.timingPolicy,
    geometry: armed.config.geometry,
    ...(armed.config.mode === "session"
      ? { stoppedBeat: armed.config.stoppedBeat }
      : {}),
    before: armed.before,
    after: proof.after,
    timingWitnesses: proof.timingWitnesses,
    launchedHost: {
      sample: proof.launched.clock[2],
      beat: proof.launched.clock[1],
      flags: proof.launched.clock[3],
      playing: true,
    },
    coordinates,
    additionalClocks: [proof.launched.clock],
    errorPrefix: "native_metric",
  });
  return Object.freeze({
    startSample: checked.originCounter,
    endSample: checked.originCounter + armed.config.geometry.totalSamples,
    originCounter: checked.originCounter,
    hostOffsetSamples: checked.hostOffsetSamples,
    hostStartSample: checked.startSample,
    hostEndSample: checked.endSample,
    alignment: checked.alignment,
  });
}

/**
 * Bind a final observation to frozen admission and native source coverage.
 * Metric parsing replays detector inputs; this does not certify physical
 * source identity or replace application-owned Session/target admission.
 */
export function assertNativeMetricObservationSource(
  rawProof: NativeMetricSourceCoverageProof,
  rawObservation: MetricAudioObservation,
  expected: NativeMetricListeningExpectation,
): Readonly<MetricAudioObservation> {
  const proof = nativeMetricSourceCoverageProofSchema.parse(rawProof);
  const checked = assertNativeMetricSourceCoverage(proof, expected);
  const observation = metricAudioObservationSchema.parse(rawObservation);
  const config = proof.armed.config;
  const local = config.geometry;
  const geometry = createMetricListeningGeometry({
    sampleRate: local.sampleRate,
    vectorSize: local.vectorSize,
    tempoBpm: local.tempoBpm,
    startBeat: local.startBeat,
    endBeat: local.endBeat,
    startSample: checked.originCounter,
  });
  if (
    JSON.stringify(observation.ownership) !==
      JSON.stringify(proof.armed.ownership) ||
    observation.source.view !== config.mode ||
    (config.sourceContext !== undefined &&
      JSON.stringify(observation.source) !==
        JSON.stringify(config.sourceContext)) ||
    JSON.stringify(observation.geometry) !== JSON.stringify(geometry) ||
    observation.sourceCoverage.startSample !== checked.startSample ||
    observation.sourceCoverage.endSample !== checked.endSample ||
    JSON.stringify(observation.alignment) !==
      JSON.stringify(checked.alignment) ||
    JSON.stringify(observation.requestedMetrics) !==
      JSON.stringify(config.requestedMetrics) ||
    (config.mode === "session" &&
      observation.source.view === "session" &&
      JSON.stringify(observation.source.target) !==
        JSON.stringify(config.source.target))
  )
    throw new Error("native_metric_observation_binding_mismatch");
  if (config.requestedMetrics.includes("attacks")) {
    const settings = config.attacks;
    const algorithm = observation.metrics.attacks.algorithm;
    if (
      !settings ||
      !algorithm ||
      algorithm.thresholdDb !== settings.thresholdDb ||
      algorithm.minSpacingSamples !== settings.minSpacingSamples ||
      algorithm.windowSamples !== proof.armed.receipt.fields[2]
    )
      throw new Error("native_metric_attack_configuration_mismatch");
  }
  const spectrum = observation.metrics["spectral-centroid"];
  if (
    proof.spectrumCleanup &&
    (proof.spectrumCleanup.status !== "completed" ||
      proof.spectrumCleanup.generation !== proof.armed.ownership.generation ||
      proof.spectrumCleanup.nativeEpoch !== proof.armed.ownership.nativeEpoch)
  )
    throw new Error("native_metric_spectrum_cleanup_unconfirmed");
  if (spectrum.algorithm?.firstFrameEndSample != null) {
    const phase = proof.spectrumPhase;
    if (
      !phase ||
      !proof.spectrumCleanup ||
      JSON.stringify(phase.ownership) !==
        JSON.stringify(proof.armed.ownership) ||
      JSON.stringify(phase.clock.dsp) !==
        JSON.stringify(proof.armed.before.dsp) ||
      phase.clock.frames[31]![4] > proof.armed.receipt.timing[5] ||
      phase.clock.frames[31]![4] <
        proof.armed.receipt.timing[5] - local.sampleRate ||
      spectrum.algorithm.firstFrameEndSample !==
        nativeMetricFirstSpectrumEndpoint(phase, checked.originCounter)
    )
      throw new Error("native_metric_spectrum_phase_binding_mismatch");
  }
  return freeze(observation);
}
