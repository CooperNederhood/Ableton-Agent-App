import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { listenerControlSchema, listenerReplySchema, listenerResultSchema } from "../../packages/signal-routing/src/listener-contracts.ts";
const require = createRequire(import.meta.url);
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");
const nativeEvidence = require("./fixtures/native-host-spectrum.json");

test("signal-mode internal FFT coordinates do not leak fields outside canonical observation/wire contracts", () => {
  const control = listenerControlSchema.parse({
    type: "listener.control", protocolVersion: 1, listenerVersion: 1,
    requestId: "native-request", connectionEpoch: "native-connection", jobId: "native-job", passId: "native-pass",
    traceId: "native-trace", correlationId: "native-correlation", causationId: "native-cause", action: "prepare",
    config: { durationMs: 100, maxWindows: 1, source: { mode: "arrangement", startBeat: 0, endBeat: 0.2 } },
  });
  const engine = new AudioListenerEngine({ listenerId: "listener", launchAlignment: "signal", now: () => 0,
    certificate: { validated: true, algorithmVersion: VERSION, hostVersion: "test-double",
      maxVersion: "test-double", launchAligned: true, requiredHostFlags: 19,
      uncertaintySamples: 64, descriptorOffsetSamples: 0, sampleRate: 48000, vectorSize: 64 } });
  const origin = nativeEvidence.after.hostBeatZeroSample;
  const host = (playing, sample, beat) => engine.configureHost({
    playing, sample, beat, tempoBpm: 120, flags: 31, dspOn: true, sampleRate: 48000, vectorSize: 64 });
  host(false, origin - 512, 0);
  engine.prepare({ ...control, ...control.config.source, ...control.config });
  engine.arm({ ...control, nativeEpoch: 1 });
  engine.acknowledgeNativeArm({
    nativeEpoch: 1, armCounter: nativeEvidence.nativeOrigin[1], hostBinding: nativeEvidence.before,
    launchClock: -1, sourceClock: -1, onsetCount: 0, rejected: 0, active: 0,
    launchPhaseSamples: -1, firstSourceClock: -1, completedSamples: 0,
  }, control);
  host(true, origin + 640, 640 / 24000);
  engine.launchNative({
    nativeEpoch: 1, armCounter: nativeEvidence.nativeOrigin[1], launchClock: 576,
    launchPhaseSamples: 64, rejected: 0, active: 1,
  }, control);
  host(true, origin + 4864, 4864 / 24000);
  engine.ingest({ sample: origin + 4800, beat: 0.2, peak: [0, 0], rms: [0, 0],
    centroidHz: 0, spectralEnergy: 0, windowSamples: 4800,
    spectralWindow: { startSample: origin + 1536, endSample: origin + 3584 } }, control);
  const finalHost = nativeEvidence.after.frames.at(-1);
  host(true, finalHost[2], finalHost[1]);
  engine.confirmNativeHost(nativeEvidence.after, control);
  const result = engine.finish();
  assert.equal(result.status, "complete");
  assert.equal(Object.hasOwn(result.observation.samples[0], "spectralWindow"), false);
  const wire = { ...control, type: "listener.result", sequence: 1, status: "completed",
    observation: result.observation };
  delete wire.action;
  delete wire.config;
  assert.deepEqual(listenerResultSchema.parse(wire), wire);
});

test("actual shared client serializes canonical listener replies/results with correct IDs/sequence/schema", () => {
  const frames = [];
  class NoSocketClient extends AgentSignalClient {
    writeMessage(message) { frames.push(message); return true; }
  }
  const client = new NoSocketClient({ signalKind: "audio", schemaVersion: "audio-observation/v1",
    producerIdPrefix: "ableton-audio-listener", displayName: "Audio-Listener",
    listener: { version: 1, connectionEpoch: "epoch", capabilities: ["audio-listener/v1"],
      sampleRate: 48000, algorithmVersion: VERSION },
    env: { ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/runner/profile.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/runner/profile.secret" } });
  const producer = client.configureProducer({ canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", name: "test" }, device: { id: "2", name: "Audio-Listener" } });
  const control = listenerControlSchema.parse({
    type: "listener.control", protocolVersion: 1, listenerVersion: 1,
    requestId: "request", connectionEpoch: "epoch", jobId: "job", passId: "pass",
    traceId: "trace", correlationId: "correlation", causationId: "cause", action: "prepare",
    config: { durationMs: 1000, maxWindows: 10, source: { mode: "session", startBeat: 4, endBeat: 4.2 } },
  });
  // Exercise real shared framing without any sockets, discovery reads, or Live calls.
  client.authenticated = true; client.socket = { destroyed: false };
  client.listenerJob = control;
  assert.equal(client.sendListenerReply(control, { status: "ready" }), true);
  assert.deepEqual(listenerReplySchema.parse(frames[0]), frames[0]);
  const engine = new AudioListenerEngine({ listenerId: producer.producerId, now: () => 0,
    certificate: { validated: true, algorithmVersion: VERSION, hostVersion: "test-double",
      maxVersion: "test-double", launchAligned: true, requiredHostFlags: 19,
      uncertaintySamples: 64, descriptorOffsetSamples: 0, sampleRate: 48000, vectorSize: 64 } });
  const host = (playing, sample, beat) => engine.configureHost({
    playing, sample, beat, flags: 19, dspOn: true, sampleRate: 48000, vectorSize: 64 });
  host(false, 10000, 4);
  engine.prepare({ ...control, ...control.config.source });
  engine.arm(control); host(true, 10000, 4); host(true, 14800, 4.2);
  engine.ingest({ sample: 14800, beat: 4.2, peak: [1, 0], rms: [0.7, 0],
    centroidHz: 750, spectralEnergy: 1, windowSamples: 4800 }, control);
  const { observation } = engine.finish();
  assert.equal(client.sendListenerResult(control, { status: "completed", observation }), true);
  assert.deepEqual(listenerResultSchema.parse(frames[1]), frames[1]);
  assert.equal(frames[1].sequence, frames[0].sequence + 1);
  assert.equal(frames[1].observation.listenerId, client.producer.producerId);
  assert.equal(frames[1].observation.passId, control.passId);
  assert.equal(frames[1].observation.startBeat, control.config.source.startBeat);
  assert.equal(frames[1].observation.endBeat, control.config.source.endBeat);
  assert.ok(frames[1].observation.endSample > frames[1].observation.startSample);
  assert.equal(frames[1].observation.algorithm.version, client.listener.algorithmVersion);
  assert.equal(frames[1].observation.sampleRate, client.listener.sampleRate);
  assert.equal(client.listenerJob, null);
});
