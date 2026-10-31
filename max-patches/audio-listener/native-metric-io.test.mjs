import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { genModel } from "./gen-model.mjs";
import { retainedNativeSpectrumSource } from "./retained-native-source.mjs";
import {
  NativeMessageIO,
  GENERATION,
  OTHER,
  EPOCH,
  spectrumFixture,
  classicFixture,
} from "./native-metric-io-test-helpers.mjs";

const require = createRequire(import.meta.url);
const {
  decodeRetentionSnapshot,
  decodeRetentionRejection,
  decodeIORejection,
  RETENTION_REJECTION_LENGTH,
  RETENTION_SNAPSHOT_LENGTH,
  IO_REJECTION_LENGTH,
} = require("./audio_listener_native_io.js");

test("clock reader never forwards a host tuple that changes during its acquisition", () => {
  const packets = [];
  const io = new NativeMessageIO(
    "clock",
    (packet) => packets.push(packet),
    () => {},
    assert.fail,
    { now: () => 0 },
  );
  io.begin(GENERATION, EPOCH, 48000);
  for (let index = 0; index < 32; index++) {
    io.anchorPre([0, 0, 100, 31]);
    io.anchorClock([164, 0, 164, 2]);
    assert.equal(io.anchorPost([0, 0, 164, 31]), false);
  }
  assert.equal(packets.filter((packet) => packet[2] === "clock").length, 0);
  assert.equal(
    packets.filter((packet) => packet[2] === "clock-cohort-skipped").length,
    3,
  );
  io.anchorPre([0, 0, 100, 31]);
  io.anchorClock([164, 0, 164, 2]);
  assert.equal(io.anchorPost([0, 0, 100, 31]), true);
  assert.deepEqual(packets.at(-1), [
    "native",
    GENERATION,
    "clock",
    0,
    0,
    100,
    31,
    164,
    0,
    164,
    0,
    0,
    100,
    31,
  ]);
});

test("clock reader does not repair differing native counter bookends", () => {
  const packets = [];
  const io = new NativeMessageIO(
    "clock",
    (packet) => packets.push(packet),
    () => {},
    assert.fail,
    { now: () => 0 },
  );
  io.begin(GENERATION, EPOCH, 48000);
  io.anchorPre([0, 0, 100, 31]);
  io.anchorClock([164, 0, 165, 2]);
  assert.equal(io.anchorPost([0, 0, 100, 31]), false);
  assert.ok(!packets.some((packet) => packet[2] === "clock"));
});

function deliverOne(f) {
  f.advance();
  assert.equal(f.poll(), false);
  assert.equal(f.poll(), true);
  assert.equal(f.io.retentionReader.stats().accepted, 1);
}

test("FFT startup waits for genuinely executed epoch instead of rejecting the previous idle bank", () => {
  const f = spectrumFixture();
  const idle = [...f.advance()];
  f.begin();
  const controls = f.controls.length;
  assert.equal(f.poll(idle), false);
  assert.equal(f.io.retentionReader.stats().state, "started");
  assert.equal(f.io.retentionReadySent, false);
  assert.equal(f.controls.length, controls);
  deliverOne(f);
  assert.equal(f.io.retentionReadySent, true);
});

test("the real Max adapter sends named Gen parameter messages, not lists whose selectors can be ignored", () => {
  const { context, controls, controlDeliveryKinds } = classicFixture();
  context.begin(GENERATION, EPOCH, 48000);
  assert.deepEqual(controls.slice(0, 3), [
    ["measurementReadSequence", 1],
    ["measurementAcknowledged", 0],
    ["measurementEpoch", EPOCH],
  ]);
  assert(controlDeliveryKinds.every((kind) => kind === "named"));
});

test("an idle FFT bank after executed readiness remains ownership corruption", () => {
  const f = spectrumFixture();
  f.begin();
  deliverOne(f);
  f.model.configure({ measurementEpoch: 0 });
  assert.equal(f.poll(f.advance()), false);
  assert.equal(f.io.retentionReader.stats().state, "failed");
});

test("classic Max includes the reader even when its require returns an incompatible namespace", () => {
  const { context, controls } = classicFixture(
    "spectrum",
    ["spectrum", "metric-v1"],
    { maxRequire: true },
  );
  assert.equal(context.begin(GENERATION, EPOCH, 48000), true);
  assert.deepEqual(controls.slice(0, 3), [
    ["measurementReadSequence", 1],
    ["measurementAcknowledged", 0],
    ["measurementEpoch", EPOCH],
  ]);
});

