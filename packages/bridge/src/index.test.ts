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
      selectedProtocolVersion: 1,
      capabilities: {
        "system.ping": true,
        "transport.set_tempo": true,
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
