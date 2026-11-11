import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import vm from "node:vm";
import { genModel } from "./gen-model.mjs";
import { retainedMusicalEnvelopeSource } from "./retained-native-source.mjs";
import { DESCRIPTIVE_CLOCK_CODE } from "./host-timing-source.mjs";

const require = createRequire(import.meta.url);
const { createMetricEnvelopeIO } = require("./audio_listener_metric_io.js");
const owner = Object.freeze({
  generation: "generation-1",
  passId: "pass-1",
  connectionEpoch: "connection-1",
  traceId: "trace-1",
  correlationId: "correlation-1",
  causationId: "causation-1",
});

function geometry(rate = 48000, tempo = 137, start = 12.125, end = 13.01) {
  const at = (beat) => Math.round(((beat - start) * rate * 60) / tempo);
  const bounds = [0];
  for (let n = Math.floor(start * 4) + 1; n / 4 < end; n++)
    bounds.push(at(n / 4));
  bounds.push(at(end));
  return {
    sampleRate: rate,
    totalSamples: at(end),
    hopSamples: Math.round(rate / 10),
    tempoBpm: tempo,
    startBeatFraction: start - Math.floor(start),
    captureVector: 64,
    levelConfigurationVersion: 1,
    reportStartBeat: start,
    reportEndBeat: end,
    reportRowCount: bounds.length - 1,
    bounds,
  };
}

function harness(g = geometry(), options = {}) {
  const source = retainedMusicalEnvelopeSource();
  const model = genModel(source.code, 64, g.sampleRate);
  const events = [],
    controls = [],
    records = [];
  let time = 0,
    counter = 2 ** 32,
    output,
    origin;
  const io = createMetricEnvelopeIO({
    now: () => time,
    control(action) {
      controls.push(action);
      assert(Object.isFrozen(action));
      assert.equal(action[0], "envelope");
      model.configure({ [action[1]]: action[2] });
    },
    send: (frame) => events.push(frame),
    onEvent(frame) {
      if (options.onEvent) options.onEvent(frame, io);
    },
    consume(family, record) {
      records.push({ family, record });
      return options.consume ? options.consume(family, record, io) : true;
    },
  });
  function step(phase = 0.618, pcm = [0, 0]) {
    output = model.step(phase, ...pcm, counter++);
    return output;
  }
  function receipts(who = owner) {
    io.metric_configuration_frame(who, output.slice(8, 20), counter - 1);
    io.metric_timing_frame(who, output.slice(0, 8), counter - 1);
  }
  function poll(family) {
    const offset = family === "level" ? 20 : 42;
    io[family === "level" ? "metric_level_frame" : "metric_detector_frame"](
      owner,
      output.slice(offset, offset + 22),
    );
  }
  function begin(epoch = 1, who = owner) {
    io.begin({ owner: who, nativeEpoch: epoch, deadlineMs: time + 100000 });
    for (let n = 0; n < 2048; n++) step();
    receipts(who);
  }
  function configure() {
    const configuration = { ...g };
    delete configuration.bounds;
    return io.configure_metric(owner, configuration);
  }
  function arm(wait = 0) {
    configure();
    io.arm(owner);
    step();
    receipts();
    const armCounter = counter - 1;
    for (let n = 0; n < wait; n++) step();
    receipts();
    origin = armCounter + wait + 128;
    return armCounter;
  }
  function run({ skip = [], mutate } = {}) {
    for (
      let sample = -127;
      sample <= g.totalSamples + g.captureVector + 3;
      sample++
    ) {
      const phase =
        sample < g.captureVector
          ? 0.618
          : (g.reportStartBeat + (sample * g.tempoBpm) / (g.sampleRate * 60)) %
            1;
      step(
        phase,
        sample >= 0 && sample < g.totalSamples ? pcm(sample) : [0, 0],
      );
      if (sample % 16 === 0) {
        receipts();
        if (mutate) mutate(output, sample);
        for (const family of ["level", "detector-level"])
          if (!skip.includes(family)) poll(family);
      }
    }
    for (let i = 0; i < 10; i++) {
      step(0.7);
      receipts();
      for (const family of ["level", "detector-level"])
        if (!skip.includes(family)) poll(family);
    }
  }
  function cleanup() {
    io.stop(owner);
    assert.equal(io.snapshot().cleanup, "started");
    step();
    receipts();
    assert.equal(io.snapshot().cleanup, "completed");
  }
  return {
    io,
    model,
    records,
    events,
    controls,
    step,
    receipts,
    poll,
    begin,
    configure,
    arm,
    run,
    cleanup,
    g,
    get output() {
      return output;
    },
    get origin() {
      return origin;
    },
    get counter() {
      return counter - 1;
    },
    setTime(value) {
      time = value;
    },
  };
}
function pcm(sample) {
  return [sample % 7 === 0 ? -0.5 : 0.125, sample % 11 === 0 ? 0.75 : -0.25];
}
function reference(bounds) {
  return bounds.slice(1).map((end, i) => {
    const start = bounds[i];
    let left = 0,
      right = 0,
      peakL = 0,
      peakR = 0;
    for (let n = start; n < end; n++) {
      const [l, r] = pcm(n);
      left += l * l;
      right += r * r;
      peakL = Math.max(peakL, Math.abs(l));
      peakR = Math.max(peakR, Math.abs(r));
    }
    return { start, end, left, right, peakL, peakR };
  });
}

