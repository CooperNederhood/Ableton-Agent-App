import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createKnownListeningFixture } from "../../packages/test-support/src/listening-fixture.ts";

const require = createRequire(import.meta.url);
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
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
  const host = {
    sampleRate: 48000,
    vectorSize: 64,
    sample: 0,
    beat: 0,
    flags: 19,
    playing: false,
    dspOn: true,
  };
  const owner = { passId: "numeric-phase-test", connectionEpoch: "test-epoch" };
  const engine = new AudioListenerEngine({
    listenerId: "numeric-only",
    now: () => 0,
    // Test-only adapter: never a real launch/timing certificate.
    certificate: {
      validated: true,
      algorithmVersion: VERSION,
      hostVersion: "synthetic",
      maxVersion: "synthetic",
      launchAligned: true,
      requiredHostFlags: 19,
      sampleRate: 48000,
      vectorSize: 64,
      uncertaintySamples: 64,
      descriptorOffsetSamples: 0,
    },
  });
  engine.configureHost(host);
  engine.prepare({
    ...owner,
    startBeat: 0,
    endBeat: 8,
    settings: { attackThresholdDb: threshold },
  });
  engine.arm(owner);
  engine.configureHost({ ...host, playing: true });
  for (const point of points) {
    engine.configureHost({
      ...host,
      playing: true,
      sample: point.sample,
      beat: point.beat,
    });
    assert.equal(engine.ingest(point, owner), true);
  }
  return engine.cancel(owner).observation;
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
