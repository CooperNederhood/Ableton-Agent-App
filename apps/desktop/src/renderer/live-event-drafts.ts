import type {
  DesktopLiveEventState,
  DesktopLiveSetSnapshot,
  DesktopTrack,
  LiveEventDefinitionDraft,
  LiveEventSelection,
} from "../contracts";

export const defaultParameterPolicy = {
  minimumNormalizedDelta: 0.01,
  throttleMs: 100,
} as const;

export const clipEventKinds = [
  "track.playing_clip_changed",
  "track.triggered_clip_changed",
  "track.recording_state_changed",
] as const;

export type TrackEventKind =
  (typeof clipEventKinds)[number] | "track.pattern_changed";

export const eventKindLabels: Record<LiveEventDefinitionDraft["kind"], string> =
  {
    "parameter.value_changed": "Parameter value",
    "track.playing_clip_changed": "Playing clip",
    "track.triggered_clip_changed": "Queued clip",
    "track.recording_state_changed": "Recording",
    "track.pattern_changed": "Pattern",
  };

function namedOccurrence<T extends { name: string }>(
  items: readonly T[],
  index: number,
): number {
  const name = items[index]?.name;
  if (name === undefined) return 0;
  return items.slice(0, index).filter((item) => item.name === name).length;
}

/** The name-plus-occurrence locator Live Events use to find a track again. */
export function trackLocator(
  snapshot: DesktopLiveSetSnapshot,
  track: DesktopTrack,
): { name: string; occurrence: number } {
  const index = snapshot.tracks.findIndex(({ id }) => id === track.id);
  return {
    name: track.name,
    occurrence: namedOccurrence(snapshot.tracks, index),
  };
}

export function trackDraft(
  track: DesktopTrack,
  snapshot: DesktopLiveSetSnapshot,
  kind: TrackEventKind,
): LiveEventDefinitionDraft {
  return {
    kind,
    classification: "discrete",
    name: `${track.name}: ${eventKindLabels[kind]}`,
    enabled: true,
    target: { track: trackLocator(snapshot, track) },
  };
}

export function parameterDraftFromSnapshot(
  snapshot: DesktopLiveSetSnapshot,
  trackId: string,
  deviceId: string,
  parameterId: string,
): LiveEventDefinitionDraft | undefined {
  const trackIndex = snapshot.tracks.findIndex(({ id }) => id === trackId);
  const track = snapshot.tracks[trackIndex];
  const deviceIndex =
    track?.devices.findIndex(({ id }) => id === deviceId) ?? -1;
  const device = track?.devices[deviceIndex];
  const parameterIndex =
    device?.parameters.findIndex(({ id }) => id === parameterId) ?? -1;
  const parameter = device?.parameters[parameterIndex];
  if (!track || !device || !parameter) return undefined;
  return {
    kind: "parameter.value_changed",
    classification: "continuous",
    name: `${track.name}: ${device.name} ${parameter.name}`,
    enabled: true,
    target: {
      track: {
        name: track.name,
        occurrence: namedOccurrence(snapshot.tracks, trackIndex),
      },
      device: {
        name: device.name,
        occurrence: namedOccurrence(track.devices, deviceIndex),
      },
      parameter: {
        name: parameter.name,
        occurrence: namedOccurrence(device.parameters, parameterIndex),
      },
    },
    observationPolicy: defaultParameterPolicy,
  };
}

export function parameterDraftFromSelection(
  selection: LiveEventSelection,
  snapshot?: DesktopLiveSetSnapshot,
): LiveEventDefinitionDraft | undefined {
  const identity = selection.parameter;
  if (identity === null || snapshot === undefined) return undefined;
  return parameterDraftFromSnapshot(
    snapshot,
    identity.expectedReference,
    identity.expectedDeviceReference,
    identity.expectedParameterReference,
  );
}

export function selectionTrack(
  selection: LiveEventSelection | undefined,
  snapshot: DesktopLiveSetSnapshot | undefined,
): DesktopTrack | undefined {
  if (!selection?.track || !snapshot) return undefined;
  return (
    snapshot.tracks.find(
      ({ id }) => id === selection.track?.expectedReference,
    ) ??
    snapshot.tracks[selection.track.index] ??
    snapshot.tracks.find(({ name }) => name === selection.track?.expectedName)
  );
}

export function latestStateLabel(event: DesktopLiveEventState): string {
  const latest = event.latestState;
  if (latest === undefined) return "Waiting for initial state";
  switch (latest.kind) {
    case "parameter.value_changed":
      return latest.state.displayValue;
    case "track.playing_clip_changed":
    case "track.triggered_clip_changed":
      return latest.state.state === "session-clip"
        ? (latest.state.clipName ??
            `Session clip ${latest.state.slotIndex + 1}`)
        : latest.state.state;
    case "track.recording_state_changed":
      return `${latest.state.recording ? "Recording" : "Not recording"} (${latest.state.source})`;
    case "track.pattern_changed":
      return latest.state.episode === "pattern-established"
        ? `${latest.state.periodBars}-bar loop`
        : latest.state.episode.replace("-", " ");
  }
}

export interface ParameterMatch {
  track: DesktopTrack;
  device: DesktopTrack["devices"][number];
  parameter: DesktopTrack["devices"][number]["parameters"][number];
  macro: boolean;
}

const unnamedMacro = /^Macro \d+$/u;
const switchValues = new Set(["on", "off"]);

/** Racks expose their macros after the "Device On" switch. */
function isRack(device: DesktopTrack["devices"][number]): boolean {
  return /rack$/iu.test(device.type);
}

/**
 * Finds knobs and macros whose "track device knob" text contains every query
 * word. Unnamed macros and on/off switches are noise in a large set, so they
 * are counted but hidden unless asked for.
 */
export function searchParameters(
  snapshot: DesktopLiveSetSnapshot | undefined,
  query: string,
  options: { macrosOnly?: boolean; showHidden?: boolean } = {},
): { matches: ParameterMatch[]; hidden: number } {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matches: ParameterMatch[] = [];
  let hidden = 0;
  for (const track of snapshot?.tracks ?? []) {
    for (const device of track.devices) {
      const rack = isRack(device);
      device.parameters.forEach((parameter, index) => {
        const macro = rack && index > 0;
        if (options.macrosOnly && !macro) return;
        const haystack =
          `${track.name} ${device.name} ${parameter.name}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return;
        const noise =
          (macro && unnamedMacro.test(parameter.name)) ||
          switchValues.has(parameter.displayValue.trim().toLowerCase());
        if (noise && !options.showHidden) {
          hidden += 1;
          return;
        }
        matches.push({ track, device, parameter, macro });
      });
    }
  }
  return { matches, hidden };
}
