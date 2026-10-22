const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { HostedCalibrationCollector } = require("./hosted_calibration_probe.js");
const TRACE = "c1809bda-921e-4400-8748-5aa7c211b0f7";
const ack = (epoch = 1) => [0, epoch, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0];
const packet = (sample, epoch = 1) => [
  sample,
  epoch,
  513,
  513,
  1,
  0,
  1,
  1,
  513,
  0.5,
  0.5,
  0.35,
  0.35,
];
function setup() {
  let now = 0;
  const controls = [],
    output = [];
  const collector = new HostedCalibrationCollector({
    now: () => now,
    control: (...a) => controls.push(a),
    emit: (...a) => output.push(a),
  });
  return {
    collector,
    controls,
    output,
    advance(ms) {
      now += ms;
      collector.tick();
    },
    start() {
      collector.startSynchronized("runner-owned", TRACE, 1);
      collector.frame(ack());
    },
  };
}

test("synchronized collector validates ownership, trace and monotonic epoch before any native control", () => {
  const s = setup();
  for (const epoch of [0, -1, 0.5, NaN, Infinity, 1000001])
    assert.throws(
      () => s.collector.startSynchronized("runner-owned", TRACE, epoch),
      /epoch/,
    );
  assert.throws(
    () => s.collector.startSynchronized("foreign", TRACE, 1),
    /ownership/,
  );
  assert.throws(
    () => s.collector.startSynchronized("runner-owned", "secret", 1),
    /trace/,
  );
  assert.deepEqual(s.controls, []);
  s.start();
  assert.throws(
    () => s.collector.startSynchronized("runner-owned", TRACE, 2),
    /active/,
  );
  s.collector.cancel();
  assert.throws(
    () => s.collector.startSynchronized("runner-owned", TRACE, 1),
    /epoch/,
  );
});

test("only a complete same-packet native arm/reset acknowledgement starts transport once", () => {
  const s = setup();
  s.collector.startSynchronized("runner-owned", TRACE, 1);
  s.collector.frame(packet(240000, 0));
  assert.deepEqual(s.controls, [
    ["native", "cancel", 0],
    ["native", "epoch", 1],
  ]);
  s.advance(50);
  s.collector.frame(ack());
  s.collector.frame(ack());
  assert.deepEqual(s.controls.at(-1), ["source", "call", "start_playing"]);
  assert.equal(s.controls.filter((c) => c[0] === "source").length, 1);
  assert.equal(s.collector.result.sourceRequestedAtMs, 50);
  assert.deepEqual(
    s.collector.result.events.map((e) => e.stage),
    ["queued", "started", "armed", "source-start-requested"],
  );
});

test("100 epoch-bound native windows complete with bounded traced export and no transport stop", () => {
  const s = setup();
  s.start();
  for (let i = 1; i <= 100; i++) {
    s.advance(100);
    s.collector.frame(packet(i * 4800));
    s.collector.frame(packet(i * 4800));
  }
  const result = s.collector.result;
  assert.equal(result.outcome, "collected");
  assert.equal(result.schema, "hosted-native-envelope/v1");
  assert.equal(result.productionReady, false);
  assert.equal(result.nativeTiming, "UNVERIFIED");
  assert.equal(result.originClock, 512);
  assert.equal(result.frames.length, 100);
  assert.deepEqual(s.controls.at(-1), ["native", "epoch", 0]);
  assert(s.controls.every((c) => !c.includes("stop_playing")));
  assert.deepEqual(
    result.events.map((e) => e.stage),
    [
      "queued",
      "started",
      "armed",
      "source-start-requested",
      "native-launched",
      "progress",
      "progress",
      "progress",
      "progress",
      "completed",
    ],
  );
  result.events.forEach((event, i) => {
    assert.equal(event.traceId, TRACE);
    assert.equal(event.correlationId, TRACE);
    assert.equal(event.causationId, i ? result.events[i - 1].eventId : TRACE);
    assert.equal(
      event.elapsedMs,
      i < 4 ? 0 : i === 4 ? 100 : Math.min(10000, (i - 4) * 2500),
    );
  });
  s.collector.dump();
  const header = JSON.parse(s.output[0][1]);
  assert.equal(header.frameCount, 100);
  assert.equal(header.chunkCount, 13);
  assert.equal(header.nativeEpoch, 1);
  assert(!("frames" in header));
  assert(
    s.output.slice(1).every(([, json]) => JSON.parse(json).frames.length <= 8),
  );
  assert(JSON.stringify(result).length < 65536);
});

