import { describe, expect, it } from "vitest";
import * as protocol from "@ableton-agent/protocol";
import {
  createSyntheticNativeListeningFixture,
  createSyntheticNativeListeningFixtureV2,
} from "@ableton-agent/protocol/testing";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  createNativeScenarioApproval,
  snapshotNativeSessionSource,
  verifyNativeListeningEvidence,
} from "./native-listening-verification.mjs";

function evidence() {
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

function descriptiveEvidence(
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
} = {}) {
  const e = descriptiveEvidence({
    sampleRate: rate,
    vectorSize: 128,
    tempoBpm: 120,
    startBeat,
    endBeat: startBeat + 4,
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
      endBeat: startBeat + 4,
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
      globalQuantization: startBeat % 4 === 0 ? 4 : 0,
      launchQuantization: 0,
      launchMode: 0,
      legato: false,
      followActionEnabled: followUnknown ? null : false,
      startMarker: 0,
      endMarker: 8,
      loopStart: 0,
      loopEnd: 8,
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
              durationBeats: 4,
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
        durationBeats: 4,
        expiresInMs: 30000,
      },
    }),
  );
  e.session = {
    target,
    source,
    sourceKind: kind,
    geometry: e.expected.geometry,
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
  e.pass.requestedRange = { startBeat: 0, endBeat: 4 };
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

describe("Session wire3 independent source join (synthetic only, not physical qualification)", () => {
  it("accepts the canonical association shape read through the typed store from capture 232754af, not Live UUID identity", () => {
    const e = sessionEvidence({ startBeat: 0, followUnknown: true });
    const clipId =
      "e0bf4bac5a50584d6662bd3483e4f6c004d97ad55f17c9abaf20d10344006535";
    const trackId =
      "b5f76dd0db11fe5dca34ae6d1712e10f7c3c2e045968fc0001f39803c48bbdf7";
    e.subjects[0].id = e.links[0].subjectId = clipId;
    e.subjects[1].id = e.links[1].subjectId = trackId;
    for (const subject of e.subjects) {
      subject.trackId = trackId;
      subject.binding.semanticLocator.trackId = trackId;
    }
    expect(trackId).not.toBe(e.target.binding.track.expectedReference);
    expect(verifyNativeListeningEvidence(e, protocol)).toMatchObject({
      observationSchema: "session-audio-observation/v1",
      attribution: "unknown",
      freshness: "unknown",
      physicalClipIdentityProven: false,
      transportRange: { startBeat: 0, endBeat: 4 },
    });
    e.subjects[0].trackId = e.target.binding.track.expectedReference;
    expect(() => verifyNativeListeningEvidence(e, protocol)).toThrow(
      "Context association",
    );
  });
  it("keeps nominal requested duration exact at a fractional None-quantized transport origin without clamping actual beats", () => {
    const e = sessionEvidence({ startBeat: 0.1 });
    expect(
      e.expected.geometry.endBeat - e.expected.geometry.startBeat,
    ).not.toBe(4);
    const result = verifyNativeListeningEvidence(e, protocol);
    expect(result.requestedRange).toEqual({ startBeat: 0, endBeat: 4 });
    expect(result.endBeat).toBe(e.received[0].result.observation.endBeat - 0.1);
    expect(result.endBeat).not.toBe(4);
  });
  it.each([
    [44100, "midi"],
    [48000, "warped-audio"],
  ])(
    "accepts %sHz %s raw-v2 transport plus local historical context and independently monitored epoch",
    (rate, kind) => {
      const e = sessionEvidence({ rate, kind });
      const raw = globalThis.structuredClone(e.received[0].result);
      expect(verifyNativeListeningEvidence(e, protocol)).toMatchObject({
        observationSchema: "session-audio-observation/v1",
        sourceKind: kind,
        startBeat: 0,
        endBeat: 4,
        transportRange: { startBeat: 8, endBeat: 12 },
        physicalClipIdentityProven: false,
      });
      expect(e.received[0].result).toEqual(raw);
      expect(e.entries[0].payload.startSample).toBe(
        raw.observation.startSample,
      );
    },
  );
  it("preserves unknown follow state only with the monitoring/detection limitation", () => {
    expect(
      verifyNativeListeningEvidence(
        sessionEvidence({ followUnknown: true }),
        protocol,
      ).continuity.followActions,
    ).toBe("unknown");
  });
  it("does not reinterpret redacted historical display names as identity authority", () => {
    const e = sessionEvidence();
    for (const observation of [e.entries[0].payload, e.resumed.observation]) {
      observation.source.target.expectedClipName = "token=[REDACTED]";
      observation.source.target.track.expectedName = "Fixture [REDACTED]";
    }
    expect(
      verifyNativeListeningEvidence(e, protocol).physicalClipIdentityProven,
    ).toBe(false);
  });
  it("does not replace the pre-publication origin with a later leave-running loop epoch", () => {
    const e = sessionEvidence();
    const after = {
      ...e.session.after.after,
      globalBeat: 16.25,
      startTimeBeats: 16,
    };
    e.session.after = { ...e.session.after, before: after, after };
    const result = verifyNativeListeningEvidence(e, protocol);
    expect(result.transportRange).toEqual({ startBeat: 8, endBeat: 12 });
    expect(e.entries[0].payload.source.origin.clipStartTimeBeats).toBe(8);
  });
  it("deeply freezes pre-capture source and geometry without claiming native source proof", () => {
    const e = sessionEvidence();
    e.session.geometry = globalThis.structuredClone(e.session.geometry);
    const frozen = snapshotNativeSessionSource(e.session, protocol);
    e.session.source.target.track.expectedReference = randomUUID();
    e.session.geometry.startBeat = 9;
    expect(Object.isFrozen(frozen.source.target.track)).toBe(true);
    expect(frozen.geometry.startBeat).toBe(8);
    expect(frozen.source.nativeAlignment).toBe("unverified");
  });
  it.each([
    [
      "missing frozen expectation",
      (e) => {
        delete e.expected;
      },
    ],
    [
      "missing source receipts",
      (e) => {
        e.session.receipts = [];
      },
    ],
    [
      "wire-v2 receipt",
      (e) => {
        e.received[0].result.listenerVersion = 2;
      },
    ],
    [
      "promoted raw schema",
      (e) => {
        e.received[0].result.observation.schema =
          "session-audio-observation/v1";
      },
    ],
    [
      "wrong wrapper target",
      (e) => {
        e.received[0].result.nativeCapture = globalThis.structuredClone(
          e.received[0].result.nativeCapture,
        );
        e.received[0].result.nativeCapture.source.target.sceneIndex = 1;
      },
    ],
    [
      "wrong native policy",
      (e) => {
        e.expected.policy.maxClockDisagreementSamples = 65;
      },
    ],
    [
      "relabelled ABI2 scope",
      (e) => {
        e.received[0].result.nativeCapture.transport.scope =
          protocol.NATIVE_SESSION_LISTENER_SCOPE;
      },
    ],
    [
      "missing physical window",
      (e) => {
        e.received[0].result.nativeCapture.transport.spectralWindows.pop();
      },
    ],
    [
      "result-derived geometry",
      (e) => {
        e.expected = globalThis.structuredClone(e.expected);
        e.expected.geometry.startBeat = 7;
        e.expected.geometry.endBeat = 11;
      },
    ],
    [
      "wrong source epoch",
      (e) => {
        e.session.receipts[1].result.sourceEpoch = {
          ...e.session.receipts[1].result.sourceEpoch,
          startTimeBeats: 9,
        };
      },
    ],
    [
      "wrong active clip",
      (e) => {
        e.session.receipts[1].result.lastObservedSource.selectedClipReference =
          randomUUID();
      },
    ],
    [
      "no prepublication witness",
      (e) => {
        e.session.receipts.forEach((receipt) => {
          receipt.beforePublication = false;
        });
      },
    ],
    [
      "epoch lost after launch",
      (e) => {
        e.session.receipts[2].result.sourceEpoch = null;
        e.session.receipts[2].result.mutationState = "indeterminate";
        e.session.receipts[2].result.status = "queued";
      },
    ],
    [
      "retry",
      (e) => {
        e.session.receipts.splice(2, 0, e.session.receipts[1]);
      },
    ],
    [
      "cancelled monitor",
      (e) => {
        e.session.receipts.at(-1).params.reason = "cancelled";
      },
    ],
    [
      "unreleased monitor",
      (e) => {
        e.session.receipts.pop();
      },
    ],
    [
      "changed source owner",
      (e) => {
        e.session.receipts[2].params.ownerId = randomUUID();
      },
    ],
    [
      "global primary coverage",
      (e) => {
        e.links[0].coverage = { ...e.links[1].coverage };
      },
    ],
    [
      "global requested range",
      (e) => {
        e.pass.requestedRange = { startBeat: 8, endBeat: 12 };
      },
    ],
    [
      "wrong historical clip reference",
      (e) => {
        e.entries[0].payload.source.target.expectedClipReference = randomUUID();
      },
    ],
    [
      "local contributor coverage",
      (e) => {
        e.links[1].coverage = { ...e.links[0].coverage };
      },
    ],
    [
      "wrong scene binding",
      (e) => {
        e.subjects[0].binding.semanticLocator.sceneIndex = 1;
      },
    ],
    [
      "wrong track binding",
      (e) => {
        e.subjects[1].binding.previousRuntimeBindings = [randomUUID()];
      },
    ],
    [
      "exclusive attribution",
      (e) => {
        e.links[0].attribution = "exclusive";
      },
    ],
    [
      "fresh reference",
      (e) => {
        e.links[0].freshness.status = "fresh";
      },
    ],
    [
      "known dependency scope",
      (e) => {
        e.subjects[1].binding.dependencyScope = "complete";
      },
    ],
    [
      "missing reopened alignment",
      (e) => {
        delete e.resumed.observation.alignment;
      },
    ],
    [
      "loop endpoint equality",
      (e) => {
        e.session.source.settings.loopEnd = 4;
      },
    ],
    [
      "changed launch setting",
      (e) => {
        e.session.after = globalThis.structuredClone(e.session.after);
        e.session.after.settings.legato = true;
      },
    ],
    [
      "enabled follow actions",
      (e) => {
        e.session.source.settings.followActionEnabled = true;
      },
    ],
    [
      "promoted unknown follow state",
      (e) => {
        e.session.source.settings.followActionEnabled = null;
        e.session.receipts.forEach((receipt) => {
          receipt.result.followActionState = "unknown";
          receipt.result.limitations.push(
            "Unknown follow actions may not be detected.",
          );
        });
      },
    ],
    [
      "unknown units",
      (e) => {
        e.session.source.positionUnit = null;
      },
    ],
    [
      "altered DSP sample index",
      (e) => {
        e.entries[0].payload.startSample++;
      },
    ],
    [
      "content edit",
      (e) => {
        e.final = { trackCount: 2 };
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const e = sessionEvidence();
    mutate(e);
    expect(() => verifyNativeListeningEvidence(e, protocol)).toThrow();
  });
});

describe("native v2 verification with independent App expectations (synthetic only)", () => {
  it("verifies fractional 44.1k/127.5BPM coverage and truthful reopened quality", () => {
    const result = verifyNativeListeningEvidence(
      descriptiveEvidence(),
      protocol,
    );
    expect(result).toMatchObject({
      sampleRate: 44_100,
      startBeat: 5.25,
      endBeat: 9.5,
      requestedRange: { startBeat: 5.25, endBeat: 9.50001 },
      observationSchema: "audio-observation/v2",
      alignment: {
        alignment: "approximate",
        intendedUse: "descriptive-only",
        estimatedAbsoluteErrorSamples: null,
        verifiedAbsoluteErrorBoundSamples: null,
      },
    });
  });
  it.each([
    [0.1, 1],
    [0.1 + 1 / 48_000, 2],
    [30, 300],
  ])(
    "verifies %s native seconds and %s exact windows without calibration attacks",
    (seconds, windows) => {
      const result = verifyNativeListeningEvidence(
        descriptiveEvidence({
          sampleRate: 48_000,
          vectorSize: 64,
          tempoBpm: 100,
          startBeat: 3.125,
          endBeat: 3.125 + (seconds * 100) / 60,
        }),
        protocol,
      );
      expect(result.envelopeWindows).toBe(windows);
      expect(result.stereoFrames).toBe(Math.round(seconds * 48_000));
      expect(result.estimatedAttacks).toBe(0);
    },
  );
  it.each([
    [
      "missing App expectation",
      (e) => {
        delete e.expected;
      },
    ],
    [
      "changed requested policy",
      (e) => {
        e.expected.policy.maxClockDisagreementSamples = 480;
      },
    ],
    [
      "wrong App listener",
      (e) => {
        e.expected.listenerId = "other-listener";
      },
    ],
    [
      "wrong App pass",
      (e) => {
        e.expected.passId = "other-pass";
      },
    ],
    [
      "relabelled native count",
      (e) => {
        e.received[0].result.nativeCapture.envelopeWindows[0][0]++;
      },
    ],
    [
      "legacy entry kind",
      (e) => {
        e.entries[0].kind = "audio-observation/v1";
      },
    ],
    [
      "legacy result version",
      (e) => {
        e.received[0].result.listenerVersion = 1;
      },
    ],
    [
      "unquantized actual range",
      (e) => {
        e.pass.actualRange = { ...e.pass.requestedRange };
      },
    ],
    [
      "rewritten requested range",
      (e) => {
        e.pass.requestedRange = { ...e.pass.actualRange };
      },
    ],
    [
      "fabricated absolute bound",
      (e) => {
        e.entries[0].payload.alignment.verifiedAbsoluteErrorBoundSamples = 64;
      },
    ],
    [
      "lost reopened alignment",
      (e) => {
        delete e.resumed.observation.alignment;
      },
    ],
    [
      "mutated Set",
      (e) => {
        e.final.trackCount = 2;
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const e = descriptiveEvidence();
    mutate(e);
    expect(() => verifyNativeListeningEvidence(e, protocol)).toThrow();
  });
});

describe("native listening independent verification (synthetic unit evidence only)", () => {
  it("accepts exact proof plus one typed atomic historical track/range context", () => {
    expect(verifyNativeListeningEvidence(evidence(), protocol)).toMatchObject({
      stereoFrames: 96000,
      envelopeWindows: 20,
      spectralWindows: 20,
      estimatedAttacks: 4,
      cleanupPolicy: "leave-running",
      attribution: "unknown",
    });
  });
  it.each([
    [
      "wrong device",
      (e) => {
        e.entries[0].producer.deviceId = "foreign";
      },
    ],
    [
      "wrong contributor track",
      (e) => {
        e.subjects[1].trackId = "foreign";
      },
    ],
    [
      "wrong context pass",
      (e) => {
        e.entries[0].passId = "foreign";
      },
    ],
    [
      "queued acceptance",
      (e) => {
        e.job.stage = "arming";
      },
    ],
    [
      "wrong owner",
      (e) => {
        e.pass.sessionId = "foreign";
      },
    ],
    [
      "wrong epoch",
      (e) => {
        e.received[0].result.connectionEpoch = "stale";
      },
    ],
    [
      "wrong causation",
      (e) => {
        e.received[0].result.causationId = "stale";
      },
    ],
    [
      "missing proof",
      (e) => {
        delete e.received[0].result.nativeCapture;
      },
    ],
    [
      "missing FFT",
      (e) => {
        e.received[0].result.nativeCapture.spectralWindows.pop();
      },
    ],
    [
      "fake host bracket",
      (e) => {
        e.received[0].result.nativeCapture.after.frames[0][2]++;
      },
    ],
    [
      "duplicate context",
      (e) => {
        e.entries.push(e.entries[0]);
      },
    ],
    [
      "exclusive attribution",
      (e) => {
        e.links[0].attribution = "exclusive";
      },
    ],
    [
      "freshness promotion",
      (e) => {
        e.links[0].freshness.status = "fresh";
      },
    ],
    [
      "clip association",
      (e) => {
        e.subjects[0].kind = "clip";
      },
    ],
    [
      "reopen data mismatch",
      (e) => {
        e.resumed = {
          ...e.resumed,
          observation: { ...e.resumed.observation, passId: "foreign" },
        };
      },
    ],
    [
      "Set mutation",
      (e) => {
        e.final.trackCount++;
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const e = evidence();
    mutate(e);
    expect(() => verifyNativeListeningEvidence(e, protocol)).toThrow();
  });
});

describe("native scenario exact actor approval guards", () => {
  const sessionTarget = {
    view: "session",
    track: {
      kind: "regular",
      index: 0,
      expectedReference: "00000000-0000-4000-8000-000000000001",
      expectedName: "Track",
    },
    sceneIndex: 0,
    expectedClipReference: "00000000-0000-4000-8000-000000000002",
    expectedClipName: "Clip",
  };
  async function sessionApproval(overrides = {}) {
    const manifest = JSON.parse(
      await readFile(
        "integration/live-scenarios/native-session-midi.json",
        "utf8",
      ),
    );
    return createNativeScenarioApproval(manifest, {
      listenerId: "owned",
      sessionTarget,
      passIds: new Set(["owned-pass"]),
      contextIds: new Set(["owned-context"]),
      completedContextIds: new Set(["owned-context"]),
      ...overrides,
    });
  }
  const sessionPlay = (change = {}) => ({
    toolName: "ableton_listening",
    risk: "reversible",
    arguments: {
      action: "play-session-and-listen",
      target: sessionTarget,
      listenerIds: ["owned"],
      durationBeats: 4,
      maximumDurationMs: 30000,
      ...change,
    },
  });
  it("admits exactly one inspected Session launch, one owned get-pass and one completed historical context get", async () => {
    const a = await sessionApproval();
    expect(
      await a.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      }),
    ).toBe(true);
    expect(await a.request(sessionPlay())).toBe(true);
    expect(a.mutationCount).toBe(1);
    expect(
      await a.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "get-pass", passId: "owned-pass" },
      }),
    ).toBe(true);
    expect(
      await a.request({
        toolName: "ableton_context",
        risk: "read",
        arguments: {
          action: "get",
          contextId: "owned-context",
          includeHistorical: true,
        },
      }),
    ).toBe(true);
    expect(await a.request(sessionPlay())).toBe(false);
  });
  it.each([
    { durationBeats: 4.001 },
    { maximumDurationMs: 30001 },
    { listenerIds: ["owned", "other"] },
    { listenerIds: ["other"] },
    { target: { ...sessionTarget, sceneIndex: 1 } },
    {
      target: {
        ...sessionTarget,
        expectedClipReference: "00000000-0000-4000-8000-000000000003",
      },
    },
    {
      target: { ...sessionTarget, track: { ...sessionTarget.track, index: 1 } },
    },
    { startBeat: 0 },
    { endBeat: 4 },
  ])(
    "denies widened Session arguments without allowing correction or retry %j",
    async (change) => {
      const a = await sessionApproval();
      await a.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      });
      expect(await a.request(sessionPlay(change))).toBe(false);
      expect(a.mutationCount).toBe(0);
      expect(await a.request(sessionPlay())).toBe(false);
    },
  );
  it("rejects Session playback without prior inspection or with wrong risk", async () => {
    const a = await sessionApproval();
    expect(await a.request(sessionPlay())).toBe(false);
    const b = await sessionApproval();
    await b.request({
      toolName: "ableton_listening",
      risk: "read",
      arguments: { action: "inspect-listeners" },
    });
    expect(await b.request({ ...sessionPlay(), risk: "read" })).toBe(false);
  });
  it("does not permit historical context merely because an owned ID exists before completion", async () => {
    const a = await sessionApproval({ completedContextIds: new Set() });
    await a.request({
      toolName: "ableton_listening",
      risk: "read",
      arguments: { action: "inspect-listeners" },
    });
    await a.request(sessionPlay());
    await a.request({
      toolName: "ableton_listening",
      risk: "read",
      arguments: { action: "get-pass", passId: "owned-pass" },
    });
    expect(
      await a.request({
        toolName: "ableton_context",
        risk: "read",
        arguments: {
          action: "get",
          contextId: "owned-context",
          includeHistorical: true,
        },
      }),
    ).toBe(false);
  });
  it("freezes the selected target before actor arguments can widen its scene", async () => {
    const target = globalThis.structuredClone(sessionTarget);
    const a = await sessionApproval({ sessionTarget: target });
    await a.request({
      toolName: "ableton_listening",
      risk: "read",
      arguments: { action: "inspect-listeners" },
    });
    target.sceneIndex = 1;
    expect(await a.request(sessionPlay({ target }))).toBe(false);
    expect(a.mutationCount).toBe(0);
  });
  it.each([
    [
      "ableton_transport",
      "reversible",
      { action: "set-playing", isPlaying: false },
    ],
    [
      "ableton_listening",
      "reversible",
      {
        action: "play-arrangement-and-listen",
        startBeat: 0,
        endBeat: 4,
        listenerIds: ["owned"],
        maximumDurationMs: 30000,
      },
    ],
    ["ableton_listening", "read", { action: "get-pass", passId: "foreign" }],
    [
      "ableton_listening",
      "reversible",
      { action: "cancel", passId: "owned-pass" },
    ],
    ["ableton_context", "read", { action: "list", includeHistorical: true }],
  ])(
    "rejects unrelated/unowned Session action %s/%s/%j",
    async (toolName, risk, args) => {
      const a = await sessionApproval();
      await a.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "inspect-listeners" },
      });
      expect(await a.request({ toolName, risk, arguments: args })).toBe(false);
      expect(a.mutationCount).toBe(0);
    },
  );

  async function fixture() {
    const manifest = JSON.parse(
      await readFile(
        "integration/live-scenarios/native-playback-and-listen.json",
      ),
    );
    const binding = {
      listenerId: "native",
      passIds: new Set(["owned"]),
      contextIds: new Set(["context"]),
    };
    return createNativeScenarioApproval(manifest, binding);
  }
  const play = (args = {}) => ({
    toolName: "ableton_listening",
    risk: "reversible",
    arguments: {
      action: "play-arrangement-and-listen",
      listenerIds: ["native"],
      startBeat: 0,
      endBeat: 4,
      maximumDurationMs: 8000,
      ...args,
    },
  });
  const inspect = {
    toolName: "ableton_listening",
    risk: "read",
    arguments: { action: "inspect-listeners" },
  };
  it("requires discovery before exactly one bounded actor mutation", async () => {
    const f = await fixture();
    expect(await f.request(play())).toBe(false);
    expect(await f.request(inspect)).toBe(true);
    expect(await f.request(play())).toBe(true);
    expect(await f.request(play())).toBe(false);
    expect(f.mutationCount).toBe(1);
  });
  it.each([
    { listenerIds: ["old-unscoped"] },
    { listenerIds: ["native", "other"] },
    { startBeat: 1 },
    { endBeat: 20 },
    { maximumDurationMs: 8001 },
  ])("denies unsafe/widened playback %j", async (args) => {
    const f = await fixture();
    await f.request(inspect);
    expect(await f.request(play(args))).toBe(false);
  });
  it("bounds calls, historical queries, pass/context ownership and tool surface", async () => {
    const f = await fixture();
    expect(
      await f.request({
        toolName: "ableton_transport",
        risk: "reversible",
        arguments: { action: "set-playing", isPlaying: false },
      }),
    ).toBe(false);
    expect(
      await f.request({
        toolName: "ableton_listening",
        risk: "read",
        arguments: { action: "get-pass", passId: "foreign" },
      }),
    ).toBe(false);
    expect(
      await f.request({
        toolName: "ableton_context",
        risk: "read",
        arguments: {
          action: "get",
          contextId: "context",
          includeHistorical: false,
        },
      }),
    ).toBe(false);
    expect(
      await f.request({
        toolName: "ableton_context",
        risk: "read",
        arguments: {
          action: "get",
          contextId: "context",
          includeHistorical: true,
        },
      }),
    ).toBe(true);
    for (let i = f.decisions.length; i < 8; i++) await f.request(inspect);
    expect(await f.request(inspect)).toBe(false);
    expect(f.decisions.at(-1).reason).toBe("tool-call-budget");
  });
});
