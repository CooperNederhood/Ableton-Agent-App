import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
import { appendFlatnessSmokeGraph } from "./flatness-smoke-source.mjs";
import { metricRuntimeHarness } from "./metric-runtime-test-helpers.mjs";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.ts";

const { createFlatnessProbe } = createRequire(import.meta.url)(
  "./audio_listener_flatness_probe.js",
);
const generation = "a1111111-1111-4111-8111-111111111111";
const control = { generation };
function setup() {
  let clock = 0;
  const events = [];
  const controls = [];
  const probe = createFlatnessProbe({
    now: () => clock,
    sendControl: (...atoms) => controls.push(atoms),
    emit: (owner, lifecycle) => {
      events.push({ owner, lifecycle });
      return true;
    },
  });
  const receive = (...packet) => probe.receive([generation, 1, ...packet]);
  return {
    probe,
    events,
    controls,
    receive,
    advance: (ms) => {
      clock += ms;
    },
    start() {
      probe.start(control, 1, "a2222222-2222-4222-8222-222222222222");
      receive("started", "fluid.spectralshape~", "fluid.spectralshape~");
    },
  };
}
const facts = (event) =>
  Object.fromEntries(
    event.lifecycle.facts.map((fact) => [fact.field, fact.actual]),
  );

test("smoke retains bounded per-channel deliveries without inventing analysis frames", () => {
  const s = setup();
  s.start();
  s.advance(150);
  s.receive("value", 0, 1, -45.5);
  s.receive("value", 1, 1, -3.25);
  s.receive("value", 0, 2, -45.5);
  assert.equal(s.probe.stop(control), false);
  s.advance(50);
  s.receive("stopped");
  assert.equal(s.probe.stop(control), true);
  assert.equal(
    s.probe.stop({ generation: "next-pass-failed-before-launch" }),
    true,
  );
  assert.deepEqual(s.controls, [
    ["begin", generation, 1],
    ["stop", generation, 1],
  ]);
  assert.deepEqual(s.probe.snapshot().deliveries, [2, 1]);
  const final = s.events.at(-1);
  assert.equal(final.lifecycle.reason, "flatness_smoke_cleanup");
  assert.equal(final.lifecycle.stage, "completed");
  assert.equal(final.lifecycle.durationMs, 50);
  assert.equal(final.lifecycle.elapsedMs, 200);
  assert.equal(facts(final)["flatness.support"].value, "unqualified");
  assert.equal(facts(final)["flatness.valueValidity"].value, "unqualified");
  assert.equal(facts(final)["flatness.leftDb"].value, -45.5);
  assert.equal(facts(final)["flatness.rightDb"].value, -3.25);
  for (const [index, event] of s.events.entries()) {
    assert.equal(event.owner, control);
    assert.equal(event.lifecycle.frames, 0);
    assert.equal(event.lifecycle.metric, "spectral-flatness");
    assert.equal(event.lifecycle.nativeEpoch, 1);
    assert.ok(event.lifecycle.facts.length <= 24);
    assert.equal(
      event.lifecycle.causationId,
      index
        ? s.events[index - 1].lifecycle.eventId
        : "a2222222-2222-4222-8222-222222222222",
    );
    assert.ok(event.lifecycle.durationMs >= 0);
    assert.equal(
      nativeMetricLifecycleSchema.safeParse(event.lifecycle).success,
      true,
    );
  }
});

test("absent output fails locally before capture completion; stop acknowledgement remains mandatory", () => {
  const s = setup();
  s.start();
  assert.equal(s.probe.stop(control), false);
  assert.equal(s.probe.snapshot().failure, "flatness_no_output");
  assert.ok(
    !s.events.some(
      ({ lifecycle: e }) =>
        e.reason === "flatness_smoke_capture" && e.stage === "completed",
    ),
  );
  s.receive("stopped");
  assert.equal(s.probe.snapshot().cleanup, "completed");
});

test("cancellation remains cancelled, not no-output or successful capture", () => {
  const s = setup();
  s.start();
  s.probe.stop(control, true);
  s.receive("stopped");
  assert.ok(s.events.some(({ lifecycle: e }) => e.stage === "cancelled"));
  assert.equal(s.probe.snapshot().failure, null);
});

