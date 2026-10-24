/* global Buffer, structuredClone */
import "../audio-listener/native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
const require = createRequire(import.meta.url);
const { AgentSignalClient } = require("./agent_signal_client.js");
const { createSyntheticNativeSessionListeningFixture } =
  await import("../../packages/protocol/src/testing.ts");
const {
  listenerRegistrationSessionSchema,
  listenerReplySessionSchema,
  listenerResultSessionSchema
} =
  await import("../../packages/signal-routing/src/listener-session-contracts.ts");
const SECRET = "synthetic-session-sdk-secret-at-least-32-characters";
const source = {
  mode: "session",
  synchronization: "transport-coupled-first-iteration",
  target: {
    view: "session",
    sceneIndex: 0,
    expectedClipName: "clip",
    expectedClipReference: "11111111-1111-4111-8111-111111111111",
    track: {
      kind: "regular",
      index: 0,
      expectedName: "track",
      expectedReference: "22222222-2222-4222-8222-222222222222"
    }
  }
};
const status = {
  version: 3,
  scope: "session-transport-coupled/v1",
  readiness: "BLOCKED",
  reason: "fresh_per_pass_native_validation_required",
  alignment: "approximate",
  verifiedAbsoluteErrorBoundSamples: null,
  acceptedSampleRates: [44100, 48000],
  acceptedVectorSizes: [64, 128],
  timingModes: ["descriptive", "strict"],
  maxClockDisagreementSamples: 480,
  maxAudioDurationMs: 30000,
  maxWindows: 300,
  abiVersion: 2,
  sourceEvidence: "expected-context-only",
  synchronization: "transport-coupled-first-iteration",
  maxDurationBeats: 4
};
function fixture(options = {}) {
  const wire = [],
    failures = [],
    admitted = [];
  const listener = {
    version: 3,
    capabilities: ["audio-listener/session-v1"],
    sampleRate: 48000,
    vectorSize: 64,
    algorithmVersion: "2.0.0",
    nativeStatus: structuredClone(status),
    ...options.listener
  };
  const client = new AgentSignalClient({
    env: {},
    signalKind: "audio",
    schemaVersion: "audio-observation/v2",
    listener,
    secret: SECRET,
    onListenerFailure: (reason) => failures.push(reason),
    onListenerControl: (control) => {
      admitted.push(control);
      return options.onControl?.(control);
    },
    ...options.client
  });
  client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", name: "synthetic" },
    device: { id: "2", name: "listener" }
  });
  client.listener = { ...client.listener, connectionEpoch: "session-epoch" };
  client.authenticated = true;
  client.socket = {
    destroyed: false,
    write(encoded) {
      assert(Buffer.byteLength(encoded, "utf8") - 1 <= 128 * 1024);
      wire.push(JSON.parse(encoded));
      return true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
  const native = createSyntheticNativeSessionListeningFixture({
    source,
    listenerId: client.producer.producerId,
    passId: "session-pass"
  });
  let requests = 0;
  const control = (action = "prepare", patch = {}) => ({
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 3,
    requestId: `session-${requests++}`,
    connectionEpoch: "session-epoch",
    jobId: "session-job",
    passId: "session-pass",
    traceId: "session-trace",
    correlationId: "session-correlation",
    causationId: "session-cause",
    action,
    ...(action === "prepare"
      ? {
          config: {
            geometry: { ...native.expected.geometry },
            timingPolicy: { ...native.expected.policy },
            source: structuredClone(source)
          }
        }
      : {}),
    ...patch
  });
  const reserve = () => {
    const c = control();
    client.handleListenerControl(c);
    return c;
  };
  return {
    client,
    listener,
    native,
    wire,
    failures,
    admitted,
    control,
    reserve
  };
}
test("wire3 registration and source admission support bundled Node without Object.hasOwn", () => {
  const original = Object.getOwnPropertyDescriptor(Object, "hasOwn");
  Object.defineProperty(Object, "hasOwn", { ...original, value: undefined });
  try {
    const f = fixture();
    f.reserve();
    assert.equal(f.admitted.length, 1);
    assert.equal(f.failures.length, 0);
  } finally {
    Object.defineProperty(Object, "hasOwn", original);
  }
});

test("wire3 requires exact negotiated registration/status, raw v2 schema and immutable ABI2 metadata", () => {
  const f = fixture();
  listenerRegistrationSessionSchema.parse(f.client.listener);
  f.listener.nativeStatus.acceptedVectorSizes.push(256);
  assert.deepEqual(
    f.client.listener.nativeStatus.acceptedVectorSizes,
    [64, 128]
  );
  for (const listener of [
    { version: 2 },
    { capabilities: ["audio-listener/v2"] },
    { nativeStatus: { ...status, abiVersion: 3 } },
    { nativeStatus: { ...status, scope: "arrangement-descriptive/v2" } },
    { nativeStatus: { ...status, sourceEvidence: "native" } },
    { nativeStatus: { ...status, reason: undefined } },
    { nativeStatus: { ...status, acceptedSampleRates: [48000, 44100] } },
    { nativeStatus: { ...status, acceptedVectorSizes: [64, 64] } },
    { nativeStatus: { ...status, extra: true } },
    { extra: true },
    { sampleRate: 96000, nativeStatus: { ...status, readiness: "READY" } }
  ])
    assert.throws(() => fixture({ listener }), /listener|registration|version/);
  for (const schemaVersion of [
    "audio-observation/v1",
    "audio-observation/v3",
    "session-audio-observation/v1"
  ])
    assert.throws(
      () => fixture({ client: { schemaVersion } }),
      /listener|version/
    );
});
test("wire3 discovery is explicit and never falls back to v2 or substring capabilities", async () => {
  const f = fixture(),
    descriptor = {
      host: "127.0.0.1",
      port: 12345,
      protocol: "newline-delimited-json",
      protocolVersion: 1,
      maxFrameBytes: 128 * 1024,
      listenerVersions: [1, 2, 3],
      listenerCapabilities: [
        "audio-listener/v1",
        "audio-listener/v2",
        "audio-listener/session-v1"
      ]
    };
  f.client.descriptorPath = "/synthetic/session/descriptor.json";
  for (const patch of [
    { listenerVersions: [1, 2] },
    { listenerVersions: "123" },
    { listenerCapabilities: "audio-listener/session-v1" },
    { listenerCapabilities: ["audio-listener/v2"] }
  ]) {
    f.client.readText = async () => JSON.stringify({ ...descriptor, ...patch });
    await assert.rejects(() => f.client.loadDescriptor(), /not advertised/);
  }
  f.client.readText = async () => JSON.stringify(descriptor);
  assert.deepEqual(await f.client.loadDescriptor(), descriptor);
});
test("wire3 freezes bounded source/config and rejects mixed, unsupported, replayed and extra controls", () => {
  const f = fixture(),
    control = f.reserve();
  control.config.source.target.track.index = 2;
  assert.equal(f.client.listenerJob.config.source.target.track.index, 0);
  assert(Object.isFrozen(f.client.listenerJob.config.source.target.track));
  assert(Object.isFrozen(f.client.listenerJob.config.source.target));
  for (const mutate of [
    (c) => {
      c.listenerVersion = 2;
    },
    (c) => {
      c.extra = true;
    },
    (c) => {
      c.config.source.target.sceneIndex = 256;
    },
    (c) => {
      c.config.source.authority = "native";
    },
    (c) => {
      c.config.geometry.endBeat = 5;
      c.config.geometry.totalSamples = 120000;
    },
    (c) => {
      c.config.timingPolicy = {
        mode: "strict",
        maxClockDisagreementSamples: 1
      };
    },
    (c) => {
      c.config.geometry.vectorSize = 128;
    }
  ]) {
    const g = fixture(),
      c = g.control();
    mutate(c);
    g.client.handleListenerControl(c);
    assert.equal(g.admitted.length, 0);
    assert(g.client.socket.destroyed);
    assert(g.failures.length);
  }
  f.client.handleListenerControl(control);
  assert(f.client.socket.destroyed);
});
test("wire3 sends explicit ABI2 arm/launch/capture wrappers, lifecycle and raw global v2 observation", () => {
  const f = fixture(),
    prepare = f.reserve(),
    arm = f.control("arm");
  assert(f.client.sendListenerReply(prepare, { status: "ready" }));
  f.client.handleListenerControl(arm);
  assert(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.arm
    })
  );
  assert(
    f.client.sendListenerResult(arm, {
      status: "progress",
      nativeLaunch: f.native.launch
    })
  );
  assert(
    f.client.sendListenerResult(arm, {
      status: "completed",
      observation: f.native.observation,
      nativeCapture: f.native.proof
    })
  );
  for (const message of f.wire)
    (message.type === "listener.reply"
      ? listenerReplySessionSchema
      : listenerResultSessionSchema
    ).parse(message);
  assert.deepEqual(
    f.wire.map((v) => v.sequence),
    [0, 1, 2, 3]
  );
  assert.equal(f.client.listenerJob, null);
  assert.equal(f.client.offlineQueue.length, 0);
});
test("wire3 rejects old scopes, source substitution and raw observations without proof before sequence advance", () => {
  for (const payload of [
    { status: "armed", nativeArm: { scope: "arrangement-descriptive/v2" } },
    {
      status: "armed",
      nativeArm: {
        scope: status.scope,
        source,
        transport: { scope: status.scope }
      }
    },
    {
      status: "armed",
      nativeArm: {
        scope: status.scope,
        source: { ...source, target: { ...source.target, sceneIndex: 2 } }
      }
    }
  ]) {
    const f = fixture();
    f.reserve();
    const control = f.control("arm");
    f.client.handleListenerControl(control);
    assert.equal(f.client.sendListenerReply(control, payload), false);
    assert.equal(f.wire.length, 0);
    assert.equal(f.client.listenerSequence, 0);
    assert(f.client.listenerJob);
  }
  const f = fixture(),
    c = f.reserve();
  assert.equal(
    f.client.sendListenerResult(c, {
      status: "completed",
      observation: f.native.observation
    }),
    false
  );
  assert.equal(f.client.sendSample(f.native.observation), false);
  assert.equal(f.wire.length, 0);
});
test("wire3 busy/foreign cancellation cannot release ownership and owned cancellation preserves optional reason", () => {
  const f = fixture(),
    selected = f.reserve();
  f.client.handleListenerControl(f.control("prepare", { passId: "other" }));
  f.client.handleListenerControl(f.control("cancel", { traceId: "foreign" }));
  assert.equal(f.client.listenerJob.requestId, selected.requestId);
  const cancel = f.control("cancel");
  f.client.handleListenerControl(cancel);
  assert(f.client.sendListenerReply(cancel, { status: "cancelled" }));
  assert.equal(f.client.listenerJob, null);
  assert.equal(f.wire.at(-1).reason, undefined);
});
test("wire3 drain, ACKs, cancellation and redacted callback failures reuse bounded ownership semantics", async () => {
  const f = fixture(),
    written = [],
    callbacks = [];
  f.client.socket = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      written.push(JSON.parse(chunk.toString()));
      callbacks.push(done);
    }
  });
  try {
    const c = f.reserve();
    assert(f.client.sendListenerReply(c, { status: "ready" }));
    const cancel = f.control("cancel");
    f.client.handleListenerControl(cancel);
    assert(f.client.sendListenerReply(cancel, { status: "cancelled" }));
    callbacks.shift()();
    await Promise.resolve();
    callbacks.shift()();
    await Promise.resolve();
    assert.deepEqual(
      written.map((v) => v.sequence),
      [0, 1]
    );
    for (const v of written)
      f.client.handleResponse(
        JSON.stringify({
          type: "producer.ack",
          protocolVersion: 1,
          requestId: v.requestId,
          action: "listener"
        })
      );
    assert.equal(f.client.pending.size, 0);
    assert.equal(f.client.writeDrain, null);
  } finally {
    f.client.stop();
  }
  const g = fixture({
    onControl: async () => {
      throw new Error(SECRET);
    }
  });
  g.reserve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(g.wire.at(-1).status, "failed");
  assert(!JSON.stringify(g.wire).includes(SECRET));
});

