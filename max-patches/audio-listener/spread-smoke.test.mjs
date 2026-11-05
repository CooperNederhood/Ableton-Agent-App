import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { test } from "node:test";
import { metricRuntimeHarness } from "./metric-runtime-test-helpers.mjs";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.ts";

const { createSpectralShapeSmoke } = createRequire(import.meta.url)(
  "./audio_listener_flatness_probe.js",
);
const generation = "a1111111-1111-4111-8111-111111111111";
const control = { generation };
const facts = (event) =>
  Object.fromEntries(event.facts.map(({ field, actual }) => [field, actual]));

test("the pinned reference fixes spread before flatness even when selection spelling is reversed", () => {
  const reference = readFileSync(
    new URL(
      "./dependencies/flucoma/docs/fluid.spectralshape~.maxref.xml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    reference,
    /Reordering the options in this argument will not reorder how the analyses are returned/,
  );
  assert.match(reference, /spectral spread \(2\) in Hertz/);
  assert.match(reference, /flatness \(6\) in dB/);
  for (const selection of ["spread flatness", "flatness spread"]) {
    const s = setup();
    s.start();
    s.receive("value", 0, 1, 1200, -30);
    s.receive("value", 1, 1, 2400, -5);
    const spread = s.events.find(
      ({ event }) => event.reason === "spread_smoke_output",
    ).event;
    const flatness = s.events.find(
      ({ event }) => event.reason === "flatness_smoke_output",
    ).event;
    assert.equal(facts(spread)["spread.leftHz"].value, 1200, selection);
    assert.equal(facts(flatness)["flatness.leftDb"].value, -30, selection);
  }
});

function setup(emit) {
  let clock = 0;
  const events = [];
  const controls = [];
  const probe = createSpectralShapeSmoke({
    now: () => clock,
    emit: (owner, event) => {
      events.push({ owner, event });
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
      clock += ms;
    },
    start() {
      probe.start(control, 1, "a2222222-2222-4222-8222-222222222222");
      receive("started", "fluid.spectralshape~", "fluid.spectralshape~");
    },
  };
}

test("shared producer maps canonical spread/flatness outputs into independent bounded diagnostic chains", () => {
  const s = setup();
  s.start();
  s.advance(200);
  s.receive("value", 0, 1, 1500, -40);
  s.receive("value", 1, 1, 3000, -3);
  assert.equal(s.probe.stop(control), false);
  s.advance(50);
  s.receive("stopped");
  assert.equal(s.probe.stop(control), true);
  assert.deepEqual(s.controls, [
    ["begin", generation, 1],
    ["stop", generation, 1],
  ]);
  for (const [metric, prefix, suffix, values] of [
    ["spectral-spread", "spread", "Hz", [1500, 3000]],
    ["spectral-flatness", "flatness", "Db", [-40, -3]],
  ]) {
    const events = s.events.filter(({ event }) => event.metric === metric);
    const final = events.at(-1).event;
    assert.equal(final.reason, `${prefix}_smoke_cleanup`);
    assert.equal(final.stage, "completed");
    assert.equal(final.durationMs, 50);
    assert.equal(final.elapsedMs, 250);
    assert.equal(facts(final)[`${prefix}.left${suffix}`].value, values[0]);
    assert.equal(facts(final)[`${prefix}.right${suffix}`].value, values[1]);
    for (const [index, { owner, event }] of events.entries()) {
      assert.equal(owner, control);
      assert.equal(event.frames, 0);
      assert.equal(
        event.causationId,
        index
          ? events[index - 1].event.eventId
          : "a2222222-2222-4222-8222-222222222222",
      );
      assert.ok(event.facts.length <= 24);
      assert.equal(nativeMetricLifecycleSchema.safeParse(event).success, true);
    }
  }
  const spread = facts(
    s.events.find(({ event }) => event.metric === "spectral-spread").event,
  );
  for (const [key, value] of Object.entries({
    schema: "flucoma-spread-smoke/v1",
    support: "unqualified",
    valueValidity: "unqualified",
    units: "Hz",
    channelPolicy: "independent-stereo",
    windowSamples: 2048,
    hopSamples: 2048,
    power: 0,
    unit: 0,
    minfreq: 0,
    maxfreq: -1,
  }))
    assert.equal(spread[`spread.${key}`].value, value);
});

test("descriptor-local invalid values preserve the healthy sibling", () => {
  for (const [spread, flatness, failed, healthy] of [
    [-1, -3, "spread", "flatness"],
    [NaN, -3, "spread", "flatness"],
    [Infinity, -3, "spread", "flatness"],
    [0, -321, "flatness", "spread"],
    [10, 0.1, "flatness", "spread"],
  ]) {
    const s = setup();
    s.start();
    s.receive("value", 0, 1, spread, flatness);
    s.receive("value", 1, 1, 200, -2);
    s.receive("value", 0, 2, 100, -1);
    s.probe.stop(control);
    s.receive("stopped");
    assert.ok(
      s.events.some(
        ({ event }) =>
          event.reason === `${failed}_malformed_output` &&
          event.stage === "failed",
      ),
    );
    assert.ok(
      !s.events.some(
        ({ event }) =>
          event.reason === `${failed}_smoke_capture` &&
          event.stage === "completed",
      ),
    );
    assert.ok(
      s.events.some(
        ({ event }) =>
          event.reason === `${healthy}_smoke_capture` &&
          event.stage === "completed",
      ),
    );
    for (const { event } of s.events) {
      assert.ok(event.facts.length <= 24);
      assert.equal(nativeMetricLifecycleSchema.safeParse(event).success, true);
    }
  }
});

test("malformed shared envelopes and sequence gaps are integrity errors, not descriptor-local failures", () => {
  for (const packet of [
    ["value", 0, 1, 1500],
    ["value", 0, 1, 1500, -3, 10],
    ["value", 2, 1, 1500, -3],
    ["value", 0, 0, 1500, -3],
    ["value", 0, 2, 1500, -3],
    ["value", 0, 1.5, 1500, -3],
    ["invalid-width"],
    ["delivery-limit"],
    ["stopped"],
    ["started", "fluid.spectralshape~", "fluid.spectralshape~"],
  ]) {
    const s = setup();
    s.start();
    assert.throws(() => s.receive(...packet), /invalid_envelope/);
    assert.deepEqual(s.probe.snapshot().spread.deliveries, [0, 0]);
    assert.deepEqual(s.probe.snapshot().flatness.deliveries, [0, 0]);
    s.probe.stop(control, true);
    s.receive("stopped");
    assert.equal(s.probe.stop(control), true);
  }
});

test("ownership remains strict before launch, during drain, and after cleanup", () => {
  const s = setup();
  assert.throws(() => s.receive("value", 0, 1, 100, -1), /foreign_or_late/);
  assert.equal(s.probe.stop(control), true);
  assert.deepEqual(s.controls, []);
  s.start();
  assert.throws(() => s.probe.start(control, 2, "cause"), /still_owned/);
  assert.throws(
    () => s.probe.receive(["foreign", 1, "value", 0, 1, 100, -1]),
    /foreign_or_late/,
  );
  assert.throws(
    () => s.probe.receive([generation, 2, "value", 0, 1, 100, -1]),
    /foreign_or_late/,
  );
  assert.throws(
    () => s.probe.stop({ generation: "foreign" }),
    /owner_mismatch/,
  );
  s.receive("value", 0, 1, 100, -1);
  s.probe.stop(control, true);
  s.receive("value", 0, 2, 200, -2);
  assert.throws(() => s.receive("value", 0, 2, 200, -2), /invalid_envelope/);
  assert.throws(() => s.receive("value", 1, 1, 200), /invalid_envelope/);
  assert.deepEqual(s.probe.snapshot().spread.deliveries, [1, 0]);
  s.receive("stopped");
  assert.throws(() => s.receive("value", 0, 3, 100, -1), /foreign_or_late/);
  s.probe.start(control, 2, "cause");
  assert.deepEqual(s.probe.snapshot().spread.deliveries, [0, 0]);
  assert.deepEqual(s.probe.snapshot().flatness.deliveries, [0, 0]);
  assert.equal(
    facts(s.events.at(-1).event)["spread.leftHz"].state,
    "unavailable",
  );
});

test("zero spread is valid but absent channels and unavailable externals cannot complete smoke", () => {
  for (const missing of ["both", "right", "external"]) {
    const s = setup();
    if (missing === "external") {
      s.probe.start(control, 1, "cause");
      s.receive("started", "jbogus", "fluid.spectralshape~");
    } else s.start();
    if (missing === "right") s.receive("value", 0, 1, 0, 7.62e-13);
    s.probe.stop(control);
    s.receive("stopped");
    for (const prefix of ["spread", "flatness"]) {
      assert.equal(
        s.probe.snapshot()[prefix].failure,
        `${prefix}_${missing === "external" ? "external_unavailable" : "no_output"}`,
      );
      assert.ok(
        !s.events.some(
          ({ event }) =>
            event.reason === `${prefix}_smoke_capture` &&
            event.stage === "completed",
        ),
      );
    }
  }
  const s = setup();
  s.start();
  s.receive("value", 0, 1, 0, 7.62e-13);
  s.receive("value", 1, 1, 0, 1e-9);
  s.probe.stop(control);
  s.receive("stopped");
  assert.equal(s.probe.snapshot().spread.failure, null);
  assert.equal(s.probe.snapshot().flatness.failure, null);
});

test("cancellation before a delivery and during pending stop drains the single gate", () => {
  for (const pending of [false, true]) {
    let accepting = true;
    const s = setup(() => accepting);
    s.start();
    if (pending) {
      s.receive("value", 0, 1, 100, -1);
      s.receive("value", 1, 1, 200, -2);
      s.probe.stop(control);
    }
    accepting = false;
    assert.equal(s.probe.stop(control, true), false);
    s.receive("stopped");
    assert.equal(s.probe.stop(control, true), true);
    assert.equal(s.controls.filter(([kind]) => kind === "stop").length, 1);
    for (const prefix of ["flatness", "spread"]) {
      assert.equal(s.probe.snapshot()[prefix].failure, null);
      assert.equal(s.probe.snapshot()[prefix].diagnosticDeliveryFailed, true);
      if (!pending)
        assert.ok(
          s.events.some(
            ({ event }) =>
              event.metric === `spectral-${prefix}` &&
              event.stage === "cancelled",
          ),
        );
    }
  }
});

test("watchdog acknowledgement cleans both probes even when diagnostic emission throws", () => {
  let throwing = false;
  const s = setup(() => {
    if (throwing) throw new Error("observer_failed");
    return true;
  });
  s.start();
  throwing = true;
  assert.throws(() => s.receive("watchdog-stopped"), /observer_failed/);
  assert.equal(s.probe.stop(control), true);
  for (const prefix of ["flatness", "spread"]) {
    assert.equal(s.probe.snapshot()[prefix].cleanup, "completed");
    assert.equal(
      s.probe.snapshot()[prefix].failure,
      `${prefix}_watchdog_stopped`,
    );
  }
  throwing = false;
  s.probe.start(control, 2, "cause");
  assert.deepEqual(s.probe.snapshot().spread.deliveries, [0, 0]);
});

test("throwing either descriptor observer never skips sibling cleanup or shared stop", () => {
  for (const descriptor of ["flatness", "spread"]) {
    for (const stage of ["queued", "started", "progress", "completed"]) {
      let throwing = false;
      const s = setup((_owner, event) => {
        if (
          throwing &&
          event.metric === `spectral-${descriptor}` &&
          event.stage === stage
        )
          throw new Error("observer_failed");
        return true;
      });
      s.start();
      s.receive("value", 0, 1, 100, -1);
      s.receive("value", 1, 1, 200, -2);
      throwing = true;
      if (stage === "progress") {
        s.advance(500);
        assert.throws(
          () => s.receive("value", 0, 2, 300, -3),
          /observer_failed/,
        );
      }
      if (stage === "progress") s.probe.stop(control);
      else assert.throws(() => s.probe.stop(control), /observer_failed/);
      assert.deepEqual(s.controls.at(-1), ["stop", generation, 1]);
      assert.equal(s.probe.snapshot().flatness.cleanup, "pending");
      assert.equal(s.probe.snapshot().spread.cleanup, "pending");
      throwing = false;
      s.receive("stopped");
      assert.equal(s.probe.stop(control), true);
      assert.equal(
        s.probe.snapshot()[descriptor].diagnosticDeliveryFailed,
        true,
      );
    }
  }
});

test("shared output limits cover both descriptor progress chains and never serialize invalid bodies", () => {
  const s = setup();
  s.start();
  for (let sequence = 1; sequence <= 400; sequence++) {
    s.advance(100);
    s.receive("value", 0, sequence, sequence, -3);
    s.receive("value", 1, sequence, sequence * 2, -6);
  }
  const progress = s.events.filter(({ event }) => event.stage === "progress");
  assert.equal(progress.length, 160);
  assert.throws(() => s.receive("value", 0, 401, 100, -1), /invalid_envelope/);
  s.probe.stop(control);
  s.receive("stopped");
  for (const { event } of s.events)
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 8192);
  const invalid = setup();
  invalid.start();
  invalid.receive("value", 0, 1, "secret=do-not-retain", -3);
  assert.ok(!JSON.stringify(invalid.events).includes("do-not-retain"));
  assert.equal(
    facts(invalid.events.at(-1).event)["spread.rejected.hz"].value,
    "string",
  );
});

test("aggregate diagnostic quotas reject before emission without blocking the shared physical stop", () => {
  const oversized = setup();
  assert.throws(
    () => oversized.probe.start(control, 1, "x".repeat(8192)),
    /diagnostic_limit/,
  );
  assert.equal(oversized.events.length, 0);
  assert.deepEqual(oversized.controls, [["begin", generation, 1]]);
  oversized.probe.stop(control, true);
  oversized.receive("stopped");
  assert.equal(oversized.probe.stop(control), true);

  const saturated = setup();
  saturated.start();
  assert.throws(() => {
    for (let sequence = 1; sequence <= 400; sequence++) {
      saturated.advance(1000);
      saturated.receive("value", 0, sequence, 100, -1);
      saturated.receive("value", 1, sequence, 200, -2);
    }
  }, /diagnostic_limit/);
  assert.equal(saturated.events.length, 192);
  assert.throws(() => saturated.probe.stop(control, true), /diagnostic_limit/);
  assert.deepEqual(saturated.controls.at(-1), ["stop", generation, 1]);
  assert.throws(() => saturated.receive("stopped"), /diagnostic_limit/);
  assert.equal(saturated.probe.stop(control), true);
  assert.equal(saturated.events.length, 192);
});

test("runtime preserves native publication on local descriptor failure and invalidates shared corruption", async () => {
  for (const malformed of [false, true]) {
    let disposed = 0;
    const h = metricRuntimeHarness({
      controller: {
        dispose: () => {
          disposed++;
        },
      },
    });
    h.controllerOptions.onEvent({
      control,
      phase: "launch",
      nativeLifecycle: {
        stage: "completed",
        nativeEpoch: 1,
        eventId: "launch",
      },
    });
    h.handlers.flatness_smoke(
      generation,
      1,
      "started",
      "fluid.spectralshape~",
      "fluid.spectralshape~",
    );
    h.handlers.flatness_smoke(
      generation,
      1,
      "value",
      0,
      malformed ? 2 : 1,
      -1,
      -3,
    );
    if (malformed) {
      assert.equal(disposed, 1);
      assert.deepEqual(h.stops, ["client"]);
    } else {
      h.handlers.flatness_smoke(generation, 1, "value", 1, 1, 200, -2);
      assert.equal(disposed, 0);
      assert.deepEqual(h.stops, []);
      assert.equal(
        h.controllerOptions.sendListenerResult(control, { native: "healthy" }),
        true,
      );
      assert.equal(h.controllerOptions.beforeCleanup(control, false), false);
      h.handlers.flatness_smoke(generation, 1, "stopped");
      assert.equal(h.controllerOptions.beforeCleanup(control, false), true);
      assert.ok(
        h.diagnostics.some(
          ({ payload }) =>
            payload.reason === "flatness_smoke_capture" &&
            payload.stage === "completed",
        ),
      );
      assert.ok(
        h.diagnostics.some(
          ({ payload }) => payload.reason === "spread_malformed_output",
        ),
      );
    }
    await h.runtime.stop();
  }
});
