import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { createMetricListeningGeometry } from "./metric-listening-geometry.js";
import {
  metricAudioObservationSchema,
  createMetricObservationReportRows,
} from "./metric-observation-schemas.js";
import type { nativeHostClockRowSchema } from "./native-listening-schemas.js";
import {
  nativeArmProofV2Schema,
  assertNativeSourceCoverageV2,
} from "./native-listening-v2-schemas.js";
import {
  nativeMetricListeningConfigSchema,
  nativeMetricArmProofSchema,
  nativeMetricReadyProofSchema,
  nativeMetricOwnershipSchema,
  nativeMetricLaunchProofSchema,
  nativeMetricSourceCoverageProofSchema,
  nativeMetricSpectrumPhaseSchema,
  nativeMetricFirstSpectrumEndpoint,
  assertNativeMetricArmProof,
  assertNativeMetricReadyProof,
  assertNativeMetricSourceCoverage,
  assertNativeMetricObservationSource,
  nativeMetricLaunchCoordinates,
  snapshotNativeMetricListeningExpectation,
  NATIVE_METRIC_LISTENING_SCOPE,
  type NativeMetricListeningExpectation,
} from "./native-metric-listening-schemas.js";
import { createSyntheticNativeListeningFixtureV2 } from "./testing.js";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
} from "./metric-testing.js";

type Row = z.infer<typeof nativeHostClockRowSchema>;

/** Synthetic contract provenance only: no Max compilation/physical readiness. */
function fixture(
  options: {
    rate?: 44_100 | 48_000;
    vector?: number;
    total?: number;
    startBeat?: number;
    session?: boolean;
    completedLaunch?: boolean;
    strict?: boolean;
    shift?: number;
    hostOffset?: number;
    armLead?: number;
    clockStep?: number;
  } = {},
) {
  const rate = options.rate ?? 48_000;
  const vector = options.vector ?? 64;
  const total = options.total ?? rate;
  const tempo = 128;
  const startBeat = options.startBeat ?? (options.session ? 0 : 5.13);
  const geometry = createMetricListeningGeometry({
    sampleRate: rate,
    vectorSize: vector,
    tempoBpm: tempo,
    startBeat,
    endBeat: startBeat + (total * tempo) / (rate * 60),
    startSample: 0,
  });
  const config = nativeMetricListeningConfigSchema.parse({
    scope: NATIVE_METRIC_LISTENING_SCOPE,
    algorithmVersion: "3.0.0",
    geometry,
    timingPolicy: options.strict
      ? { mode: "strict", maxClockDisagreementSamples: 0 }
      : { mode: "descriptive", maxClockDisagreementSamples: 64 },
    grid: {
      beats: 0.25,
      anchor: "global-beat-grid",
      rounding: "nearest-sample",
      coordinates: "capture-local",
    },
    requestedMetrics: ["level", "spectral-centroid", "attacks"],
    attacks: { thresholdDb: 6, minSpacingSamples: Math.round(rate / 10) },
    ...(options.session
      ? {
          mode: "session",
          sourceEvidence: "expected-context-only",
          source: {
            mode: "session",
            synchronization: "transport-coupled-first-iteration",
            target: {
              view: "session",
              sceneIndex: 0,
              expectedClipReference: "11111111-1111-4111-8111-111111111111",
              expectedClipName: "clip",
              track: {
                kind: "regular",
                index: 0,
                expectedReference: "22222222-2222-4222-8222-222222222222",
                expectedName: "track",
              },
            },
          },
        }
      : { mode: "arrangement", sourceEvidence: "transport-only" }),
  });
  const owner = {
    listenerId: "synthetic-metric-listener",
    passId: "synthetic-metric-pass",
    connectionId: "55555555-5555-4555-8555-555555555555",
    connectionEpoch: "66666666-6666-4666-8666-666666666666",
    generation: "33333333-3333-4333-8333-333333333333",
    nativeEpoch: 1,
    traceId: "77777777-7777-4777-8777-777777777777",
    correlationId: "synthetic-correlation",
    causationId: "synthetic-capture-origin",
  };
  const origin = 200_000;
  const armLead = options.armLead ?? 1_000;
  const armCounter = origin - armLead;
  const offset = options.hostOffset ?? 800_000;
  const clockStep = options.clockStep ?? 512;
  const samplesPerBeat = (rate * 60) / tempo;
  const row = (counter: number, playing: boolean, shift = 0): Row => {
    const beat = playing
      ? startBeat + (counter - origin) / samplesPerBeat
      : startBeat;
    const sample = counter + offset + shift;
    return [
      Number(playing) as 0 | 1,
      beat,
      sample,
      31,
      counter,
      playing ? beat % 1 : 0.618,
      counter,
      Number(playing) as 0 | 1,
      beat,
      sample,
      31,
    ];
  };
  const before = Array.from({ length: 32 }, (_, index) =>
    row(armCounter - (32 - index) * clockStep, false),
  );
  const phaseClocks = Array.from({ length: 32 }, (_, index) => {
    const clock = row(armCounter - (32 - index) * 256, false);
    clock[2] = clock[9] = Math.max(0, clock[2]);
    return clock;
  });
  const phaseEnd =
    origin - Math.ceil((origin - phaseClocks[12]![4]) / 2048) * 2048;
  const clearedSpectrum = Array<number>(20).fill(0);
  clearedSpectrum[0] = 1;
  clearedSpectrum[2] = clearedSpectrum[18] = 1;
  const watermark = origin + total + vector;
  const spectrumReceipt = (
    nativeSourceCounter: number,
    observedHostReceiptMs: number,
  ) => ({
    raw: [...clearedSpectrum],
    counterBefore: nativeSourceCounter,
    counterAfter: nativeSourceCounter,
    nativeSourceCounter,
    observedHostReceiptMs,
  });
  const launch = row(
    origin + (options.completedLaunch ? total + vector - 1 : vector),
    true,
  );
  const after = Array.from({ length: 32 }, (_, index) =>
    row(origin + total + vector + 64 + index * clockStep, true, options.shift),
  );
  const fields = [
    1,
    total,
    rate / 10,
    tempo,
    startBeat - Math.floor(startBeat),
    vector,
    1,
    startBeat,
    geometry.endBeat,
    geometry.rows.length,
    1,
    1,
  ];
  const armTiming = [1, -1, 0, 0, -1, armCounter, -1, 3];
  const clocks = [...before, ...after, launch];
  const playing = [...after, launch];
  const extreme = (
    rows: Row[],
    value: (row: Row) => number,
    maximum: boolean,
  ): Row =>
    rows.reduce((best, current) =>
      (maximum ? value(current) > value(best) : value(current) < value(best))
        ? current
        : best,
    );
  const beatOrigin = (r: Row) =>
    r[2] - Math.round((r[1] - startBeat) * samplesPerBeat);
  const phase = (r: Row) => {
    const difference = Math.abs(
      Math.round(r[5] * samplesPerBeat) -
        Math.round((r[1] % 1) * samplesPerBeat),
    );
    return Math.min(
      difference,
      Math.abs(Math.round(samplesPerBeat) - difference),
    );
  };
  const proof = nativeMetricSourceCoverageProofSchema.parse({
    armed: {
      scope: NATIVE_METRIC_LISTENING_SCOPE,
      ownership: owner,
      config,
      before: { dsp: [1, rate, vector], frames: before },
      receipt: {
        fields,
        confirmedFields: fields,
        timing: armTiming,
        confirmedTiming: armTiming,
        elapsedMs: 20,
      },
    },
    launched: {
      scope: NATIVE_METRIC_LISTENING_SCOPE,
      ownership: owner,
      timing: [
        1,
        armLead + vector,
        0,
        options.completedLaunch ? 0 : 1,
        vector,
        armCounter,
        origin,
        3,
      ],
      clock: launch,
      elapsedMs: 100,
    },
    completion: {
      fields,
      confirmedFields: fields,
      timing: [1, armLead + vector, 0, 0, vector, armCounter, origin, 3],
      confirmedTiming: [
        1,
        armLead + vector,
        0,
        0,
        vector,
        armCounter,
        origin,
        3,
      ],
      elapsedMs: 20,
    },
    after: { dsp: [1, rate, vector], frames: after },
    timingWitnesses: {
      minHostOffset: extreme(clocks, (r) => r[2] - r[4], false),
      maxHostOffset: extreme(clocks, (r) => r[2] - r[4], true),
      minBeatOrigin: extreme(playing, beatOrigin, false),
      maxBeatOrigin: extreme(playing, beatOrigin, true),
      maxPhaseDisagreement: extreme(playing, phase, true),
    },
    postElapsedMs: 100,
    spectrumPhase: {
      scope: "native-metric-spectrum-phase/v1",
      ownership: owner,
      fftInformation: [2048, 2048, 2048, 1],
      binding: { abi: 2, ready: [2, 1, 1] },
      clock: { dsp: [1, rate, vector], frames: phaseClocks },
      acquisitions: [
        [1, phaseEnd - 1, phaseEnd - 1, phaseEnd],
        [1, phaseEnd + 2047, phaseEnd + 2047, phaseEnd + 2048],
      ],
    },
    spectrumCleanup: {
      type: "native-metric-spectrum-cleanup/v1",
      generation: owner.generation,
      nativeEpoch: 1,
      status: "completed",
      phase: "disabled-confirmed",
      outcome: "complete",
      diagnosticOnly: false,
      inputFailureReason: null,
      reason: null,
      stopWatermark: watermark,
      deadlineMs: 2010,
      requestedHostMs: 10,
      completedHostMs: 30,
      watermarkReceipt: {
        available: true,
        value: spectrumReceipt(watermark, 20),
      },
      receipt: {
        available: true,
        value: spectrumReceipt(watermark + vector, 30),
      },
    },
  });
  const expected: NativeMetricListeningExpectation = {
    ...owner,
    config,
  };
  return { proof, expected, row, origin, offset, total };
}

