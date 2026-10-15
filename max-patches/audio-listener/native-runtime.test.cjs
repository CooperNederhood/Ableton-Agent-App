const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { createHash, randomUUID } = require("node:crypto");
const {
  createRuntime,
  NATIVE_DIAGNOSTIC_LIMIT,
} = require("./audio_listener_runtime.js");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");
const { syntheticPreflight } = require("./native-preflight-fixture.cjs");
const evidence = require("./fixtures/native-host-spectrum.json");

const EPOCH = "native-connection";
const before = syntheticPreflight();
const armCounter = evidence.nativeOrigin[1];
const origin = evidence.nativeOrigin[2];
const offset = evidence.before.clockOffsetSamples;
const identity = {
  canonicalPath: "live_set tracks 0 devices 0",
  track: { id: "1", name: "synthetic fixture" },
  device: { id: "2", name: "Audio-Listener" },
};
const base = {
  type: "listener.control",
  protocolVersion: 1,
  listenerVersion: 1,
  connectionEpoch: EPOCH,
  jobId: "native-job",
  passId: "native-pass",
  traceId: "native-trace",
  correlationId: "native-correlation",
  causationId: "native-wire-root",
};

// The real shared SDK frames every reply/result. Discovery, sockets, Max and
// timely host callbacks are controlled synthetic IO, not fresh hardware evidence.
function fixture(options = {}) {
  let now = 0,
    requests = 0;
  const handlers = {},
    timers = [],
    outputs = [],
    wire = [],
    clients = [],
    cleanup = [];
  let f;
  class Client extends AgentSignalClient {
    constructor(config) {
      super(config);
      this.options = config;
      clients.push(this);
    }
    start() {
      this.started = true;
      this.listener = { ...this.listener, connectionEpoch: EPOCH };
      this.authenticated = true;
      this.socket = {
        destroyed: false,
        destroy: () => {
          this.authenticated = false;
          this.socket.destroyed = true;
        },
      };
    }
    stop() {
      cleanup.push("client-stop");
      this.authenticated = false;
      this.started = false;
      this.listenerJob = null;
    }
    writeMessage(message) {
      if (options.rejectWrite?.(message)) return false;
      wire.push(JSON.parse(JSON.stringify(message)));
      options.onWrite?.(message, f);
      return true;
    }
  }
  const runtime = (options.createRuntime ?? createRuntime)({
    maxApi: {
      addHandler: (name, fn) => {
        handlers[name] = fn;
      },
      outlet: (...values) => {
        outputs.push(values);
        return options.onOutput?.(values, f);
      },
    },
    nativeMode: options.nativeMode ?? true,
    Client,
    clock: () => now,
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR:
        "/fixture/profile/descriptor.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH:
        "/fixture/profile/credential.json",
    },
    interval: (fn) => {
      timers.push(fn);
      return fn;
    },
    clear: () => cleanup.push("timer-clear"),
  });
  const register = () => {
    handlers.identity(JSON.stringify(identity));
    handlers.dsp(1, 48000, 64);
    handlers.host(0, 4, 10000, 19);
  };
  const control = (action, patch = {}) => ({
    ...base,
    requestId: `request-${++requests}`,
    action,
    ...(action === "prepare"
      ? {
          config: {
            durationMs: 2000,
            maxWindows: 20,
            source: { mode: "arrangement", startBeat: 0, endBeat: 4 },
          },
        }
      : {}),
    ...patch,
  });
  const dispatch = (action, patch) => {
    const message = control(action, patch);
    runtime.client.handleListenerControl(message);
    return message;
  };
  const packet = (
    type,
    values,
    generation = runtime.nativeController?.pass?.generation,
  ) => handlers.native(generation, type, ...values);
  const preflight = () => {
    for (const [type, values] of [
      ["dsp", [1, 48000, 64]],
      ["tempo", [120]],
      ["fftInfo", [2048, 2048, 2048, 1]],
      ["abi-clock", [1]],
      ["abi-envelope", [1]],
      ["abi-spectrum", [1]],
    ])
      packet(type, values);
    packet("envelope", [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 1]);
    packet("spectrum", before.spectrum);
    for (const row of before.before.frames) packet("clock", row);
  };
  const ack = () =>
    packet("envelope", [
      runtime.nativeController.pass.nativeEpoch,
      -1,
      -1,
      0,
      0,
      0,
      -1,
      -1,
      0,
      0,
      0,
      0,
      0,
      armCounter,
      -1,
      1,
    ]);
  const clock = (counter) => {
    const beat = (counter - origin) / 24000,
      sample = counter + offset;
    return [
      1,
      beat,
      sample,
      31,
      counter,
      beat % 1,
      counter,
      1,
      beat,
      sample,
      31,
    ];
  };
  const envelope = (index = 0) => {
    const row = evidence.envelope.frames[index - 1] ?? [0, 0, 0, 0];
    return [
      runtime.nativeController.pass.nativeEpoch,
      576,
      -1,
      0,
      0,
      1,
      64,
      -1,
      ...row.slice(0, 4),
      index * 4800,
      armCounter,
      origin,
      1,
    ];
  };
  const launch = () => {
    packet("clock", clock(origin + 640));
    packet("envelope", envelope());
  };
  const capture = () => {
    const spectra = evidence.spectrum.frames;
    let cursor = spectra.findIndex((row) => row[0] > before.spectrum[0]);
    for (let index = 1; index <= 20; index++) {
      const end = origin + index * 4800;
      packet("clock", clock(end + 64));
      while (cursor < spectra.length && spectra[cursor][0] <= end)
        packet("spectrum", spectra[cursor++]);
      packet("envelope", envelope(index));
    }
  };
  const post = () => {
    for (let index = 0; index < 32; index++)
      packet("clock", clock(origin + 96128 + index * 64));
  };
  const armed = async () => {
    dispatch("prepare");
    const arm = dispatch("arm");
    preflight();
    ack();
    await Promise.resolve();
    return arm;
  };
  f = {
    runtime,
    handlers,
    timers,
    outputs,
    wire,
    clients,
    cleanup,
    register,
    control,
    dispatch,
    packet,
    preflight,
    ack,
    clock,
    envelope,
    launch,
    capture,
    post,
    armed,
    time: (value) => {
      now = value;
    },
  };
  register();
  return f;
}

