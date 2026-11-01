import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { freezeSessionSourceExpectation } from "../../packages/runtime/dist/session-listening-source.js";

const unavailableSpectrumFixture = Object.freeze({
  schema: "native-metric-engineering-fixture/v1",
  id: "native5-unavailable-spectrum/v1",
  engineeringOnly: true,
  unavailableMetric: "spectral-centroid",
  sourceSemantics: "spectral-acquisition-not-started",
  runtimeEntry: "audio_listener_native_v5_unavailable_spectrum_max.js",
});
const fixtureHash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requireMetricFixtureSelection(reviewed, input) {
  if (reviewed.nativeVersion !== 5 || input.nativeVersion !== 5)
    throw new Error("Native metric engineering fixture version mismatch");
  if (reviewed.engineeringFixtureId !== undefined) {
    if (
      reviewed.engineeringFixtureId !== unavailableSpectrumFixture.id ||
      input.engineeringFixture?.id !== unavailableSpectrumFixture.id
    )
      throw new Error(
        "Explicit unavailable-spectrum engineering fixture required; repaired defaults denied",
      );
  } else if (Object.hasOwn(input, "engineeringFixture"))
    throw new Error(
      "Native metric engineering fixture denied for normal scenario",
    );
}

export function verifyNativeMetricEngineeringBinding(
  reviewed,
  input,
  artifact,
  runtimeBytes,
) {
  requireMetricFixtureSelection(reviewed, input);
  if (reviewed.engineeringFixtureId === undefined) {
    if (Object.hasOwn(artifact, "engineeringFixture"))
      throw new Error(
        "Native metric engineering fixture denied for normal scenario",
      );
    return { variant: "default" };
  }
  const metadata = input.engineeringFixture;
  const expected = {
    ...unavailableSpectrumFixture,
    runtimeEntrySha256: metadata.runtimeEntrySha256,
  };
  const resources = artifact.resources?.filter(
    (resource) => resource.name === expected.runtimeEntry,
  );
  if (
    artifact.nativeVersion !== 5 ||
    artifact.nativeMode !== true ||
    artifact.realLiveValidated !== false ||
    !/^[a-f0-9]{64}$/.test(expected.runtimeEntrySha256 ?? "") ||
    !isDeepStrictEqual(metadata, expected) ||
    !isDeepStrictEqual(artifact.engineeringFixture, expected) ||
    resources?.length !== 1 ||
    resources[0].sha256 !== expected.runtimeEntrySha256 ||
    runtimeBytes === undefined ||
    fixtureHash(runtimeBytes) !== expected.runtimeEntrySha256
  )
    throw new Error(
      "Native metric engineering fixture metadata/runtime hash binding mismatch",
    );
  return {
    variant: expected.id,
    runtimeEntry: expected.runtimeEntry,
    runtimeEntrySha256: expected.runtimeEntrySha256,
  };
}

async function boundedMetricFixtureFile(path, maximumBytes) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > maximumBytes ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error(
      "Native metric fixture requires bounded regular nonsymlink artifact files",
    );
  const bytes = await readFile(path);
  if (bytes.length !== info.size)
    throw new Error("Native metric fixture file changed while reading");
  return bytes;
}

/** Read-only harness admission. Production callers cannot select a variant
 * through an environment/profile; the artifact checker verifies canonical code.
 */
export async function admitNativeMetricScenarioFixture(
  reviewed,
  input,
  options = {},
) {
  requireMetricFixtureSelection(reviewed, input);
  if (reviewed.longMetric) await admitNativeMetricLongFixture(input);
  else if (Object.hasOwn(input, "longMetricFixture"))
    throw new Error("Long metric fixture denied for original short scenario");
  if (
    typeof input.candidateDirectory !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.candidateManifestSha256 ?? "")
  )
    throw new Error(
      "Native metric fixture candidate manifest hash pin required",
    );
  const manifestPath = join(
    input.candidateDirectory,
    "audio-listener-manifest.json",
  );
  const bytes = await boundedMetricFixtureFile(manifestPath, 512 * 1024);
  if (fixtureHash(bytes) !== input.candidateManifestSha256)
    throw new Error("Native metric fixture candidate manifest hash mismatch");
  const artifact = JSON.parse(bytes.toString("utf8"));
  const runtimeBytes =
    reviewed.engineeringFixtureId === undefined
      ? undefined
      : await boundedMetricFixtureFile(
          join(
            input.candidateDirectory,
            unavailableSpectrumFixture.runtimeEntry,
          ),
          2 * 1024 * 1024,
        );
  const binding = verifyNativeMetricEngineeringBinding(
    reviewed,
    input,
    artifact,
    runtimeBytes,
  );
  const check =
    options.checkArtifact ??
    (await import("../audio-listener-device.mjs")).checkArtifact;
  const checked = await check(input.candidateDirectory);
  if (
    !isDeepStrictEqual(checked, artifact) ||
    fixtureHash(await boundedMetricFixtureFile(manifestPath, 512 * 1024)) !==
      input.candidateManifestSha256
  )
    throw new Error(
      "Native metric fixture artifact changed during hash/check admission",
    );
  if (
    runtimeBytes &&
    fixtureHash(
      await boundedMetricFixtureFile(
        join(input.candidateDirectory, unavailableSpectrumFixture.runtimeEntry),
        2 * 1024 * 1024,
      ),
    ) !== binding.runtimeEntrySha256
  )
    throw new Error(
      "Native metric fixture runtime entry hash changed during admission",
    );
  return {
    schema: "native-metric-fixture-admission/v1",
    ...binding,
    candidateManifestSha256: input.candidateManifestSha256,
  };
}

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

