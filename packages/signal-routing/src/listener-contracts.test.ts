import { describe, expect, it } from "vitest";
import { listenerControlInputSchema } from "./listener-contracts.js";
import {
  producerHelloSchema,
  producerMessageSchema,
} from "./ingress-contracts.js";
import {
  listenerControlMetricSchema,
  listenerRegistrationMetricSchema,
} from "./listener-metric-contracts.js";
import { createSyntheticMetricWireFixture } from "./listener-metric-test-support.js";

describe("clean-break listener contracts", () => {
  it("accepts only new host input and leaves generation, sequence and wire identity to ingress", () => {
    const f = createSyntheticMetricWireFixture();
    const input = {
      jobId: f.wire.jobId,
      passId: f.wire.passId,
      traceId: f.wire.traceId,
      correlationId: f.wire.correlationId,
      causationId: f.wire.causationId,
      action: "prepare",
      config: f.config,
    };
    expect(listenerControlInputSchema.parse(input)).toEqual(input);
    for (const extra of [
      { generation: f.wire.generation },
      { sequence: 0 },
      { listenerVersion: 4 },
      { connectionId: f.wire.connectionId },
      {
        config: {
          durationMs: 1000,
          maxWindows: 8,
          source: { mode: "arrangement", startBeat: 0, endBeat: 2 },
        },
      },
      { action: "arm" },
      { config: undefined },
    ]) {
      expect(
        listenerControlInputSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
    }
  });
  it.each([1, 2, 3, 4])(
    "rejects superseded wire%s metadata, controls, replies and results",
    (version) => {
      const f = createSyntheticMetricWireFixture();
      const capabilities = [
        "audio-listener/v1",
        "audio-listener/v2",
        "audio-listener/session-v1",
        "audio-listener/dual-mode-v1",
      ];
      const listener = {
        ...f.registration,
        version,
        capabilities: [capabilities[version - 1]],
      };
      expect(listenerRegistrationMetricSchema.safeParse(listener).success).toBe(
        false,
      );
      expect(
        producerHelloSchema.safeParse({
          type: "producer.hello",
          protocolVersion: 1,
          requestId: "hello",
          secret: "x".repeat(32),
          producer: {
            producerId: f.wire.listenerId,
            instanceId: "instance",
            displayName: "Listener",
            signalKind: "audio",
            schemaVersion: `audio-observation/v${version === 1 ? 1 : 2}`,
          },
          listener,
        }).success,
      ).toBe(false);
      expect(
        listenerControlMetricSchema.safeParse({
          ...f.wire,
          listenerVersion: version,
          type: "listener.control",
          action: "prepare",
          config: f.config,
        }).success,
      ).toBe(false);
      for (const type of ["listener.reply", "listener.result"]) {
        expect(
          producerMessageSchema.safeParse({
            ...f.wire,
            listenerVersion: version,
            type,
            status: "failed",
            reason: "old-listener",
          }).success,
        ).toBe(false);
      }
    },
  );

  it.each([
    { deviceCanonicalPath: "live_set this_device" },
    { deviceCanonicalPath: "live_set tracks 0 devices 0 chains 0 devices 0" },
    { deviceCanonicalPath: "live_set tracks 0 devices 32" },
    { trackCanonicalPath: "live_set return_tracks 0" },
    { trackCanonicalPath: "live_set tracks 256" },
    { deviceCanonicalPath: 29 },
    { nativeStatus: undefined },
    { nativeStatus: { version: 1, timing: "VERIFIED", readiness: "READY" } },
  ])("preserves path, owning-track and metadata guards: %j", (change) => {
    const f = createSyntheticMetricWireFixture();
    expect(
      listenerRegistrationMetricSchema.safeParse({
        ...f.registration,
        ...change,
      }).success,
    ).toBe(false);
  });
});
