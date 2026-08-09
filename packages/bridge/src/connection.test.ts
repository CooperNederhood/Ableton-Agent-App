import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FrameDecoder,
  PROTOCOL_VERSION,
  encodeFrame,
  type EventEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "@ableton-agent/protocol";
import { InMemoryEventPublisher, type AppEvent } from "@ableton-agent/shared";

import { AbletonBridgeService } from "./index.js";

const token = "test-token-that-is-at-least-thirty-two-characters";
const projectId = "bridge-test-project";

interface TestServer {
  readonly server: Server;
  readonly port: number;
  readonly requests: RequestEnvelope[];
  readonly sockets: Socket[];
}

async function startServer(
  onRequest?: (request: RequestEnvelope, socket: Socket) => void,
  respondToHello = true,
): Promise<TestServer> {
  const requests: RequestEnvelope[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind !== "request") continue;
        requests.push(message);
        if (message.command === "system.hello") {
          if (!respondToHello) continue;
          const response: ResponseEnvelope = {
            protocolVersion: PROTOCOL_VERSION,
            kind: "response",
            requestId: message.requestId,
            ok: true,
            result: {
              selectedProtocolVersion: PROTOCOL_VERSION,
              liveVersion: "12.1-test",
              remoteScriptVersion: "0.4.0",
              projectId,
              capabilities: { "system.ping": true },
              limits: { maxFrameBytes: 1_048_576, maxBatchItems: 128 },
            },
            warnings: [],
          };
          socket.write(encodeFrame(response));
        } else {
          onRequest?.(message, socket);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return { server, port: address.port, requests, sockets };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const servers: Server[] = [];
const services: AbletonBridgeService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  vi.useRealTimers();
});

describe("Ableton bridge connection manager", () => {
  it("stays disconnected when stopped during an in-flight handshake", async () => {
    const testServer = await startServer(undefined, false);
    servers.push(testServer.server);
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: new InMemoryEventPublisher(),
      port: testServer.port,
      requestTimeoutMs: 50,
    });
    services.push(service);

    const start = service.start();
    await waitFor(() => testServer.sockets.length === 1);
    await service.stop();
    await start;

    await expect(service.getStatus()).resolves.toEqual({
      state: "disconnected",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(testServer.sockets).toHaveLength(1);
  });

  it("orders events, reports sequence gaps, and propagates revisions", async () => {
    const testServer = await startServer((request, socket) => {
      if (request.command === "system.ping") {
        const response: ResponseEnvelope = {
          protocolVersion: PROTOCOL_VERSION,
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { pong: true },
          projectRevision: 9,
          warnings: [],
        };
        socket.write(encodeFrame(response));
      }
    });
    servers.push(testServer.server);
    const publisher = new InMemoryEventPublisher();
    const appEvents: AppEvent[] = [];
    publisher.subscribe((event) => appEvents.push(event));
    const bridgeEvents: string[] = [];
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: publisher,
      port: testServer.port,
      eventSubscriptions: ["project.changed"],
    });
    services.push(service);
    service.subscribe((event) => bridgeEvents.push(event.event));

    await service.start();
    const socket = testServer.sockets[0];
    const first: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      kind: "event",
      event: "project.changed",
      sequence: 4,
      payload: { reason: "tempo" },
      projectRevision: 7,
    };
    const gap: EventEnvelope = {
      ...first,
      sequence: 6,
      projectRevision: 8,
    };
    socket?.write(Buffer.concat([encodeFrame(first), encodeFrame(gap)]));
    await waitFor(() => bridgeEvents.length === 2);

    expect(bridgeEvents).toEqual(["project.changed", "project.changed"]);
    expect(appEvents).toContainEqual({
      type: "ableton.event_gap",
      expectedSequence: 5,
      receivedSequence: 6,
    });
    expect(service.getProjectRevision()).toBe(8);

    await service.ping();
    expect(testServer.requests.at(-1)?.projectRevision).toBe(8);
    expect(service.getProjectRevision()).toBe(9);
    expect(testServer.requests[0]?.params).toMatchObject({
      eventSubscriptions: ["project.changed"],
    });
  });

  it("reconnects after an established socket closes", async () => {
    const testServer = await startServer();
    servers.push(testServer.server);
    const statuses: AppEvent[] = [];
    const publisher = new InMemoryEventPublisher();
    publisher.subscribe((event) => statuses.push(event));
    const service = new AbletonBridgeService({
      authenticationToken: token,
      events: publisher,
      port: testServer.port,
      reconnect: {
        maxAttempts: 2,
        initialDelayMs: 5,
        maxDelayMs: 5,
        jitterRatio: 0,
      },
    });
    services.push(service);

    await service.start();
    testServer.sockets[0]?.destroy();
    await waitFor(
      () =>
        statuses.filter(
          (event) =>
            event.type === "ableton.connection_changed" &&
            event.status.state === "connected",
        ).length === 2,
    );

    expect(testServer.sockets).toHaveLength(2);
    await expect(service.getStatus()).resolves.toMatchObject({
      state: "connected",
      projectId,
    });
  });
});
