import { describe, expect, it } from "vitest";
import {
  inspectSessionListeningSourceParamsSchema,
  inspectSessionListeningSourceResultSchema,
} from "./session-listening-source-schemas.js";

const target = {
  view: "session",
  track: {
    kind: "regular",
    index: 0,
    expectedReference: "10000000-0000-4000-8000-000000000001",
    expectedName: "Track",
  },
  sceneIndex: 0,
  expectedClipReference: "10000000-0000-4000-8000-000000000002",
  expectedClipName: "Source",
};
const params = {
  schemaVersion: 1,
  queryId: "10000000-0000-4000-8000-000000000003",
  target,
};
const state = {
  transportPlaying: false,
  globalBeat: 12,
  startTimeBeats: -4,
  playingPosition: 0,
  targetPlaying: false,
  targetTriggered: true,
  targetRecording: false,
  playingSlotIndex: -1,
  firedSlotIndex: 0,
  selectedClipReference: null,
};
const settings = {
  tempoBpm: 120,
  signatureNumerator: 4,
  signatureDenominator: 4,
  globalQuantization: 4,
  launchQuantization: 0,
  launchMode: 0,
  legato: false,
  followActionEnabled: null,
  startMarker: 0,
  endMarker: 8,
  loopStart: 0,
  loopEnd: 8,
  looping: true,
};
const result = {
  ...params,
  projectRevision: 0,
  evidence: "message-rate-only",
  nativeAlignment: "unverified",
  sourceKind: "midi",
  positionUnit: "beats",
  before: state,
  after: state,
  settings,
};

describe("Session listening source inspection", () => {
  it("accepts historical signed origins without granting launch authority", () => {
    expect(inspectSessionListeningSourceParamsSchema.parse(params)).toEqual(
      params,
    );
    expect(inspectSessionListeningSourceResultSchema.parse(result)).toEqual(
      result,
    );
    for (const change of [
      { evidence: "sample-accurate" },
      { nativeAlignment: "verified" },
      { sourceKind: "unwarped-audio", positionUnit: "beats" },
      { sourceKind: "unknown", positionUnit: "seconds" },
      { ready: true },
      { after: { ...state, playingPosition: Infinity } },
      { settings: { ...settings, globalQuantization: 999 } },
    ]) {
      expect(
        inspectSessionListeningSourceResultSchema.safeParse({
          ...result,
          ...change,
        }).success,
      ).toBe(false);
    }
  });

  it("retains unknown metadata and seconds units explicitly", () => {
    expect(
      inspectSessionListeningSourceResultSchema.parse({
        ...result,
        sourceKind: "unwarped-audio",
        positionUnit: "seconds",
        settings: Object.fromEntries(
          Object.keys(settings).map((key) => [key, null]),
        ),
      }).positionUnit,
    ).toBe("seconds");
  });

  it("rejects unbounded selectors and mutation parameters", () => {
    for (const change of [
      { fire: true },
      { queryId: "stale" },
      { target: { ...target, sceneIndex: 256 } },
      { target: { ...target, track: { ...target.track, index: 256 } } },
    ]) {
      expect(
        inspectSessionListeningSourceParamsSchema.safeParse({
          ...params,
          ...change,
        }).success,
      ).toBe(false);
    }
  });
});