export const metricLongFixtureContract = Object.freeze({
  schema: "native-metric-long-fixture/v1",
  tempoBpm: 128,
  signatureNumerator: 4,
  signatureDenominator: 4,
  firstIterationEndBeat: 64,
  midiClipName: "AA_METRIC_MIDI_64BEATS",
  audioClipName: "AA_METRIC_AUDIO_64BEATS",
  audioSampleRate: 48000,
  audioSampleLength: 1536000,
  sourceSetSha256:
    "089a2dc15d61b685b035672b58cc81ccfb81d0f97471ea2d10efe168390c9fcb",
  sourceAudioSha256:
    "1bae0212d0f4b0f7ed18d0d9a97dbd008145559e8c28586d415b659329a0012c",
});

export const metricLongCases = Object.freeze(
  Object.fromEntries(
    ["midi", "audio"].flatMap((kind) =>
      [32, 64].map((beats) => [
        `native-metric-session-${kind}-${beats === 32 ? "eight-bars" : "30-seconds"}`,
        Object.freeze({ kind, beats, seconds: beats === 32 ? 15 : 30 }),
      ]),
    ),
  ),
);

export async function admitNativeMetricLongFixture(input) {
  const metadata = input.longMetricFixture;
  if (
    !metadata ||
    !isDeepStrictEqual(metadata, {
      ...metricLongFixtureContract,
      preparedSetSha256: input.sourceSetSha256,
      preparedAudioSha256: input.audioFiles?.[0]?.sha256,
    }) ||
    input.audioFiles?.length !== 1 ||
    !/^[a-f0-9]{64}$/.test(metadata.preparedSetSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(metadata.preparedAudioSha256 ?? "")
  )
    throw new Error(
      "Explicit pinned copied 64-beat long metric fixture required",
    );
  const set = await boundedMetricFixtureFile(input.sourceSet, 8 * 1024 * 1024);
  const audio = await boundedMetricFixtureFile(
    input.audioFiles[0].path,
    8 * 1024 * 1024,
  );
  if (
    fixtureHash(set) !== metadata.preparedSetSha256 ||
    fixtureHash(audio) !== metadata.preparedAudioSha256
  )
    throw new Error("Prepared long metric Set/audio hash mismatch");
  const xml = gunzipSync(set, { maxOutputLength: 16 * 1024 * 1024 }).toString(
    "utf8",
  );
  const clip = (kind, name) => {
    const matches = [
      ...xml.matchAll(new RegExp(`<${kind}\\b[^>]*>[\\s\\S]*?</${kind}>`, "g")),
    ].filter(([body]) => body.includes(`<Name Value="${name}"`));
    return (
      matches.length === 1 &&
      ["LoopEnd", "OutMarker"].every((tag) =>
        matches[0][0].includes(`<${tag} Value="64"`),
      )
    );
  };
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !clip("MidiClip", metadata.midiClipName) ||
    !clip("AudioClip", metadata.audioClipName) ||
    !/<Tempo>[\s\S]*?<Manual Value="128"/.test(xml) ||
    audio.length < 44 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE" ||
    audio.toString("ascii", 12, 16) !== "fmt " ||
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt32LE(24) !== metadata.audioSampleRate ||
    audio.readUInt16LE(22) !== 2 ||
    audio.readUInt16LE(34) !== 16 ||
    audio.toString("ascii", 36, 40) !== "data" ||
    audio.readUInt32LE(40) !== metadata.audioSampleLength * 4 ||
    audio.length !== 44 + metadata.audioSampleLength * 4
  )
    throw new Error(
      "Long metric fixture lacks pinned 64-beat sources/PCM duration",
    );
  return { ...metadata };
}

export function metricLongSmokePrompt(kind, beats) {
  if (!["midi", "audio"].includes(kind) || ![32, 64].includes(beats))
    throw new Error("Unreviewed long metric capture");
  return `${metricSpectrumSmokePrompt
    .replace("MIDI Session", `${kind === "midi" ? "MIDI" : "audio"} Session`)
    .replace(
      "durationBeats 1,",
      `durationBeats ${beats},`,
    )} Capture ${beats === 32 ? "one eight-bar 4/4 phrase (32 beats, 15 seconds)" : "exactly 30 seconds (64 beats)"} at constant128 BPM with no tempo automation. The harness has prepared and hash-pinned a copied 64-beat first-iteration source; never loop a shorter source, extend it, change tempo or repair it yourself. All quarter-beat rows, independent attack-input windows and phase-sensitive FFT records must remain available in the saved and reopened context.`;
}

export const metricRepeatedSmokePrompt = `${metricSpectrumSmokePrompt} This is one of three separately authorized one-beat captures of the SAME immutable MIDI source and SAME loaded native5 producer. Do not start another capture in this turn. Only the harness may establish exactly two stopped, recording-off beat-zero baselines after verified completed captures; it never reinstalls, reloads or rebinds the producer. Stop at the first failure, denial or cancellation; no later capture is authorized. Descriptive clock disagreement is advisory, not a sample-accuracy admission gate. Constant 120 BPM is assumed; tempo automation is unsupported. Final capture cleanup leaves playback running.`;

