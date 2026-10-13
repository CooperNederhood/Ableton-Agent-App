const test = require("node:test");
const assert = require("node:assert/strict");
const { AudioListenerEngine, VERSION, LIMITS, dbfs, descriptor } = require("./audio_listener_engine.js");

const certificate = { validated: true, algorithmVersion: VERSION, hostVersion: "test-double",
  maxVersion: "test-double", launchAligned: true, requiredHostFlags: 3,
  uncertaintySamples: 64, descriptorOffsetSamples: 0, sampleRate: 48000, vectorSize: 64 };
const owner = { passId: "pass", connectionEpoch: "epoch" };
function fixture(options = {}) {
  let time = 0;
  const events = [], analysis = [];
  const engine = new AudioListenerEngine({ listenerId: "listener",
    certificate, now: () => time, emit: (e) => events.push(e),
    analysis: (...args) => analysis.push(args), ...options });
  const nativeIngest = engine.ingest.bind(engine);
  // Numeric/lifecycle fixture simulates a synchronized host/descriptor adapter.
  // This is explicitly not proof of that synchronization in real Max/Live.
  engine.ingest = (frame, owner) => {
    if (engine.host) engine.host.sample = frame.sample;
    return nativeIngest(frame, owner);
  };
  const host = (overrides = {}) => engine.configureHost({
    sampleRate: 48000, vectorSize: 64, sample: 10000, beat: 4,
    flags: 3, playing: false, dspOn: true, ...overrides,
  });
  host();
  function start(settings = {}, overrides = {}) {
    engine.prepare({ ...owner, startBeat: 4, endBeat: 8, settings, ...overrides });
    engine.arm(owner);
    host({ playing: true });
  }
  const frame = (i, overrides = {}) => ({ sample: 10000 + 4800 * i, beat: 4 + i / 5,
    peak: [1, 0.5], rms: [Math.SQRT1_2, Math.SQRT1_2 / 2], centroidHz: 1000,
    spectralEnergy: 10, windowSamples: 4800, ...overrides });
  return { engine, host, start, frame, events, analysis, nativeIngest, time: (t) => { time = t; } };
}