test("wire3 exact result/lifecycle/ABI2 shape guards reject malformed payloads without releasing the reservation", () => {
  for (const mutate of [
    (p) => {
      p.observation.extra = true;
    },
    (p) => {
      p.observation.schema = "session-audio-observation/v1";
    },
    (p) => {
      p.observation.samples[0].sample = -1;
    },
    (p) => {
      p.observation.alignment.vectorSize = 128;
    },
    (p) => {
      p.nativeCapture.transport.envelopeWindows.pop();
    },
    (p) => {
      p.nativeCapture.transport.armed.reset.active = 1;
    },
    (p) => {
      p.nativeCapture.transport.armed.before.dsp[2] = 128;
    },
    (p) => {
      p.nativeCapture.transport.launched.armCounter += 1;
    },
    (p) => {
      p.nativeCapture.transport.extra = true;
    },
    (p) => {
      p.nativeCapture.source.target.track.index = 1;
    }
  ]) {
    const f = fixture(),
      c = f.reserve();
    const payload = structuredClone({
      status: "completed",
      observation: f.native.observation,
      nativeCapture: f.native.proof
    });
    mutate(payload);
    assert.equal(f.client.sendListenerResult(c, payload), false);
    assert.equal(f.client.listenerSequence, 0);
    assert.equal(f.wire.length, 0);
    assert(f.client.listenerJob);
    assert(f.failures.includes("invalid_listener_payload"));
  }
  const f = fixture(),
    c = f.reserve();
  const lifecycle = {
    scope: status.scope,
    eventId: "33333333-3333-4333-8333-333333333333",
    causationId: c.causationId,
    stage: "progress",
    nativeEpoch: 1,
    elapsedMs: 5,
    frames: 0,
    phase: "preflight"
  };
  assert(
    f.client.sendListenerResult(c, {
      status: "progress",
      nativeLifecycle: lifecycle
    })
  );
  listenerResultSessionSchema.parse(f.wire.at(-1));
  for (const patch of [
    { scope: "arrangement-descriptive/v2" },
    { elapsedMs: Infinity },
    { extra: true },
    { eventId: "not-a-uuid" },
    { frames: 301 },
    { phase: "unsupported" }
  ])
    assert.equal(
      f.client.sendListenerResult(c, {
        status: "progress",
        nativeLifecycle: { ...lifecycle, ...patch }
      }),
      false
    );
  assert.equal(f.client.listenerSequence, 1);
});

