import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const Measurements = require("./audio_listener_measurements.js");
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { nativeListenerLifecycleV2Schema } =
  await import("../../packages/protocol/src/native-listening-v2-schemas.ts");
const GENERATION = "11111111-1111-4111-8111-111111111111";
const ACTUAL_ACCEPTED = [
  1, 1, 21, 1, 21, 1226752, 1228800, 21, 20, 0, 1228800, 0, 0, 1226752, 1228800,
  0, 21, 1, 21, 1,
];
const ACTUAL_TORN = [
  1, 1, 21, 1, 21, 1226752, 1228800, 21, 21, 0, 1230848, 0, 0, 1228800, 1230848,
  0, 22, 1, 22, 1,
];

function fixture(mode = "spectrum", rate = 48000, options = {}) {
  const packets = [],
    controls = [];
  let time = 0;
  const io = new NativeMessageIO(
    mode,
    (packet) => {
      packets.push(packet);
      options.send?.(packet);
    },
    (control) => controls.push(control),
    () => {},
    2,
    {
      retainedMeasurements: true,
      now: () => time,
    },
  );
  io.begin(options.generation ?? GENERATION, 1, rate);
  const width = mode === "envelope" ? 16 : 6;
  const row = (sequence, acknowledged = sequence - 1) => {
    const start = 1226752 + (sequence - 21) * 2048;
    const end = start + 2048;
    return [
      1,
      1,
      sequence,
      1,
      sequence,
      start,
      end,
      sequence,
      acknowledged,
      0,
      ...[end, 0, 0, start, end, 0, ...Array(10).fill(0)].slice(0, width),
      sequence,
      1,
      sequence,
      1,
    ];
  };
  const torn = (sequence) => {
    const mixed = row(sequence);
    mixed[width + 10]++;
    mixed[width + 12]++;
    return mixed;
  };
  return {
    io,
    packets,
    controls,
    width,
    row,
    torn,
    time: (value) => {
      time = value;
    },
    frames: () => packets.filter((p) => p[2] === mode),
  };
}

test("actual owned-host mixed sequence21/22 snapshot is unstable, retains counters, and recovers without retry", () => {
  const f = fixture();
  for (let sequence = 1; sequence <= 20; sequence++) {
    f.io.retainedFrame(f.row(sequence));
    assert.equal(f.io.retainedFrame(f.row(sequence)), true);
  }
  f.io.retainedFrame(ACTUAL_ACCEPTED);
  assert.equal(f.io.retainedFrame(ACTUAL_ACCEPTED), true);
  const controls = f.controls.slice();
  const queue = { ...f.io.retentionQueue };
  assert.equal(f.io.retainedFrame(ACTUAL_TORN), false);
  assert.equal(f.io.retentionReader.stats().state, "started");
  assert.equal(f.io.retentionReader.stats().unstable, 1);
  assert.equal(f.io.retentionReader.stats().expectedSequence, 22);
  assert.equal(f.frames().length, 21);
  assert.deepEqual(f.controls, controls);
  assert.deepEqual(f.io.retentionQueue, queue);
  const next = f.row(22, 20);
  assert.equal(f.io.retainedFrame(next), false);
  assert.equal(f.io.retainedFrame(next), true);
  assert.equal(f.frames().length, 22);
  assert.equal(
    f.packets.some((p) => ["retention-rejection", "ioError"].includes(p[2])),
    false,
  );
  assert.deepEqual(f.controls.slice(-2), [
    ["measurementReadSequence", 23],
    ["measurementAcknowledged", 22],
  ]);
});

