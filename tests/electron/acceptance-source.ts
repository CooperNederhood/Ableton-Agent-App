import { createHash, randomUUID } from "node:crypto";
import {
  inspectSessionListeningSourceParamsSchema,
  type InspectSessionListeningSourceParams,
  type InspectSessionListeningSourceResult,
} from "@ableton-agent/protocol";
import type { DesktopLiveSetSnapshot } from "../../apps/desktop/src/contracts.js";

export interface SessionSourceSelector {
  readonly trackName: string;
  readonly sceneIndex: number;
  readonly clipName: string;
}

export function sourceStoppedAtZero(
  source: Pick<InspectSessionListeningSourceResult, "before" | "after">,
): boolean {
  return [source.before, source.after].every(
    (state) =>
      state.transportPlaying === false &&
      state.globalBeat === 0 &&
      state.targetPlaying === false &&
      state.targetTriggered === false &&
      state.targetRecording === false &&
      (state.playingSlotIndex === -1 || state.playingSlotIndex === -2) &&
      state.firedSlotIndex === -1,
  );
}

export function resolveSessionSource(
  snapshot: DesktopLiveSetSnapshot,
  selector: SessionSourceSelector,
): InspectSessionListeningSourceParams {
  const tracks = snapshot.tracks.filter(
    (track) => track.name === selector.trackName && track.kind === "audio",
  );
  if (tracks.length !== 1)
    throw new Error("Fixture requires exactly one matching audio track");
  if (
    snapshot.sessionClips === undefined ||
    (snapshot.completeness?.truncatedDomains.length ?? 0) > 0
  ) {
    throw new Error("Session source evidence is missing or truncated");
  }
  const track = tracks[0]!;
  const clips = snapshot.sessionClips.filter(
    (clip) =>
      clip.trackId === track.id &&
      clip.sceneIndex === selector.sceneIndex &&
      clip.name === selector.clipName &&
      clip.kind === "audio",
  );
  if (clips.length !== 1)
    throw new Error("Fixture requires exactly one matching Session audio clip");
  const clip = clips[0]!;
  return inspectSessionListeningSourceParamsSchema.parse({
    schemaVersion: 1,
    queryId: randomUUID(),
    target: {
      view: "session",
      track: {
        kind: "regular",
        index: clip.trackIndex,
        expectedReference: track.id,
        expectedName: track.name,
      },
      sceneIndex: selector.sceneIndex,
      expectedClipReference: clip.id,
      expectedClipName: clip.name,
    },
  });
}

export function sessionStructureFingerprint(
  snapshot: DesktopLiveSetSnapshot,
): string {
  if (snapshot.sessionClips === undefined)
    throw new Error("Cannot verify Session structure without clip evidence");
  if (
    (snapshot.completeness?.truncatedDomains.length ?? 0) > 0 ||
    snapshot.tracks.some((track) => track.devicesTruncated)
  ) {
    throw new Error("Cannot verify truncated Set structure");
  }

  const structure = {
    liveSetId: snapshot.liveSetId,
    tempo: snapshot.tempo,
    timeSignature: snapshot.timeSignature,
    tracks: snapshot.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      index: track.index,
      muted: track.muted,
      soloed: track.soloed,
      armed: track.armed,
      volume: track.volume,
      pan: track.pan,
      inputRouting: track.inputRouting,
      outputRouting: track.outputRouting,
      groupTrackId: track.groupTrackId,
      devices: track.devices.map(({ id, name, type, enabled }) => ({
        id,
        name,
        type,
        enabled,
      })),
    })),
    scenes: snapshot.scenes,
    clips: snapshot.sessionClips.map((clip) =>
      Object.fromEntries(
        Object.entries(clip).filter(([key]) => key !== "status"),
      ),
    ),
    arrangementClips: snapshot.arrangementClips,
    cuePoints: snapshot.cuePoints,
    devices: snapshot.devices,
    completeness: snapshot.completeness,
  };
  return createHash("sha256").update(JSON.stringify(structure)).digest("hex");
}

export function unrelatedPlaybackFingerprint(
  snapshot: DesktopLiveSetSnapshot,
  allowedClipIds: readonly string[] = [],
): string {
  if (
    !snapshot.sessionClips ||
    (snapshot.completeness?.truncatedDomains.length ?? 0) > 0
  )
    throw new Error(
      "Cannot verify unrelated playback without complete Session evidence",
    );
  return createHash("sha256")
    .update(
      JSON.stringify(
        snapshot.sessionClips
          .filter((clip) => !allowedClipIds.includes(clip.id))
          .map(({ id, status }) => ({ id, status }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .digest("hex");
}