test("explicit native option reserves fixed scope through one SDK; shipping default remains blocked and ignores numeric native packets", () => {
  const f = fixture();
  assert.equal(f.clients.length, 1);
  assert.equal(
    f.runtime.client.producer.instanceId,
    f.runtime.client.instanceId,
  );
  assert.equal(
    f.runtime.nativeStatus.scope,
    "arrangement-beat0-120bpm-48000hz-vector64/v1",
  );
  assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
  assert.equal(f.runtime.nativeStatus.timing, "UNVERIFIED");
  assert.equal(
    f.runtime.nativeStatus.reason,
    "fresh_per_pass_native_validation_required",
  );
  f.dispatch("prepare");
  assert.equal(f.wire.at(-1).status, "ready");
  assert.equal(f.runtime.engine.pass, null);
  assert.equal(f.runtime.nativeController.state, "prepared");
  assert.equal(
    f.outputs.some((row) => row[0] === "native_control"),
    false,
  );
  f.runtime.stop();

  const legacy = fixture({ nativeMode: false });
  legacy.dispatch("prepare");
  assert.equal(legacy.wire.at(-1).status, "failed");
  assert.equal(
    legacy.wire.at(-1).reason,
    "real_live_timing_validation_required",
  );
  assert.equal(legacy.runtime.nativeStatus.scope, undefined);
  assert.equal(legacy.runtime.nativeController, null);
  legacy.handlers.native("stale", "ioError", 1);
  assert.equal(
    legacy.outputs.some((row) => row[0] === "native_control"),
    false,
  );
  legacy.runtime.stop();
  assert.throws(
    () => createRuntime({ nativeMode: "true" }),
    /invalid_native_mode/,
  );
});

test("native arm reply precedes every canonical lifecycle/launch/result and complete wire independently satisfies actual strict App schemas", async () => {
  const f = fixture();
  const arm = await f.armed();
  f.launch();
  f.capture();
  f.post();
  const {
    listenerRegistrationSchema,
    listenerReplySchema,
    listenerResultSchema,
  } = await import("../../packages/signal-routing/src/listener-contracts.ts");
  const { assertNativeCaptureObservation } =
    await import("../../packages/protocol/src/native-listening-schemas.ts");
  listenerRegistrationSchema.parse(f.runtime.client.listener);
  for (const frame of f.wire)
    (frame.type === "listener.reply"
      ? listenerReplySchema
      : listenerResultSchema
    ).parse(frame);
  const armedIndex = f.wire.findIndex((frame) => frame.status === "armed");
  assert.equal(f.wire[armedIndex].requestId, arm.requestId);
  assert.equal(f.wire.filter((frame) => frame.status === "armed").length, 1);
  assert(
    f.wire
      .slice(0, armedIndex)
      .every((frame) => frame.type === "listener.reply"),
  );
  const result = f.wire.at(-1);
  assert.equal(result.status, "completed");
  assertNativeCaptureObservation(result.nativeCapture, result.observation);
  assert.equal(
    result.observation.listenerId,
    f.runtime.client.producer.producerId,
  );
  const launched = f.wire.filter((frame) => frame.nativeLaunch);
  assert.equal(launched.length, 1);
  assert.deepEqual(result.nativeCapture.launched, launched[0].nativeLaunch);
  assert.deepEqual(result.nativeCapture.armed, f.wire[armedIndex].nativeArm);
  for (const [index, frame] of f.wire.entries()) {
    assert.equal(frame.sequence, index);
    assert.equal(frame.traceId, base.traceId);
    assert.equal(frame.correlationId, base.correlationId);
    assert.equal(frame.causationId, base.causationId);
  }
  const lifecycle = f.wire
    .filter((frame) => frame.nativeLifecycle)
    .map((frame) => frame.nativeLifecycle);
  for (const phase of ["preflight", "reset", "capture"]) {
    assert.equal(
      lifecycle.filter(
        (event) => event.phase === phase && event.stage === "completed",
      ).length,
      1,
    );
  }
  const ancestors = new Set([base.causationId]);
  for (const event of lifecycle) {
    assert(
      ancestors.has(event.causationId),
      `${event.phase}: orphan ${event.causationId}`,
    );
    assert(!ancestors.has(event.eventId), "duplicate lifecycle UUID");
    ancestors.add(event.eventId);
    assert.equal(
      event.generation,
      f.outputs.find(
        (row) => row[0] === "native_control" && row[1] === "begin",
      )[2],
    );
    assert.equal(event.nativeEpoch, result.nativeCapture.armed.nativeEpoch);
    if (event.phase !== "capture") assert.equal(event.frames, 0);
  }
  const local = f.outputs
    .filter((row) => row[0] === "native_diagnostic")
    .map((row) => JSON.parse(row[1]));
  const preflightCompleted = local.find(
    (event) =>
      event.type === "native-preflight-stage" && event.stage === "completed",
  );
  assert.equal(
    lifecycle.find((event) => event.phase === "capture").causationId,
    preflightCompleted.eventId,
  );
  assert.equal(preflightCompleted.traceId, result.traceId);
  assert.equal(preflightCompleted.correlationId, result.correlationId);
  assert.equal(
    lifecycle.some(
      (event) =>
        event.eventId === preflightCompleted.eventId &&
        event.phase === "preflight",
    ),
    true,
  );
  assert(
    f.outputs
      .filter((row) => row[0] === "native_control")
      .every((row) => ["begin", "arm", "stop"].includes(row[1])),
  );
  assert.equal(f.runtime.nativeStatus.readiness, "BLOCKED");
  f.runtime.stop();
});

