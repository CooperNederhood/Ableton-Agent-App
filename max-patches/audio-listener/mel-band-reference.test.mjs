import test from "node:test";
import assert from "node:assert/strict";
import {
  melBandReference,
  melBandReferenceDefinitions,
} from "./mel-band-reference.mjs";

const length = 2048;
const rates = [44100, 48000];
const tone = (bin, amplitude = 1) =>
  Array.from(
    { length },
    (_, index) => amplitude * Math.cos((2 * Math.PI * bin * index) / length),
  );
const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, received ${actual}`,
  );
const triangle = (frequency, band) =>
  Math.max(
    0,
    Math.min(
      (frequency - band.lowerHz) / (band.centerHz - band.lowerHz),
      (band.upperHz - frequency) / (band.upperHz - band.centerHz),
    ),
  );

test("mel reference pins a contiguous overlapping 24-band filterbank", () => {
  const bands = melBandReferenceDefinitions;
  assert.equal(bands.length, 24);
  close(bands[0].lowerHz, 20, 1e-10);
  close(bands.at(-1).upperHz, 20000, 1e-10);
  assert.ok(Object.isFrozen(bands));
  for (const [index, band] of bands.entries()) {
    assert.ok(Object.isFrozen(band));
    assert.equal(band.index, index);
    assert.ok(band.lowerHz < band.centerHz);
    assert.ok(band.centerHz < band.upperHz);
    if (index > 0) {
      assert.equal(bands[index - 1].centerHz, band.lowerHz);
      assert.equal(bands[index - 1].upperHz, band.centerHz);
    }
  }
});

for (const sampleRate of rates) {
  test(`mel reference preserves measured zeros at ${sampleRate} Hz`, () => {
    assert.deepEqual(
      melBandReference(Array(length).fill(0), sampleRate),
      Array(24).fill(0),
    );
  });

  test(`periodic-Hann centered impulse uses unnormalized magnitude sums at ${sampleRate} Hz`, () => {
    const impulse = Array(length).fill(0);
    impulse[length / 2] = 1;
    const values = melBandReference(impulse, sampleRate);
    for (const band of melBandReferenceDefinitions) {
      let expected = 0;
      for (let bin = 0; bin <= length / 2; bin++)
        expected += triangle((bin * sampleRate) / length, band);
      close(values[band.index], expected);
    }
    assert.ok(values.at(-1) > values[0] * 10);
    assert.equal(impulse[length / 2], 1);
    assert.equal(impulse.filter((value) => value !== 0).length, 1);
  });

  for (const bin of [8, 48, 256]) {
    test(`bin ${bin} has the analytic three-bin Hann spectrum at ${sampleRate} Hz`, () => {
      const actual = melBandReference(tone(bin), sampleRate);
      for (const band of melBandReferenceDefinitions) {
        const expected =
          (length / 4) * triangle((bin * sampleRate) / length, band) +
          (length / 8) *
            (triangle(((bin - 1) * sampleRate) / length, band) +
              triangle(((bin + 1) * sampleRate) / length, band));
        close(actual[band.index], expected);
      }
    });
  }

  test(`mixed isolated tones retain band balance and linear gain at ${sampleRate} Hz`, () => {
    const inputs = [tone(8, 0.25), tone(48, 0.5), tone(256, 0.75)];
    const mixed = inputs[0].map((_, index) =>
      inputs.reduce((sum, input) => sum + input[index], 0),
    );
    const components = inputs.map((input) =>
      melBandReference(input, sampleRate),
    );
    const actual = melBandReference(mixed, sampleRate);
    const gained = melBandReference(
      mixed.map((sample) => sample * 4),
      sampleRate,
    );
    for (let index = 0; index < 24; index++) {
      close(
        actual[index],
        components.reduce((sum, values) => sum + values[index], 0),
      );
      close(gained[index], actual[index] * 4);
    }
  });

  test(`an inter-band tone contributes to adjacent filters at ${sampleRate} Hz`, () => {
    const bands = melBandReferenceDefinitions;
    const frequency = (bands[10].centerHz + bands[11].centerHz) / 2;
    const actual = melBandReference(
      tone((frequency * length) / sampleRate),
      sampleRate,
    );
    const largest = actual
      .map((value, index) => ({ value, index }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 2)
      .map(({ index }) => index)
      .sort((left, right) => left - right);
    assert.deepEqual(largest, [10, 11]);
    assert.ok(actual[10] > 0 && actual[11] > 0);
  });
}

test("mel reference does not mix independent channel inputs", () => {
  const left = tone(8);
  const right = tone(256);
  const leftValues = melBandReference(left, 48000);
  const rightValues = melBandReference(right, 48000);
  assert.notDeepEqual(leftValues, rightValues);
  const frozenLeft = [...leftValues];
  right.fill(0);
  assert.deepEqual(melBandReference(right, 48000), Array(24).fill(0));
  assert.deepEqual(leftValues, frozenLeft);
  assert.deepEqual(melBandReference(left, 48000), frozenLeft);
});

test("mel reference rejects malformed, unbounded and unsupported inputs", () => {
  for (const input of [
    null,
    "audio",
    new Float64Array(length),
    Array(length - 1).fill(0),
    Array(length + 1).fill(0),
    Array(length),
    Array(length).fill(NaN),
    Array(length).fill(Infinity),
    Array(length).fill(-Infinity),
    Array(length).fill(64.0001),
    Array(length).fill(-64.0001),
  ])
    assert.throws(() => melBandReference(input, 48000), /mel_reference/);
  for (const rate of [0, 22050, 96000, NaN, "48000"])
    assert.throws(
      () => melBandReference(Array(length).fill(0), rate),
      /mel_reference_sample_rate/,
    );
  assert.ok(
    melBandReference(Array(length).fill(64), 48000).every(Number.isFinite),
  );
});
