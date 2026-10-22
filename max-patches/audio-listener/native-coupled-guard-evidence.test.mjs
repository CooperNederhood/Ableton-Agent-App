import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

async function readEvidence() {
  return JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-coupled-guard-observation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

test("recorded corrected native envelope advances and admits valid comparisons while remaining disarmed", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-corrected-envelope-observation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const baseline = await readEvidence();
  assert.equal(evidence.baselineRunId, baseline.runId);
  const documents = nativeRuntimeDocuments({ nativeVersion: 2 });
  for (const name of ["clock", "envelope"]) {
    const document =
      name === "envelope"
        ? JSON.parse(
            await readFile(
              new URL(
                "./fixtures/native-v2-envelope-wide-finite-bd4eb41.gendsp",
                import.meta.url,
              ),
              "utf8",
            ),
          )
        : documents[`audio_listener_native_${name}.gendsp`];
    const code = document.patcher.boxes.find(({ box }) => box.id === "code").box
      .code;
    assert.equal(
      createHash("sha256").update(code).digest("hex"),
      evidence.pins[`${name}CodeSha256`],
    );
    assert.equal(
      createHash("sha256")
        .update(`${JSON.stringify(document, null, 2)}\n`)
        .digest("hex"),
      evidence.pins[`${name}GenSha256`],
    );
  }
  assert.equal(evidence.pins.spectrumCodeSha256, baseline.spectrum.codeSha256);
  assert.deepEqual(evidence.dsp, baseline.dsp);
  assert.equal(evidence.envelope.same26FieldMapAsBaseline, true);
  assert.equal(evidence.envelope.originalOutputs1Through23Preserved, true);
  assert.equal(
    evidence.envelope.originalConfigurationControlsAndStoppedAckPreserved,
    true,
  );
  assert.equal(evidence.envelope.notVectorAtomic, true);
  assert.equal(evidence.envelope.forwardedToSdk, false);
  assert.equal(evidence.envelope.scope, "native-envelope-guard-probe/v2");
  assert.equal(evidence.envelope.packetCount, 88);
  const samples = [evidence.envelope.first, evidence.envelope.last].map(
    (values) => {
      assert.equal(values.length, baseline.envelope.fields.length);
      assert(values.every(Number.isFinite));
      return Object.fromEntries(
        baseline.envelope.fields.map((name, index) => [name, values[index]]),
      );
    },
  );
  for (const sample of samples) {
    assert.equal(sample.actualGenSampleRate, 48000);
    assert.equal(sample.liveEpoch, 0);
    assert.equal(sample.liveEpochBound, 1);
    assert.equal(sample.liveEpochFullGate, 0);
    assert.equal(sample.isolatedProbeEpoch, 1);
    assert.equal(sample.probeEpochBound, 1);
    assert.equal(sample.probeEpochFullGate, 1);
    assert.equal(sample.actualCounterValid, 1);
    assert.equal(sample.headroomReject, 0);
    assert(sample.clockOnEntry > 1048576);
    assert(sample.actualInputCounter > 1048576);
    assert.equal(sample.computedCappedNextClock, sample.clockBeforeUpdate + 1);
    assert.equal(sample.evaluatedWideLiteral, 0);
    assert.equal(sample.actualConfigValid, 0);
    assert.equal(sample.wasRunningOnEntry, 0);
    assert.equal(sample.newLiveRequest, 0);
    assert.equal(sample.sealedEpochAfter, 0);
    assert.equal(sample.armCounterAfter, -1);
  }
  assert(samples[1].clockOnEntry > samples[0].clockOnEntry);
  assert(samples[1].actualInputCounter > samples[0].actualInputCounter);
  assert.notEqual(samples[0].clockOnEntry, samples[0].clockBeforeUpdate);
  assert.equal(evidence.clock.packetCount, 83);
  for (const values of [evidence.clock.first, evidence.clock.last]) {
    assert.equal(values[4], values[2]);
    assert.equal(values[4], values[6]);
    assert.equal(values[4], values[9]);
  }
  assert(evidence.clock.last[4] > evidence.clock.first[4]);
  assert.equal(evidence.spectrum.packetCount, 88);
  for (const values of [evidence.spectrum.first, evidence.spectrum.last]) {
    assert.equal(values[0], values[4]);
    assert.equal(values[0] - values[3], 2048);
    assert.deepEqual([values[1], values[2], values[5]], [0, 0, 0]);
  }
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.captureOrContextAuthorized, false);
  assert.equal(evidence.instrumentation.measurementPacketsAdmitted, 0);
  assert.equal(evidence.instrumentation.nativeArmControlsForwarded, 0);
  assert.equal(evidence.instrumentation.forwardedStopAcks, 1);
  assert.equal(
    evidence.instrumentation.privateHandlerRegisteredBeforeBegin,
    true,
  );
  assert.equal(evidence.instrumentation.privateHandlerRemoved, true);
  assert.deepEqual(evidence.cleanup, {
    processStopped: true,
    fixtureCleaned: true,
    sourcePinsUnchanged: true,
    errors: [],
  });
});