test("supported legacy UI attack settings are consumed by controller prepare, frozen per pass and reported truthfully in native observation", async () => {
  const f = fixture();
  f.handlers["attack-threshold"](18);
  f.handlers["attack-spacing-ms"](200);
  f.dispatch("prepare");
  assert.deepEqual(f.runtime.nativeController.pass.command.settings, {
    attackThresholdDb: 18,
    minAttackSpacingSamples: 9600,
  });
  f.handlers["attack-threshold"](1);
  f.handlers["attack-spacing-ms"](1000);
  f.dispatch("arm");
  f.preflight();
  f.ack();
  await Promise.resolve();
  f.launch();
  f.capture();
  f.post();
  assert.deepEqual(f.wire.at(-1).observation.algorithm.settings, {
    attackThresholdDb: 18,
    minAttackSpacingSamples: 9600,
  });
  const { listenerResultSchema } =
    await import("../../packages/signal-routing/src/listener-contracts.ts");
  const { assertNativeCaptureObservation } =
    await import("../../packages/protocol/src/native-listening-schemas.ts");
  const result = listenerResultSchema.parse(f.wire.at(-1));
  assertNativeCaptureObservation(result.nativeCapture, result.observation);
  assert(
    f.outputs
      .filter((row) => row[0] === "native_control")
      .every((row) => ["begin", "arm", "stop"].includes(row[1])),
  );
  f.dispatch("prepare", { passId: "next-pass", jobId: "next-job" });
  assert.deepEqual(f.runtime.nativeController.pass.command.settings, {
    attackThresholdDb: 1,
    minAttackSpacingSamples: 48000,
  });
  f.runtime.stop();
});

test("synchronous begin/arm delivery and native packets reentrant inside armed serialization cannot publish premature progress or duplicate replies", async () => {
  const f = fixture({
    onOutput: (row, context) => {
      if (row[0] === "native_control" && row[1] === "begin")
        context.preflight();
      if (row[0] === "native_control" && row[1] === "arm") context.ack();
    },
    onWrite: (frame, context) => {
      if (frame.status === "armed") {
        context.launch();
        assert.equal(
          context.wire.filter((message) => message.type === "listener.result")
            .length,
          0,
        );
      }
    },
  });
  f.dispatch("prepare");
  f.dispatch("arm");
  await Promise.resolve();
  assert.equal(f.wire.filter((frame) => frame.status === "armed").length, 1);
  f.packet("clock", f.clock(origin + 704));
  assert.equal(f.wire.filter((frame) => frame.nativeLaunch).length, 1);
  for (let index = 0; index < f.wire.length; index++)
    assert.equal(f.wire[index].sequence, index);
  f.dispatch("cancel");
  f.runtime.stop();
});

test("reentrant cancellation inside the armed writer is fenced until SDK sequence confirmation and replies exactly once", async () => {
  let cancel;
  const f = fixture({
    onWrite: (frame, context) => {
      if (frame.status === "armed") {
        cancel = context.control("cancel");
        context.runtime.client.options.onListenerControl(cancel);
      }
    },
  });
  f.dispatch("prepare");
  f.dispatch("arm");
  f.preflight();
  f.ack();
  await Promise.resolve();
  for (const [index, frame] of f.wire.entries())
    assert.equal(frame.sequence, index);
  assert.equal(f.wire.at(-1).status, "cancelled");
  assert.equal(f.wire.at(-1).requestId, cancel.requestId);
  assert.equal(f.wire.filter((frame) => frame.status === "armed").length, 1);
  assert.equal(f.runtime.nativeController.pass, null);
  assert(
    f.wire
      .filter((frame) => frame.type === "listener.result")
      .every(
        (frame) =>
          ["preflight", "reset"].includes(frame.nativeLifecycle?.phase) &&
          frame.nativeLaunch === undefined &&
          frame.observation === undefined,
      ),
  );
  f.runtime.stop();
});

