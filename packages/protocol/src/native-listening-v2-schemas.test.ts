import { describe, expect, it } from "vitest";
import {
  audioObservationV2Schema,
  type AudioObservationV2,
} from "./audio-observation-schemas.js";
import {
  createNativeListeningGeometry,
  nativeListeningGeometrySchema,
} from "./native-listening-geometry.js";
import {
  assertNativeCaptureObservationV2,
  nativeArmProofV2Schema,
  nativeCaptureProofV2Schema,
  nativeLaunchCoordinatesV2,
  nativeListenerLifecycleV2Schema,
  snapshotNativeListeningExpectationV2,
  NATIVE_LISTENER_SCOPE_V2,
} from "./native-listening-v2-schemas.js";
import {
  nativeArmProofSchema,
  NATIVE_LISTENER_SCOPE,
} from "./native-listening-schemas.js";
import {
  evaluateListeningAlignment,
  type ListeningTimingPolicy,
} from "./listening-timing-schemas.js";

function fixture(
  options: {
    sampleRate?: 44_100 | 48_000;
    totalSamples?: number;
    shift?: number;
    strict?: boolean;
    silence?: boolean;
    limit?: number;
  } = {},
) {
  const rate = options.sampleRate ?? 48_000;
  const requestedSamples = options.totalSamples ?? rate;
  const geometry = createNativeListeningGeometry({
    sampleRate: rate,
    vectorSize: 64,
    tempoBpm: 93,
    startBeat: 5.25,
    endBeat: 5.25 + ((requestedSamples / rate) * 93) / 60,
  });
  const policy: ListeningTimingPolicy = options.strict
    ? { mode: "strict", maxClockDisagreementSamples: 0 }
    : { mode: "descriptive", maxClockDisagreementSamples: options.limit ?? 64 };
  const expected = {
    policy,
    geometry,
    listenerId: "listener-v2",
    passId: "pass-v2",
  };
  const origin = 200_000;
  const armCounter = origin - 1_000;
  const offset = 800_000;
  const startSample = origin + offset;
  const samplesPerBeat = (rate * 60) / 93;
  const shift = options.shift ?? 0;
  const row = (counter: number, playing: boolean, delta = 0) => {
    const sample = counter + offset + delta;
    const beat = playing ? 5.25 + (counter - origin) / samplesPerBeat : 5.25;
    return [
      Number(playing),
      beat,
      sample,
      31,
      counter,
      playing ? beat % 1 : 0.75,
      counter,
      Number(playing),
      beat,
      sample,
      31,
    ];
  };
  const before = Array.from({ length: 32 }, (_, index) =>
    row(armCounter - (32 - index) * 512, false),
  );
  const after = Array.from({ length: 32 }, (_, index) =>
    row(origin + requestedSamples + 64 + index * 512, true, shift),
  );
  const launch = row(origin + 64, true);
  const clockRows = [...before, ...after, launch];
  const playingRows = [...after, launch];
  const hostOffset = (value: number[]) => value[2]! - value[4]!;
  const beatOrigin = (value: number[]) =>
    value[2]! - Math.round((value[1]! - 5.25) * samplesPerBeat);
  const extremum = (
    rows: number[][],
    measure: (value: number[]) => number,
    maximum: boolean,
  ) =>
    rows.reduce((best, current) =>
      (
        maximum
          ? measure(current) > measure(best)
          : measure(current) < measure(best)
      )
        ? current
        : best,
    );
  const windows = Math.ceil(requestedSamples / geometry.hopSamples);
  const rawRms = options.silence ? 0 : 0.25;
  const rawPeak = options.silence ? 0 : 0.5;
  const db = options.silence ? null : 20 * Math.log10(rawRms);
  const envelopes = Array.from({ length: windows }, (_, index) => [
    origin + Math.min((index + 1) * geometry.hopSamples, requestedSamples),
    rawPeak,
    rawPeak,
    rawRms,
    rawRms,
  ]);
  let previousSpectrum: number[] | undefined;
  const spectra = envelopes.map((envelope, index) => {
    const end = Math.floor(envelope[0]! / 2048) * 2048 + offset;
    const spectrum =
      previousSpectrum?.[1] === end
        ? [...previousSpectrum]
        : [
            end - 2048,
            end,
            options.silence ? 0 : 440 + index,
            options.silence ? 0 : index + 1,
          ];
    previousSpectrum = spectrum;
    return spectrum;
  });
  let energy = 0;
  let centroid = 0;
  for (const [index, spectrum] of spectra.entries()) {
    const count = Math.min(
      geometry.hopSamples,
      requestedSamples - index * geometry.hopSamples,
    );
    const weighted = (spectrum[3]! * count) / geometry.hopSamples;
    energy += weighted;
    centroid += spectrum[2]! * weighted;
  }
  const proof = nativeCaptureProofV2Schema.parse({
    armed: {
      scope: NATIVE_LISTENER_SCOPE_V2,
      policy,
      geometry,
      nativeEpoch: 1,
      armCounter,
      before: { dsp: [1, rate, 64], frames: before },
      reset: {
        launchClock: -1,
        sourceClock: -1,
        onsetCount: 0,
        rejected: 0,
        active: 0,
        launchPhaseSamples: -1,
        firstSourceClock: -1,
        completedSamples: 0,
      },
    },
    launched: {
      nativeEpoch: 1,
      armCounter,
      launchClock: 1_064,
      launchPhaseSamples: 64,
      rejected: 0,
      active: 1,
      host: { sample: launch[2], beat: launch[1], flags: 31, playing: true },
    },
    after: { dsp: [1, rate, 64], frames: after },
    timingWitnesses: {
      minHostOffset: extremum(clockRows, hostOffset, false),
      maxHostOffset: extremum(clockRows, hostOffset, true),
      minBeatOrigin: extremum(playingRows, beatOrigin, false),
      maxBeatOrigin: extremum(playingRows, beatOrigin, true),
    },
    envelopeRms: envelopes.map((value) => value.slice(3)),
    spectralWindows: spectra,
  });
  const observation: AudioObservationV2 = audioObservationV2Schema.parse({
    schema: "audio-observation/v2",
    listenerId: expected.listenerId,
    passId: expected.passId,
    sampleRate: rate,
    startSample,
    endSample: startSample + requestedSamples,
    startBeat: 5.25,
    endBeat: 5.25 + requestedSamples / samplesPerBeat,
    complete: true,
    limitations: ["Synthetic contract fixture, not actual native execution."],
    algorithm: {
      name: "native-max-stereo-energy-envelope-rise",
      version: "2.0.0",
      windowSamples: 2048,
      hopSamples: geometry.hopSamples,
      settings: {
        attackThresholdDb: 6,
        minAttackSpacingSamples: geometry.hopSamples,
      },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
    },
    alignment: evaluateListeningAlignment(policy, {
      sampleRate: rate,
      vectorSize: 64,
      observedClockDisagreementSamples: Math.min(
        shift,
        policy.maxClockDisagreementSamples,
      ),
      observedBeatDisagreementSamples: Math.min(
        shift,
        policy.maxClockDisagreementSamples,
      ),
    }),
    summaries: {
      peak: [rawPeak, rawPeak],
      rmsDbfs: [db, db],
      centroidHz: energy ? centroid / energy : null,
    },
    samples: envelopes.map((envelope, index) => ({
      sample: envelope[0]! + offset,
      beat: 5.25 + (envelope[0]! - origin) / samplesPerBeat,
      peak: [rawPeak, rawPeak],
      rmsDbfs: [db, db],
      centroidHz: options.silence ? null : spectra[index]![2],
    })),
    attacks:
      db === null
        ? []
        : [
            {
              sample: envelopes[0]![0]! + offset,
              beat: 5.25 + (envelopes[0]![0]! - origin) / samplesPerBeat,
              strength: db + 120,
            },
          ],
    reduction: {
      originalSamples: windows,
      originalAttacks: db === null ? 0 : 1,
      truncated: false,
    },
  });
  return { proof, observation, expected };
}

