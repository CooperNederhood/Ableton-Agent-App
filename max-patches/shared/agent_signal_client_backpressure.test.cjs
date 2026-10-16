/* global Buffer, setTimeout */
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const test = require("node:test");
const { AgentSignalClient } = require("./agent_signal_client.js");

function fixture(options = {}) {
  const writes = [];
  const callbacks = [];
  const failures = [];
  const statuses = [];
  const timers = new Set();
  const socket = new Writable({
    highWaterMark: 16384,
    write(chunk, encoding, done) {
      writes.push(chunk.toString("utf8"));
      callbacks.push(done);
    }
  });
  socket.on("error", () => {});
  const client = new AgentSignalClient({
    env: {},
    signalKind: "audio",
    onListenerFailure: (reason) => failures.push(reason),
    onStatus: (...values) => statuses.push(values),
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    ...options
  });
  client.socket = socket;
  client.authenticated = true;
  client.connectionId = "origin-connection";
  client.transportEpoch = "origin-epoch";
  return { client, socket, writes, callbacks, failures, statuses, timers };
}

function message(requestId, size = 17000) {
  return {
    type: "listener.result",
    requestId,
    traceId: "synthetic-write-trace",
    correlationId: "synthetic-write-correlation",
    causationId: "synthetic-write-cause",
    jobId: "synthetic-write-job",
    passId: "synthetic-write-pass",
    payload: "x".repeat(size)
  };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("audio preserves exact standard-stream watermark boundaries, counting the newline", async () => {
  for (const bytes of [16383, 16384, 16385]) {
    const f = fixture();
    try {
      const frame = message("boundary", 0);
      frame.payload = "x".repeat(
        bytes - Buffer.byteLength(JSON.stringify(frame)) - 1
      );
      assert.equal(f.client.writeMessage(frame), true);
      assert.equal(Buffer.byteLength(f.writes[0]), bytes);
      assert.equal(f.timers.size, bytes < 16384 ? 0 : 1);
      assert.equal(f.socket.destroyed, false);
      f.callbacks.shift()();
      await tick();
      assert.equal(f.timers.size, 0);
      assert.equal(f.writes.length, 1);
      assert.deepEqual(f.failures, []);
    } finally {
      f.client.stop();
    }
  }
});

function diagnosticsFixture(options = {}) {
  let heartbeat;
  const f = fixture({
    setInterval(fn) {
      heartbeat = fn;
      return { unref() {} };
    },
    clearInterval() {},
    ...options
  });
  f.client.writeDiagnosticsSupported = true;
  f.client.startHeartbeat();
  return { ...f, heartbeat: () => heartbeat() };
}

function acknowledge(client, requestId, action = "heartbeat") {
  client.handleResponse(
    JSON.stringify({
      type: "producer.ack",
      protocolVersion: 1,
      requestId,
      action
    })
  );
}

test("diagnostics wait for scheduled heartbeat after drain, retain until ACK, and measure actual stream state", async () => {
  let now = 1000;
  const f = diagnosticsFixture({ now: () => now });
  try {
    f.client.writeMessage(message("original"));
    f.heartbeat();
    assert.equal(f.writes.length, 1);
    assert.equal(f.client.writeDiagnosticEvents.length, 3);
    now = 1050;
    f.callbacks.shift()();
    await tick();
    assert.equal(
      f.writes.length,
      2,
      "ordinary heartbeat queued during drain still works"
    );
    f.callbacks.shift()();
    await tick();
    assert.equal(
      f.writes.length,
      2,
      "drain never synchronously flushes diagnostics"
    );
    f.heartbeat();
    const heartbeat = JSON.parse(f.writes.at(-1));
    assert.equal(heartbeat.type, "producer.heartbeat");
    assert.equal(heartbeat.diagnostics.schema, "write-backpressure/v1");
    const events = heartbeat.diagnostics.events;
    assert.deepEqual(
      events.map((e) => e.stage),
      ["queued", "started", "progress", "completed"]
    );
    assert.deepEqual(
      events.map((e) => e.order),
      [0, 1, 2, 3]
    );
    assert.deepEqual(
      events.map((e) => e.sourceTime),
      [1000, 1000, 1000, 1050]
    );
    assert.deepEqual(
      events.map((e) => e.elapsedMs),
      [0, 0, 0, 50]
    );
    assert.equal(new Set(events.map((e) => e.eventId)).size, 4);
    for (const event of events) {
      assert.match(event.eventId, /^[a-f0-9-]{36}$/);
      assert.equal(event.requestId, "original");
      assert.equal(event.originConnectionId, "origin-connection");
      assert.equal(event.connectionEpoch, "origin-epoch");
      assert.equal(event.writeReturn, false);
      assert.equal(event.writableHighWaterMark, 16384);
      assert.equal(event.traceId, "synthetic-write-trace");
      assert.equal("payload" in event, false);
    }
    assert.equal(events[0].writableLength, Buffer.byteLength(f.writes[0]));
    assert.equal(events[3].writableLength, 0);
    assert.equal(f.client.writeDiagnosticEvents.length, 4);
    acknowledge(f.client, "original", "listener");
    assert.equal(f.client.writeDiagnosticEvents.length, 4);
    acknowledge(f.client, heartbeat.requestId);
    assert.equal(f.client.writeDiagnosticEvents.length, 0);
    assert.deepEqual(f.failures, []);
  } finally {
    f.client.stop();
  }
});

test("diagnostic-bearing heartbeat suppresses its own lifecycle but preserves actual drain cleanup", async () => {
  const f = diagnosticsFixture();
  try {
    f.client.writeMessage(message("original"));
    f.callbacks.shift()();
    await tick();
    f.heartbeat();
    const heartbeat = JSON.parse(f.writes.at(-1));
    assert(heartbeat.diagnostics);
    // Force real backpressure for the next diagnostic heartbeat.
    f.callbacks.shift()();
    await tick();
    acknowledge(f.client, heartbeat.requestId);
    f.client.writeMessage(message("second"));
    f.callbacks.shift()();
    await tick();
    f.socket._writableState.highWaterMark = 1;
    const count = f.client.writeDiagnosticEvents.length;
    f.heartbeat();
    assert(f.client.writeDrain);
    assert.equal(f.client.writeDiagnosticEvents.length, count);
    f.callbacks.shift()();
    await tick();
    assert.equal(f.client.writeDrain, null);
    assert.equal(f.timers.size, 0);
    assert.equal(f.client.writeDiagnosticEvents.length, count);
  } finally {
    f.client.stop();
  }
});

test("diagnostic metadata is bounded, rejects unsafe bodies, expires, and reports gaps without capture failure", async () => {
  let now = 1000;
  const secret = "synthetic-diagnostic-secret-credential";
  const f = diagnosticsFixture({ now: () => now, secret });
  try {
    f.client.writeMessage(message("original"));
    f.callbacks.shift()();
    await tick();
    const base = f.client.writeDiagnosticEvents[0];
    for (const patch of [
      { payload: "audio" },
      { requestId: "token=private" },
      { writableLength: -1 },
      { stage: "unsafe" },
      { sourceTime: Infinity },
      { reason: "unknown" },
      { traceId: `prefix-${secret}-suffix` },
      { traceId: "x".repeat(129) }
    ])
      assert.equal(
        f.client.collectWriteDiagnostic({ ...base, ...patch }),
        false
      );
    for (let i = 0; i < 70; i++)
      assert.equal(
        f.client.collectWriteDiagnostic({
          ...base,
          eventId: require("node:crypto").randomUUID(),
          order: i + 3,
          ...Object.fromEntries(
            ["traceId", "correlationId", "causationId", "jobId", "passId"].map(
              (key) => [key, "x".repeat(128)]
            )
          )
        }),
        true
      );
    assert.equal(f.client.writeDiagnosticEvents.length, 64);
    assert.equal(f.client.writeDiagnosticGaps.overflow, 9);
    const batch = f.client.heartbeatDiagnostics();
    assert(batch.events.length <= 8);
    assert(Buffer.byteLength(JSON.stringify(batch)) <= 8192);
    assert(batch.events.length < 8, "byte bound includes all wrapper fields");
    now = 61000;
    const expired = f.client.heartbeatDiagnostics();
    assert.equal(expired.events.length, 0);
    assert.equal(expired.gaps.expired, 64);
    assert(
      f.statuses.some(
        (s) => s[1] === "write_diagnostics" && s[2] === "overflow"
      )
    );
    assert(
      f.statuses.some((s) => s[1] === "write_diagnostics" && s[2] === "expired")
    );
    assert.deepEqual(f.failures, []);
    assert(!JSON.stringify([f.statuses, batch]).includes(secret));
  } finally {
    f.client.stop();
  }
});

test("old hello ACK explicitly disables diagnostics even with discovery hint and never denies capture", async () => {
  for (const producerDiagnostics of [undefined, "write-backpressure/v1", []]) {
    const f = diagnosticsFixture();
    try {
      f.client.descriptor = { producerDiagnostics: ["write-backpressure/v1"] };
      f.client.pending.set("hello", "hello");
      f.client.handleResponse(
        JSON.stringify({
          type: "producer.ack",
          protocolVersion: 1,
          requestId: "hello",
          action: "hello",
          connectionId: "authenticated",
          producerDiagnostics
        })
      );
      f.client.writeMessage(message("original"));
      f.callbacks.shift()();
      await tick();
      f.heartbeat();
      assert.equal(JSON.parse(f.writes.at(-1)).diagnostics, undefined);
      assert.equal(f.client.writeDiagnosticEvents.length, 0);
      assert.equal(f.client.writeDiagnosticGaps.unsupported, 3);
      assert(
        f.statuses.some(
          (s) => s[1] === "write_diagnostics" && s[2] === "unsupported"
        )
      );
      assert.deepEqual(f.failures, []);
    } finally {
      f.client.stop();
    }
  }
});

test("unacknowledged diagnostics reconnect with frozen origin, never replaying measurement frames", async () => {
  const f = diagnosticsFixture();
  const replacement = fixture();
  try {
    f.client.writeMessage(message("original"));
    f.callbacks.shift()();
    await tick();
    f.heartbeat();
    const originalBatch = JSON.parse(f.writes.at(-1)).diagnostics;
    f.client.handleClose(f.socket);
    f.client.socket = replacement.socket;
    f.client.authenticated = true;
    f.client.connectionId = "new-connection";
    f.client.transportEpoch = "new-epoch";
    f.client.writeDiagnosticsSupported = true;
    f.heartbeat();
    const redelivery = JSON.parse(replacement.writes.at(-1));
    assert.deepEqual(redelivery.diagnostics, originalBatch);
    assert.equal(redelivery.type, "producer.heartbeat");
    assert.equal(replacement.writes.length, 1);
    assert.equal(f.client.offlineQueue.length, 0);
    f.client.handleResponse(
      JSON.stringify({
        type: "producer.error",
        protocolVersion: 1,
        requestId: redelivery.requestId,
        code: "diagnostic_denied",
        fatal: false
      })
    );
    assert.deepEqual(f.failures, []);
    assert.equal(f.client.writeDiagnosticEvents.length, 3);
    replacement.callbacks.shift()();
    await tick();
    f.heartbeat();
    acknowledge(f.client, JSON.parse(replacement.writes.at(-1)).requestId);
    assert.equal(f.client.writeDiagnosticEvents.length, 0);
  } finally {
    f.socket.destroy();
    f.client.stop();
    replacement.client.stop();
  }
});

test("audio accepts a standard-stream false write once, waits for drain and preserves its protocol ACK", async () => {
  let now = 1000;
  const f = fixture({ now: () => now });
  try {
    assert.equal(f.client.writeMessage(message("large")), true);
    assert.equal(f.socket.destroyed, false);
    assert.deepEqual(f.failures, []);
    assert.equal(f.writes.length, 1);
    assert.equal(f.timers.size, 1);
    assert(f.client.pending.has("large"));
    now = 1050;
    f.callbacks.shift()();
    await tick();
    assert.equal(f.timers.size, 0);
    assert(f.client.pending.has("large"), "drain is not a protocol ACK");
    f.client.handleResponse(
      JSON.stringify({
        type: "producer.ack",
        protocolVersion: 1,
        requestId: "large",
        action: "listener"
      })
    );
    assert.equal(f.client.pending.size, 0);
    assert.deepEqual(
      f.statuses.filter((s) => s[1] === "write_backpressure").map((s) => s[2]),
      ["queued", "started", "completed"]
    );
    assert.deepEqual(
      f.statuses.filter((s) => s[1] === "write_backpressure").map((s) => s[9]),
      ["0", "0", "50"]
    );
    assert(
      f.statuses.some(
        (s) =>
          s.includes("synthetic-write-trace") &&
          s.includes("synthetic-write-cause")
      )
    );
  } finally {
    f.client.stop();
  }
});

test("audio status callbacks cannot enqueue ahead of older writes while drain completes", async () => {
  let client;
  const f = fixture({
    onStatus(...values) {
      if (values[1] === "write_backpressure" && values[2] === "completed")
        assert.equal(client.writeMessage(message("newer", 10)), true);
    }
  });
  client = f.client;
  try {
    assert.equal(client.writeMessage(message("one")), true);
    assert.equal(client.writeMessage(message("two", 10)), true);
    f.callbacks.shift()();
    await tick();
    while (f.callbacks.length) f.callbacks.shift()();
    assert.deepEqual(
      f.writes.map((s) => JSON.parse(s).requestId),
      ["one", "two", "newer"]
    );
    assert.equal(client.writeQueue.length, 0);
  } finally {
    client.stop();
  }
});

test("audio serializes bounded same-connection writes behind drain without resending or an offline queue", async () => {
  const f = fixture();
  try {
    assert.equal(f.client.writeMessage(message("one")), true);
    assert.equal(f.client.writeMessage(message("two")), true);
    assert.equal(f.client.writeMessage(message("three", 10)), true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.client.pending.size, 3);
    assert.equal(f.client.offlineQueue.length, 0);
    f.callbacks.shift()();
    await tick();
    assert.deepEqual(
      f.writes.map((s) => JSON.parse(s).requestId),
      ["one", "two"]
    );
    assert.equal(f.timers.size, 1);
    f.callbacks.shift()();
    await tick();
    assert.deepEqual(
      f.writes.map((s) => JSON.parse(s).requestId),
      ["one", "two", "three"]
    );
    f.callbacks.shift()();
    await tick();
    assert.equal(f.timers.size, 0);
    assert.equal(f.socket.listenerCount("drain"), 0);
    assert.deepEqual(f.failures, []);
  } finally {
    f.client.stop();
  }
});

test("audio drain timeout is bounded, fatal and drops unsent frames without retry", async () => {
  const f = fixture();
  try {
    assert.equal(f.client.writeMessage(message("one")), true);
    assert.equal(f.client.writeMessage(message("two")), true);
    const timer = [...f.timers][0];
    assert.equal(timer.delay, 1000);
    timer.callback();
    assert.equal(f.socket.destroyed, true);
    assert(f.failures.includes("outbound_drain_timeout"));
    assert.equal(f.timers.size, 0);
    assert.equal(f.socket.listenerCount("drain"), 0);
    f.callbacks.shift()();
    await tick();
    assert.equal(f.writes.length, 1);
    assert.equal(f.client.pending.size, 0);
  } finally {
    f.client.stop();
  }
});

test("audio bounds queued bytes and pending requests rather than admitting unlimited backpressure", () => {
  for (const bound of ["bytes", "pending"]) {
    const f = fixture(bound === "pending" ? { maxPendingRequests: 1 } : {});
    try {
      assert.equal(f.client.writeMessage(message("one", 120000)), true);
      if (bound === "bytes")
        assert.equal(f.client.writeMessage(message("two", 120000)), true);
      assert.equal(f.client.writeMessage(message("overflow", 120000)), false);
      assert.equal(f.socket.destroyed, true);
      assert.equal(f.writes.length, 1);
      assert.equal(f.timers.size, 0);
      assert.equal(f.socket.listenerCount("drain"), 0);
      assert.equal(f.client.offlineQueue.length, 0);
    } finally {
      f.client.stop();
    }
  }
});

test("audio write callback and socket errors fail once, redact credentials and clean the drain", async () => {
  for (const mode of ["callback", "callback-small", "error", "close"]) {
    const secret = "synthetic-private-write-credential";
    const f = fixture({ secret });
    try {
      const size = mode === "callback-small" ? 10 : 17000;
      assert.equal(f.client.writeMessage(message("one", size)), true);
      assert.equal(f.client.writeMessage(message("two", size)), true);
      if (mode.startsWith("callback"))
        f.callbacks.shift()(new Error(`write failed ${secret}`));
      else f.socket.emit(mode, new Error(`write failed ${secret}`));
      await tick();
      assert.equal(f.socket.destroyed, true);
      assert.equal(f.writes.length, 1);
      assert.equal(f.timers.size, 0);
      assert.equal(f.socket.listenerCount("drain"), 0);
      assert.equal(f.failures.length, 1);
      assert.equal(JSON.stringify(f.statuses).includes(secret), false);
    } finally {
      f.client.stop();
    }
  }
});

test("audio disconnect drops the same-connection queue and stale close/error/drain/timer callbacks cannot affect a new socket", () => {
  const f = fixture();
  const replacement = fixture();
  try {
    assert.equal(f.client.writeMessage(message("one")), true);
    assert.equal(f.client.writeMessage(message("two")), true);
    const staleDrain = f.socket.listeners("drain")[0];
    const staleError = f.socket.listeners("error").at(-1);
    const staleClose = f.socket.listeners("close")[0];
    const staleTimeout = [...f.timers][0].callback;
    f.client.handleClose(f.socket);
    assert.equal(f.timers.size, 0);
    assert.equal(f.client.pending.size, 0);
    assert.equal(f.client.writeQueue.length, 0);
    assert.equal(f.client.writeQueueBytes, 0);
    assert.equal(f.client.authenticated, false);
    f.client.socket = replacement.socket;
    staleDrain();
    staleError(new Error("old socket failure"));
    staleClose();
    staleTimeout();
    assert.equal(replacement.socket.destroyed, false);
    assert.equal(replacement.writes.length, 0);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.failures, []);
  } finally {
    f.socket.destroy();
    f.client.stop();
    replacement.client.stop();
  }
});