function classicCleanupHarness({
  failAfterPrefix = false,
  missing = false,
  autoStart = true,
  transformFrame,
  onPacket,
} = {}) {
  const g = geometry();
  const model = genModel(
    retainedMusicalEnvelopeSource().code,
    64,
    g.sampleRate,
  );
  const clock = genModel(DESCRIPTIVE_CLOCK_CODE, 8, g.sampleRate);
  const prefix = Object.values(owner);
  const frames = [],
    controls = [];
  let context,
    output,
    counter = 0,
    time = 0,
    sharedFailure = null;
  function message(selector, ...args) {
    context.messagename = selector;
    return context.anything(...args);
  }
  function step(phase = 0.618, left = 0, right = 0) {
    counter = clock.step()[1];
    output = model.step(phase, left, right, counter);
  }
  function readbacks() {
    for (const [selector, first, width] of [
      ["metric_configuration_sample", 8, 12],
      ["metric_timing_sample", 0, 8],
      ["metric_level_sample", 20, 22],
      ["metric_detector_sample", 42, 22],
    ]) {
      const row = output.slice(first, first + width);
      if (
        sharedFailure === "configuration" &&
        selector === "metric_configuration_sample"
      )
        row[1]++;
      if (sharedFailure === "clock" && selector === "metric_timing_sample")
        row[5]++;
      if (width === 22 && missing) message(selector);
      else {
        if (width === 22 && failAfterPrefix && row[4] >= 2) row[16] = -1;
        const values = [counter, ...row, counter];
        if (transformFrame) transformFrame(selector, values);
        message(selector, ...values);
      }
    }
  }
  context = vm.createContext({
    jsarguments: ["audio_listener_metric_io.js", "musical-v1"],
    Date: class extends Date {
      getTime() {
        return time;
      }
    },
    arrayfromargs: (args) => Array.from(args),
    include(name) {
      assert.equal(name, "audio_listener_measurements.js");
      vm.runInContext(
        readFileSync(new URL(name, import.meta.url), "utf8"),
        context,
      );
    },
    outlet(index, values) {
      const list = Array.from(values);
      if (index === 0) {
        const packet = { selector: list[0], payload: JSON.parse(list[1]) };
        if (onPacket) onPacket(packet);
        frames.push(packet);
      }
      if (index === 1) {
        controls.push(list);
        if (list[0] !== "poll") model.configure({ [list[0]]: list[1] });
      }
      if (index === 2 && list[0] === "poll_frames") readbacks();
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("audio_listener_metric_io.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  for (let n = 0; n < 2048; n++) step();
  if (autoStart) {
    message("begin", ...prefix, 1, 100000);
    message("metric_poll");
    message("configure_metric", ...prefix, ...Object.values(g).slice(0, -1));
    message("arm", ...prefix);
    step();
    message("metric_poll");
  }
  function snapshot() {
    message("metric_status", ...prefix);
    assert.equal(frames.at(-1).selector, "native_metric_status");
    return frames.at(-1).payload;
  }
  let nextSample = -127;
  function until(predicate) {
    for (; nextSample <= g.totalSamples + g.captureVector + 64;) {
      const sample = nextSample++;
      const phase =
        sample < g.captureVector
          ? 0.618
          : (g.reportStartBeat + (sample * g.tempoBpm) / (g.sampleRate * 60)) %
            1;
      step(phase, sample >= 0 ? 0.25 : 0, sample >= 0 ? -0.5 : 0);
      if (sample % 16 === 0) {
        message("metric_poll");
        if (predicate(snapshot())) return sample;
      }
    }
    assert.fail(
      "controlled capture did not reach expected prefix/family health",
    );
  }
  function record(family, sequence = 1) {
    message("metric_record", ...prefix, family, sequence);
    assert.equal(frames.at(-1).selector, "native_metric_record");
    return frames.at(-1).payload.record;
  }
  function cleanStop() {
    message("stop", ...prefix);
    message("metric_poll");
    assert.equal(snapshot().cleanup, "started");
    step();
    message("metric_poll");
    assert.equal(snapshot().cleanup, "completed");
  }
  return {
    frames,
    controls,
    prefix,
    g,
    message,
    step,
    snapshot,
    until,
    record,
    prefixRecord(family, sequence = 1, controlOwner = owner) {
      return context.metricMaxAdapter.prefixRecord(
        controlOwner,
        family,
        sequence,
      );
    },
    cleanStop,
    get output() {
      return output.slice();
    },
    get counter() {
      return counter;
    },
    lateReadbacks: readbacks,
    setTime(value) {
      time = value;
    },
    setSharedFailure(value) {
      sharedFailure = value;
    },
    events() {
      return frames
        .filter((frame) => frame.selector === "native_metric")
        .map((frame) => frame.payload);
    },
  };
}

function maxEvidence(h, prefix = h.prefix) {
  const result = h.message("metric_evidence", ...prefix);
  if (result === false) return false;
  assert.equal(h.frames.at(-1).selector, "native_metric_evidence");
  return h.frames.at(-1).payload;
}

function maxPrefixRecord(h, family, sequence = 1, prefix = h.prefix) {
  const result = h.message("metric_prefix_record", ...prefix, family, sequence);
  if (result === false) return false;
  assert.equal(h.frames.at(-1).selector, "native_metric_prefix_record");
  return h.frames.at(-1).payload;
}

test("active prefix getter hands off only accepted native-origin records before clean stop, without another ACK", () => {
  const h = classicCleanupHarness();
  assert.throws(() => maxPrefixRecord(h, "level"), /unavailable/);
  h.until(
    (snapshot) => h.output[24] === 1 && snapshot.families.level.accepted === 0,
  );
  assert.throws(() => maxPrefixRecord(h, "level"), /unavailable/);
  h.until((snapshot) => snapshot.families.level.accepted === 1);
  const before = h.snapshot(),
    controls = h.controls.slice(),
    events = h.events();
  assert.equal(before.state, "capturing");
  assert(
    !h.frames.some((frame) => frame.selector === "native_metric_prefix_record"),
  );
  assert.throws(() => h.record("level"), /unavailable/);
  const eager = maxPrefixRecord(h, "level");
  assert.deepEqual(eager.owner, owner);
  assert.equal(eager.nativeEpoch, before.nativeEpoch);
  assert.equal(eager.sourceOriginCounter, before.sourceOriginCounter);
  assert.equal(eager.record.sourceOriginCounter, before.sourceOriginCounter);
  assert.equal(eager.record.sequence, 1);
  assert.equal(eager.record.startSample, 0);
  assert.equal(eager.record.endSample, h.g.bounds[1]);
  // Process a real accepted prefix now, rather than waiting for source cleanup.
  assert.equal(eager.record.sumSquares[0] / eager.record.count, 1 / 16);
  const direct = h.prefixRecord("level");
  assert(Object.isFrozen(direct));
  assert(Object.isFrozen(direct.owner));
  assert(Object.isFrozen(direct.record));
  assert(Object.isFrozen(direct.record.sumSquares));
  assert.throws(() => {
    direct.record.sumSquares[0] = 0;
  }, TypeError);
  assert.deepEqual(maxPrefixRecord(h, "level"), eager);
  for (const [family, sequence] of [
    ["level", 2],
    ["level", 0],
    ["level", -1],
    ["level", NaN],
    ["level", "1"],
    ["level", 2001],
    ["detector-level", 301],
    ["spectrum", 1],
  ])
    assert.throws(() => maxPrefixRecord(h, family, sequence), /unavailable/);
  assert.throws(
    () => h.message("metric_prefix_record", ...h.prefix, "level"),
    /invalid_selector_arity/,
  );
  assert.deepEqual(maxPrefixRecord(h, "level"), eager);
  assert.deepEqual(h.controls, controls);
  assert.deepEqual(h.events(), events);
  h.until((snapshot) => snapshot.families["detector-level"].accepted === 1);
  assert.equal(
    h.frames.filter((frame) => frame.selector === "native_metric_prefix_record")
      .length,
    3,
  );
  assert.deepEqual(maxPrefixRecord(h, "level"), eager);
  assert.throws(() => h.record("level"), /unavailable/);
});

test("full accepted prefixes remain repeatable through clean stop and stay independent of clean-stop record semantics", () => {
  const h = classicCleanupHarness();
  h.until((snapshot) =>
    Object.values(snapshot.families).every(
      (family) => family.state === "completed",
    ),
  );
  const before = h.snapshot(),
    controls = h.controls.slice();
  assert.equal(before.state, "capturing");
  const accepted = [];
  for (const family of ["level", "detector-level"]) {
    const health = before.families[family];
    assert.equal(health.accepted, health.expected);
    for (let sequence = 1; sequence <= health.expected; sequence++) {
      const payload = maxPrefixRecord(h, family, sequence);
      assert.equal(payload.record.sequence, sequence);
      assert.equal(payload.sourceOriginCounter, before.sourceOriginCounter);
      accepted.push(payload);
    }
    assert.throws(
      () => maxPrefixRecord(h, family, health.expected + 1),
      /unavailable/,
    );
    assert.throws(() => h.record(family), /unavailable/);
  }
  assert.deepEqual(h.controls, controls);
  h.message("stop", ...h.prefix);
  assert.equal(h.snapshot().cleanup, "started");
  assert.deepEqual(maxPrefixRecord(h, "level"), accepted[0]);
  assert.throws(() => h.record("level"), /unavailable/);
  h.step();
  h.message("metric_poll");
  for (const payload of accepted) {
    assert.deepEqual(
      maxPrefixRecord(h, payload.family, payload.record.sequence),
      payload,
    );
    assert.deepEqual(
      h.record(payload.family, payload.record.sequence),
      payload.record,
    );
  }
});

test("a failed family's validated prefix stays readable while the independent healthy family continues", () => {
  const h = classicCleanupHarness({
    transformFrame(selector, values) {
      if (selector === "metric_level_sample" && values[5] >= 2) values[17] = -1;
    },
  });
  h.until(
    (snapshot) =>
      snapshot.families.level.state === "failed" &&
      snapshot.families["detector-level"].accepted >= 2,
  );
  const state = h.snapshot();
  assert.equal(state.state, "capturing");
  assert.equal(state.families.level.accepted, 1);
  assert.equal(state.families["detector-level"].state, "started");
  const prefix = maxPrefixRecord(h, "level");
  assert.equal(prefix.record.sequence, 1);
  assert.throws(() => maxPrefixRecord(h, "level", 2), /unavailable/);
  assert.equal(maxPrefixRecord(h, "detector-level", 2).record.sequence, 2);
  h.until(
    (snapshot) => snapshot.families["detector-level"].state === "completed",
  );
  assert.deepEqual(maxPrefixRecord(h, "level"), prefix);
  assert(
    !h.controls.some(
      ([name, sequence]) =>
        name === "levelMeasurementAcknowledged" && sequence > 1,
    ),
  );
  assert.throws(() => h.record("level"), /unavailable/);
});

for (const failure of [
  "cancel",
  "clock",
  "configuration",
  "owner",
  "deadline",
]) {
  test(`active prefix is denied after ${failure}, including late data and actual successful cleanup where possible`, () => {
    const h = classicCleanupHarness();
    h.until((snapshot) =>
      Object.values(snapshot.families).every((family) => family.accepted === 1),
    );
    const accepted = maxPrefixRecord(h, "level"),
      controls = h.controls.filter(([name]) => /Acknowledged$/.test(name));
    if (failure === "cancel") h.message("cancel", ...h.prefix);
    else if (failure === "owner") {
      assert.equal(
        maxPrefixRecord(h, "level", 1, [
          h.prefix[0],
          "foreign-pass",
          ...h.prefix.slice(2),
        ]),
        false,
      );
    } else if (failure === "deadline") {
      h.setTime(99999);
      assert.deepEqual(maxPrefixRecord(h, "level"), accepted);
      h.setTime(100000);
      h.message("callerTick", ...h.prefix);
    } else {
      h.setSharedFailure(failure);
      h.message("metric_poll");
      h.setSharedFailure(null);
    }
    assert.throws(() => maxPrefixRecord(h, "level"), /unavailable/);
    assert.throws(() => h.prefixRecord("level"), /unavailable/);
    h.lateReadbacks();
    h.step();
    h.message("metric_poll");
    const status = h.snapshot();
    assert.equal(status.state, failure === "cancel" ? "cancelled" : "failed");
    assert.equal(
      status.cleanup,
      failure === "deadline" ? "failed" : "completed",
    );
    assert.throws(() => maxPrefixRecord(h, "level"), /unavailable/);
    assert.throws(() => h.record("level"), /unavailable/);
    assert.deepEqual(
      h.controls.filter(([name]) => /Acknowledged$/.test(name)),
      controls,
    );
  });
}

test("stale/released/replaced owners cannot read old prefixes and failed output delivery does not consume records", () => {
  let throwNextPrefix = false;
  const h = classicCleanupHarness({
    onPacket(packet) {
      if (
        throwNextPrefix &&
        packet.selector === "native_metric_prefix_record"
      ) {
        throwNextPrefix = false;
        throw new Error("controlled-prefix-delivery-failure");
      }
    },
  });
  h.until((snapshot) =>
    Object.values(snapshot.families).every((family) => family.accepted === 1),
  );
  const accepted = maxPrefixRecord(h, "level"),
    controls = h.controls.slice();
  throwNextPrefix = true;
  assert.throws(
    () => maxPrefixRecord(h, "level"),
    /controlled-prefix-delivery-failure/,
  );
  assert.deepEqual(maxPrefixRecord(h, "level"), accepted);
  assert.deepEqual(h.controls, controls);
  const packets = h.frames.length;
  assert.equal(
    maxPrefixRecord(h, "level", 1, ["stale-generation", ...h.prefix.slice(1)]),
    false,
  );
  assert.equal(h.frames.length, packets);
  h.cleanStop();
  h.message("release", ...h.prefix);
  assert.equal(maxPrefixRecord(h, "level"), false);
  h.prefix[0] = "generation-2";
  h.message("begin", ...h.prefix, 2, 100000);
  assert.equal(maxPrefixRecord(h, "level", 1, Object.values(owner)), false);
  assert.throws(() => maxPrefixRecord(h, "level"), /unavailable/);
  h.message(
    "metric_level_sample",
    h.counter,
    ...h.output.slice(20, 42),
    h.counter,
  );
  assert.throws(() => maxPrefixRecord(h, "level"), /unavailable/);
});

function assertReceipt(slot, raw, nativeSourceCounter, observedHostReceiptMs) {
  assert.equal(slot.available, true);
  assert.deepEqual(slot.receipt, {
    raw,
    nativeSourceCounter,
    observedHostReceiptMs,
  });
}

function assertMissingReceipts(evidence) {
  assert.deepEqual(Object.keys(evidence.receipts), [
    "idle",
    "currentEpoch",
    "prelaunch",
    "cleanup",
  ]);
  for (const group of Object.values(evidence.receipts)) {
    assert.deepEqual(group, {
      timing: { available: false, receipt: null },
      configuration: { available: false, receipt: null },
    });
  }
}

test("evidence getter is explicit owner-gated immutable executed data, never private input intent", () => {
  const h = harness();
  assert.equal(h.io.evidence(owner), false);
  h.io.begin({ owner, nativeEpoch: 1, deadlineMs: 100000 });
  assertMissingReceipts(h.io.evidence(owner));
  h.setTime(13);
  for (let i = 0; i < 2048; i++) h.step();
  const idleConfiguration = h.output.slice(8, 20),
    idleTiming = h.output.slice(0, 8);
  h.receipts();
  const idle = h.io.evidence(owner);
  assert.equal(idle.type, "native-metric-envelope-evidence/v1");
  assert.deepEqual(idle.owner, owner);
  assert.equal(idle.nativeEpoch, 1);
  assert.equal(idle.status, "idle");
  assert.equal(idle.cleanup, "blocked");
  assert.equal(idle.diagnosticOnly, false);
  assertReceipt(idle.receipts.idle.timing, idleTiming, h.counter, 13);
  assertReceipt(
    idle.receipts.idle.configuration,
    idleConfiguration,
    h.counter,
    13,
  );
  h.configure();
  assert.equal(
    h.io.evidence(owner).receipts.currentEpoch.configuration.available,
    false,
  );
  h.io.arm(owner);
  h.setTime(55);
  assert.equal(
    h.io.metric_configuration_frame(owner, idleConfiguration, h.counter),
    false,
  );
  assert.equal(h.io.metric_timing_frame(owner, idleTiming, h.counter), false);
  assert.deepEqual(h.io.evidence(owner).receipts, idle.receipts);
  h.step();
  const actualConfiguration = h.output.slice(8, 20),
    actualTiming = h.output.slice(0, 8);
  h.setTime(101);
  h.io.metric_timing_frame(owner, actualTiming, h.counter);
  assert.equal(h.io.evidence(owner).receipts.prelaunch.timing.available, false);
  h.setTime(102);
  h.io.metric_configuration_frame(owner, actualConfiguration, h.counter);
  const armed = h.io.evidence(owner);
  assertReceipt(
    armed.receipts.currentEpoch.timing,
    actualTiming,
    h.counter,
    101,
  );
  assertReceipt(
    armed.receipts.currentEpoch.configuration,
    actualConfiguration,
    h.counter,
    102,
  );
  assert.deepEqual(armed.receipts.prelaunch, armed.receipts.currentEpoch);
  actualTiming[5] = 0;
  actualConfiguration[1] = -1;
  assert.notEqual(armed.receipts.currentEpoch.timing.receipt.raw[5], 0);
  assert.notEqual(armed.receipts.currentEpoch.configuration.receipt.raw[1], -1);
  function frozen(value) {
    if (!value || typeof value !== "object") return;
    assert(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
  frozen(armed);
  assert.throws(() => {
    armed.receipts.prelaunch.timing.receipt.raw[0] = 99;
  }, TypeError);
  assert.throws(() => {
    armed.owner.passId = "foreign";
  }, TypeError);
  const counts = [h.events.length, h.controls.length];
  h.setTime(5000);
  assert.deepEqual(h.io.evidence(owner), armed);
  assert.deepEqual([h.events.length, h.controls.length], counts);
  assert.equal(
    h.io.evidence({ ...owner, generation: "old-generation" }),
    false,
  );
  assert.equal(h.io.snapshot().state, "armed");
  assert.equal(h.io.evidence({ ...owner, passId: "foreign" }), false);
  const failed = h.io.evidence(owner);
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "foreign_owner");
  assert.equal(failed.diagnosticOnly, true);
  assert.deepEqual(failed.receipts, armed.receipts);
});

test("prelaunch evidence requires actual matching native counter stamps and survives launched/cleanup rows", () => {
  const h = harness();
  h.begin();
  h.arm();
  const prelaunch = h.io.evidence(owner).receipts.prelaunch;
  h.setTime(17);
  h.step();
  h.io.metric_timing_frame(owner, h.output.slice(0, 8), h.counter);
  let evidence = h.io.evidence(owner);
  assert.notEqual(
    evidence.receipts.currentEpoch.timing.receipt.nativeSourceCounter,
    evidence.receipts.currentEpoch.configuration.receipt.nativeSourceCounter,
  );
  assert.deepEqual(evidence.receipts.prelaunch, prelaunch);
  h.io.metric_configuration_frame(owner, h.output.slice(8, 20), h.counter);
  evidence = h.io.evidence(owner);
  assert.deepEqual(evidence.receipts.prelaunch, evidence.receipts.currentEpoch);
  h.run();
  const captured = h.io.evidence(owner);
  assertReceipt(
    captured.receipts.currentEpoch.timing,
    h.output.slice(0, 8),
    h.counter,
    17,
  );
  assertReceipt(
    captured.receipts.currentEpoch.configuration,
    h.output.slice(8, 20),
    h.counter,
    17,
  );
  assert(captured.receipts.currentEpoch.timing.receipt.raw[1] >= 0);
  assert.equal(captured.receipts.prelaunch.timing.receipt.raw[1], -1);
  h.io.stop(owner);
  assert.equal(
    h.io.metric_configuration_frame(owner, h.output.slice(8, 20), h.counter),
    false,
  );
  assert.equal(
    h.io.metric_timing_frame(owner, h.output.slice(0, 8), h.counter),
    false,
  );
  assert.equal(h.io.evidence(owner).receipts.cleanup.timing.available, false);
  h.setTime(31);
  h.step();
  h.receipts();
  const cleaned = h.io.evidence(owner);
  assert.equal(cleaned.status, "completed");
  assert.equal(cleaned.cleanup, "completed");
  assertReceipt(
    cleaned.receipts.cleanup.timing,
    h.output.slice(0, 8),
    h.counter,
    31,
  );
  assertReceipt(
    cleaned.receipts.cleanup.configuration,
    h.output.slice(8, 20),
    h.counter,
    31,
  );
  assert.equal(cleaned.receipts.cleanup.timing.receipt.raw[0], 0);
  assert.equal(cleaned.receipts.cleanup.configuration.receipt.raw[10], 0);
  assert.deepEqual(
    cleaned.receipts.currentEpoch,
    captured.receipts.currentEpoch,
  );
  assert.deepEqual(cleaned.receipts.prelaunch, captured.receipts.prelaunch);
  assert.equal(h.io.release(owner), true);
  assert.equal(h.io.evidence(owner), false);
  const next = { ...owner, generation: "generation-2" };
  h.io.begin({ owner: next, nativeEpoch: 2, deadlineMs: 100000 });
  assertMissingReceipts(h.io.evidence(next));
  assert.equal(h.io.evidence(owner), false);
});

test("rejected raw configuration/timing and regressed stamps never replace admitted evidence", () => {
  for (const corrupt of [
    (h) => {
      const row = h.output.slice(8, 20);
      row[10]++;
      h.io.metric_configuration_frame(owner, row, h.counter);
    },
    (h) => {
      const row = h.output.slice(0, 8);
      row[5]++;
      h.io.metric_timing_frame(owner, row, h.counter);
    },
    (h) => h.io.metric_timing_frame(owner, h.output.slice(0, 8), 0),
    (h) =>
      h.io.metric_timing_frame(owner, h.output.slice(0, 8), 17592186044416),
    (h) => {
      const row = h.output.slice(8, 20);
      delete row[1];
      h.io.metric_configuration_frame(owner, row, h.counter);
    },
    (h) =>
      h.io.metric_configuration_frame(
        owner,
        ["private bearer token"],
        h.counter,
      ),
  ]) {
    const h = harness();
    h.begin();
    h.arm();
    const trusted = h.io.evidence(owner);
    corrupt(h);
    const rejected = h.io.evidence(owner);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.diagnosticOnly, true);
    assert.deepEqual(rejected.receipts, trusted.receipts);
    assert(!JSON.stringify(rejected).includes("private bearer"));
    h.step();
    h.receipts();
    const diagnostic = h.io.evidence(owner);
    assert.equal(diagnostic.status, "failed");
    assert.equal(diagnostic.cleanup, "completed");
    assert.equal(diagnostic.diagnosticOnly, true);
    assert.equal(diagnostic.receipts.cleanup.timing.available, true);
    assert.deepEqual(
      diagnostic.receipts.currentEpoch,
      trusted.receipts.currentEpoch,
    );
  }
});

test("genuine classic Max evidence selector returns actual Gen rows and counter bookends only on explicit request", () => {
  const h = classicCleanupHarness({ autoStart: false });
  h.message("begin", ...h.prefix, 1, 100000);
  assertMissingReceipts(maxEvidence(h));
  h.setTime(11);
  h.message("metric_poll");
  const idle = maxEvidence(h);
  assertReceipt(idle.receipts.idle.timing, h.output.slice(0, 8), h.counter, 11);
  h.message(
    "configure_metric",
    ...h.prefix,
    ...Object.values(h.g).slice(0, -1),
  );
  h.message("arm", ...h.prefix);
  h.setTime(19);
  h.message("metric_poll");
  assert.deepEqual(maxEvidence(h).receipts, idle.receipts);
  h.setTime(23);
  h.step();
  h.message("metric_poll");
  const armed = maxEvidence(h);
  assertReceipt(
    armed.receipts.currentEpoch.timing,
    h.output.slice(0, 8),
    h.counter,
    23,
  );
  assertReceipt(
    armed.receipts.currentEpoch.configuration,
    h.output.slice(8, 20),
    h.counter,
    23,
  );
  assert.deepEqual(armed.receipts.prelaunch, armed.receipts.currentEpoch);
  assert.notEqual(h.counter, 23);
  const evidenceCount = h.frames.filter(
    (frame) => frame.selector === "native_metric_evidence",
  ).length;
  const controls = h.controls.slice();
  for (let n = 0; n < 128; n++) {
    h.step();
    h.message("metric_poll");
  }
  assert.equal(
    h.frames.filter((frame) => frame.selector === "native_metric_evidence")
      .length,
    evidenceCount,
  );
  assert.deepEqual(h.controls, controls);
  const before = h.frames.length;
  assert.equal(
    maxEvidence(h, ["stale-generation", ...h.prefix.slice(1)]),
    false,
  );
  assert.equal(h.frames.length, before);
  assert.throws(
    () => h.message("metric_evidence", ...h.prefix, "extra"),
    /invalid_selector_arity/,
  );
  const beforeCancel = maxEvidence(h);
  h.message("cancel", ...h.prefix);
  h.step();
  h.message("metric_poll");
  const diagnostic = maxEvidence(h);
  assert.equal(diagnostic.status, "cancelled");
  assert.equal(diagnostic.cleanup, "completed");
  assert.equal(diagnostic.diagnosticOnly, true);
  assert.equal(diagnostic.receipts.cleanup.timing.receipt.raw[0], 0);
  assert.deepEqual(
    diagnostic.receipts.prelaunch,
    beforeCancel.receipts.prelaunch,
  );
  assert.throws(() => h.record("level"), /unavailable/);
});

test("classic Max advancing counter bookends discard a torn acquisition and accept the next coherent receipt", () => {
  let inject = false;
  const h = classicCleanupHarness({
    transformFrame(selector, values) {
      if (inject && selector === "metric_configuration_sample")
        values[values.length - 1] += 64;
    },
  });
  const trusted = maxEvidence(h);
  inject = true;
  h.step();
  h.message("metric_poll");
  const skipped = maxEvidence(h);
  assert.notEqual(skipped.status, "failed");
  for (const group of ["idle", "currentEpoch", "prelaunch"])
    assert.deepEqual(
      skipped.receipts[group].configuration,
      trusted.receipts[group].configuration,
    );
  const diagnostics = h.frames.filter(
    (frame) =>
      frame.selector === "native_metric" &&
      frame.payload.reason === "readback_cohort_skipped",
  );
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].payload.owner, owner);
  assert.equal(
    diagnostics[0].payload.progress.counterAfter -
      diagnostics[0].payload.progress.counterBefore,
    64,
  );
  inject = false;
  h.step();
  h.message("metric_poll");
  const recovered = maxEvidence(h);
  assert.notEqual(recovered.status, "failed");
  assert.ok(
    recovered.receipts.currentEpoch.configuration.receipt.nativeSourceCounter >
      trusted.receipts.currentEpoch.configuration.receipt.nativeSourceCounter,
  );
  h.cleanStop();
});

for (const [selector, first, width] of [
  ["metric_configuration_sample", 8, 12],
  ["metric_timing_sample", 0, 8],
  ["metric_level_sample", 20, 22],
  ["metric_detector_sample", 42, 22],
]) {
  test(`independent coherent ${selector} may lag another bank by one vector but never its own watermark`, () => {
    let cached = null;
    const h = classicCleanupHarness({
      transformFrame(bank, values) {
        if (cached && bank === selector)
          values.splice(0, values.length, ...cached);
      },
    });
    const older = [
      h.counter,
      ...h.output.slice(first, first + width),
      h.counter,
    ];
    for (let i = 0; i < 64; i++) h.step();
    cached = [h.counter, ...h.output.slice(first, first + width), h.counter];
    for (let i = 0; i < 64; i++) h.step();
    assert.equal(h.counter - cached[0], 64);
    h.message("metric_poll");
    assert.notEqual(h.snapshot().state, "failed");
    assert.equal(h.snapshot().cleanup, "blocked");
    h.step();
    assert.equal(h.output[0], 1);
    assert.equal(h.output[18], 1);
    assert.equal(h.output[2], 0);
    assert.equal(h.output[7], 3);

    cached = older;
    h.message("metric_poll");
    assert.equal(h.snapshot().reason, "invalid_shared_timing");
    assert.equal(h.snapshot().cleanup, "started");
    h.step();
    // The failed reader disarms the same Gen consumed by listener.mel~.
    assert.equal(h.output[0], 0);
    assert.equal(h.output[18], 0);
    assert.equal(h.output[2], 0);
    assert.equal(h.output[7], 3);
    cached = null;
    h.message("metric_poll");
    assert.equal(h.snapshot().cleanup, "completed");
  });
}

test("classic Max forged/backwards cohort data cannot update receipt slots and foreign evidence owners stay fatal", () => {
  for (const fault of ["backwards", "forged", "foreign"]) {
    let inject = false;
    const h = classicCleanupHarness({
      transformFrame(selector, values) {
        if (!inject || selector !== "metric_configuration_sample") return;
        if (fault === "backwards") values[values.length - 1]--;
        else if (fault === "forged") values[11]++;
      },
    });
    const trusted = maxEvidence(h);
    h.setTime(41);
    if (fault === "foreign")
      assert.equal(
        maxEvidence(h, [h.prefix[0], "foreign-pass", ...h.prefix.slice(2)]),
        false,
      );
    else {
      inject = true;
      h.step();
      h.message("metric_poll");
      inject = false;
    }
    const rejected = maxEvidence(h);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.diagnosticOnly, true);
    assert.deepEqual(rejected.receipts, trusted.receipts);
    h.step();
    h.message("metric_poll");
    assert.equal(maxEvidence(h).cleanup, "completed");
    assert.throws(() => h.record("level"), /unavailable/);
  }
});

test("receipt evidence remains bounded and independent of family failures, getter traffic and deadlines", () => {
  const h = classicCleanupHarness({ failAfterPrefix: true });
  h.until((snapshot) =>
    Object.values(snapshot.families).every(
      (family) => family.state === "failed",
    ),
  );
  const failedFamilies = maxEvidence(h);
  assert.equal(failedFamilies.diagnosticOnly, false);
  assert.equal(failedFamilies.status, "capturing");
  h.cleanStop();
  const cleaned = maxEvidence(h);
  const controls = h.controls.slice();
  for (let i = 0; i < 1000; i++) {
    h.setTime(1000 + i);
    assert.deepEqual(maxEvidence(h), cleaned);
  }
  assert.deepEqual(h.controls, controls);
  let scalars = 0;
  for (const group of Object.values(cleaned.receipts)) {
    assert.deepEqual(Object.keys(group), ["timing", "configuration"]);
    for (const [family, slot] of Object.entries(group)) {
      assert.equal(slot.available, true);
      assert.equal(slot.receipt.raw.length, family === "timing" ? 8 : 12);
      scalars += slot.receipt.raw.length;
    }
  }
  assert.equal(scalars, 80);
  assert(JSON.stringify(cleaned).length < 8192);
  assert(!Object.hasOwn(cleaned, "sourceCoverage"));
  assert(!Object.hasOwn(cleaned, "inputConfiguration"));
  assert(!Object.hasOwn(cleaned, "publicationEligible"));
  assert(!Object.hasOwn(cleaned, "nativeReady"));
  const waiting = classicCleanupHarness();
  waiting.setTime(99999);
  maxEvidence(waiting);
  waiting.setTime(100000);
  waiting.message("callerTick", ...waiting.prefix);
  assert.equal(maxEvidence(waiting).reason, "deadline_exceeded");
  assert.equal(maxEvidence(waiting).diagnosticOnly, true);
});

test("the independent watchdog disarms only its owned generation and still requires executed cleanup", () => {
  const h = classicCleanupHarness();
  const before = h.snapshot();
  assert.equal(h.message("metric_guard_stop", "foreign-generation"), false);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.message("metric_guard_stop", h.prefix[0]), true);
  assert.deepEqual(h.controls.at(-1), ["epoch", 0]);
  assert.equal(h.snapshot().cleanup, "started");
  h.step();
  h.message("metric_poll");
  assert.equal(h.snapshot().cleanup, "completed");
});

