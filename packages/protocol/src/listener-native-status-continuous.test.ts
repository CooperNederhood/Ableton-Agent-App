import { describe, expect, it } from "vitest";
import {
  listenerNativeContinuousMetricStatusSchema,
  listenerNativeMetricRegistrationStatusSchema,
  compactListenerNativeContinuousMetricStatus,
  listenerNativeContinuousMetricStatusWireSchema,
} from "./listener-native-status-continuous.js";
import {
  listenerMetricCapabilitiesSchema,
  listenerMetricRegistrationMetadataSchema,
  listenerMetricRegistrationMetadataWireSchema,
} from "./listener-metric-registration.js";
import {
  nativeContinuousMetricArmProofSchema,
  nativeContinuousMetricListeningConfigSchema,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
} from "./native-continuous-metric-listening-schemas.js";
import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "./metric-continuous-geometry.js";
import { METRIC_RECORD_STREAM_CAPABILITY } from "./metric-record-stream.js";
import { createSyntheticMetricRecordStreamFixture } from "./metric-stream-testing.js";
import { createSyntheticAnalyzerReadiness } from "./analyzer-testing.js";

const capabilities = [
  "audio-listener/independent-metric-timelines-v1",
  "audio-listener/mel-band-timelines-v1",
  "audio-listener/analyzer-timelines-v1",
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
];

async function statusFixture(seconds = 600, allMetrics = true) {
  const fixture = await createSyntheticMetricRecordStreamFixture();
  const native = fixture.manifest.nativeProof;
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "finite-metric-stream",
    sampleRate: 48_000,
    vectorSize: 64,
    tempoBpm: 120,
    startBeat: 0,
    endBeat: seconds * 2,
    startSample: 0,
  });
  const config = nativeContinuousMetricListeningConfigSchema.parse({
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    algorithmVersion: "3.0.0",
    mode: "arrangement",
    captureMode: "finite-metric-stream",
    sourceEvidence: "transport-only",
    sourceContext: {
      ...fixture.descriptor.source,
      transport: {
        startBeat: geometry.startBeat,
        endBeat: geometry.endBeat,
      },
    },
    geometry,
    timingPolicy: fixture.descriptor.timingPolicy,
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    requestedMetrics: allMetrics
      ? fixture.descriptor.requestedMetrics
      : ["level"],
    attacks: allMetrics ? { thresholdDb: 6, minSpacingSamples: 4800 } : null,
    maxPendingChunks: 8,
    maxChunkBytes: 131072,
  });
  const epoch = native.ownership.nativeEpoch;
  const fields = [
    epoch,
    geometry.totalSamples,
    4800,
    120,
    0,
    64,
    1,
    0,
    geometry.endBeat,
    geometry.rows.length,
    epoch,
    epoch,
  ];
  const timing = [epoch, -1, 0, 0, -1, native.launch.timing[5], -1, 3];
  const executedGen = nativeContinuousMetricArmProofSchema.parse({
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    analyzerProducerAbi: 3,
    ownership: native.ownership,
    config,
    before: native.before,
    receipt: {
      fields,
      confirmedFields: fields,
      timing,
      confirmedTiming: timing,
      elapsedMs: 20,
    },
  });
  return {
    version: 6,
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    readiness: "READY",
    alignment: "approximate",
    verifiedAbsoluteErrorBoundSamples: null,
    acceptedSampleRates: [44100, 48000],
    acceptedVectorSizes: [64],
    supportedModes: ["arrangement", "session"],
    timingModes: ["descriptive", "strict"],
    maxClockDisagreementSamples: 480,
    maxAudioDurationMs: 600_000,
    maxSessionAudioDurationMs: 600_000,
    maxReportRows: 39_961,
    maxSessionReportRows: 39_961,
    streamCapability: METRIC_RECORD_STREAM_CAPABILITY,
    executedGen,
  };
}

describe("explicit continuous producer registration metadata", () => {
  it("expands compact executed registration evidence before unchanged readiness gates", async () => {
    const status = listenerNativeContinuousMetricStatusSchema.parse(
      await statusFixture(),
    );
    const wire = compactListenerNativeContinuousMetricStatus(status);
    expect(JSON.stringify(wire)).not.toContain('"rows":');
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(128 * 1024);
    expect(listenerNativeContinuousMetricStatusWireSchema.parse(wire)).toEqual(
      status,
    );
    const registration = {
      capabilities,
      algorithmVersion: "3.0.0",
      sampleRate: 48000,
      vectorSize: 64,
      nativeStatus: wire,
      analyzerReadiness: createSyntheticAnalyzerReadiness(48000),
    };
    expect(
      listenerMetricRegistrationMetadataWireSchema.parse(registration)
        .nativeStatus,
    ).toEqual(status);
    expect(
      listenerMetricRegistrationMetadataWireSchema.safeParse({
        ...registration,
        sampleRate: 44100,
      }).success,
    ).toBe(false);
    expect(
      listenerNativeContinuousMetricStatusWireSchema.safeParse({
        ...wire,
        executedGen: null,
      }).success,
    ).toBe(false);
  });

  it("admits the fourth capability only with explicit continuous execution and matching ABI3 readiness", async () => {
    const nativeStatus = await statusFixture();
    expect(listenerMetricCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
    expect(
      listenerNativeMetricRegistrationStatusSchema.parse(nativeStatus),
    ).toEqual(nativeStatus);
    const registration = {
      capabilities,
      algorithmVersion: "3.0.0",
      sampleRate: 48000,
      vectorSize: 64,
      nativeStatus,
      analyzerReadiness: createSyntheticAnalyzerReadiness(48000),
    };
    expect(
      listenerMetricRegistrationMetadataSchema.parse(registration),
    ).toEqual(registration);
    for (const change of [
      { capabilities: capabilities.slice(0, 3) },
      { analyzerReadiness: undefined },
      { sampleRate: 44100 },
      { vectorSize: 128 },
    ])
      expect(
        listenerMetricRegistrationMetadataSchema.safeParse({
          ...registration,
          ...change,
        }).success,
      ).toBe(false);
  });

  it("cannot advertise 600-second readiness from short, missing or incomplete-family execution", async () => {
    const qualified = await statusFixture();
    for (const invalid of [
      { ...qualified, executedGen: null },
      { ...qualified, version: 5 },
      { ...qualified, maxSessionAudioDurationMs: 30_000 },
      { ...qualified, maxSessionReportRows: 2_000 },
      await statusFixture(30),
      await statusFixture(600, false),
    ])
      expect(
        listenerNativeContinuousMetricStatusSchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it("retains explicit blocked status without inventing executed readiness", async () => {
    const nativeStatus = await statusFixture();
    const blocked = {
      ...nativeStatus,
      readiness: "BLOCKED",
      executedGen: null,
      reason: "fresh_continuous_producer_validation_required",
    };
    expect(listenerNativeContinuousMetricStatusSchema.parse(blocked)).toEqual(
      blocked,
    );
    expect(
      listenerNativeContinuousMetricStatusSchema.safeParse({
        ...blocked,
        reason: undefined,
      }).success,
    ).toBe(false);
  });
});
