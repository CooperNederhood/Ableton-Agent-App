import { isDeepStrictEqual } from "node:util";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyNativeListeningEvidence(input, protocol) {
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
  } = input;
  const expected =
    input.expected === undefined
      ? undefined
      : protocol.snapshotNativeListeningExpectationV2(input.expected);
  const requestedRange = expected
    ? {
        startBeat: expected.geometry.startBeat,
        endBeat: expected.geometry.endBeat,
      }
    : { startBeat: 0, endBeat: 4 };
  const actualRange = expected
    ? {
        startBeat: expected.geometry.startBeat,
        endBeat:
          expected.geometry.startBeat +
          expected.geometry.totalSamples /
            ((expected.geometry.sampleRate * 60) / expected.geometry.tempoBpm),
      }
    : requestedRange;
  const expectedSamples = expected?.geometry.totalSamples ?? 96000;
  const expectedWindows = expected
    ? Math.ceil(expectedSamples / expected.geometry.hopSamples)
    : 20;
  const expectedRate = expected?.geometry.sampleRate ?? 48000;
  requireValue(
    job.stage === "completed" &&
      job.cleanupPolicy === "leave-running" &&
      job.contextIds.length === 1,
    "Listening pass did not complete with owned leave-running cleanup",
  );
  requireValue(
    pass?.id === job.passId &&
      pass.status === "completed" &&
      pass.complete &&
      pass.sessionId === owner.sessionId &&
      pass.liveSetId === owner.liveSetId &&
      pass.initiatorAgentId === owner.agentId &&
      isDeepStrictEqual(pass.listenerIds, [listener.producer.producerId]) &&
      isDeepStrictEqual(pass.requestedRange, requestedRange) &&
      isDeepStrictEqual(pass.actualRange, actualRange) &&
      pass.requestedMode === "arrangement" &&
      pass.actualMode === "arrangement",
    "Persisted pass ownership or exact Arrangement coverage mismatch",
  );
  requireValue(
    entries.length === 1 && entries[0].id === job.contextIds[0],
    "Expected exactly one atomic context entry",
  );
  const entry = entries[0];
  const observation = (
    expected
      ? protocol.audioObservationV2Schema
      : protocol.audioObservationSchema
  ).parse(entry.payload);
  if (expected)
    requireValue(
      entry.kind === "audio-observation/v2" &&
        listener.registration.version === 2 &&
        listener.producer.schemaVersion === "audio-observation/v2" &&
        expected.listenerId === listener.producer.producerId &&
        expected.passId === pass.id,
      "Descriptive verification requires explicit matching App expectation and version",
    );
  requireValue(
    entry.passId === pass.id &&
      entry.producer.deviceId === target.binding.expectedDeviceReference &&
      entry.sessionId === owner.sessionId &&
      entry.liveSetId === owner.liveSetId &&
      entry.producer.agentId === owner.agentId &&
      entry.producer.listenerId === listener.producer.producerId &&
      entry.producer.connectionEpoch ===
        listener.registration.connectionEpoch &&
      observation.passId === pass.id &&
      observation.listenerId === listener.producer.producerId &&
      isDeepStrictEqual(entry.trace, pass.trace),
    "Context attribution or trace mismatch",
  );
  requireValue(
    received.length === 1,
    "Expected one exact native terminal result, not queued acceptance",
  );
  const event = received[0];
  requireValue(
    event.connectionId === listener.connectionId &&
      isDeepStrictEqual(event.producer, listener.producer) &&
      isDeepStrictEqual(event.binding, listener.binding) &&
      event.result.status === "completed" &&
      event.result.passId === pass.id &&
      event.result.connectionEpoch === listener.registration.connectionEpoch &&
      event.result.traceId === pass.trace.traceId &&
      event.result.correlationId === pass.trace.correlationId &&
      event.result.causationId === pass.trace.causationId &&
      isDeepStrictEqual(event.result.observation, observation),
    "Native result connection/causation mismatch",
  );
  const proof = (
    expected
      ? protocol.nativeCaptureProofV2Schema
      : protocol.nativeCaptureProofSchema
  ).parse(event.result.nativeCapture);
  if (expected) {
    requireValue(
      event.result.listenerVersion === 2,
      "Native result version mismatch",
    );
    protocol.assertNativeCaptureObservationV2(proof, observation, expected);
  } else protocol.assertNativeCaptureObservation(proof, observation);
  requireValue(
    proof.armed.before.frames.length === 32 &&
      proof.after.frames.length === 32 &&
      proof.spectralWindows.length === expectedWindows &&
      observation.samples.length === expectedWindows &&
      observation.sampleRate === expectedRate &&
      observation.endSample - observation.startSample === expectedSamples &&
      observation.startBeat === actualRange.startBeat &&
      observation.endBeat === actualRange.endBeat &&
      observation.complete &&
      !observation.reduction.truncated &&
      (expected !== undefined || observation.attacks.length === 4),
    "Incomplete native sample/window/attack coverage",
  );
  requireValue(
    links.length === 2 && subjects.length === 2,
    "Expected only primary range and contributor track links",
  );
  for (const link of links) {
    const subject = subjects.find((item) => item.id === link.subjectId);
    requireValue(
      link.entryId === entry.id &&
        subject !== undefined &&
        link.sessionId === owner.sessionId &&
        link.liveSetId === owner.liveSetId &&
        subject.sessionId === owner.sessionId &&
        subject.liveSetId === owner.liveSetId &&
        subject.trackId === target.binding.track.expectedReference &&
        subject.binding.semanticLocator.trackId ===
          target.binding.track.expectedReference &&
        isDeepStrictEqual(link.coverage, actualRange) &&
        link.attribution === "unknown" &&
        link.freshness.status === "unknown" &&
        ((link.relationship === "primary" &&
          subject.kind === "arrangement-range" &&
          isDeepStrictEqual(
            subject.binding.semanticLocator.arrangementRange,
            requestedRange,
          )) ||
          (link.relationship === "contributor" && subject.kind === "track")),
      "Context association promoted unknown attribution/freshness or claimed exclusive clip audio",
    );
  }
  requireValue(
    links.filter((item) => item.relationship === "primary").length === 1 &&
      links.filter((item) => item.relationship === "contributor").length === 1,
    "Atomic context associations mismatch",
  );
  requireValue(
    typed.action === "get" &&
      resumed.action === "get" &&
      typed.entry.contextId === entry.id &&
      resumed.entry.contextId === entry.id &&
      typed.entry.passId === pass.id &&
      resumed.entry.passId === pass.id &&
      typed.entry.listenerId === observation.listenerId &&
      resumed.entry.listenerId === observation.listenerId &&
      typed.entry.freshness === "unknown" &&
      resumed.entry.freshness === "unknown" &&
      isDeepStrictEqual(typed.observation, observation) &&
      isDeepStrictEqual(resumed.observation, observation),
    "Typed historical retrieval/reopen mismatch",
  );
  requireValue(
    isDeepStrictEqual(baseline, final),
    "The listening scenario mutated the Set",
  );
  return {
    passId: pass.id,
    contextId: entry.id,
    listenerId: observation.listenerId,
    startBeat: actualRange.startBeat,
    endBeat: actualRange.endBeat,
    sampleRate: expectedRate,
    stereoFrames: expectedSamples,
    envelopeWindows: expectedWindows,
    spectralWindows: expectedWindows,
    beforeFrames: 32,
    afterFrames: 32,
    estimatedAttacks: observation.attacks.length,
    ...(expected
      ? {
          alignment: observation.alignment,
          requestedRange,
          observationSchema: observation.schema,
        }
      : {}),
    attribution: "unknown",
    freshness: "unknown",
    cleanupPolicy: "leave-running",
    independentlyAcceptedNativeProof: true,
  };
}

