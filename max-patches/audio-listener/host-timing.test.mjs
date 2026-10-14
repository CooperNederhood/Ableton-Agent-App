/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { genModel } from "./gen-model.mjs";
import { hostTimingDocument, HOST_TIMING_CODE } from "./host-timing-source.mjs";
import { validateDocument } from "../../scripts/audio-listener-device.mjs";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";

const phase = (index) => (index % 24000) / 24000;
const create = (rate = 48000, stoppedPhase = 0) => {
  const model = genModel(HOST_TIMING_CODE, 6, rate);
  for (let i = 0; i < 128; i++) model.step(stoppedPhase);
  return model;
};

test("engineering native timing document is deterministic, bounded and has no audio output or production authority", async () => {
  const expected = hostTimingDocument();
  validateDocument(expected);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        new URL("./host_timing_probe.gendsp", import.meta.url),
        "utf8",
      ),
    ),
    expected,
  );
  assert.doesNotMatch(
    JSON.stringify(expected),
    /plugout~|dac~|LiveAPI|node.script|certificate|productionReady/,
  );
  assert.equal(expected.patcher.boxes[0].box.numinlets, 3);
  assert.equal(expected.patcher.boxes[0].box.numoutlets, 6);
});

test("model rejects an arm while playing, at a wrap, with prior audio, or with unsupported rate", () => {
  const playing = create();
  playing.configure({ epoch: 1 });
  assert.deepEqual(playing.step(0.5), [1, -1, -1, 0, 1, 0]);
  const wrapping = create();
  wrapping.step(0.99);
  wrapping.configure({ epoch: 1 });
  assert.equal(wrapping.step(0)[4], 1);
  const noisy = create();
  noisy.configure({ epoch: 1 });
  assert.equal(noisy.step(0, 0.1)[4], 8);
  const wrongRate = create(44100);
  wrongRate.configure({ epoch: 1 });
  assert.equal(wrongRate.step(0)[4], 5);
});

test("recorded stopped nonzero phase can arm, but a moving phase cannot", () => {
  const stopped = create(48000, 0.304);
  stopped.configure({ epoch: 1 });
  assert.deepEqual(stopped.step(0.304), [1, -1, -1, 0, 0, 0]);
  assert.deepEqual(stopped.step(0), [1, 1, -1, 0, 0, 1]);
  assert.deepEqual(stopped.step(phase(1), 1 / 32768), [1, 1, 2, 1, 0, 1]);

  const moving = create();
  for (let i = 0; i < 128; i++) moving.step(phase(i));
  moving.configure({ epoch: 1 });
  assert.equal(moving.step(phase(128))[4], 1);
});

test("model preserves source markers preceding the host phase change by the recorded 63 samples", () => {
  const fixture = createKnownListeningFixture("quarter-sine");
  const pcm = new DataView(fixture.wav.buffer);
  const model = create(48000, 0.304);
  model.configure({ epoch: 1 });
  model.step(0.304);
  const onsets = [];
  let count = 0,
    marker;
  for (let i = 0; i < 96000; i++) {
    marker = model.step(
      i < 64 ? 0.304 : phase(i),
      pcm.getInt16(44 + i * 4, true) / 32768,
      pcm.getInt16(46 + i * 4, true) / 32768,
    );
    if (marker[3] !== count) {
      onsets.push(marker[2]);
      count = marker[3];
    }
    assert.equal(marker[4], 0);
  }
  assert.equal(marker[1], 65);
  assert.deepEqual(
    onsets,
    fixture.onsetBeats.map((beat) => 2 + beat * 24000),
  );
  assert.equal(onsets[0] - marker[1], -63);
});

for (const kind of ["quarter-sine", "anti-phase-quarter-sine", "silence"]) {
  test(`model latches native phase launch and independent ${kind} source markers`, () => {
    const fixture = createKnownListeningFixture(kind);
    const pcm = new DataView(fixture.wav.buffer);
    const model = create();
    model.configure({ epoch: 1 });
    assert.deepEqual(model.step(0), [1, -1, -1, 0, 0, 0]);
    for (let i = 0; i < 64; i++) model.step(0);
    let lastCount = 0,
      marker,
      firstLaunch;
    const onsets = [];
    for (let index = 0; index < 96000; index++) {
      marker = model.step(
        phase(index),
        pcm.getInt16(44 + index * 4, true) / 32768,
        pcm.getInt16(46 + index * 4, true) / 32768,
      );
      if (marker[1] >= 0) firstLaunch ??= marker[1];
      if (marker[3] !== lastCount) {
        onsets.push(marker[2]);
        lastCount = marker[3];
      }
      assert.equal(marker[4], 0);
    }
    assert.equal(firstLaunch, 66);
    assert.equal(marker[5], 1);
    assert.deepEqual(
      onsets,
      fixture.onsetBeats.map((beat) => firstLaunch + beat * 24000),
    );
    for (let i = 96000; i < 480002; i++) marker = model.step(phase(i));
    assert.equal(marker[5], 0);
    assert.equal(marker[4], 0);
    assert.equal(marker[3], fixture.onsetBeats.length);
  });
}

test("model timeout, cancellation, transport stop and stale epoch cannot become successful capture", () => {
  const timeout = create();
  timeout.configure({ epoch: 1 });
  let marker;
  for (let i = 0; i <= 480000; i++) marker = timeout.step(0);
  assert.equal(marker[4], 2);
  assert.equal(marker[1], -1);
  const cancelled = create();
  cancelled.configure({ epoch: 1 });
  cancelled.step(0);
  cancelled.step(0.01);
  cancelled.configure({ cancel: 1 });
  assert.equal(cancelled.step(0.02)[4], 4);
  cancelled.configure({ cancel: 0 });
  assert.equal(cancelled.step(0.03)[5], 0);
  const stopped = create();
  stopped.configure({ epoch: 1 });
  stopped.step(0);
  stopped.step(0.1);
  for (let i = 0; i < 128; i++) marker = stopped.step(0.1);
  assert.equal(marker[4], 3);
  const stale = create();
  stale.configure({ epoch: 2 });
  stale.step(0);
  stale.configure({ epoch: 1 });
  assert.deepEqual(stale.step(0), [2, -1, -1, 0, 6, 0]);
});

test("invalid epochs and excessive onsets fail closed; reset cannot reuse an epoch", () => {
  for (const epoch of [-1, 0.5, 1000001]) {
    const invalid = create();
    invalid.configure({ epoch });
    assert.equal(invalid.step(0)[4], 6);
  }
  const model = create();
  model.configure({ epoch: 1 });
  model.step(0);
  let marker;
  for (let i = 1; i <= 9 * 241; i++) {
    marker = model.step(phase(i), i % 241 === 1 ? 0.1 : 0);
  }
  assert.equal(marker[3], 9);
  assert.equal(marker[4], 7);
  assert.equal(marker[5], 0);
  model.configure({ epoch: 0 });
  model.step(0);
  model.configure({ epoch: 1 });
  assert.equal(model.step(0)[5], 0);
  assert.equal(model.step(0)[4], 7);
});
