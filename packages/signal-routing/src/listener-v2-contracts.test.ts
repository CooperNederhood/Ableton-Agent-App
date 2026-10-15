import { describe, expect, it } from "vitest";
import {
  assertNativeCaptureObservationV2,
  createNativeListeningGeometry,
  NATIVE_LISTENER_SCOPE_V2,
} from "@ableton-agent/protocol";
import { createSyntheticNativeListeningFixtureV2 } from "@ableton-agent/protocol/testing";
import {
  listenerControlSchema,
  listenerRegistrationSchema,
  listenerReplySchema,
  listenerResultSchema,
} from "./listener-contracts.js";
import {
  listenerConfigV2Schema,
  listenerControlV2Schema,
  listenerRegistrationV2Schema,
  listenerReplyV2Schema,
  listenerResultV2Schema,
} from "./listener-v2-contracts.js";
import { DEFAULT_MAX_INGRESS_FRAME_BYTES } from "./contracts.js";

const policy = {
  mode: "descriptive" as const,
  maxClockDisagreementSamples: 64,
};
const geometry = createNativeListeningGeometry({
  sampleRate: 48_000,
  vectorSize: 64,
  tempoBpm: 120,
  startBeat: 0,
  endBeat: 4,
});
const registration = {
  version: 2,
  connectionEpoch: "epoch",
  capabilities: ["audio-listener/v2"],
  sampleRate: 48_000,
  vectorSize: 64,
  algorithmVersion: "2.0.0",
  deviceCanonicalPath: "live_set tracks 0 devices 0",
  trackCanonicalPath: "live_set tracks 0",
  nativeStatus: {
    version: 2,
    scope: NATIVE_LISTENER_SCOPE_V2,
    readiness: "READY",
    alignment: "approximate",
    verifiedAbsoluteErrorBoundSamples: null,
    acceptedSampleRates: [44_100, 48_000],
    acceptedVectorSizes: [64],
    timingModes: ["descriptive", "strict"],
    maxClockDisagreementSamples: 480,
    maxAudioDurationMs: 30_000,
    maxWindows: 300,
    abiVersion: 2,
  },
};
const wire = {
  protocolVersion: 1,
  listenerVersion: 2,
  requestId: "request",
  connectionEpoch: "epoch",
  jobId: "job",
  passId: "pass",
  traceId: "trace",
  correlationId: "correlation",
  causationId: "cause",
};

function fixture() {
  const { proof, observation } = createSyntheticNativeListeningFixtureV2();
  return {
    reply: {
      ...wire,
      type: "listener.reply",
      sequence: 0,
      status: "armed",
      nativeArm: proof.armed,
    },
    result: {
      ...wire,
      type: "listener.result",
      sequence: 1,
      status: "completed",
      observation,
      nativeCapture: proof,
    },
  };
}