test("maximum bounded owner/epoch evidence stays scalar-only and below the explicit getter packet bound", () => {
  const h = classicCleanupHarness({ autoStart: false });
  h.prefix.splice(
    0,
    h.prefix.length,
    "g" + "x".repeat(127),
    "p" + "x".repeat(127),
    "e" + "x".repeat(127),
    "t" + "x".repeat(127),
    "c" + "x".repeat(127),
    "a" + "x".repeat(127),
  );
  h.message("begin", ...h.prefix, 1000000, 100000);
  h.message("metric_poll");
  h.message(
    "configure_metric",
    ...h.prefix,
    ...Object.values(h.g).slice(0, -1),
  );
  h.message("arm", ...h.prefix);
  h.step();
  h.message("metric_poll");
  h.until((snapshot) =>
    Object.values(snapshot.families).every((family) => family.accepted === 1),
  );
  h.cleanStop();
  const evidence = maxEvidence(h);
  assert.equal(evidence.nativeEpoch, 1000000);
  assert.equal(evidence.owner.traceId.length, 128);
  assert.equal(evidence.owner.connectionEpoch.length, 128);
  assert(JSON.stringify(evidence).length < 8192);
  for (const group of Object.values(evidence.receipts)) {
    for (const slot of Object.values(group)) {
      assert.equal(slot.available, true);
      assert(
        slot.receipt.raw.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
      );
    }
  }
});