function observationFixture(
  options: Parameters<typeof fixture>[0] = {},
  partial = false,
) {
  const f = fixture(options);
  const config = f.expected.config;
  const g = config.geometry;
  const observation = (
    partial
      ? createSyntheticPartialMetricListeningObservation
      : createSyntheticMetricListeningObservation
  )({
    sampleRate: g.sampleRate,
    vectorSize: g.vectorSize,
    tempoBpm: g.tempoBpm,
    startBeat: g.startBeat,
    endBeat: g.endBeat,
    startSample: f.origin,
  });
  observation.ownership = structuredClone(f.proof.armed.ownership);
  observation.alignment = structuredClone(
    assertNativeMetricSourceCoverage(f.proof, f.expected).alignment,
  );
  if (config.mode === "session")
    observation.source = {
      view: "session",
      target: structuredClone(config.source.target),
      clipReference: config.source.target.expectedClipReference,
      kind: "midi",
      coordinate: {
        unit: "beats",
        iteration: 0,
        startBeat: 0,
        endBeat: g.endBeat,
      },
      transport: { startBeat: 0, endBeat: g.endBeat },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
  return { ...f, observation };
}

describe("actual counter-bound spectral phase", () => {
  it.each([44_100, 48_000] as const)(
    "%i: derives the first capture endpoint from witnessed native phase",
    (rate) => {
      const f = observationFixture({ rate });
      const phase = nativeMetricSpectrumPhaseSchema.parse(
        f.proof.spectrumPhase,
      );
      expect(nativeMetricFirstSpectrumEndpoint(phase, f.origin)).toBe(
        f.origin + 2048,
      );
      expect(nativeMetricFirstSpectrumEndpoint(phase, f.origin + 37)).toBe(
        f.origin + 2048,
      );
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).not.toThrow();
    },
  );

  it.each([
    "foreign-epoch",
    "torn",
    "nonconsecutive",
    "future-endpoint",
    "outside-clock",
    "incoherent-clock",
  ])("rejects %s instead of inventing FFT timing", (fault) => {
    const phase = nativeMetricSpectrumPhaseSchema.parse(
      fixture().proof.spectrumPhase,
    );
    if (fault === "foreign-epoch") phase.acquisitions[0][0]++;
    if (fault === "torn") phase.acquisitions[0][2]++;
    if (fault === "nonconsecutive") phase.acquisitions[1][3]--;
    if (fault === "future-endpoint")
      phase.acquisitions[0][1] = phase.acquisitions[0][2] =
        phase.acquisitions[0][3] - 2;
    if (fault === "outside-clock")
      phase.acquisitions[0][1] = phase.acquisitions[0][2] =
        phase.clock.frames[0]![4] - 1;
    if (fault === "incoherent-clock") phase.clock.frames[0]![6]++;
    expect(() => nativeMetricSpectrumPhaseSchema.parse(phase)).toThrow();
  });

  it("cannot publish known spectral cadence without actual phase proof", () => {
    const f = observationFixture();
    delete f.proof.spectrumPhase;
    expect(() =>
      assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
    ).toThrow("native_metric_spectrum_phase_binding_mismatch");
  });

  it("binds phase ownership and sample rate to the actual capture", () => {
    const f = observationFixture();
    const phase = nativeMetricSpectrumPhaseSchema.parse(f.proof.spectrumPhase);
    phase.ownership.generation = "44444444-4444-4444-8444-444444444444";
    f.proof.spectrumPhase = phase;
    expect(() =>
      assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
    ).toThrow("native_metric_spectrum_phase_binding_mismatch");
    phase.ownership.generation = f.proof.armed.ownership.generation;
    phase.clock.dsp[1] = 44_100;
    expect(() =>
      assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
    ).toThrow("native_metric_spectrum_phase_binding_mismatch");
  });
});

