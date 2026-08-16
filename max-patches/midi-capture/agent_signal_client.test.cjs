/* global setTimeout */

const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");

const {
  AgentSignalClient,
  PROTOCOL_VERSION,
} = require("./agent_signal_client.js");

const SECRET = "local-test-secret-that-is-at-least-32-characters";

function sample(index) {
  return {
    schema: "midi-sample/v1",
    sample_index: index,
    complete: true,
    end_reason: "boundary",
    start_tick: index * 480,
    end_tick: (index + 1) * 480,
    ppq: 480,
    start_beat: index,
    end_beat: index + 1,
    length_beats: 1,
    tempo_bpm_at_start: 120,
    time_signature_at_start: [4, 4],
    notes: [],
  };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

async function createIngress(onMessage) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          onMessage(JSON.parse(line), socket);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    descriptor: {
      host: "127.0.0.1",
      port: server.address().port,
      protocol: "newline-delimited-json",
      protocolVersion: PROTOCOL_VERSION,
      maxFrameBytes: 128 * 1024,
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createClient(descriptor, overrides = {}) {
  return new AgentSignalClient({
    descriptorPath: "descriptor.json",
    secret: SECRET,
    instanceId: "runtime-instance",
    readText: async () => JSON.stringify(descriptor),
    reconnectInitialMs: 10,
    reconnectMaxMs: 20,
    heartbeatMs: 25,
    ...overrides,
  });
}

test("registers, handles chunked acks, sends samples, and heartbeats", async () => {
  const received = [];
  const ingress = await createIngress((message, socket) => {
    received.push(message);
    const action =
      message.type === "producer.hello"
        ? "hello"
        : message.type === "signal.frame"
          ? "signal"
          : message.type === "producer.disconnect"
            ? "disconnect"
            : "heartbeat";
    const ack = `${JSON.stringify({
      type: "producer.ack",
      protocolVersion: 1,
      requestId: message.requestId,
      action,
      ...(action === "hello" ? { connectionId: "connection-1" } : {}),
    })}\n`;
    socket.write(ack.slice(0, 7));
    socket.write(ack.slice(7));
  });
  const client = createClient(ingress.descriptor);
  client.start();
  await waitFor(() => client.isConnected());
  assert.equal(client.connectionId, "connection-1");
  client.sendSample(sample(0), 1234);
  await waitFor(() =>
    received.find((message) => message.type === "signal.frame"),
  );
  const hello = received.find((message) => message.type === "producer.hello");
  assert.deepEqual(hello.producer, {
    producerId: "ableton-midi-capture:runtime-instance",
    instanceId: "runtime-instance",
    displayName: "Midi-Capture",
    signalKind: "midi",
    schemaVersion: "midi-sample/v1",
  });
  assert.equal(hello.secret, SECRET);
  const frame = received.find((message) => message.type === "signal.frame");
  assert.equal(frame.sequence, 0);
  assert.equal(frame.capturedAt, 1234);
  assert.deepEqual(frame.payload, sample(0));
  assert.equal("connectionId" in frame, false);
  await waitFor(() =>
    received.find((message) => message.type === "producer.heartbeat"),
  );
  client.stop();
  await waitFor(() =>
    received.find((message) => message.type === "producer.disconnect"),
  );
  await ingress.close();
});

test("reconnects with monotonic sequence and flushes a bounded offline queue", async () => {
  const received = [];
  let helloCount = 0;
  const ingress = await createIngress((message, socket) => {
    received.push(message);
    if (message.type === "producer.hello") {
      helloCount += 1;
      if (helloCount === 1) {
        socket.destroy();
        return;
      }
      socket.write(
        `${JSON.stringify({
          type: "producer.ack",
          protocolVersion: 1,
          requestId: message.requestId,
          action: "hello",
          connectionId: `connection-${helloCount}`,
        })}\n`,
      );
      return;
    }
    socket.write(
      `${JSON.stringify({
        type: "producer.ack",
        protocolVersion: 1,
        requestId: message.requestId,
        action: message.type === "signal.frame" ? "signal" : "heartbeat",
      })}\n`,
    );
  });
  const statuses = [];
  const client = createClient(ingress.descriptor, {
    maxOfflineSamples: 2,
    onStatus: (...items) => statuses.push(items),
  });
  client.start();
  client.sendSample(sample(0), 100);
  client.sendSample(sample(1), 101);
  client.sendSample(sample(2), 102);
  await waitFor(
    () =>
      received.filter((message) => message.type === "signal.frame").length ===
      2,
  );
  const frames = received.filter((message) => message.type === "signal.frame");
  assert.deepEqual(
    frames.map((frame) => frame.payload.sample_index),
    [1, 2],
  );
  assert.deepEqual(
    frames.map((frame) => frame.sequence),
    [0, 1],
  );
  assert.ok(
    statuses.some(
      (status) => status[0] === "live" && status[1] === "queue_coalesced",
    ),
  );
  client.stop();
  await ingress.close();
});

test("missing or invalid discovery remains nonfatal and stop cancels retry", async () => {
  const statuses = [];
  let attempts = 0;
  const client = new AgentSignalClient({
    descriptorPath: "missing.json",
    secret: SECRET,
    readText: async () => {
      attempts += 1;
      throw new Error("not found");
    },
    reconnectInitialMs: 10,
    reconnectMaxMs: 10,
    onStatus: (...items) => statuses.push(items),
  });
  client.start();
  client.sendSample(sample(0));
  await waitFor(() => attempts >= 2);
  assert.equal(client.offlineQueue.length, 1);
  assert.ok(
    statuses.some(
      (status) => status[0] === "live" && status[1] === "unavailable",
    ),
  );
  client.stop();
  const stoppedAttempts = attempts;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(attempts, stoppedAttempts);

  await assert.rejects(
    () =>
      new AgentSignalClient({
        descriptorPath: "invalid.json",
        secret: SECRET,
        readText: async () => "{}",
      }).loadDescriptor(),
    /invalid ingress descriptor/,
  );
});

test("drops oversized samples without leaking secrets in status", async () => {
  const received = [];
  const statuses = [];
  const ingress = await createIngress((message, socket) => {
    received.push(message);
    socket.write(
      `${JSON.stringify({
        type: "producer.ack",
        protocolVersion: 1,
        requestId: message.requestId,
        action: message.type === "producer.hello" ? "hello" : "signal",
        ...(message.type === "producer.hello"
          ? { connectionId: "connection" }
          : {}),
      })}\n`,
    );
  });
  const client = createClient(ingress.descriptor, {
    maxFrameBytes: 512,
    onStatus: (...items) => statuses.push(items),
  });
  client.start();
  await waitFor(() => client.isConnected());
  client.sendSample({ ...sample(0), notes: ["x".repeat(1000)] });
  await waitFor(() =>
    statuses.find(
      (status) => status[0] === "live" && status[1] === "sample_dropped",
    ),
  );
  assert.equal(
    received.filter((message) => message.type === "signal.frame").length,
    0,
  );
  assert.equal(JSON.stringify(statuses).includes(SECRET), false);
  client.stop();
  await ingress.close();
});

test("handles recoverable ingress errors without disconnecting", async () => {
  const statuses = [];
  let signalCount = 0;
  const ingress = await createIngress((message, socket) => {
    if (message.type === "producer.hello") {
      socket.write(
        `${JSON.stringify({
          type: "producer.ack",
          protocolVersion: 1,
          requestId: message.requestId,
          action: "hello",
          connectionId: "connection",
        })}\n`,
      );
      return;
    }
    if (message.type === "signal.frame") {
      signalCount += 1;
      socket.write(
        `${JSON.stringify({
          type: "producer.error",
          protocolVersion: 1,
          requestId: message.requestId,
          code: "route-rejected",
          message: "not routed",
          fatal: false,
        })}\n`,
      );
    }
  });
  const client = createClient(ingress.descriptor, {
    heartbeatMs: 1000,
    onStatus: (...items) => statuses.push(items),
  });
  client.start();
  await waitFor(() => client.isConnected());
  client.sendSample(sample(0));
  await waitFor(() =>
    statuses.find(
      (status) =>
        status[0] === "live" &&
        status[1] === "server_error" &&
        status[2] === "route-rejected",
    ),
  );
  assert.equal(signalCount, 1);
  assert.equal(client.isConnected(), true);
  client.stop();
  await ingress.close();
});
