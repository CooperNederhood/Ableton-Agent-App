import { describe, expect, it } from "vitest";
import { createSyntheticAnalyzerReadiness } from "./analyzer-testing.js";
import {
  listenerMetricCapabilitiesSchema,
  listenerMetricRegistrationMetadataSchema,
} from "./listener-metric-registration.js";

const baseline = [
  "audio-listener/independent-metric-timelines-v1",
  "audio-listener/mel-band-timelines-v1",
];
const analyzers = [...baseline, "audio-listener/analyzer-timelines-v1"];
const metadata = {
  capabilities: baseline,
  algorithmVersion: "3.0.0",
  sampleRate: 48000,
  vectorSize: 64,
  nativeStatus: {
    version: 5,
    scope: "independent-metric-timelines/v1",
    readiness: "BLOCKED",
    alignment: "approximate",
    verifiedAbsoluteErrorBoundSamples: null,
    acceptedSampleRates: [44100, 48000],
    acceptedVectorSizes: [64],
    supportedModes: ["arrangement", "session"],
    timingModes: ["descriptive", "strict"],
    maxClockDisagreementSamples: 480,
    maxAudioDurationMs: 30000,
    maxReportRows: 2000,
    executedGen: null,
    reason: "fresh_per_pass_native_validation_required",
  },
};

describe("canonical listener registration metadata", () => {
  it("accepts only exact baseline-plus-mel or qualified analyzer capability tuples", () => {
    expect(listenerMetricCapabilitiesSchema.parse(baseline)).toEqual(baseline);
    expect(listenerMetricCapabilitiesSchema.parse(analyzers)).toEqual(
      analyzers,
    );
    for (const value of [
      [],
      baseline.slice(0, 1),
      [...baseline, baseline[0]],
      [...analyzers, "unknown"],
      [...analyzers].reverse(),
    ])
      expect(listenerMetricCapabilitiesSchema.safeParse(value).success).toBe(
        false,
      );
  });
  it.each([44100, 48000] as const)(
    "preserves observed %s Hz readiness without synthesizing baseline evidence",
    (sampleRate) => {
      expect(listenerMetricRegistrationMetadataSchema.parse(metadata)).toEqual(
        metadata,
      );
      const analyzerReadiness = createSyntheticAnalyzerReadiness(sampleRate);
      const qualified = {
        ...metadata,
        sampleRate,
        capabilities: analyzers,
        analyzerReadiness,
      };
      expect(listenerMetricRegistrationMetadataSchema.parse(qualified)).toEqual(
        qualified,
      );
      for (const invalid of [
        { ...qualified, analyzerReadiness: undefined },
        { ...qualified, capabilities: baseline },
        { ...qualified, sampleRate: sampleRate === 44100 ? 48000 : 44100 },
      ])
        expect(
          listenerMetricRegistrationMetadataSchema.safeParse(invalid).success,
        ).toBe(false);
    },
  );
});
