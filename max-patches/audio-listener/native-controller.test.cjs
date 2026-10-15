const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { setImmediate } = require("node:timers");
const {
  NativeCaptureController,
} = require("./audio_listener_native_controller.js");
const { AudioListenerEngine } = require("./audio_listener_engine.js");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");
const { syntheticPreflight } = require("./native-preflight-fixture.cjs");
const recorded = require("./fixtures/native-host-spectrum.json");
const phaseMismatch = require("./fixtures/native-clock-phase-mismatch.json");
const spectrumMismatch = require("./fixtures/native-spectrum-torn-read.json");
const hardenedFailure = require("./fixtures/native-hardened-fixture-failure.json");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");

const owner = { passId: "native-pass", connectionEpoch: "native-connection" };
const command = {
  ...owner,
  traceId: "native-trace",
  correlationId: "native-correlation",
  causationId: "wire-root",
  mode: "arrangement",
  startBeat: 0,
  endBeat: 4,
};
const armCounter = recorded.nativeOrigin[1];
const origin = recorded.nativeOrigin[2];
const offset = recorded.before.clockOffsetSamples;
const before = syntheticPreflight();
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixture(options = {}) {
  let now = 0;
  const sent = [],
    events = [],
    observed = [],
    order = [],
    armed = [];
  const Controller = options.Controller ?? NativeCaptureController;
  const controller = new Controller({
    listenerId: "listener",
    now: () => now,
    send: (packet) => {
      sent.push(packet);
      return options.send?.(packet) ?? true;
    },
    onArmed: (proof) => {
      order.push("armed");
      armed.push(proof);
      return options.onArmed ? options.onArmed(proof) : true;
    },
    emit: (event) => {
      order.push(event.type);
      events.push(event);
      options.emit?.(event);
    },
    observe: (event) => {
      observed.push(event);
      options.observe?.(event);
    },
  });
  const prepare = (patch = {}) => controller.prepare({ ...command, ...patch });
  const ingest = (type, values, generation = controller.pass?.generation) =>
    controller.ingest({ generation, type, values });
  const metadata = (exclude = []) => {
    for (const [type, values] of [
      ["dsp", [1, 48000, 64]],
      ["tempo", [120]],
      ["fftInfo", [2048, 2048, 2048, 1]],
      ["abi-clock", [1]],
      ["abi-envelope", [1]],
      ["abi-spectrum", [1]],
    ])
      if (!exclude.includes(type)) ingest(type, values);
  };
  const epoch = (seen = 0) =>
    ingest("envelope", [
      seen,
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
      0,
      -1,
      1,
    ]);
  const preflight = (exclude = [], seen = 0) => {
    metadata(exclude);
    if (!exclude.includes("envelope")) epoch(seen);
    if (!exclude.includes("spectrum")) ingest("spectrum", before.spectrum);
    for (const row of before.before.frames) ingest("clock", row);
  };
  const ack = (patch = {}) => {
    const v = [
      controller.pass?.nativeEpoch,
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
    ];
    for (const [index, value] of Object.entries(patch)) v[index] = value;
    return ingest("envelope", v);
  };
  const clock = (counter, playing = true) => {
    const sample = counter + offset;
    const beat = playing ? (counter - origin) / 24000 : 0;
    return [
      Number(playing),
      beat,
      sample,
      31,
      counter,
      playing ? beat % 1 : 0.25,
      counter,
      Number(playing),
      beat,
      sample,
      31,
    ];
  };
  const envelope = (index = 0, silent = false) => {
    const row = recorded.envelope.frames[index - 1] ?? [0, 0, 0, 0, 0];
    return [
      controller.pass?.nativeEpoch,
      576,
      -1,
      0,
      0,
      1,
      64,
      -1,
      ...(silent ? [0, 0, 0, 0] : row.slice(0, 4)),
      index * 4800,
      armCounter,
      origin,
      1,
    ];
  };
  const launch = () => {
    ingest("clock", clock(origin + 640));
    ingest("envelope", envelope());
  };
  // Actual recorded descriptors with clearly synthetic timely IO callbacks.
  // This never claims real Max/Live delivery or shipping readiness.
  const capture = (silent = false, envelopeFirst = false, tornWindow = 0) => {
    const spectra = recorded.spectrum.frames;
    let cursor = spectra.findIndex((packet) => packet[0] > before.spectrum[0]);
    for (let index = 1; index <= 20; index++) {
      const end = origin + index * 4800;
      if (index === tornWindow) {
        const previous = controller.pass.clock;
        // Actual daUU6L bracket: unused because acquisition crossed one vector.
        ingest(
          "clock",
          [
            1, 2.792000000000001, 1905854484, 31, 488896, 0.792000000000004,
            488896, 1, 2.794666666666667, 1905854548, 31,
          ],
        );
        assert.equal(controller.pass.clock, previous);
      } else ingest("clock", clock(end + 64));
      if (envelopeFirst) ingest("envelope", envelope(index, silent));
      while (cursor < spectra.length && spectra[cursor][0] <= end) {
        const v = [...spectra[cursor++]];
        if (silent) v[1] = v[2] = 0;
        ingest("spectrum", v);
      }
      if (!envelopeFirst) ingest("envelope", envelope(index, silent));
      if (index === tornWindow) {
        assert.equal(controller.engine.pass.points.length, index - 1);
        assert.equal(controller.pass.envelopes.length, 1);
        ingest("clock", clock(end + 128));
        assert.equal(controller.engine.pass.points.length, index);
        assert.equal(controller.pass.envelopes.length, 0);
      }
      assert(
        controller.pass,
        `window ${index}: ${JSON.stringify(events.at(-1))}`,
      );
    }
  };
  const post = () => {
    for (let index = 0; index < 32; index++)
      ingest("clock", clock(origin + 96000 + 128 + index * 64));
  };
  const start = async () => {
    prepare();
    const pending = controller.arm(owner);
    preflight();
    ack();
    await pending;
    launch();
  };
  return {
    controller,
    sent,
    events,
    observed,
    order,
    armed,
    prepare,
    ingest,
    metadata,
    epoch,
    preflight,
    ack,
    clock,
    envelope,
    launch,
    capture,
    post,
    start,
    time: (value) => {
      now = value;
    },
  };
}

