import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import { genModel } from "./gen-model.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const { structuredClone } = globalThis;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const genName = "audio_listener_native_envelope.gendsp";
const archiveText = readFileSync(
  new URL(
    "./fixtures/native-v2-envelope-periodic-baseline-b732.gendsp",
    import.meta.url,
  ),
  "utf8",
);
const archive = JSON.parse(archiveText);
const code = (document) => document.patcher.boxes[0].box.code;
const current = () => nativeRuntimeDocuments({ nativeVersion: 2 });
const envelope = () => code(current()[genName]);
const canonicalAssignment =
  "periodicPhase = in1 >= 1 && in1 - 1 <= 0.000000001 ? 0 : in1;\n";

function fixture({
  rate = 48000,
  total = rate / 10,
  tempo = 120,
  fraction = 0,
  arm = 1210880,
  launch = 128,
  stopped = 0.75,
  dense = true,
  compare = true,
  source = () => [0.25, -0.25],
} = {}) {
  // Gold model uses the immutable prior Gen with only its input canonicalized.
  // This is an executable Gen subset, not native compilation/phase accuracy.
  const gold = genModel(code(archive), 23, rate);
  const candidate = genModel(envelope(), 23, rate);
  let counter = arm - 128,
    clock = 0,
    row,
    previousCount = -1;
  const rows = [];
  const configure = (settings) => {
    gold.configure(settings);
    candidate.configure(settings);
  };
  const step = (phase = stopped, counterOverride, referencePhase = phase) => {
    const nativeCounter = counterOverride ?? counter;
    const [left, right] = source(nativeCounter);
    const expected = gold.step(
      referencePhase >= 1 && referencePhase - 1 <= 1e-9 ? 0 : referencePhase,
      left,
      right,
      nativeCounter,
    );
    row = candidate.step(phase, left, right, nativeCounter);
    counter++;
    if (
      compare &&
      (dense || clock < 256 || row[4] !== 0 || row[12] !== previousCount)
    )
      assert.deepEqual(
        row,
        expected,
        "all23 outputs equal exact-endpoint input oracle",
      );
    if (row[12] > previousCount && row[12] > 0) rows.push([...row]);
    previousCount = row[12];
    return row;
  };
  configure({
    totalSamples: total,
    hopSamples: rate / 10,
    tempoBpm: tempo,
    startBeatFraction: fraction,
    captureVector: 64,
  });
  for (let i = 0; i < 128; i++) step();
  configure({ epoch: 1 });
  step();
  const natural = (tick, closed = true) => {
    if (tick < launch) return stopped;
    const phase = (fraction + (tick - launch) / ((rate * 60) / tempo)) % 1;
    return closed && phase === 0 ? 1 : phase;
  };
  const advance = (phase, counterOverride, referencePhase) => {
    clock++;
    return step(
      phase === undefined ? natural(clock) : phase,
      counterOverride,
      referencePhase,
    );
  };
  return {
    gold,
    candidate,
    configure,
    step,
    natural,
    advance,
    rows,
    to(time, closed = true) {
      while (clock < time) advance(natural(clock + 1, closed));
      return row;
    },
    get row() {
      return row;
    },
    get clock() {
      return clock;
    },
  };
}

