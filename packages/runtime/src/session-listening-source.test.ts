import { describe, expect, it } from "vitest";
import {
  inspectSessionListeningSourceResultSchema,
  createNativeListeningGeometry,
} from "@ableton-agent/protocol";
import {
  freezeSessionSourceExpectation,
  assertSessionSourceUnchanged,
  assertTransportCoupledSessionOrigin,
  assertSessionFirstIterationCoverage,
} from "./session-listening-source.js";

const target = {
  view: "session" as const,
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: "00000000-0000-4000-8000-000000000001",
    expectedName: "Track",
  },
  sceneIndex: 0,
  expectedClipReference: "00000000-0000-4000-8000-000000000002",
  expectedClipName: "Clip",
};
function source() {
  const state = {
    transportPlaying: false,
    globalBeat: 0,
    startTimeBeats: -8,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: null,
  };
  return inspectSessionListeningSourceResultSchema.parse({
    schemaVersion: 1,
    queryId: "00000000-0000-4000-8000-000000000003",
    target,
    projectRevision: 1,
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    sourceKind: "midi",
    positionUnit: "beats",
    before: state,
    after: state,
    settings: {
      tempoBpm: 120,
      signatureNumerator: 4,
      signatureDenominator: 4,
      globalQuantization: 0,
      launchQuantization: 0,
      launchMode: 0,
      legato: false,
      followActionEnabled: null,
      startMarker: 0,
      endMarker: 8,
      loopStart: 0,
      loopEnd: 8,
      looping: true,
    },
  });
}
const origin = {
  clipReference: target.expectedClipReference,
  playingSlotIndex: 0,
  clipStartTimeBeats: 0,
  observedAtGlobalBeat: 0.2,
};

describe("Session source admission and independent transport join", () => {
  it.each(["midi", "warped-audio"] as const)(
    "freezes %s metadata without attributing historical start_time",
    (kind) => {
      const snapshot = source();
      snapshot.sourceKind = kind;
      const expected = freezeSessionSourceExpectation(snapshot, target, 4);
      expect(expected).toMatchObject({
        startBeat: 0,
        endBeat: 4,
        followActions: "unknown",
      });
      expect(expected.limitations.join(" ")).toContain("message-rate");
      snapshot.settings.loopEnd = 1;
      expect(expected.source.settings.loopEnd).toBe(8);
      expect(Object.isFrozen(expected.source.target.track)).toBe(true);
      expect(() =>
        assertTransportCoupledSessionOrigin(expected, origin),
      ).not.toThrow();
    },
  );

  it.each([
    { sourceKind: "unwarped-audio" as const, positionUnit: "seconds" as const },
    { sourceKind: "unknown" as const, positionUnit: null },
    { after: { ...source().after, transportPlaying: true } },
    { before: { ...source().before, firedSlotIndex: 0 } },
    { after: { ...source().after, targetTriggered: true } },
    { settings: { ...source().settings, launchQuantization: 5 } },
    { settings: { ...source().settings, globalQuantization: 8 } },
    { settings: { ...source().settings, launchMode: 1 } },
    { settings: { ...source().settings, legato: true } },
    { settings: { ...source().settings, followActionEnabled: true } },
    {
      settings: {
        ...source().settings,
        followActionEnabled: null,
        looping: null,
      },
    },
    { settings: { ...source().settings, loopStart: 1 } },
    { settings: { ...source().settings, startMarker: 1 } },
    { settings: { ...source().settings, loopEnd: 3 } },
    { settings: { ...source().settings, loopEnd: 4 } },
    { settings: { ...source().settings, tempoBpm: null } },
    { settings: { ...source().settings, signatureNumerator: 3 } },
    {
      before: { ...source().before, globalBeat: 12.2 },
      after: { ...source().after, globalBeat: 12.2 },
    },
    { after: { ...source().after, globalBeat: 16 } },
    { target: { ...target, expectedClipName: "Replacement" } },
  ])("refuses unsupported or unknown admission metadata: %j", (change) => {
    expect(() =>
      freezeSessionSourceExpectation({ ...source(), ...change }, target, 4),
    ).toThrow();
  });

  it.each([
    [0, 4],
    [4, 0],
    [12, 0],
    [0.25, 0],
    [12, 4],
    [12.25, 4],
  ])(
    "refuses the unqualified stopped anchor %s with global quantization %s",
    (globalBeat, globalQuantization) => {
      const snapshot = source();
      snapshot.before.globalBeat = snapshot.after.globalBeat = globalBeat;
      snapshot.settings.globalQuantization = globalQuantization;
      expect(() => freezeSessionSourceExpectation(snapshot, target, 4)).toThrow(
        "session_launch_case_unqualified",
      );
    },
  );

  it("retains known-disabled follow state for the qualified launch case", () => {
    const snapshot = source();
    snapshot.settings.followActionEnabled = false;
    expect(freezeSessionSourceExpectation(snapshot, target, 4)).toMatchObject({
      startBeat: 0,
      followActions: "disabled",
    });
  });

  it.each([true, false])(
    "rejects capture at either first-iteration boundary with looping=%s",
    (looping) => {
      for (const field of ["loopEnd", "endMarker"] as const) {
        const snapshot = source();
        snapshot.settings.looping = looping;
        snapshot.settings[field] = 4;
        expect(() =>
          freezeSessionSourceExpectation(snapshot, target, 4),
        ).toThrow("session_first_iteration_exceeded");
      }
    },
  );

  it.each([
    { clipReference: "other" },
    { playingSlotIndex: 1 },
    { clipStartTimeBeats: 16 },
    { clipStartTimeBeats: -4 },
    { observedAtGlobalBeat: 11 },
    { observedAtGlobalBeat: 20 },
  ])(
    "does not join another epoch or a delayed/wrapped origin: %j",
    (change) => {
      const expected = freezeSessionSourceExpectation(source(), target, 4);
      expect(() =>
        assertTransportCoupledSessionOrigin(expected, { ...origin, ...change }),
      ).toThrow();
    },
  );

  it("rechecks the settings/identity fingerprint without confusing dynamic launch changes with edits", () => {
    const expected = freezeSessionSourceExpectation(source(), target, 4);
    const latest = source();
    latest.after.transportPlaying = true;
    latest.after.globalBeat = 1;
    latest.after.startTimeBeats = 0;
    latest.after.targetPlaying = true;
    expect(() => assertSessionSourceUnchanged(expected, latest)).not.toThrow();
    latest.settings.loopEnd = 16;
    expect(() => assertSessionSourceUnchanged(expected, latest)).toThrow(
      "session_source_changed",
    );
  });

  it("rejects a rounded native span crossing the first loop instead of trimming it", () => {
    const snapshot = source();
    snapshot.settings.tempoBpm = 128;
    snapshot.settings.loopEnd = 4.00001;
    const expected = freezeSessionSourceExpectation(snapshot, target, 4);
    const geometry = createNativeListeningGeometry({
      sampleRate: 44100,
      vectorSize: 64,
      tempoBpm: 128,
      startBeat: 0,
      endBeat: 4,
    });
    expect(() =>
      assertSessionFirstIterationCoverage(expected, geometry),
    ).toThrow("session_first_iteration_exceeded");
    snapshot.settings.loopEnd = 8;
    expect(() =>
      assertSessionFirstIterationCoverage(
        freezeSessionSourceExpectation(snapshot, target, 4),
        geometry,
      ),
    ).not.toThrow();
  });
});
