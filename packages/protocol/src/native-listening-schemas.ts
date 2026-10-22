import { z } from "zod";
import type { AudioObservation } from "./audio-observation-schemas.js";

export const NATIVE_LISTENER_SCOPE =
  "arrangement-beat0-120bpm-48000hz-vector64/v1" as const;

const counterLimit = 2 ** 44;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const counter = integer.max(counterLimit - 1);
const epoch = integer.min(1).max(1_000_000);
export const nativeHostClockRowSchema = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.number().finite().min(0).max(1_000_000_000),
  integer,
  integer.max(0x7fffffff),
  counter,
  z.number().finite().min(0).max(1),
  counter,
  z.union([z.literal(0), z.literal(1)]),
  z.number().finite().min(0).max(1_000_000_000),
  integer,
  integer.max(0x7fffffff),
]);

function clockBinding(playing: boolean) {
  return z
    .strictObject({
      dsp: z.tuple([z.literal(1), z.literal(48000), z.literal(64)]),
      frames: z.array(nativeHostClockRowSchema).length(32),
    })
    .superRefine((binding, ctx) => {
      let previous = -1;
      let offset: number | undefined;
      let beatZero: number | undefined;
      for (const row of binding.frames) {
        const candidateOffset = row[2] - row[4];
        const candidateZero = row[2] - Math.round(row[1] * 24000);
        if (
          row[0] !== Number(playing) ||
          row[7] !== row[0] ||
          row[1] !== row[8] ||
          row[2] !== row[9] ||
          row[3] !== row[10] ||
          (row[3] & 19) !== 19 ||
          row[4] !== row[6] ||
          row[4] <= previous ||
          (offset !== undefined && offset !== candidateOffset) ||
          (!playing && row[1] !== 0) ||
          (playing &&
            ((Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) %
              24000 !==
              0 ||
              (beatZero !== undefined && beatZero !== candidateZero)))
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Incoherent native host-clock bracket",
          });
          return;
        }
        previous = row[4];
        offset = candidateOffset;
        beatZero = candidateZero;
      }
    });
}

export const nativeArmProofSchema = z
  .strictObject({
    scope: z.literal(NATIVE_LISTENER_SCOPE),
    nativeEpoch: epoch,
    armCounter: counter.max(counterLimit - 480001),
    before: clockBinding(false),
    reset: z.strictObject({
      launchClock: z.literal(-1),
      sourceClock: z.literal(-1),
      onsetCount: z.literal(0),
      rejected: z.literal(0),
      active: z.literal(0),
      launchPhaseSamples: z.literal(-1),
      firstSourceClock: z.literal(-1),
      completedSamples: z.literal(0),
    }),
  })
  .superRefine((proof, ctx) => {
    const last = proof.before.frames.at(-1);
    if (
      last !== undefined &&
      (proof.armCounter < last[4] || proof.armCounter - last[4] > 720000)
    )
      ctx.addIssue({ code: "custom", message: "Stale native arm binding" });
  });
export type NativeArmProof = z.infer<typeof nativeArmProofSchema>;

export const nativeLaunchProofSchema = z.strictObject({
  nativeEpoch: epoch,
  armCounter: counter,
  launchClock: integer.max(480000),
  launchPhaseSamples: integer.max(64),
  rejected: z.literal(0),
  active: z.literal(1),
  host: z.strictObject({
    sample: integer,
    beat: z.number().finite().min(0).max(1_000_000_000),
    flags: integer.max(0x7fffffff).refine((flags) => (flags & 19) === 19),
    playing: z.literal(true),
  }),
});
export type NativeLaunchProof = z.infer<typeof nativeLaunchProofSchema>;

export const nativeCaptureProofSchema = z.strictObject({
  armed: nativeArmProofSchema,
  launched: nativeLaunchProofSchema,
  after: clockBinding(true),
  // Start/end host samples, centroid Hz and unnormalized pooled stereo energy.
  spectralWindows: z
    .array(
      z.tuple([
        integer,
        integer,
        z.number().finite().min(0).max(24000),
        z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
      ]),
    )
    .min(1)
    .max(100),
});
export type NativeCaptureProof = z.infer<typeof nativeCaptureProofSchema>;