for (const rate of [44100, 48000]) {
  test(`native 63-sample endpoint hold catches up by exactly 64 samples without losing audio at ${rate}`, () => {
    const f = fixture({ rate, total: rate });
    f.to(128 + rate / 2);
    for (let offset = 1; offset <= 63; offset++) {
      f.advance(1 + 1e-12, undefined, offset / (rate / 2));
      assert.equal(f.row[4], 0);
    }
    f.advance(64 / (rate / 2));
    assert.equal(f.row[4], 0);
    f.to(128 + rate + 128);
    assert.equal(f.row[12], rate);
    assert.equal(f.rows.length, 10);
    assert.equal(f.row[4], 0);
  });
  test(`phase catch-up is earned by elapsed samples, not a wider drift budget at ${rate}`, () => {
    const beatSamples = rate / 2;
    for (const held of [0, 1, 31, 63]) {
      for (const residual of [0, 0.009, -0.009, 0.02, -0.02]) {
        const f = fixture({ rate, total: rate, compare: false });
        f.to(128 + beatSamples);
        for (let i = 0; i < held; i++) assert.equal(f.advance(0)[4], 0);
        const row = f.advance((held + 1 + residual) / beatSamples);
        assert.equal(row[4], Math.abs(residual) > 0.01 ? 14 : 0);
        if (row[4] !== 0) {
          assert.equal(row[5], 0);
          f.configure({ epoch: 0 });
          assert.equal(f.step(0)[22], 0);
        }
      }
    }
    const unearned = fixture({ rate, total: rate, compare: false });
    unearned.to(128 + beatSamples);
    assert.equal(unearned.advance(64 / beatSamples)[4], 14);
  });
  test(`a whole-vector phase stall and cancellation remain terminal at ${rate}`, () => {
    const stalled = fixture({ rate, total: rate, compare: false });
    stalled.to(128 + rate / 2);
    for (let i = 0; i < 63; i++) assert.equal(stalled.advance(0)[4], 0);
    assert.equal(stalled.advance(0)[4], 3);
    assert.equal(stalled.advance(64 / (rate / 2))[5], 0);
    const cancelled = fixture({ rate, total: rate, compare: false });
    cancelled.to(128 + rate / 2);
    for (let i = 0; i < 31; i++) cancelled.advance(0);
    cancelled.configure({ cancel: 1 });
    assert.equal(cancelled.advance(32 / (rate / 2))[4], 4);
    assert.equal(cancelled.row[5], 0);
    cancelled.configure({ epoch: 0, cancel: 0 });
    assert.equal(cancelled.step(0)[22], 0);
    cancelled.configure({ epoch: 1 });
    assert.equal(cancelled.step(0)[4], 4);
    assert.equal(cancelled.row[5], 0);
    assert.equal(cancelled.row[22], 0);
  });
  test(`sub-nanophase upper endpoint aliases zero without changing exact capture at ${rate}`, () => {
    // Native classification proves >1 with nano-excess rounding to zero;
    // these representative doubles are not claimed as the recorded bits.
    for (const phase of [1 + 2 ** -52, 1 + 1e-12, 1 + 2 ** -30]) {
      const f = fixture({ rate, total: rate });
      f.to(128 + rate / 2 - 1);
      f.advance(phase);
      assert.equal(f.row[4], 0);
      f.to(128 + rate + 128);
      assert.equal(f.row[4], 0);
      assert.equal(f.row[12], rate);
      assert.equal(f.rows.length, 10);
    }
    for (const phase of [1 + 2 ** -29, 1.00001, -(2 ** -52)]) {
      const f = fixture({ rate, total: rate });
      f.to(128 + rate / 2 - 1);
      assert.equal(f.advance(phase)[4], 14);
      assert.equal(f.row[5], 0);
    }
  });
}
test("archive differs only in bounded endpoint normalization and elapsed-sample phase checks", () => {
  assert.equal(
    sha(archiveText),
    "b732aed30d37910c72362c790160758dd96f5087e5093e2dff3a8924d7c7b508",
  );
  assert.equal(
    sha(code(archive)),
    "4184116450b5754a50f616fddeeb3b32a930a1f25d13c7b512517da4210c1c54",
  );
  const text = envelope();
  assert.ok(text.includes(canonicalAssignment));
  assert.equal(
    (text.match(/\bin1\b/g) ?? []).length,
    3,
    "raw phase appears only in the bounded endpoint selector",
  );
  for (const fragment of [
    "phaseValid = periodicPhase >= 0 && periodicPhase < 1;",
    "phaseDistance = periodicPhase - passFraction;",
    "phaseStep = periodicPhase - previousPhase;",
    "stablePhaseSamples = periodicPhase == previousPhase",
    "previousPhase = periodicPhase;",
  ])
    assert.ok(text.includes(fragment));
  const stepGuard =
    "if (abs(phaseStep * beatSamples - (stablePhaseSamples + 1)) > 0.01)";
  assert.ok(text.includes(stepGuard));
  const reversed = text
    .replace(canonicalAssignment, "")
    .replaceAll(/\bperiodicPhase\b/g, "in1")
    .replace(stepGuard, "if (abs(phaseStep * beatSamples - 1) > 0.01)");
  assert.equal(reversed, code(archive));
  const document = structuredClone(current()[genName]);
  document.patcher.boxes[0].box.code = reversed;
  assert.deepEqual(document, archive);
  assert.equal(document.patcher.boxes[0].box.numoutlets, 23);
});
test("actual cb1 native-equal-one replay no longer rejects, without changing launch/arm/count origin", () => {
  const historic = genModel(code(archive), 23, 48000);
  const fixed = genModel(
    `${envelope()}\nout24 = n; out25 = completed; out26 = previousPhase;`,
    26,
    48000,
  );
  let counter = 1210880 - 128;
  const configure = (values) => {
    historic.configure(values);
    fixed.configure(values);
  };
  const step = (phase) => {
    const a = historic.step(phase, 0, 0, counter);
    const b = fixed.step(phase, 0, 0, counter++);
    return [a, b];
  };
  configure({
    totalSamples: 1440000,
    hopSamples: 4800,
    tempoBpm: 120,
    startBeatFraction: 0.25,
    captureVector: 64,
  });
  for (let i = 0; i < 128; i++) step(0);
  configure({ epoch: 1 });
  step(0);
  let rows;
  // Intervening phase is a model, not a reconstruction of an actual trace.
  // The fault sample1 is now established by cb1's native comparison flags.
  for (let clock = 1; clock <= 249040; clock++)
    rows = step(
      clock === 249040
        ? 1
        : clock < 87040
          ? 0
          : (0.25 + (clock - 87040) / 24000) % 1,
    );
  const [old, corrected] = rows;
  assert.deepEqual(
    old.slice(0, 16),
    [1, 87040, -1, 0, 14, 0, 0, -1, 0, 0, 0, 0, 158400, 1210880, 1297920, 2],
  );
  assert.equal(counter - 1, 1459920);
  assert.equal(corrected[4], 0);
  assert.equal(corrected[5], 1);
  assert.deepEqual(corrected.slice(12, 16), [158400, 1210880, 1297920, 2]);
  assert.deepEqual(corrected.slice(23), [3537, 158400, 0]);
});
for (const rate of [44100, 48000]) {
  test(`closed endpoint is consistent for launch, continuous wrap, full30s and exact tails at${rate}`, () => {
    const hop = rate / 10;
    for (const total of [hop, hop + 1, 30 * rate]) {
      const f = fixture({ rate, total, dense: false });
      assert.equal(f.row[22], 1);
      f.to(128 + 64 + Math.ceil(total / hop) * hop + 2);
      assert.equal(f.row[4], 0);
      assert.equal(f.row[5], 0);
      assert.equal(f.row[12], total);
      assert.equal(f.row[13], 1210880);
      assert.equal(f.row[14], 1210880 + 128);
      assert.equal(f.row[15], 2);
      assert.equal(f.rows.length, Math.ceil(total / hop));
      assert.ok(f.rows.length <= 300);
      let count = 0;
      for (const row of f.rows) {
        assert.equal(row[12] - count, Math.min(hop, total - count));
        count = row[12];
        for (const value of row.slice(8, 12)) assert.equal(value, 0.25);
      }
    }
    const fractional = fixture({
      rate,
      total: hop + 1,
      tempo: 93,
      fraction: 0.375,
    });
    fractional.to(128 + 64 + 2 * hop + 2, false);
    assert.equal(fractional.row[12], hop + 1);
    assert.equal(fractional.row[4], 0);
  });
  test(`out-of-bound excess, negatives/nonfinite and genuine jumps still fail at${rate}`, () => {
    for (const phase of [
      1 + 2 ** -29,
      1.000000000000003,
      1.25,
      2,
      -Number.MIN_VALUE,
      -0.01,
      NaN,
      Infinity,
      -Infinity,
    ]) {
      const f = fixture({ rate, fraction: 0.25 });
      f.to(128);
      assert.equal(f.advance(phase)[4], 14);
      assert.equal(f.row[5], 0);
      assert.equal(f.row[12], 0);
    }
    const jump = fixture({ rate, fraction: 0.25 });
    jump.to(128);
    assert.equal(
      jump.advance(1)[4],
      14,
      "canonical0 still rejects a genuine0.75beat jump",
    );
    const aboveStep = fixture({ rate, fraction: 0.25 });
    aboveStep.to(128);
    assert.equal(aboveStep.advance(0.25 + 1.02 / (rate / 2))[4], 14);
    const belowStep = fixture({ rate, fraction: 0.25 });
    belowStep.to(128);
    assert.equal(belowStep.advance(0.25 + 1.009 / (rate / 2))[4], 0);
    const missed = fixture({ rate, fraction: 0.25 });
    assert.equal(
      missed.advance(1)[4],
      9,
      "normalization never relabels a late launch",
    );
  });
  test(`periodic history stays consistent through stationary aliases, guard priority, cancel and queued epochs at${rate}`, () => {
    const f = fixture({ rate });
    f.to(128);
    for (let i = 0; i < 64; i++) f.advance(i % 2 === 0 ? 0 : 1);
    assert.equal(f.row[4], 3, "alternating0/1 is stationary, not moving");
    f.configure({ epoch: 0 });
    f.step(1);
    assert.equal(f.row[0], 0);
    assert.equal(f.row[22], 0);
    f.configure({ epoch: 1 });
    f.step(1);
    assert.equal(f.row[5], 0);
    f.configure({ epoch: 2 });
    assert.equal(f.step(1)[22], 2);
    f.configure({ epoch: 0 });
    f.step(1);
    f.configure({ epoch: 1 });
    assert.equal(f.step(1)[4], 6);
    assert.equal(f.row[22], 0);
    const cancelled = fixture({ rate });
    cancelled.to(128);
    cancelled.configure({ cancel: 1 });
    assert.equal(cancelled.advance(1 + 2 ** -52)[4], 4);
    cancelled.configure({ epoch: 0, cancel: 0 });
    assert.equal(cancelled.step(1)[0], 0);
    assert.equal(cancelled.row[22], 0);
    const denied = fixture({ rate });
    denied.to(128);
    denied.configure({ totalSamples: 0 });
    assert.equal(denied.advance(1)[4], 13);
    const regressed = fixture({ rate });
    assert.equal(regressed.advance(1, 1)[4], 12);
  });
}
test("clock, spectrum, non-scheduler analysis geometry and default/v1 documents remain byte-identical", () => {
  const docs = current();
  assert.equal(
    sha(code(docs["audio_listener_native_clock.gendsp"])),
    "d64283544620de3cf19f6dd062c07f3fa3f0b8fc30b5a515b79d44a28be722a9",
  );
  assert.equal(
    sha(code(docs["audio_listener_native_spectrum.gendsp"])),
    "5bd377dc1eee13b58e1567880fb1a1d99cd0da0d1b20a104a913fbbfd08e34f4",
  );
  const analysis = structuredClone(
    docs["audio_listener_native_analysis.maxpat"],
  );
  const poll = analysis.patcher.boxes.find(({ box }) => box.id === "poll").box;
  assert.equal(poll.text, "metro 10 @active 0");
  poll.text = "qmetro 10 @active 0";
  assert.equal(
    sha(`${JSON.stringify(analysis, null, 2)}\n`),
    "b0f85f4833c79a1c34d1dad715fc6befac394a882e6c1100d92b93ecaed7aade",
  );
  assert.equal(
    sha(JSON.stringify(nativeRuntimeDocuments())),
    "d102081c366e48f040661f4d08d0ae8c597f8549ee0493a341c3f0fd2fe4473e",
  );
  assert.deepEqual(
    nativeRuntimeDocuments({ nativeVersion: 1 }),
    nativeRuntimeDocuments(),
  );
});
