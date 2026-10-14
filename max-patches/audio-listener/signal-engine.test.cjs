const test = require("node:test");
const assert = require("node:assert/strict");
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const { nativeHostBinding } = require("./audio_listener_native_coordinates.js");
const evidence = require("./fixtures/native-host-spectrum.json");

const owner = { passId: "native-pass", connectionEpoch: "native-connection" };
const context = {
  traceId: evidence.envelope.traceId,
  correlationId: "correlation",
  causationId: "control",
};
const certificate = {
  validated: true,
  algorithmVersion: VERSION,
  hostVersion: "test-double",
  maxVersion: "test-double",
  launchAligned: true,
  requiredHostFlags: 19,
  uncertaintySamples: 64,
  descriptorOffsetSamples: 0,
  sampleRate: 48000,
  vectorSize: 64,
};
const origin = evidence.nativeOrigin[2] + evidence.before.clockOffsetSamples;
const ack = () => ({
  nativeEpoch: 1,
  armCounter: evidence.nativeOrigin[1],
  hostBinding: evidence.before,
  launchClock: -1,
  sourceClock: -1,
  onsetCount: 0,
  rejected: 0,
  active: 0,
  launchPhaseSamples: -1,
  firstSourceClock: -1,
  completedSamples: 0,
});
const launch = () => ({
  nativeEpoch: 1,
  armCounter: evidence.nativeOrigin[1],
  launchClock: evidence.envelope.nativeMarker[1],
  launchPhaseSamples: evidence.envelope.nativeMarker[6],
  rejected: 0,
  active: 1,
});

function fixture(options = {}) {
  let now = 0;
  const events = [],
    analysis = [];
  const engine = new AudioListenerEngine({
    listenerId: "listener",
    certificate,
    launchAlignment: "signal",
    now: () => now,
    emit: (event) => events.push(event),
    analysis: (...values) => analysis.push(values),
    ...options,
  });
  // Timely host callbacks here are synthetic. Recorded native coordinates and
  // bracket evidence do not turn this engine test into actual runtime acceptance.
  const host = (overrides = {}) =>
    engine.configureHost({
      sampleRate: 48000,
      vectorSize: 64,
      tempoBpm: 120,
      sample: origin - 512,
      beat: 0,
      flags: 31,
      dspOn: true,
      playing: false,
      ...overrides,
    });
  host();
  const prepare = (overrides = {}) =>
    engine.prepare({
      ...owner,
      ...context,
      mode: "arrangement",
      startBeat: 0,
      endBeat: 4,
      ...overrides,
    });
  const arm = () => {
    prepare();
    return engine.arm({ ...owner, nativeEpoch: 1 });
  };
  const start = () => {
    arm();
    engine.acknowledgeNativeArm(ack(), owner);
    host({ playing: true, beat: 640 / 24000, sample: origin + 640 });
    engine.launchNative(launch(), owner);
  };
  const frame = (index) => {
    const envelope = evidence.envelope.frames[index - 1];
    const sample = origin + envelope[4];
    const spectral = evidence.spectrum.frames
      .filter((row) => row[4] + evidence.before.clockOffsetSamples <= sample)
      .at(-1);
    return {
      sample,
      beat: envelope[4] / 24000,
      peak: envelope.slice(0, 2),
      rms: envelope.slice(2, 4),
      centroidHz: spectral[1],
      spectralEnergy: spectral[2],
      windowSamples: 4800,
      spectralWindow: {
        startSample: spectral[3] + evidence.before.clockOffsetSamples,
        endSample: spectral[4] + evidence.before.clockOffsetSamples,
      },
    };
  };
  const ingest = (index, overrides = {}) => {
    const value = { ...frame(index), ...overrides };
    host({
      playing: true,
      sample: value.sample + 64,
      beat: (value.sample + 64 - origin) / 24000,
    });
    return engine.ingest(value, owner);
  };
  const postcheck = () => {
    const row = evidence.after.frames.at(-1);
    host({ playing: true, sample: row[2], beat: row[1] });
    return engine.confirmNativeHost(evidence.after, owner);
  };
  return {
    engine,
    events,
    analysis,
    host,
    prepare,
    arm,
    start,
    frame,
    ingest,
    postcheck,
    time: (value) => {
      now = value;
    },
  };
}

