import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { URL } from "node:url";
import {
  nativeRejectionCoverage,
  nativeRejectionGuardInventory,
} from "./native-rejection-inventory.mjs";
const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { nativeFailureDiagnosticV2Schema } =
  await import("../../packages/signal-routing/src/listener-v2-contracts.ts");

function streams(f, elapsed, missing) {
  f.time(elapsed);
  const counter = f.armCounter + elapsed * 48;
  if (elapsed % 50 === 0)
    for (const [type, values] of [
      ["dsp", [1, 48000, 64]],
      ["tempo", [128]],
      ["fftInfo", [2048, 2048, 2048, 1]],
      ["abi-clock", [2]],
      ["abi-envelope", [2]],
      ["abi-spectrum", [2]],
    ])
      f.packet(type, values);
  f.packet(
    "envelope-state",
    [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 2],
  );
  if (elapsed % 40 === 0 && missing !== "spectrum")
    f.packet(
      "spectrum",
      f.spectrum(
        Math.floor(counter / 2048) * 2048 +
          (missing === "future-spectrum" ? 4096 : 0),
        0,
        0,
      ),
    );
  f.packet("clock", f.clock(counter, false));
}
async function rejection(missing) {
  const f = v2Fixture({
    retainedMeasurements: true,
    total: 90000,
    geometry: { tempoBpm: 128, startBeat: 0, endBeat: 4 },
  });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  const p = f.controller.pass;
  const rejected = pending.catch((error) => error);
  for (const family of [1, 2]) {
    f.packet("retention-state", [
      family,
      0,
      p.nativeEpoch,
      1,
      0,
      0,
      family === 1 ? 16 : 32,
      0,
      0,
      0,
    ]);
    f.packet("retention-state", [
      family,
      1,
      p.nativeEpoch,
      1,
      0,
      0,
      family === 1 ? 16 : 32,
      0,
      0,
      0,
    ]);
    if (!(family === 2 && missing === "retention-spectrum"))
      f.packet("retention-ready", [family, 1, p.nativeEpoch]);
  }
  for (let elapsed = 0; elapsed <= 1010; elapsed += 10)
    streams(f, elapsed, missing);
  const error = await rejected;
  assert.equal(error.message, "stale_native_preflight");
  return { f, p, error, diagnostic: error.nativeFailureDiagnostic };
}

for (const missing of ["spectrum", "retention-spectrum", "future-spectrum"])
  test(`independent preflight ${missing} rejection preserves exact first-owner operands before cleanup`, async () => {
    const { f, p, diagnostic } = await rejection(missing);
    nativeFailureDiagnosticV2Schema.parse(diagnostic);
    const e = diagnostic.checkEvidence;
    assert.equal(diagnostic.scope, "native-check-rejection/v1");
    assert.equal(diagnostic.generation, p.generation);
    assert.equal(e.owner, "controller");
    assert.equal(e.phase, "preflight");
    assert.equal(e.check, "preflight-source-span");
    assert.equal(e.elapsedMs, 1010);
    assert.equal(e.deadlineMs, 2000);
    assert.equal(e.preflight.actualSpanSamples, 48480);
    assert.equal(e.preflight.maximumSpanSamples, 48000);
    assert.equal(e.preflight.firstClock[4], 65536);
    assert.equal(e.preflight.lastClock[4], 114016);
    assert.equal(e.preflight.clockCount, 32);
    assert.equal(
      e.preflight.prerequisites.retentionSpectrumReady,
      missing !== "retention-spectrum",
    );
    assert.equal(
      e.preflight.prerequisites.spectrumPresent,
      missing !== "spectrum",
    );
    assert.equal(e.preflight.ages.clockMs, 0);
    assert.equal(e.preflight.ages.maximumMs, 1000);
    assert.equal(
      e.operands.find((o) => o.field === "fft-clock-distance").relation,
      "less-than",
    );
    assert.equal(
      e.operands.find((o) => o.field === "fft-clock-distance").expected,
      2048,
    );
    assert.equal(e.preflight.maximumClockMinusSpectrumSamplesExclusive, 2048);
    assert.equal(e.preflight.clockEndSample, e.preflight.lastClock[4]);
    assert.equal(
      e.preflight.clockMinusSpectrumSamples,
      missing === "spectrum"
        ? null
        : e.preflight.clockEndSample - e.preflight.spectrumEndSample,
    );
    assert.deepEqual(
      e.operands.find((o) => o.field === "source-span"),
      {
        field: "source-span",
        actual: 48480,
        expected: 48000,
        relation: "at-most",
        unit: "samples",
        domain: "native-source",
      },
    );
    assert.equal(e.launch, "not-attempted");
    assert.equal(
      e.operands.some((operand) => operand.field.startsWith("post-")),
      false,
    );
    assert.equal(e.rejected.type, "clock");
    assert.equal(e.rejected.cells[4], 114016);
    assert(e.clockCounts.received >= 102);
    if (missing !== "future-spectrum")
      assert(e.coverage.missing.includes(missing));
    if (missing === "future-spectrum") {
      const cohortCounter = e.operands.find(
        (o) => o.field === "preflight-cohort-clock",
      ).actual;
      assert.equal(
        e.operands.find((o) => o.field === "fft-clock-distance").actual,
        cohortCounter - e.preflight.spectrumEndSample,
      );
      assert.equal(cohortCounter, e.preflight.lastClock[4] - 480);
      assert.equal(
        e.operands.find((o) => o.field === "preflight-cohort-age").actual,
        480,
      );
      assert.equal(e.preflight.clockMinusSpectrumSamples, -2720);
    }
    assert.equal(
      e.preflightWaits.last.check,
      {
        spectrum: "spectrum",
        "retention-spectrum": "retention-spectrum",
        "future-spectrum": "fft-future",
      }[missing],
    );
    assert(Object.isFrozen(e));
    const before = JSON.stringify(diagnostic);
    f.packet("stopped", [0, 0, 2], p.generation);
    f.packet("clock", f.clock(1), p.generation);
    assert.equal(JSON.stringify(diagnostic), before);
    assert.equal(f.controller.pendingDisarm, null);
    assert.equal(
      f.sent.some((v) => v.action === "configure_v2"),
      false,
    );
  });

