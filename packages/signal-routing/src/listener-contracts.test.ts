import { describe, expect, it } from "vitest";
import {
  DEFAULT_LISTENING_TIMING_POLICY,
  evaluateListeningAlignment,
} from "@ableton-agent/protocol";
import { outputProducerSchema } from "./contracts.js";
import { producerHelloSchema } from "./ingress-contracts.js";
import {
  listenerRegistrationSchema,
  listenerReplySchema,
  listenerResultSchema,
} from "./listener-contracts.js";
import { createSyntheticNativeListeningFixture } from "@ableton-agent/protocol/testing";

const legacy = {
  version: 1,
  connectionEpoch: "epoch",
  capabilities: ["audio-listener/v1"],
  sampleRate: 48000,
  algorithmVersion: "native/v1",
};
const native = {
  ...legacy,
  deviceCanonicalPath: "live_set tracks 0 devices 0",
  trackCanonicalPath: "live_set tracks 0",
  nativeStatus: {
    version: 1,
    timing: "UNVERIFIED",
    readiness: "BLOCKED",
    reason: "real_live_timing_validation_required",
  },
};
describe("native listener registration carrier", () => {
  it("does not grant v2 eligibility merely because its observation schema exists", () => {
    expect(
      outputProducerSchema.safeParse({
        producerId: "listener",
        instanceId: "instance",
        displayName: "Listener",
        signalKind: "audio",
        schemaVersion: "audio-observation/v2",
      }).success,
    ).toBe(false);
    expect(
      listenerRegistrationSchema.safeParse({
        ...native,
        version: 2,
        capabilities: ["audio-listener/v2"],
      }).success,
    ).toBe(false);
    const { proof, observation } = createSyntheticNativeListeningFixture();
    const { timingUncertaintySamples, ...algorithm } = observation.algorithm;
    expect(timingUncertaintySamples).toBe(64);
    expect(
      listenerResultSchema.safeParse({
        protocolVersion: 1,
        listenerVersion: 1,
        requestId: "request",
        connectionEpoch: "connection",
        jobId: "job",
        passId: "pass",
        traceId: "trace",
        correlationId: "correlation",
        causationId: "cause",
        sequence: 0,
        type: "listener.result",
        status: "completed",
        nativeCapture: proof,
        observation: {
          ...observation,
          schema: "audio-observation/v2",
          algorithm,
          alignment: evaluateListeningAlignment(
            DEFAULT_LISTENING_TIMING_POLICY,
            {
              sampleRate: 48_000,
              vectorSize: 64,
              observedClockDisagreementSamples: 1,
              observedBeatDisagreementSamples: 0,
            },
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("carries bounded per-pass evidence only on the matching reply/result stage", () => {
    const { proof, observation } = createSyntheticNativeListeningFixture();
    const wire = {
      protocolVersion: 1,
      listenerVersion: 1,
      requestId: "request",
      connectionEpoch: "connection",
      jobId: "job",
      passId: "pass",
      traceId: "trace",
      correlationId: "correlation",
      causationId: "cause",
      sequence: 0,
    };
    const armed = {
      ...wire,
      type: "listener.reply",
      status: "armed",
      nativeArm: proof.armed,
    };
    expect(listenerReplySchema.parse(armed).nativeArm).toEqual(proof.armed);
    expect(
      listenerReplySchema.safeParse({ ...armed, status: "ready" }).success,
    ).toBe(false);
    const launched = {
      ...wire,
      type: "listener.result",
      status: "progress",
      nativeLaunch: proof.launched,
    };
    expect(listenerResultSchema.parse(launched).nativeLaunch).toEqual(
      proof.launched,
    );
    expect(
      listenerResultSchema.safeParse({
        ...launched,
        status: "completed",
        observation,
      }).success,
    ).toBe(false);
    const completed = {
      ...wire,
      type: "listener.result",
      status: "completed",
      observation,
      nativeCapture: proof,
    };
    expect(listenerResultSchema.parse(completed).nativeCapture).toEqual(proof);
    expect(
      listenerResultSchema.safeParse({ ...completed, status: "progress" })
        .success,
    ).toBe(false);
    expect(
      listenerResultSchema.safeParse({ ...completed, rawAudio: [1] }).success,
    ).toBe(false);
  });
  it("accepts actual producer.hello.listener fields and preserves legacy absence without invented readiness", () => {
    expect(listenerRegistrationSchema.parse(native).nativeStatus).toEqual(
      native.nativeStatus,
    );
    expect(
      listenerRegistrationSchema.parse(legacy).nativeStatus,
    ).toBeUndefined();
    const hello = producerHelloSchema.parse({
      type: "producer.hello",
      protocolVersion: 1,
      requestId: "hello",
      secret: "x".repeat(32),
      producer: {
        producerId: "path-hash",
        instanceId: "instance",
        displayName: "Listener",
        signalKind: "audio",
        schemaVersion: "audio-observation/v1",
        track: { id: "17" },
        device: { id: "29" },
      },
      listener: native,
    });
    expect(hello.listener?.capabilities).toEqual(["audio-listener/v1"]);
    expect(hello.listener?.deviceCanonicalPath).toBe(
      native.deviceCanonicalPath,
    );
  });
  it.each([
    { deviceCanonicalPath: "live_set this_device" },
    { deviceCanonicalPath: "live_set tracks 0 devices 0 chains 0 devices 0" },
    { deviceCanonicalPath: "live_set tracks 0 devices 32" },
    { trackCanonicalPath: "live_set return_tracks 0" },
    { trackCanonicalPath: "live_set tracks 256" },
    { deviceCanonicalPath: 29 },
    {
      nativeStatus: { version: 2, timing: "UNVERIFIED", readiness: "BLOCKED" },
    },
    {
      nativeStatus: { version: 1, timing: "UNVERIFIED", readiness: "BLOCKED" },
    },
    {
      nativeStatus: {
        ...native.nativeStatus,
        certificateFile: "/caller-supplied",
      },
    },
  ])("rejects unsafe paths, versions, and status evidence %j", (change) => {
    expect(
      listenerRegistrationSchema.safeParse({ ...native, ...change }).success,
    ).toBe(false);
  });
});
