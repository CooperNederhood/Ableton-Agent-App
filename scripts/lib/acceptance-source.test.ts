import { describe, expect, it } from "vitest";
import { liveSetSnapshotSchema } from "../../apps/desktop/src/contracts.js";
import {
  resolveSessionSource,
  sessionStructureFingerprint,
  unrelatedPlaybackFingerprint,
  sourceStoppedAtZero,
  sourceStoppedAtPosition,
} from "../../tests/electron/acceptance-source.js";
import type { InspectSessionListeningSourceResult } from "@ableton-agent/protocol";

function snapshot() {
  return liveSetSnapshotSchema.parse({
    liveSetId: "set-1",
    liveSetName: "Project",
    tempo: 120,
    timeSignature: "4/4",
    tracks: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Source 1",
        kind: "audio",
        index: 0,
        color: "#fff",
        volume: 0.8,
        pan: 0,
        muted: false,
        clips: [],
        devices: [],
      },
    ],
    sessionClips: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        trackId: "00000000-0000-4000-8000-000000000001",
        trackIndex: 0,
        sceneIndex: 0,
        name: "Clip 1",
        kind: "audio",
        lengthBeats: 4,
        noteCount: null,
        status: "stopped",
      },
    ],
  });
}
const selector = { trackName: "Source 1", sceneIndex: 0, clipName: "Clip 1" };