export const metricSwitchingSmokePrompt = `${metricSpectrumSmokePrompt.replace("MIDI Session", "runner-supplied Session")} This is ONE separately authorized pass in the fixed MIDI/audio/MIDI sequence. Use only this turn's exact supplied source kind, target and listener ID; never start a later capture yourself. Both native5 producers remain loaded with stable instance, registration and connection bindings. The harness alone stops the PREVIOUS selected track's Session clips unquantized, then stops transport and seeks beat0 at exactly two verified completion boundaries. It independently verifies BOTH selected tracks stopped/unqueued/recording-off before the next capture. Public transport stop/seek does not stop Session clips and is not auto-repair authority. No actor stop, seek, repair, source changes, waits, retries or later capture after failure/denial/cancellation. Native epochs increase PER PRODUCER, not globally across different producers. Descriptive64-sample disagreement is advisory; constant120 BPM is assumed and tempo automation unsupported. Final cleanup leaves playback running.`;

export function verifySwitchingSessionReset(
  sources,
  previousTarget,
  { stoppedZero = false, inactive = false } = {},
) {
  if (
    sources.length !== 2 ||
    new Set(sources.map((source) => source.target.track.expectedReference))
      .size !== 2
  )
    throw new Error(
      "Switching baseline requires two exact independent source tracks",
    );
  for (const source of sources) {
    for (const state of [source.before, source.after]) {
      const previous = isDeepStrictEqual(source.target, previousTarget);
      if (
        state.targetRecording !== false ||
        state.targetTriggered !== false ||
        state.firedSlotIndex !== -1 ||
        !Number.isInteger(state.playingSlotIndex) ||
        state.playingSlotIndex < -2 ||
        (state.playingSlotIndex >= 0 &&
          (inactive ||
            stoppedZero ||
            !previous ||
            state.playingSlotIndex !== previousTarget.sceneIndex ||
            state.selectedClipReference !==
              previousTarget.expectedClipReference)) ||
        ((!previous || inactive || stoppedZero) &&
          state.targetPlaying !== false) ||
        (stoppedZero &&
          (state.transportPlaying !== false || state.globalBeat !== 0))
      )
        throw new Error(
          "Switching baseline recording/playing/queued/stopped-zero guard failed",
        );
    }
  }
}

export function switchingSessionStopParams(previousTarget, plan) {
  if (
    plan.length !== 2 ||
    !plan.some((step) => isDeepStrictEqual(step.sessionTarget, previousTarget))
  )
    throw new Error(
      "Switching stop must target only the exact previous owned source track",
    );
  return {
    action: "stop-clips",
    target: globalThis.structuredClone(previousTarget.track),
    quantized: false,
  };
}

export function verifySwitchingNativeMetricPasses(passes, plan) {
  const seen = new Map();
  if (
    passes.length !== 3 ||
    plan?.length !== 2 ||
    new Set(passes.map((p) => p.job.passId)).size !== 3 ||
    new Set(passes.map((p) => p.evidence.contextId)).size !== 3 ||
    passes[0].evidence.listenerId === passes[1].evidence.listenerId ||
    passes[0].sessionTarget.track.expectedReference ===
      passes[1].sessionTarget.track.expectedReference ||
    !isDeepStrictEqual(passes[0].sessionTarget, passes[2].sessionTarget)
  )
    throw new Error(
      "Switching metric exact MIDI/audio/MIDI pass/context/source sequence mismatch",
    );
  for (const [index, pass] of passes.entries()) {
    const expected = plan[[0, 1, 0][index]];
    const prior = seen.get(pass.evidence.listenerId);
    if (
      pass.sourceKind !== ["midi", "warped-audio", "midi"][index] ||
      !isDeepStrictEqual(pass.sessionTarget, expected.sessionTarget) ||
      !isDeepStrictEqual(pass.producerIdentity, expected.producerIdentity) ||
      pass.job.stage !== "completed" ||
      pass.evidence.passId !== pass.job.passId ||
      pass.evidence.nativeEpoch !== pass.nativeEpoch ||
      !Number.isSafeInteger(pass.nativeEpoch) ||
      pass.nativeEpoch <= 0 ||
      pass.producerIdentity.producer.producerId !== pass.evidence.listenerId ||
      pass.producerIdentity.registration.version !== 5 ||
      pass.evidence.savedAndReopened !== true ||
      pass.evidence.nativeCleanup !== "confirmed-before-terminal-result" ||
      pass.evidence.spectrumPhase == null ||
      pass.evidence.spectrumCleanup?.status !== "completed" ||
      pass.evidence.spectrum.status !== "complete" ||
      pass.evidence.spectrum.records.length === 0 ||
      pass.evidence.spectrum.records.length !==
        pass.evidence.spectrum.expectedRecords ||
      (prior &&
        (pass.nativeEpoch <= prior.nativeEpoch ||
          !isDeepStrictEqual(pass.producerIdentity, prior.producerIdentity) ||
          !isDeepStrictEqual(pass.sessionTarget, prior.sessionTarget)))
    )
      throw new Error(
        "Switching metric per-producer epoch/identity/source/cleanup mismatch",
      );
    seen.set(pass.evidence.listenerId, pass);
  }
  if (seen.size !== 2)
    throw new Error("Switching metric requires exactly two stable producers");
  return {
    schema: "native-switching-metric-session/v1",
    sameLoadedInstances: true,
    priorContextsPreserved: true,
    epochPolicy: "increasing-per-producer",
    passes: passes.map((pass) => ({
      ...pass.evidence,
      nativeEpoch: pass.nativeEpoch,
      sourceKind: pass.sourceKind,
      target: globalThis.structuredClone(pass.sessionTarget),
      producerIdentity: globalThis.structuredClone(pass.producerIdentity),
      audioActivity: pass.audioActivity,
    })),
  };
}

