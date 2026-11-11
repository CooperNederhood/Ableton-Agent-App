import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionContextStore,
  type AppendContextPass,
  type EntityContextRepository,
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
} from "@ableton-agent/protocol";
import {
  createSyntheticNativeListeningFixtureV2,
  createSyntheticMetricListeningObservation,
} from "@ableton-agent/protocol/testing";
import { contextOperationResultSchema } from "@ableton-agent/tools";
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

async function featureFixture() {
  const seeded = await fixture();
  const source = createSyntheticMetricListeningObservation();
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
    feature: extractPeakFeature(source),
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

  it("returns source-linked features and application-computed pairwise distances", async () => {
    const { host, getFeature } = await featureFixture();
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
        segment: { kind: "unaligned" },
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
      comparisons: [{ result: { status: "comparable", distance: 0 } }],
    });
    expect(getFeature).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ trace, activeAgentId: "reader" }),
    );
  });

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
    const { host, store, record } = await featureFixture();
    const search = vi.spyOn(store, "searchFeatures").mockResolvedValue({
      matches: [{ feature: record, distance: 0 }],
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
      distanceDefinition: "euclidean-linear-amplitude/v1",
      matches: [{ distance: 0, feature: { source: { contextId: "entry" } } }],
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
      items: Array.from({ length: 20 }, () => entry),
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
