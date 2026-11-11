import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as codec from "../../packages/protocol/src/index.ts";
const require = createRequire(import.meta.url);
const { createMelBandHandoff } = require("./audio_listener_mel_handoff.js");
const origin = 10000,
  total = 6151,
  end = origin + total;
const readiness = {
  schema: "analyzer-native-readiness/v1",
  producerAbi: 3,
  sourceAbi: 3,
  probeToken: 10,
  dspGeneration: 7,
  sampleRate: 48000,
  sourceClock: 8000,
};
const header = (sequence, start, stop, lost = 0, partial = 0, reason = 0) => [
  3,
  3,
  7,
  sequence,
  start,
  stop,
  lost,
  partial,
  reason,
  48000,
  24,
];
const diagnostics = () => [
  6,
  440.64,
  0.981,
  0,
  -111.6,
  28.4,
  464.5,
  1,
  "null",
  "null",
  1,
  "null",
  "null",
  "null",
];
function fixture() {
  const controls = [],
    events = [];
  let now = 0;
  const handoff = createMelBandHandoff({
    epoch: 3,
    sampleRate: 48000,
    totalSamples: total,
    codec,
    requestedMetrics: ["mel-bands", "pitch", "spectral-shape"],
    analyzerReadiness: readiness,
    now: () => now,
    send: (...args) => controls.push(args),
    emit: (e) => events.push(e),
  });
  handoff.arm();
  return {
    handoff,
    events,
    start() {
      handoff.receive(["mel_ready", ...header(0, 9000, 9000)]);
      handoff.receive(["mel_started", ...header(0, origin, end)]);
      handoff.bind({ startSample: origin, endSample: end });
    },
    frame(sequence, diag = diagnostics(), mel = Array(48).fill(0.25)) {
      handoff.receive([
        "mel_frame",
        ...header(
          sequence,
          origin + (sequence - 1) * 2048,
          origin + sequence * 2048,
        ),
        ...mel,
        ...diag,
      ]);
    },
    finish(frames = 3, reason = 10, clock = end) {
      handoff.receive([
        "mel_stopped",
        ...header(frames, origin + frames * 2048, end, 3 - frames, 7, reason),
      ]);
      now += 10;
      handoff.tick();
      const token = controls.findLast(
        ([selector]) => selector === "drain",
      )[1][0];
      handoff.receive([
        "mel_drain",
        3,
        token,
        3,
        7,
        frames + 3,
        frames,
        1,
        1,
        clock,
      ]);
    },
  };
}
test("ABI3 source-bound frames retain independent paired estimates and explicit tail", () => {
  const f = fixture();
  f.start();
  assert.throws(() => f.handoff.analyzerTimelines(), /not_settled/);
  f.frame(1);
  f.frame(2);
  f.frame(3);
  f.finish();
  const timelines = f.handoff.analyzerTimelines();
  assert.equal(timelines.pitch.status, "complete");
  assert.equal(timelines["spectral-shape"].status, "complete");
  assert.deepEqual(timelines.pitch.frames[0].channels[0], {
    state: "accepted-estimate",
    hz: 440.64,
    confidence: 0.981,
  });
  assert.deepEqual(timelines.pitch.frames[0].channels[1], {
    state: "silence",
    hz: null,
    confidence: null,
  });
  assert.deepEqual(timelines.pitch.trailingSupport, {
    startSample: origin + 6144,
    endSample: end,
  });
  for (const metric of ["pitch", "spectral-shape"])
    assert.ok(
      f.events.some(
        (event) => event.metric === metric && event.stage === "completed",
      ),
    );
});
test("one malformed family/frame cannot discard siblings or later valid supported frames", () => {
  const f = fixture();
  f.start();
  const badPitch = diagnostics();
  badPitch[0] = 999;
  f.frame(1, badPitch);
  const badShape = diagnostics();
  badShape[4] = "broken";
  f.frame(2, badShape);
  const badMel = Array(48).fill(0.25);
  badMel[0] = "null";
  f.frame(3, diagnostics(), badMel);
  f.finish();
  const t = f.handoff.analyzerTimelines();
  assert.deepEqual(
    t.pitch.frames.map((v) => v.index),
    [1, 2],
  );
  assert.deepEqual(
    t["spectral-shape"].frames.map((v) => v.index),
    [0, 2],
  );
  assert.deepEqual(
    f.handoff.timeline().frames.map((v) => v.index),
    [0, 1],
  );
  assert.equal(t.pitch.gaps[0].reason, "malformed-record");
  assert.equal(t.pitch.gaps[0].support.startSample, origin);
});
test("native overflow records honest missing slots with consumed terminal", () => {
  const f = fixture();
  f.start();
  f.frame(1);
  f.finish(1, 6, origin + 3000);
  for (const timeline of Object.values(f.handoff.analyzerTimelines())) {
    assert.equal(timeline.status, "partial");
    assert.equal(timeline.gaps[0].count, 2);
    assert.equal(timeline.gaps[0].reason, "overflow");
  }
});
test("ABI2, generation change, duplicate support and missing drain fail closed", () => {
  const f = fixture();
  const old = header(0, 9000, 9000);
  old[0] = 2;
  assert.throws(() => f.handoff.receive(["mel_ready", ...old]), /header/);
  const g = fixture();
  const changed = header(0, 9000, 9000);
  changed[2] = 8;
  assert.throws(
    () => g.handoff.receive(["mel_ready", ...changed]),
    /generation_mismatch/,
  );
  const h = fixture();
  h.start();
  h.frame(1);
  assert.throws(() => h.frame(1), /sequence_mismatch/);
  assert.throws(() => h.handoff.analyzerTimelines(), /not_settled/);
});
test("cancellation drains shared physical ownership but publishes no analyzer timeline", () => {
  const f = fixture();
  f.start();
  f.frame(1);
  assert.equal(f.handoff.stop(true), false);
  f.finish(1, 1, origin + 3000);
  assert.equal(f.handoff.stop(true), true);
  assert.throws(() => f.handoff.analyzerTimelines(), /not_settled/);
});