test("native prepare denies unsupported scope and native arm timeout emits only the matching failed reply before publication", async () => {
  for (const config of [
    {
      durationMs: 2000,
      maxWindows: 20,
      source: { mode: "session", startBeat: 0, endBeat: 4 },
    },
    {
      durationMs: 2000,
      maxWindows: 20,
      source: { mode: "arrangement", startBeat: 1, endBeat: 4 },
    },
    {
      durationMs: 10001,
      maxWindows: 101,
      source: { mode: "arrangement", startBeat: 0, endBeat: 20.2 },
    },
  ]) {
    const f = fixture();
    f.dispatch("prepare", { config });
    assert.equal(f.wire.at(-1).status, "failed");
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(
      f.outputs.some((row) => row[0] === "native_control"),
      false,
    );
    f.runtime.stop();
  }
  const f = fixture();
  f.dispatch("prepare");
  const arm = f.dispatch("arm");
  f.preflight();
  f.time(1000);
  f.timers[0]();
  await Promise.resolve();
  assert.equal(f.wire.at(-1).requestId, arm.requestId);
  assert.equal(f.wire.at(-1).reason, "native_arm_ack_timeout");
  assert.equal(
    f.wire.filter((frame) => frame.type === "listener.result").length,
    0,
  );
  assert.equal(
    f.outputs.filter((row) => row[0] === "native_control").at(-1)[1],
    "stop",
  );
  f.runtime.stop();
});

test("stale native generations and legacy host/descriptors never become native proof; a matching owned ioError fails terminal without capture proof", async () => {
  const f = fixture();
  f.dispatch("prepare");
  f.dispatch("arm");
  f.packet("ioError", [1], "stale-generation");
  f.handlers.host(1, 0, origin + offset, 31);
  f.handlers.frame(1, 1, 0.5, 0.5, 4800, 1000, 1);
  assert.equal(f.runtime.engine.pass, null);
  assert.equal(f.runtime.nativeController.state, "preflight");
  f.preflight();
  f.ack();
  await Promise.resolve();
  f.launch();
  const generation = f.runtime.nativeController.pass.generation;
  f.packet("ioError", [1], generation);
  const result = f.wire.at(-1);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "native_io_packet_failed");
  assert.equal(result.nativeCapture, undefined);
  assert.equal(f.runtime.nativeController.pass, null);
  const count = f.wire.length;
  f.packet("envelope", [1], generation);
  assert.equal(f.wire.length, count);
  f.runtime.stop();
});

test("cancel during preflight and after launch settles pending arm and replies once to cancel, never failed/completed on stale arm", async () => {
  for (const launched of [false, true]) {
    const f = fixture();
    f.dispatch("prepare");
    const arm = f.dispatch("arm");
    if (launched) {
      f.preflight();
      f.ack();
      await Promise.resolve();
      f.launch();
    }
    const cancel = f.dispatch("cancel");
    await Promise.resolve();
    assert.equal(
      f.wire.filter((frame) => frame.requestId === cancel.requestId).length,
      1,
    );
    assert.equal(f.wire.at(-1).status, "cancelled");
    assert.equal(
      f.wire.filter(
        (frame) =>
          frame.requestId === arm.requestId && frame.status === "failed",
      ).length,
      0,
    );
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(f.runtime.engine.pass, null);
    f.runtime.stop();
    assert.equal(f.cleanup.filter((item) => item === "timer-clear").length, 1);
  }
});

test("connection epoch replacement cancels pending generation but preserves the one SDK producer instance; old epoch controls/callbacks cannot publish", async () => {
  const f = fixture();
  f.dispatch("prepare");
  f.dispatch("arm");
  const client = f.runtime.client,
    instance = client.instanceId;
  const generation = f.runtime.nativeController.pass.generation;
  client.listener.connectionEpoch = "fresh-connection";
  f.runtime.refreshRegistration();
  await Promise.resolve();
  assert.equal(f.runtime.client, client);
  assert.equal(client.instanceId, instance);
  assert.equal(f.clients.length, 1);
  assert.equal(f.runtime.nativeController.pass, null);
  const count = f.wire.length;
  client.options.onListenerControl(f.control("arm"));
  f.packet("ioError", [1], generation);
  assert.equal(f.wire.length, count);
  f.runtime.stop();
});

test("disconnect, reset, identity loss and runtime stop close native polling/assembly without transport ownership", async () => {
  for (const kind of ["disconnect", "reset", "identity", "stop"]) {
    const f = fixture();
    await f.armed();
    f.launch();
    const retained = f.runtime.nativeController.pass;
    if (kind === "disconnect") {
      f.runtime.client.authenticated = false;
      f.runtime.client.options.onStatus("live", "disconnected");
    } else if (kind === "reset") f.handlers.reset();
    else if (kind === "identity") f.handlers.identity("invalid identity");
    else f.runtime.stop();
    await Promise.resolve();
    assert.equal(retained.closed, true);
    assert.equal(retained.assembler.pending.length, 0);
    assert.equal(retained.assembler.spectra.length, 0);
    assert.equal(
      f.outputs.filter((row) => row[0] === "native_control").at(-1)[1],
      "stop",
    );
    assert(
      f.outputs.every(
        (row) => !["transport", "play", "stop", "seek"].includes(row[0]),
      ),
    );
    assert.equal(
      f.wire.some((frame) => frame.status === "completed"),
      false,
    );
    f.runtime.stop();
  }
});