export function createNativeScenarioApproval(manifest, binding) {
  const decisions = [];
  let mutationCount = 0;
  const request = async (approval) => {
    const { toolName, arguments: args, risk } = approval;
    let reason = "reviewed";
    if (decisions.length >= manifest.maxToolCalls) reason = "tool-call-budget";
    else if (
      !manifest.allowedTools.includes(toolName) ||
      !manifest.allowedRisks.includes(risk) ||
      !manifest.allowedActions[toolName]?.includes(args?.action)
    )
      reason = "unreviewed-tool-action-risk";
    else if (
      toolName === "ableton_listening" &&
      args.action === "play-arrangement-and-listen"
    ) {
      if (
        !decisions.some(
          (item) =>
            item.approved && item.arguments.action === "inspect-listeners",
        )
      )
        reason = "inspection-required-before-playback";
      else if (
        mutationCount !== 0 ||
        args.startBeat !== 0 ||
        args.endBeat !== 4 ||
        args.maximumDurationMs !== 8000 ||
        !isDeepStrictEqual(args.listenerIds, [binding.listenerId])
      )
        reason = "exact-listener-range-budget";
      else mutationCount++;
    } else if (
      toolName === "ableton_listening" &&
      ["get-pass", "cancel"].includes(args.action) &&
      !binding.passIds.has(args.passId)
    )
      reason = "unowned-pass";
    else if (
      toolName === "ableton_listening" &&
      args.action === "list-passes" &&
      (args.cursor !== undefined || (args.limit ?? 20) > 20)
    )
      reason = "bounded-owned-pass-query";
    else if (
      toolName === "ableton_context" &&
      (args.includeHistorical !== true ||
        args.cursor !== undefined ||
        (args.limit ?? 20) > 20 ||
        args.subjectId !== undefined ||
        (args.listenerId !== undefined &&
          args.listenerId !== binding.listenerId) ||
        (args.passId !== undefined && !binding.passIds.has(args.passId)) ||
        (args.action === "get" && !binding.contextIds.has(args.contextId)))
    )
      reason = "bounded-owned-historical-context-query";
    const decision = {
      sequence: decisions.length + 1,
      toolName,
      risk,
      arguments: args,
      approved: reason === "reviewed",
      reason,
    };
    decisions.push(decision);
    return decision.approved;
  };
  return {
    decisions,
    request,
    get mutationCount() {
      return mutationCount;
    },
  };
}
