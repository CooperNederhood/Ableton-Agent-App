import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionContextStore,
  type AppendContextPass,
  type EntityContextRepository,
  type MetricCaptureRecord,
} from "@ableton-agent/project-state";
import {
  audioObservationSchema,
  createMetricObservationReportRows,
  metricAudioObservationSchema,
  nativeMetricObservationMetricSchema,
  type MetricAudioObservation,
  type StoredAudioObservation,
  contextFeatureSchema,
  contextSegmentSchema,
  extractPeakFeature,
  extractListeningFeature,
  segmentListeningObservation,
  createContinuousMetricListeningGeometry,
  createMetricRecordStreamState,
  metricRecordStreamDescriptorSchema,
  metricRecordChunkSchema,
  metricRecordChunkDigest,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  DEFAULT_LISTENING_TIMING_POLICY,
  MEL_BAND_PROFILE,
  type MetricRecordStreamManifest,
  type MetricRecordChunk,
} from "@ableton-agent/protocol";
import {
  createSyntheticNativeListeningFixtureV2,
  createSyntheticMetricListeningObservation,
  createSyntheticMetricRecordStreamFixture,
} from "@ableton-agent/protocol/testing";
import {
  contextOperationParamsSchema,
  contextOperationResultSchema,
} from "@ableton-agent/tools";
import { createSessionContextHost } from "./session-context-host.js";
import { buildListeningPublication } from "./listening-publication.js";

const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "query",
  causationId: "call",
};
const context = { sessionId: "session-a", agentId: "reader", trace };
const timestamp = "2026-10-12T00:00:00.000Z";
const stores: EntityContextRepository[] = [];
const reportDefaults = { includeHistorical: false, offset: 0, limit: 8 };
const featurePageDefaults = { offset: 0, supportOffset: 0, limit: 8 };

async function streamFixture(persist = false) {
  const seeded = await fixture();
  const observation = createSyntheticMetricListeningObservation();
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "finite-metric-stream",
    sampleRate: 48_000,
    vectorSize: 64,
    tempoBpm: 120,
    startBeat: 0,
    endBeat: persist ? 4 : 1200,
    startSample: 10_000,
  });
  const descriptor = metricRecordStreamDescriptorSchema.parse({
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: {
      ...observation.ownership,
      ...trace,
      passId: "stream-pass",
      listenerId: "listener",
    },
    source: {
      ...observation.source,
      transport: { startBeat: 0, endBeat: geometry.endBeat },
    },
    geometry,
    timingPolicy: DEFAULT_LISTENING_TIMING_POLICY,
    requestedMetrics: ["mel-bands"],
    maxPendingChunks: 8,
    algorithms: [
      {
        metric: "mel-bands",
        availability: "available",
        unavailableReason: null,
        algorithm: MEL_BAND_PROFILE,
      },
    ],
  });
  const state = await createMetricRecordStreamState(descriptor);
  const chunks: MetricRecordChunk[] = [];
  for (let sequence = 0; sequence < 2; sequence++) {
    const body = metricRecordChunkSchema.parse({
      schema: "metric-record-chunk/v1",
      descriptorDigest: state.descriptorDigest,
      ownership: descriptor.ownership,
      metric: "mel-bands",
      chunkSequence: sequence,
      recordOffset: sequence * 96,
      slotOffset: sequence * 96,
      previousDigest: chunks.at(-1)?.digest ?? state.metrics[0]!.lastDigest,
      digest: "0".repeat(64),
      gaps: [],
      records: Array.from({ length: 96 }, (_, offset) => {
        const index = sequence * 96 + offset;
        return {
          index,
          support: {
            startSample: 10_000 + index * 2048,
            endSample: 10_000 + (index + 1) * 2048,
          },
          magnitudes: [
            Array.from({ length: 24 }, (_, band) => (band + 1) / 31),
            Array.from({ length: 24 }, (_, band) => (band + 1) / 37),
          ],
        };
      }),
    });
    chunks.push({ ...body, digest: await metricRecordChunkDigest(body) });
  }
  const pass = (await seeded.store.getPass("pass"))!;
  const subject = (await seeded.store.getSubject("subject"))!;
  const { rows: _rows, ...coordinates } = geometry;
  void _rows;
  // This read boundary consumes a committed typed overview. Native terminal
  // proof/replay is independently qualified by the real project-state suite.
  const manifest = {
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    outcome: "complete",
    algorithms: descriptor.algorithms,
    limitations: ["Synthetic typed reader fixture, not native qualification"],
    metrics: state.metrics.map((metric) => ({
      ...metric,
      nextChunkSequence: 147,
      nextIndex: 14062,
      nextRecordOffset: 14062,
      status: "complete",
      availability: "available",
      expectedRecords: 14062,
      trailingSupport: null,
    })),
    nativeProof: {
      status: "completed",
      capturedSamples: geometry.totalSamples,
      sourceOrigin: geometry.startSample,
      sourceEnd: geometry.endSample,
      drain: "completed",
    },
  } as unknown as MetricRecordStreamManifest;
  let record: MetricCaptureRecord = {
    kind: "metric-record-stream-context/v1",
    metadata: {
      id: "stream-context",
      pass: {
        ...pass,
        id: "stream-pass",
        requestedRange: { startBeat: 0, endBeat: geometry.endBeat },
        actualRange: { startBeat: 0, endBeat: geometry.endBeat },
      },
      subject: {
        ...subject,
        id: "stream-subject",
        kind: "arrangement-range",
        binding: {
          ...subject.binding,
          semanticLocator: {
            ...subject.binding.semanticLocator,
            arrangementRange: { startBeat: 0, endBeat: geometry.endBeat },
          },
          previousRuntimeBindings: [
            descriptor.source.view === "arrangement"
              ? descriptor.source.target.expectedReference
              : descriptor.source.clipReference,
          ],
        },
      },
      producer: {
        listenerId: "listener",
        deviceId: "device",
        agentId: "writer",
        connectionEpoch: descriptor.ownership.connectionEpoch,
        version: "fixture",
      },
      trace,
    },
    descriptor: { ...descriptor, geometry: coordinates },
    state,
    status: "completed",
    chunkCount: 147,
    storedBytes: 16_000_000,
    updatedAt: timestamp,
    reason: null,
    manifest,
  };
  const metrics = seeded.store.incrementalMetrics!;
  if (persist) {
    const stream = await createSyntheticMetricRecordStreamFixture({
      seconds: 2,
      sourceOrigin: geometry.startSample,
      source: descriptor.source,
      ownership: descriptor.ownership,
      timingPolicy: descriptor.timingPolicy,
      requestedMetrics: ["mel-bands"],
      recordsPerChunk: 96,
    });
    const owner = await metrics.beginMetricCapture({
      descriptor: stream.descriptor,
      metadata: {
        ...record.metadata,
        pass: {
          ...record.metadata.pass,
          status: "partial",
          complete: false,
          actualRange: null,
        },
      },
    });
    for await (const chunk of stream.chunks())
      await metrics.appendMetricChunk(owner, chunk);
    await metrics.finalizeMetricCapture(
      owner,
      stream.manifest,
      record.metadata.pass,
    );
    record = (await metrics.getMetricCapture(record.metadata.id))!;
  } else {
    const listEntries = seeded.store.listEntries.bind(seeded.store);
    vi.spyOn(seeded.store, "listEntries").mockImplementation(
      async (query, options) => {
        if (query?.entryId !== record.metadata.id)
          return listEntries(query, options);
        const page = await listEntries({ ...query, entryId: "entry" }, options);
        if (
          !query.includeHistorical &&
          record.metadata.pass.liveSetId !== "set-a"
        )
          return { ...page, items: [] };
        return {
          ...page,
          items: page.items.map((entry) => ({
            ...entry,
            id: record.metadata.id,
            passId: record.metadata.pass.id,
            liveSetId: record.metadata.pass.liveSetId,
            kind: record.kind,
            payload: {
              schema: record.kind,
              captureId: record.metadata.id,
              descriptorDigest: record.state.descriptorDigest,
              descriptor: record.descriptor,
            },
          })),
        };
      },
    );
    const listLinks = seeded.store.listLinks.bind(seeded.store);
    vi.spyOn(seeded.store, "listLinks").mockImplementation(
      async (query, options) => {
        const page = await listLinks(
          query?.entryId === record.metadata.id
            ? { ...query, entryId: "entry" }
            : query,
          options,
        );
        return query?.entryId === record.metadata.id &&
          record.metadata.pass.liveSetId !== "set-a"
          ? {
              ...page,
              items: page.items.map((link) => ({
                ...link,
                freshness: { ...link.freshness, status: "historical" as const },
              })),
            }
          : page;
      },
    );
  }
  const get = vi.spyOn(metrics, "getMetricCapture");
  if (!persist)
    get.mockImplementation(async (id) =>
      id === record.metadata.id ? record : undefined,
    );
  const inventory = vi.spyOn(metrics, "listMetricCaptures");
  if (!persist)
    inventory.mockResolvedValue({
      items: [record],
      encodedBytes: Buffer.byteLength(JSON.stringify([record])),
    });
  const read = vi.spyOn(metrics, "listMetricChunks");
  if (!persist)
    read.mockImplementation(async (query) => {
      const index = (query.afterSequence ?? -1) + 1;
      const items = chunks
        .slice(index, index + (query.limit ?? 1))
        .filter(
          (chunk) =>
            query.metric === undefined || query.metric === chunk.metric,
        );
      return {
        items,
        encodedBytes: Buffer.byteLength(JSON.stringify(items)),
        ...(items.length && index + items.length < chunks.length
          ? { nextSequence: index + items.length - 1 }
          : {}),
      };
    });
  return { ...seeded, record, chunks, get, inventory, read };
}

