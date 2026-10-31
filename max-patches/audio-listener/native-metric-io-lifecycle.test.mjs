import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
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
  decodeIORejection,
  IO_REJECTION_CHECKS,
} = require("./audio_listener_native_io.js");

function clockFixture(onControl = () => {}) {
  const packets = [],
    controls = [],
    diagnostics = [];
  let io;
  io = new NativeMessageIO(
    "clock",
    (p) => packets.push(p),
    (c) => {
      controls.push(c);
      onControl(c, io);
    },
    (d) => diagnostics.push(d),
    { now: () => 10 },
  );
  return { io, packets, controls, diagnostics };
}
function finish(f) {
  assert.equal(f.request(), true);
  f.poll(f.advance());
  assert.equal(f.poll(f.advance()), true);
  assert.equal(f.io.release(GENERATION), true);
}

for (const rate of [44100, 48000])
  test(`clock ${rate}: owned ABI2 pre/data/post cohort is passive and carries no manufactured source coverage`, () => {
    const f = clockFixture();
    assert.equal(f.io.begin(GENERATION, EPOCH, rate), true);
    assert.deepEqual(f.controls, [
      ["poll", 0],
      ["poll", 1],
    ]);
    const pre = [1, 2, 3, 31],
      body = [65536, 0, 65536, 2],
      post = pre.slice();
    assert.equal(f.io.anchorPre(pre), true);
    assert.equal(f.io.anchorClock(body), true);
    assert.equal(f.io.anchorPost(post), true);
    assert.deepEqual(f.packets, [
      ["native", GENERATION, "abi-clock", 2],
      ["native", GENERATION, "clock", ...pre, ...body.slice(0, 3), ...post],
    ]);
    assert(f.packets.every(Object.isFrozen));
    assert.equal(f.io.anchorPost(post), false);
    assert(f.packets.some((p) => p[2] === "ioError"));
    assert.equal(f.io.release(OTHER), false);
    assert.equal(f.io.release(GENERATION), true);
    assert.deepEqual(f.controls.at(-1), ["poll", 0]);
    assert.equal(f.io.anchorPre(pre), false);
    assert.equal(f.io.retentionReader, null);
    assert(!f.packets.some((p) => p[2] === "stopped"));
  });

for (const defect of ["abi", "nan", "pre", "post", "scope"])
  test(`clock ${defect}: unsupported or incomplete cohorts cannot emit a clock sample`, () => {
    const f = clockFixture();
    f.io.begin(GENERATION, EPOCH, 48000);
    if (defect !== "pre") f.io.anchorPre([1, 2, 3, 4]);
    f.io.anchorClock([100, 0, 1, defect === "abi" ? 1 : 2]);
    const post =
      defect === "nan"
        ? [0, 0, 0, Number.NaN]
        : defect === "post"
          ? [0]
          : [0, 0, 0, 0];
    if (defect === "scope") {
      assert.equal(f.io.packet("spectrum", [0, 0, 0, 0, 0, 0]), false);
      assert.equal(f.io.packet("config", [0, 0, 0, 0, 0, 0, 0]), false);
    } else assert.equal(f.io.anchorPost(post), false);
    assert(!f.packets.some((p) => p[2] === "clock"));
  });

test("clock release cannot recurse or replace its still-owned generation from poll-disable callbacks", () => {
  let releasing = false;
  const f = clockFixture(([name, value], io) => {
    if (releasing && name === "poll" && value === 0) {
      assert.equal(io.release(GENERATION), false);
      assert.equal(io.begin(OTHER, EPOCH + 1, 48000), false);
    }
  });
  f.io.begin(GENERATION, EPOCH, 48000);
  releasing = true;
  assert.equal(f.io.release(GENERATION), true);
  releasing = false;
  assert.equal(f.io.begin(OTHER, EPOCH + 1, 48000), true);
  assert.equal(f.io.generation, OTHER);
});