export const metricRepeatedBetweenPasses = Object.freeze({
  action: "fixture-stop-clips-stop-transport-position-zero-verify",
  count: 2,
  authorization: "scenario-harness-only-after-verified-completion",
  retry: false,
  positionBeat: 0,
  scope: "owned-disposable-fixture-only",
  reviewRevision: "fixture-beat-zero-reset-v1",
});

export const metricRepeatedAssertions = Object.freeze([
  "one-owned-pass-no-retries",
  "frozen-all-metrics-proven-spectrum-phase",
  "actual-native-source-and-cleanup-proofs",
  "non-silent-independent-level-timeline",
  "one-persisted-context-readable-after-reopen",
  "unchanged-fixture-and-leave-running-idle",
  "same-loaded-instance-and-registration-through-three-passes",
  "exact-same-midi-source-three-one-beat-captures-two-harness-stopped-baselines",
  "three-distinct-passes-contexts-and-increasing-native-epochs",
  "all-prior-contexts-and-associations-immutable-after-each-pass",
  "stop-at-first-failure-no-retry-or-later-subpass",
]);

export const metricArrangementSmokePrompt =
  "Make these calls sequentially: inspect-listeners, exactly one play-arrangement-and-listen with startBeat 0.25, endBeat 1.25, maximumDurationMs 30000 and only the supplied listener ID, then get-pass once with the returned passId. The runner explicitly requests level, spectral-centroid and attacks through the native5 independent-metric pipeline. Never supply Session durationBeats or a Session target. If any call fails or is denied, stop and report it without retry, repair, shell waits, source changes, edits, seek or stop calls. If get-pass is nonterminal, finish your turn reporting pending; never poll or call it twice. The harness owns the terminal wait. Only after completed may you get the returned contextId once with includeHistorical=true. Before native prepare/arm, the production listening host positions the runner-owned Arrangement insert marker and stopped playhead to beat0.25 and independently re-inspects; that positioning is part of the one authorized playback operation, not actor seek authority. The immutable audio Arrangement clip spans beats0..8 on the exact listener track. Descriptive timing uses an advisory 64-sample clock-disagreement target, not a sample-accuracy admission gate. Constant120 BPM is assumed; tempo automation is unsupported. Leave playback running; capture cleanup does not restore the prior playhead or insert marker. Report measured metric availability without claiming exclusive clip audio, verified source onset or physical timing accuracy.";

export function verifyNativeMetricArrangementFixture(target, range) {
  const covering = target.clips.filter(
    (clip) =>
      clip.target.view === "arrangement" &&
      clip.interval?.startBeat <= range.startBeat &&
      clip.interval?.endBeat >= range.endBeat,
  );
  const clip = covering[0];
  if (
    target.enabled !== true ||
    target.sessionOverride !== false ||
    target.clipsTruncated !== false ||
    covering.length !== 1 ||
    target.binding.track.kind !== "regular" ||
    target.binding.track.index !== 2 ||
    clip.isAudioClip !== true ||
    clip.isRecording !== false ||
    clip.target.track.kind !== target.binding.track.kind ||
    clip.target.track.index !== target.binding.track.index ||
    clip.target.track.expectedReference !==
      target.binding.track.expectedReference ||
    clip.target.expectedClipName !== "AA_SESSION_120BPM_8BEATS" ||
    clip.target.expectedStartTime !== 0 ||
    !isDeepStrictEqual(clip.interval, { startBeat: 0, endBeat: 8 })
  )
    throw new Error(
      "Arrangement fixture lacks the exact pinned covering audio source",
    );
  return globalThis.structuredClone({
    target: clip.target,
    interval: clip.interval,
    isAudioClip: clip.isAudioClip,
    isRecording: clip.isRecording,
    settings: clip.settings,
    fingerprint: clip.fingerprint,
  });
}

export function createMetricArrangementApproval(
  manifest,
  binding,
  createApproval,
) {
  const core = createApproval(manifest, binding);
  const decisions = [];
  let denied = false;
  const sequence = [
    ["ableton_listening", "inspect-listeners", ["action"]],
    [
      "ableton_listening",
      "play-arrangement-and-listen",
      ["action", "listenerIds", "startBeat", "endBeat", "maximumDurationMs"],
    ],
    ["ableton_listening", "get-pass", ["action", "passId"]],
    ["ableton_context", "get", ["action", "contextId", "includeHistorical"]],
  ];
  return {
    decisions,
    get mutationCount() {
      return core.mutationCount;
    },
    async request(request) {
      const expected = sequence[decisions.length];
      const args = request.arguments;
      let approved = false;
      if (
        !denied &&
        expected &&
        request.toolName === expected[0] &&
        args?.action === expected[1] &&
        isDeepStrictEqual(Object.keys(args).sort(), [...expected[2]].sort()) &&
        (args.action !== "get" ||
          binding.completedContextIds.has(args.contextId))
      )
        approved = await core.request(request);
      denied ||= !approved;
      decisions.push({
        sequence: decisions.length + 1,
        toolName: request.toolName,
        risk: request.risk,
        arguments: globalThis.structuredClone(args),
        approved,
        reason: approved
          ? "reviewed"
          : "unreviewed-arrangement-sequence-or-arguments",
      });
      return approved;
    },
  };
}

