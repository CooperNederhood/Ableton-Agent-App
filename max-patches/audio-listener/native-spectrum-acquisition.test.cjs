const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeCaptureController,
} = require("./audio_listener_native_controller.js");
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");

const ACTUAL_PACKET = [1134592, 0, 0, 1132544, 1136640, 0];
const states = ["preflight", "native-arming", "armed", "capturing"];
const heldPayload = (previous) => [
  previous[0],
  previous[1],
  previous[2],
  previous[3],
  previous[0] + 2048,
  previous[5],
];
async function setup(rate, state, seedSpectrum = true) {
  const f = v2Fixture({ rate });
  f.controller.prepare(f.command);
  f.pending = f.controller.arm(V2_OWNER);
  f.pending.catch(() => {});
  if (state === "preflight") {
    if (seedSpectrum) f.packet("spectrum", f.spectrum(64000, 0, 0));
  } else {
    f.preflight();
    if (state !== "native-arming") {
      f.configReceipt();
      f.ack();
      await f.pending;
      if (state === "capturing") {
        f.packet("clock", f.clock(f.origin + 640));
        f.packet("envelope", f.envelope());
      }
    }
  }
  assert.equal(f.controller.state, state);
  return f;
}
async function finish(f) {
  if (f.controller.state === "preflight") f.preflight();
  if (f.controller.state === "native-arming") {
    f.configReceipt();
    f.ack();
  }
  await f.pending;
  if (f.controller.state === "armed") {
    f.packet("clock", f.clock(f.origin + 640));
    f.packet("envelope", f.envelope());
  }
  f.capture();
  f.post();
  const terminal = f.events.find((event) => event.status === "complete");
  assert(terminal, JSON.stringify(f.events));
  assert.equal(
    terminal.observation.endSample - terminal.observation.startSample,
    f.geometry.totalSamples,
  );
  assert.equal(terminal.observation.samples.length, 10);
  assert.equal(terminal.nativeCapture.spectralWindows.length, 10);
  assert.equal(f.controller.pass, null);
  assert(f.controller.pendingDisarm);
  f.packet("stopped", [0, 0, 2], f.controller.pendingDisarm.generation);
  assert.equal(f.controller.pendingDisarm, null);
}
async function cleanup(f, reason) {
  const p = f.controller.pass;
  if (p) f.controller.cancel(V2_OWNER);
  await f.pending.catch((error) => {
    if (reason) assert.match(error.message, reason);
  });
  const generation = f.controller.pendingDisarm?.generation;
  if (generation) f.packet("stopped", [0, 0, 2], generation);
  assert.equal(f.controller.pass, null);
  assert.equal(f.controller.pendingDisarm, null);
}

test("actual c6a024c9 input is discarded only with an independently retained matching coherent payload, never used as a valid bracket", async () => {
  const f = await setup(48000, "preflight", false);
  for (const [type, values] of [
    ["dsp", [1, 48000, 64]],
    ["fftInfo", [2048, 2048, 2048, 1]],
    ["abi-clock", [2]],
    ["abi-envelope", [2]],
    ["abi-spectrum", [2]],
  ])
    f.packet(type, values);
  // Synthetic prior state tests classification; the actual prior packet was not retained.
  const previous = [1134592, 0, 0, 1132544, 1134592, 0];
  f.packet("spectrum", previous);
  const p = f.controller.pass,
    retained = p.spectrum,
    at = p.spectrumAt,
    cause = p.cause;
  const wire = [];
  const io = new NativeMessageIO(
    "spectrum",
    (message) => {
      wire.push([...message]);
      f.controller.ingest({
        generation: message[1],
        type: message[2],
        values: message.slice(3),
      });
    },
    () => {},
    () => {},
    2,
  );
  io.begin(p.generation);
  f.packet("spectrum-diagnostics", [-1, -1, -1, -1, 0]);
  const debug = p.spectrumDiagnostics;
  assert.equal(io.packet("spectrum", ACTUAL_PACKET, 6), true);
  assert.deepEqual(wire.at(-1), [
    "native",
    p.generation,
    "spectrum",
    ...ACTUAL_PACKET,
  ]);
  assert.equal(f.controller.pass, p);
  assert.equal(p.spectrum, retained);
  assert.equal(p.spectrumAt, at);
  assert.equal(p.spectrumDiagnostics, debug);
  assert.equal(p.nativeFailureDiagnostic, null);
  assert.equal(p.rejected, 1);
  const event = f.observed.at(-1);
  assert.equal(event.stage, "progress");
  assert.equal(event.reason, "torn_native_spectrum");
  assert.equal(event.causationId, cause);
  assert.equal(event.generation, p.generation);
  assert.equal(event.passId, f.command.passId);
  assert.equal(event.connectionEpoch, f.command.connectionEpoch);
  assert.equal(event.traceId, f.command.traceId);
  assert.equal(event.correlationId, f.command.correlationId);
  assert.equal(event.elapsedMs, 0);
  assert.equal(
    f.sent.some((packet) => packet.action === "arm"),
    false,
  );
  await cleanup(f, /cancelled/);
});

