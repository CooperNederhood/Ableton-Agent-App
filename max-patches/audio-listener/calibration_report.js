/* global module, Buffer */
"use strict";
const SCHEMA = "native-commissioning/v1";
const MAX_POINTS = 128;
const MAX_BYTES = 65536;
const FIXTURES = ["silence", "quarter-sine", "anti-phase-quarter-sine"];
const ANALYSIS_RESOURCES = [
  "audio_listener_analysis.maxpat",
  "audio_listener_spectrum.maxpat",
  "audio_listener_envelope.gendsp",
  "audio_listener_spectrum_energy.gendsp",
];
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  ) {
    throw new Error("invalid_commissioning_shape");
  }
}
function number(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isFinite(value) || value < 0 || value > max)
    throw new Error("invalid_commissioning_number");
}
function integer(value, max = Number.MAX_SAFE_INTEGER) {
  number(value, max);
  if (!Number.isSafeInteger(value))
    throw new Error("invalid_commissioning_integer");
}
function digest(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("invalid_resource_digest");
}
function marker(value, vectorSize) {
  exact(value, [
    "dspSample",
    "vectorIndex",
    "vectorOffset",
    "resetEpoch",
    "resetSample",
  ]);
  Object.values(value).forEach((v) => integer(v));
  if (
    value.resetEpoch < 1 ||
    value.resetEpoch > 1000000 ||
    value.resetSample > value.dspSample ||
    value.vectorIndex !== Math.floor(value.dspSample / vectorSize) ||
    value.vectorOffset !== value.dspSample % vectorSize
  )
    throw new Error("invalid_native_marker");
  return value;
}
function validateReport(value) {
  exact(value, [
    "schema",
    "calibrationOnly",
    "nativeTiming",
    "productionReady",
    "outcome",
    "reason",
    "fixture",
    "dsp",
    "resources",
    "markers",
    "descriptors",
    "limitations",
  ]);
  if (
    value.schema !== SCHEMA ||
    value.calibrationOnly !== true ||
    value.nativeTiming !== "UNVERIFIED" ||
    value.productionReady !== false ||
    !["collected", "cancelled", "failed"].includes(value.outcome)
  ) {
    throw new Error("invalid_commissioning_status");
  }
  if (typeof value.reason !== "string" || !/^[a-z_]{1,80}$/.test(value.reason))
    throw new Error("invalid_reason");
  exact(value.fixture, ["id", "sha256", "sampleRate", "frames"]);
  if (
    !FIXTURES.includes(value.fixture.id) ||
    value.fixture.sampleRate !== 48000 ||
    value.fixture.frames !== 96000
  ) {
    throw new Error("invalid_fixture");
  }
  digest(value.fixture.sha256);
  exact(value.dsp, ["sampleRate", "vectorSize", "ioVectorSize"]);
  if (value.dsp.sampleRate !== 48000)
    throw new Error("unsupported_sample_rate");
  integer(value.dsp.vectorSize, 4096);
  integer(value.dsp.ioVectorSize, 65536);
  if (!value.dsp.vectorSize || !value.dsp.ioVectorSize)
    throw new Error("invalid_vector_size");
  exact(value.resources, ANALYSIS_RESOURCES);
  Object.values(value.resources).forEach(digest);
  exact(value.markers, ["start", "stop"]);
  for (const m of Object.values(value.markers))
    if (m !== null) marker(m, value.dsp.vectorSize);
  if (
    !Array.isArray(value.descriptors) ||
    value.descriptors.length > MAX_POINTS
  )
    throw new Error("descriptor_limit");
  let previous = 0;
  let previousReference = -1;
  for (const p of value.descriptors) {
    exact(p, [
      "analysisSample",
      "referenceSample",
      "marker",
      "sourceActive",
      "peak",
      "rms",
      "centroidHz",
      "spectralEnergy",
    ]);
    if (typeof p.sourceActive !== "boolean")
      throw new Error("invalid_source_gate");
    integer(p.analysisSample, value.fixture.frames);
    integer(p.referenceSample);
    if (p.analysisSample !== previous + 4800) throw new Error("descriptor_gap");
    marker(p.marker, value.dsp.vectorSize);
    if (
      p.referenceSample !== p.marker.dspSample - p.marker.resetSample ||
      p.marker.resetEpoch !== value.markers.start?.resetEpoch ||
      p.marker.resetSample !== value.markers.start?.resetSample ||
      p.referenceSample <= previousReference
    )
      throw new Error("marker_epoch_mismatch");
    for (const name of ["peak", "rms"]) {
      if (!Array.isArray(p[name]) || p[name].length !== 2)
        throw new Error("invalid_stereo_descriptor");
      p[name].forEach((v) => number(v, 64));
    }
    if (p.rms.some((v, i) => v > p.peak[i] + 1e-6))
      throw new Error("rms_exceeds_peak");
    if (p.centroidHz !== null) number(p.centroidHz, value.dsp.sampleRate / 2);
    number(p.spectralEnergy, 1e20);
    if (p.spectralEnergy <= 1e-20 && p.centroidHz !== null)
      throw new Error("silent_centroid");
    previous = p.analysisSample;
    previousReference = p.referenceSample;
  }
  if (
    value.markers.start &&
    value.markers.stop &&
    (value.markers.stop.resetEpoch <= value.markers.start.resetEpoch ||
      value.markers.stop.dspSample < value.markers.start.dspSample)
  )
    throw new Error("invalid_reset_order");
  if (
    value.outcome === "collected" &&
    (!value.markers.start ||
      !value.markers.stop ||
      previous !== value.fixture.frames)
  ) {
    throw new Error("missing_native_coverage_or_reset");
  }
  if (
    !Array.isArray(value.limitations) ||
    value.limitations.length < 1 ||
    value.limitations.length > 16 ||
    value.limitations.some((v) => typeof v !== "string" || !v || v.length > 500)
  )
    throw new Error("invalid_limitations");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES)
    throw new Error("report_byte_limit");
  return value;
}
module.exports = {
  SCHEMA,
  MAX_POINTS,
  MAX_BYTES,
  FIXTURES,
  ANALYSIS_RESOURCES,
  exact,
  integer,
  marker,
  validateReport,
};
