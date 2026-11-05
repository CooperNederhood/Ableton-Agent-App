import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as codec from "../../packages/protocol/dist/index.js";

const require = createRequire(import.meta.url);
const { createMelBandHandoff } = require("./audio_listener_mel_handoff.js");
const origin = 10000;
const total = 4107;
const end = origin + total;
const header = (sequence, start, stop, lost = 0, partial = 0, reason = 0) => [
  2,
  3,
  7,
  sequence,
  start,
  stop,
  lost,
  partial,
  reason,
  48000,
  24,
];
const frame = (sequence, values = Array(48).fill(0.5)) => [
  "mel_frame",
  ...header(sequence, origin + (sequence - 1) * 2048, origin + sequence * 2048),
  ...values,
];
const terminal = (frames = 2, reason = 10) => [
  "mel_stopped",
  ...header(frames, origin + frames * 2048, end, 2 - frames, 11, reason),
];

function fixture() {
  let time = 0;
  const controls = [];
  const events = [];
  const handoff = createMelBandHandoff({
    epoch: 3,
    sampleRate: 48000,
    totalSamples: total,
    codec,
    now: () => time,
    send: (...args) => controls.push(args),
    emit: (event) => events.push(event),
  });
  return {
    handoff,
    controls,
    events,
    advance() {
      time += 10;
      handoff.tick();
    },
    ready() {
      handoff.arm();
      handoff.receive(["mel_ready", ...header(0, 9000, 9000)]);
    },
    start() {
      this.ready();
      handoff.receive(["mel_started", ...header(0, origin, end)]);
      handoff.bind({ startSample: origin, endSample: end });
    },
    drain(records, frames, consumed = 1, clockValid = 1, clock = end) {
      this.advance();
      const token = controls.findLast(
        ([selector]) => selector === "drain",
      )[1][0];
      handoff.receive([
        "mel_drain",
        2,
        token,
        3,
        7,
        records,
        frames,
        consumed,
        clockValid,
        clock,
      ]);
    },
  };
}

test("mel handoff requires actual readiness, source binding and terminal-consumed receipt", () => {
  const f = fixture();
  f.handoff.arm();
  assert.equal(f.handoff.snapshot().ready, false);
  f.handoff.receive(["mel_ready", ...header(0, 9000, 9000)]);
  assert.equal(f.handoff.snapshot().ready, true);
  f.handoff.receive(["mel_started", ...header(0, origin, end)]);
  f.handoff.receive(
    frame(1, [...Array(24).fill(0.5), ...Array(24).fill(0.25)]),
  );
  f.handoff.bind({ startSample: origin, endSample: end });
  f.handoff.receive(frame(2));
  f.handoff.receive(terminal());
  assert.equal(f.handoff.snapshot().completed, false);
  assert.throws(() => f.handoff.timeline(), /not_settled/);
  assert.equal(f.handoff.stop(), false);
  f.drain(5, 2);
  assert.equal(f.handoff.stop(), true);
  const timeline = f.handoff.timeline();
  assert.equal(timeline.status, "complete");
  assert.equal(timeline.expectedRecords, 2);
  assert.equal(timeline.frames.length, 2);
  assert.deepEqual(timeline.frames[0].magnitudes[0], Array(24).fill(0.5));
  assert.deepEqual(timeline.frames[0].magnitudes[1], Array(24).fill(0.25));
  assert.deepEqual(timeline.frames[1].support, {
    startSample: origin + 2048,
    endSample: origin + 4096,
  });
  assert.deepEqual(timeline.gaps, []);
  assert.equal(f.handoff.snapshot().receipt.sourceClockExclusive, end);
  assert.equal(
    f.events.filter((event) => event.reason === "mel_native_cleanup_complete")
      .length,
    1,
  );
  assert.equal(f.controls.filter(([kind]) => kind === "arm").length, 1);
  const completed = f.events.find(
    (event) => event.reason === "mel_native_cleanup_complete",
  );
  assert.deepEqual(
    Object.fromEntries(
      completed.facts.map(({ field, actual }) => [field, actual.value]),
    ),
    {
      "mel.abi": 2,
      "mel.sampleRate": 48000,
      "mel.bandCount": 24,
      "mel.expectedFrames": 2,
      "mel.validFrames": 2,
      "mel.receivedFrames": 2,
      "mel.dspGeneration": 7,
      "mel.startSample": origin,
      "mel.endSample": end,
      "mel.terminalReason": 10,
      "mel.lostFrames": 0,
      "mel.trailingSamples": 11,
      "mel.terminalConsumed": 1,
      "mel.recordsDrained": 5,
      "mel.framesDrained": 2,
      "mel.sourceClockExclusive": end,
    },
  );
  assert.ok(f.events.every((event) => event.facts.length <= 16));
});