test("explicit evidence reads inside lifecycle callbacks see admitted rows without recursive events or controls", () => {
  const observed = [];
  const h = harness(undefined, {
    onEvent(frame, io) {
      if (
        (frame.family === "control" &&
          frame.reason === "executed_configuration") ||
        (frame.family === "cleanup" && frame.stage === "completed")
      )
        observed.push({ frame, evidence: io.evidence(owner) });
    },
  });
  h.begin();
  h.arm();
  h.run();
  h.cleanup();
  assert.equal(observed.length, 2);
  assert.equal(observed[0].evidence.receipts.prelaunch.timing.available, true);
  assert.equal(
    observed[0].evidence.receipts.prelaunch.configuration.available,
    true,
  );
  assert.equal(observed[1].evidence.cleanup, "completed");
  assert.equal(observed[1].evidence.receipts.cleanup.timing.available, true);
  assert.equal(
    observed[1].evidence.receipts.cleanup.configuration.available,
    true,
  );
  assert.equal(h.io.snapshot().state, "completed");
});

test("clean control stop exposes both failed-family validated prefixes without deciding observation viability", () => {
  const h = classicCleanupHarness({ failAfterPrefix: true });
  const stoppedSample = h.until((snapshot) =>
    Object.values(snapshot.families).every(
      (family) => family.state === "failed",
    ),
  );
  assert(stoppedSample < h.g.totalSamples - 1);
  const before = h.snapshot();
  for (const family of ["level", "detector-level"]) {
    assert.equal(before.families[family].accepted, 1);
    assert.equal(
      before.families[family].reason,
      "metric_record_moments_mismatch",
    );
    assert.throws(() => h.record(family), /unavailable/);
  }
  h.setTime(17);
  h.cleanStop();
  const after = h.snapshot();
  assert.equal(after.state, "completed");
  assert.equal(after.reason, null);
  assert.deepEqual(after.families, before.families);
  for (const family of ["level", "detector-level"]) {
    const record = h.record(family);
    assert.equal(record.sequence, 1);
    assert.equal(record.startSample, 0);
    assert.deepEqual(record.sumSquares, [record.count / 16, record.count / 4]);
    assert.deepEqual(h.record(family), record);
    assert.throws(() => h.record(family, 2), /unavailable/);
  }
  const controlsBeforeLate = h.controls.slice();
  h.lateReadbacks();
  assert.deepEqual(h.controls, controlsBeforeLate);
  assert.deepEqual(
    h.controls.filter(
      ([name, sequence]) => /Acknowledged$/.test(name) && sequence > 0,
    ),
    [
      ["levelMeasurementAcknowledged", 1],
      ["attackMeasurementAcknowledged", 1],
    ],
  );
  const events = h.events();
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.family === "cleanup" ||
          (event.family === "control" && event.stage === "completed"),
      )
      .map((event) => [
        event.family,
        event.stage,
        event.reason,
        event.elapsedMs,
      ]),
    [
      ["cleanup", "queued", null, 17],
      ["cleanup", "started", null, 17],
      ["cleanup", "completed", null, 17],
      ["control", "completed", null, 17],
    ],
  );
  assert(!events.some((event) => event.reason === "no_complete_family"));
  for (const family of ["level", "detector-level"]) {
    const failures = events.filter(
      (event) => event.family === family && event.stage === "failed",
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, "metric_record_moments_mismatch");
    assert(
      events.indexOf(failures[0]) <
        events.findIndex((event) => event.family === "cleanup"),
    );
  }
});

