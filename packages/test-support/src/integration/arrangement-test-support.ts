import type { FixtureManifest } from "./contracts.js";
import type {
  ArrangementCaptureEvidence,
  ArrangementFixtureSource,
  ArrangementSourceEvidence,
} from "./arrangement.js";

/** Synthetic contract inputs only; no fixture assets or real-host registration. */
export function arrangementTestEvidence() {
  const sha256 = "a".repeat(64),
    projectSha256 = "b".repeat(64);
  const definition: ArrangementFixtureSource = {
    id: "arrangement-source",
    view: "arrangement",
    trackIndex: 1,
    trackName: "Track",
    listenerBindingSlot:
      "AudioTrack:9/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
    startBeat: 0,
    endBeat: 384,
    tempoBpm: 128,
    clips: Array.from({ length: 24 }, (_, i) => ({
      savedClipId: String(i + 1),
      mediaTarget: "media/resource-001.aif",
      startBeat: i * 16,
      endBeat: (i + 1) * 16,
    })),
  };
  const fixture: FixtureManifest = {
    schemaVersion: 1,
    id: "synthetic-arrangement",
    qualification: "synthetic-only",
    provenance: {
      ownership: "authored",
      description: "Synthetic evidence only",
    },
    resources: [
      {
        path: "project.als",
        target: "project.als",
        sha256: projectSha256,
        bytes: 1,
      },
      {
        path: "media/resource-001.aif",
        target: "media/resource-001.aif",
        sha256,
        bytes: 1,
      },
    ],
    dependencies: ["machine-listening"],
    listenerBindings: [
      {
        slot: definition.listenerBindingSlot,
        sourcePath: "listener.amxd",
        dependency: "machine-listening",
        trackIndex: 1,
        deviceIndex: 0,
      },
    ],
    arrangementSources: [definition],
    baseline: { currentSongTime: 72, targetArmed: true },
  };
  const state = {
    tempoBpm: 128,
    tempoAutomation: false,
    currentBeat: 72,
    transportPlaying: false,
    loopEnabled: false,
    arrangementRecord: false,
    sessionRecord: false,
    targetRecording: false,
    targetArmed: true,
    targetMonitoring: "off",
    backToArrangement: false,
    playingSessionClips: 0,
    queuedSessionClips: 0,
  } as const;
  const baseline: ArrangementSourceEvidence = {
    source: {
      view: "arrangement",
      trackId: "track-1",
      trackIndex: 1,
      startBeat: 0,
      endBeat: 384,
      clips: definition.clips.map((clip, i) => ({
        startBeat: clip.startBeat,
        endBeat: clip.endBeat,
        savedClipId: clip.savedClipId,
        clipId: `live-clip-${i}`,
        mediaSha256: sha256,
      })),
    },
    trackName: "Track",
    listenerId: "listener-1",
    listenerDeviceIndex: 0,
    savedProjectSha256: projectSha256,
    loadedProjectSha256: projectSha256,
    savedClips: definition.clips,
    media: [
      {
        target: "media/resource-001.aif",
        loadedPath: "/owned/media/resource-001.aif",
        ownedPath: "/owned/media/resource-001.aif",
        sha256,
        sampleRate: 48_000,
      },
    ],
    before: state,
    after: state,
  };
  const expected = {
    operationId: "operation-1",
    traceId: "trace-1",
    causationId: "message-1",
    tempoBpm: 128,
    hostSampleRate: 48_000,
    playbackAfterCapture: "stopped" as const,
    metricRecords: { level: 1800, spectral: 9000 },
  };
  const capture: ArrangementCaptureEvidence = {
    passId: "pass-1",
    operationId: expected.operationId,
    traceId: expected.traceId,
    correlationId: expected.traceId,
    causationId: expected.causationId,
    listenerId: baseline.listenerId,
    source: baseline.source,
    sampleRate: 48_000,
    startSample: 0,
    endSample: 8_640_000,
    complete: true,
    truncated: false,
    failure: null,
    metrics: Object.entries(expected.metricRecords).map(([name, count]) => ({
      name,
      passId: "pass-1",
      listenerId: baseline.listenerId,
      expectedRecords: count,
      receivedRecords: count,
      missingRecords: 0,
      startSample: 0,
      endSample: 8_640_000,
      source: baseline.source,
      nonSilent: true,
    })),
    cleanup: {
      captureReleased: true,
      sourceRestored: true,
      transportPlaying: false,
      failure: null,
    },
  };
  return { fixture, definition, baseline, capture, expected };
}