test("empty pre-readiness drains do not imply readiness or completion", () => {
  const f = fixture();
  f.handoff.arm();
  f.drain(0, 0, 0, 0, 0);
  assert.equal(f.handoff.snapshot().ready, false);
  assert.equal(f.handoff.snapshot().completed, false);
  assert.throws(() => f.handoff.timeline(), /not_settled/);
  f.handoff.receive(["mel_ready", ...header(0, 9000, 9000)]);
  assert.equal(f.handoff.snapshot().ready, true);
});

test("an unbound initial empty receipt cannot establish a DSP owner or readiness", () => {
  const f = fixture();
  f.handoff.arm();
  f.advance();
  f.handoff.receive(["mel_drain", 2, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(f.handoff.snapshot().generation, null);
  assert.equal(f.handoff.snapshot().ready, false);
  assert.equal(f.handoff.snapshot().completed, false);
  f.handoff.receive(["mel_ready", ...header(0, 9000, 9000)]);
  assert.equal(f.handoff.snapshot().generation, 7);
  f.advance();
  assert.throws(
    () => f.handoff.receive(["mel_drain", 2, 2, 0, 0, 1, 0, 0, 0, 0]),
    /mel_invalid_drain_receipt/,
  );
});

for (const [reason, gap] of [
  [6, "overflow"],
  [7, "malformed-record"],
]) {
  test(`native local reason ${reason} retains exact prefix and ${gap} coverage`, () => {
    const f = fixture();
    f.start();
    f.handoff.receive(frame(1));
    f.handoff.receive(terminal(1, reason));
    f.drain(4, 1, 1, 1, origin + 2048);
    const timeline = f.handoff.timeline();
    assert.equal(timeline.status, "partial");
    assert.equal(timeline.frames.length, 1);
    assert.deepEqual(timeline.gaps, [
      {
        firstIndex: 1,
        count: 1,
        support: { startSample: origin + 2048, endSample: origin + 4096 },
        reason: gap,
      },
    ]);
  });
}

for (const reason of [0, 2, 3, 4, 5, 8, 9, 11, 99]) {
  test(`shared native reason ${reason} cannot hide behind malformed data or cancellation`, () => {
    for (const cancelled of [false, true]) {
      const f = fixture();
      f.start();
      f.handoff.receive(frame(1, Array(47).fill(0.5)));
      f.handoff.stop(cancelled);
      assert.throws(
        () => f.handoff.receive(terminal(1, reason)),
        /mel_native_integrity_failure/,
      );
      assert.throws(() => f.handoff.timeline(), /not_settled/);
      f.drain(4, 1);
      assert.throws(() => f.handoff.timeline(), /not_settled/);
      assert.match(
        f.handoff.snapshot().integrityFailure,
        /mel_native_integrity_failure/,
      );
    }
  });
}

test("local failure cleanup cannot claim a clock before its retained prefix", () => {
  const f = fixture();
  f.start();
  f.handoff.receive(frame(1));
  f.handoff.receive(terminal(1, 6));
  assert.throws(
    () => f.drain(4, 1, 1, 1, origin + 2047),
    /mel_terminal_clock_before_retained_frames/,
  );
  assert.equal(f.handoff.snapshot().completed, false);
});

for (const values of [
  Array(47).fill(0.5),
  Array(49).fill(0.5),
  [...Array(47).fill(0.5), NaN],
  [...Array(47).fill(0.5), -1],
  [...Array(47).fill(0.5), codec.MAX_MEL_BAND_MAGNITUDE + 1],
]) {
  test(`mel-local malformed vector (${String(values.at(-1))}, length ${values.length}) preserves an independently valid prefix`, () => {
    const f = fixture();
    f.start();
    f.handoff.receive(frame(1));
    f.handoff.receive(frame(2, values));
    f.advance();
    assert.ok(f.controls.some(([kind]) => kind === "stop"));
    f.handoff.receive(terminal(2, 1));
    f.drain(5, 2);
    const timeline = f.handoff.timeline();
    assert.equal(timeline.status, "partial");
    assert.equal(timeline.frames.length, 1);
    assert.deepEqual(timeline.gaps, [
      {
        firstIndex: 1,
        count: 1,
        support: {
          startSample: origin + 2048,
          endSample: origin + 4096,
        },
        reason: "malformed-record",
      },
    ]);
    assert.equal(f.events.filter(({ stage }) => stage === "failed").length, 1);
  });
}

test("all invalid vectors are an explicit failed metric, never measured silence", () => {
  const f = fixture();
  f.start();
  f.handoff.receive(frame(1, Array(48).fill(NaN)));
  f.advance();
  f.handoff.receive(terminal(1, 1));
  f.drain(4, 1);
  const timeline = f.handoff.timeline();
  assert.equal(timeline.status, "failed");
  assert.equal(timeline.frames.length, 0);
  assert.equal(timeline.gaps[0].count, 2);
});

test("genuine zero magnitudes remain valid complete measured vectors", () => {
  const f = fixture();
  f.start();
  f.handoff.receive(frame(1, Array(48).fill(0)));
  f.handoff.receive(frame(2, Array(48).fill(0)));
  f.handoff.receive(terminal());
  f.drain(5, 2);
  assert.equal(f.handoff.timeline().status, "complete");
});

test("wrong origin, frame support, sequence, epoch and generation fail closed", () => {
  for (const mutate of [
    (packet) => {
      packet[2]++;
    },
    (packet) => {
      packet[3]++;
    },
    (packet) => {
      packet[4]++;
    },
    (packet) => {
      packet[5]++;
    },
    (packet) => {
      packet[6]++;
    },
  ]) {
    const f = fixture();
    f.start();
    const packet = frame(1);
    mutate(packet);
    assert.throws(() => f.handoff.receive(packet), /mel_/);
  }
  const f = fixture();
  f.ready();
  f.handoff.bind({ startSample: origin + 1, endSample: end + 1 });
  assert.throws(
    () => f.handoff.receive(["mel_started", ...header(0, origin, end)]),
    /capture_origin_mismatch/,
  );
});

test("unobserved, duplicated, stale and incomplete terminal receipts cannot complete acquisition", () => {
  const unobserved = fixture();
  unobserved.start();
  assert.throws(() => unobserved.drain(2, 0), /unobserved_terminal/);
  const incomplete = fixture();
  incomplete.start();
  incomplete.handoff.receive(frame(1));
  assert.throws(
    () => incomplete.handoff.receive(terminal(1)),
    /incomplete_normal_terminal/,
  );
  for (const [records, frames, consumed, clockValid, clock] of [
    [4, 2, 1, 1, end],
    [5, 1, 1, 1, end],
    [5, 2, 0, 1, end],
    [5, 2, 1, 0, end],
    [5, 2, 1, 1, end - 1],
  ]) {
    const f = fixture();
    f.start();
    f.handoff.receive(frame(1));
    f.handoff.receive(frame(2));
    f.handoff.receive(terminal());
    assert.throws(
      () => f.drain(records, frames, consumed, clockValid, clock),
      /mel_/,
    );
    assert.equal(f.handoff.snapshot().completed, false);
  }
  const f = fixture();
  f.start();
  f.handoff.receive(frame(1));
  assert.throws(() => f.handoff.receive(frame(1)), /sequence_mismatch/);
  assert.throws(
    () => f.handoff.receive(["mel_drain", 2, 999, 3, 7, 3, 1, 0, 0, 0]),
    /invalid_drain_receipt/,
  );
});

test("cancellation requires a physical terminal and never publishes a timeline", () => {
  const f = fixture();
  f.start();
  f.handoff.receive(frame(1));
  assert.equal(f.handoff.stop(true), false);
  f.advance();
  assert.equal(f.handoff.stop(true), false);
  f.handoff.receive(terminal(1, 1));
  f.drain(4, 1, 1, 1, origin + 2500);
  assert.equal(f.handoff.stop(true), true);
  assert.throws(() => f.handoff.timeline(), /not_settled/);
  assert.equal(f.events.filter(({ stage }) => stage === "cancelled").length, 1);
  assert.equal(f.controls.filter(([kind]) => kind === "stop").length, 1);
});

test("unknown native faults remain shared integrity failures", () => {
  const f = fixture();
  f.start();
  assert.throws(
    () => f.handoff.receive(terminal(0, 99)),
    /mel_native_integrity_failure_99/,
  );
});

test("progress, control attempts and rearming are bounded", () => {
  const f = fixture();
  f.start();
  assert.throws(() => f.handoff.arm(), /already_armed/);
  f.handoff.receive(frame(1));
  f.handoff.receive(frame(2));
  assert.equal(f.events.filter(({ stage }) => stage === "progress").length, 1);
  for (let index = 0; index < 12000; index++) f.advance();
  assert.throws(() => f.advance(), /drain_attempt_limit/);
});