describe("frozen admitted metric source context", () => {
  it.each(["arrangement", "session"] as const)(
    "binds complete/partial %s source metadata to the original intent",
    (mode) => {
      for (const partial of [false, true]) {
        const f = observationFixture({ session: mode === "session" }, partial);
        const config = nativeMetricListeningConfigSchema.parse({
          ...f.expected.config,
          sourceContext: f.observation.source,
        });
        const proof = structuredClone(f.proof);
        proof.armed.config = config;
        const expected = { ...f.expected, config };
        expect(
          assertNativeMetricObservationSource(proof, f.observation, expected)
            .source,
        ).toEqual(f.observation.source);
        const pinned = snapshotNativeMetricListeningExpectation(expected);
        expect(Object.isFrozen(pinned.config.sourceContext)).toBe(true);
        if (f.observation.source.view === "arrangement")
          f.observation.source.target.expectedReference =
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        else f.observation.source.kind = "warped-audio";
        expect(
          metricAudioObservationSchema.safeParse(f.observation).success,
        ).toBe(true);
        expect(() =>
          assertNativeMetricObservationSource(proof, f.observation, pinned),
        ).toThrow("native_metric_observation_binding_mismatch");
      }
    },
  );

  it("rejects source context whose transport range differs from capture admission", () => {
    const f = observationFixture();
    const sourceContext = structuredClone(f.observation.source);
    sourceContext.transport.endBeat++;
    expect(
      nativeMetricListeningConfigSchema.safeParse({
        ...f.expected.config,
        sourceContext,
      }).success,
    ).toBe(false);
  });

  it("rejects Session source context with a different expected clip", () => {
    const f = observationFixture({ session: true });
    const sourceContext = structuredClone(f.observation.source);
    if (sourceContext.view !== "session")
      throw new Error("Synthetic Session source missing");
    sourceContext.clipReference = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      nativeMetricListeningConfigSchema.safeParse({
        ...f.expected.config,
        sourceContext,
      }).success,
    ).toBe(false);
  });
});

function readyFixture(
  priorCapture = false,
  options: Parameters<typeof fixture>[0] = {},
) {
  const f = fixture(options);
  const ownership = {
    ...f.proof.armed.ownership,
    nativeEpoch: priorCapture ? 2 : 1,
  };
  const frames = f.proof.armed.before.frames;
  const fields = priorCapture
    ? [1, 24000, 4800, 120, 0, 64, 1, 0, 1, 4, 0, 1]
    : Array<number>(12).fill(0);
  const timing = priorCapture
    ? [0, 1064, 4, 0, 64, 50000, 51000, 3]
    : [0, -1, 0, 0, -1, -1, -1, 3];
  const ready = {
    scope: NATIVE_METRIC_LISTENING_SCOPE,
    phase: "idle-preflight" as const,
    configurationEvidence: "admitted-not-executed" as const,
    ownership,
    config: f.expected.config,
    disarmCounter: frames[0]![4] - 64,
    before: f.proof.armed.before,
    idle: {
      fields,
      confirmedFields: [...fields],
      timing,
      confirmedTiming: [...timing],
      configurationCounter: frames[2]![4],
      confirmedConfigurationCounter: frames[4]![4],
      timingCounter: frames[3]![4],
      confirmedTimingCounter: frames[5]![4],
      elapsedMs: 20,
    },
    elapsedMs: 100,
  };
  return {
    ...f,
    ready,
    expected: { ...f.expected, nativeEpoch: ownership.nativeEpoch },
  };
}

describe("non-arming metric prepare readiness", () => {
  it.each([44_100, 48_000] as const)(
    "supports non-arming %iHz preflight for both modes and every supported vector",
    (rate) => {
      for (const session of [false, true])
        for (let vector = 1; vector <= 1024; vector *= 2) {
          const f = readyFixture(false, { rate, vector, session });
          expect(() =>
            assertNativeMetricReadyProof(f.ready, f.expected),
          ).not.toThrow();
        }
    },
  );
  it("accepts genuine idle preflight with zero histories without manufacturing an arm certificate", () => {
    const f = readyFixture();
    const fakeArm = {
      scope: f.ready.scope,
      ownership: f.ready.ownership,
      config: f.ready.config,
      before: f.ready.before,
      receipt: {
        fields: f.ready.idle.fields,
        confirmedFields: f.ready.idle.confirmedFields,
        timing: f.ready.idle.timing,
        confirmedTiming: f.ready.idle.confirmedTiming,
        elapsedMs: f.ready.idle.elapsedMs,
      },
    };
    expect(nativeMetricArmProofSchema.safeParse(fakeArm).success).toBe(false);
    const ready = nativeMetricReadyProofSchema.parse(f.ready);
    expect(() => assertNativeMetricReadyProof(ready, f.expected)).not.toThrow();
    expect(ready.idle.fields[6]).toBe(0);
    expect(ready.configurationEvidence).toBe("admitted-not-executed");
  });
  it("allows prior cancelled launch/configuration latches only as unsealed idle histories", () => {
    const f = readyFixture(true);
    const result = assertNativeMetricReadyProof(f.ready, f.expected);
    expect(result.idle.timing[1]).toBe(1064);
    expect(result.idle.timing[6]).toBe(51000);
    expect(result.idle.fields[1]).toBe(24000);
    expect(result.config.geometry.totalSamples).toBe(48000);
    expect(result.idle.fields[0]).toBeLessThan(result.ownership.nativeEpoch);
    expect(result.idle.fields[10]).toBe(0);
    expect(Object.isFrozen(result.config.attacks)).toBe(true);
    expect(Object.isFrozen(result.idle.confirmedFields)).toBe(true);
    expect(Reflect.set(result.idle.timing, "0", 2)).toBe(false);
    expect(nativeMetricArmProofSchema.safeParse(result).success).toBe(false);
    expect(nativeMetricReadyProofSchema.safeParse(f.proof.armed).success).toBe(
      false,
    );
  });
  it.each([
    ["timing", 0, 1],
    ["timing", 3, 1],
    ["timing", 7, 2],
    ["fields", 10, 1],
    ["fields", 11, 1],
  ] as const)(
    "rejects armed/active, wrong ABI or sealed/torn idle %s cell%i",
    (field, index, value) => {
      const f = readyFixture();
      Reflect.set(f.ready.idle[field], index, value);
      Reflect.set(
        field === "timing"
          ? f.ready.idle.confirmedTiming
          : f.ready.idle.confirmedFields,
        index,
        value,
      );
      expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(
        false,
      );
    },
  );
  it.each(["fields", "timing"] as const)(
    "rejects changed immutable idle %s confirmation",
    (field) => {
      const f = readyFixture();
      const values =
        field === "fields"
          ? f.ready.idle.confirmedFields
          : f.ready.idle.confirmedTiming;
      values[1] = values[1]! + 1;
      expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(
        false,
      );
    },
  );
  it.each([
    "configurationCounter",
    "confirmedConfigurationCounter",
    "timingCounter",
    "confirmedTimingCounter",
  ] as const)(
    "requires actual fresh %s within the stopped native-clock bracket",
    (field) => {
      for (const boundary of ["before", "after"] as const) {
        const f = readyFixture();
        f.ready.idle[field] =
          boundary === "before"
            ? f.ready.before.frames[0]![4] - 1
            : f.ready.before.frames.at(-1)![4] + 1;
        expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(
          false,
        );
      }
    },
  );
  it("requires confirmations on later DSP cohorts, not cloned counter attribution", () => {
    for (const field of ["configurationCounter", "timingCounter"] as const) {
      const f = readyFixture();
      const confirmed =
        field === "configurationCounter"
          ? "confirmedConfigurationCounter"
          : "confirmedTimingCounter";
      f.ready.idle[confirmed] = f.ready.idle[field];
      expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(
        false,
      );
    }
  });
  it("rejects reused future epochs, pre-disarm clocks and expired preflight", () => {
    const reused = readyFixture(true);
    reused.ready.ownership.nativeEpoch = 1;
    expect(nativeMetricReadyProofSchema.safeParse(reused.ready).success).toBe(
      false,
    );
    const stale = readyFixture();
    stale.ready.disarmCounter = stale.ready.before.frames[0]![4];
    expect(nativeMetricReadyProofSchema.safeParse(stale.ready).success).toBe(
      false,
    );
    for (const stage of ["idle", "preflight"] as const) {
      const f = readyFixture();
      if (stage === "idle") f.ready.idle.elapsedMs = 1001;
      else f.ready.elapsedMs = 2001;
      expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(
        false,
      );
    }
  });
  it("requires stopped requested-position clocks and matching live DSP geometry", () => {
    for (const fault of ["playing", "beat", "rate", "vector"] as const) {
      const f = readyFixture();
      if (fault === "rate") f.ready.before.dsp[1] = 44100;
      else if (fault === "vector") f.ready.before.dsp[2] = 128;
      else
        for (const row of f.ready.before.frames) {
          if (fault === "playing") {
            row[0] = 1;
            row[7] = 1;
          } else {
            row[1]++;
            row[8]++;
          }
        }
      expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(
        false,
      );
    }
  });
  it("binds prepared intent and attribution without certifying executed configuration", () => {
    const f = readyFixture();
    const expected = snapshotNativeMetricListeningExpectation(f.expected);
    const changed = structuredClone(f.ready);
    changed.config.attacks!.thresholdDb++;
    expect(nativeMetricReadyProofSchema.safeParse(changed).success).toBe(true);
    expect(() => assertNativeMetricReadyProof(changed, expected)).toThrow(
      "native_metric_owner_or_config_mismatch",
    );
    changed.config = structuredClone(f.ready.config);
    changed.ownership.traceId = "44444444-4444-4444-8444-444444444444";
    expect(() => assertNativeMetricReadyProof(changed, expected)).toThrow(
      "native_metric_owner_or_config_mismatch",
    );
  });
  it("preserves strict stopped-clock agreement and native counter headroom at preflight", () => {
    const strict = readyFixture(false, { strict: true });
    const last = strict.ready.before.frames.at(-1)!;
    last[2]++;
    last[9]++;
    expect(nativeMetricReadyProofSchema.safeParse(strict.ready).success).toBe(
      false,
    );
    const f = readyFixture();
    const delta = 2 ** 44 - 100 - f.ready.before.frames.at(-1)![4];
    for (const row of f.ready.before.frames)
      for (const index of [2, 4, 6, 9] as const) row[index] += delta;
    f.ready.disarmCounter += delta;
    for (const name of [
      "configurationCounter",
      "confirmedConfigurationCounter",
      "timingCounter",
      "confirmedTimingCounter",
    ] as const)
      f.ready.idle[name] += delta;
    expect(nativeMetricReadyProofSchema.safeParse(f.ready).success).toBe(false);
  });
});

