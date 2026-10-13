import { describe, expect, it } from "vitest";
import { producerHelloSchema } from "./ingress-contracts.js";
import { listenerRegistrationSchema } from "./listener-contracts.js";

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
