/* global Buffer, structuredClone */
import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
const { assertNativeCaptureObservationV2, nativeArmProofV2Schema } =
  await import("../../packages/protocol/src/native-listening-v2-schemas.ts");
const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const {
  NativeCaptureController,
} = require("./audio_listener_native_controller.js");
const {
  nativeV2Configuration,
} = require("./audio_listener_native_coordinates.js");
const { nativeFailureDiagnosticV2Schema } =
  await import("../../packages/signal-routing/src/listener-v2-contracts.ts");
const TEMPO_LIMITATION =
  "Constant tempo is assumed; stability is not independently verified; tempo automation is unsupported.";

test("recorded low-priority spectrum frame loss remains a hard failure inside requested coverage", async () => {
  const recorded = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-scheduler-spectrum-gap.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(recorded.packet[0] - recorded.previousPacket[0], 12288);
  assert.equal(
    (recorded.packet[0] - recorded.previousPacket[0]) / 2048 - 1,
    recorded.missingFrameCount,
  );
  assert(recorded.packet[0] < recorded.requestedEndCounter);
  assert.equal(recorded.packet[5], 0);
  const f = v2Fixture();
  await f.start();
  const p = f.controller.pass;
  p.spectrum = [...recorded.previousPacket];
  f.packet("spectrum", recorded.packet);
  assert.equal(f.controller.state, "failed");
  assert.equal(p.nativeFailureDiagnostic.check, "sequence");
  assert.deepEqual(
    p.nativeFailureDiagnostic.previousPacket,
    recorded.previousPacket,
  );
  assert.deepEqual(p.nativeFailureDiagnostic.packet, recorded.packet);
  assert(
    f.events.some(
      (event) =>
        event.type === "terminal" &&
        event.status === "failed" &&
        event.reason === recorded.failureReason,
    ),
  );
  f.packet("stopped", [0, 0, 2], p.generation);
  assert.equal(f.controller.pendingDisarm, null);
});

test("recorded v2 mixed-vector clock is reacquired without publishing a 65-sample alignment", async () => {
  const recorded = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-mixed-vector-clock-rejection.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const f = v2Fixture({
    geometry: recorded.geometry,
    policy: recorded.policy,
    total: recorded.geometry.totalSamples,
  });
  f.controller.prepare(f.command);
  const p = f.controller.pass;
  f.controller.state = "capturing";
  p.anchorClock = recorded.anchorClock;
  p.anchorHostOffset = recorded.anchorHostOffsetSamples;
  p.clock = recorded.previousClock;
  assert.equal(
    Math.abs(
      recorded.rejectedClock[2] -
        recorded.rejectedClock[4] -
        p.anchorHostOffset,
    ),
    65,
  );
  assert.doesNotThrow(() => f.controller.clock(p, recorded.rejectedClock));
  assert.equal(p.rejected, 1);
  assert.deepEqual(p.clock, recorded.previousClock);
  assert.deepEqual(p.timingWitnesses, {});
  assert.equal(p.nativeFailureDiagnostic, null);
  const progress = f.observed.find(
    (event) =>
      event.type === "native-preflight-stage" &&
      event.stage === "progress" &&
      event.reason === "phase_torn_native_clock",
  );
  assert(progress);
  assert.equal(progress.generation, p.generation);
  assert.equal(progress.passId, f.command.passId);
  assert.equal(progress.traceId, f.command.traceId);
  assert.equal(progress.correlationId, f.command.correlationId);
  assert.equal(progress.rejected, 1);
  assert(progress.elapsedMs >= 0);
  f.controller.cancel(V2_OWNER);
  f.packet("stopped", [0, 0, 2], p.generation);
});

test("recorded stopped 65-sample mismatch is never discarded without independent phase evidence", async () => {
  const recorded = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-mixed-vector-clock-rejection.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const stopped = recorded.stoppedVariant;
  for (const state of ["preflight", "native-arming", "armed"]) {
    const f = v2Fixture({
      geometry: recorded.geometry,
      policy: recorded.policy,
      total: recorded.geometry.totalSamples,
    });
    f.controller.prepare(f.command);
    f.controller.state = state;
    const p = f.controller.pass;
    p.anchorHostOffset = stopped.anchorHostOffsetSamples;
    p.anchorClock = stopped.anchorClock;
    p.clock = stopped.previousClock;
    assert.throws(
      () => f.controller.clock(p, stopped.rejectedClock),
      /listening_alignment_budget_exceeded/,
    );
    assert.equal(p.rejected, 0);
    assert.deepEqual(p.clock, stopped.previousClock);
    assert.equal(p.nativeFailureDiagnostic.startSample, null);
    assert.equal(
      p.nativeFailureDiagnostic.measurements.observedClockDisagreementSamples,
      65,
    );
    f.controller.cancel(V2_OWNER);
    f.packet("stopped", [0, 0, 2], p.generation);
  }
});

for (const rate of [44100, 48000]) {
  for (const vector of [32, 64, 128]) {
    test(`v2 ${rate}/vector${vector} reacquires a mixed-vector row and still completes independently verified coverage`, async () => {
      const f = v2Fixture({ rate, vector, offset: -1 });
      await f.start();
      const p = f.controller.pass;
      const coherent = f.clock(f.origin + 1024);
      coherent[2]++;
      coherent[9]++;
      f.packet("clock", coherent);
      const witnesses = structuredClone(p.timingWitnesses);
      const torn = f.clock(f.origin + 2048);
      const samplesPerBeat = (rate * 60) / f.geometry.tempoBpm;
      torn[2] += vector + 1;
      torn[9] = torn[2];
      torn[1] += vector / samplesPerBeat;
      torn[8] = torn[1];
      f.packet("clock", torn);
      assert.equal(f.controller.state, "capturing");
      assert.equal(p.rejected, 1);
      assert.deepEqual(p.clock, coherent);
      assert.deepEqual(p.timingWitnesses, witnesses);
      f.capture();
      f.post();
      const terminal = f.events.find(
        (event) => event.type === "terminal" && event.status === "complete",
      );
      assert(terminal);
      assert.equal(
        terminal.observation.alignment.observedClockDisagreementSamples,
        1,
      );
      assertNativeCaptureObservationV2(
        terminal.nativeCapture,
        terminal.observation,
        {
          listenerId: "v2-listener",
          passId: f.command.passId,
          policy: f.timingPolicy,
          geometry: f.geometry,
        },
      );
      assert(
        Object.values(terminal.nativeCapture.timingWitnesses).every(
          (row) => JSON.stringify(row) !== JSON.stringify(torn),
        ),
      );
    });
  }
}

test("v2 mixed-vector reacquisition remains bounded and cannot accept a persistent clock shift", async () => {
  const f = v2Fixture({ offset: -1 });
  await f.start();
  const p = f.controller.pass;
  const coherent = f.clock(f.origin + 1024);
  coherent[2]++;
  coherent[9]++;
  f.packet("clock", coherent);
  for (let index = 1; index <= 65; index++) {
    const torn = f.clock(f.origin + 1024 + index * 64);
    torn[2] += 65;
    torn[9] = torn[2];
    torn[1] += (64 * f.geometry.tempoBpm) / (60 * f.geometry.sampleRate);
    torn[8] = torn[1];
    f.packet("clock", torn);
    if (index <= 64) assert.equal(f.controller.state, "capturing");
  }
  assert.equal(f.controller.state, "failed");
  assert.equal(p.closed, true);
  assert(
    f.events.some(
      (event) =>
        event.type === "terminal" &&
        event.status === "failed" &&
        event.reason === "native_preflight_rejection_limit",
    ),
  );
  f.packet("stopped", [0, 0, 2], p.generation);
  assert.equal(f.controller.pendingDisarm, null);
});

test("v2 mixed-vector handling does not discard other phase directions, shifts or an already mismatched reference", async () => {
  for (const [offsetStep, phaseStep, previousPhaseStep] of [
    [64, 0, 0],
    [64, 63, 0],
    [64, -64, 0],
    [64, 65, 0],
    [65, 64, 0],
    [128, 64, 0],
    [64, 64, 1],
  ]) {
    const f = v2Fixture({ offset: -1 });
    await f.start();
    const p = f.controller.pass;
    const samplesPerBeat = (f.geometry.sampleRate * 60) / f.geometry.tempoBpm;
    const coherent = f.clock(f.origin + 1024);
    coherent[2]++;
    coherent[9]++;
    coherent[5] -= previousPhaseStep / samplesPerBeat;
    f.packet("clock", coherent);
    const row = f.clock(f.origin + 2048);
    row[2] += offsetStep + 1;
    row[9] = row[2];
    row[1] += phaseStep / samplesPerBeat;
    row[8] = row[1];
    f.packet("clock", row);
    assert.equal(f.controller.state, "failed");
    assert.equal(p.rejected, 0);
    assert.equal(p.nativeFailureDiagnostic.check, "host-offset");
    assert.equal(
      p.nativeFailureDiagnostic.measurements.observedClockDisagreementSamples,
      offsetStep + 1,
    );
    f.packet("stopped", [0, 0, 2], p.generation);
    assert.equal(f.controller.pendingDisarm, null);
  }
});

