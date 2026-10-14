/* global module */
"use strict";

function nativeHostBinding(value, playing) {
  if (
    typeof playing !== "boolean" ||
    !value ||
    !Array.isArray(value.dsp) ||
    value.dsp.length !== 3 ||
    value.dsp[0] !== 1 ||
    value.dsp[1] !== 48000 ||
    value.dsp[2] !== 64 ||
    !Array.isArray(value.frames) ||
    value.frames.length !== 32
  ) {
    throw new Error("invalid_native_host_binding");
  }
  let offset,
    beatZero,
    previous = -1;
  for (const row of value.frames) {
    if (
      !Array.isArray(row) ||
      row.length !== 11 ||
      row.some((number) => !Number.isFinite(number) || number < 0) ||
      row[1] > 1000000000 ||
      row[0] !== Number(playing) ||
      row[7] !== row[0] ||
      row[1] !== row[8] ||
      row[2] !== row[9] ||
      row[3] !== row[10] ||
      !Number.isSafeInteger(row[2]) ||
      !Number.isSafeInteger(row[3]) ||
      row[3] > 0x7fffffff ||
      (row[3] & 19) !== 19 ||
      !Number.isSafeInteger(row[4]) ||
      row[4] !== row[6] ||
      row[4] >= 2 ** 44 ||
      row[4] <= previous ||
      row[5] > 1
    ) {
      throw new Error("incoherent_native_host_binding");
    }
    previous = row[4];
    const candidate = row[2] - row[4];
    if (offset !== undefined && offset !== candidate)
      throw new Error("native_host_offset_changed");
    offset = candidate;
    if (playing) {
      const candidateZero = row[2] - Math.round(row[1] * 24000);
      const phase =
        (Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) % 24000;
      if (
        phase !== 0 ||
        (beatZero !== undefined && beatZero !== candidateZero)
      ) {
        throw new Error("native_host_phase_changed");
      }
      beatZero = candidateZero;
    }
  }
  return Object.freeze({
    hostOffsetSamples: offset,
    hostBeatZeroSample: playing ? beatZero : null,
    lastCounter: previous,
  });
}

module.exports = { nativeHostBinding };