test("clean stop with incomplete prefixes completes control and preserves explicit family incompleteness", () => {
  const h = classicCleanupHarness();
  h.until((snapshot) =>
    Object.values(snapshot.families).every((family) => family.accepted === 1),
  );
  h.cleanStop();
  const state = h.snapshot();
  assert.equal(state.state, "completed");
  for (const family of ["level", "detector-level"]) {
    assert.equal(state.families[family].state, "failed");
    assert.equal(state.families[family].reason, "incomplete_at_stop");
    assert.equal(h.record(family).sequence, 1);
  }
});

test("spectrum-only host can finish shared-valid control cleanup with zero envelope records", () => {
  const h = classicCleanupHarness({ missing: true });
  assert(
    Object.values(h.snapshot().families).every(
      (family) =>
        family.state === "failed" &&
        family.accepted === 0 &&
        family.reason === "unavailable_output",
    ),
  );
  h.cleanStop();
  const state = h.snapshot();
  assert.equal(state.state, "completed");
  assert.equal(state.reason, null);
  assert.equal(state.sourceOriginCounter, null);
  assert(
    Object.values(state.families).every((family) => family.accepted === 0),
  );
  for (const family of ["level", "detector-level"])
    assert.throws(() => h.record(family), /unavailable/);
  assert(
    !h.controls.some(
      ([name, sequence]) => /Acknowledged$/.test(name) && sequence > 0,
    ),
  );
  assert.deepEqual(
    h
      .events()
      .filter((event) => event.family === "control")
      .map((event) => [event.stage, event.reason]),
    [
      ["queued", null],
      ["progress", "executed_idle"],
      ["started", null],
      ["progress", "executed_configuration"],
      ["completed", null],
    ],
  );
});