test("v2 mixed-vector phase comparison handles a host beat crossing the circular phase boundary", async () => {
  const f = v2Fixture({
    offset: -1,
    geometry: { tempoBpm: 120, startBeat: 0.99, endBeat: 2.99 },
  });
  await f.start();
  const p = f.controller.pass;
  const coherent = f.clock(f.origin + 24152);
  coherent[2]++;
  coherent[9]++;
  f.packet("clock", coherent);
  const row = f.clock(f.origin + 24216);
  row[2] += 65;
  row[9] = row[2];
  row[1] += 64 / 24000;
  row[8] = row[1];
  assert(row[1] % 1 < row[5]);
  f.packet("clock", row);
  assert.equal(f.controller.state, "capturing");
  assert.equal(p.rejected, 1);
  assert.deepEqual(p.clock, coherent);
  f.controller.cancel(V2_OWNER);
  f.packet("stopped", [0, 0, 2], p.generation);
  assert.equal(f.controller.pendingDisarm, null);
});

test("v2 mixed-vector reacquisition leaves strict zero tolerance and proof unchanged", async () => {
  const f = v2Fixture({
    offset: 0,
    policy: { mode: "strict", maxClockDisagreementSamples: 0 },
    geometry: { tempoBpm: 120, startBeat: 0, endBeat: 2 },
  });
  await f.start();
  const p = f.controller.pass;
  const row = f.clock(f.origin + 2048);
  row[2] += 64;
  row[9] = row[2];
  row[1] += 64 / 24000;
  row[8] = row[1];
  f.packet("clock", row);
  assert.equal(p.rejected, 1);
  f.capture();
  f.post();
  const terminal = validate(f);
  assert.equal(
    terminal.observation.alignment.observedClockDisagreementSamples,
    0,
  );
  assert.equal(
    terminal.observation.alignment.observedBeatDisagreementSamples,
    0,
  );
});

test("actual corrected immutable v2 candidate arms before a later unclassified envelope-binding failure", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-envelope-binding-failure.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  nativeArmProofV2Schema.parse(evidence.nativeArm);
  assert.equal(evidence.nativeArm.nativeEpoch, 1);
  assert.equal(evidence.nativeArm.armCounter, 1026560);
  assert.equal(evidence.nativeArm.before.frames.length, 32);
  assert.deepEqual(evidence.nativeArm.before.dsp, [1, 48000, 64]);
  assert.deepEqual(evidence.nativeArm.policy, {
    mode: "descriptive",
    maxClockDisagreementSamples: 64,
  });
  assert.equal(evidence.nativeArm.geometry.totalSamples, 84000);
  assert.equal(evidence.failureReason, "native_envelope_binding_changed");
  assert.equal(evidence.nativeLaunchReceiptRetained, false);
  assert.equal(evidence.rejectedEnvelopePacket, null);
  assert.equal(evidence.actualGuardOperand, null);
  assert.equal(evidence.failureFrames, 0);
  assert.equal(evidence.outcome.completed, false);
  assert.equal(evidence.outcome.realLiveValidated, false);
  assert.deepEqual(evidence.outcome.contextIds, []);
  assert.equal(evidence.outcome.processStopped, true);
  assert.equal(evidence.outcome.fixtureCleaned, true);
});

test("v2 keeps both envelope-binding guard branches as hard failures with confirmed modeled cleanup", async () => {
  for (const field of [4, 13]) {
    const f = v2Fixture();
    await f.start();
    const p = f.controller.pass;
    const row = f.envelope();
    row[field] = field === 4 ? 12 : row[field] + 1;
    f.packet("envelope", row);
    assert.equal(f.controller.state, "failed");
    assert.equal(p.closed, true);
    assert(
      f.events.some(
        (event) =>
          event.type === "terminal" &&
          event.status === "failed" &&
          event.reason === "native_envelope_binding_changed",
      ),
    );
    assert(f.controller.pendingDisarm);
    f.packet("stopped", [0, 0, 2], p.generation);
    assert.equal(f.controller.pendingDisarm, null);
  }
});

test("actual read-only rejection row preserves the armed counter and replays native rejection15", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-envelope-rejection-observation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const observed = evidence.observation;
  assert.equal(evidence.instrumentedDiagnosticOnly, true);
  assert.equal(evidence.acceptancePassed, false);
  assert.deepEqual(evidence.sourceOverrides, []);
  assert.equal(evidence.controlAdmissionValidationAndCallbacksUnchanged, true);
  assert.equal(observed.controllerState, "armed");
  assert.equal(observed.count, 214);
  assert.equal(observed.rejectedRow.length, 16);
  assert(observed.rejectedRow.every(Number.isFinite));
  assert.equal(observed.rejectedRow[0], observed.nativeEpoch);
  assert.equal(observed.rejectedRow[13], observed.originalArmCounter);
  assert.equal(observed.rejectedRow[4], 15);
  assert.equal(observed.armCounterMismatch, false);
  assert.equal(observed.rejectedCounterNonzero, true);
  assert.equal(observed.observedPassMatchesActorJob, true);
  const f = v2Fixture();
  f.controller.prepare(f.command);
  f.controller.state = observed.controllerState;
  const pass = f.controller.pass;
  pass.nativeEpoch = observed.nativeEpoch;
  pass.armed = { armCounter: observed.originalArmCounter };
  assert.throws(() => f.controller.envelope(pass, observed.rejectedRow), {
    message: observed.originalErrorMessage,
  });
  assert.deepEqual(evidence.outcome.contextIds, []);
  for (const key of [
    "instrumentationRestored",
    "processStopped",
    "fixtureCleaned",
    "copiedResourcesUnchanged",
    "sourcePinsUnchanged",
  ])
    assert.equal(evidence.outcome[key], true);
});

test("actual diagnostic load retains the unpublished spectrum sentinel and denies arm", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-spectrum-fault-diagnostic.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const recorded = evidence.journalEvidence.nativeFailureDiagnostic;
  nativeFailureDiagnosticV2Schema.parse(recorded);
  const f = v2Fixture();
  f.controller.prepare(f.command);
  const p = f.controller.pass;
  const pending = f.controller.arm(V2_OWNER).catch((error) => error);
  f.packet("fftInfo", recorded.metadata.fftInfo);
  f.packet("abi-spectrum", [recorded.metadata.spectrumAbi]);
  f.packet("spectrum-diagnostics", recorded.fftDiagnostics);
  f.packet("spectrum", recorded.packet);
  const error = await pending;
  assert.equal(error.message, evidence.failureReason);
  assert.deepEqual(p.nativeFailureDiagnostic, {
    ...recorded,
    generation: p.generation,
  });
  assert.equal(
    f.sent.some((packet) => packet.action === "arm"),
    false,
  );
  assert.equal(evidence.outcome.completed, false);
  assert.deepEqual(evidence.outcome.contextIds, []);
  assert.equal(evidence.outcome.processStopped, true);
  assert.equal(evidence.outcome.fixtureCleaned, true);
  f.packet("stopped", [0, 0, 2], p.generation);
});

test("v2 spectrum rejection freezes exact numeric input, latest non-authority debug and actually received metadata", async () => {
  for (const [check, patch] of [
    ["end", { 0: 0 }],
    ["start", { 3: -1 }],
    ["frame", { 4: 0 }],
    ["centroid", { 1: 24001 }],
    ["energy", { 2: -1 }],
    ["silence_centroid", { 1: 1, 2: 0 }],
    ["invalid_frames", { 5: -1 }],
    ["bracket", { 0: 64001 }],
  ]) {
    const f = v2Fixture();
    f.controller.prepare(f.command);
    const p = f.controller.pass;
    const pending = f.controller.arm(V2_OWNER).catch((error) => error);
    f.packet("dsp", [1, 48000, 64]);
    f.packet("abi-clock", [2]);
    f.packet("spectrum-diagnostics", [0, 1, 2, 3, 4]);
    const debug = [5, -2, 0.5, Number.MAX_VALUE, 8];
    f.packet("spectrum-diagnostics", debug);
    assert.equal(f.controller.state, "preflight");
    assert.equal(
      f.sent.some((packet) => packet.action === "arm"),
      false,
    );
    const values = Object.assign([64000, 1000, 1, 61952, 64000, 0], patch);
    const expected = [...values];
    f.packet("spectrum", values);
    const error = await pending;
    assert.match(
      error.message,
      new RegExp(`^invalid_native_spectrum_packet_${check}_`),
    );
    const diagnostic = p.nativeFailureDiagnostic;
    nativeFailureDiagnosticV2Schema.parse(diagnostic);
    assert.deepEqual(diagnostic, {
      scope: "native-spectrum-rejection/v1",
      generation: p.generation,
      check,
      packet: expected,
      fftDiagnostics: debug,
      metadata: {
        dsp: [1, 48000, 64],
        fftInfo: null,
        clockAbi: 2,
        envelopeAbi: null,
        spectrumAbi: null,
      },
    });
    assert(Object.isFrozen(diagnostic));
    assert(Object.isFrozen(diagnostic.packet));
    assert(Object.isFrozen(diagnostic.fftDiagnostics));
    assert(Object.isFrozen(diagnostic.metadata));
    assert(Object.isFrozen(diagnostic.metadata.dsp));
    values[0] = 777;
    debug[0] = 999;
    assert.deepEqual(diagnostic.packet, expected);
    assert.equal(diagnostic.fftDiagnostics[0], 5);
    assert.deepEqual(p.metadata, {});
    assert.equal(p.spectrumDiagnostics, null);
    f.packet("stopped", [0, 0, 2], p.generation);
  }
});