test("module absence is a regression: real engine composition is required, with bounded immutable eligibility only", () => {
  const f = fixture();
  assert(f.controller.engine instanceof AudioListenerEngine);
  const input = { ...command, settings: { attackThresholdDb: 7 } };
  assert.deepEqual(f.controller.prepare(input), {
    status: "ready",
    scope: "arrangement-beat0-120bpm-48000hz-vector64/v1",
  });
  input.settings.attackThresholdDb = 120;
  assert.equal(f.controller.pass.command.settings.attackThresholdDb, 7);
  assert(Object.isFrozen(f.controller.pass.command.settings));
  assert.equal(f.controller.engine.pass, null);
  assert.deepEqual(f.sent, []);
  assert.throws(() => f.prepare(), /listener_busy/);
  for (const change of [
    { mode: "session" },
    { startBeat: 1 },
    { endBeat: 20.2 },
    { endBeat: 0.1 },
    { durationMs: 1999 },
    { durationMs: 10001 },
    { maxWindows: 19 },
    { maxWindows: 101 },
    { settings: { rawAudio: [] } },
    { settings: 1 },
    { settings: [] },
    { traceId: "" },
    { causationId: "api_key=secret" },
    { launchToleranceBeats: 0.1 },
  ])
    assert.throws(() => fixture().prepare(change), /native/);
});

for (const silent of [false, true])
  for (const envelopeFirst of [false, true])
    test(`actual engine + assembler complete ${silent ? "silent" : "recorded nonzero"} descriptors (${envelopeFirst ? "envelope" : "FFT"} first), independently verified App proof`, async () => {
      const f = fixture();
      f.prepare();
      f.time(150);
      const pending = f.controller.arm(owner);
      f.preflight([], 41);
      assert.equal(f.controller.pass.nativeEpoch, 42);
      assert.equal(f.controller.engine.state, "native-arming");
      assert.deepEqual(f.events, []);
      f.time(210);
      f.ack();
      assert.equal((await pending).status, "ready");
      assert.equal(f.order[0], "armed");
      f.launch();
      assert(f.controller.pass.assembler instanceof NativeDescriptorAssembler);
      f.capture(silent, envelopeFirst);
      const retained = f.controller.pass;
      assert.equal(retained.assembler.state, "covered");
      assert.equal(retained.assembler.pending.length, 0);
      assert.equal(retained.assembler.spectra.length, 0);
      assert.equal(
        f.events.some((event) => event.type === "terminal"),
        false,
      );
      f.post();
      const terminal = f.events.at(-1);
      assert.equal(terminal.status, "complete");
      assert.equal(terminal.observation.samples.length, 20);
      assert.equal(terminal.nativeCapture.spectralWindows.length, 20);
      assert.equal(terminal.nativeCapture.after.frames.length, 32);
      const schemas =
        await import("../../packages/protocol/src/native-listening-schemas.ts");
      const proof = schemas.nativeCaptureProofSchema.parse(
        terminal.nativeCapture,
      );
      schemas.assertNativeCaptureObservation(proof, terminal.observation);
      const launch = f.events.find((event) => event.nativeLaunch);
      assert.deepEqual(launch.nativeLaunch, proof.launched);
      if (silent) {
        assert.deepEqual(terminal.observation.summaries.rmsDbfs, [null, null]);
        assert.equal(terminal.observation.summaries.centroidHz, null);
      } else
        assert(terminal.observation.samples.some((point) => point.centroidHz));
      assert.equal(f.controller.pass, null);
      assert.equal(f.controller.engine.pass, null);
      assert.equal(retained.frames.length, 0);
      assert.equal(retained.post.length, 0);
      assert.equal(retained.assembler.intervals.length, 0);
      assert.equal(f.sent.at(-1).action, "stop");
      assert(
        f.sent.every((packet) =>
          ["begin", "arm", "stop"].includes(packet.action),
        ),
      );
      const pre = f.observed.filter((event) => event.stage !== "progress");
      assert.deepEqual(
        pre.map((event) => event.stage),
        ["queued", "started", "completed"],
      );
      assert.equal(pre[0].causationId, command.causationId);
      for (let index = 1; index < pre.length; index++)
        assert.equal(pre[index].causationId, pre[index - 1].eventId);
      const stages = f.events.filter(
        (event) => event.type === "native-capture-stage",
      );
      assert.equal(stages[0].causationId, pre.at(-1).eventId);
      for (let index = 1; index < stages.length; index++)
        assert.equal(stages[index].causationId, stages[index - 1].eventId);
      for (const stage of [...pre, ...stages]) {
        assert.match(stage.eventId, uuid);
        assert.equal(stage.traceId, command.traceId);
        assert.equal(stage.correlationId, command.correlationId);
        assert(stage.elapsedMs >= 0 && stage.elapsedMs <= 120000);
      }
      assert.equal(
        stages.find((stage) => stage.reason === "native_arm_acknowledged")
          .elapsedMs,
        60,
      );
    });

test("the actual shared wire client publishes armed before buffered lifecycle/results", async () => {
  const frames = [];
  class Client extends AgentSignalClient {
    writeMessage(message) {
      frames.push(message);
      return true;
    }
  }
  const client = new Client({
    signalKind: "audio",
    schemaVersion: "audio-observation/v1",
    producerIdPrefix: "ableton-audio-listener",
    displayName: "Audio-Listener",
    listener: {
      version: 1,
      connectionEpoch: owner.connectionEpoch,
      capabilities: ["audio-listener/v1"],
      sampleRate: 48000,
      algorithmVersion: "1.0.1",
    },
  });
  client.authenticated = true;
  client.socket = { destroyed: false };
  const wire = {
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 1,
    requestId: "request",
    connectionEpoch: owner.connectionEpoch,
    jobId: "job",
    passId: owner.passId,
    traceId: command.traceId,
    correlationId: command.correlationId,
    causationId: command.causationId,
    action: "arm",
  };
  const f = fixture({
    onArmed: (nativeArm) =>
      client.sendListenerReply(wire, { status: "armed", nativeArm }),
  });
  f.prepare();
  const pending = f.controller.arm(owner);
  f.preflight();
  f.ack();
  await pending;
  assert.equal(frames[0].status, "armed");
  const { listenerReplySchema } =
    await import("../../packages/signal-routing/src/listener-contracts.ts");
  assert.equal(listenerReplySchema.parse(frames[0]).nativeArm.nativeEpoch, 1);
  assert.equal(f.order[0], "armed");
  f.controller.cancel(owner);
});

test("every missing metadata/ABI source or baseline fails bounded preflight and settles without listener results", async () => {
  for (const missing of [
    "dsp",
    "tempo",
    "fftInfo",
    "abi-clock",
    "abi-envelope",
    "abi-spectrum",
    "envelope",
    "spectrum",
  ]) {
    const f = fixture();
    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight([missing]);
    assert.equal(f.controller.engine.pass, null);
    f.time(2000);
    f.controller.tick();
    await assert.rejects(pending, /native_preflight_timeout/);
    assert.equal(f.controller.pass, null);
    assert.deepEqual(f.events, []);
    assert.equal(f.sent.at(-1).action, "stop");
    assert.equal(f.observed.at(-1).stage, "failed");
    assert.equal(f.observed.at(-1).elapsedMs, 2000);
  }
});

