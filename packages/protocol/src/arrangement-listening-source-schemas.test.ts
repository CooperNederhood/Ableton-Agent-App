import { describe, expect, it } from "vitest";
import {
  inspectArrangementListeningSourceParamsSchema,
  inspectArrangementListeningSourceResultSchema,
} from "./arrangement-listening-source-schemas.js";
import { sessionPreflightInstrumentChainSchema } from "./session-listening-preflight-schemas.js";

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
  function midiResult() {
    const inventory = { devices: [], total: 0, offset: 0, limit: 8 };
    return {
      ...result,
      range: { startBeat: 4, endBeat: 8 },
      before: { ...state, currentBeat: 16 },
      after: { ...state, currentBeat: 16 },
      clips: [
        {
          ...clip,
          filePath: null,
          sampleRate: null,
          sampleLength: null,
          warped: null,
          gain: null,
          pitchCoarse: null,
          pitchFine: null,
          midi: {
            clip: {
              reference: clip.clipId,
              trackReference: params.track.expectedReference,
              trackIndex: params.track.index,
              name: clip.name,
              kind: "midi",
              startTime: 0,
              endTime: 16,
              length: 16,
              noteCount: 1,
              looping: true,
            },
            notes: [
              {
                pitch: 60,
                startTime: 1,
                duration: 0.25,
                velocity: 100,
                mute: false,
              },
            ],
            totalNotes: 1,
            offset: 0,
            limit: 2048,
            truncated: false,
          },
        },
      ],
      instrumentChain: { before: inventory, devices: [], after: inventory },
    };
  }

  it("retains complete loaded MIDI notes and stable chain evidence without clipping the requested subrange", () => {
    const midi = midiResult();
    expect(inspectArrangementListeningSourceResultSchema.parse(midi)).toEqual(
      midi,
    );
  });

  it("uses a bounded top-level Arrangement witness while deep Session admission still requires the rack tree", () => {
    const midi = midiResult();
    const device = {
      reference: "10000000-0000-4000-8000-000000000004",
      trackReference: params.track.expectedReference,
      trackIndex: params.track.index,
      index: 0,
      name: "Rack",
      className: "InstrumentGroupDevice",
      classDisplayName: "Instrument Rack",
      enabled: true,
      parameterCount: 0,
      canHaveChains: true,
      canHaveDrumPads: true,
    };
    const inventory = { devices: [device], total: 1, offset: 0, limit: 8 };
    const chain = {
      before: inventory,
      after: inventory,
      devices: [{ device, parameters: [], total: 0, offset: 0, limit: 256 }],
    };
    expect(
      inspectArrangementListeningSourceResultSchema.safeParse({
        ...midi,
        instrumentChain: chain,
      }).success,
    ).toBe(true);
    expect(sessionPreflightInstrumentChainSchema.safeParse(chain).success).toBe(
      false,
    );
    expect(
      inspectArrangementListeningSourceResultSchema.safeParse({
        ...midi,
        instrumentChain: { ...chain, devices: [] },
      }).success,
    ).toBe(false);
    expect(
      inspectArrangementListeningSourceResultSchema.safeParse({
        ...midi,
        instrumentChain: {
          ...chain,
          after: { ...inventory, devices: [{ ...device, enabled: false }] },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { truncated: true },
    { offset: 1 },
    { totalNotes: 2 },
    { notes: [] },
    {
      notes: Array.from({ length: 2049 }, () => ({
        pitch: 60,
        startTime: 0,
        duration: 1,
        velocity: 100,
        mute: false,
      })),
    },
    { clip: { ...midiResult().clips[0]!.midi.clip, kind: "audio" } },
    { clip: { ...midiResult().clips[0]!.midi.clip, startTime: 1 } },
    { clip: { ...midiResult().clips[0]!.midi.clip, trackIndex: 2 } },
    {
      clip: { ...midiResult().clips[0]!.midi.clip, reference: params.queryId },
    },
  ])("rejects incomplete or foreign loaded MIDI evidence %j", (change) => {
    const midi = midiResult();
    expect(
      inspectArrangementListeningSourceResultSchema.safeParse({
        ...midi,
        clips: [
          { ...midi.clips[0], midi: { ...midi.clips[0]!.midi, ...change } },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires MIDI chain evidence and refuses chain evidence on an audio-only result", () => {
    const midi = midiResult();
    expect(
      inspectArrangementListeningSourceResultSchema.safeParse({
        ...midi,
        instrumentChain: undefined,
      }).success,
    ).toBe(false);
    expect(
      inspectArrangementListeningSourceResultSchema.safeParse({
        ...result,
        instrumentChain: midi.instrumentChain,
      }).success,
    ).toBe(false);
  });

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
