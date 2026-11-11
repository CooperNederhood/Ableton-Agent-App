import { describe, expect, it } from "vitest";
import { createSyntheticMetricListeningObservation } from "./testing.js";
import {
  compareListeningFeatures,
  extractPeakFeature,
  listeningFeatureSchema,
} from "./listening-features.js";

describe("peak-summary/v1", () => {
  it("preserves the source and computes independent retained channel maxima", () => {
    const observation = createSyntheticMetricListeningObservation();
    const before = JSON.stringify(observation);
    const feature = extractPeakFeature(observation);
    expect(feature.values).toEqual(
      [0, 1].map((channel) =>
        Math.max(
          ...observation.metrics.level.records.map((r) => r.peak[channel]!),
        ),
      ),
    );
    expect(feature.status).toBe("ready");
    expect(JSON.stringify(observation)).toBe(before);
    expect(compareListeningFeatures(feature, feature)).toMatchObject({
      status: "comparable",
      distance: 0,
      distanceDefinition: "euclidean-linear-amplitude/v1",
    });
  });

  it("owns exact finite Euclidean arithmetic, not a similarity probability", () => {
    const original = extractPeakFeature(
      createSyntheticMetricListeningObservation(),
    );
    const a = listeningFeatureSchema.parse({ ...original, values: [0, 0] });
    const b = listeningFeatureSchema.parse({ ...original, values: [3, 4] });
    expect(compareListeningFeatures(a, b)).toMatchObject({ distance: 5 });
    expect(compareListeningFeatures(b, a)).toEqual(
      compareListeningFeatures(a, b),
    );
    expect(
      listeningFeatureSchema.safeParse({ ...a, values: [NaN, 0] }).success,
    ).toBe(false);
  });

  it("distinguishes measured zero from unavailable and rejects partial comparison", () => {
    const source = createSyntheticMetricListeningObservation();
    const silence = structuredClone(source);
    for (const record of silence.metrics.level.records) {
      record.peak = [0, 0];
      record.rms = [0, 0];
    }
    expect(extractPeakFeature(silence)).toMatchObject({
      status: "ready",
      values: [0, 0],
    });
    const feature = extractPeakFeature(source);
    const partial = listeningFeatureSchema.parse({
      ...feature,
      coveredSamples: feature.expectedSamples - 1,
      support: [[0, feature.expectedSamples - 1]],
    });
    expect(compareListeningFeatures(feature, partial)).toMatchObject({
      status: "not-comparable",
      reason: "insufficient-support",
    });
    const absent = structuredClone(source);
    absent.metrics.level.records = [];
    absent.metrics.level.status = "failed";
    const unavailable = extractPeakFeature(absent);
    expect(unavailable).toMatchObject({ status: "unavailable", values: null });
    expect(compareListeningFeatures(feature, unavailable)).toMatchObject({
      status: "not-comparable",
      reason: "unavailable",
    });
  });

  it("preserves duration and rejects undefined acquisition profiles and redefined distances", () => {
    const short = extractPeakFeature(
      createSyntheticMetricListeningObservation({ endBeat: 0.5 }),
    );
    const longer = extractPeakFeature(
      createSyntheticMetricListeningObservation({ endBeat: 2 }),
    );
    expect(short.durationSeconds).toBeLessThan(longer.durationSeconds);
    expect(compareListeningFeatures(short, longer)).toMatchObject({
      status: "comparable",
      distance: 0,
    });
    for (const change of [
      { type: "peak-summary/v2" },
      { distanceDefinition: "cosine" },
      { units: "dBFS" },
      { profile: "diagnostic-snapshot" },
      { coveredSamples: short.expectedSamples + 1 },
    ])
      expect(
        listeningFeatureSchema.safeParse({ ...short, ...change }).success,
      ).toBe(false);
    const missingProfile = createSyntheticMetricListeningObservation();
    missingProfile.metrics.level.algorithm = null;
    expect(extractPeakFeature(missingProfile)).toMatchObject({
      status: "unavailable",
      reason: "unsupported-level-profile",
      values: null,
    });
  });
});