test("reader construction failure is bounded and redacted before owned cleanup", () => {
  const f = spectrumFixture();
  f.io.retentionAPI = {
    createReader() {
      throw new TypeError(
        "token=ghp_private_test_credential " + "x".repeat(200),
      );
    },
  };
  assert.throws(() => f.begin(), TypeError);
  const evidence = f.packets.find(
    (packet) => packet[2] === "spectrum-start-error",
  );
  assert.deepEqual(evidence.slice(0, 5), [
    "native",
    GENERATION,
    "spectrum-start-error",
    EPOCH,
    "TypeError",
  ]);
  assert(evidence[5].length <= 128);
  assert(evidence[5].includes("[redacted]"));
  assert(!evidence[5].includes("private_test_credential"));
  assert.deepEqual(f.controls, []);
  f.request("failed");
  f.poll(f.advance());
  f.poll(f.advance());
  assert.equal(f.evidence().status, "completed");
  assert.equal(f.io.release(GENERATION), true);
});

test("FFT phase provenance carries actual readout bookends, not the retained frame endpoint", () => {
  const f = spectrumFixture();
  f.begin();
  f.advance();
  const firstEnd = f.frame[15];
  f.advance();
  f.advance();
  assert.equal(f.poll(), false);
  assert.equal(f.poll(), true);
  const witness = f.packets.find((p) => p[2] === "spectrum-acquisition");
  assert.deepEqual(witness, [
    "native",
    GENERATION,
    "spectrum-acquisition",
    EPOCH,
    f.frame[0],
    f.frame[21],
    firstEnd,
  ]);
  assert.notEqual(witness[4], firstEnd);
  assert(witness[4] > firstEnd);
  assert.equal(f.io.retentionReader.stats().accepted, 1);
});

test("a lost proof-only FFT witness does not add another data ACK dependency", () => {
  const f = spectrumFixture({
    send: (packet) => packet[2] !== "spectrum-acquisition",
  });
  f.begin();
  deliverOne(f);
  assert.equal(
    f.packets.filter((p) => p[2] === "spectrum-acquisition").length,
    1,
  );
  assert.equal(f.io.retentionReader.stats().accepted, 1);
  assert.equal(
    f.controls.filter((c) => c[0] === "measurementAcknowledged").at(-1)[1],
    1,
  );
});

test("the Max watchdog releases only its FFT owner after genuine executed disarm", () => {
  const { f, context: c, controls } = classicFixture();
  c.begin(GENERATION, EPOCH, 48000);
  const count = controls.length;
  assert.equal(c.metric_spectrum_guard_stop(OTHER), false);
  assert.equal(controls.length, count);
  assert.equal(c.metric_spectrum_guard_stop(GENERATION), true);
  const cleanup = c.nativeIO.spectrumCleanupState;
  assert.equal(c.nativeIO.generation, GENERATION);
  c.spectrum_measurement_frame(...f.advance());
  assert.equal(c.nativeIO.spectrumCleanupState.status, "pending");
  assert.equal(c.nativeIO.generation, GENERATION);
  const cleared = f.advance();
  c.spectrum_measurement_frame(...cleared);
  assert.equal(cleanup.status, "completed");
  assert.equal(cleanup.receipt.nativeSourceCounter, cleared[0]);
  assert.equal(c.nativeIO.generation, null);
  assert.deepEqual(controls.at(-1), ["poll", 0]);
});

test("a missing FFT watchdog disarm receipt remains an explicit bounded failure", () => {
  const { f, context: c, controls } = classicFixture();
  c.begin(GENERATION, EPOCH, 48000);
  c.metric_spectrum_guard_stop(GENERATION);
  const unchanged = f.advance();
  f.setTime(2011);
  assert.equal(c.spectrum_measurement_frame(...unchanged), false);
  assert.equal(c.nativeIO.spectrumCleanupState.status, "failed");
  assert.equal(c.nativeIO.spectrumCleanupState.receipt, null);
  assert.equal(c.nativeIO.generation, GENERATION);
  assert.deepEqual(controls.at(-1), ["poll", 0]);
});

function acquire(f) {
  const actual = f.advance();
  assert.equal(f.poll(), false);
  assert.equal(f.evidence().phase, "awaiting-disabled");
  assert.equal(f.evidence().stopWatermark, actual[0]);
  return actual;
}
function disabled(f) {
  const actual = f.advance();
  assert.equal(f.poll(), true);
  assert.equal(f.evidence().status, "completed");
  assert.deepEqual(f.evidence().receipt.value.raw, actual.slice(1, -1));
  return actual;
}

