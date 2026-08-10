import type {
  InspectArrangementTransportResult,
  InspectBrowserRootsResult,
  InspectDevicesResult,
  SessionSnapshot,
} from "@ableton-agent/protocol";
import type { ConnectionStatus } from "@ableton-agent/shared";

function yesNo(value: boolean): string {
  return value ? "yes" : "";
}

export function snapshotMarkdown(snapshot: SessionSnapshot): string {
  return [
    "## Live Set",
    "",
    `- **Tempo:** ${snapshot.tempo} BPM`,
    `- **Time signature:** ${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
    `- **Playback:** ${snapshot.isPlaying ? "playing" : "stopped"}`,
    `- **Session clips:** ${snapshot.clips?.length ?? 0}`,
    "",
    `### Tracks (${snapshot.trackCount})`,
    "",
    "| # | Name | Type | Muted | Soloed | Armed |",
    "|---:|---|---|:---:|:---:|:---:|",
    ...snapshot.tracks.map(
      (track) =>
        `| ${track.index + 1} | ${track.name} | ${track.kind} | ${yesNo(track.isMuted)} | ${yesNo(track.isSoloed)} | ${yesNo(track.isArmed)} |`,
    ),
  ].join("\n");
}

export function transportMarkdown(
  transport: InspectArrangementTransportResult,
): string {
  return [
    "## Arrangement transport",
    "",
    `- **Loop:** ${transport.loop.enabled ? "enabled" : "disabled"}`,
    `- **Range:** beat ${transport.loop.start} for ${transport.loop.length} beats`,
    `- **Cue points:** ${transport.totalCuePoints}`,
    ...(transport.cuePoints.length === 0
      ? []
      : [
          "",
          "| Beat | Cue point |",
          "|---:|---|",
          ...transport.cuePoints.map(
            (cuePoint) => `| ${cuePoint.time} | ${cuePoint.name} |`,
          ),
        ]),
  ].join("\n");
}

export function devicesMarkdown(
  trackNumber: number,
  trackName: string,
  devices: InspectDevicesResult,
): string {
  return [
    `## Devices · ${trackName}`,
    "",
    `Track ${trackNumber} has **${devices.total}** top-level devices.`,
    "",
    "| # | Device | Parameters | State |",
    "|---:|---|---:|---|",
    ...devices.devices.map(
      (device) =>
        `| ${device.index + 1} | ${device.name} | ${device.parameterCount} | ${
          device.enabled === null
            ? "unavailable"
            : device.enabled
              ? "enabled"
              : "disabled"
        } |`,
    ),
  ].join("\n");
}

export function browserRootsMarkdown(
  result: InspectBrowserRootsResult,
): string {
  return [
    `## Browser roots (${result.roots.length})`,
    "",
    "| Key | Name |",
    "|---|---|",
    ...result.roots.map((root) => `| ${root.root} | ${root.name} |`),
  ].join("\n");
}

export function connectionStatusMarkdown(
  applicationState: string,
  status: ConnectionStatus,
  sessionId?: string,
): string {
  return [
    "## Status",
    "",
    `- **Application:** ${applicationState}`,
    `- **Ableton:** ${status.state}`,
    ...(status.state === "connected"
      ? [
          `- **Live:** ${status.liveVersion}`,
          `- **Remote Script:** ${status.remoteScriptVersion}`,
        ]
      : []),
    ...(sessionId === undefined ? [] : [`- **Session:** ${sessionId}`]),
  ].join("\n");
}
