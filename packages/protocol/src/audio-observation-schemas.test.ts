import { describe, expect, it } from "vitest";
import {
  audioObservationSchema,
  MAX_AUDIO_OBSERVATION_ATTACKS,
  MAX_AUDIO_OBSERVATION_SAMPLES,
  type AudioObservation,
} from "./audio-observation-schemas.js";

function observation(): AudioObservation {
  return {
    schema: "audio-observation/v1",
    listenerId: "listener:1",
    passId: "pass:1",
    sampleRate: 48_000,
    startSample: 0,
    endSample: 48_000,
    startBeat: 0,
    endBeat: 2,
    complete: true,
    limitations: [],
    algorithm: {
      name: "native-envelope-centroid",
      version: "1",
      windowSamples: 1_024,
      hopSamples: 512,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 2_400 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 64,
    },
    summaries: { peak: [0, 0], rmsDbfs: [null, null], centroidHz: null },
    samples: [
      {
        sample: 0,
        beat: 0,
        peak: [0, 0],
        rmsDbfs: [null, null],
        centroidHz: null,
      },
    ],
    attacks: [],
    reduction: { originalSamples: 1, originalAttacks: 0, truncated: false },
  };
}

describe("canonical audio-observation/v1", () => {
  it("retains processed stereo descriptors, declared units and defined silence", () => {
    expect(audioObservationSchema.parse(observation())).toEqual(observation());
  });

  it.each([
    { schema: "audio-observation/v2" },
    { rawAudio: "encoded audio" },
    { waveform: [1, 2] },
    { samples: [{ ...observation().samples[0], pcm: [1] }] },
    {
      summaries: {
        peak: [Infinity, 0],
        rmsDbfs: [null, null],
        centroidHz: null,
      },
    },
    {
      summaries: { peak: [0, 0], rmsDbfs: [-Infinity, null], centroidHz: null },
    },
    { summaries: { peak: [0, 0], rmsDbfs: [NaN, null], centroidHz: null } },
    { summaries: { peak: [0, 0], rmsDbfs: [null, null], centroidHz: 24_001 } },
    { endSample: -1 },
    { startBeat: 3 },
    { endSample: Number.MAX_SAFE_INTEGER + 1 },
    { limitations: Array.from({ length: 33 }, () => "limitation") },
    { limitations: ["x".repeat(501)] },
    { reduction: { originalSamples: 2, originalAttacks: 0, truncated: false } },
    { reduction: { originalSamples: 1, originalAttacks: 0, truncated: true } },
  ])(
    "rejects unbounded, nonfinite, unsupported or raw content %#",
    (change) => {
      expect(() =>
        audioObservationSchema.parse({ ...observation(), ...change }),
      ).toThrow();
    },
  );

  it("bounds descriptor detail, preserves explicit partial reduction and monotonic sample/beat timing", () => {
    const source = observation();
    source.complete = false;
    source.samples = Array.from(
      { length: MAX_AUDIO_OBSERVATION_SAMPLES },
      (_, sample) => ({
        sample,
        beat: sample / 1_024,
        peak: [0, 0],
        rmsDbfs: [null, null],
        centroidHz: null,
      }),
    );
    source.attacks = Array.from(
      { length: MAX_AUDIO_OBSERVATION_ATTACKS },
      (_, sample) => ({
        sample,
        beat: sample / 1_024,
        strength: 0.2,
      }),
    );
    source.reduction = {
      originalSamples: 2_048,
      originalAttacks: 1_024,
      truncated: true,
    };
    expect(audioObservationSchema.parse(source).complete).toBe(false);
    expect(() =>
      audioObservationSchema.parse({
        ...source,
        samples: [...source.samples, source.samples[0]],
      }),
    ).toThrow();
    expect(() =>
      audioObservationSchema.parse({
        ...source,
        attacks: [...source.attacks, source.attacks[0]],
      }),
    ).toThrow();
    expect(() =>
      audioObservationSchema.parse({
        ...source,
        samples: [...source.samples].reverse(),
      }),
    ).toThrow();
    expect(() =>
      audioObservationSchema.parse({
        ...source,
        samples: [{ ...source.samples[0], sample: 48_001 }],
      }),
    ).toThrow();
  });
});
