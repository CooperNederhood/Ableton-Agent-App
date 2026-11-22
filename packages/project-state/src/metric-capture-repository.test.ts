import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  MEL_BAND_PROFILE,
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  DEFAULT_LISTENING_TIMING_POLICY,
  acceptMetricRecordChunk,
  createContinuousMetricListeningGeometry,
  createMetricRecordStreamState,
  metricRecordChunkDigest,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamExpectedCoverage,
  metricRecordStreamManifestSchema,
  type MetricRecordChunk,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamState,
  type NativeMetricLaunchProof,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticMetricSpectrumEvidence,
} from "@ableton-agent/protocol/testing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import {
  createInMemorySessionContextStore,
  openSessionContextStore,
  type SessionContextStore,
} from "./context-repository.js";
import {
  metricCapturePageSchema,
  metricCaptureRecordSchema,
  metricChunkPageSchema,
  type MetricCaptureStart,
} from "./metric-capture-schemas.js";
import type { AppendContextPass } from "./context-schemas.js";

const now = "2026-11-14T12:00:00.000Z";
const stores: SessionContextStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function fixture(seconds = 0.5): MetricCaptureStart {
  const observation = createSyntheticMetricListeningObservation();
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "finite-metric-stream",
    sampleRate: 48_000,
    vectorSize: 64,
    tempoBpm: 120,
    startBeat: 0,
    endBeat: seconds * 2,
    startSample: 10_000,
  });
  const descriptor = metricRecordStreamDescriptorSchema.parse({
    schema: "metric-record-stream/v1",
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    ownership: observation.ownership,
    source: {
      ...observation.source,
      transport: { startBeat: 0, endBeat: seconds * 2 },
    },
    geometry,
    timingPolicy: DEFAULT_LISTENING_TIMING_POLICY,
    maxPendingChunks: 8,
    requestedMetrics: [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ],
    algorithms: [
      ...(["level", "spectral-centroid", "attacks"] as const).map((metric) => ({
        metric,
        algorithm: observation.metrics[metric].algorithm,
        availability: "available",
        unavailableReason: null,
      })),
      {
        metric: "mel-bands",
        algorithm: MEL_BAND_PROFILE,
        availability: "available",
        unavailableReason: null,
      },
      {
        metric: "pitch",
        algorithm: PITCH_PROFILE,
        availability: "available",
        unavailableReason: null,
      },
      {
        metric: "spectral-shape",
        algorithm: SPECTRAL_SHAPE_PROFILE,
        availability: "available",
        unavailableReason: null,
      },
    ],
  });
  const trace = {
    traceId: descriptor.ownership.traceId,
    correlationId: descriptor.ownership.correlationId,
    causationId: descriptor.ownership.causationId,
  };
  const range = { startBeat: 0, endBeat: seconds * 2 };
  return {
    descriptor,
    metadata: {
      id: "capture:1",
      trace,
      pass: {
        id: "pass",
        sessionId: "session:1",
        liveSetId: "set:1",
        initiatorAgentId: "agent:1",
        listenerIds: ["listener"],
        requestedMode: "arrangement",
        actualMode: "arrangement",
        requestedRange: range,
        actualRange: null,
        status: "partial",
        complete: false,
        createdAt: now,
        startedAt: now,
        endedAt: now,
        interruptionReason: null,
        trace,
      },
      producer: {
        listenerId: "listener",
        deviceId: "device:1",
        agentId: "agent:1",
        connectionEpoch: descriptor.ownership.connectionEpoch,
        version: "1",
      },
      subject: {
        id: "subject:1",
        sessionId: "session:1",
        liveSetId: "set:1",
        kind: "arrangement-range",
        binding: {
          version: 1,
          semanticLocator: {
            name: "Diagnostic token=secret",
            arrangementRange: range,
          },
          sourceIdentity: "source:1",
          playbackSettingsHash: "settings:1",
          upstreamProcessingHash: "upstream:1",
          routingHash: "routing:1",
          dependencyScope: "unknown",
          previousRuntimeBindings: [
            descriptor.source.view === "arrangement"
              ? descriptor.source.target.expectedReference
              : descriptor.source.clipReference,
          ],
        },
      },
    },
  };
}

function completedPass(start: MetricCaptureStart) {
  return {
    ...start.metadata.pass,
    status: "completed" as const,
    complete: true,
    actualRange: start.metadata.pass.requestedRange,
  };
}

