import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { test } from "node:test";
import { appendFlatnessSmokeGraph } from "./flatness-smoke-source.mjs";

const { createSpectralShapeSmoke } = createRequire(import.meta.url)(
  "./audio_listener_flatness_probe.js",
);
const generation = "a1111111-1111-4111-8111-111111111111";
const control = { generation };
const facts = (event) =>
  Object.fromEntries(event.facts.map(({ field, actual }) => [field, actual]));
function setup(emit = () => true) {
  let time = 0;
  const events = [];
  const controls = [];
  const probe = createSpectralShapeSmoke({
    now: () => time,
    emit: (owner, event) => {
      events.push(event);
      return emit(owner, event);
    },
    sendControl: (...atoms) => controls.push(atoms),
  });
  const receive = (...atoms) => probe.receive([generation, 1, ...atoms]);
  return {
    probe,
    events,
    controls,
    receive,
    advance(ms) {
      time += ms;
    },
    start() {
      probe.start(control, 1, "a2222222-2222-4222-8222-222222222222");
      receive("started", "fluid.spectralshape~", "fluid.spectralshape~");
    },
  };
}

test("rolloff uses the same two analyzers with explicit 95 percent and canonical selection", () => {
  const document = { patcher: { boxes: [], lines: [] } };
  appendFlatnessSmokeGraph(document, "input", "runtime", "guard");
  const sub = document.patcher.boxes.find(
    ({ box }) => box.id === "flatness-smoke",
  ).box;
  const analyzers = sub.patcher.boxes.filter(({ box }) =>
    box.id.startsWith("shape-"),
  );
  assert.equal(analyzers.length, 2);
  for (const { box } of analyzers)
    assert.equal(
      box.text,
      "fluid.spectralshape~ @select spread rolloff flatness @fftsettings 2048 2048 2048 @unit 0 @power 0 @minfreq 0 @maxfreq -1 @rolloffpercent 95",
    );
});

test("rolloff has an independent attributed lifecycle without stealing sibling values", () => {
  const s = setup();
  s.start();
  s.advance(200);
  s.receive("value", 0, 1, 1200, 7200, -30);
  s.receive("value", 1, 1, 2400, 14000, -5);
  assert.equal(s.probe.stop(control), false);
  s.advance(50);
  s.receive("stopped");
  assert.equal(s.probe.stop(control), true);
  assert.deepEqual(s.controls, [
    ["begin", generation, 1],
    ["stop", generation, 1],
  ]);
  for (const [kind, suffix, values] of [
    ["spread", "Hz", [1200, 2400]],
    ["rolloff", "Hz", [7200, 14000]],
    ["flatness", "Db", [-30, -5]],
  ]) {
    const events = s.events.filter((e) => e.metric === `spectral-${kind}`);
    assert.deepEqual(
      events.map((e) => e.stage),
      [
        "queued",
        "started",
        "progress",
        "completed",
        "queued",
        "started",
        "completed",
      ],
    );
    for (const [index, e] of events.entries()) {
      assert.equal(e.frames, 0);
      assert.equal(e.generation, generation);
      assert.equal(e.nativeEpoch, 1);
      assert.equal(
        e.causationId,
        index
          ? events[index - 1].eventId
          : "a2222222-2222-4222-8222-222222222222",
      );
      assert.equal(facts(e)[`${kind}.support`].value, "unqualified");
      assert.equal(facts(e)[`${kind}.valueValidity`].value, "unqualified");
    }
    const last = events.at(-1);
    assert.equal(last.durationMs, 50);
    assert.equal(last.elapsedMs, 250);
    assert.equal(facts(last)[`${kind}.left${suffix}`].value, values[0]);
    assert.equal(facts(last)[`${kind}.right${suffix}`].value, values[1]);
  }
  const rolloff = s.events.find((e) => e.metric === "spectral-rolloff");
  assert.equal(rolloff.facts.length, 19);
  assert.equal(facts(rolloff)["rolloff.rolloffpercent"].value, 95);
});

test("invalid rolloff fails locally and never persists arbitrary rejected strings", () => {
  for (const value of [-1, NaN, Infinity, "token=do-not-retain", null]) {
    const s = setup();
    s.start();
    s.receive("value", 0, 1, 1200, value, -30);
    s.receive("value", 1, 1, 2400, 14000, -5);
    s.probe.stop(control);
    s.receive("stopped");
    assert.equal(
      s.probe.snapshot().rolloff.failure,
      "rolloff_malformed_output",
    );
    assert.equal(s.probe.snapshot().flatness.failure, null);
    assert.equal(s.probe.snapshot().spread.failure, null);
    assert.ok(!JSON.stringify(s.events).includes("do-not-retain"));
    assert.ok(
      !s.events.some(
        (e) => e.reason === "rolloff_smoke_capture" && e.stage === "completed",
      ),
    );
  }
});

test("rolloff zero is not missing output and missing channels cannot succeed", () => {
  for (const channels of [0, 1, 2]) {
    const s = setup();
    s.start();
    for (let channel = 0; channel < channels; channel++)
      s.receive("value", channel, 1, 0, 0, 0);
    s.probe.stop(control);
    s.receive("stopped");
    assert.equal(
      s.probe.snapshot().rolloff.failure,
      channels === 2 ? null : "rolloff_no_output",
    );
  }
});

test("three streams fit the full delivery budget including terminal cleanup", () => {
  const s = setup();
  s.start();
  for (let sequence = 1; sequence <= 400; sequence++) {
    s.advance(100);
    s.receive("value", 0, sequence, 100, 1000, -3);
    s.receive("value", 1, sequence, 200, 2000, -6);
  }
  s.probe.stop(control);
  s.receive("stopped");
  assert.equal(s.events.filter((e) => e.stage === "progress").length, 240);
  assert.equal(s.events.length, 258);
  assert.equal(s.probe.stop(control), true);
  for (const e of s.events)
    assert.ok(Buffer.byteLength(JSON.stringify(e)) <= 8192);
});

test("rolloff cancellation and observer failure never skip physical cleanup", () => {
  for (const cancelled of [false, true]) {
    let rejecting = false;
    const s = setup((_owner, e) => {
      if (rejecting && e.metric === "spectral-rolloff") return false;
      return true;
    });
    s.start();
    if (!cancelled) {
      s.receive("value", 0, 1, 100, 1000, -3);
      s.receive("value", 1, 1, 200, 2000, -6);
    }
    rejecting = true;
    if (cancelled) s.probe.stop(control, true);
    else
      assert.throws(
        () => s.probe.stop(control),
        /rolloff_diagnostic_delivery_failed/,
      );
    assert.deepEqual(s.controls.at(-1), ["stop", generation, 1]);
    if (cancelled) s.receive("stopped");
    else
      assert.throws(
        () => s.receive("stopped"),
        /rolloff_diagnostic_delivery_failed/,
      );
    assert.equal(s.probe.stop(control), true);
    assert.equal(s.probe.snapshot().rolloff.cleanup, "completed");
  }
});