export function verifyMetricActorSequence(decisions, mode = "session") {
  const expected = [
    ["ableton_listening", "inspect-listeners"],
    ["ableton_listening", `play-${mode}-and-listen`],
    ["ableton_listening", "get-pass"],
    ["ableton_context", "get"],
  ];
  if (
    ![3, 4].includes(decisions.length) ||
    !decisions.every((decision) => decision.approved) ||
    !isDeepStrictEqual(
      decisions.map((decision) => [
        decision.toolName,
        decision.arguments.action,
      ]),
      expected.slice(0, decisions.length),
    )
  )
    throw new Error("Repeated metric actor sequence mismatch");
}

export function verifyRepeatedMetricActivity(evidence) {
  const peaks = evidence.level.flatMap((record) => record.peak);
  const energeticWindows = evidence.spectrum.records.filter(
    (record) => record.spectralEnergy > 0 && record.centroidHz > 0,
  ).length;
  if (
    peaks.length === 0 ||
    !peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak < 1) ||
    !evidence.level.some((record) => record.rms.some((rms) => rms > 0)) ||
    energeticWindows === 0
  )
    throw new Error(
      "Repeated metric fixture lacks non-silent nonclipping native evidence",
    );
  return { peak: Math.max(...peaks), energeticWindows };
}

