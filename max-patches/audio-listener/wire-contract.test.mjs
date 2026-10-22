import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  listenerControlSchema,
  listenerReplySchema,
  listenerResultSchema,
} from "../../packages/signal-routing/src/listener-contracts.ts";
import {
  assertNativeCaptureObservation,
  nativeCaptureProofSchema,
  NATIVE_LISTENER_SCOPE,
} from "../../packages/protocol/src/native-listening-schemas.ts";
const require = createRequire(import.meta.url);
const { AudioListenerEngine, VERSION } = require("./audio_listener_engine.js");
const { AgentSignalClient } = require("../shared/agent_signal_client.js");
const nativeEvidence = require("./fixtures/native-host-spectrum.json");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");
const { syntheticPreflight } = require("./native-preflight-fixture.cjs");

test("signal-mode internal FFT coordinates do not leak fields outside canonical observation/wire contracts", () => {
  const control = listenerControlSchema.parse({
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 1,
    requestId: "native-request",
    connectionEpoch: "native-connection",
    jobId: "native-job",
    passId: "native-pass",
    traceId: "native-trace",
    correlationId: "native-correlation",
    causationId: "native-cause",
    action: "prepare",
    config: {
      durationMs: 2000,
      maxWindows: 20,
      source: { mode: "arrangement", startBeat: 0, endBeat: 4 },
    },
  });
  const engine = new AudioListenerEngine({
    listenerId: "listener",
    launchAlignment: "signal",
    now: () => 0,
  });
  const origin = nativeEvidence.after.hostBeatZeroSample;
  const host = (playing, sample, beat) =>
    engine.configureHost({
      playing,
      sample,
      beat,
      tempoBpm: 120,
      flags: 31,
      dspOn: true,
      sampleRate: 48000,
      vectorSize: 64,
    });
  host(false, origin - 512, 0);
  const preflight = syntheticPreflight();
  engine.prepare(
    { ...control, ...control.config.source, ...control.config },
    preflight,
  );
  engine.arm({ ...control, nativeEpoch: 1 });
  const ack = {
    nativeEpoch: 1,
    armCounter: nativeEvidence.nativeOrigin[1],
    hostBinding: preflight.before,
    launchClock: -1,
    sourceClock: -1,
    onsetCount: 0,
    rejected: 0,
    active: 0,
    launchPhaseSamples: -1,
    firstSourceClock: -1,
    completedSamples: 0,
  };
  engine.acknowledgeNativeArm(ack, control);
  host(true, origin + 640, 640 / 24000);
  const launch = {
    nativeEpoch: 1,
    armCounter: nativeEvidence.nativeOrigin[1],
    launchClock: 576,
    launchPhaseSamples: 64,
    rejected: 0,
    active: 1,
  };
  engine.launchNative(launch, control);
  // Host delivery and timely post brackets are synthetic, not native acceptance.
  const owner = {
    passId: control.passId,
    connectionEpoch: control.connectionEpoch,
    nativeEpoch: 1,
  };
  const assembler = new NativeDescriptorAssembler({
    owner,
    armCounter: ack.armCounter,
    originCounter: nativeEvidence.nativeOrigin[2],
    hostOffsetSamples: engine.pass.certificate.hostOffsetSamples,
    windows: 20,
    invalidFrames: engine.pass.certificate.invalidFrames,
    onFrame: (frame) => {
      host(true, frame.sample + 64, (frame.sample + 64 - origin) / 24000);
      return engine.ingest(frame, control);
    },
    onFailure: (reason) => engine.terminate("partial", reason),
  });
  const packets = [
    ...nativeEvidence.spectrum.frames.map((value) => ({
      counter: value[0],
      spectrum: value,
    })),
    ...nativeEvidence.envelope.frames.slice(0, 20).map((value) => ({
      counter: nativeEvidence.nativeOrigin[2] + value[4],
      envelope: {
        nativeEpoch: 1,
        armCounter: ack.armCounter,
        originCounter: nativeEvidence.nativeOrigin[2],
        endCounter: nativeEvidence.nativeOrigin[2] + value[4],
        peak: value.slice(0, 2),
        rms: value.slice(2, 4),
      },
    })),
  ].sort((left, right) => left.counter - right.counter);
  for (const packet of packets) {
    if (packet.spectrum) assembler.pushSpectrum(packet.spectrum, owner);
    else assembler.pushEnvelope(packet.envelope, owner);
  }
  const after = {
    dsp: [1, 48000, 64],
    frames: Array.from({ length: 32 }, (_, index) => {
      const counter = nativeEvidence.nativeOrigin[2] + 96000 + 64 + index * 512;
      const sample = counter + nativeEvidence.before.clockOffsetSamples;
      const beat = (counter - nativeEvidence.nativeOrigin[2]) / 24000;
      return [
        1,
        beat,
        sample,
        31,
        counter,
        beat % 1,
        counter,
        1,
        beat,
        sample,
        31,
      ];
    }),
  };
  const finalHost = after.frames.at(-1);
  host(true, finalHost[2], finalHost[1]);
  engine.confirmNativeHost(after, control);
  const result = engine.finish();
  assert.equal(result.status, "complete");
  assert.equal(
    Object.hasOwn(result.observation.samples[0], "spectralWindow"),
    false,
  );
  const { nativeEpoch, armCounter, hostBinding, ...reset } = ack;
  const proof = nativeCaptureProofSchema.parse({
    armed: {
      scope: NATIVE_LISTENER_SCOPE,
      nativeEpoch,
      armCounter,
      before: { dsp: hostBinding.dsp, frames: hostBinding.frames },
      reset,
    },
    launched: {
      ...launch,
      host: {
        sample: origin + 640,
        beat: 640 / 24000,
        flags: 31,
        playing: true,
      },
    },
    after,
    spectralWindows: assembler.spectralWindows(owner),
  });
  assertNativeCaptureObservation(proof, result.observation);
  assert.ok(
    result.observation.samples.some((point) => point.centroidHz !== null),
  );
  const wire = {
    ...control,
    type: "listener.result",
    sequence: 1,
    status: "completed",
    observation: result.observation,
    nativeCapture: proof,
  };
  delete wire.action;
  delete wire.config;
  assert.deepEqual(listenerResultSchema.parse(wire), wire);
});

