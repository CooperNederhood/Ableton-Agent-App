import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  nativeCaptureProofSchema,
  assertNativeCaptureObservation,
} from "../../packages/protocol/src/native-listening-schemas.ts";
const { audioObservationSchema } =
  await import("../../packages/protocol/src/audio-observation-schemas.ts");

const require = createRequire(import.meta.url);
const evidence = require("./fixtures/native-acquisition-recovery.json");
const clock = require("./fixtures/native-clock-phase-mismatch.json");
const spectrum = require("./fixtures/native-spectrum-torn-read.json");

test("actual diagnostic recovery retained full independently valid native proof and durable typed context", () => {
  const proof = nativeCaptureProofSchema.parse(evidence.nativeCapture);
  const observation = audioObservationSchema.parse(evidence.observation);
  assertNativeCaptureObservation(proof, observation);
  assert.equal(observation.complete, true);
  assert.equal(observation.samples.length, 20);
  assert.equal(observation.endSample - observation.startSample, 96000);
  assert.equal(proof.armed.before.frames.length, 32);
  assert.equal(proof.after.frames.length, 32);
  assert.equal(observation.attacks.length, 4);
  assert.equal(evidence.evidence.spectralWindows, 20);
  assert.deepEqual(evidence.typedContext.observation, observation);
  assert.equal(evidence.typedReopenInNewProcessMatches, true);
});

test("both measured acquisition cohorts really recovered with causal persisted progress before completion", () => {
  const rejected = evidence.lifecycle.filter((event) =>
    ["torn_native_spectrum", "phase_torn_native_clock"].includes(
      event.attributes.reason,
    ),
  );
  assert.equal(rejected.length, 2);
  assert.deepEqual(
    rejected.map((event) => [event.attributes.reason, event.attributes.frames]),
    [
      ["torn_native_spectrum", 9],
      ["phase_torn_native_clock", 18],
    ],
  );
  assert.equal(
    rejected[1].attributes.causationId,
    rejected[0].attributes.eventId,
  );
  const completed = evidence.lifecycle.find(
    (event) => event.name === "output.listener.native.completed",
  );
  assert.equal(typeof completed.attributes.generation, "string");
  for (const event of rejected) {
    assert.equal(event.attributes.passId, evidence.observation.passId);
    assert.equal(event.attributes.generation, completed.attributes.generation);
    assert.equal(
      event.attributes.nativeEpoch,
      evidence.nativeCapture.armed.nativeEpoch,
    );
    assert.equal(event.attributes.stage, "progress");
    assert.equal(event.attributes.phase, "capture");
  }
  assert.ok(completed.sequence > rejected[1].sequence);
  assert.ok(completed.attributes.elapsedMs >= rejected[1].attributes.elapsedMs);
});

test("instrumented numeric failures distinguish an unaccepted clock offset from torn FFT tags", () => {
  const { row, previous } = clock.clock;
  assert.deepEqual(row.slice(0, 4), row.slice(7));
  assert.equal(row[4], row[6]);
  assert.equal(row[2] - row[4], 64);
  assert.equal(previous[2] - previous[4], 0);
  assert.equal(row[4] - previous[4], 896);
  assert.equal(row[2] - previous[2], 960);
  assert.equal(
    (Math.round(row[1] * 24000) - Math.round(row[5] * 24000)) % 24000,
    64,
  );
  assert.equal(clock.terminal.stage, "failed");
  const fft = spectrum.spectrum;
  assert.equal(fft.row[0], fft.previous[0]);
  assert.equal(fft.row[3], fft.previous[0]);
  assert.equal(fft.row[4], fft.previous[0] + 2048);
  assert.notEqual(fft.row[0], fft.row[4]);
  assert.equal(spectrum.terminal.stage, "failed");
});

test("exact current bytes completed an instrumented capture without granting standard-runner or production qualification", () => {
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.productionReady, false);
  const qualified = evidence.currentSourceQualification;
  assert.equal(qualified.completeActualCapture, true);
  assert.equal(qualified.instrumentedDiagnosticOnly, true);
  assert.equal(qualified.standardRunnerAccepted, false);
  const proof = nativeCaptureProofSchema.parse(qualified.nativeCapture);
  const observation = audioObservationSchema.parse(qualified.observation);
  assertNativeCaptureObservation(proof, observation);
  assert.equal(observation.samples.length, 20);
  assert.equal(observation.endSample - observation.startSample, 96000);
  assert.deepEqual(qualified.typedContext.observation, observation);
  assert.equal(qualified.typedReadInNewProcessMatches, true);
  assert.deepEqual(
    qualified.recoveryEvents.map((event) => [
      event.attributes.reason,
      event.attributes.frames,
    ]),
    [
      ["torn_native_spectrum", 13],
      ["phase_torn_native_clock", 15],
    ],
  );
  assert.match(
    qualified.earlierFailedDiagnosticError,
    /native_clock_discontinuity/,
  );
  assert.equal(evidence.sourceOverridesAtCapture.length, 2);
  for (const captured of evidence.sourceOverridesAtCapture) {
    const current = evidence.currentSourceSnapshot[captured.name];
    assert.equal(current.baselineSha256, captured.previousSha256);
    assert.notEqual(current.sha256, captured.sha256);
  }
  assert.equal(clock.instrumentation.acceptanceEvidence, false);
  assert.equal(spectrum.acceptanceEvidence, false);
  assert.equal(evidence.typedContext.entry.freshness, "unknown");
  assert.equal(evidence.evidence.attribution, "unknown");
});
