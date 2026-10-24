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