test("preflight waits for overlapping streams in either order, rolls exactly 32 rows, rejects no temporarily future baseline", async () => {
  for (const future of [false, true]) {
    const f = fixture();
    f.prepare();
    const pending = f.controller.arm(owner);
    f.metadata();
    f.epoch();
    const spectrum = [...before.spectrum];
    if (future) {
      spectrum[0] += 2048;
      spectrum[3] += 2048;
      spectrum[4] += 2048;
      f.ingest("spectrum", spectrum);
    }
    for (const row of before.before.frames) f.ingest("clock", row);
    assert.equal(f.controller.state, "preflight");
    if (future)
      for (let i = 1; i <= 32; i++)
        f.ingest(
          "clock",
          f.clock(before.before.frames.at(-1)[4] + i * 64, false),
        );
    else f.ingest("spectrum", spectrum);
    assert.equal(f.controller.state, "native-arming");
    assert.equal(f.controller.pass.frames.length, 32);
    const arm = future ? armCounter + 2048 : armCounter;
    f.ack({ 13: arm });
    await pending;
    f.controller.cancel(owner);
  }
});

test("stopped torn/held reads are bounded and observable; changed holds and clock discontinuities fail", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  const row = before.before.frames[0];
  const torn = [...row];
  torn[6]++;
  f.ingest("clock", torn);
  f.ingest("clock", row);
  for (let index = 0; index < 500; index++) f.ingest("clock", row);
  assert.equal(f.controller.pass.rejected, 1);
  assert.equal(f.controller.pass.held, 64);
  assert.equal(f.controller.pass.frames.length, 1);
  for (let index = 0; index < 63; index++) f.ingest("clock", torn);
  assert.equal(f.controller.pass.rejected, 64);
  f.ingest("clock", torn);
  await assert.rejects(pending, /rejection_limit/);
  assert.equal(
    f.observed.filter((event) => event.reason === "held_native_clock").length,
    64,
  );
  assert.equal(
    f.observed.filter((event) => event.reason === "torn_native_clock").length,
    64,
  );
  for (const kind of ["hold", "backwards", "gap", "playing"]) {
    const g = fixture();
    g.prepare();
    const task = g.controller.arm(owner);
    g.ingest("clock", row);
    const next = [...(kind === "hold" ? row : before.before.frames[1])];
    if (kind === "hold") next[5] = 0.5;
    if (kind === "backwards") next[4] = next[6] = row[4] - 64;
    if (kind === "gap") {
      next[4] = next[6] = row[4] + 48064;
      next[2] = next[9] = next[4] + offset;
    }
    if (kind === "playing") next[0] = next[7] = 1;
    g.ingest("clock", next);
    await assert.rejects(task, /native/);
    assert.equal(g.controller.pass, null);
  }
});

test("unbound stopped preflight requires 32 fresh exact-offset rows after any candidate restart, then freezes that binding", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.metadata();
  f.epoch();
  f.ingest("spectrum", before.spectrum);
  for (const sample of before.before.frames.slice(0, 4)) {
    const row = [...sample];
    for (const index of [2, 4, 6, 9]) row[index] -= 512;
    f.ingest("clock", row);
  }
  for (const sample of before.before.frames.slice(0, 31)) {
    const row = [...sample];
    row[2] += 64;
    row[9] += 64;
    f.ingest("clock", row);
  }
  assert.equal(f.controller.state, "preflight");
  assert.equal(f.controller.pass.frames.length, 31);
  assert.equal(f.controller.pass.rejected, 1);
  assert.equal(f.armed.length, 0);
  const last = [...before.before.frames[31]];
  last[2] += 64;
  last[9] += 64;
  f.ingest("clock", last);
  assert.equal(f.controller.state, "native-arming");
  f.ack();
  await pending;
  assert.equal(f.armed[0].before.frames.length, 32);
  for (const row of f.armed[0].before.frames)
    assert.equal(row[2] - row[4], offset + 64);
  f.launch();
  assert.equal(f.controller.pass, null);
  assert.equal(f.events.at(-1).reason, "native_clock_discontinuity");
});

test("unbound preflight restart retains quota, deadline and monotonic host-clock guards", async () => {
  for (const ending of ["quota", "timeout", "backwards"]) {
    const f = fixture();
    f.prepare();
    const pending = f.controller.arm(owner);
    for (let index = 0; index < (ending === "quota" ? 66 : 2); index++) {
      const row = [...before.before.frames[0]];
      for (const field of [2, 4, 6, 9]) row[field] += index * 64;
      row[2] += index % 2 ? 64 : 0;
      row[9] = row[2];
      f.ingest("clock", row);
    }
    if (ending === "timeout") {
      f.time(2001);
      f.controller.tick();
    }
    if (ending === "backwards") {
      const row = [...before.before.frames[2]];
      row[2] -= 1024;
      row[9] = row[2];
      f.ingest("clock", row);
    }
    await assert.rejects(pending, /native/);
    assert.equal(f.controller.pass, null);
    assert.equal(f.armed.length, 0);
  }
});

