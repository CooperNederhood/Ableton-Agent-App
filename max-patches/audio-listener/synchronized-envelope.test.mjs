/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { genModel } from "./gen-model.mjs";
import {
  SYNCHRONIZED_ENVELOPE_CODE,
  synchronizedEnvelopeDocument,
} from "./synchronized-envelope-source.mjs";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";
import { validateDocument } from "../../scripts/audio-listener-device.mjs";

const phase = (i) => (i % 24000) / 24000;
function create(code = SYNCHRONIZED_ENVELOPE_CODE, rate = 48000, held = false) {
  const model = genModel(code, 13, rate);
  for (let i = 0; i < 128; i++) model.step(held ? 0.304 : 0);
  return model;
}
function input(kind) {
  const wav = createKnownListeningFixture(kind).wav;
  const pcm = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  return (i) =>
    i < 96000
      ? [
          pcm.getInt16(44 + i * 4, true) / 32768,
          pcm.getInt16(46 + i * 4, true) / 32768,
        ]
      : [0, 0];
}
function oracle(read) {
  const rows = [];
  for (let start = 0; start < 480000; start += 4800) {
    let l = 0,
      r = 0,
      sl = 0,
      sr = 0;
    for (let i = start; i < start + 4800; i++) {
      const [left, right] = read(i);
      l = Math.max(l, Math.abs(left));
      r = Math.max(r, Math.abs(right));
      sl += left * left;
      sr += right * right;
    }
    rows.push([l, r, Math.sqrt(sl / 4800), Math.sqrt(sr / 4800), start + 4800]);
  }
  return rows;
}
function run(read, held, idle = 511, code = SYNCHRONIZED_ENVELOPE_CODE) {
  const model = create(code, 48000, held);
  model.configure({ epoch: 1 });
  model.step(held ? 0.304 : 0);
  for (let i = 0; i < idle; i++) model.step(held ? 0.304 : 0);
  const rows = [],
    times = [];
  let previous = 0,
    marker;
  for (let i = 0; i <= 480064; i++) {
    const [l, r] = read(i);
    marker = model.step(held && i < 64 ? 0.304 : phase(i), l, r);
    assert.equal(marker[4], 0);
    if (marker[12] !== previous) {
      rows.push(marker.slice(8));
      times.push(idle + 1 + i);
      previous = marker[12];
    }
  }
  return { rows, times, marker, model, origin: idle + 1 };
}

test("fixed integer-delay model preserves all 64 samples and clears history", () => {
  const model = genModel("Delay d(64); out1 = d.read(64); d.write(in1);", 1);
  for (let i = 0; i < 128; i++)
    assert.equal(model.step(i === 0 ? 1 : 0)[0], i === 64 ? 1 : 0);
  model.step(1);
  model.reset();
  for (let i = 0; i < 128; i++) assert.equal(model.step(0)[0], 0);
  assert.throws(() => genModel("Delay d(0);", 1), /unsupported model delay/);
  assert.throws(
    () => genModel("Delay d(64); out1 = d.read(65);", 1).step(0),
    /unsupported model delay read/,
  );
});

test("engineering synchronized envelope document is deterministic and cannot authorize production", async () => {
  const expected = synchronizedEnvelopeDocument();
  validateDocument(expected);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        new URL("./synchronized_envelope_probe.gendsp", import.meta.url),
        "utf8",
      ),
    ),
    expected,
  );
  assert.equal(expected.patcher.boxes[0].box.numinlets, 3);
  assert.equal(expected.patcher.boxes[0].box.numoutlets, 13);
  assert.doesNotMatch(
    JSON.stringify(expected),
    /plugout~|dac~|LiveAPI|certificate/,
  );
});

for (const kind of ["quarter-sine", "anti-phase-quarter-sine", "silence"]) {
  for (const held of [false, true]) {
    test(`100 native-model ${kind} windows align exactly with ${held ? "held" : "fresh"} phase`, () => {
      const read = input(kind);
      const result = run(read, held);
      assert.deepEqual(result.rows, oracle(read));
      assert.deepEqual(
        result.times,
        Array.from(
          { length: 100 },
          (_, i) => result.origin + (i + 1) * 4800 + 63,
        ),
      );
      assert.equal(result.marker[1] - result.marker[6], result.origin);
      assert.equal(result.marker[5], 0);
      assert.equal(result.marker[12], 480000);
    });
  }
}

