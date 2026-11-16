import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionContextStore,
  contextSubjectSchema,
} from "@ableton-agent/project-state";
import {
  acceptMetricRecordChunk,
  createContinuousMetricListeningGeometry,
  createMetricRecordStreamState,
  metricRecordChunkDigest,
  metricRecordStreamExpectedCoverage,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  type MetricRecordStreamDescriptor,
  type MetricRecordChunk,
  type MetricRecordStreamManifest,
} from "@ableton-agent/protocol";
import { createSyntheticMetricSpectrumEvidence } from "@ableton-agent/protocol/testing";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import { createStorageMetricStreamPublication } from "./metric-stream-publication.js";
import { MetricRecordIngestion } from "./metric-record-ingestion.js";

const stores: Awaited<ReturnType<typeof createInMemorySessionContextStore>>[] =
  [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture() {
  const f = createSyntheticMetricWireFixture("arrangement");
  if (f.observation.source.view !== "arrangement") throw new Error("source");
  const g = f.observation.geometry;
  const descriptor: MetricRecordStreamDescriptor = {
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: f.observation.ownership,
    source: f.observation.source,
    geometry: createContinuousMetricListeningGeometry({
      captureMode: "finite-metric-stream",
      sampleRate: g.sampleRate,
      vectorSize: g.vectorSize,
      tempoBpm: g.tempoBpm,
      startBeat: g.startBeat,
      endBeat: g.endBeat,
      startSample: g.startSample,
    }),
    requestedMetrics: ["level"],
    algorithms: [
      {
        metric: "level",
        algorithm: f.observation.metrics.level.algorithm,
        availability: "available",
        unavailableReason: null,
      },
    ],
    maxPendingChunks: 1,
    timingPolicy: f.config.timingPolicy,
  };
  const initial = await createMetricRecordStreamState(descriptor);
  const chunk: MetricRecordChunk = {
    schema: "metric-record-chunk/v1",
    descriptorDigest: initial.descriptorDigest,
    ownership: descriptor.ownership,
    metric: "level",
    chunkSequence: 0,
    recordOffset: 0,
    slotOffset: 0,
    previousDigest: initial.descriptorDigest,
    digest: "0".repeat(64),
    gaps: [],
    records: f.observation.metrics.level.records,
  };
  chunk.digest = await metricRecordChunkDigest(chunk);
  const state = await acceptMetricRecordChunk(descriptor, initial, chunk);
  const manifest: MetricRecordStreamManifest = {
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: initial.descriptorDigest,
    ownership: descriptor.ownership,
    outcome: "complete",
    algorithms: descriptor.algorithms,
    metrics: [
      {
        ...state.metrics[0]!,
        status: "complete",
        availability: "available",
        ...metricRecordStreamExpectedCoverage(descriptor, "level"),
      },
    ],
    nativeProof: {
      schema: "metric-record-stream-terminal/v1",
      ownership: descriptor.ownership,
      status: "completed",
      launch: f.proof.launched,
      timing: f.proof.completion.timing,
      confirmedTiming: f.proof.completion.confirmedTiming,
      configuration: f.proof.completion.fields,
      confirmedConfiguration: f.proof.completion.confirmedFields,
      before: f.proof.armed.before,
      after: f.proof.after,
      timingWitnesses: f.proof.timingWitnesses,
      clock: f.proof.after,
      capturedSamples: g.totalSamples,
      sourceOrigin: g.startSample,
      sourceEnd: g.endSample,
      drain: "completed",
      spectrumPhase: null,
      spectrumCleanup: createSyntheticMetricSpectrumEvidence({
        ownership: descriptor.ownership,
        clock: f.proof.armed.before,
        firstAcquisitionEndpoint: g.startSample - 8192,
        stopWatermark: g.endSample,
      }).spectrumCleanup,
    },
    limitations: [],
  };
  const owner = { sessionId: "session", liveSetId: "set", agentId: "agent" };
  const repository = await createInMemorySessionContextStore(owner);
  stores.push(repository);
  const { traceId, correlationId, causationId } = descriptor.ownership;
  const requestedRange = { startBeat: g.startBeat, endBeat: g.endBeat };
  const input = {
    passId: descriptor.ownership.passId,
    owner,
    trace: { traceId, correlationId, causationId },
    requestedRange,
    createdAt: "2026-11-14T12:00:00.000Z",
    bindings: [
      {
        listenerId: descriptor.ownership.listenerId,
        deviceReference: "device",
        connectionEpoch: descriptor.ownership.connectionEpoch,
        version: "3.0.0",
        primary: contextSubjectSchema.parse({
          id: "subject",
          sessionId: owner.sessionId,
          liveSetId: owner.liveSetId,
          kind: "arrangement-range",
          binding: {
            version: 1,
            semanticLocator: {
              name: "Track",
              arrangementRange: requestedRange,
            },
            sourceIdentity: "source",
            playbackSettingsHash: "settings",
            upstreamProcessingHash: "upstream",
            routingHash: "routing",
            dependencyScope: "unknown",
            previousRuntimeBindings: [
              descriptor.source.view === "arrangement"
                ? descriptor.source.target.expectedReference
                : descriptor.source.target.track.expectedReference,
            ],
          },
        }),
        contributors: [],
        attribution: "unknown" as const,
      },
    ],
  };
  const abort = new AbortController();
  const publication = createStorageMetricStreamPublication(
    repository,
    input,
    abort.signal,
  );
  const ingestion = new MetricRecordIngestion(publication.sink, descriptor);
  const publishInput = {
    manifests: [manifest],
    startedAt: "2026-11-14T12:00:01.000Z",
    endedAt: "2026-11-14T12:00:02.000Z",
    signal: abort.signal,
  };
  return {
    repository,
    input,
    abort,
    publication,
    descriptor,
    chunk,
    manifest,
    ingestion,
    publishInput,
  };
}

describe("production staged stream publication adapter", () => {
  it("allocates only on descriptor, seals without publication, then returns real typed context IDs", async () => {
    const f = await fixture();
    const begin = vi.spyOn(f.repository, "beginMetricCapture");
    const append = vi.spyOn(f.repository, "appendMetricChunk");
    const seal = vi.spyOn(f.repository, "sealMetricCapture");
    const finalize = vi.spyOn(f.repository, "finalizeMetricCapture");
    expect(begin).not.toHaveBeenCalled();
    await f.ingestion.begin(f.descriptor);
    await f.ingestion.append(f.chunk);
    await f.ingestion.finalize(f.manifest);
    expect(seal).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(await f.repository.getPass(f.input.passId)).toBeUndefined();
    expect((await f.repository.listMetricCaptures()).items).toEqual([]);
    const staged = (await f.repository.listMetricCaptures({ status: "sealed" }))
      .items[0]!;
    expect(staged.metadata.pass.complete).toBe(false);
    expect(append.mock.calls[0]![2]).toMatchObject({
      trace: f.input.trace,
      activeAgentId: f.input.owner.agentId,
      signal: f.abort.signal,
    });
    const ids = await f.publication.publish(f.publishInput);
    expect(ids).toEqual([staged.metadata.id]);
    expect(ids[0]).not.toBe(f.input.passId);
    expect((await f.repository.getMetricCapture(ids[0]!))?.status).toBe(
      "completed",
    );
    expect((await f.repository.getPass(f.input.passId))?.complete).toBe(true);
    expect(
      (await f.repository.listMetricChunks({ captureId: ids[0]! })).items,
    ).toEqual([f.chunk]);
    await expect(f.publication.publish(f.publishInput)).rejects.toThrow(
      "lifecycle",
    );
  });
  it("terminates sealed data on cancellation without an aborted cleanup signal or completed claim", async () => {
    const f = await fixture();
    const terminate = vi.spyOn(f.repository, "terminateMetricCapture");
    await f.ingestion.begin(f.descriptor);
    await f.ingestion.append(f.chunk);
    await f.ingestion.finalize(f.manifest);
    f.abort.abort(new Error("cancelled"));
    await expect(f.publication.publish(f.publishInput)).rejects.toThrow(
      "cancelled",
    );
    await f.publication.sink.abort("cancelled");
    await f.publication.sink.abort("again");
    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate.mock.calls[0]![1]).toBe("cancelled");
    expect(terminate.mock.calls[0]![3]?.signal).toBeUndefined();
    expect(await f.repository.getPass(f.input.passId)).toBeUndefined();
    expect(
      (await f.repository.listMetricCaptures({ status: "cancelled" })).items,
    ).toHaveLength(1);
  });
  it("rejects foreign source/trace before durable allocation and mismatched terminal publication", async () => {
    const f = await fixture();
    const changed = structuredClone(f.descriptor);
    changed.ownership.correlationId = "foreign";
    await expect(f.publication.sink.begin(changed)).rejects.toThrow("identity");
    expect(
      (await f.repository.listMetricCaptures({ status: "staging" })).items,
    ).toEqual([]);
    const valid = await fixture();
    await valid.ingestion.begin(valid.descriptor);
    await valid.ingestion.append(valid.chunk);
    await valid.ingestion.finalize(valid.manifest);
    await expect(
      valid.publication.publish({
        ...valid.publishInput,
        manifests: [{ ...valid.manifest, limitations: ["changed"] }],
      }),
    ).rejects.toThrow("manifest");
    expect(await valid.repository.getPass(valid.input.passId)).toBeUndefined();
  });
  it("fails closed on missing chunks and cleans staging after write or cleanup failures", async () => {
    const f = await fixture();
    await f.ingestion.begin(f.descriptor);
    await expect(f.publication.sink.finalize(f.manifest)).rejects.toThrow();
    await f.ingestion.abort("missing chunks");
    expect(
      (await f.repository.listMetricCaptures({ status: "failed" })).items,
    ).toHaveLength(1);
    const other = await fixture();
    await other.ingestion.begin(other.descriptor);
    vi.spyOn(other.repository, "appendMetricChunk").mockRejectedValueOnce(
      new Error("disk"),
    );
    await expect(other.ingestion.append(other.chunk)).rejects.toThrow("disk");
    const terminate = vi
      .spyOn(other.repository, "terminateMetricCapture")
      .mockRejectedValueOnce(new Error("cleanup"));
    await expect(other.ingestion.abort("disk")).rejects.toThrow("cleanup");
    expect(terminate).toHaveBeenCalledOnce();
    expect(await other.repository.getPass(other.input.passId)).toBeUndefined();
  });
  it("awaits the durable append and finishes a pending allocation before abort cleanup", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.repository.beginMetricCapture.bind(f.repository);
    vi.spyOn(f.repository, "beginMetricCapture").mockImplementation(
      async (...args) => {
        await gate;
        return original(...args);
      },
    );
    const begin = f.publication.sink.begin(f.descriptor);
    let cleaned = false;
    const cleanup = f.publication.sink
      .abort("cancelled before allocation")
      .then(() => {
        cleaned = true;
      });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    release();
    await begin;
    await cleanup;
    expect(
      (await f.repository.listMetricCaptures({ status: "failed" })).items,
    ).toHaveLength(1);
    const other = await fixture();
    await other.ingestion.begin(other.descriptor);
    const durable = other.repository.appendMetricChunk.bind(other.repository);
    let commit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    vi.spyOn(other.repository, "appendMetricChunk").mockImplementation(
      async (...args) => {
        await commitGate;
        await durable(...args);
      },
    );
    let appended = false;
    const append = other.ingestion.append(other.chunk).then(() => {
      appended = true;
    });
    await Promise.resolve();
    expect(appended).toBe(false);
    expect(other.ingestion.coverage?.persistedChunks).toBe(0);
    commit();
    await append;
    expect(other.ingestion.coverage?.persistedChunks).toBe(1);
    await other.ingestion.abort("finished test");
  });
});
