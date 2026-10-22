const test = require("node:test");
const assert = require("node:assert/strict");
const {
  nativePreflightTiming,
} = require("./audio_listener_native_coordinates.js");
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const { syntheticPreflight } = require("./native-preflight-fixture.cjs");

const owner = { passId: "pass", connectionEpoch: "connection" };
const command = {
  ...owner,
  traceId: "trace",
  correlationId: "correlation",
  causationId: "cause",
  mode: "arrangement",
  startBeat: 0,
  endBeat: 4,
};
function fixture() {
  let now = 0;
  const preflight = syntheticPreflight();
  const row = preflight.before.frames[31];
  const host = {
    playing: false,
    dspOn: true,
    sampleRate: 48000,
    vectorSize: 64,
    sample: row[2] + 64,
    beat: 0,
    tempoBpm: 120,
    flags: 31,
  };
  const analysis = [],
    events = [];
  const engine = new AudioListenerEngine({
    listenerId: "listener",
    launchAlignment: "signal",
    now: () => now,
    analysis: (...values) => analysis.push(values),
    emit: (event) => events.push(event),
  });
  engine.configureHost(host);
  return {
    preflight,
    host,
    engine,
    analysis,
    events,
    time: (value) => {
      now = value;
    },
  };
}

test("signal preparation consumes fresh observed geometry without an injected certificate", () => {
  const f = fixture();
  assert.deepEqual(f.engine.prepare(command, f.preflight), {
    status: "prepared",
  });
  const timing = f.engine.pass.certificate;
  assert.equal(timing.validated, undefined);
  assert.equal(timing.sampleRate, 48000);
  assert.equal(timing.vectorSize, 64);
  assert.equal(
    timing.fftGrid,
    (f.preflight.spectrum[3] + timing.hostOffsetSamples) % 2048,
  );
  assert.equal(timing.invalidFrames, 353);
  assert(f.analysis.every(([on]) => on === false));
  f.engine.cancel(owner);
  assert.equal(f.engine.pass, null);
  assert.deepEqual(f.analysis.at(-1), [false, true]);
});

