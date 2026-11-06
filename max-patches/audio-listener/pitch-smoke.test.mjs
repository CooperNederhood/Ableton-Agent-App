import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { metricRuntimeHarness } from "./metric-runtime-test-helpers.mjs";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.ts";

const require = createRequire(import.meta.url);
const generation = "a1111111-1111-4111-8111-111111111111";
const cause = "a2222222-2222-4222-8222-222222222222";
const control = { generation };
const facts = (e) =>
  Object.fromEntries(e.facts.map((f) => [f.field, f.actual]));
function setup(emit) {
  const { createPitchSmoke } = require("./audio_listener_pitch_probe.js");
  let time = 0;
  const events = [],
    controls = [];
  const probe = createPitchSmoke({
    now: () => time,
    emit: (owner, event) => {
      events.push(event);
      return emit ? emit(owner, event) : true;
    },
    sendControl: (...atoms) => controls.push(atoms),
  });
  const receive = (...atoms) => probe.receive([generation, 1, ...atoms]);
  return {
    probe,
    events,
    controls,
    receive,
    advance: (ms) => {
      time += ms;
    },
    start() {
      probe.start(control, 1, cause, 20);
      receive("started", "fluid.pitch~", "fluid.pitch~");
    },
  };
}

test("pitch keeps independent ordered pairs, sentinel and exact 24 bounded facts", () => {
  const s = setup();
  s.start();
  assert.deepEqual(facts(s.events[0])["pitch.leftHz"], {
    state: "unavailable",
    reason: "not-reported",
  });
  s.receive("value", 0, 1, 120, 0.1);
  s.receive("value", 1, 1, 240, 1);
  s.receive("value", 0, 2, 0, 0);
  assert.equal(s.probe.stop(control), false);
  s.advance(50);
  s.receive("stopped");
  assert.equal(s.probe.stop(control), true);
  const f = facts(s.events.at(-1));
  assert.equal(f["pitch.leftHz"].value, 0);
  assert.equal(f["pitch.rightHz"].value, 240);
  assert.equal(f["pitch.leftConfidence"].value, 0);
  assert.equal(f["pitch.rightConfidence"].value, 1);
  assert.equal(f["pitch.leftCandidates"].value, 1);
  assert.equal(f["pitch.rightCandidates"].value, 1);
  assert.equal(f["pitch.leftDeliveries"].value, 2);
  assert.equal(f["pitch.cleanup"].value, "completed");
  assert.equal(
    f["pitch.confidenceSemantics"].value,
    "yinfft-score-not-probability",
  );
  for (const [i, e] of s.events.entries()) {
    assert.equal(e.facts.length, 24);
    assert.equal(e.metric, "monophonic-pitch");
    assert.equal(e.frames, 0);
    assert.equal(e.causationId, i ? s.events[i - 1].eventId : cause);
    assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 8192);
    assert.equal(nativeMetricLifecycleSchema.safeParse(e).success, true);
  }
});

test("pitch numerical failures stay local; foreign and malformed envelopes fail closed", () => {
  for (const pair of [
    [NaN, 0.5],
    [Infinity, 0],
    [-999, 0.5],
    [49, 0.5],
    [2001, 0.5],
    [100, -0.01],
    [100, 1.01],
    [100, "private/path"],
  ]) {
    const s = setup();
    s.start();
    s.receive("value", 0, 1, ...pair);
    assert.equal(s.probe.snapshot().failure, "pitch_malformed_output");
    assert.equal(s.probe.stop(control), false);
    s.receive("stopped");
    assert.equal(s.probe.stop(control), true);
    assert.ok(s.events.every((e) => e.facts.length === 24));
    assert.ok(!JSON.stringify(s.events).includes("private/path"));
  }
  for (const packet of [
    ["foreign", 1, "value", 0, 1, 100, 0.2],
    [generation, 2, "value", 0, 1, 100, 0.2],
    [generation, 1, "value", 0, 2, 100, 0.2],
    [generation, 1, "value", 0, 1, 100],
    [generation, 1, "value", 2, 1, 100, 0.2],
  ]) {
    const s = setup();
    s.start();
    assert.throws(() => s.probe.receive(packet), /foreign|envelope/);
  }
});