test("foreign, late, premature and malformed packets cannot become useful output", () => {
  const s = setup();
  assert.throws(() => s.receive("started"), /foreign_or_late/);
  s.probe.start(control, 1, "cause");
  assert.throws(() => s.receive("value", 0, 1, -3), /invalid_packet/);
  s.receive("started", "fluid.spectralshape~", "fluid.spectralshape~");
  assert.throws(
    () => s.probe.receive(["foreign", 1, "value", 0, 1, -3]),
    /foreign_or_late/,
  );
  assert.throws(
    () => s.probe.stop({ generation: "foreign" }),
    /owner_mismatch/,
  );
  s.receive("value", 0, 1, Infinity);
  assert.equal(s.probe.snapshot().failure, "flatness_malformed_output");
  assert.equal(
    facts(s.events.at(-1))["flatness.rejected.db"].value,
    "Infinity",
  );
  s.probe.stop(control);
  s.receive("value", 0, 2, -2);
  s.receive("stopped");
  assert.throws(() => s.receive("value", 0, 1, -3), /foreign_or_late/);
});

test("missing external classes are reported explicitly and still require gate cleanup", () => {
  const s = setup();
  s.probe.start(control, 1, "cause");
  s.receive("started", "jbogus", "fluid.spectralshape~");
  assert.equal(s.probe.snapshot().failure, "flatness_external_unavailable");
  assert.equal(facts(s.events.at(-1))["flatness.leftClass"].value, "jbogus");
  assert.equal(s.probe.stop(control), false);
  s.receive("stopped");
  assert.equal(s.probe.stop(control), true);
});

test("malformed class diagnostics reject without acknowledging capture", () => {
  for (const invalid of ["", "x".repeat(129), null, 1]) {
    const s = setup();
    s.probe.start(control, 1, "cause");
    assert.throws(
      () => s.receive("started", invalid, "fluid.spectralshape~"),
      /flatness_invalid_class/,
    );
    assert.equal(s.events.length, 1);
  }
});

test("only tiny positive floating-point roundoff is normalized at the zero-dB boundary", () => {
  for (const value of [7.62e-13, 1e-9]) {
    const s = setup();
    s.start();
    s.receive("value", 0, 1, value);
    s.receive("value", 1, 1, -12);
    assert.equal(s.probe.snapshot().failure, null);
    assert.equal(facts(s.events.at(-1))["flatness.leftDb"].value, 0);
    assert.equal(facts(s.events.at(-1))["flatness.rightDb"].value, -12);
  }
  const s = setup();
  s.start();
  s.receive("value", 0, 1, 1.001e-9);
  assert.equal(s.probe.snapshot().failure, "flatness_malformed_output");
});

test("progress is bounded and reused ownership cannot leak values across captures", () => {
  const s = setup();
  s.start();
  for (let index = 1; index <= 300; index++) {
    s.advance(100);
    s.receive("value", 0, index, -10);
    s.receive("value", 1, index, -11);
  }
  assert.ok(
    s.events.filter(({ lifecycle: e }) => e.stage === "progress").length <= 60,
  );
  assert.throws(() => s.probe.start(control, 2, "cause"), /still_owned/);
  s.probe.stop(control);
  s.receive("stopped");
  s.probe.start(control, 2, "cause");
  assert.deepEqual(s.probe.snapshot().deliveries, [0, 0]);
  assert.equal(facts(s.events.at(-1))["flatness.leftDb"].state, "unavailable");
});

test("diagnostic delivery errors are surfaced, not successful fallback", () => {
  const probe = createFlatnessProbe({
    now: () => 0,
    sendControl: () => {},
    emit: () => false,
  });

  assert.throws(
    () => probe.start(control, 1, "cause"),
    /diagnostic_delivery_failed/,
  );
});

test("diagnostic rejection cannot prevent the owned gate stop or its acknowledgement", () => {
  let accepting = true;
  const controls = [];
  const probe = createFlatnessProbe({
    now: () => 0,
    sendControl: (...atoms) => controls.push(atoms),
    emit: () => accepting,
  });
  probe.start(control, 1, "cause");
  probe.receive([
    generation,
    1,
    "started",
    "fluid.spectralshape~",
    "fluid.spectralshape~",
  ]);
  accepting = false;
  assert.throws(() => probe.stop(control), /diagnostic_delivery_failed/);
  assert.deepEqual(controls.at(-1), ["stop", generation, 1]);
  assert.equal(probe.snapshot().cleanup, "pending");
  assert.throws(
    () => probe.receive([generation, 1, "stopped"]),
    /diagnostic_delivery_failed/,
  );
  assert.equal(probe.stop(control), true);
  assert.equal(probe.snapshot().diagnosticDeliveryFailed, true);
});