test("advancing FFT counter bookends discard the acquisition without admitting or acknowledging data", () => {
  const f = spectrumFixture();
  f.begin();
  const row = f.advance();
  const controls = f.controls.length;
  const torn = [...row];
  torn[21] += 64;
  assert.equal(f.poll(torn), false);
  assert.equal(f.io.spectrumInputFailure, false);
  assert.equal(f.io.retentionReader.stats().state, "started");
  assert.equal(f.io.retentionReader.stats().accepted, 0);
  assert.equal(f.controls.length, controls);
  assert.equal(f.io.spectrumCounterHighWater, -1);
  assert.equal(f.poll(), false);
  assert.equal(f.poll(), true);
  assert.equal(f.io.retentionReader.stats().accepted, 1);
  assert.equal(
    f.packets.filter((p) => p[2] === "retention-unstable").length,
    1,
  );
  assert(f.packets.every((p) => p[1] === GENERATION));
  f.request();
  acquire(f);
  disabled(f);
  assert.equal(f.io.release(GENERATION), true);
});

test("actual Max FFT selector discards torn readout and recovers with the executed Gen counter", () => {
  const { f, context: c, packets, controls } = classicFixture();
  c.begin(GENERATION, EPOCH, 48000);
  const row = f.advance();
  const torn = [...row];
  torn[21] += 64;
  const controlCount = controls.length;
  assert.equal(c.spectrum_measurement_frame(...torn), false);
  assert.equal(c.nativeIO.spectrumInputFailure, false);
  assert.equal(controls.length, controlCount);
  assert.equal(c.spectrum_measurement_frame(...row), false);
  assert.equal(c.spectrum_measurement_frame(...row), true);
  assert.equal(packets.filter((p) => p[2] === "spectrum").length, 1);
  assert.equal(c.nativeIO.retentionReader.stats().accepted, 1);
});

for (const corruption of ["backwards-bookend", "regressing-cohort"])
  test(`FFT ${corruption} is still rejected rather than retried`, () => {
    const f = spectrumFixture();
    f.begin();
    deliverOne(f);
    const row = [...f.frame];
    if (corruption === "backwards-bookend") row[21]--;
    else {
      row[0] -= 64;
      row[21] += 64;
    }
    assert.equal(f.poll(row), false);
    assert.equal(f.io.spectrumInputFailure, true);
    assert.equal(f.io.retentionReader.stats().accepted, 1);
    assert.equal(
      f.packets.filter((p) => p[2] === "retention-unstable").length,
      0,
    );
  });

for (const outcome of ["complete", "failed", "cancelled"])
  test(`advancing FFT cleanup bookends cannot fabricate a ${outcome} watermark or disabled receipt`, () => {
    const f = spectrumFixture();
    f.begin();
    deliverOne(f);
    const reader = f.io.retentionReader;
    f.request(outcome);
    const controls = f.controls.length;
    const watermark = [...f.advance()];
    watermark[21] += 64;
    assert.equal(f.poll(watermark), false);
    assert.equal(f.evidence().status, "pending");
    assert.equal(f.evidence().stopWatermark, null);
    assert.equal(f.controls.length, controls);
    acquire(f);
    const receipt = [...f.advance()];
    receipt[21] += 64;
    assert.equal(f.poll(receipt), false);
    assert.equal(f.evidence().status, "pending");
    assert.equal(f.evidence().receipt.available, false);
    assert.equal(f.io.generation, GENERATION);
    disabled(f);
    assert.equal(f.evidence().outcome, outcome);
    assert.equal(reader.stats().accepted, 1);
    assert.equal(f.io.release(GENERATION), true);
  });

test("continually advancing FFT acquisitions still expire the original cleanup deadline", () => {
  const f = spectrumFixture();
  f.begin();
  deliverOne(f);
  f.request();
  const torn = [...f.advance()];
  torn[21] += 64;
  assert.equal(f.poll(torn), false);
  assert.equal(f.evidence().deadlineMs, 100);
  f.setTime(101);
  assert.equal(f.poll(torn), false);
  assert.equal(f.evidence().status, "failed");
  assert.equal(f.evidence().receipt.available, false);
  const evidence = f.evidence();
  assert.equal(evidence.diagnosticOnly, true);
  assert.equal(f.io.release(GENERATION), true);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.receipt.available, false);
});