test("exact retained binding and native reset are required; timeout/late ACK cannot arm", async () => {
  for (const patch of [
    { 0: 2 },
    { 1: 0 },
    { 2: 0 },
    { 3: 1 },
    { 4: 1 },
    { 5: 1 },
    { 6: 0 },
    { 7: 0 },
    { 12: 4800 },
    { 13: armCounter - 128 },
    { 13: armCounter + 48000 },
    { 14: 0 },
  ]) {
    const f = fixture();
    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight();
    f.ack(patch);
    await assert.rejects(pending, /native/);
    assert.equal(f.armed.length, 0);
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.preflight();
  const generation = f.controller.pass.generation;
  f.time(1000);
  f.controller.tick();
  await assert.rejects(pending, /native_arm_ack_timeout/);
  assert.equal(f.ingest("envelope", [], generation), false);
  assert.equal(f.controller.pass, null);
});

test("ownership, duplicate arm, generation fencing, reconnect epoch allocation and pending cancellation/reset", async () => {
  const f = fixture();
  f.prepare();
  assert.throws(
    () => f.controller.arm({ ...owner, passId: "foreign" }),
    /owner/,
  );
  const pending = f.controller.arm(owner);
  const oldGeneration = f.controller.pass.generation;
  assert.throws(() => f.controller.arm(owner), /duplicate/);
  assert.throws(
    () => f.controller.cancel({ ...owner, connectionEpoch: "foreign" }),
    /owner/,
  );
  assert.throws(
    () =>
      f.controller.reset("native_disconnect", { ...owner, passId: "foreign" }),
    /owner/,
  );
  assert.equal(f.ingest("dsp", [0, 0, 0], "stale"), false);
  f.controller.cancel(owner);
  await assert.rejects(pending, /cancelled/);
  assert.equal(
    f.ingest("clock", before.before.frames[0], oldGeneration),
    false,
  );
  f.prepare();
  const second = f.controller.arm(owner);
  f.preflight([], 53);
  assert.equal(f.controller.pass.nativeEpoch, 54);
  f.controller.reset("native_disconnect");
  await assert.rejects(second, /native_disconnect/);
  f.prepare();
  const third = f.controller.arm(owner);
  f.preflight([], 1);
  assert.equal(f.controller.pass.nativeEpoch, 55);
  f.ack();
  await third;
  f.launch();
  f.controller.cancel(owner);
  assert.equal(f.events.at(-1).status, "cancelled");
  assert.equal(f.controller.pass, null);
});

test("publication failure or reentrant cancellation never leaks pre-arm progress or resurrects passes", async () => {
  for (const kind of ["false", "throw", "cancel"]) {
    let f;
    f = fixture({
      onArmed: () => {
        if (kind === "throw") throw new Error("arbitrary private text");
        if (kind === "cancel") f.controller.cancel(owner);
        return false;
      },
    });
    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight();
    f.ack();
    await assert.rejects(pending);
    assert.equal(f.controller.pass, null);
    assert.equal(f.controller.engine.pass, null);
    assert.deepEqual(f.events, []);
    assert.equal(f.sent.at(-1).action, "stop");
    assert(!JSON.stringify(f.observed).includes("private text"));
  }
});

test("scheduler playing never launches; native marker arriving before host waits without resetting", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.preflight();
  f.ack();
  await pending;
  f.ingest("envelope", f.envelope());
  assert.equal(f.controller.state, "armed");
  assert.equal(
    f.events.some((event) => event.nativeLaunch),
    false,
  );
  f.ingest("clock", f.clock(origin + 640));
  assert.equal(f.controller.state, "capturing");
  assert.equal(f.sent.filter((packet) => packet.action === "arm").length, 1);
  f.controller.reset();
  const g = fixture();
  await g.start();
  g.controller.reset();
  assert.equal(g.controller.pass, null);
  assert.equal(g.events.at(-1).status, "cancelled");
});

test("post coverage requires 32 fresh playing rows; no post rows times out with cleanup", async () => {
  const f = fixture();
  await f.start();
  f.capture();
  const retained = f.controller.pass;
  for (let index = 0; index < 31; index++)
    f.ingest("clock", f.clock(origin + 96000 + 128 + index * 64));
  assert.equal(f.controller.pass.post.length, 31);
  assert.equal(
    f.events.some((event) => event.type === "terminal"),
    false,
  );
  f.time(4000);
  f.controller.tick();
  assert.equal(f.events.at(-1).status, "partial");
  assert.equal(f.events.at(-1).reason, "native_capture_timeout");
  assert.equal(retained.assembler.intervals.length, 0);
  assert.equal(f.controller.pass, null);
});

