import { describe, expect, it } from "vitest";
import {
  audioObservationSchema,
  audioObservationV2Schema,
  MAX_AUDIO_OBSERVATION_BYTES,
  MAX_AUDIO_OBSERVATION_ATTACKS,
  MAX_AUDIO_OBSERVATION_SAMPLES,
  storedAudioObservationSchema,
} from "./audio-observation-schemas.js";
import {
  DEFAULT_LISTENING_TIMING_POLICY,
  evaluateListeningAlignment,
} from "./listening-timing-schemas.js";
import {
  assertNativeCaptureObservation,
  nativeCaptureProofSchema,
} from "./native-listening-schemas.js";
import { createSyntheticNativeListeningFixture } from "./testing.js";

function observation() {
  const { observation: legacy } = createSyntheticNativeListeningFixture();
  const { timingUncertaintySamples: _legacyTiming, ...algorithm } =
    legacy.algorithm;
  expect(_legacyTiming).toBe(64);
  return {
    ...legacy,
    schema: "audio-observation/v2" as const,
    algorithm,
    alignment: evaluateListeningAlignment(DEFAULT_LISTENING_TIMING_POLICY, {
      sampleRate: legacy.sampleRate,
      vectorSize: 64,
      observedClockDisagreementSamples: 64,
      observedBeatDisagreementSamples: 1,
    }),
  };
}

describe("versioned descriptive observations", () => {
  it("keeps complete measurements separate from approximate alignment", () => {
    const result = audioObservationV2Schema.parse(observation());
    expect(result.complete).toBe(true);
    expect(result.alignment.alignment).toBe("approximate");
    expect(result.algorithm).not.toHaveProperty("timingUncertaintySamples");
    expect(result.alignment.verifiedAbsoluteErrorBoundSamples).toBeNull();
    expect(
      new TextEncoder().encode(JSON.stringify(result)).byteLength,
    ).toBeLessThan(MAX_AUDIO_OBSERVATION_BYTES);
  });

  it("reads both versions without promoting or changing legacy semantics", () => {
    const { observation: legacy, proof } =
      createSyntheticNativeListeningFixture();
    expect(storedAudioObservationSchema.parse(legacy)).toEqual(legacy);
    expect(storedAudioObservationSchema.parse(observation()).schema).toBe(
      "audio-observation/v2",
    );
    expect(audioObservationSchema.safeParse(observation()).success).toBe(false);
    expect(audioObservationV2Schema.safeParse(legacy).success).toBe(false);
    expect(
      nativeCaptureProofSchema.safeParse({
        ...proof,
        alignment: observation().alignment,
      }).success,
    ).toBe(false);
  });

  it("never authorizes v2 with the legacy native coverage validator", () => {
    const { proof } = createSyntheticNativeListeningFixture();
    expect(() => {
      Reflect.apply(assertNativeCaptureObservation, undefined, [
        proof,
        observation(),
      ]);
    }).toThrow("native_capture_coverage_mismatch");
  });

  it.each([
    { alignment: undefined },
    { sampleRate: 44_100 },
    { rawAudio: "PCM" },
    {
      complete: true,
      reduction: { originalSamples: 21, originalAttacks: 0, truncated: true },
    },
    {
      summaries: { peak: [0, 0], rmsDbfs: [-Infinity, null], centroidHz: null },
    },
    {
      samples: [
        {
          sample: -1,
          beat: 0,
          peak: [0, 0],
          rmsDbfs: [null, null],
          centroidHz: null,
        },
      ],
    },
  ])(
    "rejects missing quality, invalid coverage or forbidden content %#",
    (change) => {
      expect(
        audioObservationV2Schema.safeParse({ ...observation(), ...change })
          .success,
      ).toBe(false);
    },
  );

  it("does not accept the user's limit as an algorithmic or verified error bound", () => {
    const source = observation();
    expect(
      audioObservationV2Schema.safeParse({
        ...source,
        algorithm: { ...source.algorithm, timingUncertaintySamples: 64 },
      }).success,
    ).toBe(false);
    expect(
      audioObservationV2Schema.safeParse({
        ...source,
        alignment: {
          ...source.alignment,
          verifiedAbsoluteErrorBoundSamples: 64,
        },
      }).success,
    ).toBe(false);
  });

  it("does not make a genuinely reduced capture complete", () => {
    const source = observation();
    source.samples.pop();
    source.complete = false;
    source.reduction.truncated = true;
    expect(audioObservationV2Schema.parse(source).complete).toBe(false);
    expect(
      audioObservationV2Schema.safeParse({ ...source, complete: true }).success,
    ).toBe(false);
  });

  it("keeps the encoded UTF-8 quota unchanged for the larger versioned payload", () => {
    const source = observation();
    source.endSample = Number.MAX_SAFE_INTEGER;
    source.endBeat = Number.MAX_SAFE_INTEGER;
    source.samples = Array.from(
      { length: MAX_AUDIO_OBSERVATION_SAMPLES },
      (): (typeof source.samples)[number] => ({
        sample: source.endSample,
        beat: source.endBeat,
        peak: [Number.MAX_VALUE, Number.MAX_VALUE],
        rmsDbfs: [-Number.MAX_VALUE, -Number.MAX_VALUE],
        centroidHz: Number.MIN_VALUE,
      }),
    );
    source.attacks = Array.from(
      { length: MAX_AUDIO_OBSERVATION_ATTACKS },
      () => ({
        sample: source.endSample,
        beat: source.endBeat,
        strength: Number.MAX_VALUE,
      }),
    );
    source.reduction = {
      originalSamples: source.samples.length,
      originalAttacks: source.attacks.length,
      truncated: false,
    };
    source.limitations = Array.from({ length: 32 }, () => "\u20ac".repeat(500));
    expect(
      new TextEncoder().encode(JSON.stringify(source)).byteLength,
    ).toBeGreaterThan(MAX_AUDIO_OBSERVATION_BYTES);
    const result = audioObservationV2Schema.safeParse(source);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual([
        "Observation exceeds encoded payload quota",
      ]);
    }
  });
});
