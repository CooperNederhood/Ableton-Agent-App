const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { HostClockCollector } = require("./hosted_calibration_probe.js");
const TRACE = "2e86c266-c836-4b44-aeaf-5f5671664be7";

function setup() {
  let now = 0;
  const controls = [],
    output = [];
  const collector = new HostClockCollector({
    now: () => now,
    control: (...args) => controls.push(args),
    emit: (...args) => output.push(args),
  });
  return {
    collector,
    controls,
    output,
    advance(ms) {
      now += ms;
      collector.tick();
    },
    pair(i, change = () => {}, playing = true) {
      const sample = i * 1024;
      const host = [
        playing ? 1 : 0,
        playing ? (sample + 64) / 24000 : 0,
        100000 + sample + 64,
        31,
      ];
      const clock = [
        1000 + sample,
        playing ? (sample % 24000) / 24000 : 0.304,
        1000 + sample,
      ];
      const post = [...host];
      change(host, clock, post);
      collector.dsp([1, 48000, 64]);
      collector.pre(host);
      collector.clock(clock);
      collector.post(post);
    },
  };
}

test("bracketed host calibration validates caller before polling and cannot authorize production", () => {
  const s = setup();
  assert.throws(() => s.collector.start("foreign", TRACE), /ownership/);
  assert.throws(() => s.collector.start("runner-owned", "secret"), /trace/);
  assert.deepEqual(s.controls, []);
  s.collector.start("runner-owned", TRACE);
  s.collector.dsp([1, 48000, 64]);
  assert.throws(() => s.collector.start("runner-owned", TRACE), /active/);
  assert.equal(s.collector.result.productionReady, false);
  assert.equal(s.collector.result.nativeTiming, "UNVERIFIED");
});

test("actual DSP evidence is required and unsupported changes fail without sample publication", () => {
  for (const values of [
    null,
    [0, 48000, 64],
    [1, 44100, 64],
    [1, 48000, 128],
  ]) {
    const s = setup();
    s.collector.start("runner-owned", TRACE);
    s.collector.dsp(values);
    assert.equal(s.collector.result.reason, "unsupported_dsp");
    assert.equal(s.collector.result.frames.length, 0);
    assert.deepEqual(s.controls.at(-1), ["clock-poll", 0]);
  }
  const s = setup();
  s.collector.start("runner-owned", TRACE);
  s.collector.post([1, 0, 0, 31]);
  assert.equal(s.collector.result.reason, "dsp_not_observed");
});

test("native host clock wrapper exposes causal handlers and stops owned polling and timer on deletion", () => {
  const calls = [];
  let timer;
  const context = vm.createContext({
    Date,
    outlet: (...a) => calls.push(a),
    arrayfromargs: (a) => Array.from(a),
    Task: function () {
      timer = this;
      this.repeat = () => {};
      this.cancel = () => {
        this.cancelled = true;
      };
    },
  });
  vm.runInContext(
    fs.readFileSync(require.resolve("./hosted_calibration_probe.js"), "utf8"),
    context,
  );
  context.anchor_start("runner-owned", TRACE);
  context.anchor_dsp(1, 48000, 64);
  context.anchor_pre(1, 64 / 24000, 100064, 31);
  context.anchor_clock(1000, 0, 1000);
  context.anchor_post(1, 64 / 24000, 100064, 31);
  context.notifydeleted();
  assert.deepEqual(calls, [
    [1, 1],
    [1, 0],
  ]);
  assert.equal(timer.cancelled, true);
});

test("passive host-clock patch is deterministic, correctly bracketed and has no audio or transport control", async () => {
  const { hostClockDocument } = await import("./calibration-source.mjs");
  const document = hostClockDocument();
  assert.throws(
    () => hostClockDocument({ resourceDirectory: "relative" }),
    /absolute/,
  );
  const staged = hostClockDocument({
    resourceDirectory: "/engineering resources",
  });
  assert.equal(
    staged.patcher.boxes.find(({ box }) => box.id === "collector").box.text,
    'js "/engineering resources/hosted_calibration_probe.js"',
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(require.resolve("./host_clock_probe.maxpat"), "utf8"),
    ),
    document,
  );
  const text = document.patcher.boxes.map(({ box }) => box.text).join("\n");
  assert.doesNotMatch(
    text,
    /plugin~|plugout~|dac~|buffer~|live.object|node.script/,
  );
  const wires = document.patcher.lines.map(({ patchline: p }) => [
    p.source,
    p.destination,
  ]);
  for (const [outlet, target] of [
    [3, "dspOrder"],
    [2, "preOrder"],
    [1, "snapshot"],
    [0, "postOrder"],
  ]) {
    assert(
      wires.some(
        ([s, d]) => s[0] === "order" && s[1] === outlet && d[0] === target,
      ),
    );
  }
  assert(
    wires.some(
      ([s, d]) =>
        s[0] === "clock" && s[1] === 1 && d[0] === "channels" && d[1] === 0,
    ),
  );
  assert(
    wires.some(
      ([s, d]) =>
        s[0] === "clock" && s[1] === 1 && d[0] === "channels" && d[1] === 2,
    ),
  );
});

