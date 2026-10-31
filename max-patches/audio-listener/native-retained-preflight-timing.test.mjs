import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { genModel } from "./gen-model.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";
import { retainedNativeSpectrumSource } from "./retained-native-source.mjs";

const require = createRequire(import.meta.url);
const { v2Fixture, V2_OWNER } = require("./native-v2-fixture.cjs");
const { NativeMessageIO } = require("./audio_listener_native_io.js");

function spectrumReadbackOffset() {
  const fft = nativeRuntimeDocuments({ nativeVersion: 4 })[
    "audio_listener_native_fft.maxpat"
  ];
  const readback = fft.patcher.boxes.find(
    ({ box }) => box.id === "measurementReadback",
  ).box.patcher;
  const snapshot = readback.boxes.find(({ box }) => box.id === "snapshot").box;
  const match = /^mc\.snapshot~ @offset (\d+)$/.exec(snapshot.text);
  assert(match, snapshot.text);
  return Number(match[1]);
}

// FFT processing and Param application happen in whole spectral vectors.
// Root clocks and readback polls are independent message-rate observations.
// This executes shipping Gen/IO/reader/controller logic, not Max's scheduler.
async function preflight({
  offset = spectrumReadbackOffset(),
  deliverySamples = 64,
  stopPublishing = false,
  tornClockAt = null,
  startPlayingAt = null,
} = {}) {
  const f = v2Fixture({ retainedMeasurements: true });
  f.controller.prepare(f.command);
  const pending = f.controller.arm(V2_OWNER).catch((error) => error);
  const p = f.controller.pass;
  const source = retainedNativeSpectrumSource();
  const model = genModel(source.code, source.outputs);
  const parameters = {};
  let sample = 0;
  const io = new NativeMessageIO(
    "spectrum",
    (packet) =>
      f.controller.ingest({
        generation: packet[1],
        type: packet[2],
        values: packet.slice(3),
      }),
    ([name, value]) => {
      parameters[name] = value;
    },
    (reason) => assert.fail(reason),
    2,
    { retainedMeasurements: true, now: () => sample / 48 },
  );
  assert.equal(io.begin(p.generation, p.nativeEpoch, 48000), true);
  for (const [type, values] of [
    ["dsp", [1, 48000, 64]],
    ["tempo", [f.geometry.tempoBpm]],
    ["fftInfo", [2048, 2048, 2048, 1]],
    ["abi-clock", [2]],
    ["abi-envelope", [2]],
    ["abi-spectrum", [2]],
  ])
    f.packet(type, values);
  for (const stage of [0, 1])
    f.packet("retention-state", [
      1,
      stage,
      p.nativeEpoch,
      1,
      0,
      0,
      16,
      0,
      0,
      0,
    ]);
  f.packet("retention-ready", [1, 1, p.nativeEpoch]);
  let page;
  let frame = 0;
  const observedClocks = new Set();
  for (; sample <= 49000 && f.controller.state === "preflight"; sample++) {
    f.time(sample / 48);
    if (
      sample === (frame + 1) * 2048 + deliverySamples &&
      !(stopPublishing && frame > 0)
    ) {
      model.configure(parameters);
      for (const name of Object.keys(parameters)) delete parameters[name];
      for (let bin = 0; bin < 2048; bin++) {
        const counter = f.armCounter + frame * 2048 + bin;
        const output = model.step(
          0,
          0,
          0,
          0,
          bin,
          counter % 1048576,
          Math.floor(counter / 1048576),
        );
        if (bin === offset) page = output.slice(11);
      }
      frame++;
    }
    if (sample % 480 === 0) {
      f.packet(
        "envelope-state",
        [0, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, -1, -1, 2],
      );
      const row = f.clock(
        f.armCounter + Math.floor(sample / 64) * 64 - 1,
        startPlayingAt !== null && sample >= startPlayingAt,
      );
      if (sample === tornClockAt) row[9] += 64;
      else observedClocks.add(JSON.stringify(row));
      f.packet("clock", row);
    }
    if (sample % 480 === 32 && page) io.retainedFrame(page);
  }
  const result = {
    state: f.controller.state,
    elapsedMs: sample / 48,
    clockCount: p.frames.length,
    clockGap:
      p.before && p.spectrum ? p.before.frames.at(-1)[4] - p.spectrum[0] : null,
    latestGap: p.clock && p.spectrum ? p.clock[4] - p.spectrum[0] : null,
    cohortAgeSamples:
      p.before && p.clock ? p.clock[2] - p.before.frames.at(-1)[2] : null,
    cohortWasObserved:
      p.before?.frames.every((row) =>
        observedClocks.has(JSON.stringify(row)),
      ) ?? false,
    wait: p.lastPreflightWait,
    commands: [...f.sent],
  };
  if (f.controller.pass) f.controller.cancel(V2_OWNER);
  const error = await pending;
  const evidence = error.nativeFailureDiagnostic?.checkEvidence;
  if (result.state === "failed" && evidence?.preflight) {
    result.clockCount = evidence.preflight.clockCount;
    result.clockGap = evidence.preflight.clockMinusSpectrumSamples;
    result.wait = evidence.preflightWaits.last;
  }
  io.closeRetention("cancelled");
  f.packet("stopped", [0, 0, 2], p.generation);
  assert.equal(f.controller.pendingDisarm, null);
  return { ...result, error };
}

