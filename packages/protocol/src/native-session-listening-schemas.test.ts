import { describe, expect, it } from "vitest";
import {
  createSyntheticNativeListeningFixtureV2,
  createSyntheticNativeSessionListeningFixture,
} from "./testing.js";
import { nativeArmProofV2Schema } from "./native-listening-v2-schemas.js";
import {
  NATIVE_SESSION_LISTENER_SCOPE as scope,
  sessionNativeSourceSchema,
  nativeSessionListeningConfigSchema,
  nativeSessionArmProofSchema,
  assertNativeSessionArmProof,
  nativeSessionLaunchCoordinates,
  assertNativeSessionCaptureObservation,
  snapshotNativeSessionListeningExpectation,
} from "./native-session-listening-schemas.js";

export const source = sessionNativeSourceSchema.parse({
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
});
function fixture() {
  const f = createSyntheticNativeListeningFixtureV2();
  return {
    ...f,
    expected: {
      geometry: f.proof.armed.geometry,
      policy: f.proof.armed.policy,
      listenerId: f.observation.listenerId,
      passId: f.observation.passId,
      source,
    },
  };
}
describe("negotiated Session wrapper over unchanged transport ABI2", () => {
  it.each([44100, 48000] as const)(
    "builds explicitly synthetic negotiated Session fixtures at %s Hz without relabelling transport evidence",
    (sampleRate) => {
      const mutableSource = structuredClone(source);
      const f = createSyntheticNativeSessionListeningFixture({
        source: mutableSource,
        listenerId: "synthetic-session-listener",
        passId: "synthetic-session-pass",
        geometry: {
          sampleRate,
          vectorSize: 128,
          tempoBpm: 91,
          startBeat: 5.25,
          endBeat: 9.25,
        },
      });
      mutableSource.target.sceneIndex = 3;
      expect(f.expected.source.target.sceneIndex).toBe(0);
      expect(Object.isFrozen(f.expected.source.target.track)).toBe(true);
      expect(f.arm.scope).toBe(scope);
      expect(f.arm.transport.scope).toBe("arrangement-descriptive/v2");
      expect(f.proof.transport.armed).toEqual(f.arm.transport);
      expect(f.proof.transport.launched).toEqual(f.launch.transport);
      expect(f.observation.schema).toBe("audio-observation/v2");
      expect(f.observation.startSample).toBeGreaterThan(0);
      if (sampleRate === 44100)
        expect(f.observation.endBeat - f.observation.startBeat).toBeGreaterThan(
          4,
        );
      assertNativeSessionArmProof(f.arm, f.expected);
      nativeSessionLaunchCoordinates(f.arm, f.launch, f.expected);
      assertNativeSessionCaptureObservation(f.proof, f.observation, f.expected);
      const wrongContext = structuredClone(f.proof);
      wrongContext.source.target.sceneIndex += 1;
      expect(() =>
        assertNativeSessionCaptureObservation(
          wrongContext,
          f.observation,
          f.expected,
        ),
      ).toThrow(/context_mismatch/);
      const missingWindow = structuredClone(f.proof);
      missingWindow.transport.envelopeWindows.pop();
      expect(() =>
        assertNativeSessionCaptureObservation(
          missingWindow,
          f.observation,
          f.expected,
        ),
      ).toThrow();
      expect(() =>
        createSyntheticNativeSessionListeningFixture({
          source,
          endBeat: 5,
        }),
      ).toThrow(/four beats/);
    },
  );
  it("validates arm, first transport movement, windows and global-coordinate descriptors", () => {
    const f = fixture(),
      arm = { scope, source, transport: f.proof.armed };
    assertNativeSessionArmProof(arm, f.expected);
    nativeSessionLaunchCoordinates(
      arm,
      { scope, source, transport: f.proof.launched },
      f.expected,
    );
    assertNativeSessionCaptureObservation(
      { scope, source, transport: f.proof },
      f.observation,
      f.expected,
    );
    expect(nativeArmProofV2Schema.safeParse(arm).success).toBe(false);
    expect(nativeSessionArmProofSchema.safeParse(f.proof.armed).success).toBe(
      false,
    );
    expect(
      nativeSessionArmProofSchema.safeParse({
        ...arm,
        transport: { ...arm.transport, scope },
      }).success,
    ).toBe(false);
  });
  it("freezes cloned expected context and rejects source/geometry/policy substitution", () => {
    const f = fixture(),
      input = structuredClone(f.expected);
    const expected = snapshotNativeSessionListeningExpectation(input);
    input.source.target.sceneIndex = 2;
    expect(expected.source.target.sceneIndex).toBe(0);
    expect(Object.isFrozen(expected.source.target.track)).toBe(true);
    const arm = { scope, source, transport: f.proof.armed };
    expect(() =>
      assertNativeSessionArmProof({ ...arm, source: input.source }, expected),
    ).toThrow(/context_mismatch/);
    expect(() =>
      assertNativeSessionArmProof(arm, {
        ...expected,
        geometry: { ...expected.geometry, vectorSize: 128 },
      }),
    ).toThrow(/mismatch/);
    expect(() =>
      assertNativeSessionArmProof(arm, {
        ...expected,
        policy: { mode: "strict", maxClockDisagreementSamples: 0 },
      }),
    ).toThrow();
  });
  it("retains exact bounded target, four beat and existing DSP quotas", () => {
    const f = fixture(),
      config = {
        geometry: f.expected.geometry,
        timingPolicy: f.expected.policy,
        source,
      };
    nativeSessionListeningConfigSchema.parse(config);
    for (const changed of [
      { ...config, source: { ...source, authority: "native" } },
      {
        ...config,
        source: { ...source, target: { ...source.target, sceneIndex: 256 } },
      },
      { ...config, geometry: { ...config.geometry, startBeat: -1 } },
      {
        ...config,
        geometry: {
          ...config.geometry,
          endBeat: config.geometry.startBeat + 5,
        },
      },
      { ...config, geometry: { ...config.geometry, sampleRate: 96000 } },
      { ...config, geometry: { ...config.geometry, vectorSize: 65 } },
      { ...config, geometry: { ...config.geometry, hopSamples: 1 } },
    ])
      expect(
        nativeSessionListeningConfigSchema.safeParse(changed).success,
      ).toBe(false);
  });
  it("rejects metadata, host clock, launch and descriptor mismatches", () => {
    const f = fixture();
    for (const mutate of [
      (p: typeof f.proof) => {
        p.armed.before.dsp[1] = 44100;
      },
      (p: typeof f.proof) => {
        p.launched.nativeEpoch += 1;
      },
      (p: typeof f.proof) => {
        p.after.frames[0]![1] += 0.1;
      },
      (p: typeof f.proof) => {
        p.envelopeWindows[0]![0] += 1;
      },
      (p: typeof f.proof) => {
        p.spectralWindows[0]![0] += 1;
      },
    ]) {
      const proof = structuredClone(f.proof);
      mutate(proof);
      expect(() =>
        assertNativeSessionCaptureObservation(
          { scope, source, transport: proof },
          f.observation,
          f.expected,
        ),
      ).toThrow();
    }
  });
});
