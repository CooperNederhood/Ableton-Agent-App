import { describe, expect, it } from "vitest";
import { createSyntheticNativeListeningFixtureV2 } from "@ableton-agent/protocol/testing";
import { NATIVE_SESSION_LISTENER_SCOPE as scope } from "@ableton-agent/protocol";
import {
  listenerConfigV2Schema,
  listenerReplyV2Schema,
} from "./listener-v2-contracts.js";
import {
  listenerControlSessionSchema,
  listenerRegistrationSessionSchema,
  listenerReplySessionSchema,
  listenerResultSessionSchema,
} from "./listener-session-contracts.js";
import { producerMessageSchema } from "./ingress-contracts.js";
const source = {
  mode: "session",
  synchronization: "transport-coupled-first-iteration",
  target: {
    view: "session",
    sceneIndex: 0,
    expectedClipName: "clip",
    expectedClipReference: "11111111-1111-4111-8111-111111111111",
    track: {
      kind: "regular",
      index: 0,
      expectedName: "track",
      expectedReference: "22222222-2222-4222-8222-222222222222",
    },
  },
};
const wire = {
  protocolVersion: 1,
  listenerVersion: 3,
  requestId: "request",
  connectionEpoch: "epoch",
  jobId: "job",
  passId: "pass",
  traceId: "trace",
  correlationId: "correlation",
  causationId: "cause",
  sequence: 0,
};
const status = {
  version: 3,
  scope,
  readiness: "BLOCKED",
  alignment: "approximate",
  verifiedAbsoluteErrorBoundSamples: null,
  acceptedSampleRates: [44100, 48000],
  acceptedVectorSizes: [64],
  timingModes: ["descriptive", "strict"],
  maxClockDisagreementSamples: 480,
  maxAudioDurationMs: 30000,
  maxWindows: 300,
  abiVersion: 2,
  reason: "fresh_per_pass_native_validation_required",
  sourceEvidence: "expected-context-only",
  synchronization: "transport-coupled-first-iteration",
  maxDurationBeats: 4,
};
describe("listener wire3 Session negotiation", () => {
  it("requires exact capability, scope, ABI2 and readiness policy", () => {
    const registration = {
      version: 3,
      connectionEpoch: "epoch",
      capabilities: ["audio-listener/session-v1"],
      algorithmVersion: "2.0.0",
      sampleRate: 48000,
      vectorSize: 64,
      nativeStatus: status,
    };
    listenerRegistrationSessionSchema.parse(registration);
    for (const changed of [
      { ...registration, capabilities: ["audio-listener/v2"] },
      {
        ...registration,
        nativeStatus: { ...status, scope: "arrangement-descriptive/v2" },
      },
      { ...registration, nativeStatus: { ...status, abiVersion: 3 } },
      {
        ...registration,
        nativeStatus: { ...status, readiness: "READY" },
        sampleRate: 96000,
      },
      { ...registration, nativeStatus: { ...status, reason: undefined } },
    ])
      expect(listenerRegistrationSessionSchema.safeParse(changed).success).toBe(
        false,
      );
  });
  it("accepts only new prepare configs and negotiated wrappers; preserves old strict schemas", () => {
    const { proof, observation } = createSyntheticNativeListeningFixtureV2();
    const config = {
      geometry: proof.armed.geometry,
      timingPolicy: proof.armed.policy,
      source,
    };
    const { sequence: _sequence, ...controlWire } = wire;
    expect(_sequence).toBe(0);
    listenerControlSessionSchema.parse({
      ...controlWire,
      type: "listener.control",
      action: "prepare",
      config,
    });
    expect(listenerConfigV2Schema.safeParse(config).success).toBe(false);
    expect(
      listenerControlSessionSchema.safeParse({
        ...controlWire,
        type: "listener.control",
        action: "arm",
        config,
      }).success,
    ).toBe(false);
    const reply = {
      ...wire,
      type: "listener.reply",
      status: "armed",
      nativeArm: { scope, source, transport: proof.armed },
    };
    producerMessageSchema.parse(reply);
    expect(listenerReplyV2Schema.safeParse(reply).success).toBe(false);
    expect(
      listenerReplySessionSchema.safeParse({ ...reply, nativeArm: proof.armed })
        .success,
    ).toBe(false);
    listenerResultSessionSchema.parse({
      ...wire,
      type: "listener.result",
      status: "completed",
      observation,
      nativeCapture: { scope, source, transport: proof },
    });
    for (const value of [
      { ...wire, type: "listener.result", status: "completed", observation },
      { ...wire, type: "listener.result", status: "failed" },
      { ...wire, type: "listener.reply", status: "armed" },
    ])
      expect(producerMessageSchema.safeParse(value).success).toBe(false);
    listenerReplySessionSchema.parse({
      ...wire,
      type: "listener.reply",
      status: "cancelled",
    });
  });
});
