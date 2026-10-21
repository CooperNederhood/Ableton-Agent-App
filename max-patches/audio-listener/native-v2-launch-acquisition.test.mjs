import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { assertNativeCaptureObservationV2 } =
  await import("../../packages/protocol/src/native-listening-v2-schemas.ts");

const recorded = [
  {
    startBeat: 0,
    endBeat: 4,
    totalSamples: 96000,
    anchor: [
      0, 0, 102350336, 31, 102350272, 0.013333333333332, 102350272, 0, 0,
      102350336, 31,
    ],
    row: [
      1, 0, 102465536, 31, 102465472, 0.013333333333332, 102465472, 1, 0,
      102465536, 31,
    ],
  },
  {
    startBeat: 4,
    endBeat: 12,
    totalSamples: 192000,
    anchor: [
      0, 4, 99554816, 31, 99554752, 0.757333333333334, 99554752, 0, 4, 99554816,
      31,
    ],
    row: [
      1, 4.002666666666666, 99676224, 31, 99676192, 0.757333333333334, 99676192,
      1, 4.002666666666666, 99676224, 31,
    ],
  },
];

for (const evidence of recorded) {
  test(`recorded ${evidence.startBeat}-${evidence.endBeat} first-playing row cannot become capture timing evidence while its signal phase is still stopped`, () => {
    const f = v2Fixture({
      geometry: {
        sampleRate: 48000,
        vectorSize: 64,
        tempoBpm: 120,
        startBeat: evidence.startBeat,
        endBeat: evidence.endBeat,
        totalSamples: evidence.totalSamples,
      },
    });
    f.controller.prepare(f.command);
    const p = f.controller.pass;
    f.controller.state = "armed";
    p.anchorClock = evidence.anchor;
    p.anchorHostOffset = evidence.anchor[2] - evidence.anchor[4];
    // Only the anchor and rejected row are recorded; this nearby stopped
    // predecessor models continuous polling without inventing a recorded row.
    const stopped = [...evidence.row];
    stopped[0] = stopped[7] = 0;
    stopped[1] = stopped[8] = evidence.startBeat;
    for (const index of [2, 4, 6, 9]) stopped[index] -= 64;
    p.clock = stopped;
    f.controller.clock(p, evidence.row);
    assert.equal(p.rejected, 1);
    assert.deepEqual(p.clock, stopped);
    assert.equal(p.timingWitnesses.maxPhaseDisagreement, undefined);
    assert.equal(p.timingWitnesses.minBeatOrigin, undefined);
    assert.equal(p.nativeFailureDiagnostic, null);
    const progress = f.observed.find(
      (event) => event.reason === "native_launch_phase_pending",
    );
    assert(progress);
    assert.equal(progress.generation, p.generation);
    assert.equal(progress.traceId, f.command.traceId);
    assert.equal(progress.correlationId, f.command.correlationId);
    assert.equal(progress.passId, f.command.passId);
    assert(progress.elapsedMs >= 0);
    f.controller.cancel(V2_OWNER);
    f.packet("stopped", [0, 0, 2], p.generation);
  });
}

async function armedFixture(options = {}) {
  const f = v2Fixture({
    stoppedPhase: 0.757333333333334,
    geometry: { tempoBpm: 120, startBeat: 4, endBeat: 6 },
    ...options,
  });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  f.preflight();
  f.configReceipt();
  f.ack();
  await pending;
  return f;
}

function pendingClock(f, counter = f.origin + 32) {
  const row = f.clock(counter);
  row[5] = f.controller.pass.clock[5];
  return row;
}

