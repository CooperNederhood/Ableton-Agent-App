import { describe, expect, it } from "vitest";
import {
  isListeningFeatureValueValid,
  listeningFeatureTypeSchema,
  listeningFeatureSchema,
  extractPeakFeature,
  type ListeningFeatureType,
} from "./listening-features.js";
import { createSyntheticMetricListeningObservation } from "./testing.js";
import { MIN_SPECTRAL_FLATNESS_DB } from "./analyzer-profile.js";
import {
  MAX_MEL_BAND_MAGNITUDE,
  MEL_BAND_DENOMINATOR_FLOOR,
} from "./mel-band-profile.js";
import { MAX_METRIC_ATTACK_STRENGTH_DB } from "./metric-observation-schemas.js";

const domains: readonly [ListeningFeatureType, number, number][] = [
  ["peak-summary/v1", 64, 64.01],
  ["level-grid/v1", 0.25, -0.01],
  [
    "spectral-energy-summary/v1",
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ],
  ["centroid-grid/v1", 24000, 24001],
  ["attack-activity-grid/v1", 300, 0.5],
  [
    "attack-strength-grid/v1",
    MAX_METRIC_ATTACK_STRENGTH_DB,
    MAX_METRIC_ATTACK_STRENGTH_DB + 1,
  ],
  ["mel-shape/v1", 0.2, 1.01],
  ["mel-grid/v1", 0.1, 2],
  [
    "mel-region-summary/v1",
    24 * MAX_MEL_BAND_MAGNITUDE,
    25 * MAX_MEL_BAND_MAGNITUDE,
  ],
  [
    "mel-ratio-summary/v1",
    1,
    (25 * MAX_MEL_BAND_MAGNITUDE) / MEL_BAND_DENOMINATOR_FLOOR,
  ],
  ["pitch-grid/v1", 69, 0],
  ["pitch-confidence-summary/v1", 1, 1.001],
  [
    "flatness-summary/v1",
    MIN_SPECTRAL_FLATNESS_DB,
    MIN_SPECTRAL_FLATNESS_DB - 1,
  ],
  ["spread-summary/v1", 22050, 22051],
  ["rolloff-summary/v1", 22050, -1],
];

describe("shared scalar feature domains for full vectors and pages", () => {
  it.each(domains)(
    "enforces %s without needing neighboring page values",
    (type, valid, invalid) => {
      expect(isListeningFeatureValueValid(type, valid, 44100)).toBe(true);
      expect(isListeningFeatureValueValid(type, invalid, 44100)).toBe(false);
      for (const value of [NaN, Infinity, -Infinity])
        expect(isListeningFeatureValueValid(type, value, 48000)).toBe(false);
      expect(isListeningFeatureValueValid(type, null, 48000)).toBe(true);
      expect(isListeningFeatureValueValid(type, valid, 96000)).toBe(false);
      if (type !== "flatness-summary/v1")
        expect(isListeningFeatureValueValid(type, -0.001, 48000)).toBe(false);
    },
  );

  it("covers the entire registry and validates sample-rate-specific physical bounds", () => {
    expect(domains.map(([type]) => type)).toEqual(
      listeningFeatureTypeSchema.options,
    );
    for (const type of ["spread-summary/v1", "rolloff-summary/v1"] as const) {
      expect(isListeningFeatureValueValid(type, 23000, 44100)).toBe(false);
      expect(isListeningFeatureValueValid(type, 23000, 48000)).toBe(true);
    }
    expect(
      isListeningFeatureValueValid("flatness-summary/v1", -20, 48000),
    ).toBe(true);
    expect(
      isListeningFeatureValueValid("flatness-summary/v1", 0.01, 48000),
    ).toBe(false);
    expect(isListeningFeatureValueValid("pitch-grid/v1", 127, 48000)).toBe(
      false,
    );
  });

  it("keeps full feature validation aligned without interpreting a page as a normalized vector", () => {
    const feature = extractPeakFeature(
      createSyntheticMetricListeningObservation(),
    );
    for (const value of [0, 0.5, 64, -0.1, 64.1, Infinity])
      expect(
        listeningFeatureSchema.safeParse({ ...feature, values: [value, value] })
          .success,
      ).toBe(
        isListeningFeatureValueValid(feature.type, value, feature.sampleRate),
      );
    const page = [0.1, 0.2];
    expect(
      page.every((value) =>
        isListeningFeatureValueValid("mel-grid/v1", value, 48000),
      ),
    ).toBe(true);
    expect(page).toEqual([0.1, 0.2]);
  });
});
