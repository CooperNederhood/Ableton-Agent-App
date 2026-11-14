import { describe, expect, it } from "vitest";
import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
} from "./metric-continuous-geometry.js";
import {
  nativeContinuousMetricListeningConfigSchema,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  nativeContinuousMetricReadyProofSchema,
  nativeContinuousMetricArmProofSchema,
  nativeMetricControlConfigSchema,
  nativeMetricControlReadyProofSchema,
  nativeMetricControlArmProofSchema,
  assertNativeContinuousMetricReadyProof,
  assertNativeContinuousMetricArmProof,
  nativeContinuousMetricLaunchCoordinates,
  snapshotNativeContinuousMetricListeningExpectation,
  compactNativeContinuousMetricListeningConfig,
  compactNativeContinuousMetricReadyProof,
  compactNativeContinuousMetricArmProof,
  nativeMetricControlConfigWireSchema,
  nativeMetricControlReadyProofWireSchema,
  nativeMetricControlArmProofWireSchema,
  assertNativeContinuousMetricSourceCoverage,
} from "./native-continuous-metric-listening-schemas.js";
import {
  createSyntheticMetricRecordStreamFixture,
  createSyntheticMetricRecordStreamTerminalProof,
} from "./metric-stream-testing.js";
import {
  nativeMetricListeningConfigSchema,
  nativeMetricReadyProofSchema,
  nativeMetricArmProofSchema,
  type NativeMetricLaunchProof,
} from "./native-metric-listening-schemas.js";
import { createSyntheticMetricListeningObservation } from "./metric-testing.js";

function config() {
  return {
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    algorithmVersion: "3.0.0",
    mode: "arrangement",
    captureMode: "arrangement-continuous",
    sourceEvidence: "transport-only",
    geometry: createContinuousMetricListeningGeometry({
      captureMode: "arrangement-continuous",
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 120,
      startBeat: 0,
      endBeat: 1200,
      startSample: 0,
    }),
    timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    requestedMetrics: [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ],
    attacks: { thresholdDb: 6, minSpacingSamples: 4800 },
    sourceContext: {
      view: "arrangement",
      target: {
        kind: "regular",
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000001",
      },
      transport: { startBeat: 0, endBeat: 1200 },
    },
    maxPendingChunks: 8,
    maxChunkBytes: 128 * 1024,
  };
}

function proofFixture() {
  const c = nativeContinuousMetricListeningConfigSchema.parse(config());
  const ownership = createSyntheticMetricListeningObservation().ownership;
  const origin = 100_000;
  const arm = origin - 1000;
  const row = (
    counter: number,
    playing: boolean,
  ): NativeMetricLaunchProof["clock"] => {
    const beat = playing ? (counter - origin) / 24000 : 0;
    return [
      playing ? 1 : 0,
      beat,
      counter + 1_000_000,
      19,
      counter,
      playing ? beat % 1 : 0.125,
      counter,
      playing ? 1 : 0,
      beat,
      counter + 1_000_000,
      19,
    ];
  };
  const before = {
    dsp: [1, c.geometry.sampleRate, c.geometry.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      row(arm - (32 - i) * 256, false),
    ),
  };
  const first = before.frames[0]![4];
  const configurationCounter = before.frames[8]![4];
  const idleFields = Array<number>(12).fill(0);
  const idleTiming = [0, -1, 0, 0, -1, arm - 1, -1, 3];
  const ready = {
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    analyzerProducerAbi: 3,
    phase: "idle-preflight",
    configurationEvidence: "admitted-not-executed",
    ownership,
    config: c,
    before,
    disarmCounter: first - 1,
    elapsedMs: 100,
    idle: {
      fields: idleFields,
      confirmedFields: idleFields,
      timing: idleTiming,
      confirmedTiming: idleTiming,
      configurationCounter,
      confirmedConfigurationCounter: configurationCounter + 1,
      timingCounter: configurationCounter + 2,
      confirmedTimingCounter: configurationCounter + 3,
      elapsedMs: 20,
    },
  };
  const fields = [
    ownership.nativeEpoch,
    c.geometry.totalSamples,
    4800,
    120,
    0,
    64,
    1,
    0,
    1200,
    c.geometry.rows.length,
    ownership.nativeEpoch,
    ownership.nativeEpoch,
  ];
  const timing = [ownership.nativeEpoch, -1, 0, 0, -1, arm, -1, 3];
  const armed = {
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    analyzerProducerAbi: 3,
    ownership,
    config: c,
    before,
    receipt: {
      fields,
      confirmedFields: fields,
      timing,
      confirmedTiming: timing,
      elapsedMs: 20,
    },
  };
  const launch = {
    scope: "independent-metric-timelines/v1",
    ownership,
    timing: [ownership.nativeEpoch, 1064, 0, 1, 64, arm, origin, 3],
    clock: row(origin + 64, true),
    elapsedMs: 100,
  };
  return {
    ready,
    armed,
    launch,
    expected: { ...ownership, config: c },
    origin,
  };
}

