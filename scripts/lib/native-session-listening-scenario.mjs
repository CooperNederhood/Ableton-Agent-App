import { isDeepStrictEqual } from "node:util";

const cases = Object.freeze({
  "native-session-midi": Object.freeze({
    sourceKind: "midi",
    artifactPrefix: "AA_SMOKE_SESSION_MIDI_",
    durationBeats: 4,
    loopEnd: 8,
  }),
  "native-session-warped-audio": Object.freeze({
    sourceKind: "warped-audio",
    artifactPrefix: "AA_SMOKE_SESSION_WARPED_",
    durationBeats: 4,
    loopEnd: 4,
  }),
  "native-session-midi-full-loop": Object.freeze({
    sourceKind: "midi",
    artifactPrefix: "AA_SMOKE_SESSION_MIDI_FULL_LOOP_",
    loopEnd: 8,
  }),
  "native-session-midi-eight-beats": Object.freeze({
    sourceKind: "midi",
    artifactPrefix: "AA_SMOKE_SESSION_MIDI_EIGHT_",
    durationBeats: 8,
    loopEnd: 8,
  }),
});

export function nativeSessionListeningPrompt(kind, durationBeats = 4) {
  if (!["midi", "warped-audio"].includes(kind))
    throw new Error("Unreviewed Session source kind");
  if (![4, 8, null].includes(durationBeats))
    throw new Error("Unreviewed Session duration");
  const duration =
    durationBeats === null
      ? "durationBeats omitted entirely to capture the exact full active loop"
      : `durationBeats ${durationBeats}`;
  return `Make these calls sequentially, never in parallel: inspect-listeners, exactly one play-session-and-listen for the exact runner-supplied ${kind} Session clip target with ${duration}, maximumDurationMs 30000 and only the bound listener ID, then get-pass once using the returned passId. This is an explicit transport-coupled first-iteration Session pass with a matching native Session listener and the App-owned descriptive timing policy with an advisory 64-sample target; measured scheduler disagreement is reported, not a sample-accuracy admission gate. Constant 120 BPM is assumed; tempo automation is unsupported. Readiness metadata and queued acceptance are not measured audio. Do not use an Arrangement action, another target or another listener. Do not seek, stop, change launch settings, edit the Set, install devices, repair or retry. If any call fails, including argument validation or permission denial, report and end without correction or shell waits. If still nonterminal after get-pass, report pending and end; the harness waits for the actual terminal job. Only after completed may you get its typed contextId with includeHistorical=true. Do not list passes or context. Leave playback running. Cancellation stops capture, not transport, and a launch already dispatched may still happen. MIDI and warped audio share the same audio-analysis path. Clip-local first-iteration beats are distinct from global transport beats. Follow-action state can be unknown: observed source changes invalidate capture, but message-rate monitoring is not a sample-accurate continuity guarantee. Never claim exclusive clip audio, verified disabled follow actions or absolute physical timing accuracy.`;
}

