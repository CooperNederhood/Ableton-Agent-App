// Offline engineering verifier. Never executes/imports the listener DSP model,
// acquires audio, authorizes production, or constructs a production observation.
import { open, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";
import { checkCalibrationArtifact } from "../../scripts/audio-listener-device.mjs";

const require = createRequire(import.meta.url);
const { validateReport, MAX_BYTES } = require("./calibration_report.js");
const { readArtifact } = require("./calibration_controller.js");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const HOP = 4800,
  FFT = 2048,
  FRAME_COUNT = 96000;
// Acceptance policy matches the independent test-support listening verifier:
// 0.001 linear peak, 0.25 dB RMS, two actual FFT bins (not envelope bins).
const PEAK_TOLERANCE = 0.001,
  RMS_DB_TOLERANCE = 0.25,
  SILENCE_TOLERANCE = 1e-6;
const UNPROVED = Object.freeze([
  "actual_max_buffer_identity_and_execution",
  "runner_process_ownership_and_report_authenticity",
  "native_attack_count_and_timing",
  "exact_fft_frame_coordinates_latency_and_absolute_energy_scaling",
  "stereo_polarity_channel_swap_and_individual_fft_channel_participation",
  "live_source_onset_host_vector_phase_and_passthrough",
  "production_timing_readiness_or_certification",
]);

function verdict() {
  return {
    schema: "native-commissioning-verification/v1",
    calibrationOnly: true,
    nativeTiming: "UNVERIFIED",
    productionReady: false,
    passed: false,
    scope: "offline_declared_fixture_numeric_checks_only",
    fixture: null,
    failures: [],
    checked: {
      schema: false,
      artifactAndDeclaredSourceIdentity: false,
      coverageAndResetMarkers: false,
      sourceGate: false,
      perWindowStereoPeakRms: false,
      wholeFixturePeakRms: false,
      centroid: false,
    },
    tolerances: {
      peakLinear: PEAK_TOLERANCE,
      rmsDb: RMS_DB_TOLERANCE,
      silenceLinear: SILENCE_TOLERANCE,
      centroidHz: (2 * 48000) / FFT,
    },
    unproved: [...UNPROVED],
  };
}
function failure(v, code) {
  if (v.failures.length < 128 && !v.failures.includes(code))
    v.failures.push(code);
}
function closeRms(actual, expected) {
  return expected === 0
    ? actual <= SILENCE_TOLERANCE
    : actual > 0 &&
        Math.abs(20 * Math.log10(actual / expected)) <= RMS_DB_TOLERANCE;
}

/** Fixture/source identity here is declaration + independent staged bytes, NOT
 * attestation that Max actually loaded/processed those bytes. Reports have no
 * signal-derived identity or attack/FFT-frame fields; those remain unproved.
 */
export async function verifyCalibrationReport(
  input,
  { artifactDirectory } = {},
) {
  const result = verdict();
  let r;
  try {
    r = validateReport(input);
  } catch {
    failure(result, "invalid_or_unbounded_report");
    return result;
  }
  result.checked.schema = true;
  result.fixture = { id: r.fixture.id, sha256: r.fixture.sha256 };
  if (!artifactDirectory || typeof artifactDirectory !== "string") {
    failure(result, "artifact_evidence_required");
    return result;
  }
  const fixture = createKnownListeningFixture(r.fixture.id);
  try {
    // Reuse structural, hash and file-size preflight before the common checker
    // reads resources. This collector module is not started and supplies no
    // numeric expectations; the independent PCM below remains the sole oracle.
    readArtifact(artifactDirectory);
    const manifest = await checkCalibrationArtifact(artifactDirectory);
    const expected = manifest.fixtures.find((f) => f.id === r.fixture.id);
    if (
      !expected ||
      r.fixture.sha256 !== hash(fixture.wav) ||
      expected.sha256 !== r.fixture.sha256 ||
      r.fixture.sampleRate !== fixture.sampleRate ||
      r.fixture.frames !== FRAME_COUNT ||
      r.dsp.sampleRate !== fixture.sampleRate ||
      Object.entries(r.resources).some(
        ([name, digest]) =>
          manifest.resources.find((resource) => resource.name === name)
            ?.sha256 !== digest,
      )
    ) {
      failure(result, "fixture_or_native_resource_identity_mismatch");
      return result;
    }
  } catch {
    failure(result, "artifact_evidence_invalid");
    return result;
  }
  result.checked.artifactAndDeclaredSourceIdentity = true;

  const start = r.markers.start,
    stop = r.markers.stop;
  const complete =
    r.outcome === "collected" &&
    r.reason === "fixture_end" &&
    r.descriptors.length === 20 &&
    start &&
    stop &&
    stop.resetEpoch === start.resetEpoch + 1 &&
    start.dspSample - start.resetSample < HOP &&
    stop.resetSample - start.resetSample >= FRAME_COUNT - 1 &&
    stop.resetSample - start.resetSample <= 480000 &&
    stop.resetSample >= r.descriptors.at(-1).marker.dspSample &&
    r.descriptors.every(
      (p) =>
        p.referenceSample >= p.analysisSample - 1 &&
        p.referenceSample < p.analysisSample + HOP,
    );
  if (!complete) {
    failure(result, "incomplete_or_incoherent_native_coverage_reset");
    return result;
  }
  result.checked.coverageAndResetMarkers = true;
  let gates = true,
    windows = true,
    whole = true,
    spectral = true;
  const data = new DataView(
    fixture.wav.buffer,
    fixture.wav.byteOffset,
    fixture.wav.byteLength,
  );
  const observedPeak = [0, 0],
    observedPower = [0, 0];
  for (let i = 0; i < 20; i++) {
    const p = r.descriptors[i],
      from = i * HOP;
    const peaks = [0, 0],
      sums = [0, 0];
    // Independent quantized PCM integration, not generated from listener code.
    for (let frame = from; frame < from + HOP; frame++)
      for (let c = 0; c < 2; c++) {
        const sample = data.getInt16(44 + frame * 4 + c * 2, true) / 32768;
        peaks[c] = Math.max(peaks[c], Math.abs(sample));
        sums[c] += sample * sample;
      }
    for (let c = 0; c < 2; c++) {
      const expectedRms = Math.sqrt(sums[c] / HOP);
      if (
        Math.abs(p.peak[c] - peaks[c]) >
        (peaks[c] === 0 ? SILENCE_TOLERANCE : PEAK_TOLERANCE)
      ) {
        windows = false;
        failure(result, `window_${i + 1}_channel_${c + 1}_peak`);
      }
      if (!closeRms(p.rms[c], expectedRms)) {
        windows = false;
        failure(result, `window_${i + 1}_channel_${c + 1}_rms`);
      }
      observedPeak[c] = Math.max(observedPeak[c], p.peak[c]);
      observedPower[c] += p.rms[c] ** 2 / 20;
    }
    if (p.sourceActive !== p.referenceSample < FRAME_COUNT) {
      gates = false;
      failure(result, `window_${i + 1}_source_gate`);
    }
    if (fixture.frequencyHz === null) {
      if (p.centroidHz !== null || p.spectralEnergy > 1e-20) {
        spectral = false;
        failure(result, `window_${i + 1}_silent_spectrum`);
      }
    } else if (i % 5 === 1) {
      // Four nominal steady-gate checkpoints only. Exact FFT frame coordinates
      // are absent: do not compare transient frames or invent FFT timestamps.
      if (
        p.centroidHz === null ||
        p.spectralEnergy <= 1e-20 ||
        Math.abs(p.centroidHz - fixture.frequencyHz) >
          result.tolerances.centroidHz
      ) {
        spectral = false;
        failure(result, `window_${i + 1}_steady_tone_centroid`);
      }
    }
  }
  for (let c = 0; c < 2; c++) {
    if (
      Math.abs(observedPeak[c] - fixture.reference.peak[c]) >
      (fixture.reference.peak[c] === 0 ? SILENCE_TOLERANCE : PEAK_TOLERANCE)
    ) {
      whole = false;
      failure(result, `whole_channel_${c + 1}_peak`);
    }
    const rms = Math.sqrt(observedPower[c]),
      expected = fixture.reference.rmsDbfs[c];
    if (
      expected === null
        ? rms > SILENCE_TOLERANCE
        : rms <= 0 ||
          Math.abs(20 * Math.log10(rms) - expected) > RMS_DB_TOLERANCE
    ) {
      whole = false;
      failure(result, `whole_channel_${c + 1}_rms`);
    }
  }
  Object.assign(result.checked, {
    sourceGate: gates,
    perWindowStereoPeakRms: windows,
    wholeFixturePeakRms: whole,
    centroid: spectral,
  });
  result.passed = result.failures.length === 0;
  return result;
}

/** Bound filesystem input before parsing; no output writes or application access. */
export async function verifyCalibrationReportFile(
  file,
  { artifactDirectory } = {},
) {
  const result = verdict();
  let handle;
  try {
    if (typeof file !== "string" || !file || file.length > 4096) throw Error();
    const initial = await lstat(resolve(file));
    if (!initial.isFile() || initial.size < 1 || initial.size > MAX_BYTES) {
      failure(result, "report_file_size_or_type");
      return result;
    }
    handle = await open(resolve(file), "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) {
      failure(result, "report_file_size_or_type");
      return result;
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) {
      failure(result, "report_file_size_or_type");
      return result;
    }
    let report;
    try {
      report = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    } catch {
      failure(result, "invalid_report_json");
      return result;
    }
    return await verifyCalibrationReport(report, {
      artifactDirectory: artifactDirectory ?? dirname(resolve(file)),
    });
  } catch {
    failure(result, "report_file_unavailable");
    return result;
  } finally {
    if (handle) await handle.close();
  }
}