describe("native continuous Arrangement admission", () => {
  it("checks continuous completed source coverage with the unchanged launch scope and running transport", async () => {
    const fixture = proofFixture();
    const short = await createSyntheticMetricRecordStreamFixture();
    const descriptor = {
      ...short.descriptor,
      source: {
        ...short.descriptor.source,
        transport: { startBeat: 0, endBeat: 1200 },
      },
      geometry: createContinuousMetricListeningGeometry({
        ...compactNativeContinuousMetricListeningConfig(fixture.expected.config)
          .geometry,
        startSample: fixture.origin,
      }),
    };
    const terminal = createSyntheticMetricRecordStreamTerminalProof(descriptor);
    const source = {
      armed: fixture.armed,
      launched: terminal.launch,
      completion: {
        fields: terminal.configuration,
        confirmedFields: terminal.confirmedConfiguration,
        timing: terminal.timing,
        confirmedTiming: terminal.confirmedTiming,
        elapsedMs: 20,
      },
      after: terminal.after,
      timingWitnesses: terminal.timingWitnesses,
      postElapsedMs: 20,
    };
    expect(terminal.launch.scope).toBe("independent-metric-timelines/v1");
    const checked = assertNativeContinuousMetricSourceCoverage(
      source,
      fixture.expected,
    );
    expect(checked.startSample).toBe(fixture.origin);
    expect(checked.endSample).toBe(descriptor.geometry.endSample);
    expect(() =>
      assertNativeContinuousMetricSourceCoverage(
        {
          ...source,
          completion: {
            ...source.completion,
            fields: source.completion.fields.map((cell, index) =>
              index === 1 ? cell - 1 : cell,
            ),
          },
        },
        fixture.expected,
      ),
    ).toThrow();
    const { generation, ...missingOwner } = fixture.expected;
    expect(generation).toBe(fixture.armed.ownership.generation);
    expect(() =>
      assertNativeContinuousMetricSourceCoverage(source, missingOwner),
    ).toThrow("missing_owner_pin");
    expect(() =>
      assertNativeContinuousMetricSourceCoverage(
        {
          ...source,
          launched: {
            ...source.launched,
            scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
          },
        },
        fixture.expected,
      ),
    ).toThrow();
  });

  it("bounds maximum-tempo control geometry on wire and restores exact canonical rows", () => {
    const original = config();
    const geometry = createContinuousMetricListeningGeometry({
      captureMode: "arrangement-continuous",
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 999,
      startBeat: 0.1,
      endBeat: 9990.1,
      startSample: 0,
    });
    const full = nativeContinuousMetricListeningConfigSchema.parse({
      ...original,
      geometry,
      sourceContext: {
        ...original.sourceContext,
        transport: { startBeat: 0.1, endBeat: 9990.1 },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(
      2 * 1024 * 1024,
    );
    const wire = compactNativeContinuousMetricListeningConfig(full);
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(4096);
    expect(JSON.stringify(wire)).not.toContain('"rows":');
    expect(nativeMetricControlConfigWireSchema.parse(wire)).toEqual(full);
    expect(
      nativeMetricControlConfigWireSchema.safeParse({
        ...wire,
        geometry: { ...wire.geometry, endBeat: 9991 },
      }).success,
    ).toBe(false);
    expect(
      nativeMetricControlConfigWireSchema.safeParse({
        ...wire,
        geometry: { ...wire.geometry, startSample: 1 },
      }).success,
    ).toBe(false);
    expect(
      nativeMetricControlConfigWireSchema.safeParse({
        ...wire,
        mode: "session",
      }).success,
    ).toBe(false);
  });

  it("compacts ready and armed envelopes without weakening physical proof guards", () => {
    const fixture = proofFixture();
    const ready = nativeContinuousMetricReadyProofSchema.parse(fixture.ready);
    const armed = nativeContinuousMetricArmProofSchema.parse(fixture.armed);
    const readyWire = compactNativeContinuousMetricReadyProof(ready);
    const armWire = compactNativeContinuousMetricArmProof(armed);
    expect(Buffer.byteLength(JSON.stringify(readyWire))).toBeLessThan(
      128 * 1024,
    );
    expect(Buffer.byteLength(JSON.stringify(armWire))).toBeLessThan(128 * 1024);
    expect(nativeMetricControlReadyProofWireSchema.parse(readyWire)).toEqual(
      ready,
    );
    expect(nativeMetricControlArmProofWireSchema.parse(armWire)).toEqual(armed);
    expect(
      nativeMetricControlArmProofWireSchema.safeParse({
        ...armWire,
        receipt: {
          ...armWire.receipt,
          confirmedFields: Array<number>(12).fill(0),
        },
      }).success,
    ).toBe(false);
  });

  it("admits a distinct local-grid 600-second six-family request", () => {
    const value = config();
    expect(nativeContinuousMetricListeningConfigSchema.parse(value)).toEqual(
      value,
    );
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it.each([
    { mode: "session" },
    { captureMode: "session" },
    { capability: "audio-listener/independent-metric-timelines-v1" },
    { scope: "independent-metric-timelines/v1" },
    { maxPendingChunks: 9 },
    { maxPendingChunks: 0 },
    { maxChunkBytes: 256 * 1024 },
    { requestedMetrics: ["level", "level"], attacks: null },
    { attacks: null },
  ])(
    "rejects unsupported scope, capability, metric or queue setting %#",
    (change) => {
      expect(
        nativeContinuousMetricListeningConfigSchema.safeParse({
          ...config(),
          ...change,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects translated source coordinates as native admission", () => {
    const value = config();
    const geometry = createContinuousMetricListeningGeometry({
      captureMode: "arrangement-continuous",
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 120,
      startBeat: 0,
      endBeat: 1200,
      startSample: 100_000,
    });
    expect(
      nativeContinuousMetricListeningConfigSchema.safeParse({
        ...value,
        geometry,
      }).success,
    ).toBe(false);
  });

  it("keeps attacks optional only when not requested and validates source range", () => {
    const value = config();
    expect(
      nativeContinuousMetricListeningConfigSchema.safeParse({
        ...value,
        requestedMetrics: ["level"],
      }).success,
    ).toBe(false);
    expect(
      nativeContinuousMetricListeningConfigSchema.safeParse({
        ...value,
        requestedMetrics: ["level"],
        attacks: null,
      }).success,
    ).toBe(true);
    expect(
      nativeContinuousMetricListeningConfigSchema.safeParse({
        ...value,
        sourceContext: {
          ...value.sourceContext,
          transport: { startBeat: 0, endBeat: 1199 },
        },
      }).success,
    ).toBe(false);
    expect(
      nativeContinuousMetricListeningConfigSchema.safeParse({
        ...value,
        sourceContext: { ...value.sourceContext, view: "session" },
      }).success,
    ).toBe(false);
  });

  it("uses explicit long control/ready/arm proofs with unchanged native seal and readiness guards", () => {
    const fixture = proofFixture();
    expect(
      nativeMetricControlConfigSchema.safeParse(fixture.expected.config)
        .success,
    ).toBe(true);
    expect(
      nativeContinuousMetricReadyProofSchema.safeParse(fixture.ready).success,
    ).toBe(true);
    expect(
      nativeContinuousMetricArmProofSchema.safeParse(fixture.armed).success,
    ).toBe(true);
    expect(
      nativeMetricControlReadyProofSchema.safeParse(fixture.ready).success,
    ).toBe(true);
    expect(
      nativeMetricControlArmProofSchema.safeParse(fixture.armed).success,
    ).toBe(true);
    expect(nativeMetricReadyProofSchema.safeParse(fixture.ready).success).toBe(
      false,
    );
    expect(nativeMetricArmProofSchema.safeParse(fixture.armed).success).toBe(
      false,
    );
    const ready = assertNativeContinuousMetricReadyProof(
      fixture.ready,
      fixture.expected,
    );
    const armed = assertNativeContinuousMetricArmProof(
      fixture.armed,
      fixture.expected,
    );
    expect(Object.isFrozen(ready.before.frames)).toBe(true);
    expect(Object.isFrozen(armed.receipt.fields)).toBe(true);
    const snapshot = snapshotNativeContinuousMetricListeningExpectation(
      fixture.expected,
    );
    expect(Object.isFrozen(snapshot.config.geometry.rows)).toBe(true);
    expect(snapshot).toEqual(fixture.expected);
    expect(
      nativeContinuousMetricLaunchCoordinates(
        armed,
        fixture.launch,
        fixture.expected,
      ),
    ).toMatchObject({
      startSample: fixture.origin,
      endSample: fixture.origin + 28_800_000,
      hostStartSample: fixture.origin + 1_000_000,
    });
  });

  it("denies missing analyzer readiness, stale idle owners, changed DSP holds and source mismatch", () => {
    const { ready, armed } = proofFixture();
    for (const change of [
      { analyzerProducerAbi: undefined },
      { disarmCounter: ready.before.frames[0]![4] },
      {
        idle: {
          ...ready.idle,
          fields: [1, ...ready.idle.fields.slice(1, 11), 1],
          confirmedFields: [1, ...ready.idle.fields.slice(1, 11), 1],
        },
      },
      { before: { ...ready.before, dsp: [1, 44100, 64] } },
    ])
      expect(
        nativeContinuousMetricReadyProofSchema.safeParse({
          ...ready,
          ...change,
        }).success,
      ).toBe(false);
    for (const change of [
      { analyzerProducerAbi: undefined },
      {
        receipt: {
          ...armed.receipt,
          confirmedFields: armed.receipt.fields.map((cell, index) =>
            index === 1 ? cell - 1 : cell,
          ),
        },
      },
      {
        receipt: {
          ...armed.receipt,
          fields: armed.receipt.fields.map((cell, index) =>
            index === 10 ? cell + 1 : cell,
          ),
        },
      },
      {
        receipt: {
          ...armed.receipt,
          timing: [1, -1, 0, 1, -1, 99000, -1, 3],
          confirmedTiming: [1, -1, 0, 1, -1, 99000, -1, 3],
        },
      },
      { config: { ...armed.config, mode: "session" } },
    ])
      expect(
        nativeContinuousMetricArmProofSchema.safeParse({ ...armed, ...change })
          .success,
      ).toBe(false);
  });

  it("pins continuous control ownership/configuration and rejects forged launches before source publication", () => {
    const f = proofFixture();
    const arm = nativeContinuousMetricArmProofSchema.parse(f.armed);
    for (const expected of [
      { ...f.expected, passId: "different-pass" },
      { ...f.expected, causationId: "different-cause" },
      { ...f.expected, generation: "00000000-0000-4000-8000-000000000099" },
    ])
      expect(() =>
        assertNativeContinuousMetricArmProof(arm, expected),
      ).toThrow();
    const { nativeEpoch, ...missingEpoch } = f.expected;
    expect(nativeEpoch).toBe(1);
    expect(() =>
      assertNativeContinuousMetricArmProof(arm, missingEpoch),
    ).toThrow("incomplete_owner_pin");
    expect(() =>
      nativeContinuousMetricLaunchCoordinates(
        arm,
        {
          ...f.launch,
          timing: [1, 1064, 0, 1, 64, 99000, f.origin + 1, 3],
        },
        f.expected,
      ),
    ).toThrow("launch_binding_mismatch");
    expect(() =>
      nativeContinuousMetricLaunchCoordinates(
        arm,
        {
          ...f.launch,
          ownership: { ...f.launch.ownership, correlationId: "different" },
        },
        f.expected,
      ),
    ).toThrow();
  });
});