describe("pinned metric launch coordinates", () => {
  it("uses the same checked native origin before collection as final source coverage", () => {
    const f = fixture();
    const coordinates = nativeMetricLaunchCoordinates(
      f.proof.armed,
      f.proof.launched,
      f.expected,
    );
    const final = assertNativeMetricSourceCoverage(f.proof, f.expected);
    expect(coordinates).toEqual({
      startSample: f.origin,
      endSample: f.origin + f.total,
      originCounter: f.origin,
      hostOffsetSamples: f.offset,
      hostStartSample: f.origin + f.offset,
      hostEndSample: f.origin + f.offset + f.total,
    });
    for (const key of Object.keys(coordinates) as (keyof typeof coordinates)[])
      expect(coordinates[key]).toBe(final[key]);
    expect(Object.isFrozen(coordinates)).toBe(true);
  });

  it("rejects unpinned launch transactions and self-consistent foreign owners", () => {
    const f = fixture();
    const unpinned = { ...f.expected };
    delete unpinned.generation;
    delete unpinned.nativeEpoch;
    expect(() =>
      nativeMetricLaunchCoordinates(f.proof.armed, f.proof.launched, unpinned),
    ).toThrow("native_metric_missing_owner_pin");
    const changed = structuredClone(f.proof);
    changed.armed.ownership.passId = "other-pass";
    changed.launched.ownership.passId = "other-pass";
    expect(() =>
      nativeMetricLaunchCoordinates(
        changed.armed,
        changed.launched,
        f.expected,
      ),
    ).toThrow();
    changed.armed = f.proof.armed;
    expect(() =>
      nativeMetricLaunchCoordinates(
        changed.armed,
        changed.launched,
        f.expected,
      ),
    ).toThrow("native_metric_launch_binding_mismatch");
  });

  it("rejects a forged marker or short-capture completion without endpoint passage", () => {
    const f = fixture({ total: 1, completedLaunch: true });
    const wrongMarker = structuredClone(f.proof.launched);
    wrongMarker.timing[6]++;
    expect(() =>
      nativeMetricLaunchCoordinates(f.proof.armed, wrongMarker, f.expected),
    ).toThrow("native_metric_launch_binding_mismatch");
    const early = structuredClone(f.proof.launched);
    early.clock[4] = f.origin;
    early.clock[6] = f.origin;
    expect(() =>
      nativeMetricLaunchCoordinates(f.proof.armed, early, f.expected),
    ).toThrow("native_metric_launch_binding_mismatch");
  });
});