for (const startBeat of [0, 0.25, 4]) {
  test(`a launch packet before phase advancement at beat ${startBeat} waits, then completes independently verified native coverage`, async () => {
    const f = await armedFixture({
      geometry: { tempoBpm: 120, startBeat, endBeat: startBeat + 2 },
    });
    const p = f.controller.pass;
    f.packet("clock", pendingClock(f));
    f.packet("envelope", f.envelope());
    assert.equal(f.controller.state, "armed");
    assert.equal(f.controller.engine.pass.startSample, null);
    assert(f.controller.pass.launchPacket);
    f.packet("clock", f.clock(f.origin + 640));
    assert.equal(f.controller.state, "capturing");
    f.capture();
    f.post();
    const completed = f.events.find(
      (event) => event.type === "terminal" && event.status === "complete",
    );
    assert(completed);
    assert.equal(
      completed.observation.endSample - completed.observation.startSample,
      f.geometry.totalSamples,
    );
    assert(
      completed.observation.alignment.observedBeatDisagreementSamples <= 64,
    );
    assert.equal(
      f.events.filter((event) => event.type === "terminal").length,
      1,
    );
    assertNativeCaptureObservationV2(
      completed.nativeCapture,
      completed.observation,
      {
        listenerId: "v2-listener",
        passId: f.command.passId,
        policy: f.timingPolicy,
        geometry: f.geometry,
      },
    );
    f.packet("stopped", [0, 0, 2], p.generation);
    assert.equal(f.controller.pendingDisarm, null);
  });
}

test("a never-advancing launch phase fails at the existing bounded rejection limit", async () => {
  const f = await armedFixture();
  const p = f.controller.pass;
  for (let index = 0; index < 65; index++)
    f.packet("clock", pendingClock(f, f.origin + 32 + index * 64));
  assert.equal(f.controller.state, "failed");
  assert(
    f.events.some(
      (event) =>
        event.type === "terminal" &&
        event.reason === "native_preflight_rejection_limit",
    ),
  );
  assert.equal(f.events.filter((event) => event.type === "terminal").length, 1);
  assert.equal(f.controller.engine.pass, null);
  f.packet("stopped", [0, 0, 2], p.generation);
  assert.equal(f.controller.pendingDisarm, null);
});

test("a changing but incorrect launch phase is not excused as stopped-phase acquisition", async () => {
  const f = await armedFixture();
  const row = f.clock(f.origin + 640);
  row[5] = (row[5] + 0.1) % 1;
  f.packet("clock", row);
  f.packet("envelope", f.envelope());
  assert.equal(f.controller.state, "failed");
  assert(
    f.events.some(
      (event) =>
        event.type === "terminal" &&
        event.reason === "listening_alignment_budget_exceeded",
    ),
  );
});

test("strict-zero still rejects host-clock drift during launch acquisition", async () => {
  const f = await armedFixture({
    policy: { mode: "strict", maxClockDisagreementSamples: 0 },
  });
  const row = pendingClock(f);
  row[2]++;
  row[9]++;
  f.packet("clock", row);
  assert.equal(f.controller.state, "failed");
  assert(
    f.events.some(
      (event) =>
        event.type === "terminal" &&
        event.reason === "listening_alignment_budget_exceeded",
    ),
  );
});

test("cancellation while awaiting phase disarms once and cannot leak a launch into a replacement generation", async () => {
  const f = await armedFixture();
  const p = f.controller.pass;
  f.packet("clock", pendingClock(f));
  f.packet("envelope", f.envelope());
  assert(p.launchPacket);
  f.controller.cancel(V2_OWNER);
  assert.equal(f.controller.state, "cancelled");
  assert.equal(f.events.filter((event) => event.type === "terminal").length, 1);
  assert.equal(f.controller.engine.pass, null);
  assert.equal(p.launchPacket, null);
  f.packet("stopped", [0, 0, 2], p.generation);
  assert.equal(f.controller.pendingDisarm, null);
  f.controller.prepare({ ...f.command, passId: "replacement-pass" });
  const replacement = f.controller.pass;
  assert.notEqual(replacement.generation, p.generation);
  f.packet("clock", f.clock(f.origin + 640), p.generation);
  f.packet("envelope", f.envelope(), p.generation);
  assert.equal(replacement.clock, undefined);
  assert.equal(replacement.launchPacket, undefined);
  f.controller.cancel({ ...V2_OWNER, passId: "replacement-pass" });
  f.packet("stopped", [0, 0, 2], replacement.generation);
  assert.equal(f.controller.pendingDisarm, null);
});
