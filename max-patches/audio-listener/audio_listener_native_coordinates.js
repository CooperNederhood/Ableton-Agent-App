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

const NATIVE_V2_SCOPE = "arrangement-descriptive/v2";
function nativeV2Configuration(geometry, policy) {
  const keys = [
    "sampleRate",
    "vectorSize",
    "tempoBpm",
    "startBeat",
    "endBeat",
    "hopSamples",
    "totalSamples",
  ];
  if (
    !geometry ||
    typeof geometry !== "object" ||
    Array.isArray(geometry) ||
    Object.keys(geometry).length !== keys.length ||
    Object.keys(geometry).some((key) => keys.indexOf(key) < 0) ||
    ![44100, 48000].includes(geometry.sampleRate) ||
    !Number.isInteger(geometry.vectorSize) ||
    geometry.vectorSize < 1 ||
    geometry.vectorSize > 1024 ||
    (geometry.vectorSize & (geometry.vectorSize - 1)) !== 0 ||
    !Number.isFinite(geometry.tempoBpm) ||
    geometry.tempoBpm < 20 ||
    geometry.tempoBpm > 999 ||
    !Number.isFinite(geometry.startBeat) ||
    geometry.startBeat < 0 ||
    geometry.startBeat > 1576800 ||
    !Number.isFinite(geometry.endBeat) ||
    geometry.endBeat <= geometry.startBeat ||
    geometry.endBeat > 1576800 ||
    geometry.hopSamples !== Math.round(geometry.sampleRate / 10) ||
    !Number.isSafeInteger(geometry.totalSamples) ||
    geometry.totalSamples !==
      Math.round(
        ((geometry.endBeat - geometry.startBeat) * geometry.sampleRate * 60) /
          geometry.tempoBpm,
      ) ||
    geometry.totalSamples < geometry.hopSamples ||
    geometry.totalSamples > 30 * geometry.sampleRate ||
    Math.ceil(geometry.totalSamples / geometry.hopSamples) > 300 ||
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).length !== 2 ||
    Object.keys(policy).some(
      (key) => !["mode", "maxClockDisagreementSamples"].includes(key),
    ) ||
    !["descriptive", "strict"].includes(policy.mode) ||
    !Number.isInteger(policy.maxClockDisagreementSamples) ||
    policy.maxClockDisagreementSamples < 0 ||
    policy.maxClockDisagreementSamples > 480 ||
    (policy.mode === "strict" && policy.maxClockDisagreementSamples !== 0)
  )
    throw new Error("invalid_native_v2_configuration");
  return Object.freeze({
    geometry: Object.freeze({ ...geometry }),
    policy: Object.freeze({ ...policy }),
  });
}

function nativeV2PhaseOffset(row, geometry) {
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const period = Math.round(samplesPerBeat);
  const difference =
    Math.round((row[1] % 1) * samplesPerBeat) -
    Math.round(row[5] * samplesPerBeat);
  if (difference > period / 2) return difference - period;
  if (difference < -period / 2) return difference + period;
  return difference;
}

function nativeV2PhaseDisagreement(row, geometry) {
  return Math.abs(nativeV2PhaseOffset(row, geometry));
}

function nativeV2ClockRow(row) {
  if (
    !Array.isArray(row) ||
    row.length !== 11 ||
    Array.from(row).some((value) => !Number.isFinite(value) || value < 0) ||
    ![0, 1].includes(row[0]) ||
    ![0, 1].includes(row[7]) ||
    row[1] > 1e9 ||
    row[8] > 1e9 ||
    !Number.isSafeInteger(row[2]) ||
    !Number.isSafeInteger(row[9]) ||
    !Number.isSafeInteger(row[3]) ||
    row[3] > 0x7fffffff ||
    !Number.isSafeInteger(row[10]) ||
    row[10] > 0x7fffffff ||
    (row[3] & 19) !== 19 ||
    (row[10] & 19) !== 19 ||
    !Number.isSafeInteger(row[4]) ||
    row[4] >= 2 ** 44 ||
    !Number.isSafeInteger(row[6]) ||
    row[6] >= 2 ** 44 ||
    row[5] > 1
  )
    throw new Error("invalid_native_clock");
  return (
    row[0] === row[7] &&
    row[1] === row[8] &&
    row[2] === row[9] &&
    row[3] === row[10] &&
    row[4] === row[6]
  );
}