describe("separate native v2 wire negotiation", () => {
  it("fits a validated30-second300-window result without raising the128KiB ingress ceiling", () => {
    const source = listenerResultV2Schema.parse(fixture().result);
    const proof = source.nativeCapture!;
    const observation = source.observation!;
    const expanded = createNativeListeningGeometry({
      sampleRate: geometry.sampleRate,
      vectorSize: geometry.vectorSize,
      tempoBpm: geometry.tempoBpm,
      startBeat: geometry.startBeat,
      endBeat: 60,
    });
    proof.armed.geometry = expanded;
    observation.endBeat = 60;
    observation.endSample = observation.startSample + expanded.totalSamples;
    const rms = Math.sqrt(2) / 10;
    const peak: [number, number] = [Math.sqrt(0.9), Math.sqrt(0.8)];
    const db = 20 * Math.log10(rms);
    const centroid = 22_000.12345678901;
    observation.samples = Array.from({ length: 300 }, (_, index) => ({
      sample: observation.startSample + (index + 1) * 4_800,
      beat: ((index + 1) * 4_800) / 24_000,
      peak: [...peak],
      rmsDbfs: [db, db],
      centroidHz: centroid,
    }));
    observation.attacks = [
      { sample: observation.samples[0]!.sample, beat: 0.2, strength: db + 120 },
    ];
    observation.reduction.originalSamples = 300;
    observation.reduction.originalAttacks = 1;
    observation.summaries = { peak, rmsDbfs: [db, db], centroidHz: centroid };
    proof.envelopeRms = Array.from({ length: 300 }, () => [rms, rms]);
    proof.spectralWindows = observation.samples.map((point) => {
      const end =
        Math.floor((point.sample - 899_456) / 2_048) * 2_048 + 899_456;
      return [end - 2_048, end, centroid, 12_345_678_901.23456];
    });
    for (const row of proof.after.frames) {
      for (const index of [2, 4, 6, 9] as const) row[index] += 1_344_000;
      row[1] += 56;
      row[8] += 56;
    }
    expect(() =>
      assertNativeCaptureObservationV2(proof, observation, {
        policy,
        geometry: expanded,
        listenerId: observation.listenerId,
        passId: observation.passId,
      }),
    ).not.toThrow();
    const encoded = new TextEncoder().encode(JSON.stringify(source)).byteLength;
    expect(DEFAULT_MAX_INGRESS_FRAME_BYTES).toBe(128 * 1_024);
    expect(encoded).toBeLessThanOrEqual(DEFAULT_MAX_INGRESS_FRAME_BYTES);
    expect(listenerResultV2Schema.safeParse(source).success).toBe(true);
    observation.limitations = Array.from({ length: 32 }, () =>
      "\u20ac".repeat(500),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(source)).byteLength,
    ).toBeGreaterThan(DEFAULT_MAX_INGRESS_FRAME_BYTES);
    const rejected = listenerResultV2Schema.safeParse(source);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues.map((issue) => issue.message)).toContain(
        "Native v2 result exceeds the ingress frame quota",
      );
    }
  });

  it("carries explicit capabilities without an absolute timing certificate", () => {
    const parsed = listenerRegistrationV2Schema.parse(registration);
    expect(parsed.nativeStatus.verifiedAbsoluteErrorBoundSamples).toBeNull();
    expect(parsed.nativeStatus.maxAudioDurationMs).toBe(30_000);
    expect(listenerRegistrationSchema.safeParse(parsed).success).toBe(false);
    expect(
      listenerRegistrationV2Schema.safeParse({ ...registration, version: 1 })
        .success,
    ).toBe(false);
  });

  it.each([
    {
      nativeStatus: {
        ...registration.nativeStatus,
        verifiedAbsoluteErrorBoundSamples: 64,
      },
    },
    { nativeStatus: { ...registration.nativeStatus, readiness: "BLOCKED" } },
    {
      nativeStatus: {
        ...registration.nativeStatus,
        acceptedVectorSizes: [64, 64],
      },
    },
    { nativeStatus: { ...registration.nativeStatus, abiVersion: 1 } },
    { vectorSize: 128 },
    { vectorSize: 0 },
    {
      nativeStatus: {
        ...registration.nativeStatus,
        maxAudioDurationMs: 60_000,
      },
    },
    { nativeStatus: { ...registration.nativeStatus, maxWindows: 301 } },
    {
      nativeStatus: {
        ...registration.nativeStatus,
        maxClockDisagreementSamples: 481,
      },
    },
    { nativeStatus: { ...registration.nativeStatus, alignment: "exact" } },
    { sampleRate: 96_000 },
    { trackCanonicalPath: "live_set tracks 1" },
    { capabilities: ["audio-listener/v1"] },
    { algorithmVersion: "1.0.1" },
  ])("denies incompatible or inflated registration%j", (change) => {
    expect(
      listenerRegistrationV2Schema.safeParse({ ...registration, ...change })
        .success,
    ).toBe(false);
  });

  it("keeps unsupported DSP discoverable as blocked with a reason", () => {
    expect(
      listenerRegistrationV2Schema.parse({
        ...registration,
        sampleRate: 96_000,
        nativeStatus: {
          ...registration.nativeStatus,
          readiness: "BLOCKED",
          reason: "unsupported_sample_rate",
        },
      }).nativeStatus.readiness,
    ).toBe("BLOCKED");
  });

  it("carries configuration only at prepare and snapshots both nested policy and geometry", () => {
    const input = { geometry: { ...geometry }, timingPolicy: { ...policy } };
    const parsed = listenerConfigV2Schema.parse(input);
    input.timingPolicy.maxClockDisagreementSamples = 480;
    input.geometry.vectorSize = 128;
    expect(parsed.timingPolicy.maxClockDisagreementSamples).toBe(64);
    expect(parsed.geometry.vectorSize).toBe(64);
    const prepare = {
      ...wire,
      type: "listener.control",
      action: "prepare",
      config: parsed,
    };
    expect(listenerControlV2Schema.parse(prepare).config).toEqual(parsed);
    expect(listenerControlSchema.safeParse(prepare).success).toBe(false);
    for (const action of ["arm", "cancel"]) {
      expect(
        listenerControlV2Schema.safeParse({ ...prepare, action }).success,
      ).toBe(false);
      expect(
        listenerControlV2Schema.safeParse({
          ...wire,
          type: "listener.control",
          action,
        }).success,
      ).toBe(true);
    }
    expect(
      listenerControlV2Schema.safeParse({
        ...wire,
        type: "listener.control",
        action: "prepare",
      }).success,
    ).toBe(false);
  });

  it("requires native proofs on armed and completed outcomes, not on failed or cancelled replies", () => {
    const value = fixture();
    expect(listenerReplyV2Schema.parse(value.reply).nativeArm).toEqual(
      value.reply.nativeArm,
    );
    expect(listenerResultV2Schema.parse(value.result).nativeCapture).toEqual(
      value.result.nativeCapture,
    );
    expect(listenerReplySchema.safeParse(value.reply).success).toBe(false);
    expect(listenerResultSchema.safeParse(value.result).success).toBe(false);
    expect(
      listenerReplyV2Schema.safeParse({ ...value.reply, nativeArm: undefined })
        .success,
    ).toBe(false);
    for (const change of [
      { nativeCapture: undefined },
      { observation: undefined },
      { status: "progress" },
      { status: "failed", reason: "over_budget" },
    ])
      expect(
        listenerResultV2Schema.safeParse({ ...value.result, ...change })
          .success,
      ).toBe(false);
    expect(
      listenerReplyV2Schema.safeParse({
        ...wire,
        type: "listener.reply",
        sequence: 1,
        status: "failed",
      }).success,
    ).toBe(false);
    expect(
      listenerReplyV2Schema.parse({
        ...wire,
        type: "listener.reply",
        sequence: 1,
        status: "failed",
        reason: "over_budget",
      }).reason,
    ).toBe("over_budget");
    expect(
      listenerReplyV2Schema.parse({
        ...wire,
        type: "listener.reply",
        sequence: 1,
        status: "cancelled",
      }).status,
    ).toBe("cancelled");
  });
});
