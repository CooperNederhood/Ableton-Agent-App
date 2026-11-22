import { describe, expect, it, vi } from "vitest";
import {
  createContinuousMetricListeningGeometry,
  createMetricRecordStreamState,
  metricRecordChunkDigest,
  metricRecordStreamExpectedCoverage,
  acceptMetricRecordChunk,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  type MetricRecordChunk,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamManifest,
} from "@ableton-agent/protocol";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import {
  createSyntheticMetricSpectrumEvidence,
  createSyntheticMetricRecordStreamFixture,
} from "@ableton-agent/protocol/testing";
import { MetricRecordIngestion } from "./metric-record-ingestion.js";

async function fixture() {
  const data = createSyntheticMetricWireFixture("arrangement");
  if (data.observation.source.view !== "arrangement") throw new Error("source");
  const g = data.observation.geometry;
  const descriptor: MetricRecordStreamDescriptor = {
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: data.observation.ownership,
    source: data.observation.source,
    geometry: createContinuousMetricListeningGeometry({
      sampleRate: g.sampleRate,
      vectorSize: g.vectorSize,
      tempoBpm: g.tempoBpm,
      startBeat: g.startBeat,
      endBeat: g.endBeat,
      startSample: g.startSample,
      captureMode: "finite-metric-stream",
    }),
    requestedMetrics: ["level"],
    algorithms: [
      {
        metric: "level",
        algorithm: data.observation.metrics.level.algorithm,
        availability: "available",
        unavailableReason: null,
      },
    ],
    maxPendingChunks: 1,
    timingPolicy: data.config.timingPolicy,
  };
  const state = await createMetricRecordStreamState(descriptor);
  const chunk: MetricRecordChunk = {
    schema: "metric-record-chunk/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    metric: "level",
    chunkSequence: 0,
    recordOffset: 0,
    slotOffset: 0,
    previousDigest: state.descriptorDigest,
    digest: "0".repeat(64),
    gaps: [],
    records: data.observation.metrics.level.records,
  };
  chunk.digest = await metricRecordChunkDigest(chunk);
  const nativeProof: MetricRecordStreamManifest["nativeProof"] = {
    schema: "metric-record-stream-terminal/v1",
    ownership: descriptor.ownership,
    status: "completed",
    launch: data.proof.launched,
    timing: data.proof.completion.timing,
    confirmedTiming: data.proof.completion.confirmedTiming,
    configuration: data.proof.completion.fields,
    confirmedConfiguration: data.proof.completion.confirmedFields,
    before: data.proof.armed.before,
    after: data.proof.after,
    timingWitnesses: data.proof.timingWitnesses,
    clock: data.proof.after,
    capturedSamples: g.totalSamples,
    sourceOrigin: g.startSample,
    sourceEnd: g.endSample,
    drain: "completed",
    spectrumPhase: null,
    spectrumCleanup: createSyntheticMetricSpectrumEvidence({
      ownership: descriptor.ownership,
      clock: data.proof.armed.before,
      firstAcquisitionEndpoint: g.startSample - 8192,
      stopWatermark: g.endSample,
    }).spectrumCleanup,
  };
  const manifest: MetricRecordStreamManifest = {
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    outcome: "complete",
    algorithms: descriptor.algorithms,
    metrics: [
      {
        ...state.metrics[0]!,
        nextChunkSequence: 1,
        nextRecordOffset: chunk.records.length,
        nextIndex: chunk.records.length,
        lastDigest: chunk.digest,
        lastRecordEndSample: chunk.records.at(-1)!.support.endSample,
        status: "complete",
        availability: "available",
        ...metricRecordStreamExpectedCoverage(descriptor, "level"),
      },
    ],
    nativeProof,
    limitations: [],
  };
  const sink = {
    begin: vi.fn(async () => {}),
    append: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const ingestion = new MetricRecordIngestion(sink, descriptor);
  return { data, descriptor, chunk, manifest, sink, ingestion };
}

describe("bounded durable metric ingestion", () => {
  it.each([30])(
    "durably consumes all six metric families for %ss without accumulating chunk bodies",
    async (seconds) => {
      const fixture = await createSyntheticMetricRecordStreamFixture({
        seconds,
        recordsPerChunk: 256,
      });
      let chunks = 0;
      let records = 0;
      let finalized = false;
      const ingestion = new MetricRecordIngestion(
        {
          async begin() {},
          async append(chunk) {
            expect(
              chunk.records.length + chunk.gaps.length,
            ).toBeLessThanOrEqual(256);
            expect(
              new TextEncoder().encode(JSON.stringify(chunk)).byteLength,
            ).toBeLessThanOrEqual(128 * 1024);
            chunks++;
            records += chunk.records.length;
          },
          async finalize() {
            finalized = true;
          },
          async abort() {
            throw new Error("Unexpected abort");
          },
        },
        fixture.descriptor,
      );
      await ingestion.begin(fixture.descriptor);
      for await (const chunk of fixture.chunks()) await ingestion.append(chunk);
      await ingestion.finalize(fixture.manifest);
      expect(finalized).toBe(true);
      expect(fixture.manifest.metrics).toHaveLength(6);
      expect(ingestion.progress).toEqual({
        chunks,
        records,
        missingRecords: 0,
      });
      expect(ingestion.coverage).toMatchObject({
        requestedSamples: seconds * 48_000,
        persistedSamples: seconds * 48_000,
      });
    },
  );
  it("reports only durably committed metric coverage", async () => {
    const f = await fixture();
    expect(f.ingestion.coverage).toBeUndefined();
    await f.ingestion.begin(f.descriptor);
    expect(f.ingestion.coverage).toEqual({
      sampleRate: f.descriptor.geometry.sampleRate,
      requestedSamples: f.descriptor.geometry.totalSamples,
      persistedSamples: 0,
      persistedChunks: 0,
    });
    await f.ingestion.append(f.chunk);
    expect(f.ingestion.coverage).toMatchObject({
      persistedSamples: f.descriptor.geometry.totalSamples,
      persistedChunks: 1,
    });
  });
  it.each([30])(
    "stages a %ss continuous span without retaining or replaying a terminal observation",
    async (seconds) => {
      const f = await fixture();
      const old = f.descriptor.geometry;
      const geometry = createContinuousMetricListeningGeometry({
        sampleRate: old.sampleRate,
        vectorSize: old.vectorSize,
        tempoBpm: old.tempoBpm,
        startBeat: old.startBeat,
        startSample: old.startSample,
        captureMode: "finite-metric-stream",
        endBeat: old.startBeat + (seconds * old.tempoBpm) / 60,
      });
      const descriptor: MetricRecordStreamDescriptor = {
        ...f.descriptor,
        geometry,
        source: {
          ...f.descriptor.source,
          transport: {
            startBeat: geometry.startBeat,
            endBeat: geometry.endBeat,
          },
        },
      };
      const ingestion = new MetricRecordIngestion(f.sink, descriptor);
      await ingestion.begin(descriptor);
      let state = await createMetricRecordStreamState(descriptor);
      const template = f.chunk.records[0]!;
      for (let offset = 0; offset < geometry.rows.length; offset += 256) {
        const previous = state.metrics[0]!;
        const chunk: MetricRecordChunk = {
          ...f.chunk,
          metric: "level",
          descriptorDigest: state.descriptorDigest,
          previousDigest: previous.lastDigest,
          chunkSequence: previous.nextChunkSequence,
          recordOffset: previous.nextRecordOffset,
          slotOffset: previous.nextIndex,
          records: geometry.rows.slice(offset, offset + 256).map((row, i) => ({
            ...template,
            index: offset + i,
            support: { startSample: row.startSample, endSample: row.endSample },
          })),
        };
        chunk.digest = await metricRecordChunkDigest(chunk);
        state = await acceptMetricRecordChunk(descriptor, state, chunk);
        await ingestion.append(chunk);
      }
      expect(ingestion.progress.records).toBe(geometry.rows.length);
      expect(ingestion.progress.chunks).toBe(
        Math.ceil(geometry.rows.length / 256),
      );
      expect(f.sink.append).toHaveBeenCalledTimes(ingestion.progress.chunks);
      expect(f.sink.finalize).not.toHaveBeenCalled();
      await ingestion.abort("test-cleanup");
      expect(f.sink.abort).toHaveBeenCalledOnce();
    },
  );
  it("durably consumes an incremental chunk and only then finalizes a manifest", async () => {
    const f = await fixture();
    await f.ingestion.begin(f.descriptor);
    await f.ingestion.append(f.chunk);
    expect(f.ingestion.progress).toEqual({
      chunks: 1,
      records: f.chunk.records.length,
      missingRecords: 0,
    });
    expect(await f.ingestion.finalize(f.manifest)).toEqual(f.manifest);
    expect(f.sink.finalize).toHaveBeenCalledExactlyOnceWith(f.manifest);
    await expect(f.ingestion.append(f.chunk)).rejects.toThrow("after-terminal");
  });
  it.each(["digest", "chunkSequence", "recordOffset", "slotOffset"] as const)(
    "rejects a conflicting %s before persistence",
    async (field) => {
      const f = await fixture();
      await f.ingestion.begin(f.descriptor);
      Object.assign(f.chunk, {
        [field]: field === "digest" ? "f".repeat(64) : 1,
      });
      await expect(f.ingestion.append(f.chunk)).rejects.toThrow();
      expect(f.sink.append).not.toHaveBeenCalled();
      await f.ingestion.abort("invalid-chunk");
      expect(f.sink.abort).toHaveBeenCalledExactlyOnceWith("invalid-chunk");
    },
  );
  it("does not turn a missing chunk into a completed context", async () => {
    const f = await fixture();
    await f.ingestion.begin(f.descriptor);
    await expect(f.ingestion.finalize(f.manifest)).rejects.toThrow();
    expect(f.sink.finalize).not.toHaveBeenCalled();
  });
  it("rejects replaced source and trace ownership before beginning storage", async () => {
    const f = await fixture();
    f.descriptor.ownership.traceId = "11111111-1111-4111-8111-111111111111";
    const expected = structuredClone(f.descriptor);
    expected.ownership.traceId = "22222222-2222-4222-8222-222222222222";
    await expect(
      new MetricRecordIngestion(f.sink, expected).begin(f.descriptor),
    ).rejects.toThrow("ownership-changed");
    expect(f.sink.begin).not.toHaveBeenCalled();
  });
  it("rejects duplicate chunks without persisting twice", async () => {
    const f = await fixture();
    await f.ingestion.begin(f.descriptor);
    await f.ingestion.append(f.chunk);
    await expect(f.ingestion.append(f.chunk)).rejects.toThrow();
    expect(f.sink.append).toHaveBeenCalledTimes(1);
  });
  it("rejects a rehashed record with changed source support before writing it", async () => {
    const f = await fixture();
    await f.ingestion.begin(f.descriptor);
    f.chunk.records[0]!.support.endSample += 1;
    f.chunk.digest = await metricRecordChunkDigest(f.chunk);
    await expect(f.ingestion.append(f.chunk)).rejects.toThrow(
      "support_mismatch",
    );
    expect(f.sink.append).not.toHaveBeenCalled();
  });
  it("preserves uncertain cleanup failures rather than silently discarding them", async () => {
    const f = await fixture();
    await f.ingestion.begin(f.descriptor);
    f.sink.abort.mockRejectedValueOnce(new Error("staged-cleanup-failed"));
    await expect(f.ingestion.abort("cancelled")).rejects.toThrow(
      "staged-cleanup-failed",
    );
    await expect(f.ingestion.abort("cancelled")).rejects.toThrow(
      "staged-cleanup-failed",
    );
    expect(f.sink.abort).toHaveBeenCalledOnce();
    expect(f.sink.finalize).not.toHaveBeenCalled();
  });
  it("propagates a write failure and cannot finalize its uncommitted prefix", async () => {
    const f = await fixture();
    f.sink.append.mockRejectedValueOnce(new Error("disk-write-failed"));
    await f.ingestion.begin(f.descriptor);
    await expect(f.ingestion.append(f.chunk)).rejects.toThrow(
      "disk-write-failed",
    );
    expect(f.ingestion.progress.chunks).toBe(0);
    await expect(f.ingestion.finalize(f.manifest)).rejects.toThrow(
      "after-terminal",
    );
    await f.ingestion.abort("disk-write-failed");
    expect(f.sink.abort).toHaveBeenCalledOnce();
  });
  it("bounds in-flight work and waits for durable writes before cancellation cleanup", async () => {
    const f = await fixture();
    let release!: () => void;
    f.sink.append.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await f.ingestion.begin(f.descriptor);
    const append = f.ingestion.append(f.chunk);
    await vi.waitFor(() => expect(f.sink.append).toHaveBeenCalledOnce());
    expect(f.ingestion.coverage).toMatchObject({
      persistedSamples: 0,
      persistedChunks: 0,
    });
    await expect(f.ingestion.append(f.chunk)).rejects.toThrow("backpressure");
    const cleanup = f.ingestion.abort("cancelled");
    expect(f.sink.abort).not.toHaveBeenCalled();
    release();
    await expect(append).rejects.toThrow("aborted");
    await cleanup;
    expect(f.sink.abort).toHaveBeenCalledExactlyOnceWith("cancelled");
    await f.ingestion.abort("cancelled");
    expect(f.sink.abort).toHaveBeenCalledOnce();
  });
});
