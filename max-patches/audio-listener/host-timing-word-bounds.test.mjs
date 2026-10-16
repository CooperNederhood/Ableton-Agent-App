import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";
import { genModel } from "./gen-model.mjs";
import {
  descriptiveFiniteWords,
  descriptiveFinitePredicate,
} from "./host-timing-source.mjs";

// Executable Gen subset only; native c7e9153f established the failing original
// expressions. Replacing their literal by zero replays the observed failure,
// not a claim about the compiler's internal implementation.
const limit = 2 ** 44;
const word = 2 ** 20;
const emitted = (name) =>
  nativeRuntimeDocuments({ nativeVersion: 2 })[
    `audio_listener_native_${name}.gendsp`
  ].patcher.boxes[0].box.code;
const settings = (rate, totalSamples = rate / 10) => ({
  totalSamples,
  hopSamples: rate / 10,
  tempoBpm: 93,
  startBeatFraction: 0.375,
  captureVector: 64,
});
const clauses = (text) => ({
  epoch: text.match(
    /epoch > seenEpoch && [^\n]+ && floor\(epoch\) == epoch/,
  )[0],
  counter: text.match(/^counterValid = ([^\n]+);$/m)[1],
  headroom: text.match(
    /else if \(!\(counterValid\) \|\| ([^\n]+)\) \{ rejected = 12; \}/,
  )[1],
});
function observed(text) {
  const { epoch, counter, headroom } = clauses(text);
  return text.replace(
    "if ((wasRunning || configurationSealed)",
    `out24 = clock; out25 = (${counter}) ? 1 : 0;
out26 = (${epoch.replaceAll(/\bepoch\b/g, "1")}) ? 1 : 0;
out27 = (${headroom}) ? 1 : 0;
out28 = in4 + 10 * samplerate + reportSamples + captureVector;
if ((wasRunning || configurationSealed)`,
  );
}

