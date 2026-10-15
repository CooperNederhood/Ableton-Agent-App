import { z } from "zod";
import {
  audioObservationV2Schema,
  type AudioObservationV2,
} from "./audio-observation-schemas.js";
import {
  nativeListeningGeometrySchema,
  type NativeListeningGeometry,
} from "./native-listening-geometry.js";
import {
  nativeArmProofSchema,
  nativeHostClockRowSchema,
  nativeListenerLifecycleSchema,
} from "./native-listening-schemas.js";
import {
  evaluateListeningAlignment,
  listeningTimingPolicySchema,
  type ListeningTimingPolicy,
} from "./listening-timing-schemas.js";

export const NATIVE_LISTENER_SCOPE_V2 = "arrangement-descriptive/v2" as const;
const COUNTER_LIMIT = 2 ** 44;
const FFT = 2_048;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counter = integer.max(COUNTER_LIMIT - 1);
const epoch = integer.min(1).max(1_000_000);
const amplitude = z.number().finite().min(0).max(64);
type ClockRow = z.infer<typeof nativeHostClockRowSchema>;

function coherent(row: ClockRow): boolean {
  return (
    row[0] === row[7] &&
    row[1] === row[8] &&
    row[2] === row[9] &&
    row[3] === row[10] &&
    (row[3] & 19) === 19 &&
    row[4] === row[6]
  );
}

function clockBinding(playing: boolean) {
  return z
    .strictObject({
      dsp: z.tuple([
        z.literal(1),
        z.union([z.literal(44_100), z.literal(48_000)]),
        nativeListeningGeometrySchema.shape.vectorSize,
      ]),
      frames: z.array(nativeHostClockRowSchema).length(32),
    })
    .superRefine((value, ctx) => {
      let previous: ClockRow | undefined;
      for (const row of value.frames) {
        if (
          !coherent(row) ||
          row[0] !== Number(playing) ||
          (previous !== undefined &&
            (row[4] <= previous[4] ||
              row[2] < previous[2] ||
              row[1] < previous[1] ||
              (!playing && (row[1] !== previous[1] || row[5] !== previous[5]))))
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Incoherent native v2 clock bracket",
          });
          return;
        }
        previous = row;
      }
      const first = value.frames[0];
      const last = value.frames.at(-1);
      if (first && last && last[4] - first[4] > value.dsp[1]) {
        ctx.addIssue({
          code: "custom",
          message: "Stale native v2 clock binding",
        });
      }
    });
}

export const nativeArmProofV2Schema = z
  .strictObject({
    scope: z.literal(NATIVE_LISTENER_SCOPE_V2),
    policy: listeningTimingPolicySchema,
    geometry: nativeListeningGeometrySchema,
    nativeEpoch: epoch,
    armCounter: counter,
    before: clockBinding(false),
    reset: nativeArmProofSchema.shape.reset,
  })
  .superRefine((value, ctx) => {
    const first = value.before.frames[0];
    const last = value.before.frames.at(-1);
    if (!first || !last) return;
    const baseline = first[2] - first[4];
    if (
      value.before.dsp[1] !== value.geometry.sampleRate ||
      value.before.dsp[2] !== value.geometry.vectorSize ||
      value.armCounter < last[4] ||
      value.armCounter - last[4] > value.geometry.sampleRate ||
      value.armCounter + value.geometry.totalSamples >= COUNTER_LIMIT ||
      value.before.frames.some((row) => row[1] !== value.geometry.startBeat)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Native v2 arm geometry or freshness mismatch",
      });
    }
    if (
      value.before.frames.some(
        (row) =>
          Math.abs(row[2] - row[4] - baseline) >
          value.policy.maxClockDisagreementSamples,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Native v2 arm alignment budget exceeded",
      });
    }
  });
export type NativeArmProofV2 = z.infer<typeof nativeArmProofV2Schema>;