export function reviewNativeSessionScenario(manifest) {
  if (manifest.id === "native-dual-session-repeat-1-2-1") {
    const baseline = {
      action: "fixture-stop-clips-stop-transport-position-zero-verify",
      count: 2,
      authorization: "scenario-harness-only-after-verified-completion",
      retry: false,
      positionBeat: 0,
      scope: "owned-disposable-fixture-only",
      reviewRevision: "fixture-beat-zero-reset-v1",
    };
    if (
      manifest.nativeVersion !== 4 ||
      manifest.group !== "native-listening-repeated" ||
      manifest.mode !== "session" ||
      manifest.modeNegotiation !== "explicit-per-pass" ||
      manifest.instancePolicy !== "same-loaded-producer-no-restart-or-rebind" ||
      manifest.artifactPrefix !== "AA_SMOKE_SESSION_REPEAT_" ||
      !isDeepStrictEqual(manifest.sequence, [0, 1, 0]) ||
      !isDeepStrictEqual(manifest.betweenPasses, baseline) ||
      manifest.maxToolCalls !== 24 ||
      manifest.maxMutations !== 3 ||
      manifest.timeoutMs !== 270000 ||
      manifest.setupContract?.nativeVersion !== 4 ||
      manifest.setupContract?.inputOption !== "--native-v4-fixture-input" ||
      manifest.setupContract?.sourcePolicy !==
        "immutable-two-distinct-midi-clips-on-one-listener-track" ||
      manifest.setupContract?.baselineFailureEvidence !==
        "durable-bounded-request-before-dispatch-one-read-only-diagnostic-round-original-error-always-aborts" ||
      !isDeepStrictEqual(manifest.ordering, [
        {
          before: "ableton_listening",
          beforeAction: "inspect-listeners",
          after: "ableton_listening",
          afterAction: "play-session-and-listen",
        },
      ]) ||
      !isDeepStrictEqual(manifest.assertions?.slice(-6), [
        "non-silent-nonclipping-native-level-and-spectrum-witness",
        "same-loaded-instance-and-registration-through-three-passes",
        "exact-clip1-clip2-clip1-with-two-harness-stopped-baselines",
        "three-distinct-passes-contexts-and-increasing-native-epochs",
        "all-prior-contexts-and-associations-immutable-after-each-pass",
        "stop-at-first-failure-no-retry-or-later-subpass",
      ])
    )
      throw new Error("Unreviewed repeated Session native scenario contract");
    const single = reviewNativeSessionScenario({
      ...manifest,
      id: "native-session-midi",
      group: "native-listening-session",
      nativeVersion: 3,
      artifactPrefix: "AA_SMOKE_SESSION_MIDI_",
      maxToolCalls: 8,
      maxMutations: 1,
      timeoutMs: 90000,
      assertions: manifest.assertions.slice(0, -6),
      setupContract: {
        ...manifest.setupContract,
        nativeVersion: 3,
        inputOption: "--native-v3-fixture-input",
        sourcePolicy: "immutable-session-midi-and-warped-audio",
      },
    });
    return Object.freeze({
      ...single,
      nativeVersion: 4,
      mode: "session",
      repeatedSession: true,
      sequence: Object.freeze([0, 1, 0]),
    });
  }
  const reviewed = cases[manifest.id];
  if (reviewed === undefined) return undefined;
  const capture = {
    ...(reviewed.durationBeats === undefined
      ? {}
      : { durationBeats: reviewed.durationBeats }),
    maximumDurationMs: 30000,
    sceneIndex: 0,
  };
  const sourceRegion = {
    startMarker: 0,
    loopStart: 0,
    loopEnd: reviewed.loopEnd,
    endMarker: reviewed.loopEnd,
  };
  const timingPolicy = { mode: "descriptive", maxClockDisagreementSamples: 64 };
  if (
    manifest.execution !== "native-listening-runtime" ||
    manifest.group !== "native-listening-session" ||
    manifest.nativeVersion !== 3 ||
    manifest.sourceKind !== reviewed.sourceKind ||
    manifest.artifactPrefix !== reviewed.artifactPrefix ||
    manifest.prompt !==
      nativeSessionListeningPrompt(
        reviewed.sourceKind,
        reviewed.durationBeats ?? null,
      ) ||
    !isDeepStrictEqual(manifest.capture, capture) ||
    !isDeepStrictEqual(manifest.sourceRegion, sourceRegion) ||
    manifest.maxToolCalls !== 8 ||
    manifest.maxMutations !== 1 ||
    manifest.timeoutMs !== 90000 ||
    !isDeepStrictEqual(manifest.allowedTools, [
      "ableton_listening",
      "ableton_context",
    ]) ||
    !isDeepStrictEqual(manifest.allowedRisks, ["read", "reversible"]) ||
    !isDeepStrictEqual(manifest.allowedActions, {
      ableton_listening: [
        "inspect-listeners",
        "play-session-and-listen",
        "get-pass",
      ],
      ableton_context: ["get"],
    }) ||
    manifest.setupContract?.nativeVersion !== 3 ||
    manifest.setupContract?.inputOption !== "--native-v3-fixture-input" ||
    !isDeepStrictEqual(manifest.setupContract?.timingPolicy, timingPolicy) ||
    manifest.setupContract?.tempoPolicy !== "constant-tempo-assumed" ||
    manifest.setupContract?.tempoAutomationSupported !== false ||
    manifest.setupContract?.sourcePolicy !==
      "immutable-session-midi-and-warped-audio" ||
    !isDeepStrictEqual(manifest.assertions, [
      "no-failed-actor-tools",
      "stopped-recording-off-exact-session-source",
      "frozen-source-and-native-expectations-before-launch",
      "same-audio-analysis-path",
      "complete-native-coverage-and-independent-source-origin-join",
      "one-atomic-session-clip-and-track-context",
      "explicit-local-global-coordinate-semantics",
      "typed-historical-retrieval-and-reopen",
      "unchanged-content-leave-running-idle-capture",
    ])
  )
    throw new Error("Unreviewed Session native scenario contract");
  return Object.freeze({
    nativeVersion: 3,
    session: true,
    sourceKind: reviewed.sourceKind,
    sourceRegion: Object.freeze(sourceRegion),
    timingPolicy: Object.freeze(timingPolicy),
    capture: Object.freeze({
      ...capture,
      startBeat: 0,
      endBeat: reviewed.durationBeats ?? reviewed.loopEnd,
    }),
  });
}