function record(
  descriptor: MetricRecordStreamDescriptor,
  metric: MetricRecordChunk["metric"],
  index: number,
) {
  const g = descriptor.geometry;
  const hop = metric === "attacks" ? 4800 : 2048;
  const row = g.rows[index];
  const support =
    metric === "level"
      ? { startSample: row!.startSample, endSample: row!.endSample }
      : {
          startSample: g.startSample + index * hop,
          endSample: Math.min(g.startSample + (index + 1) * hop, g.endSample),
        };
  switch (metric) {
    case "level":
      return { index, support, peak: [0.5, 0.5], rms: [0.25, 0.25] };
    case "spectral-centroid":
      return { index, support, centroidHz: 500, spectralEnergy: 2 };
    case "attacks":
      return {
        index,
        support,
        inputLevel: { peak: [0, 0], rms: [0, 0] },
        events: [],
      };
    case "mel-bands":
      return {
        index,
        support,
        magnitudes: [
          Array(MEL_BAND_PROFILE.bandCount).fill(0.1),
          Array(MEL_BAND_PROFILE.bandCount).fill(0.2),
        ],
      };
    case "pitch":
      return {
        index,
        support,
        channels: [
          { state: "undefined", hz: 0, confidence: 0 },
          { state: "silence", hz: null, confidence: null },
        ],
      };
    case "spectral-shape":
      return {
        index,
        support,
        channels: [
          {
            state: "undefined",
            flatnessDb: null,
            spreadHz: null,
            rolloffHz: null,
          },
          {
            state: "silence",
            flatnessDb: null,
            spreadHz: null,
            rolloffHz: null,
          },
        ],
      };
  }
}

async function chunk(
  descriptor: MetricRecordStreamDescriptor,
  state: MetricRecordStreamState,
  metric: MetricRecordChunk["metric"],
  count?: number,
) {
  const prefix = state.metrics.find((item) => item.metric === metric)!;
  const expected = metricRecordStreamExpectedCoverage(
    descriptor,
    metric,
  ).expectedRecords;
  const length = Math.min(count ?? 256, expected - prefix.nextIndex);
  const body = {
    schema: "metric-record-chunk/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    metric,
    chunkSequence: prefix.nextChunkSequence,
    recordOffset: prefix.nextRecordOffset,
    slotOffset: prefix.nextIndex,
    previousDigest: prefix.lastDigest,
    digest: "0".repeat(64),
    gaps: [],
    records: Array.from({ length }, (_, index) =>
      record(descriptor, metric, prefix.nextIndex + index),
    ),
  } as MetricRecordChunk;
  return {
    ...body,
    digest: await metricRecordChunkDigest(body),
  } as MetricRecordChunk;
}

