import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ListeningFailure } from "@ableton-agent/application";
import {
  inspectSessionListeningSourceResultSchema,
  type InspectSessionListeningSourceParams,
  type InspectSessionListeningSourceResult,
  type NativeListeningGeometry,
} from "@ableton-agent/protocol";

type Source = InspectSessionListeningSourceResult;
type Target = InspectSessionListeningSourceParams["target"];

export interface SessionSourceExpectation {
  readonly source: Readonly<Source>;
  readonly startBeat: number;
  readonly endBeat: number;
  readonly durationBeats: number;
  readonly firstIterationEndBeat: number;
  readonly fingerprint: string;
  readonly followActions: "disabled" | "unknown";
  readonly limitations: readonly string[];
}

export interface SessionSourceOrigin {
  readonly clipReference: string;
  readonly playingSlotIndex: number;
  readonly clipStartTimeBeats: number;
  readonly observedAtGlobalBeat: number;
}

function deny(code: string, detail?: string): never {
  throw new ListeningFailure(code, detail ? `${code}: ${detail}` : code);
}

function fingerprint(source: Source): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: source.target,
        kind: source.sourceKind,
        unit: source.positionUnit,
        settings: source.settings,
      }),
    )
    .digest("hex");
}

/** Frozen source expectations precede launch; deferred metadata is not timing proof. */
export function freezeSessionSourceExpectation(
  raw: Source,
  target: Target,
  durationBeats: number,
): Readonly<SessionSourceExpectation> {
  const source = inspectSessionListeningSourceResultSchema.parse(raw);
  if (!isDeepStrictEqual(source.target, target)) deny("stale_session_target");
  if (
    !Number.isFinite(durationBeats) ||
    durationBeats <= 0 ||
    durationBeats > 4 ||
    !["midi", "warped-audio"].includes(source.sourceKind) ||
    source.positionUnit !== "beats"
  )
    deny(
      "unsupported_session_source",
      "Session listening supports MIDI and warped audio in beat coordinates, with a requested duration up to four beats.",
    );
  const { before, after, settings } = source;
  if (
    [before, after].some(
      (state) =>
        state.transportPlaying !== false ||
        state.targetPlaying !== false ||
        state.targetTriggered !== false ||
        state.targetRecording !== false ||
        state.firedSlotIndex !== -1 ||
        state.playingSlotIndex === null ||
        state.globalBeat === null ||
        state.globalBeat < 0,
    )
  )
    deny(
      "session_launch_state_unknown_or_active",
      "Transport must be stopped with known recording-off clip state and no queued launch; nothing was launched.",
    );
  if (before.globalBeat !== after.globalBeat) deny("session_transport_changed");
  const startBeat = after.globalBeat!;
  if (
    settings.tempoBpm === null ||
    settings.signatureNumerator !== 4 ||
    settings.signatureDenominator !== 4 ||
    settings.launchMode !== 0 ||
    settings.legato !== false ||
    settings.launchQuantization !== 0 ||
    (settings.globalQuantization !== 0 && settings.globalQuantization !== 4) ||
    settings.startMarker !== 0 ||
    settings.loopStart !== 0 ||
    settings.looping === null ||
    settings.endMarker === null ||
    settings.loopEnd === null
  )
    deny(
      "unsupported_session_launch_settings",
      "Requires Trigger mode, legato off, clip Global quantization, a qualified global launch case in 4/4, and zero start/loop offsets. No settings were changed.",
    );
  if (settings.followActionEnabled === true)
    deny(
      "session_follow_actions_enabled",
      "Known-enabled follow actions are unsupported. No clip was launched or edited.",
    );
  if (startBeat !== 0 || settings.globalQuantization !== 0)
    deny(
      "session_launch_case_unqualified",
      "Only global None from stopped beat zero has real-host Session qualification. One-bar and nonzero stopped anchors are refused; the App does not seek or change launch settings.",
    );
  const firstIterationEndBeat = Math.min(settings.loopEnd, settings.endMarker);
  if (firstIterationEndBeat <= durationBeats)
    deny(
      "session_first_iteration_exceeded",
      "Capture must finish strictly before the first loop wrap and natural end; it was not silently shortened.",
    );
  Object.freeze(source.target.track);
  Object.freeze(source.target);
  Object.freeze(source.before);
  Object.freeze(source.after);
  Object.freeze(source.settings);
  Object.freeze(source);
  const followActions =
    settings.followActionEnabled === false ? "disabled" : "unknown";
  return Object.freeze({
    source,
    startBeat,
    endBeat: startBeat + durationBeats,
    durationBeats,
    firstIterationEndBeat,
    fingerprint: fingerprint(source),
    followActions,
    limitations: Object.freeze([
      "Clip launch and continuity use message-rate LOM evidence, not sample-accurate source identity.",
      "The listener signal can contain instrument/effect latency, tails, inputs and routed contributors.",
      ...(followActions === "unknown"
        ? [
            "Follow-action settings are unavailable; observed source changes invalidate the pass, but changes between deferred observations may not be detected.",
          ]
        : []),
    ]),
  });
}

export function assertSessionSourceUnchanged(
  expected: SessionSourceExpectation,
  latest: Source,
): void {
  if (
    fingerprint(inspectSessionListeningSourceResultSchema.parse(latest)) !==
    expected.fingerprint
  )
    deny("session_source_changed");
}

export function assertSessionFirstIterationCoverage(
  expected: SessionSourceExpectation,
  geometry: NativeListeningGeometry,
): void {
  const actualBeats =
    geometry.totalSamples / ((geometry.sampleRate * 60) / geometry.tempoBpm);
  if (
    geometry.startBeat !== expected.startBeat ||
    geometry.endBeat !== expected.endBeat ||
    geometry.tempoBpm !== expected.source.settings.tempoBpm ||
    actualBeats >= expected.firstIterationEndBeat
  )
    deny(
      "session_first_iteration_exceeded",
      "The native sample-rounded range would cross the first clip iteration; no clip was launched.",
    );
}

export function assertTransportCoupledSessionOrigin(
  expected: SessionSourceExpectation,
  origin: SessionSourceOrigin,
): void {
  if (
    origin.clipReference !== expected.source.target.expectedClipReference ||
    origin.playingSlotIndex !== expected.source.target.sceneIndex ||
    !Number.isFinite(origin.clipStartTimeBeats) ||
    Math.abs(origin.clipStartTimeBeats - expected.startBeat) > 1e-8 ||
    !Number.isFinite(origin.observedAtGlobalBeat) ||
    origin.observedAtGlobalBeat < expected.startBeat ||
    origin.observedAtGlobalBeat >=
      expected.startBeat + expected.firstIterationEndBeat
  )
    deny(
      "session_native_origin_mismatch",
      "The observed clip/source epoch did not match the frozen native transport anchor. No context was published; playback is left running.",
    );
}
