import { describe, expect, it } from "vitest";
import {
  aggregateMelBandFrames,
  deriveMelBandFrame,
  MAX_MEL_BAND_FRAMES,
  MAX_MEL_BAND_MAGNITUDE,
  MEL_BAND_DENOMINATOR_FLOOR,
  MEL_BAND_PROFILE,
  melBandFramesSchema,
  melBandMagnitudeVectorSchema,
  melBandProfileSchema,
  melBandRatioSchema,
  melBandSampleRateSchema,
  melBandStereoFrameSchema,
} from "./mel-band-profile.js";

const vector = (low = 1, mid = 1, high = 1) =>
  Array.from({ length: 24 }, (_, i) => (i < 2 ? low : i < 9 ? mid : high));
const stereo = (left = vector(), right = left) =>
  melBandStereoFrameSchema.parse([left, right]);

describe("deterministic mel-band metadata and arithmetic (not acquisition)", () => {
  it("pins 24 independent linear magnitude bands and the approved transform settings", () => {
    expect(MEL_BAND_PROFILE).toMatchObject({
      schema: "mel-band-profile/v1",
      bandCount: 24,
      minimumHz: 20,
      maximumHz: 20_000,
      channelMode: "independent-stereo",
      quantity: "linear-fft-magnitude",
      normalize: 0,
      scale: 0,
      windowType: "hann-periodic",
      windowSamples: 2_048,
      hopSamples: 2_048,
      fftSamples: 2_048,
      denominatorFloor: 1e-12,
    });
    expect(MEL_BAND_PROFILE.bands).toHaveLength(24);
    const mel = (hz: number) => 1127.01048 * Math.log(1 + hz / 700);
    const spacing = (mel(20_000) - mel(20)) / 25;
    for (const [i, band] of MEL_BAND_PROFILE.bands.entries()) {
      expect(band.index).toBe(i);
      expect(mel(band.lowerHz)).toBeCloseTo(mel(20) + spacing * i, 10);
      expect(mel(band.centerHz)).toBeCloseTo(mel(20) + spacing * (i + 1), 10);
      expect(mel(band.upperHz)).toBeCloseTo(mel(20) + spacing * (i + 2), 10);
    }
    expect(MEL_BAND_PROFILE.bands[0]!.lowerHz).toBe(20);
    expect(MEL_BAND_PROFILE.bands[23]!.upperHz).toBe(20_000);
    expect(MEL_BAND_PROFILE.bands.map((band) => band.region)).toEqual([
      ...Array.from({ length: 2 }, () => "low"),
      ...Array.from({ length: 7 }, () => "mid"),
      ...Array.from({ length: 15 }, () => "high"),
    ]);
  });

  it("assigns crossing triangles by center, not overlap or boundary interpolation", () => {
    expect(MEL_BAND_PROFILE.bands[1]).toMatchObject({ region: "low" });
    expect(MEL_BAND_PROFILE.bands[1]!.upperHz).toBeGreaterThan(250);
    expect(MEL_BAND_PROFILE.bands[8]).toMatchObject({ region: "mid" });
    expect(MEL_BAND_PROFILE.bands[8]!.upperHz).toBeGreaterThan(2_000);
    const values = vector(0, 0, 0);
    values[1] = 3;
    values[8] = 5;
    values[9] = 7;
    const result = deriveMelBandFrame(stereo(values));
    expect(result.regions[0]).toEqual({ low: 3, mid: 5, high: 7 });
    expect(result.ratios[0]).toEqual({
      lowMid: { value: 3 / 5, reason: null },
      highMid: { value: 7 / 5, reason: null },
    });
  });

  it("keeps stereo independent and ratios invariant under healthy linear gain", () => {
    const input = stereo(vector(2, 4, 8), vector(3, 5, 7));
    const result = deriveMelBandFrame(input);
    expect(result.regions).toEqual([
      { low: 4, mid: 28, high: 120 },
      { low: 6, mid: 35, high: 105 },
    ]);
    expect(result.ratios[0].lowMid.value).toBe(4 / 28);
    expect(result.ratios[1].highMid.value).toBe(3);
    const scaled = deriveMelBandFrame(
      stereo(
        input[0].map((x) => x * 8),
        input[1].map((x) => x * 8),
      ),
    );
    expect(scaled.ratios).toEqual(result.ratios);
    expect(scaled.regions[0].mid).toBe(result.regions[0].mid * 8);
    expect(deriveMelBandFrame(stereo(vector(0, 2, 0))).ratios[0]).toEqual({
      lowMid: { value: 0, reason: null },
      highMid: { value: 0, reason: null },
    });
  });

  it.each([
    [0, "zero-denominator"],
    [Number.MIN_VALUE, "below-floor"],
    [MEL_BAND_DENOMINATOR_FLOOR / 2, "below-floor"],
    [MEL_BAND_DENOMINATOR_FLOOR, "below-floor"],
  ] as const)("distinguishes an unusable mid sum %s with %s", (mid, reason) => {
    const values = vector(1, 0, 1);
    values[2] = mid;
    const result = deriveMelBandFrame(stereo(values));
    expect(result.ratios[0]).toEqual({
      lowMid: { value: null, reason },
      highMid: { value: null, reason },
    });
  });

  it("accepts a denominator immediately above the floor without clamping", () => {
    const values = vector(1, 0, 1);
    values[2] = MEL_BAND_DENOMINATOR_FLOOR * (1 + Number.EPSILON);
    expect(deriveMelBandFrame(stereo(values)).ratios[0].lowMid).toEqual({
      value: 2 / values[2],
      reason: null,
    });
  });

  it.each([23, 25, 0])("rejects vectors of length %i", (length) => {
    expect(
      melBandMagnitudeVectorSchema.safeParse(Array(length).fill(1)).success,
    ).toBe(false);
    expect(() =>
      deriveMelBandFrame([Array(length).fill(1), vector()]),
    ).toThrow();
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    -1,
    MAX_MEL_BAND_MAGNITUDE + 1,
    "1",
    null,
    undefined,
  ])(
    "rejects invalid magnitudes %s without filling missing values",
    (invalid) => {
      const values: unknown[] = vector();
      values[3] = invalid;
      expect(melBandMagnitudeVectorSchema.safeParse(values).success).toBe(
        false,
      );
      expect(() => aggregateMelBandFrames([[values, vector()]])).toThrow();
    },
  );

  it("rejects missing, sparse, mono and extra channels", () => {
    for (const invalid of [
      undefined,
      [],
      [vector()],
      [vector(), vector(), vector()],
      [Array(24), vector()],
      { left: vector(), right: vector() },
    ]) {
      expect(melBandStereoFrameSchema.safeParse(invalid).success).toBe(false);
      expect(() => deriveMelBandFrame(invalid)).toThrow();
    }
  });

  it("bounds input and worst-case sums and ratios using the native amplitude and FFT limits", () => {
    expect(MAX_MEL_BAND_MAGNITUDE).toBe(64 * 2_048 * 1_025);
    const values = vector(MAX_MEL_BAND_MAGNITUDE, 0, MAX_MEL_BAND_MAGNITUDE);
    values[2] = MEL_BAND_DENOMINATOR_FLOOR * (1 + Number.EPSILON);
    const frame = stereo(values);
    const result = aggregateMelBandFrames(
      Array(MAX_MEL_BAND_FRAMES).fill(frame),
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected analysis");
    expect(result.frameCount).toBe(706);
    expect(result.analysis.magnitudes[0]).toEqual(values);
    expect(Number.isFinite(result.analysis.ratios[0].highMid.value)).toBe(true);
    expect(result.analysis.ratios[0].highMid.reason).toBeNull();
  });

  it("returns an explicit empty outcome and rejects more than 706 frames", () => {
    expect(aggregateMelBandFrames([])).toEqual({
      status: "no-frames",
      frameCount: 0,
    });
    expect(
      melBandFramesSchema.safeParse(Array(707).fill(stereo())).success,
    ).toBe(false);
    expect(() => aggregateMelBandFrames(Array(707).fill(stereo()))).toThrow();
    expect(() => aggregateMelBandFrames(undefined)).toThrow();
  });

  it("averages all linear vectors equally then derives ratios, never averaging ratios", () => {
    const first = stereo(vector(1, 1, 2), vector(0, 0, 0));
    const second = stereo(vector(3, 9, 4), vector(4, 2, 6));
    const result = aggregateMelBandFrames([first, second]);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected analysis");
    expect(result.analysis.magnitudes).toEqual(
      stereo(vector(2, 5, 3), vector(2, 1, 3)),
    );
    expect(result.analysis.ratios[0].lowMid.value).toBe(4 / 35);
    expect(result.analysis.ratios[0].lowMid.value).not.toBe(
      (deriveMelBandFrame(first).ratios[0].lowMid.value! +
        deriveMelBandFrame(second).ratios[0].lowMid.value!) /
        2,
    );
    expect(result.analysis.ratios[1].lowMid.value).toBe(4 / 7);
    expect(aggregateMelBandFrames([first])).toEqual({
      status: "completed",
      frameCount: 1,
      analysis: deriveMelBandFrame(first),
    });
  });

  it("does not mutate inputs and exposes deeply frozen metadata and results", () => {
    const input = [vector(), vector(2, 3, 4)];
    const original = structuredClone(input);
    Object.freeze(input[0]);
    Object.freeze(input[1]);
    Object.freeze(input);
    const result = aggregateMelBandFrames([input]);
    expect(input).toEqual(original);
    const assertFrozen = (value: unknown) => {
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(assertFrozen);
      }
    };
    assertFrozen(MEL_BAND_PROFILE);
    assertFrozen(result);
    expect(
      melBandProfileSchema.parse(JSON.parse(JSON.stringify(MEL_BAND_PROFILE))),
    ).toEqual(MEL_BAND_PROFILE);
  });

  it("strictly validates metadata, rates and ratio result variants", () => {
    for (const sampleRate of [44_100, 48_000]) {
      expect(melBandSampleRateSchema.parse(sampleRate)).toBe(sampleRate);
    }
    expect(melBandSampleRateSchema.safeParse(96_000).success).toBe(false);
    for (const change of [
      { normalize: 1 },
      { scale: 1 },
      { bandCount: 25 },
      { windowType: "hann-symmetric" },
      { rawAudio: [] },
    ]) {
      expect(
        melBandProfileSchema.safeParse({ ...MEL_BAND_PROFILE, ...change })
          .success,
      ).toBe(false);
    }
    const changedBands = structuredClone(MEL_BAND_PROFILE.bands);
    expect(
      melBandProfileSchema.safeParse({
        ...MEL_BAND_PROFILE,
        bands: changedBands.map((band, i) =>
          i === 1 ? { ...band, region: "mid" } : band,
        ),
      }).success,
    ).toBe(false);
    expect(
      melBandProfileSchema.safeParse({
        ...MEL_BAND_PROFILE,
        bands: changedBands.map((band, i) =>
          i === 0 ? { ...band, extra: true } : band,
        ),
      }).success,
    ).toBe(false);
    for (const valid of [
      { value: 0, reason: null },
      { value: null, reason: "zero-denominator" },
      { value: null, reason: "below-floor" },
    ]) {
      expect(melBandRatioSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      { value: null, reason: null },
      { value: 0, reason: "below-floor" },
      { value: -1, reason: null },
      { value: Infinity, reason: null },
      { value: 1e100, reason: null },
      { value: 1, reason: null, extra: true },
    ]) {
      expect(melBandRatioSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