test("actual shared client serializes canonical listener replies/results with correct IDs/sequence/schema", () => {
  const frames = [];
  class NoSocketClient extends AgentSignalClient {
    writeMessage(message) {
      frames.push(message);
      return true;
    }
  }
  const client = new NoSocketClient({
    signalKind: "audio",
    schemaVersion: "audio-observation/v1",
    producerIdPrefix: "ableton-audio-listener",
    displayName: "Audio-Listener",
    listener: {
      version: 1,
      connectionEpoch: "epoch",
      capabilities: ["audio-listener/v1"],
      sampleRate: 48000,
      algorithmVersion: VERSION,
    },
    env: {
      ABLETON_AGENT_SIGNAL_INGRESS_DESCRIPTOR: "/runner/profile.json",
      ABLETON_AGENT_SIGNAL_INGRESS_SECRET_PATH: "/runner/profile.secret",
    },
  });
  const producer = client.configureProducer({
    canonicalPath: "live_set tracks 0 devices 0",
    track: { id: "1", name: "test" },
    device: { id: "2", name: "Audio-Listener" },
  });
  const control = listenerControlSchema.parse({
    type: "listener.control",
    protocolVersion: 1,
    listenerVersion: 1,
    requestId: "request",
    connectionEpoch: "epoch",
    jobId: "job",
    passId: "pass",
    traceId: "trace",
    correlationId: "correlation",
    causationId: "cause",
    action: "prepare",
    config: {
      durationMs: 1000,
      maxWindows: 10,
      source: { mode: "session", startBeat: 4, endBeat: 4.2 },
    },
  });
  // Exercise real shared framing without any sockets, discovery reads, or Live calls.
  client.authenticated = true;
  client.socket = { destroyed: false };
  client.listenerJob = control;
  assert.equal(client.sendListenerReply(control, { status: "ready" }), true);
  assert.deepEqual(listenerReplySchema.parse(frames[0]), frames[0]);
  const engine = new AudioListenerEngine({
    listenerId: producer.producerId,
    now: () => 0,
    certificate: {
      validated: true,
      algorithmVersion: VERSION,
      hostVersion: "test-double",
      maxVersion: "test-double",
      launchAligned: true,
      requiredHostFlags: 19,
      uncertaintySamples: 64,
      descriptorOffsetSamples: 0,
      sampleRate: 48000,
      vectorSize: 64,
    },
  });
  const host = (playing, sample, beat) =>
    engine.configureHost({
      playing,
      sample,
      beat,
      flags: 19,
      dspOn: true,
      sampleRate: 48000,
      vectorSize: 64,
    });
  host(false, 10000, 4);
  engine.prepare({ ...control, ...control.config.source });
  engine.arm(control);
  host(true, 10000, 4);
  host(true, 14800, 4.2);
  engine.ingest(
    {
      sample: 14800,
      beat: 4.2,
      peak: [1, 0],
      rms: [0.7, 0],
      centroidHz: 750,
      spectralEnergy: 1,
      windowSamples: 4800,
    },
    control,
  );
  const { observation } = engine.finish();
  assert.equal(
    client.sendListenerResult(control, { status: "completed", observation }),
    true,
  );
  assert.deepEqual(listenerResultSchema.parse(frames[1]), frames[1]);
  assert.equal(frames[1].sequence, frames[0].sequence + 1);
  assert.equal(frames[1].observation.listenerId, client.producer.producerId);
  assert.equal(frames[1].observation.passId, control.passId);
  assert.equal(
    frames[1].observation.startBeat,
    control.config.source.startBeat,
  );
  assert.equal(frames[1].observation.endBeat, control.config.source.endBeat);
  assert.ok(
    frames[1].observation.endSample > frames[1].observation.startSample,
  );
  assert.equal(
    frames[1].observation.algorithm.version,
    client.listener.algorithmVersion,
  );
  assert.equal(frames[1].observation.sampleRate, client.listener.sampleRate);
  assert.equal(client.listenerJob, null);
});