test("source sample zero is retained, and omitted pre-roll is detected by independent PCM", () => {
  const read = (i) => [i === 0 ? 1 : 0, i === 0 ? -1 : 0];
  for (const held of [false, true]) {
    const result = run(read, held, 0);
    assert.deepEqual(result.rows, oracle(read));
    assert.equal(result.rows[0][0], 1);
    assert.equal(result.rows[0][2], Math.sqrt(1 / 4800));
  }
  const broken = SYNCHRONIZED_ENVELOPE_CODE.replaceAll(".read(64)", ".read(1)");
  assert.notDeepEqual(run(read, true, 0, broken).rows, oracle(read));
});

test("a silent clip-edge offset matches PCM and detects a one-sample late boundary", () => {
  const file = input("quarter-sine");
  const read = (i) => file(i + 12048);
  for (const held of [false, true]) {
    assert.deepEqual(run(read, held).rows, oracle(read));
  }
  const late = SYNCHRONIZED_ENVELOPE_CODE.replaceAll(".read(64)", ".read(63)");
  const actual = run(read, true, 511, late).rows;
  const expected = oracle(read);
  assert(
    actual.some((row, i) =>
      row
        .slice(0, 4)
        .some((value, c) => Math.abs(value - expected[i][c]) > 1e-6),
    ),
  );
});

async function nativeEvidence() {
  return JSON.parse(
    await readFile(
      new URL("./fixtures/synchronized-native-envelope.json", import.meta.url),
      "utf8",
    ),
  );
}

function recordedWindows(run) {
  const rows = [
    ...run.activeFrames,
    ...Array.from({ length: run.silentTailWindows }, () => [0, 0, 0, 0]),
  ];
  assert.equal(rows.length, run.frameCount);
  return rows.map((row, i) => [...row, (i + 1) * 4800]);
}

test("recorded native fresh/held windows retain the same origin and all 100 descriptors", async () => {
  const evidence = await nativeEvidence();
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.nativeTiming, "UNVERIFIED");
  assert.equal(
    createHash("sha256")
      .update(createKnownListeningFixture("quarter-sine").wav)
      .digest("hex"),
    evidence.source.sha256,
  );
  assert.equal(
    createHash("sha256")
      .update(
        await readFile(
          new URL("./synchronized_envelope_probe.gendsp", import.meta.url),
        ),
      )
      .digest("hex"),
    evidence.genSha256,
  );
  const [fresh, held] = evidence.runs;
  assert.equal(fresh.frameCount, 100);
  assert.deepEqual(recordedWindows(fresh), recordedWindows(held));
  assert.deepEqual(fresh.nativeMarker, [1, 513, 72513, 4, 0, 0, 1, 513]);
  assert.deepEqual(held.nativeMarker, [2, 576, 72513, 4, 0, 0, 64, 513]);
  for (const run of [fresh, held]) {
    assert.equal(run.originClock, 512);
    assert.equal(run.nativeMarker[1] - run.nativeMarker[6], run.originClock);
    assert.equal(run.nativeMarker[7] - run.originClock, 1);
  }
});

test("recorded silent-edge native windows match independent PCM without concealing the original edge discrepancy", async () => {
  const evidence = await nativeEvidence();
  const original = evidence.runs[0];
  const isolated = evidence.runs[2];
  const file = input("quarter-sine");
  assert.equal(isolated.sourceOffsetSamples, 12048);
  const expected = oracle((i) => file(i + isolated.sourceOffsetSamples));
  const actual = recordedWindows(isolated);
  assert.equal(actual.length, 100);
  actual.forEach((row, i) =>
    row.forEach((value, c) =>
      assert(Math.abs(value - expected[i][c]) <= 1e-12, `window ${i + 1}/${c}`),
    ),
  );
  assert.equal(isolated.nativeMarker[7] - isolated.originClock, 11953);
  assert.equal(isolated.nativeMarker[3], 3);
  const untrimmed = oracle(file);
  const originalRows = recordedWindows(original);
  assert(Math.abs(originalRows[0][2] - untrimmed[0][2]) > 0.00049);
  originalRows
    .slice(1)
    .forEach((row, i) =>
      row.forEach((value, c) =>
        assert(Math.abs(value - untrimmed[i + 1][c]) <= 1e-12),
      ),
    );
});