test("classic metric-v1 clock entry scopes live source metadata and releases only polling ownership", () => {
  const { context: c, packets, controls } = classicFixture("clock");
  assert.equal(c.begin(GENERATION, EPOCH, 48000), true);
  c.anchor_dsp(1, 48000, 64);
  c.tempo(120);
  c.anchor_pre(1, 2, 3, 31);
  c.anchor_clock(1024, 0, 1024, 2);
  c.anchor_post(1, 2, 3, 31);
  assert(packets.some((p) => p[2] === "clock"));
  assert.equal(
    c.request_spectrum_stop(GENERATION, EPOCH, "complete", 100),
    false,
  );
  c.notifydeleted();
  assert.equal(c.nativeIO.generation, null);
  assert.deepEqual(controls.at(-1), ["poll", 0]);
});

for (const rate of [44100, 48000])
  test(`${rate}: a retained request144 survives disabled reset and fresh owner restarts at sequence1`, () => {
    const f = spectrumFixture({ rate });
    f.begin();
    for (let sequence = 1; sequence <= 143; sequence++) {
      f.advance();
      f.poll();
      assert.equal(f.poll(), true);
    }
    assert.equal(f.io.retentionReader.stats().accepted, 143);
    finish(f);
    const reset = f.frame.slice(1, -1);
    assert.equal(reset[2], 144);
    assert.equal(reset[18], 144);
    assert.equal(reset[1], 0);
    assert.equal(f.begin(OTHER, EPOCH + 1), true);
    assert.equal(f.poll(f.frame, OTHER, EPOCH + 1), false);
    f.advance();
    f.poll(f.frame, OTHER, EPOCH + 1);
    assert.equal(f.poll(f.frame, OTHER, EPOCH + 1), true);
    assert.equal(f.io.retentionReader.stats().accepted, 1);
    assert.equal(f.io.retentionReader.stats().expectedSequence, 2);
  });

test("delayed Param application never turns startup pages into readiness or repeated ACKs", () => {
  const f = spectrumFixture({ deferControls: true });
  f.begin();
  f.poll(f.advance());
  assert.equal(f.io.retentionReadySent, false);
  assert.equal(f.io.retentionReader.stats().accepted, 0);
  f.flush();
  f.advance();
  f.poll();
  assert.equal(f.poll(), true);
  const acks = f.controls.filter(
    (c) => c[0] === "measurementAcknowledged" && c[1] > 0,
  );
  assert.equal(acks.length, 1);
  assert.equal(f.poll(), false);
  assert.equal(
    f.controls.filter((c) => c[0] === "measurementAcknowledged" && c[1] > 0)
      .length,
    1,
  );
  f.flush();
  f.advance();
  f.poll();
  assert.equal(f.poll(), true);
  const controls = f.controls.slice(-2);
  assert.deepEqual(controls, [
    ["measurementReadSequence", 3],
    ["measurementAcknowledged", 2],
  ]);
});

test("epoch reservation, UUID reuse denial and failed preflight cannot recycle prior source ownership", () => {
  const f = spectrumFixture();
  assert.equal(f.begin(), true);
  f.poll(f.advance());
  finish(f);
  assert.equal(f.begin(GENERATION, EPOCH + 1), false);
  assert.equal(f.begin(OTHER, EPOCH), false);
  assert.equal(f.begin(OTHER, EPOCH + 1), true);
  assert.equal(f.io.begin(GENERATION, EPOCH + 2, 48000), false);
  assert.equal(f.io.retentionEpochHighWater, EPOCH + 1);
});

for (const invalid of ["epoch", "rate", "generation"])
  test(`begin ${invalid} denial cannot initialize or mutate the source`, () => {
    const f = spectrumFixture();
    assert.equal(
      f.io.begin(
        invalid === "generation" ? "untrusted bearer secret" : GENERATION,
        invalid === "epoch" ? 0 : EPOCH,
        invalid === "rate" ? 96000 : 48000,
      ),
      false,
    );
    assert.equal(f.io.generation, null);
    assert.equal(f.controls.length, 0);
    assert.doesNotMatch(JSON.stringify(f.packets), /bearer|secret/);
  });

