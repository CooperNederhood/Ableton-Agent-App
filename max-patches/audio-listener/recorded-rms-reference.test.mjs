/* global URL, structuredClone */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";
import { CLOCK_ANCHORED_ENVELOPE_CODE } from "./synchronized-envelope-source.mjs";

const require = createRequire(import.meta.url);
const { nativeHostBinding } = require("./audio_listener_native_coordinates.js");
const evidence = JSON.parse(
  await readFile(
    new URL("./fixtures/native-rms-reference.json", import.meta.url),
  ),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");

function checkRows(rows) {
  assert.equal(rows.length, 100);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.length, 9);
    assert.equal(row[4], (index + 1) * 4800);
    for (let channel = 0; channel < 2; channel++) {
      assert.ok(
        Number.isFinite(row[2 + channel]) && Number.isFinite(row[7 + channel]),
      );
      assert.ok(
        Math.abs(row[2 + channel] ** 2 - row[7 + channel] ** 2) <= 1e-12,
      );
    }
  }
}

test("actual native RMS matches independent delayed MSP input averaging across all 100 windows without fitting", () => {
  assert.equal(evidence.productionReady, false);
  assert.equal(evidence.nativeTiming, "UNVERIFIED");
  assert.equal(evidence.criterion.maximum, 1e-12);
  assert.equal(evidence.criterion.fittedShift, false);
  assert.equal(evidence.codeSha256.envelope, sha(CLOCK_ANCHORED_ENVELOPE_CODE));
  assert.deepEqual(evidence.capture.reference, {
    object: "average~",
    mode: "rms",
    intervalSamples: 4800,
    integerDelaySamples: 64,
    hold: "native_window_completion",
    comparison: "squared_amplitude_absolute_error",
    tolerance: 1e-12,
  });
  checkRows(evidence.capture.frames);
  const maxima = [0, 0];
  for (const row of evidence.capture.frames)
    for (let channel = 0; channel < 2; channel++)
      maxima[channel] = Math.max(
        maxima[channel],
        Math.abs(row[2 + channel] ** 2 - row[7 + channel] ** 2),
      );
  assert.deepEqual(maxima, evidence.comparison.maximumSquaredError);
  assert.deepEqual(
    evidence.capture.frames[0].slice(2, 4),
    evidence.capture.frames[0].slice(7, 9),
  );
  assert.ok(evidence.capture.frames.some((row) => row[2] > 0));
  assert.ok(
    evidence.capture.frames.some((row) => row[2] === 0 && row[7] === 0),
  );
});

test("bare WAV disagreement is retained as upstream input evidence, not repaired with a gain or time offset", () => {
  const wav = createKnownListeningFixture("quarter-sine").wav;
  assert.equal(sha(wav), evidence.source.sha256);
  assert.equal(evidence.source.offsetSamples, 0);
  assert.equal(evidence.source.warping, false);
  assert.equal(evidence.source.normalizedGain, 0.4);
  assert.equal(evidence.source.displayedGain, "0.00 dB");
  const pcm = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let sum = 0;
  for (let frame = 0; frame < 4800; frame++)
    sum += (pcm.getInt16(44 + frame * 4, true) / 32768) ** 2;
  const rawRms = Math.sqrt(sum / 4800);
  assert.equal(rawRms, evidence.comparison.firstRawFileRms[0]);
  assert.ok(Math.abs(rawRms - evidence.capture.frames[0][2]) > 1e-4);
  assert.equal(
    evidence.capture.nativeMarker[7] - evidence.capture.originClock,
    1,
  );
  assert.equal(
    evidence.capture.nativeMarker[2] - evidence.capture.originClock,
    72001,
  );
});

test("independent before/after host brackets bind the actual native origin and preserve causal lifecycle", () => {
  const before = nativeHostBinding(evidence.before, false);
  const after = nativeHostBinding(evidence.after, true);
  assert.equal(before.hostOffsetSamples, 1407845460);
  assert.equal(after.hostOffsetSamples, before.hostOffsetSamples);
  assert.equal(
    evidence.nativeOrigin[1] + evidence.capture.originClock,
    evidence.nativeOrigin[2],
  );
  assert.equal(
    evidence.nativeOrigin[2] + before.hostOffsetSamples,
    after.hostBeatZeroSample,
  );
  assert.equal(after.hostBeatZeroSample, 1428465748);
  for (const report of [evidence.before, evidence.capture, evidence.after]) {
    assert.equal(report.outcome, "collected");
    assert.equal(report.productionReady, false);
    assert.deepEqual(
      report.events.slice(0, 2).map((event) => event.stage),
      ["queued", "started"],
    );
    assert.equal(report.events.at(-1).stage, "completed");
    for (const [index, event] of report.events.entries()) {
      assert.equal(event.traceId, report.traceId);
      assert.equal(event.correlationId, report.traceId);
      assert.equal(
        event.causationId,
        index ? report.events[index - 1].eventId : report.traceId,
      );
      if (index)
        assert.ok(event.elapsedMs >= report.events[index - 1].elapsedMs);
    }
  }
  assert.deepEqual(evidence.cleanup, {
    ownedObjectsRemoved: 6,
    boxes: 130,
    cables: 150,
    exactGraphRestored: true,
    sourceMarkersUnchanged: true,
    arrangementClipPlaying: false,
    masterValue: 0.85,
    masterModified: false,
    songPlaying: true,
    existingProcessesPreserved: true,
  });
});

test("changed reference pairing or native values cannot silently pass the measured criterion", () => {
  for (const kind of ["reference", "native", "gap", "missing"]) {
    const rows = structuredClone(evidence.capture.frames);
    if (kind === "reference") rows[0][7] = rows[1][7];
    if (kind === "native") rows[0][2] += 0.001;
    if (kind === "gap") rows[0][4]++;
    if (kind === "missing") rows.pop();
    assert.throws(() => checkRows(rows));
  }
});