export function verifyRepeatedNativeMetricPasses(passes) {
  if (
    passes.length !== 3 ||
    new Set(passes.map((p) => p.job.passId)).size !== 3 ||
    new Set(passes.map((p) => p.evidence.contextId)).size !== 3 ||
    !passes.every(
      (p, index) =>
        p.job.stage === "completed" &&
        p.evidence.passId === p.job.passId &&
        p.evidence.listenerId === passes[0].evidence.listenerId &&
        p.evidence.nativeEpoch === p.nativeEpoch &&
        Number.isSafeInteger(p.nativeEpoch) &&
        p.nativeEpoch > 0 &&
        (index === 0 || p.nativeEpoch > passes[index - 1].nativeEpoch) &&
        p.producerIdentity.registration.version === 5 &&
        isDeepStrictEqual(p.producerIdentity, passes[0].producerIdentity) &&
        isDeepStrictEqual(p.sessionTarget, passes[0].sessionTarget) &&
        p.evidence.savedAndReopened === true &&
        p.evidence.nativeCleanup === "confirmed-before-terminal-result" &&
        p.evidence.spectrumPhase != null &&
        p.evidence.spectrumCleanup?.status === "completed" &&
        p.evidence.spectrum.status === "complete" &&
        p.evidence.spectrum.records.length > 0 &&
        p.evidence.spectrum.records.length ===
          p.evidence.spectrum.expectedRecords,
    )
  )
    throw new Error(
      "Repeated metric pass/context/native-epoch/source/cleanup mismatch",
    );
  return {
    schema: "native-repeated-metric-session/v1",
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
  const long = metricLongCases[manifest.id];
  const zeroEnergySpectrum =
    manifest.id === "native-metric-session-audio-silent-tail";
  const phrase =
    zeroEnergySpectrum ||
    manifest.id === "native-metric-session-midi-production-phrase" ||
    manifest.id === "native-metric-session-audio-production-phrase";
  const switching = manifest.id === "native-metric-session-midi-audio-midi";
  const arrangement =
    manifest.id === "native-metric-arrangement-audio-fractional-spectrum";
  const repeated =
    switching || manifest.id === "native-metric-session-midi-repeat-3";
  const partial = manifest.id === "native-metric-session-midi-partial-spectrum";
  const audio =
    long?.kind === "audio" ||
    manifest.id === "native-metric-session-audio-silent-tail" ||
    manifest.id === "native-metric-session-audio-production-phrase" ||
    manifest.id === "native-metric-session-audio-spectrum";
  const spectrum =
    phrase ||
    long !== undefined ||
    arrangement ||
    repeated ||
    audio ||
    manifest.id === "native-metric-session-midi-spectrum";
  if (!partial && !spectrum && manifest.id !== "native-metric-session-midi")
    return undefined;
  const requestedMetrics =
    partial || spectrum
      ? ["level", "spectral-centroid", "attacks"]
      : ["level", "attacks"];
  const capture = arrangement
    ? { startBeat: 0.25, endBeat: 1.25, maximumDurationMs: 30000 }
    : {
        durationBeats: long?.beats ?? (phrase ? 4 : 1),
        maximumDurationMs: 30000,
        sceneIndex: 0,
      };
  const timingPolicy = {
    mode: "descriptive",
    maxClockDisagreementSamples: 64,
  };
  if (
    manifest.formatVersion !== 1 ||
    manifest.group !==
      (long
        ? "native-listening-metric-long"
        : zeroEnergySpectrum
          ? "native-listening-metric-silent-tail"
          : "native-listening-metric") ||
    manifest.execution !== "native-listening-runtime" ||
    manifest.nativeVersion !== 5 ||
    manifest.mode !== (arrangement ? "arrangement" : "session") ||
    manifest.prompt !==
      (long
        ? metricLongSmokePrompt(long.kind, long.beats)
        : phrase
          ? metricSpectrumSmokePrompt
              .replace("MIDI Session", audio ? "audio Session" : "MIDI Session")
              .replace("durationBeats 1,", "durationBeats 4,")
          : switching
            ? metricSwitchingSmokePrompt
            : arrangement
              ? metricArrangementSmokePrompt
              : repeated
                ? metricRepeatedSmokePrompt
                : partial
                  ? metricPartialSmokePrompt
                  : spectrum
                    ? audio
                      ? metricSpectrumSmokePrompt.replace(
                          "MIDI Session",
                          "audio Session",
                        )
                      : metricSpectrumSmokePrompt
                    : metricSmokePrompt) ||
    manifest.artifactPrefix !==
      (arrangement
        ? "AA_SMOKE_METRIC_ARRANGEMENT_"
        : audio
          ? "AA_SMOKE_METRIC_AUDIO_"
          : "AA_SMOKE_METRIC_MIDI_") ||
    !isDeepStrictEqual(manifest.requestedMetrics, requestedMetrics) ||
    !isDeepStrictEqual(manifest.capture, capture) ||
    manifest.maxToolCalls !== (repeated ? 24 : 8) ||
    manifest.maxMutations !== (repeated ? 3 : 1) ||
    manifest.timeoutMs !== (repeated ? 270000 : 90000) ||
    (repeated &&
      (!isDeepStrictEqual(
        manifest.sequence,
        switching ? [0, 1, 0] : [0, 0, 0],
      ) ||
        manifest.modeNegotiation !== "explicit-per-pass" ||
        manifest.instancePolicy !==
          (switching
            ? "same-two-loaded-producers-no-restart-or-rebind"
            : "same-loaded-producer-no-restart-or-rebind") ||
        (switching &&
          (!isDeepStrictEqual(manifest.sourceSequence, [
            "midi",
            "warped-audio",
            "midi",
          ]) ||
            manifest.epochPolicy !== "increasing-per-producer")) ||
        !isDeepStrictEqual(
          manifest.betweenPasses,
          metricRepeatedBetweenPasses,
        ))) ||
    !isDeepStrictEqual(manifest.allowedTools, [
      "ableton_listening",
      "ableton_context",
    ]) ||
    !isDeepStrictEqual(manifest.allowedActions, {
      ableton_listening: [
        "inspect-listeners",
        arrangement ? "play-arrangement-and-listen" : "play-session-and-listen",
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
        afterAction: arrangement
          ? "play-arrangement-and-listen"
          : "play-session-and-listen",
      },
    ]) ||
    manifest.setupContract?.nativeVersion !== 5 ||
    manifest.setupContract?.inputOption !== "--native-v5-fixture-input" ||
    !isDeepStrictEqual(manifest.setupContract?.timingPolicy, timingPolicy) ||
    manifest.setupContract?.tempoPolicy !== "constant-tempo-assumed" ||
    manifest.setupContract?.tempoAutomationSupported !== false ||
    (long
      ? !isDeepStrictEqual(
          manifest.setupContract?.longFixture,
          metricLongFixtureContract,
        )
      : Object.hasOwn(manifest.setupContract ?? {}, "longFixture")) ||
    (partial
      ? manifest.setupContract?.engineeringFixture !==
        unavailableSpectrumFixture.id
      : Object.hasOwn(manifest.setupContract ?? {}, "engineeringFixture")) ||
    !isDeepStrictEqual(
      manifest.assertions,
      repeated
        ? switching
          ? [
              ...metricRepeatedAssertions.filter(
                (assertion) =>
                  assertion !==
                    "exact-same-midi-source-three-one-beat-captures-two-harness-stopped-baselines" &&
                  assertion !==
                    "three-distinct-passes-contexts-and-increasing-native-epochs",
              ),
              "exact-midi-audio-midi-two-listeners-two-harness-stopped-baselines",
              "three-distinct-passes-contexts-and-increasing-per-producer-native-epochs",
            ]
          : metricRepeatedAssertions
        : [
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
            ...(zeroEnergySpectrum
              ? ["retained-zero-energy-fft-with-null-centroid"]
              : []),
            ...(partial
              ? ["explicit-engineering-unavailable-spectrum-candidate"]
              : []),
            ...(long
              ? [
                  "pinned-64-beat-first-iteration-128bpm-4-4",
                  "all-quarterbeat-rows-and-independent-attack-input-counts",
                  "phase-sensitive-full-fft-counts-without-reduction",
                ]
              : []),
            ...(arrangement
              ? [
                  "pinned-covering-audio-arrangement-source",
                  "one-guarded-position-before-native-prepare",
                ]
              : []),
          ],
    )
  )
    throw new Error("Unreviewed metric listening scenario contract");
  return Object.freeze({
    nativeVersion: 5,
    ...(repeated
      ? {
          repeatedSession: true,
          sequence: Object.freeze(switching ? [0, 1, 0] : [0, 0, 0]),
        }
      : {}),
    ...(switching
      ? {
          switchingSession: true,
          sourceSequence: Object.freeze(["midi", "warped-audio", "midi"]),
        }
      : {}),
    mode: arrangement ? "arrangement" : "session",
    session: !arrangement,
    ...(arrangement ? { arrangementQualification: true } : {}),
    sourceKind: audio ? "warped-audio" : "midi",
    sourceRegion: Object.freeze({
      startMarker: 0,
      loopStart: 0,
      loopEnd: long ? 64 : zeroEnergySpectrum || audio ? 4 : 8,
      ...(long ? { endMarker: 64 } : {}),
    }),
    requestedMetrics: Object.freeze(requestedMetrics),
    expectedOutcome: partial ? "partial" : "complete",
    ...(partial ? { engineeringFixtureId: unavailableSpectrumFixture.id } : {}),
    expectedSpectrum: spectrum,
    ...(zeroEnergySpectrum ? { expectedZeroEnergySpectrum: true } : {}),
    ...(long ? { longMetric: true, expectedTempoBpm: 128 } : {}),
    capture: Object.freeze(
      arrangement
        ? capture
        : {
            ...capture,
            startBeat: 0,
            endBeat: long?.beats ?? (phrase ? 4 : 1),
          },
    ),
    timingPolicy: Object.freeze(timingPolicy),
  });
}

export function verifyNativeMetricZeroEnergySpectrum(timeline) {
  if (
    timeline?.status !== "complete" ||
    !Array.isArray(timeline.records) ||
    timeline.records.length !== timeline.expectedRecords ||
    timeline.gaps.length !== 0
  )
    throw new Error("Zero-energy FFT regression requires a complete timeline");
  const silent = timeline.records.filter(
    (record) => record.spectralEnergy === 0,
  );
  if (
    silent.length === 0 ||
    silent.some((record) => record.centroidHz !== null)
  )
    throw new Error("Retained zero-energy FFT records need null centroids");
  return silent.length;
}

export function verifyNativeMetricListeningEvidence(input, protocol) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const partial = input.expectedOutcome === "partial";
  const spectrumExpected = input.expectedSpectrum === true;
  const arrangement = input.arrangement;
  const range = arrangement?.range ??
    input.captureRange ?? { startBeat: 0, endBeat: 1 };
  const expectedTempoBpm = input.expectedTempoBpm ?? 120;
  const mode = arrangement ? "arrangement" : "session";
  const sourceTarget = arrangement
    ? {
        kind: input.target.binding.track.kind,
        index: input.target.binding.track.index,
        expectedReference: input.target.binding.track.expectedReference,
      }
    : input.session.target;
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
      isDeepStrictEqual(pass.requestedRange, range) &&
      isDeepStrictEqual(pass.actualRange, range) &&
      pass.requestedMode === mode &&
      pass.actualMode === mode,
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
      (arrangement
        ? pin.config.mode === "arrangement" &&
          pin.config.sourceEvidence === "transport-only" &&
          isDeepStrictEqual(pin.config.sourceContext, {
            view: "arrangement",
            target: sourceTarget,
            transport: range,
          })
        : isDeepStrictEqual(pin.config.source.target, session.target)) &&
      pin.config.geometry.totalSamples === expected.geometry.totalSamples &&
      pin.config.geometry.tempoBpm === expectedTempoBpm &&
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
    arrangement
      ? []
      : freezeSessionSourceExpectation(
          session.source,
          session.target,
          range.endBeat - range.startBeat,
        ).limitations,
  );
  protocol.assertNativeMetricObservationSource(
    event.result.nativeSourceCoverage,
    observation,
    pin,
  );
  const zeroEnergyFFTRecords = input.expectedZeroEnergySpectrum
    ? verifyNativeMetricZeroEnergySpectrum(
        observation.metrics["spectral-centroid"],
      )
    : undefined;
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
      observation.metrics.level.records.length ===
        Math.ceil((range.endBeat - range.startBeat) * 4) &&
      observation.metrics.level.records.some((record) =>
        record.rms.some((value) => value > 0),
      ) &&
      observation.metrics.level.records.reduce(
        (sum, record) =>
          sum + record.support.endSample - record.support.startSample,
        0,
      ) === expected.geometry.totalSamples &&
      observation.source.view === mode &&
      isDeepStrictEqual(observation.source.target, sourceTarget) &&
      (!arrangement || isDeepStrictEqual(observation.source.transport, range)),
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
          subject.kind === (arrangement ? "arrangement-range" : "clip") &&
          (!arrangement ||
            isDeepStrictEqual(
              subject.binding.semanticLocator.arrangementRange,
              range,
            )) &&
          subject.binding.previousRuntimeBindings.includes(
            arrangement
              ? sourceTarget.expectedReference
              : session.target.expectedClipReference,
          ),
      ) &&
      subjects.some(
        (subject) =>
          subject.kind === "track" &&
          subject.binding.previousRuntimeBindings.includes(
            arrangement
              ? sourceTarget.expectedReference
              : session.target.track.expectedReference,
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
  if (arrangement) {
    check(
      isDeepStrictEqual(
        verifyNativeMetricArrangementFixture(target, range),
        arrangement.fixture,
      ) &&
        arrangement.positioning.length === 1 &&
        arrangement.positioning[0].reply.mode === "arrangement" &&
        arrangement.positioning[0].reply.requestedStartBeat ===
          range.startBeat &&
        arrangement.positioning[0].reply.currentBeat === range.startBeat &&
        arrangement.positioning[0].reply.insertMarkerBeat === range.startBeat &&
        arrangement.positioning[0].reply.playing === false &&
        arrangement.positioning[0].reply.cleanupPolicy === "leave-running" &&
        arrangement.positioning[0].beforeNativePrepare === true,
      "Arrangement frozen source or actual pre-prepare positioning receipt mismatch",
    );
  } else
    check(
      session.receipts.filter(({ params }) => params.action === "launch")
        .length === 1 &&
        session.receipts.at(-1)?.params.action === "release" &&
        session.receipts.at(-1)?.beforePublication === true,
      "Session source must launch once and release before publication",
    );
  const retainedCoverage = verifyMetricRetainedCoverage(observation, protocol);
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
    ...(zeroEnergyFFTRecords === undefined ? {} : { zeroEnergyFFTRecords }),
    spectrumPhase: event.result.nativeSourceCoverage.spectrumPhase ?? null,
    spectrumCleanup: event.result.nativeSourceCoverage.spectrumCleanup ?? null,
    source: observation.source,
    nativeEpoch: pin.nativeEpoch,
    nativeCleanup: "confirmed-before-terminal-result",
    savedAndReopened: true,
    trace: globalThis.structuredClone(pass.trace),
    retainedCoverage,
  };
}