test("v2 coupled clock/envelope bounds and local cap never emit the physically failing wide ceiling", () => {
  for (const name of ["clock", "envelope"])
    assert.doesNotMatch(emitted(name), /17592186044416/);
  assert.doesNotMatch(emitted("envelope"), /clock = min\(/);
});

test("v2 86-poll idle replay resists the observed zero-wide-bound pattern without arming", () => {
  const text = observed(emitted("envelope")).replaceAll("17592186044416", "0");
  const gen = genModel(text, 28);
  // The actual probe retained 86 polls with these first/last input counters.
  // Model signal-rate ticks between polls; do not infer real polling atomicity.
  const first = 957696;
  const last = 1000384;
  const polls = new Set(
    Array.from({ length: 86 }, (_, i) => Math.round(((last - first) * i) / 85)),
  );
  const rows = [];
  for (let tick = 0; tick <= last - first; tick++) {
    const row = gen.step(0.375, 0, 0, first + tick);
    if (polls.has(tick)) {
      assert.deepEqual(row.slice(23), [tick, 1, 1, 0, first + tick + 480000]);
      assert.equal(row[0], 0);
      assert.equal(row[4], 0);
      assert.equal(row[5], 0);
      assert.equal(row[16], 0);
      assert.equal(row[22], 0);
      assert.equal(row[15], 2);
      rows.push(row);
    }
  }
  assert.equal(rows.length, 86);
  assert.equal(rows[0][27], 1437696);
  assert.equal(rows.at(-1)[27], 1480384);
});

test("v2 emitted epoch/counter/headroom predicates equal independent strict 2^44 oracles", () => {
  const expression = clauses(emitted("envelope"));
  const text = `Param epoch(0); Param seenEpoch(0);
Param reportSamples(0); Param captureVector(0);
out1 = (${expression.epoch}) ? 1 : 0;
out2 = (${expression.counter}) ? 1 : 0;
out3 = (${expression.headroom}) ? 1 : 0;`;
  const values = [
    -Infinity,
    -1,
    -0.5,
    -Number.MIN_VALUE,
    -0,
    0,
    Number.MIN_VALUE,
    0.5,
    1,
    word - 1,
    word,
    word + 1,
    limit - word,
    limit - 1,
    limit - 0.5,
    limit,
    limit + 0.5,
    limit + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    Infinity,
    NaN,
  ];
  for (const rate of [44100, 48000]) {
    const gen = genModel(text, 3, rate);
    for (const seenEpoch of [0, 1, word, limit - 2, limit - 1]) {
      gen.configure({ seenEpoch });
      for (const value of values) {
        gen.configure({ epoch: value });
        const row = gen.step(0, 0, 0, value);
        assert.equal(
          row[0],
          Number(value > seenEpoch && value < limit && Number.isInteger(value)),
          `epoch=${value}, seen=${seenEpoch}`,
        );
        assert.equal(
          row[1],
          Number(value >= 0 && value < limit && Number.isInteger(value)),
        );
      }
    }
    for (const [reportSamples, captureVector] of [
      [0, 0],
      [rate / 10, 64],
      [(2 * rate) / 10, 1024],
      [30 * rate, 1024],
    ]) {
      gen.configure({ reportSamples, captureVector });
      const overhead = 10 * rate + reportSamples + captureVector;
      for (const value of [
        ...values,
        limit - overhead - 1,
        limit - overhead,
        limit - overhead + 0.5,
        limit - overhead + 1,
      ]) {
        const row = gen.step(0, 0, 0, value);
        assert.equal(row[2], Number(value + overhead >= limit));
      }
    }
  }
  // Both generated graphs must use the identical full epoch gate.
  assert.equal(
    emitted("clock").match(
      /epoch > seenEpoch && [^\n]+ && floor\(epoch\) == epoch/,
    )[0],
    expression.epoch,
  );
});

test("v2 envelope local clock matches original integer saturation across words, cap and beyond", () => {
  const text = `${emitted("envelope")}\nout24 = clock;`;
  for (const rate of [44100, 48000])
    for (const initial of [
      0,
      1,
      word - 1,
      word,
      word + 1,
      limit - word - 1,
      limit - 2,
      limit - 1,
      limit,
      limit + 1,
      limit + word,
      2 * limit - 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const gen = genModel(
        text.replace("History clock(0)", `History clock(${initial})`),
        24,
        rate,
      );
      let expected = initial;
      for (let tick = 0; tick < 4; tick++) {
        expected = Math.min(limit, expected + 1);
        assert.equal(gen.step(0.375, 0, 0, tick)[23], expected);
      }
    }
});

test("v2 local clock reset precedes saturation; arm/sealed receipt, continuity, cancel and zero stay distinct", () => {
  for (const rate of [44100, 48000]) {
    const text = `${emitted("envelope")}\nout24 = clock; out25 = armed;`;
    const gen = genModel(
      text.replace("History clock(0)", `History clock(${limit})`),
      25,
      rate,
    );
    gen.configure(settings(rate));
    let counter = word - 64;
    for (let i = 0; i < 128; i++) gen.step(0.375, 0, 0, counter++);
    gen.configure({ epoch: 1 });
    let row = gen.step(0.375, 0, 0, counter++);
    assert.equal(row[23], 1);
    assert.equal(row[24], 1);
    assert.equal(row[22], 1);
    assert.equal(row[5], 0); // Sealed/armed is not an active measurement.
    assert.equal(row[13], counter - 1);
    gen.configure({ cancel: 1 });
    row = gen.step(0.375, 0, 0, counter++);
    assert.equal(row[4], 4);
    assert.equal(row[24], 0);
    assert.equal(row[22], 1); // Cancellation does not manufacture a zero ACK.
    gen.configure({ epoch: 0, cancel: 0 });
    row = gen.step(0.375, 0, 0, counter++);
    assert.equal(row[0], 0);
    assert.equal(row[16], 1);
    assert.equal(row[22], 0);
    gen.configure({ epoch: 1 });
    assert.equal(gen.step(0.375, 0, 0, counter++)[24], 0);
    gen.configure({ epoch: 2 });
    row = gen.step(0.375, 0, 0, counter++);
    assert.equal(row[23], 1);
    assert.equal(row[24], 1);
    assert.equal(row[22], 2);
    row = gen.step(0.375, 0, 0, ++counter);
    assert.equal(row[4], 12);
    assert.equal(row[24], 0);
    assert.equal(row[22], 2); // Receipt history alone never proves continuity.
  }
});

test("v2 actual arming keeps ceil-to-hop projected headroom strict at the native ceiling", () => {
  for (const rate of [44100, 48000])
    for (const delta of [-1, 0, 1]) {
      const gen = genModel(emitted("envelope"), 23, rate);
      gen.configure(settings(rate, rate / 10 + 1));
      const overhead = 10 * rate + (2 * rate) / 10 + 64;
      const counter = limit - overhead + delta;
      for (let i = 128; i > 0; i--) gen.step(0.375, 0, 0, counter - i);
      gen.configure({ epoch: 1 });
      const row = gen.step(0.375, 0, 0, counter);
      assert.equal(row[4], delta < 0 ? 0 : 12);
      assert.equal(row[22], delta < 0 ? 1 : 0);
      assert.equal(row[13], counter);
      assert.equal(row[5], 0);
    }
});

test("v2 coupled changes reverse exactly to historical clock and envelope code without other guard or math changes", () => {
  const replaceOne = (source, before, after) => {
    assert.equal(source.split(before).length, 2);
    return source.replace(before, after);
  };
  for (const [name, expected] of [
    [
      "clock",
      "0cfd2c195651928c6124129445fb09d3b8c7e0f38626b321607ff1c8ef24a189",
    ],
    [
      "envelope",
      "6213d92358ab76ccef514a7cfb717a7e8e286cb930fa3894560f71173ea33d18",
    ],
  ]) {
    let previous = replaceOne(
      emitted(name),
      "epoch > seenEpoch && floor((epoch) / 1048576) < 16777216 && floor(epoch) == epoch",
      "epoch > seenEpoch && epoch < 17592186044416 && floor(epoch) == epoch",
    );
    if (name === "envelope") {
      previous = replaceOne(
        previous,
        `${["L", "R"].map((side) => descriptiveFiniteWords(`delayed${side}`, side)).join("\n")}\n`,
        "",
      );
      previous = replaceOne(
        previous,
        ["L", "R"]
          .map((side) => descriptiveFinitePredicate(side))
          .join(" &&\n    "),
        "abs(delayedL) <= 1000000000000 && abs(delayedR) <= 1000000000000",
      );
      previous = replaceOne(
        previous,
        "floor((in4) / 1048576) < 16777216",
        "in4 < 17592186044416",
      );
      previous = replaceOne(
        previous,
        "floor((in4 + 10 * samplerate + reportSamples + captureVector) / 1048576) >= 16777216",
        "in4 + 10 * samplerate + reportSamples + captureVector >= 17592186044416",
      );
      previous = replaceOne(
        previous,
        `clockHigh = floor(clock / 1048576);
clockLow = clock - clockHigh * 1048576;
if (clockHigh < 16777216) { clock = clock + 1; }
else { clock = clock - clockLow - (clockHigh - 16777216) * 1048576; }`,
        "clock = min(17592186044416, clock + 1);",
      );
    }
    assert.equal(createHash("sha256").update(previous).digest("hex"), expected);
  }
});
