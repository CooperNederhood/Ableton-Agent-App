import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { OutputProducer } from "./contracts.js";
import {
  PRODUCER_PROTOCOL_VERSION,
  type ProducerResponse,
} from "./ingress-contracts.js";
import {
  SignalIngressServer,
  type SignalIngressEndpoint,
} from "./ingress-server.js";
import { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRouter } from "./router.js";
import { midiSample } from "./test-fixtures.js";

const SECRET = "a-secure-test-secret-that-is-at-least-32-characters";
const artifactRoot = resolve(
  "packages/signal-routing/.test-artifacts",
  randomUUID(),
);
const servers: SignalIngressServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await rm(artifactRoot, { recursive: true, force: true });
});

function producer(
  producerId = "producer",
  instanceId = `${producerId}-instance`,
): OutputProducer {
  return {
    producerId,
    instanceId,
    displayName: `Producer ${producerId}`,
    signalKind: "midi",
    schemaVersion: "midi-sample/v1",
  };
}

function hello(
  requestId = "hello",
  producerValue = producer(),
  secret = SECRET,
): object {
  return {
    type: "producer.hello",
    protocolVersion: PRODUCER_PROTOCOL_VERSION,
    requestId,
    secret,
    producer: producerValue,
  };
}

function frame(sequence: number, requestId = `frame-${sequence}`): object {
  return {
    type: "signal.frame",
    protocolVersion: PRODUCER_PROTOCOL_VERSION,
    requestId,
    sequence,
    capturedAt: 1000 + sequence,
    payload: { ...midiSample, sample_index: sequence },
  };
}

async function startServer(
  overrides: Partial<ConstructorParameters<typeof SignalIngressServer>[0]> = {},
): Promise<{
  server: SignalIngressServer;
  endpoint: SignalIngressEndpoint;
  registry: InMemoryConnectionRegistry;
}> {
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 10_000 });
  const router = new SignalRouter({ registry });
  const server = new SignalIngressServer({
    secret: SECRET,
    registry,
    router,
    port: 0,
    ...overrides,
  });
  servers.push(server);
  return { server, endpoint: await server.start(), registry };
}

async function openClient(
  endpoint: SignalIngressEndpoint,
): Promise<TestClient> {
  const socket = connect(endpoint.port, endpoint.host);
  sockets.push(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("connect", resolvePromise);
    socket.once("error", reject);
  });
  return new TestClient(socket);
}

class TestClient {
  readonly #socket: Socket;
  readonly #responses: ProducerResponse[] = [];
  readonly #waiters: Array<(response: ProducerResponse) => void> = [];
  #buffer = "";

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const response = JSON.parse(line) as ProducerResponse;
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
          this.#responses.push(response);
        } else {
          waiter(response);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  send(value: object): void {
    this.#socket.write(`${JSON.stringify(value)}\n`);
  }

  write(value: string | Buffer): void {
    this.#socket.write(value);
  }

  end(): void {
    this.#socket.end();
  }

  next(): Promise<ProducerResponse> {
    const response = this.#responses.shift();
    if (response !== undefined) {
      return Promise.resolve(response);
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for ingress response")),
        2000,
      );
      this.#waiters.push((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      });
    });
  }

  closed(): Promise<void> {
    if (this.#socket.closed) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise) =>
      this.#socket.once("close", () => resolvePromise()),
    );
  }
}