/** Counts are derived from actual acquisition phase, not the conservative FFT budget. */
export function verifyMetricRetainedCoverage(observation, protocol) {
  const g = observation.geometry;
  const { level, attacks } = observation.metrics;
  const spectrum = observation.metrics["spectral-centroid"];
  const check = (value, message) => {
    if (!value)
      throw new Error(`Metric retained coverage mismatch: ${message}`);
  };
  check(
    observation.rows.length === g.rows.length &&
      observation.reduction.mode === "none" &&
      observation.reduction.originalReportRows === g.rows.length &&
      observation.reduction.retainedReportRows === g.rows.length &&
      observation.reduction.authoritativeTimelines === "retained" &&
      isDeepStrictEqual(
        observation.rows,
        protocol.createMetricObservationReportRows(observation),
      ),
    "all quarter-beat rows",
  );
  const exact = (timeline, supports, name) => {
    check(
      timeline.status === "complete" &&
        timeline.gaps.length === 0 &&
        timeline.expectedRecords === supports.length &&
        timeline.records.length === supports.length &&
        timeline.records.every(
          (record, index) =>
            record.index === index &&
            isDeepStrictEqual(record.support, supports[index]),
        ),
      `${name} count/support`,
    );
  };
  exact(
    level,
    g.rows.map(({ startSample, endSample }) => ({ startSample, endSample })),
    "level",
  );
  const windowSamples = Math.round(g.sampleRate / 10);
  check(attacks.algorithm?.windowSamples === windowSamples, "attack algorithm");
  const attackSupports = [];
  for (let start = g.startSample; start < g.endSample; start += windowSamples)
    attackSupports.push({
      startSample: start,
      endSample: Math.min(start + windowSamples, g.endSample),
    });
  exact(attacks, attackSupports, "independent attack-input");
  let fftRecords = 0;
  if (spectrum.status === "complete") {
    const first = spectrum.algorithm?.firstFrameEndSample;
    check(
      Number.isSafeInteger(first) &&
        first > g.startSample &&
        first <= g.startSample + 2048 &&
        spectrum.algorithm.hopSamples === 2048,
      "FFT phase",
    );
    const supports = [];
    for (let end = first; end <= g.endSample; end += 2048)
      supports.push({ startSample: end - 2048, endSample: end });
    exact(spectrum, supports, "phase-sensitive FFT");
    fftRecords = supports.length;
  }

  return {
    reportRows: g.rows.length,
    attackInputRecords: attackSupports.length,
    fftRecords,
    firstFrameEndSample: spectrum.algorithm?.firstFrameEndSample ?? null,
  };
}

