import { describe, expect, it } from "vitest";
import { createSyntheticNativeSessionListeningFixture } from "@ableton-agent/protocol/testing";
import {
  listenerControlDualSchema,
  listenerReplyDualSchema,
  listenerResultDualSchema,
} from "./listener-dual-contracts.js";
import { producerMessageSchema } from "./ingress-contracts.js";

const f = createSyntheticNativeSessionListeningFixture({
  source: {
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
  },
});
const context = {
  protocolVersion: 1,
  listenerVersion: 4,
  connectionEpoch: "epoch",
  requestId: "request",
  jobId: "job",
  passId: f.observation.passId,
  traceId: "trace",
  correlationId: "correlation",
  causationId: "cause",
};
describe("wire4 per-pass mode contracts", () => {
  it.each(["arrangement", "session"] as const)(
    "accepts only exact %s configuration and proof shapes",
    (mode) => {
      const session = mode === "session";
      const config = {
        geometry: f.expected.geometry,
        timingPolicy: f.expected.policy,
        ...(session ? { source: f.expected.source } : {}),
      };
      const prepare = {
        ...context,
        type: "listener.control",
        mode,
        action: "prepare",
        config,
      };
      expect(listenerControlDualSchema.safeParse(prepare).success).toBe(true);
      expect(
        listenerControlDualSchema.safeParse({
          ...prepare,
          mode: session ? "arrangement" : "session",
        }).success,
      ).toBe(false);
      expect(
        listenerControlDualSchema.safeParse({ ...prepare, mode: undefined })
          .success,
      ).toBe(false);
      for (const version of [0, 5, "4"])
        expect(
          listenerControlDualSchema.safeParse({
            ...prepare,
            listenerVersion: version,
          }).success,
        ).toBe(false);
      const arm = {
        ...context,
        type: "listener.reply",
        mode,
        sequence: 0,
        status: "armed",
        nativeArm: session ? f.arm : f.arm.transport,
      };
      const result = {
        ...context,
        type: "listener.result",
        mode,
        sequence: 2,
        status: "completed",
        observation: f.observation,
        nativeCapture: session ? f.proof : f.proof.transport,
      };
      expect(producerMessageSchema.safeParse(arm).success).toBe(true);
      expect(producerMessageSchema.safeParse(result).success).toBe(true);
      expect(
        listenerReplyDualSchema.safeParse({
          ...arm,
          mode: session ? "arrangement" : "session",
        }).success,
      ).toBe(false);
      expect(
        listenerResultDualSchema.safeParse({
          ...result,
          mode: session ? "arrangement" : "session",
        }).success,
      ).toBe(false);
      expect(
        listenerResultDualSchema.safeParse({
          ...result,
          nativeCapture: undefined,
        }).success,
      ).toBe(false);
      expect(
        listenerResultDualSchema.safeParse({ ...result, status: "progress" })
          .success,
      ).toBe(false);
    },
  );
});
