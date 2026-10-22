import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

test("actual stricter finite-bound control publishes native silence frames without capture authority", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-finite-bound-control.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const baseline = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-fft-guard-observation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(evidence.baselineRunId, baseline.runId);
  assert.equal(
    evidence.pins.baselineProbeDocumentSha256,
    baseline.pins.probeSpectrumGenSha256,
  );
  assert(evidence.controlBound < evidence.originalBound);
  assert.equal(evidence.strictSubset, true);
  assert.equal(evidence.mainComparisonsChanged, 4);
  assert.equal(evidence.passiveComparisonsChanged, 8);
  assert.equal(evidence.totalComparisonsChanged, 12);
  assert.deepEqual(evidence.observed.diagnosticFirst, [48000, 0, 0, -1, 0]);
  assert.deepEqual(
    evidence.observed.diagnosticLast,
    evidence.observed.diagnosticFirst,
  );
  for (const packet of [
    evidence.observed.spectrumFirst,
    evidence.observed.spectrumLast,
  ]) {
    assert(packet[0] > 0);
    assert.equal(packet[0], packet[4]);
    assert.equal(packet[0] - packet[3], 2048);
    assert.equal(packet[1], 0);
    assert.equal(packet[2], 0);
    assert.equal(packet[5], 0);
  }
  assert(
    evidence.observed.spectrumLast[0] > evidence.observed.spectrumFirst[0],
  );
  assert.equal(evidence.productionCorrection, false);
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.instrumentation.measurementPacketsAdmitted, 0);
  assert.equal(evidence.instrumentation.nativeArmControlsForwarded, 0);
  assert.deepEqual(evidence.cleanup, {
    processStopped: true,
    fixtureCleaned: true,
    sourcePinsUnchanged: true,
    errors: [],
  });
});

test("actual passive FFT probe identifies finite-comparison failure, not unsupported local rate", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-fft-guard-observation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(evidence.scope, "native-spectrum-guard-probe/v1");
  assert.equal(evidence.productionDiagnosticShape, false);
  assert.equal(evidence.forwardedToSdk, false);
  assert.equal(evidence.usedAsNativeFailureDiagnostic, false);
  assert.deepEqual(evidence.observed.first, [48000, 4, 15, 0, 0]);
  assert.deepEqual(evidence.observed.last, evidence.observed.first);
  assert.equal(evidence.observed.last[1], evidence.faultBits.finite);
  assert.equal(
    evidence.observed.last[2],
    Object.values(evidence.componentBits).reduce((sum, bit) => sum + bit, 0),
  );
  assert.equal(evidence.observed.diagnosticPacketCount, 87);
  assert(evidence.observed.clockLast[4] > evidence.observed.clockFirst[4]);
  assert.equal(evidence.observed.spectrumFirst[0], -1);
  assert.equal(evidence.observed.spectrumLast[0], -1);
  assert.equal(evidence.preservation.guardsAndMathUnchanged, true);
  assert.equal(evidence.preservation.mainOutputsAndAbiUnchanged, true);
  assert.equal(evidence.instrumentation.measurementPacketsAdmitted, 0);
  assert.equal(evidence.instrumentation.nativeArmControlsForwarded, 0);
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.captureOrContextAuthorized, false);
  assert.deepEqual(evidence.cleanup, {
    processStopped: true,
    fixtureCleaned: true,
    sourcePinsUnchanged: true,
    errors: [],
  });
});
