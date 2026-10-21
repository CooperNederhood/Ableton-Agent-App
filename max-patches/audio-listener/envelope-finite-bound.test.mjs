import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { genModel } from "./gen-model.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const documents = () => nativeRuntimeDocuments({ nativeVersion: 2 });
const envelope = () =>
  documents()["audio_listener_native_envelope.gendsp"].patcher.boxes[0].box
    .code;
const oldPredicate =
  "abs(delayedL) <= 1000000000000 && abs(delayedR) <= 1000000000000";
const words = ["L", "R"]
  .map(
    (side) =>
      `finiteHigh${side} = floor(abs(delayed${side}) / 1048576);
finiteLow${side} = (abs(delayed${side}) / 1048576 - finiteHigh${side}) * 1048576;`,
  )
  .join("\n");
const predicate = ["L", "R"]
  .map(
    (side) =>
      `(finiteHigh${side} >= 0 && finiteLow${side} >= 0 && finiteLow${side} < 1048576 &&
      (finiteHigh${side} < 953674 || (finiteHigh${side} == 953674 && finiteLow${side} <= 331776)))`,
  )
  .join(" &&\n    ");
function historical(text) {
  return text
    .replace(
      "periodicPhase = in1 >= 1 && in1 - 1 <= 0.000000001 ? 0 : in1;\n",
      "",
    )
    .replace(
      "abs(phaseStep * beatSamples - (stablePhaseSamples + 1))",
      "abs(phaseStep * beatSamples - 1)",
    )
    .replaceAll(/\bperiodicPhase\b/g, "in1")
    .replace(`${words}\n`, "")
    .replace(predicate, oldPredicate);
}
function replaceObservedComparisons(text) {
  // Actual B96f88bf6 observed both delayed values0 and both original rechecks0.
  // Replay that measured result only; this does not model compiler internals.
  for (const side of ["L", "R"])
    text = text.replaceAll(`abs(delayed${side}) <= 1000000000000`, "0");
  return text;
}
test("v2 envelope finite checks use exactly the qualified spectrum word pattern, never a wide ceiling", () => {
  const text = envelope();
  assert.ok(text.includes(`${words}\n`));
  assert.ok(text.includes(`else if (!(${predicate})) {`));
  assert.doesNotMatch(text, /1000000000000/);
  const spectrum =
    documents()["audio_listener_native_spectrum.gendsp"].patcher.boxes[0].box
      .code;
  for (const [index, side] of ["L", "R"].entries()) {
    const number = index + 1;
    const renamed = words
      .split("\n")
      .slice(index * 2, index * 2 + 2)
      .join("\n")
      .replaceAll(`delayed${side}`, `in${number}`)
      .replaceAll(`High${side}`, `High${number}`)
      .replaceAll(`Low${side}`, `Low${number}`);
    assert.ok(spectrum.includes(renamed));
  }
});
test("only finite temporaries and predicate change; spectrum code and both v1 document sets retain frozen hashes", () => {
  assert.equal(
    sha(historical(envelope())),
    "8045e102ba54b8a63dbcc00ff490007943e01298d38ed1e371614ab58ce11fb7",
  );
  const current = documents();
  assert.equal(
    sha(
      current["audio_listener_native_spectrum.gendsp"].patcher.boxes[0].box
        .code,
    ),
    "5bd377dc1eee13b58e1567880fb1a1d99cd0da0d1b20a104a913fbbfd08e34f4",
  );
  assert.equal(
    sha(
      `${JSON.stringify(current["audio_listener_native_spectrum.gendsp"], null, 2)}\n`,
    ),
    "a515b56b91f25d0e4b05dede4c92ceb7e362d1af160d1dff444333fd512a071f",
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
test("actual zero-code15 replay keeps native arm/origin and proceeds at the first retained sample", () => {
  function replay(text) {
    const model = genModel(replaceObservedComparisons(text), 23, 48000);
    model.configure({
      totalSamples: 84000,
      hopSamples: 4800,
      tempoBpm: 120,
      startBeatFraction: 0.25,
      captureVector: 64,
    });
    let counter = 1157632 - 128;
    for (let i = 0; i < 128; i++) model.step(0, 0, 0, counter++);
    model.configure({ epoch: 1 });
    model.step(0, 0, 0, counter++);
    let row;
    for (let clock = 1; clock <= 86080; clock++)
      row = model.step(
        clock < 86016 ? 0 : 0.25 + (clock - 86016) / 24000,
        0,
        0,
        counter++,
      );
    assert.equal(counter - 1, 1243712);
    return row;
  }
  const old = replay(historical(envelope()));
  assert.deepEqual(
    old.slice(0, 16),
    [1, 86016, -1, 0, 15, 0, 0, -1, 0, 0, 0, 0, 0, 1157632, 1243648, 2],
  );
  const current = replay(envelope());
  assert.equal(current[4], 0);
  assert.equal(current[5], 1);
  assert.deepEqual(current.slice(13), old.slice(13));
  assert.equal(current[12], 0);
});
test("emitted stereo finite predicate equals independent inclusive1e12 oracle at adjacent floats, subwords, overflow and nonfinite values", () => {
  assert.ok(envelope().includes(words));
  assert.ok(envelope().includes(predicate));
  assert.equal(953674n * 1048576n + 331776n, 1000000000000n);
  const ulp = 2 ** -13;
  const values = [
    -Infinity,
    Infinity,
    NaN,
    -0,
    0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    -0.125,
    0.125,
    1048576 - 2 ** -33,
    1048576,
    1048576 + 2 ** -32,
    953674 * 1048576,
    1e12 - ulp,
    1e12,
    1e12 + ulp,
    -1e12 + ulp,
    -1e12,
    -1e12 - ulp,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ];
  for (const rate of [44100, 48000]) {
    const model = genModel(
      `delayedL = in1; delayedR = in2;\n${words}\nout1 = (${predicate}) ? 1 : 0;`,
      1,
      rate,
    );
    for (const left of values)
      for (const right of values)
        assert.equal(
          model.step(left, right)[0],
          Number(
            Number.isFinite(left) &&
              Math.abs(left) <= 1e12 &&
              Number.isFinite(right) &&
              Math.abs(right) <= 1e12,
          ),
          `rate${rate} left${left} right${right}`,
        );
  }
});
function fixture(rate, total, amplitude = 0.25, text = envelope()) {
  const model = genModel(replaceObservedComparisons(text), 23, rate);
  model.configure({
    totalSamples: total,
    hopSamples: rate / 10,
    tempoBpm: 93,
    startBeatFraction: 0.375,
    captureVector: 64,
  });
  let counter = 1048500;
  let row;
  let clock = 0;
  const step = (phase = 0.75, left = amplitude, right = -amplitude) => {
    row = model.step(phase, left, right, counter++);
    return row;
  };
  for (let i = 0; i < 128; i++) step();
  model.configure({ epoch: 1 });
  step();
  const advance = (left = amplitude, right = -amplitude) => {
    clock++;
    return step(
      clock < 128 ? 0.75 : (0.375 + (clock - 128) / ((rate * 60) / 93)) % 1,
      left,
      right,
    );
  };
  return {
    model,
    advance,
    step,
    get row() {
      return row;
    },
    get clock() {
      return clock;
    },
  };
}
for (const rate of [44100, 48000]) {
  test(`finite guard preserves pooled anti-phase/silent exact hops and1-sample tails at${rate}`, () => {
    const hop = rate / 10;
    for (const [total, amplitude] of [
      [hop, 0],
      [hop + 1, 0.25],
      [30 * rate, 0.25],
      [hop, 1e12],
    ]) {
      const f = fixture(rate, total, amplitude);
      const counts = [];
      let prior = 0;
      for (
        let tick = 0;
        tick < 128 + Math.ceil(total / hop) * hop + 65;
        tick++
      ) {
        const row = f.advance();
        assert.equal(row[4], 0);
        if (row[12] !== prior) {
          counts.push(row[12] - prior);
          prior = row[12];
          for (const value of row.slice(8, 12))
            assert.ok(
              Math.abs(value - amplitude) <= Math.max(1e-12, amplitude * 1e-12),
            );
        }
      }
      assert.equal(f.row[12], total);
      assert.equal(f.row[5], 0);
      assert.equal(counts.length, Math.ceil(total / hop));
      assert.ok(counts.length <= 300);
      assert.ok(
        counts.every((count, i) => count === Math.min(hop, total - i * hop)),
      );
    }
  });
  test(`finite source guards reject either channel without padding and retain cancel/zero/sealed behavior at${rate}`, () => {
    for (const input of [
      [NaN, 0],
      [0, NaN],
      [Infinity, 0],
      [0, -Infinity],
      [Infinity, -Infinity],
      [NaN, NaN],
      [1e12 + 2 ** -13, 0],
      [0, -1e12 - 2 ** -13],
    ]) {
      for (const n of [0, 17]) {
        const f = fixture(rate, rate / 10, 0);
        while (f.clock < 192 + n)
          f.advance(...(f.clock + 1 === 128 + n ? input : [0, 0]));
        assert.equal(f.row[4], 15);
        assert.equal(f.row[12], 0);
        assert.equal(f.row[5], 0);
        const held = f.row.slice(8, 13);
        f.model.configure({ epoch: 0 });
        assert.equal(f.step()[0], 0);
        assert.equal(f.row[22], 0);
        assert.deepEqual(f.row.slice(8, 13), held);
        f.model.configure({ epoch: 1 });
        assert.equal(f.step()[5], 0);
      }
    }
    const f = fixture(rate, rate / 10 + 1);
    for (let i = 0; i < 220; i++) f.advance();
    f.model.configure({ cancel: 1 });
    assert.equal(f.advance()[4], 4);
    assert.equal(f.row[22], 1);
    f.model.configure({ epoch: 0, cancel: 0 });
    assert.equal(f.step()[0], 0);
    assert.equal(f.row[22], 0);
    assert.equal(f.row[15], 2);
  });
}