export const nativeListenerLifecycleSchema = z.strictObject({
  eventId: z.string().uuid(),
  causationId: z.string().min(1).max(128),
  phase: z.enum(["preflight", "reset", "capture"]).optional(),
  generation: z.string().uuid().optional(),
  stage: z.enum([
    "queued",
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
  ]),
  nativeEpoch: integer.max(1_000_000),
  elapsedMs: z.number().finite().min(0).max(120000),
  frames: integer.max(100),
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,127}$/)
    .optional(),
});
export type NativeListenerLifecycle = z.infer<
  typeof nativeListenerLifecycleSchema
>;

export function nativeLaunchCoordinates(
  armed: NativeArmProof,
  launched: NativeLaunchProof,
): { startSample: number; originCounter: number; hostOffsetSamples: number } {
  const first = armed.before.frames[0];
  if (first === undefined) throw new Error("invalid_native_host_binding");
  const hostOffsetSamples = first[2] - first[4];
  const originCounter =
    armed.armCounter + launched.launchClock - launched.launchPhaseSamples;
  const startSample = originCounter + hostOffsetSamples;
  if (
    launched.nativeEpoch !== armed.nativeEpoch ||
    launched.armCounter !== armed.armCounter ||
    launched.launchClock < launched.launchPhaseSamples ||
    originCounter >= counterLimit ||
    !Number.isSafeInteger(startSample) ||
    startSample < 0 ||
    launched.host.sample - Math.round(launched.host.beat * 24000) !==
      startSample ||
    launched.host.sample < startSample ||
    launched.host.sample - startSample > 4864
  )
    throw new Error("native_launch_binding_mismatch");
  return { startSample, originCounter, hostOffsetSamples };
}

/** Independently verifies the producer's native coordinates before publication. */
export function assertNativeCaptureObservation(
  proof: NativeCaptureProof,
  observation: AudioObservation,
): void {
  const coordinates = nativeLaunchCoordinates(proof.armed, proof.launched);
  const duration = Math.round(observation.endBeat * 5) * 4800;
  const last = proof.after.frames.at(-1);
  if (
    observation.schema !== "audio-observation/v1" ||
    observation.sampleRate !== 48000 ||
    observation.startBeat !== 0 ||
    observation.endBeat <= 0 ||
    observation.endBeat > 20 ||
    !Number.isInteger(observation.endBeat * 5) ||
    !observation.complete ||
    observation.reduction.truncated ||
    observation.algorithm.windowSamples !== 2048 ||
    observation.algorithm.hopSamples !== 4800 ||
    observation.algorithm.timingUncertaintySamples > 64 ||
    observation.startSample !== coordinates.startSample ||
    observation.endSample !== coordinates.startSample + duration ||
    coordinates.originCounter + duration >= counterLimit ||
    observation.samples.length !== duration / 4800 ||
    proof.spectralWindows.length !== observation.samples.length ||
    last === undefined ||
    last[4] < coordinates.originCounter + duration ||
    last[4] - coordinates.originCounter - duration > 48000
  )
    throw new Error("native_capture_coverage_mismatch");
  for (const row of proof.after.frames) {
    if (
      row[2] - row[4] !== coordinates.hostOffsetSamples ||
      row[2] - Math.round(row[1] * 24000) !== coordinates.startSample ||
      row[4] < coordinates.originCounter + duration
    )
      throw new Error("native_post_binding_mismatch");
  }
  let grid: number | undefined;
  let centroidSum = 0;
  let energySum = 0;
  for (const [index, point] of observation.samples.entries()) {
    const window = proof.spectralWindows[index];
    if (
      window === undefined ||
      point.sample !== coordinates.startSample + (index + 1) * 4800 ||
      point.beat !== (point.sample - coordinates.startSample) / 24000 ||
      window[1] - window[0] !== 2048 ||
      window[0] < coordinates.startSample ||
      window[1] > point.sample ||
      point.sample - window[1] >= 2048 ||
      (window[3] <= 1e-20 && window[2] !== 0) ||
      point.centroidHz !== (window[3] <= 1e-20 ? null : window[2]) ||
      (grid !== undefined && window[0] % 2048 !== grid)
    )
      throw new Error("native_spectral_coordinates_mismatch");
    grid = window[0] % 2048;
    if (point.centroidHz !== null) {
      centroidSum += point.centroidHz * window[3];
      energySum += window[3];
    }
  }
  if (
    observation.summaries.centroidHz !==
    (energySum <= 1e-20 ? null : centroidSum / energySum)
  )
    throw new Error("native_spectral_summary_mismatch");
  for (const attack of observation.attacks) {
    if (attack.beat !== (attack.sample - coordinates.startSample) / 24000)
      throw new Error("native_attack_coordinates_mismatch");
  }
}
