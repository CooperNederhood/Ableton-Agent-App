/* global setTimeout */

const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");

const {
  AgentSignalClient,
  PROTOCOL_VERSION,
  producerIdForCanonicalPath,
  validateProducerIdentity,
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
  const client = new AgentSignalClient({
    descriptorPath: "descriptor.json",
    secret: SECRET,
    instanceId: "runtime-instance",
    readText: async () => JSON.stringify(descriptor),
    reconnectInitialMs: 10,
    reconnectMaxMs: 20,
    heartbeatMs: 25,
    ...overrides,
  });
  client.configureProducer({
    canonicalPath: "live_set tracks 2 devices 1",
    track: { id: "17", index: 2, name: "Drums" },
    device: { id: "29", name: "Midi-Capture" },
  });
  return client;
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
    producerId: producerIdForCanonicalPath("live_set tracks 2 devices 1"),
    instanceId: "runtime-instance",
    displayName: "Midi-Capture",
    signalKind: "midi",
    schemaVersion: "midi-sample/v1",
    track: { id: "17", index: 2, name: "Drums" },
    device: { id: "29", name: "Midi-Capture" },
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
  client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", index: 0, name: "Track" },
    device: { id: "2", name: "Midi-Capture" },
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

test("derives deterministic path identities and validates metadata", () => {
  const first = producerIdForCanonicalPath("live_set tracks 2 devices 1");
  const second = producerIdForCanonicalPath("live_set tracks 2 devices 1");
  const duplicate = producerIdForCanonicalPath("live_set tracks 2 devices 2");
  assert.equal(first, second);
  assert.notEqual(first, duplicate);
  assert.match(first, /^ableton-midi-capture:path:[a-f0-9]{32}$/);

  assert.deepEqual(
    validateProducerIdentity({
      canonicalPath: " live_set tracks 2 devices 1 ",
      track: { id: "17", name: "Drums" },
      device: { id: "29", name: "Midi-Capture" },
    }),
    {
      canonicalPath: "live_set tracks 2 devices 1",
      track: { id: "17", name: "Drums" },
      device: { id: "29", name: "Midi-Capture" },
    },
  );
  assert.throws(
    () =>
      validateProducerIdentity({
        canonicalPath: "live_set tracks 2 devices 1",
        track: { id: "17", index: -1, name: "Drums" },
        device: { id: "29", name: "Midi-Capture" },
      }),
    /track.index/,
  );
});

test("requires producer configuration before startup and keeps it immutable", () => {
  const client = new AgentSignalClient({
    descriptorPath: "descriptor.json",
    secret: SECRET,
    readText: async () => "{}",
  });
  assert.throws(
    () => client.start(),
    /producer identity must be configured before startup/,
  );
  client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", index: 0, name: "Track" },
    device: { id: "2", name: "Midi-Capture" },
  });
  client.start();
  assert.throws(
    () =>
      client.configureProducer({
        canonicalPath: "live_set tracks 0 devices 1",
        track: { id: "1", index: 0, name: "Track" },
        device: { id: "3", name: "Midi-Capture" },
      }),
    /cannot change after startup/,
  );
  client.stop();
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

test("MIDI compatibility entry point exports the single common implementation and unchanged IDs", () => {
  const common = require("../shared/agent_signal_client.js");
  assert.equal(AgentSignalClient, common.AgentSignalClient);
  const canonicalPath = "live_set tracks 2 devices 1";
  assert.equal(
    producerIdForCanonicalPath(canonicalPath),
    common.producerIdForCanonicalPath(canonicalPath, "ableton-midi-capture"),
  );
  assert.notEqual(
    producerIdForCanonicalPath(canonicalPath),
    common.producerIdForCanonicalPath(canonicalPath, "ableton-audio-listener"),
  );
});

function audioClient(descriptor, overrides = {}) {
  return createClient(
    {
      ...descriptor,
      listenerVersions: [1],
      listenerCapabilities: ["audio-listener/v1"],
    },
    {
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      producerIdPrefix: "ableton-audio-listener",
      displayName: "Audio Listener",
      listener: {
        version: 1,
        capabilities: ["audio-listener/v1"],
        sampleRate: 48000,
        algorithmVersion: "native/v1",
      },
      ...overrides,
    },
  );
}

function descriptiveClient(descriptor, overrides = {}) {
  const { sampleRate = 44100, ...clientOptions } = overrides;
  return createClient(
    {
      ...descriptor,
      listenerVersions: [1, 2],
      listenerCapabilities: ["audio-listener/v1", "audio-listener/v2"],
    },
    {
      signalKind: "audio",
      schemaVersion: "audio-observation/v2",
      listener: {
        version: 2,
        capabilities: ["audio-listener/v2"],
        sampleRate,
        vectorSize: 64,
        algorithmVersion: "2.0.0",
        nativeStatus: {
          version: 2,
          scope: "arrangement-descriptive/v2",
          readiness: "BLOCKED",
          alignment: "approximate",
          verifiedAbsoluteErrorBoundSamples: null,
          acceptedSampleRates: [44100, 48000],
          acceptedVectorSizes: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
          timingModes: ["descriptive", "strict"],
          maxClockDisagreementSamples: 480,
          maxAudioDurationMs: 30000,
          maxWindows: 300,
          abiVersion: 2,
          reason: "fresh_per_pass_native_validation_required",
        },
      },
      ...clientOptions,
    },
  );
}

function descriptiveConfig() {
  return {
    geometry: {
      sampleRate: 44100,
      vectorSize: 64,
      tempoBpm: 93,
      startBeat: 5.25,
      endBeat: 8.35,
      hopSamples: 4410,
      totalSamples: 88200,
    },
    timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
  };
}

function descriptiveControl(client, action = "prepare") {
  return {
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 2,
    requestId: action,
    connectionEpoch: client.listener.connectionEpoch,
    jobId: "job",
    passId: "pass",
    traceId: "trace",
    correlationId: "correlation",
    causationId: "causation",
    action,
    ...(action === "prepare" ? { config: descriptiveConfig() } : {}),
  };
}

test("explicit v2 clients negotiate their exact capability and preserve wire ownership and version", async () => {
  const messages = [];
  const failures = [];
  let serverSocket;
  const ingress = await createIngress((message, socket) => {
    serverSocket = socket;
    messages.push(message);
    socket.write(
      `${JSON.stringify({
        type: "producer.ack",
        protocolVersion: 1,
        requestId: message.requestId,
        action: message.type === "producer.hello" ? "hello" : "listener",
        ...(message.type === "producer.hello"
          ? { connectionId: "descriptive-connection" }
          : {}),
      })}\n`,
    );
  });
  let client;
  try {
    client = descriptiveClient(ingress.descriptor, {
      onListenerFailure: (reason) => failures.push(reason),
      onListenerControl: (control) =>
        client.sendListenerReply(control, { status: "ready" }),
    });
    client.start();
    await waitFor(() => client.isConnected());
    assert.equal(messages[0].producer.schemaVersion, "audio-observation/v2");
    assert.equal(messages[0].listener.version, 2);
    const control = descriptiveControl(client);
    serverSocket.write(`${JSON.stringify(control)}\n`);
    const reply = await waitFor(() =>
      messages.find((message) => message.type === "listener.reply"),
    );
    for (const key of [
      "listenerVersion",
      "connectionEpoch",
      "jobId",
      "passId",
      "traceId",
      "correlationId",
      "causationId",
    ]) {
      assert.equal(reply[key], control[key]);
    }
    client.sendListenerResult(control, {
      status: "failed",
      reason: "synthetic_capture_denial",
    });
    const result = await waitFor(() =>
      messages.find((message) => message.type === "listener.result"),
    );
    assert.equal(result.listenerVersion, 2);
    assert.equal(result.sequence, reply.sequence + 1);
    assert.equal(client.listenerJob, null);
    assert.deepEqual(failures, []);
  } finally {
    client?.stop();
    await ingress.close();
  }
});

test("v2 cannot fall back to v1 descriptor advertisement or mismatched schema", async () => {
  const client = descriptiveClient({});
  await assert.rejects(
    () => client.loadDescriptor(),
    /invalid ingress descriptor/,
  );
  const legacy = {
    host: "127.0.0.1",
    port: 12345,
    protocol: "newline-delimited-json",
    protocolVersion: 1,
    maxFrameBytes: 128 * 1024,
    listenerVersions: [1],
    listenerCapabilities: ["audio-listener/v1"],
  };
  client.readText = async () => JSON.stringify(legacy);
  await assert.rejects(() => client.loadDescriptor(), /not advertised/);
  client.readText = async () =>
    JSON.stringify({ ...legacy, listenerVersions: [1, 2] });
  await assert.rejects(() => client.loadDescriptor(), /not advertised/);
  assert.throws(
    () => descriptiveClient({}, { schemaVersion: "audio-observation/v1" }),
    /listener capability requires/,
  );
  for (const change of [
    { version: 1 },
    { version: 3 },
    { version: "2" },
    { capabilities: ["audio-listener/v1"] },
    { capabilities: ["audio-listener/v1", "audio-listener/v2"] },
  ]) {
    assert.throws(
      () =>
        descriptiveClient({}, { listener: { ...client.listener, ...change } }),
      /listener capability requires/,
    );
  }
});

test("v2 admits only bounded coherent prepare geometry and no configuration on arm or cancel", () => {
  const client = descriptiveClient({});
  client.listener = { ...client.listener, connectionEpoch: "epoch" };
  const failures = [];
  const admitted = [];
  client.authenticated = true;
  client.socket = { destroy() {} };
  client.onListenerFailure = (reason) => failures.push(reason);
  client.onListenerControl = (control) => admitted.push(control);
  const valid = descriptiveControl(client);
  const invalid = [
    { ...valid, listenerVersion: 1 },
    { ...valid, config: undefined },
    { ...valid, config: { ...valid.config, extra: 1 } },
    {
      ...valid,
      config: {
        ...valid.config,
        geometry: { ...valid.config.geometry, totalSamples: 88201 },
      },
    },
    {
      ...valid,
      config: {
        ...valid.config,
        geometry: { ...valid.config.geometry, vectorSize: 63 },
      },
    },
    {
      ...valid,
      config: {
        ...valid.config,
        timingPolicy: { mode: "strict", maxClockDisagreementSamples: 64 },
      },
    },
    {
      ...valid,
      config: {
        ...valid.config,
        timingPolicy: { mode: "descriptive", maxClockDisagreementSamples: 481 },
      },
    },
    { ...descriptiveControl(client, "arm"), config: valid.config },
    { ...descriptiveControl(client, "cancel"), config: valid.config },
  ];
  for (const control of invalid) client.handleListenerControl(control);
  assert.equal(failures.length, invalid.length);
  assert.equal(admitted.length, 0);
  assert.equal(client.listenerJob, null);
  client.handleListenerControl(valid);
  assert.equal(admitted.length, 1);
  assert.deepEqual(client.listenerJob, valid);
  assert(Object.isFrozen(client.listenerJob.config.geometry));
  client.handleListenerControl(descriptiveControl(client, "arm"));
  assert.equal(admitted.length, 2);
});

test("v2 transport admits both actual-rate geometries, exact tails, maximum duration and all tuning budgets", () => {
  for (const rate of [44100, 48000]) {
    const hop = rate / 10;
    for (const count of [hop, hop + 1, rate * 30]) {
      for (const budget of [0, 1, 64, 128, 480]) {
        const client = descriptiveClient({}, { sampleRate: rate });
        client.listener = { ...client.listener, connectionEpoch: "epoch" };
        client.authenticated = true;
        const admitted = [];
        client.onListenerControl = (control) => admitted.push(control);
        const control = descriptiveControl(client);
        control.config.geometry = {
          ...control.config.geometry,
          sampleRate: rate,
          totalSamples: count,
          hopSamples: hop,
          endBeat: 5.25 + (count * 93) / (rate * 60),
        };
        control.config.timingPolicy.maxClockDisagreementSamples = budget;
        client.handleListenerControl(control);
        assert.equal(admitted.length, 1);
        if (budget === 0) {
          const strict = descriptiveClient({}, { sampleRate: rate });
          strict.listener = { ...strict.listener, connectionEpoch: "epoch" };
          strict.authenticated = true;
          strict.onListenerControl = (value) => admitted.push(value);
          strict.handleListenerControl({
            ...control,
            config: {
              ...control.config,
              timingPolicy: { mode: "strict", maxClockDisagreementSamples: 0 },
            },
          });
          assert.equal(admitted.length, 2);
        }
      }
    }
  }
});

for (const listenerVersion of [1, 2])
  test(`audio v${listenerVersion} controls preserve trace context, rotate reconnect epochs, and reject stale controls`, async () => {
    const messages = [];
    const failures = [];
    let serverSocket;
    const ingress = await createIngress((message, socket) => {
      serverSocket = socket;
      messages.push(message);
      socket.write(
        `${JSON.stringify({
          type: "producer.ack",
          protocolVersion: 1,
          requestId: message.requestId,
          action: message.type === "producer.hello" ? "hello" : "listener",
          ...(message.type === "producer.hello"
            ? { connectionId: "audio-connection" }
            : {}),
        })}\n`,
      );
    });
    let client;
    client = (listenerVersion === 2 ? descriptiveClient : audioClient)(
      ingress.descriptor,
      {
        onListenerFailure: (reason) => failures.push(reason),
        onListenerControl: (control) =>
          client.sendListenerReply(control, { status: "ready" }),
      },
    );
    client.sendSample({ schema: `audio-observation/v${listenerVersion}` });
    assert.equal(client.offlineQueue.length, 0);
    assert.ok(failures.includes("offline_audio_not_replayed"));
    client.start();
    await waitFor(() => client.isConnected());
    const firstEpoch = client.listener.connectionEpoch;
    const control = {
      type: "listener.control",
      protocolVersion: 1,
      listenerVersion,
      requestId: "prepare",
      connectionEpoch: firstEpoch,
      jobId: "job",
      passId: "pass",
      traceId: "trace",
      correlationId: "correlation",
      causationId: "causation",
      action: "prepare",
      config:
        listenerVersion === 2
          ? descriptiveConfig()
          : {
              durationMs: 1000,
              maxWindows: 8,
              source: { mode: "session", startBeat: 0, endBeat: 2 },
            },
    };
    serverSocket.write(`${JSON.stringify(control)}\n`);
    const reply = await waitFor(() =>
      messages.find((message) => message.type === "listener.reply"),
    );
    assert.equal(reply.traceId, control.traceId);
    assert.equal(reply.correlationId, control.correlationId);
    assert.equal(reply.causationId, control.causationId);
    assert.equal(reply.sequence, 0);
    serverSocket.destroy();
    await waitFor(
      () =>
        messages.filter((message) => message.type === "producer.hello")
          .length === 2 && client.isConnected(),
    );
    assert.notEqual(client.listener.connectionEpoch, firstEpoch);
    assert.equal(client.listenerSequence, 0);
    assert.equal(client.listenerJob, null);
    serverSocket.write(`${JSON.stringify(control)}\n`);
    await waitFor(() => failures.includes("invalid_control"));
    client.stop();
    await ingress.close();
  });

test("audio backpressure is an explicit failure rather than lossy offline coalescing", () => {
  const failures = [];
  const client = audioClient(
    {},
    { onListenerFailure: (reason) => failures.push(reason) },
  );
  client.authenticated = true;
  client.socket = {
    destroyed: false,
    write: () => false,
    destroy() {
      this.destroyed = true;
    },
  };
  const control = {
    connectionEpoch: client.listener.connectionEpoch,
    requestId: "r",
    jobId: "j",
    passId: "p",
    traceId: "t",
    correlationId: "c",
    causationId: "a",
  };
  assert.equal(client.sendListenerReply(control, { status: "ready" }), false);
  assert.ok(failures.includes("backpressure"));
  assert.equal(client.socket.destroyed, true);
  assert.equal(client.offlineQueue.length, 0);
});

test("audio refuses old ingress descriptors without listener opt-in", async () => {
  const statuses = [];
  const descriptor = {
    host: "127.0.0.1",
    port: 45832,
    protocol: "newline-delimited-json",
    protocolVersion: 1,
    maxFrameBytes: 128 * 1024,
  };
  const client = audioClient(descriptor, {
    readText: async () => JSON.stringify(descriptor),
    onStatus: (...items) => statuses.push(items),
  });
  client.start();
  await waitFor(() => statuses.find((items) => items[1] === "unavailable"));
  assert.match(
    statuses.find((items) => items[1] === "unavailable")[2],
    /not advertised/,
  );
  client.stop();
});

test("credential file references accept canonical JSON and retain explicit and legacy precedence", async () => {
  const paths = [];
  const reader = new AgentSignalClient({
    env: {},
    readText: async (file) => {
      paths.push(file);
      return JSON.stringify({ version: 1, secret: SECRET });
    },
  });
  assert.equal(
    await reader.loadSecret({
      secretPath: "/profile/credentials/signal-ingress-secret.json",
    }),
    SECRET,
  );
  assert.deepEqual(paths, ["/profile/credentials/signal-ingress-secret.json"]);
  const explicit = new AgentSignalClient({
    env: {},
    secretPath: "/explicit/credential",
    readText: async (file) => {
      paths.push(file);
      return SECRET;
    },
  });
  assert.equal(
    await explicit.loadSecret({ secretPath: "/different/profile/credential" }),
    SECRET,
  );
  assert.equal(paths.at(-1), "/explicit/credential");
  const token = new AgentSignalClient({
    env: {},
    secretPath: "/profile/credential",
    readText: async () => JSON.stringify({ version: 1, token: SECRET }),
  });
  assert.equal(await token.loadSecret(), SECRET);
  for (const text of [
    JSON.stringify({ version: 2, secret: SECRET }),
    JSON.stringify({ version: 1, secret: SECRET, token: SECRET }),
    `{"version":1,"secret":"${SECRET}"`,
    "x".repeat(4097),
  ]) {
    const invalid = new AgentSignalClient({
      env: {},
      secretPath: "/profile/credential",
      readText: async () => text,
    });
    await assert.rejects(invalid.loadSecret(), (error) => {
      assert.equal(error.message.includes(SECRET), false);
      return true;
    });
  }
});

test("default discovery/credential reader bounds filesystem content and closes failed reads", async () => {
  const files = require("node:fs/promises");
  const path = require("node:path");
  const directory = path.resolve(
    "max-patches/midi-capture/.test-artifacts",
    require("node:crypto").randomUUID(),
  );
  const secretPath = path.join(directory, "signal-ingress-secret.json");
  try {
    await files.mkdir(directory, { recursive: true });
    await files.writeFile(
      secretPath,
      JSON.stringify({ version: 1, secret: SECRET }),
    );
    const client = new AgentSignalClient({
      env: {},
      secretPath,
      descriptorPath: secretPath,
    });
    assert.equal(await client.loadSecret(), SECRET);
    await files.writeFile(secretPath, "x".repeat(128 * 1024 + 1));
    await assert.rejects(client.loadSecret(), /bounded regular files/);
    await assert.rejects(client.loadDescriptor(), /bounded regular files/);
    await files.writeFile(secretPath, SECRET);
    assert.equal(await client.loadSecret(), SECRET);
  } finally {
    await files.rm(directory, { recursive: true, force: true });
  }
});

test("new audio has no legacy discovery fallback while MIDI defaults remain compatible", async () => {
  const audio = new AgentSignalClient({ env: {}, signalKind: "audio" });
  assert.equal(audio.descriptorPath, null);
  assert.equal(audio.secretPath, null);
  assert.equal(audio.legacyDiscovery, false);
  await assert.rejects(audio.loadDescriptor(), /not configured/);
  await assert.rejects(audio.loadSecret(), /not configured/);
  const midi = new AgentSignalClient({ env: {} });
  assert.equal(midi.legacyDiscovery, true);
  assert.equal(
    midi.descriptorPath,
    require("./agent_signal_client.js").DEFAULT_DESCRIPTOR_PATH,
  );
  assert.equal(
    midi.secretPath,
    require("./agent_signal_client.js").DEFAULT_SECRET_PATH,
  );
});
