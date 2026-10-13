import { z } from "zod";

export const MAX_AUDIO_OBSERVATION_SAMPLES = 1_024;
export const MAX_AUDIO_OBSERVATION_ATTACKS = 512;
export const MAX_AUDIO_OBSERVATION_BYTES = 256 * 1_024;

const identifier = z.string().min(1).max(200);
const sample = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const beat = z.number().finite().nonnegative();
const amplitude = z.number().finite().nonnegative();
const rms = z.number().finite().nullable();
const centroid = z.number().finite().nonnegative().nullable();
const stereoPeak = z.tuple([amplitude, amplitude]);
const stereoRms = z.tuple([rms, rms]);

export const audioObservationSampleSchema = z.strictObject({
  sample,
  beat,
  peak: stereoPeak,
  rmsDbfs: stereoRms,
  centroidHz: centroid,
});

export const audioObservationAttackSchema = z.strictObject({
  sample,
  beat,
  strength: amplitude,
});

/** Processed descriptors only. Null denotes silence/below-floor, never -Infinity. */
export const audioObservationSchema = z
  .strictObject({
    schema: z.literal("audio-observation/v1"),
    listenerId: identifier,
    passId: identifier,
    sampleRate: z.number().int().min(8_000).max(384_000),
    startSample: sample,
    endSample: sample,
    startBeat: beat,
    endBeat: beat,
    complete: z.boolean(),
    limitations: z.array(z.string().min(1).max(500)).max(32),
    algorithm: z.strictObject({
      name: z.string().min(1).max(100),
      version: z.string().min(1).max(100),
      windowSamples: z.number().int().min(1).max(65_536),
      hopSamples: z.number().int().min(1).max(65_536),
      settings: z.strictObject({
        attackThresholdDb: z.number().finite().min(0).max(120),
        minAttackSpacingSamples: sample,
      }),
      units: z.strictObject({
        amplitude: z.literal("linear"),
        rms: z.literal("dBFS"),
        centroid: z.literal("Hz"),
      }),
      timingUncertaintySamples: sample,
    }),
    summaries: z.strictObject({
      peak: stereoPeak,
      rmsDbfs: stereoRms,
      centroidHz: centroid,
    }),
    samples: z
      .array(audioObservationSampleSchema)
      .max(MAX_AUDIO_OBSERVATION_SAMPLES),
    attacks: z
      .array(audioObservationAttackSchema)
      .max(MAX_AUDIO_OBSERVATION_ATTACKS),
    reduction: z.strictObject({
      originalSamples: sample,
      originalAttacks: sample,
      truncated: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (
      value.endSample < value.startSample ||
      value.endBeat < value.startBeat
    ) {
      issue("Capture coordinates must be ordered");
    }
    for (const points of [value.samples, value.attacks]) {
      let previousSample = value.startSample;
      let previousBeat = value.startBeat;
      for (const point of points) {
        if (
          point.sample < previousSample ||
          point.sample > value.endSample ||
          point.beat < previousBeat ||
          point.beat > value.endBeat
        ) {
          issue("Descriptor coordinates must be monotonic and within capture");
        }
        previousSample = point.sample;
        previousBeat = point.beat;
      }
    }
    if (
      value.reduction.originalSamples < value.samples.length ||
      value.reduction.originalAttacks < value.attacks.length
    ) {
      issue("Reduction counts cannot be smaller than retained detail");
    }
    if (
      !value.reduction.truncated &&
      (value.reduction.originalSamples !== value.samples.length ||
        value.reduction.originalAttacks !== value.attacks.length)
    ) {
      issue("Reduced detail must declare truncation");
    }
    if (value.complete && value.reduction.truncated) {
      issue("Truncated capture cannot claim complete coverage");
    }
    for (const descriptor of [value.summaries, ...value.samples]) {
      if (
        descriptor.centroidHz !== null &&
        descriptor.centroidHz > value.sampleRate / 2
      ) {
        issue("Centroid cannot exceed Nyquist");
      }
    }
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_AUDIO_OBSERVATION_BYTES
    ) {
      issue("Observation exceeds encoded payload quota");
    }
  });

export type AudioObservation = z.infer<typeof audioObservationSchema>;
