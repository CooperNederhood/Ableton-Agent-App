import type {
  DeviceParameterSummary,
  DeviceSummary,
  SessionSnapshot,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";

import {
  projectSnapshotSchema,
  type DesktopProjectSnapshot,
  type DesktopTrack,
} from "../contracts.js";

type TrackSummary = SessionSnapshot["tracks"][number];

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

/**
 * Names the Live set by the only identity the protocol exposes: the project ID
 * from the Remote Script handshake. No display name is invented.
 */
export function projectLabel(status: ConnectionStatus): string {
  return status.state === "connected"
    ? `Live set ${status.projectId}`
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
    color: colorFromLiveValue(track.color),
    volume: track.volume,
    pan: track.pan,
    muted: track.isMuted,
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
 * Maps a protocol session snapshot into the desktop project view model.
 * Devices are included only for tracks whose devices were actually read.
 */
export function toDesktopSnapshot(
  snapshot: SessionSnapshot,
  status: ConnectionStatus,
  trackDevices: readonly TrackDevices[] = [],
): DesktopProjectSnapshot {
  const devicesByTrack = new Map(
    trackDevices.map((entry) => [entry.trackReference, entry]),
  );
  return projectSnapshotSchema.parse({
    id: status.state === "connected" ? status.projectId : "unknown-project",
    name: projectLabel(status),
    tempo: snapshot.tempo,
    timeSignature: `${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
    tracks: snapshot.tracks.map((track) =>
      desktopTrack(track, snapshot, devicesByTrack.get(track.reference)),
    ),
  } satisfies DesktopProjectSnapshot);
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
