import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { nativeFailureDiagnosticV2Schema } =
  await import("../../packages/signal-routing/src/listener-v2-contracts.ts");

for (const tempo of [120, 128])
  test(`${tempo} BPM: withheld FFTs overflow unchanged controller bound with exact join operands`, async () => {
    const f = v2Fixture({
      retainedMeasurements: true,
      total: 96000,
      geometry: {
        tempoBpm: tempo,
        startBeat: 0,
        endBeat: (96000 * tempo) / (48000 * 60),
      },
    });
    await f.start();
    const pass = f.controller.pass;
    for (let hop = 1; hop <= 9; hop++) {
      f.time(hop * 100);
      f.packet("clock", f.clock(f.origin + hop * 4800 + 64));
      f.packet("envelope", f.envelope(hop * 4800));
    }
    const terminal = f.events.find((e) => e.type === "terminal");
    assert.equal(terminal.reason, "native_envelope_buffer_overflow");
    const d = terminal.nativeFailureDiagnostic;
    assert.ok(d);
    assert.equal(d.check, "controller-envelope-overflow");
    assert.equal(d.blocker, "spectrum-behind");
    assert.equal(d.controllerPending, 8);
    assert.deepEqual(
      d.checkEvidence.operands.find((o) => o.field === "envelope-pending"),
      {
        field: "envelope-pending",
        actual: 8,
        expected: 8,
        relation: "less-than",
        unit: "count",
        domain: "native-source",
      },
    );
    assert.equal(d.assemblerPending, 0);
    assert.equal(d.completedMeasurements, 0);
    assert.equal(d.firstEnvelopeEndCounter, f.origin + 4800);
    assert.equal(d.rejectedEnvelopeEndCounter, f.origin + 9 * 4800);
    assert.equal(d.clock[4], f.origin + 9 * 4800 + 64);
    assert.equal(d.clockAgeMs, 0);
    assert.deepEqual(d.latestSpectrum, f.spectrum(64000, 0, 0));
    assert.equal(d.availableSpectrum, null);
    assert.equal(d.generation, pass.generation);
    assert.deepEqual(nativeFailureDiagnosticV2Schema.parse(d), d);
    assert(Object.isFrozen(d.clock));
    assert.equal(pass.envelopes.length, 0);
    assert.equal(f.sent.at(-1).outcome, "failed");
    assert.equal(
      f.events.some((e) => e.status === "complete"),
      false,
    );
    const saved = JSON.stringify(d);
    f.packet("stopped", [0, 0, 2], pass.generation);
    await f.start();
    assert.notEqual(f.controller.pass.generation, pass.generation);
    assert.equal(f.controller.pass.nativeFailureDiagnostic, null);
    f.capture();
    f.post();
    assert.equal(f.events.at(-1).status, "complete");
    assert.equal(JSON.stringify(d), saved);
  });

test("assembler overflow is distinguished and snapshots its queue before abort clears it", async () => {
  const f = v2Fixture({ retainedMeasurements: true, total: 96000 });
  await f.start();
  const pass = f.controller.pass;
  assert.throws(() => {
    for (let hop = 1; hop <= 9; hop++)
      pass.assembler.pushEnvelope(
        {
          nativeEpoch: pass.nativeEpoch,
          armCounter: f.armCounter,
          originCounter: f.origin,
          endCounter: f.origin + hop * 4800,
          peak: [0.8, 0.6],
          rms: [0.3, 0.2],
        },
        pass.owner,
      );
  }, /native_envelope_buffer_overflow/);
  const d = f.events.find((e) => e.type === "terminal").nativeFailureDiagnostic;
  assert.equal(d.check, "assembler-envelope-overflow");
  assert.equal(d.assemblerPending, 8);
  assert.deepEqual(
    d.checkEvidence.operands.find((o) => o.field === "assembler-pending"),
    {
      field: "assembler-pending",
      actual: 8,
      expected: 8,
      relation: "less-than",
      unit: "count",
      domain: "native-source",
    },
  );
  assert.equal(d.controllerPending, 0);
  assert.equal(d.firstEnvelopeEndCounter, f.origin + 4800);
  assert.equal(d.blocker, "spectrum-behind");
  assert.equal(pass.assembler.pending.length, 0);
  assert.deepEqual(nativeFailureDiagnosticV2Schema.parse(d), d);
});