test("changed held descriptors, gaps, missing boundary and foreign epochs never become complete", () => {
  for (const kind of ["hold", "gap", "boundary", "epoch", "malformed"]) {
    const s = setup();
    s.start();
    s.collector.frame(packet(4800));
    let next = packet(9600);
    if (kind === "hold") {
      next = packet(4800);
      next[9] = 0.6;
    }
    if (kind === "gap") next[0] = 14400;
    if (kind === "boundary") next[7] = 2;
    if (kind === "epoch") next[1] = 2;
    if (kind === "malformed") next[9] = "credential-must-not-be-retained";
    s.collector.frame(next);
    assert.equal(s.collector.result.outcome, "failed", kind);
    assert.deepEqual(s.controls.at(-1), ["native", "epoch", 0]);
    assert(!JSON.stringify(s.collector.result).includes("credential"));
  }
});

test("all native rejection codes, early launch and dirty reset explicitly fail or cancel before fixture playback", () => {
  for (let code = 1; code <= 11; code++) {
    const s = setup();
    s.collector.startSynchronized("runner-owned", TRACE, 1);
    const rejected = ack();
    rejected[5] = code;
    s.collector.frame(rejected);
    assert.equal(
      s.collector.result.outcome,
      code === 4 ? "cancelled" : "failed",
    );
    assert.equal(s.collector.result.reason, "native_rejected_" + code);
    assert(!s.controls.some((c) => c[0] === "source"));
  }
  for (const dirty of [packet(0), [...ack().slice(0, 9), 0.1, 0, 0, 0]]) {
    const s = setup();
    s.collector.startSynchronized("runner-owned", TRACE, 1);
    s.collector.frame(dirty);
    assert.equal(s.collector.result.outcome, "failed");
    assert(!s.controls.some((c) => c[0] === "source"));
  }
});

test("native arm/capture deadlines and repeated cancellation bound cleanup without stopping playback", () => {
  for (const started of [false, true]) {
    const s = setup();
    s.collector.startSynchronized("runner-owned", TRACE, 1);
    if (started) s.collector.frame(ack());
    s.advance(12000);
    assert.equal(s.collector.result.outcome, "failed");
    assert.equal(
      s.collector.result.reason,
      started ? "collection_timeout" : "native_arm_timeout",
    );
    assert.deepEqual(s.controls.at(-1), ["native", "epoch", 0]);
  }
  const s = setup();
  s.start();
  s.collector.frame(packet(4800));
  s.advance(200);
  s.collector.cancel();
  s.collector.cancel();
  s.collector.frame(packet(9600));
  assert.equal(s.collector.result.outcome, "cancelled");
  assert.equal(s.collector.result.frames.length, 1);
  assert.equal(s.collector.result.events.at(-1).elapsedMs, 200);
  assert.equal(
    s.controls.filter((c) => c[1] === "epoch" && c[2] === 0).length,
    1,
  );
  assert(s.controls.every((c) => !c.includes("stop_playing")));
});

test("native Max wrapper routes synchronized frames, starts the resolved Song and disarms on deletion", () => {
  const calls = [];
  let timer;
  const context = vm.createContext({
    Date,
    outlet: (...args) => calls.push(args),
    arrayfromargs: (args) => Array.from(args),
    Task: function (fn) {
      timer = this;
      this.repeat = () => {};
      this.cancel = () => {
        this.cancelled = true;
      };
      this.fn = fn;
    },
  });
  vm.runInContext(
    fs.readFileSync(require.resolve("./hosted_calibration_probe.js"), "utf8"),
    context,
  );
  context.start_synchronized("runner-owned", TRACE, 1);
  context.list(...ack());
  context.list(...packet(4800));
  context.notifydeleted();
  assert(
    calls.some(
      (c) => JSON.stringify(c) === JSON.stringify([2, "call", "start_playing"]),
    ),
  );
  assert.deepEqual(calls.at(-1), [1, "epoch", 0]);
  assert.equal(timer.cancelled, true);
});
