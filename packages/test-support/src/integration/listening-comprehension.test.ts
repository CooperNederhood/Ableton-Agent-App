import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import {
  metricRecordStreamDescriptorSchema,
  canonicalMetricRecordJson,
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  DEFAULT_LISTENING_TIMING_POLICY,
  sessionListeningPreflightResultSchema,
} from "@ableton-agent/protocol";
import { agentListeningFixture } from "./agent-listening-test-support.js";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import { createDefaultAssertions } from "./assertions.js";
import type {
  AssertionInput,
  CaptureEvidence,
  ContextEvidence,
  MidiSourceEvidence,
} from "./contracts.js";
import { midiContentIdentity } from "./sources.js";
import { streamProofContentSha256 } from "./arrangement-stream.js";

const pattern = "|1-2-3-4|1-1-1-1|2-2-2-2|3-3-3-3|4-4-4-4|";
const assertion = {
  name: "listening-comprehension",
  parameters: {
    sessionSourceIds: "clip-1,clip-2,clip-3,clip-4",
    arrangementSourceId: "arrangement",
    expectedPattern: pattern,
    hostSampleRate: 48_000,
  },
};
function fixture(): AssertionInput {
  const session = agentListeningFixture();
  const arrangement = arrangementTestEvidence();
  const source = session.input.baseline.sources!.a!;
  if (!("loadedMediaPath" in source))
    throw new Error("Expected synthetic audio source");
  const captures = Array.from({ length: 4 }, (_, index) => {
    const raw = createSyntheticMetricListeningObservation({
      endBeat: 4,
      tempoBpm: 128,
      startSample: 0,
    });
    const id = `clip-${index + 1}`;
    const passId = `00000000-0000-4000-8000-00000000001${index}`;
    const identity = {
      trackId: source.source.trackId,
      clipId: `00000000-0000-4000-8000-00000000003${index}`,
      slotIndex: index,
      midiNotesSha256: "a".repeat(64),
      instrumentChainSha256: "b".repeat(64),
    };
    const native = {
      connectionId: raw.ownership.connectionId,
      connectionEpoch: raw.ownership.connectionEpoch,
      generation: `00000000-0000-4000-8000-00000000002${index}`,
      nativeEpoch: index + 1,
    };
    raw.ownership = {
      ...raw.ownership,
      ...native,
      passId,
      traceId: session.owner.sdkTurnId,
      correlationId: session.owner.sdkTurnId,
      causationId: `cause-${index}`,
    };
    raw.source = {
      view: "session",
      kind: "midi",
      target: {
        view: "session",
        track: {
          kind: "regular",
          index: 0,
          expectedReference: identity.trackId,
          expectedName: "audio-track",
        },
        sceneIndex: index,
        expectedClipReference: identity.clipId,
        expectedClipName: id,
      },
      clipReference: identity.clipId,
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
      transport: { startBeat: 0, endBeat: 4 },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
    const observation = metricRecordStreamDescriptorSchema.parse({
      schema: "metric-record-stream/v1",
      capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
      ownership: raw.ownership,
      source: raw.source,
      geometry: createContinuousMetricListeningGeometry({
        captureMode: "finite-metric-stream",
        sampleRate: raw.geometry.sampleRate,
        vectorSize: raw.geometry.vectorSize,
        tempoBpm: raw.geometry.tempoBpm,
        startBeat: raw.geometry.startBeat,
        endBeat: raw.geometry.endBeat,
        startSample: raw.geometry.startSample,
      }),
      timingPolicy: DEFAULT_LISTENING_TIMING_POLICY,
      requestedMetrics: raw.requestedMetrics,
      algorithms: (["level", "spectral-centroid", "attacks"] as const).map(
        (metric) => ({
          metric,
          availability: "available",
          unavailableReason: null,
          algorithm: raw.metrics[metric]?.algorithm,
        }),
      ),
      maxPendingChunks: 8,
    });
    const stream = {
      contextId: `context-${index}`,
      passId,
      listenerId: raw.ownership.listenerId,
      descriptorDigest: createHash("sha256")
        .update(canonicalMetricRecordJson(observation))
        .digest("hex"),
      manifestSha256: "c".repeat(64),
      recordsSha256: "d".repeat(64),
      chunkCount: 6,
      afterOwnedRestart: false,
    };
    return {
      ...session.turn.captures[0]!,
      passId,
      source: identity,
      listenerId: raw.ownership.listenerId,
      native,
      observation,
      stream,
      toolCausationId: raw.ownership.causationId,
      metricFamilies: [...raw.requestedMetrics],
    };
  });
  const contexts: ContextEvidence[] = captures.map((capture, index) => ({
    ...session.turn.contexts[0]!,
    contextId: `context-${index}`,
    passId: capture.passId,
    source: capture.source,
    contentSha256: streamProofContentSha256(capture.stream),
  }));
  const sources = Object.fromEntries(
    captures.map((capture, index) => {
      const observation = capture.observation;
      if (observation.source.view !== "session")
        throw new Error("Expected Session source");
      const device = {
        reference: "00000000-0000-4000-8000-000000000099",
        trackReference: capture.source.trackId,
        trackIndex: 0,
        index: 0,
        name: "Listener",
        className: "MxDeviceAudioEffect",
        classDisplayName: "Max Audio Effect",
        enabled: true,
        parameterCount: 0,
        canHaveChains: false,
        canHaveDrumPads: false,
      };
      const inventory = { devices: [device], total: 1, offset: 0, limit: 8 };
      const state = {
        transportPlaying: false,
        globalBeat: 72,
        startTimeBeats: 0,
        playingPosition: 0,
        targetPlaying: false,
        targetTriggered: false,
        targetRecording: false,
        playingSlotIndex: -1,
        firedSlotIndex: -1,
        selectedClipReference: null,
      };
      const midi = sessionListeningPreflightResultSchema.parse({
        source: {
          schemaVersion: 1,
          queryId: capture.source.clipId,
          projectRevision: 0,
          evidence: "message-rate-only",
          nativeAlignment: "unverified",
          sourceKind: "midi",
          positionUnit: "beats",
          target: observation.source.target,
          before: state,
          after: state,
          settings: {
            tempoBpm: 128,
            signatureNumerator: 4,
            signatureDenominator: 4,
            clipSignatureNumerator: 4,
            clipSignatureDenominator: 4,
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
            reference: capture.source.clipId,
            name: `clip-${index + 1}`,
            trackReference: capture.source.trackId,
            trackIndex: 0,
            sceneIndex: index,
            length: 4,
            noteCount: 1,
          },
          notes: [
            {
              pitch: 60,
              startTime: 0,
              duration: 4,
              velocity: 100,
              mute: false,
            },
          ],
          offset: 0,
          limit: 2048,
          totalNotes: 1,
          truncated: false,
        },
        instrumentChain: {
          before: inventory,
          after: inventory,
          devices: [
            { device, parameters: [], total: 0, offset: 0, limit: 256 },
          ],
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
      });
      if (!("midi" in midi)) throw new Error("Expected MIDI preflight");
      const placement = {
        trackIndex: 0,
        deviceIndex: 0,
        deviceReference: device.reference,
      };
      const hashes = midiContentIdentity(midi, placement);
      Object.assign(capture.source, hashes);
      return [
        `clip-${index + 1}`,
        {
          source: capture.source,
          listenerId: capture.listenerId,
          midi,
          listenerPlacement: placement,
          facts: {
            trackName: "audio-track",
            trackIndex: 0,
            sceneIndex: index,
            clipName: `clip-${index + 1}`,
          },
        } satisfies MidiSourceEvidence,
      ];
    }),
  );
  const endBeat = 80;
  const clips = [
    {
      savedClipId: "1",
      mediaTarget: "media/resource-001.aif",
      startBeat: 0,
      endBeat,
    },
  ];
  const definition = {
    ...arrangement.definition,
    id: "arrangement",
    endBeat,
    clips,
  };
  const baseline = {
    ...arrangement.baseline,
    source: {
      ...arrangement.baseline.source,
      endBeat,
      clips: [{ ...arrangement.baseline.source.clips[0]!, endBeat }],
    },
    savedClips: clips,
  };
  const passId = "arrangement-pass";
  const stream = {
    contextId: "arrangement-context",
    passId,
    listenerId: baseline.listenerId,
    descriptorDigest: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    recordsSha256: "c".repeat(64),
    chunkCount: 6,
    afterOwnedRestart: false,
  };
  const arrangementCapture = {
    ...arrangement.capture,
    passId,
    stream,
    operationId: session.turn.operationId,
    traceId: session.owner.sdkTurnId,
    correlationId: session.owner.sdkTurnId,
    source: baseline.source,
    endSample: 1_800_000,
    spectralCentroidFirstFrameEndSample: 2048,
    metrics: Object.entries({
      level: 320,
      "spectral-centroid": 878,
      attacks: 375,
      "mel-bands": 878,
      pitch: 878,
      "spectral-shape": 878,
    }).map(([name, count]) => ({
      ...arrangement.capture.metrics[0]!,
      name,
      passId,
      source: baseline.source,
      endSample: 1_800_000,
      expectedRecords: count,
      receivedRecords: count,
    })),
    cleanup: { ...arrangement.capture.cleanup, transportPlaying: true },
  };
  const baseTurn = { ...session.turn };
  delete baseTurn.agentListening;
  const turn = {
    ...baseTurn,
    captures,
    contexts,
    assistantText: pattern,
    arrangementCaptures: [arrangementCapture],
    facts: {
      ...session.turn.facts,
      "arrangement.captureCausationId": arrangementCapture.causationId,
    },
  };
  return {
    ...session.input,
    fixture: {
      ...arrangement.fixture,
      listenerBindings: [
        ...arrangement.fixture.listenerBindings!,
        {
          slot: "MidiTrack:1/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
          sourcePath: "listener.amxd",
          dependency: "machine-listening",
          trackIndex: 0,
          deviceIndex: 0,
        },
      ],
      arrangementSources: [definition],
      sources: captures.map((capture, index) => ({
        id: `clip-${index + 1}`,
        trackName: "audio-track",
        clipName: `clip-${index + 1}`,
        trackIndex: 0,
        sceneIndex: index,
        listenerBindingSlot:
          "MidiTrack:1/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
        midi: {
          notesSha256: capture.source.midiNotesSha256,
          instrumentChainSha256: capture.source.instrumentChainSha256,
        },
      })),
    },
    baseline: {
      ...session.input.baseline,
      sources,
      arrangementSources: { arrangement: baseline },
    },
    turns: [turn],
    turn,
    evidence: {
      schemaVersion: 1,
      contexts,
      capturePassIds: [...captures.map((capture) => capture.passId), passId],
      facts: {},
      arrangementContexts: [stream],
      unchanged: [
        "session-structure",
        "source-settings",
        "fixture-media",
        "unrelated-playback",
        "project-file",
      ].map((scope) => ({
        scope,
        beforeSha256: "a".repeat(64),
        afterSha256: "a".repeat(64),
      })),
    },
  };
}
const evaluate = (input: AssertionInput) =>
  createDefaultAssertions().evaluate(assertion, input);
describe("one-turn mixed listening comprehension", () => {
  it("accepts exactly four original Session contexts and one complete Arrangement stream", () => {
    expect(evaluate(fixture()).passed).toBe(true);
    const input = fixture();
    const finalInput = { ...input };
    delete finalInput.turn;
    expect(evaluate(finalInput).passed).toBe(true);
  });
  it("checks original turn proofs before final collection, but never permits missing final evidence", () => {
    const stepInput = { ...fixture() };
    delete stepInput.evidence;
    expect(evaluate(stepInput).passed).toBe(true);
    delete stepInput.turn;
    expect(evaluate(stepInput).passed).toBe(false);
  });
  it.each([
    pattern.replace("1-2", "2-1"),
    pattern.replace("1-2", "1 -2"),
    pattern.slice(1),
    "|1-2-3|",
    pattern.replace("|2-2-2-2|", ""),
    `${pattern}\n${pattern}`,
    `${pattern} or ${pattern.replace("1-2", "2-1")}`,
    `${pattern.replace("1-2", "2-1")}\n${pattern}`,
    `${pattern}1-1-1-1|`,
    `|1-2-3-A${pattern}`,
    `|1-2-\n${pattern}`,
    "The sequence is clear, but no sequence block is provided.",
  ])("rejects incorrect or malformed answer %s", (assistantText) => {
    const input = fixture();
    const turn = { ...input.turn!, assistantText };
    expect(evaluate({ ...input, turn, turns: [turn] }).passed).toBe(false);
  });
  it("trims outer whitespace only", () => {
    const input = fixture();
    const turn = { ...input.turn!, assistantText: ` \n${pattern}\n` };
    expect(evaluate({ ...input, turn, turns: [turn] }).passed).toBe(true);
  });
  it.each([
    `Answer: ${pattern}`,
    `\`${pattern}\``,
    `The last three bars match clip-4.\n\n${pattern}`,
    `${pattern}\n\nThe captures support this sequence.`,
    `\`\`\`text\n${pattern}\n\`\`\``,
  ])(
    "accepts explanatory text around one exact sequence: %s",
    (assistantText) => {
      const input = fixture();
      const turn = { ...input.turn!, assistantText };
      expect(evaluate({ ...input, turn, turns: [turn] }).passed).toBe(true);
    },
  );
  it("does not prescribe discovery, capture enumeration order or report reading", () => {
    const input = fixture();
    const turn = {
      ...input.turn!,
      captures: [...input.turn!.captures].reverse(),
      contexts: [...input.turn!.contexts].reverse(),
    };
    expect(evaluate({ ...input, turn, turns: [turn] }).passed).toBe(true);
  });
  it.each([
    "missing",
    "extra",
    "wrong-source",
    "failed",
    "cancelled",
    "cleanup",
    "context",
    "trace",
    "causation",
    "session-causation",
    "native",
    "observation",
    "arrangement-cleanup",
    "arrangement-failed",
    "arrangement-source",
    "arrangement-extra",
    "hidden-job",
    "protected",
  ])("rejects %s evidence despite a correct answer", (mode) => {
    const input = fixture();
    const original = {
      ...input.turn!,
      assistantText: `The recordings support this sequence:\n${pattern}`,
    };
    let captures: readonly CaptureEvidence[] = original.captures;
    if (mode === "missing") captures = captures.slice(1);
    if (mode === "extra") captures = [...captures, captures[0]!];
    if (mode === "wrong-source")
      captures = [
        { ...captures[0]!, source: captures[1]!.source },
        ...captures.slice(1),
      ];
    if (mode === "failed")
      captures = [
        { ...captures[0]!, failure: "native_failed" },
        ...captures.slice(1),
      ];
    if (mode === "cleanup")
      captures = [
        { ...captures[0]!, cleanupComplete: false },
        ...captures.slice(1),
      ];
    if (mode === "session-causation")
      captures = [
        { ...captures[0]!, toolCausationId: "foreign" },
        ...captures.slice(1),
      ];
    if (mode === "observation") {
      const capture = { ...captures[0]! };
      delete capture.observation;
      captures = [capture, ...captures.slice(1)];
    }
    if (mode === "native") {
      const capture = { ...captures[0]! };
      delete capture.native;
      captures = [capture, ...captures.slice(1)];
    }
    const arrangement = original.arrangementCaptures![0]!;
    const turn = {
      ...original,
      captures,
      arrangementCaptures:
        mode === "arrangement-cleanup"
          ? [
              {
                ...arrangement,
                cleanup: { ...arrangement.cleanup, sourceRestored: false },
              },
            ]
          : mode === "arrangement-failed"
            ? [{ ...arrangement, failure: "native_failed" }]
            : mode === "arrangement-source"
              ? [
                  {
                    ...arrangement,
                    source: { ...arrangement.source, trackId: "foreign" },
                  },
                ]
              : mode === "arrangement-extra"
                ? [arrangement, arrangement]
                : original.arrangementCaptures!,
      status: mode === "cancelled" ? ("cancelled" as const) : original.status,
      contexts:
        mode === "context" ? original.contexts.slice(1) : original.contexts,
      facts:
        mode === "trace"
          ? { ...original.facts, sdkTurnId: "foreign" }
          : mode === "causation"
            ? { ...original.facts, "arrangement.captureCausationId": "foreign" }
            : original.facts,
    };
    const evidence = input.evidence!;
    expect(
      evaluate({
        ...input,
        turn,
        turns: [turn],
        evidence: {
          ...evidence,
          capturePassIds:
            mode === "hidden-job"
              ? [...evidence.capturePassIds!, "failed-unpublished"]
              : evidence.capturePassIds!,
          unchanged:
            mode === "protected"
              ? evidence.unchanged.slice(1)
              : evidence.unchanged,
        },
      }).passed,
    ).toBe(false);
  });
});