test("classic Max gate parses in the host's ES5 engine", () => {
  const require = createRequire(import.meta.url);
  const { parse } = createRequire(require.resolve("eslint/package.json"))(
    "espree",
  );
  parse(
    readFileSync(
      new URL("./audio_listener_flatness_smoke.js", import.meta.url),
      "utf8",
    ),
    { ecmaVersion: 5 },
  );
});

test("classic Max gate drains only new callbacks, clears state and stops its own task", () => {
  let clock = 0;
  let timer;
  const output = [];
  const context = {
    patcher: {
      getnamed: () => ({ maxclass: "fluid.spectralshape~" }),
    },
    Date: { now: () => clock },
    inlet: 0,
    arrayfromargs: (args) => Array.from(args),
    outlet: (_out, packet) => output.push(Array.from(packet)),
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
      new URL("./audio_listener_flatness_smoke.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  context.begin(generation, 1);
  context.inlet = 1;
  context.msg_float(-40);
  timer.callback();
  assert.equal(output.length, 1);
  clock = 200;
  context.msg_float(-40);
  context.inlet = 2;
  context.msg_float(-4);
  timer.callback();
  timer.callback();
  assert.deepEqual(output.slice(1), [
    [generation, 1, "value", 0, 1, -40],
    [generation, 1, "value", 1, 1, -4],
  ]);
  context.stop(generation, 1);
  assert.equal(timer.running, false);
  context.msg_float(-2);
  timer.callback();
  assert.equal(output.at(-1)[2], "stopped");
  context.begin(generation, 2);
  clock = 400;
  timer.callback();
  assert.equal(output.at(-1)[2], "started");
  context.guardstop(generation);
  assert.equal(output.at(-1)[2], "watchdog-stopped");
  assert.equal(timer.running, false);
  context.notifydeleted();
  assert.equal(timer.running, false);
});

test("generated stereo analyzer is a passive tap with explicit configuration and owned control routing", () => {
  const document = { patcher: { boxes: [], lines: [] } };
  appendFlatnessSmokeGraph(document, "input", "runtime", "guard");
  const sub = document.patcher.boxes.find(
    ({ box }) => box.id === "flatness-smoke",
  ).box;
  const shapes = sub.patcher.boxes.filter(({ box }) =>
    box.id.startsWith("shape-"),
  );
  assert.equal(shapes.length, 2);
  assert.deepEqual(document.patcher.project.searchpath, {
    0: {
      bootpath: "./dependencies/flucoma",
      projectrelativepath: "./dependencies/flucoma",
      label: "Bundled FluCoMa",
      recursive: 0,
      enabled: 1,
      includeincollective: 0,
    },
  });
  for (const { box } of shapes)
    assert.match(
      box.text,
      /^fluid\.spectralshape~ @select flatness @fftsettings 2048 2048 2048 @power 0/,
    );
  assert.ok(
    !document.patcher.lines.some(
      ({ patchline }) => patchline.destination[0] === "input",
    ),
  );
  assert.throws(
    () => appendFlatnessSmokeGraph(document, "input", "runtime", "guard"),
    /duplicate/,
  );
});

test("runtime starts diagnostics only after launch and requires owned cleanup", () => {
  const h = metricRuntimeHarness();
  const event = {
    control,
    phase: "launch",
    nativeLifecycle: { stage: "completed", nativeEpoch: 1, eventId: "launch" },
  };
  h.controllerOptions.onEvent(event);
  assert.deepEqual(h.output.at(-1), [
    "flatness_smoke_control",
    "begin",
    generation,
    1,
  ]);
  h.handlers.flatness_smoke(
    generation,
    1,
    "started",
    "fluid.spectralshape~",
    "fluid.spectralshape~",
  );
  h.handlers.flatness_smoke(generation, 1, "value", 0, 1, -10);
  h.handlers.flatness_smoke(generation, 1, "value", 1, 1, -5);
  assert.equal(h.controllerOptions.beforeCleanup(control, false), false);
  h.handlers.flatness_smoke(generation, 1, "stopped");
  assert.equal(h.controllerOptions.beforeCleanup(control, false), true);
  assert.ok(
    h.diagnostics.some(
      ({ payload }) => payload.reason === "flatness_smoke_output",
    ),
  );
});