test("v2 alignment failures retain the actual rejected row and measurements before clearing capture state", async () => {
  for (const check of ["host-offset", "clock-alignment"]) {
    const f = v2Fixture();
    await f.start();
    const p = f.controller.pass;
    const previous = [...p.clock];
    const rejected = f.clock(
      f.origin + 704,
      true,
      check === "host-offset" ? 65 : 0,
    );
    if (check === "clock-alignment") {
      rejected[1] += (65 * f.geometry.tempoBpm) / (60 * f.geometry.sampleRate);
      rejected[8] = rejected[1];
      rejected[5] = rejected[1] % 1;
    }
    const expectedRow = [...rejected];
    f.packet("clock", rejected);
    assert.equal(f.controller.state, "failed");
    assert.equal(f.controller.pass, null);
    const diagnostic = p.nativeFailureDiagnostic;
    nativeFailureDiagnosticV2Schema.parse(diagnostic);
    assert.equal(diagnostic.scope, "native-alignment-rejection/v1");
    assert.equal(diagnostic.check, check);
    assert.deepEqual(diagnostic.rejectedClock, expectedRow);
    assert.deepEqual(diagnostic.previousClock, previous);
    assert.deepEqual(diagnostic.geometry, f.geometry);
    assert.deepEqual(diagnostic.policy, f.timingPolicy);
    assert.equal(diagnostic.anchorHostOffsetSamples, 1000000);
    assert.equal(diagnostic.startSample, f.origin + 1000000);
    assert.equal(
      diagnostic.measurements.observedClockDisagreementSamples,
      check === "host-offset" ? 65 : 0,
    );
    assert.equal(
      diagnostic.measurements.observedBeatDisagreementSamples,
      check === "host-offset" ? null : 65,
    );
    assert(Object.isFrozen(diagnostic));
    assert(Object.isFrozen(diagnostic.rejectedClock));
    rejected[2] = 999;
    assert.deepEqual(diagnostic.rejectedClock, expectedRow);
    const terminal = f.events.find((event) => event.type === "terminal");
    assert.equal(terminal.reason, "listening_alignment_budget_exceeded");
    assert.deepEqual(terminal.nativeFailureDiagnostic, diagnostic);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.nativeCapture, undefined);
    assert.deepEqual(p.timingWitnesses, {});
    f.packet("stopped", [0, 0, 2], p.generation);
  }
});

test("v2 changed spectrum sequence retains both packets without relaxing the sequence guard", async () => {
  const f = v2Fixture();
  await f.start();
  const p = f.controller.pass;
  const previous = [...p.spectrum];
  const rejected = [...previous];
  rejected[2] += 1;
  f.packet("spectrum", rejected);
  assert.equal(f.controller.state, "failed");
  const diagnostic = p.nativeFailureDiagnostic;
  nativeFailureDiagnosticV2Schema.parse(diagnostic);
  assert.equal(diagnostic.check, "sequence");
  assert.deepEqual(diagnostic.previousPacket, previous);
  assert.deepEqual(diagnostic.packet, rejected);
  assert.equal(
    f.events.find((event) => event.type === "terminal").reason,
    "changed_native_spectrum_sequence",
  );
  assert(Object.isFrozen(diagnostic.previousPacket));
  f.packet("stopped", [0, 0, 2], p.generation);
});