test("audio stop cancels drain and queued writes, and stale drain cannot touch a replacement connection", async () => {
  const f = fixture();
  assert.equal(f.client.writeMessage(message("one")), true);
  assert.equal(f.client.writeMessage(message("two")), true);
  const oldDrain = f.socket.listeners("drain")[0];
  f.client.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.socket.listenerCount("drain"), 0);
  const replacement = fixture();
  try {
    f.client.socket = replacement.socket;
    oldDrain();
    f.callbacks.shift()();
    await tick();
    assert.equal(replacement.writes.length, 0);
    assert.equal(replacement.socket.destroyed, false);
    assert.equal(
      f.writes.some((s) => JSON.parse(s).requestId === "two"),
      false
    );
    assert.equal(f.client.pending.size, 0);
    assert(
      f.statuses.some(
        (s) => s[1] === "write_backpressure" && s[2] === "cancelled"
      )
    );
  } finally {
    f.socket.destroy();
    replacement.client.stop();
  }
});

test("audio write below the watermark and MIDI retain their existing immediate acceptance behavior", () => {
  for (const signalKind of ["audio", "midi"]) {
    const f = fixture({ signalKind });
    try {
      assert.equal(
        f.client.writeMessage(
          message("one", signalKind === "audio" ? 10 : 17000)
        ),
        true
      );
      assert.equal(f.timers.size, 0);
      assert.equal(f.writes.length, 1);
      assert.equal(f.failures.length, 0);
    } finally {
      f.client.stop();
    }
  }
});