test("invalid changes, torn active FFT, changed holds, envelope gaps, and malformed/raw IO fail and clear", async () => {
  for (const kind of [
    "invalid",
    "torn",
    "hold",
    "gap",
    "clock",
    "raw",
    "sparse",
    "metadata",
    "fft-gap",
    "envelope-hold",
    "origin",
    "source",
  ]) {
    const f = fixture();
    await f.start();
    const retained = f.controller.pass;
    if (["invalid", "torn", "hold"].includes(kind)) {
      const spectrum = [...recorded.spectrum.frames[0]];
      f.ingest("spectrum", spectrum);
      if (kind === "invalid") spectrum[5]++;
      if (kind === "torn") spectrum[4]++;
      if (kind === "hold") spectrum[2] = 1;
      f.ingest("spectrum", spectrum);
    } else if (kind === "fft-gap") {
      const first = recorded.spectrum.frames.find(
        (packet) => packet[0] > before.spectrum[0],
      );
      f.ingest("spectrum", first);
      const next = [...first];
      next[0] += 4096;
      next[3] += 4096;
      next[4] += 4096;
      f.ingest("spectrum", next);
    } else if (kind === "envelope-hold") {
      f.ingest("clock", f.clock(origin + 4864));
      const envelope = f.envelope(1);
      f.ingest("envelope", envelope);
      envelope[8] = 0.1;
      f.ingest("envelope", envelope);
    } else if (kind === "origin" || kind === "source") {
      const envelope = f.envelope();
      if (kind === "origin") envelope[14]++;
      else envelope[7] = 0;
      f.ingest("envelope", envelope);
    } else if (kind === "gap") {
      f.ingest("clock", f.clock(origin + 9664));
      f.ingest("envelope", f.envelope(2));
    } else if (kind === "clock") {
      const row = f.clock(origin + 700);
      row[6] = -1;
      f.ingest("clock", row);
    } else if (kind === "raw") {
      f.controller.ingest({
        generation: retained.generation,
        type: "spectrum",
        values: recorded.spectrum.frames[0],
        rawAudio: [0],
      });
    } else if (kind === "sparse") f.ingest("spectrum", new Array(6));
    else f.ingest("tempo", [121]);
    assert.equal(f.controller.pass, null, kind);
    assert.equal(f.controller.engine.pass, null, kind);
    assert.equal(f.events.at(-1).status, "failed", kind);
    assert.equal(retained.assembler.pending.length, 0);
    assert.equal(retained.assembler.spectra.length, 0);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("throwing send/observer/consumer and reentrant callbacks settle tasks and fence late work", async () => {
  for (const kind of ["send", "observe", "emit", "cancel-begin"]) {
    let f;
    f = fixture({
      send: (packet) => {
        if (kind === "send" && packet.action === "arm")
          throw new Error("secret_credential_token");
        if (kind === "cancel-begin" && packet.action === "begin")
          f.controller.cancel(owner);
        return true;
      },
      observe: () => {
        if (kind === "observe") throw new Error("secret_credential_token");
      },
      emit: () => {
        if (kind === "emit") throw new Error("secret_credential_token");
      },
    });
    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight();
    if (kind === "emit") f.ack();
    if (kind === "emit") await pending;
    else await assert.rejects(pending);
    assert.equal(f.controller.pass, null);
    assert.equal(f.controller.engine.pass, null);
    assert.equal(f.sent.at(-1).action, "stop");
    assert(!JSON.stringify(f.observed).includes("secret_credential_token"));
  }
});

test("transport changing before ACK rejects the promise rather than stranding it", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.preflight();
  f.ingest("clock", f.clock(origin + 640));
  await assert.rejects(pending, /native_transport_changed_before_launch/);
  assert.equal(f.controller.pass, null);
  assert.deepEqual(f.events, []);
});

test("bounded assembler queues fail explicitly; no late data or oversized envelope/FFT buffers survive", async () => {
  for (const kind of ["envelope", "spectrum"]) {
    const f = fixture();
    await f.start();
    const retained = f.controller.pass;
    if (kind === "envelope") {
      for (let index = 1; index <= 9; index++) {
        f.ingest("clock", f.clock(origin + index * 4800 + 64));
        f.ingest("envelope", f.envelope(index));
      }
    } else {
      const first = recorded.spectrum.frames.find(
        (packet) => packet[0] > before.spectrum[0],
      );
      // 129 undrained tagged windows exceed the assembler's fixed quota.
      for (let index = 0; index <= 128 && f.controller.pass; index++) {
        const packet = [...first];
        packet[0] += index * 2048;
        packet[3] += index * 2048;
        packet[4] += index * 2048;
        f.ingest("spectrum", packet);
      }
    }
    assert.equal(f.controller.pass, null, kind);
    assert.match(f.events.at(-1).reason, /buffer_overflow/);
    assert.equal(retained.assembler.pending.length, 0);
    assert.equal(retained.assembler.spectra.length, 0);
    assert.equal(
      f.ingest("spectrum", before.spectrum, retained.generation),
      false,
    );
  }
});

test("post evidence cannot wander beyond bounded coverage lag or silently change offset/PPQ", async () => {
  for (const kind of ["lag", "offset", "phase", "stopped"]) {
    const f = fixture();
    await f.start();
    f.capture();
    const row = f.clock(origin + 96000 + (kind === "lag" ? 48001 : 128));
    if (kind === "offset") row[2] = row[9] = row[2] + 1;
    if (kind === "phase") row[1] = row[8] = row[1] + 0.1;
    if (kind === "stopped") row[0] = row[7] = 0;
    f.ingest("clock", row);
    assert.equal(f.controller.pass, null, kind);
    assert.notEqual(f.events.at(-1).status, "complete");
    assert.equal(Object.hasOwn(f.events.at(-1), "nativeCapture"), false);
  }
});

test("reset-ACK held epoch cannot be reused after Node reconnect; allocation exhaustion is bounded failure", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.preflight([], 1000000);
  await assert.rejects(pending, /native_epoch_exhausted/);
  assert.equal(f.controller.pass, null);
  assert.equal(f.sent.filter((packet) => packet.action === "arm").length, 0);
});

test("covered descriptors stay bounded while awaiting postcheck; preparation reservation can expire safely", async () => {
  const f = fixture();
  await f.start();
  f.capture();
  const assembler = f.controller.pass.assembler;
  const held = f.envelope(20);
  for (let index = 0; index < 500; index++) f.ingest("envelope", held);
  assert.equal(assembler.intervals.length, 20);
  assert.equal(assembler.pending.length, 0);
  assert.equal(assembler.spectra.length, 0);
  f.controller.cancel(owner);
  const g = fixture();
  g.prepare();
  g.time(15000);
  g.controller.tick();
  assert.equal(g.controller.pass, null);
  assert.equal(g.observed.at(-1).reason, "native_preparation_timeout");
  assert.deepEqual(g.events, []);
});

test("local/forwarded lifecycle time is bounded even when the owner ticks very late", async () => {
  const f = fixture();
  await f.start();
  f.time(1e9);
  f.controller.tick();
  assert.equal(f.controller.pass, null);
  for (const event of [...f.events, ...f.observed])
    if (event.elapsedMs !== undefined)
      assert(event.elapsedMs >= 0 && event.elapsedMs <= 120000);
});

test("synchronous publication/control callbacks cannot silently return tasks; failed stop is observable and cleaned", async () => {
  for (const kind of ["begin", "arm", "armed", "stop"]) {
    const f = fixture({
      send: (packet) => {
        if (packet.action === kind)
          return kind === "stop" ? false : Promise.resolve(true);
        return true;
      },
      onArmed: () => (kind === "armed" ? Promise.resolve(true) : true),
    });

    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight();
    if (kind === "armed" || kind === "stop") f.ack();
    if (kind === "stop") {
      await pending;
      f.controller.reset();
      assert.equal(f.observed.at(-1).reason, "native_stop_send_failed");
    } else await assert.rejects(pending, /native/);
    assert.equal(f.controller.pass, null);
    assert.equal(f.controller.engine.pass, null);
  }
});

test("Max ioError fails only its owned generation and settles pending arm or cleans active capture", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  const generation = f.controller.pass.generation;
  assert.equal(f.ingest("ioError", [1], "stale-generation"), false);
  assert.equal(f.controller.state, "preflight");
  f.ingest("ioError", [1], generation);
  await assert.rejects(pending, /native_io_packet_failed/);
  assert.deepEqual(f.events, []);
  assert.equal(f.controller.pass, null);
  assert.equal(f.observed.at(-1).reason, "native_io_packet_failed");
  assert.equal(f.sent.at(-1).action, "stop");
  assert.equal(f.ingest("ioError", [1], generation), false);

  const active = fixture();
  await active.start();
  const retained = active.controller.pass;
  active.ingest("ioError", [1]);
  assert.equal(active.events.at(-1).reason, "native_io_packet_failed");
  assert.equal(active.events.at(-1).status, "failed");
  assert.equal(active.controller.pass, null);
  assert.equal(active.controller.engine.pass, null);
  assert.equal(retained.assembler.pending.length, 0);
  assert.equal(retained.assembler.spectra.length, 0);
  assert.equal(active.sent.at(-1).action, "stop");
});

test("generation-scoped unchanged metadata remains cached without refresh notifications, but actual changes fail", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.metadata();
  f.time(1200);
  f.epoch();
  f.ingest("spectrum", before.spectrum);
  for (const row of before.before.frames) f.ingest("clock", row);
  assert.equal(f.controller.state, "native-arming");
  f.ack();
  await pending;
  assert.equal(f.controller.state, "armed");
  f.ingest("dsp", [0, 48000, 64]);
  assert.equal(f.controller.pass, null);
  assert.equal(f.events.at(-1).reason, "native_metadata_changed");
});