test("actual Max-JS spectrum_diagnostics handler forwards five finite values without fabricating missing metadata", async () => {
  const f = v2Fixture();
  f.controller.prepare(f.command);
  const p = f.controller.pass;
  const pending = f.controller.arm(V2_OWNER).catch((error) => error);
  const wire = [];
  const context = {
    jsarguments: ["audio_listener_native_io.js", "spectrum", 2],
    arrayfromargs: (args) => Array.from(args),
    post() {},
    outlet: (port, values) => {
      if (port !== 0) return;
      const packet = Array.from(values);
      wire.push(packet);
      f.packet(packet[2], packet.slice(3), packet[1]);
    },
  };
  runInNewContext(
    await readFile(
      new URL("./audio_listener_native_io.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  context.begin(p.generation);
  const debug = [1, 2048, Number.MAX_VALUE, 0, -0.25];
  context.spectrum_diagnostics(...debug);
  assert.deepEqual(wire[0], [
    "native",
    p.generation,
    "spectrum-diagnostics",
    ...debug,
  ]);
  context.spectrum_frame(64000, 24001, 1, 61952, 64000, 0);
  await pending;
  assert.deepEqual(p.nativeFailureDiagnostic.fftDiagnostics, debug);
  assert.deepEqual(p.nativeFailureDiagnostic.metadata, {
    dsp: null,
    fftInfo: null,
    clockAbi: null,
    envelopeAbi: null,
    spectrumAbi: null,
  });
  context.stop(p.generation);
  f.packet("stopped", [0, 0, 2], p.generation);
});

test("v2 malformed debug fails boundedly and stale debug cannot replace a new owner's missing diagnostics", async () => {
  for (const values of [
    [1, 2],
    [1, 2, 3, 4, NaN],
    [1, 2, 3, 4, Infinity],
  ]) {
    const f = v2Fixture();
    f.controller.prepare(f.command);
    const p = f.controller.pass;
    const pending = f.controller.arm(V2_OWNER).catch((error) => error);
    f.packet("spectrum-diagnostics", values);
    assert.equal((await pending).message, "invalid_native_io_packet");
    assert.equal(p.nativeFailureDiagnostic, null);
    f.packet("stopped", [0, 0, 2], p.generation);
  }
  const f = v2Fixture();
  f.controller.prepare(f.command);
  const first = f.controller.pass;
  const cancelled = f.controller.arm(V2_OWNER).catch((error) => error);
  f.packet("spectrum-diagnostics", [1, 2, 3, 4, 5]);
  f.controller.cancel(V2_OWNER);
  await cancelled;
  assert.equal(first.nativeFailureDiagnostic, null);
  f.packet("stopped", [0, 0, 2], first.generation);
  f.controller.prepare(f.command);
  const next = f.controller.pass;
  const pending = f.controller.arm(V2_OWNER).catch((error) => error);
  assert.equal(
    f.packet("spectrum-diagnostics", [9, 9, 9, 9, 9], first.generation),
    false,
  );
  f.packet("spectrum", [64000, -1, 1, 61952, 64000, 0]);
  await pending;
  assert.equal(next.nativeFailureDiagnostic.generation, next.generation);
  assert.equal(next.nativeFailureDiagnostic.fftDiagnostics, null);
  f.packet("stopped", [0, 0, 2], next.generation);
});

test("spectrum debug IO rejects malformed values once per generation and never loosens main packet guards", () => {
  const generation = "a0f16f9f-a7cb-4dcf-8845-b4adef11a021";
  const wire = [];
  const io = new NativeMessageIO(
    "spectrum",
    (packet) => wire.push(packet),
    () => {},
    () => {},
    2,
  );
  assert.equal(io.spectrumDiagnostics([1, 2, 3, 4, 5]), false);
  io.begin(generation);
  for (const values of [
    [1],
    [1, 2, 3, 4, NaN],
    [1, 2, 3, 4, Infinity],
    [1, 2, 3, 4, "5"],
  ])
    assert.equal(io.spectrumDiagnostics(values), false);
  assert.deepEqual(wire, [["native", generation, "ioError", 1]]);
  assert.equal(io.spectrumDiagnostics([1, 2, 3, 4, Number.MAX_VALUE]), true);
  assert.equal(
    io.packet("spectrum", [64000, 0, Number.MAX_VALUE, 61952, 64000, 0], 6),
    false,
  );
  assert.equal(wire.filter((packet) => packet[2] === "spectrum").length, 0);
  io.stop(generation);
  io.release(generation);
  assert.equal(io.spectrumDiagnostics([1, 2, 3, 4, 5]), false);
  assert.equal(wire.filter((packet) => packet[2] === "ioError").length, 1);
});

test("default v1 spectrum failure preserves reason and has no numeric diagnostic fields", async () => {
  const controller = new NativeCaptureController({
    listenerId: "v1-listener",
    send: () => true,
    onArmed: () => true,
  });
  controller.prepare({
    ...V2_OWNER,
    traceId: "v1-trace",
    correlationId: "v1-correlation",
    causationId: "v1-root",
    mode: "arrangement",
    startBeat: 0,
    endBeat: 4,
  });
  const p = controller.pass;
  const pending = controller.arm(V2_OWNER).catch((error) => error);
  controller.ingest({
    generation: p.generation,
    type: "spectrum",
    values: [64000, -1, 1, 61952, 64000, 0],
  });
  assert.equal((await pending).message, "invalid_native_spectrum_packet");
  assert.equal(Object.hasOwn(p, "nativeFailureDiagnostic"), false);
  assert.equal(Object.hasOwn(p, "spectrumDiagnostics"), false);
  const wire = [];
  const io = new NativeMessageIO(
    "spectrum",
    (packet) => wire.push(packet),
    () => {},
    () => {},
  );
  io.begin(p.generation);
  assert.equal(io.spectrumDiagnostics([1, 2, 3, 4, 5]), false);
  assert.deepEqual(wire, [["native", p.generation, "ioError", 1]]);
});

test("recorded real v2 zero-spectrum ABI failure replays as a denial, never native capture authority", async () => {
  const recorded = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/native-v2-arm-metadata-failure.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(recorded.evidenceKind, "actual-runner-owned-live-failure");
  assert.equal(recorded.rejectedMetadata.physicalCause, "unresolved");
  assert.equal(recorded.relatedCompilerEvidence.messages.length, 2);
  assert(
    recorded.relatedCompilerEvidence.loadedFixtureName.includes(
      recorded.scenarioRunId,
    ),
  );
  assert.equal(recorded.outcome.realLiveValidated, false);
  assert.equal(recorded.outcome.completed, false);
  assert.equal(recorded.outcome.cancellationConfirmed, false);
  assert.deepEqual(recorded.outcome.contextIds, []);
  const geometry = recorded.applicationConfiguration.geometry;
  const f = v2Fixture({
    rate: geometry.sampleRate,
    total: geometry.totalSamples,
    geometry: {
      tempoBpm: geometry.tempoBpm,
      startBeat: geometry.startBeat,
      endBeat: geometry.endBeat,
    },
  });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  f.packet(
    recorded.rejectedMetadata.type,
    recorded.rejectedMetadata.observedValues,
  );
  await assert.rejects(pending, { message: recorded.failureReason });
  assert.equal(f.armed.length, 0);
  assert.equal(
    f.events.some((event) => event.status === "complete"),
    false,
  );
});

test("v2 arm metadata failures identify the rejected packet and bounded actual values without weakening validation", async () => {
  for (const [type, values, expectedReason] of [
    ["dsp", [1, 48000, 128], "native_metadata_changed_dsp_1_48000_128"],
    [
      "fftInfo",
      [2048, 2048, 2048, 0],
      "native_metadata_changed_fft_info_2048_2048_2048_0",
    ],
    ["abi-clock", [1], "native_metadata_changed_abi_clock_1"],
    ["abi-envelope", [0], "native_metadata_changed_abi_envelope_0"],
    ["abi-spectrum", [0], "native_metadata_changed_abi_spectrum_0"],
    ["abi-spectrum", [1], "native_metadata_changed_abi_spectrum_1"],
    [
      "fftInfo",
      [Number.MAX_VALUE, 2 ** 53, 0.5, -1],
      "native_metadata_changed_fft_info_invalid_invalid_invalid_invalid",
    ],
  ]) {
    const f = v2Fixture({
      rate: 48000,
      total: 84000,
      geometry: { tempoBpm: 120, startBeat: 0.25, endBeat: 3.75 },
    });
    f.controller.prepare(f.command);
    const p = f.controller.pass;
    const pending = f.controller.arm(V2_OWNER);
    f.packet(type, values);
    await assert.rejects(pending, { message: expectedReason });
    assert.equal(f.controller.pass, null);
    assert.equal(f.armed.length, 0);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
    );
    const failure = f.observed.find(
      (event) =>
        event.type === "native-preflight-stage" && event.stage === "failed",
    );
    assert.equal(failure.reason, expectedReason);
    assert.match(failure.reason, /^[a-z][a-z0-9_]{0,127}$/);
    assert.equal(failure.traceId, f.command.traceId);
    assert.equal(failure.generation, p.generation);
    assert.equal(f.sent.at(-1).action, "stop");
    assert.equal(f.sent.at(-1).generation, p.generation);
    f.packet("stopped", [0, 0, 2], p.generation);
    assert.equal(f.controller.pendingDisarm, null);
  }
});

test("v2 rejected spectrum snapshots retain bounded counter diagnostics without accepting malformed frames", async () => {
  for (const [values, expected] of [
    [[0, 0, 0, 0, 0, 37], "end_e0_s0_f0_b37"],
    [[8192, 1000, 1, -1, 8192, 0], "start_e8192_sinvalid_f8192_b0"],
    [[8192, 1000, 1, 6144, 0, 0], "frame_e8192_s6144_f0_b0"],
    [[8192, 1000, 1, 6000, 8192, 0], "bracket_e8192_s6000_f8192_b0"],
    [[8192, 24001, 1, 6144, 8192, 0], "centroid_e8192_s6144_f8192_b0"],
    [[8192, 1000, -1, 6144, 8192, 0], "energy_e8192_s6144_f8192_b0"],
    [[8192, 1, 0, 6144, 8192, 0], "silence_centroid_e8192_s6144_f8192_b0"],
    [
      [8192, 1000, 1, 6144, 8192, 0.5],
      "invalid_frames_e8192_s6144_f8192_binvalid",
    ],
    [[2 ** 53, 0, 0, 0, 2048, 0], "end_einvalid_s0_f2048_b0"],
  ]) {
    const f = v2Fixture();
    f.controller.prepare(f.command);
    const p = f.controller.pass;
    const pending = f.controller.arm(V2_OWNER);
    f.packet("spectrum", values);
    const reason = `invalid_native_spectrum_packet_${expected}`;
    await assert.rejects(pending, { message: reason });
    assert.equal(f.controller.pass, null);
    assert.equal(f.armed.length, 0);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
    );
    const failure = f.observed.find(
      (event) =>
        event.type === "native-preflight-stage" && event.stage === "failed",
    );
    assert.equal(failure.reason, reason);
    assert.match(reason, /^[a-z][a-z0-9_]{0,127}$/);
    assert.equal(failure.traceId, f.command.traceId);
    assert.equal(failure.generation, p.generation);
    f.packet("stopped", [0, 0, 2], p.generation);
    assert.equal(f.controller.pendingDisarm, null);
  }
  const maximum = Number.MAX_SAFE_INTEGER;
  assert.match(
    v2Fixture().controller.spectrumPacketReason(
      [maximum, 0, 0, maximum, maximum, maximum],
      "silence_centroid",
    ),
    /^[a-z][a-z0-9_]{0,127}$/,
  );
});

test("v2 completed, failed and cancelled observations durably disclose the constant-tempo assumption", async () => {
  for (const rate of [44100, 48000])
    for (const outcome of ["complete", "failed", "cancelled"]) {
      const f = v2Fixture({ rate });
      await f.start();
      f.capture();
      if (outcome === "complete") f.post();
      else if (outcome === "failed") f.packet("tempo", [93 + 1e-6]);
      else f.controller.cancel(V2_OWNER);
      const terminal = f.events.find((event) => event.type === "terminal");
      assert.equal(terminal.observation.schema, "audio-observation/v2");
      assert.equal(terminal.status, outcome);
      assert.equal(
        terminal.observation.limitations.filter(
          (limitation) => limitation === TEMPO_LIMITATION,
        ).length,
        1,
      );
      assert(TEMPO_LIMITATION.length <= 128);
      assert.equal(terminal.observation.complete, outcome === "complete");
      if (outcome === "failed")
        assert.equal(terminal.reason, "native_host_tempo_changed");
      if (outcome !== "complete")
        assert.equal(terminal.nativeCapture, undefined);
      f.packet("stopped", [0, 0, 2], f.controller.pendingDisarm.generation);
      assert.equal(f.controller.pendingDisarm, null);
    }
});

test("the v2 tempo limitation leaves default v1 observation bytes unchanged from the archived engine", () => {
  const current = require("./audio_listener_engine.js");
  const archived = require("./fixtures/native-v1-6cceef6/audio_listener_engine.js");
  const observations = [current, archived].map(
    ({ AudioListenerEngine, VERSION }) => {
      const events = [];
      const engine = new AudioListenerEngine({
        listenerId: "legacy-listener",
        now: () => 0,
        emit: (event) => events.push(event),
        certificate: {
          validated: true,
          algorithmVersion: VERSION,
          hostVersion: "test-double",
          maxVersion: "test-double",
          launchAligned: true,
          requiredHostFlags: 19,
          uncertaintySamples: 64,
          descriptorOffsetSamples: 0,
          sampleRate: 48000,
          vectorSize: 64,
        },
      });
      const host = {
        sampleRate: 48000,
        vectorSize: 64,
        sample: 10000,
        beat: 4,
        flags: 19,
        playing: false,
        dspOn: true,
      };
      engine.configureHost(host);
      engine.prepare({ ...V2_OWNER, startBeat: 4, endBeat: 8, settings: {} });
      engine.arm(V2_OWNER);
      engine.configureHost({ ...host, playing: true });
      engine.cancel(V2_OWNER);
      const observation = events.find(
        (event) => event.type === "terminal",
      ).observation;
      assert.equal(observation.schema, "audio-observation/v1");
      assert.equal(observation.limitations.includes(TEMPO_LIMITATION), false);
      return JSON.stringify(observation);
    },
  );
  assert.equal(observations[0], observations[1]);
});

test("v2 classic-JS IO seals generation-owned setters before epoch but never fabricates a native configuration receipt", () => {
  const packets = [],
    controls = [],
    diagnostics = [];
  const io = new NativeMessageIO(
    "envelope",
    (value) => packets.push(value),
    (value) => controls.push(value),
    (value) => diagnostics.push(value),
    2,
  );
  const generation = "11111111-1111-4111-8111-111111111111";
  assert.equal(io.begin(generation), true);
  assert.equal(io.configureV2("foreign", [48000, 4800, 93, 0.25, 64]), false);
  assert.equal(io.generation, generation);
  assert.equal(io.configureV2(generation, [48000, 4800, 93, 0.25, 64]), true);
  assert.equal(io.arm(generation, 7), true);
  assert.equal(packets.length, 0);
  assert.deepEqual(controls.slice(-7), [
    ["totalSamples", 48000],
    ["hopSamples", 4800],
    ["tempoBpm", 93],
    ["startBeatFraction", 0.25],
    ["captureVector", 64],
    ["cancel", 0],
    ["epoch", 7],
  ]);
  assert.equal(io.configurationFrame([7, 48000, 4800, 93, 0.25, 64, 7]), true);
  assert.deepEqual(packets[0], [
    "native",
    generation,
    "config",
    7,
    48000,
    4800,
    93,
    0.25,
    64,
    7,
  ]);
  assert.equal(io.begin("22222222-2222-4222-8222-222222222222"), false);
  assert.equal(io.generation, generation);
  assert.equal(io.stop("foreign"), false);
  assert.equal(io.stop(generation), true);
  assert.equal(io.stopping, true);
  assert.equal(
    io.envelope([7, 576, -1, 0, 0, 1, 64, -1, 0, 0, 0, 0, 0, 65536, 66048, 2]),
    false,
  );
  assert.equal(io.generation, generation);
  assert.equal(
    io.envelope([0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 65536, -1, 2]),
    true,
  );
  assert.equal(io.configuration, null);
  assert.equal(io.configurationFrame([7, 48000, 4800, 93, 0.25, 64, 7]), false);
  assert.deepEqual(controls.slice(-3), [
    ["cancel", 1],
    ["epoch", 0],
    ["poll", 0],
  ]);
  assert.deepEqual(packets.at(-1), ["native", generation, "stopped", 0, 0, 2]);
});

test("missing, changed and inconsistent native v2 configuration receipts fail/reset without armed publication", async () => {
  for (const kind of [
    "missing",
    "wrong-total",
    "wrong-seal",
    "changed-reset",
  ]) {
    const f = v2Fixture();
    f.controller.prepare(f.command);
    const pending = f.controller.arm(V2_OWNER);
    f.preflight();
    f.ack();
    assert.equal(f.armed.length, 0);
    if (kind === "missing") {
      f.time(1000);
      f.controller.tick();
    } else if (kind === "changed-reset") {
      const ack = [
        f.controller.pass.nativeEpoch,
        -1,
        -1,
        0,
        0,
        0,
        -1,
        -1,
        0,
        0,
        0,
        0,
        0,
        f.armCounter + 64,
        -1,
        2,
      ];
      f.packet("envelope", ack);
    } else {
      const epoch = f.controller.pass.nativeEpoch;
      f.packet("config", [
        epoch,
        f.geometry.totalSamples + (kind === "wrong-total" ? 1 : 0),
        f.geometry.hopSamples,
        93,
        0.25,
        64,
        epoch + (kind === "wrong-seal" ? 1 : 0),
      ]);
    }
    await assert.rejects(pending, /native_/);
    assert.equal(f.controller.pass, null);
    assert.equal(f.armed.length, 0);
    assert.equal(f.sent.at(-1).action, "stop");
  }
});

test("actual recorded stopped 0-to64 and minus1-to0 native clock offset changes are descriptive observations, never v1 retuning", () => {
  const evidence = require("./fixtures/native-hardened-fixture-failure.json");
  for (const observed of [
    evidence.diagnostic.clock,
    evidence.failOnlyLookahead.clock.initial,
  ]) {
    const f = v2Fixture({
      geometry: { tempoBpm: 120, startBeat: 0, endBeat: 2 },
    });
    f.controller.prepare(f.command);
    f.controller.state = "armed";
    const p = f.controller.pass;
    const anchor = observed.previous[2] - observed.previous[4];
    p.clock = observed.previous;
    p.anchorHostOffset = anchor;
    f.controller.clock(p, observed.row);
    assert.deepEqual(p.clock, observed.row);
    assert.equal(p.anchorHostOffset, anchor);
    assert.equal(p.rejected, 0);
    assert.equal(f.armed.length, 0);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
    );
    f.controller.cancel(V2_OWNER);
    const strict = v2Fixture({
      geometry: { tempoBpm: 120, startBeat: 0, endBeat: 2 },
      policy: { mode: "strict", maxClockDisagreementSamples: 0 },
    });
    strict.controller.prepare(strict.command);
    strict.controller.state = "armed";
    const strictPass = strict.controller.pass;
    strictPass.clock = observed.previous;
    strictPass.anchorHostOffset = anchor;
    assert.throws(
      () => strict.controller.clock(strictPass, observed.row),
      /listening_alignment_budget_exceeded/,
    );
    assert.equal(strictPass.anchorHostOffset, anchor);
    strict.controller.cancel(V2_OWNER);
  }
});