test("shipping uncertified engine refuses readiness; no invented flags/clock timing", () => {
  const f = fixture({ certificate: null });
  assert.throws(() => f.start(), /real_live_timing_validation_required/);
  assert.equal(f.engine.pass, null);
  assert.deepEqual(f.analysis.at(-1), [false, true]);
});
test("ready/armed waits until verified actual launch, not fire request", () => {
  const f = fixture();
  f.engine.prepare({ ...owner, startBeat: 8, endBeat: 12 });
  f.engine.arm(owner);
  assert.equal(f.engine.state, "armed");
  f.host({ playing: true, beat: 7.9 });
  assert.equal(f.engine.state, "armed");
  assert.deepEqual(f.analysis.at(-1), [false, true]);
  f.host({ playing: true, beat: 8, sample: 90000 });
  assert.equal(f.engine.pass.startSample, 90000);
  assert.equal(f.engine.state, "capturing");
  assert.deepEqual(f.analysis.at(-1), [true, true]);
});
test("missed quantized launch is failure, never retrospective claim", () => {
  const f = fixture();
  f.engine.prepare({ ...owner, startBeat: 4, endBeat: 8 });
  f.engine.arm(owner);
  f.host({ playing: true, beat: 4.01 });
  assert.equal(f.events.at(-1).reason, "missed_actual_launch_boundary");
  assert.equal(f.events.at(-1).observation, null);
});
test("finite silence is null dBFS/centroid with no false attacks", () => {
  const f = fixture(); f.start();
  for (let i = 1; i <= 3; i++) f.engine.ingest(f.frame(i,
    { peak: [0, 0], rms: [0, 0], centroidHz: null, spectralEnergy: 0 }), owner);
  const result = f.engine.cancel(owner);
  assert.deepEqual(result.observation.summaries, { peak: [0, 0], rmsDbfs: [null, null], centroidHz: null });
  assert.equal(result.observation.attacks.length, 0);
  assert.equal(JSON.stringify(result).includes("Infinity"), false);
});
test("channel independence, duration-weighted power RMS and energy-weighted centroid", () => {
  const f = fixture(); f.start();
  f.engine.ingest(f.frame(1, { peak: [1, 0], rms: [1, 0], centroidHz: 100, spectralEnergy: 1 }), owner);
  f.engine.ingest(f.frame(2, { peak: [0, 2], rms: [0, 2], centroidHz: 300, spectralEnergy: 3 }), owner);
  const result = f.engine.cancel(owner);
  const sum = result.observation.summaries;
  assert.deepEqual(sum.peak, [1, 2]); // no false 0dBFS clamp for clipped audio
  assert.ok(Math.abs(sum.rmsDbfs[0] + 3.01029995664) < 1e-8);
  assert.ok(Math.abs(sum.rmsDbfs[1] - 3.01029995664) < 1e-8);
  assert.equal(sum.centroidHz, 250);
});
test("envelope-rise threshold/minimum spacing, sustained level and weak rise", () => {
  const f = fixture(); f.start({ attackThresholdDb: 6, minAttackSpacingSamples: 14400 });
  const levels = [0, .1, .1, 0, .1, 0, .1];
  levels.forEach((level, i) => f.engine.ingest(f.frame(i + 1,
    { peak: [level, level], rms: [level, level] }), owner));
  const obs = f.engine.cancel(owner).observation;
  assert.deepEqual(obs.attacks.map((p) => p.sample), [19600, 34000]);
  assert.throws(() => fixture().start({ minAttackSpacingSamples: 10 }), /attack spacing/);
  const zeroThreshold = fixture(); zeroThreshold.start({ attackThresholdDb: 0 });
  for (let i = 1; i <= 3; i++) zeroThreshold.engine.ingest(zeroThreshold.frame(i), owner);
  assert.equal(zeroThreshold.engine.cancel(owner).observation.attacks.length, 1);
});
test("exact end completes only with final window coverage; no scheduler receipt coordinates", () => {
  const f = fixture(); f.start({}, { endBeat: 4.4 });
  f.engine.ingest(f.frame(1), owner);
  f.host({ playing: true, sample: 19600, beat: 4.4 });
  f.engine.ingest(f.frame(2), owner);
  const result = f.engine.finish();
  assert.equal(result.status, "complete");
  assert.equal(result.observation.startSample, 10000);
  assert.equal(result.observation.endSample, 19600);
  assert.equal(result.observation.complete, true);
  assert.equal(result.observation.algorithm.timingUncertaintySamples, 64);
  assert.deepEqual(f.analysis.at(-1), [false, true]);
});
test("missing first/next/final block and backward beat are explicit partial outcomes", () => {
  for (const which of ["first", "next", "beat", "final"]) {
    const f = fixture(); f.start();
    if (which === "first") f.engine.ingest(f.frame(2), owner);
    else {
      f.engine.ingest(f.frame(1), owner);
      if (which === "next") f.engine.ingest(f.frame(3), owner);
      if (which === "beat") f.engine.ingest(f.frame(2, { beat: 4.1 }), owner);
      if (which === "final") f.engine.finish();
    }
    assert.equal(f.events.at(-1).status, "partial", which);
    assert.equal(f.events.at(-1).observation.complete, false);
  }
});
test("duplicate snapshot doesn't consume budget; strict limits fail instead of coalescing", () => {
  const f = fixture(); f.start({}, { maxWindows: 2 });
  assert.equal(f.engine.ingest(f.frame(1), owner), true);
  assert.equal(f.engine.ingest(f.frame(1), owner), false);
  f.engine.ingest(f.frame(2), owner);
  f.engine.ingest(f.frame(3), owner);
  const result = f.events.at(-1);
  assert.equal(result.reason, "point_limit");
  assert.equal(result.observation.samples.length, 2);
  assert.equal(result.observation.reduction.originalSamples, 3);
  assert.equal(result.observation.reduction.truncated, true);
  assert.equal(result.observation.complete, false);
});
test("attack budget cannot yield complete observation", () => {
  const f = fixture(); f.start({}, { endBeat: 1000 });
  for (let i = 1; i <= 1025 && f.engine.pass; i++) {
    const level = i % 2 ? 1 : 0;
    f.engine.ingest(f.frame(i, { peak: [level, 0], rms: [level, 0], beat: 4 + i / 10 }), owner);
  }
  assert.equal(f.events.at(-1).status, "partial");
  // 1024-point bound is reached before a 513th attack. Attack bound is independently guarded.
  assert.ok(f.events.at(-1).observation.attacks.length <= LIMITS.attacks);
});
test("host stop, discontinuity, DSP change, flags, timeout, disconnect reset clear analysis", () => {
  for (const reason of ["stop", "seek", "dsp", "flags", "timeout", "disconnect"]) {
    const f = fixture(); f.start(); f.engine.ingest(f.frame(1), owner);
    if (reason === "stop") f.host({ playing: false });
    if (reason === "seek") { f.host({ playing: true, sample: 20000, beat: 5 }); f.host({ playing: true }); }
    if (reason === "dsp") f.host({ playing: true, sampleRate: 44100 });
    if (reason === "flags") f.host({ playing: true, flags: 0 });
    if (reason === "timeout") { f.time(300000); f.engine.tick(); }
    if (reason === "disconnect") f.engine.reset("disconnected");
    assert.equal(f.engine.pass, null, reason);
    assert.equal(f.events.at(-1).observation.complete, false, reason);
    assert.deepEqual(f.analysis.at(-1), [false, true], reason);
  }
});
test("ownership, epoch, concurrent pass, stale host and raw/malformed descriptor rejected", () => {
  const f = fixture(); f.start();
  assert.throws(() => f.engine.ingest(f.frame(1), { ...owner, connectionEpoch: "old" }), /ownership/);
  assert.throws(() => f.engine.prepare({ ...owner }), /busy/);
  assert.throws(() => f.engine.cancel({ ...owner, passId: "other" }), /ownership/);
  assert.throws(() => descriptor({ ...f.frame(1), waveform: [0, 1] }, 48000), /not a descriptor/);
  for (const patch of [{ sample: NaN }, { centroidHz: 24001 }, { rms: [2, 2] },
    { peak: [Infinity, 0] }, { spectralEnergy: -1 }]) {
    assert.throws(() => descriptor(f.frame(1, patch), 48000));
  }
  const stale = fixture(); stale.time(2000);
  assert.throws(() => stale.start(), /invalid_host_timing/);
});
test("armed launch timeout and fresh epoch after reset", () => {
  const f = fixture();
  f.engine.prepare({ ...owner, startBeat: 4, endBeat: 8 });
  f.engine.arm(owner);
  f.time(15000); f.engine.tick();
  assert.equal(f.events.at(-1).reason, "launch_timeout");
  f.host();
  const next = { passId: "next", connectionEpoch: "new" };
  f.engine.prepare({ ...next, startBeat: 4, endBeat: 8 });
  assert.throws(() => f.engine.arm(owner), /ownership/);
  f.engine.arm(next); f.engine.cancel(next);
  assert.equal(f.engine.pass, null);
});
test("silence floor, invalid infinity and positive over-unity amplitudes", () => {
  assert.equal(dbfs(0), null);
  assert.equal(dbfs(1e-7), null);
  assert.equal(dbfs(1), 0);
  assert.ok(dbfs(2) > 6);
  assert.throws(() => dbfs(Infinity));
});
test("native vs host sample seek drift is partial, and unsafe host change before arm is rejected", () => {
  const f = fixture(); f.start();
  f.host({ playing: true, sample: 900000, beat: 6 });
  f.nativeIngest(f.frame(1), owner);
  assert.equal(f.events.at(-1).reason, "host_sample_discontinuity");
  const g = fixture();
  g.engine.prepare({ ...owner, startBeat: 4, endBeat: 8 });
  g.host({ flags: 0 });
  assert.throws(() => g.engine.arm(owner), /invalid_host_timing/);
});
