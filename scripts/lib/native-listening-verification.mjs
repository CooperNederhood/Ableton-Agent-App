import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function inspectNativeStoppedPreflight(
  { inspected, input, nativeVersion, session = false, limits },
  sanitize,
) {
  const listeners = Array.isArray(inspected?.listeners)
    ? inspected.listeners
    : [];
  const target = listeners[0];
  const transport = inspected?.transport;
  const recording = transport?.recording;
  const checks = {
    transportStopped: transport?.playing === false,
    legacyBeatZero: nativeVersion >= 2 || transport?.currentBeat === 0,
    tempo120: transport?.tempo === 120,
    safeToStart: transport?.safeToStart === true,
    recordModeOff: recording?.recordMode === false,
    sessionRecordOff: recording?.sessionRecord === false,
    arrangementOverdubOff: recording?.arrangementOverdub === false,
    sessionAutomationRecordOff: recording?.sessionAutomationRecord === false,
    exactListenerCount: listeners.length === 1,
    listenerEnabled: target?.enabled === true,
    arrangementSource: session || target?.sessionOverride === false,
    canonicalDevicePath:
      target?.pathAttestation?.canonicalDevicePath === input.canonicalPath,
    trackName: target?.binding?.track?.expectedName === input.trackName,
    deviceName: target?.binding?.expectedDeviceName === input.deviceName,
    clipsComplete: target?.clipsTruncated === false,
    // Session's bounded dependency fingerprint is descriptive, not exclusive source proof.
    ...(session
      ? {}
      : { dependenciesComplete: target?.dependenciesTruncated === false }),
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const text = (value, limit = 128) =>
    typeof value === "string" ? sanitize(value).slice(0, limit) : null;
  const boolean = (value) => (typeof value === "boolean" ? value : null);
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const reasons = (value) =>
    Array.isArray(value)
      ? value
          .slice(0, 8)
          .map((value) => text(value))
          .filter((value) => value !== null)
      : [];
  return {
    schema: "native-stopped-preflight/v1",
    mode: session ? "session" : "arrangement",
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    limits: {
      maxClips: number(limits?.maxClips),
      maxParameters: number(limits?.maxParameters),
    },
    expected: {
      canonicalPath: text(input.canonicalPath, 256),
      trackName: text(input.trackName),
      deviceName: text(input.deviceName),
    },
    transport: {
      playing: boolean(transport?.playing),
      currentBeat: number(transport?.currentBeat),
      tempo: number(transport?.tempo),
      safeToStart: boolean(transport?.safeToStart),
      recording: {
        recordMode: boolean(recording?.recordMode),
        sessionRecord: boolean(recording?.sessionRecord),
        arrangementOverdub: boolean(recording?.arrangementOverdub),
        sessionAutomationRecord: boolean(recording?.sessionAutomationRecord),
      },
    },
    listenerCount: listeners.length,
    target: {
      enabled: boolean(target?.enabled),
      sessionOverride: boolean(target?.sessionOverride),
      canonicalPath: text(target?.canonicalPath, 256),
      attestedDevicePath: text(
        target?.pathAttestation?.canonicalDevicePath,
        256,
      ),
      trackIndex: number(target?.binding?.track?.index),
      trackReference: text(target?.binding?.track?.expectedReference),
      trackName: text(target?.binding?.track?.expectedName),
      deviceIndex: number(target?.binding?.deviceIndex),
      deviceReference: text(target?.binding?.expectedDeviceReference),
      deviceName: text(target?.binding?.expectedDeviceName),
      className: text(target?.binding?.expectedClassName),
      clipsTruncated: boolean(target?.clipsTruncated),
      dependenciesTruncated: boolean(target?.dependenciesTruncated),
    },
    quality: {
      dependencyRequirement: session ? "descriptive-only" : "complete-required",
      dependencyCompleteness:
        target?.dependenciesTruncated === true
          ? "incomplete"
          : target?.dependenciesTruncated === false &&
              target?.fingerprint?.completeness === "complete"
            ? "complete"
            : "unknown",
      fingerprintCompleteness:
        target?.dependenciesTruncated === false &&
        target?.fingerprint?.completeness === "complete"
          ? "complete"
          : "unknown",
      attribution:
        target?.attribution === "nonexclusive" ? "nonexclusive" : "unknown",
      unknownReasons: reasons(target?.unknownReasons),
      fingerprintUnknownReasons: reasons(target?.fingerprint?.unknownReasons),
    },
  };
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Frozen deferred-source expectations, never physical identity or native admission evidence. */
export function snapshotNativeSessionSource(
  { source, target, sourceKind, geometry },
  protocol,
) {
  const parsed =
    protocol.inspectSessionListeningSourceResultSchema.parse(source);
  const g = protocol.nativeListeningGeometrySchema.parse(geometry);
  const settings = parsed.settings;
  const span = g.totalSamples / ((g.sampleRate * 60) / g.tempoBpm);
  const firstIterationEndBeat = Math.min(
    settings.loopEnd ?? 0,
    settings.endMarker ?? 0,
  );
  requireValue(
    isDeepStrictEqual(parsed.target, target) &&
      ["midi", "warped-audio"].includes(sourceKind) &&
      parsed.sourceKind === sourceKind &&
      parsed.positionUnit === "beats" &&
      [parsed.before, parsed.after].every(
        (state) =>
          state.transportPlaying === false &&
          state.targetPlaying === false &&
          state.targetTriggered === false &&
          state.targetRecording === false &&
          state.firedSlotIndex === -1 &&
          state.playingSlotIndex !== null &&
          state.globalBeat === g.startBeat,
      ) &&
      g.startBeat >= 0 &&
      Math.abs(g.endBeat - g.startBeat - 4) <= 1e-8 &&
      g.tempoBpm === 120 &&
      settings.tempoBpm === g.tempoBpm &&
      settings.signatureNumerator === 4 &&
      settings.signatureDenominator === 4 &&
      settings.startMarker === 0 &&
      settings.loopStart === 0 &&
      typeof settings.looping === "boolean" &&
      settings.launchMode === 0 &&
      settings.legato === false &&
      settings.launchQuantization === 0 &&
      [0, 4].includes(settings.globalQuantization) &&
      (settings.globalQuantization !== 4 ||
        Math.abs(g.startBeat / 4 - Math.round(g.startBeat / 4)) <= 1e-10) &&
      settings.followActionEnabled !== true &&
      span < firstIterationEndBeat &&
      4 < firstIterationEndBeat,
    "Unsafe or mismatched immutable Session source/first-iteration geometry",
  );
  return freeze({
    target: globalThis.structuredClone(parsed.target),
    sourceKind,
    source: parsed,
    geometry: g,
    firstIterationEndBeat,
    followActions:
      settings.followActionEnabled === false ? "disabled" : "unknown",
  });
}

function verifySessionSourceJoin(input, observation, raw, expected, protocol) {
  const { session, target, pass, owner } = input;
  const frozen = snapshotNativeSessionSource(session, protocol);
  requireValue(
    isDeepStrictEqual(frozen.geometry, expected.geometry) &&
      isDeepStrictEqual(expected.source, {
        mode: "session",
        synchronization: "transport-coupled-first-iteration",
        target: frozen.target,
      }) &&
      target.binding.track.expectedReference ===
        frozen.target.track.expectedReference &&
      target.binding.track.index === frozen.target.track.index,
    "Session source target or frozen native expectation mismatch",
  );
  const receipts = session.receipts;
  requireValue(
    Array.isArray(receipts) && receipts.length >= 4 && receipts.length <= 512,
    "Bounded independent Session source-driver receipts required",
  );
  let ownerId;
  let firstPlaying;
  let launched = false;
  const actions = [];
  for (const record of receipts) {
    const params = protocol.sessionListeningPassParamsSchema.parse(
      record.params,
    );
    const result = protocol.sessionListeningPassResultSchema.parse(
      record.result,
    );
    ownerId ??= params.ownerId;
    requireValue(
      params.ownerId === ownerId &&
        result.ownerId === ownerId &&
        params.passId === pass.id &&
        result.passId === pass.id &&
        result.durationBeats === 4 &&
        result.followActionState ===
          (frozen.followActions === "unknown" ? "unknown" : "known-disabled"),
      "Session source receipt changed ownership, duration or follow-action evidence",
    );
    actions.push(params.action);
    if (params.action === "prepare") {
      requireValue(
        actions.length === 1 &&
          result.status === "prepared" &&
          params.expectedLiveSetId === owner.liveSetId &&
          params.expectedProjectRevision === frozen.source.projectRevision &&
          params.durationBeats === 4 &&
          params.timingAnchor.globalBeat === expected.geometry.startBeat &&
          isDeepStrictEqual(params.target, frozen.target) &&
          isDeepStrictEqual(params.listener, target.binding),
        "Session preparation did not use the independently frozen fixture target and transport anchor",
      );
    } else if (params.action === "launch") {
      requireValue(
        !launched && ["accepted", "queued", "playing"].includes(result.status),
        "Session launch receipt was not accepted or observed",
      );
      launched = true;
    } else if (params.action === "release")
      requireValue(
        params.reason === "completed" && result.status === "released",
        "Session source monitor cleanup was not confirmed",
      );
    else
      requireValue(
        (launched ? ["accepted", "queued", "playing"] : ["prepared"]).includes(
          result.status,
        ),
        "Session source continuity was invalidated",
      );
    if (firstPlaying && params.action !== "release")
      requireValue(
        result.status === "playing" &&
          isDeepStrictEqual(result.sourceEpoch, firstPlaying.sourceEpoch),
        "Session source epoch continuity was lost after the first observed playing witness",
      );
    if (result.sourceEpoch && params.action !== "release") {
      const epoch = result.sourceEpoch;
      const state = result.lastObservedSource;
      requireValue(
        launched &&
          epoch.clipReference === frozen.target.expectedClipReference &&
          Math.abs(epoch.startTimeBeats - expected.geometry.startBeat) <=
            1e-8 &&
          state.startTimeBeats === epoch.startTimeBeats &&
          state.selectedClipReference === epoch.clipReference &&
          state.playingSlotIndex === frozen.target.sceneIndex &&
          state.targetPlaying === true &&
          state.targetRecording === false &&
          state.transportPlaying === true &&
          epoch.observedGlobalBeat >= expected.geometry.startBeat &&
          epoch.observedGlobalBeat <
            expected.geometry.startBeat + frozen.firstIterationEndBeat,
        "Actual Session source epoch did not match frozen native transport geometry",
      );
      if (result.status === "playing" && !firstPlaying) {
        requireValue(
          record.beforePublication === true,
          "Session source epoch was not independently observed before publication",
        );
        firstPlaying = result;
      }
    }
  }
  requireValue(
    actions.filter((action) => action === "prepare").length === 1 &&
      actions.filter((action) => action === "launch").length === 1 &&
      actions.filter((action) => action === "release").length === 1 &&
      actions.includes("inspect") &&
      actions.at(-1) === "release" &&
      firstPlaying !== undefined &&
      firstPlaying.sourceEpoch.observedGlobalBeat < raw.endBeat,
    "Session pass requires one launch and an observed source epoch with released monitoring",
  );
  const after = protocol.inspectSessionListeningSourceResultSchema.parse(
    session.after,
  );
  requireValue(
    isDeepStrictEqual(after.target, frozen.target) &&
      after.sourceKind === frozen.sourceKind &&
      after.positionUnit === "beats" &&
      isDeepStrictEqual(after.settings, frozen.source.settings) &&
      [after.before, after.after].every(
        (state) =>
          state.transportPlaying === true &&
          state.targetPlaying === true &&
          state.targetRecording === false &&
          state.targetTriggered === false &&
          state.selectedClipReference === frozen.target.expectedClipReference &&
          state.playingSlotIndex === frozen.target.sceneIndex,
      ),
    "Session source identity/settings or leave-running state changed",
  );
  const origin = expected.geometry.startBeat;
  const storedTarget = observation.source.target;
  requireValue(
    storedTarget.view === frozen.target.view &&
      storedTarget.sceneIndex === frozen.target.sceneIndex &&
      storedTarget.expectedClipReference ===
        frozen.target.expectedClipReference &&
      storedTarget.track.kind === frozen.target.track.kind &&
      storedTarget.track.index === frozen.target.track.index &&
      storedTarget.track.expectedReference ===
        frozen.target.track.expectedReference,
    "Stored Session target reference/scene/track association mismatch",
  );
  const mapped = protocol.sessionAudioObservationSchema.parse({
    ...raw,
    schema: "session-audio-observation/v1",
    startBeat: raw.startBeat - origin,
    endBeat: raw.endBeat - origin,
    samples: raw.samples.map((point) => ({
      ...point,
      beat: point.beat - origin,
    })),
    attacks: raw.attacks.map((point) => ({
      ...point,
      beat: point.beat - origin,
    })),
    limitations: observation.limitations,
    source: {
      view: "session",
      target: storedTarget,
      kind: frozen.sourceKind,
      coordinate: {
        unit: "beats",
        iteration: 0,
        startBeat: 0,
        endBeat: raw.endBeat - origin,
      },
      transport: { startBeat: raw.startBeat, endBeat: raw.endBeat },
      origin: {
        evidence: "message-rate-start-time-with-native-transport",
        clipStartTimeBeats: firstPlaying.sourceEpoch.startTimeBeats,
        observedAtGlobalBeat: firstPlaying.sourceEpoch.observedGlobalBeat,
      },
      continuity: {
        evidence: "message-rate-monitored",
        followActions: frozen.followActions,
      },
    },
  });
  requireValue(
    isDeepStrictEqual(mapped, observation) &&
      raw.limitations.every((limitation) =>
        observation.limitations.includes(limitation),
      ) &&
      observation.limitations.some((limitation) =>
        /message-rate/i.test(limitation),
      ) &&
      (frozen.followActions !== "unknown" ||
        observation.limitations.some(
          (limitation) =>
            /follow.action/i.test(limitation) &&
            /unavailable|unknown/i.test(limitation) &&
            /not.*detect|may.*not/i.test(limitation),
        )),
    "Session global-to-local mapping, original sample indices or timing limitations mismatch",
  );
}

export function inspectNativeListeningPostconditions(input, sanitizeText) {
  const {
    baselineSnapshot,
    finalSnapshot,
    inspected,
    finalInspection,
    listener,
    finalListener,
    beforeBinding,
    afterBinding,
  } = input;
  const checks = {
    snapshotPlaying: finalSnapshot.isPlaying === true,
    transportPlaying: finalInspection.transport.playing === true,
    recordingInactive: Object.values(finalInspection.transport.recording).every(
      (value) => value === false,
    ),
    listenerIdle: finalListener?.phase === "idle",
    listenerPassReleased:
      finalListener !== undefined && finalListener.passId === undefined,
    listenerJobReleased:
      finalListener !== undefined && finalListener.jobId === undefined,
    connectionUnchanged:
      finalListener !== undefined &&
      finalListener.connectionId === listener.connectionId,
    registrationUnchanged:
      finalListener !== undefined &&
      isDeepStrictEqual(finalListener.registration, listener.registration),
    bindingUnchanged: isDeepStrictEqual(beforeBinding, afterBinding),
  };
  const before = {
    snapshotPlaying: baselineSnapshot.isPlaying,
    transportPlaying: inspected.transport.playing,
    recording: inspected.transport.recording,
    phase: listener.phase,
    passId: listener.passId,
    jobId: listener.jobId,
    connectionId: listener.connectionId,
    registration: listener.registration,
    inspection: beforeBinding,
  };
  const after = {
    snapshotPlaying: finalSnapshot.isPlaying,
    transportPlaying: finalInspection.transport.playing,
    recording: finalInspection.transport.recording,
    phase: finalListener?.phase,
    passId: finalListener?.passId,
    jobId: finalListener?.jobId,
    connectionId: finalListener?.connectionId,
    registration: finalListener?.registration,
    inspection: afterBinding,
  };
  const summarize = (value) => {
    if (value === undefined) return { type: "undefined" };
    if (value === null) return { type: "null" };
    if (typeof value === "string")
      return { type: "string", value: sanitizeText(value).slice(0, 256) };
    if (typeof value !== "object") return { type: typeof value, value };
    const text = sanitizeText(JSON.stringify(value));
    return {
      type: Array.isArray(value) ? "array" : "object",
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  };
  const differences = [];
  let visited = 0,
    differencesTruncated = false;
  const diff = (path, left, right, depth = 0) => {
    if (isDeepStrictEqual(left, right)) return;
    if (differences.length >= 8 || ++visited > 128) {
      differencesTruncated = true;
      return;
    }
    if (
      depth < 10 &&
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      Array.isArray(left) === Array.isArray(right)
    ) {
      for (const key of [
        ...new Set([...Object.keys(left), ...Object.keys(right)]),
      ].sort()) {
        diff(`${path}.${key}`, left[key], right[key], depth + 1);
        if (differencesTruncated) break;
      }
    } else
      differences.push({
        path: sanitizeText(path).slice(0, 256),
        before: summarize(left),
        after: summarize(right),
      });
  };
  for (const [path, left, right] of [
    ["transport.recording", before.recording, after.recording],
    ["listener.phase", before.phase, after.phase],
    ["listener.passId", before.passId, after.passId],
    ["listener.jobId", before.jobId, after.jobId],
    ["listener.connectionId", before.connectionId, after.connectionId],
    ["listener.registration", before.registration, after.registration],
    ["inspection", before.inspection, after.inspection],
  ])
    diff(path, left, right);
  return {
    schema: "native-listening-postconditions/v1",
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.keys(checks).filter((name) => !checks[name]),
    before: Object.fromEntries(
      Object.entries(before).map(([key, value]) => [key, summarize(value)]),
    ),
    after: Object.fromEntries(
      Object.entries(after).map(([key, value]) => [key, summarize(value)]),
    ),
    differences,
    differencesTruncated,
  };
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
  const session = input.session !== undefined;
  requireValue(
    !session || input.expected !== undefined,
    "Independent frozen Session native expectation required",
  );
  const expected =
    input.expected === undefined
      ? undefined
      : session
        ? protocol.snapshotNativeSessionListeningExpectation(input.expected)
        : protocol.snapshotNativeListeningExpectationV2(input.expected);
  const requestedRange = session
    ? {
        startBeat: 0,
        endBeat: 4,
      }
    : expected
      ? {
          startBeat: expected.geometry.startBeat,
          endBeat: expected.geometry.endBeat,
        }
      : { startBeat: 0, endBeat: 4 };
  const transportRange = expected
    ? {
        startBeat: expected.geometry.startBeat,
        endBeat:
          expected.geometry.startBeat +
          expected.geometry.totalSamples /
            ((expected.geometry.sampleRate * 60) / expected.geometry.tempoBpm),
      }
    : requestedRange;
  const actualRange = session
    ? {
        startBeat: 0,
        endBeat: transportRange.endBeat - transportRange.startBeat,
      }
    : transportRange;
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
      pass.requestedMode === (session ? "session" : "arrangement") &&
      pass.actualMode === (session ? "session" : "arrangement"),
    "Persisted pass ownership or exact playback coverage mismatch",
  );
  requireValue(
    entries.length === 1 && entries[0].id === job.contextIds[0],
    "Expected exactly one atomic context entry",
  );
  const entry = entries[0];
  const observation = (
    session
      ? protocol.sessionAudioObservationSchema
      : expected
        ? protocol.audioObservationV2Schema
        : protocol.audioObservationSchema
  ).parse(entry.payload);
  if (expected)
    requireValue(
      entry.kind ===
        (session ? "session-audio-observation/v1" : "audio-observation/v2") &&
        listener.registration.version === (session ? 3 : 2) &&
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
      (session || isDeepStrictEqual(event.result.observation, observation)),
    "Native result connection/causation mismatch",
  );
  const raw = session
    ? protocol.audioObservationV2Schema.parse(event.result.observation)
    : observation;
  const wrapper = (
    session
      ? protocol.nativeSessionCaptureProofSchema
      : expected
        ? protocol.nativeCaptureProofV2Schema
        : protocol.nativeCaptureProofSchema
  ).parse(event.result.nativeCapture);
  const proof = session ? wrapper.transport : wrapper;
  if (expected) {
    requireValue(
      event.result.listenerVersion === (session ? 3 : 2),
      "Native result version mismatch",
    );
    if (session) {
      protocol.assertNativeSessionCaptureObservation(wrapper, raw, expected);
      verifySessionSourceJoin(input, observation, raw, expected, protocol);
    } else
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
  const contributingTrack = session
    ? subjects.find(
        (subject) =>
          subject.id ===
            links.find((link) => link.relationship === "contributor")
              ?.subjectId &&
          subject.kind === "track" &&
          subject.binding.previousRuntimeBindings.includes(
            input.session.target.track.expectedReference,
          ),
      )
    : undefined;
  requireValue(
    !session || contributingTrack !== undefined,
    "Session contributing track must bind the exact inspected runtime reference",
  );
  const associatedTrackId = session
    ? contributingTrack.id
    : target.binding.track.expectedReference;
  for (const link of links) {
    const subject = subjects.find((item) => item.id === link.subjectId);
    requireValue(
      link.entryId === entry.id &&
        subject !== undefined &&
        link.sessionId === owner.sessionId &&
        link.liveSetId === owner.liveSetId &&
        subject.sessionId === owner.sessionId &&
        subject.liveSetId === owner.liveSetId &&
        subject.trackId === associatedTrackId &&
        subject.binding.semanticLocator.trackId === associatedTrackId &&
        isDeepStrictEqual(
          link.coverage,
          session
            ? link.relationship === "primary"
              ? { coordinate: "clip-local-beats", iteration: 0, ...actualRange }
              : { coordinate: "transport-beats", ...transportRange }
            : actualRange,
        ) &&
        link.attribution === "unknown" &&
        link.freshness.status === "unknown" &&
        ((link.relationship === "primary" &&
          (session
            ? subject.kind === "clip" &&
              subject.location === "session" &&
              subject.binding.semanticLocator.sceneIndex ===
                input.session.target.sceneIndex &&
              subject.binding.previousRuntimeBindings.includes(
                input.session.target.expectedClipReference,
              )
            : subject.kind === "arrangement-range" &&
              isDeepStrictEqual(
                subject.binding.semanticLocator.arrangementRange,
                requestedRange,
              ))) ||
          (link.relationship === "contributor" &&
            subject.kind === "track" &&
            (!session ||
              subject.binding.previousRuntimeBindings.includes(
                input.session.target.track.expectedReference,
              )))) &&
        (!session || subject.binding.dependencyScope === "unknown"),
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
    ...(session
      ? {
          observationSchema: observation.schema,
          sourceKind: observation.source.kind,
          sourceEpochEvidence: "message-rate-only",
          transportRange,
          continuity: observation.source.continuity,
          physicalClipIdentityProven: false,
        }
      : {}),
  };
}

export function createNativeScenarioApproval(manifest, binding) {
  const session = manifest.nativeVersion === 3;
  const capture = Object.freeze(
    manifest.nativeVersion >= 2
      ? { ...manifest.capture }
      : { startBeat: 0, endBeat: 4, maximumDurationMs: 8000 },
  );
  const decisions = [];
  let mutationCount = 0;
  let inspectedAtMutation;
  let sessionDenied = false;
  let frozenTarget;
  let frozenListenerId;
  const sessionReads = new Set();
  const keys = (args, expected) =>
    args !== null &&
    typeof args === "object" &&
    isDeepStrictEqual(Object.keys(args).sort(), [...expected].sort());
  const sessionReason = (toolName, risk, args) => {
    if (sessionDenied) return "prior-denial-no-retry";
    if (decisions.length >= 8) return "tool-call-budget";
    if (
      toolName === "ableton_listening" &&
      args?.action === "inspect-listeners"
    ) {
      if (
        risk !== "read" ||
        !keys(args, ["action"]) ||
        sessionReads.has("inspect") ||
        mutationCount !== 0 ||
        !binding.sessionTarget ||
        typeof binding.listenerId !== "string" ||
        binding.listenerId.length === 0
      )
        return "exact-session-inspection";
      frozenTarget = globalThis.structuredClone(binding.sessionTarget);
      frozenListenerId = binding.listenerId;
      sessionReads.add("inspect");
      return "reviewed";
    }
    if (
      toolName === "ableton_listening" &&
      args?.action === "play-session-and-listen"
    ) {
      if (!sessionReads.has("inspect"))
        return "inspection-required-before-playback";
      if (
        risk !== "reversible" ||
        !keys(args, [
          "action",
          "target",
          "listenerIds",
          "durationBeats",
          "maximumDurationMs",
        ]) ||
        mutationCount !== 0 ||
        capture.durationBeats !== 4 ||
        capture.maximumDurationMs !== 30000 ||
        args.durationBeats !== capture.durationBeats ||
        args.maximumDurationMs !== capture.maximumDurationMs ||
        !isDeepStrictEqual(args.listenerIds, [frozenListenerId]) ||
        !isDeepStrictEqual(args.target, frozenTarget)
      )
        return "exact-session-listener-target-budget";
      mutationCount++;
      return "reviewed";
    }
    if (
      toolName === "ableton_listening" &&
      args?.action === "get-pass" &&
      risk === "read" &&
      keys(args, ["action", "passId"]) &&
      mutationCount === 1 &&
      !sessionReads.has("pass") &&
      binding.passIds.size === 1 &&
      binding.passIds.has(args.passId)
    ) {
      sessionReads.add("pass");
      return "reviewed";
    }
    if (
      toolName === "ableton_context" &&
      args?.action === "get" &&
      risk === "read" &&
      keys(args, ["action", "contextId", "includeHistorical"]) &&
      sessionReads.has("pass") &&
      !sessionReads.has("context") &&
      args.includeHistorical === true &&
      binding.contextIds.has(args.contextId) &&
      binding.completedContextIds?.has(args.contextId)
    ) {
      sessionReads.add("context");
      return "reviewed";
    }
    return "unreviewed-session-tool-action-risk";
  };
  const request = async (approval) => {
    const { toolName, arguments: args, risk } = approval;
    let reason = "reviewed";
    if (session) {
      reason = sessionReason(toolName, risk, args);
      if (reason !== "reviewed") sessionDenied = true;
    } else if (decisions.length >= manifest.maxToolCalls)
      reason = "tool-call-budget";
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
      if (inspectedAtMutation !== mutationCount)
        reason = "inspection-required-before-playback";
      else if (
        mutationCount >=
          Math.min(manifest.maxMutations, binding.captureLimit ?? 1) ||
        args.startBeat !== capture.startBeat ||
        args.endBeat !== capture.endBeat ||
        args.maximumDurationMs !== capture.maximumDurationMs ||
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
      arguments: session ? globalThis.structuredClone(args) : args,
      approved: reason === "reviewed",
      reason,
    };
    decisions.push(decision);
    if (
      decision.approved &&
      toolName === "ableton_listening" &&
      args.action === "inspect-listeners"
    )
      inspectedAtMutation = mutationCount;
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