function validate(f) {
  const terminal = f.events.find((event) => event.type === "terminal");
  assert.equal(terminal?.status, "complete", JSON.stringify(terminal));
  assertNativeCaptureObservationV2(
    terminal.nativeCapture,
    terminal.observation,
    {
      listenerId: "v2-listener",
      passId: V2_OWNER.passId,
      geometry: f.geometry,
      policy: f.timingPolicy,
    },
  );
  return terminal;
}

test("v2 disarm acknowledges only its owned native epoch, times out without claiming receipt and bounds cleanup", async () => {
  for (const outcome of ["receipt", "timeout", "observer-failure"]) {
    const receipts = [];
    const f = v2Fixture({
      onDisarmed: (value) => receipts.push(value),
      observe: (event) => {
        if (
          outcome === "observer-failure" &&
          event.type === "native-disarm-stage"
        )
          throw new Error("controlled observer failure");
      },
    });
    await f.start();
    const generation = f.controller.pass.generation;
    f.controller.cancel(V2_OWNER);
    assert.equal(f.controller.pendingDisarm.generation, generation);
    assert.throws(
      () => f.controller.prepare(f.command),
      /native_disarm_pending/,
    );
    assert.equal(
      f.controller.ingest({
        generation: "stale",
        type: "stopped",
        values: [0, 0, 2],
      }),
      false,
    );
    assert.equal(
      f.controller.ingest({ generation, type: "stopped", values: [0, 1, 2] }),
      false,
    );
    if (outcome === "timeout") {
      f.time(1000);
      f.controller.tick();
    } else f.packet("stopped", [0, 0, 2], generation);
    assert.equal(f.controller.pendingDisarm, null);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].confirmed, outcome !== "timeout");
    assert.equal(
      receipts[0].reason,
      outcome === "observer-failure"
        ? "native_disarm_observer_failed"
        : outcome === "timeout"
          ? "native_stop_ack_timeout"
          : "native_disarm_confirmed",
    );
    const stages = f.observed.filter(
      (event) => event.type === "native-disarm-stage",
    );
    assert.equal(
      stages[0].causationId,
      f.events.filter((event) => event.type === "native-capture-stage").at(-1)
        .eventId,
    );
    assert.deepEqual(
      stages.map((event) => event.stage),
      ["queued", "started", outcome === "timeout" ? "failed" : "completed"],
    );
    for (let i = 1; i < stages.length; i++)
      assert.equal(stages[i].causationId, stages[i - 1].eventId);
    assert.equal(stages.at(-1).elapsedMs, outcome === "timeout" ? 1000 : 0);
    assert(
      stages.every(
        (event) =>
          event.traceId === "v2-trace" &&
          event.correlationId === "v2-correlation",
      ),
    );
    f.controller.prepare(f.command);
    f.controller.cancel(V2_OWNER);
    assert.equal(f.controller.pendingDisarm, null);
  }
});

