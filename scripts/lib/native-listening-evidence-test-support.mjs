import { randomUUID } from "node:crypto";
import * as protocol from "@ableton-agent/protocol";
import {
  createSyntheticNativeListeningFixture,
  createSyntheticNativeListeningFixtureV2,
} from "@ableton-agent/protocol/testing";

export function evidence() {
  const { proof, observation } = createSyntheticNativeListeningFixture();
  observation.attacks = [0, 1, 2, 3].map((beat) => ({
    beat,
    sample: observation.startSample + beat * 24000,
    strength: 1,
  }));
  observation.reduction.originalAttacks = 4;
  const owner = { sessionId: "session", agentId: "agent", liveSetId: "set" };
  const trace = {
    traceId: "00000000-0000-4000-8000-000000000001",
    correlationId: "correlation",
    causationId: "cause",
  };
  const listener = {
    connectionId: "connection",
    producer: { producerId: observation.listenerId },
    binding: { trackId: "track", deviceId: "device" },
    registration: { connectionEpoch: "epoch" },
  };
  const entry = {
    id: "context",
    passId: "pass",
    sessionId: "session",
    liveSetId: "set",
    trace,
    producer: {
      agentId: "agent",
      listenerId: observation.listenerId,
      connectionEpoch: "epoch",
      deviceId: "device-reference",
    },
    payload: observation,
  };
  return {
    owner,
    listener,
    target: {
      binding: {
        expectedDeviceReference: "device-reference",
        track: { expectedReference: "track-reference" },
      },
    },
    job: {
      passId: "pass",
      stage: "completed",
      cleanupPolicy: "leave-running",
      contextIds: ["context"],
    },
    pass: {
      id: "pass",
      status: "completed",
      complete: true,
      sessionId: "session",
      liveSetId: "set",
      initiatorAgentId: "agent",
      listenerIds: [observation.listenerId],
      requestedRange: { startBeat: 0, endBeat: 4 },
      actualRange: { startBeat: 0, endBeat: 4 },
      requestedMode: "arrangement",
      actualMode: "arrangement",
      trace,
    },
    entries: [entry],
    links: ["primary", "contributor"].map((relationship, index) => ({
      entryId: "context",
      subjectId: `subject-${index}`,
      sessionId: "session",
      liveSetId: "set",
      relationship,
      coverage: { startBeat: 0, endBeat: 4 },
      attribution: "unknown",
      freshness: { status: "unknown" },
    })),
    subjects: ["arrangement-range", "track"].map((kind, index) => ({
      id: `subject-${index}`,
      kind,
      trackId: "track-reference",
      sessionId: "session",
      liveSetId: "set",
      binding: {
        semanticLocator: {
          trackId: "track-reference",
          arrangementRange: { startBeat: 0, endBeat: 4 },
        },
      },
    })),
    received: [
      {
        connectionId: "connection",
        producer: listener.producer,
        binding: listener.binding,
        result: {
          status: "completed",
          passId: "pass",
          connectionEpoch: "epoch",
          ...trace,
          observation,
          nativeCapture: proof,
        },
      },
    ],
    typed: {
      action: "get",
      entry: {
        contextId: "context",
        passId: "pass",
        listenerId: observation.listenerId,
        freshness: "unknown",
      },
      observation,
    },
    resumed: {
      action: "get",
      entry: {
        contextId: "context",
        passId: "pass",
        listenerId: observation.listenerId,
        freshness: "unknown",
      },
      observation,
    },
    baseline: { trackCount: 1 },
    final: { trackCount: 1 },
  };
}

