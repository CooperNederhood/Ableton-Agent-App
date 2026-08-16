import { describe, expect, it } from "vitest";

import {
  MAX_SIGNAL_PAYLOAD_BYTES,
  audioSignalReferenceSchema,
  midiSampleV1Schema,
  outputAssignmentSchema,
  outputProducerSchema,
  signalConsumerEndpointSchema,
  signalEnvelopeSchema,
} from "./contracts.js";
import { midiSample } from "./test-fixtures.js";

describe("signal routing contracts", () => {
  it("accepts the existing midi-sample/v1 writer shape", () => {
    expect(midiSampleV1Schema.parse(midiSample)).toEqual(midiSample);
  });

  it("rejects malformed MIDI and oversized envelopes", () => {
    expect(
      midiSampleV1Schema.safeParse({
        ...midiSample,
        notes: [{ ...midiSample.notes[0], channel: 17 }],
      }).success,
    ).toBe(false);
    expect(
      signalEnvelopeSchema.safeParse({
        protocolVersion: 1,
        connectionId: "connection",
        sequence: 0,
        capturedAt: 1,
        payload: {
          ...midiSample,
          end_reason: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES),
        },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded audio references and rejects raw PCM", () => {
    expect(
      audioSignalReferenceSchema.safeParse({
        schema: "audio-reference/v1",
        durationMs: 1000,
        metadata: { source: "analysis" },
        features: [{ name: "rms", value: 0.25 }],
      }).success,
    ).toBe(true);
    expect(
      audioSignalReferenceSchema.safeParse({
        schema: "audio-reference/v1",
        durationMs: 1000,
        pcm: [0, 0.5, -0.5],
      }).success,
    ).toBe(false);
  });

  it("validates producers, assignments, and extensible consumers", () => {
    expect(
      outputProducerSchema.safeParse({
        producerId: "stable-id",
        instanceId: "runtime-id",
        displayName: "MIDI Capture",
        signalKind: "midi",
        schemaVersion: "midi-sample/v1",
        track: { index: 2, name: "Keys" },
        capabilities: { live: true },
      }).success,
    ).toBe(true);

    const futureConsumer = {
      kind: "shared-analysis-room",
      id: "room-1",
      region: "local",
    };
    expect(signalConsumerEndpointSchema.parse(futureConsumer)).toEqual(
      futureConsumer,
    );
    expect(
      outputAssignmentSchema.safeParse({
        assignmentId: "assignment",
        producerId: "stable-id",
        consumer: { kind: "agent-session", id: "session" },
        deliveryMode: "next-prompt",
        enabled: true,
        usageInstruction: "Use this recent MIDI performance.",
        processingPolicyIds: ["latest-window"],
      }).success,
    ).toBe(true);
  });
});
