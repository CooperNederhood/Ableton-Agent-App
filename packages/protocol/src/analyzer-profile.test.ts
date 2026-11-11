import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANALYZER_SOURCE_PINS,
  ANALYZER_QUALIFICATION_BUILD,
  ANALYZER_PRODUCER_ABI,
  LISTENER_CAPABILITY_ANALYZER_TIMELINES,
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  PITCH_OUTPUT_MINIMUM_HZ,
  PITCH_OUTPUT_MAXIMUM_HZ,
  pitchProfileSchema,
  spectralShapeProfileSchema,
  MIN_SPECTRAL_FLATNESS_DB,
  analyzerNativeSourceIdentitySchema,
} from "./analyzer-profile.js";

describe("pinned diagnostic analyzer profiles", () => {
  it("bounds fault evidence owners/counts while preserving invalid and nonfinite source operands", () => {
    const value = {
      schema: "analyzer-native-source-identity/v1",
      producerAbi: 3,
      expectedEpoch: 7,
      expectedGeneration: 1,
      completedFrames: 21,
      sourceAbi: null,
      sourceEpoch: -1,
      sourceRejected: 14,
      sourceSealedEpoch: 0.5,
      sourceClock: 1e100,
    };
    const parsed = analyzerNativeSourceIdentitySchema.parse(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const change of [
      { producerAbi: 2 },
      { expectedEpoch: 0 },
      { expectedGeneration: 0 },
      { completedFrames: 704 },
      { sourceAbi: NaN },
      { sourceClock: Infinity },
      { sourceEpoch: "null" },
      { pcm: [1, 2] },
    ])
      expect(
        analyzerNativeSourceIdentitySchema.safeParse({ ...value, ...change })
          .success,
      ).toBe(false);
  });
  it("uses the actual canonical native build's exact upstream commits", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../max-patches/audio-listener/native-mel-adapter/dependencies.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      cmake: string;
      dependencies: Record<string, { commit: string }>;
    };
    for (const [key, pin] of Object.entries(ANALYZER_SOURCE_PINS))
      expect(
        manifest.dependencies[key === "maxSdkBase" ? "max-sdk-base" : key]
          ?.commit,
      ).toBe(pin);
    expect(manifest.cmake).toBe(ANALYZER_QUALIFICATION_BUILD.cmake);
    expect(ANALYZER_QUALIFICATION_BUILD.scope).toBe(
      "offline-controlled-inputs",
    );
    expect(ANALYZER_QUALIFICATION_BUILD.executedArchitecture).toBe("arm64");
  });
  it("separates the frozen tested input cases from the tolerance-expanded OUTPUT gate", () => {
    expect(pitchProfileSchema.parse(PITCH_PROFILE)).toEqual(PITCH_PROFILE);
    expect(PITCH_PROFILE.testedInputHz).toEqual([
      196, 220, 261.625565, 440, 880, 1760,
    ]);
    expect(PITCH_PROFILE.testedAmplitudes).toEqual([0.01, 0.2, 0.9]);
    expect(PITCH_PROFILE.testedPhasesRadians).toEqual([0, 0.37, 1.3, 2.4]);
    expect(1200 * Math.log2(PITCH_OUTPUT_MINIMUM_HZ / 196)).toBeCloseTo(
      -20,
      10,
    );
    expect(1200 * Math.log2(PITCH_OUTPUT_MAXIMUM_HZ / 1760)).toBeCloseTo(
      20,
      10,
    );
    expect(PITCH_PROFILE.acceptanceMeaning).toBe(
      "estimate-gate-not-input-class-or-accuracy-proof",
    );
    expect(PITCH_PROFILE.knownCounterexample).toBe(
      "2000Hz-sine-high-confidence-1000Hz-octave",
    );
    expect(LISTENER_CAPABILITY_ANALYZER_TIMELINES).toBe(
      "audio-listener/analyzer-timelines-v1",
    );
    expect(ANALYZER_PRODUCER_ABI).toBe(3);
  });
  it("freezes the verified selected-bin mathematical semantics, not an idealized FFT grid", () => {
    expect(spectralShapeProfileSchema.parse(SPECTRAL_SHAPE_PROFILE)).toEqual(
      SPECTRAL_SHAPE_PROFILE,
    );
    expect(SPECTRAL_SHAPE_PROFILE).toMatchObject({
      windowSamples: 2048,
      hopSamples: 2048,
      fftSamples: 2048,
      windowType: "hann-periodic",
      magnitudeMode: "magnitude",
      frequencyScale: "linear",
      rolloffPercent: 95,
      magnitudeFloor: Number.EPSILON,
      firstIncludedBin: 0,
      lastIncludedBin: 1023,
      nyquistBin: "excluded",
      frequencyGrid: "k*sampleRate/(2*1023)",
      oracleToleranceDb: 1e-5,
      oracleToleranceHz: 1e-7,
    });
    expect(MIN_SPECTRAL_FLATNESS_DB).toBeCloseTo(-313.07119549054045, 10);
  });
  it.each([
    ["pitch", pitchProfileSchema, PITCH_PROFILE],
    ["spectral", spectralShapeProfileSchema, SPECTRAL_SHAPE_PROFILE],
  ] as const)(
    "rejects silently changed %s settings or pins",
    (_name, schema, profile) => {
      for (const changed of [
        { ...profile, hopSamples: 1024 },
        { ...profile, channelMode: "mono" },
        { ...profile, sourcePins: { ...profile.sourcePins, core: "other" } },
        {
          ...profile,
          qualificationBuild: {
            ...profile.qualificationBuild,
            scope: "host-qualified",
          },
        },
        { ...profile, undocumentedOption: true },
      ])
        expect(schema.safeParse(changed).success).toBe(false);
    },
  );
});