for (const mode of ["envelope", "spectrum"])
  for (const rate of [44100, 48000]) {
    test(`${mode} ${rate}: unstable acquisition breaks consecutive settling and never changes accepted data or controls`, () => {
      const f = fixture(mode, rate);
      const reader = f.io.retentionReader;
      assert.equal(reader.poll(f.row(1)).status, "settling");
      const before = reader.stats();
      const controls = f.controls.slice();
      const mixed = f.torn(1);
      mixed[7] = mixed[8] = 2 ** 44 - 1;
      const result = reader.poll(mixed);
      assert.deepEqual(result, { status: "unstable", actions: [] });
      assert.equal(reader.stats().accepted, before.accepted);
      assert.equal(reader.stats().expectedSequence, before.expectedSequence);
      assert.equal(reader.stats().candidatePending, true);
      assert.equal(reader.stats().pendingControl, before.pendingControl);
      assert.equal(reader.stats().failures, 0);
      assert.equal(reader.poll(f.row(1)).status, "settling");
      assert.equal(reader.poll(f.row(1)).status, "accepted");
      assert.equal(reader.poll(f.torn(1)).status, "unstable");
      assert.equal(reader.stats().pendingControl, true);
      assert.equal(reader.poll(f.row(2)).status, "settling");
      assert.equal(reader.poll(f.row(2)).status, "accepted");
      assert.equal(f.frames().length, 2);
      assert.deepEqual(f.controls, controls);
    });

    test(`${mode} ${rate}: unstable reads preserve immutable fingerprints and coherent faults stay terminal`, () => {
      for (const accepted of [false, true])
        for (const mutate of [
          (row) => {
            row[5]++;
          },
          (row) => {
            row[10]++;
          },
        ]) {
          const f = fixture(mode, rate);
          const reader = f.io.retentionReader;
          reader.poll(f.row(1));
          if (accepted) reader.poll(f.row(1));
          assert.equal(reader.poll(f.torn(1)).status, "unstable");
          const changed = f.row(1);
          mutate(changed);
          assert.equal(reader.poll(changed).reason, "immutable_slot_changed");
          assert.equal(f.frames().length, Number(accepted));
        }
      for (const [reason, mutate] of [
        [
          "invalid_header_bounds",
          (row) => {
            row[5] = -1;
          },
        ],
        [
          "invalid_header_bounds",
          (row) => {
            row[fIndex(mode, 10)] = -1;
          },
        ],
        [
          "invalid_header_bounds",
          (row) => {
            row[fIndex(mode, 11)] = 1000001;
          },
        ],
        [
          "invalid_header_bounds",
          (row) => {
            row[fIndex(mode, 12)] = -1;
          },
        ],
        [
          "invalid_header_bounds",
          (row) => {
            row[fIndex(mode, 13)] = 1.5;
          },
        ],
        [
          "invalid_numeric",
          (row) => {
            row[10] = Infinity;
          },
        ],
        [
          "invalid_abi",
          (row) => {
            row[0] = 2;
          },
        ],
        [
          "unread_capacity_overflow",
          (row) => {
            row[9] = 1;
          },
        ],
        [
          "invalid_dsp_control",
          (row) => {
            row[9] = 2;
          },
        ],
      ]) {
        const f = fixture(mode, rate);
        const row = f.torn(1);
        if (
          ["unread_capacity_overflow", "invalid_dsp_control"].includes(reason)
        ) {
          row[f.width + 10] = row[4];
          row[f.width + 12] = row[2];
        }
        mutate(row);
        assert.equal(f.io.retentionReader.poll(row).reason, reason);
      }
      const f = fixture(mode, rate);
      const wrongOwner = f.row(1);
      wrongOwner[1] = wrongOwner[f.width + 13] = 2;
      assert.equal(f.io.retentionReader.poll(wrongOwner).status, "stale");
      assert.equal(f.frames().length, 0);
      assert.equal(f.io.retentionReader.stats().unstable, 0);
    });
  }

function fIndex(mode, suffix) {
  return (mode === "envelope" ? 16 : 6) + suffix;
}