test("32 stable bracketed pairs retain exact counter/phase mapping, timing and bounded export", () => {
  const s = setup();
  s.collector.start("runner-owned", TRACE);
  for (let i = 0; i < 32; i++) {
    s.advance(10);
    s.pair(i);
  }
  const r = s.collector.result;
  assert.equal(r.outcome, "collected");
  assert.equal(r.clockOffsetSamples, 99064);
  assert.equal(r.phaseLagSamples, 64);
  assert.equal(r.hostBeatZeroSample, 100000);
  assert.equal(r.frames.length, 32);
  assert.equal(r.rejectedReads, 0);
  assert.deepEqual(s.controls, [
    ["clock-poll", 1],
    ["clock-poll", 0],
  ]);
  assert.deepEqual(
    r.events.map((e) => e.stage),
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
  r.events.forEach((e, i) => {
    assert.equal(e.traceId, TRACE);
    assert.equal(e.correlationId, TRACE);
    assert.equal(e.causationId, i ? r.events[i - 1].eventId : TRACE);
    assert(e.elapsedMs >= (i ? r.events[i - 1].elapsedMs : 0));
  });
  assert.equal(r.events.at(-1).elapsedMs, 320);
  s.collector.dump();
  assert.equal(JSON.parse(s.output[0][1]).chunkCount, 4);
  assert(
    s.output.slice(1).every(([, json]) => JSON.parse(json).frames.length === 8),
  );
});

test("stopped host has no invented beat-zero or phase binding", () => {
  const s = setup();
  s.collector.start("runner-owned", TRACE);
  for (let i = 0; i < 32; i++) s.pair(i, () => {}, false);
  assert.equal(s.collector.result.outcome, "collected");
  assert.equal(s.collector.result.phaseLagSamples, null);
  assert.equal(s.collector.result.hostBeatZeroSample, null);
});

test("torn reads and nonadvancing clocks are bounded, never averaged into a binding", () => {
  for (const kind of ["clock", "host", "missing", "stalled"]) {
    const s = setup();
    s.collector.start("runner-owned", TRACE);
    s.collector.dsp([1, 48000, 64]);
    if (kind === "stalled") s.pair(0);
    for (let i = 0; i < 32; i++) {
      if (kind === "missing") s.collector.post([1, 0, 0, 31]);
      else
        s.pair(kind === "stalled" ? 0 : i, (host, clock, post) => {
          if (kind === "clock") clock[2]++;
          if (kind === "host") post[2]++;
        });
    }
    assert.equal(s.collector.result.outcome, "failed", kind);
    assert.equal(s.collector.result.rejectedReads, 32);
    assert.deepEqual(s.controls.at(-1), ["clock-poll", 0]);
  }
});

test("counter, phase, transport and validity changes fail with retained partial evidence", () => {
  for (const kind of ["offset", "phase", "transport", "flags", "malformed"]) {
    const s = setup();
    s.collector.start("runner-owned", TRACE);
    s.pair(0);
    s.pair(1, (host, clock, post) => {
      if (kind === "offset") clock[0] = clock[2] = clock[0] + 1;
      if (kind === "phase") clock[1] += 1 / 24000;
      if (kind === "transport") host[0] = post[0] = 0;
      if (kind === "flags") host[3] = post[3] = 3;
      if (kind === "malformed") clock[1] = "credential-do-not-retain";
    });
    assert.equal(s.collector.result.outcome, "failed", kind);
    assert.equal(s.collector.result.frames.length, 1);
    assert(!JSON.stringify(s.collector.result).includes("credential"));
    assert.deepEqual(s.controls.at(-1), ["clock-poll", 0]);
  }
});

test("clock timeout and cancellation stop only owned polling, preserving bounded partial rows", () => {
  for (const cancel of [false, true]) {
    const s = setup();
    s.collector.start("runner-owned", TRACE);
    s.pair(0);
    if (cancel) {
      s.advance(100);
      s.collector.cancel();
      s.collector.cancel();
    } else s.advance(2000);
    assert.equal(s.collector.result.outcome, cancel ? "cancelled" : "failed");
    assert.equal(s.collector.result.frames.length, 1);
    assert.equal(s.controls.length, 2);
    assert.equal(
      s.collector.result.events.at(-1).elapsedMs,
      cancel ? 100 : 2000,
    );
    assert(!s.controls.some((c) => c.includes("stop_playing")));
  }
});
