import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const { v2Fixture } = require("./native-v2-fixture.cjs");
const GENERATION = "11111111-1111-4111-8111-111111111111";
const IDLE_ENVELOPE = [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 2];

function inactive(width, requested = 144) {
  const row = Array(width + 14).fill(0);
  row[0] = 1;
  row[2] = row[width + 12] = requested;
  return row;
}
function activeEmpty(width, epoch) {
  const row = inactive(width, 1);
  row[1] = row[width + 13] = epoch;
  return row;
}
function ioFor(mode, rate, send = () => {}, now = () => 0) {
  return new NativeMessageIO(
    mode,
    send,
    () => {},
    () => {},
    2,
    {
      retainedMeasurements: true,
      now,
    },
  );
}
function harness(rate) {
  let time = 0;
  const ios = {};
  const f = v2Fixture({
    rate,
    retainedMeasurements: true,
    retentionReady: false,
    setTime: (value) => {
      time = value;
    },
    send: (control) => {
      if (control.action === "begin") {
        for (const mode of ["envelope", "spectrum"]) {
          ios[mode] ??= ioFor(
            mode,
            rate,
            (p) => f.packet(p[2], p.slice(3), p[1]),
            () => time,
          );
          assert.equal(
            ios[mode].begin(control.generation, control.nativeEpoch, rate),
            true,
          );
          ios[mode].retainedFrame(inactive(mode === "envelope" ? 16 : 6));
        }
      }
      if (control.action === "stop") {
        for (const mode of ["envelope", "spectrum"])
          assert.equal(
            ios[mode].stop(control.generation, control.outcome),
            true,
          );
        assert.equal(ios.envelope.envelope(IDLE_ENVELOPE), true);
      }
    },
  });
  const begin = (index) => {
    const command = {
      ...f.command,
      passId: `inactive-pass-${index}`,
      traceId: `inactive-trace-${index}`,
      correlationId: `inactive-correlation-${index}`,
    };
    f.controller.prepare(command);
    const pending = f.controller.arm(command);
    return { pending, command, pass: f.controller.pass };
  };
  const complete = async (index) => {
    const started = begin(index);
    f.preflight();
    for (const mode of ["envelope", "spectrum"]) {
      const row = activeEmpty(
        mode === "envelope" ? 16 : 6,
        started.pass.nativeEpoch,
      );
      ios[mode].retainedFrame(row);
      ios[mode].retainedFrame(row);
    }
    f.configReceipt();
    f.ack();
    await started.pending;
    f.packet("clock", f.clock(f.origin + 640));
    f.packet("envelope-state", f.envelope());
    assert.equal(f.controller.state, "capturing");
    f.capture();
    f.post();
    assert.equal(f.events.at(-1).status, "complete");
    assert.equal(f.controller.pendingDisarm, null);
    return started;
  };
  return { f, ios, begin, complete };
}

