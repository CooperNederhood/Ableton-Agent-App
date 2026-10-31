import { isDeepStrictEqual } from "node:util";
import { freezeSessionSourceExpectation } from "../../packages/runtime/dist/session-listening-source.js";

export const metricSmokePrompt =
  "Make these calls sequentially: inspect-listeners, exactly one play-session-and-listen for the supplied MIDI Session target with durationBeats 1, maximumDurationMs 30000 and only the supplied listener ID, then get-pass once with the returned passId. The runner explicitly requests level and attacks only, not spectrum. Use only the new v5 independent-metric pipeline. If a call fails, stop and report it: do not retry, repair, seek, stop playback, change settings, edit the Set or use another listener. After the first get-pass, if it is nonterminal, immediately finish your turn with pending. Never call get-pass twice, poll or wait: the harness owns the terminal wait. Only after completed may you get the context with includeHistorical=true. Leave playback running. Report measured level and attack availability without inventing frequency information or claiming exclusive clip audio.";

export const metricPartialSmokePrompt = metricSmokePrompt
  .replace(
    "level and attacks only, not spectrum",
    "level, spectral-centroid and attacks; spectral timing is deliberately unestablished and must be reported as unavailable",
  )
  .replace("Only after completed may", "Only after completed or partial may");
export const metricSpectrumSmokePrompt = metricSmokePrompt
  .replace(
    "level and attacks only, not spectrum",
    "level, spectral-centroid and attacks",
  )
  .replace(
    "Report measured level and attack availability without inventing frequency information or claiming exclusive clip audio.",
    "Report measured level, spectral-centroid and attack availability without claiming exclusive clip audio.",
  );

function mismatchPath(actual, expected, path = "observation") {
  if (isDeepStrictEqual(actual, expected)) return null;
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    for (const key of new Set([
      ...Object.keys(actual),
      ...Object.keys(expected),
    ])) {
      const mismatch = mismatchPath(
        actual[key],
        expected[key],
        `${path}.${key}`,
      );
      if (mismatch) return mismatch;
    }
  }
  return path.slice(0, 256);
}

export function verifyMetricPublishedObservation(
  raw,
  stored,
  sourceLimitations,
) {
  const expected = {
    ...raw,
    limitations: [...new Set([...raw.limitations, ...sourceLimitations])],
  };
  if (!isDeepStrictEqual(stored, expected))
    throw new Error(
      `Native terminal result mismatch: ${mismatchPath(stored, expected)}`,
    );
}

export function reviewNativeMetricScenario(manifest) {
  const partial = manifest.id === "native-metric-session-midi-partial-spectrum";
  const audio = manifest.id === "native-metric-session-audio-spectrum";
  const spectrum =
    audio || manifest.id === "native-metric-session-midi-spectrum";
  if (!partial && !spectrum && manifest.id !== "native-metric-session-midi")
    return undefined;
  const requestedMetrics =
    partial || spectrum
      ? ["level", "spectral-centroid", "attacks"]
      : ["level", "attacks"];
  const capture = {
    durationBeats: 1,
    maximumDurationMs: 30000,
    sceneIndex: 0,
  };
  const timingPolicy = {
    mode: "descriptive",
    maxClockDisagreementSamples: 64,
  };
  if (
    manifest.formatVersion !== 1 ||
    manifest.group !== "native-listening-metric" ||
    manifest.execution !== "native-listening-runtime" ||
    manifest.nativeVersion !== 5 ||
    manifest.mode !== "session" ||
    manifest.prompt !==
      (partial
        ? metricPartialSmokePrompt
        : spectrum
          ? audio
            ? metricSpectrumSmokePrompt.replace("MIDI Session", "audio Session")
            : metricSpectrumSmokePrompt
          : metricSmokePrompt) ||
    manifest.artifactPrefix !==
      (audio ? "AA_SMOKE_METRIC_AUDIO_" : "AA_SMOKE_METRIC_MIDI_") ||
    !isDeepStrictEqual(manifest.requestedMetrics, requestedMetrics) ||
    !isDeepStrictEqual(manifest.capture, capture) ||
    manifest.maxToolCalls !== 8 ||
    manifest.maxMutations !== 1 ||
    manifest.timeoutMs !== 90000 ||
    !isDeepStrictEqual(manifest.allowedTools, [
      "ableton_listening",
      "ableton_context",
    ]) ||
    !isDeepStrictEqual(manifest.allowedActions, {
      ableton_listening: [
        "inspect-listeners",
        "play-session-and-listen",
        "get-pass",
      ],
      ableton_context: ["get"],
    }) ||
    !isDeepStrictEqual(manifest.allowedRisks, ["read", "reversible"]) ||
    !isDeepStrictEqual(manifest.ordering, [
      {
        before: "ableton_listening",
        beforeAction: "inspect-listeners",
        after: "ableton_listening",
        afterAction: "play-session-and-listen",
      },
    ]) ||
    manifest.setupContract?.nativeVersion !== 5 ||
    manifest.setupContract?.inputOption !== "--native-v5-fixture-input" ||
    !isDeepStrictEqual(manifest.setupContract?.timingPolicy, timingPolicy) ||
    manifest.setupContract?.tempoPolicy !== "constant-tempo-assumed" ||
    manifest.setupContract?.tempoAutomationSupported !== false ||
    !isDeepStrictEqual(manifest.assertions, [
      "one-owned-pass-no-retries",
      partial
        ? "frozen-all-metrics-explicit-unknown-phase"
        : spectrum
          ? "frozen-all-metrics-proven-spectrum-phase"
          : "frozen-explicit-level-and-attacks",
      "actual-native-source-and-cleanup-proofs",
      "non-silent-independent-level-timeline",
      "one-persisted-context-readable-after-reopen",
      "unchanged-fixture-and-leave-running-idle",
    ])
  )
    throw new Error("Unreviewed metric listening scenario contract");
  return Object.freeze({
    nativeVersion: 5,
    mode: "session",
    session: true,
    sourceKind: audio ? "warped-audio" : "midi",
    sourceRegion: Object.freeze({
      startMarker: 0,
      loopStart: 0,
      loopEnd: audio ? 4 : 8,
    }),
    requestedMetrics: Object.freeze(requestedMetrics),
    expectedOutcome: partial ? "partial" : "complete",
    expectedSpectrum: spectrum,
    capture: Object.freeze({ ...capture, startBeat: 0, endBeat: 1 }),
    timingPolicy: Object.freeze(timingPolicy),
  });
}