/** A new one-pass approval scope is opened only by the verified harness boundary.
 * The actor never receives permission to stop, retry, or start a later subpass.
 */
export function createRepeatedSessionApprovals(manifest, createApproval) {
  const scopes = [];
  let active;
  return {
    begin(binding) {
      if (
        scopes.length >= 3 ||
        scopes.some((s) => s.decisions.some((d) => !d.approved))
      )
        throw new Error(
          "Repeated Session approval cannot retry or exceed three passes",
        );
      if (
        active &&
        (active.approval.mutationCount !== 1 ||
          active.local.passIds.size !== 1 ||
          active.local.completedContextIds.size !== 1)
      )
        throw new Error(
          "Prior repeated Session approval did not capture exactly once",
        );
      const local = {
        listenerId: binding.listenerId,
        sessionTarget: globalThis.structuredClone(binding.sessionTarget),
        passIds: new Set(),
        contextIds: new Set(),
        completedContextIds: new Set(),
      };
      const approval = createApproval(
        { ...manifest, maxToolCalls: 8, maxMutations: 1 },
        local,
      );
      active = { approval, local };
      scopes.push(approval);
    },
    registerJob(job) {
      if (!active)
        throw new Error("Repeated Session has no active approval scope");
      active.local.passIds.add(job.passId);
      for (const id of job.contextIds) {
        active.local.contextIds.add(id);
        if (job.stage === "completed") active.local.completedContextIds.add(id);
      }
    },
    request(request) {
      if (!active)
        throw new Error("Repeated Session actor called before frozen baseline");
      return active.approval.request(request);
    },
    get decisions() {
      return scopes.flatMap((s) => s.decisions);
    },
    get mutationCount() {
      return scopes.reduce((n, s) => n + s.mutationCount, 0);
    },
  };
}

/** Remove only the reviewed clips' dynamic launch flags, never foreign state. */
export function normalizeRepeatedSessionSnapshot(snapshot, targets) {
  const refs = new Set(targets.map((t) => t.expectedClipReference));
  const result = globalThis.structuredClone(snapshot);
  delete result.isPlaying;
  result.clips = result.clips.map((clip) => {
    if (!refs.has(clip.reference)) return clip;
    const copy = { ...clip };
    delete copy.isPlaying;
    delete copy.isTriggered;
    return copy;
  });
  return result;
}