test("native binding derives offsets only from 32 coherent actual brackets", () => {
  assert.deepEqual(nativeHostBinding(evidence.before, false), {
    hostOffsetSamples: 842480212,
    hostBeatZeroSample: null,
    lastCounter: 166144448,
  });
  assert.equal(
    nativeHostBinding(evidence.after, true).hostBeatZeroSample,
    origin,
  );
  for (const change of [
    (value) => value.frames.pop(),
    (value) => {
      value.dsp[2] = 128;
    },
    (value) => {
      value.frames[2][6]++;
    },
    (value) => {
      value.frames[2][9]++;
    },
    (value) => {
      value.frames[2][4] = value.frames[1][4];
      value.frames[2][6] = value.frames[1][6];
    },
    (value) => {
      value.frames[2][2]++;
      value.frames[2][9]++;
    },
    (value) => {
      value.frames[2][3] = 3;
      value.frames[2][10] = 3;
    },
  ]) {
    const bad = JSON.parse(JSON.stringify(evidence.before));
    change(bad);
    assert.throws(() => nativeHostBinding(bad, false), /native_host/);
  }
  assert.throws(() => nativeHostBinding(evidence.after, false), /incoherent/);
});

test("signal mode preserves production denial and rejects unqualified scope before enabling DSP", () => {
  assert.throws(
    () => fixture({ certificate: null }).prepare(),
    /real_live_timing_validation_required/,
  );
  for (const changes of [
    { mode: "session" },
    { startBeat: 1 },
    { endBeat: 20.2 },
    { endBeat: 0.1 },
    { durationMs: 120000 },
    { durationMs: 1000 },
    { traceId: "" },
  ]) {
    const f = fixture();
    assert.throws(() => f.prepare(changes));
    assert.equal(f.engine.pass, null);
    assert(f.analysis.every(([enabled]) => !enabled));
  }
  const f = fixture();
  f.host({ tempoBpm: 121 });
  assert.throws(() => f.prepare(), /unsupported_native_capture_scope/);
});

test("signal arm waits for exact native acknowledgement and host notifications never launch or reset it", () => {
  const f = fixture();
  assert.deepEqual(f.arm(), { status: "waiting-native-arm" });
  assert.equal(f.engine.state, "native-arming");
  assert.deepEqual(f.analysis.at(-1), [true, true, { nativeEpoch: 1 }]);
  assert.throws(
    () => f.engine.acknowledgeNativeArm({ ...ack(), nativeEpoch: 2 }, owner),
    /epoch/,
  );
  assert.throws(
    () =>
      f.engine.acknowledgeNativeArm(
        { ...ack(), completedSamples: 4800 },
        owner,
      ),
    /ack/,
  );
  assert.throws(
    () =>
      f.engine.acknowledgeNativeArm(ack(), {
        ...owner,
        connectionEpoch: "foreign",
      }),
    /ownership/,
  );
  assert.deepEqual(f.engine.acknowledgeNativeArm(ack(), owner), {
    status: "ready",
  });
  assert.equal(f.engine.launchNative(launch(), owner), false);
  const calls = f.analysis.length;
  f.host({ playing: true, beat: 640 / 24000, sample: origin + 640 });
  assert.equal(f.engine.state, "armed");
  assert.equal(f.engine.pass.startSample, null);
  assert.equal(f.engine.launchNative(launch(), owner), true);
  assert.equal(f.engine.pass.startSample, origin);
  assert.equal(
    f.analysis.length,
    calls,
    "observing launch must not reset pre-roll",
  );
});

test("native source coordinates and FFT intervals produce canonical output only after independent postcheck", () => {
  const f = fixture();
  f.start();
  for (let i = 1; i <= 20; i++) assert.equal(f.ingest(i), true);
  assert.equal(f.postcheck(), true);
  const result = f.engine.finish();
  assert.equal(result.status, "complete");
  assert.equal(result.observation.startSample, origin);
  assert.equal(result.observation.endSample, origin + 96000);
  assert.equal(result.observation.samples.length, 20);
  assert.equal(result.observation.complete, true);
  assert.equal(f.engine.pass, null);
  assert.deepEqual(f.analysis.at(-1), [false, true]);
  const events = f.events.filter(
    (event) => event.type === "native-capture-stage",
  );
  assert.deepEqual(
    events.slice(0, 2).map((event) => event.stage),
    ["queued", "started"],
  );
  assert.equal(events.at(-1).stage, "completed");
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].traceId, context.traceId);
    assert.equal(events[i].correlationId, context.correlationId);
    assert.equal(
      events[i].causationId,
      i ? events[i - 1].eventId : context.causationId,
    );
    assert.equal(events[i].connectionEpoch, owner.connectionEpoch);
    assert.equal(events[i].nativeEpoch, 1);
  }
});

