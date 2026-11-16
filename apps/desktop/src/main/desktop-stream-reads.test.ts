import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemorySessionContextStore,
  type SessionContextStore,
} from "@ableton-agent/project-state";
import type { MetricCaptureStart } from "@ableton-agent/project-state/metric-capture-schemas";
import { createSyntheticMetricRecordStreamFixture } from "@ableton-agent/protocol/testing";
import { inspectArrangementListeningSourceResultSchema } from "@ableton-agent/protocol";
import type { NonBlockingObservabilityRecorder } from "@ableton-agent/observability";
import { createDesktopApi } from "../preload/api.js";
import { ipcSchemas } from "../contracts.js";
import {
  desktopMetricChunksRequestSchema,
  desktopMetricChunkPageSchema,
} from "../context-contracts.js";
import { createDesktopContextReader } from "./desktop-context-reader.js";
import {
  createIpcHandlers,
  registerIpc,
  type DiagnosticsActions,
} from "./ipc.js";
import type { DesktopService } from "./desktop-service.js";

const stores: SessionContextStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
const trace = {
  traceId: "10000000-0000-4000-8000-000000000001",
  correlationId: "10000000-0000-4000-8000-000000000002",
  causationId: "10000000-0000-4000-8000-000000000003",
};
const request = { sessionId: "desktop-session", contextId: "capture", trace };
const chunkRequest = {
  sessionId: request.sessionId,
  captureId: request.contextId,
  afterSequence: -1,
  limit: 16,
  maxBytes: 1_048_576,
  trace,
};
const chunkQuery = {
  captureId: request.contextId,
  afterSequence: -1,
  limit: 16,
  maxBytes: 1_048_576,
};
const arrangement = {
  schemaVersion: 1 as const,
  queryId: trace.traceId,
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: "10000000-0000-4000-8000-000000000004",
    expectedName: "Drums",
  },
  range: { startBeat: 0, endBeat: 384 },
};
const transport = {
  transportPlaying: true,
  currentBeat: 0,
  tempoBpm: 128,
  loopEnabled: false,
  arrangementRecord: false,
  sessionRecord: false,
  overdub: false,
  sessionAutomationRecord: false,
  globalBackToArrangement: false,
  targetArmed: false,
  targetMonitoring: 2,
  arrangementEligible: true,
  playingSessionClips: 0,
  queuedSessionClips: 0,
};
const source = inspectArrangementListeningSourceResultSchema.parse({
  ...arrangement,
  projectRevision: 1,
  evidence: "message-rate-only",
  projectPath: "/owned/prepared.als",
  before: transport,
  after: transport,
  clips: [],
});

async function seed() {
  const fixture = await createSyntheticMetricRecordStreamFixture();
  const store = await createInMemorySessionContextStore({
    sessionId: request.sessionId,
    liveSetId: "live-set",
  });
  stores.push(store);
  const ownership = fixture.descriptor.ownership;
  const originalTrace = {
    traceId: ownership.traceId,
    correlationId: ownership.correlationId,
    causationId: ownership.causationId,
  };
  const range = {
    startBeat: fixture.descriptor.geometry.startBeat,
    endBeat: fixture.descriptor.geometry.endBeat,
  };
  const previousRuntimeBinding: unknown =
    fixture.descriptor.source.target.expectedReference;
  if (typeof previousRuntimeBinding !== "string")
    throw new Error("Synthetic source is missing its runtime binding");
  const start: MetricCaptureStart = {
    descriptor: fixture.descriptor,
    metadata: {
      id: request.contextId,
      trace: originalTrace,
      producer: {
        listenerId: ownership.listenerId,
        deviceId: "device",
        agentId: "writer",
        connectionEpoch: ownership.connectionEpoch,
        version: "synthetic",
      },
      pass: {
        id: ownership.passId,
        sessionId: request.sessionId,
        liveSetId: "live-set",
        initiatorAgentId: "writer",
        listenerIds: [ownership.listenerId],
        requestedMode: "arrangement",
        actualMode: "arrangement",
        requestedRange: range,
        actualRange: range,
        status: "partial",
        complete: false,
        createdAt: "2026-11-14T12:00:00.000Z",
        startedAt: "2026-11-14T12:00:00.000Z",
        endedAt: "2026-11-14T12:00:00.500Z",
        interruptionReason: null,
        trace: originalTrace,
      },
      subject: {
        id: "subject",
        sessionId: request.sessionId,
        liveSetId: "live-set",
        kind: "arrangement-range",
        trackId: "track",
        location: "arrangement",
        binding: {
          version: 1,
          semanticLocator: {
            name: "Synthetic source",
            trackId: "track",
            arrangementRange: range,
          },
          sourceIdentity: "synthetic",
          playbackSettingsHash: "synthetic",
          upstreamProcessingHash: "synthetic",
          routingHash: "synthetic",
          dependencyScope: "unknown",
          previousRuntimeBindings: [previousRuntimeBinding],
        },
      },
    },
  };
  const owner = await store.beginMetricCapture(start);
  for await (const chunk of fixture.chunks())
    await store.appendMetricChunk(owner, chunk);
  await store.finalizeMetricCapture(owner, fixture.manifest, {
    ...start.metadata.pass,
    status: "completed",
    complete: true,
    endedAt: "2026-11-14T12:00:00.500Z",
  });
  const resolveRepository = vi.fn(async () => store);
  const enqueue = vi.fn<NonBlockingObservabilityRecorder["enqueue"]>();
  const reader = createDesktopContextReader({
    execute: async () => ({ action: "list", entries: [] }),
    resolveRepository,
    telemetry: { enqueue },
  });
  return { store, reader, resolveRepository, enqueue };
}