test("natural Gen active=0 at 480000 samples covers the exact 100-window range and completes with fresh post binding", async () => {
  const f = fixture();
  f.prepare({ endBeat: 20 });
  const pending = f.controller.arm(owner);
  f.preflight();
  f.ack();
  await pending;
  f.launch();
  let spectralEnd = before.spectrum[0] + 2048;
  for (let index = 1; index <= 100; index++) {
    const end = origin + index * 4800;
    f.ingest("clock", f.clock(end + 64));
    while (spectralEnd <= end) {
      f.ingest("spectrum", [
        spectralEnd,
        0,
        0,
        spectralEnd - 2048,
        spectralEnd,
        353,
      ]);
      spectralEnd += 2048;
    }
    const envelope = f.envelope(index, true);
    if (index === 100) envelope[5] = 0;
    f.ingest("envelope", envelope);
    assert(
      f.controller.pass,
      `window ${index}: ${JSON.stringify(f.events.at(-1))}`,
    );
  }
  assert.equal(f.controller.pass.assembler.state, "covered");
  for (let index = 0; index < 32; index++)
    f.ingest("clock", f.clock(origin + 480000 + 128 + index * 64));
  const result = f.events.at(-1);
  assert.equal(result.status, "complete");
  assert.equal(result.observation.samples.length, 100);
  const schemas =
    await import("../../packages/protocol/src/native-listening-schemas.ts");
  schemas.assertNativeCaptureObservation(
    schemas.nativeCaptureProofSchema.parse(result.nativeCapture),
    result.observation,
  );
});

test("covered short ranges ignore bounded later valid windows including the naturally inactive final hold", async () => {
  const f = fixture();
  await f.start();
  f.capture();
  const assembler = f.controller.pass.assembler;
  for (let index = 21; index <= 100; index++) {
    const envelope = f.envelope(index, true);
    if (index === 100) envelope[5] = 0;
    f.ingest("envelope", envelope);
  }
  assert.equal(f.controller.pass.assembler, assembler);
  assert.equal(assembler.intervals.length, 20);
  assert.equal(assembler.pending.length, 0);
  f.post();
  assert.equal(f.events.at(-1).status, "complete");
  assert.equal(f.events.at(-1).observation.samples.length, 20);
});

test("begin may retain old rejected/completed markers; only the new matching epoch is subject to reset validation", async () => {
  const f = fixture();
  f.prepare();
  const pending = f.controller.arm(owner);
  f.metadata();
  f.ingest("envelope", [
    63,
    576,
    60465,
    8,
    3,
    0,
    64,
    12465,
    0.1,
    0.1,
    0.01,
    0.01,
    480000,
    armCounter - 1000000,
    origin - 1000000,
    1,
  ]);
  f.ingest("spectrum", before.spectrum);
  for (const row of before.before.frames) f.ingest("clock", row);
  assert.equal(f.controller.pass.nativeEpoch, 64);
  f.ack();
  await pending;
  assert.equal(f.controller.state, "armed");
  f.controller.cancel(owner);
});

test("bundled Node 16.6 compatibility: absent Object.hasOwn permits metadata, native ACK and complete actual engine composition", async () => {
  const exported = { exports: {} };
  const compatibleObject = new Proxy(Object, {
    get(target, property) {
      if (property === "hasOwn") return undefined;
      return Reflect.get(target, property);
    },
  });
  assert.equal(compatibleObject.hasOwn, undefined);
  runInNewContext(
    readFileSync(
      require.resolve("./audio_listener_native_controller.js"),
      "utf8",
    ),
    { module: exported, require, Object: compatibleObject },
    { filename: "audio_listener_native_controller.js" },
  );
  const f = fixture({ Controller: exported.exports.NativeCaptureController });
  await f.start();
  f.capture();
  f.post();
  assert.equal(f.events.at(-1).status, "complete");
  assert.equal(f.events.at(-1).nativeCapture.after.frames.length, 32);
  assert.equal(f.controller.pass, null);
  assert.equal(f.controller.engine.pass, null);
  assert.equal(f.sent.at(-1).action, "stop");
});

test("async Max reset delivery tolerates the observed pre-arm held epoch but never publishes/resolves until genuine target ACK", async () => {
  const oldEnvelope = [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 1];
  let f;
  let notify;
  const oldDelivered = new Promise((resolve) => {
    notify = resolve;
  });
  f = fixture({
    send: (control) => {
      if (control.action === "arm")
        Promise.resolve().then(() => {
          f.ingest("envelope", oldEnvelope);
          notify();
        });
      return true;
    },
  });
  f.prepare();
  const pending = f.controller.arm(owner);
  let resolved = false;
  pending.then(
    () => {
      resolved = true;
    },
    () => {},
  );
  f.preflight();
  await oldDelivered;
  assert.equal(f.controller.state, "native-arming");
  assert.equal(resolved, false);
  assert.equal(f.armed.length, 0);
  assert.deepEqual(f.events, []);
  await new Promise((resolve) => setImmediate(resolve));
  f.time(40);
  f.ack();
  assert.equal((await pending).status, "ready");
  assert.equal(f.order[0], "armed");
  f.launch();
  f.capture();
  f.post();
  assert.equal(f.events.at(-1).status, "complete");
});

