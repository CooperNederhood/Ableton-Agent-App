import { createHash } from "node:crypto";
import { sessionListeningPreflightResultSchema } from "@ableton-agent/protocol";
import type {
  FixtureManifest,
  Facts,
  ClipLaunchQuantization,
  FixtureSource,
  ListenerPlacement,
  MidiContentIdentity,
  SessionSourceEvidence,
} from "./contracts.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const listenerRuntimeParameters = new Set(["Attack rise dB", "Attack gap ms"]);

/** Protocol-normalized public enum, never a saved XML LaunchQuantisation ordinal. */
export function sessionClipQuantizationName(
  value: number | null,
): ClipLaunchQuantization | "unsupported" {
  return value === 0
    ? "global"
    : value === 1
      ? "none"
      : value === 5
        ? "bar"
        : "unsupported";
}

export function declaredSourceBaseline(
  fixture: FixtureManifest,
  source: FixtureSource,
): Facts {
  return {
    ...fixture.baseline,
    ...(source.clipLaunchQuantization === undefined
      ? {}
      : { clipLaunchQuantization: source.clipLaunchQuantization }),
  };
}

/** Observable Live API content only: neither opaque instrument state nor native timing. */
export function midiContentIdentity(
  input: unknown,
  listener: ListenerPlacement,
): MidiContentIdentity {
  const parsed = sessionListeningPreflightResultSchema.parse(input);
  if (!("midi" in parsed)) throw new Error("Expected complete MIDI preflight");
  const device = parsed.instrumentChain.before.devices[listener.deviceIndex];
  if (
    !device ||
    !Number.isInteger(listener.deviceIndex) ||
    device.index !== listener.deviceIndex ||
    device.reference !== listener.deviceReference ||
    device.trackIndex !== listener.trackIndex ||
    device.className !== "MxDeviceAudioEffect" ||
    !device.enabled
  )
    throw new Error("MIDI listener requires an exact enabled device slot");
  const notes = parsed.midi.notes
    .map(
      ({ pitch, startTime, duration, velocity, mute }) =>
        [pitch, startTime, duration, velocity, mute] as const,
    )
    .sort(
      (a, b) =>
        a[0] - b[0] ||
        a[1] - b[1] ||
        a[2] - b[2] ||
        a[3] - b[3] ||
        Number(a[4]) - Number(b[4]),
    );
  const devices = parsed.instrumentChain.devices.map(
    ({ device, parameters }) => ({
      index: device.index,
      name: device.name,
      className: device.className,
      classDisplayName: device.classDisplayName,
      enabled: device.enabled,
      parameterCount: device.parameterCount,
      canHaveChains: device.canHaveChains,
      canHaveDrumPads: device.canHaveDrumPads,
      parameters: parameters.map(
        ({
          index,
          name,
          value,
          normalizedValue,
          min,
          max,
          isQuantized,
          isEnabled,
          valueItemCount,
        }) => ({
          index,
          name,
          min,
          max,
          isQuantized,
          isEnabled,
          valueItemCount,
          ...(device.index === listener.deviceIndex &&
          listenerRuntimeParameters.has(name)
            ? {}
            : { value, normalizedValue }),
        }),
      ),
    }),
  );
  return {
    midiNotesSha256: hash(notes),
    instrumentChainSha256: hash({
      listenerIndex: listener.deviceIndex,
      devices,
    }),
  };
}

export function validateFixtureSourceEvidence(
  fixture: FixtureManifest,
  definition: FixtureSource,
  evidence: SessionSourceEvidence,
): void {
  const expectedQuantization = declaredSourceBaseline(
    fixture,
    definition,
  ).clipLaunchQuantization;
  if (
    expectedQuantization !== undefined &&
    (evidence.facts.clipLaunchQuantization !== expectedQuantization ||
      ("midi" in evidence &&
        sessionClipQuantizationName(
          evidence.midi.source.settings.launchQuantization,
        ) !== expectedQuantization))
  )
    throw new Error("Observed source clip quantization differs from fixture");
  if (
    evidence.facts.trackName !== definition.trackName ||
    evidence.facts.clipName !== definition.clipName ||
    evidence.source.slotIndex !== definition.sceneIndex
  )
    throw new Error("Observed source selector differs from fixture");
  if ("mediaTarget" in definition) {
    if (!("loadedMediaPath" in evidence))
      throw new Error("Expected audio source evidence");
    const resource = fixture.resources.find(
      (entry) => entry.target === definition.mediaTarget,
    );
    if (!resource || resource.sha256 !== evidence.source.mediaSha256)
      throw new Error("Observed audio source content differs from fixture");
    return;
  }
  if (!("midi" in evidence)) throw new Error("Expected MIDI source evidence");
  const parsed = sessionListeningPreflightResultSchema.parse(evidence.midi);
  const target = parsed.source.target;
  const binding = fixture.listenerBindings?.find(
    (entry) => entry.slot === definition.listenerBindingSlot,
  );
  if (
    !binding ||
    binding.trackIndex !== definition.trackIndex ||
    binding.trackIndex !== evidence.listenerPlacement.trackIndex ||
    binding.deviceIndex !== evidence.listenerPlacement.deviceIndex ||
    evidence.facts.trackIndex !== definition.trackIndex ||
    evidence.facts.sceneIndex !== definition.sceneIndex ||
    target.track.index !== definition.trackIndex ||
    target.track.expectedName !== definition.trackName ||
    target.expectedClipName !== definition.clipName ||
    target.track.expectedReference !== evidence.source.trackId ||
    target.expectedClipReference !== evidence.source.clipId ||
    target.sceneIndex !== definition.sceneIndex
  )
    throw new Error(
      "Observed MIDI source or listener placement differs from fixture",
    );
  const observed = midiContentIdentity(
    evidence.midi,
    evidence.listenerPlacement,
  );
  if (
    observed.midiNotesSha256 !== definition.midi.notesSha256 ||
    observed.instrumentChainSha256 !== definition.midi.instrumentChainSha256 ||
    observed.midiNotesSha256 !== evidence.source.midiNotesSha256 ||
    observed.instrumentChainSha256 !== evidence.source.instrumentChainSha256
  )
    throw new Error(
      "Observed MIDI content differs from independently declared fixture",
    );
}

export function validateMidiSourcePreconditions(
  fixture: FixtureManifest,
  evidence: SessionSourceEvidence,
): void {
  if (!("midi" in evidence)) return;
  const parsed = sessionListeningPreflightResultSchema.parse(evidence.midi);
  if (
    parsed.recording.state.arrangementRecord !== false ||
    parsed.recording.state.sessionRecord !== false ||
    parsed.source.before.globalBeat !== parsed.source.after.globalBeat ||
    (fixture.baseline.currentSongTime !== undefined &&
      parsed.source.after.globalBeat !== fixture.baseline.currentSongTime) ||
    ![parsed.source.before, parsed.source.after].every(
      (state) =>
        state.transportPlaying === false &&
        typeof state.globalBeat === "number" &&
        state.globalBeat >= 0 &&
        state.targetRecording === false &&
        state.targetTriggered === false &&
        state.firedSlotIndex === -1,
    )
  )
    throw new Error(
      "MIDI source requires independently observed stopped, unqueued, nonrecording state",
    );
}
