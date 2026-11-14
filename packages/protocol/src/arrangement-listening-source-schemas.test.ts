import { describe, expect, it } from "vitest";
import {
  inspectArrangementListeningSourceParamsSchema,
  inspectArrangementListeningSourceResultSchema,
} from "./arrangement-listening-source-schemas.js";

const params = {
  schemaVersion: 1,
  queryId: "10000000-0000-4000-8000-000000000001",
  track: {
    kind: "regular",
    index: 1,
    expectedReference: "10000000-0000-4000-8000-000000000002",
    expectedName: "Track",
  },
  range: { startBeat: 0, endBeat: 384 },
};
const state = {
  transportPlaying: false,
  currentBeat: 72,
  tempoBpm: 128,
  loopEnabled: false,
  arrangementRecord: false,
  sessionRecord: false,
  overdub: false,
  sessionAutomationRecord: false,
  globalBackToArrangement: false,
  targetArmed: true,
  targetMonitoring: 2,
  arrangementEligible: true,
  playingSessionClips: 0,
  queuedSessionClips: 0,
};
const clip = {
  clipId: "10000000-0000-4000-8000-000000000003",
  name: "Source",
  startBeat: 0,
  endBeat: 16,
  filePath: "/owned/source.aif",
  sampleRate: 48000,
  sampleLength: 360000,
  recording: false,
  warped: true,
  startMarker: 0,
  endMarker: 16,
  loopStart: 0,
  loopEnd: 16,
  looping: true,
  gain: 1,
  pitchCoarse: 0,
  pitchFine: 0,
};
const result = {
  ...params,
  projectRevision: 1,
  evidence: "message-rate-only",
  projectPath: "/owned/prepared.als",
  before: state,
  after: state,
  clips: [clip],
};
describe("bounded independent Arrangement read contract", () => {
  it("preserves exact source identity/range and loaded unavailable evidence", () => {
    expect(inspectArrangementListeningSourceParamsSchema.parse(params)).toEqual(
      params,
    );
    expect(inspectArrangementListeningSourceResultSchema.parse(result)).toEqual(
      result,
    );
    expect(
      inspectArrangementListeningSourceResultSchema.parse({
        ...result,
        before: { ...state, sessionRecord: null },
      }).before.sessionRecord,
    ).toBeNull();
  });
  it.each([
    { ...params, range: { startBeat: 16, endBeat: 0 } },
    { ...params, track: { ...params.track, kind: "return" } },
    { ...params, mutation: true },
  ])("rejects malformed or out-of-scope requests", (input) => {
    expect(
      inspectArrangementListeningSourceParamsSchema.safeParse(input).success,
    ).toBe(false);
  });
  it.each([
    { ...result, clips: [clip, clip] },
    { ...result, clips: Array.from({ length: 257 }, () => clip) },
    { ...result, clips: [{ ...clip, endBeat: 0 }] },
    { ...result, before: { ...state, targetMonitoring: 3 } },
    { ...result, evidence: "sample-accurate" },
  ])(
    "rejects duplicate/truncated/nonfinite/certified source inventories",
    (input) => {
      expect(
        inspectArrangementListeningSourceResultSchema.safeParse(input).success,
      ).toBe(false);
    },
  );
});