test("terminal reader callbacks cannot restart obsolete controls after reentrant replacement", () => {
  let replace = true;
  const f = spectrumFixture({
    send: (packet, io) => {
      if (replace && packet[2] === "retention-state" && packet[4] === 0) {
        replace = false;
        io.requestSpectrumStop(GENERATION, EPOCH, "cancelled", 100);
        assert.equal(io.release(GENERATION), true);
        assert.equal(io.begin(OTHER, EPOCH + 1, 48000), true);
      }
    },
  });
  assert.equal(f.begin(), false);
  assert.equal(f.io.generation, OTHER);
  assert.equal(f.io.retentionReader.stats().state, "started");
  assert.deepEqual(f.controls.at(-1), ["measurementEpoch", EPOCH + 1]);
});

test("snapshot delivery failure is explicit and bounded without changing sole-reader admission", () => {
  let reject = true;
  const f = spectrumFixture({
    send: (packet) => {
      if (reject && packet[2] === "retention-snapshot")
        throw new Error("private diagnostic failure");
    },
  });
  f.begin();
  f.advance();
  f.poll();
  assert.equal(f.poll(), true);
  assert.equal(f.io.retentionReader.stats().accepted, 1);
  assert.equal(f.io.retentionSnapshotDrops, 1);
  assert.deepEqual(f.diagnostics, [
    "native_retention_snapshot_delivery_failed",
  ]);
  reject = false;
  f.setTime(300);
  f.poll(f.advance());
  const p = f.packets.filter((v) => v[2] === "retention-snapshot").at(-1);
  assert.equal(decodeRetentionSnapshot(p.slice(3)).dropped, 1);
});

test("partial source slots must settle immutably before any ACK or forwarding", () => {
  const f = spectrumFixture();
  f.begin();
  f.advance();
  f.poll();
  const mutated = [...f.frame];
  mutated[12] = 123;
  assert.equal(f.poll(mutated), false);
  assert.equal(f.io.retentionReader.stats().state, "failed");
  assert.equal(f.io.retentionReader.stats().reason, "immutable_slot_changed");
  assert(
    !f.controls.some((c) => c[0] === "measurementAcknowledged" && c[1] > 0),
  );
});

for (const boundary of ["request", "tick"])
  test(`${boundary} clock callback failure cannot fail a replacement's pending stop`, () => {
    let replace = false,
      f;
    f = spectrumFixture({
      now: (time) => {
        if (!replace) return time;
        replace = false;
        if (boundary === "request") f.request("cancelled");
        assert.equal(f.io.release(GENERATION), true);
        assert.equal(f.begin(OTHER, EPOCH + 1), true);
        assert.equal(
          f.io.requestSpectrumStop(OTHER, EPOCH + 1, "complete", 100),
          true,
        );
        throw new Error("old clock failure");
      },
    });
    f.begin();
    f.poll(f.advance());
    if (boundary === "tick") f.request();
    replace = true;
    assert.throws(
      () =>
        boundary === "request"
          ? f.request()
          : f.io.spectrumCleanupTick(GENERATION, EPOCH),
      /old clock failure/,
    );
    const state = f.io.spectrumCleanupEvidence(OTHER, EPOCH + 1);
    assert.equal(state.status, "pending");
    assert.equal(state.receipt.available, false);
    assert.equal(f.io.generation, OTHER);
  });

test("current source IO guards have explicit classifications and old packed call-site catalogs are absent", () => {
  const source = readFileSync(
    new URL("./audio_listener_native_io.js", import.meta.url),
    "utf8",
  );
  for (const match of source.matchAll(/this\.fail\("([^"]+)"/g))
    assert(IO_REJECTION_CHECKS.includes(match[1]), match[1]);
  assert.doesNotMatch(
    source,
    /IO_REJECTION_SITES|configureV2|configurationFrame|spectrumCleanupV5|retainedMeasurements|nativeVersion/,
  );
  assert(!IO_REJECTION_CHECKS.includes("unavailable"));
  const f = spectrumFixture();
  f.begin();
  f.io.packet("config", [0]);
  const packet = f.packets.find((p) => p[2] === "io-rejection");
  const decoded = decodeIORejection(packet.slice(3));
  assert.equal(decoded.mode, "spectrum");
  assert.equal(decoded.check, "packet-kind");
  assert.equal(decoded.nativeEpoch, EPOCH);
  assert.equal(decoded.generationMatches, true);
  assert.equal("armed" in decoded, false);
  assert.equal("retentionEpoch" in decoded, false);
});