describe("versioned native geometry and independent descriptive validation", () => {
  it.each(["sample", "flags", "phase"] as const)(
    "rejects changed-held %s clocks even when alignment fits the budget",
    (field) => {
      const value = fixture();
      const held = structuredClone(value.proof.armed.before.frames[0]!);
      if (field === "sample") {
        held[2] += 1;
        held[9] += 1;
        value.observation.alignment.observedClockDisagreementSamples = 1;
      } else if (field === "flags") {
        held[3] = 19;
        held[10] = 19;
      } else {
        held[5] = 0.5;
      }
      value.proof.timingWitnesses.maxHostOffset = held;
      expect(() =>
        assertNativeCaptureObservationV2(
          value.proof,
          value.observation,
          value.expected,
        ),
      ).toThrow("native_v2_changed_clock_hold");
    },
  );

  it("rejects a retained stop after playback despite zero disagreement", () => {
    const value = fixture();
    const stopped = structuredClone(value.proof.after.frames[0]!);
    for (const index of [2, 4, 6, 9] as const) stopped[index] += 1;
    stopped[0] = stopped[7] = 0;
    stopped[1] = stopped[8] = value.expected.geometry.startBeat;
    stopped[5] = 0.75;
    value.proof.timingWitnesses.minHostOffset = stopped;
    expect(() =>
      assertNativeCaptureObservationV2(
        value.proof,
        value.observation,
        value.expected,
      ),
    ).toThrow("native_v2_transport_regression");
  });

  it("does not soften changed-held FFT data when a final1-sample interval reuses its spectrum", () => {
    const value = fixture({ totalSamples: 4_801 });
    expect(value.proof.spectralWindows[0]!.slice(0, 2)).toEqual(
      value.proof.spectralWindows[1]!.slice(0, 2),
    );
    value.proof.spectralWindows[1]![2] = 441;
    value.observation.samples[1]!.centroidHz = 441;
    const firstEnergy = value.proof.spectralWindows[0]![3];
    const lastEnergy = value.proof.spectralWindows[1]![3] / 4_800;
    value.observation.summaries.centroidHz =
      (440 * firstEnergy + 441 * lastEnergy) / (firstEnergy + lastEnergy);
    expect(() =>
      assertNativeCaptureObservationV2(
        value.proof,
        value.observation,
        value.expected,
      ),
    ).toThrow("native_v2_changed_spectral_hold");
  });

  it.each([
    [
      [0, 0, 1066432, 31, 1066432, 0, 1066432, 0, 0, 1066432, 31],
      [0, 0, 1066944, 31, 1066880, 0, 1066880, 0, 0, 1066944, 31],
    ],
    [
      [0, 0, 947647, 31, 947648, 0, 947648, 0, 0, 947647, 31],
      [0, 0, 948160, 31, 948160, 0, 948160, 0, 0, 948160, 31],
    ],
  ])(
    "distinguishes descriptive arm policy from exact v1 for recorded stopped pairs%j",
    (previous, next) => {
      const value = fixture();
      const offset = previous[2]! - previous[4]!;
      const frames = Array.from({ length: 30 }, (_, index) => {
        const native = previous[4]! - (30 - index) * 512;
        const host = native + offset;
        return [0, 0, host, 31, native, 0, native, 0, 0, host, 31];
      });
      frames.push(previous, next);
      const armed = {
        ...value.proof.armed,
        armCounter: next[4]! + 512,
        geometry: createNativeListeningGeometry({
          sampleRate: 48_000,
          vectorSize: 64,
          tempoBpm: 120,
          startBeat: 0,
          endBeat: 4,
        }),
        before: { dsp: [1, 48_000, 64], frames },
      };
      expect(nativeArmProofV2Schema.safeParse(armed).success).toBe(true);
      expect(
        nativeArmProofV2Schema.safeParse({
          ...armed,
          policy: { mode: "strict", maxClockDisagreementSamples: 0 },
        }).success,
      ).toBe(false);
      expect(
        nativeArmProofSchema.safeParse({
          scope: NATIVE_LISTENER_SCOPE,
          nativeEpoch: armed.nativeEpoch,
          armCounter: armed.armCounter,
          before: armed.before,
          reset: armed.reset,
        }).success,
      ).toBe(false);
      frames.at(-1)![9] = frames.at(-1)![9]! + 1;
      expect(
        nativeArmProofV2Schema.safeParse({
          ...armed,
          policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    "queued",
    "started",
    "progress",
    "completed",
    "failed",
    "cancelled",
  ] as const)(
    "defines bounded attributed native%s lifecycle including alignment evaluation",
    (stage) => {
      const event = {
        scope: NATIVE_LISTENER_SCOPE_V2,
        eventId: "00000000-0000-4000-8000-000000000001",
        causationId: "capture-parent",
        phase: "alignment",
        stage,
        nativeEpoch: 1,
        elapsedMs: 25,
        frames: 300,
        ...(["failed", "cancelled"].includes(stage) ? { reason: stage } : {}),
      };
      expect(nativeListenerLifecycleV2Schema.parse(event).stage).toBe(stage);
      expect(
        nativeListenerLifecycleV2Schema.safeParse({ ...event, frames: 301 })
          .success,
      ).toBe(false);
      expect(
        nativeListenerLifecycleV2Schema.safeParse({
          ...event,
          elapsedMs: Infinity,
        }).success,
      ).toBe(false);
      expect(
        nativeListenerLifecycleV2Schema.safeParse({ ...event, rawAudio: "PCM" })
          .success,
      ).toBe(false);
    },
  );

  it.each([44_100, 48_000] as const)(
    "covers exact30s and a1-sample final tail at%iHz and93BPM",
    (rate) => {
      for (const totalSamples of [
        Math.round(rate / 10),
        Math.round(rate / 10) + 1,
        rate * 30,
      ]) {
        const value = fixture({ sampleRate: rate, totalSamples });
        expect(value.expected.geometry.totalSamples).toBe(totalSamples);
        expect(() =>
          assertNativeCaptureObservationV2(
            value.proof,
            value.observation,
            value.expected,
          ),
        ).not.toThrow();
        expect(value.observation.samples.length).toBe(
          Math.ceil(totalSamples / value.expected.geometry.hopSamples),
        );
      }
    },
  );

  it.each([0, 1, 63, 64])(
    "accepts observed discrepancy%i without certifying an absolute bound",
    (shift) => {
      const value = fixture({ shift });
      expect(() =>
        assertNativeCaptureObservationV2(
          value.proof,
          value.observation,
          value.expected,
        ),
      ).not.toThrow();
      expect(
        value.observation.alignment.verifiedAbsoluteErrorBoundSamples,
      ).toBeNull();
    },
  );

  it("accepts silence without requiring a source attack", () => {
    const value = fixture({ silence: true, shift: 64 });
    expect(value.observation.attacks).toEqual([]);
    expect(() =>
      assertNativeCaptureObservationV2(
        value.proof,
        value.observation,
        value.expected,
      ),
    ).not.toThrow();
  });

  it("fails above budget and under strict policy instead of falling back", () => {
    for (const value of [
      fixture({ shift: 65 }),
      fixture({ strict: true, shift: 1 }),
    ]) {
      expect(() =>
        assertNativeCaptureObservationV2(
          value.proof,
          value.observation,
          value.expected,
        ),
      ).toThrow("listening_alignment_budget_exceeded");
    }
    const exact = fixture({ strict: true });
    expect(() =>
      assertNativeCaptureObservationV2(
        exact.proof,
        exact.observation,
        exact.expected,
      ),
    ).not.toThrow();
  });

  it.each([
    { sampleRate: 96_000 },
    { vectorSize: 63 },
    { vectorSize: 2048 },
    { tempoBpm: 0 },
    { startBeat: -1 },
    { endBeat: 5.25 },
    { endBeat: 5.25001 },
    { endBeat: 1000 },
    { hopSamples: 4801 },
    { totalSamples: 1 },
  ])("rejects invalid or inconsistent geometry%j", (change) => {
    expect(
      nativeListeningGeometrySchema.safeParse({
        ...fixture().expected.geometry,
        ...change,
      }).success,
    ).toBe(false);
  });

  it("does not let producer-selected policy or geometry override the App snapshot", () => {
    const value = fixture();
    expect(() =>
      assertNativeCaptureObservationV2(value.proof, value.observation, {
        ...value.expected,
        policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
      }),
    ).toThrow("native_v2_policy_or_geometry_mismatch");
    expect(() =>
      assertNativeCaptureObservationV2(value.proof, value.observation, {
        ...value.expected,
        geometry: { ...value.expected.geometry, vectorSize: 128 },
      }),
    ).toThrow("native_v2_policy_or_geometry_mismatch");
  });

  it("freezes a trusted per-pass expectation independently of subsequent preference changes", () => {
    const value = fixture();
    const snapshot = snapshotNativeListeningExpectationV2(value.expected);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
    expect(Object.isFrozen(snapshot.geometry)).toBe(true);
    value.expected.policy.maxClockDisagreementSamples = 480;
    expect(snapshot.policy.maxClockDisagreementSamples).toBe(64);
    expect(() =>
      assertNativeCaptureObservationV2(
        value.proof,
        value.observation,
        snapshot,
      ),
    ).not.toThrow();
  });

  it("uses the exact configured480-sample maximum without increasing it to admit481", () => {
    const accepted = fixture({ limit: 480, shift: 480 });
    expect(() =>
      assertNativeCaptureObservationV2(
        accepted.proof,
        accepted.observation,
        accepted.expected,
      ),
    ).not.toThrow();
    const denied = fixture({ limit: 480, shift: 481 });
    expect(() =>
      assertNativeCaptureObservationV2(
        denied.proof,
        denied.observation,
        denied.expected,
      ),
    ).toThrow("listening_alignment_budget_exceeded");
  });

  it.each([
    "epoch",
    "phase",
    "counter",
    "gap",
    "rms",
    "summary",
    "fft",
    "centroid",
    "quality",
    "attack",
    "identity",
    "witness",
    "torn",
    "missing-post",
    "stale-arm",
  ])("rejects%s corruption independently of the descriptive budget", (kind) => {
    const value = fixture();
    const { proof, observation, expected } = value;
    if (kind === "epoch") proof.launched.nativeEpoch++;
    if (kind === "phase") proof.launched.launchPhaseSamples = 65;
    if (kind === "counter") proof.launched.armCounter--;
    if (kind === "gap") observation.samples[1]!.sample++;
    if (kind === "rms") proof.envelopeRms[0]![0] = 0.6;
    if (kind === "summary") observation.summaries.rmsDbfs[0] = -3;
    if (kind === "fft") proof.spectralWindows[0]![1]++;
    if (kind === "centroid") observation.samples[0]!.centroidHz = 999;
    if (kind === "quality")
      observation.alignment.observedClockDisagreementSamples = 1;
    if (kind === "attack") observation.attacks[0]!.strength++;
    if (kind === "identity") observation.passId = "different-pass";
    if (kind === "witness") proof.timingWitnesses.minBeatOrigin[0] = 0;
    if (kind === "torn") proof.after.frames[0]![9]++;
    if (kind === "missing-post") proof.after.frames.pop();
    if (kind === "stale-arm") proof.armed.armCounter += 48_000;
    expect(() =>
      assertNativeCaptureObservationV2(proof, observation, expected),
    ).toThrow(/native_v2|native v2|invalid|too small|too big/i);
  });

  it("keeps legacy arm proofs separate from the new policy contract", () => {
    const value = fixture();
    const legacy = { ...value.proof.armed, scope: NATIVE_LISTENER_SCOPE };
    expect(nativeArmProofSchema.safeParse(legacy).success).toBe(false);
    expect(nativeArmProofV2Schema.safeParse(legacy).success).toBe(false);
    expect(
      nativeLaunchCoordinatesV2(
        value.proof.armed,
        value.proof.launched,
        value.expected,
      ).startSample,
    ).toBe(1_000_000);
  });
});
