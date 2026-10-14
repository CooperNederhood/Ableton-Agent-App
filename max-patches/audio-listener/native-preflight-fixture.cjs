"use strict";

const recorded = require("./fixtures/native-host-spectrum.json");

/** Synthetic timely preflight. Recorded coordinates are not actual runtime acceptance. */
function syntheticPreflight() {
  const last = recorded.nativeOrigin[1] - 64;
  const offset = recorded.before.clockOffsetSamples;
  const grid = recorded.spectrum.frames[0][3] % 2048;
  const end = last - ((last - grid) % 2048);
  return {
    before: {
      dsp: [1, 48000, 64],
      frames: Array.from({ length: 32 }, (_, index) => {
        const counter = last - (31 - index) * 64;
        const sample = counter + offset;
        return [0, 0, sample, 31, counter, 0.25, counter, 0, 0, sample, 31];
      }),
    },
    fftInformation: [2048, 2048, 2048, 1],
    spectrum: [end, 0, 0, end - 2048, end, 353],
  };
}

module.exports = { syntheticPreflight };