test("armed publication refusal fails closed before any canonical progress/result", async () => {
  const f = fixture({ rejectWrite: (frame) => frame.status === "armed" });
  f.dispatch("prepare");
  f.dispatch("arm");
  f.preflight();
  f.ack();
  await Promise.resolve();
  assert.equal(
    f.wire.some((frame) => frame.type === "listener.result"),
    false,
  );
  assert.equal(f.runtime.nativeController.pass, null);
  assert.equal(f.runtime.engine.pass, null);
  f.runtime.stop();
});

test("reset during preflight fails the pending arm once, releases SDK job ownership and permits a new reservation without new producer identity", async () => {
  const f = fixture();
  f.dispatch("prepare");
  const arm = f.dispatch("arm");
  const client = f.runtime.client,
    instance = client.instanceId;
  f.handlers.reset();
  await Promise.resolve();
  assert.equal(
    f.wire.filter((frame) => frame.requestId === arm.requestId).length,
    1,
  );
  assert.equal(f.wire.at(-1).status, "failed");
  assert.equal(f.wire.at(-1).reason, "reset");
  assert.equal(client.listenerJob, null);
  f.dispatch("prepare", { passId: "fresh-pass", jobId: "fresh-job" });
  assert.equal(f.wire.at(-1).status, "ready");
  assert.equal(f.runtime.client, client);
  assert.equal(client.instanceId, instance);
  f.runtime.stop();
});

test("reentrant controls have a fixed quota and traced local dispatch diagnostics; overflow cannot resurrect or manufacture completion", async () => {
  const f = fixture({
    onWrite: (frame, context) => {
      if (frame.status === "armed")
        for (let index = 0; index < 33; index++)
          context.runtime.client.options.onListenerControl(
            context.control("cancel"),
          );
    },
  });
  f.dispatch("prepare");
  f.dispatch("arm");
  f.preflight();
  f.ack();
  await Promise.resolve();
  assert.equal(f.runtime.nativeController.pass, null);
  assert.equal(f.runtime.engine.pass, null);
  assert.equal(
    f.wire.some((frame) => frame.status === "completed"),
    false,
  );
  const diagnostics = f.outputs
    .filter((row) => row[0] === "native_diagnostic")
    .map((row) => JSON.parse(row[1]));
  const dispatch = diagnostics.filter(
    (event) => event.type === "native-runtime-control-stage",
  );
  assert.equal(dispatch.filter((event) => event.stage === "queued").length, 32);
  assert.equal(
    dispatch.filter((event) => event.stage === "cancelled").length,
    32,
  );
  for (const event of dispatch) {
    assert.equal(event.traceId, base.traceId);
    assert.equal(event.correlationId, base.correlationId);
    assert(event.queued <= 32);
    assert(event.elapsedMs >= 0 && event.elapsedMs <= 120000);
    assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  }
  assert(
    diagnostics.some(
      (event) => event.reason === "native_control_queue_overflow",
    ),
  );
  assert.equal(
    f.outputs.filter((row) => row[0] === "native_control").at(-1)[1],
    "stop",
  );
  f.runtime.stop();
});

test("SDK foreign/replayed controls cannot orphan a selected native pass or publish fresh proof", async () => {
  for (const replay of [false, true]) {
    const f = fixture();
    f.dispatch("prepare");
    if (replay) {
      const arm = f.dispatch("arm");
      f.runtime.client.handleListenerControl(arm);
    } else {
      f.dispatch("arm", { passId: "foreign-pass", jobId: "foreign-job" });
      f.timers[0]();
    }
    await Promise.resolve();
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(f.runtime.client.listenerJob, null);
    assert.equal(
      f.wire.some((frame) => frame.status === "armed"),
      false,
    );
    assert.equal(
      f.wire.some((frame) => frame.nativeCapture),
      false,
    );
    f.runtime.stop();
  }
});

test("native control/output and canonical consumer failures clean safely without raw callback text or fabricated success", async () => {
  for (const kind of ["native-output", "result-output"]) {
    const f = fixture({
      onOutput: (row) => {
        if (
          kind === "native-output" &&
          row[0] === "native_control" &&
          row[1] === "begin"
        )
          throw new Error("api_key=DO_NOT_LOG_THIS");
      },
      rejectWrite: (frame) =>
        kind === "result-output" && frame.type === "listener.result",
    });
    f.dispatch("prepare");
    f.dispatch("arm");
    if (kind === "result-output") {
      f.preflight();
      f.ack();
    }
    await Promise.resolve();
    assert.equal(f.runtime.nativeController.pass, null);
    assert.equal(f.runtime.engine.pass, null);
    assert.equal(f.runtime.client.listenerJob, null);
    assert.equal(
      f.wire.some((frame) => frame.status === "completed"),
      false,
    );
    assert(!JSON.stringify(f.outputs).includes("DO_NOT_LOG_THIS"));
    f.runtime.stop();
  }
});