export const nativeLaunchProofV2Schema = z.strictObject({
  nativeEpoch: epoch,
  armCounter: counter,
  launchClock: integer.max(480_000),
  launchPhaseSamples: integer.max(1_024),
  rejected: z.literal(0),
  active: z.literal(1),
  host: z.strictObject({
    sample: integer,
    beat: z.number().finite().min(0).max(1_576_800),
    flags: integer.max(0x7fffffff).refine((value) => (value & 19) === 19),
    playing: z.literal(true),
  }),
});
export type NativeLaunchProofV2 = z.infer<typeof nativeLaunchProofV2Schema>;

export const nativeCaptureProofV2Schema = z.strictObject({
  armed: nativeArmProofV2Schema,
  launched: nativeLaunchProofV2Schema,
  after: clockBinding(true),
  timingWitnesses: z.strictObject({
    minHostOffset: nativeHostClockRowSchema,
    maxHostOffset: nativeHostClockRowSchema,
    minBeatOrigin: nativeHostClockRowSchema,
    maxBeatOrigin: nativeHostClockRowSchema,
  }),
  envelopeRms: z
    .array(z.tuple([amplitude, amplitude]))
    .min(1)
    .max(300),
  spectralWindows: z
    .array(
      z.tuple([
        integer,
        integer,
        z.number().finite().min(0).max(24_000),
        z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
      ]),
    )
    .min(1)
    .max(300),
});
export type NativeCaptureProofV2 = z.infer<typeof nativeCaptureProofV2Schema>;
export const nativeListenerLifecycleV2Schema = nativeListenerLifecycleSchema
  .extend({
    scope: z.literal(NATIVE_LISTENER_SCOPE_V2),
    frames: integer.max(300),
    phase: z.enum(["preflight", "reset", "capture", "alignment"]).optional(),
  })
  .refine(
    (value) =>
      !["failed", "cancelled"].includes(value.stage) ||
      value.reason !== undefined,
    {
      message: "Native v2 failure/cancellation requires an explanatory reason",
    },
  );
export interface NativeListeningExpectationV2 {
  readonly policy: Readonly<ListeningTimingPolicy>;
  readonly geometry: Readonly<NativeListeningGeometry>;
  readonly listenerId: string;
  readonly passId: string;
}

export function snapshotNativeListeningExpectationV2(
  input: NativeListeningExpectationV2,
): Readonly<NativeListeningExpectationV2> {
  const identifier = z.string().min(1).max(200);
  return Object.freeze({
    policy: Object.freeze(listeningTimingPolicySchema.parse(input.policy)),
    geometry: Object.freeze(
      nativeListeningGeometrySchema.parse(input.geometry),
    ),
    listenerId: identifier.parse(input.listenerId),
    passId: identifier.parse(input.passId),
  });
}

function assertExpectation(
  armed: NativeArmProofV2,
  expected: NativeListeningExpectationV2,
): void {
  const policy = listeningTimingPolicySchema.parse(expected.policy);
  const geometry = nativeListeningGeometrySchema.parse(expected.geometry);
  if (
    policy.mode !== armed.policy.mode ||
    policy.maxClockDisagreementSamples !==
      armed.policy.maxClockDisagreementSamples ||
    Object.keys(geometry).some(
      (key) => Reflect.get(geometry, key) !== Reflect.get(armed.geometry, key),
    )
  )
    throw new Error("native_v2_policy_or_geometry_mismatch");
}

