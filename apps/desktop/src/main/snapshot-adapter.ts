import type {
  CuePointSummary,
  DeviceParameterSummary,
  DeviceSummary,
  InspectArrangementResult,
  SessionSnapshot,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";

import {
  connectionStatusSchema,
  liveSetSnapshotSchema,
  type DesktopConnectionStatus,
  type DesktopLiveSetSnapshot,
  type DesktopTrack,
} from "../contracts.js";

type TrackSummary = SessionSnapshot["tracks"][number];
type ArrangementClipSummary = InspectArrangementResult["clips"][number];
const sessionClipLimit = 4096;
const sceneLimit = 512;
const snapshotDeviceLimit = 2048;

export interface SnapshotSupplement {
  source?: "startup" | "manual" | "internal" | "save";
  capturedAt?: string;
  arrangementClips?: readonly ArrangementClipSummary[];
  arrangementClipsTruncated?: boolean;
  cuePoints?: readonly CuePointSummary[];
  cuePointsTruncated?: boolean;
  arrangementLoop?: {
    readonly enabled: boolean;
    readonly start: number;
    readonly length: number;
  };
  capabilities?: readonly string[];
  unsupportedDomains?: readonly string[];
}

/** Devices reported for a track, paired with the parameters actually read. */
export interface TrackDevices {
  trackReference: string;
  devices: Array<{
    device: DeviceSummary;
    parameters: readonly DeviceParameterSummary[];
  }>;
}

const unknownTrackColor = "#8a8f98";

/** Live encodes track and clip colors as a 24-bit RGB integer. */
export function colorFromLiveValue(value: number | null): string {
  if (value === null || !Number.isInteger(value) || value < 0) {
    return unknownTrackColor;
  }
  return `#${(value & 0xff_ff_ff).toString(16).padStart(6, "0")}`;
}

/** Names the Live Set from the explicit Remote Script identity. */
export function liveSetLabel(
  status: ConnectionStatus | DesktopConnectionStatus,
): string {
  const desktopStatus = connectionStatusSchema.parse(status);
  return desktopStatus.state === "connected"
    ? desktopStatus.liveSetName
    : "No connected Live set";
}

function clipStatus(clip: {
  isPlaying?: boolean | undefined;
  isTriggered?: boolean | undefined;
}): "playing" | "queued" | "stopped" {
  if (clip.isTriggered === true) return "queued";
  return clip.isPlaying === true ? "playing" : "stopped";
}

function formatParameterValue(parameter: DeviceParameterSummary): string {
  return Number.isInteger(parameter.value)
    ? String(parameter.value)
    : parameter.value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function desktopTrack(
  track: TrackSummary,
  snapshot: SessionSnapshot,
  devices: TrackDevices | undefined,
): DesktopTrack {
  return {
    id: track.reference,
    name: track.name,
    kind: track.kind,
    index: track.index,
    color: colorFromLiveValue(track.color),
    volume: track.volume,
    pan: track.pan,
    muted: track.isMuted,
    soloed: track.isSoloed,
    armed: track.isArmed,
    ...(track.devicesTruncated === undefined
      ? {}
      : { devicesTruncated: track.devicesTruncated }),
    clips: (snapshot.clips ?? [])
      .filter((clip) => clip.trackReference === track.reference)
      .map((clip) => ({
        id: clip.reference,
        name: clip.name,
        sceneIndex: clip.sceneIndex,
        lengthBeats: clip.length,
        status: clipStatus(clip),
      })),
    devices: (devices?.devices ?? []).map(({ device, parameters }) => ({
      id: device.reference,
      name: device.name,
      type: device.classDisplayName,
      // Live reports `null` when it cannot expose the on/off state; treat the
      // unknown case as enabled only when Live says so.
      enabled: device.enabled === true,
      parameters: parameters.map((parameter) => ({
        id: parameter.reference,
        name: parameter.name,
        value: parameter.normalizedValue,
        displayValue: formatParameterValue(parameter),
      })),
    })),
  };
}

/**
 * Maps a protocol session snapshot into the desktop Live Set view model.
 * Devices are included only for tracks whose devices were actually read.
 */
export function toDesktopSnapshot(
  snapshot: SessionSnapshot,
  status: ConnectionStatus | DesktopConnectionStatus,
  trackDevices: readonly TrackDevices[] = [],
  supplement: SnapshotSupplement = {},
): DesktopLiveSetSnapshot {
  const desktopStatus = connectionStatusSchema.parse(status);
  if (desktopStatus.state !== "connected") {
    throw new Error("Cannot map a snapshot without a connected Live Set");
  }
  const devicesByTrack = new Map(
    trackDevices.map((entry) => [entry.trackReference, entry]),
  );
  const sessionClips = (snapshot.clips ?? []).slice(0, sessionClipLimit);
  const sceneIndexes = [...new Set(sessionClips.map((clip) => clip.sceneIndex))]
    .sort((left, right) => left - right)
    .slice(0, sceneLimit);
  const topLevelDevices = snapshot.tracks
    .flatMap((track) => {
      const enriched = devicesByTrack.get(track.reference)?.devices;
      return (enriched ?? track.devices ?? []).map((entry) => {
        const device = "device" in entry ? entry.device : entry;
        return {
          id: device.reference,
          trackId: track.reference,
          trackIndex: track.index,
          index: device.index,
          name: device.name,
          className: device.className,
          classDisplayName: device.classDisplayName,
          enabled: device.enabled,
          parameterCount: device.parameterCount,
          canHaveChains:
            "canHaveChains" in device &&
            typeof device.canHaveChains === "boolean"
              ? device.canHaveChains
              : false,
          canHaveDrumPads:
            "canHaveDrumPads" in device &&
            typeof device.canHaveDrumPads === "boolean"
              ? device.canHaveDrumPads
              : false,
        };
      });
    })
    .slice(0, snapshotDeviceLimit);
  const truncatedDomains = [
    ...(snapshot.clips !== undefined && snapshot.clips.length > sessionClipLimit
      ? ["session_clips"]
      : []),
    ...(sceneIndexes.length >= sceneLimit ? ["scenes"] : []),
    ...(supplement.arrangementClipsTruncated === true
      ? ["arrangement_clips"]
      : []),
    ...(supplement.cuePointsTruncated === true ? ["cue_points"] : []),
    ...(snapshot.tracks.some((track) => track.devicesTruncated === true) ||
    topLevelDevices.length >= snapshotDeviceLimit
      ? ["devices"]
      : []),
  ];
  return liveSetSnapshotSchema.parse({
    liveSetId: desktopStatus.liveSetId,
    liveSetName: liveSetLabel(desktopStatus),
    ...(desktopStatus.liveProjectId === undefined
      ? {}
      : { liveProjectId: desktopStatus.liveProjectId }),
    ...(desktopStatus.liveProjectName === undefined
      ? {}
      : { liveProjectName: desktopStatus.liveProjectName }),
    tempo: snapshot.tempo,
    timeSignature: `${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
    capabilities: [...(supplement.capabilities ?? [])],
    transport: {
      isPlaying: snapshot.isPlaying,
      ...(supplement.arrangementLoop === undefined
        ? {}
        : { arrangementLoop: supplement.arrangementLoop }),
    },
    capturedAt: supplement.capturedAt ?? new Date().toISOString(),
    source: supplement.source ?? "internal",
    tracks: snapshot.tracks.map((track) =>
      desktopTrack(track, snapshot, devicesByTrack.get(track.reference)),
    ),
    scenes: sceneIndexes.map((index) => ({
      id: `scene:${index}`,
      index,
      derived: true,
    })),
    sessionClips: sessionClips.map((clip) => ({
      id: clip.reference,
      trackId: clip.trackReference,
      trackIndex: clip.trackIndex,
      sceneIndex: clip.sceneIndex,
      name: clip.name,
      kind: clip.kind,
      lengthBeats: clip.length,
      noteCount: clip.noteCount,
      ...(clip.muted === undefined ? {} : { muted: clip.muted }),
      ...(clip.looping === undefined ? {} : { looping: clip.looping }),
      status: clipStatus(clip),
    })),
    arrangementClips: (supplement.arrangementClips ?? []).map((clip) => ({
      id: clip.reference,
      trackId: clip.trackReference,
      trackIndex: clip.trackIndex,
      name: clip.name,
      kind: clip.kind,
      startTime: clip.startTime,
      endTime: clip.endTime,
      lengthBeats: clip.length,
      noteCount: clip.noteCount,
      ...(clip.muted === undefined ? {} : { muted: clip.muted }),
      ...(clip.looping === undefined ? {} : { looping: clip.looping }),
    })),
    cuePoints: (supplement.cuePoints ?? []).map((cuePoint) => ({
      id: cuePoint.reference,
      name: cuePoint.name,
      time: cuePoint.time,
    })),
    devices: topLevelDevices,
    completeness: {
      truncatedDomains,
      unsupportedDomains: [
        "track_groups",
        "track_routing",
        ...(supplement.unsupportedDomains ?? []),
      ],
    },
  } satisfies DesktopLiveSetSnapshot);
}

/** Lists the capability names the connected Remote Script reports as enabled. */
export function toDesktopCapabilities(
  capabilities: Readonly<Record<string, boolean>>,
): string[] {
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}
