import { describe, expect, it } from "vitest";
import { liveSetSnapshotSchema } from "../../apps/desktop/src/contracts.js";
import {
  resolveSessionSource,
  sessionStructureFingerprint,
  unrelatedPlaybackFingerprint,
} from "../../tests/electron/acceptance-source.js";

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
  it("allows only the declared source playback, not unrelated launches", () => {
    const before = snapshot(),
      after = snapshot();
    const sourceId = before.sessionClips![0]!.id;
    after.sessionClips![0]!.status = "playing";
    expect(unrelatedPlaybackFingerprint(before, sourceId)).toBe(
      unrelatedPlaybackFingerprint(after, sourceId),
    );
    before.sessionClips!.push({
      ...before.sessionClips![0]!,
      id: "another-clip",
      sceneIndex: 1,
    });
    after.sessionClips!.push({ ...before.sessionClips![1]!, status: "queued" });
    expect(unrelatedPlaybackFingerprint(before, sourceId)).not.toBe(
      unrelatedPlaybackFingerprint(after, sourceId),
    );
  });
  it("binds the reviewed selector to actual host references", () => {
    const state = snapshot();
    expect(resolveSessionSource(state, selector).target).toMatchObject({
      expectedClipReference: state.sessionClips![0]!.id,
      track: { expectedReference: state.tracks[0]!.id, index: 0 },
    });
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