export function nativeLaunchCoordinatesV2(
  rawArm: NativeArmProofV2,
  rawLaunch: NativeLaunchProofV2,
  expected: NativeListeningExpectationV2,
) {
  const armed = nativeArmProofV2Schema.parse(rawArm);
  const launched = nativeLaunchProofV2Schema.parse(rawLaunch);
  assertExpectation(armed, expected);
  const first = armed.before.frames[0];
  if (!first) throw new Error("invalid_native_v2_host_binding");
  const geometry = armed.geometry;
  const hostOffsetSamples = first[2] - first[4];
  const originCounter =
    armed.armCounter + launched.launchClock - launched.launchPhaseSamples;
  const startSample = originCounter + hostOffsetSamples;
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const launchResidual =
    launched.host.sample -
    Math.round((launched.host.beat - geometry.startBeat) * samplesPerBeat) -
    startSample;
  if (
    launched.nativeEpoch !== armed.nativeEpoch ||
    launched.armCounter !== armed.armCounter ||
    launched.launchPhaseSamples > geometry.vectorSize ||
    launched.launchClock < launched.launchPhaseSamples ||
    launched.launchClock > 10 * geometry.sampleRate ||
    originCounter + geometry.totalSamples >= COUNTER_LIMIT ||
    !Number.isSafeInteger(startSample) ||
    startSample < 0 ||
    launched.host.sample <
      startSample - armed.policy.maxClockDisagreementSamples ||
    launched.host.sample - startSample >
      geometry.hopSamples +
        geometry.vectorSize +
        armed.policy.maxClockDisagreementSamples
  )
    throw new Error("native_v2_launch_binding_mismatch");
  evaluateListeningAlignment(armed.policy, {
    sampleRate: geometry.sampleRate,
    vectorSize: geometry.vectorSize,
    observedClockDisagreementSamples: 0,
    observedBeatDisagreementSamples: Math.abs(launchResidual),
  });
  return Object.freeze({ startSample, originCounter, hostOffsetSamples });
}

function near(actual: number | null, expected: number | null): boolean {
  return (
    actual === expected ||
    (actual !== null &&
      expected !== null &&
      Math.abs(actual - expected) <=
        512 *
          Number.EPSILON *
          Math.max(1, Math.abs(actual), Math.abs(expected)))
  );
}

function dbfs(amplitude: number): number | null {
  return amplitude <= 1e-6 ? null : 20 * Math.log10(amplitude);
}