export function descriptiveEvidence(
  geometry = {
    sampleRate: 44_100,
    vectorSize: 128,
    tempoBpm: 127.5,
    startBeat: 5.25,
    endBeat: 9.50001,
  },
) {
  const e = evidence();
  const policy = { mode: "descriptive", maxClockDisagreementSamples: 64 };
  const native = createSyntheticNativeListeningFixtureV2({
    geometry,
    timingPolicy: policy,
    passId: e.pass.id,
    listenerId: e.listener.producer.producerId,
  });
  e.expected = {
    policy,
    geometry: protocol.createNativeListeningGeometry(geometry),
    passId: e.pass.id,
    listenerId: e.listener.producer.producerId,
  };
  e.listener.registration.version = 2;
  e.listener.producer.schemaVersion = "audio-observation/v2";
  e.entries[0].kind = "audio-observation/v2";
  e.entries[0].payload = native.observation;
  e.pass.requestedRange = {
    startBeat: geometry.startBeat,
    endBeat: geometry.endBeat,
  };
  e.pass.actualRange = {
    startBeat: native.observation.startBeat,
    endBeat: native.observation.endBeat,
  };
  for (const link of e.links) link.coverage = { ...e.pass.actualRange };
  e.subjects[0].binding.semanticLocator.arrangementRange = {
    ...e.pass.requestedRange,
  };
  e.received[0].result.listenerVersion = 2;
  e.received[0].result.observation = native.observation;
  e.received[0].result.nativeCapture = native.proof;
  e.typed.observation = native.observation;
  e.resumed.observation = globalThis.structuredClone(native.observation);
  return e;
}

