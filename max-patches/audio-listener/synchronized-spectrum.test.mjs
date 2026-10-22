/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { genModel } from "./gen-model.mjs";
import {
  TAGGED_SPECTRUM_CODE,
  taggedSpectrumGenDocument,
  CLOCK_SPLIT_CODE,
  clockSplitDocument,
} from "./synchronized-spectrum-source.mjs";
import {
  CLOCK_ANCHORED_ENVELOPE_CODE,
  clockAnchoredEnvelopeDocument,
} from "./synchronized-envelope-source.mjs";
import {
  taggedSpectrumDocument,
  synchronizedAnalysisDocument,
} from "./calibration-source.mjs";
import { validateDocument } from "../../scripts/audio-listener-device.mjs";
import { fftReference } from "./fft-reference.mjs";

test("Gen clock bounds avoid wide literals rejected by the native bound guard", () => {
  const check = (code) => {
    for (const [literal] of code.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
      assert(
        Number(literal) <= 2147483647,
        `unsupported native wide literal: ${literal}`,
      );
    }
  };
  check(TAGGED_SPECTRUM_CODE);
  check(CLOCK_ANCHORED_ENVELOPE_CODE);
  assert.throws(
    () => check(`${TAGGED_SPECTRUM_CODE}\nout11 = 17592186042368.0;`),
    /unsupported native wide literal/,
  );
  assert.throws(
    () => check(`${CLOCK_ANCHORED_ENVELOPE_CODE}\nout16 = 9007199254260991.0;`),
    /unsupported native wide literal/,
  );
});

test("FFT start bounds accept the last full frame and reject the next sample", () => {
  for (const start of [17592186042368, 17592186042369]) {
    const model = genModel(TAGGED_SPECTRUM_CODE, 10);
    const split = genModel(CLOCK_SPLIT_CODE, 2);
    let row;
    for (let bin = 0; bin < 2048; bin++) {
      const [low, high] = split.step(start + bin).map(Math.fround);
      row = model.step(0, 0, 0, 0, bin, low, high);
    }
    if (start === 17592186042368)
      assert.deepEqual(row.slice(0, 5), [0, 0, start, start + 2048, 0]);
    else {
      assert.deepEqual(row.slice(0, 5), [0, 0, -1, -1, 1]);
      assert.equal(row[9], 253);
    }
  }
});

test("tagged spectrum publishes only a complete contiguous 2048-sample clock window", () => {
  const model = genModel(TAGGED_SPECTRUM_CODE, 5);
  let row;
  for (let frame = 0; frame < 2; frame++) {
    for (let bin = 0; bin < 2048; bin++) {
      row = model.step(
        bin === 32 ? 1 : 0,
        0,
        bin === 64 ? 2 : 0,
        0,
        bin,
        100000 + frame * 2048 + bin,
      );
      if (bin < 2047) assert.equal(row[3], frame ? 102048 : -1);
    }
    assert.deepEqual(row, [
      1350,
      5,
      100000 + frame * 2048,
      102048 + frame * 2048,
      0,
    ]);
  }
});

test("clock reset or noninteger tags never publish a mixed FFT window", () => {
  for (const mode of ["reset", "fractional"]) {
    const model = genModel(TAGGED_SPECTRUM_CODE, 5);
    let row;
    for (let bin = 0; bin < 2048; bin++)
      row = model.step(
        1,
        0,
        0,
        0,
        bin,
        mode === "fractional" ? bin + 0.5 : bin < 1000 ? bin : bin - 1000,
      );
    assert.deepEqual(row, [0, 0, -1, -1, 1]);
  }
});

