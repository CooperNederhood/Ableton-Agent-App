/* global structuredClone, process */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCalibration } from "../../scripts/audio-listener-device.mjs";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";
import {
  verifyCalibrationReport,
  verifyCalibrationReportFile,
} from "./calibration-verifier.mjs";

async function setup(t, id = "quarter-sine") {
  const dir = await mkdtemp(join(tmpdir(), "commission-verifier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = await buildCalibration(dir),
    fixture = createKnownListeningFixture(id);
  const reference = manifest.fixtures.find((f) => f.id === id);
  const data = new DataView(fixture.wav.buffer);
  const marker = (sample, epoch = 17, reset = 16384) => ({
    dspSample: reset + sample,
    vectorIndex: Math.floor((reset + sample) / 64),
    vectorOffset: (reset + sample) % 64,
    resetEpoch: epoch,
    resetSample: reset,
  });
  // Independent generated-PCM positive DTO, never an actual Max observation.
  const points = [];
  for (let end = 4800; end <= 96000; end += 4800) {
    const peak = [0, 0],
      sums = [0, 0];
    for (let i = end - 4800; i < end; i++)
      for (let c = 0; c < 2; c++) {
        const x = data.getInt16(44 + i * 4 + c * 2, true) / 32768;
        peak[c] = Math.max(peak[c], Math.abs(x));
        sums[c] += x * x;
      }
    const tone = id !== "silence" && end % 24000 <= 14400 && end % 24000 !== 0;
    points.push({
      analysisSample: end,
      referenceSample: end,
      marker: marker(end),
      sourceActive: end < 96000,
      peak,
      rms: sums.map((s) => Math.sqrt(s / 4800)),
      centroidHz: tone ? 440 : null,
      spectralEnergy: tone ? 1000 : 0,
    });
  }
  const report = {
    schema: "native-commissioning/v1",
    calibrationOnly: true,
    nativeTiming: "UNVERIFIED",
    productionReady: false,
    outcome: "collected",
    reason: "fixture_end",
    fixture: { id, sha256: reference.sha256, sampleRate: 48000, frames: 96000 },
    dsp: { sampleRate: 48000, vectorSize: 64, ioVectorSize: 256 },
    resources: Object.fromEntries(
      manifest.resources
        .filter((r) => r.name.startsWith("audio_listener_"))
        .map((r) => [r.name, r.sha256]),
    ),
    markers: { start: marker(0), stop: marker(0, 18, 16384 + 97024) },
    descriptors: points,
    limitations: ["Synthetic verifier test; not actual DSP proof."],
  };
  return { dir, report };
}

test("independent PCM synthetic silence, sine and anti-phase pass numeric checks only", async (t) => {
  for (const id of ["silence", "quarter-sine", "anti-phase-quarter-sine"]) {
    const { dir, report } = await setup(t, id);
    const result = await verifyCalibrationReport(report, {
      artifactDirectory: dir,
    });
    assert.equal(result.passed, true, JSON.stringify(result.failures));
    assert.equal(result.calibrationOnly, true);
    assert.equal(result.nativeTiming, "UNVERIFIED");
    assert.equal(result.productionReady, false);
    assert.ok(result.unproved.includes("native_attack_count_and_timing"));
    assert.ok(
      result.unproved.includes("actual_max_buffer_identity_and_execution"),
    );
  }
});

test("numeric mutations detect wrong gain, RMS, alias frequency, cancellation and silent leakage", async (t) => {
  const { dir, report } = await setup(t, "anti-phase-quarter-sine");
  for (const mutate of [
    (r) => {
      r.descriptors[1].peak[0] *= 0.5;
    },
    (r) => {
      r.descriptors[1].rms[1] *= 0.7;
    },
    (r) => {
      r.descriptors[1].centroidHz = 880;
    },
    (r) => {
      r.descriptors[1].centroidHz = 220;
    },
    // Spectrum-only downmix cancellation must fail with intact stereo meters.
    (r) => {
      for (const p of r.descriptors) {
        p.centroidHz = null;
        p.spectralEnergy = 0;
      }
    },
    (r) => {
      for (const p of r.descriptors) {
        p.peak = [0, 0];
        p.rms = [0, 0];
        p.centroidHz = null;
        p.spectralEnergy = 0;
      }
    },
    (r) => {
      r.descriptors[3].peak[1] = 0.01;
      r.descriptors[3].rms[1] = 0.001;
    },
  ]) {
    const r = structuredClone(report);
    mutate(r);
    assert.equal(
      (await verifyCalibrationReport(r, { artifactDirectory: dir })).passed,
      false,
    );
  }
});

test("missing/wrong fixture, partial/reset/marker/gap evidence and false readiness are denied", async (t) => {
  const { dir, report } = await setup(t);
  for (const mutate of [
    (r) => {
      r.fixture.sha256 = "0".repeat(64);
    },
    (r) => {
      r.fixture.id = "anti-phase-quarter-sine";
    },
    (r) => {
      r.dsp.sampleRate = 44100;
    },
    (r) => {
      r.outcome = "failed";
    },
    (r) => {
      r.markers.stop = null;
    },
    (r) => {
      r.markers.stop.resetEpoch = 19;
    },
    (r) => {
      r.descriptors.pop();
    },
    (r) => {
      r.descriptors[0].referenceSample++;
    },
    (r) => {
      r.descriptors[0].marker.vectorOffset++;
    },
    (r) => {
      r.descriptors[0].sourceActive = false;
    },
    (r) => {
      r.productionReady = true;
    },
    (r) => {
      r.certificate = "approved";
    },
    (r) => {
      r.descriptors[0].peak[0] = Infinity;
    },
    (r) => {
      r.descriptors = Array(129).fill(r.descriptors[0]);
    },
    (r) => {
      r.waveform = [1, 2, 3];
    },
    (r) => {
      r.resources["audio_listener_analysis.maxpat"] = "0".repeat(64);
    },
  ]) {
    const r = structuredClone(report);
    mutate(r);
    assert.equal(
      (await verifyCalibrationReport(r, { artifactDirectory: dir })).passed,
      false,
    );
  }
  assert.equal((await verifyCalibrationReport(report)).passed, false);
});

test("bounded offline CLI passes synthetic data, fails malformed/oversized data and never claims certification", async (t) => {
  const { dir, report } = await setup(t);
  const file = join(dir, "native-commissioning-report.json");
  await writeFile(file, JSON.stringify(report));
  const run = () =>
    spawnSync(
      process.execPath,
      ["scripts/audio-listener-device.mjs", "verify-calibration-report", file],
      { encoding: "utf8" },
    );
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).productionReady, false);
  assert.equal(JSON.parse(good.stdout).passed, true);
  const archive = await mkdtemp(join(tmpdir(), "commission-report-archive-"));
  t.after(() => rm(archive, { recursive: true, force: true }));
  const copy = join(archive, "quarter-sine.json");
  await writeFile(copy, JSON.stringify(report));
  const archived = spawnSync(
    process.execPath,
    [
      "scripts/audio-listener-device.mjs",
      "verify-calibration-report",
      copy,
      "--artifact",
      dir,
    ],
    { encoding: "utf8" },
  );
  assert.equal(archived.status, 0, archived.stderr);
  assert.equal((await verifyCalibrationReportFile(dir)).passed, false);
  const link = join(archive, "linked-report.json");
  await symlink(copy, link);
  assert.equal(
    (await verifyCalibrationReportFile(link, { artifactDirectory: dir }))
      .passed,
    false,
  );
  await writeFile(file, "{");
  assert.equal(run().status, 1);
  await writeFile(file, " ".repeat(65537));
  const bad = await verifyCalibrationReportFile(file);
  assert.equal(bad.passed, false);
  assert.ok(bad.failures.includes("report_file_size_or_type"));
  assert.equal((await readFile(file)).length, 65537); // Verifier is read-only.
});