for (const rate of [44100, 48000])
  for (const outcome of ["complete", "failed", "cancelled"])
    test(`${rate}/${outcome}: sole retained reader atomically stops only after actual fresh disabled DSP`, () => {
      const f = spectrumFixture({ rate });
      f.begin();
      deliverOne(f);
      const reader = f.io.retentionReader;
      assert.deepEqual(f.controls.slice(-2), [
        ["measurementReadSequence", 2],
        ["measurementAcknowledged", 1],
      ]);
      const controls = f.controls.length;
      assert.equal(f.request(outcome), true);
      const queued = f.evidence();
      assert.equal(queued.status, "pending");
      assert.equal(queued.stopWatermark, null);
      assert.equal(queued.watermarkReceipt.available, false);
      assert.equal(queued.receipt.available, false);
      assert.equal(f.io.retentionReader, reader);
      assert.equal(f.poll(), false);
      assert.equal(f.controls.length, controls);
      f.setTime(20);
      const captured = acquire(f);
      const watermark = f.evidence().watermarkReceipt.value;
      assert.deepEqual(watermark.raw, captured.slice(1, -1));
      assert.equal(watermark.nativeSourceCounter, captured[0]);
      assert.equal(watermark.observedHostReceiptMs, 20);
      assert.equal(watermark.raw[1], EPOCH);
      assert.equal(f.evidence().receipt.available, false);
      assert.equal(f.evidence().deadlineMs, 100);
      assert.equal(f.evidence().requestedHostMs, 10);
      assert.equal(f.poll(), false);
      f.setTime(22);
      const zero = disabled(f);
      const evidence = f.evidence();
      assert.equal(evidence.phase, "disabled-confirmed");
      assert.equal(evidence.outcome, outcome);
      assert.equal(evidence.diagnosticOnly, outcome !== "complete");
      assert.equal(evidence.watermarkReceipt.value, watermark);
      assert.equal(evidence.receipt.value.nativeSourceCounter, zero[0]);
      assert.equal(evidence.receipt.value.counterBefore, zero[0]);
      assert.equal(evidence.receipt.value.counterAfter, zero.at(-1));
      assert.equal(evidence.receipt.value.observedHostReceiptMs, 22);
      assert(zero[0] > evidence.stopWatermark);
      assert.equal(reader.stats().accepted, 1);
      assert.equal(
        reader.stats().state,
        outcome === "complete" ? "completed" : outcome,
      );
      assert.equal(f.io.generation, GENERATION);
      assert.equal(f.io.retentionEpoch, EPOCH);
      assert.deepEqual(f.controls.slice(controls), [["measurementEpoch", 0]]);
      assert.deepEqual(
        f.packets
          .filter((p) => p[2] === "spectrum-cleanup-state")
          .map((p) => p[4]),
        [0, 1, 2, 3],
      );
      assert.equal(f.io.release(GENERATION), true);
      assert.equal(f.evidence(), false);
      assert.equal(f.poll(zero), false);
    });

test("no delivered FFT records is not resource-disarm denial or an observation-success claim", () => {
  const f = spectrumFixture();
  f.begin();
  f.request();
  acquire(f);
  disabled(f);
  assert.equal(f.packets.filter((p) => p[2] === "spectrum").length, 0);
  assert.equal("sourceCoverage" in f.evidence(), false);
  assert.equal("observation" in f.evidence(), false);
});

