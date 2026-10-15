import "./native-protocol-test-loader.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { audioObservationSchema } =
  await import("../../packages/protocol/src/audio-observation-schemas.ts");
const require = createRequire(import.meta.url);
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const cert = {
  validated: true,
  algorithmVersion: VERSION,
  hostVersion: "fixture",
  maxVersion: "fixture",
  requiredHostFlags: 19,
  uncertaintySamples: 64,
  descriptorOffsetSamples: 0,
  launchAligned: true,
  sampleRate: 48000,
  vectorSize: 64,
};
function observation(status = "complete") {
  const engine = new AudioListenerEngine({
    listenerId: "listener",
    certificate: cert,
    now: () => 0,
  });
  const host = (playing, sample, beat) =>
    engine.configureHost({
      dspOn: true,
      playing,
      sample,
      beat,
      sampleRate: 48000,
      vectorSize: 64,
      flags: 19,
    });
  const owner = { passId: "pass", connectionEpoch: "epoch" };
  host(false, 10000, 4);
  engine.prepare({ ...owner, startBeat: 4, endBeat: 4.2 });
  engine.arm(owner);
  host(true, 10000, 4);
  host(true, 14800, 4.2);
  engine.ingest(
    {
      sample: 14800,
      beat: 4.2,
      peak: [1, 0],
      rms: [0.5, 0],
      centroidHz: 1000,
      spectralEnergy: 1,
      windowSamples: 4800,
    },
    owner,
  );
  return (status === "complete" ? engine.finish() : engine.cancel(owner))
    .observation;
}
test("engine terminal outputs match the actual strict protocol schema, not a copied shape", () => {
  for (const status of ["complete", "cancelled"]) {
    const value = observation(status);
    assert.deepEqual(audioObservationSchema.parse(value), value);
    assert.equal(value.complete, status === "complete");
  }
});
test("versioned attack correction does not invalidate historical observations", () => {
  const value = observation();
  assert.equal(value.algorithm.version, VERSION);
  value.algorithm.version = "1.0.0";
  assert.deepEqual(audioObservationSchema.parse(value), value);
});
test("schema rejects raw payload, Nyquist overflow, unmarked reduction and malformed coordinates", () => {
  for (const mutate of [
    (o) => {
      o.audio = "base64";
    },
    (o) => {
      o.samples[0].centroidHz = 30000;
    },
    (o) => {
      o.samples[0].sample = o.endSample + 1;
    },
    (o) => {
      o.reduction.originalSamples++;
    },
    (o) => {
      o.summaries.rmsDbfs[0] = -Infinity;
    },
  ]) {
    const o = observation();
    mutate(o);
    assert.equal(audioObservationSchema.safeParse(o).success, false);
  }
});
