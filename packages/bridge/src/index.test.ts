import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryEventPublisher } from "@ableton-agent/shared";

import { AbletonBridgeService } from "./index.js";

const token = "test-token-that-is-at-least-thirty-two-characters";
let simulator: ChildProcessWithoutNullStreams | undefined;

async function startSimulator(expectedToken = token): Promise<number> {
  simulator = spawn(
    "python3",
    ["remote-script/simulator.py", "--token", expectedToken],
    {
      cwd: new URL("../../..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: simulator.stdout });
  const line = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    simulator?.once("error", reject);
    simulator?.once("exit", (code) => {
      reject(new Error(`Simulator exited before startup with code ${code}`));
    });
  });
  lines.close();
  return (JSON.parse(line) as { port: number }).port;
}

afterEach(() => {
  simulator?.kill();
  simulator = undefined;
});

describe("AbletonBridgeService", () => {
  it("negotiates capabilities and sends ping across the Python protocol", async () => {
    const port = await startSimulator();
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
    });

    await service.start();

    expect(await service.getStatus()).toEqual({
      state: "connected",
      liveVersion: "12.1-simulator",
      remoteScriptVersion: "0.2.0",
      projectId: "simulated-project",
    });
    await expect(service.getCapabilities()).resolves.toMatchObject({
      selectedProtocolVersion: 2,
      capabilities: {
        "system.ping": true,
        "transport.set_tempo": true,
        "transport.set_playing": true,
        "tracks.create": true,
        "tracks.delete": true,
        "tracks.rename": true,
        "tracks.set_mixer": true,
        "clips.create_midi": true,
        "clips.replace_notes": true,
        "arrangement.create_midi_clip": true,
      },
    });
    await expect(service.ping()).resolves.toEqual({ pong: true });
    await expect(service.inspectSession()).resolves.toMatchObject({
      tempo: 120,
      trackCount: 2,
      tracks: [{ name: "Drums" }, { name: "Bass" }],
    });
    await expect(service.setTempo(132)).resolves.toEqual({
      beforeTempo: 120,
      afterTempo: 132,
      verified: true,
    });
    await expect(service.setPlaying(true)).resolves.toEqual({
      beforeIsPlaying: false,
      afterIsPlaying: true,
      verified: true,
    });
    await expect(
      service.createTrack({ kind: "audio", name: "Vocals" }),
    ).resolves.toMatchObject({
      beforeTrackCount: 2,
      afterTrackCount: 3,
      track: { index: 2, name: "Vocals", kind: "audio" },
      verified: true,
    });
    const snapshot = await service.inspectSession();
    const bass = snapshot.tracks.find((track) => track.name === "Bass");
    expect(bass).toBeDefined();
    await expect(
      service.deleteTrack({
        index: 1,
        expectedReference: bass?.reference ?? "",
        expectedName: "Bass",
        expectedKind: "midi",
      }),
    ).resolves.toEqual({
      beforeTrackCount: 3,
      afterTrackCount: 2,
      track: {
        index: 1,
        reference: bass?.reference,
        name: "Bass",
        kind: "midi",
      },
      verified: true,
    });
    const afterDelete = await service.inspectSession();
    const drums = afterDelete.tracks.find((track) => track.name === "Drums");
    expect(drums).toBeDefined();
    await expect(
      service.renameTrack({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Drums",
        name: "Main Drums",
      }),
    ).resolves.toEqual({
      reference: drums?.reference,
      index: 0,
      beforeName: "Drums",
      afterName: "Main Drums",
      verified: true,
    });
    await expect(
      service.setTrackMixer({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        isMuted: true,
        volume: 0.65,
        pan: 0.2,
      }),
    ).resolves.toMatchObject({
      reference: drums?.reference,
      index: 0,
      before: { isMuted: false, volume: 0.85, pan: 0 },
      after: { isMuted: true, volume: 0.65, pan: 0.2 },
      verified: true,
    });
    const createdClip = await service.createMidiClip({
      index: 0,
      expectedReference: drums?.reference ?? "",
      expectedName: "Main Drums",
      sceneIndex: 0,
      length: 4,
      name: "Beat",
    });
    expect(createdClip).toMatchObject({
      clip: {
        trackReference: drums?.reference,
        trackIndex: 0,
        sceneIndex: 0,
        name: "Beat",
        length: 4,
        noteCount: 0,
      },
      verified: true,
    });
    await expect(
      service.replaceMidiNotes({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
        allowPerNoteExpressionLoss: true,
        notes: [
          {
            pitch: 36,
            startTime: 0,
            duration: 0.25,
            velocity: 110,
            mute: false,
          },
        ],
      }),
    ).resolves.toMatchObject({
      clip: { reference: createdClip.clip.reference, noteCount: 1 },
      beforeNoteCount: 0,
      afterNoteCount: 1,
      verified: true,
    });
    await expect(
      service.replaceMidiNotes({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        sceneIndex: 0,
        expectedClipReference: createdClip.clip.reference,
        allowPerNoteExpressionLoss: false,
        notes: [],
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    await expect(
      service.createArrangementMidiClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        startTime: 8,
        length: 4,
        name: "Verse",
      }),
    ).resolves.toMatchObject({
      clip: {
        trackReference: drums?.reference,
        trackIndex: 0,
        name: "Verse",
        startTime: 8,
        endTime: 12,
        length: 4,
        noteCount: 0,
      },
      verified: true,
    });
    const arrangement = await service.inspectArrangement({
      offset: 0,
      limit: 10,
    });
    expect(arrangement).toMatchObject({
      total: 1,
      clips: [{ name: "Verse", kind: "midi", startTime: 8 }],
    });
    await expect(
      service.deleteArrangementClip({
        index: 0,
        expectedReference: drums?.reference ?? "",
        expectedName: "Main Drums",
        expectedClipReference: arrangement.clips[0]?.reference ?? "",
        expectedStartTime: 8,
      }),
    ).resolves.toMatchObject({
      beforeClipCount: 1,
      afterClipCount: 0,
      verified: true,
    });
    const vocals = afterDelete.tracks.find((track) => track.name === "Vocals");
    expect(vocals).toBeDefined();
    await expect(
      service.createArrangementMidiClip({
        index: 1,
        expectedReference: vocals?.reference ?? "",
        expectedName: "Vocals",
        startTime: 8,
        length: 4,
      }),
    ).rejects.toMatchObject({
      code: "unsupported_capability",
      retryable: false,
    });
    await service.stop();
  });

  it("reports a connection error without crashing startup", async () => {
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port: 1,
      requestTimeoutMs: 100,
    });

    await service.start();

    expect(await service.getStatus()).toMatchObject({
      state: "error",
      code: "connection_failed",
    });
  });

  it("preserves authentication failures as stable connection errors", async () => {
    const port = await startSimulator(
      "different-token-that-is-at-least-thirty-two-characters",
    );
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port,
    });

    await service.start();

    expect(await service.getStatus()).toMatchObject({
      state: "error",
      code: "authentication_failed",
    });
  });
});