for (const [kind, value] of [
  ["nan", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["huge", 1e200],
  ["string", "private bearer token"],
  ["null", null],
])
  for (const index of [11, 12, 13, 14, 15, 16])
    test(`active payload ${kind} cell ${index}: malformed FFT data fails only the family and preserves confirmed cleanup`, () => {
      const f = spectrumFixture();
      f.begin();
      deliverOne(f);
      const reader = f.io.retentionReader;
      const row = [...f.advance()];
      row[index] = value;
      const acks = f.controls.filter(
        (control) => control[0] === "measurementAcknowledged",
      ).length;
      assert.equal(f.poll(row), false);
      assert.equal(reader.stats().state, "failed");
      assert.equal(reader.stats().accepted, 1);
      assert.equal(f.io.spectrumInputFailure, false);
      assert.equal(
        f.packets.some((packet) => packet[2] === "ioError"),
        false,
      );
      const rejection = f.packets.find(
        (packet) => packet[2] === "retention-rejection",
      );
      assert(rejection);
      assert.equal(
        decodeRetentionRejection(rejection.slice(3)).readerReason,
        "invalid_numeric",
      );
      assert.doesNotMatch(JSON.stringify(f.packets), /private|bearer|token/);
      assert.equal(
        f.controls.filter((control) => control[0] === "measurementAcknowledged")
          .length,
        acks,
      );
      assert.equal(f.request("failed"), true);
      acquire(f);
      disabled(f);
      assert.equal(f.evidence().diagnosticOnly, true);
      assert.equal(reader.stats().state, "failed");
      assert.equal(reader.stats().accepted, 1);
    });

test("active malformed FIFO ownership is shared corruption, not a local metric-value failure", () => {
  const f = spectrumFixture();
  f.begin();
  deliverOne(f);
  const row = [...f.advance()];
  row[4] = row[18] = Number.NaN;
  assert.equal(f.poll(row), false);
  assert.equal(f.io.retentionReader.stats().accepted, 1);
  assert.equal(
    f.packets.some((packet) => packet[2] === "ioError"),
    true,
  );
});

for (const phase of ["acquiring", "disabled"])
  for (const corruption of [
    "counter",
    "nan",
    "fractional",
    "foreign",
    "footer",
    "abi",
    "arity",
    "body",
  ])
    test(`${phase}/${corruption}: malformed owned source is terminal and never ACKed or admitted`, () => {
      const f = spectrumFixture();
      f.begin();
      deliverOne(f);
      f.request();
      if (phase === "disabled") acquire(f);
      const row = [...f.advance()];
      if (corruption === "counter") row[21]--;
      if (corruption === "nan") row[0] = row[21] = Number.NaN;
      if (corruption === "fractional") row[0] = row[21] = row[0] + 0.5;
      if (corruption === "foreign") row[2] = row[20] = EPOCH + 1;
      if (corruption === "footer") row[19]++;
      if (corruption === "abi") row[1] = 9;
      if (corruption === "arity") row.pop();
      if (corruption === "body") row[phase === "disabled" ? 11 : 3] = 0.5;
      const acks = f.controls.filter(
        (c) => c[0] === "measurementAcknowledged",
      ).length;
      assert.equal(f.poll(row), false);
      assert.equal(f.evidence().status, "failed");
      assert.equal(f.evidence().diagnosticOnly, true);
      assert.equal(f.evidence().receipt.available, false);
      assert.equal(
        f.evidence().watermarkReceipt.available,
        phase === "disabled",
      );
      assert.equal(f.poll(f.advance()), false);
      assert.equal(f.evidence().status, "failed");
      assert.equal(
        f.controls.filter((c) => c[0] === "measurementAcknowledged").length,
        acks,
      );
      assert.deepEqual(f.controls.at(-1), ["measurementEpoch", 0]);
      assert.equal(f.io.generation, GENERATION);
    });

for (const phase of ["acquiring", "disabled"])
  test(`${phase}: fixed caller deadline expires without fabricated source evidence or age renewal`, () => {
    const f = spectrumFixture();
    f.begin();
    deliverOne(f);
    f.request("complete", 40);
    if (phase === "disabled") acquire(f);
    const receipt = f.evidence().watermarkReceipt;
    for (const time of [20, 30, 39]) {
      f.setTime(time);
      assert.equal(f.io.spectrumCleanupTick(GENERATION, EPOCH), true);
      assert.equal(f.evidence().deadlineMs, 40);
      assert.equal(f.evidence().requestedHostMs, 10);
      assert.equal(f.evidence().watermarkReceipt.value, receipt.value);
      assert.equal(f.request("complete", 200), false);
    }
    f.setTime(40);
    assert.equal(f.io.spectrumCleanupTick(GENERATION, EPOCH), false);
    assert.equal(f.evidence().reason, "deadline");
    assert.equal(f.evidence().receipt.available, false);
    assert.equal(f.evidence().stopWatermark === null, phase === "acquiring");
    assert.equal(f.poll(f.advance()), false);
    assert.equal(f.evidence().status, "failed");
  });

test("stale generations are ignored, same-generation epoch forgery is fatal, and replacement has no old receipts", () => {
  const f = spectrumFixture();
  f.begin();
  deliverOne(f);
  f.request();
  const row = f.advance();
  assert.equal(f.poll(row, OTHER), false);
  assert.equal(f.evidence().status, "pending");
  assert.equal(f.poll(row, GENERATION, EPOCH + 1), false);
  assert.equal(f.evidence().status, "failed");
  f.io.release(GENERATION);
  assert.equal(f.begin(OTHER, EPOCH + 1), true);
  assert.equal(f.poll(row), false);
  assert.equal(f.evidence(), false);
  assert.equal(f.io.spectrumCleanupEvidence(OTHER, EPOCH + 1), false);
});

test("overflow is a failed FFT family, but actual cleared FIFO still provides genuine resource-disarm evidence", () => {
  const f = spectrumFixture();
  f.begin();
  for (let n = 0; n < 33; n++) f.advance();
  f.poll();
  const reader = f.io.retentionReader;
  assert.equal(reader.stats().reason, "unread_capacity_overflow");
  f.request();
  acquire(f);
  disabled(f);
  assert.equal(reader.stats().state, "failed");
  assert.equal(f.evidence().receipt.value.raw[9], 0);
  assert(!f.packets.some((p) => p[2] === "ioError"));
});

for (const behavior of ["reject", "throw"])
  test(`synchronous owned forwarding ${behavior} never ACKs or invents a second reader`, () => {
    const f = spectrumFixture({
      send: (packet) => {
        if (packet[2] !== "spectrum") return;
        if (behavior === "throw") throw new Error("private forwarding failure");
        return false;
      },
    });
    f.begin();
    f.advance();
    const reader = f.io.retentionReader;
    f.poll();
    assert.equal(f.poll(), false);
    assert.equal(f.io.retentionReader, reader);
    assert.equal(reader.stats().accepted, 0);
    assert.equal(reader.stats().state, "failed");
    assert(!f.packets.some((p) => p[2] === "ioError"));
    assert(
      !f.controls.some((c) => c[0] === "measurementAcknowledged" && c[1] > 0),
    );
    assert.doesNotMatch(
      JSON.stringify(f.packets),
      /private|forwarding failure/,
    );
    f.request("failed");
    acquire(f);
    disabled(f);
  });

for (const stage of [0, 1, 2, 3])
  test(`cleanup event ${stage} delivery failure disables source and remains diagnostic-only`, () => {
    let reject = true;
    const f = spectrumFixture({
      send: (packet) => {
        if (
          reject &&
          packet[2] === "spectrum-cleanup-state" &&
          packet[4] === stage
        ) {
          reject = false;
          throw new Error("private event secret");
        }
      },
    });
    f.begin();
    deliverOne(f);
    if (stage < 2) assert.throws(() => f.request(), /private event secret/);
    else {
      f.request();
      if (stage === 3) acquire(f);
      f.advance();
      assert.throws(() => f.poll(), /private event secret/);
    }
    assert.equal(f.evidence().status, "failed");
    assert.equal(f.evidence().reason, "event_delivery_failed");
    assert.equal(f.evidence().diagnosticOnly, true);
    assert.equal(f.evidence().receipt.available, stage === 3);
    assert.equal(f.io.retentionReader, null);
    assert.deepEqual(f.controls.at(-1), ["measurementEpoch", 0]);
    assert.doesNotMatch(JSON.stringify(f.evidence()), /private|secret/);
    assert.deepEqual(f.diagnostics, [
      "native_io_spectrum_cleanup_event_failed",
    ]);
  });

test("control delivery failure cannot become a completed receipt when a later disabled row arrives", () => {
  const f = spectrumFixture({
    control: ([name, value]) => {
      if (name === "measurementEpoch" && value === 0)
        throw new Error("private control failure");
    },
  });
  f.begin();
  deliverOne(f);
  f.request();
  f.advance();
  assert.throws(() => f.poll(), /private control failure/);
  assert.equal(f.evidence().reason, "control_failed");
  assert.equal(f.evidence().status, "failed");
  assert.equal(f.poll(f.advance()), false);
});

for (const value of ["throw", "nan", "regress"])
  test(`host clock ${value} fails without source-counter substitution`, () => {
    let bad = false;
    const f = spectrumFixture({
      now: (time) => {
        if (!bad) return time;
        if (value === "throw") throw new Error("private clock failure");
        return value === "nan" ? Number.NaN : 9;
      },
    });
    f.begin();
    deliverOne(f);
    f.request();
    bad = true;
    if (value === "throw")
      assert.throws(
        () => f.io.spectrumCleanupTick(GENERATION, EPOCH),
        /private clock failure/,
      );
    else assert.equal(f.io.spectrumCleanupTick(GENERATION, EPOCH), false);
    assert.equal(f.evidence().status, "failed");
    assert.equal(f.evidence().stopWatermark, null);
    assert.equal(f.evidence().receipt.available, false);
    assert.doesNotMatch(JSON.stringify(f.evidence()), /private/);
  });

for (const phase of ["queued", "acquired", "completed", "control"])
  test(`reentrant replacement at ${phase} cannot disable, fail or ACK the new owner`, () => {
    let replace = true;
    function replacement(io) {
      replace = false;
      assert.equal(io.release(GENERATION), true);
      assert.equal(io.begin(OTHER, EPOCH + 1, 48000), true);
    }
    const f = spectrumFixture({
      send: (packet, io) => {
        const stage = { queued: 0, acquired: 2, completed: 3 }[phase];
        if (
          replace &&
          packet[2] === "spectrum-cleanup-state" &&
          packet[4] === stage
        )
          replacement(io);
      },
      control: ([name, value], io) => {
        if (
          replace &&
          phase === "control" &&
          name === "measurementEpoch" &&
          value === 0
        ) {
          replacement(io);
          throw new Error("old callback failure");
        }
      },
    });
    f.begin();
    deliverOne(f);
    if (phase === "queued") assert.equal(f.request(), false);
    else {
      f.request();
      f.advance();
      if (phase === "control")
        assert.throws(() => f.poll(), /old callback failure/);
      else {
        f.poll();
        if (phase === "completed") f.poll(f.advance());
      }
    }
    assert.equal(f.io.generation, OTHER);
    assert.equal(f.io.retentionEpoch, EPOCH + 1);
    assert.equal(f.io.retentionReader.stats().state, "started");
    assert.deepEqual(
      f.controls.filter((control) => control[0] === "measurementEpoch").at(-1),
      ["measurementEpoch", EPOCH + 1],
    );
    assert.equal(f.evidence(), false);
  });

test("early release explicitly fails while owner is retained; no completed/stopped substitute", () => {
  let observed = false;
  const f = spectrumFixture({
    send: (packet, io) => {
      if (packet[2] === "spectrum-cleanup-state" && packet[4] === 4)
        observed = io.generation === GENERATION && io.retentionEpoch === EPOCH;
    },
  });
  f.begin();
  f.request();
  assert.equal(f.io.release(GENERATION), true);
  assert.equal(observed, true);
  assert.equal(f.io.generation, null);
  assert(!f.packets.some((p) => p[2] === "stopped"));
});

test("receipts are fixed-size immutable slots and explicit getters never refresh acquisition age", () => {
  const f = spectrumFixture();
  f.begin();
  deliverOne(f);
  f.request();
  acquire(f);
  disabled(f);
  const evidence = f.evidence(),
    count = f.packets.length;
  assert(Object.isFrozen(evidence));
  for (const name of ["watermarkReceipt", "receipt"]) {
    assert(Object.isFrozen(evidence[name]));
    assert(Object.isFrozen(evidence[name].value));
    assert(Object.isFrozen(evidence[name].value.raw));
    assert.throws(() => {
      evidence[name].value.raw[0] = 0;
    }, TypeError);
  }
  assert(JSON.stringify(evidence).length < 4096);
  for (let n = 0; n < 100; n++) {
    f.setTime(1000 + n);
    assert.deepEqual(f.evidence(), evidence);
    assert.equal(f.poll(f.advance()), false);
  }
  assert.equal(f.packets.length, count);
});

test("executed counter tap preserves all production Gen outputs and crosses split-counter carry exactly", () => {
  const source = retainedNativeSpectrumSource();
  const plain = genModel(source.code, source.outputs);
  const tapped = genModel(`${source.code}\nout32 = sourceClock;`, 32);
  for (let n = 0; n < 4096; n++) {
    const counter = 1048576 - 2048 + n;
    const args = [
      0,
      0,
      0,
      0,
      n % 2048,
      counter % 1048576,
      Math.floor(counter / 1048576),
    ];
    const actual = tapped.step(...args);
    assert.deepEqual(actual.slice(0, 31), plain.step(...args));
    assert.equal(actual[31], counter);
  }
});

test("compact new-path diagnostics are bounded, redacted, throttled and reject former framing", () => {
  const f = spectrumFixture({ deferControls: true });
  f.begin();
  for (let t = 0; t <= 1000; t += 10) {
    f.setTime(t);
    f.poll(f.advance());
  }
  const snapshots = f.packets.filter((p) => p[2] === "retention-snapshot");
  assert.equal(snapshots.length, 5);
  for (const p of snapshots) {
    assert.equal(p.length - 3, RETENTION_SNAPSHOT_LENGTH);
    const decoded = decodeRetentionSnapshot(p.slice(3));
    assert.equal(decoded.family, 2);
    assert(decoded.readbacks.length <= 3);
    assert(decoded.readbacks.every((r) => r.cells.length <= 22));
  }
  assert.equal(decodeRetentionSnapshot(Array(188).fill(0)), null);
  assert.equal(decodeRetentionRejection(Array(187).fill(0)), null);
  assert.equal(decodeIORejection(Array(71).fill(0)), null);
  const bad = spectrumFixture();
  bad.begin();
  const raw = bad.advance();
  const corrupted = [...raw];
  corrupted[11] = "private bearer token";
  bad.poll(corrupted);
  const rejection = bad.packets.find(
    (packet) => packet[2] === "retention-rejection",
  );
  assert.equal(
    decodeRetentionRejection(rejection.slice(3)).readerReadbacks.at(-1)
      .cells[10],
    "invalid:string",
  );
  assert.doesNotMatch(JSON.stringify(bad.packets), /private|bearer|token/);
  const invalidMetadata = spectrumFixture();
  invalidMetadata.begin();
  invalidMetadata.io.spectrumDiagnostics([0, "private bearer token", 0, 0, 0]);
  assert.doesNotMatch(
    JSON.stringify(invalidMetadata.packets),
    /private|bearer|token/,
  );
  const io = invalidMetadata.packets.find((p) => p[2] === "io-rejection");
  assert.equal(io.length - 3, IO_REJECTION_LENGTH);
  assert.equal(decodeIORejection(io.slice(3)).nativeEpoch, EPOCH);
  assert.equal(RETENTION_REJECTION_LENGTH, 139);
});

test("single new Max entry owns real numeric banks and the explicit evidence/tick/release selectors", () => {
  const { f, context: c, packets, controls, setThrowGetter } = classicFixture();
  c.begin(GENERATION, EPOCH, 48000);
  f.advance();
  c.spectrum_measurement_frame(...f.frame);
  c.spectrum_measurement_frame(...f.frame);
  const before = controls.length;
  assert.equal(
    c.request_spectrum_stop(GENERATION, EPOCH, "complete", 100),
    true,
  );
  assert.equal(controls.length, before);
  f.setTime(20);
  const watermark = f.advance();
  assert.equal(c.spectrum_measurement_frame(...watermark), false);
  f.setTime(23);
  const zero = f.advance();
  assert.equal(c.spectrum_measurement_frame(...zero), true);
  assert(!packets.some((p) => p[0] === "native_metric_spectrum_cleanup"));
  c.spectrum_cleanup_evidence(GENERATION, EPOCH);
  const evidence = JSON.parse(packets.at(-1)[1]);
  assert.equal(packets.at(-1)[0], "native_metric_spectrum_cleanup");
  assert.deepEqual(evidence.watermarkReceipt.value.raw, watermark.slice(1, -1));
  assert.deepEqual(evidence.receipt.value.raw, zero.slice(1, -1));
  assert.equal(
    evidence.watermarkReceipt.value.nativeSourceCounter,
    watermark[0],
  );
  assert.equal(evidence.receipt.value.nativeSourceCounter, zero[0]);
  assert.equal(evidence.receipt.value.observedHostReceiptMs, 23);
  setThrowGetter(true);
  assert.throws(
    () => c.spectrum_cleanup_evidence(GENERATION, EPOCH),
    /private getter/,
  );
  setThrowGetter(false);
  c.spectrum_cleanup_evidence(GENERATION, EPOCH);
  assert.deepEqual(JSON.parse(packets.at(-1)[1]), evidence);
  assert.equal(c.release(GENERATION), true);
  assert.equal(c.spectrum_cleanup_evidence(GENERATION, EPOCH), false);
  assert.equal(c.stop, undefined);
  assert.equal(c.measurement_frame, undefined);
  assert.equal(c.envelope_frame, undefined);
});

for (const phase of ["active", "acquiring", "disabled", "completed"])
  test(`Max deletion during ${phase} never fabricates resource confirmation`, () => {
    const { f, context: c, packets } = classicFixture();
    c.begin(GENERATION, EPOCH, 48000);
    f.advance();
    c.spectrum_measurement_frame(...f.frame);
    if (phase !== "active")
      c.request_spectrum_stop(GENERATION, EPOCH, "cancelled", 100);
    if (["disabled", "completed"].includes(phase))
      c.spectrum_measurement_frame(...f.advance());
    if (phase === "completed") c.spectrum_measurement_frame(...f.advance());
    c.notifydeleted();
    assert.equal(c.nativeIO.retentionReader, null);
    assert.equal(f.advance()[2], 0);
    assert(!packets.some((p) => p[2] === "stopped"));
    const stages = packets
      .filter((p) => p[2] === "spectrum-cleanup-state")
      .map((p) => p[4]);
    if (phase !== "completed") assert(!stages.includes(3));
  });

test("only clock/spectrum metric-v1 can load; no versions, opt-ins, coupled capture, or latest/raw20 fallback", () => {
  for (const args of [
    ["spectrum", 2, "retention-v1", "spectrum-cleanup-v5"],
    ["spectrum", 2],
    ["envelope", "metric-v1"],
    ["clock", 1],
  ])
    assert.throws(
      () => classicFixture("spectrum", args),
      /unsupported_metric_io_mode|invalid_native_io_mode/,
    );
  for (const options of [
    { retainedMeasurements: true },
    { spectrumCleanupV5: true },
    2,
  ])
    assert.throws(
      () =>
        new NativeMessageIO(
          "spectrum",
          () => {},
          () => {},
          () => {},
          options,
        ),
      /invalid_metric_io_options/,
    );
  const f = spectrumFixture();
  for (const method of [
    "stop",
    "stopSpectrumV5",
    "releaseSpectrumV5",
    "retainedFrame",
    "arm",
    "configureV2",
    "configurationFrame",
    "envelope",
  ])
    assert.equal(f.io[method], undefined);
  const parse = createRequire(require.resolve("eslint/package.json"))(
    "espree",
  ).parse;
  parse(
    readFileSync(
      new URL("./audio_listener_native_io.js", import.meta.url),
      "utf8",
    ),
    { ecmaVersion: 5 },
  );
});
