import test from "node:test";
import assert from "node:assert/strict";
import {
  MEL_BAND_PROFILE,
  aggregateMelBandFrames,
  deriveMelBandFrame,
} from "../../packages/protocol/dist/mel-band-profile.js";
import {
  melBandReference,
  melBandReferenceDefinitions,
} from "./mel-band-reference.mjs";

const length = 2048;
const close = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-10,
    `expected ${expected}, received ${actual}`,
  );
const mixedFrame = (levels) =>
  Array.from({ length }, (_, index) =>
    [8, 48, 256].reduce(
      (sum, bin, part) =>
        sum + levels[part] * Math.cos((2 * Math.PI * bin * index) / length),
      0,
    ),
  );
function regionSums(values) {
  const regions = { low: 0, mid: 0, high: 0 };
  for (const band of melBandReferenceDefinitions) {
    const region =
      band.centerHz < 250 ? "low" : band.centerHz < 2000 ? "mid" : "high";
    regions[region] += values[band.index];
  }
  return regions;
}

test("compiled protocol dimensions agree with independently calculated mel edges", () => {
  assert.equal(MEL_BAND_PROFILE.bandCount, 24);
  for (const expected of melBandReferenceDefinitions) {
    const band = MEL_BAND_PROFILE.bands[expected.index];
    assert.equal(band.index, expected.index);
    for (const key of ["lowerHz", "centerHz", "upperHz"])
      close(band[key], expected[key]);
  }
});

for (const sampleRate of [44100, 48000]) {
  test(`compiled stereo ratio derivation preserves reference band sums at ${sampleRate} Hz`, () => {
    const stereo = [
      melBandReference(mixedFrame([0.75, 0.5, 0.25]), sampleRate),
      melBandReference(mixedFrame([0.125, 0.25, 0.5]), sampleRate),
    ];
    const actual = deriveMelBandFrame(stereo);
    assert.deepEqual(actual.magnitudes, stereo);
    assert.notDeepEqual(actual.ratios[0], actual.ratios[1]);
    for (let channel = 0; channel < 2; channel++) {
      const expected = regionSums(stereo[channel]);
      for (const region of ["low", "mid", "high"])
        close(actual.regions[channel][region], expected[region]);
      close(actual.ratios[channel].lowMid.value, expected.low / expected.mid);
      close(actual.ratios[channel].highMid.value, expected.high / expected.mid);
      assert.equal(actual.ratios[channel].lowMid.reason, null);
      assert.equal(actual.ratios[channel].highMid.reason, null);
    }
  });

  test(`compiled interval ratios use matching mean reference bands at ${sampleRate} Hz`, () => {
    const inputs = [
      [
        [0.75, 0.25, 0.125],
        [0.125, 0.75, 0.25],
      ],
      [
        [0.25, 0.75, 0.5],
        [0.75, 0.125, 0.5],
      ],
    ].map((channels) =>
      channels.map((levels) =>
        melBandReference(mixedFrame(levels), sampleRate),
      ),
    );
    const output = aggregateMelBandFrames(inputs);
    assert.equal(output.status, "completed");
    assert.equal(output.frameCount, 2);
    for (let channel = 0; channel < 2; channel++) {
      const mean = inputs[0][channel].map(
        (value, band) => (value + inputs[1][channel][band]) / 2,
      );
      const expected = regionSums(mean);
      const actual = output.analysis;
      assert.deepEqual(actual.magnitudes[channel], mean);
      close(actual.ratios[channel].lowMid.value, expected.low / expected.mid);
      close(actual.ratios[channel].highMid.value, expected.high / expected.mid);
    }
  });
}