describe("bounded stream context consumers", () => {
  it("summarizes a complete bounded mel passage across immutable chunk boundaries", async () => {
    const { host, record, read, chunks } = await streamFixture();
    read.mockResolvedValueOnce({
      items: chunks,
      encodedBytes: Buffer.byteLength(JSON.stringify(chunks)),
    });
    const result = await host.executeContextOperation(
      contextOperationParamsSchema.parse({
        action: "stream-summary",
        contextId: record.metadata.id,
        range: {
          startSample: 10_000 + 94 * 2048,
          endSample: 10_000 + 98 * 2048,
        },
      }),
      context,
    );
    expect(result).toMatchObject({
      action: "stream-summary",
      summary: {
        kind: "mel-band-range-summary/v1",
        availability: "available",
        aggregation: { status: "completed", frameCount: 4 },
        chunkDigests: chunks.map((chunk) => chunk.digest),
        gaps: [],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6000);
    expect(read.mock.calls[0]?.[1]).toMatchObject({
      trace,
      activeAgentId: "reader",
    });
  });

  it("reads a verified 600-second overview without loading records or deriving features", async () => {
    const { host, read, record } = await streamFixture();
    const result = await host.executeContextOperation(
      {
        action: "stream-overview",
        contextId: record.metadata.id,
        includeHistorical: false,
      },
      context,
    );
    expect(contextOperationResultSchema.parse(result)).toMatchObject({
      action: "stream-overview",
      entry: { kind: record.kind, freshness: "unknown" },
      overview: {
        geometry: { totalSamples: 28_800_000, sampleRate: 48_000 },
        metrics: [{ expectedRecords: 14062 }],
        featureDerivation: "supported",
      },
    });
    expect(JSON.stringify(result)).not.toContain('"rows"');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(65536);
    expect(read).not.toHaveBeenCalled();
  });

  it("pages exact records below 64KiB, continuing within and between immutable chunks", async () => {
    const { host, record, chunks, read } = await streamFixture();
    const indices = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await host.executeContextOperation(
        {
          action: "stream-records",
          contextId: record.metadata.id,
          includeHistorical: false,
          metric: "mel-bands",
          limit: 64,
          ...(cursor === undefined ? {} : { cursor }),
        },
        context,
      );
      if (result.action !== "stream-records" || result.page === null)
        throw new Error("Expected record page");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        65536,
      );
      expect(result.page.kind).toBe("metric-record-chunk-projection/v1");
      expect(result.page.chunkDigest).toBe(
        chunks[result.page.chunkSequence]!.digest,
      );
      if (pages++ === 0) expect(result.page.records.length).toBeLessThan(64);
      indices.push(...result.page.records.map((item) => item.index));
      cursor = result.nextCursor;
    } while (cursor !== undefined && pages < 12);
    expect(cursor).toBeUndefined();
    expect(indices).toEqual(Array.from({ length: 192 }, (_, index) => index));
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      limit: 1,
      maxBytes: 131074,
    });
    expect(read.mock.calls[0]?.[1]).toMatchObject({
      trace,
      activeAgentId: "reader",
    });
  });

  it("filters a musical sample range before paging across chunk boundaries without clipping supports", async () => {
    const { host, record, chunks } = await streamFixture();
    const query = {
      action: "stream-records" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
      metric: "mel-bands" as const,
      range: {
        startSample: 10_000 + 94 * 2048 + 7,
        endSample: 10_000 + 97 * 2048 + 9,
      },
      limit: 2,
    };
    const records = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await host.executeContextOperation(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        context,
      );
      if (result.action !== "stream-records" || result.page === null)
        throw new Error("Expected range projection");
      expect(result.page.chunkDigest).toBe(
        chunks[result.page.chunkSequence]!.digest,
      );
      records.push(...result.page.records);
      cursor = result.nextCursor;
      pages++;
    } while (cursor !== undefined && pages < 12);
    expect(cursor).toBeUndefined();
    expect(records).toEqual([
      ...chunks[0]!.records.slice(94),
      ...chunks[1]!.records.slice(0, 2),
    ]);
    expect(pages).toBe(2);
    expect(records[0]!.support.startSample).toBeLessThan(
      query.range.startSample,
    );
    expect(records.at(-1)!.support.endSample).toBeGreaterThan(
      query.range.endSample,
    );
  });

  it("returns an empty bounded projection for a coarse chunk match with no intersecting records", async () => {
    const { host, record } = await streamFixture();
    const query = {
      action: "stream-records" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
      range: { startSample: 1, endSample: 2 },
      limit: 8,
    };
    const first = await host.executeContextOperation(query, context);
    expect(first).toMatchObject({
      page: { records: [], gaps: [], entryOffset: 0 },
    });
    if (first.action !== "stream-records") throw new Error("Expected records");
    expect(typeof first.nextCursor).toBe("string");
    const last = await host.executeContextOperation(
      { ...query, cursor: first.nextCursor! },
      context,
    );
    expect(last).toMatchObject({ page: { records: [], gaps: [] } });
    expect("nextCursor" in last).toBe(false);
  });

  it("preserves intersecting gaps while excluding records touching only the half-open boundaries", async () => {
    const { host, record, chunks, read } = await streamFixture();
    const original = chunks[0]!;
    if (original.metric !== "mel-bands")
      throw new Error("Expected mel fixture");
    const missing = original.records.at(-1)!;
    const gap = {
      firstIndex: missing.index,
      count: 1,
      support: missing.support,
      reason: "sequence-gap" as const,
      detail: "Missing retained analyzer frame",
    };
    const body = {
      ...original,
      records: original.records.slice(0, -1),
      gaps: [gap],
    };
    const chunk = { ...body, digest: await metricRecordChunkDigest(body) };
    read.mockResolvedValueOnce({
      items: [chunk],
      encodedBytes: Buffer.byteLength(JSON.stringify([chunk])),
    });
    const result = await host.executeContextOperation(
      {
        action: "stream-records",
        contextId: record.metadata.id,
        includeHistorical: false,
        range: missing.support,
        limit: 64,
      },
      context,
    );
    expect(result).toMatchObject({
      page: {
        chunkDigest: chunk.digest,
        totalRecords: 95,
        totalGaps: 1,
        entryOffset: 0,
        records: [],
        gaps: [gap],
      },
    });
    read.mockResolvedValueOnce({
      items: [chunk],
      encodedBytes: Buffer.byteLength(JSON.stringify([chunk])),
    });
    const summary = await host.executeContextOperation(
      {
        action: "stream-summary",
        contextId: record.metadata.id,
        includeHistorical: false,
        range: missing.support,
      },
      context,
    );
    expect(summary).toMatchObject({
      summary: {
        aggregation: { status: "no-frames", frameCount: 0 },
        gaps: [gap],
      },
    });
  });

  it("summarizes only the selected mel frames with the existing linear regional aggregation", async () => {
    const { host, record } = await streamFixture();
    const result = await host.executeContextOperation(
      {
        action: "stream-summary",
        contextId: record.metadata.id,
        includeHistorical: false,
        range: {
          startSample: 10_000 + 12 * 2048,
          endSample: 10_000 + 16 * 2048,
        },
      },
      context,
    );
    expect(result).toMatchObject({
      summary: {
        aggregation: {
          status: "completed",
          frameCount: 4,
        },
      },
    });
    if (
      result.action !== "stream-summary" ||
      result.summary.aggregation.status !== "completed"
    )
      throw new Error("Expected completed mel aggregation");
    for (const [channel, denominator] of [31, 37].entries()) {
      const region = result.summary.aggregation.analysis.regions[channel]!;
      expect(region.low).toBeCloseTo(3 / denominator, 12);
      expect(region.mid).toBeCloseTo(42 / denominator, 12);
      expect(region.high).toBeCloseTo(255 / denominator, 12);
    }
  });

  it("refuses partial, out-of-range and cancelled summaries instead of returning incomplete means", async () => {
    const { host, record, read, chunks } = await streamFixture();
    const query = {
      action: "stream-summary" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
      range: { startSample: 10_000, endSample: 10_000 + 16 * 2048 },
    };
    read.mockResolvedValueOnce({
      items: chunks,
      encodedBytes: 2,
      nextSequence: 1,
    });
    await expect(
      host.executeContextOperation(query, context),
    ).rejects.toMatchObject({
      code: "context_response_too_large",
    });
    await expect(
      host.executeContextOperation(
        { ...query, range: { startSample: 1, endSample: 2 } },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_range" });
    read.mockResolvedValueOnce({
      items: [...chunks, chunks[0]!],
      encodedBytes: 2,
    });
    await expect(
      host.executeContextOperation(
        {
          ...query,
          range: { startSample: 10_000, endSample: 10_000 + 200 * 2048 },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "context_response_too_large" });
    read.mockRejectedValueOnce(new Error("stored summary chunk corrupt"));
    await expect(host.executeContextOperation(query, context)).rejects.toThrow(
      "stored summary chunk corrupt",
    );
    const controller = new AbortController();
    read.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during summary"));
      return { items: [], encodedBytes: 2 };
    });
    await expect(
      host.executeContextOperation(query, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled during summary");
  });

  it("binds continuations to context, filters and original chunk identity", async () => {
    const { host, record, read, chunks } = await streamFixture();
    const query = {
      action: "stream-records" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
      limit: 8,
    };
    const first = await host.executeContextOperation(query, context);
    if (first.action !== "stream-records") throw new Error("Expected records");
    await expect(
      host.executeContextOperation(
        { ...query, cursor: first.nextCursor!, metric: "pitch" },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      host.executeContextOperation(
        {
          ...query,
          cursor: first.nextCursor!,
          range: { startSample: 10_000, endSample: 12_048 },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(
      host.executeContextOperation({ ...query, cursor: "malformed" }, context),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    read.mockResolvedValueOnce({
      items: [{ ...chunks[0]!, digest: "f".repeat(64) }],
      encodedBytes: 1,
    });
    await expect(
      host.executeContextOperation(
        { ...query, cursor: first.nextCursor! },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("discovers published streams in the normal registry and derives their canonical features without whole observations", async () => {
    const { host, store, record, read, inventory } = await streamFixture(true);
    const derive = vi.spyOn(store, "deriveFeatures");
    const result = await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      context,
    );
    expect(result).toMatchObject({
      entries: [{ kind: "audio-observation/v1" }, { kind: record.kind }],
    });
    expect(inventory).not.toHaveBeenCalled();
    const bootstrap: unknown = JSON.parse(
      await host.getSessionContextInventory(context.sessionId, context),
    );
    expect(bootstrap).toMatchObject({
      entries: [{ contextId: "entry" }, { contextId: record.metadata.id }],
    });
    expect(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: record.metadata.id,
          includeHistorical: false,
        },
        context,
      ),
    ).toMatchObject({ observation: { schema: record.kind } });
    for (const action of ["report"] as const)
      await expect(
        host.executeContextOperation(
          contextOperationParamsSchema.parse({
            action,
            contextId: record.metadata.id,
            includeHistorical: false,
            ...(action === "report" ? { offset: 0, limit: 8 } : {}),
          }),
          context,
        ),
      ).rejects.toMatchObject({ code: "unsupported_context_kind" });
    expect(read).not.toHaveBeenCalled();
    expect(
      await host.executeContextOperation(
        {
          action: "derive-features" as const,
          contextIds: [record.metadata.id],
          includeHistorical: false,
        },
        context,
      ),
    ).toMatchObject({
      action: "derive-features",
      derivations: [{ status: "ready" }],
    });
    const features = await host.executeContextOperation(
      {
        action: "list-features" as const,
        contextId: record.metadata.id,
        includeHistorical: false,
        limit: 20,
      },
      context,
    );
    expect(features.action).toBe("list-features");
    expect(
      "inventory" in features && Array.isArray(features.inventory.features),
    ).toBe(true);
    expect(derive).toHaveBeenCalledOnce();
  });

  it("denies provisional, foreign and wrong-Set contexts and forwards cancellation without reads", async () => {
    const { host, record, get, read } = await streamFixture();
    const query = {
      action: "stream-overview" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
    };
    get.mockResolvedValueOnce({ ...record, status: "sealed" });
    await expect(
      host.executeContextOperation(query, context),
    ).rejects.toMatchObject({ code: "not_found" });
    get.mockResolvedValueOnce({
      ...record,
      metadata: {
        ...record.metadata,
        pass: { ...record.metadata.pass, sessionId: "foreign" },
      },
    });
    await expect(
      host.executeContextOperation(query, context),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const historical = {
      ...record,
      metadata: {
        ...record.metadata,
        pass: { ...record.metadata.pass, liveSetId: "old-set" },
      },
    };
    record.metadata.pass.liveSetId = historical.metadata.pass.liveSetId;
    await expect(
      host.executeContextOperation(query, context),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await host.executeContextOperation(
        { ...query, includeHistorical: true },
        context,
      ),
    ).toMatchObject({ entry: { freshness: "historical" } });
    const controller = new AbortController();
    controller.abort(new Error("reader cancelled"));
    await expect(
      host.executeContextOperation(query, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow("reader cancelled");
    expect(read).not.toHaveBeenCalled();
  });

  it("returns an explicit empty page and propagates repository failures", async () => {
    const { host, record, read } = await streamFixture();
    const query = {
      action: "stream-records" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
      limit: 8,
      metric: "pitch" as const,
    };
    expect(await host.executeContextOperation(query, context)).toMatchObject({
      page: null,
    });
    read.mockRejectedValueOnce(new Error("stored chunk integrity failed"));
    await expect(host.executeContextOperation(query, context)).rejects.toThrow(
      "stored chunk integrity failed",
    );
  });
});

describe("stream range and cancellation boundaries", () => {
  it("continues canonical and historical discovery through one context registry and binds inventory filters", async () => {
    const { host, record } = await streamFixture(true);
    const query = {
      action: "list" as const,
      includeHistorical: false,
      limit: 1,
    };
    const first = await host.executeContextOperation(query, context);
    if (first.action !== "list" || first.nextCursor === undefined)
      throw new Error("Expected mixed continuation");
    expect(first.entries.map((entry) => entry.contextId)).toEqual(["entry"]);
    const second = await host.executeContextOperation(
      { ...query, cursor: first.nextCursor },
      context,
    );
    expect(second).toMatchObject({
      entries: [{ contextId: record.metadata.id }],
    });
    expect(second).not.toHaveProperty("nextCursor");
    await expect(
      host.executeContextOperation(
        { ...query, cursor: first.nextCursor, listenerId: "different" },
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });
  it("preserves original range supports and application attribution, and cancels an empty in-flight read", async () => {
    const { host, record, read } = await streamFixture();
    const range = { startSample: 10_001, endSample: 10_002 };
    const query = {
      action: "stream-records" as const,
      contextId: record.metadata.id,
      includeHistorical: false,
      range,
      limit: 1,
    };
    const result = await host.executeContextOperation(query, {
      ...context,
      actorKind: "application",
      agentId: "desktop-reader",
    });
    expect(result).toMatchObject({
      page: {
        records: [{ support: { startSample: 10_000, endSample: 12_048 } }],
      },
    });
    expect(read.mock.calls[0]?.[0]).toMatchObject({ range });
    expect(read.mock.calls[0]?.[1]).not.toHaveProperty("activeAgentId");
    const controller = new AbortController();
    read.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during record query"));
      return { items: [], encodedBytes: 2 };
    });
    await expect(
      host.executeContextOperation(query, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled during record query");
  });
});

async function featureFixture(grid = false) {
  const seeded = await fixture();
  const source = createSyntheticMetricListeningObservation();
  const aligned = segmentListeningObservation(source, {
    version: 1,
    coordinate: "transport-beats",
    meter: { numerator: 4, denominator: 4 },
    barOriginBeat: 0,
    tempoBpm: source.geometry.tempoBpm,
    tempoEvidence: "message-rate-monitored-constant",
    provenance: "capture-snapshot/v1",
  })[0]!;
  const record = contextFeatureSchema.parse({
    id: "feature-1",
    entryId: "entry",
    segmentId: "segment-1",
    sessionId: context.sessionId,
    liveSetId: "set-a",
    sourceFingerprint: "a".repeat(64),
    primarySubjectId: "subject",
    freshness: {
      status: "fresh",
      assessedAt: timestamp,
      reason: "test source snapshot",
    },
    createdAt: timestamp,
    trace,
    feature: grid
      ? extractListeningFeature("level-grid/v1", source, aligned)
      : extractPeakFeature(source),
  });
  const segment = contextSegmentSchema.parse({
    id: "segment-1",
    entryId: "entry",
    sessionId: context.sessionId,
    liveSetId: "set-a",
    order: 0,
    kind: "unaligned",
    coordinate: "transport-beats",
    startBeat: 0,
    endBeat: 1,
    startSample: 10_000,
    endSample: 34_000,
    sampleRate: 48_000,
    alignmentReason: "musical-bar-alignment-not-established",
    ...(grid
      ? {
          kind: aligned.kind,
          alignment: aligned.alignment,
          alignmentReason: aligned.alignmentReason,
        }
      : {}),
  });
  const getFeature = vi
    .spyOn(seeded.store, "getFeature")
    .mockImplementation(async (id) => (id === record.id ? record : undefined));
  vi.spyOn(seeded.store, "getSegment").mockResolvedValue(segment);
  return { ...seeded, record, segment, getFeature };
}

describe("typed listening feature host", () => {
  it("discovers canonical registered comparisons without touching Live", async () => {
    const { host } = await fixture();
    const result = await host.executeContextOperation(
      { action: "feature-definitions" },
      context,
    );
    const parsed = contextOperationResultSchema.parse(result);
    if (parsed.action !== "feature-definitions")
      throw new Error("Expected definitions");
    expect(
      parsed.definitions.find(
        (definition) => definition.type === "peak-summary/v1",
      ),
    ).toMatchObject({
      type: "peak-summary/v1",
      distanceDefinition: "euclidean-linear-amplitude/v1",
    });
  });

  it.each([false, true])(
    "returns source-linked features and computed distances with grid=%s",
    async (grid) => {
      const { host, getFeature, record } = await featureFixture(grid);
      const detail = await host.executeContextOperation(
        {
          action: "get-feature",
          featureId: "feature-1",
          includeHistorical: false,
          ...featurePageDefaults,
        },
        context,
      );
      expect(contextOperationResultSchema.parse(detail)).toMatchObject({
        action: "get-feature",
        feature: {
          record: { id: "feature-1" },
          segment: { kind: grid ? "short" : "unaligned" },
          source: { contextId: "entry" },
        },
      });
      const result = await host.executeContextOperation(
        {
          action: "compare-features",
          pairs: [{ leftFeatureId: "feature-1", rightFeatureId: "feature-1" }],
          includeHistorical: false,
        },
        context,
      );
      expect(result).toMatchObject({
        comparisons: [
          {
            result: {
              status: "comparable",
              distance: 0,
              ...(grid
                ? {
                    coverage: {
                      policy: "shared-valid-musical-cells",
                      comparedValues: record.feature.values!.length,
                      totalValues: record.feature.values!.length,
                    },
                  }
                : {}),
            },
          },
        ],
      });
      expect(getFeature).toHaveBeenCalledWith(
        "feature-1",
        expect.objectContaining({ trace, activeAgentId: "reader" }),
      );
    },
  );

  it("denies missing sources and read-only derivation, and forwards cancellation", async () => {
    const { host, store } = await featureFixture();
    await expect(
      host.executeContextOperation(
        {
          action: "derive-features",
          contextIds: ["entry"],
          includeHistorical: false,
        },
        { ...context, actorKind: "application" },
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      host.executeContextOperation(
        {
          action: "get-feature",
          featureId: "feature-1",
          includeHistorical: false,
          ...featurePageDefaults,
        },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled");
    vi.spyOn(store, "getEntry").mockResolvedValue(undefined);
    await expect(
      host.executeContextOperation(
        {
          action: "get-feature",
          featureId: "feature-1",
          includeHistorical: true,
          ...featurePageDefaults,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("preserves search scope, exclusions and non-exhaustive evidence", async () => {
    const { host, store, record } = await featureFixture(true);
    const coverage = {
      policy: "shared-valid-musical-cells" as const,
      comparedValues: record.feature.values!.length,
      totalValues: record.feature.values!.length,
    };
    const search = vi.spyOn(store, "searchFeatures").mockResolvedValue({
      matches: [{ feature: record, distance: 0, coverage }],
      scannedCount: 1,
      comparableCount: 1,
      eligibleCount: 2,
      excludedCount: 0,
      exhaustive: false,
      limitsHit: ["candidates"],
      exclusionReasons: {},
    });
    const result = await host.executeContextOperation(
      {
        action: "search-features",
        featureId: "feature-1",
        excludeContextIds: ["other-source"],
        includeHistorical: true,
        limit: 10,
        candidateLimit: 1,
      },
      context,
    );
    expect(contextOperationResultSchema.parse(result)).toMatchObject({
      exhaustive: false,
      scannedCount: 1,
      limitsHit: ["candidates"],
      exclusionReasons: {},
      distanceDefinition: "rms-linear-amplitude/v1",
      matches: [
        { distance: 0, coverage, feature: { source: { contextId: "entry" } } },
      ],
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeEntryIds: ["other-source"],
        candidateLimit: 1,
      }),
      expect.objectContaining({ trace }),
    );
  });

  it("uses search-owned source freshness without another candidate lookup or revalidation", async () => {
    const { host, store, record, getFeature } = await featureFixture();
    const listEntries = vi.spyOn(store, "listEntries");
    const listLinks = vi.spyOn(store, "listLinks");
    vi.spyOn(store, "searchFeatures").mockResolvedValue({
      matches: [
        {
          feature: {
            ...record,
            freshness: {
              status: "unknown",
              assessedAt: timestamp,
              reason: "revalidation budget exhausted",
            },
          },
          distance: 0,
        },
      ],
      scannedCount: 1,
      comparableCount: 1,
      eligibleCount: 1,
      excludedCount: 0,
      exhaustive: true,
      limitsHit: [],
      exclusionReasons: {},
    });
    const result = await host.executeContextOperation(
      {
        action: "search-features",
        featureId: record.id,
        excludeContextIds: [],
        includeHistorical: false,
        limit: 10,
        candidateLimit: 1000,
      },
      context,
    );
    expect(contextOperationResultSchema.parse(result)).toMatchObject({
      matches: [
        {
          feature: {
            record: {
              freshness: {
                status: "unknown",
                reason: "revalidation budget exhausted",
              },
            },
            source: { freshness: "unknown" },
          },
        },
      ],
    });
    expect(getFeature).toHaveBeenCalledTimes(1);
    expect(listEntries).not.toHaveBeenCalled();
    expect(listLinks).not.toHaveBeenCalled();
  });
});

function metricFixture(): MetricAudioObservation {
  const value = createSyntheticMetricListeningObservation({ endBeat: 4 });
  Object.assign(value.ownership, trace);
  const spectral = value.metrics["spectral-centroid"];
  spectral.status = "failed";
  spectral.gaps = [
    {
      firstIndex: 0,
      count: spectral.expectedRecords,
      startSample: spectral.records[0]!.support.startSample,
      endSample: spectral.records.at(-1)!.support.endSample,
      reason: "drain-timeout",
      detail: "No validated frames",
    },
  ];
  spectral.records = [];
  const [first, quiet, rise] = value.metrics.attacks.records;
  quiet!.inputLevel = { peak: [0, 0], rms: [0, 0] };
  quiet!.events = [];
  rise!.events = first!.events.map((event) => ({
    ...event,
    sample: rise!.support.endSample,
  }));
  value.outcome = "partial";
  value.rows = createMetricObservationReportRows(value);
  return metricAudioObservationSchema.parse(value);
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture(
  name = "Known sine",
  supplied?: StoredAudioObservation,
): Promise<{
  store: EntityContextRepository;
  host: ReturnType<typeof createSessionContextHost>;
  payload: StoredAudioObservation;
}> {
  if (supplied?.schema === "metric-audio-observation/v1") {
    // This host boundary consumes typed repository reads; metric publication is
    // independently owned and validated by the publication/repository tests.
    const seeded = await fixture(name);
    const { rows, geometry, metrics, ...provenance } = supplied;
    const { rows: geometryRows, ...coordinates } = geometry;
    expect(rows.length).toBe(supplied.reduction.retainedReportRows);
    expect(geometryRows.length).toBe(supplied.reduction.originalReportRows);
    const metricSummary = <T extends { records: unknown[] }>(metric: T) => {
      const { records, ...summary } = metric;
      return { ...summary, retainedRecords: records.length };
    };
    const payload = {
      ...provenance,
      geometry: coordinates,
      metrics: {
        level: metricSummary(metrics.level),
        "spectral-centroid": metricSummary(metrics["spectral-centroid"]),
        attacks: metricSummary(metrics.attacks),
      },
    };
    const listEntries = seeded.store.listEntries.bind(seeded.store);
    const getEntry = seeded.store.getEntry.bind(seeded.store);
    vi.spyOn(seeded.store, "listEntries").mockImplementation(
      async (...args) => {
        const page = await listEntries(...args);
        return {
          ...page,
          items: page.items.map((entry) => ({
            ...entry,
            kind: supplied.schema,
            payload,
          })),
        };
      },
    );
    vi.spyOn(seeded.store, "getEntry").mockImplementation(async (...args) => {
      const entry = await getEntry(...args);
      return entry === undefined
        ? undefined
        : { ...entry, kind: supplied.schema, payload: supplied };
    });
    return { ...seeded, payload: supplied };
  }
  const store = await createInMemorySessionContextStore({
    sessionId: context.sessionId,
    liveSetId: "set-a",
  });
  stores.push(store);
  const binding = {
    version: 1 as const,
    semanticLocator: {
      name,
      trackId: "track",
      arrangementRange: { startBeat: 0, endBeat: 4 },
    },
    sourceIdentity: "fixture:known-sine",
    playbackSettingsHash: "gain-zero",
    upstreamProcessingHash: "none",
    routingHash: "stereo",
    dependencyScope: "unknown" as const,
    previousRuntimeBindings: ["old-bridge-reference"],
  };
  const payload =
    supplied ??
    audioObservationSchema.parse({
      schema: "audio-observation/v1",
      listenerId: "listener",
      passId: "pass",
      sampleRate: 48_000,
      startSample: 0,
      endSample: 96_000,
      startBeat: 0,
      endBeat: 4,
      complete: true,
      limitations: [
        "Stored synthetic query fixture; not real-device validation",
      ],
      algorithm: {
        name: "fixture",
        version: "fixture-v1",
        windowSamples: 4800,
        hopSamples: 4800,
        settings: { attackThresholdDb: 6, minAttackSpacingSamples: 480 },
        units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
        timingUncertaintySamples: 0,
      },
      summaries: {
        peak: [0.5, 0.5],
        rmsDbfs: [-12.158, -12.158],
        centroidHz: 440,
      },
      samples: [],
      attacks: [],
      reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
    });
  const legacy: AppendContextPass = {
    pass: {
      id: "pass",
      sessionId: context.sessionId,
      liveSetId: "set-a",
      initiatorAgentId: "writer",
      listenerIds: ["listener"],
      requestedMode: "arrangement",
      actualMode: "arrangement",
      requestedRange: { startBeat: 0, endBeat: 4 },
      actualRange: { startBeat: 0, endBeat: 4 },
      status: "completed",
      complete: true,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: "2026-10-12T00:00:02.000Z",
      interruptionReason: null,
      trace,
    },
    subjects: [
      {
        id: "subject",
        sessionId: context.sessionId,
        liveSetId: "set-a",
        kind: "clip",
        trackId: "track",
        location: "arrangement",
        binding,
      },
    ],
    entries: [
      {
        id: "entry",
        sessionId: context.sessionId,
        liveSetId: "set-a",
        passId: "pass",
        kind: payload.schema,
        producer: {
          listenerId: "listener",
          deviceId: "device",
          agentId: "writer",
          connectionEpoch: "epoch",
          version: "fixture-v1",
        },
        createdAt: timestamp,
        capturedAt: timestamp,
        trace,
        payload,
      },
    ],
    links: [
      {
        id: "link",
        sessionId: context.sessionId,
        liveSetId: "set-a",
        entryId: "entry",
        subjectId: "subject",
        relationship: "primary",
        coverage: { startBeat: 0, endBeat: 4 },
        attribution: "unknown",
        observedContributorIds: [],
        sourceFingerprint: binding,
        freshness: {
          status: "unknown",
          assessedAt: timestamp,
          reason: "Current source is unverified",
        },
      },
    ],
  };
  if (payload.schema === "session-audio-observation/v1") {
    const track = {
      ...legacy.subjects[0]!,
      id: "track",
      kind: "track" as const,
      location: "track" as const,
      binding: {
        ...binding,
        previousRuntimeBindings: [
          payload.source.target.track.expectedReference,
        ],
      },
    };
    let sequence = 0;
    await store.appendPass(
      buildListeningPublication(
        {
          passId: "pass",
          owner: {
            sessionId: context.sessionId,
            liveSetId: "set-a",
            agentId: "writer",
          },
          trace,
          requestedMode: "session",
          actualMode: "session",
          requestedRange: { startBeat: 0, endBeat: 4 },
          createdAt: timestamp,
          startedAt: timestamp,
          endedAt: timestamp,
          observations: [payload],
          bindings: [
            {
              listenerId: "listener",
              deviceReference: "device",
              connectionEpoch: "epoch",
              version: "fixture-v1",
              primary: {
                ...track,
                id: "subject",
                kind: "clip",
                location: "session",
                binding: {
                  ...binding,
                  semanticLocator: {
                    name,
                    trackId: "track",
                    sceneIndex: payload.source.target.sceneIndex,
                  },
                  previousRuntimeBindings: [
                    payload.source.target.expectedClipReference,
                  ],
                },
              },
              contributors: [track],
              attribution: "unknown",
            },
          ],
        },
        () => (sequence++ === 0 ? "entry" : `link-${sequence}`),
      ),
    );
  } else {
    await store.appendPass(legacy);
  }
  const host = createSessionContextHost({
    resolveRepository: async () => store,
  });
  return { store, host, payload };
}

describe("typed App-session context host", () => {
  it("reads a bounded stacked metric timeline with deterministic continuation and no full payload", async () => {
    const observation = createSyntheticMetricListeningObservation({
      endBeat: 4,
    });
    const { host, store } = await fixture("Stacked complete", observation);
    const read = vi.spyOn(store, "getEntry");
    const first = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          ...reportDefaults,
          action: "report",
          contextId: "entry",
          includeHistorical: true,
        },
        context,
      ),
    );
    if (first.action !== "report") throw new Error("Expected report");
    expect(first).not.toHaveProperty("observation");
    expect(first.report).toMatchObject({
      observationOutcome: "complete",
      offset: 0,
      totalRows: 16,
      nextOffset: 8,
    });
    expect(first.report.rows).toHaveLength(8);
    expect(first.report.rows[0]).toMatchObject({
      index: 0,
      startBeat: 0,
      endBeat: 0.25,
      startSample: 10_000,
      endSample: 16_000,
      level: { availability: "available", records: [{ rms: [0.25, 0.25] }] },
      "spectral-centroid": {
        availability: "available",
        centroidHz: 500,
        frameCount: 2,
        supports: [
          { startSample: 10_000, endSample: 12_048 },
          { startSample: 12_048, endSample: 14_096 },
        ],
      },
    });
    expect(read).toHaveBeenCalledWith("entry", {
      trace,
      activeAgentId: "reader",
    });
    const last = await host.executeContextOperation(
      {
        ...reportDefaults,
        action: "report",
        contextId: "entry",
        offset: first.report.nextOffset!,
        limit: 32,
      },
      context,
    );
    expect(last).toMatchObject({
      action: "report",
      report: { offset: 8, nextOffset: null },
    });
    if (last.action !== "report") throw new Error("Expected last page");
    expect(last.report.rows).toHaveLength(8);
    const end = await host.executeContextOperation(
      { ...reportDefaults, action: "report", contextId: "entry", offset: 16 },
      context,
    );
    expect(end).toMatchObject({
      action: "report",
      report: { offset: 16, rows: [], nextOffset: null },
    });
  });

  it("reads selected report rows with native identities and retained-position continuation", async () => {
    const observation = createSyntheticMetricListeningObservation();
    observation.rows = [observation.rows[0]!, observation.rows[2]!];
    observation.reduction = {
      mode: "selected-report-rows",
      originalReportRows: 4,
      retainedReportRows: 2,
      authoritativeTimelines: "retained",
    };
    const { host } = await fixture("Selected report rows", observation);
    for (const [offset, index] of [
      [0, 0],
      [1, 2],
    ] as const) {
      const result = contextOperationResultSchema.parse(
        await host.executeContextOperation(
          {
            ...reportDefaults,
            action: "report",
            contextId: "entry",
            offset,
            limit: 1,
          },
          context,
        ),
      );
      if (result.action !== "report") throw new Error("Expected report");
      expect(result.report).toMatchObject({
        observationOutcome: "complete",
        reduction: observation.reduction,
        offset,
        nextOffset: offset === 0 ? 1 : null,
        totalRows: 2,
      });
      expect(result.report.rows.map((row) => row.index)).toEqual([index]);
    }
  });

  it("preserves partial acquisition and missing row support without fake spectral zeros", async () => {
    const observation = metricFixture();
    const { host } = await fixture("Stacked partial", observation);
    const result = await host.executeContextOperation(
      { ...reportDefaults, action: "report", contextId: "entry", limit: 1 },
      context,
    );
    if (result.action !== "report") throw new Error("Expected report");
    expect(result.report).toMatchObject({
      observationOutcome: "partial",
      metricStatus: { "spectral-centroid": "failed" },
    });
    expect(result.report.rows[0]).toMatchObject({
      level: { availability: "available", records: [{ rms: [0.25, 0.25] }] },
      "spectral-centroid": {
        availability: "missing",
        centroidHz: null,
        spectralEnergy: null,
        frameCount: 0,
        gaps: [
          {
            reason: "drain-timeout",
            support: { startSample: 10_000, endSample: 104_208 },
          },
        ],
      },
      attacks: {
        availability: "available",
        events: [observation.metrics.attacks.records[0]!.events[0]],
      },
    });
  });

  it("preserves byte-limited canonical continuation through the application response without changing acquisition outcome", async () => {
    const observation = createSyntheticMetricListeningObservation({
      tempoBpm: 20,
      endBeat: 10,
    });
    observation.limitations = Array.from({ length: 16 }, () =>
      "界".repeat(240),
    );
    for (const name of nativeMetricObservationMetricSchema.options) {
      observation.metrics[name].limitations = Array.from({ length: 8 }, () =>
        "界".repeat(240),
      );
    }
    const { host } = await fixture(
      "Byte-limited report",
      metricAudioObservationSchema.parse(observation),
    );
    const first = await host.executeContextOperation(
      { ...reportDefaults, action: "report", contextId: "entry", limit: 32 },
      context,
    );
    if (first.action !== "report") throw new Error("Expected report");
    expect(first.report.pageBudget).toEqual({
      byteLimit: 48 * 1024,
      requestedRowLimit: 32,
      byteLimited: true,
    });
    expect(first.report.rows.length).toBeGreaterThan(0);
    expect(first.report.rows.length).toBeLessThan(32);
    expect(first.report.observationOutcome).toBe("complete");
    expect(first.report.nextOffset).toBe(first.report.rows.length);
    expect(
      new TextEncoder().encode(JSON.stringify(first.report)).byteLength,
    ).toBeLessThanOrEqual(48 * 1024);
    expect(
      new TextEncoder().encode(JSON.stringify(first)).byteLength,
    ).toBeLessThanOrEqual(64 * 1024);
    const next = await host.executeContextOperation(
      {
        ...reportDefaults,
        action: "report",
        contextId: "entry",
        offset: first.report.nextOffset!,
        limit: 32,
      },
      context,
    );
    if (next.action !== "report") throw new Error("Expected continuation");
    expect(next.report.rows[0]?.index).toBe(first.report.rows.length);
    expect(next.report.limitations).toEqual(observation.limitations);
    expect(next.report.metricMetadata.attacks.algorithm).toEqual(
      observation.metrics.attacks.algorithm,
    );
  });
  it.each([false, true])(
    "distinguishes no-frame and measured silence in reports (silence=%s)",
    async (silence) => {
      const observation = createSyntheticMetricListeningObservation({
        endBeat: silence ? 4 : 0.01,
      });
      if (silence) {
        observation.metrics.level.records.forEach((record) => {
          record.peak = [0, 0];
          record.rms = [0, 0];
        });
        observation.metrics["spectral-centroid"].records.forEach((frame) => {
          frame.centroidHz = null;
          frame.spectralEnergy = 0;
        });
        observation.metrics.attacks.records.forEach((window) => {
          window.inputLevel = { peak: [0, 0], rms: [0, 0] };
          window.events = [];
        });
        observation.rows = createMetricObservationReportRows(observation);
      }
      const { host } = await fixture("Spectral support", observation);
      const result = contextOperationResultSchema.parse(
        await host.executeContextOperation(
          { ...reportDefaults, action: "report", contextId: "entry", limit: 1 },
          context,
        ),
      );
      if (result.action !== "report") throw new Error("Expected report");
      expect(result.report.rows[0]?.["spectral-centroid"]).toMatchObject({
        availability: silence ? "available" : "no-frame",
        frameCount: silence ? 2 : 0,
        centroidHz: null,
        spectralEnergy: silence ? 0 : null,
      });
    },
  );

  it("refuses legacy conversion, invalid/missing pages and foreign session reports without bypassing scoped reads", async () => {
    const { host: legacy } = await fixture();
    await expect(
      legacy.executeContextOperation(
        { ...reportDefaults, action: "report", contextId: "entry" },
        context,
      ),
    ).rejects.toThrow("use get for legacy");
    const { host, store } = await fixture("Scoped report", metricFixture());
    const read = vi.spyOn(store, "getEntry");
    for (const paging of [
      { offset: -1 },
      { offset: 17 },
      { offset: 0.5 },
      { limit: 0 },
      { limit: 33 },
    ]) {
      await expect(
        host.executeContextOperation(
          {
            ...reportDefaults,
            action: "report",
            contextId: "entry",
            ...paging,
          },
          context,
        ),
      ).rejects.toThrow();
    }
    await expect(
      host.executeContextOperation(
        { ...reportDefaults, action: "report", contextId: "entry" },
        { ...context, sessionId: "foreign" },
      ),
    ).rejects.toThrow("another App session");
    read.mockClear();
    vi.spyOn(store, "listEntries").mockResolvedValueOnce({ items: [] });
    await expect(
      host.executeContextOperation(
        { ...reportDefaults, action: "report", contextId: "entry" },
        context,
      ),
    ).rejects.toThrow("session/freshness scope");
    expect(read).not.toHaveBeenCalled();
    read.mockResolvedValueOnce(undefined);
    await expect(
      host.executeContextOperation(
        { ...reportDefaults, action: "report", contextId: "entry" },
        context,
      ),
    ).rejects.toThrow("no longer exists");
    const caller = new AbortController();
    caller.abort(new Error("Cancelled report"));
    read.mockClear();
    await expect(
      host.executeContextOperation(
        { ...reportDefaults, action: "report", contextId: "entry" },
        { ...context, signal: caller.signal },
      ),
    ).rejects.toThrow("Cancelled report");
    expect(read).not.toHaveBeenCalled();
  });

  it("summarizes trustworthy metric records, independent attack events and explicit missing data without legacy aggregates", async () => {
    const observation = metricFixture();
    const { host, store } = await fixture("Metric source", observation);
    const getEntry = vi.spyOn(store, "getEntry");
    const listed = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        { action: "list", includeHistorical: true, limit: 20 },
        context,
      ),
    );
    if (listed.action !== "list") throw new Error("Expected list");
    const summary = listed.entries[0]!.summary;
    expect(summary).toContain("Metric observation outcome partial");
    expect(summary).toContain("level complete: 16/16");
    expect(summary).toContain(
      "spectral-centroid failed: 0/46 validated records; 46 missing records (drain-timeout)",
    );
    expect(summary).toContain("-12.04 dBFS");
    expect(summary).toContain("not a whole-pass aggregate");
    expect(summary).toContain(
      "2 estimated attacks across retained independent windows",
    );
    expect(summary).toContain(
      "Missing data and no-frame intervals are not silence",
    );
    expect(summary).toContain("samples 10000-106000 at 48000 Hz");
    expect(summary).not.toContain("silence/below floor");
    expect(summary).not.toContain("Centroid not observed");
    const detail = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        { action: "get", contextId: "entry", includeHistorical: true },
        context,
      ),
    );
    expect(detail).toMatchObject({
      action: "get",
      entry: {
        passId: "pass",
        listenerId: "listener",
        kind: observation.schema,
      },
      observation,
    });
    const inventory = JSON.parse(
      await host.getSessionContextInventory(context.sessionId, context),
    ) as { entries: Array<{ summary: string }> };
    expect(inventory.entries[0]?.summary).toBe(summary);
    expect(JSON.stringify(inventory)).not.toContain('"records"');
    expect(getEntry).toHaveBeenCalledWith("entry", {
      trace,
      activeAgentId: "reader",
    });
    const projected = await store.listEntries({ includeHistorical: true });
    expect(projected.items[0]?.payload).not.toHaveProperty("rows");
    expect(projected.items[0]?.payload).not.toHaveProperty(
      "metrics.level.records",
    );
    expect(projected.items[0]?.payload).toHaveProperty(
      "metrics.level.retainedRecords",
      16,
    );
  });

  it("fails an unavailable metric timeline read rather than fabricating a summary from projected counts", async () => {
    const { host, store } = await fixture(
      "Disappearing metric source",
      metricFixture(),
    );
    const getEntry = vi.spyOn(store, "getEntry");
    getEntry.mockResolvedValueOnce(undefined);
    await expect(
      host.executeContextOperation(
        { action: "list", includeHistorical: false, limit: 20 },
        context,
      ),
    ).rejects.toThrow("no longer exists");
    getEntry.mockRejectedValueOnce(new Error("Metric timeline read cancelled"));
    await expect(
      host.executeContextOperation(
        { action: "list", includeHistorical: false, limit: 20 },
        context,
      ),
    ).rejects.toThrow("Metric timeline read cancelled");
  });

  it("reports partial level coverage without extrapolating retained RMS into missing intervals", async () => {
    const observation = metricFixture();
    const removed = observation.metrics.level.records.pop()!;
    observation.metrics.level.status = "partial";
    observation.metrics.level.gaps = [
      {
        firstIndex: removed.index,
        count: 1,
        ...removed.support,
        reason: "sequence-gap",
        detail: "Final interval missing",
      },
    ];
    observation.metrics.attacks = {
      status: "not-requested",
      expectedRecords: 0,
      algorithm: null,
      records: [],
      gaps: [],
      limitations: [],
    };
    observation.requestedMetrics = ["level", "spectral-centroid"];
    observation.rows = createMetricObservationReportRows(observation);
    const { host } = await fixture(
      "Partial levels",
      metricAudioObservationSchema.parse(observation),
    );
    const result = await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      context,
    );
    if (result.action !== "list") throw new Error("Expected list");
    const summary = result.entries[0]!.summary;
    expect(summary).toContain("outcome partial");
    expect(summary).toContain(
      "level partial: 15/16 validated records; 1 missing records (sequence-gap)",
    );
    expect(summary).toContain("Retained level records: RMS ranges");
    expect(summary).not.toContain("silence (measured zero)");
  });

  it("distinguishes measured silence, nonrequested metrics and Session geometry from missing spectra", async () => {
    const observation = metricFixture();
    observation.metrics.level.records.forEach((record) => {
      record.peak = [0, 0];
      record.rms = [0, 0];
    });
    observation.metrics.attacks = {
      status: "not-requested",
      expectedRecords: 0,
      algorithm: null,
      records: [],
      gaps: [],
      limitations: [],
    };
    observation.requestedMetrics = ["level", "spectral-centroid"];
    observation.source = {
      view: "session",
      target: {
        view: "session",
        track: {
          kind: "regular",
          index: 0,
          expectedReference: "00000000-0000-4000-8000-000000000001",
          expectedName: "Track",
        },
        sceneIndex: 0,
        expectedClipReference: "00000000-0000-4000-8000-000000000002",
        expectedClipName: "Clip",
      },
      clipReference: "00000000-0000-4000-8000-000000000002",
      kind: "midi",
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
      transport: { startBeat: 0, endBeat: 4 },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
    observation.rows = createMetricObservationReportRows(observation);
    const { host } = await fixture(
      "Silent metric session",
      metricAudioObservationSchema.parse(observation),
    );
    const result = await host.executeContextOperation(
      { action: "list", includeHistorical: true, limit: 20 },
      context,
    );
    if (result.action !== "list") throw new Error("Expected list");
    const summary = result.entries[0]!.summary;
    expect(summary).toContain("silence (measured zero)");
    expect(summary).toContain("attacks not-requested");
    expect(summary).toContain("spectral-centroid failed");
    expect(summary).toContain(
      "clip-local beats 0-4; global transport beats 0-4; midi",
    );
    expect(summary).not.toContain("Infinity");
    expect(summary).not.toContain("0 estimated attacks");
  });

  it("labels complete metric data without fabricating a legacy centroid aggregate", async () => {
    const observation = metricFixture();
    const spectral = observation.metrics["spectral-centroid"];
    spectral.status = "complete";
    spectral.gaps = [];
    spectral.records = Array.from(
      { length: spectral.expectedRecords },
      (_, index) => ({
        index,
        support: {
          startSample: 10_000 + index * 2048,
          endSample: 10_000 + (index + 1) * 2048,
        },
        centroidHz: index === 0 ? null : 500,
        spectralEnergy: index === 0 ? 0 : 2,
      }),
    );
    observation.outcome = "complete";
    observation.rows = createMetricObservationReportRows(observation);
    const { host } = await fixture(
      "Complete metrics",
      metricAudioObservationSchema.parse(observation),
    );
    const result = await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      context,
    );
    if (result.action !== "list") throw new Error("Expected list");
    expect(result.entries[0]!.summary).toContain("outcome complete");
    expect(result.entries[0]!.summary).toContain(
      "centroid range 500.0-500.0 Hz; 1 measured zero-energy frames",
    );
  });

  it("exposes Session local and transport coordinates plus historical timing limitations in existing typed APIs", async () => {
    const observation: StoredAudioObservation = {
      ...createSyntheticNativeListeningFixtureV2({ listenerId: "listener" })
        .observation,
      schema: "session-audio-observation/v1",
      source: {
        view: "session",
        target: {
          view: "session",
          track: {
            kind: "regular",
            index: 0,
            expectedReference: "00000000-0000-4000-8000-000000000001",
            expectedName: "Track",
          },
          sceneIndex: 0,
          expectedClipReference: "00000000-0000-4000-8000-000000000002",
          expectedClipName: "Clip",
        },
        kind: "midi",
        coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
        transport: { startBeat: 40, endBeat: 44 },
        origin: {
          evidence: "message-rate-start-time-with-native-transport",
          clipStartTimeBeats: 40,
          observedAtGlobalBeat: 40,
        },
        continuity: {
          evidence: "message-rate-monitored",
          followActions: "unknown",
        },
      },
    };
    const { host } = await fixture("Session clip", observation);
    const detail = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: "entry",
          includeHistorical: true,
        },
        context,
      ),
    );
    expect(detail).toMatchObject({
      action: "get",
      observation,
      entry: { kind: "session-audio-observation/v1", freshness: "unknown" },
    });
    if (detail.action !== "get") throw new Error("Expected detail");
    expect(detail.entry.summary).toContain("clip-local-beats 0-4");
    expect(detail.entry.summary).toContain("global transport beats 40-44");
    expect(detail.entry.summary).toContain("not physical source proof");
    expect(detail.entry.summary).toContain("absolute error unknown");
    expect(detail.entry.summary).toContain(
      "Follow actions unknown, not disabled",
    );
    expect(detail.entry.summary).toContain("detection-limited");
    expect(
      await host.getSessionContextInventory(context.sessionId, context),
    ).toContain("connection-scoped");
  });

  it("returns v2 inventory and detail with approximate quality and actual-rate milliseconds", async () => {
    const { observation } = createSyntheticNativeListeningFixtureV2({
      listenerId: "listener",
    });
    observation.sampleRate = observation.alignment.sampleRate = 44_100;
    observation.alignment.observedClockDisagreementSamples = 64;
    const { host } = await fixture("Descriptive query fixture", observation);
    const listed = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "list",
          limit: 20,
          includeHistorical: false,
        },
        context,
      ),
    );
    expect(listed).toMatchObject({
      action: "list",
      entries: [{ kind: "audio-observation/v2" }],
    });
    if (listed.action !== "list") throw new Error("Unexpected context result");
    expect(listed.entries[0]?.summary).toContain(
      "Approximate descriptive-only timing; absolute error unknown",
    );
    expect(listed.entries[0]?.summary).toContain("64 samples (1.451 ms)");
    const detail = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: "entry",
          includeHistorical: false,
        },
        context,
      ),
    );
    expect(detail).toMatchObject({
      action: "get",
      observation: {
        schema: "audio-observation/v2",
        alignment: { verifiedAbsoluteErrorBoundSamples: null },
      },
    });
    expect(
      await host.getSessionContextInventory(context.sessionId, context),
    ).toContain("Approximate descriptive-only timing");
  });

  it("propagates caller cancellation and prevents cancelled pruning", async () => {
    const { host, store } = await fixture();
    const controller = new AbortController();
    const list = vi.spyOn(store, "listEntries");
    await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      { ...context, signal: controller.signal },
    );
    expect(list.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(
      host.executeContextOperation(
        {
          action: "prune",
          contextIds: ["entry"],
          confirm: "prune-session-context",
        },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toThrow("caller cancelled");
    expect(await store.getEntry("entry")).toBeDefined();
  });

  it("aborts stalled repository resolution without cancelling the host lifetime", async () => {
    const caller = new AbortController();
    const lifetime = new AbortController();
    const host = createSessionContextHost({
      signal: lifetime.signal,
      resolveRepository: () => new Promise(() => {}),
    });
    const query = host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      { ...context, signal: caller.signal },
    );
    caller.abort(new Error("cancelled during resolution"));
    await expect(query).rejects.toThrow("cancelled during resolution");
    expect(lifetime.signal.aborted).toBe(false);
  });

  it("attributes trusted application reads without a fabricated active-agent ID", async () => {
    const { store } = await fixture();
    const query = vi.spyOn(store, "listEntries");
    const host = createSessionContextHost({
      resolveRepository: async () => store,
    });
    await host.executeContextOperation(
      { action: "list", includeHistorical: true, limit: 20 },
      { ...context, actorKind: "application", agentId: "desktop-context" },
    );
    expect(query.mock.calls[0]?.[1]).toHaveProperty("trace", trace);
    expect(query.mock.calls[0]?.[1]).not.toHaveProperty("activeAgentId");
  });
  it("queries real repository history without claiming unknown data is fresh", async () => {
    const { host, payload } = await fixture();
    const current = await host.executeContextOperation(
      { action: "list", includeHistorical: false, limit: 20 },
      context,
    );
    expect(current).toMatchObject({
      action: "list",
      entries: [{ freshness: "unknown" }],
    });
    const historical = contextOperationResultSchema.parse(
      await host.executeContextOperation(
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        context,
      ),
    );
    expect(historical.action).toBe("list");
    if (historical.action !== "list") throw new Error("Expected list");
    expect(historical.entries).toHaveLength(1);
    expect(historical.entries[0]).toMatchObject({
      contextId: "entry",
      subjectId: "subject",
      freshness: "unknown",
    });
    expect(historical.entries[0]?.summary).toContain("Known sine");
    expect(historical.entries[0]?.summary).toContain("Attribution unknown");
    const detail = await host.executeContextOperation(
      {
        action: "get",
        contextId: "entry",
        includeHistorical: true,
      },
      context,
    );
    expect(contextOperationResultSchema.parse(detail)).toMatchObject({
      action: "get",
      observation: payload,
    });
    expect(
      await host.executeContextOperation(
        {
          action: "get",
          contextId: "entry",
          includeHistorical: false,
        },
        context,
      ),
    ).toMatchObject({ action: "get", entry: { freshness: "unknown" } });
  });

  it("rejects cross-session resolver leakage and mismatched inventory ownership", async () => {
    const { host } = await fixture();
    await expect(
      host.executeContextOperation(
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        { ...context, sessionId: "another-session" },
      ),
    ).rejects.toThrow("another App session");
    await expect(
      host.getSessionContextInventory("another-session", context),
    ).rejects.toThrow("invoking owner");
  });

  it("retains bounded inventory with historical names and without measurement arrays", async () => {
    const { host } = await fixture();
    const inventory = await host.getSessionContextInventory(
      context.sessionId,
      context,
    );
    expect(inventory.length).toBeLessThanOrEqual(16_384);
    expect(inventory).toContain("Known sine");
    expect(inventory).toContain('"freshness":"unknown"');
    expect(inventory).not.toContain('"samples"');
    expect(inventory).not.toContain('"attacks"');
  });

  it("prunes only exact owned IDs and refuses a partially invalid selection before deletion", async () => {
    const { store, host } = await fixture();
    await expect(
      host.executeContextOperation(
        {
          action: "prune",
          contextIds: ["entry", "missing"],
          confirm: "prune-session-context",
        },
        context,
      ),
    ).rejects.toThrow("existing context IDs");
    expect(await store.getEntry("entry")).toBeDefined();
    expect(
      await host.executeContextOperation(
        {
          action: "prune",
          contextIds: ["entry"],
          confirm: "prune-session-context",
        },
        context,
      ),
    ).toEqual({ action: "prune", prunedContextIds: ["entry"] });
    expect(await store.getEntry("entry")).toBeUndefined();
  });

  it("forwards each caller's trace and agent to repository reads", async () => {
    const { store, host } = await fixture();
    const list = vi.spyOn(store, "listEntries");
    await host.executeContextOperation(
      { action: "list", includeHistorical: true, limit: 20 },
      context,
    );
    expect(list.mock.lastCall?.[1]).toEqual({ trace, activeAgentId: "reader" });
    const other = {
      ...context,
      agentId: "other",
      trace: { ...trace, correlationId: "next-query" },
    };
    await host.getSessionContextInventory(context.sessionId, other);
    expect(list.mock.lastCall?.[1]).toEqual({
      trace: other.trace,
      activeAgentId: "other",
    });
  });

  it("reports missing/corrupt repositories rather than fabricating an empty inventory", async () => {
    const host = createSessionContextHost({
      resolveRepository: async () => {
        throw new Error("Context store recovery required");
      },
    });
    await expect(
      host.getSessionContextInventory(context.sessionId, context),
    ).rejects.toThrow("recovery required");
  });

  it("cancels before opening a repository and does not expose data", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Context host closing"));
    const resolveRepository = vi.fn();
    const host = createSessionContextHost({
      resolveRepository,
      signal: controller.signal,
    });
    await expect(
      host.executeContextOperation(
        {
          action: "list",
          includeHistorical: true,
          limit: 20,
        },
        context,
      ),
    ).rejects.toThrow("host closing");
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it("keeps inventories valid JSON while dropping excess summaries explicitly", async () => {
    const { store, host } = await fixture("A".repeat(500));
    const page = await store.listEntries({ includeHistorical: true });
    const entry = page.items[0];
    if (entry === undefined) throw new Error("Expected fixture entry");
    vi.spyOn(store, "listEntries").mockResolvedValue({
      items: [entry],
      nextCursor: "bounded-repository-continuation",
    });
    const inventory = await host.getSessionContextInventory(
      context.sessionId,
      context,
    );
    expect(inventory.length).toBeLessThanOrEqual(16_384);
    const result: unknown = JSON.parse(inventory);
    expect(result).toMatchObject({ truncated: true });
  });
});