test("actual current full-range FFT publishes native silence without capture authority", async () => {
  const evidence = await readEvidence();
  const document = nativeRuntimeDocuments({ nativeVersion: 2 })[
    "audio_listener_native_spectrum.gendsp"
  ];
  const code = document.patcher.boxes.find(({ box }) => box.id === "code").box
    .code;
  assert.equal(
    createHash("sha256").update(code).digest("hex"),
    evidence.spectrum.codeSha256,
  );
  assert.equal(
    createHash("sha256")
      .update(`${JSON.stringify(document, null, 2)}\n`)
      .digest("hex"),
    evidence.spectrum.genSha256,
  );
  assert.equal(evidence.spectrum.currentProductionSourceObserved, true);
  assert.equal(evidence.spectrum.inclusiveFiniteBound, 1000000000000);
  assert.equal(evidence.spectrum.stricterSubsetControl, false);
  assert.equal(evidence.spectrum.savedCandidateModified, false);
  assert.deepEqual(evidence.dsp, [1, 48000, 64]);
  assert.equal(evidence.spectrum.abi, 2);
  assert.equal(evidence.spectrum.packetCount, 85);
  for (const values of [evidence.spectrum.first, evidence.spectrum.last]) {
    assert.equal(values.length, 6);
    assert(values.every(Number.isFinite));
    assert(values[0] > 0);
    assert.equal(values[0], values[4]);
    assert.equal(values[0] - values[3], 2048);
    assert.deepEqual([values[1], values[2], values[5]], [0, 0, 0]);
  }
  assert(evidence.spectrum.last[0] > evidence.spectrum.first[0]);
  assert.deepEqual(evidence.spectrum.diagnosticsFirst, [-1, -1, -1, -1, 0]);
  assert.deepEqual(
    evidence.spectrum.diagnosticsLast,
    evidence.spectrum.diagnosticsFirst,
  );
  assert.equal(evidence.acceptancePassed, false);
  assert.equal(evidence.captureOrContextAuthorized, false);
  assert.equal(evidence.instrumentation.measurementPacketsAdmitted, 0);
  assert.equal(evidence.instrumentation.nativeArmControlsForwarded, 0);
  assert.equal(evidence.instrumentation.forwardedStopAcks, 1);
  assert(
    evidence.instrumentation.failureAfterBeginMs <=
      evidence.instrumentation.maximumDelayMs,
  );
  assert.deepEqual(evidence.cleanup, {
    processStopped: true,
    fixtureCleaned: true,
    sourcePinsUnchanged: true,
    errors: [],
  });
});

test("actual disarmed envelope exposes failed epoch/counter bounds and frozen local clock", async () => {
  const { envelope, instrumentation } = await readEvidence();
  assert.equal(envelope.scope, "native-envelope-guard-probe/v1");
  assert.equal(envelope.originalOutputs1Through23AndAbi16Preserved, true);
  assert.equal(
    envelope.originalControlsConfigurationAndStoppedAckRoutingPreserved,
    true,
  );
  assert.equal(envelope.notVectorAtomic, true);
  assert.equal(envelope.forwardedToSdk, false);
  assert.equal(envelope.packetCount, 86);
  assert.equal(envelope.fields.length, 26);
  const samples = [envelope.first, envelope.last].map((values) => {
    assert.equal(values.length, envelope.fields.length);
    assert(values.every(Number.isFinite));
    return Object.fromEntries(
      envelope.fields.map((name, index) => [name, values[index]]),
    );
  });
  for (const sample of samples) {
    assert.equal(sample.actualGenSampleRate, 48000);
    assert.equal(sample.liveEpoch, 0);
    assert.equal(sample.isolatedProbeEpoch, 1);
    assert.equal(sample.probeEpochBound, 0);
    assert.equal(sample.probeEpochFullGate, 0);
    assert(sample.actualInputCounter > 0);
    assert(sample.actualInputCounter < 17592186044416);
    assert.equal(sample.actualCounterValid, 0);
    assert(sample.actualProjectedEnd < 17592186044416);
    assert.equal(sample.headroomReject, 1);
    assert.equal(sample.clockOnEntry, 0);
    assert.equal(sample.clockBeforeUpdate, 0);
    assert.equal(sample.computedCappedNextClock, 0);
    assert.equal(sample.evaluatedWideLiteral, 0);
    assert.equal(sample.newLiveRequest, 0);
    assert.equal(sample.wasRunningOnEntry, 0);
    assert.equal(sample.sealedEpochAfter, 0);
    assert.equal(sample.armCounterAfter, -1);
  }
  assert(samples[1].actualInputCounter > samples[0].actualInputCounter);
  assert.equal(instrumentation.privateHandlerRegisteredBeforeBegin, true);
  assert.equal(instrumentation.privateHandlerRemoved, true);
  assert.equal(instrumentation.foreignMessages, 0);
  assert.equal(instrumentation.malformedMessages, 0);
});