test("both rates discard the old-payload/new-final-tag shape in every existing acquisition phase and complete with later coherent coverage", async () => {
  for (const rate of [44100, 48000])
    for (const state of states) {
      const f = await setup(rate, state),
        p = f.controller.pass;
      const previous = p.spectrum,
        spectrumAt = p.spectrumAt,
        clock = p.clock,
        clockAt = p.clockAt;
      const queued = p.assembler ? JSON.stringify(p.assembler.spectra) : null;
      const armCount = f.armed.length;
      const values = heldPayload(previous);
      f.time(100);
      assert.equal(f.packet("spectrum", values), true, `${rate}/${state}`);
      assert.equal(f.controller.state, state);
      assert.equal(p.rejected, 1);
      assert.equal(p.spectrum, previous);
      assert.equal(p.spectrumAt, spectrumAt);
      assert.equal(p.clock, clock);
      assert.equal(p.clockAt, clockAt);
      assert.equal(
        p.assembler ? JSON.stringify(p.assembler.spectra) : null,
        queued,
      );
      assert.equal(f.armed.length, armCount);
      assert.equal(f.observed.at(-1).elapsedMs, 100);
      assert.equal(p.nativeFailureDiagnostic, null);
      await finish(f);
    }
});

test("arbitrary, multi-frame, nonintegral, nonfinite, changed-counter, changed-payload and impossible brackets remain fatal", async () => {
  const mutations = [
    (v) => {
      v[0] -= 2048;
    },
    (v) => {
      v[3]++;
    },
    (v) => {
      v[4] += 2048;
    },
    (v) => {
      v[4]--;
    },
    (v) => {
      v[4] += 0.5;
    },
    (v) => {
      v[4] = v[0] - 2048;
    },
    (v) => {
      v[5]++;
    },
    (v) => {
      v[1] = 1;
      v[2] = 1;
    },
    (v) => {
      v[2] = 1;
    },
    (v) => {
      v[1] = 24001;
      v[2] = 1;
    },
    (v) => {
      v[2] = Number.MAX_SAFE_INTEGER + 1;
    },
    (v) => {
      v[0] = -1;
    },
    (v) => {
      v[2] = NaN;
    },
    (v) => {
      v[1] = Infinity;
    },
    ...Array.from({ length: 6 }, (_, index) => [
      (v) => {
        v[index] = NaN;
      },
      (v) => {
        v[index] = Infinity;
      },
    ]).flat(),
  ];
  for (const rate of [44100, 48000])
    for (const state of states)
      for (const mutate of mutations) {
        const f = await setup(rate, state),
          p = f.controller.pass;
        const values = heldPayload(p.spectrum);
        mutate(values);
        assert.equal(f.packet("spectrum", values), false);
        assert.equal(f.controller.pass, null, `${rate}/${state}/${values}`);
        assert.equal(p.closed, true);
        assert.equal(p.rejected, 0);
        assert.equal(
          f.events.some((event) => event.status === "complete"),
          false,
        );
        assert.equal(f.sent.at(-1).action, "stop");
        if (p.assembler) {
          assert.equal(p.assembler.pending.length, 0);
          assert.equal(p.assembler.spectra.length, 0);
        }
        await cleanup(f);
      }
});

test("missing previous state, stale retained payload and replay after coherent advancement remain fatal", async () => {
  for (const rate of [44100, 48000])
    for (const fault of [
      "missing",
      "stale",
      "future",
      "replay",
      "previous-frame",
      "previous-start",
    ]) {
      const f = await setup(rate, "capturing"),
        p = f.controller.pass;
      const previous = p.spectrum,
        values = heldPayload(previous);
      if (fault === "missing") p.spectrum = null;
      if (fault === "stale") f.time(1001);
      if (fault === "future") p.spectrumAt = 1;
      if (fault === "previous-frame")
        p.spectrum = [...previous.slice(0, 4), previous[4] + 2048, previous[5]];
      if (fault === "previous-start")
        p.spectrum = previous.map(
          (value, index) => value + Number(index === 3),
        );
      if (fault === "replay")
        f.packet("spectrum", f.spectrum(previous[0] + 2048, 0, 0));
      assert.equal(f.packet("spectrum", values), false);
      assert.equal(p.rejected, 0);
      assert.equal(p.closed, true);
      await cleanup(f);
    }
});