test("indefinitely old reset snapshots time out without publication; repeated holds have a fixed quota", async () => {
  for (const quota of [false, true]) {
    const f = fixture();
    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight();
    const oldEnvelope = [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 1];
    for (let index = 0; index < (quota ? 65 : 10); index++)
      f.ingest("envelope", oldEnvelope);
    if (!quota) {
      assert.equal(f.controller.state, "native-arming");
      f.time(1000);
      f.controller.tick();
    }
    await assert.rejects(
      pending,
      quota ? /native_arm_ack_hold_limit/ : /native_arm_ack_timeout/,
    );
    assert.equal(f.armed.length, 0);
    assert.deepEqual(f.events, []);
    assert.equal(f.controller.pass, null);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("reset waiting denies unknown/future epochs and denies the old observed epoch after target ACK", async () => {
  for (const epoch of [0, 1, 6, 8]) {
    const f = fixture();
    f.prepare();
    const pending = f.controller.arm(owner);
    f.preflight([], 6);
    f.ack({ 0: epoch });
    if (epoch === 6) {
      assert.equal(f.controller.state, "native-arming");
      f.ack();
      await pending;
      f.ack({ 0: 6 });
      assert.equal(f.events.at(-1).reason, "native_epoch_mismatch");
    } else await assert.rejects(pending, /native_epoch_mismatch/);
    assert.equal(f.controller.pass, null);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("actual torn active bracket is discarded; envelopes await covering coherent clock and full capture/postcheck recovers unchanged", async () => {
  const f = fixture();
  await f.start();
  f.capture(false, true, 14);
  const retained = f.controller.pass;
  assert.equal(retained.rejected, 1);
  assert.equal(retained.assembler.frames, 20);
  assert.equal(retained.envelopes.length, 0);
  const tornPost = f.clock(origin + 96128);
  tornPost[8] += 64 / 24000;
  tornPost[9] += 64;
  f.ingest("clock", tornPost);
  assert.equal(retained.post.length, 0);
  f.post();
  const result = f.events.at(-1);
  assert.equal(result.status, "complete");
  assert.equal(result.observation.algorithm.timingUncertaintySamples, 64);
  assert.equal(
    result.observation.samples[13].sample,
    origin + offset + 14 * 4800,
  );
  assert.equal(result.nativeCapture.after.frames.length, 32);
  const schemas =
    await import("../../packages/protocol/src/native-listening-schemas.ts");
  schemas.assertNativeCaptureObservation(
    schemas.nativeCaptureProofSchema.parse(result.nativeCapture),
    result.observation,
  );
  assert.equal(retained.envelopes.length, 0);
});

test("active torn reads share the fixed rejection budget and never refresh host freshness", async () => {
  for (const stale of [false, true]) {
    const f = fixture();
    await f.start();
    const retained = f.controller.pass;
    const coherent = retained.clock;
    const at = retained.clockAt;
    const torn = f.clock(origin + 1000);
    torn[8] += 64 / 24000;
    torn[9] += 64;
    for (let index = 0; index < (stale ? 1 : 64); index++)
      f.ingest("clock", torn);
    assert.equal(retained.clock, coherent);
    assert.equal(retained.clockAt, at);
    assert.equal(f.controller.state, "capturing");
    if (stale) {
      f.time(1001);
      f.ingest("envelope", f.envelope(1));
      assert.equal(f.controller.engine.pass.points.length, 0);
      f.controller.tick();
      assert.equal(f.events.at(-1).reason, "host_timing_stale");
    } else {
      f.ingest("clock", torn);
      assert.match(f.events.at(-1).reason, /rejection_limit/);
    }
    assert.equal(f.controller.pass, null);
    assert.equal(retained.envelopes.length, 0);
    assert.equal(retained.assembler.pending.length, 0);
    assert.equal(retained.assembler.spectra.length, 0);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("actual stopped armed offset mismatch stays denied without independent playing phase evidence", async () => {
  const f = fixture();
  f.prepare();
  const armed = f.controller.arm(owner);
  f.preflight();
  f.ack();
  await armed;
  assert.equal(f.controller.state, "armed");
  const p = f.controller.pass;
  const observed = hardenedFailure.diagnostic.clock;
  const replay = { ...p, clock: observed.previous };
  assert.throws(
    () => f.controller.clock(replay, observed.row),
    /native_clock_discontinuity/,
  );
  assert.equal(replay.clock, observed.previous);
  assert.equal(replay.rejected, 0);

  const previous = p.clock;
  const at = p.clockAt;
  const shifted = [...previous];
  shifted[2] = shifted[9] = previous[2] + 512;
  shifted[4] = shifted[6] = previous[4] + 448;
  const generation = p.generation;
  f.ingest("clock", shifted);
  assert.equal(f.events.at(-1).reason, "native_clock_discontinuity");
  assert.equal(f.events.at(-1).status, "failed");
  assert.equal(f.controller.pass, null);
  assert.equal(p.clock, null);
  assert.equal(p.clockAt, at);
  assert.equal(p.envelopes.length, 0);
  assert.equal(f.controller.engine.pass, null);
  assert.deepEqual(f.sent.at(-1), { action: "stop", generation });
  assert.equal(
    f.observed.some((event) => event.reason === "phase_torn_native_clock"),
    false,
  );
  assert.equal(
    f.events.some((event) => event.status === "complete"),
    false,
  );
});

test("actual one-vector phase/counter mismatch is bounded acquisition rejection, never a new clock binding", async () => {
  const f = fixture();
  await f.start();
  const p = f.controller.pass;
  const previous = p.clock;
  const at = p.clockAt;
  const observed = phaseMismatch.clock;
  assert.equal(observed.row[2] - observed.row[4], 64);
  assert.equal(observed.previous[2] - observed.previous[4], 0);
  assert.equal(observed.row[4] - observed.previous[4], 896);
  assert.equal(observed.row[2] - observed.previous[2], 960);
  assert.equal(
    (Math.round(observed.row[1] * 24000) -
      Math.round(observed.row[5] * 24000)) %
      24000,
    64,
  );
  const livePass = f.controller.pass;
  const replay = { ...livePass, clock: observed.previous };
  f.controller.clock(replay, observed.row);
  assert.equal(replay.clock, observed.previous);
  assert.equal(replay.rejected, 1);

  const torn = f.clock(origin + 1000);
  torn[1] = torn[8] = torn[1] + 64 / 24000;
  torn[2] = torn[9] = torn[2] + 64;
  f.ingest("clock", torn);
  assert.equal(f.controller.pass, p);
  assert.equal(p.clock, previous);
  assert.equal(p.clockAt, at);
  assert.equal(p.rejected, 1);
  assert.equal(f.observed.at(-1).reason, "phase_torn_native_clock");
  f.capture();
  const tornPost = f.clock(origin + 96128);
  tornPost[1] = tornPost[8] = tornPost[1] + 64 / 24000;
  tornPost[2] = tornPost[9] = tornPost[2] + 64;
  f.ingest("clock", tornPost);
  assert.equal(p.post.length, 0);
  f.post();
  const result = f.events.at(-1);
  assert.equal(result.status, "complete");
  assert.equal(result.nativeCapture.after.frames.length, 32);
  const schemas =
    await import("../../packages/protocol/src/native-listening-schemas.ts");
  schemas.assertNativeCaptureObservation(
    schemas.nativeCaptureProofSchema.parse(result.nativeCapture),
    result.observation,
  );
});

test("phase-torn acquisition keeps quota, freshness, cancellation and exact offset guards", async () => {
  for (const ending of ["quota", "stale", "cancel", "offset"]) {
    const f = fixture();
    await f.start();
    const p = f.controller.pass;
    const clock = p.clock;
    const at = p.clockAt;
    const torn = f.clock(origin + 1000);
    torn[1] = torn[8] = torn[1] + 64 / 24000;
    torn[2] = torn[9] = torn[2] + 64;
    for (let index = 0; index < (ending === "quota" ? 64 : 1); index++)
      f.ingest("clock", torn);
    assert.equal(p.clock, clock);
    assert.equal(p.clockAt, at);
    if (ending === "quota") f.ingest("clock", torn);
    if (ending === "stale") {
      f.time(1001);
      f.controller.tick();
    }
    if (ending === "cancel") f.controller.cancel(owner);
    if (ending === "offset") {
      const changed = f.clock(origin + 1200);
      changed[2] = changed[9] = changed[2] + 64;
      f.ingest("clock", changed);
    }
    assert.equal(f.controller.pass, null, ending);
    assert.notEqual(f.events.at(-1).status, "complete", ending);
    assert.equal(p.envelopes.length, 0);
    assert.equal(p.assembler.pending.length, 0);
    assert.equal(f.sent.at(-1).action, "stop");
    if (ending === "offset")
      assert.equal(f.events.at(-1).reason, "native_clock_discontinuity");
    f.ingest("clock", torn);
    assert.equal(f.controller.pass, null);
  }
});

test("phase-torn classification never covers regressions, long gaps, changed holds or different mismatches", async () => {
  for (const kind of [
    "regression",
    "gap",
    "hold",
    "phase",
    "offset",
    "onset",
  ]) {
    const f = fixture();
    await f.start();
    const previous = f.controller.pass.clock;
    const counter =
      kind === "regression"
        ? previous[4] - 64
        : kind === "gap"
          ? previous[4] + 48064
          : kind === "hold"
            ? previous[4]
            : origin + 1000;
    const row = f.clock(counter);
    row[1] = row[8] = row[1] + (kind === "phase" ? 128 : 64) / 24000;
    row[2] = row[9] = row[2] + (kind === "offset" ? 128 : 64);
    if (kind === "onset") f.controller.state = "armed";
    f.ingest("clock", row);
    assert.equal(f.controller.pass, null, kind);
    assert.notEqual(f.events.at(-1).status, "complete", kind);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("observed held-to-next FFT boundary is discarded without accepting data or losing required sequential coverage", async () => {
  const f = fixture();
  await f.start();
  const p = f.controller.pass;
  const observed = spectrumMismatch.spectrum;
  const replay = { ...p, spectrum: observed.previous };
  f.controller.spectrum(replay, observed.row);
  assert.equal(replay.spectrum, observed.previous);
  assert.equal(replay.rejected, 1);
  const previous = p.spectrum;
  const at = p.spectrumAt;
  const torn = [
    previous[0],
    previous[1],
    previous[2],
    previous[0],
    previous[0] + 2048,
    previous[5],
  ];
  f.ingest("spectrum", torn);
  assert.equal(p.spectrum, previous);
  assert.equal(p.spectrumAt, at);
  assert.equal(p.rejected, 1);
  f.capture();
  f.post();
  const result = f.events.at(-1);
  assert.equal(result.status, "complete");
  const schemas =
    await import("../../packages/protocol/src/native-listening-schemas.ts");
  schemas.assertNativeCaptureObservation(
    schemas.nativeCaptureProofSchema.parse(result.nativeCapture),
    result.observation,
  );
});

test("FFT acquisition rejection shares the fixed quota and never accepts missing or arbitrary torn frames", async () => {
  for (const ending of ["quota", "gap", "arbitrary", "cancel"]) {
    const f = fixture();
    await f.start();
    const p = f.controller.pass;
    const previous = p.spectrum;
    const torn = [
      previous[0],
      previous[1],
      previous[2],
      previous[0],
      previous[0] + 2048,
      previous[5],
    ];
    for (let index = 0; index < (ending === "quota" ? 64 : 1); index++)
      f.ingest("spectrum", torn);
    assert.equal(p.spectrum, previous);
    if (ending === "quota") f.ingest("spectrum", torn);
    if (ending === "gap")
      f.ingest("spectrum", [
        previous[0] + 4096,
        previous[1],
        previous[2],
        previous[0] + 2048,
        previous[0] + 4096,
        previous[5],
      ]);
    if (ending === "arbitrary")
      f.ingest("spectrum", [
        torn[0],
        torn[1],
        torn[2],
        torn[3],
        torn[4] + 1,
        torn[5],
      ]);
    if (ending === "cancel") f.controller.cancel(owner);
    assert.equal(f.controller.pass, null, ending);
    assert.notEqual(f.events.at(-1).status, "complete");
    assert.equal(p.assembler.spectra.length, 0);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("ahead-of-host envelopes wait for fresh coherent coverage, with bounded unchanged holds and queue cleanup", async () => {
  const f = fixture();
  await f.start();
  const first = f.envelope(1);
  f.ingest("envelope", first);
  for (let index = 0; index < 500; index++) f.ingest("envelope", first);
  assert.equal(f.controller.pass.envelopes.length, 1);
  for (const packet of recorded.spectrum.frames)
    if (packet[0] > before.spectrum[0] && packet[0] <= origin + 4800)
      f.ingest("spectrum", packet);
  assert.equal(f.controller.engine.pass.points.length, 0);
  const coherent = f.clock(origin + 4864);
  f.ingest("clock", coherent);
  assert.equal(f.controller.engine.pass.points.length, 1);
  assert.equal(f.controller.pass.envelopes.length, 0);
  assert.equal(f.controller.engine.host.sample, coherent[2]);
  f.controller.cancel(owner);

  const stale = fixture();
  await stale.start();
  stale.ingest("clock", stale.clock(origin + 4864));
  for (const packet of recorded.spectrum.frames)
    if (packet[0] > before.spectrum[0] && packet[0] <= origin + 4800)
      stale.ingest("spectrum", packet);
  stale.time(1001);
  stale.ingest("envelope", stale.envelope(1));
  assert.equal(stale.controller.engine.pass.points.length, 0);
  assert.equal(stale.controller.pass.envelopes.length, 1);
  stale.ingest("clock", stale.clock(origin + 4928));
  assert.equal(stale.controller.engine.pass.points.length, 1);
  assert.equal(stale.controller.pass.envelopes.length, 0);
  stale.controller.cancel(owner);

  const overflow = fixture();
  await overflow.start();
  const retained = overflow.controller.pass;
  for (let index = 1; index <= 9; index++)
    overflow.ingest("envelope", overflow.envelope(index));
  assert.equal(overflow.controller.pass, null);
  assert.match(overflow.events.at(-1).reason, /buffer_overflow/);
  assert.equal(retained.envelopes.length, 0);
});

test("torn-read recovery never permits external transport/offset/PPQ mutation, malformed clocks, changed holds or counter restart", async () => {
  for (const kind of [
    "offset",
    "ppq",
    "transport",
    "malformed",
    "hold",
    "restart",
  ]) {
    const f = fixture();
    await f.start();
    const torn = f.clock(origin + 1000);
    torn[8] += 64 / 24000;
    torn[9] += 64;
    f.ingest("clock", torn);
    const row =
      kind === "hold" ? [...f.controller.pass.clock] : f.clock(origin + 1100);
    if (kind === "offset") row[2] = row[9] = row[2] + 1;
    if (kind === "ppq") row[1] = row[8] = row[1] + 0.1;
    if (kind === "transport") row[7] = 0;
    if (kind === "malformed") row[6] = -1;
    if (kind === "hold") row[5] = 0.5;
    if (kind === "restart") row[4] = row[6] = 0;
    f.ingest("clock", row);
    assert.equal(f.controller.pass, null, kind);
    assert.notEqual(f.events.at(-1).status, "complete");
    assert.equal(Object.hasOwn(f.events.at(-1), "nativeCapture"), false);
  }
});
