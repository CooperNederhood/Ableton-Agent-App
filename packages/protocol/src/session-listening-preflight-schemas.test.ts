import { describe, expect, it } from "vitest";
import { sessionListeningPreflightResultSchema } from "./session-listening-preflight-schemas.js";

function fixture() {
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
    expectedClipName: "Clip",
  };
  const state = {
    transportPlaying: false,
    globalBeat: 5.5,
    startTimeBeats: 0,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: null,
  };
  return {
    source: {
      schemaVersion: 1,
      queryId: "10000000-0000-4000-8000-000000000003",
      target,
      projectRevision: 0,
      evidence: "message-rate-only",
      nativeAlignment: "unverified",
      sourceKind: "midi",
      positionUnit: "beats",
      before: state,
      after: state,
      settings: {
        tempoBpm: 128,
        signatureNumerator: 4,
        signatureDenominator: 4,
        globalQuantization: 4,
        launchQuantization: 0,
        launchMode: 0,
        legato: false,
        followActionEnabled: false,
        startMarker: 0,
        endMarker: 4,
        loopStart: 0,
        loopEnd: 4,
        looping: true,
      },
    },
    midi: {
      clip: {
        reference: target.expectedClipReference,
        name: target.expectedClipName,
        trackReference: target.track.expectedReference,
        trackIndex: 0,
        sceneIndex: 0,
        length: 4,
        noteCount: 1,
      },
      notes: [
        { pitch: 69, startTime: 0, duration: 0.25, velocity: 100, mute: false },
      ],
      offset: 0,
      limit: 2048,
      totalNotes: 1,
      truncated: false,
    },
    instrumentChain: {
      before: { devices: [], total: 0, offset: 0, limit: 8 },
      devices: [],
      after: { devices: [], total: 0, offset: 0, limit: 8 },
    },
    recording: {
      action: "inspect",
      state: {
        arrangementRecord: false,
        sessionRecord: false,
        overdub: false,
        sessionAutomationRecord: false,
        punchIn: false,
        punchOut: false,
      },
    },
  };
}

describe("bounded Session listening preflight", () => {
  it("retains complete MIDI content without audio or native authority", () => {
    const value = fixture();
    expect(sessionListeningPreflightResultSchema.parse(value)).toEqual(value);
    const empty = fixture();
    empty.midi.notes = [];
    empty.midi.totalNotes = empty.midi.clip.noteCount = 0;
    expect(sessionListeningPreflightResultSchema.parse(empty)).toEqual(empty);
  });

  it.each([
    { reference: "10000000-0000-4000-8000-000000000099" },
    { trackReference: "10000000-0000-4000-8000-000000000099" },
    { trackIndex: 1 },
    { sceneIndex: 1 },
    { name: "Other" },
    { noteCount: 2 },
  ])("rejects foreign or inconsistent MIDI clip identity: %j", (patch) => {
    const value = fixture();
    value.midi.clip = { ...value.midi.clip, ...patch };
    expect(sessionListeningPreflightResultSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it.each([
    { offset: 1 },
    { truncated: true },
    { totalNotes: 2 },
    { notes: [] },
    { limit: 0 },
  ])("rejects incomplete or malformed MIDI evidence: %j", (patch) => {
    const value = fixture();
    expect(
      sessionListeningPreflightResultSchema.safeParse({
        ...value,
        midi: { ...value.midi, ...patch },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized content, wrong source kinds and invented authority", () => {
    const value = fixture();
    for (const change of [
      { midi: { ...value.midi, notes: Array(2049).fill(value.midi.notes[0]) } },
      { source: { ...value.source, sourceKind: "warped-audio" } },
      { source: { ...value.source, nativeAlignment: "verified" } },
      { recording: undefined },
      { audio: {} },
      { renderedAudioVerified: true },
    ])
      expect(
        sessionListeningPreflightResultSchema.safeParse({
          ...value,
          ...change,
        }).success,
      ).toBe(false);
  });

  it("requires a complete flat device chain, not a partial or changed inventory", () => {
    const value = fixture();
    const device = {
      reference: "10000000-0000-4000-8000-000000000004",
      trackReference: value.source.target.track.expectedReference,
      trackIndex: 0,
      index: 0,
      name: "Instrument",
      className: "Operator",
      classDisplayName: "Operator",
      enabled: true,
      parameterCount: 1,
      canHaveChains: false,
      canHaveDrumPads: false,
    };
    const parameter = {
      reference: "10000000-0000-4000-8000-000000000005",
      deviceReference: device.reference,
      index: 0,
      name: "Level",
      value: 0.5,
      normalizedValue: 0.5,
      min: 0,
      max: 1,
      isQuantized: false,
      isEnabled: true,
      valueItemCount: 0,
    };
    const inventory = { devices: [device], total: 1, offset: 0, limit: 8 };
    const inspection = {
      device,
      parameters: [parameter],
      total: 1,
      offset: 0,
      limit: 256,
    };
    const chain = {
      before: inventory,
      devices: [inspection],
      after: inventory,
    };
    expect(
      sessionListeningPreflightResultSchema.parse({
        ...value,
        instrumentChain: chain,
      }),
    ).toMatchObject({ instrumentChain: chain });
    for (const patch of [
      { instrumentChain: undefined },
      { instrumentChain: { ...chain, devices: [] } },
      { instrumentChain: { ...chain, before: { ...inventory, total: 2 } } },
      { instrumentChain: { ...chain, before: { ...inventory, offset: 1 } } },
      {
        instrumentChain: {
          ...chain,
          after: { ...inventory, devices: [{ ...device, enabled: false }] },
        },
      },
      ...[
        { device: { ...device, trackIndex: 1 } },
        { device: { ...device, reference: parameter.reference } },
        { device: { ...device, parameterCount: 2 } },
        { offset: 1 },
        { total: 2 },
        { parameters: [] },
        { parameters: [{ ...parameter, index: 1 }] },
        {
          parameters: [{ ...parameter, deviceReference: parameter.reference }],
        },
        { parameters: [parameter, parameter] },
      ].map((change) => ({
        instrumentChain: {
          ...chain,
          devices: [{ ...inspection, ...change }],
        },
      })),
      ...[
        { trackIndex: 1 },
        { trackReference: parameter.reference },
        { index: 1 },
        { canHaveChains: true },
        { canHaveDrumPads: true },
        { parameterCount: 257 },
      ].map((change) => {
        const changed = { ...device, ...change };
        const changedInventory = { ...inventory, devices: [changed] };
        return {
          instrumentChain: {
            before: changedInventory,
            devices: [{ ...inspection, device: changed }],
            after: changedInventory,
          },
        };
      }),
    ]) {
      expect(
        sessionListeningPreflightResultSchema.safeParse({ ...value, ...patch })
          .success,
      ).toBe(false);
    }
  });
});