test("pitch no-output differs from sentinel output; candidates are not a confidence threshold", () => {
  for (const sentinel of [false, true]) {
    const s = setup();
    s.start();
    if (sentinel) for (const ch of [0, 1]) s.receive("value", ch, 1, 0, 0);
    s.probe.stop(control);
    s.receive("stopped");
    assert.equal(
      s.probe.snapshot().failure,
      sentinel ? null : "pitch_no_output",
    );
    assert.equal(facts(s.events.at(-1))["pitch.leftCandidates"].value, 0);
  }
});

test("pitch full gate horizon stays under 96 events and reserves terminal cleanup", () => {
  const s = setup();
  s.start();
  for (let seq = 1; seq <= 400; seq++) {
    s.advance(100);
    s.receive("value", 0, seq, 100, 0);
    s.receive("value", 1, seq, 200, 0);
  }
  s.probe.stop(control);
  s.receive("stopped");
  assert.ok(s.events.length <= 96);
  assert.equal(s.events.at(-1).reason, "pitch_smoke_cleanup");
  assert.equal(facts(s.events.at(-1))["pitch.cleanup"].value, "completed");
  assert.throws(() => s.receive("value", 0, 401, 100, 0), /late/);
});

test("pitch progress quota reserves cleanup even for arbitrarily delayed callbacks", () => {
  const s = setup();
  s.start();
  for (let seq = 1; seq <= 400; seq++) {
    for (const channel of [0, 1]) {
      s.advance(1000);
      s.receive("value", channel, seq, 100, 0.1);
    }
  }
  s.probe.stop(control);
  s.receive("stopped");
  assert.ok(s.events.length <= 96);
  assert.equal(s.events.at(-1).stage, "completed");
  assert.equal(facts(s.events.at(-1))["pitch.cleanup"].value, "completed");
});

test("pitch classic Max gate parses as ES5", () => {
  const { parse } = createRequire(require.resolve("eslint/package.json"))(
    "espree",
  );
  parse(
    readFileSync(
      new URL("./audio_listener_pitch_smoke.js", import.meta.url),
      "utf8",
    ),
    { ecmaVersion: 5 },
  );
});

test("pitch rejection, cancellation and watchdog never skip physical cleanup", () => {
  const s = setup(() => false);
  assert.throws(() => s.probe.start(control, 1, cause), /delivery_failed/);
  assert.deepEqual(s.controls, [["begin", generation, 1]]);
  s.probe.stop(control, true);
  assert.deepEqual(s.controls.at(-1), ["stop", generation, 1]);
  s.receive("stopped");
  assert.equal(s.probe.stop(control, true), true);
  const w = setup();
  w.start();
  w.receive("watchdog-stopped");
  assert.equal(w.probe.snapshot().failure, "pitch_watchdog_stopped");
  assert.equal(w.probe.stop(control), true);
  w.probe.start(control, 2, cause);
});

test("pitch Max gate preserves pair atomicity, 10Hz cap, watchdog and bounded delivery", () => {
  let time = 0,
    timer;
  const output = [];
  const ctx = {
    Date: { now: () => time },
    inlet: 1,
    arrayfromargs: (args) => Array.from(args),
    outlet: (_, atoms) => output.push(Array.from(atoms)),
    patcher: { getnamed: () => ({ maxclass: "fluid.pitch~" }) },
    Task: function (callback) {
      timer = this;
      this.callback = callback;
      this.repeat = () => {
        this.running = true;
      };
      this.cancel = () => {
        this.running = false;
      };
    },
  };
  runInNewContext(
    readFileSync(
      new URL("./audio_listener_pitch_smoke.js", import.meta.url),
      "utf8",
    ),
    ctx,
  );
  ctx.begin(generation, 1);
  assert.equal(timer.interval, 100);
  time = 100;
  ctx.list(100, 0.1);
  ctx.list(110, 0.2);
  ctx.inlet = 2;
  ctx.list(220, 0.3);
  timer.callback();
  assert.deepEqual(output.slice(1), [
    [generation, 1, "value", 0, 1, 110, 0.2],
    [generation, 1, "value", 1, 1, 220, 0.3],
  ]);
  ctx.guardstop(generation);
  assert.equal(timer.running, false);
  ctx.begin(generation, 2);
  time = 200;
  ctx.inlet = 1;
  assert.throws(() => ctx.list(100), /width/);
  for (let i = 0; i < 400; i++) {
    ctx.list(100, 0.5);
    timer.callback();
  }
  ctx.list(100, 0.5);
  assert.throws(() => timer.callback(), /delivery_limit/);
  ctx.stop(generation, 2);
  assert.equal(timer.running, false);
});

