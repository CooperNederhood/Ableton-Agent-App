import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH,
  createAgentInstanceAssignmentId,
} from "./assignment-id.js";
import {
  MAX_SIGNAL_PAYLOAD_BYTES,
  audioSignalReferenceSchema,
  midiSampleV1Schema,
  outputAssignmentSchema,
  outputProducerSchema,
  signalConsumerEndpointSchema,
  signalEnvelopeSchema,
  translatedSignalContextSchema,
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
        consumer: { kind: "agent-instance", id: "agent" },
        deliveryMode: "next-prompt",
        enabled: true,
        usageInstruction: "Use this recent MIDI performance.",
        processingPolicyIds: ["latest-window"],
      }).success,
    ).toBe(true);
  });

  it("accepts legacy agent-session assignments during migration", () => {
    expect(
      outputAssignmentSchema.safeParse({
        assignmentId: "legacy-assignment",
        producerId: "stable-id",
        consumer: { kind: "agent-session", id: "session" },
        deliveryMode: "next-prompt",
        enabled: true,
        usageInstruction: "Use this recent MIDI performance.",
        processingPolicyIds: [],
      }).success,
    ).toBe(true);
  });

  it("creates unambiguous deterministic agent-instance assignment ids", () => {
    expect(createAgentInstanceAssignmentId("a:b", "c")).toBe(
      createAgentInstanceAssignmentId("a:b", "c"),
    );
    expect(createAgentInstanceAssignmentId("a:b", "c")).not.toBe(
      createAgentInstanceAssignmentId("a", "b:c"),
    );
    expect(
      outputAssignmentSchema.shape.assignmentId.safeParse(
        createAgentInstanceAssignmentId("agent-1", "producer-1"),
      ).success,
    ).toBe(true);
  });

  it("enforces canonical producer component boundaries", () => {
    const producerId = "p".repeat(
      MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH,
    );
    const producer = {
      producerId,
      instanceId: "runtime-id",
      displayName: "MIDI Capture",
      signalKind: "midi",
      schemaVersion: "midi-sample/v1",
    };

    expect(outputProducerSchema.safeParse(producer).success).toBe(true);
    expect(
      outputProducerSchema.safeParse({
        ...producer,
        producerId: `${producerId}x`,
      }).success,
    ).toBe(false);
    expect(() =>
      createAgentInstanceAssignmentId("agent", producerId),
    ).not.toThrow();
    expect(() =>
      createAgentInstanceAssignmentId("agent", `${producerId}x`),
    ).toThrow(RangeError);
  });

  it("accepts a long canonical assignment id in translated context", () => {
    const component = "\0".repeat(
      MAX_AGENT_INSTANCE_ASSIGNMENT_COMPONENT_LENGTH,
    );
    const assignmentId = createAgentInstanceAssignmentId(component, component);
    const context = {
      assignmentId,
      producerId: component,
      consumer: { kind: "agent-instance", id: component },
      deliveryMode: "next-prompt",
      sequence: 1,
      capturedAt: 1,
      sourceIdentity: "Maximum-length producer",
      content: "signal context",
    };

    expect(assignmentId.length).toBeGreaterThan(4096);
    expect(
      outputAssignmentSchema.shape.assignmentId.safeParse(assignmentId).success,
    ).toBe(true);
    expect(translatedSignalContextSchema.safeParse(context).success).toBe(true);
    expect(
      outputAssignmentSchema.shape.assignmentId.safeParse(`${assignmentId}x`)
        .success,
    ).toBe(false);
    expect(
      translatedSignalContextSchema.safeParse({
        ...context,
        assignmentId: `${assignmentId}x`,
      }).success,
    ).toBe(false);
  });
});