for (const rate of [44100, 48000]) {
  test(`${rate}: inactive144 cannot arm generation2, fresh coherent DSP ownership allows another completed capture`, async () => {
    const h = harness(rate);
    const first = await h.complete(1);
    const second = h.begin(2);
    assert.equal(first.pass.nativeEpoch, 1);
    assert.equal(second.pass.nativeEpoch, 2);
    assert.notEqual(first.pass.generation, second.pass.generation);
    const times = [
      second.pass.clockAt,
      second.pass.spectrumAt,
      second.pass.envelopeAt,
    ];
    for (const io of Object.values(h.ios)) {
      assert.equal(io.retentionReader.stats().state, "started");
      assert.equal(io.retentionReader.stats().waiting, 1);
      assert.equal(io.retentionReadySent, false);
      assert.equal(io.retentionReader.stats().expectedSequence, 1);
      assert.equal(io.retentionReader.stats().accepted, 0);
    }
    assert.deepEqual(second.pass.retentionReady, {});
    assert.deepEqual(
      [second.pass.clockAt, second.pass.spectrumAt, second.pass.envelopeAt],
      times,
    );
    assert.equal(h.f.controller.state, "preflight");
    h.f.preflight();
    for (const mode of ["envelope", "spectrum"]) {
      const row = activeEmpty(mode === "envelope" ? 16 : 6, 2);
      h.ios[mode].retainedFrame(row);
      h.ios[mode].retainedFrame(row);
    }
    h.f.configReceipt();
    h.f.ack();
    await second.pending;
    h.f.packet("clock", h.f.clock(h.f.origin + 640));
    h.f.packet("envelope-state", h.f.envelope());
    h.f.capture();
    h.f.post();
    const terminal = h.f.events.at(-1);
    assert.equal(terminal.status, "complete");
    assert.equal(terminal.observation.passId, second.command.passId);
    assert.equal(terminal.observation.complete, true);
    assert.equal(
      terminal.observation.endSample - terminal.observation.startSample,
      rate,
    );
    assert.equal(h.f.events.filter((e) => e.status === "complete").length, 2);
    assert.equal(h.f.controller.pendingDisarm, null);
    assert(Object.values(h.ios).every((io) => io.retentionReader === null));
  });

  for (const outcome of ["timeout", "cancelled"])
    test(`${rate}: generation2 remaining inactive144 ${outcome} preserves deadlines, trace and cleanup`, async () => {
      const h = harness(rate);
      await h.complete(1);
      const second = h.begin(2);
      const rejected = assert.rejects(
        second.pending,
        outcome === "timeout"
          ? /native_measurement_readiness_timeout/
          : /cancelled/,
      );
      h.f.preflight();
      const times = [
        second.pass.clockAt,
        second.pass.spectrumAt,
        second.pass.envelopeAt,
      ];
      const progressBefore = h.f.observed.length;
      for (let time = 0; time < 2000; time += 10) {
        h.f.time(time);
        for (const mode of ["envelope", "spectrum"])
          h.ios[mode].retainedFrame(inactive(mode === "envelope" ? 16 : 6));
      }
      assert.deepEqual(
        [second.pass.clockAt, second.pass.spectrumAt, second.pass.envelopeAt],
        times,
      );
      assert.deepEqual(second.pass.retentionReady, {});
      assert.equal(h.f.observed.length, progressBefore);
      if (outcome === "timeout") {
        h.f.time(2000);
        h.f.controller.tick();
      } else h.f.controller.cancel(second.command);
      await rejected;
      assert.equal(h.f.controller.pass, null);
      assert.equal(h.f.controller.pendingDisarm, null);
      assert.equal(h.f.sent.filter((c) => c.action === "begin").length, 2);
      assert.equal(h.f.sent.filter((c) => c.action === "stop").length, 2);
      assert.equal(h.f.events.filter((e) => e.status === "complete").length, 1);
      assert(
        Object.values(h.ios).every(
          (io) =>
            io.retentionReader === null && io.retentionReadbacks.length === 0,
        ),
      );
      const disarm = h.f.observed.findLast(
        (e) => e.type === "native-disarm-stage",
      );
      assert.equal(disarm.traceId, second.command.traceId);
      assert.equal(disarm.correlationId, second.command.correlationId);
      assert.equal(disarm.generation, second.pass.generation);
      assert.equal(disarm.nativeEpoch, 2);
    });
}

for (const mode of ["envelope", "spectrum"])
  for (const rate of [44100, 48000])
    test(`${mode} ${rate}: inactive relaxation never permits dirty state, invalid requests or post-ownership resets`, () => {
      const width = mode === "envelope" ? 16 : 6;
      for (let index = 1; index < width + 14; index++) {
        if ([1, 2, width + 12].includes(index)) continue;
        const io = ioFor(mode, rate);
        io.begin(GENERATION, 2, rate);
        const dirty = inactive(width);
        dirty[index] = 1;
        io.retainedFrame(dirty);
        assert.equal(
          io.retentionReader.stats().reason,
          "invalid_uninitialized_readback",
        );
        assert.equal(io.retentionReadySent, false);
      }
      for (const requested of [-1, 0.5, 2 ** 44, Infinity, "144"]) {
        const io = ioFor(mode, rate);
        io.begin(GENERATION, 2, rate);
        io.retainedFrame(inactive(width, requested));
        assert.equal(io.retentionReader.stats().state, "failed");
      }
      const mismatch = ioFor(mode, rate);
      mismatch.begin(GENERATION, 2, rate);
      const row = inactive(width);
      row[width + 12] = 143;
      mismatch.retainedFrame(row);
      assert.equal(
        mismatch.retentionReader.stats().reason,
        "invalid_uninitialized_readback",
      );
      const owned = ioFor(mode, rate);
      owned.begin(GENERATION, 2, rate);
      owned.retainedFrame(activeEmpty(width, 1));
      assert.equal(owned.retentionReadySent, false);
      assert.equal(owned.retentionReader.stats().stale, 1);
      owned.retainedFrame(activeEmpty(width, 2));
      owned.retainedFrame(inactive(width));
      assert.equal(owned.retentionReader.stats().reason, "invalid_owner_reset");
    });