for (const [failure, reason] of [
  ["owner", "foreign_owner"],
  ["clock", "shared_arm_counter"],
  ["configuration", "executed_configuration_mismatch"],
  ["cancel", "cancelled"],
]) {
  test(`${failure}: actual successful cleanup cannot relabel a terminal pass or expose its retained prefixes`, () => {
    const h = classicCleanupHarness();
    h.until((snapshot) =>
      Object.values(snapshot.families).every((family) => family.accepted === 1),
    );
    h.setTime(17);
    const eventStart = h.events().length;
    const controlsBefore = h.controls.filter(([name]) =>
      /Acknowledged$/.test(name),
    );
    if (failure === "owner")
      h.message("arm", h.prefix[0], "foreign-pass", ...h.prefix.slice(2));
    else if (failure === "cancel") h.message("cancel", ...h.prefix);
    else {
      h.setSharedFailure(failure);
      h.message("metric_poll");
      h.setSharedFailure(null);
    }
    h.setTime(29);
    h.cleanStop();
    const state = h.snapshot(),
      terminal = failure === "cancel" ? "cancelled" : "failed";
    assert.equal(state.state, terminal);
    assert.equal(state.reason, reason);
    for (const family of ["level", "detector-level"]) {
      assert.equal(state.families[family].accepted, 1);
      assert.throws(() => h.record(family), /unavailable/);
    }
    assert.deepEqual(
      h.controls.filter(([name]) => /Acknowledged$/.test(name)),
      controlsBefore,
    );
    assert.deepEqual(
      h
        .events()
        .slice(eventStart)
        .filter(
          (event) => event.family === "control" || event.family === "cleanup",
        )
        .map((event) => [
          event.family,
          event.stage,
          event.reason,
          event.elapsedMs,
        ]),
      [
        ["control", terminal, failure === "cancel" ? null : reason, 17],
        ["cleanup", "queued", null, 17],
        ["cleanup", "started", null, 17],
        ["cleanup", "completed", null, 29],
      ],
    );
  });
}

test("fixed deadline cannot be extended by useful prefixes or late cleanup readbacks", () => {
  const h = classicCleanupHarness();
  h.until((snapshot) =>
    Object.values(snapshot.families).every((family) => family.accepted === 1),
  );
  h.setTime(99999);
  h.message("callerTick", ...h.prefix);
  assert.equal(h.snapshot().state, "capturing");
  h.setTime(100000);
  h.message("callerTick", ...h.prefix);
  h.step();
  h.message("metric_poll");
  h.message("stop", ...h.prefix);
  const state = h.snapshot();
  assert.equal(state.state, "failed");
  assert.equal(state.reason, "deadline_exceeded");
  assert.equal(state.cleanup, "failed");
  for (const family of ["level", "detector-level"])
    assert.throws(() => h.record(family), /unavailable/);
  assert(
    !h
      .events()
      .some(
        (event) => event.family === "control" && event.stage === "completed",
      ),
  );
});

for (const rate of [44100, 48000]) {
  for (const [tempo, start, end] of [
    [137, 12.125, 13.01],
    [999, 100.249, 100.3],
  ]) {
    test(`${rate}/${tempo}: actual retained Gen -> IO -> exact independent PCM`, () => {
      const h = harness(geometry(rate, tempo, start, end));
      h.begin();
      h.arm();
      h.run();
      assert.equal(h.io.snapshot().state, "capturing");
      const detector = [0];
      for (let n = h.g.hopSamples; n < h.g.totalSamples; n += h.g.hopSamples)
        detector.push(n);
      detector.push(h.g.totalSamples);
      for (const [family, bounds] of [
        ["level", h.g.bounds],
        ["detector-level", detector],
      ]) {
        const actual = h.records.filter((row) => row.family === family);
        const expected = reference(bounds);
        assert.equal(actual.length, expected.length);
        actual.forEach(({ record }, i) => {
          assert(Object.isFrozen(record));
          assert.equal(record.sequence, i + 1);
          assert.equal(record.sourceOriginCounter, h.origin);
          assert.equal(record.startSample, expected[i].start);
          assert.equal(record.endSample, expected[i].end);
          assert.deepEqual(record.sumSquares, [
            expected[i].left,
            expected[i].right,
          ]);
          assert.deepEqual(record.peak, [expected[i].peakL, expected[i].peakR]);
          assert.deepEqual(record.rms, [
            Math.sqrt(expected[i].left / record.count),
            Math.sqrt(expected[i].right / record.count),
          ]);
        });
      }
      h.cleanup();
      assert.equal(h.io.snapshot().state, "completed");
      assert.equal(h.io.release(owner), true);
    });
  }
}

test("no setter echo/readiness facade; stopped armed wait stays bounded by caller/source deadlines", () => {
  const h = harness();
  h.begin();
  h.configure();
  h.io.arm(owner);
  assert.equal(h.io.snapshot().state, "arming");
  for (let n = 0; n < 10000; n++) h.step();
  h.receipts();
  assert.equal(h.io.snapshot().state, "armed");
  assert.equal(h.records.length, 0);
  h.io.stop(owner);
  h.step();
  h.receipts();
  assert.equal(h.io.snapshot().cleanup, "completed");
  assert.equal(h.io.snapshot().state, "completed");
  assert.equal(h.io.snapshot().sourceOriginCounter, null);
  assert(
    Object.values(h.io.snapshot().families).every(
      (family) =>
        family.state === "failed" &&
        family.reason === "incomplete_at_stop" &&
        family.accepted === 0,
    ),
  );
});

test("family overflow is isolated, healthy family completes, accepted prefix survives", () => {
  const h = harness(geometry(48000, 999, 0, 8));
  h.begin();
  h.arm();
  h.run({ skip: ["level"] });
  h.poll("level");
  assert.equal(h.io.snapshot().families.level.state, "failed");
  assert.equal(h.io.snapshot().families["detector-level"].state, "completed");
  assert(h.records.some((r) => r.family === "detector-level"));
  h.cleanup();
  assert.equal(h.io.snapshot().state, "completed");
});

test("malformed family output is isolated and never acknowledged", () => {
  const h = harness();
  h.begin();
  h.arm();
  const before = h.controls.length;
  h.io.metric_level_frame(owner, ["private bearer secret"]);
  assert.equal(h.io.snapshot().families.level.state, "failed");
  assert.equal(h.controls.length, before);
  h.run();
  assert.equal(h.io.snapshot().families["detector-level"].state, "completed");
  h.cleanup();
});

test("shared rejection, wrong seal/configuration and foreign current-owner IDs are fatal", () => {
  for (const mutate of [
    (h) => {
      const row = h.output.slice(8, 20);
      row[10] = 2;
      h.io.metric_configuration_frame(owner, row, h.counter);
    },
    (h) => {
      const row = h.output.slice(8, 20);
      row[1]++;
      h.io.metric_configuration_frame(owner, row, h.counter);
    },
    (h) => {
      const row = h.output.slice(0, 8);
      row[2] = 13;
      h.io.metric_timing_frame(owner, row, 2 ** 32 + 2);
    },
    (h) => h.io.metric_level_frame({ ...owner, passId: "foreign" }, []),
    (h) => h.io.metric_timing_frame(owner, h.output.slice(0, 8), 0),
  ]) {
    const h = harness();
    h.begin();
    h.arm();
    mutate(h);
    assert.equal(h.io.snapshot().state, "failed");
    assert.equal(h.io.snapshot().cleanup, "started");
    h.step();
    h.receipts();
    assert.equal(h.io.snapshot().cleanup, "completed");
  }
});

test("cancel gates late callbacks and consumer reentrancy before ACK", () => {
  const h = harness(undefined, {
    consume: (_f, _r, io) => {
      io.cancel(owner);
      return true;
    },
  });
  h.begin();
  h.arm();
  h.run();
  assert.equal(h.io.snapshot().state, "cancelled");
  assert.equal(
    h.controls.filter((c) => /Acknowledged/.test(c[1]) && c[2] > 0).length,
    0,
  );
  const count = h.records.length;
  h.io.metric_level_frame(owner, h.output.slice(20, 42));
  assert.equal(h.records.length, count);
  assert.equal(
    h.events.filter((e) => e.stage === "cancelled" && e.family === "control")
      .length,
    1,
  );
});

