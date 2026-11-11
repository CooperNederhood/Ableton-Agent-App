import type {
  InspectSessionListeningSourceParams,
  InspectSessionListeningSourceResult,
  RecordingOperationResult,
  AudioClipsOperationResult,
  InspectMidiNotesResult,
} from "@ableton-agent/protocol";

export function sessionListeningMidiPreflightFixture() {
  const { params, result } = sessionListeningSourceFixture();
  const source: InspectSessionListeningSourceResult = {
    ...result,
    sourceKind: "midi",
    positionUnit: "beats",
  };
  const midi: InspectMidiNotesResult = {
    clip: {
      reference: params.target.expectedClipReference,
      trackReference: params.target.track.expectedReference,
      trackIndex: params.target.track.index,
      sceneIndex: params.target.sceneIndex,
      name: params.target.expectedClipName,
      length: 4,
      noteCount: 1,
    },
    notes: [
      { pitch: 69, startTime: 0, duration: 0.25, velocity: 100, mute: false },
    ],
    totalNotes: 1,
    offset: 0,
    limit: 2048,
    truncated: false,
  };
  return {
    params,
    result: {
      source,
      midi,
      instrumentChain: {
        before: { devices: [], total: 0, offset: 0, limit: 8 },
        devices: [],
        after: { devices: [], total: 0, offset: 0, limit: 8 },
      },
      recording: recordingInspectionFixture(),
    },
  };
}

export function sessionListeningPreflightFixture() {
  const { params, result: source } = sessionListeningSourceFixture();
  const audio: Extract<
    AudioClipsOperationResult,
    { action: "inspect" }
  >["clip"] = {
    reference: params.target.expectedClipReference,
    name: params.target.expectedClipName,
    length: 4,
    gain: 1,
    pitchCoarse: 0,
    pitchFine: 0,
    warping: true,
    warpMode: 0,
    availableWarpModes: [0],
    startMarker: 0,
    endMarker: 4,
    loopStart: 0,
    loopEnd: 4,
    looping: true,
    ramMode: false,
    filePath: "/runner/working/media/resource-001.wav",
    sampleLength: 96_000,
    sampleRate: 48_000,
  };
  return {
    params,
    result: { source, audio, recording: recordingInspectionFixture() },
  };
}

export function recordingInspectionFixture(): Extract<
  RecordingOperationResult,
  { action: "inspect" }
> {
  return {
    action: "inspect",
    state: {
      arrangementRecord: true,
      sessionRecord: true,
      overdub: false,
      sessionAutomationRecord: false,
      punchIn: false,
      punchOut: false,
    },
  };
}

export function sessionListeningSourceFixture(): {
  params: InspectSessionListeningSourceParams;
  result: InspectSessionListeningSourceResult;
} {
  const params: InspectSessionListeningSourceParams = {
    schemaVersion: 1,
    queryId: "00000000-0000-4000-8000-000000000051",
    target: {
      view: "session",
      track: {
        kind: "regular",
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000052",
        expectedName: "Source 1",
      },
      sceneIndex: 0,
      expectedClipReference: "00000000-0000-4000-8000-000000000053",
      expectedClipName: "Clip 1",
    },
  };
  const state = {
    transportPlaying: false,
    globalBeat: 0,
    startTimeBeats: 0,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: params.target.expectedClipReference,
  };
  return {
    params,
    result: {
      ...params,
      projectRevision: 7,
      evidence: "message-rate-only",
      nativeAlignment: "unverified",
      sourceKind: "warped-audio",
      positionUnit: "beats",
      before: { ...state },
      after: { ...state },
      settings: {
        tempoBpm: 120,
        signatureNumerator: 4,
        signatureDenominator: 4,
        clipSignatureNumerator: 4,
        clipSignatureDenominator: 4,
        globalQuantization: 0,
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
  };
}