export function verifyRepeatedSessionPasses(passes) {
  if (
    passes.length !== 3 ||
    new Set(passes.map((p) => p.job.passId)).size !== 3 ||
    new Set(passes.map((p) => p.evidence.contextId)).size !== 3 ||
    !passes.every(
      (p) => Number.isSafeInteger(p.nativeEpoch) && p.nativeEpoch > 0,
    ) ||
    !passes.every(
      (p) =>
        p.evidence.passId === p.job.passId &&
        p.evidence.listenerId === passes[0].evidence.listenerId,
    ) ||
    !passes.every(
      (p, i) => i === 0 || p.nativeEpoch > passes[i - 1].nativeEpoch,
    ) ||
    passes[0].sessionTarget.expectedClipReference ===
      passes[1].sessionTarget.expectedClipReference ||
    !isDeepStrictEqual(passes[0].sessionTarget, passes[2].sessionTarget) ||
    !passes.every((p) =>
      isDeepStrictEqual(p.sessionTarget.track, passes[0].sessionTarget.track),
    ) ||
    !passes.every((p, i) => p.sessionTarget.sceneIndex === [0, 1, 0][i])
  )
    throw new Error(
      "Repeated Session pass/context/native-epoch/source sequence mismatch",
    );
  return {
    schema: "native-repeated-session/v1",
    sameLoadedInstance: true,
    priorContextsPreserved: true,
    passes: passes.map((p) => ({
      ...p.evidence,
      audioActivity: p.audioActivity,
      nativeEpoch: p.nativeEpoch,
      target: globalThis.structuredClone(p.sessionTarget),
    })),
  };
}

/** Descriptor headroom/activity is not an acoustic no-crackle certificate. */
export function verifyRepeatedSessionActivity(event) {
  const observation = event.result.observation;
  const spectral = event.result.nativeCapture.transport.spectralWindows;
  const peak = Math.max(...observation.summaries.peak);
  const energeticWindows = spectral.filter(
    (row) => row[3] > 0 && row[2] > 0,
  ).length;
  if (
    !(peak > 0 && peak < 1) ||
    !observation.summaries.rmsDbfs.some(
      (value) => value !== null && value < 0,
    ) ||
    !observation.samples.every((point) =>
      point.peak.every((value) => value < 1),
    ) ||
    energeticWindows === 0
  )
    throw new Error(
      "Repeated Session fixture lacks non-silent nonclipping native audio evidence",
    );
  return {
    peak: observation.summaries.peak,
    rmsDbfs: observation.summaries.rmsDbfs,
    energeticWindows,
  };
}

export function selectSessionFixtureSource(input, reviewed) {
  if (!reviewed.session) return input;
  const source = input.sessionSources?.[reviewed.sourceKind];
  if (
    !source ||
    !isDeepStrictEqual(Object.keys(source).sort(), [
      "canonicalPath",
      "deviceName",
      "sceneIndex",
      "trackName",
    ]) ||
    !/^live_set tracks (?:0|[1-9][0-9]{0,2}) devices (?:0|[1-9][0-9]?)$/.test(
      source.canonicalPath,
    ) ||
    Number(source.canonicalPath.split(" ")[2]) >= 256 ||
    Number(source.canonicalPath.split(" ").at(-1)) >= 32 ||
    typeof source.trackName !== "string" ||
    source.trackName.length > 128 ||
    typeof source.deviceName !== "string" ||
    source.deviceName.length > 128 ||
    source.sceneIndex !== reviewed.capture.sceneIndex
  )
    throw new Error(
      "Explicit matching bounded Session fixture source required",
    );
  return {
    ...input,
    canonicalPath: source.canonicalPath,
    trackName: source.trackName,
    deviceName: source.deviceName,
    sceneIndex: source.sceneIndex,
  };
}
