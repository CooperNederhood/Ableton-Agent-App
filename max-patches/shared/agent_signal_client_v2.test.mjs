/* global Buffer */
import "../audio-listener/native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentSignalClient } = require("./agent_signal_client.js");
const {
  listenerControlV2Schema,
  listenerRegistrationV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema
} = await import("../../packages/signal-routing/src/listener-v2-contracts.ts");
const SECRET = "synthetic-sdk-secret-that-must-not-escape";
const status = {
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
  reason: "fresh_per_pass_native_validation_required"
};
function fixture(options = {}) {
  const wire = [],
    failures = [],
    admitted = [],
    statuses = [];
  const listener = {
    version: 2,
    capabilities: ["audio-listener/v2"],
    sampleRate: 48000,
    vectorSize: 64,
    algorithmVersion: "2.0.0",
    nativeStatus: status,
    ...options.listener
  };
  const client = new AgentSignalClient({
    env: {},
    signalKind: "audio",
    schemaVersion: "audio-observation/v2",
    listener,
    secret: SECRET,
    instanceId: "synthetic-sdk-instance",
    onListenerFailure: (reason) => failures.push(reason),
    onStatus: (...values) => statuses.push(values),
    onListenerControl: (control) => {
      admitted.push(control);
      return options.onControl?.(control);
    },
    ...options.client
  });
  const registration = client.listener;
  client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", name: "synthetic track" },
    device: { id: "2", name: "Audio-Listener" }
  });
  client.authenticated = true;
  client.listener = { ...client.listener, connectionEpoch: "sdk-epoch" };
  client.socket = {
    destroyed: false,
    write(encoded) {
      const frame = JSON.parse(encoded);
      assert(Buffer.byteLength(encoded, "utf8") - 1 <= 128 * 1024);
      wire.push(frame);
      return true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
  const control = (action = "prepare", patch = {}) => ({
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 2,
    requestId: `${action}-${admitted.length}`,
    connectionEpoch: "sdk-epoch",
    jobId: "sdk-job",
    passId: "sdk-pass",
    traceId: "sdk-trace",
    correlationId: "sdk-correlation",
    causationId: "sdk-cause",
    action,
    ...(action === "prepare"
      ? {
          config: {
            geometry: {
              sampleRate: 48000,
              vectorSize: 64,
              tempoBpm: 93,
              startBeat: 5.25,
              endBeat: 6.8,
              hopSamples: 4800,
              totalSamples: 48000
            },
            timingPolicy: {
              mode: "descriptive",
              maxClockDisagreementSamples: 64
            }
          }
        }
      : {}),
    ...patch
  });
  return {
    client,
    listener,
    registration,
    wire,
    failures,
    statuses,
    admitted,
    control
  };
}

test("v2 SDK retains bounded native failure snapshots without treating them as successful proof", () => {
  const diagnostic = {
    scope: "native-spectrum-rejection/v1",
    generation: "55555555-5555-4555-8555-555555555555",
    check: "end",
    packet: [0, 0, 0, 0, 0, 37],
    fftDiagnostics: [0, 1, 0, 2048, 253],
    metadata: {
      dsp: [1, 48000, 64],
      fftInfo: [2048, 2048, 2048, 1],
      clockAbi: 2,
      envelopeAbi: 2,
      spectrumAbi: 2
    }
  };
  for (const type of ["reply", "result"]) {
    const send = type === "reply" ? "sendListenerReply" : "sendListenerResult";
    const schema =
      type === "reply" ? listenerReplyV2Schema : listenerResultV2Schema;
    const f = fixture();
    const control = f.control();
    f.client.handleListenerControl(control);
    assert.equal(
      f.client[send](control, {
        status: "failed",
        reason: "invalid_native_spectrum_packet",
        nativeFailureDiagnostic: diagnostic
      }),
      true
    );
    assert.deepEqual(
      schema.parse(f.wire.at(-1)).nativeFailureDiagnostic,
      diagnostic
    );
    assert.equal(f.client.listenerJob, null);
    for (const patch of [
      { packet: Array(6) },
      { packet: [0, 0, 0, 0, 0, Infinity] },
      { fftDiagnostics: [0, 1, 0, 2048, 253, 0] },
      { generation: SECRET },
      { check: "unknown" },
      { metadata: { ...diagnostic.metadata, audio: SECRET } },
      { audio: SECRET }
    ]) {
      const g = fixture();
      const prepare = g.control();
      g.client.handleListenerControl(prepare);
      assert.equal(
        g.client[send](prepare, {
          status: "failed",
          reason: "invalid_native_spectrum_packet",
          nativeFailureDiagnostic: { ...diagnostic, ...patch }
        }),
        false
      );
      assert.equal(g.wire.length, 0);
      assert.equal(g.client.listenerSequence, 0);
      assert(!JSON.stringify(g.failures).includes(SECRET));
    }
    const g = fixture();
    const prepare = g.control();
    g.client.handleListenerControl(prepare);
    assert.equal(
      g.client[send](prepare, {
        status: type === "reply" ? "ready" : "progress",
        nativeFailureDiagnostic: diagnostic
      }),
      false
    );
    assert.equal(g.wire.length, 0);
  }
});

test("v2 discovery requires actual version/capability arrays, never substring matches or fallback", async () => {
  const f = fixture();
  listenerRegistrationV2Schema.parse(f.client.listener);
  const descriptor = {
    host: "127.0.0.1",
    port: 12345,
    protocol: "newline-delimited-json",
    protocolVersion: 1,
    maxFrameBytes: 128 * 1024,
    listenerVersions: [1, 2],
    listenerCapabilities: ["audio-listener/v1", "audio-listener/v2"]
  };
  f.client.descriptorPath = "/synthetic/descriptor.json";
  for (const patch of [
    { listenerVersions: "12" },
    { listenerCapabilities: "audio-listener/v2" },
    { listenerVersions: [1] },
    { listenerCapabilities: ["audio-listener/v1"] }
  ]) {
    f.client.readText = async () => JSON.stringify({ ...descriptor, ...patch });
    await assert.rejects(() => f.client.loadDescriptor(), /not advertised/);
  }
  f.client.readText = async () => JSON.stringify(descriptor);
  assert.deepEqual(await f.client.loadDescriptor(), descriptor);
});

test("v2 cannot advertise a missing/mixed listener or mutate supplied registration metadata after construction", () => {
  for (const client of [
    { listener: null },
    { signalKind: "midi" },
    { schemaVersion: "audio-observation/v1" }
  ])
    assert.throws(() => fixture({ client }), /listener|version/);
  for (const listener of [
    { vectorSize: undefined },
    { vectorSize: 0 },
    { vectorSize: 65537 },
    { sampleRate: NaN },
    { algorithmVersion: "1.0.1" },
    { nativeStatus: undefined },
    { nativeStatus: { ...status, version: 1 } },
    { sampleRate: 96000, nativeStatus: { ...status, readiness: "READY" } },
    { vectorSize: 2048, nativeStatus: { ...status, readiness: "READY" } }
  ])
    assert.throws(() => fixture({ listener }), /listener|version/);
  const f = fixture();
  f.listener.sampleRate = 44100;
  assert.equal(f.registration.sampleRate, 48000);
});

test("v2 control snapshots immutable prepare policy/geometry and rejects extra keys or registration mismatches", () => {
  const f = fixture();
  const original = f.control();
  listenerControlV2Schema.parse(original);
  f.client.handleListenerControl(original);
  original.config.geometry.tempoBpm = 120;
  original.config.timingPolicy.maxClockDisagreementSamples = 480;
  assert.equal(f.client.listenerJob.config.geometry.tempoBpm, 93);
  assert.equal(
    f.client.listenerJob.config.timingPolicy.maxClockDisagreementSamples,
    64
  );
  assert(Object.isFrozen(f.client.listenerJob.config.geometry));
  assert(Object.isFrozen(f.client.listenerJob.config.timingPolicy));
  for (const kind of ["extra", "rate", "vector"]) {
    const g = fixture();
    const control = g.control();
    if (kind === "extra") control.untrusted = true;
    if (kind === "rate") {
      control.config.geometry.sampleRate = 44100;
      control.config.geometry.hopSamples = 4410;
      control.config.geometry.totalSamples = 44100;
    }
    if (kind === "vector") control.config.geometry.vectorSize = 128;
    g.client.handleListenerControl(control);
    assert.equal(g.admitted.length, 0, kind);
    assert.equal(g.client.socket.destroyed, true, kind);
  }
});

test("v2 busy, foreign and wrong-trace rejections cannot orphan a selected pass or release its native owner", () => {
  const f = fixture();
  f.client.handleListenerControl(f.control());
  const job = f.client.listenerJob;
  for (const denied of [
    f.control("prepare", { requestId: "busy" }),
    f.control("arm", { requestId: "foreign", passId: "other" }),
    f.control("cancel", { requestId: "trace", traceId: "other" }),
    f.control("arm", { requestId: "correlation", correlationId: "other" })
  ]) {
    f.client.handleListenerControl(denied);
    assert.equal(f.client.listenerJob, job);
  }
  assert.equal(f.admitted.length, 1);
  assert.equal(f.wire.length, 4);
  for (const frame of f.wire) listenerReplyV2Schema.parse(frame);
  assert.equal(f.client.socket.destroyed, false);
});

test("v2 outbound guards deny mixed versions, illegal stages and missing proofs before serialization", () => {
  for (const [type, payload, context] of [
    ["reply", { status: "armed" }, {}],
    [
      "reply",
      { status: "ready", nativeArm: { scope: "arrangement-descriptive/v2" } },
      {}
    ],
    ["reply", { status: "failed" }, {}],
    [
      "result",
      {
        status: "completed",
        observation: { schema: "audio-observation/v1", complete: true }
      },
      {}
    ],
    ["result", { status: "failed", reason: "denied", nativeCapture: {} }, {}],
    ["result", { status: "progress", nativeLifecycle: { scope: "v1" } }, {}],
    ["result", { status: "failed", reason: "denied" }, { listenerVersion: 1 }],
    ["result", { status: "failed", reason: "denied" }, { traceId: "other" }]
  ]) {
    const f = fixture();
    const control = f.control();
    f.client.handleListenerControl(control);
    const send = type === "reply" ? "sendListenerReply" : "sendListenerResult";
    assert.equal(f.client[send]({ ...control, ...context }, payload), false);
    assert.equal(f.wire.length, 0);
    assert(
      f.failures.length > 0 ||
        f.statuses.some((values) => values[1] === "listener_message_rejected")
    );
    assert.equal(f.client.listenerSequence, 0);
  }
});

test("v2 cancellation replies preserve the contract's optional reason and release only their selected owner", () => {
  for (const reason of [undefined, "operator_cancelled"]) {
    const f = fixture();
    const prepare = f.control();
    f.client.handleListenerControl(prepare);
    assert.equal(
      f.client.sendListenerReply(prepare, { status: "ready" }),
      true
    );
    const cancel = f.control("cancel");
    f.client.handleListenerControl(cancel);
    assert.equal(
      f.client.sendListenerReply(cancel, {
        status: "cancelled",
        ...(reason === undefined ? {} : { reason })
      }),
      true
    );
    assert.equal(f.wire.length, 2);
    assert.equal(f.wire[1].sequence, 1);
    assert.equal(f.wire[1].reason, reason);
    listenerReplyV2Schema.parse(f.wire[1]);
    assert.equal(f.client.listenerJob, null);
    assert.deepEqual(f.failures, []);
    assert.equal(f.client.socket.destroyed, false);
  }
});

test("v2 valid results retain ownership, sequence and bounded redacted callback errors", async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture({
      onControl: () => {
        const error = new Error(
          `producer failed ${SECRET} password=private-value`
        );
        if (asynchronous) return Promise.reject(error);
        throw error;
      }
    });
    f.client.handleListenerControl(f.control());
    await Promise.resolve();
    const frame = f.wire.at(-1);
    listenerReplyV2Schema.parse(frame);
    assert.equal(frame.listenerVersion, 2);
    assert.equal(frame.sequence, 0);
    assert.equal(frame.status, "failed");
    assert.equal(frame.reason.includes(SECRET), false);
    assert.equal(frame.reason.includes("private-value"), false);
    assert.equal(f.client.listenerJob, null);
  }
  const f = fixture();
  const control = f.control();
  f.client.handleListenerControl(control);
  assert.equal(f.client.sendListenerReply(control, { status: "ready" }), true);
  assert.equal(
    f.client.sendListenerResult(control, {
      status: "failed",
      reason: "synthetic_denial"
    }),
    true
  );
  listenerResultV2Schema.parse(f.wire.at(-1));
  assert.deepEqual(
    f.wire.map((frame) => frame.sequence),
    [0, 1]
  );
  assert.equal(f.client.listenerJob, null);
});

