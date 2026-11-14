import "./native-protocol-test-loader.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.ts";

const require = createRequire(import.meta.url);
const generation = "a1111111-1111-4111-8111-111111111111";
const cause = "a2222222-2222-4222-8222-222222222222";
const cases = [
  {
    name: "pitch",
    file: "audio_listener_pitch_smoke.js",
    factory: require("./audio_listener_pitch_probe.js").createPitchSmoke,
    maxclass: "fluid.pitch~",
    values: [120, 0.8],
    maxEvents: 96,
  },
  {
    name: "spectral shape",
    file: "audio_listener_flatness_smoke.js",
    factory: require("./audio_listener_flatness_probe.js")
      .createSpectralShapeSmoke,
    maxclass: "fluid.spectralshape~",
    values: [100, 2000, -10],
    maxEvents: 288,
  },
];

function setup(spec, seconds) {
  let time = 0;
  let timer;
  let probe;
  const events = [];
  const control = {
    generation,
    config: {
      scope: "arrangement-continuous-metric-stream/v1",
      geometry: { totalSamples: seconds * 48_000, sampleRate: 48_000 },
    },
  };
  const context = {
    Date: { now: () => time },
    inlet: 1,
    arrayfromargs: (args) => Array.from(args),
    outlet: (_, atoms) => probe.receive(Array.from(atoms)),
    patcher: { getnamed: () => ({ maxclass: spec.maxclass }) },
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
    readFileSync(new URL(spec.file, import.meta.url), "utf8"),
    context,
  );
  probe = spec.factory({
    now: () => time,
    sendControl: (selector, ...atoms) => context[selector](...atoms),
    emit: (_, event) => {
      events.push(event);
      return true;
    },
  });
  return {
    control,
    probe,
    context,
    events,
    start: () => probe.start(control, 1, cause),
    publish() {
      time += 100;
      for (let channel = 1; channel <= 2; channel++) {
        context.inlet = channel;
        context.list(...spec.values);
      }
      timer.callback();
    },
    timer: () => timer,
  };
}

for (const spec of cases) {
  for (const seconds of [180, 600]) {
    test(`${spec.name} physical gate and Node observer survive the ${seconds}s continuous pass without lifting diagnostic event bounds`, () => {
      const f = setup(spec, seconds);
      f.start();
      for (let index = 0; index < seconds * 10; index++) f.publish();
      assert.equal(f.probe.stop(f.control), true);
      assert.equal(f.timer().running, false);
      assert(f.events.some((event) => event.stage === "completed"));
      assert(f.events.length <= spec.maxEvents);
      for (const event of f.events) nativeMetricLifecycleSchema.parse(event);
      assert.equal(
        nativeMetricLifecycleSchema.safeParse({
          ...f.events.at(-1),
          elapsedMs: 900001,
        }).success,
        false,
      );
      assert(
        f.events.every((event) =>
          event.facts.some(
            (fact) =>
              fact.field.endsWith(".support") &&
              fact.actual.value === "unqualified",
          ),
        ),
      );
    });
  }
  test(`${spec.name} continuous diagnostics still enforce their finite delivery limit and clean up on cancellation`, () => {
    const f = setup(spec, 180);
    f.start();
    for (let index = 0; index < 2200; index++) f.publish();
    assert.throws(() => f.publish(), /invalid_envelope/);
    f.probe.stop(f.control, true);
    assert.equal(f.timer().running, false);
  });
  test(`${spec.name} rejects diagnostic durations outside the admitted ten-minute scope before opening a gate`, () => {
    const f = setup(spec, 601);
    assert.throws(() => f.start(), /duration/);
    assert.equal(f.timer().running, undefined);
  });
  test(`${spec.name} physical gate rejects unbounded or fractional delivery limits before taking ownership`, () => {
    const f = setup(spec, 180);
    for (const limit of [0, 399, 6401, Infinity, 400.5])
      assert.throws(
        () => f.context.begin(generation, 1, limit),
        /invalid_delivery_limit/,
      );
    assert.equal(f.context.owner, null);
  });
}