test("malformed private input has bounded markers and does not silently become missing evidence", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER);
  f.packet("clock", [NaN, "credential=not-a-value", ...Array(50).fill(0)]);
  const error = await pending.catch((e) => e);
  const d = nativeFailureDiagnosticV2Schema.parse(
    error.nativeFailureDiagnostic,
  );
  assert.equal(d.checkEvidence.reason, "invalid_native_io_packet");
  assert.equal(d.checkEvidence.rejected.cells.length, 30);
  assert.equal(d.checkEvidence.rejected.cells[0], "non-finite");
  assert.equal(d.checkEvidence.rejected.cells[1], "not-number");
  assert.equal(d.checkEvidence.rejected.truncated, true);
  assert(!JSON.stringify(d).includes("credential"));
});

test("preparation denial has no invented generation and does not disturb an existing owner", () => {
  const f = v2Fixture({ retainedMeasurements: true });
  assert.throws(
    () =>
      f.controller.prepare({
        ...f.command,
        geometry: { ...f.geometry, tempoBpm: 0 },
      }),
    (error) => {
      const d = nativeFailureDiagnosticV2Schema.parse(
        error.nativeFailureDiagnostic,
      );
      assert.equal(d.generation, null);
      assert.equal(d.checkEvidence.phase, "preparation");
      assert.equal(d.checkEvidence.rejected.type, "config");
      return true;
    },
  );
  f.controller.prepare(f.command);
  const p = f.controller.pass;
  assert.throws(
    () => f.controller.prepare(f.command),
    (error) => {
      nativeFailureDiagnosticV2Schema.parse(error.nativeFailureDiagnostic);
      return true;
    },
  );
  assert.equal(f.controller.pass, p);
  assert.equal(p.checkEvidence, undefined);
});

test("engine partial rejection retains engine ownership and its exact descriptor distance", async () => {
  const f = v2Fixture({ retainedMeasurements: true });
  await f.start();
  const p = f.controller.pass;
  f.time(1001);
  f.controller.tick();
  const terminal = f.events.find((e) => e.type === "terminal");
  assert.equal(terminal.status, "partial");
  assert.equal(terminal.reason, "host_timing_stale");
  nativeFailureDiagnosticV2Schema.parse(terminal.nativeFailureDiagnostic);
  assert.equal(terminal.nativeFailureDiagnostic.checkEvidence.owner, "engine");
  assert.equal(terminal.nativeFailureDiagnostic.checkEvidence.phase, "capture");
  assert.equal(p.closed, true);
});

for (const rate of [44100, 48000])
  test(`clock flags ${rate}: source evidence identifies exact rejected bitmask without changing failure`, async () => {
    const f = v2Fixture({ retainedMeasurements: true, rate });
    f.controller.prepare(f.command);
    const pending = f.controller.arm(V2_OWNER);
    const row = f.clock(f.armCounter, false);
    row[3] = 16;
    row[10] = 16;
    f.packet("clock", row);
    const error = await pending.catch((e) => e);
    assert.equal(error.message, "invalid_native_clock");
    const d = nativeFailureDiagnosticV2Schema.parse(
      error.nativeFailureDiagnostic,
    );
    assert.deepEqual(
      d.checkEvidence.operands.find((o) => o.field === "host-flags"),
      {
        field: "host-flags",
        actual: 16,
        expected: 19,
        relation: "contains-all-bits",
        unit: "flags",
        domain: "host-position",
      },
    );
    assert.deepEqual(d.checkEvidence.geometry, f.geometry);
    assert.deepEqual(d.checkEvidence.policy, f.command.timingPolicy);
    assert.equal(d.checkEvidence.rejected.cells[3], 16);
  });

test("source rejection inventory covers every phase and all IO failure sites are explicitly classified", () => {
  assert.deepEqual(
    new Set(nativeRejectionCoverage.map((v) => v.phase)),
    new Set([
      "preparation",
      "preflight",
      "arm",
      "launch",
      "capture",
      "post-binding",
      "cleanup",
      "publication",
    ]),
  );
  for (const row of nativeRejectionCoverage)
    for (const file of row.tests)
      assert(existsSync(new URL(file, import.meta.url)), file);
  const sites = nativeRejectionGuardInventory();
  assert(sites.length > 30);
  assert(sites.some((site) => site.check === "stale_native_preflight"));
  const { IO_REJECTION_CHECKS } = require("./audio_listener_native_io.js");
  const source = readFileSync(
    new URL("./audio_listener_native_io.js", import.meta.url),
    "utf8",
  );
  const calls = [...source.matchAll(/this\.fail\(([^)]*)\)/g)];
  // V5 adds one common quiescence-failure carrier, without changing the
  // eighteen legacy sites or their numeric guard indices.
  assert.equal(calls.length, 19);
  assert.equal(
    calls.filter((call) => call[1] === '"stop-quiescence"').length,
    1,
  );
  for (const call of calls) {
    const name = /^["']([^"']+)["']$/.exec(call[1].trim())?.[1];
    assert(
      IO_REJECTION_CHECKS.includes(name),
      `unclassified IO guard: ${call[0]}`,
    );
    assert.notEqual(name, "unavailable");
  }
});
