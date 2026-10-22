const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { Buffer } = require("node:buffer");
const { HostedCalibrationCollector } = require("./hosted_calibration_probe.js");
const TRACE = "52b546a7-a54c-470d-921a-d55708538365";

test("Max probe remains valid ES5 without strict-eval handler isolation", () => {
  const parser = createRequire(require.resolve("eslint/package.json"))(
    "espree",
  );
  const source = fs.readFileSync(
    require.resolve("./hosted_calibration_probe.js"),
    "utf8",
  );
  assert.doesNotThrow(() => parser.parse(source, { ecmaVersion: 5 }));
});

function setup() {
  let now = 0;
  const controls = [];
  const output = [];
  const collector = new HostedCalibrationCollector({
    now: () => now,
    emit: (...args) => output.push(args),
    control: (...args) => controls.push(args),
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
      collector.start("runner-owned", TRACE);
      collector.frame([0, 0, 0, 0, 0, 0, 0]);
    },
  };
}
function packet(sample) {
  if (sample === 4800) return [0, 0, 0, 0, sample, 0, 0];
  return [0.5, 0.5, 0.35, 0.35, sample, 440, 524288];
}

test("bounded native collection rejects absent ownership/trace before controls", () => {
  const s = setup();
  assert.throws(() => s.collector.start("user-process", TRACE), /ownership/);
  assert.throws(() => s.collector.start("runner-owned", "secret"), /trace/);
  assert.throws(() => s.collector.start("runner-owned", TRACE + "\n"), /trace/);
  assert.deepEqual(s.controls, []);
  assert.throws(() => s.collector.dump(), /not_ready/);
});