function manifest(
  descriptor: MetricRecordStreamDescriptor,
  state: MetricRecordStreamState,
) {
  const g = descriptor.geometry;
  const origin = g.startSample;
  const arm = origin - 1000;
  type Row = NativeMetricLaunchProof["clock"];
  const clock = (
    counter: number,
    playing: boolean,
    stoppedBeat = g.startBeat,
  ): Row => {
    const beat = playing
      ? g.startBeat + (counter - origin) / 24000
      : stoppedBeat;
    return [
      playing ? 1 : 0,
      beat,
      counter + 1000000,
      19,
      counter,
      playing ? beat % 1 : 0.125,
      counter,
      playing ? 1 : 0,
      beat,
      counter + 1000000,
      19,
    ];
  };
  const before = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      clock(arm - (32 - i) * 256, false),
    ),
  };
  const after = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      clock(g.endSample + 64 + i * 64, true),
    ),
  };
  const binding = {
    dsp: [1, g.sampleRate, g.vectorSize],
    frames: Array.from({ length: 32 }, (_, i) =>
      clock(g.endSample + 4096 + i * 64, true),
    ),
  };
  const spectrum = createSyntheticMetricSpectrumEvidence({
    ownership: descriptor.ownership,
    clock: before as Parameters<
      typeof createSyntheticMetricSpectrumEvidence
    >[0]["clock"],
    firstAcquisitionEndpoint: origin - 4096,
    stopWatermark: g.endSample,
  });
  const launched = clock(origin + 64, true);
  const clocks = [...before.frames, ...after.frames, launched];
  const playing = [...after.frames, launched];
  const extreme = (rows: Row[], value: (row: Row) => number, max: boolean) =>
    rows.reduce((a, b) =>
      (max ? value(b) > value(a) : value(b) < value(a)) ? b : a,
    );
  const beatOrigin = (r: Row) =>
    r[2] - Math.round((r[1] - g.startBeat) * 24000);
  const phase = (r: Row) => {
    const difference = Math.abs(
      Math.round(r[5] * 24000) - Math.round((r[1] % 1) * 24000),
    );
    return Math.min(difference, Math.abs(24000 - difference));
  };
  const timing = [
    descriptor.ownership.nativeEpoch,
    1064,
    0,
    0,
    64,
    arm,
    origin,
    3,
  ];
  const configuration = [
    descriptor.ownership.nativeEpoch,
    g.totalSamples,
    4800,
    g.tempoBpm,
    g.startBeat % 1,
    g.vectorSize,
    1,
    g.startBeat,
    g.endBeat,
    g.rows.length,
    descriptor.ownership.nativeEpoch,
    descriptor.ownership.nativeEpoch,
  ];
  return metricRecordStreamManifestSchema.parse({
    schema: "metric-record-stream-manifest/v1",
    descriptorDigest: state.descriptorDigest,
    ownership: descriptor.ownership,
    outcome: "complete",
    limitations: [],
    algorithms: descriptor.algorithms,
    metrics: state.metrics.map((item) => ({
      ...item,
      status: "complete",
      availability: "available",
      ...metricRecordStreamExpectedCoverage(descriptor, item.metric),
    })),
    nativeProof: {
      schema: "metric-record-stream-terminal/v1",
      ownership: descriptor.ownership,
      status: "completed",
      launch: {
        scope: "independent-metric-timelines/v1",
        ownership: descriptor.ownership,
        timing: [
          descriptor.ownership.nativeEpoch,
          1064,
          0,
          1,
          64,
          arm,
          origin,
          3,
        ],
        clock: launched,
        elapsedMs: 100,
      },
      timing,
      confirmedTiming: timing,
      configuration,
      confirmedConfiguration: configuration,
      before,
      after,
      timingWitnesses: {
        minHostOffset: extreme(clocks, (r) => r[2] - r[4], false),
        maxHostOffset: extreme(clocks, (r) => r[2] - r[4], true),
        minBeatOrigin: extreme(playing, beatOrigin, false),
        maxBeatOrigin: extreme(playing, beatOrigin, true),
        maxPhaseDisagreement: extreme(playing, phase, true),
      },
      clock: binding,
      capturedSamples: g.totalSamples,
      sourceOrigin: g.startSample,
      sourceEnd: g.endSample,
      drain: "completed",
      spectrumCleanup: spectrum.spectrumCleanup,
      spectrumPhase: spectrum.spectrumPhase,
    },
  });
}

async function memory(
  options: Partial<
    Parameters<typeof createInMemorySessionContextStore>[0]
  > = {},
) {
  const store = await createInMemorySessionContextStore({
    sessionId: "session:1",
    liveSetId: "set:1",
    ...options,
  });
  stores.push(store);
  return store;
}

async function fill(store: SessionContextStore, start: MetricCaptureStart) {
  const owner = await store.beginMetricCapture(start);
  let state = await createMetricRecordStreamState(start.descriptor);
  for (const metric of start.descriptor.requestedMetrics)
    while (
      state.metrics.find((item) => item.metric === metric)!.nextIndex <
      metricRecordStreamExpectedCoverage(start.descriptor, metric)
        .expectedRecords
    ) {
      const next = await chunk(start.descriptor, state, metric);
      await store.appendMetricChunk(owner, next);
      state = await acceptMetricRecordChunk(start.descriptor, state, next);
    }
  return { owner, state };
}