test("v2 classic-JS rejects an unsealed stopped snapshot and force-releases only its own stopped generation", () => {
  const packets = [],
    controls = [],
    diagnostics = [];
  const io = new NativeMessageIO(
    "envelope",
    (value) => packets.push(value),
    (value) => controls.push(value),
    (value) => diagnostics.push(value),
    2,
  );
  const generation = "11111111-1111-4111-8111-111111111111";
  io.begin(generation);
  io.configureV2(generation, [48000, 4800, 93, 0.25, 64]);
  io.arm(generation, 7);
  io.stop(generation);
  assert.equal(
    io.envelope([0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 65536, -1, 2]),
    false,
  );
  assert.equal(io.generation, generation);
  assert.equal(
    packets.some((row) => row[2] === "stopped"),
    false,
  );
  assert.equal(io.release("foreign"), false);
  assert.equal(io.release(generation), true);
  assert.equal(io.generation, null);
  assert.equal(io.configuration, null);
  assert.deepEqual(controls.at(-1), ["poll", 0]);
  assert(diagnostics.includes("native_io_disarm_unconfirmed"));
});

test("v2 disarm release failure is bounded, attributed and cleaned without persisting callback bodies", async () => {
  const receipts = [];
  const f = v2Fixture({
    onDisarmed: (receipt) => receipts.push(receipt),
    send: (value) => {
      if (value.action === "release")
        throw new Error("password=controlled-private-body");
      return true;
    },
  });
  await f.start();
  const generation = f.controller.pass.generation;
  f.controller.cancel(V2_OWNER);
  f.time(1000);
  assert.doesNotThrow(() => f.controller.tick());
  assert.equal(f.controller.pendingDisarm, null);
  assert.equal(receipts[0].confirmed, false);
  assert(
    f.observed.some(
      (event) =>
        event.generation === generation &&
        event.reason === "native_release_send_failed" &&
        event.traceId === "v2-trace",
    ),
  );
  assert.equal(
    JSON.stringify([f.observed, f.events, receipts]).includes(
      "controlled-private-body",
    ),
    false,
  );
});

for (const rate of [44100, 48000])
  for (const silent of [false, true]) {
    test(`opt-in native-v2 ${rate}Hz ${silent ? "silence" : "ordinary nonquiet audio"} at beat5.25/93BPM independently passes the actual App validator`, async () => {
      const f = v2Fixture({ rate, silent });
      await f.start();
      f.capture();
      f.post();
      const terminal = validate(f);
      assert.equal(terminal.observation.algorithm.version, "2.0.0");
      assert.equal(
        Object.hasOwn(
          terminal.observation.algorithm,
          "timingUncertaintySamples",
        ),
        false,
      );
      assert.equal(
        terminal.observation.alignment.verifiedAbsoluteErrorBoundSamples,
        null,
      );
      assert.equal(f.controller.pass, null);
      assert.equal(f.sent.at(-1).action, "stop");
      if (silent) assert.equal(terminal.observation.summaries.centroidHz, null);
    });
  }

for (const rate of [44100, 48000]) {
  for (const total of [rate / 10, rate * 30, (rate / 10) * 299 + 1])
    test(`native-v2 ${rate}Hz exact ${total}-sample range retains full proof and reporting coverage`, async () => {
      const f = v2Fixture({ rate, total });
      await f.start();
      f.capture();
      f.post();
      const terminal = validate(f);
      assert.equal(
        terminal.observation.samples.length,
        Math.ceil(total / (rate / 10)),
      );
      assert.equal(
        terminal.nativeCapture.spectralWindows.length,
        Math.ceil(total / (rate / 10)),
      );
      assert.equal(
        terminal.observation.endSample - terminal.observation.startSample,
        f.geometry.totalSamples,
      );
      assert(Buffer.byteLength(JSON.stringify(terminal), "utf8") < 128 * 1024);
    });
}

test("v2 duration-weighted energy centroid and raw RMS independently match numeric references for a one-sample tail", async () => {
  const total = 9601;
  const f = v2Fixture({
    total,
    envelopeLevels: (count) =>
      count === total ? [0.95, 0.9, 0.8, 0.7] : [0.8, 0.6, 0.3, 0.2],
  });
  await f.start();
  f.capture();
  f.post();
  const terminal = validate(f);
  let previous = f.origin,
    weightedEnergy = 0,
    weightedCentroid = 0,
    plainEnergy = 0,
    plainCentroid = 0;
  const squares = [0, 0];
  terminal.nativeCapture.envelopeWindows.forEach(
    ([end, left, right], index) => {
      const count = end - previous;
      previous = end;
      squares[0] += left * left * count;
      squares[1] += right * right * count;
      const [, , centroid, energy] =
        terminal.nativeCapture.spectralWindows[index];
      const weight = (energy * count) / f.geometry.hopSamples;
      weightedEnergy += weight;
      weightedCentroid += centroid * weight;
      plainEnergy += energy;
      plainCentroid += centroid * energy;
    },
  );
  assert(
    Math.abs(
      terminal.observation.summaries.centroidHz -
        weightedCentroid / weightedEnergy,
    ) < 1e-9,
  );
  assert(
    Math.abs(
      terminal.observation.summaries.centroidHz - plainCentroid / plainEnergy,
    ) > 1,
  );
  for (let channel = 0; channel < 2; channel++) {
    const expected = 20 * Math.log10(Math.sqrt(squares[channel] / total));
    assert(
      Math.abs(terminal.observation.summaries.rmsDbfs[channel] - expected) <
        1e-10,
    );
  }
});

test("v2 native launch phase uses the actual power-of-two DSP vector rather than a hidden fixed64 assumption", async () => {
  for (const vector of [1, 32, 128, 1024]) {
    const f = v2Fixture({ vector });
    await f.start();
    f.capture();
    f.post();
    const terminal = validate(f);
    assert.equal(terminal.observation.alignment.vectorSize, vector);
    assert(terminal.nativeCapture.launched.launchPhaseSamples <= vector);
  }
});

test("v2 fifth witness selects the genuine circular-phase maximum across wrap without changing linear extrema", async () => {
  for (const rate of [44100, 48000]) {
    const f = v2Fixture({
      rate,
      geometry: { startBeat: 5.99, endBeat: 5.99 + 93 / 60 },
      policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
    });
    await f.start();
    const names = [
      "minHostOffset",
      "maxHostOffset",
      "minBeatOrigin",
      "maxBeatOrigin",
    ];
    const linearBefore = Object.fromEntries(
      names.map((name) => [name, [...f.controller.pass.timingWitnesses[name]]]),
    );
    const first = f.clock(f.origin + 700);
    const second = f.clock(f.origin + 760);
    first[5] = second[5] = 1;
    const samplesPerBeat = (rate * 60) / 93;
    const direct = (row) =>
      Math.abs(
        Math.round(row[5] * samplesPerBeat) -
          Math.round((row[1] % 1) * samplesPerBeat),
      );
    assert(direct(first) > direct(second));
    f.packet("clock", first);
    f.packet("clock", second);
    assert.deepEqual(
      Object.fromEntries(
        names.map((name) => [name, f.controller.pass.timingWitnesses[name]]),
      ),
      linearBefore,
    );
    f.capture();
    f.post();
    const terminal = validate(f);
    assert.deepEqual(
      terminal.nativeCapture.timingWitnesses.maxPhaseDisagreement,
      second,
    );
    assert.equal(
      terminal.nativeCapture.timingWitnesses.maxPhaseDisagreement[0],
      1,
    );
    assert.equal(
      terminal.observation.alignment.observedClockDisagreementSamples,
      0,
    );
    assert.equal(
      terminal.observation.alignment.observedBeatDisagreementSamples,
      rate === 44100 ? 475 : 450,
    );
    assert.equal(Object.keys(terminal.nativeCapture.timingWitnesses).length, 5);
    assert(Buffer.byteLength(JSON.stringify(terminal), "utf8") < 128 * 1024);
  }
});