export function verifyNativeMetricListeningEvidence(input, protocol) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const partial = input.expectedOutcome === "partial";
  const spectrumExpected = input.expectedSpectrum === true;
  const requestedMetrics =
    partial || spectrumExpected
      ? ["level", "spectral-centroid", "attacks"]
      : ["level", "attacks"];
  const {
    job,
    pass,
    entries,
    links,
    subjects,
    received,
    listener,
    owner,
    baseline,
    final,
    typed,
    resumed,
    target,
    expected,
    metricControls,
    session,
  } = input;
  check(
    job.stage === (partial ? "partial" : "completed") &&
      job.cleanupPolicy === "leave-running" &&
      job.contextIds.length === 1 &&
      pass?.id === job.passId &&
      pass.status === (partial ? "partial" : "completed") &&
      pass.complete === !partial &&
      pass.sessionId === owner.sessionId &&
      pass.liveSetId === owner.liveSetId &&
      pass.initiatorAgentId === owner.agentId &&
      isDeepStrictEqual(pass.listenerIds, [listener.producer.producerId]) &&
      isDeepStrictEqual(pass.requestedRange, { startBeat: 0, endBeat: 1 }) &&
      isDeepStrictEqual(pass.actualRange, { startBeat: 0, endBeat: 1 }) &&
      pass.requestedMode === "session" &&
      pass.actualMode === "session",
    "Metric pass ownership, exact range or completion mismatch",
  );
  check(
    entries.length === 1 && entries[0].id === job.contextIds[0],
    "Expected one atomic metric context",
  );
  const entry = entries[0];
  const observation = protocol.metricAudioObservationSchema.parse(
    entry.payload,
  );
  const prepare = metricControls.find(
    ({ input: control }) => control.action === "prepare",
  );
  const arm = metricControls.find(
    ({ input: control }) => control.action === "arm",
  );
  check(
    prepare?.reply.status === "ready" && arm?.reply.status === "armed",
    "Actual accepted prepare and arm receipts required",
  );
  const pin = protocol.snapshotNativeMetricListeningExpectation({
    ...prepare.reply.nativeReady.ownership,
    config: prepare.input.config,
  });
  check(
    pin.listenerId === listener.producer.producerId &&
      pin.passId === pass.id &&
      pin.connectionId === listener.connectionId &&
      pin.connectionEpoch === listener.registration.connectionEpoch &&
      pin.traceId === pass.trace.traceId &&
      pin.correlationId === pass.trace.correlationId &&
      pin.causationId === pass.trace.causationId &&
      isDeepStrictEqual(pin.config.requestedMetrics, requestedMetrics) &&
      isDeepStrictEqual(pin.config.source.target, session.target) &&
      pin.config.geometry.totalSamples === expected.geometry.totalSamples &&
      pin.config.geometry.tempoBpm === 120 &&
      pin.config.geometry.startBeat === expected.geometry.startBeat &&
      pin.config.geometry.endBeat === expected.geometry.endBeat,
    "Metric admission differs from the independently inspected source/owner",
  );
  check(
    received.length === 1,
    "Exactly one actual terminal native result required",
  );
  const event = received[0];
  for (const [field, matches] of Object.entries({
    connection: event.connectionId === listener.connectionId,
    producer: isDeepStrictEqual(event.producer, listener.producer),
    binding: isDeepStrictEqual(event.binding, listener.binding),
    status: event.result.status === (partial ? "partial" : "completed"),
    version: event.result.listenerVersion === 5,
    pass: event.result.passId === pass.id,
    arm: isDeepStrictEqual(
      event.result.nativeSourceCoverage.armed,
      arm.reply.nativeArm,
    ),
  }))
    check(matches, `Native terminal result mismatch: ${field}`);
  verifyMetricPublishedObservation(
    event.result.observation,
    observation,
    freezeSessionSourceExpectation(session.source, session.target, 1)
      .limitations,
  );
  protocol.assertNativeMetricObservationSource(
    event.result.nativeSourceCoverage,
    observation,
    pin,
  );
  check(
    entry.kind === "metric-audio-observation/v1" &&
      entry.passId === pass.id &&
      entry.sessionId === owner.sessionId &&
      entry.liveSetId === owner.liveSetId &&
      entry.producer.agentId === owner.agentId &&
      entry.producer.deviceId === target.binding.expectedDeviceReference &&
      entry.producer.listenerId === pin.listenerId &&
      entry.producer.connectionEpoch === pin.connectionEpoch &&
      isDeepStrictEqual(entry.trace, pass.trace) &&
      observation.outcome === (partial ? "partial" : "complete") &&
      observation.metrics.level.status === "complete" &&
      observation.metrics.attacks.status === "complete" &&
      (partial
        ? observation.metrics["spectral-centroid"].status === "failed" &&
          observation.metrics["spectral-centroid"].algorithm
            ?.firstFrameEndSample === null &&
          observation.metrics["spectral-centroid"].records.length === 0 &&
          observation.metrics["spectral-centroid"].gaps.length === 0 &&
          observation.rows.every(
            (row) => row["spectral-centroid"].availability === "unknown-phase",
          )
        : spectrumExpected
          ? observation.metrics["spectral-centroid"].status === "complete" &&
            observation.metrics["spectral-centroid"].algorithm
              ?.firstFrameEndSample !== null &&
            observation.metrics["spectral-centroid"].records.length > 0 &&
            observation.metrics["spectral-centroid"].records.length ===
              observation.metrics["spectral-centroid"].expectedRecords &&
            observation.metrics["spectral-centroid"].records.some(
              (record) => record.spectralEnergy > 0,
            ) &&
            event.result.nativeSourceCoverage.spectrumPhase !== undefined &&
            event.result.nativeSourceCoverage.spectrumCleanup?.status ===
              "completed"
          : observation.metrics["spectral-centroid"].status ===
            "not-requested") &&
      observation.metrics.level.records.length === 4 &&
      observation.metrics.level.records.some((record) =>
        record.rms.some((value) => value > 0),
      ) &&
      observation.metrics.level.records.reduce(
        (sum, record) =>
          sum + record.support.endSample - record.support.startSample,
        0,
      ) === expected.geometry.totalSamples &&
      observation.source.view === "session" &&
      isDeepStrictEqual(observation.source.target, session.target),
    "Metric context attribution, independent coverage or non-silent witness mismatch",
  );
  check(
    links.length === 2 &&
      subjects.length === 2 &&
      links.every(
        (link) =>
          link.entryId === entry.id &&
          link.sessionId === owner.sessionId &&
          link.liveSetId === owner.liveSetId &&
          link.attribution === "unknown" &&
          subjects.some(
            (subject) =>
              subject.id === link.subjectId &&
              subject.sessionId === owner.sessionId &&
              subject.liveSetId === owner.liveSetId,
          ),
      ) &&
      links.filter((link) => link.relationship === "primary").length === 1 &&
      links.filter((link) => link.relationship === "contributor").length ===
        1 &&
      subjects.some(
        (subject) =>
          subject.kind === "clip" &&
          subject.binding.previousRuntimeBindings.includes(
            session.target.expectedClipReference,
          ),
      ) &&
      subjects.some(
        (subject) =>
          subject.kind === "track" &&
          subject.binding.previousRuntimeBindings.includes(
            session.target.track.expectedReference,
          ),
      ),
    "Metric context associations changed source identity or attribution",
  );
  check(
    typed.action === "get" &&
      resumed.action === "get" &&
      typed.entry.contextId === entry.id &&
      resumed.entry.contextId === entry.id &&
      isDeepStrictEqual(typed.observation, observation) &&
      isDeepStrictEqual(resumed.observation, observation) &&
      isDeepStrictEqual(baseline, final),
    "Metric context reopen or immutable Set postcondition mismatch",
  );
  check(
    session.receipts.filter(({ params }) => params.action === "launch")
      .length === 1 &&
      session.receipts.at(-1)?.params.action === "release" &&
      session.receipts.at(-1)?.beforePublication === true,
    "Session source must launch once and release before publication",
  );
  return {
    passId: pass.id,
    contextId: entry.id,
    listenerId: pin.listenerId,
    schema: observation.schema,
    requestedMetrics: observation.requestedMetrics,
    totalSamples: expected.geometry.totalSamples,
    levelRows: observation.metrics.level.records.length,
    level: observation.metrics.level.records,
    attacks: observation.metrics.attacks.records,
    spectrum: observation.metrics["spectral-centroid"],
    spectrumPhase: event.result.nativeSourceCoverage.spectrumPhase ?? null,
    spectrumCleanup: event.result.nativeSourceCoverage.spectrumCleanup ?? null,
    source: observation.source,
    nativeEpoch: pin.nativeEpoch,
    nativeCleanup: "confirmed-before-terminal-result",
    savedAndReopened: true,
  };
}