export function sessionEvidence({
  rate = 44100,
  kind = "midi",
  followUnknown = false,
  startBeat = 8,
  durationBeats = 4,
  loopEnd = 8,
} = {}) {
  const resolvedDurationBeats = durationBeats ?? loopEnd;
  const e = descriptiveEvidence({
    sampleRate: rate,
    vectorSize: 128,
    tempoBpm: 120,
    startBeat,
    endBeat: startBeat + resolvedDurationBeats,
  });
  const target = {
    view: "session",
    track: {
      kind: "regular",
      index: 0,
      expectedReference: randomUUID(),
      expectedName: "Fixture track",
    },
    sceneIndex: 0,
    expectedClipReference: randomUUID(),
    expectedClipName: "Fixture clip",
  };
  e.target.binding = {
    track: target.track,
    deviceIndex: 0,
    expectedDeviceReference: randomUUID(),
    expectedDeviceName: "Listener",
    expectedClassName: "MxDeviceAudioEffect",
  };
  e.entries[0].producer.deviceId = e.target.binding.expectedDeviceReference;
  e.pass.id = randomUUID();
  e.entries[0].passId = e.job.passId = e.pass.id;
  e.typed.entry.passId = e.resumed.entry.passId = e.pass.id;
  const native = createSyntheticNativeListeningFixtureV2({
    geometry: {
      sampleRate: rate,
      vectorSize: 128,
      tempoBpm: 120,
      startBeat,
      endBeat: startBeat + resolvedDurationBeats,
    },
    timingPolicy: e.expected.policy,
    passId: e.pass.id,
    listenerId: e.listener.producer.producerId,
  });
  e.expected.passId = e.pass.id;
  e.expected.source = {
    mode: "session",
    synchronization: "transport-coupled-first-iteration",
    target,
  };
  e.listener.registration.version = 3;
  const stopped = {
    transportPlaying: false,
    globalBeat: startBeat,
    startTimeBeats: null,
    playingPosition: 0,
    targetPlaying: false,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: -1,
    firedSlotIndex: -1,
    selectedClipReference: null,
  };
  const source = {
    schemaVersion: 1,
    queryId: randomUUID(),
    target,
    projectRevision: 4,
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    sourceKind: kind,
    positionUnit: "beats",
    before: stopped,
    after: stopped,
    settings: {
      tempoBpm: 120,
      signatureNumerator: 4,
      signatureDenominator: 4,
      clipSignatureNumerator: 4,
      clipSignatureDenominator: 4,
      globalQuantization: startBeat % 4 === 0 ? 4 : 0,
      launchQuantization: 0,
      launchMode: 0,
      legato: false,
      followActionEnabled: followUnknown ? null : false,
      startMarker: 0,
      endMarker: loopEnd,
      loopStart: 0,
      loopEnd,
      looping: true,
    },
  };
  const epoch = {
    startTimeBeats: startBeat,
    clipReference: target.expectedClipReference,
    observedGlobalBeat: startBeat + 0.25,
  };
  const running = {
    ...stopped,
    transportPlaying: true,
    globalBeat: startBeat + 0.25,
    startTimeBeats: startBeat,
    playingPosition: 0.25,
    targetPlaying: true,
    playingSlotIndex: 0,
    selectedClipReference: target.expectedClipReference,
  };
  const ownerId = randomUUID();
  const limitations = [
    "Session source continuity is message-rate monitored, not sample-accurate physical proof.",
    ...(followUnknown
      ? [
          "Follow-action state is unknown; message-rate monitoring may not detect every change.",
        ]
      : []),
  ];
  const receipts = ["prepare", "launch", "inspect", "release"].map(
    (action) => ({
      beforePublication: action !== "release",
      params: {
        schemaVersion: 1,
        ownerId,
        passId: e.pass.id,
        action,
        ...(action === "prepare"
          ? {
              expectedLiveSetId: e.owner.liveSetId,
              expectedProjectRevision: source.projectRevision,
              target,
              listener: e.target.binding,
              durationBeats: resolvedDurationBeats,
              timingAnchor: { globalBeat: startBeat },
            }
          : action === "release"
            ? { reason: "completed" }
            : {}),
      },
      result: {
        schemaVersion: 1,
        ownerId,
        passId: e.pass.id,
        status:
          action === "prepare"
            ? "prepared"
            : action === "release"
              ? "released"
              : "playing",
        mutationState:
          action === "prepare" ? "not-attempted" : "observed-playing",
        reason: null,
        cleanupPolicy: "leave-running",
        evidence: "message-rate-only",
        nativeAlignment: "unverified",
        lastObservedSource: action === "prepare" ? stopped : running,
        sourceEpoch: action === "prepare" ? null : epoch,
        followActionState: followUnknown ? "unknown" : "known-disabled",
        limitations,
        durationBeats: resolvedDurationBeats,
        expiresInMs: 30000,
      },
    }),
  );
  e.session = {
    target,
    source,
    sourceKind: kind,
    geometry: e.expected.geometry,
    durationBeats,
    receipts,
    after: { ...source, before: running, after: running },
  };
  const observation = protocol.mapSessionAudioObservation(native.observation, {
    view: "session",
    target,
    kind,
    coordinate: {
      unit: "beats",
      iteration: 0,
      startBeat: 0,
      endBeat: native.observation.endBeat - startBeat,
    },
    transport: { startBeat, endBeat: native.observation.endBeat },
    origin: {
      evidence: "message-rate-start-time-with-native-transport",
      clipStartTimeBeats: startBeat,
      observedAtGlobalBeat: startBeat + 0.25,
    },
    continuity: {
      evidence: "message-rate-monitored",
      followActions: followUnknown ? "unknown" : "disabled",
    },
  });
  observation.limitations.push(...limitations);
  e.entries[0].kind = "session-audio-observation/v1";
  e.entries[0].payload = observation;
  e.typed.observation = observation;
  e.resumed.observation = globalThis.structuredClone(observation);
  e.pass.requestedMode = e.pass.actualMode = "session";
  e.pass.requestedRange = { startBeat: 0, endBeat: resolvedDurationBeats };
  e.pass.actualRange = { startBeat: 0, endBeat: observation.endBeat };
  e.received[0].result = {
    ...e.received[0].result,
    passId: e.pass.id,
    listenerVersion: 3,
    observation: native.observation,
    nativeCapture: {
      scope: protocol.NATIVE_SESSION_LISTENER_SCOPE,
      source: e.expected.source,
      transport: native.proof,
    },
  };
  e.subjects.forEach((subject, index) => {
    subject.kind = index === 0 ? "clip" : "track";
    subject.location = index === 0 ? "session" : "track";
    subject.trackId = e.subjects[1].id;
    subject.binding = {
      semanticLocator: {
        trackId: e.subjects[1].id,
        ...(index === 0 ? { sceneIndex: 0 } : {}),
      },
      previousRuntimeBindings: [
        index === 0
          ? target.expectedClipReference
          : target.track.expectedReference,
      ],
      dependencyScope: "unknown",
    };
    e.links[index].coverage =
      index === 0
        ? {
            coordinate: "clip-local-beats",
            iteration: 0,
            ...e.pass.actualRange,
          }
        : {
            coordinate: "transport-beats",
            startBeat,
            endBeat: native.observation.endBeat,
          };
  });
  return e;
}