test("covered descriptors without post proof time out as canonical partial, never complete or carrying nativeCapture", async () => {
  const f = fixture();
  await f.armed();
  f.launch();
  f.capture();
  f.time(4000);
  f.timers[0]();
  const partial = f.wire.at(-1);
  assert.equal(partial.status, "partial");
  assert.equal(partial.reason, "native_capture_timeout");
  assert.equal(partial.observation.complete, false);
  assert.equal(partial.nativeCapture, undefined);
  const { listenerResultSchema } =
    await import("../../packages/signal-routing/src/listener-contracts.ts");
  listenerResultSchema.parse(partial);
  assert.equal(f.runtime.nativeController.pass, null);
  f.runtime.stop();
});

test("identity replacement fences the old SDK callbacks/generation and new native reservation retains its own physical instance", async () => {
  const f = fixture();
  await f.armed();
  const oldClient = f.runtime.client;
  const oldGeneration = f.runtime.nativeController.pass.generation;
  f.handlers.identity(
    JSON.stringify({ ...identity, device: { id: "3", name: "replacement" } }),
  );
  assert.equal(f.clients.length, 2);
  assert.notEqual(f.runtime.client.instanceId, oldClient.instanceId);
  f.dispatch("prepare");
  const reserved = f.runtime.nativeController.pass;
  const count = f.wire.length;
  oldClient.options.onListenerControl(f.control("arm"));
  oldClient.options.onListenerFailure("late_callback");
  oldClient.options.onStatus("live", "disconnected");
  f.packet("ioError", [1], oldGeneration);
  assert.equal(f.wire.length, count);
  assert.equal(f.runtime.nativeController.pass, reserved);
  f.runtime.stop();
});

test("Node16-compatible runtime native composition works without Object.hasOwn and leaves the physically executed controller SHA unchanged", async () => {
  const exported = { exports: {} };
  const compatibleObject = new Proxy(Object, {
    get: (target, key) =>
      key === "hasOwn" ? undefined : Reflect.get(target, key),
  });
  runInNewContext(
    readFileSync(require.resolve("./audio_listener_runtime.js"), "utf8"),
    {
      module: exported,
      require,
      process: { env: {} },
      Object: compatibleObject,
      setInterval: () => {},
      clearInterval: () => {},
    },
  );
  const f = fixture({ createRuntime: exported.exports.createRuntime });
  await f.armed();
  f.launch();
  f.capture();
  f.post();
  assert.equal(f.wire.at(-1).status, "completed");
  assert.equal(
    createHash("sha256")
      .update(
        readFileSync(require.resolve("./audio_listener_native_controller.js")),
      )
      .digest("hex"),
    require("./fixtures/native-acquisition-recovery.json")
      .currentSourceSnapshot["audio_listener_native_controller.js"].sha256,
  );
  f.runtime.stop();
});

test("phase-incoherent acquisition publishes causal bounded progress and preserves full native proof", async () => {
  const f = fixture();
  await f.armed();
  const spectrum = f.runtime.nativeController.pass.spectrum;
  f.packet("spectrum", [
    spectrum[0],
    spectrum[1],
    spectrum[2],
    spectrum[0],
    spectrum[0] + 2048,
    spectrum[5],
  ]);
  assert.equal(f.runtime.nativeController.pass.spectrum, spectrum);
  f.launch();
  f.time(30);
  const previous = f.runtime.nativeController.pass.clock;
  const row = f.clock(origin + 1000);
  row[1] = row[8] = row[1] + 64 / 24000;
  row[2] = row[9] = row[2] + 64;
  f.packet("clock", row);
  assert.equal(f.runtime.nativeController.pass.clock, previous);
  const diagnostic = f.outputs
    .filter((item) => item[0] === "native_diagnostic")
    .map((item) => JSON.parse(item[1]))
    .find((item) => item.reason === "phase_torn_native_clock");
  assert.equal(diagnostic.stage, "progress");
  assert.equal(diagnostic.rejected, 2);
  assert(
    f.wire.some(
      (frame) =>
        frame.nativeLifecycle?.eventId === diagnostic.eventId &&
        frame.nativeLifecycle.causationId === diagnostic.causationId &&
        frame.nativeLifecycle.stage === "progress",
    ),
  );
  const spectralDiagnostic = f.outputs
    .filter((item) => item[0] === "native_diagnostic")
    .map((item) => JSON.parse(item[1]))
    .find((item) => item.reason === "torn_native_spectrum");
  assert(
    f.wire.some(
      (frame) =>
        frame.nativeLifecycle?.eventId === spectralDiagnostic.eventId &&
        frame.nativeLifecycle.stage === "progress",
    ),
  );
  f.capture();
  f.post();
  assert.equal(f.wire.at(-1).status, "completed");
  assert.equal(f.wire.at(-1).nativeCapture.after.frames.length, 32);
  f.runtime.stop();
});

test("acquisition progress publication failure or reentrant cancellation cannot retain or complete a native pass", async () => {
  for (const mode of ["failed-write", "cancel"]) {
    const f = fixture({
      rejectWrite: (message) =>
        mode === "failed-write" &&
        message.nativeLifecycle?.reason === "phase_torn_native_clock",
      onWrite: (message, owner) => {
        if (
          mode === "cancel" &&
          message.nativeLifecycle?.reason === "phase_torn_native_clock"
        )
          owner.dispatch("cancel");
      },
    });
    await f.armed();
    f.launch();
    const row = f.clock(origin + 1000);
    row[1] = row[8] = row[1] + 64 / 24000;
    row[2] = row[9] = row[2] + 64;
    f.packet("clock", row);
    assert.equal(f.runtime.nativeController.pass, null, mode);
    assert(!f.wire.some((message) => message.status === "completed"), mode);
    assert(
      f.outputs.some(
        (item) => item[0] === "native_control" && item[1] === "stop",
      ),
    );
    f.runtime.stop();
  }
});