function nativeV2HostBinding(value, playing, geometry, policy) {
  nativeV2Configuration(geometry, policy);
  if (
    !value ||
    !Array.isArray(value.dsp) ||
    value.dsp.length !== 3 ||
    value.dsp[0] !== 1 ||
    value.dsp[1] !== geometry.sampleRate ||
    value.dsp[2] !== geometry.vectorSize ||
    !Array.isArray(value.frames) ||
    value.frames.length !== 32
  )
    throw new Error("invalid_native_host_binding");
  let previous;
  const anchor = value.frames[0][2] - value.frames[0][4];
  for (const row of value.frames) {
    if (
      !nativeV2ClockRow(row) ||
      row[0] !== Number(playing) ||
      (!playing && row[1] !== geometry.startBeat) ||
      (!playing &&
        Math.abs(row[2] - row[4] - anchor) >
          policy.maxClockDisagreementSamples) ||
      (previous &&
        (row[4] <= previous[4] ||
          row[2] < previous[2] ||
          row[1] < previous[1] ||
          (!playing && row[5] !== previous[5])))
    )
      throw new Error("incoherent_native_v2_host_binding");
    previous = row;
  }
  if (previous[4] - value.frames[0][4] > geometry.sampleRate)
    throw new Error("stale_native_host_binding");
  return Object.freeze({ hostOffsetSamples: anchor, lastCounter: previous[4] });
}

function nativeV2PreflightTiming(value, host, geometry, policy) {
  const binding = nativeV2HostBinding(value?.before, false, geometry, policy);
  const packet = value.spectrum;
  if (
    !value ||
    Object.keys(value).some(
      (key) => !["before", "fftInformation", "spectrum"].includes(key),
    ) ||
    JSON.stringify(value.fftInformation) !==
      JSON.stringify([2048, 2048, 2048, 1]) ||
    !host ||
    host.playing ||
    !host.dspOn ||
    host.sampleRate !== geometry.sampleRate ||
    host.vectorSize !== geometry.vectorSize ||
    host.tempoBpm !== geometry.tempoBpm ||
    host.beat !== geometry.startBeat ||
    host.sample < value.before.frames[31][2] ||
    host.sample - value.before.frames[31][2] > geometry.sampleRate ||
    !Array.isArray(packet) ||
    packet.length !== 6 ||
    Array.from(packet).some(
      (number) => !Number.isFinite(number) || number < 0,
    ) ||
    !Number.isSafeInteger(packet[0]) ||
    packet[0] >= 2 ** 44 ||
    !Number.isSafeInteger(packet[3]) ||
    packet[0] !== packet[4] ||
    packet[0] - packet[3] !== 2048 ||
    packet[0] > binding.lastCounter ||
    binding.lastCounter - packet[0] >= 2048 ||
    packet[1] > geometry.sampleRate / 2 ||
    packet[2] > Number.MAX_SAFE_INTEGER ||
    (packet[2] <= 1e-20 && packet[1] !== 0) ||
    !Number.isSafeInteger(packet[5]) ||
    !Number.isSafeInteger(packet[3] + binding.hostOffsetSamples) ||
    packet[3] + binding.hostOffsetSamples < 0
  )
    throw new Error("invalid_native_v2_preflight");
  return Object.freeze({
    sampleRate: geometry.sampleRate,
    vectorSize: geometry.vectorSize,
    requiredHostFlags: 19,
    uncertaintySamples: policy.maxClockDisagreementSamples,
    before: Object.freeze({
      dsp: Object.freeze([...value.before.dsp]),
      frames: Object.freeze(
        value.before.frames.map((row) => Object.freeze([...row])),
      ),
    }),
    hostOffsetSamples: binding.hostOffsetSamples,
    fftGrid: (packet[3] + binding.hostOffsetSamples) % 2048,
    invalidFrames: packet[5],
  });
}

