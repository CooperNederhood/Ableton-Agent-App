import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

test("actual fail-only v2 probe distinguishes received zero counters from missing clock messages", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL("./fixtures/native-v2-counter-observation.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(evidence.sourceOverrides, []);
  assert.deepEqual(evidence.metadata.dsp, [1, 48000, 64]);
  assert.equal(evidence.metadata.clockAbi, 2);
  assert.equal(evidence.clock.count, 83);
  assert.equal(evidence.clock.snapshots.length, 8);
  let previousHost = -1;
  for (const { values } of evidence.clock.snapshots) {
    assert.equal(values.length, 11);
    assert(values.every(Number.isFinite));
    assert(values[2] > previousHost);
    assert.equal(values[9], values[2]);
    assert.equal(values[4], 0);
    assert.equal(values[6], 0);
    assert.equal(values[0], 0);
    assert.equal(values[1], 0.25);
    previousHost = values[2];
  }
  assert.deepEqual(evidence.spectrum.first, [-1, 0, 0, -1, -1, 790]);
  assert.deepEqual(evidence.spectrum.last, [-1, 0, 0, -1, -1, 810]);
  assert.deepEqual(evidence.spectrum.lastDiagnostics, [0, 1, 0, 1, 255]);
  assert.equal(evidence.instrumentation.measurementPacketsAdmitted, 0);
  assert.equal(evidence.instrumentation.nativeArmControlsForwarded, 0);
  assert.equal(evidence.instrumentation.forwardedStopAcks, 1);
  assert(
    evidence.instrumentation.failureAfterBeginMs <=
      evidence.instrumentation.maximumDelayMs,
  );
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.captureOrContextAuthorized, false);
  assert.deepEqual(evidence.outcome.contextIds, []);
  for (const key of [
    "copiedResourcesUnchanged",
    "originalPinsUnchanged",
    "processStopped",
    "fixtureCleaned",
  ])
    assert.equal(evidence.outcome[key], true);
});
