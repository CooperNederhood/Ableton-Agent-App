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
      Array.from(row).some(
        (number) => !Number.isFinite(number) || number < 0,
      ) ||
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

function nativePreflightTiming(value, host) {
  if (!value) throw new Error("native_preflight_required");
  if (
    Object.keys(value).some(
      (key) => !["before", "fftInformation", "spectrum"].includes(key),
    ) ||
    !value.before ||
    Object.keys(value.before).some((key) => !["dsp", "frames"].includes(key)) ||
    !Array.isArray(value.fftInformation) ||
    value.fftInformation.length !== 4 ||
    Array.from(value.fftInformation).some(
      (number, index) => number !== [2048, 2048, 2048, 1][index],
    )
  )
    throw new Error("invalid_native_preflight");
  const binding = nativeHostBinding(value.before, false);
  const rows = value.before.frames;
  const first = rows[0],
    last = rows[31];
  if (
    !host ||
    host.playing !== false ||
    host.dspOn !== true ||
    host.sampleRate !== 48000 ||
    host.vectorSize !== 64 ||
    host.tempoBpm !== 120 ||
    host.beat !== 0 ||
    !Number.isSafeInteger(host.flags) ||
    (host.flags & 19) !== 19 ||
    !Number.isSafeInteger(host.sample) ||
    host.sample < last[2] ||
    host.sample - last[2] > 48000 ||
    last[4] - first[4] > 48000 ||
    rows.some((row) => row[1] !== 0 || row[5] !== first[5])
  ) {
    throw new Error("stale_or_moving_native_preflight");
  }
  const packet = value.spectrum;
  if (
    !Array.isArray(packet) ||
    packet.length !== 6 ||
    Array.from(packet).some(
      (number) => !Number.isFinite(number) || number < 0,
    ) ||
    !Number.isSafeInteger(packet[0]) ||
    !Number.isSafeInteger(packet[3]) ||
    packet[0] >= 2 ** 44 ||
    packet[0] !== packet[4] ||
    packet[0] - packet[3] !== 2048 ||
    packet[0] > last[4] ||
    last[4] - packet[0] >= 2048 ||
    !Number.isSafeInteger(packet[3] + binding.hostOffsetSamples) ||
    packet[3] + binding.hostOffsetSamples < 0 ||
    packet[1] > 24000 ||
    packet[2] > Number.MAX_SAFE_INTEGER ||
    (packet[2] <= 1e-20 && packet[1] !== 0) ||
    !Number.isSafeInteger(packet[5])
  )
    throw new Error("invalid_native_preflight_spectrum");
  const before = Object.freeze({
    dsp: Object.freeze([...value.before.dsp]),
    frames: Object.freeze(rows.map((row) => Object.freeze([...row]))),
  });
  return Object.freeze({
    sampleRate: 48000,
    vectorSize: 64,
    requiredHostFlags: 19,
    uncertaintySamples: 64,
    descriptorOffsetSamples: 0,
    before,
    hostOffsetSamples: binding.hostOffsetSamples,
    fftGrid: (packet[3] + binding.hostOffsetSamples) % 2048,
    invalidFrames: packet[5],
  });
}

module.exports = { nativeHostBinding, nativePreflightTiming };
