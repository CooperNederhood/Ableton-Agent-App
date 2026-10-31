import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");

async function delayedTail(tempo, beats, delay, options = {}) {
  const rate = 48000;
  const total = ((rate * 60) / tempo) * beats;
  const f = v2Fixture({
    retainedMeasurements: true,
    rate,
    total,
    policy: options.policy,
    geometry: { tempoBpm: tempo, startBeat: 0, endBeat: beats },
  });
  await f.start();
  const pass = f.controller.pass;
  let nextFFT = 66048;
  let count = f.geometry.hopSamples;
  const finalAt = ((total - 640) / rate) * 1000 + delay;
  for (
    let time = 10;
    time <= (total / rate) * 1000 + delay + 1500;
    time += 10
  ) {
    f.time(time);
    const counter = f.origin + 640 + (time * rate) / 1000;
    if (!options.omitPost || counter < f.origin + total)
      f.packet("clock", f.clock(counter));
    if (!f.controller.pass) break;
    while (nextFFT <= counter) {
      f.packet("spectrum", f.spectrum(nextFFT));
      nextFFT += 2048;
    }
    while (count <= total && f.origin + count <= counter) {
      if (count === total && time < finalAt) break;
      f.packet("envelope", f.envelope(count));
      if (count === total) {
        count = Infinity;
        break;
      }
      count = Math.min(count + f.geometry.hopSamples, total);
    }
    if (options.cancelAt !== undefined && time >= options.cancelAt) {
      f.controller.cancel(V2_OWNER);
      break;
    }
    f.controller.tick();
    if (!f.controller.pass) break;
  }
  return { f, pass, terminal: f.events.find((e) => e.type === "terminal") };
}

for (const [tempo, beats] of [
  [128, 4],
  [120, 8],
])
  for (const delay of [0, 400, 700, 900])
    test(`${tempo} BPM ${beats} beats: independent 10ms clocks preserve post proof with final descriptor lag ${delay}ms`, async () => {
      const { f, pass, terminal } = await delayedTail(tempo, beats, delay);
      assert.equal(terminal?.status, "complete", terminal?.reason);
      assert.equal(
        terminal.observation.endSample - terminal.observation.startSample,
        ((48000 * 60) / tempo) * beats,
      );
      const rows = terminal.nativeCapture.after.frames;
      assert.equal(rows.length, 32);
      assert(rows[0][4] >= f.origin + f.geometry.totalSamples);
      assert(rows.at(-1)[4] - (f.origin + f.geometry.totalSamples) <= 48000);
      assert(Object.isFrozen(terminal.nativeCapture.after));
      assert.equal(pass.closed, true);
      assert.equal(f.sent.at(-1).action, "stop");
      assert.equal(f.sent.at(-1).outcome, "complete");
    });

test("missing post clocks cannot become completed proof despite delayed descriptors", async () => {
  const { terminal } = await delayedTail(128, 4, 700, { omitPost: true });
  assert.notEqual(terminal?.status, "complete");
  assert.ok(terminal);
});

for (const [tempo, beats] of [
  [128, 4],
  [120, 8],
])
  test(`${tempo} BPM: strict alignment retains its original budget with delayed-tail post acquisition`, async () => {
    const { terminal } = await delayedTail(tempo, beats, 900, {
      policy: { mode: "strict", maxClockDisagreementSamples: 0 },
    });
    assert.equal(terminal.status, "complete", terminal.reason);
    assert.equal(
      terminal.observation.alignment.policy.maxClockDisagreementSamples,
      0,
    );
  });

test("excessive descriptor age remains rejected even with a complete timely post bracket", async () => {
  const { terminal } = await delayedTail(128, 4, 2000);
  assert.notEqual(terminal?.status, "complete");
  assert.ok(terminal);
});

test("invalid post clock cannot become proof and missing-clock timeout keeps exact diagnostics", async () => {
  const invalid = v2Fixture({ retainedMeasurements: true });
  await invalid.start();
  invalid.capture();
  const bad = invalid.clock(
    invalid.origin + invalid.geometry.totalSamples + 128,
  );
  bad[4] = -1;
  invalid.packet("clock", bad);
  assert.equal(
    invalid.events.some((e) => e.status === "complete"),
    false,
  );
  assert.equal(invalid.controller.pass, null);
  const missing = v2Fixture({ retainedMeasurements: true });
  await missing.start();
  missing.capture();
  missing.time(2000);
  missing.controller.tick();
  const terminal = missing.events.find((e) => e.type === "terminal");
  assert.equal(terminal.reason, "native_post_binding_timeout");
  assert.equal(terminal.nativeFailureDiagnostic.postClockCount, 1);
  assert.equal(terminal.nativeFailureDiagnostic.coverageAgeMs, 2000);
  assert.equal(terminal.nativeFailureDiagnostic.rejectedClock, null);
});

test("cancellation while post clocks precede the delayed tail discards unpublished proof", async () => {
  const { f, pass, terminal } = await delayedTail(128, 4, 900, {
    cancelAt: 2200,
  });

  test("post-binding validation failure retains its exact bracket without publishing a completed context", async () => {
    const f = v2Fixture({ retainedMeasurements: true });
    await f.start();
    f.capture();
    f.controller.engine.confirmNativeHost = () => {
      throw Error("invalid_native_post_binding");
    };
    f.post();
    const terminal = f.events.find((e) => e.type === "terminal");
    assert.equal(terminal.reason, "invalid_native_post_binding");
    const d = terminal.nativeFailureDiagnostic;
    assert.equal(d.check, "post-binding");
    assert.equal(d.blocker, "post-clock-invalid");
    assert.equal(d.postClockCount, 32);
    assert.equal(d.checkEvidence.phase, "post-binding");
    assert.equal(
      d.checkEvidence.operands.find(
        (operand) => operand.field === "post-clock-count",
      ).actual,
      32,
    );
    assert.equal(d.rejectedClock[4], d.postLastCounter);
    assert.equal(
      f.events.some((e) => e.status === "complete"),
      false,
    );
  });
  assert.equal(terminal.status, "cancelled");
  assert.equal(f.controller.pass, null);
  assert.deepEqual(pass.post, []);
  assert.equal(
    f.events.some((e) => e.status === "complete"),
    false,
  );
  assert.equal(f.sent.at(-1).outcome, "cancelled");
});
