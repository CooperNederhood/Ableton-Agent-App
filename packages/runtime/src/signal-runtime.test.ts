import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalTurnRequest } from "@ableton-agent/application";

import { DefaultSignalRuntime } from "./signal-runtime.js";

const artifacts = join(
  process.cwd(),
  "packages/runtime/.test-artifacts/signal-runtime",
);
const sockets: Socket[] = [];
const runtimes: DefaultSignalRuntime[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await rm(artifacts, { recursive: true, force: true });
});

async function producer(runtime: DefaultSignalRuntime, descriptorPath: string) {
  await runtime.start();
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
    host: string;
    port: number;
  };
  const socket = connect(descriptor);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  const replies: unknown[] = [];
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      replies.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const send = async (message: unknown): Promise<unknown> => {
    socket.write(`${JSON.stringify(message)}\n`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (replies.length > 0) return replies.shift();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Producer response timed out");
  };
  await send({
    type: "producer.hello",
    protocolVersion: 1,
    requestId: "hello",
    secret: "s".repeat(32),
    producer: {
      producerId: "producer-1",
      instanceId: randomUUID(),
      displayName: "MIDI output",
      signalKind: "midi",
      schemaVersion: "midi-sample/v1",
    },
  });
  return send;
}

function frame(sequence: number) {
  return {
    type: "signal.frame",
    protocolVersion: 1,
    requestId: `signal-${sequence}`,
    sequence,
    capturedAt: sequence + 100,
    payload: {
      schema: "midi-sample/v1",
      sample_index: sequence,
      complete: true,
      end_reason: "window",
      start_tick: 0,
      end_tick: 480,
      ppq: 480,
      start_beat: 0,
      end_beat: 1,
      length_beats: 1,
      tempo_bpm_at_start: 120,
      time_signature_at_start: [4, 4],
      notes: [],
    },
  };
}

describe("default signal runtime", () => {
  it("is explicitly disabled without a token", async () => {
    const runtime = new DefaultSignalRuntime({});
    runtimes.push(runtime);
    await runtime.start();
    expect(runtime.getStatus()).toMatchObject({ state: "disabled" });
  });

  it("isolates sessions and selectively acknowledges pending windows", async () => {
    await mkdir(artifacts, { recursive: true });
    const descriptorPath = join(artifacts, `${randomUUID()}.json`);
    const runtime = new DefaultSignalRuntime({
      secret: "s".repeat(32),
      descriptorPath,
      port: 0,
    });
    runtimes.push(runtime);
    runtime.upsertAssignment({
      assignmentId: "assignment-1",
      producerId: "producer-1",
      consumer: { kind: "agent-session", id: "session-1" },
      deliveryMode: "next-prompt",
      enabled: true,
      usageInstruction: "Use safely.",
      processingPolicyIds: [],
    });
    runtime.setActiveSession("session-1");
    const send = await producer(runtime, descriptorPath);
    await send(frame(1));
    await send(frame(2));

    await expect(
      runtime.provider.getPendingContexts("session-2"),
    ).resolves.toEqual([]);
    const pending = await runtime.provider.getPendingContexts("session-1");
    expect(pending.map(({ context }) => context.sequence)).toEqual([1, 2]);
    await runtime.provider.markDelivered("session-1", [pending[0]!.deliveryId]);
    await expect(
      runtime.provider.getPendingContexts("session-1"),
    ).resolves.toMatchObject([{ context: { sequence: 2 } }]);
  });

  it("triggers each automatic accepted window once", async () => {
    await mkdir(artifacts, { recursive: true });
    const descriptorPath = join(artifacts, `${randomUUID()}.json`);
    const runtime = new DefaultSignalRuntime({
      secret: "s".repeat(32),
      descriptorPath,
      port: 0,
    });
    runtimes.push(runtime);
    const enqueueSignalTurn = vi.fn((request: SignalTurnRequest) => {
      void request;
      return Promise.resolve("done");
    });
    runtime.setDeliveryService({ enqueueSignalTurn });
    runtime.upsertAssignment({
      assignmentId: "assignment-1",
      producerId: "producer-1",
      consumer: { kind: "agent-session", id: "session-1" },
      deliveryMode: "automatic-analysis",
      enabled: true,
      usageInstruction: "Analyze safely.",
      processingPolicyIds: ["latest-window"],
    });
    runtime.setActiveSession("session-1");
    const send = await producer(runtime, descriptorPath);
    await send(frame(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(enqueueSignalTurn).toHaveBeenCalledOnce();
    const request = enqueueSignalTurn.mock.calls[0]?.[0];
    expect(request?.deliveryId).toBe("assignment-1:1");
    expect(request?.context.deliveryMode).toBe("automatic-analysis");
  });
});