test("v2 retains an actual interior phase maximum even when host offset and beat origin extrema stay unchanged", async () => {
  for (const delta of [480, 481]) {
    const f = v2Fixture({
      policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
    });
    await f.start();
    const row = f.clock(f.origin + 1024);
    const samplesPerBeat = (f.geometry.sampleRate * 60) / f.geometry.tempoBpm;
    row[5] =
      (Math.round((row[1] % 1) * samplesPerBeat) + delta) / samplesPerBeat;
    f.packet("clock", row);
    f.capture();
    f.post();
    if (delta === 481) {
      assert.equal(
        f.events.some((event) => event.status === "complete"),
        false,
      );
      continue;
    }
    const terminal = validate(f);
    assert.deepEqual(
      terminal.nativeCapture.timingWitnesses.maxPhaseDisagreement,
      row,
    );
    assert.equal(
      terminal.observation.alignment.observedClockDisagreementSamples,
      0,
    );
    assert.equal(
      terminal.observation.alignment.observedBeatDisagreementSamples,
      480,
    );
    const changed = structuredClone(terminal.nativeCapture);
    changed.timingWitnesses.maxPhaseDisagreement = changed.after.frames[0];
    assert.throws(() =>
      assertNativeCaptureObservationV2(changed, terminal.observation, {
        listenerId: "v2-listener",
        passId: V2_OWNER.passId,
        geometry: f.geometry,
        policy: f.timingPolicy,
      }),
    );
  }
});

test("native-v2 strict/descriptive alignment applies only the selected observed disagreement limit", async () => {
  for (const deviation of [0, 64, 480, 481]) {
    const f = v2Fixture({
      deviation,
      policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
    });
    await f.start();
    f.capture();
    f.post();
    if (deviation <= 480) {
      const terminal = validate(f);
      assert.equal(
        terminal.observation.alignment.observedClockDisagreementSamples,
        deviation,
      );
      assert.equal(
        terminal.observation.alignment.observedBeatDisagreementSamples,
        deviation,
      );
    } else {
      assert.equal(f.controller.pass, null);
      assert.equal(
        f.events.some((event) => event.status === "complete"),
        false,
      );
    }
  }
  const strict = v2Fixture({
    deviation: 64,
    policy: { mode: "strict", maxClockDisagreementSamples: 0 },
  });
  await strict.start();
  strict.capture();
  strict.post();
  assert.equal(
    strict.events.some((event) => event.status === "complete"),
    false,
  );
});

test("native-v2 geometry and trusted policy are strict immutable snapshots with no global auto-increase", async () => {
  const f = v2Fixture();
  const saved = structuredClone(f.command);
  f.controller.prepare(f.command);
  f.command.geometry.tempoBpm = 120;
  f.command.timingPolicy.maxClockDisagreementSamples = 480;
  assert.deepEqual(f.controller.pass.command.geometry, saved.geometry);
  assert.deepEqual(f.controller.pass.command.timingPolicy, saved.timingPolicy);
  assert(Object.isFrozen(f.controller.pass.command.geometry));
  f.controller.cancel(V2_OWNER);
  for (const policy of [
    { mode: "strict", maxClockDisagreementSamples: 1 },
    { mode: "descriptive", maxClockDisagreementSamples: 481 },
    { mode: "descriptive", maxClockDisagreementSamples: 64, extra: true },
  ])
    assert.throws(
      () => nativeV2Configuration(saved.geometry, policy),
      /invalid_native_v2/,
    );
  for (const patch of [
    { sampleRate: 96000 },
    { vectorSize: 0 },
    { vectorSize: 3 },
    { vectorSize: 2048 },
    { tempoBpm: NaN },
    { tempoBpm: 19 },
    { tempoBpm: 1000 },
    { startBeat: -1 },
    { startBeat: 1576801 },
    { endBeat: Infinity },
    { endBeat: saved.geometry.startBeat },
    { hopSamples: 4799 },
    { totalSamples: saved.geometry.hopSamples - 1 },
    { totalSamples: 1440001 },
    { totalSamples: saved.geometry.totalSamples + 1 },
    { windows: 10 },
  ])
    assert.throws(
      () =>
        nativeV2Configuration(
          { ...saved.geometry, ...patch },
          saved.timingPolicy,
        ),
      /invalid_native_v2/,
    );
});

test("v2 rejects every received tempo change independently of timing policy and retains genuine message evidence", async () => {
  for (const rate of [44100, 48000])
    for (const policy of [
      { mode: "strict", maxClockDisagreementSamples: 0 },
      { mode: "descriptive", maxClockDisagreementSamples: 64 },
      { mode: "descriptive", maxClockDisagreementSamples: 480 },
    ])
      for (const phase of [
        "preflight",
        "native-arming",
        "armed",
        "capturing",
        "postflight",
      ])
        for (const change of [-1e-6, 1e-6]) {
          const f = v2Fixture({ rate, policy });
          f.controller.prepare(f.command);
          const pending = f.controller.arm(V2_OWNER);
          const rejection = ["preflight", "native-arming"].includes(phase)
            ? assert.rejects(pending, /native_host_tempo_changed/)
            : null;
          if (phase === "preflight") f.packet("tempo", [93]);
          else f.preflight();
          if (["armed", "capturing", "postflight"].includes(phase)) {
            f.configReceipt();
            f.ack();
            await pending;
          }
          if (["capturing", "postflight"].includes(phase)) {
            f.packet("clock", f.clock(f.origin + 640));
            f.packet("envelope", f.envelope());
          }
          if (phase === "postflight") {
            f.capture();
            assert.equal(f.controller.pass.assembler.state, "covered");
          }
          const retained = f.controller.pass;
          const generation = retained.generation;
          assert.equal(f.packet("tempo", [93 + change], "foreign"), false);
          assert.equal(f.controller.pass, retained);
          f.packet("tempo", [93 + change]);
          if (rejection) await rejection;
          assert.equal(f.controller.pass, null);
          assert.equal(f.controller.state, "failed");
          assert.equal(
            f.events.some((event) => event.status === "complete"),
            false,
          );
          const evidence = f.observed.filter(
            (event) => event.type === "native-tempo-observation",
          );
          assert.equal(evidence.length, 2);
          assert.deepEqual(
            evidence.map((event) => event.stage),
            ["progress", "failed"],
          );
          const last = evidence.at(-1);
          assert.equal(last.reason, "native_host_tempo_changed");
          assert.equal(last.observationSource, "host-tempo-message");
          assert.equal(last.observedTempoBpm, 93 + change);
          assert.equal(last.firstReceivedTempoBpm, 93);
          assert.equal(last.minReceivedTempoBpm, Math.min(93, 93 + change));
          assert.equal(last.maxReceivedTempoBpm, Math.max(93, 93 + change));
          assert.equal(last.nativeCounter, undefined);
          assert.equal(last.generation, generation);
          for (const key of [
            "traceId",
            "correlationId",
            "passId",
            "connectionEpoch",
          ])
            assert.equal(last[key], f.command[key]);
          assert(last.eventId && last.causationId);
          assert.deepEqual(retained.metadata, {});
          assert.equal(retained.tempoEvidence, null);
          assert.equal(retained.envelopeWindows.length, 0);
          assert.equal(retained.frames.length, 0);
          assert.equal(f.sent.at(-1).action, "stop");
          assert.equal(f.sent.at(-1).generation, generation);
          assert.equal(f.packet("tempo", [93], generation), false);
          assert.equal(f.packet("stopped", [0, 0, 2], generation), true);
          assert.equal(f.controller.pendingDisarm, null);
        }
});

test("v2 host snapshots never substitute requested BPM for missing or changed actual tempo metadata", async () => {
  for (const missing of [true, false]) {
    const f = v2Fixture({
      policy: { mode: "descriptive", maxClockDisagreementSamples: 480 },
    });
    await f.start();
    const p = f.controller.pass;
    if (missing) delete p.metadata.tempo;
    else p.metadata.tempo.values[0] = 93 + 1e-6;
    let configured = false;
    f.controller.engine.configureHost = () => {
      configured = true;
    };
    assert.throws(
      () => f.controller.host(p),
      missing
        ? /native_host_tempo_evidence_missing/
        : /native_host_tempo_changed/,
    );
    assert.equal(configured, false);
    f.controller.cancel(V2_OWNER);
    f.packet("stopped", [0, 0, 2], p.generation);
  }
});

