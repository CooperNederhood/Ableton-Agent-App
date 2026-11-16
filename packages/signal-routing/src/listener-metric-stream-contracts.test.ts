import { describe, expect, it } from "vitest";
import {
  compactMetricRecordStreamDescriptor,
  createContinuousMetricListeningGeometry,
  expandMetricRecordStreamAdmission,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  metricRecordStreamDescriptorDigest,
  type MetricRecordStreamDescriptor,
} from "@ableton-agent/protocol";
import { producerMessageSchema } from "./ingress-contracts.js";
import { listenerResultMetricSchema } from "./listener-metric-contracts.js";
import { createSyntheticMetricWireFixture } from "./listener-metric-test-support.js";

function message() {
  const f = createSyntheticMetricWireFixture();
  return {
    ...f.wire,
    type: "listener.result",
    status: "progress",
    metricChunk: {
      schema: "metric-record-chunk/v1",
      ownership: f.observation.ownership,
      descriptorDigest: "a".repeat(64),
      previousDigest: "a".repeat(64),
      digest: "b".repeat(64),
      metric: "level",
      chunkSequence: 0,
      recordOffset: 0,
      slotOffset: 0,
      records: f.observation.metrics.level.records,
      gaps: [],
    },
  };
}

describe("installed incremental metric wire union", () => {
  it("admits a compact 600s maximum-tempo source envelope and preserves its full descriptor digest", async () => {
    const f = createSyntheticMetricWireFixture();
    if (f.observation.source.view !== "arrangement") throw new Error("source");
    const geometry = createContinuousMetricListeningGeometry({
      captureMode: "finite-metric-stream",
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 999,
      startBeat: 0,
      endBeat: 9_990,
      startSample: f.observation.geometry.startSample,
    });
    const descriptor: MetricRecordStreamDescriptor = {
      schema: "metric-record-stream/v1",
      capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
      ownership: f.observation.ownership,
      source: {
        ...f.observation.source,
        transport: { startBeat: 0, endBeat: 9_990 },
      },
      geometry,
      timingPolicy: f.config.timingPolicy,
      requestedMetrics: ["level"],
      algorithms: [
        {
          metric: "level",
          availability: "available",
          unavailableReason: null,
          algorithm: f.observation.metrics.level.algorithm,
        },
      ],
      maxPendingChunks: 8,
    };
    const admission = compactMetricRecordStreamDescriptor(descriptor);
    const raw = {
      ...f.wire,
      type: "listener.result",
      status: "progress",
      metricStream: admission,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(descriptor)).byteLength,
    ).toBeGreaterThan(2 * 1024 * 1024);
    expect(
      new TextEncoder().encode(JSON.stringify(raw)).byteLength,
    ).toBeLessThan(128 * 1024);
    expect(producerMessageSchema.parse(raw)).toEqual(raw);
    expect(
      await metricRecordStreamDescriptorDigest(
        expandMetricRecordStreamAdmission(admission),
      ),
    ).toBe(await metricRecordStreamDescriptorDigest(descriptor));
    expect(
      producerMessageSchema.safeParse({
        ...raw,
        metricStream: descriptor,
      }).success,
    ).toBe(false);
    expect(
      producerMessageSchema.safeParse({
        ...raw,
        metricStream: {
          ...admission,
          geometry: { ...admission.geometry, startSample: -1 },
        },
      }).success,
    ).toBe(false);
    expect(
      producerMessageSchema.safeParse({
        ...raw,
        metricChunk: message().metricChunk,
      }).success,
    ).toBe(false);
  });
  it("accepts chunk progress through the actual authenticated producer union", () => {
    const value = message();
    expect(producerMessageSchema.parse(value)).toEqual(value);
  });
  it.each(["unknown", "completed", "partial", "failed", "cancelled"])(
    "rejects a chunk carrying incompatible mode/stage %s",
    (value) => {
      const chunk = message();
      expect(
        listenerResultMetricSchema.safeParse({
          ...chunk,
          ...(value === "unknown" ? { mode: value } : { status: value }),
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    "traceId",
    "connectionId",
    "generation",
    "passId",
    "causationId",
  ] as const)("rejects foreign %s at the wire boundary", (field) => {
    const value = message();
    Object.assign(value.metricChunk.ownership, {
      [field]:
        field.endsWith("Id") && !["passId", "causationId"].includes(field)
          ? "11111111-1111-4111-8111-111111111111"
          : "foreign",
    });
    expect(producerMessageSchema.safeParse(value).success).toBe(false);
  });
  it("bounds records and rejects malformed payloads instead of flattening them", () => {
    const value = message();
    value.metricChunk.records = Array.from({ length: 257 }, (_, index) => ({
      ...value.metricChunk.records[0]!,
      index,
    }));
    expect(producerMessageSchema.safeParse(value).success).toBe(false);
    expect(
      producerMessageSchema.safeParse({
        ...message(),
        metricChunk: { ...message().metricChunk, digest: "not-a-digest" },
      }).success,
    ).toBe(false);
  });
  it("cannot pass a whole-capture observation alongside an incremental chunk", () => {
    const f = createSyntheticMetricWireFixture();
    expect(
      producerMessageSchema.safeParse({
        ...message(),
        observation: f.observation,
      }).success,
    ).toBe(false);
  });
  it("requires a separate launch stage rather than mixing proof stages with a chunk", () => {
    const f = createSyntheticMetricWireFixture();
    expect(
      producerMessageSchema.safeParse({
        ...message(),
        nativeLaunch: f.proof.launched,
      }).success,
    ).toBe(false);
  });
});