describe("SignalIngressServer", () => {
  it("requires an authenticated hello and rejects bad credentials", async () => {
    const { endpoint, registry } = await startServer();
    const unauthenticated = await openClient(endpoint);
    unauthenticated.send(frame(0));
    await expect(unauthenticated.next()).resolves.toMatchObject({
      code: "authentication-required",
      fatal: true,
    });

    const badSecret = await openClient(endpoint);
    badSecret.send(hello("bad", producer(), `${SECRET}-wrong`));
    await expect(badSecret.next()).resolves.toMatchObject({
      requestId: "bad",
      code: "authentication-failed",
      fatal: true,
    });
    expect(registry.list()).toHaveLength(0);
  });

  it("handshakes, handles chunked and coalesced frames, and routes them", async () => {
    const { endpoint, registry } = await startServer();
    const client = await openClient(endpoint);
    const encodedHello = `${JSON.stringify(hello())}\n`;
    client.write(encodedHello.slice(0, 17));
    client.write(encodedHello.slice(17));
    const acknowledgement = await client.next();
    expect(acknowledgement).toMatchObject({
      action: "hello",
      requestId: "hello",
    });
    const connectionId =
      acknowledgement.type === "producer.ack"
        ? acknowledgement.connectionId
        : undefined;
    expect(connectionId).toBeTypeOf("string");

    client.write(`${JSON.stringify(frame(0))}\n${JSON.stringify(frame(1))}\n`);
    await expect(client.next()).resolves.toMatchObject({
      action: "signal",
      requestId: "frame-0",
    });
    await expect(client.next()).resolves.toMatchObject({
      action: "signal",
      requestId: "frame-1",
    });
    expect(registry.get(connectionId as string)?.status).toBe("connected");
  });

  it("rejects malformed JSON, unsupported versions, and invalid payloads", async () => {
    const { endpoint } = await startServer();
    const malformed = await openClient(endpoint);
    malformed.write("{nope}\n");
    await expect(malformed.next()).resolves.toMatchObject({
      code: "malformed-json",
      fatal: true,
    });

    const unsupported = await openClient(endpoint);
    unsupported.send({ ...hello(), protocolVersion: 99 });
    await expect(unsupported.next()).resolves.toMatchObject({
      code: "unsupported-version",
      fatal: true,
    });

    const invalid = await openClient(endpoint);
    invalid.send(hello());
    await invalid.next();
    invalid.send({ ...frame(0), payload: { schema: "midi-sample/v1" } });
    await expect(invalid.next()).resolves.toMatchObject({
      code: "invalid-message",
      fatal: true,
    });
  });

  it("rejects oversized frames and bounded-queue overflow", async () => {
    const { endpoint } = await startServer({ maxFrameBytes: 256 });
    const oversized = await openClient(endpoint);
    oversized.write(`${"x".repeat(257)}\n`);
    await expect(oversized.next()).resolves.toMatchObject({
      code: "frame-too-large",
      fatal: true,
    });

    const { endpoint: boundedEndpoint } = await startServer({
      maxOutstandingMessages: 1,
    });
    const flooded = await openClient(boundedEndpoint);
    flooded.write(`${JSON.stringify(hello())}\n${JSON.stringify(frame(0))}\n`);
    await expect(flooded.next()).resolves.toMatchObject({
      code: "backpressure",
      fatal: true,
    });
  });

  it("rejects sequence replay without disconnecting the producer", async () => {
    const { endpoint } = await startServer();
    const client = await openClient(endpoint);
    client.send(hello());
    await client.next();
    client.send(frame(2));
    await expect(client.next()).resolves.toMatchObject({ action: "signal" });
    client.send(frame(2, "replay"));
    await expect(client.next()).resolves.toMatchObject({
      requestId: "replay",
      code: "sequence-replay",
      fatal: false,
    });
    client.send(frame(3));
    await expect(client.next()).resolves.toMatchObject({ action: "signal" });
  });

  it("accepts heartbeats and disconnects heartbeat-stale producers", async () => {
    const { endpoint, registry } = await startServer({
      idleTimeoutMs: 80,
      idleCheckIntervalMs: 10,
    });
    const client = await openClient(endpoint);
    client.send(hello());
    const helloAck = await client.next();
    const connectionId =
      helloAck.type === "producer.ack" ? helloAck.connectionId : undefined;
    client.send({
      type: "producer.heartbeat",
      protocolVersion: PRODUCER_PROTOCOL_VERSION,
      requestId: "heartbeat",
    });
    await expect(client.next()).resolves.toMatchObject({
      action: "heartbeat",
    });
    await expect(client.next()).resolves.toMatchObject({
      code: "idle-timeout",
      fatal: true,
    });
    await client.closed();
    await expect
      .poll(() => registry.get(connectionId as string)?.status)
      .toBe("disconnected");
  });

  it("rejects duplicate live instances and permits reconnect after disconnect", async () => {
    const { endpoint } = await startServer();
    const first = await openClient(endpoint);
    first.send(hello());
    await expect(first.next()).resolves.toMatchObject({ action: "hello" });

    const duplicate = await openClient(endpoint);
    duplicate.send(hello("duplicate"));
    await expect(duplicate.next()).resolves.toMatchObject({
      code: "duplicate-instance",
      fatal: true,
    });

    first.send({
      type: "producer.disconnect",
      protocolVersion: PRODUCER_PROTOCOL_VERSION,
      requestId: "bye",
    });
    await expect(first.next()).resolves.toMatchObject({ action: "disconnect" });
    await first.closed();

    const replacement = await openClient(endpoint);
    replacement.send(hello("replacement"));
    await expect(replacement.next()).resolves.toMatchObject({
      action: "hello",
      requestId: "replacement",
    });
  });

  it("writes a secret-free 0600 descriptor and removes only its own content", async () => {
    await mkdir(artifactRoot, { recursive: true });
    const descriptorPath = resolve(artifactRoot, "ingress.json");
    const { server, endpoint } = await startServer({ descriptorPath });
    const descriptorText = await readFile(descriptorPath, "utf8");
    expect(JSON.parse(descriptorText)).toEqual({
      host: "127.0.0.1",
      port: endpoint.port,
      protocol: "newline-delimited-json",
      protocolVersion: PRODUCER_PROTOCOL_VERSION,
      maxFrameBytes: 128 * 1024,
    });
    expect(descriptorText).not.toContain(SECRET);
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);

    await writeFile(descriptorPath, "replacement\n", { mode: 0o644 });
    await chmod(descriptorPath, 0o644);
    await server.stop();
    expect(await readFile(descriptorPath, "utf8")).toBe("replacement\n");
  });

  it("shuts down idempotently, closes clients, and removes its descriptor", async () => {
    await mkdir(artifactRoot, { recursive: true });
    const descriptorPath = resolve(artifactRoot, "shutdown.json");
    const { server, endpoint } = await startServer({ descriptorPath });
    const client = await openClient(endpoint);
    client.send(hello());
    await client.next();
    const firstStop = server.stop();
    const secondStop = server.stop();
    expect(secondStop).toBe(firstStop);
    await expect(client.next()).resolves.toMatchObject({
      code: "server-shutdown",
      fatal: true,
    });
    await firstStop;
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