test("pitch graph is passive stereo and locks the pinned stock profile", async () => {
  const { appendPitchSmokeGraph } = await import("./pitch-smoke-source.mjs");
  const doc = { patcher: { boxes: [], lines: [] } };
  appendPitchSmokeGraph(doc, "input", "runtime", "guard");
  const sub = doc.patcher.boxes.find((x) => x.box.id === "pitch-smoke").box
    .patcher;
  const analyzers = sub.boxes.filter((x) =>
    x.box.text?.startsWith("fluid.pitch~"),
  );
  assert.equal(analyzers.length, 2);
  for (const { box } of analyzers)
    assert.equal(
      box.text,
      "fluid.pitch~ @algorithm 2 @unit 0 @minfreq 50 @maxfreq 2000 @fftsettings 2048 2048 2048 @select pitch confidence",
    );
  assert.ok(
    !doc.patcher.lines.some((x) => x.patchline.destination[0] === "input"),
  );
  assert.throws(
    () => appendPitchSmokeGraph(doc, "input", "runtime", "guard"),
    /duplicate/,
  );
});

test("runtime pitch numerical failures preserve healthy baseline and spectral evidence", () => {
  let disposed = 0;
  const h = metricRuntimeHarness({
    controller: {
      dispose() {
        disposed++;
      },
    },
  });
  h.controllerOptions.onEvent({
    control,
    phase: "launch",
    nativeLifecycle: { stage: "completed", nativeEpoch: 1, eventId: cause },
  });
  h.handlers.flatness_smoke(
    generation,
    1,
    "started",
    "fluid.spectralshape~",
    "fluid.spectralshape~",
  );
  h.handlers.pitch_smoke(
    generation,
    1,
    "started",
    "fluid.pitch~",
    "fluid.pitch~",
  );
  h.handlers.pitch_smoke(generation, 1, "value", 0, 1, NaN, 0.2);
  for (const channel of [0, 1])
    h.handlers.flatness_smoke(
      generation,
      1,
      "value",
      channel,
      1,
      1500,
      1000,
      -10,
    );
  assert.equal(disposed, 0);
  assert.equal(
    h.controllerOptions.sendListenerResult(control, { native: "healthy" }),
    true,
  );
  assert.equal(h.controllerOptions.beforeCleanup(control, false), false);
  h.handlers.pitch_smoke(generation, 1, "stopped");
  assert.equal(h.controllerOptions.beforeCleanup(control, false), false);
  h.handlers.flatness_smoke(generation, 1, "stopped");
  assert.equal(h.controllerOptions.beforeCleanup(control, false), true);
  assert.equal(disposed, 0);
  assert.ok(
    h.diagnostics.some(
      ({ payload }) => payload.reason === "pitch_malformed_output",
    ),
  );
  assert.ok(
    h.diagnostics.some(
      ({ payload }) =>
        payload.reason === "flatness_smoke_capture" &&
        payload.stage === "completed",
    ),
  );
});