test("v2 late callback failures cannot cancel or release a new reservation reusing the same pass identifiers", async () => {
  let rejectOld;
  const f = fixture({
    onControl: (control) => {
      if (control.action === "prepare" && !rejectOld)
        return new Promise((_, reject) => {
          rejectOld = reject;
        });
    }
  });
  f.client.handleListenerControl(f.control());
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  f.client.sendListenerReply(cancel, {
    status: "cancelled",
    reason: "cancelled"
  });
  f.client.handleListenerControl(
    f.control("prepare", { requestId: "new-reservation" })
  );
  const selected = f.client.listenerJob;
  rejectOld(new Error(`late rejection ${SECRET}`));
  await Promise.resolve();
  assert.equal(f.client.listenerJob, selected);
  assert.equal(f.failures.length, 0);
  assert.equal(f.wire.length, 1);
  assert(
    f.statuses.some((values) => values[1] === "listener_message_rejected")
  );
  assert.equal(JSON.stringify([f.wire, f.statuses]).includes(SECRET), false);
});

test("v2 cyclic and oversized local results are explicit bounded failures, never a disconnect, retry queue or sequence advance", () => {
  for (const kind of ["cyclic", "oversized"]) {
    const f = fixture({ client: { maxFrameBytes: 1024 * 1024 } });
    f.client.descriptor = { maxFrameBytes: 1024 * 1024 };
    assert.equal(f.client.maxFrameBytes(), 128 * 1024);
    const control = f.control();
    f.client.handleListenerControl(control);
    const observation = {
      schema: "audio-observation/v2",
      algorithm: { version: "2.0.0" },
      listenerId: f.client.producer.producerId,
      passId: control.passId,
      complete: false
    };
    if (kind === "cyclic") observation.self = observation;
    else observation.limitations = ["x".repeat(128 * 1024)];
    assert.equal(
      f.client.sendListenerResult(control, {
        status: "partial",
        reason: "synthetic_failure",
        observation
      }),
      false
    );
    assert(
      f.failures.includes(
        kind === "cyclic"
          ? "listener_encoding_failed"
          : "listener_frame_too_large"
      )
    );
    assert.equal(f.client.socket.destroyed, false);
    assert.equal(f.client.listenerSequence, 0);
    assert.equal(f.wire.length, 0);
    assert.equal(f.client.offlineQueue.length, 0);
    assert.equal(
      f.client.sendListenerResult(control, {
        status: "failed",
        reason: "synthetic_cleanup"
      }),
      true
    );
    assert.equal(f.wire.at(-1).sequence, 0);
    assert.equal(f.client.listenerJob, null);
  }
});

test("v2 observation producers cannot bypass native result proof through generic signal frames and redact failure callbacks", () => {
  const f = fixture();
  for (const schema of ["audio-observation/v1", "audio-observation/v2"])
    assert.equal(f.client.sendSample({ schema }), false);
  assert.equal(f.wire.length, 0);
  assert.equal(f.client.offlineQueue.length, 0);
  assert(f.failures.includes("listener_result_required"));
  f.client.listenerFailure(`synthetic_failure ${SECRET}`);
  assert.equal(
    JSON.stringify([f.failures, f.statuses]).includes(SECRET),
    false
  );
});