test("retained preflight does not depend on lucky rejected-clock alignment", async () => {
  const lucky = await preflight({
    offset: 0,
    deliverySamples: 0,
    tornClockAt: 31200,
  });
  assert.equal(lucky.state, "native-arming");
  assert(lucky.clockGap >= 0 && lucky.clockGap < 2048);
  const delayed = await preflight({ offset: 0, deliverySamples: 64 });
  assert.equal(delayed.state, "native-arming", delayed.error.message);
  assert.equal(delayed.clockCount, 32);
  assert(delayed.clockGap >= 0 && delayed.clockGap < 2048);
  assert(delayed.cohortWasObserved);
  assert(delayed.elapsedMs < 1000);
});

test("sampling the committed last bin removes the readback delay without changing admission", async () => {
  const result = await preflight({ offset: 2047 });
  assert.equal(result.state, "native-arming", result.error.message);
  assert(result.clockGap >= 0 && result.clockGap < 2048);
});

for (const deliverySamples of [0, 64, 128, 256, 2048, 2112, 4096, 6144])
  test(`shipping spectrum readback preflights with ${deliverySamples}-sample DSP delivery phase`, async () => {
    const result = await preflight({ deliverySamples });
    assert.equal(result.state, "native-arming", result.error.message);
    assert.equal(result.clockCount, 32);
    assert(result.clockGap >= 0 && result.clockGap < 2048);
    assert(result.elapsedMs < 1000);
    assert(result.cohortAgeSamples >= 0 && result.cohortAgeSamples < 48000);
    assert(result.cohortWasObserved);
    if (deliverySamples >= 2048) assert(result.latestGap >= 2048);
    assert(
      result.commands.some((command) => command.action === "configure_v2"),
    );
  });

test("holding a coherent clock cohort never permits transport to change before launch", async () => {
  const result = await preflight({
    deliverySamples: 6144,
    startPlayingAt: 16800,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.error.message, "native_transport_changed_before_launch");
  assert.equal(
    result.commands.some((command) => command.action === "arm"),
    false,
  );
});

test("last-bin readback does not authorize a genuinely stalled FFT producer", async () => {
  const result = await preflight({
    offset: 2047,
    stopPublishing: true,
  });
  assert.equal(result.state, "failed");
  assert.equal(result.error.message, "stale_native_preflight");
  assert.equal(
    result.commands.some((command) => command.action === "arm"),
    false,
  );
});

test("cohort waiting cannot extend the one-source-second acquisition budget", async () => {
  const result = await preflight({ deliverySamples: 48000 });
  assert.equal(result.state, "failed");
  assert.equal(result.error.message, "stale_native_preflight");
  const evidence = result.error.nativeFailureDiagnostic.checkEvidence;
  assert.equal(evidence.check, "preflight-source-span");
  assert(evidence.preflight.actualSpanSamples > 48000);
  assert.equal(evidence.preflight.maximumSpanSamples, 48000);
  assert.equal(evidence.deadlineMs, 2000);
  assert(result.elapsedMs < 2000);
  assert.equal(
    result.commands.some((command) => command.action === "arm"),
    false,
  );
});