test("cleanup is executed two-part readback, not a control ACK; deadline never moves", () => {
  const h = harness();
  h.begin();
  h.arm();
  h.io.cancel(owner);
  h.io.metric_configuration_frame(owner, h.output.slice(8, 20), h.counter);
  h.io.metric_timing_frame(owner, h.output.slice(0, 8), 2 ** 32 + 2);
  assert.equal(h.io.snapshot().cleanup, "started");
  assert.equal(h.io.release(owner), false);
  h.setTime(100001);
  h.io.callerTick(owner);
  assert.equal(h.io.snapshot().cleanup, "failed");
});

test("epoch highwater survives release; stale generation callbacks cannot poison fresh owner", () => {
  const h = harness();
  h.begin();
  h.arm();
  h.cleanup();
  h.io.release(owner);
  assert.throws(
    () => h.io.begin({ owner, nativeEpoch: 1, deadlineMs: 200000 }),
    /epoch/,
  );
  const next = { ...owner, generation: "generation-2" };
  h.io.begin({ owner: next, nativeEpoch: 2, deadlineMs: 200000 });
  h.io.metric_timing_frame(owner, ["bad"], 0);
  assert.equal(h.io.snapshot().state, "idle");
});

test("asynchronous old idle pages wait for actual executed arm receipts", () => {
  const h = harness();
  h.begin();
  const idleConfiguration = h.output.slice(8, 20);
  const idleTiming = h.output.slice(0, 8);
  const counter = h.counter;
  h.configure();
  h.io.arm(owner);
  h.io.metric_configuration_frame(owner, idleConfiguration, counter);
  h.io.metric_timing_frame(owner, idleTiming, counter);
  assert.equal(h.io.snapshot().state, "arming");
  assert.equal(h.records.length, 0);
  h.step();
  h.receipts();
  assert.equal(h.io.snapshot().state, "armed");
});

test("an executed parameter mutation is shared-fatal even after successful rows", () => {
  const h = harness();
  h.begin();
  h.arm();
  let mutated = false;
  h.run({
    mutate(_row, sample) {
      if (!mutated && sample > h.g.bounds[1] + 128) {
        mutated = true;
        h.model.configure({ tempoBpm: 120 });
      }
    },
  });
  assert.equal(h.io.snapshot().state, "failed");
  assert.equal(h.io.snapshot().cleanup, "completed");
  assert(h.records.length > 0);
});

test("normalization failures preserve prefixes and withhold the damaged slot ACK", () => {
  const h = harness();
  h.begin();
  h.arm();
  let damaged = false;
  h.run({
    mutate(row) {
      if (row[24] === 2) {
        damaged = true;
        const bad = row.slice(20, 42);
        bad[16] = -1;
        h.io.metric_level_frame(owner, bad);
        h.io.metric_level_frame(owner, bad);
      }
    },
  });
  assert(damaged);
  assert.equal(h.io.snapshot().families.level.accepted, 1);
  assert.equal(
    h.io.snapshot().families.level.reason,
    "metric_record_moments_mismatch",
  );
  assert.equal(h.io.snapshot().families["detector-level"].state, "completed");
  assert(
    !h.controls.some(
      (c) => c[1] === "levelMeasurementAcknowledged" && c[2] >= 2,
    ),
  );
  assert(
    h.records
      .filter((r) => r.family === "level")
      .every((r) => r.record.sequence === 1),
  );
});

test("a future owner epoch or invalid shared DSP control cannot become a partial result", () => {
  for (const corrupt of [
    (row) => {
      row[1] = 2;
      row[21] = 2;
    },
    (row) => {
      row[9] = 2;
    },
    (row) => {
      row[1] = 0;
      row[21] = 0;
    },
  ]) {
    const h = harness();
    h.begin();
    h.arm();
    let injected = false;
    h.run({
      mutate(row, sample) {
        if (!injected && sample >= 80) {
          injected = true;
          const bad = row.slice(20, 42);
          corrupt(bad);
          // A forged zero-owner page includes a nonzero request; it must not
          // erase already observed ownership.
          h.io.metric_level_frame(owner, row.slice(20, 42));
          h.io.metric_level_frame(owner, bad);
        }
      },
    });
    assert.equal(h.io.snapshot().state, "failed");
  }
});

test("consumer denial/exception is local, sanitized, and never ACKed", () => {
  for (const consume of [
    () => false,
    () => {
      throw new Error("bearer sensitive-free-text");
    },
  ]) {
    const h = harness(undefined, {
      consume: (family) => (family === "level" ? consume() : true),
    });
    h.begin();
    h.arm();
    h.run();
    assert.equal(h.io.snapshot().families.level.state, "failed");
    assert.equal(h.io.snapshot().families["detector-level"].state, "completed");
    assert(
      !h.controls.some(
        (c) => c[1] === "levelMeasurementAcknowledged" && c[2] > 0,
      ),
    );
    assert(!JSON.stringify(h.events).includes("sensitive"));
    h.cleanup();
  }
});

test("immutable candidates cannot change while settling or be ACKed", () => {
  const h = harness();
  h.begin();
  h.arm();
  let changed = false;
  h.run({
    mutate(row) {
      if (!changed && row[24] === 1) {
        changed = true;
        const first = row.slice(20, 42);
        h.io.metric_level_frame(owner, first);
        const other = first.slice();
        other[14] += 0.1;
        h.io.metric_level_frame(owner, other);
      }
    },
  });
  assert.equal(h.io.snapshot().families.level.reason, "immutable_slot_changed");
  assert(
    !h.controls.some(
      (c) => c[1] === "levelMeasurementAcknowledged" && c[2] > 0,
    ),
  );
});

test("fresh cleanup counter is mandatory, including cancelling before an arm receipt", () => {
  const h = harness();
  h.begin();
  const oldConfiguration = h.output.slice(8, 20);
  const oldTiming = h.output.slice(0, 8);
  const oldCounter = h.counter;
  h.io.cancel(owner);
  h.io.metric_configuration_frame(owner, oldConfiguration, oldCounter);
  h.io.metric_timing_frame(owner, oldTiming, oldCounter);
  assert.equal(h.io.snapshot().cleanup, "started");
  h.step();
  h.receipts();
  assert.equal(h.io.snapshot().cleanup, "completed");
  assert.equal(h.io.snapshot().state, "cancelled");
});

test("control and event callback failures stay failed with explicit cleanup", () => {
  for (const failAt of ["configuration", "events"]) {
    const controls = [];
    const io = createMetricEnvelopeIO({
      now: () => 0,
      control(action) {
        controls.push(action);
        if (failAt === "configuration" && action[1] === "totalSamples")
          throw new Error("private secret");
      },
      send(frame) {
        if (
          failAt === "events" &&
          frame.stage === "queued" &&
          frame.family === "control"
        )
          throw new Error("private secret");
      },
      consume: () => true,
    });
    const start = () => io.begin({ owner, nativeEpoch: 1, deadlineMs: 1000 });
    if (failAt === "events") assert.throws(start, /event_delivery_failed/);
    else {
      start();
      io.metric_configuration_frame(owner, Array(12).fill(0), 10);
      io.metric_timing_frame(owner, [0, -1, 0, 0, -1, 0, -1, 3], 10);
      const config = { ...geometry() };
      delete config.bounds;
      io.configure_metric(owner, config);
    }
    assert.equal(io.snapshot().state, "failed");
    assert(!JSON.stringify(io.snapshot()).includes("secret"));
    assert(controls.some((c) => c[1] === "epoch" && c[2] === 0));
  }
});

test("reentrant lifecycle cancellation cannot arm or ACK and events remain ordered", () => {
  for (const stage of ["queued", "started"]) {
    const h = harness(undefined, {
      onEvent(frame, io) {
        if (frame.family === "level" && frame.stage === stage) io.cancel(owner);
      },
    });
    h.begin();
    if (h.configure()) h.io.arm(owner);
    h.step();
    h.receipts();
    assert.equal(h.io.snapshot().state, "cancelled");
    assert(!h.controls.some((c) => /Acknowledged/.test(c[1]) && c[2] > 0));
    const states = h.events
      .filter((e) => e.family === "level")
      .map((e) => e.stage);
    assert(states.indexOf(stage) < states.indexOf("cancelled"));
  }
});