test("unstable progress is throttled, descriptor-free and cannot prove native readiness", () => {
  const f = fixture();
  for (let time = 0; time < 1000; time += 10) {
    f.time(time);
    f.io.retainedFrame(f.torn(1));
  }
  assert.equal(f.io.retentionReadySent, false);
  assert.equal(f.io.retentionReader.stats().unstable, 100);
  assert.equal(f.io.retentionReader.stats().failures, 0);
  const progress = f.packets.filter((p) => p[2] === "retention-unstable");
  assert.equal(progress.length, 4);
  assert(progress.every((p) => p.length === 5 && p[3] === 2 && p[4] === 1));
  assert.equal(
    f.packets.some((p) => p[2] === "retention-rejection"),
    false,
  );
  assert.equal(f.frames().length, 0);
  assert.deepEqual(f.controls, [
    ["measurementReadSequence", 1],
    ["measurementAcknowledged", 0],
    ["measurementEpoch", 1],
  ]);
});

test("cancellation from unstable progress clears settlement and cannot publish or resurrect a record", () => {
  const f = fixture();
  let reader;
  reader = Measurements.createReader({
    declaration: f.io.retentionReader.declaration,
    epoch: 1,
    consume: () => assert.fail("cancelled reader cannot consume"),
    onEvent: (event) => {
      if (event.reason === "unstable_acquisition") reader.cancel();
    },
  });
  reader.begin();
  reader.poll(f.row(1));
  assert.equal(reader.poll(f.torn(1)).status, "cancelled");
  assert.equal(reader.stats().candidatePending, false);
  assert.equal(reader.stats().pendingControl, false);
  assert.equal(reader.poll(f.row(1)).status, "cancelled");
});

for (const outcome of ["timeout", "cancelled"])
  test(`persistent unstable preflight still ${outcome === "timeout" ? "times out at 2000ms" : "cancels"} and releases only native ownership`, async () => {
    let io;
    const f = v2Fixture({
      retainedMeasurements: true,
      retentionReady: false,
      send: (control) => {
        if (control.action === "stop")
          io?.stop(control.generation, control.outcome);
      },
    });
    f.controller.prepare(f.command);
    const pending = f.controller.arm(V2_OWNER);
    const rejected = assert.rejects(
      pending,
      outcome === "timeout"
        ? /native_measurement_readiness_timeout/
        : /cancelled/,
    );
    const pass = f.controller.pass;
    f.preflight();
    const native = fixture("spectrum", 48000, {
      generation: pass.generation,
      send: (p) => f.packet(p[2], p.slice(3), p[1]),
    });
    io = native.io;
    const times = [pass.clockAt, pass.spectrumAt, pass.envelopeAt];
    for (let time = 0; time < 2000; time += 10) {
      f.time(time);
      native.time(time);
      io.retainedFrame(native.torn(1));
    }
    assert.deepEqual([pass.clockAt, pass.spectrumAt, pass.envelopeAt], times);
    assert.deepEqual(pass.retentionReady, {});
    const progress = f.observed.filter(
      (e) => e.reason === "native_spectrum_acquisition_unstable",
    );
    assert.equal(progress.length, 8);
    for (const event of progress) {
      assert.equal(event.traceId, f.command.traceId);
      assert.equal(event.correlationId, f.command.correlationId);
      nativeListenerLifecycleV2Schema.parse({
        scope: event.scope,
        eventId: event.eventId,
        causationId: event.causationId,
        phase: "measurement",
        generation: event.generation,
        stage: event.stage,
        nativeEpoch: event.nativeEpoch,
        elapsedMs: event.elapsedMs,
        frames: event.frames,
        reason: event.reason,
      });
    }
    if (outcome === "timeout") {
      f.time(2000);
      f.controller.tick();
    } else f.controller.cancel(V2_OWNER);
    await rejected;
    assert.equal(f.controller.pass, null);
    assert.equal(io.retentionReader, null);
    assert.deepEqual(io.retentionReadbacks, []);
    assert.equal(f.sent.filter((c) => c.action === "begin").length, 1);
    assert.equal(f.sent.filter((c) => c.action === "stop").length, 1);
    assert.equal(
      f.sent.some((c) => c.action === "configure_v2" || c.action === "arm_v2"),
      false,
    );
    assert.equal(
      f.events.some((e) => e.status === "complete"),
      false,
    );
    f.packet("stopped", [0, 0, 2], pass.generation);
    assert.equal(f.controller.pendingDisarm, null);
  });