describe("actual ABI3 arm execution receipt", () => {
  it("uses the actual12 DSP histories and compact8 operands, not a legacy reset certificate", () => {
    const f = fixture();
    expect(assertNativeMetricArmProof(f.proof.armed, f.expected)).toEqual(
      f.proof.armed,
    );
    expect(f.proof.armed.receipt.fields).toHaveLength(12);
    expect(f.proof.armed.receipt.timing).toHaveLength(8);
    expect("reset" in f.proof.armed).toBe(false);
    expect(nativeArmProofV2Schema.safeParse(f.proof.armed).success).toBe(false);
  });
  it.each(Array.from({ length: 12 }, (_, index) => index))(
    "rejects altered executed configuration cell%i even when both snapshots agree",
    (index) => {
      const { proof } = fixture();
      Reflect.set(
        proof.armed.receipt.fields,
        index,
        proof.armed.receipt.fields[index]! + 1,
      );
      Reflect.set(
        proof.armed.receipt.confirmedFields,
        index,
        proof.armed.receipt.fields[index],
      );
      expect(nativeMetricArmProofSchema.safeParse(proof.armed).success).toBe(
        false,
      );
    },
  );
  it("rejects a changed immutable confirmation even when every scalar remains in range", () => {
    const { proof } = fixture();
    proof.armed.receipt.confirmedFields[1]++;
    expect(nativeMetricArmProofSchema.safeParse(proof.armed).success).toBe(
      false,
    );
  });
  it("rejects setter echoes and missing receipt fields", () => {
    const { proof } = fixture();
    expect(
      nativeMetricArmProofSchema.safeParse({
        ...proof.armed,
        receipt: {
          ...proof.armed.receipt,
          fields: proof.armed.config.geometry,
        },
      }).success,
    ).toBe(false);
    const receipt = { ...proof.armed.receipt };
    Reflect.deleteProperty(receipt, "confirmedFields");
    expect(
      nativeMetricArmProofSchema.safeParse({ ...proof.armed, receipt }).success,
    ).toBe(false);
  });
  it.each([0, 1, 3, 4, 5, 6, 7])(
    "checks actual arm timing cell%i and confirmed hold",
    (index) => {
      const { proof } = fixture();
      Reflect.set(
        proof.armed.receipt.confirmedTiming,
        index,
        proof.armed.receipt.timing[index]! + 1,
      );
      expect(nativeMetricArmProofSchema.safeParse(proof.armed).success).toBe(
        false,
      );
    },
  );
  it("does not turn optional analyzers into universal arm readiness prerequisites", () => {
    const { proof, expected } = fixture();
    proof.armed.config.requestedMetrics = ["spectral-centroid"];
    proof.armed.config.attacks = null;
    const selected = { ...expected, config: proof.armed.config };
    expect(() =>
      assertNativeMetricArmProof(proof.armed, selected),
    ).not.toThrow();
    expect("spectralWindows" in proof).toBe(false);
    expect("retentionReady" in proof.armed).toBe(false);
  });
});