describe("three bounded public Desktop listening reads", () => {
  it("preserves complete digest-verifiable capture/chunks through reader, IPC and preload", async () => {
    const { store, reader, resolveRepository, enqueue } = await seed();
    const handlers = createIpcHandlers(
      {} as DesktopService,
      {} as DiagnosticsActions,
      undefined,
      reader,
    );
    const invoke = vi.fn(async (channel: string, value: unknown) => {
      if (channel === "entity-context:get-metric-capture")
        return handlers[channel](ipcSchemas[channel].request.parse(value));
      if (channel === "entity-context:list-metric-chunks")
        return handlers[channel](ipcSchemas[channel].request.parse(value));
      throw new Error("Unexpected channel");
    });
    const api = createDesktopApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    });
    expect(await api.entityContext.getMetricCapture(request)).toEqual(
      await store.getMetricCapture(request.contextId),
    );
    const original = await store.listMetricChunks(chunkQuery);
    const observed = await api.entityContext.listMetricChunks(chunkRequest);
    expect(observed).toEqual(original);
    expect(observed.items).toHaveLength(6);
    expect(
      observed.items.every(
        (chunk) => chunk.schema === "metric-record-chunk/v1",
      ),
    ).toBe(true);
    expect(observed.items[0]).not.toHaveProperty("chunkDigest");
    expect(resolveRepository).toHaveBeenLastCalledWith({
      sessionId: request.sessionId,
      agentId: "desktop-context",
      actorKind: "application",
      trace,
    });
    expect(enqueue.mock.calls.map(([event]) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    expect(
      enqueue.mock.calls.every(
        ([event]) =>
          event.trace?.traceId === trace.traceId &&
          event.correlationId === trace.correlationId &&
          event.causationId === trace.causationId &&
          event.activeAgentId === undefined &&
          (event.durationMs ?? -1) >= 0,
      ),
    ).toBe(true);
    expect(Object.keys(api.entityContext).sort()).toEqual([
      "get",
      "getMetricCapture",
      "list",
      "listMetricChunks",
    ]);
  });

  it("enforces request/response byte and count bounds without exposing SQL or paths", async () => {
    for (const patch of [
      { limit: 17 },
      { maxBytes: 1_048_577 },
      { afterSequence: -2 },
      { sql: "SELECT *" },
      { path: "/foreign" },
    ])
      expect(
        desktopMetricChunksRequestSchema.safeParse({
          ...chunkRequest,
          ...patch,
        }).success,
      ).toBe(false);
    const { reader, store } = await seed();
    const page = await store.listMetricChunks(chunkQuery);
    vi.spyOn(store, "listMetricChunks").mockResolvedValueOnce(page);
    await expect(
      reader.listMetricChunks({ ...chunkRequest, limit: 1 }),
    ).rejects.toThrow("bounded request");
    expect(
      desktopMetricChunkPageSchema.safeParse({
        ...page,
        encodedBytes: page.encodedBytes + 1,
      }).success,
    ).toBe(false);
    await expect(
      reader.listMetricChunks({ ...chunkRequest, maxBytes: 2 }),
    ).rejects.toThrow();
  });

  it("rechecks session/Set ownership, capture identity and chunk attribution", async () => {
    const { store, reader } = await seed();
    await expect(
      reader.getMetricCapture({ ...request, sessionId: "foreign" }),
    ).rejects.toThrow("App session");
    const record = (await store.getMetricCapture(request.contextId))!;
    const get = vi.spyOn(store, "getMetricCapture");
    get.mockResolvedValueOnce({
      ...record,
      metadata: {
        ...record.metadata,
        pass: { ...record.metadata.pass, liveSetId: "foreign" },
      },
    });
    await expect(reader.getMetricCapture(request)).rejects.toThrow("ownership");
    get.mockResolvedValueOnce({
      ...record,
      metadata: { ...record.metadata, id: "foreign" },
    });
    await expect(reader.getMetricCapture(request)).rejects.toThrow("ownership");
    const page = await store.listMetricChunks(chunkQuery);
    vi.spyOn(store, "listMetricChunks").mockResolvedValueOnce({
      ...page,
      items: page.items.map((chunk) => ({
        ...chunk,
        descriptorDigest: "f".repeat(64),
      })),
    });
    await expect(reader.listMetricChunks(chunkRequest)).rejects.toThrow(
      "capture",
    );
  });

  it("returns missing capture explicitly and records redacted failure/cancellation, not success", async () => {
    const { reader, store, enqueue } = await seed();
    expect(
      await reader.getMetricCapture({ ...request, contextId: "missing" }),
    ).toBeUndefined();
    await expect(
      reader.listMetricChunks({ ...chunkRequest, captureId: "missing" }),
    ).rejects.toThrow("unavailable");
    for (const name of ["Error", "AbortError"]) {
      const error = new Error("Bearer fixture-secret");
      error.name = name;
      vi.spyOn(store, "getMetricCapture").mockRejectedValueOnce(error);
      await expect(reader.getMetricCapture(request)).rejects.not.toThrow(
        "fixture-secret",
      );
      expect(enqueue.mock.calls.at(-1)?.[0].stage).toBe(
        name === "AbortError" ? "cancelled" : "failed",
      );
    }
  });

  it("guards all three IPC handlers against foreign frames and removes them on cleanup", async () => {
    const { reader } = await seed();
    const registered = new Map<
      string,
      (event: never, payload: unknown) => Promise<unknown>
    >();
    const ipcMain = {
      handle: (
        channel: string,
        handler: (event: never, payload: unknown) => Promise<unknown>,
      ) => registered.set(channel, handler),
      removeHandler: vi.fn(),
    };
    let trusted = false;
    const inspect = vi.fn(async () => source);
    const unregister = registerIpc(
      ipcMain,
      {
        inspectArrangementListeningSource: inspect,
      } as unknown as DesktopService,
      {} as DiagnosticsActions,
      () => trusted,
      undefined,
      undefined,
      reader,
    );
    const queries = [
      ["entity-context:get-metric-capture", request],
      ["entity-context:list-metric-chunks", chunkRequest],
      ["ableton:inspect-arrangement-listening-source", arrangement],
    ] as const;
    for (const [channel, parameters] of queries)
      await expect(
        registered.get(channel)!({} as never, parameters),
      ).rejects.toThrow("Untrusted");
    trusted = true;
    for (const [channel, parameters] of queries) {
      await expect(
        registered.get(channel)!({} as never, {
          ...parameters,
          sql: "SELECT *",
        }),
      ).rejects.toThrow();
      await expect(
        registered.get(channel)!({} as never, parameters),
      ).resolves.toBeDefined();
    }
    expect(inspect).toHaveBeenCalledOnce();
    unregister();
    for (const [channel] of queries)
      expect(ipcMain.removeHandler).toHaveBeenCalledWith(channel);
  });

  it("forwards the exact read-only Arrangement inspection and rejects malformed results", async () => {
    const invoke = vi.fn(async () => source as unknown);
    const api = createDesktopApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    });
    expect(
      await api.ableton.inspectArrangementListeningSource(arrangement),
    ).toEqual(source);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "ableton:inspect-arrangement-listening-source",
      arrangement,
    );
    invoke.mockResolvedValueOnce({
      ...source,
      clips: [{ filePath: "/missing-fields" }],
    });
    await expect(
      api.ableton.inspectArrangementListeningSource(arrangement),
    ).rejects.toThrow();
    invoke.mockResolvedValueOnce({
      ...source,
      range: { startBeat: 0, endBeat: 385 },
    });
    await expect(
      api.ableton.inspectArrangementListeningSource(arrangement),
    ).rejects.toThrow("identity mismatch");
  });
  it("checks preload capture identity and the caller's smaller page budget", async () => {
    const { store } = await seed();
    const record = await store.getMetricCapture(request.contextId);
    const page = await store.listMetricChunks(chunkQuery);
    const invoke = vi.fn(async () => record as unknown);
    const api = createDesktopApi({
      invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
    });
    await expect(
      api.entityContext.getMetricCapture({ ...request, contextId: "foreign" }),
    ).rejects.toThrow("identity mismatch");
    invoke.mockResolvedValueOnce(page);
    await expect(
      api.entityContext.listMetricChunks({ ...chunkRequest, maxBytes: 2 }),
    ).rejects.toThrow("bounded request");
  });
});
