import { createHash } from "node:crypto";
import {
  createContinuousMetricListeningGeometry,
  metricAudioObservationSchema,
} from "@ableton-agent/protocol";
import type { AssertionInput, Facts } from "./contracts.js";
import { sameSource } from "./assertions.js";
import {
  validateFixtureSourceEvidence,
  validateMidiSourcePreconditions,
} from "./sources.js";
import {
  verifyArrangementCapture,
  verifyArrangementSource,
} from "./arrangement.js";
import {
  identifier,
  rejectUnknownFields,
  requireCondition,
  validateArrangementStreamProof,
} from "./validation.js";

export function validateListeningComprehension(parameters: Facts): void {
  rejectUnknownFields(parameters, [
    "sessionSourceIds",
    "arrangementSourceId",
    "expectedPattern",
    "hostSampleRate",
  ]);
  requireCondition(
    typeof parameters.sessionSourceIds === "string",
    "Missing Session source IDs",
  );
  const ids = parameters.sessionSourceIds.split(",");
  requireCondition(
    ids.length === 4 && new Set(ids).size === 4,
    "Declare four distinct Session sources",
  );
  ids.forEach(identifier);
  identifier(parameters.arrangementSourceId);
  requireCondition(
    !ids.includes(String(parameters.arrangementSourceId)),
    "Mixed source IDs collide",
  );
  requireCondition(
    typeof parameters.expectedPattern === "string" &&
      /^\|(?:[1-4](?:-[1-4]){3}\|){5}$/u.test(parameters.expectedPattern),
    "Expected pattern requires twenty measures in five groups of four",
  );
  requireCondition(
    parameters.hostSampleRate === 48_000,
    "Comprehension requires independently verified 48 kHz host evidence",
  );
}