export function verifyNativeMetricLongSource(reviewed, source, content) {
  if (!reviewed.longMetric) return;
  const contract = metricLongFixtureContract;
  const selected = content.clips.find((clip) =>
    isDeepStrictEqual(clip.target, source.target),
  );
  const audio = reviewed.sourceKind === "warped-audio";
  const check = (value) => {
    if (!value)
      throw new Error("Long metric fixture source/content pin mismatch");
  };
  check(
    source.target.sceneIndex === 0 &&
      source.target.expectedClipName ===
        (audio ? contract.audioClipName : contract.midiClipName) &&
      source.sourceKind === reviewed.sourceKind &&
      selected?.sourceKind === reviewed.sourceKind &&
      source.settings.tempoBpm === contract.tempoBpm &&
      source.settings.signatureNumerator === 4 &&
      source.settings.signatureDenominator === 4 &&
      source.settings.startMarker === 0 &&
      source.settings.loopStart === 0 &&
      source.settings.loopEnd === 64 &&
      source.settings.endMarker === 64,
  );
  if (audio) {
    const { clip } = selected.body.audio;
    check(
      clip.sampleRate === contract.audioSampleRate &&
        clip.sampleLength === contract.audioSampleLength &&
        selected.body.markers.markers.some(
          (marker) => marker.beatTime === 64 && marker.sampleTime === 32,
        ),
    );
  } else {
    const { notes, totalNotes, truncated } = selected.body;
    check(
      totalNotes === 64 &&
        notes.length === 64 &&
        truncated === false &&
        Math.max(...notes.map((note) => note.startTime + note.duration)) === 64,
    );
  }
}