test("split FFT clock tags retain integer sample coordinates through float32 buffers and carries", () => {
  for (const start of [2 ** 24 - 1024, 2 ** 26 + 128, 2 ** 40 - 1024]) {
    const split = genModel(CLOCK_SPLIT_CODE, 2);
    const tagged = genModel(TAGGED_SPECTRUM_CODE, 5);
    let row;
    for (let bin = 0; bin < 2048; bin++) {
      const [low, high] = split.step(start + bin).map(Math.fround);
      assert.equal(low + high * 1048576, start + bin);
      row = tagged.step(0, 0, 0, 0, bin, low, high);
    }
    assert.deepEqual(row, [0, 0, start, start + 2048, 0]);
    assert.notEqual(Math.fround(start + 2047), start + 2047);
  }
});

test("independent FFT reference preserves impulse energy and rejects unsupported input", () => {
  assert.throws(() => fftReference([0, 0, 0]), /power-of-two/);
  assert.throws(() => fftReference([NaN, 0]), /finite/);
  const { real, imag } = fftReference(
    Array.from({ length: 2048 }, (_, i) => (i === 0 ? 1 : 0)),
  );
  assert(real.every((value) => value === 1));
  assert(imag.every((value) => value === 0));
});

test("anchored envelope derives its absolute origin from an independently supplied continuous counter", () => {
  for (const held of [false, true]) {
    const model = genModel(CLOCK_ANCHORED_ENVELOPE_CODE, 15);
    let counter = 1000000,
      row;
    const idlePhase = held ? 0.304 : 0;
    const step = (phase, l = 0, r = 0) => model.step(phase, l, r, counter++);
    for (let i = 0; i < 128; i++) step(idlePhase);
    const armCounter = counter;
    model.configure({ epoch: 1 });
    step(idlePhase);
    for (let i = 0; i < 511; i++) step(idlePhase);
    const frames = [];
    let previous = 0;
    for (let i = 0; i <= 480064; i++) {
      row = step(
        held && i < 64 ? idlePhase : (i % 24000) / 24000,
        i === 0 ? 1 : 0,
      );
      assert.equal(row[4], 0);
      if (row[12] !== previous) {
        frames.push(row.slice(8, 13));
        previous = row[12];
      }
    }
    assert.equal(frames.length, 100);
    assert.equal(frames[0][0], 1);
    assert.equal(frames[0][2], Math.sqrt(1 / 4800));
    assert.equal(row[13], armCounter);
    assert.equal(row[14], armCounter + 512);
  }
});

test("continuous-counter discontinuity rejects an anchored arm before any envelope window", () => {
  const model = genModel(CLOCK_ANCHORED_ENVELOPE_CODE, 15);
  for (let i = 0; i < 128; i++) model.step(0, 0, 0, i);
  model.configure({ epoch: 1 });
  model.step(0, 0, 0, 128);
  const row = model.step(0, 0, 0, 130);
  assert.equal(row[4], 12);
  assert.equal(row[5], 0);
  assert.equal(row[12], 0);
});

test("engineering tagged FFT and anchored envelope assets match their sources and preserve passive I/O", async () => {
  for (const [name, document] of [
    ["tagged_spectrum_probe.gendsp", taggedSpectrumGenDocument()],
    ["clock_split_probe.gendsp", clockSplitDocument()],
    ["clock_anchored_envelope_probe.gendsp", clockAnchoredEnvelopeDocument()],
    ["tagged_spectrum_probe.maxpat", taggedSpectrumDocument()],
    ["synchronized_analysis_probe.maxpat", synchronizedAnalysisDocument()],
  ]) {
    validateDocument(document);
    assert.deepEqual(
      JSON.parse(await readFile(new URL(name, import.meta.url), "utf8")),
      document,
    );
    assert.doesNotMatch(JSON.stringify(document), /plugout~|dac~|node.script/);
  }
  const spectrum = taggedSpectrumDocument().patcher;
  assert(spectrum.boxes.some(({ box }) => box.text === "fftin~ 3 nofft"));
  assert(
    synchronizedAnalysisDocument().patcher.boxes.some(({ box }) =>
      box.text.includes("2048 1 0 1 @float32 0"),
    ),
  );
});