/** Independent native completeness and observed alignment checks; no absolute accuracy claim. */
export function assertNativeCaptureObservationV2(
  rawProof: NativeCaptureProofV2,
  rawObservation: AudioObservationV2,
  expected: NativeListeningExpectationV2,
): void {
  const proof = nativeCaptureProofV2Schema.parse(rawProof);
  const observation = audioObservationV2Schema.parse(rawObservation);
  const armed = proof.armed;
  const geometry = armed.geometry;
  const coordinates = nativeLaunchCoordinatesV2(
    armed,
    proof.launched,
    expected,
  );
  const { startSample, originCounter, hostOffsetSamples } = coordinates;
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const windows = Math.ceil(geometry.totalSamples / geometry.hopSamples);
  const endCounter = originCounter + geometry.totalSamples;
  const last = proof.after.frames.at(-1);
  if (
    observation.listenerId !== expected.listenerId ||
    observation.passId !== expected.passId ||
    observation.sampleRate !== geometry.sampleRate ||
    observation.startBeat !== geometry.startBeat ||
    observation.endBeat !==
      geometry.startBeat + geometry.totalSamples / samplesPerBeat ||
    observation.startSample !== startSample ||
    observation.endSample !== startSample + geometry.totalSamples ||
    !observation.complete ||
    observation.reduction.truncated ||
    observation.algorithm.name !== "native-max-stereo-energy-envelope-rise" ||
    observation.algorithm.version !== "2.0.0" ||
    observation.algorithm.windowSamples !== FFT ||
    observation.algorithm.hopSamples !== geometry.hopSamples ||
    proof.after.dsp[1] !== geometry.sampleRate ||
    proof.after.dsp[2] !== geometry.vectorSize ||
    observation.samples.length !== windows ||
    proof.spectralWindows.length !== windows ||
    proof.envelopeRms.length !== windows ||
    !last ||
    last[4] < endCounter ||
    last[4] - endCounter > geometry.sampleRate
  )
    throw new Error("native_v2_capture_coverage_mismatch");

  let clockDisagreement = 0;
  let beatDisagreement = Math.abs(
    proof.launched.host.sample -
      Math.round(
        (proof.launched.host.beat - geometry.startBeat) * samplesPerBeat,
      ) -
      startSample,
  );
  const firstBefore = armed.before.frames[0];
  if (!firstBefore) throw new Error("invalid_native_v2_host_binding");
  const firstCounter = firstBefore[4];
  const witnessRows = Object.values(proof.timingWitnesses);
  const offsets: number[] = [];
  const beatOrigins: number[] = [
    proof.launched.host.sample -
      Math.round(
        (proof.launched.host.beat - geometry.startBeat) * samplesPerBeat,
      ),
  ];
  const retainedClocks = [
    ...armed.before.frames,
    ...proof.after.frames,
    ...witnessRows,
  ].sort((left, right) => left[4] - right[4]);
  let previousClock: ClockRow | undefined;
  for (const row of retainedClocks) {
    if (
      !coherent(row) ||
      row[4] < firstCounter ||
      row[4] > last[4] ||
      (row[0] === 0 && row[1] !== geometry.startBeat)
    ) {
      throw new Error("native_v2_timing_witness_mismatch");
    }
    if (
      previousClock &&
      row[4] === previousClock[4] &&
      row.some((value, index) => value !== previousClock?.[index])
    ) {
      throw new Error("native_v2_changed_clock_hold");
    }
    if (
      previousClock &&
      (row[2] < previousClock[2] ||
        row[1] < previousClock[1] ||
        (previousClock[0] === 1 && row[0] === 0))
    ) {
      throw new Error("native_v2_transport_regression");
    }
    previousClock = row;
    const offset = row[2] - row[4];
    offsets.push(offset);
    clockDisagreement = Math.max(
      clockDisagreement,
      Math.abs(offset - hostOffsetSamples),
    );
    if (row[0] === 1) {
      const beatOrigin =
        row[2] - Math.round((row[1] - geometry.startBeat) * samplesPerBeat);
      beatOrigins.push(beatOrigin);
      const residual = beatOrigin - startSample;
      const phaseSamples = Math.round(row[5] * samplesPerBeat);
      const beatPhaseSamples = Math.round((row[1] % 1) * samplesPerBeat);
      const phaseDifference = Math.abs(phaseSamples - beatPhaseSamples);
      const circularDifference = Math.min(
        phaseDifference,
        Math.abs(Math.round(samplesPerBeat) - phaseDifference),
      );
      beatDisagreement = Math.max(
        beatDisagreement,
        Math.abs(residual),
        circularDifference,
      );
    }
  }
  const witnesses = proof.timingWitnesses;
  const beatOriginOf = (row: ClockRow): number =>
    row[2] - Math.round((row[1] - geometry.startBeat) * samplesPerBeat);
  if (
    witnesses.minHostOffset[2] - witnesses.minHostOffset[4] !==
      Math.min(...offsets) ||
    witnesses.maxHostOffset[2] - witnesses.maxHostOffset[4] !==
      Math.max(...offsets) ||
    witnesses.minBeatOrigin[0] !== 1 ||
    witnesses.maxBeatOrigin[0] !== 1 ||
    beatOriginOf(witnesses.minBeatOrigin) !== Math.min(...beatOrigins) ||
    beatOriginOf(witnesses.maxBeatOrigin) !== Math.max(...beatOrigins)
  )
    throw new Error("native_v2_timing_extrema_mismatch");
  for (const row of proof.after.frames) {
    if (row[4] < endCounter)
      throw new Error("native_v2_post_binding_before_coverage");
  }
  const quality = evaluateListeningAlignment(armed.policy, {
    sampleRate: geometry.sampleRate,
    vectorSize: geometry.vectorSize,
    observedClockDisagreementSamples: clockDisagreement,
    observedBeatDisagreementSamples: beatDisagreement,
  });
  if (JSON.stringify(quality) !== JSON.stringify(observation.alignment)) {
    throw new Error("native_v2_alignment_quality_mismatch");
  }

  let previousCounter = originCounter;
  let previousSpectrum:
    NativeCaptureProofV2["spectralWindows"][number] | undefined;
  let grid: number | undefined;
  let energy = 0;
  let centroidSum = 0;
  const peak: [number, number] = [0, 0];
  const squareSum: [number, number] = [0, 0];
  const attacks: AudioObservationV2["attacks"] = [];
  let previousLevel = -120;
  let lastAttack = -Infinity;
  let riseHasAttack = false;
  if (
    observation.algorithm.settings.minAttackSpacingSamples !==
      geometry.hopSamples ||
    observation.algorithm.settings.attackThresholdDb !== 6
  ) {
    throw new Error("native_v2_attack_settings_mismatch");
  }
  for (let index = 0; index < windows; index++) {
    const point = observation.samples[index];
    const envelope = proof.envelopeRms[index];
    const spectrum = proof.spectralWindows[index];
    if (!point || !envelope || !spectrum)
      throw new Error("native_v2_missing_window");
    const expectedCounter = Math.min(
      originCounter + (index + 1) * geometry.hopSamples,
      endCounter,
    );
    const count = expectedCounter - previousCounter;
    if (
      point.sample !== expectedCounter + hostOffsetSamples ||
      point.beat !==
        geometry.startBeat +
          (expectedCounter - originCounter) / samplesPerBeat ||
      spectrum[1] - spectrum[0] !== FFT ||
      spectrum[0] < startSample ||
      spectrum[1] > point.sample ||
      point.sample - spectrum[1] >= FFT ||
      spectrum[2] > geometry.sampleRate / 2 ||
      (grid !== undefined && spectrum[0] % FFT !== grid) ||
      (spectrum[3] <= 1e-20 && spectrum[2] !== 0) ||
      point.centroidHz !== (spectrum[3] <= 1e-20 ? null : spectrum[2])
    )
      throw new Error("native_v2_descriptor_coordinates_mismatch");
    const prior = previousSpectrum;
    if (
      prior &&
      spectrum[1] === prior[1] &&
      spectrum.some((value, component) => value !== prior[component])
    ) {
      throw new Error("native_v2_changed_spectral_hold");
    }
    previousSpectrum = spectrum;
    grid = spectrum[0] % FFT;
    for (const channel of [0, 1] as const) {
      const rawPeak = point.peak[channel];
      const rawRms = envelope[channel];
      if (
        rawPeak === undefined ||
        rawRms === undefined ||
        rawPeak > 64 ||
        rawRms > rawPeak + 1e-8 ||
        !near(point.rmsDbfs[channel], dbfs(rawRms))
      ) {
        throw new Error("native_v2_envelope_measurement_mismatch");
      }
      peak[channel] = Math.max(peak[channel], rawPeak);
      squareSum[channel] += rawRms * rawRms * count;
    }
    if (point.centroidHz !== null) {
      const weightedEnergy = (spectrum[3] * count) / geometry.hopSamples;
      energy += weightedEnergy;
      centroidSum += point.centroidHz * weightedEnergy;
    }
    const level = Math.max(...point.rmsDbfs.map((value) => value ?? -120));
    const rise = level - previousLevel;
    if (rise <= 0) riseHasAttack = false;
    if (
      !riseHasAttack &&
      level > -120 &&
      rise > 0 &&
      rise >= observation.algorithm.settings.attackThresholdDb &&
      point.sample - lastAttack >=
        observation.algorithm.settings.minAttackSpacingSamples
    ) {
      attacks.push({ sample: point.sample, beat: point.beat, strength: rise });
      lastAttack = point.sample;
      riseHasAttack = true;
    }
    previousLevel = level;
    previousCounter = expectedCounter;
  }
  for (const channel of [0, 1] as const) {
    if (
      observation.summaries.peak[channel] !== peak[channel] ||
      !near(
        observation.summaries.rmsDbfs[channel],
        dbfs(Math.sqrt(squareSum[channel] / geometry.totalSamples)),
      )
    ) {
      throw new Error("native_v2_envelope_summary_mismatch");
    }
  }
  if (
    !near(
      observation.summaries.centroidHz,
      energy <= 1e-20 ? null : centroidSum / energy,
    )
  ) {
    throw new Error("native_v2_spectral_summary_mismatch");
  }
  if (JSON.stringify(attacks) !== JSON.stringify(observation.attacks)) {
    throw new Error("native_v2_attack_measurement_mismatch");
  }
}