test("recorded native cancellation and denial preserve partial evidence and traced terminal ordering", async () => {
  const evidence = await nativeEvidence();
  const [fresh, , , cancelled, denied] = evidence.runs;
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.reason, "operator_cancelled");
  assert.equal(cancelled.frameCount, 27);
  assert.deepEqual(
    recordedWindows(cancelled),
    recordedWindows(fresh).slice(0, 27),
  );
  assert.equal(denied.outcome, "failed");
  assert.equal(denied.reason, "native_rejected_1");
  assert.equal(denied.frameCount, 0);
  assert.equal(denied.sourceRequestedAtMs, null);
  assert.deepEqual(
    denied.events.map((event) => event.stage),
    ["queued", "started", "failed"],
  );
  for (const run of evidence.runs) {
    assert.equal(run.productionReady, false);
    assert.equal(run.nativeTiming, "UNVERIFIED");
    assert.equal(run.nativeMarker[0], run.nativeEpoch);
    run.events.forEach((event, i) => {
      assert.equal(event.traceId, run.traceId);
      assert.equal(event.correlationId, run.traceId);
      assert.equal(
        event.causationId,
        i ? run.events[i - 1].eventId : run.traceId,
      );
      assert.equal(
        event.eventId,
        `${run.traceId}:native:${run.nativeEpoch}:${i}`,
      );
      assert(event.elapsedMs >= (i ? run.events[i - 1].elapsedMs : 0));
      assert(event.elapsedMs < 12000);
      assert(event.frames <= run.frameCount);
    });
    assert.equal(
      run.events.at(-1).stage,
      run.outcome === "collected" ? "completed" : run.outcome,
    );
    assert.equal(run.events.at(-1).frames, run.frameCount);
  }
});

test("unsupported phase, rate and insufficient quiet pre-roll fail before any window", () => {
  const late = create();
  late.configure({ epoch: 1 });
  late.step(0);
  assert.equal(late.step(phase(65))[4], 9);
  assert.equal(late.step(phase(66))[12], 0);
  const rate = create(SYNCHRONIZED_ENVELOPE_CODE, 44100);
  rate.configure({ epoch: 1 });
  assert.equal(rate.step(0)[4], 5);
  const noisy = create();
  noisy.step(0, 0.1, -0.1);
  noisy.configure({ epoch: 1 });
  assert.equal(noisy.step(0)[4], 10);
  assert.equal(noisy.step(phase(1))[12], 0);
});

test("cancel, stopped phase and stale epoch retain partial windows without completing; new epoch clears holds", () => {
  for (const reason of ["cancel", "stop", "stale"]) {
    const model = create();
    model.configure({ epoch: 2 });
    model.step(0);
    let marker;
    for (let i = 0; i < 6000; i++) marker = model.step(phase(i), 0.1, -0.1);
    assert.equal(marker[12], 4800);
    if (reason === "cancel") model.configure({ cancel: 1 });
    if (reason === "stale") model.configure({ epoch: 1 });
    for (let i = 0; i < 128; i++)
      marker = model.step(reason === "stop" ? phase(5999) : phase(6000 + i));
    assert.equal(marker[4], { cancel: 4, stop: 3, stale: 6 }[reason]);
    assert.equal(marker[5], 0);
    assert.equal(marker[12], 4800);
    model.configure({ cancel: 0, epoch: 0 });
    for (let i = 0; i < 128; i++) model.step(0);
    model.configure({ epoch: 3 });
    marker = model.step(0);
    assert.equal(marker[0], 3);
    assert.equal(marker[4], 0);
    assert.deepEqual(marker.slice(8), [0, 0, 0, 0, 0]);
  }
});