describe("shared source proof independent of all metric outputs", () => {
  it("does not certify shared completion without an executed post-end DSP receipt", () => {
    const f = fixture();
    Reflect.deleteProperty(f.proof, "completion");
    expect(() =>
      assertNativeMetricSourceCoverage(f.proof, f.expected),
    ).toThrow();
  });
  it.each(Array.from({ length: 12 }, (_, index) => index))(
    "keeps mid-capture execution/seal mutation cell%i fatal despite healthy transport",
    (index) => {
      const f = fixture();
      Reflect.set(
        f.proof.completion.fields,
        index,
        f.proof.completion.fields[index]! + 1,
      );
      Reflect.set(
        f.proof.completion.confirmedFields,
        index,
        f.proof.completion.fields[index],
      );
      expect(() =>
        assertNativeMetricSourceCoverage(f.proof, f.expected),
      ).toThrow();
    },
  );
  it("rejects completion while DSP still runs, changed end holds, or native rejection/cancellation", () => {
    for (const [field, value] of [
      [3, 1],
      [2, 4],
      [6, 200001],
    ] as const) {
      const f = fixture();
      Reflect.set(f.proof.completion.timing, field, value);
      Reflect.set(f.proof.completion.confirmedTiming, field, value);
      expect(() =>
        assertNativeMetricSourceCoverage(f.proof, f.expected),
      ).toThrow();
    }
    const f = fixture();
    f.proof.completion.confirmedTiming[1]++;
    expect(() => assertNativeMetricSourceCoverage(f.proof, f.expected)).toThrow(
      "Native metric DSP readback seal or immutable hold mismatch",
    );
  });
  it.each([44_100, 48_000] as const)(
    "proves%iHz source coordinates with no descriptor arrays",
    (rate) => {
      const f = fixture({ rate });
      const result = assertNativeMetricSourceCoverage(f.proof, f.expected);
      expect(result.startSample).toBe(f.origin);
      expect(result.endSample).toBe(result.startSample + f.total);
      expect(result.hostStartSample).toBe(f.origin + f.offset);
      expect(result.hostEndSample).toBe(f.origin + f.offset + f.total);
      expect(result.originCounter).toBe(f.origin);
      expect(result.hostOffsetSamples).toBe(f.offset);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.alignment)).toBe(true);
      expect(
        nativeMetricSourceCoverageProofSchema.safeParse({
          ...f.proof,
          envelopeWindows: [],
        }).success,
      ).toBe(false);
    },
  );
  it.each([44_100, 48_000] as const)(
    "keeps%iHz crossing-beat0 supports native-positive even when their host projection is negative",
    (rate) => {
      const f = fixture({
        rate,
        vector: 1,
        startBeat: 0,
        armLead: 64,
        clockStep: 1,
        hostOffset: -199_904,
      });
      const result = assertNativeMetricSourceCoverage(f.proof, f.expected);
      expect(result.startSample).toBe(f.origin);
      expect(result.endSample).toBe(f.origin + f.total);
      expect(result.hostStartSample).toBe(96);
      expect(result.hostOffsetSamples).toBe(-199_904);
      const crossingSupport = {
        startSample: result.originCounter - 1024,
        endSample: result.originCounter + 1024,
      };
      expect(crossingSupport.startSample).toBeGreaterThan(0);
      expect(crossingSupport.startSample).toBeLessThan(result.startSample);
      expect(crossingSupport.endSample).toBeGreaterThan(result.startSample);
      expect(crossingSupport.startSample + result.hostOffsetSamples).toBe(-928);
      const local = f.expected.config.geometry;
      const native = createMetricListeningGeometry({
        sampleRate: local.sampleRate,
        vectorSize: local.vectorSize,
        tempoBpm: local.tempoBpm,
        startBeat: local.startBeat,
        endBeat: local.endBeat,
        startSample: result.originCounter,
      });
      expect(local.startSample).toBe(0);
      expect(native.endSample).toBe(result.endSample);
      expect(native.rows).toEqual(
        local.rows.map((row) => ({
          ...row,
          startSample: row.startSample + result.originCounter,
          endSample: row.endSample + result.originCounter,
        })),
      );
      expect(result.alignment.verifiedAbsoluteErrorBoundSamples).toBeNull();
    },
  );
  it.each([1, 23, 4_799, 4_801])(
    "supports genuine short/tail total%i without extending a legacy geometry",
    (total) => {
      const f = fixture({ total, startBeat: 0, completedLaunch: total === 1 });
      expect(f.proof.armed.config.geometry.totalSamples).toBe(total);
      const result = assertNativeMetricSourceCoverage(f.proof, f.expected);
      expect(result.endSample - result.startSample).toBe(total);
    },
  );
  it.each([44_100, 48_000] as const)(
    "checks completed one-sample source proof across every%iHz vector power",
    (rate) => {
      for (let vector = 1; vector <= 1024; vector *= 2) {
        const f = fixture({
          rate,
          vector,
          total: 1,
          startBeat: 0,
          completedLaunch: true,
        });
        expect(
          assertNativeMetricSourceCoverage(f.proof, f.expected).endSample,
        ).toBe(f.origin + 1);
      }
    },
  );
  it("cannot claim natural completion from active0 until the real source endpoint plus vector retention", () => {
    const f = fixture({ completedLaunch: true });
    f.proof.launched.clock = f.row(f.origin + 64, true);
    expect(() => assertNativeMetricSourceCoverage(f.proof, f.expected)).toThrow(
      "native_metric_launch_binding_mismatch",
    );
  });
  it("rejects a foreign launch owner, epoch or replayed generation", () => {
    for (const field of [
      "listenerId",
      "passId",
      "connectionId",
      "connectionEpoch",
      "nativeEpoch",
      "generation",
      "traceId",
      "correlationId",
      "causationId",
    ] as const) {
      const f = fixture();
      const value = f.proof.launched.ownership[field];
      Reflect.set(
        f.proof.launched.ownership,
        field,
        typeof value === "number"
          ? value + 1
          : [
                "generation",
                "connectionId",
                "connectionEpoch",
                "traceId",
              ].includes(field)
            ? "44444444-4444-4444-8444-444444444444"
            : `${value}-other`,
      );
      expect(() =>
        assertNativeMetricSourceCoverage(f.proof, f.expected),
      ).toThrow();
    }
  });
  it("requires authenticated generation/epoch pins for terminal proof", () => {
    const f = fixture();
    const unpinned = { ...f.expected };
    Reflect.deleteProperty(unpinned, "generation");
    Reflect.deleteProperty(unpinned, "nativeEpoch");
    expect(() =>
      assertNativeMetricArmProof(f.proof.armed, unpinned),
    ).not.toThrow();
    expect(() => assertNativeMetricSourceCoverage(f.proof, unpinned)).toThrow(
      "native_metric_missing_owner_pin",
    );
    expect(() =>
      snapshotNativeMetricListeningExpectation({ ...unpinned, nativeEpoch: 1 }),
    ).toThrow("native_metric_incomplete_owner_pin");
  });
  it("rejects changed immutable clock holds, not merely their extrema", () => {
    const f = fixture();
    f.proof.timingWitnesses.minHostOffset = [...f.proof.after.frames[0]!];
    f.proof.timingWitnesses.minHostOffset[2]++;
    f.proof.timingWitnesses.minHostOffset[9]++;
    expect(() => assertNativeMetricSourceCoverage(f.proof, f.expected)).toThrow(
      "native_metric_changed_clock_hold",
    );
  });
  it("checks launch clock holds too", () => {
    const f = fixture();
    f.proof.timingWitnesses.minHostOffset = [...f.proof.launched.clock];
    f.proof.timingWitnesses.minHostOffset[2]++;
    f.proof.timingWitnesses.minHostOffset[9]++;
    expect(() => assertNativeMetricSourceCoverage(f.proof, f.expected)).toThrow(
      "native_metric_changed_clock_hold",
    );
  });
  it.each([
    "minHostOffset",
    "maxHostOffset",
    "minBeatOrigin",
    "maxBeatOrigin",
    "maxPhaseDisagreement",
  ] as const)(
    "verifies retained extremum%s against all checked clocks",
    (name) => {
      const f = fixture({ shift: 64 });
      f.proof.timingWitnesses[name] = [...f.proof.armed.before.frames[0]!];
      if (name.includes("HostOffset") && name === "minHostOffset")
        f.proof.timingWitnesses[name] = [...f.proof.after.frames[0]!];
      expect(() =>
        assertNativeMetricSourceCoverage(f.proof, f.expected),
      ).toThrow();
    },
  );
  it("does not salvage partial source coverage as a partial metric result", () => {
    const f = fixture();
    for (const row of f.proof.after.frames) {
      row[4] -= f.total;
      row[6] -= f.total;
    }
    expect(() => assertNativeMetricSourceCoverage(f.proof, f.expected)).toThrow(
      "native_metric_completion_receipt_mismatch",
    );
  });
  it("requires every post clock to be past the full source endpoint", () => {
    const f = fixture();
    f.proof.after.frames[0]![4] = f.origin + f.total - 1;
    f.proof.after.frames[0]![6] = f.origin + f.total - 1;
    expect(() =>
      assertNativeMetricSourceCoverage(f.proof, f.expected),
    ).toThrow();
  });
  it("keeps shared transport regressions and strict phase/alignment failures fatal", () => {
    const f = fixture({ strict: true, shift: 64 });
    expect(() => assertNativeMetricSourceCoverage(f.proof, f.expected)).toThrow(
      "listening_alignment_budget_exceeded",
    );
    const stopped = fixture();
    stopped.proof.timingWitnesses.maxPhaseDisagreement = stopped.row(
      stopped.origin + 1_000,
      false,
    );
    expect(() =>
      assertNativeMetricSourceCoverage(stopped.proof, stopped.expected),
    ).toThrow();
    const phase = fixture({ strict: true });
    phase.proof.timingWitnesses.maxPhaseDisagreement = [
      ...phase.proof.launched.clock,
    ];
    phase.proof.timingWitnesses.maxPhaseDisagreement[5] += 0.1;
    expect(() =>
      assertNativeMetricSourceCoverage(phase.proof, phase.expected),
    ).toThrow();
  });
  it("keeps native counter limits and all fixed receipt/launch/post deadlines", () => {
    const f = fixture();
    const arm = structuredClone(f.proof.armed);
    arm.receipt.elapsedMs = 1001;
    expect(nativeMetricArmProofSchema.safeParse(arm).success).toBe(false);
    f.proof.launched.elapsedMs = 10001;
    expect(
      nativeMetricLaunchProofSchema.safeParse(f.proof.launched).success,
    ).toBe(false);
    f.proof.postElapsedMs = 2001;
    expect(
      nativeMetricSourceCoverageProofSchema.safeParse(f.proof).success,
    ).toBe(false);
    arm.receipt.elapsedMs = 20;
    arm.receipt.timing[5] = 2 ** 44 - 1;
    arm.receipt.confirmedTiming[5] = 2 ** 44 - 1;
    expect(nativeMetricArmProofSchema.safeParse(arm).success).toBe(false);
  });
  it("requires the actual Gen ten-second arm/report/vector counter headroom, not only the requested duration", () => {
    const f = fixture();
    const armed = f.proof.armed;
    const arm = 2 ** 44 - f.total - armed.config.geometry.vectorSize - 1;
    const delta = arm - armed.receipt.timing[5];
    armed.receipt.timing[5] = arm;
    armed.receipt.confirmedTiming[5] = arm;
    for (const row of armed.before.frames)
      for (const index of [2, 4, 6, 9] as const) row[index] += delta;
    expect(nativeMetricArmProofSchema.safeParse(armed).success).toBe(false);
  });
});