/** Compose original native proofs; the oracle never authorizes or repairs a capture. */
export function verifyListeningComprehension(
  input: AssertionInput,
  parameters: Facts,
): void {
  validateListeningComprehension(parameters);
  const ids = String(parameters.sessionSourceIds).split(",");
  const sourceId = String(parameters.arrangementSourceId);
  requireCondition(
    input.turns.length === 1,
    "Comprehension requires exactly one conversation turn",
  );
  requireCondition(
    input.turn || input.evidence,
    "Missing final comprehension evidence",
  );
  const turn = input.turns[0]!;
  requireCondition(
    (!input.turn || input.turn.operationId === turn.operationId) &&
      turn.status === "completed" &&
      turn.terminal &&
      turn.assistantText.trim() === parameters.expectedPattern,
    "Incorrect comprehension answer or noncompleted turn",
  );
  requireCondition(
    turn.captures.length === 4 && turn.arrangementCaptures?.length === 1,
    "Comprehension requires exactly five successful listens",
  );
  requireCondition(
    typeof turn.facts.sdkTurnId === "string",
    "Missing attributable SDK turn",
  );
  const generations = new Set<string>();
  const connections = new Map<
    string,
    NonNullable<(typeof turn.captures)[number]["native"]>
  >();
  const nativeEpochs = new Set<string>();
  const causes = new Set<string>();
  const contextIds = new Set<string>();
  const passIds = new Set<string>();
  requireCondition(
    turn.contexts.length === 4,
    "Each Session listen requires one distinct original context",
  );
  requireCondition(
    input.fixture.sources?.length === 4 &&
      Object.keys(input.baseline.sources ?? {}).length === 4 &&
      input.fixture.arrangementSources?.length === 1 &&
      Object.keys(input.baseline.arrangementSources ?? {}).length === 1,
    "Unexpected or missing admitted source inventory",
  );
  for (const id of ids) {
    const baseline = input.baseline.sources?.[id];
    const definition = input.fixture.sources?.find(
      (source) => source.id === id,
    );
    requireCondition(
      baseline &&
        definition &&
        "midi" in definition &&
        "midi" in baseline &&
        definition.trackIndex === 0 &&
        definition.sceneIndex === ids.indexOf(id),
      "Missing admitted MIDI Session source",
    );
    validateFixtureSourceEvidence(input.fixture, definition, baseline);
    validateMidiSourcePreconditions(input.fixture, baseline);
    const matches = turn.captures.filter(
      (capture) =>
        sameSource(capture.source, baseline.source) &&
        capture.listenerId === baseline.listenerId,
    );
    requireCondition(
      matches.length === 1,
      "Missing, duplicate or wrong-source Session capture",
    );
    const capture = matches[0]!;
    const observation = metricAudioObservationSchema.parse(capture.observation);
    const native = capture.native;
    requireCondition(
      native && !generations.has(native.generation),
      "Missing or reused native Session generation",
    );
    generations.add(native.generation);
    const prior = connections.get(capture.listenerId);
    const epochKey = `${capture.listenerId}:${native.nativeEpoch}`;
    requireCondition(
      !nativeEpochs.has(epochKey) &&
        (!prior ||
          (prior.connectionId === native.connectionId &&
            prior.connectionEpoch === native.connectionEpoch)),
      "Session listener connection changed or native epoch was reused",
    );
    nativeEpochs.add(epochKey);
    connections.set(capture.listenerId, native);
    const source = observation.source;
    requireCondition(
      source.view === "session" &&
        source.kind === "midi" &&
        source.target.track.expectedReference === baseline.source.trackId &&
        source.clipReference === baseline.source.clipId &&
        source.target.expectedClipReference === baseline.source.clipId &&
        source.target.sceneIndex === baseline.source.slotIndex &&
        source.target.track.index === 0 &&
        source.coordinate.startBeat === 0 &&
        source.coordinate.endBeat === 4,
      "Original Session observation has a different source or range",
    );
    requireCondition(
      capture.operationId === turn.operationId &&
        capture.complete &&
        capture.nonSilent &&
        !capture.truncated &&
        capture.missingRecords === 0 &&
        capture.cleanupComplete &&
        capture.failure === null &&
        capture.sampleRate === 48_000 &&
        capture.endSample - capture.startSample === 90_000 &&
        observation.outcome === "complete" &&
        observation.reduction.mode === "none" &&
        observation.geometry.sampleRate === 48_000 &&
        observation.geometry.tempoBpm === 128 &&
        observation.geometry.endSample - observation.geometry.startSample ===
          90_000 &&
        observation.geometry.startSample === capture.startSample &&
        observation.sourceCoverage.endSample === capture.endSample &&
        observation.ownership.passId === capture.passId &&
        observation.ownership.listenerId === capture.listenerId &&
        observation.ownership.traceId === turn.facts.sdkTurnId &&
        observation.ownership.correlationId === turn.facts.sdkTurnId &&
        capture.toolCausationId === observation.ownership.causationId &&
        Object.entries(native).every(
          ([key, value]) => Reflect.get(observation.ownership, key) === value,
        ) &&
        ["level", "spectral-centroid", "attacks"].every((metric) =>
          capture.metricFamilies.includes(metric),
        ) &&
        observation.requestedMetrics.every(
          (metric) =>
            observation.metrics[metric]?.status === "complete" &&
            capture.metricFamilies.includes(metric),
        ),
      "Session native outcome, coverage, ownership or cleanup differs",
    );
    requireCondition(
      !causes.has(observation.ownership.causationId),
      "Session capture tool call was reused",
    );
    causes.add(observation.ownership.causationId);
    const contexts = turn.contexts.filter(
      (entry) => entry.passId === capture.passId,
    );
    requireCondition(
      contexts.length === 1,
      "Missing or duplicate Session context",
    );
    const context = contexts[0]!;
    const retained = input.evidence?.contexts.filter(
      (entry) => entry.contextId === context.contextId,
    );
    requireCondition(
      context.readable &&
        !context.afterOwnedRestart &&
        sameSource(context.source, baseline.source) &&
        context.contentSha256 ===
          createHash("sha256")
            .update(JSON.stringify(observation))
            .digest("hex") &&
        (!input.evidence ||
          (retained?.length === 1 &&
            JSON.stringify(retained[0]) === JSON.stringify(context))) &&
        !contextIds.has(context.contextId) &&
        !passIds.has(capture.passId),
      "Session context is unreadable, reused or differs from its original native content",
    );
    contextIds.add(context.contextId);
    passIds.add(capture.passId);
  }
  const definition = input.fixture.arrangementSources?.find(
    (source) => source.id === sourceId,
  );
  const baseline = input.baseline.arrangementSources?.[sourceId];
  requireCondition(
    definition &&
      baseline &&
      definition.trackIndex === 1 &&
      definition.startBeat === 0 &&
      definition.endBeat === 80 &&
      definition.tempoBpm === 128,
    "Missing complete twenty-measure Arrangement source",
  );
  verifyArrangementSource(input.fixture, definition, baseline);
  const capture = turn.arrangementCaptures[0]!;
  const stream = capture.stream;
  requireCondition(
    stream && !passIds.has(capture.passId) && !contextIds.has(stream.contextId),
    "Missing or reused Arrangement stream proof",
  );
  validateArrangementStreamProof(stream);
  requireCondition(
    stream.passId === capture.passId &&
      stream.listenerId === baseline.listenerId &&
      !stream.afterOwnedRestart,
    "Arrangement stream proof ownership differs",
  );
  const retained = input.evidence?.arrangementContexts;
  requireCondition(
    !input.evidence ||
      (retained?.length === 1 &&
        JSON.stringify(retained[0]) === JSON.stringify(stream)),
    "Missing retained original Arrangement records",
  );
  requireCondition(
    typeof turn.facts["arrangement.captureCausationId"] === "string",
    "Missing Arrangement tool causation",
  );
  requireCondition(
    !causes.has(turn.facts["arrangement.captureCausationId"]),
    "Arrangement capture reused a Session tool call",
  );
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "arrangement-continuous",
    sampleRate: 48_000,
    vectorSize: 64,
    tempoBpm: 128,
    startBeat: 0,
    endBeat: 80,
    startSample: capture.startSample,
  });
  verifyArrangementCapture(capture, baseline, {
    operationId: turn.operationId,
    traceId: turn.facts.sdkTurnId,
    causationId: turn.facts["arrangement.captureCausationId"],
    tempoBpm: 128,
    hostSampleRate: 48_000,
    playbackAfterCapture: "playing",
    metricRecords: {
      level: geometry.rows.length,
      "spectral-centroid": "verified-fft-phase",
      attacks: Math.ceil(geometry.totalSamples / 4800),
      "mel-bands": Math.floor(geometry.totalSamples / 2048),
      pitch: Math.floor(geometry.totalSamples / 2048),
      "spectral-shape": Math.floor(geometry.totalSamples / 2048),
    },
  });
  passIds.add(capture.passId);
  if (!input.evidence) return;
  const inventory = input.evidence?.capturePassIds;
  requireCondition(
    inventory?.length === 5 &&
      new Set(inventory).size === 5 &&
      inventory.every((id) => passIds.has(id)),
    "Complete run inventory includes missing, extra or nonterminal listening jobs",
  );
  requireCondition(
    input.evidence?.contexts.length === 4,
    "Unexpected retained Session contexts",
  );
  for (const scope of [
    "session-structure",
    "source-settings",
    "fixture-media",
    "unrelated-playback",
    "project-file",
  ]) {
    const records = input.evidence?.unchanged.filter(
      (entry) => entry.scope === scope,
    );
    requireCondition(
      records?.length === 1 &&
        /^[a-f0-9]{64}$/u.test(records[0]!.beforeSha256) &&
        records[0]!.beforeSha256 === records[0]!.afterSha256,
      "Protected source, Set or unrelated playback changed",
    );
  }
}