function nativeV2RetainTiming(timing, row, geometry) {
  if (!nativeV2ClockRow(row)) throw new Error("incoherent_native_v2_clock");
  const copy = Object.freeze([...row]);
  const offset = (value) => value[2] - value[4];
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const beatOrigin = (value) =>
    value[2] - Math.round((value[1] - geometry.startBeat) * samplesPerBeat);
  if (!timing.minHostOffset || offset(row) < offset(timing.minHostOffset))
    timing.minHostOffset = copy;
  if (!timing.maxHostOffset || offset(row) > offset(timing.maxHostOffset))
    timing.maxHostOffset = copy;
  if (row[0] === 1) {
    if (
      !timing.minBeatOrigin ||
      beatOrigin(row) < beatOrigin(timing.minBeatOrigin)
    )
      timing.minBeatOrigin = copy;
    if (
      !timing.maxBeatOrigin ||
      beatOrigin(row) > beatOrigin(timing.maxBeatOrigin)
    )
      timing.maxBeatOrigin = copy;
    if (
      !timing.maxPhaseDisagreement ||
      nativeV2PhaseDisagreement(row, geometry) >
        nativeV2PhaseDisagreement(timing.maxPhaseDisagreement, geometry)
    )
      timing.maxPhaseDisagreement = copy;
  }
}

function nativeV2AlignmentMeasurements(timing, geometry, offset, startSample) {
  const offsets = [timing.minHostOffset, timing.maxHostOffset].filter(Boolean);
  const origins = [timing.minBeatOrigin, timing.maxBeatOrigin].filter(Boolean);
  const samplesPerBeat = (geometry.sampleRate * 60) / geometry.tempoBpm;
  const clock = Math.max(
    0,
    ...offsets.map((row) => Math.abs(row[2] - row[4] - offset)),
  );
  const beat = Math.max(
    0,
    ...origins.map((row) =>
      Math.abs(
        row[2] -
          Math.round((row[1] - geometry.startBeat) * samplesPerBeat) -
          startSample,
      ),
    ),
    timing.maxPhaseDisagreement
      ? nativeV2PhaseDisagreement(timing.maxPhaseDisagreement, geometry)
      : 0,
  );
  return Object.freeze({
    observedClockDisagreementSamples: clock,
    observedBeatDisagreementSamples: beat,
  });
}

function nativeV2Alignment(timing, geometry, policy, offset, startSample) {
  const measurements = nativeV2AlignmentMeasurements(
    timing,
    geometry,
    offset,
    startSample,
  );
  const {
    observedClockDisagreementSamples: clock,
    observedBeatDisagreementSamples: beat,
  } = measurements;
  if (Math.max(clock, beat) > policy.maxClockDisagreementSamples) {
    const error = new Error("listening_alignment_budget_exceeded");
    error.alignmentMeasurements = measurements;
    throw error;
  }
  return {
    schema: "listening-alignment/v2",
    policy: { ...policy },
    sampleRate: geometry.sampleRate,
    vectorSize: geometry.vectorSize,
    observedClockDisagreementSamples: clock,
    observedBeatDisagreementSamples: beat,
    alignment: "approximate",
    intendedUse: "descriptive-only",
    estimatedAbsoluteErrorSamples: null,
    verifiedAbsoluteErrorBoundSamples: null,
  };
}

module.exports = {
  nativeHostBinding,
  nativePreflightTiming,
  NATIVE_V2_SCOPE,
  nativeV2Configuration,
  nativeV2PhaseOffset,
  nativeV2PhaseDisagreement,
  nativeV2ClockRow,
  nativeV2HostBinding,
  nativeV2PreflightTiming,
  nativeV2RetainTiming,
  nativeV2AlignmentMeasurements,
  nativeV2Alignment,
};