test("discarded reads share the existing 64-rejection clock/FFT quota and cannot refresh freshness or enqueue descriptors", async () => {
  for (const rate of [44100, 48000]) {
    const f = await setup(rate, "capturing"),
      p = f.controller.pass,
      previous = p.spectrum;
    const oldShape = [
      previous[0],
      previous[1],
      previous[2],
      previous[0],
      previous[0] + 2048,
      previous[5],
    ];
    const tornClock = [...p.clock];
    tornClock[6] += 64;
    for (let i = 0; i < 32; i++) f.packet("spectrum", heldPayload(previous));
    for (let i = 0; i < 16; i++) f.packet("spectrum", oldShape);
    for (let i = 0; i < 16; i++) f.packet("clock", tornClock);
    assert.equal(p.rejected, 64);
    assert.equal(p.spectrum, previous);
    assert.equal(p.spectrumAt, 0);
    assert.equal(p.clockAt, 0);
    assert.equal(p.assembler.spectra.length, 0);
    assert.equal(f.packet("spectrum", heldPayload(previous)), false);
    assert.equal(p.closed, true);
    assert.match(f.events.at(-1).reason, /native_preflight_rejection_limit/);
    assert.equal(p.assembler.spectra.length, 0);
    assert.equal(p.assembler.pending.length, 0);
    await cleanup(f);
  }
});

test("fresh rejected acquisition does not refresh host freshness or extend any existing stage deadline", async () => {
  for (const rate of [44100, 48000])
    for (const state of states) {
      const f = await setup(rate, state),
        p = f.controller.pass;
      f.time(state === "native-arming" ? 500 : 900);
      f.packet("spectrum", heldPayload(p.spectrum));
      assert.equal(f.controller.pass, p);
      assert.equal(p.spectrumAt, 0);
      assert.equal(p.clockAt ?? 0, 0);
      f.time(
        state === "preflight"
          ? 2000
          : state === "native-arming"
            ? 1000
            : state === "armed"
              ? 10000
              : 1001,
      );
      f.controller.tick();
      assert.equal(p.closed, true);
      const failure = f.events.at(-1)?.reason;
      await f.pending.catch((error) => assert.match(error.message, /timeout/));
      if (state === "capturing") assert.equal(failure, "host_timing_stale");
      if (state === "armed") assert.equal(failure, "native_launch_timeout");
      await cleanup(f);
    }
});

test("cancellation and generation/owner fences remain effective after a discarded packet and permit only an explicit new pass", async () => {
  for (const rate of [44100, 48000])
    for (const state of states) {
      const f = await setup(rate, state),
        p = f.controller.pass;
      const values = heldPayload(p.spectrum),
        old = p.generation;
      assert.equal(f.packet("spectrum", values, "foreign-generation"), false);
      assert.equal(p.rejected, 0);
      assert.throws(
        () => f.controller.cancel({ ...V2_OWNER, passId: "foreign" }),
        /owner_mismatch/,
      );
      f.packet("spectrum", values);
      f.controller.cancel(V2_OWNER);
      assert.equal(p.closed, true);
      if (p.assembler) {
        assert.equal(p.assembler.pending.length, 0);
        assert.equal(p.assembler.spectra.length, 0);
      }
      await f.pending.catch((error) =>
        assert.match(error.message, /cancelled/),
      );
      assert.equal(f.packet("spectrum", values, old), false);
      assert.throws(
        () => f.controller.prepare(f.command),
        /native_disarm_pending/,
      );
      f.packet("stopped", [0, 0, 2], old);
      f.controller.prepare(f.command);
      const current = f.controller.pass;
      assert.notEqual(current.generation, old);
      assert.equal(f.packet("spectrum", values, old), false);
      assert.equal(current.rejected, 0);
      assert.equal(current.spectrum, undefined);
      f.controller.cancel(V2_OWNER);
      assert.equal(f.controller.pendingDisarm, null);
    }
});

test("v1 rejects the newly observed held-start shape and keeps its existing old-end/new-start recovery unchanged", () => {
  const controller = new NativeCaptureController({
    listenerId: "v1",
    send: () => true,
    onArmed: () => true,
    emit: () => {},
    now: () => 0,
  });
  controller.prepare({
    ...V2_OWNER,
    traceId: "v1-trace",
    correlationId: "v1-correlation",
    causationId: "v1-root",
    mode: "arrangement",
    startBeat: 0,
    endBeat: 4,
  });
  const previous = [1134592, 0, 0, 1132544, 1134592, 0];
  const p = controller.pass;
  p.spectrum = previous;
  p.spectrumAt = 0;
  controller.state = "capturing";
  assert.throws(
    () => controller.spectrum(p, ACTUAL_PACKET),
    /invalid_native_spectrum_packet/,
  );
  assert.equal(p.rejected, 0);
  assert.equal(p.spectrum, previous);
  controller.spectrum(p, [
    previous[0],
    0,
    0,
    previous[0],
    previous[0] + 2048,
    0,
  ]);
  assert.equal(p.rejected, 1);
  assert.equal(p.spectrum, previous);
  assert.equal(p.spectrumAt, 0);
  controller.cancel(V2_OWNER);
});