test("preflight/waiting-reset timestamps and UUIDs survive post-armed phase publication without restarting preflight after completion", async () => {
  const f = fixture();
  f.dispatch("prepare");
  f.dispatch("arm");
  f.time(200);
  f.preflight();
  f.time(210);
  const torn = [...before.before.frames.at(-1)];
  torn[6] += 64;
  torn[9] += 64;
  f.packet("clock", torn);
  f.time(215);
  f.packet("envelope", [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 1]);
  assert.equal(
    f.wire.filter((frame) => frame.type === "listener.result").length,
    0,
  );
  f.time(260);
  f.ack();
  await Promise.resolve();
  const phases = f.wire
    .filter((frame) => frame.nativeLifecycle)
    .map((frame) => frame.nativeLifecycle);
  assert.deepEqual(
    phases
      .filter((event) => event.phase === "preflight")
      .map((event) => event.stage),
    ["queued", "started", "completed"],
  );
  assert.equal(
    phases.find(
      (event) => event.phase === "preflight" && event.stage === "completed",
    ).elapsedMs,
    200,
  );
  assert.deepEqual(
    phases
      .filter((event) => event.phase === "reset")
      .map((event) => [event.stage, event.elapsedMs]),
    [
      ["queued", 0],
      ["started", 0],
      ["progress", 10],
      ["progress", 15],
      ["completed", 60],
    ],
  );
  const localWaiting = f.outputs
    .filter((row) => row[0] === "native_diagnostic")
    .map((row) => JSON.parse(row[1]))
    .find((event) => event.reason === "waiting_native_reset");
  assert.equal(localWaiting.elapsedMs, 215);
  assert(
    phases.some(
      (event) =>
        event.phase === "reset" &&
        event.stage === "progress" &&
        event.eventId === localWaiting.eventId &&
        event.causationId === localWaiting.causationId,
    ),
  );
  const parents = new Set([base.causationId]);
  for (const event of phases) {
    assert(parents.has(event.causationId), `orphan: ${event.causationId}`);
    parents.add(event.eventId);
  }
  const { listenerResultSchema } =
    await import("../../packages/signal-routing/src/listener-contracts.ts");
  for (const frame of f.wire.filter(
    (event) => event.type === "listener.result",
  ))
    listenerResultSchema.parse(frame);
  assert.equal(f.runtime.nativeDiagnosticBufferSize, 0);
  f.dispatch("cancel");
  f.runtime.stop();
});

test("failed/cancelled pre-armed reset phases stay local and buffers clear only without illegal result publication", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture();
    f.dispatch("prepare");
    const arm = f.dispatch("arm");
    f.time(200);
    f.preflight();
    let reply = arm;
    if (cancelled) {
      f.time(230);
      reply = f.dispatch("cancel");
    } else {
      f.time(1200);
      f.timers[0]();
    }
    await Promise.resolve();
    assert.equal(f.wire.at(-1).requestId, reply.requestId);
    assert.equal(f.wire.at(-1).status, cancelled ? "cancelled" : "failed");
    assert.equal(
      f.wire.some((frame) => frame.type === "listener.result"),
      false,
    );
    const local = f.outputs
      .filter((row) => row[0] === "native_diagnostic")
      .map((row) => JSON.parse(row[1]));
    const reset = local.filter((event) => event.type === "native-reset-stage");
    assert.deepEqual(
      reset.map((event) => event.stage),
      ["queued", "started", cancelled ? "cancelled" : "failed"],
    );
    assert.equal(reset.at(-1).elapsedMs, cancelled ? 30 : 1000);
    assert.equal(f.runtime.nativeDiagnosticBufferSize, 0);
    assert.equal(f.runtime.nativeController.pass, null);
    f.runtime.stop();
  }
});

test("maximum real held/torn/pre-ACK observations fit the explicit 200-event quota and drain after armed before capture", async () => {
  const f = fixture();
  f.dispatch("prepare");
  f.dispatch("arm");
  const first = before.before.frames[0];
  const torn = [...first];
  torn[6]++;
  f.packet("clock", first);
  for (let index = 0; index < 64; index++) {
    f.packet("clock", first);
    f.packet("clock", torn);
  }
  f.preflight();
  for (let index = 0; index < 64; index++)
    f.packet(
      "envelope",
      [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 1],
    );
  assert.equal(NATIVE_DIAGNOSTIC_LIMIT, 200);
  assert.equal(f.runtime.nativeDiagnosticBufferSize, 197);
  assert.equal(
    f.wire.some((frame) => frame.type === "listener.result"),
    false,
  );
  f.ack();
  await Promise.resolve();
  assert.equal(f.runtime.nativeDiagnosticBufferSize, 0);
  const diagnostics = f.wire.filter((frame) =>
    ["preflight", "reset"].includes(frame.nativeLifecycle?.phase),
  );
  assert.equal(diagnostics.length, 198);
  const firstCapture = f.wire.findIndex(
    (frame) => frame.nativeLifecycle?.phase === "capture",
  );
  assert.equal(firstCapture, 200);
  const parents = new Set([base.causationId]);
  for (const frame of f.wire) {
    if (frame.nativeLifecycle) {
      assert(parents.has(frame.nativeLifecycle.causationId));
      parents.add(frame.nativeLifecycle.eventId);
    }
  }
  f.dispatch("cancel");
  assert.equal(f.runtime.nativeDiagnosticBufferSize, 0);
  f.runtime.stop();
});

