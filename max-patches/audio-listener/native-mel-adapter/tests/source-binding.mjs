import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { nativeRuntimeDocuments } from "../../native-runtime-source.mjs";
import { genModel } from "../../gen-model.mjs";
import { melBandReference } from "../../mel-band-reference.mjs";

const executable = process.argv[2];
assert.ok(executable, "pass the compiled stream driver; no silent skip");
const documents = nativeRuntimeDocuments({ nativeVersion: 5 });
const clockCode =
  documents["audio_listener_native_clock.gendsp"].patcher.boxes[0].box.code;
const captureCode =
  documents["audio_listener_native_envelope.gendsp"].patcher.boxes[0].box.code;
const window = 2048;
const origin = 4096;
const total = window * 3 + 123;

function signals(rate, delay) {
  const clock = genModel(clockCode, 8, rate);
  const capture = genModel(captureCode, 64, rate);
  const beatSamples = rate / 2;
  const config = {
    epoch: 0,
    cancel: 0,
    totalSamples: total,
    hopSamples: rate / 10,
    tempoBpm: 120,
    startBeatFraction: 0,
    captureVector: 1024,
    levelConfigurationVersion: 1,
    reportStartBeat: 0,
    reportEndBeat: total / beatSamples,
    reportRowCount: Math.ceil((total / beatSamples) * 4),
  };
  clock.configure(config);
  capture.configure(config);
  const rows = [];
  for (let n = 0; n < origin + total + 1025; ++n) {
    if (n === 2048) {
      clock.configure({ epoch: 1 });
      capture.configure({ epoch: 1 });
    }
    const source = clock.step();
    const t = n - origin;
    const left =
      t < window
        ? 0
        : t < window * 2
          ? Math.sin((2 * Math.PI * 64 * t) / window)
          : Math.sin((2 * Math.PI * 1234.5 * t) / rate) * 0.3 +
            Math.cos((2 * Math.PI * 7532.3 * t) / rate) * 0.15;
    const right =
      t < window
        ? 0.01
        : t < window * 2
          ? 0
          : Math.sin((2 * Math.PI * 32 * t) / window) * 0.7;
    const phase = n >= origin + delay ? (n - origin) / beatSamples : 0;
    const env = capture.step(phase, left, right, source[1]);
    assert.equal(env[2], 0, `capture Gen rejection at ${n}`);
    // Same executed capture Gen: epoch, rejection, origin, ABI, total, vector,
    // sealed epoch. Clock is its SAME input4, not a local replacement counter.
    rows.push([
      left,
      right,
      source[1],
      env[0],
      env[2],
      env[6],
      env[7],
      env[9],
      env[13],
      env[18],
    ]);
  }
  return rows;
}

function run(rows, rate, block) {
  const child = spawnSync(executable, [String(rate), String(block)], {
    input: rows.map((row) => row.join(" ")).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  return child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

for (const rate of [44100, 48000]) {
  for (const delay of [1, 32, 1024]) {
    const rows = signals(rate, delay);
    let baseline;
    for (const block of [7, 64, 2048, 8192]) {
      const records = run(rows, rate, block);
      if (baseline) assert.deepEqual(records, baseline);
      baseline = records;
      assert.equal(records[0].kind, 4);
      assert.ok(records[0].end <= origin);
      assert.equal(records[1].kind, 1);
      assert.equal(records[1].start, origin);
      assert.equal(records[1].end, origin + total);
      const frames = records.filter((r) => r.kind === 2);
      assert.equal(frames.length, 3);
      assert.equal(frames[0].diagnostics[0].pitchState, 1);
      assert.equal(frames[0].diagnostics[0].hz, null);
      assert.equal(frames[0].diagnostics[0].spectralState, 1);
      assert.equal(frames[1].diagnostics[1].pitchState, 1);
      for (const [frame, channel, bin] of [
        [frames[1], 0, 64],
        [frames[2], 1, 32],
      ]) {
        const d = frame.diagnostics[channel];
        assert.equal(d.pitchState, 6);
        assert.ok(
          Math.abs(1200 * Math.log2(d.hz / ((rate * bin) / 2048))) <= 20,
        );
        assert.ok(d.confidence >= 0.9);
        assert.equal(d.spectralState, 0);
        assert.ok(d.flatnessDb <= 1e-10 && d.spreadHz >= 0);
      }
      for (const [index, frame] of frames.entries()) {
        assert.equal(frame.start, origin + window * index);
        assert.equal(frame.end, frame.start + window);
        assert.equal(frame.sequence, index + 1);
        for (const [channel, name] of [
          [0, "left"],
          [1, "right"],
        ]) {
          // Consume the parent's independent oracle; do not duplicate it here.
          const reference = melBandReference(
            rows.slice(frame.start, frame.end).map((row) => row[channel]),
            rate,
          );
          reference.forEach((value, band) =>
            assert.ok(
              Math.abs(value - frame[name][band]) <=
                1e-8 + Math.abs(value) * 1e-10,
              `${rate}/${block} frame ${index} ${name} band ${band}`,
            ),
          );
        }
      }
      assert.equal(records.at(-1).kind, 3);
      assert.equal(records.at(-1).reason, 10);
      assert.equal(records.at(-1).partial, 123);
      assert.equal(records.at(-1).lost, 0);
    }
    const discontinuous = rows.map((r) => [...r]);
    discontinuous[origin + 100][2]++;
    const failure = run(discontinuous, rate, 64);
    assert.equal(failure.filter((r) => r.kind === 2).length, 0);
    assert.equal(failure.at(-1).reason, 3);
  }
}
console.log(
  "Existing Gen-source model -> pinned native core -> parent oracle: passed",
);
console.log(
  "Offline model only: not Max compilation, native graph, or Live qualification.",
);
