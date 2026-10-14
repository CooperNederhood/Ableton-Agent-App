import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { listenerControlSchema, listenerReplySchema, listenerResultSchema } from "../../packages/signal-routing/src/listener-contracts.ts";
const require = createRequire(import.meta.url);
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");

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
