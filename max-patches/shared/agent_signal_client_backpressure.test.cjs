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