test("diagnostic overflow is bounded, local and failed through the existing control reply, never a fabricated success-shaped result", async () => {
  const f = fixture();
  f.dispatch("prepare");
  const arm = f.dispatch("arm");
  // Deliberately synthetic observer spam, not measured brackets or hardware
  // evidence: defend the runtime quota even if a future producer over-emits.
  const event = {
    ...base,
    type: "native-preflight-stage",
    stage: "progress",
    eventId: randomUUID(),
    generation: f.runtime.nativeController.pass.generation,
    nativeEpoch: 0,
    elapsedMs: 0,
    frames: 0,
  };
  for (let index = 2; index < NATIVE_DIAGNOSTIC_LIMIT; index++)
    f.runtime.nativeController.observe({ ...event, eventId: randomUUID() });
  assert.equal(f.runtime.nativeDiagnosticBufferSize, NATIVE_DIAGNOSTIC_LIMIT);
  assert.throws(
    () => f.runtime.nativeController.observe(event),
    /native_diagnostic_buffer_overflow/,
  );
  assert.equal(f.runtime.nativeDiagnosticBufferSize, NATIVE_DIAGNOSTIC_LIMIT);
  f.time(2000);
  f.timers[0]();
  await Promise.resolve();
  assert.equal(f.wire.at(-1).requestId, arm.requestId);
  assert.equal(f.wire.at(-1).status, "failed");
  assert.equal(f.wire.at(-1).reason, "native_diagnostic_buffer_overflow");
  assert.equal(
    f.wire.some((frame) => frame.type === "listener.result"),
    false,
  );
  assert.equal(f.runtime.nativeDiagnosticBufferSize, 0);
  f.runtime.stop();
});

test("an expired unarmed reservation retains local failure but cannot publish progress and does not orphan SDK job ownership", () => {
  const f = fixture();
  f.dispatch("prepare");
  f.time(15000);
  f.timers[0]();
  assert.equal(f.runtime.nativeController.pass, null);
  assert.equal(f.runtime.nativeDiagnosticBufferSize, 0);
  assert.equal(f.runtime.client.listenerJob, null);
  assert.equal(f.wire.length, 1);
  assert.equal(f.wire[0].status, "ready");
  f.dispatch("prepare", { jobId: "fresh-job", passId: "fresh-pass" });
  assert.equal(f.wire.at(-1).status, "ready");
  f.runtime.stop();
});

test("native watchdog context precedes begin with the exact owned generation and bounded arm wire trace; legacy mode never emits it", async () => {
  const f = fixture();
  f.dispatch("prepare");
  const arm = f.dispatch("arm", { causationId: "watchdog-arm-root" });
  const contextIndex = f.outputs.findIndex(
    (row) => row[0] === "native_watchdog_context",
  );
  const beginIndex = f.outputs.findIndex(
    (row) => row[0] === "native_control" && row[1] === "begin",
  );
  assert.equal(beginIndex, contextIndex + 1);
  assert.deepEqual(f.outputs[contextIndex], [
    "native_watchdog_context",
    f.runtime.nativeController.pass.generation,
    arm.traceId,
    arm.correlationId,
    arm.causationId,
  ]);
  assert(
    f.outputs[contextIndex].slice(2).every((value) => value.length <= 128),
  );
  f.dispatch("cancel");
  await Promise.resolve();
  assert.equal(
    f.outputs.filter((row) => row[0] === "native_watchdog_context").length,
    1,
  );
  f.runtime.stop();

  const legacy = fixture({ nativeMode: false });
  legacy.dispatch("prepare");
  assert.equal(
    legacy.outputs.some((row) => row[0] === "native_watchdog_context"),
    false,
  );
  legacy.runtime.stop();
});

test("failed watchdog context publication cannot emit begin or resolve native arm and does not expose callback bodies", async () => {
  for (const throwing of [false, true]) {
    const f = fixture({
      onOutput: (row) => {
        if (row[0] !== "native_watchdog_context") return;
        if (throwing) throw new Error("token=DO_NOT_LOG_THIS");
        return false;
      },
    });
    f.dispatch("prepare");
    const arm = f.dispatch("arm");
    await Promise.resolve();
    assert.equal(
      f.outputs.some(
        (row) => row[0] === "native_control" && row[1] === "begin",
      ),
      false,
    );
    assert.equal(f.wire.at(-1).requestId, arm.requestId);
    assert.equal(f.wire.at(-1).status, "failed");
    assert.equal(f.wire.at(-1).reason, "native_control_send_failed");
    assert.equal(f.runtime.nativeController.pass, null);
    assert(!JSON.stringify(f.outputs).includes("DO_NOT_LOG_THIS"));
    f.runtime.stop();
  }
});