test("source fires once only after observed native reset, never on stale packets", () => {
  const s = setup();
  s.collector.start("runner-owned", TRACE);
  s.collector.frame(packet(240000));
  assert.deepEqual(s.controls, [["analysis", 1, 1, 48000]]);
  s.advance(25);
  s.collector.frame([0, 0, 0, 0, 0, 0, 0]);
  s.collector.frame([0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.controls.length, 1);
  s.advance(100);
  s.collector.frame(packet(4800));
  assert.deepEqual(s.controls[1], ["source", "call", "fire"]);
  assert.equal(s.controls.length, 2);
  assert.equal(s.collector.result.sourceRequestedAtMs, 125);
  assert.throws(() => s.collector.start("runner-owned", TRACE), /active/);
});

test("100 contiguous native windows survive held duplicates and export in bounded chunks", () => {
  const s = setup();
  s.start();
  for (let i = 1; i <= 100; i++) {
    s.advance(100);
    s.collector.frame(packet(i * 4800));
    s.collector.frame(packet(i * 4800));
  }
  const report = s.collector.result;
  assert.equal(report.outcome, "collected");
  assert.equal(report.productionReady, false);
  assert.equal(report.nativeTiming, "UNVERIFIED");
  assert.equal(report.frames.length, 100);
  assert.deepEqual(s.controls.at(-1), ["analysis", 0, 1, 48000]);
  assert.deepEqual(
    report.events.map((e) => e.stage),
    [
      "queued",
      "started",
      "progress",
      "progress",
      "progress",
      "progress",
      "completed",
    ],
  );
  for (const [index, event] of report.events.entries()) {
    assert.equal(event.traceId, TRACE);
    assert.equal(event.correlationId, TRACE);
    assert.equal(
      event.causationId,
      index ? report.events[index - 1].eventId : TRACE,
    );
    assert.equal(
      event.elapsedMs,
      index < 2 ? 0 : Math.min((index - 1) * 2500, 10000),
    );
  }
  s.collector.dump();
  const header = JSON.parse(s.output[0][1]);
  assert.equal(header.frameCount, 100);
  assert.equal(header.chunkCount, 13);
  const chunks = s.output.slice(1).map((v) => JSON.parse(v[1]));
  assert.deepEqual(
    chunks.flatMap((v) => v.frames),
    report.frames,
  );
  assert.ok(
    chunks.every(
      (v, i) => v.index === i && v.traceId === TRACE && v.frames.length <= 8,
    ),
  );
  assert.ok(s.output.every((v) => v[1].length < 4096));
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("gaps, resets, invalid levels and malformed packets fail visibly and reset analysis", () => {
  const bad = [
    null,
    "invalid",
    { length: 7 },
    packet(9600),
    packet(4801),
    packet(-1),
    [0.5, 0.5, 0.35, 0.35, 4800, 440, 524288],
    [0, 0, 0, 0, 4800, 440, 1],
    [0.5, 0.5, 1, 0.35, 4800, 440, 1],
    [0.5, 0.5, 0.35, 0.35, 4800, 24001, 1],
    [0.5, 0.5, 0.35, 0.35, 4800, 440, Infinity],
    ["credential", 0, 0, 0, 4800, 0, 0],
    [],
  ];
  for (const values of bad) {
    const s = setup();
    s.start();
    s.collector.frame(values);
    assert.equal(s.collector.result.outcome, "failed");
    assert.deepEqual(s.controls.at(-1), ["analysis", 0, 1, 48000]);
    assert.equal(s.collector.result.frames.length, 0);
    assert.equal(s.collector.result.events.at(-1).stage, "failed");
    assert.ok(!JSON.stringify(s.collector.result).includes("credential"));
  }
  const s = setup();
  s.start();
  s.collector.frame(packet(4800));
  s.collector.frame([0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.collector.result.reason, "descriptor_gap_or_reset");
});

test("reset/collection timeouts and cancellation preserve partial evidence and never stop transport", () => {
  for (const reset of [false, true]) {
    const s = setup();
    s.collector.start("runner-owned", TRACE);
    if (reset) s.collector.frame([0, 0, 0, 0, 0, 0, 0]);
    s.advance(12000);
    assert.equal(
      s.collector.result.reason,
      reset ? "collection_timeout" : "reset_timeout",
    );
    assert.equal(s.collector.result.events.at(-1).stage, "failed");
  }
  const s = setup();
  s.start();
  s.collector.frame(packet(4800));
  s.collector.cancel();
  s.collector.cancel();
  s.collector.frame(packet(9600));
  assert.equal(s.collector.result.frames.length, 1);
  assert.equal(s.collector.result.events.at(-1).stage, "cancelled");
  assert.equal(s.controls.filter((v) => v[1] === 0).length, 1);
  assert.ok(!JSON.stringify(s.controls).match(/stop|rewind/));
});

test("Max message wrapper emits bounded denials and cancels native analysis and timer on deletion", () => {
  const output = [];
  let tick;
  let timerCancelled = false;
  const context = vm.createContext({
    autowatch: 1,
    inlets: 1,
    outlets: 1,
    outlet: (...args) => output.push(args),
    arrayfromargs: (args) => Array.from(args),
    Task: function (callback) {
      tick = callback;
      this.repeat = () => {};
      this.cancel = () => {
        timerCancelled = true;
      };
    },
  });
  const source = fs.readFileSync(
    require.resolve("./hosted_calibration_probe.js"),
    "utf8",
  );
  vm.runInContext(`eval(${JSON.stringify(source)})`, context);
  context.start("wrong", "secret");
  assert.deepEqual(output.pop(), [
    0,
    "rejected",
    "invalid_start_or_active_collection",
  ]);
  context.start("runner-owned", TRACE);
  context.list(0, 0, 0, 0, 0, 0, 0);
  context.list(0, 0, 0, 0, 4800, 0, 0);
  assert.ok(output.some((v) => JSON.stringify(v) === '[2,"call","fire"]'));
  tick();
  context.notifydeleted();
  assert.deepEqual(output.at(-1), [1, "analysis", 0, 1, 48000]);
  assert.equal(timerCancelled, true);
  context.dump();
  const header = output.find((v) => v[0] === 0 && v[1] === "header");
  assert.match(header[2], /^[a-f0-9]+$/);
  assert.equal(
    JSON.parse(Buffer.from(header[2], "hex").toString("utf8")).outcome,
    "cancelled",
  );
});

test("complete Max export preserves all 100 numeric frames through punctuation-safe chunks", () => {
  const output = [];
  const context = vm.createContext({
    autowatch: 1,
    inlets: 1,
    outlets: 1,
    outlet: (...args) => output.push(args),
    arrayfromargs: (args) => Array.from(args),
    Task: function () {
      this.repeat = () => {};
      this.cancel = () => {};
    },
  });
  const source = fs.readFileSync(
    require.resolve("./hosted_calibration_probe.js"),
    "utf8",
  );
  vm.runInContext(`eval(${JSON.stringify(source)})`, context);
  context.start("runner-owned", TRACE);
  context.list(0, 0, 0, 0, 0, 0, 0);
  for (let index = 1; index <= 100; index++)
    context.list(...packet(index * 4800));
  context.dump();
  const wire = output.filter((v) => v[0] === 0);
  assert.equal(wire.length, 14);
  for (const message of wire) {
    assert.match(message[2], /^[a-f0-9]+$/);
    assert.ok(message[2].length <= 8192);
  }
  const [header, ...chunks] = wire.map((v) =>
    JSON.parse(Buffer.from(v[2], "hex").toString("utf8")),
  );
  assert.equal(header.frameCount, 100);
  assert.equal(header.chunkCount, 13);
  assert.equal(header.productionReady, false);
  assert.equal(header.nativeTiming, "UNVERIFIED");
  assert.deepEqual(
    chunks.map((v) => v.index),
    Array.from({ length: 13 }, (_, i) => i),
  );
  assert.ok(chunks.every((v) => v.traceId === TRACE));
  assert.deepEqual(
    chunks.flatMap((v) => v.frames),
    Array.from({ length: 100 }, (_, i) => packet((i + 1) * 4800)),
  );
  context.notifydeleted();
});
