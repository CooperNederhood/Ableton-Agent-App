/* global URL, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";
import { fftReference } from "./fft-reference.mjs";
import { taggedSpectrumGenDocument } from "./synchronized-spectrum-source.mjs";
import { clockAnchoredEnvelopeDocument } from "./synchronized-envelope-source.mjs";

const bytes = await readFile(
  new URL("./fixtures/native-host-spectrum.json", import.meta.url),
);
const evidence = JSON.parse(bytes);
const wav = createKnownListeningFixture("quarter-sine").wav;
const pcm = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
const sha = (value) => createHash("sha256").update(value).digest("hex");

function lifecycle(report, count) {
  assert.equal(report.outcome, "collected");
  assert.equal(report.productionReady, false);
  assert.equal(report.nativeTiming, "UNVERIFIED");
  assert.equal(report.frameCount, count);
  assert.equal(report.frames.length, count);
  assert.deepEqual(
    report.events.slice(0, 2).map((event) => event.stage),
    ["queued", "started"],
  );
  assert.equal(report.events.at(-1).stage, "completed");
  let elapsed = 0;
  for (let i = 0; i < report.events.length; i++) {
    const event = report.events[i];
    assert.equal(event.traceId, report.traceId);
    assert.equal(event.correlationId, report.traceId);
    assert.equal(
      event.causationId,
      i ? report.events[i - 1].eventId : report.traceId,
    );
    assert(event.elapsedMs >= elapsed);
    elapsed = event.elapsedMs;
  }
  assert(elapsed > 0 && elapsed < (count === 100 ? 12000 : 5000));
}

function binding(report, playing) {
  lifecycle(report, 32);
  assert.deepEqual(report.dsp, [1, 48000, 64]);
  let previous = -1;
  for (const row of report.frames) {
    assert.equal(row[0], playing ? 1 : 0);
    assert.deepEqual(row.slice(0, 4), row.slice(7));
    assert.equal(row[3] & 19, 19);
    assert.equal(row[4], row[6]);
    assert(row[4] > previous);
    previous = row[4];
    assert.equal(row[2] - row[4], report.clockOffsetSamples);
    if (playing) {
      assert.equal(
        row[2] - Math.round(row[1] * 24000),
        report.hostBeatZeroSample,
      );
      assert.equal(
        (((Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) % 24000) +
          24000) %
          24000,
        0,
      );
    }
  }
  assert.equal(report.phaseLagSamples, playing ? 0 : null);
  if (!playing) assert.equal(report.hostBeatZeroSample, null);
}

function verify(data, gateBeforeLaunch = true) {
  binding(data.before, false);
  binding(data.after, true);
  assert.equal(data.before.clockOffsetSamples, data.after.clockOffsetSamples);
  const [epoch, arm, origin] = data.nativeOrigin;
  assert.equal(epoch, data.envelope.nativeEpoch);
  assert.equal(origin - arm, data.envelope.originClock);
  assert.equal(
    origin + data.after.clockOffsetSamples,
    data.after.hostBeatZeroSample,
    "independent host beat-zero origin",
  );
  const marker = data.envelope.nativeMarker;
  assert.equal(marker[0], epoch);
  assert.equal(marker[1] - marker[6], origin - arm);
  assert.equal(marker[7] - data.envelope.originClock, 11953);
  assert.equal(marker[2] - data.envelope.originClock, 59953);
  assert.equal(marker[3], 3);
  assert.equal(marker[4], 0);
  assert.deepEqual(data.fftInformation, [2048, 2048, 2048, 1]);

  const read = (relative, channel) => {
    const index = relative + data.source.offsetSamples;
    return (gateBeforeLaunch && relative < 0) ||
      index < 0 ||
      index >= data.source.sampleCount
      ? 0
      : pcm.getInt16(44 + index * 4 + channel * 2, true) / 32768;
  };
  lifecycle(data.envelope, 100);
  for (const [window, row] of data.envelope.frames.entries()) {
    assert.equal(row[4], (window + 1) * 4800);
    for (let channel = 0; channel < 2; channel++) {
      let peak = 0,
        sum = 0;
      for (let i = window * 4800; i < (window + 1) * 4800; i++) {
        const value = read(i, channel);
        peak = Math.max(peak, Math.abs(value));
        sum += value * value;
      }
      assert(Math.abs(row[channel] - peak) <= 1e-12, "envelope peak");
      assert(
        Math.abs(row[channel + 2] - Math.sqrt(sum / 4800)) <= 1e-12,
        "envelope RMS",
      );
    }
    assert.deepEqual(row.slice(5), [0, 0]);
  }

  lifecycle(data.spectrum, 64);
  assert.equal(data.spectrum.traceId, data.envelope.traceId);
  let nonzero = 0,
    previous = null;
  for (const row of data.spectrum.frames) {
    assert.equal(row[0], row[4]);
    assert.equal(row[4] - row[3], 2048);
    assert.equal(row[5], data.spectrum.initialInvalidFrames);
    if (previous !== null) assert.equal(row[3], previous);
    previous = row[4];
    const spectra = [0, 1].map((channel) =>
      fftReference(
        Array.from({ length: 2048 }, (_, i) =>
          read(row[3] - origin + i, channel),
        ),
      ),
    );
    let energy = 0,
      weighted = 0;
    for (let bin = 0; bin <= 1024; bin++) {
      const binEnergy = spectra.reduce(
        (sum, spectrum) =>
          sum + spectrum.real[bin] ** 2 + spectrum.imag[bin] ** 2,
        0,
      );
      energy += binEnergy;
      weighted += (binEnergy * bin * 48000) / 2048;
    }
    if (energy === 0) {
      assert.equal(row[1], 0, "silent FFT centroid");
      assert.equal(row[2], 0, "silent FFT energy");
    } else {
      nonzero++;
      assert(
        Math.abs(row[2] - energy) <= energy * 1e-12,
        "exact-window stereo FFT energy",
      );
      assert(
        Math.abs(row[1] - weighted / energy) <= 1e-9,
        "exact-window FFT centroid",
      );
    }
  }
  assert.equal(nonzero, 20);
}

test("recorded host-bound native FFT/envelope evidence is bounded and source/code bound, not production certification", () => {
  assert(bytes.length <= 65536);
  assert.equal(evidence.calibrationOnly, true);
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.nativeTiming, "UNVERIFIED");
  assert.equal(sha(wav), evidence.source.sha256);
  assert.equal(
    sha(taggedSpectrumGenDocument().patcher.boxes[0].box.code),
    evidence.codeSha256.spectrum,
  );
  assert.equal(
    sha(clockAnchoredEnvelopeDocument().patcher.boxes[0].box.code),
    evidence.codeSha256.envelope,
  );
  const ids = [
    evidence.before,
    evidence.envelope,
    evidence.spectrum,
    evidence.after,
  ].flatMap((report) => report.events.map((event) => event.eventId));
  assert.equal(new Set(ids).size, ids.length);
  verify(evidence);
});

test("independent recorded evidence rejects one-sample coordinates, wrong host binding and missing stereo participation", () => {
  for (const mutation of [
    "origin",
    "host",
    "fft-clock",
    "mono-energy",
    "gap",
  ]) {
    const changed = structuredClone(evidence);
    if (mutation === "origin") changed.nativeOrigin[2]++;
    if (mutation === "host") changed.after.clockOffsetSamples++;
    if (mutation === "fft-clock")
      for (const row of changed.spectrum.frames) {
        row[0]++;
        row[3]++;
        row[4]++;
      }
    if (mutation === "mono-energy")
      for (const row of changed.spectrum.frames) row[2] /= 2;
    if (mutation === "gap") changed.spectrum.frames.splice(10, 1);
    assert.throws(() => verify(changed), undefined, mutation);
  }
  assert.throws(() => verify(evidence, false), /FFT energy/);
});