test("wire3 bounded encoding, disconnected ownership and stale callbacks fail explicitly", async () => {
  const f = fixture(),
    c = f.reserve();
  f.client.configuredMaxFrameBytes = 512;
  const arm = f.control("arm");
  f.client.handleListenerControl(arm);
  assert.equal(
    f.client.sendListenerReply(arm, {
      status: "armed",
      nativeArm: f.native.arm
    }),
    false
  );
  assert(f.failures.includes("listener_frame_too_large"));
  assert.equal(f.client.listenerSequence, 0);
  f.client.authenticated = false;
  assert.equal(f.client.sendListenerReply(c, { status: "ready" }), false);
  assert(f.failures.includes("listener_not_connected"));
  let reject;
  const g = fixture({
    onControl: () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      })
  });
  g.reserve();
  const rejectOld = reject;
  const cancel = g.control("cancel");
  g.client.handleListenerControl(cancel);
  assert(g.client.sendListenerReply(cancel, { status: "cancelled" }));
  const replacement = g.reserve();
  rejectOld(new Error("late_owner_failure"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(g.client.listenerJob.requestId, replacement.requestId);
  assert.equal(g.wire.length, 1);
});

test("production SDK wire3 authenticates and completes through actual typed signal ingress validation", async () => {
  const { SignalIngressServer } =
    await import("../../packages/signal-routing/src/ingress-server.ts");
  const { InMemoryConnectionRegistry } =
    await import("../../packages/signal-routing/src/registry.ts");
  const { SignalRouter } =
    await import("../../packages/signal-routing/src/router.ts");
  const registry = new InMemoryConnectionRegistry({ staleAfterMs: 15000 });
  const server = new SignalIngressServer({
    secret: SECRET,
    registry,
    router: new SignalRouter({ registry }),
    port: 0
  });
  const results = [];
  server.onListenerResult((result) => results.push(result));
  const endpoint = await server.start();
  let native, selected;
  const client = new AgentSignalClient({
    env: {},
    signalKind: "audio",
    schemaVersion: "audio-observation/v2",
    secret: SECRET,
    descriptorPath: "/synthetic/session/descriptor.json",
    readText: async () =>
      JSON.stringify({
        ...endpoint,
        protocol: "newline-delimited-json",
        protocolVersion: 1,
        maxFrameBytes: 128 * 1024,
        listenerVersions: [1, 2, 3],
        listenerCapabilities: [
          "audio-listener/v1",
          "audio-listener/v2",
          "audio-listener/session-v1"
        ]
      }),
    listener: {
      version: 3,
      capabilities: ["audio-listener/session-v1"],
      sampleRate: 48000,
      vectorSize: 64,
      algorithmVersion: "2.0.0",
      nativeStatus: status,
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0"
    },
    onListenerControl: (control) => {
      selected = control;
      assert(
        client.sendListenerReply(
          control,
          control.action === "prepare"
            ? { status: "ready" }
            : { status: "armed", nativeArm: native.arm }
        )
      );
    }
  });
  const until = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
    }
    throw new Error("synthetic_session_ingress_timeout");
  };
  try {
    client.configureProducer({
      canonicalPath: "live_set tracks 0 devices 0",
      track: { id: "1", name: "synthetic" },
      device: { id: "2", name: "listener" }
    });
    native = createSyntheticNativeSessionListeningFixture({
      source,
      listenerId: client.producer.producerId,
      passId: "session-pass"
    });
    client.start();
    await until(() => client.authenticated);
    const connection = server.inspectListeners()[0];
    assert.equal(connection.registration.version, 3);
    const context = {
      jobId: "session-job",
      passId: "session-pass",
      traceId: "session-trace",
      correlationId: "session-correlation",
      causationId: "session-cause"
    };
    await server.requestListenerControl(connection.connectionId, {
      ...context,
      action: "prepare",
      config: {
        geometry: native.expected.geometry,
        timingPolicy: native.expected.policy,
        source
      }
    });
    await server.requestListenerControl(connection.connectionId, {
      ...context,
      action: "arm"
    });
    assert(
      client.sendListenerResult(selected, {
        status: "progress",
        nativeLaunch: native.launch
      })
    );
    assert(
      client.sendListenerResult(selected, {
        status: "completed",
        nativeCapture: native.proof,
        observation: native.observation
      })
    );
    await until(() =>
      results.some((event) => event.result.status === "completed")
    );
    assert.equal(server.inspectListeners()[0].phase, "idle");
    assert.equal(results.at(-1).result.listenerVersion, 3);
    await until(() => client.pending.size === 0);
  } finally {
    client.stop();
    await server.stop();
  }
});