test("v2 initial tempo mismatch and tempo-observer failure reject arm with genuine evidence and owned cleanup", async () => {
  for (const observerFailure of [false, true]) {
    const f = v2Fixture({
      observe: (event) => {
        if (observerFailure && event.type === "native-tempo-observation")
          throw new Error("credential-shaped callback body must not escape");
      },
    });
    f.controller.prepare(f.command);
    const p = f.controller.pass;
    const pending = f.controller.arm(V2_OWNER);
    const observed = observerFailure ? 93 : 93 - 1e-6;
    f.packet("tempo", [observed]);
    await assert.rejects(
      pending,
      observerFailure ? /native_observer_failed/ : /native_host_tempo_mismatch/,
    );
    const evidence = f.observed.find(
      (event) => event.type === "native-tempo-observation",
    );
    assert.equal(evidence.firstReceivedTempoBpm, observed);
    assert.equal(evidence.minReceivedTempoBpm, observed);
    assert.equal(evidence.maxReceivedTempoBpm, observed);
    assert.equal(f.controller.pass, null);
    assert.equal(p.tempoEvidence, null);
    assert.deepEqual(p.metadata, {});
    assert.equal(f.armed.length, 0);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
    );
    assert.equal(f.sent.at(-1).action, "stop");
    assert.equal(f.sent.at(-1).generation, p.generation);
    f.packet("stopped", [0, 0, 2], p.generation);
    assert.equal(f.controller.pendingDisarm, null);
  }
});

test("v2 classic-JS tempo dedup preserves tiny changes and restored values without rounding or fabricating clock evidence", () => {
  const packets = [],
    diagnostics = [];
  const io = new NativeMessageIO(
    "clock",
    (packet) => packets.push(packet),
    () => {},
    (reason) => diagnostics.push(reason),
    2,
  );
  const generation = "11111111-1111-4111-8111-111111111111";
  assert.equal(io.begin(generation), true);
  for (const value of [93, 93 + 1e-6, 93, 93 - 1e-6, 93]) {
    assert.equal(io.packet("tempo", [value], 1), true);
    assert.equal(io.packet("tempo", [value], 1), false);
  }
  assert.deepEqual(
    packets.map((packet) => packet.slice(2)),
    [93, 93 + 1e-6, 93, 93 - 1e-6, 93].map((value) => ["tempo", value]),
  );
  assert(packets.every((packet) => packet[1] === generation));
  assert.equal(io.stop(generation), true);
  assert.equal(io.packet("tempo", [93 + 1e-6], 1), false);
  assert.deepEqual(diagnostics, []);
});

test("native-v2 malformed metadata, gaps, torn/changed holds and cancellation remain generation-owned and bounded", async () => {
  for (const kind of [
    "dsp",
    "tempo",
    "gap",
    "hold",
    "torn",
    "cancel",
    "timeout",
    "fractional-clock",
    "counter-overflow",
    "fractional-envelope",
    "invalid-rms",
    "missing-fft",
    "skipped-fft",
    "changed-spectrum",
    "envelope-queue",
  ]) {
    const f = v2Fixture();
    await f.start();
    const retained = f.controller.pass;
    if (kind === "dsp") f.packet("dsp", [1, 48000, 128]);
    if (kind === "tempo") f.packet("tempo", [120]);
    if (kind === "gap")
      f.packet("envelope", f.envelope(f.geometry.hopSamples * 2));
    if (kind === "hold") {
      f.packet("clock", f.clock(f.origin + 1000));
      const changed = f.clock(f.origin + 1000);
      changed[5] += 0.01;
      f.packet("clock", changed);
    }
    if (kind === "torn") {
      const row = f.clock(f.origin + 1000);
      row[6]++;
      for (let i = 0; i < 65; i++) f.packet("clock", row);
    }
    if (kind === "cancel") {
      assert.throws(
        () => f.controller.cancel({ ...V2_OWNER, passId: "foreign" }),
        /owner/,
      );
      f.controller.cancel(V2_OWNER);
    }
    if (kind === "timeout") {
      f.time(40000);
      f.controller.tick();
    }
    if (kind === "fractional-clock" || kind === "counter-overflow") {
      const counter = kind === "fractional-clock" ? f.origin + 1000.5 : 2 ** 44;
      f.packet("clock", f.clock(counter));
    }
    if (kind === "fractional-envelope")
      f.packet("envelope", f.envelope(f.geometry.hopSamples + 0.25));
    if (kind === "invalid-rms") {
      const row = f.envelope(f.geometry.hopSamples);
      row[10] = row[8] + 0.01;
      f.packet("envelope", row);
    }
    if (kind === "missing-fft") {
      f.packet("clock", f.clock(f.origin + f.geometry.hopSamples + 64));
      f.packet("envelope", f.envelope(f.geometry.hopSamples));
      f.time(1001);
      f.controller.tick();
    }
    if (kind === "skipped-fft") f.packet("spectrum", f.spectrum(64000 + 4096));
    if (kind === "changed-spectrum")
      f.packet("spectrum", f.spectrum(64000, 100, 1));
    if (kind === "envelope-queue")
      for (let index = 1; index <= 9; index++)
        f.packet("envelope", f.envelope(f.geometry.hopSamples * index));
    assert.equal(f.controller.pass, null, kind);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
      kind,
    );
    assert.equal(retained.envelopes.length, 0);
    assert.equal(retained.envelopeWindows.length, 0);
    assert.equal(retained.frames.length, 0);
    assert.equal(f.sent.at(-1).generation, retained.generation);
    assert.equal(
      f.controller.ingest({
        generation: retained.generation,
        type: "dsp",
        values: [1, 48000, 64],
      }),
      false,
    );
  }
});

test("v2 proof snapshots actual native envelope counters and RMS before downstream descriptor relabelling", async () => {
  for (const rate of [44100, 48000]) {
    const f = v2Fixture({ rate, total: (rate / 10) * 2 + 1 });
    await f.start();
    const reported = [];
    const ingestPacket = f.controller.ingest.bind(f.controller);
    f.controller.ingest = (packet) => {
      if (packet.type === "envelope" && packet.values[12] > 0)
        reported.push([
          packet.values[14] + packet.values[12],
          packet.values[10],
          packet.values[11],
        ]);
      return ingestPacket(packet);
    };
    const ingestDescriptor = f.controller.engine.ingest.bind(
      f.controller.engine,
    );
    f.controller.engine.ingest = (frame, owner) => {
      const accepted = ingestDescriptor(frame, owner);
      frame.sample += f.geometry.hopSamples;
      frame.rms = [0, 0];
      return accepted;
    };
    f.capture();
    f.post();
    const terminal = f.events.find((event) => event.type === "terminal");
    assert.equal(terminal?.status, "complete");
    assert.deepEqual(terminal.nativeCapture.envelopeWindows, reported);
    assert.equal(reported.length, 3);
    assert.equal(reported.at(-1)[0] - reported.at(-2)[0], 1);
    assert.equal(terminal.nativeCapture.envelopeRms, undefined);
    validate(f);
  }
});

test("v2 independent App proof rejects dropped native windows despite expected-index labels and identical RMS", async () => {
  const f = v2Fixture();
  await f.start();
  f.capture();
  f.post();
  const terminal = validate(f);
  const rows = terminal.nativeCapture.envelopeWindows;
  for (const dropped of [0, Math.floor(rows.length / 2), rows.length - 1]) {
    const changed = structuredClone(terminal.nativeCapture);
    changed.envelopeWindows.splice(dropped, 1);
    changed.envelopeWindows.push([...changed.envelopeWindows.at(-1)]);
    assert.deepEqual(
      changed.envelopeWindows.map(([, left, right]) => [left, right]),
      rows.map(([, left, right]) => [left, right]),
    );
    assert.throws(
      () =>
        assertNativeCaptureObservationV2(changed, terminal.observation, {
          listenerId: "v2-listener",
          passId: V2_OWNER.passId,
          geometry: f.geometry,
          policy: f.timingPolicy,
        }),
      /native_v2_envelope_coordinates_mismatch/,
    );
  }
});

test("v2 FFT Nyquist is rate-aware and invalid spectral metadata cannot become a completed observation", async () => {
  for (const rate of [44100, 48000]) {
    const f = v2Fixture({ rate });
    await f.start();
    f.packet("spectrum", f.spectrum(64000 + 2048, rate / 2 + 1, 1));
    assert.equal(f.controller.pass, null);
    assert.equal(
      f.events.some((event) => event.status === "complete"),
      false,
    );
    assert(
      f.events.some(
        (event) =>
          event.type === "terminal" && typeof event.reason === "string",
      ),
    );
  }
});

test("native-v2 arms only after reset receipt and emits bounded causal lifecycle after armed publication", async () => {
  const f = v2Fixture();
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  f.preflight();
  assert.equal(f.armed.length, 0);
  assert.equal(f.controller.state, "native-arming");
  f.ack();
  assert.equal(f.armed.length, 0);
  f.configReceipt();
  await pending;
  nativeArmProofV2Schema.parse(f.armed[0]);
  const seen = new Set(["v2-root"]);
  for (const event of [
    ...f.observed,
    ...f.events.filter((item) => item.type === "native-capture-stage"),
  ]) {
    assert(seen.has(event.causationId), event.causationId);
    seen.add(event.eventId);
    assert.equal(event.traceId, "v2-trace");
    assert.equal(event.correlationId, "v2-correlation");
    assert(event.elapsedMs >= 0);
  }
  f.controller.cancel(V2_OWNER);
});
