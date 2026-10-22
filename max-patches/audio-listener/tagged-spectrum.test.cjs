const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { TaggedSpectrumCollector } = require("./hosted_calibration_probe.js");
const TRACE = "f3e1e775-ff20-4d2c-bc70-c043b24b5905";
function setup() {
  let now = 0;
  const output = [];
  const c = new TaggedSpectrumCollector({
    now: () => now,
    emit: (...a) => output.push(a),
  });
  c.start("runner-owned", TRACE);
  return {
    c,
    output,
    advance(ms) {
      now += ms;
      c.tick();
    },
  };
}
const frame = (i) => [
  12048 + i * 2048,
  440,
  100,
  10000 + i * 2048,
  12048 + i * 2048,
  1,
];
test("unverified native reload is denied without altering owned Gen ports or active collections", () => {
  const calls = [],
    reloads = [];
  const spectrum = { message: (...a) => reloads.push(["fft", ...a]) };
  const objects = {
    ml_synced_gen: { message: (...a) => reloads.push(["envelope", ...a]) },
    ml_synced_clockSplit: { message: (...a) => reloads.push(["clock", ...a]) },
    ml_synced_fft: { subpatcher: () => ({ getnamed: () => spectrum }) },
  };
  const context = vm.createContext({
    Date,
    patcher: { getnamed: (name) => objects[name] },
    outlet: (...a) => calls.push(a),
    arrayfromargs: (a) => Array.from(a),
    Task: function () {
      this.repeat = () => {};
      this.cancel = () => {};
    },
  });
  vm.runInContext(
    fs.readFileSync(require.resolve("./hosted_calibration_probe.js"), "utf8"),
    context,
  );
  context.reload_native();
  assert.deepEqual(reloads, []);
  assert.deepEqual(calls.at(-1), [
    0,
    "rejected",
    "native_probe_recreation_required",
  ]);
  context.combined_start("runner-owned", TRACE, 1);
  context.reload_native();
  assert.equal(reloads.length, 0);
  assert.deepEqual(calls.at(-1), [0, "rejected", "native_collection_active"]);
  context.combined_cancel();
  objects.ml_synced_fft = null;
  context.reload_native();
  assert.deepEqual(calls.at(-1), [
    0,
    "rejected",
    "native_probe_recreation_required",
  ]);
});
test("64 tagged frames retain source intervals, traced lifecycle and schema-disambiguated chunks", () => {
  const s = setup();
  for (let i = 0; i < 64; i++) {
    s.advance(43);
    s.c.frame(frame(i));
    s.c.frame(frame(i));
  }
  assert.equal(s.c.result.outcome, "collected");
  assert.equal(s.c.result.frames.length, 64);
  assert.equal(s.c.result.initialInvalidFrames, 1);
  assert.equal(s.c.result.productionReady, false);
  s.c.result.events.forEach((e, i) => {
    assert.equal(e.eventId, `${TRACE}:fft:${i}`);
    assert.equal(e.causationId, i ? s.c.result.events[i - 1].eventId : TRACE);
    assert.equal(e.traceId, TRACE);
    assert.equal(e.correlationId, TRACE);
  });
  s.c.dump();
  assert.equal(JSON.parse(s.output[0][1]).chunkCount, 8);
  assert(
    s.output
      .slice(1)
      .every(
        ([, json]) => JSON.parse(json).schema === "tagged-native-spectrum/v1",
      ),
  );
});
test("spectral gaps, reset, changed holds, malformed values and clock errors preserve partial failures", () => {
  for (const mode of [
    "gap",
    "reset",
    "hold",
    "clock",
    "shape",
    "invalid-window",
  ]) {
    const { c } = setup();
    c.frame(frame(0));
    const next = frame(1);
    if (mode === "gap") {
      next[0] += 2048;
      next[3] += 2048;
      next[4] += 2048;
    }
    if (mode === "reset") {
      next[0] -= 4096;
      next[3] -= 4096;
      next[4] -= 4096;
    }
    if (mode === "hold") {
      next.splice(0, 6, ...frame(0));
      next[1] = 450;
    }
    if (mode === "clock") next[5]++;
    if (mode === "shape") next[1] = "credential-do-not-retain";
    if (mode === "invalid-window") next[3]++;
    c.frame(next);
    assert.equal(c.result.outcome, "failed", mode);
    assert.equal(c.result.frames.length, 1);
    assert(!JSON.stringify(c.result).includes("credential"));
  }
});
test("spectral startup, torn snapshots, deadlines and cancellation are bounded", () => {
  const s = setup();
  s.c.frame([-1, 0, 0, -1, -1, 1]);
  assert.equal(s.c.result.frames.length, 0);
  for (let i = 0; i < 32; i++) {
    const f = frame(i);
    f[4]++;
    s.c.frame(f);
  }
  assert.equal(s.c.result.reason, "unstable_spectral_read");
  const deadline = setup();
  deadline.advance(5000);
  assert.equal(deadline.c.result.reason, "spectral_timeout");
  const cancelled = setup();
  cancelled.c.frame(frame(0));
  cancelled.advance(10);
  cancelled.c.cancel();
  cancelled.c.cancel();
  cancelled.c.frame(frame(1));
  assert.equal(cancelled.c.result.outcome, "cancelled");
  assert.equal(cancelled.c.result.frames.length, 1);
});