test("authenticated hello ACK alone enables diagnostics and preserves accumulated unsupported gaps", async () => {
  const f = diagnosticsFixture();
  try {
    f.client.writeDiagnosticsSupported = false;
    f.client.writeMessage(message("unsupported"));
    f.callbacks.shift()();
    await tick();
    f.client.pending.set("hello", "hello");
    f.client.handleResponse(
      JSON.stringify({
        type: "producer.ack",
        protocolVersion: 1,
        requestId: "hello",
        action: "hello",
        connectionId: "supported",
        producerDiagnostics: ["future/optional", "write-backpressure/v1"]
      })
    );
    assert.equal(f.client.writeDiagnosticsSupported, true);
    f.heartbeat();
    const frame = JSON.parse(f.writes.at(-1));
    assert.deepEqual(frame.diagnostics, {
      schema: "write-backpressure/v1",
      events: [],
      gaps: { overflow: 0, expired: 0, unsupported: 3 }
    });
    acknowledge(f.client, frame.requestId);
    assert.equal(f.client.writeDiagnosticGaps.unsupported, 0);
    assert.deepEqual(f.failures, []);
  } finally {
    f.client.stop();
  }
});

test("backpressure failure and cancellation callbacks preserve source origins, metrics, IDs and timing", () => {
  for (const terminal of ["timeout", "cancelled", "disconnected"]) {
    let now = 1000;
    const events = [];
    const f = fixture({
      now: () => now,
      onWriteDiagnostic: (event) => events.push(event)
    });
    try {
      f.client.writeMessage(message("original"));
      f.client.writeMessage(message("queued", 10));
      now = 1100;
      f.client.connectionId = "new-context";
      f.client.transportEpoch = "new-epoch";
      const writableLength = f.socket.writableLength;
      if (terminal === "timeout") [...f.timers][0].callback();
      else if (terminal === "cancelled") f.client.stop();
      else f.client.handleClose(f.socket);
      const event = events.at(-1);
      assert.equal(
        event.stage,
        terminal === "cancelled" ? "cancelled" : "failed"
      );
      assert.equal(
        event.reason,
        {
          timeout: "outbound_drain_timeout",
          cancelled: "stopped",
          disconnected: "disconnected"
        }[terminal]
      );
      assert.equal(event.originConnectionId, "origin-connection");
      assert.equal(event.connectionEpoch, "origin-epoch");
      assert.equal(event.sourceTime, 1100);
      assert.equal(event.elapsedMs, 100);
      assert.equal(event.queueCount, 1);
      assert(event.queueBytes > 0);
      assert.equal(event.writableLength, writableLength);
      assert.equal(event.writeReturn, false);
      assert.equal(new Set(events.map((e) => e.eventId)).size, events.length);
      assert.equal(f.timers.size, 0);
      assert.equal(f.client.writeQueue.length, 0);
    } finally {
      f.client.stop();
    }
  }
});

test("diagnostic callback exceptions are metadata errors, never native capture denials", async () => {
  const f = fixture({
    onWriteDiagnostic() {
      throw new Error("token=must-not-leak");
    }
  });
  try {
    f.client.writeMessage(message("original"));
    f.callbacks.shift()();
    await tick();
    assert.deepEqual(f.failures, []);
    assert(
      f.statuses.some(
        (s) => s[1] === "write_diagnostics" && s[2] === "callback_failed"
      )
    );
    assert(!JSON.stringify(f.statuses).includes("must-not-leak"));
    assert.equal(f.client.writeDrain, null);
  } finally {
    f.client.stop();
  }
});