test("fixed deadline, nonzero timing, ID sanitization and configuration bounds", () => {
  const h = harness();
  h.begin();
  h.arm();
  h.setTime(300);
  h.io.callerTick(owner);
  h.setTime(100001);
  h.io.callerTick(owner);
  assert.equal(h.io.snapshot().state, "failed");
  assert.equal(h.io.snapshot().reason, "deadline_exceeded");
  assert.equal(h.io.snapshot().cleanup, "failed");
  assert(h.events.some((e) => e.elapsedMs === 100001));
  const io = createMetricEnvelopeIO({
    send() {},
    control() {},
    consume: () => true,
  });
  for (const value of [
    "bearer-private",
    "x".repeat(129),
    "line\nbreak",
    "sk-private",
  ]) {
    assert.throws(
      () =>
        io.begin({
          owner: { ...owner, traceId: value },
          nativeEpoch: 1,
          deadlineMs: Date.now() + 1000,
        }),
      /invalid_owner/,
    );
  }
  for (const patch of [
    { sampleRate: 96000 },
    { tempoBpm: 19 },
    { tempoBpm: 1000 },
    { reportEndBeat: 1576801 },
    { hopSamples: 4801 },
    { reportRowCount: 2001 },
    { totalSamples: 48000 * 30 + 1 },
    { levelConfigurationVersion: 2 },
    { startBeatFraction: 0 },
    { unexpected: 1 },
  ]) {
    const bounded = harness();
    bounded.begin();
    const config = { ...geometry(), ...patch };
    delete config.bounds;
    assert.throws(
      () => bounded.io.configure_metric(owner, config),
      /invalid_configuration/,
    );
    assert.equal(bounded.controls.length, 0);
  }
});

test("classic Max JS entry and owner-explicit control selectors need no Node runtime", () => {
  const { parse } = createRequire(require.resolve("eslint/package.json"))(
    "espree",
  );
  const context = vm.createContext({
    jsarguments: ["audio_listener_metric_io.js", "musical-v1"],
    arrayfromargs: (args) => Array.from(args),
    Date: class {
      getTime() {
        return 0;
      }
    },
    outlet: (index, values) => {
      if (index !== 2 || values[0] !== "poll_frames") return;
      message("metric_configuration_sample", 10, ...Array(12).fill(0), 10);
      message("metric_timing_sample", 10, 0, -1, 0, 0, -1, 0, -1, 3, 10);
    },
  });
  function message(selector, ...args) {
    context.messagename = selector;
    return context.anything(...args);
  }
  for (const file of [
    "audio_listener_measurements.js",
    "audio_listener_metric_io.js",
  ]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    parse(text, { ecmaVersion: 5 });
    vm.runInContext(text, context);
  }
  const prefix = [
    owner.generation,
    owner.passId,
    owner.connectionEpoch,
    owner.traceId,
    owner.correlationId,
    owner.causationId,
  ];
  message("begin", ...prefix, 1, 1000);
  message("metric_poll");
  const config = geometry();
  message(
    "configure_metric",
    ...prefix,
    ...context.AudioListenerMetricIO.configurationFields.map(
      (key) => config[key],
    ),
  );
  assert.throws(() => message("arm", ...prefix, 1), /invalid_selector_arity/);
  message("arm", ...prefix);
  assert.equal(context.metricMaxAdapter.snapshot().state, "arming");
});

for (const rate of [44100, 48000]) {
  for (const vector of [1, 1024]) {
    test(`${rate}/vector${vector}: long stopped wait retains sample zero and one short tail exactly once`, () => {
      const g = geometry(rate, 128, 8.13, 8.2);
      g.captureVector = vector;
      const h = harness(g);
      h.begin();
      h.arm(rate * 2);
      h.run();
      assert.equal(h.io.snapshot().state, "capturing");
      for (const family of ["level", "detector-level"]) {
        const rows = h.records.filter((row) => row.family === family);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].record.startSample, 0);
        assert.equal(rows[0].record.endSample, g.totalSamples);
        assert.equal(rows[0].record.sourceOriginCounter, h.origin);
        assert.deepEqual(rows[0].record.sumSquares, [
          reference([0, g.totalSamples])[0].left,
          reference([0, g.totalSamples])[0].right,
        ]);
        const prefix =
          family === "level" ? "levelMeasurement" : "attackMeasurement";
        const request = h.controls.findIndex(
          (c) => c[1] === prefix + "ReadSequence" && c[2] === 2,
        );
        const ack = h.controls.findIndex(
          (c) => c[1] === prefix + "Acknowledged" && c[2] === 1,
        );
        assert(request > 0 && ack > request);
        assert.equal(
          h.controls.filter(
            (c) => c[1] === prefix + "Acknowledged" && c[2] === 1,
          ).length,
          1,
        );
      }
      h.cleanup();
    });
  }
}

test("configuration is frozen against caller mutation and repeat configuration is shared-fatal", () => {
  const h = harness();
  h.begin();
  const config = { ...geometry() };
  delete config.bounds;
  h.io.configure_metric(owner, config);
  config.tempoBpm = 20;
  h.io.arm(owner);
  h.step();
  h.receipts();
  assert.equal(h.io.snapshot().state, "armed");
  assert.equal(h.io.configure_metric(owner, config), false);
  assert.equal(h.io.snapshot().reason, "configuration_mutation");
});

test("missing shared output denies readiness; a missing optional output does not", () => {
  for (const selector of [
    "metric_configuration_frame",
    "metric_timing_frame",
  ]) {
    const h = harness();
    h.begin();
    h.configure();
    h.io.arm(owner);
    h.step();
    h.io[selector](owner, null, h.counter);
    assert.equal(h.io.snapshot().state, "failed");
    assert.equal(h.records.length, 0);
  }
  const h = harness();
  h.begin();
  h.configure();
  h.io.metric_level_frame(owner, null);
  h.io.arm(owner);
  h.step();
  h.receipts();
  h.run();
  assert.equal(h.io.snapshot().families.level.state, "failed");
  assert.equal(h.io.snapshot().families["detector-level"].state, "completed");
  h.cleanup();
});

test("malformed cleanup evidence fails explicitly; no control-only release", () => {
  const h = harness();
  h.begin();
  h.arm();
  h.io.cancel(owner);
  h.io.metric_configuration_frame(owner, ["bearer-private"], h.counter + 1);
  assert.equal(h.io.snapshot().cleanup, "failed");
  assert.equal(h.io.release(owner), false);
  assert(
    h.events.some(
      (e) =>
        e.family === "cleanup" &&
        e.stage === "failed" &&
        e.reason === "invalid_shared_configuration",
    ),
  );
  assert(!JSON.stringify(h.events).includes("bearer"));
});

test("shared failure terminates both live family stages with prefixes still attributed", () => {
  const h = harness();
  h.begin();
  h.arm();
  const broken = h.output.slice(0, 8);
  broken[5]++;
  h.io.metric_timing_frame(owner, broken, h.counter + 1);
  assert.equal(h.io.snapshot().state, "failed");
  for (const family of ["level", "detector-level"]) {
    assert.equal(h.io.snapshot().families[family].state, "cancelled");
    const stages = h.events
      .filter((e) => e.family === family)
      .map((e) => e.stage);
    assert(stages.indexOf("queued") < stages.indexOf("started"));
    assert.equal(stages.at(-1), "cancelled");
  }
});

test("sparse/malformed shared frames cannot stand in for executed receipts", () => {
  for (const selector of [
    "metric_configuration_frame",
    "metric_timing_frame",
  ]) {
    for (const invalid of [NaN, Infinity, "1", undefined]) {
      const h = harness();
      h.begin();
      h.arm();
      const row =
        selector === "metric_configuration_frame"
          ? h.output.slice(8, 20)
          : h.output.slice(0, 8);
      if (invalid === undefined) delete row[1];
      else row[1] = invalid;
      h.io[selector](owner, row, h.counter);
      assert.equal(h.io.snapshot().state, "failed");
      assert.equal(h.records.length, 0);
    }
  }
});

test("frozen sanitized attributed events, lifecycle ordering, bounded deadlines and configuration", () => {
  const h = harness();
  h.begin();
  h.arm();
  h.run();
  h.cleanup();
  assert(h.events.every((e) => Object.isFrozen(e) && Object.isFrozen(e.owner)));
  assert(
    h.events.every(
      (e) => e.owner.traceId === owner.traceId && e.elapsedMs >= 0,
    ),
  );
  assert.deepEqual(
    h.events.filter((e) => e.family === "control").map((e) => e.stage),
    ["queued", "progress", "started", "progress", "progress", "completed"],
  );
  assert(!JSON.stringify(h.events).includes("values"));
  const bad = harness();
  bad.begin();
  const config = { ...geometry() };
  delete config.bounds;
  assert.throws(
    () =>
      bad.io.configure_metric(owner, {
        ...config,
        totalSamples: config.totalSamples + 1,
      }),
    /configuration/,
  );
  assert.throws(
    () => bad.io.configure_metric(owner, { ...config, captureVector: 3 }),
    /configuration/,
  );
  assert.throws(() => bad.io.arm(owner), /configuration/);
});
