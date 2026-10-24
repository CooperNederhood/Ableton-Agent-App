import { z } from "zod";
import { listeningAlignmentQualitySchema } from "./listening-timing-schemas.js";
import { inspectSessionListeningSourceParamsSchema } from "./session-listening-source-schemas.js";

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

const audioObservationBodySchema = z.strictObject({
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
});

function validateAudioObservation(
  value: Omit<z.infer<typeof audioObservationBodySchema>, "algorithm">,
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };
  if (value.endSample < value.startSample || value.endBeat < value.startBeat) {
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
}

/** Processed descriptors only. Null denotes silence/below-floor, never -Infinity. */
export const audioObservationSchema = z
  .strictObject({
    schema: z.literal("audio-observation/v1"),
    ...audioObservationBodySchema.shape,
  })
  .superRefine(validateAudioObservation);

export type AudioObservation = z.infer<typeof audioObservationSchema>;

function validateDescriptiveObservation(
  value: Omit<z.infer<typeof audioObservationBodySchema>, "algorithm"> & {
    alignment: z.infer<typeof listeningAlignmentQualitySchema>;
  },
  ctx: z.RefinementCtx,
): void {
  validateAudioObservation(value, ctx);
  if (value.sampleRate !== value.alignment.sampleRate) {
    ctx.addIssue({
      code: "custom",
      message:
        "Alignment quality must use the observation's actual sample rate",
    });
  }
}

export const audioObservationV2Schema = audioObservationBodySchema
  .extend({
    schema: z.literal("audio-observation/v2"),
    algorithm: audioObservationBodySchema.shape.algorithm.omit({
      timingUncertaintySamples: true,
    }),
    alignment: listeningAlignmentQualitySchema,
  })
  .superRefine(validateDescriptiveObservation);
export type AudioObservationV2 = z.infer<typeof audioObservationV2Schema>;

/** Historical message-rate evidence, not admission or physical source proof. */
export const sessionAudioObservationSchema = z
  .strictObject({
    ...audioObservationV2Schema.shape,
    schema: z.literal("session-audio-observation/v1"),
    source: z.strictObject({
      view: z.literal("session"),
      target: inspectSessionListeningSourceParamsSchema.shape.target,
      kind: z.enum(["midi", "warped-audio"]),
      coordinate: z.strictObject({
        unit: z.literal("beats"),
        iteration: z.literal(0),
        startBeat: z.literal(0),
        // Historical rounded coverage only; runtime independently checks exact geometry.
        endBeat: z.number().finite().positive().max(4.001),
      }),
      transport: z.strictObject({ startBeat: beat, endBeat: beat }),
      origin: z.strictObject({
        evidence: z.literal("message-rate-start-time-with-native-transport"),
        clipStartTimeBeats: z.number().finite(),
        observedAtGlobalBeat: z.number().finite(),
      }),
      continuity: z.strictObject({
        evidence: z.literal("message-rate-monitored"),
        followActions: z.enum(["disabled", "unknown"]),
      }),
    }),
  })
  .superRefine((value, ctx) => {
    validateDescriptiveObservation(value, ctx);
    const { coordinate, transport, origin } = value.source;
    if (
      value.startBeat !== 0 ||
      value.endBeat !== coordinate.endBeat ||
      Math.abs(transport.endBeat - transport.startBeat - value.endBeat) >
        1e-8 ||
      origin.clipStartTimeBeats !== transport.startBeat
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Session clip-local coverage and transport origin must agree",
      });
    }
  });
export type SessionAudioObservation = z.infer<
  typeof sessionAudioObservationSchema
>;

/** Coordinate conversion only; runtime owns source admission and native geometry proof. */
export function mapSessionAudioObservation(
  observation: AudioObservationV2,
  source: SessionAudioObservation["source"],
): SessionAudioObservation {
  const global = audioObservationV2Schema.parse(observation);
  const origin = source.transport.startBeat;
  return sessionAudioObservationSchema.parse({
    ...global,
    schema: "session-audio-observation/v1",
    startBeat: global.startBeat - origin,
    endBeat: global.endBeat - origin,
    samples: global.samples.map((point) => ({
      ...point,
      beat: point.beat - origin,
    })),
    attacks: global.attacks.map((point) => ({
      ...point,
      beat: point.beat - origin,
    })),
    source,
  });
}

/** Typed historical readings; no kind grants capture/publication authority. */
export const audioObservationKindSchema = z.enum([
  "audio-observation/v1",
  "audio-observation/v2",
  "session-audio-observation/v1",
]);
export const storedAudioObservationSchema = z.union([
  audioObservationSchema,
  audioObservationV2Schema,
  sessionAudioObservationSchema,
]);
export type StoredAudioObservation = z.infer<
  typeof storedAudioObservationSchema
>;
