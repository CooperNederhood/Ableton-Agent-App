import { createHash } from "node:crypto";
import {
  sessionListeningPreflightResultSchema,
  type InspectMidiNotesResult,
  type SessionPreflightInstrumentChain,
} from "@ableton-agent/protocol";
import type {
  FixtureManifest,
  Facts,
  ClipLaunchQuantization,
  FixtureSource,
  ListenerPlacement,
  MidiContentIdentity,
  SessionSourceEvidence,
  ScenarioManifest,
} from "./contracts.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const listenerRuntimeParameters = new Set(["Attack rise dB", "Attack gap ms"]);

export function scenarioSessionSources(
  fixture: FixtureManifest,
  scenario: ScenarioManifest,
): readonly FixtureSource[] {
  const definitions = fixture.sources ?? [];
  const ids = new Set(
    scenario.steps.flatMap((step) => (step.sourceId ? [step.sourceId] : [])),
  );
  for (const permission of scenario.permissions) {
    if (
      permission.tool !== "ableton_listening" ||
      permission.action !== "play-session-and-listen"
    )
      continue;
    if (permission.sourceId) {
      ids.add(permission.sourceId);
      continue;
    }
    if (
      scenario.steps.some(
        (step) =>
          (!permission.stepIds || permission.stepIds.includes(step.id)) &&
          !step.sourceId,
      )
    )
      return definitions;
  }
  return definitions.filter((source) => ids.size === 0 || ids.has(source.id));
}

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
  const baseline = { ...fixture.baseline };
  if (fixture.arrangementSources?.length)
    for (const key of [
      "targetArmed",
      "targetMonitoring",
      "loopEnabled",
      "backToArrangement",
    ])
      delete baseline[key];
  return {
    ...baseline,
    ...(source.activeLengthBeats === undefined
      ? {}
      : {
          activeLengthBeats: source.activeLengthBeats,
          loopEnd: source.activeLengthBeats,
        }),
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
  return midiSourceIdentity(
    parsed.midi.notes,
    parsed.instrumentChain,
    listener,
  );
}

export function midiNotesSha256(
  input: readonly InspectMidiNotesResult["notes"][number][],
): string {
  return hash(
    input
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
      ),
  );
}

export function midiSourceIdentity(
  notes: readonly InspectMidiNotesResult["notes"][number][],
  instrumentChain: SessionPreflightInstrumentChain,
  listener: ListenerPlacement,
  includeInstrumentTree = true,
): MidiContentIdentity {
  const parsed = { instrumentChain };
  const device = instrumentChain.before.devices[listener.deviceIndex];
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
  const describeDevice = (
    {
      device,
      parameters,
    }: Pick<
      (typeof parsed.instrumentChain.devices)[number],
      "device" | "parameters"
    >,
    isListener: boolean,
  ) => ({
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
        ...(isListener && listenerRuntimeParameters.has(name)
          ? {}
          : { value, normalizedValue }),
      }),
    ),
  });
  const devices = parsed.instrumentChain.devices.map((entry) =>
    describeDevice(entry, entry.device.index === listener.deviceIndex),
  );
  return {
    midiNotesSha256: midiNotesSha256(notes),
    instrumentChainSha256: hash({
      listenerIndex: listener.deviceIndex,
      devices,
      ...(includeInstrumentTree && parsed.instrumentChain.before.instrumentTree
        ? {
            tree: parsed.instrumentChain.before.instrumentTree.map((node) => ({
              path: node.path,
              device: describeDevice(
                node,
                node.path === String(listener.deviceIndex),
              ),
              chains: node.chains,
              pads: node.pads,
            })),
          }
        : {}),
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