test("both real Max timers stop before asynchronous runtime acknowledgements release ownership", () => {
  const h = metricRuntimeHarness();
  const contexts = {},
    pending = [],
    timers = [];
  for (const [prefix, object] of [
    ["flatness", "fluid.spectralshape~"],
    ["pitch", "fluid.pitch~"],
  ]) {
    const ctx = {
      Date: { now: () => 0 },
      inlet: 1,
      arrayfromargs: (args) => Array.from(args),
      patcher: { getnamed: () => ({ maxclass: object }) },
      outlet: (_, packet) =>
        pending.push(() =>
          h.handlers[`${prefix}_smoke`](...Array.from(packet)),
        ),
      Task: function (callback) {
        timers.push(this);
        this.callback = callback;
        this.repeat = () => {
          this.running = true;
        };
        this.cancel = () => {
          this.running = false;
        };
      },
    };
    runInNewContext(
      readFileSync(
        new URL(`./audio_listener_${prefix}_smoke.js`, import.meta.url),
        "utf8",
      ),
      ctx,
    );
    contexts[`${prefix}_smoke_control`] = ctx;
  }
  const dispatch = () => {
    for (const [selector, method, ...atoms] of h.output.splice(0))
      if (contexts[selector]) contexts[selector][method](...atoms);
  };
  h.controllerOptions.onEvent({
    control,
    phase: "launch",
    nativeLifecycle: { stage: "completed", nativeEpoch: 1, eventId: cause },
  });
  dispatch();
  assert.ok(timers.every((t) => t.running));
  while (pending.length) pending.shift()();
  assert.equal(h.controllerOptions.beforeCleanup(control, true), false);
  dispatch();
  assert.ok(timers.every((t) => !t.running));
  assert.equal(pending.length, 2);
  assert.equal(h.controllerOptions.beforeCleanup(control, true), false);
  pending.shift()();
  assert.equal(h.controllerOptions.beforeCleanup(control, true), false);
  assert.throws(
    () =>
      h.controllerOptions.onEvent({
        control,
        phase: "launch",
        nativeLifecycle: {
          stage: "completed",
          nativeEpoch: 2,
          eventId: cause,
        },
      }),
    /gates_still_owned/,
  );
  assert.equal(h.output.length, 0);
  pending.shift()();
  assert.equal(h.controllerOptions.beforeCleanup(control, true), true);
  h.controllerOptions.onEvent({
    control,
    phase: "launch",
    nativeLifecycle: { stage: "completed", nativeEpoch: 2, eventId: cause },
  });
  dispatch();
  assert.ok(timers.every((t) => t.running));
});

test("runtime joins both asynchronous gate acknowledgements even if one observer throws", () => {
  let reject = false;
  const h = metricRuntimeHarness({
    sendListenerDiagnostic: () => {
      if (reject) throw new Error("observer_failed");
      return true;
    },
  });
  h.controllerOptions.onEvent({
    control,
    phase: "launch",
    nativeLifecycle: { stage: "completed", nativeEpoch: 1, eventId: cause },
  });
  for (const selector of ["flatness_smoke", "pitch_smoke"])
    assert.ok(
      h.output.some((x) => x[0] === `${selector}_control` && x[1] === "begin"),
    );
  h.handlers.flatness_smoke(
    generation,
    1,
    "started",
    "fluid.spectralshape~",
    "fluid.spectralshape~",
  );
  h.handlers.pitch_smoke(
    generation,
    1,
    "started",
    "fluid.pitch~",
    "fluid.pitch~",
  );
  reject = true;
  assert.throws(
    () => h.controllerOptions.beforeCleanup(control, false),
    /observer_failed/,
  );
  for (const selector of ["flatness_smoke", "pitch_smoke"])
    assert.ok(
      h.output.some((x) => x[0] === `${selector}_control` && x[1] === "stop"),
    );
  reject = false;
  h.handlers.flatness_smoke(generation, 1, "stopped");
  assert.equal(h.controllerOptions.beforeCleanup(control, false), false);
  h.handlers.pitch_smoke(generation, 1, "stopped");
  assert.equal(h.controllerOptions.beforeCleanup(control, false), true);
});
