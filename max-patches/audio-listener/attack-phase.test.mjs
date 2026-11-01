import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";

const require = createRequire(import.meta.url);
const {
  createMetricTimelines,
} = require("./audio_listener_metric_timelines.js");
const HOP = 4800;

// Independent quantized source integration, not execution of native DSP.
function envelopeWindows(fixture, offset) {
  const pcm = new DataView(
    fixture.wav.buffer,
    fixture.wav.byteOffset,
    fixture.wav.byteLength,
  );
  const frames = (fixture.wav.length - 44) / 4;
  const points = [];
  for (
    let end = HOP;
    end <= Math.ceil((frames + offset) / HOP) * HOP + HOP;
    end += HOP
  ) {
    const peak = [0, 0],
      energy = [0, 0];
    for (let index = end - HOP; index < end; index++) {
      const source = index - offset;
      if (source < 0 || source >= frames) continue;
      for (let channel = 0; channel < 2; channel++) {
        const value = pcm.getInt16(44 + source * 4 + channel * 2, true) / 32768;
        peak[channel] = Math.max(peak[channel], Math.abs(value));
        energy[channel] += value * value;
      }
    }
    points.push({
      sample: end,
      beat: (end * fixture.tempo) / (60 * fixture.sampleRate),
      windowSamples: HOP,
      peak,
      rms: energy.map((sum) => Math.sqrt(sum / HOP)),
      centroidHz: energy[0] || energy[1] ? 440 : null,
      spectralEnergy: energy[0] + energy[1],
    });
  }
  return points;
}

function estimates(points, threshold = 6) {
  const totalSamples = points.at(-1).sample;
  const owner = {
    generation: "00000000-0000-4000-8000-000000000008",
    nativeEpoch: 1,
    arm: "numeric-phase-arm",
  };
  const collector = createMetricTimelines({
    owner,
    originSample: 0,
    originBeat: 0,
    sampleRate: 48000,
    vectorSize: 64,
    tempo: 120,
    startBeat: 0,
    endBeat: totalSamples / 24000,
    captureStartSample: 0,
    captureEndSample: totalSamples,
    requestedMetrics: ["attacks"],
    attacks: { thresholdDb: threshold, minSpacingSamples: HOP },
    traceId: "numeric-phase-trace",
    correlationId: "numeric-phase-correlation",
    causationId: "numeric-phase-cause",
  });
  for (const [index, point] of points.entries()) {
    const accepted = collector.ingestDetectorLevel({
      owner,
      sequence: index + 1,
      startSample: point.sample - HOP,
      endSample: point.sample,
      count: HOP,
      peak: point.peak,
      rms: point.rms,
    });
    assert.equal(accepted.accepted, true);
  }
  const result = collector.finalize({ owner, sourceEndSample: totalSamples });
  assert.equal(result.metrics.attacks.status, "completed");
  return { attacks: result.metrics.attacks.summary.events };
}

for (const kind of ["quarter-sine", "anti-phase-quarter-sine", "silence"]) {
  test(`independent PCM: ${kind} attack count is stable across reporting phases`, () => {
    const fixture = createKnownListeningFixture(kind);
    const phases = [...Array.from({ length: 75 }, (_, i) => i * 64), HOP - 1];
    for (const offset of phases) {
      const points = envelopeWindows(fixture, offset);
      for (const threshold of [0, 6]) {
        const observation = estimates(points, threshold);
        assert.equal(
          observation.attacks.length,
          fixture.onsetBeats.length,
          `phase=${offset}, threshold=${threshold}`,
        );
        observation.attacks.forEach((attack, index) => {
          const onset =
            offset +
            (fixture.onsetBeats[index] * fixture.sampleRate * 60) /
              fixture.tempo;
          assert.ok(attack.sample >= onset);
          assert.ok(attack.sample - onset <= HOP + fixture.fadeSamples + 64);
        });
      }
    }
  });
}