describe("incremental metric context", () => {
  it("durably stages all six families, independently verifies and atomically publishes a bounded manifest", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const store = await memory({
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    const start = fixture();
    const { owner, state } = await fill(store, start);
    expect(await store.getPass("pass")).toBeUndefined();
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "staging",
    );
    const publication = await store.finalizeMetricCapture(
      owner,
      manifest(start.descriptor, state),
      completedPass(start),
    );
    expect(publication).toEqual({
      contextId: start.metadata.id,
      kind: "metric-record-stream-context/v1",
      passId: "pass",
      subjectId: "subject:1",
      listenerId: "listener",
    });
    const overview = await store.getMetricCapture(owner.captureId);
    expect(metricCaptureRecordSchema.parse(overview)).toEqual(overview);
    expect(
      metricCaptureRecordSchema.safeParse({ ...overview, status: "cancelled" })
        .success,
    ).toBe(false);
    const inventory = await store.listMetricCaptures();
    expect(metricCapturePageSchema.parse(inventory)).toEqual(inventory);
    expect(
      metricCapturePageSchema.safeParse({
        ...inventory,
        encodedBytes: inventory.encodedBytes + 1,
      }).success,
    ).toBe(false);
    expect(overview?.status).toBe("completed");
    expect(overview?.manifest?.metrics).toHaveLength(6);
    expect(await store.getPass("pass")).toMatchObject({ complete: true });
    expect(JSON.stringify(overview)).not.toContain("token=secret");
    expect(start.metadata.subject.binding.semanticLocator.name).toContain(
      "token=secret",
    );
    const pages = await store.listMetricChunks({
      captureId: owner.captureId,
      limit: 2,
    });
    expect(metricChunkPageSchema.parse(pages)).toEqual(pages);
    expect(
      metricChunkPageSchema.safeParse({
        ...pages,
        encodedBytes: pages.encodedBytes + 1,
      }).success,
    ).toBe(false);
    expect(
      metricChunkPageSchema.safeParse({
        items: Array.from({ length: 17 }, () => pages.items[0]),
        encodedBytes: pages.encodedBytes,
      }).success,
    ).toBe(false);
    expect(pages.items).toHaveLength(2);
    expect(pages.nextSequence).toBe(1);
    expect(
      (
        await store.listMetricChunks({
          captureId: owner.captureId,
          afterSequence: pages.nextSequence,
          metric: "pitch",
          range: { startSample: 10000, endSample: 12048 },
        })
      ).items[0]?.metric,
    ).toBe("pitch");
    await expect(
      store.appendMetricChunk(owner, pages.items[0]!),
    ).rejects.toThrow(/stale|terminal/);
    await store.close();
    const phases = events
      .filter((event) => event.name.startsWith("context.metric-finalize."))
      .map((event) => event.stage);
    expect(phases).toEqual([
      "queued",
      "started",
      "progress",
      "progress",
      "completed",
    ]);
    for (const event of events.filter((event) =>
      /context.metric-(stage|chunk|finalize)\./u.test(event.name),
    )) {
      expect(event.trace?.traceId).toBe(start.metadata.trace.traceId);
      expect(event.correlationId).toBe(start.metadata.trace.correlationId);
      expect(event.causationId).toBeTruthy();
      if (event.stage === "completed")
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects mismatched chunks and terminal counts without ever publishing complete context", async () => {
    const store = await memory();
    const start = fixture();
    const { owner, state } = await fill(store, start);
    const terminal = manifest(start.descriptor, state);
    const first = terminal.metrics[0]!;
    const wrong = structuredClone(terminal);
    wrong.metrics[0] = { ...first, lastDigest: "f".repeat(64) };
    await expect(
      store.finalizeMetricCapture(owner, wrong, completedPass(start)),
    ).rejects.toThrow(/mismatch/);
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "failed",
    );
    expect(await store.getPass("pass")).toBeUndefined();
    await expect(
      store.finalizeMetricCapture(owner, terminal, completedPass(start)),
    ).rejects.toThrow(/stale|terminal/);
  });

  it("enforces configured quotas, cancellation, stale owners, and explicit prune boundaries", async () => {
    const store = await memory({ maxPassBytes: 64 });
    const start = fixture();
    const owner = await store.beginMetricCapture(start);
    const state = await createMetricRecordStreamState(start.descriptor);
    const next = await chunk(start.descriptor, state, "level");
    await expect(
      store.appendMetricChunk({ ...owner, ownerToken: randomUUID() }, next),
    ).rejects.toThrow(/stale/);
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "staging",
    );
    await expect(store.appendMetricChunk(owner, next)).rejects.toThrow(
      /allowance/,
    );
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "failed",
    );
    await store.prune({ passIds: ["pass"], trace: start.metadata.trace });
    expect(await store.getMetricCapture(owner.captureId)).toBeUndefined();
    expect(
      (await store.listMetricChunks({ captureId: owner.captureId })).items,
    ).toEqual([]);
    const other = await memory();
    const pending = await other.beginMetricCapture(start);
    await other.terminateMetricCapture(
      pending,
      "cancelled",
      "token=do-not-retain",
    );
    expect((await other.getMetricCapture(pending.captureId))?.status).toBe(
      "cancelled",
    );
    expect(
      JSON.stringify(await other.getMetricCapture(pending.captureId)),
    ).not.toContain("do-not-retain");
  });

  it.each(["staging", "sealed"] as const)(
    "reopens durable chunks, classifies crash %s as interrupted, and invalidates the old owner",
    async (status) => {
      const root = join(process.cwd(), `.test-metric-context-${randomUUID()}`);
      roots.push(root);
      await mkdir(root);
      const path = join(root, "entity-context.sqlite");
      const options = { path, sessionId: "session:1", liveSetId: "set:1" };
      const store = await openSessionContextStore(options);
      stores.push(store);
      const start = fixture();
      const { owner, state } = await fill(store, start);
      if (status === "sealed")
        await store.sealMetricCapture(owner, manifest(start.descriptor, state));
      // Copy the durably staged file, then release the original lock normally.
      const stagedBytes = await readFile(path);
      await store.close();
      await writeFile(path, stagedBytes);
      const reopened = await openSessionContextStore(options);
      stores.push(reopened);
      expect((await reopened.getMetricCapture(owner.captureId))?.status).toBe(
        "interrupted",
      );
      expect(
        (await reopened.listMetricChunks({ captureId: owner.captureId })).items
          .length,
      ).toBeGreaterThan(0);
      await expect(
        reopened.terminateMetricCapture(owner, "failed", "late owner"),
      ).rejects.toThrow(/stale/);
      expect(await reopened.getPass("pass")).toBeUndefined();
    },
  );

  it("classifies pre-aborted ingress as cancelled and blocks a later complete manifest", async () => {
    const store = await memory();
    const start = fixture();
    const owner = await store.beginMetricCapture(start);
    const state = await createMetricRecordStreamState(start.descriptor);
    const next = await chunk(start.descriptor, state, "level");
    const controller = new AbortController();
    controller.abort(new Error("capture cancelled"));
    await expect(
      store.appendMetricChunk(owner, next, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "cancelled",
    );
    expect(
      (await store.listMetricChunks({ captureId: owner.captureId })).items,
    ).toHaveLength(0);
    await expect(store.appendMetricChunk(owner, next)).rejects.toThrow(
      /stale|terminal/,
    );
    expect(await store.getPass("pass")).toBeUndefined();
  });

  it("bounds query bytes and rejects digest, sequence, support, or identity conflicts", async () => {
    for (const corruption of [
      "digest",
      "sequence",
      "support",
      "identity",
    ] as const) {
      const store = await memory();
      const start = fixture();
      const owner = await store.beginMetricCapture(start);
      const state = await createMetricRecordStreamState(start.descriptor);
      const next = await chunk(start.descriptor, state, "level");
      if (corruption === "digest") next.digest = "f".repeat(64);
      else if (corruption === "sequence") next.chunkSequence++;
      else if (corruption === "identity")
        next.ownership = { ...next.ownership, generation: randomUUID() };
      else {
        const first = next.records[0]!;
        next.records[0] = {
          ...first,
          support: { ...first.support, endSample: first.support.endSample - 1 },
        };
      }
      if (corruption !== "digest")
        next.digest = await metricRecordChunkDigest(next);
      await expect(store.appendMetricChunk(owner, next)).rejects.toThrow(
        /mismatch/,
      );
      expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
        "failed",
      );
      expect(await store.getPass("pass")).toBeUndefined();
    }
    const store = await memory();
    const start = fixture();
    const { owner } = await fill(store, start);
    await expect(
      store.listMetricChunks({ captureId: owner.captureId, maxBytes: 64 }),
    ).rejects.toThrow(/budget/);
    await expect(
      store.listMetricChunks({ captureId: owner.captureId, limit: 17 }),
    ).rejects.toThrow();
    await expect(store.transitionLiveSetOwnership("set:other")).rejects.toThrow(
      /ownership/,
    );
    await store.terminateMetricCapture(owner, "failed", "controlled failure");
    await store.transitionLiveSetOwnership("set:other");
    expect(
      (await store.getMetricCapture(owner.captureId))?.metadata.pass.liveSetId,
    ).toBe("set:1");
  });

  it("admits generous configurable storage allowances without widening query ceilings", async () => {
    const store = await memory({
      maxStoreBytes: 3 * 1024 ** 3,
      maxPassBytes: 1024 ** 3,
      maxFeatureBytes: 1024 ** 2,
      maxFeatureBatchBytes: 128 * 1024 ** 2,
    });
    expect(store.schemaVersion).toBe(4);
    expect((await store.listPasses()).items).toEqual([]);
    await expect(memory({ maxStoreBytes: 0 })).rejects.toThrow(/positive/);
  });

  it("retains a multi-page six-family capture through bounded chunks and overview reads", async () => {
    const store = await memory();
    const start = fixture(60);
    const { owner, state } = await fill(store, start);
    await store.sealMetricCapture(owner, manifest(start.descriptor, state));
    await store.finalizeMetricCapture(
      owner,
      manifest(start.descriptor, state),
      completedPass(start),
    );
    const overview = await store.getMetricCapture(owner.captureId);
    expect(overview?.status).toBe("completed");
    expect(overview?.descriptor.geometry).not.toHaveProperty("rows");
    expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThan(
      256 * 1024,
    );
    let afterSequence = -1;
    const counts = new Map<string, number>();
    let chunks = 0;
    for (;;) {
      const page = await store.listMetricChunks({
        captureId: owner.captureId,
        afterSequence,
        limit: 16,
      });
      expect(page.encodedBytes).toBeLessThanOrEqual(1024 * 1024);
      for (const item of page.items) {
        counts.set(
          item.metric,
          (counts.get(item.metric) ?? 0) + item.records.length,
        );
        chunks++;
      }
      if (page.nextSequence === undefined) break;
      afterSequence = page.nextSequence;
    }
    expect(chunks).toBe(overview?.chunkCount);
    for (const metric of start.descriptor.requestedMetrics)
      expect(counts.get(metric)).toBe(
        metricRecordStreamExpectedCoverage(start.descriptor, metric)
          .expectedRecords,
      );
  });

  it("reopens completed manifests and keeps every immutable record independently readable", async () => {
    const root = join(process.cwd(), `.test-metric-context-${randomUUID()}`);
    roots.push(root);
    await mkdir(root);
    const options = {
      path: join(root, "entity-context.sqlite"),
      sessionId: "session:1",
      liveSetId: "set:1",
    };
    const store = await openSessionContextStore(options);
    const start = fixture();
    const { owner, state } = await fill(store, start);
    const terminal = manifest(start.descriptor, state);
    const publication = await store.finalizeMetricCapture(
      owner,
      terminal,
      completedPass(start),
    );
    await store.close();
    const reopened = await openSessionContextStore(options);
    stores.push(reopened);
    expect(
      (await reopened.getMetricCapture(publication.contextId))?.manifest,
    ).toEqual(terminal);
    expect(await reopened.getPass("pass")).toEqual(completedPass(start));
    const pitch = await reopened.listMetricChunks({
      captureId: owner.captureId,
      metric: "pitch",
    });
    expect(pitch.items[0]?.records[0]).toMatchObject({
      channels: [
        { state: "undefined", hz: 0, confidence: 0 },
        { state: "silence", hz: null, confidence: null },
      ],
    });
    expect(
      await reopened.prune({ passIds: ["pass"], trace: start.metadata.trace }),
    ).toMatchObject({
      deletedMetricCaptures: 1,
      deletedMetricChunks: 6,
    });
    expect(await reopened.getPass("pass")).toBeUndefined();
    expect(await reopened.getMetricCapture(owner.captureId)).toBeUndefined();
    expect(await reopened.getSubject("subject:1")).toBeUndefined();
    expect(
      (await reopened.listMetricChunks({ captureId: owner.captureId })).items,
    ).toEqual([]);
  });

  it("rolls back failed durable writes, exposes cleanup failure, and never advances a complete pass", async () => {
    const root = join(process.cwd(), `.test-metric-context-${randomUUID()}`);
    roots.push(root);
    await mkdir(root);
    const path = join(root, "entity-context.sqlite");
    const events: TelemetryEventEnvelope[] = [];
    const store = await openSessionContextStore({
      path,
      sessionId: "session:1",
      liveSetId: "set:1",
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    stores.push(store);
    const start = fixture();
    const owner = await store.beginMetricCapture(start);
    const state = await createMetricRecordStreamState(start.descriptor);
    const next = await chunk(start.descriptor, state, "level");
    const stagedBytes = await readFile(path);
    await rm(path);
    await mkdir(path);
    await expect(store.appendMetricChunk(owner, next)).rejects.toThrow();
    expect((await store.getMetricCapture(owner.captureId))?.chunkCount).toBe(0);
    expect(await store.getPass("pass")).toBeUndefined();
    expect(await readdir(root)).toEqual([
      "entity-context.sqlite",
      "entity-context.sqlite.lock",
    ]);
    await rm(path, { recursive: true });
    await writeFile(path, stagedBytes);
    await store.terminateMetricCapture(owner, "failed", "durable write failed");
    await store.close();
    expect(
      events.some((event) => event.name === "context.metric-chunk.failed"),
    ).toBe(true);
    expect(
      events.filter((event) => event.name === "context.metric-chunk.failed")[0]
        ?.attributes,
    ).toHaveProperty("recoveryError");
  });

  it("does not stage after registry denial, and ignores complete claims without independently stored chunks", async () => {
    const start = fixture();
    const denied = await memory({
      publishSessionContext: async () => {
        throw new Error("registry denied");
      },
    });
    await expect(denied.beginMetricCapture(start)).rejects.toThrow(
      "registry denied",
    );
    expect(await denied.getMetricCapture(start.metadata.id)).toBeUndefined();
    const source = await memory();
    const { state } = await fill(source, start);
    const terminal = manifest(start.descriptor, state);
    const incomplete = await memory();
    const owner = await incomplete.beginMetricCapture(start);
    expect((await incomplete.listMetricCaptures()).items).toEqual([]);
    expect(
      (
        await incomplete.listMetricCaptures({
          status: "staging",
          passId: "pass",
        })
      ).items,
    ).toHaveLength(1);
    await expect(
      incomplete.finalizeMetricCapture(owner, terminal, completedPass(start)),
    ).rejects.toThrow(/mismatch/);
    expect((await incomplete.getMetricCapture(owner.captureId))?.status).toBe(
      "failed",
    );
    expect((await incomplete.listMetricCaptures()).items).toEqual([]);
    expect(await incomplete.getPass("pass")).toBeUndefined();
    const controller = new AbortController();
    controller.abort(new Error("stage cancelled"));
    const cancelled = await memory();
    await expect(
      cancelled.beginMetricCapture(start, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    expect(await cancelled.getMetricCapture(start.metadata.id)).toBeUndefined();
  });

  it("derives canonical stream features without flattening the original measurements", async () => {
    const store = await memory();
    const start = fixture();
    const { owner, state } = await fill(store, start);
    const publication = await store.finalizeMetricCapture(
      owner,
      manifest(start.descriptor, state),
      completedPass(start),
    );
    expect((await store.getMetricCapture(publication.contextId))?.kind).toBe(
      "metric-record-stream-context/v1",
    );
    expect((await store.deriveFeatures(publication.contextId)).status).toBe(
      "ready",
    );
    expect(
      (await store.getFeatureDerivation(publication.contextId))?.status,
    ).toBe("ready");
    expect(
      (await store.listFeatures({ entryId: publication.contextId })).items,
    ).toHaveLength(15);
    expect((await store.getEntry(publication.contextId))?.payload.schema).toBe(
      "metric-record-stream-context/v1",
    );
    expect((await store.listMetricCaptures()).items).toHaveLength(1);
  });

  it("keeps context IDs unambiguous across streamed manifests and whole-observation entries", async () => {
    const start = fixture();
    const observation = createSyntheticMetricListeningObservation();
    observation.ownership.passId = "legacy-pass";
    const pass = { ...completedPass(start), id: "legacy-pass" };
    const legacy: AppendContextPass = {
      pass,
      subjects: [start.metadata.subject],
      entries: [
        {
          id: start.metadata.id,
          sessionId: pass.sessionId,
          liveSetId: pass.liveSetId,
          passId: pass.id,
          kind: "metric-audio-observation/v1",
          producer: start.metadata.producer,
          createdAt: now,
          capturedAt: now,
          trace: start.metadata.trace,
          payload: observation,
        },
      ],
      links: [
        {
          id: "legacy-link",
          sessionId: pass.sessionId,
          liveSetId: pass.liveSetId,
          entryId: start.metadata.id,
          subjectId: start.metadata.subject.id,
          relationship: "primary",
          coverage: pass.requestedRange,
          attribution: "unknown",
          observedContributorIds: [],
          sourceFingerprint: start.metadata.subject.binding,
          freshness: {
            status: "unknown",
            assessedAt: now,
            reason: "Synthetic evidence",
          },
        },
      ],
    };
    const staged = await memory();
    await staged.beginMetricCapture(start);
    await expect(staged.appendPass(legacy)).rejects.toThrow(/Context ID/);
    expect(await staged.getPass("legacy-pass")).toBeUndefined();
    const existing = await memory();
    await existing.appendPass(legacy);
    await expect(existing.beginMetricCapture(start)).rejects.toThrow(
      /Context ID/,
    );
    expect(await existing.getMetricCapture(start.metadata.id)).toBeUndefined();
    expect(await existing.getEntry(start.metadata.id)).toBeDefined();
  });

  it("keeps sealed captures unpublished until the application commit gate and cancellation can still win", async () => {
    const start = fixture();
    const events: TelemetryEventEnvelope[] = [];
    const store = await memory({
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    const { owner, state } = await fill(store, start);
    const terminal = manifest(start.descriptor, state);
    await store.sealMetricCapture(owner, terminal);
    expect(await store.getMetricCapture(owner.captureId)).toMatchObject({
      status: "sealed",
      metadata: { pass: { complete: false } },
      manifest: { outcome: "complete" },
    });
    expect((await store.listMetricCaptures()).items).toEqual([]);
    expect(await store.getPass("pass")).toBeUndefined();
    await expect(store.transitionLiveSetOwnership("set:other")).rejects.toThrow(
      /ownership/,
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled at application publication gate"));
    await expect(
      store.finalizeMetricCapture(owner, terminal, completedPass(start), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(await store.getMetricCapture(owner.captureId)).toMatchObject({
      status: "cancelled",
      manifest: null,
    });
    expect(await store.getPass("pass")).toBeUndefined();
    expect((await store.listMetricCaptures()).items).toEqual([]);
    const explicit = await memory();
    const prepared = await fill(explicit, start);
    await explicit.sealMetricCapture(prepared.owner, terminal);
    await explicit.terminateMetricCapture(
      prepared.owner,
      "cancelled",
      "runtime disarmed without publishing",
    );
    expect(
      (await explicit.getMetricCapture(prepared.owner.captureId))?.status,
    ).toBe("cancelled");
    await store.close();
    const lifecycle = events.filter((event) =>
      event.name.startsWith("context.metric-seal."),
    );
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "progress",
      "completed",
    ]);
    expect(
      lifecycle.every(
        (event) => event.trace?.traceId === start.metadata.trace.traceId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.name === "context.metric-finalize.cancelled",
      ),
    ).toBe(true);
  });

  it("rejects altered terminal claims and late chunks after sealing without exposing complete context", async () => {
    const start = fixture();
    for (const late of ["manifest", "chunk"] as const) {
      const store = await memory();
      const { owner, state } = await fill(store, start);
      const terminal = manifest(start.descriptor, state);
      await store.sealMetricCapture(owner, terminal);
      if (late === "manifest") {
        const changed = structuredClone(terminal);
        changed.limitations = ["changed after sealing"];
        await expect(
          store.finalizeMetricCapture(owner, changed, completedPass(start)),
        ).rejects.toThrow(/identical/);
      } else {
        const first = (
          await store.listMetricChunks({ captureId: owner.captureId })
        ).items[0]!;
        await expect(store.appendMetricChunk(owner, first)).rejects.toThrow(
          /stale|terminal/,
        );
      }
      expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
        "failed",
      );
      expect(await store.getPass("pass")).toBeUndefined();
    }
  });

  it("lets cancellation during durable file writing win before the publication rename", async () => {
    const root = join(process.cwd(), `.test-metric-context-${randomUUID()}`);
    roots.push(root);
    await mkdir(root);
    const path = join(root, "entity-context.sqlite");
    const store = await openSessionContextStore({
      path,
      sessionId: "session:1",
      liveSetId: "set:1",
    });
    stores.push(store);
    const start = fixture();
    const { owner, state } = await fill(store, start);
    const terminal = manifest(start.descriptor, state);
    await store.sealMetricCapture(owner, terminal);
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const sync = Reflect.get(prototype, "sync");
    const controller = new AbortController();
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: FileHandle,
    ) {
      await sync.call(this);
      controller.abort(new Error("cancelled during durable publication write"));
    });
    try {
      await expect(
        store.finalizeMetricCapture(owner, terminal, completedPass(start), {
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      spy.mockRestore();
    }
    expect(await store.getPass("pass")).toBeUndefined();
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "cancelled",
    );
    await store.close();
    const reopened = await openSessionContextStore({
      path,
      sessionId: "session:1",
      liveSetId: "set:1",
    });
    stores.push(reopened);
    expect(await reopened.getPass("pass")).toBeUndefined();
    expect((await reopened.getMetricCapture(owner.captureId))?.status).toBe(
      "cancelled",
    );
    expect(await readdir(root)).toEqual([
      "entity-context.sqlite",
      "entity-context.sqlite.lock",
    ]);
  });
});