test("missing postcheck, future/gapped spectral windows and changed held values cannot claim complete", () => {
  const complete = fixture();
  complete.start();
  for (let i = 1; i <= 20; i++) complete.ingest(i);
  assert.equal(complete.engine.finish().reason, "native_post_binding_required");
  for (const mode of ["missing", "future", "stale", "beat", "hold"]) {
    const f = fixture();
    f.start();
    const frame = f.frame(1);
    f.host({
      playing: true,
      sample: frame.sample + 64,
      beat: (frame.sample + 64 - origin) / 24000,
    });
    if (mode === "missing") delete frame.spectralWindow;
    if (mode === "future")
      frame.spectralWindow = {
        startSample: frame.sample,
        endSample: frame.sample + 2048,
      };
    if (mode === "stale")
      frame.spectralWindow = { startSample: origin, endSample: origin + 2048 };
    if (mode === "beat") frame.beat += 0.000001;
    if (mode === "hold") {
      assert.equal(f.engine.ingest(frame, owner), true);
      frame.peak = [1, 1];
    }
    assert.equal(f.engine.ingest(frame, owner), false);
    assert.equal(f.engine.pass, null);
    assert.equal(f.events.at(-1).status, "partial");
    assert.deepEqual(f.analysis.at(-1), [false, true]);
  }
});

test("native failures, cancellation, stale epochs and deadlines release analysis without transport controls", () => {
  for (const mode of ["tempo", "offset", "cancel", "timeout"]) {
    const f = fixture();
    f.start();
    if (mode === "tempo")
      f.host({
        playing: true,
        sample: origin + 1024,
        beat: 1024 / 24000,
        tempoBpm: 121,
      });
    if (mode === "offset")
      f.host({ playing: true, sample: origin + 1025, beat: 1024 / 24000 });
    if (mode === "cancel") f.engine.cancel(owner);
    if (mode === "timeout") {
      f.time(4000);
      f.host({ playing: true, sample: origin + 192000, beat: 8 });
      f.engine.tick();
    }
    assert.equal(f.engine.pass, null, mode);
    assert.deepEqual(f.analysis.at(-1), [false, true]);
    const terminal = f.events
      .filter((event) => event.type === "native-capture-stage")
      .at(-1);
    assert.equal(terminal.stage, mode === "cancel" ? "cancelled" : "failed");
  }
  const f = fixture();
  f.arm();
  f.time(15000);
  f.engine.tick();
  assert.equal(f.events.at(-1).reason, "launch_timeout");
  assert.deepEqual(f.analysis.at(-1), [false, true]);
  assert.throws(() => f.engine.launchNative(launch(), owner), /ownership/);
});

test("native scope, early transport changes, invalid launch and changed post-binding remain fenced", () => {
  for (const mode of ["playing", "position"]) {
    const f = fixture();
    f.arm();
    f.host(mode === "playing" ? { playing: true } : { beat: 1 });
    assert.equal(
      f.events.at(-1).reason,
      "native_transport_changed_before_launch",
    );
    assert.deepEqual(f.analysis.at(-1), [false, true]);
  }
  for (const marker of [
    { ...launch(), nativeEpoch: 2 },
    { ...launch(), armCounter: 1 },
    { ...launch(), launchPhaseSamples: 65 },
    { ...launch(), active: 0 },
  ]) {
    const f = fixture();
    f.arm();
    f.engine.acknowledgeNativeArm(ack(), owner);
    assert.throws(() => f.engine.launchNative(marker, owner));
    assert.equal(f.engine.state, "armed");
    f.engine.cancel(owner);
    assert.deepEqual(f.analysis.at(-1), [false, true]);
  }
  const early = fixture();
  early.start();
  assert.throws(() => early.postcheck(), /not_covered/);
  early.engine.cancel(owner);
  const changed = fixture();
  changed.start();
  for (let i = 1; i <= 20; i++) changed.ingest(i);
  const bad = JSON.parse(JSON.stringify(evidence.after));
  for (const row of bad.frames) {
    row[2]++;
    row[9]++;
  }
  assert.throws(
    () => changed.engine.confirmNativeHost(bad, owner),
    /post_binding/,
  );
  changed.engine.cancel(owner);
  const stale = fixture();
  stale.start();
  for (let i = 1; i <= 20; i++) stale.ingest(i);
  stale.postcheck();
  stale.time(1001);
  assert.equal(stale.engine.finish().status, "partial");
  assert.deepEqual(stale.analysis.at(-1), [false, true]);
});

test("native holds are value-based while FFT grid changes fail even inside the latest-frame interval", () => {
  const f = fixture();
  f.start();
  f.ingest(1);
  const duplicate = Object.fromEntries(Object.entries(f.frame(1)).reverse());
  assert.equal(f.engine.ingest(duplicate, owner), false);
  assert.equal(f.engine.pass.points.length, 1);
  const next = f.frame(2);
  next.spectralWindow.startSample++;
  next.spectralWindow.endSample++;
  f.host({
    playing: true,
    sample: next.sample + 64,
    beat: (next.sample + 64 - origin) / 24000,
  });
  assert.equal(f.engine.ingest(next, owner), false);
  assert.equal(f.events.at(-1).reason, "native_descriptor_coordinates");
  assert.deepEqual(f.analysis.at(-1), [false, true]);
});
