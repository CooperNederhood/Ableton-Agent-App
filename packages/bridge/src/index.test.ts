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