test("assembler spectrum pre-append overflow preserves the failing strict capacity tuple", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  const p = f.controller.pass;
  while (p.assembler.spectra.length < 128)
    p.assembler.pushSpectrum(
      f.spectrum((p.assembler.lastSpectrum?.end ?? 64000) + 2048),
      p.owner,
    );
  assert.throws(
    () =>
      p.assembler.pushSpectrum(
        f.spectrum(p.assembler.lastSpectrum.end + 2048),
        p.owner,
      ),
    /native_spectrum_buffer_overflow/,
  );
  const d = f.events.find((e) => e.type === "terminal").nativeFailureDiagnostic;
  assert.deepEqual(
    d.checkEvidence.operands.find((o) => o.field === "spectrum-pending"),
    {
      field: "spectrum-pending",
      actual: 128,
      expected: 128,
      relation: "less-than",
      unit: "count",
      domain: "native-source",
    },
  );
  nativeFailureDiagnosticV2Schema.parse(d);
});

for (const condition of ["clock-behind", "clock-stale", "clock-stopped"])
  test(`join rejection distinguishes ${condition} without accepting or resizing pending envelopes`, async () => {
    const f = v2Fixture({ retainedMeasurements: true, total: 96000 });
    await f.start();
    const pass = f.controller.pass;
    if (condition === "clock-stopped") {
      // Freeze a validated stopped clock at the owning join boundary.
      pass.clock = f.clock(f.armCounter, false);
    }
    if (condition === "clock-stale") f.time(1001);
    for (let hop = 1; hop <= 9; hop++)
      f.packet("envelope", f.envelope(hop * 4800));
    const terminal = f.events.find((e) => e.type === "terminal");
    assert.equal(terminal.reason, "native_envelope_buffer_overflow");
    const d = terminal.nativeFailureDiagnostic;
    assert.equal(d.blocker, condition);
    assert.equal(d.controllerPending, 8);
    assert.deepEqual(nativeFailureDiagnosticV2Schema.parse(d), d);
  });

test("ordinary independent spectrum delivery drains envelopes and does not produce a rejection", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  f.capture();
  f.post();
  const terminal = f.events.find((e) => e.type === "terminal");
  assert.equal(terminal.status, "complete");
  assert.equal(terminal.nativeFailureDiagnostic, undefined);
});

test("cancelled stalled join discards queues and a fresh generation can complete", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  const old = f.controller.pass;
  for (let hop = 1; hop <= 3; hop++) {
    f.packet("clock", f.clock(f.origin + hop * 4800 + 64));
    f.packet("envelope", f.envelope(hop * 4800));
  }
  f.controller.cancel(V2_OWNER);
  assert.equal(old.envelopes.length, 0);
  assert.equal(old.nativeFailureDiagnostic.checkEvidence.reason, "cancelled");
  assert.equal(old.nativeFailureDiagnostic.checkEvidence.owner, "controller");
  f.packet("stopped", [0, 0, 2], old.generation);
  await f.start();
  assert.notEqual(f.controller.pass.generation, old.generation);
  f.capture();
  f.post();
  assert.equal(f.events.at(-1).status, "complete");
});

test("late insufficient post clocks preserve exact rejected counter and covered queue state", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  f.capture();
  const pass = f.controller.pass;
  const end = f.origin + f.geometry.totalSamples;
  for (let i = 0; i < 30; i++) f.packet("clock", f.clock(end + 128 + i * 64));
  f.packet("clock", f.clock(end + 48064));
  const terminal = f.events.find((e) => e.type === "terminal");
  assert.equal(terminal.reason, "stale_native_post_binding");
  const d = terminal.nativeFailureDiagnostic;
  assert.equal(d.check, "post-binding");
  assert.equal(d.postClockCount, 31);
  assert.equal(d.postFirstCounter, end + 64);
  assert.equal(d.rejectedClock[4], end + 48064);
  assert.equal(d.completedMeasurements, 10);
  assert.deepEqual(nativeFailureDiagnosticV2Schema.parse(d), d);
  assert.equal(pass.post.length, 0);
});
