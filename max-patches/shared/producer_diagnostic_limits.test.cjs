/* global Buffer */
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const process = require("node:process");
const { Writable } = require("node:stream");
const { AgentSignalClient } = require("./agent_signal_client.js");

function setup() {
  let now = 100000;
  const statuses = [];
  const client = new AgentSignalClient({
    env: {},
    signalKind: "audio",
    secret: "test-secret-at-least-thirty-two-characters",
    now: () => now,
    onStatus: (...status) => statuses.push(status)
  });
  client.writeDiagnosticsSupported = true;
  client.socket = new Writable({
    write(_chunk, _encoding, done) {
      done();
    }
  });
  return {
    client,
    statuses,
    advance: (milliseconds) => {
      now += milliseconds;
    }
  };
}
function diagnostic(order, long = false) {
  const id = () => (long ? "x".repeat(128) : randomUUID());
  return {
    eventId: randomUUID(),
    stage: "queued",
    sourceTime: 100000,
    order,
    elapsedMs: 0,
    requestId: id(),
    originConnectionId: id(),
    connectionEpoch: id(),
    traceId: id(),
    correlationId: id(),
    causationId: id(),
    jobId: id(),
    passId: id(),
    queueCount: 0,
    queueBytes: 0,
    reason: "write_backpressure",
    writeReturn: false,
    writableLength: 17000,
    writableHighWaterMark: 16384
  };
}

test("diagnostic batches fit count, UTF8 byte budget and negotiated complete heartbeat frame budget", () => {
  const { client } = setup();
  try {
    for (let order = 0; order < 16; order++)
      assert(client.collectWriteDiagnostic(diagnostic(order, true)));
    let batch = client.heartbeatDiagnostics();
    assert(batch.events.length > 0 && batch.events.length < 8);
    assert(Buffer.byteLength(JSON.stringify(batch)) <= 8192);
    client.descriptor = { maxFrameBytes: 2200 };
    const requestId = "x".repeat(128);
    batch = client.heartbeatDiagnostics(requestId);
    assert.equal(batch.events.length, 1);
    assert(
      Buffer.byteLength(
        JSON.stringify({
          type: "producer.heartbeat",
          protocolVersion: 1,
          requestId,
          diagnostics: batch
        })
      ) +
        1 <=
        2200
    );
    client.descriptor = { maxFrameBytes: 256 };
    assert.equal(client.heartbeatDiagnostics(requestId), null);
    assert.equal(client.writeDiagnosticEvents.length, 16);
  } finally {
    client.stop();
  }
});

test("ordinary writable bytes prevent telemetry flush even without a drain reservation", () => {
  const { client } = setup();
  try {
    assert(client.collectWriteDiagnostic(diagnostic(0)));
    client.socket.cork();
    client.socket.write("ordinary buffered bytes");
    assert.equal(client.writeDrain, null);
    assert(client.socket.writableLength > 0);
    assert.equal(client.heartbeatDiagnostics(), null);
    client.socket.uncork();
    assert(client.heartbeatDiagnostics());
  } finally {
    client.stop();
  }
});

test("diagnostic ownership IDs preserve the existing protocol's bounded string contract", () => {
  const { client } = setup();
  try {
    assert.equal(
      client.collectWriteDiagnostic({
        ...diagnostic(0),
        jobId: "capture/job",
        traceId: "trace with spaces",
        correlationId: "\u00e9".repeat(128)
      }),
      true
    );
    assert.equal(
      client.writeDiagnosticEvents[0].correlationId,
      "\u00e9".repeat(128)
    );
    assert.equal(
      client.collectWriteDiagnostic({
        ...diagnostic(1),
        jobId: "x".repeat(129)
      }),
      false
    );
    assert.equal(client.writeDiagnosticGaps.invalid, 1);
  } finally {
    client.stop();
  }
});

test("invalid metadata and expired in-flight metadata have explicit bounded gaps without clearing ordinary pending requests", () => {
  const { client, statuses, advance } = setup();
  try {
    assert.equal(
      client.collectWriteDiagnostic({
        ...diagnostic(0),
        rawAudio: "forbidden"
      }),
      false
    );
    assert.equal(client.writeDiagnosticGaps.invalid, 1);
    assert(
      statuses.some((s) => s[1] === "write_diagnostics" && s[2] === "invalid")
    );
    assert(client.collectWriteDiagnostic(diagnostic(1)));
    client.pending.set("ordinary", "listener");
    client.writeDiagnosticBatches.set("expired-heartbeat", {
      sentAt: 100000,
      eventIds: [],
      gaps: {}
    });

    advance(60000);
    const batch = client.heartbeatDiagnostics();
    assert.equal(client.writeDiagnosticBatches.size, 0);
    assert.equal(client.pending.get("ordinary"), "listener");
    assert.equal(batch.events.length, 0);
    assert.equal(batch.gaps.expired, 1);
    assert.equal(batch.gaps.invalid, 1);
    assert.equal(client.writeDiagnosticEvents.length, 0);
  } finally {
    client.stop();
  }
});

test("diagnostic presentation callback failures are explicit and cannot deny native transport", (t) => {
  const { client } = setup();
  const warnings = [];
  t.mock.method(process, "emitWarning", (...args) => warnings.push(args));
  client.onStatus = () => {
    throw new Error("controlled presentation failure");
  };
  try {
    assert.doesNotThrow(() =>
      client.collectWriteDiagnostic({ ...diagnostic(0), rawAudio: "forbidden" })
    );
    assert.equal(client.writeDiagnosticGaps.invalid, 1);
    assert.equal(warnings.length, 1);
    assert.equal(client.socket.destroyed, false);
  } finally {
    client.onStatus = () => {};
    client.stop();
  }
});