describe("independent Desktop source evidence", () => {
  it("accepts both Live stopped-slot sentinels and requires both observation brackets", () => {
    const state: InspectSessionListeningSourceResult["after"] = {
      transportPlaying: false,
      globalBeat: 0,
      targetPlaying: false,
      targetTriggered: false,
      targetRecording: false,
      playingSlotIndex: -2,
      firedSlotIndex: -1,
      selectedClipReference: null,
      startTimeBeats: null,
      playingPosition: null,
    };
    for (const playingSlotIndex of [-2, -1]) {
      const stopped = { ...state, playingSlotIndex };
      expect(sourceStoppedAtZero({ before: stopped, after: stopped })).toBe(
        true,
      );
      const offset = { ...stopped, globalBeat: 5.5 };
      expect(
        sourceStoppedAtPosition({ before: offset, after: offset }, 5.5),
      ).toBe(true);
      expect(sourceStoppedAtZero({ before: offset, after: offset })).toBe(
        false,
      );
      for (const expected of [0, -1, 1_576_801, Infinity, NaN])
        expect(
          sourceStoppedAtPosition({ before: offset, after: offset }, expected),
        ).toBe(false);
      for (const bracket of ["before", "after"])
        expect(
          sourceStoppedAtPosition(
            {
              before: offset,
              after: offset,
              [bracket]: { ...offset, globalBeat: 5.5001 },
            },
            5.5,
          ),
        ).toBe(false);
    }
    for (const patch of [
      { transportPlaying: true },
      { globalBeat: 1 },
      { targetPlaying: true },
      { targetTriggered: true },
      { targetRecording: true },
      { playingSlotIndex: 0 },
      { playingSlotIndex: null },
      { playingSlotIndex: -3 },
      { playingSlotIndex: -1.5 },
      { firedSlotIndex: -2 },
      { firedSlotIndex: 0 },
      { firedSlotIndex: null },
      { targetRecording: null },
      { targetTriggered: null },
      { targetPlaying: null },
      { transportPlaying: null },
      { globalBeat: null },
    ])
      for (const bracket of ["before", "after"])
        expect(
          sourceStoppedAtZero({
            before: state,
            after: state,
            [bracket]: { ...state, ...patch },
          }),
        ).toBe(false);
  });
  it("allows only the declared source playback, not unrelated launches", () => {
    const before = snapshot(),
      after = snapshot();
    const sourceId = before.sessionClips![0]!.id;
    after.sessionClips![0]!.status = "playing";
    expect(unrelatedPlaybackFingerprint(before, [sourceId])).toBe(
      unrelatedPlaybackFingerprint(after, [sourceId]),
    );
    before.sessionClips!.push({
      ...before.sessionClips![0]!,
      id: "another-clip",
      sceneIndex: 1,
    });
    after.sessionClips!.push({ ...before.sessionClips![1]!, status: "queued" });
    expect(unrelatedPlaybackFingerprint(before, [sourceId])).not.toBe(
      unrelatedPlaybackFingerprint(after, [sourceId]),
    );
  });
  it("binds the reviewed selector to actual host references", () => {
    const state = snapshot();
    expect(resolveSessionSource(state, selector).target).toMatchObject({
      expectedClipReference: state.sessionClips![0]!.id,
      track: { expectedReference: state.tracks[0]!.id, index: 0 },
    });
  });
  it("selects only the explicitly declared MIDI track, clip kind and index", () => {
    const state = snapshot();
    state.tracks[0]!.kind = "midi";
    state.sessionClips![0]!.kind = "midi";
    const midi = { ...selector, kind: "midi" as const, trackIndex: 0 };
    expect(resolveSessionSource(state, midi).target.track.index).toBe(0);
    expect(() => resolveSessionSource(state, selector)).toThrow();
    expect(() =>
      resolveSessionSource(state, { ...midi, trackIndex: 1 }),
    ).toThrow();
    state.sessionClips![0]!.kind = "audio";
    expect(() => resolveSessionSource(state, midi)).toThrow();
  });
  it("admits a stable remembered target slot only when explicitly selected and stopped", () => {
    const state: InspectSessionListeningSourceResult["after"] = {
      transportPlaying: false,
      globalBeat: 5.5,
      targetPlaying: true,
      targetTriggered: false,
      targetRecording: false,
      playingSlotIndex: 1,
      firedSlotIndex: -1,
      selectedClipReference: null,
      startTimeBeats: 0,
      playingPosition: 0,
    };
    expect(
      sourceStoppedAtPosition({ before: state, after: state }, 5.5, 1),
    ).toBe(true);
    expect(sourceStoppedAtPosition({ before: state, after: state }, 5.5)).toBe(
      false,
    );
    const inactive = { ...state, targetPlaying: false, playingSlotIndex: -1 };
    expect(
      sourceStoppedAtPosition({ before: inactive, after: inactive }, 5.5, 1),
    ).toBe(false);
    for (const patch of [
      { transportPlaying: true },
      { targetTriggered: true },
      { targetRecording: true },
      { firedSlotIndex: 1 },
      { playingSlotIndex: 0 },
      { targetPlaying: false },
    ])
      expect(
        sourceStoppedAtPosition(
          { before: state, after: { ...state, ...patch } },
          5.5,
          1,
        ),
      ).toBe(false);
  });
  it("rejects ambiguous, missing and truncated evidence", () => {
    const state = snapshot();
    state.tracks.push({ ...state.tracks[0]! });
    expect(() => resolveSessionSource(state, selector)).toThrow("exactly one");
    const missing = snapshot();
    missing.sessionClips = [];
    expect(() => resolveSessionSource(missing, selector)).toThrow(
      "exactly one",
    );
    const truncated = snapshot();
    truncated.completeness = {
      truncatedDomains: ["session_clips"],
      unsupportedDomains: [],
    };
    expect(() => resolveSessionSource(truncated, selector)).toThrow(
      "truncated",
    );
  });
  it("permits playback status changes but detects content and mixer mutations", () => {
    const before = snapshot();
    const after = snapshot();
    after.sessionClips![0]!.status = "playing";
    after.capturedAt = new Date().toISOString();
    expect(sessionStructureFingerprint(after)).toBe(
      sessionStructureFingerprint(before),
    );
    after.sessionClips![0]!.lengthBeats = 8;
    expect(sessionStructureFingerprint(after)).not.toBe(
      sessionStructureFingerprint(before),
    );
    const mixer = snapshot();
    mixer.tracks[0]!.volume = 0;
    expect(sessionStructureFingerprint(mixer)).not.toBe(
      sessionStructureFingerprint(before),
    );
  });
});