test("an old approved certificate cannot substitute for per-pass native preflight", () => {
  const f = fixture();
  f.engine.certificate = {
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
  assert.throws(() => f.engine.prepare(command), /native_preflight_required/);
  assert.equal(f.engine.pass, null);
  assert(f.analysis.every(([on]) => on === false));
});

test("preflight rejects missing, torn, sparse, moving, stale and unbounded native input", () => {
  const mutations = [
    (p) => {
      p.before.frames.pop();
    },
    (p) => {
      p.before.dsp[2] = 128;
    },
    (p) => {
      p.before.frames[1][6]++;
    },
    (p) => {
      delete p.before.frames[1][5];
    },
    (p) => {
      p.before.frames[1][1] = p.before.frames[1][8] = 0.1;
    },
    (p) => {
      p.before.frames[1][5] += 0.001;
    },
    (p) => {
      p.before.frames[1][3] = p.before.frames[1][10] = 3;
    },
    (p) => {
      p.before.frames[0][2] -= 48000;
      p.before.frames[0][9] -= 48000;
      p.before.frames[0][4] -= 48000;
      p.before.frames[0][6] -= 48000;
    },
    (p) => {
      p.fftInformation[1] = 1024;
    },
    (p) => {
      delete p.fftInformation[1];
    },
    (p) => {
      p.before.rawAudio = [0.5];
    },
    (p) => {
      p.validated = true;
    },
  ];
  for (const change of mutations) {
    const f = fixture();
    change(f.preflight);
    assert.throws(() => f.engine.prepare(command, f.preflight), /native_/);
    assert.equal(f.engine.pass, null);
    assert(f.analysis.every(([on]) => on === false));
  }
});

test("preflight requires a recent complete tagged FFT and a finite invalid-frame baseline", () => {
  const mutations = [
    (packet) => {
      packet.pop();
    },
    (packet) => {
      delete packet[1];
    },
    (packet) => {
      packet[4]++;
    },
    (packet) => {
      packet[3]++;
    },
    (packet) => {
      packet[0] += 4096;
      packet[3] += 4096;
      packet[4] += 4096;
    },
    (packet) => {
      packet[0] -= 4096;
      packet[3] -= 4096;
      packet[4] -= 4096;
    },
    (packet) => {
      packet[1] = 1;
    },
    (packet) => {
      packet[1] = Infinity;
    },
    (packet) => {
      packet[2] = -1;
    },
    (packet) => {
      packet[1] = 24001;
      packet[2] = 1;
    },
    (packet) => {
      packet[5] = 0.5;
    },
    (packet) => {
      packet[5] = Number.MAX_SAFE_INTEGER + 1;
    },
  ];
  for (const change of mutations) {
    const f = fixture();
    change(f.preflight.spectrum);
    assert.throws(
      () => nativePreflightTiming(f.preflight, f.host),
      /preflight_spectrum/,
    );
  }
});

test("preflight host freshness is bounded by observed samples, not receipt timestamps alone", () => {
  for (const changes of [
    { sample: -1 },
    { sample: fixture().host.sample + 48000 },
    { playing: true },
    { dspOn: false },
    { tempoBpm: 121 },
    { flags: 19.5 },
  ]) {
    const f = fixture();
    assert.throws(
      () => nativePreflightTiming(f.preflight, { ...f.host, ...changes }),
      /preflight/,
    );
  }
  const f = fixture();
  f.time(1001);
  assert.throws(
    () => f.engine.prepare(command, f.preflight),
    /invalid_host_timing/,
  );
  assert.equal(f.engine.pass, null);
});

test("preflight evidence is defensively retained and cannot be swapped at native reset acknowledgement", () => {
  const f = fixture();
  f.engine.prepare(command, f.preflight);
  const retained = f.engine.pass.certificate.before;
  f.preflight.before.frames[0][5] = 0.75;
  f.preflight.before.dsp[1] = 96000;
  assert.equal(retained.frames[0][5], 0.25);
  assert.equal(retained.dsp[1], 48000);
  assert(Object.isFrozen(retained.frames[0]));
  f.engine.arm({ ...owner, nativeEpoch: 1 });
  const marker = {
    nativeEpoch: 1,
    armCounter: f.host.sample - f.engine.pass.certificate.hostOffsetSamples,
    hostBinding: {
      ...retained,
      frames: retained.frames.map((row) => [...row]),
    },
    launchClock: -1,
    sourceClock: -1,
    onsetCount: 0,
    rejected: 0,
    active: 0,
    launchPhaseSamples: -1,
    firstSourceClock: -1,
    completedSamples: 0,
  };
  marker.hostBinding.frames[0][5] = 0.75;
  assert.throws(
    () => f.engine.acknowledgeNativeArm(marker, owner),
    /binding_changed/,
  );
  marker.hostBinding = { frames: retained.frames, dsp: retained.dsp };
  assert.deepEqual(f.engine.acknowledgeNativeArm(marker, owner), {
    status: "ready",
  });
  f.engine.cancel(owner);
  assert.equal(f.engine.pass, null);
});

test("native preflight expires before arm and before reset acknowledgement without retaining active analysis", () => {
  for (const boundary of ["arm", "ack", "counter"]) {
    const f = fixture();
    f.engine.prepare(command, f.preflight);
    if (boundary !== "arm") f.engine.arm({ ...owner, nativeEpoch: 1 });
    if (boundary !== "counter") f.time(1001);
    f.engine.configureHost(f.host);
    assert.throws(() => {
      if (boundary === "arm") return f.engine.arm({ ...owner, nativeEpoch: 1 });
      const timing = f.engine.pass.certificate;
      return f.engine.acknowledgeNativeArm(
        {
          nativeEpoch: 1,
          armCounter:
            timing.before.frames[31][4] + (boundary === "counter" ? 48001 : 64),
          hostBinding: timing.before,
          launchClock: -1,
          sourceClock: -1,
          onsetCount: 0,
          rejected: 0,
          active: 0,
          launchPhaseSamples: -1,
          firstSourceClock: -1,
          completedSamples: 0,
        },
        owner,
      );
    }, /stale_native/);
    f.engine.cancel(owner);
    assert.equal(f.engine.pass, null);
    assert.deepEqual(f.analysis.at(-1), [false, true]);
  }
});