test("persistent unstable capture preserves timing failure and releases the accepted reader", async () => {
  let io;
  const f = v2Fixture({
    retainedMeasurements: true,
    send: (control) => {
      if (control.action === "stop")
        io?.stop(control.generation, control.outcome);
    },
  });
  await f.start();
  const pass = f.controller.pass;
  const native = fixture("spectrum", 48000, {
    generation: pass.generation,
    send: (p) => f.packet(p[2], p.slice(3), p[1]),
  });
  io = native.io;
  const spectrum = f.spectrum(66048);
  const selected = native.row(1);
  selected[5] = spectrum[3];
  selected[6] = spectrum[4];
  selected.splice(10, 6, ...spectrum);
  io.retainedFrame(selected);
  assert.equal(io.retainedFrame(selected), true);
  const before = [
    pass.clockAt,
    pass.spectrumAt,
    pass.envelopeAt,
    pass.assembler.frames,
  ];
  const mixed = selected.slice();
  mixed[8] = 1;
  mixed[16] = mixed[18] = 2;
  mixed.splice(10, 6, ...f.spectrum(68096));
  for (const time of [250, 500, 750, 1000]) {
    f.time(time);
    native.time(time);
    assert.equal(io.retainedFrame(mixed), false);
  }
  assert.deepEqual(
    [pass.clockAt, pass.spectrumAt, pass.envelopeAt, pass.assembler.frames],
    before,
  );
  f.time(1001);
  f.controller.tick();
  const terminal = f.events.find((e) => e.type === "terminal");
  assert.equal(terminal.reason, "host_timing_stale");
  assert.notEqual(terminal.status, "complete");
  assert.equal(f.sent.at(-1).action, "stop");
  assert.equal(f.controller.pass, null);
  assert.equal(io.retentionReader, null);
  assert.deepEqual(io.retentionReadbacks, []);
  assert.equal(native.controls.at(-1)[0], "measurementEpoch");
  assert.equal(native.controls.at(-1)[1], 0);
  assert.equal(f.sent.at(-1).outcome, "failed");
  assert.equal(
    f.observed.some((e) => e.stage === "partial"),
    false,
  );
  f.packet("stopped", [0, 0, 2], pass.generation);
  assert.equal(f.controller.pendingDisarm, null);
  assert.equal(
    f.packet("retention-unstable", [2, pass.nativeEpoch], pass.generation),
    false,
  );
});

test("unstable acquisition progress stays generation/epoch-owned, bounded and non-authoritative", async () => {
  for (const values of [[3, 1], [2, 2], [2], [2, 1, 0], [2, Infinity]]) {
    const f = v2Fixture({ retainedMeasurements: true });
    await f.start();
    assert.equal(f.packet("retention-unstable", values, "foreign"), false);
    assert.equal(f.controller.state, "capturing");
    assert.equal(f.packet("retention-unstable", values), false);
    assert.equal(f.controller.pass, null);
    assert.equal(
      f.events.some((e) => e.status === "complete"),
      false,
    );
  }
  const f = v2Fixture({ retainedMeasurements: true, retentionReady: false });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  f.controller.tryPreflight = () =>
    assert.fail("unstable data cannot advance preflight");
  f.controller.drain = () => assert.fail("unstable data cannot drain capture");
  assert.equal(f.packet("retention-unstable", [1, 1]), true);
  assert.equal(f.controller.state, "preflight");
  assert.deepEqual(f.controller.pass.retentionReady, {});
  const rejected = assert.rejects(pending, /cancelled/);
  f.controller.cancel(V2_OWNER);
  await rejected;
});