describe("frozen metric configuration and expected ownership", () => {
  it("requires explicit admitted attack settings instead of implicit detector defaults", () => {
    const config = structuredClone(fixture().proof.armed.config);
    Reflect.deleteProperty(config, "attacks");
    expect(nativeMetricListeningConfigSchema.safeParse(config).success).toBe(
      false,
    );
    Reflect.set(config, "attacks", { thresholdDb: 6, minSpacingSamples: 4800 });
    expect(nativeMetricListeningConfigSchema.safeParse(config).success).toBe(
      true,
    );
  });
  it.each([
    { thresholdDb: 0, minSpacingSamples: 0 },
    { thresholdDb: 120, minSpacingSamples: 2 ** 44 - 1 },
  ])(
    "admits explicit bounded Node settings %j without changing DSP fields",
    (settings) => {
      const f = fixture();
      const fields = [...f.proof.armed.receipt.fields];
      f.proof.armed.config.attacks = settings;
      Reflect.set(f.expected.config, "attacks", settings);
      expect(() =>
        assertNativeMetricArmProof(f.proof.armed, f.expected),
      ).not.toThrow();
      expect(f.proof.armed.receipt.fields).toEqual(fields);
    },
  );
  it.each([
    null,
    { thresholdDb: -1, minSpacingSamples: 0 },
    { thresholdDb: 121, minSpacingSamples: 0 },
    { thresholdDb: Number.NaN, minSpacingSamples: 0 },
    { thresholdDb: 6, minSpacingSamples: -1 },
    { thresholdDb: 6, minSpacingSamples: 0.5 },
    { thresholdDb: 6, minSpacingSamples: 2 ** 44 },
    { thresholdDb: 6, minSpacingSamples: 4800, windowSamples: 4800 },
  ])("rejects missing, invalid or DSP-shaped Node settings %j", (settings) => {
    const value = structuredClone(fixture().proof.armed.config);
    Reflect.set(value, "attacks", settings);
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("allows only absent/null attack settings when attacks are not requested", () => {
    const value = structuredClone(fixture().proof.armed.config);
    value.requestedMetrics = ["level"];
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      false,
    );
    value.attacks = null;
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      true,
    );
    Reflect.deleteProperty(value, "attacks");
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      true,
    );
  });
  it("deep freezes admitted attack settings and rejects post-admission context overrides", () => {
    const f = fixture();
    const expected = snapshotNativeMetricListeningExpectation(f.expected);
    expect(Object.isFrozen(expected.config.attacks)).toBe(true);
    f.expected.config.attacks!.thresholdDb = 99;
    expect(expected.config.attacks!.thresholdDb).toBe(6);
    f.proof.armed.config.attacks!.thresholdDb = 99;
    expect(() => assertNativeMetricArmProof(f.proof.armed, expected)).toThrow(
      "native_metric_owner_or_config_mismatch",
    );
  });
  it("reuses observation ownership exactly and binds every capture attribution field externally", () => {
    expect(nativeMetricOwnershipSchema).toBe(
      metricAudioObservationSchema.shape.ownership,
    );
    for (const field of [
      "listenerId",
      "passId",
      "connectionId",
      "connectionEpoch",
      "traceId",
      "correlationId",
      "causationId",
    ] as const) {
      const f = fixture();
      const expected = { ...f.expected };
      Reflect.set(
        expected,
        field,
        ["connectionId", "connectionEpoch", "traceId"].includes(field)
          ? "44444444-4444-4444-8444-444444444444"
          : `${expected[field]}-other`,
      );
      expect(() => assertNativeMetricArmProof(f.proof.armed, expected)).toThrow(
        "native_metric_owner_or_config_mismatch",
      );
    }
  });

  describe("final metric observation bound to frozen native admission", () => {
    it("accepts explicitly admitted nondefault detector settings, not hidden defaults", () => {
      const f = observationFixture();
      const settings = { thresholdDb: 0, minSpacingSamples: 0 };
      f.proof.armed.config.attacks = settings;
      Reflect.set(f.expected.config, "attacks", settings);
      Object.assign(f.observation.metrics.attacks.algorithm!, settings);
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).not.toThrow();
    });
    it("does not require a detector or its settings when attacks are not requested", () => {
      const f = observationFixture();
      f.proof.armed.config.requestedMetrics = ["level", "spectral-centroid"];
      f.proof.armed.config.attacks = null;
      Reflect.set(f.expected.config, "requestedMetrics", [
        "level",
        "spectral-centroid",
      ]);
      Reflect.set(f.expected.config, "attacks", null);
      f.observation.requestedMetrics = ["level", "spectral-centroid"];
      f.observation.metrics.attacks = {
        status: "not-requested",
        algorithm: null,
        records: [],
        expectedRecords: 0,
        gaps: [],
        limitations: [],
      };
      f.observation.rows = createMetricObservationReportRows(f.observation);
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).not.toThrow();
    });
    it("allows explicit attack acquisition failure without invalidating independently useful metrics", () => {
      const f = observationFixture();
      const attacks = f.observation.metrics.attacks;
      attacks.records = [];
      attacks.status = "failed";
      attacks.gaps = [
        {
          firstIndex: 0,
          count: attacks.expectedRecords,
          startSample: f.origin,
          endSample: f.origin + f.total,
          reason: "dependency-unavailable",
          detail: "Synthetic unavailable detector input; not physical evidence",
        },
      ];
      f.observation.outcome = "partial";
      f.observation.rows = createMetricObservationReportRows(f.observation);
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).not.toThrow();
    });
    it.each([44_100, 48_000] as const)(
      "retains genuine one-sample %iHz geometry with independent100ms detector configuration",
      (rate) => {
        const f = observationFixture({
          rate,
          total: 1,
          startBeat: 0,
          completedLaunch: true,
        });
        const result = assertNativeMetricObservationSource(
          f.proof,
          f.observation,
          f.expected,
        );
        expect(result.geometry.totalSamples).toBe(1);
        expect(result.metrics.attacks.algorithm!.windowSamples).toBe(rate / 10);
        expect(result.metrics.attacks.records[0]!.support).toEqual({
          startSample: f.origin,
          endSample: f.origin + 1,
        });
      },
    );
    it.each([44_100, 48_000] as const)(
      "accepts native %iHz FFT support crossing onset despite a negative host projection",
      (rate) => {
        const f = observationFixture({
          rate,
          vector: 1,
          startBeat: 0,
          armLead: 64,
          clockStep: 1,
          hostOffset: -199_904,
        });
        const spectral = f.observation.metrics["spectral-centroid"];
        for (const acquisition of f.proof.spectrumPhase!.acquisitions) {
          acquisition[1] += 1024;
          acquisition[2] += 1024;
          acquisition[3] += 1024;
        }
        spectral.algorithm!.firstFrameEndSample = f.origin + 1024;
        spectral.records = [];
        for (
          let end = f.origin + 1024;
          end <= f.origin + f.total;
          end += 2048
        ) {
          spectral.records.push({
            index: spectral.records.length,
            support: { startSample: end - 2048, endSample: end },
            spectralEnergy: 2,
            centroidHz: 500,
          });
        }
        spectral.expectedRecords = spectral.records.length;
        f.observation.rows = createMetricObservationReportRows(f.observation);
        const result = assertNativeMetricObservationSource(
          f.proof,
          f.observation,
          f.expected,
        );
        const first = result.metrics["spectral-centroid"].records[0]!.support;
        expect(first.startSample).toBe(198976);
        expect(first.endSample).toBe(201024);
        expect(first.startSample + f.offset).toBe(-928);
      },
    );
    it.each([44_100, 48_000] as const)(
      "binds complete and partial %iHz observations without requiring optional metric readiness",
      (rate) => {
        for (const partial of [false, true]) {
          const f = observationFixture({ rate }, partial);
          const result = assertNativeMetricObservationSource(
            f.proof,
            f.observation,
            f.expected,
          );
          expect(result).toEqual(f.observation);
          expect(result.geometry.startSample).toBe(f.origin);
          expect(Object.isFrozen(result.metrics.attacks.algorithm)).toBe(true);
          expect(Object.isFrozen(result.metrics.attacks.records)).toBe(true);
        }
      },
    );
    it.each(["thresholdDb", "minSpacingSamples"] as const)(
      "rejects a self-consistent final algorithm that overrides frozen %s",
      (field) => {
        const f = observationFixture();
        f.observation.metrics.attacks.algorithm![field]++;
        expect(
          metricAudioObservationSchema.safeParse(f.observation).success,
        ).toBe(true);
        expect(() =>
          assertNativeMetricObservationSource(
            f.proof,
            f.observation,
            f.expected,
          ),
        ).toThrow("native_metric_attack_configuration_mismatch");
      },
    );
    it("keeps a shared completion failure fatal even for a useful partial observation", () => {
      const f = observationFixture({}, true);
      f.proof.completion.timing[3] = 1;
      f.proof.completion.confirmedTiming[3] = 1;
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).toThrow("native_metric_completion_receipt_mismatch");
    });
    it("binds Session expected context without certifying physical clip identity", () => {
      const f = observationFixture({ session: true });
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).not.toThrow();
      if (f.observation.source.view !== "session") throw new Error("fixture");
      f.observation.source.target.sceneIndex++;
      expect(
        metricAudioObservationSchema.safeParse(f.observation).success,
      ).toBe(true);
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).toThrow("native_metric_observation_binding_mismatch");
    });
    it.each(["local", "host"] as const)(
      "rejects internally valid %s-domain observations instead of native counters",
      (domain) => {
        const f = observationFixture();
        const g = f.expected.config.geometry;
        const other = createSyntheticMetricListeningObservation({
          sampleRate: g.sampleRate,
          vectorSize: g.vectorSize,
          tempoBpm: g.tempoBpm,
          startBeat: g.startBeat,
          endBeat: g.endBeat,
          startSample: domain === "local" ? 0 : f.origin + f.offset,
        });
        other.ownership = f.observation.ownership;
        other.alignment = f.observation.alignment;
        expect(metricAudioObservationSchema.safeParse(other).success).toBe(
          true,
        );
        expect(() =>
          assertNativeMetricObservationSource(f.proof, other, f.expected),
        ).toThrow("native_metric_observation_binding_mismatch");
      },
    );
    it("binds all attribution, requested metrics and observed alignment to frozen admission", () => {
      for (const field of [
        "listenerId",
        "passId",
        "connectionId",
        "connectionEpoch",
        "generation",
        "nativeEpoch",
        "traceId",
        "correlationId",
        "causationId",
      ] as const) {
        const f = observationFixture();
        const value = f.observation.ownership[field];
        Reflect.set(
          f.observation.ownership,
          field,
          typeof value === "number"
            ? value + 1
            : [
                  "connectionId",
                  "connectionEpoch",
                  "generation",
                  "traceId",
                ].includes(field)
              ? "44444444-4444-4444-8444-444444444444"
              : `${value}-other`,
        );
        expect(
          metricAudioObservationSchema.safeParse(f.observation).success,
        ).toBe(true);
        expect(() =>
          assertNativeMetricObservationSource(
            f.proof,
            f.observation,
            f.expected,
          ),
        ).toThrow("native_metric_observation_binding_mismatch");
      }
      const f = observationFixture();
      f.observation.alignment.observedClockDisagreementSamples++;
      expect(() =>
        assertNativeMetricObservationSource(f.proof, f.observation, f.expected),
      ).toThrow("native_metric_observation_binding_mismatch");
      const unrequested = observationFixture();
      unrequested.observation.requestedMetrics = ["level", "attacks"];
      unrequested.observation.metrics["spectral-centroid"] = {
        status: "not-requested",
        algorithm: null,
        records: [],
        expectedRecords: 0,
        gaps: [],
        limitations: [],
      };
      unrequested.observation.rows = createMetricObservationReportRows(
        unrequested.observation,
      );
      expect(
        metricAudioObservationSchema.safeParse(unrequested.observation).success,
      ).toBe(true);
      expect(() =>
        assertNativeMetricObservationSource(
          unrequested.proof,
          unrequested.observation,
          unrequested.expected,
        ),
      ).toThrow("native_metric_observation_binding_mismatch");
    });
  });
  it("snapshots nested rows, requested metrics and Session expected target without reference aliasing", () => {
    const f = fixture({ session: true });
    const expected = snapshotNativeMetricListeningExpectation(f.expected);
    f.expected.config.requestedMetrics.push("level");
    expect(expected.config.requestedMetrics).toHaveLength(3);
    expect(Object.isFrozen(expected.config.geometry.rows[0])).toBe(true);
    expect(Object.isFrozen(expected.config.requestedMetrics)).toBe(true);
    if (expected.config.mode !== "session") throw new Error("fixture");
    expect(Object.isFrozen(expected.config.source.target.track)).toBe(true);
    expect(() =>
      expected.config.geometry.rows.push(expected.config.geometry.rows[0]!),
    ).toThrow();
  });
  it("uses the globally anchored clipped grid with independently rounded local samples", () => {
    const f = fixture({ startBeat: 5.13 });
    expect(f.proof.armed.config.geometry.rows[0]!.endBeat).toBe(5.25);
    const value = structuredClone(f.proof.armed.config);
    value.geometry.rows[0]!.endSample++;
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      false,
    );
    Reflect.set(value.grid, "anchor", "capture-start");
    expect(nativeMetricListeningConfigSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("rejects ownership/config changes and never treats Session expected identity as native source proof", () => {
    const f = fixture({ session: true });
    expect(() =>
      assertNativeMetricSourceCoverage(f.proof, f.expected),
    ).not.toThrow();
    const expected = structuredClone(f.expected);
    if (expected.config.mode !== "session") throw new Error("fixture");
    expected.config.source.target.sceneIndex++;
    expect(() => assertNativeMetricArmProof(f.proof.armed, expected)).toThrow(
      "native_metric_owner_or_config_mismatch",
    );
    Reflect.set(f.proof.armed.config, "sourceEvidence", "native-clip-identity");
    expect(nativeMetricArmProofSchema.safeParse(f.proof.armed).success).toBe(
      false,
    );
  });
  it("keeps Session stopped beat0 admission distinct from Arrangement", () => {
    expect(() => fixture({ session: true, startBeat: 5.13 })).toThrow();
    expect(() => fixture({ session: false, startBeat: 5.13 })).not.toThrow();
  });
  it("does not weaken the existing legacy source verifier or its100ms minimum", () => {
    const legacy = createSyntheticNativeListeningFixtureV2();
    const { armed, launched, after, timingWitnesses } = legacy.proof;
    expect(() =>
      assertNativeSourceCoverageV2(
        { armed, launched, after, timingWitnesses },
        {
          policy: armed.policy,
          geometry: armed.geometry,
          listenerId: legacy.observation.listenerId,
          passId: legacy.observation.passId,
        },
      ),
    ).not.toThrow();
    const changed = structuredClone(armed);
    changed.geometry.totalSamples = 1;
    expect(nativeArmProofV2Schema.safeParse(changed).success).toBe(false);
  });
});
