import { createHash, randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  telemetryEventEnvelopeSchema,
  sanitizePersistedText,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";
import { type Database } from "sql.js";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
  createSyntheticNativeListeningFixtureV2,
} from "@ableton-agent/protocol/testing";
import {
  createMetricObservationReportRows,
  metricAudioObservationSchema,
  compareListeningFeatures,
  contextFeatureSchema,
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
  classifyPitchEstimate,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
  type ListeningMusicalAlignment,
} from "@ableton-agent/protocol";
import {
  resolveLiveAgentStorage,
  resolveNestedSessionStorage,
} from "../../storage/dist/index.js";
import { loadSqlJs, SqliteProjectStateStore } from "./sqlite.js";
import { appSessionSchema } from "./schemas.js";
import { InMemoryProjectStateStore } from "./repository.js";
import {
  assessContextFreshness,
  CONTEXT_LIMITS,
  SESSION_CONTEXT_STORE_REFERENCE,
  sessionContextStoreReferenceSchema,
  type AppendContextPass,
  type ContextBindingEvidence,
  type ContextFreshnessAssessment,
  type ContextEntry,
} from "./context-schemas.js";
import {
  createInMemorySessionContextStore,
  openSessionContextStore,
  type SessionContextStore,
  type ContextOperationOptions,
} from "./context-repository.js";

const timestamp = "2026-10-12T00:00:00.000Z";
const trace = {
  traceId: "e1b8bc59-3c55-4b4e-844a-bf937759acdd",
  correlationId: "operation:1",
  causationId: "tool:1",
};
const ownership = { sessionId: "session:1", liveSetId: "set:1" };

function binding(): ContextBindingEvidence {
  return {
    version: 1,
    semanticLocator: { name: "Kick", trackId: "track:1", sceneIndex: 0 },
    sourceIdentity: "/Music/kick.wav",
    sourceContentHash: "content:1",
    playbackSettingsHash: "playback:1",
    upstreamProcessingHash: "upstream:1",
    routingHash: "routing:1",
    dependencyScope: "known",
    previousRuntimeBindings: ["runtime:1"],
  };
}

type LegacyPublication = Omit<AppendContextPass, "entries"> & {
  entries: (Omit<ContextEntry, "kind" | "payload"> & {
    kind: "audio-observation/v1";
    payload: Extract<
      ContextEntry["payload"],
      { schema: "audio-observation/v1" }
    >;
  })[];
};

function publication(id = "1", listeners = 1): LegacyPublication {
  const passId = `pass:${id}`;
  const listenerIds = Array.from(
    { length: listeners },
    (_, index) => `listener:${index}`,
  );
  return {
    pass: {
      id: passId,
      ...ownership,
      initiatorAgentId: "agent:1",
      listenerIds,
      requestedMode: "session",
      actualMode: "session",
      requestedRange: { startBeat: 0, endBeat: 2 },
      actualRange: { startBeat: 0, endBeat: 2 },
      status: "completed",
      complete: true,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
      interruptionReason: null,
      trace,
    },
    subjects: [
      {
        id: "subject:1",
        ...ownership,
        kind: "clip",
        trackId: "track:1",
        location: "session",
        binding: binding(),
      },
    ],
    entries: listenerIds.map((listenerId, index) => ({
      id: `entry:${id}:${index}`,
      ...ownership,
      passId,
      kind: "audio-observation/v1",
      producer: {
        listenerId,
        deviceId: `device:${index}`,
        agentId: "agent:1",
        connectionEpoch: "epoch:1",
        version: "1",
      },
      createdAt: timestamp,
      capturedAt: timestamp,
      trace,
      payload: {
        schema: "audio-observation/v1",
        listenerId,
        passId,
        sampleRate: 48_000,
        startSample: 0,
        endSample: 48_000,
        startBeat: 0,
        endBeat: 2,
        complete: true,
        limitations: [],
        algorithm: {
          name: "native",
          version: "1",
          windowSamples: 1_024,
          hopSamples: 512,
          settings: { attackThresholdDb: 6, minAttackSpacingSamples: 2_400 },
          units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
          timingUncertaintySamples: 64,
        },
        summaries: { peak: [0.5, 0.5], rmsDbfs: [-12, -12], centroidHz: 100 },
        samples: [
          {
            sample: 0,
            beat: 0,
            peak: [0.5, 0.5],
            rmsDbfs: [-12, -12],
            centroidHz: 100,
          },
        ],
        attacks: [{ sample: 1, beat: 0.01, strength: 0.5 }],
        reduction: { originalSamples: 1, originalAttacks: 1, truncated: false },
      },
    })),
    links: listenerIds.map((_, index) => ({
      id: `link:${id}:${index}`,
      ...ownership,
      entryId: `entry:${id}:${index}`,
      subjectId: "subject:1",
      relationship: "primary",
      coverage: { startBeat: 0, endBeat: 2 },
      attribution: "exclusive",
      observedContributorIds: [],
      sourceFingerprint: binding(),
      freshness: {
        status: "fresh",
        assessedAt: timestamp,
        reason: "Verified at capture",
      },
    })),
  };
}

const stores: SessionContextStore[] = [];
const roots: string[] = [];
async function memory(
  options: Parameters<typeof createInMemorySessionContextStore>[0] = ownership,
): Promise<SessionContextStore> {
  const store = await createInMemorySessionContextStore(options);
  stores.push(store);
  return store;
}
async function diskPath(): Promise<string> {
  const root = join(process.cwd(), `.test-context-${randomUUID()}`);
  await mkdir(root);
  roots.push(root);
  return join(root, "entity-context.sqlite");
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function descriptivePublication(id = "descriptive") {
  const legacy = publication(id);
  return {
    ...legacy,
    pass: {
      ...legacy.pass,
      requestedMode: "arrangement" as const,
      actualMode: "arrangement" as const,
    },
    entries: legacy.entries.map((entry) => ({
      ...entry,
      kind: "audio-observation/v2" as const,
      payload: createSyntheticNativeListeningFixtureV2({
        listenerId: entry.producer.listenerId,
        passId: entry.passId,
        endBeat: 2,
      }).observation,
    })),
    links: legacy.links.map((link) => ({
      ...link,
      attribution: "unknown" as const,
    })),
  };
}

function metricPublication(id = "metric", partial = false): AppendContextPass {
  const legacy = publication(id);
  const entry = legacy.entries[0]!;
  entry.producer.connectionEpoch = "00000000-0000-4000-8000-000000000004";
  const payload = createSyntheticMetricListeningObservation({ endBeat: 2 });
  payload.ownership = {
    ...payload.ownership,
    listenerId: entry.producer.listenerId,
    passId: entry.passId,
    connectionEpoch: entry.producer.connectionEpoch,
    ...trace,
  };
  payload.outcome = partial ? "partial" : "complete";
  payload.requestedMetrics = partial
    ? ["level", "spectral-centroid"]
    : ["level"];
  const unrequested = {
    status: "not-requested" as const,
    expectedRecords: 0,
    algorithm: null,
    records: [],
    gaps: [],
    limitations: [],
  };
  payload.metrics.attacks = { ...unrequested };
  if (partial) {
    const spectrum = payload.metrics["spectral-centroid"];
    const first = spectrum.records[0]!;
    const last = spectrum.records.at(-1)!;
    spectrum.status = "failed";
    spectrum.gaps = [
      {
        firstIndex: first.index,
        count: spectrum.records.length,
        startSample: first.support.startSample,
        endSample: last.support.endSample,
        reason: "drain-timeout",
        detail: "Synthetic missing spectral frames; not actual audio evidence",
      },
    ];
    spectrum.records = [];
    spectrum.limitations = [
      "Synthetic spectral acquisition failure; retained level fixture only",
    ];
  } else {
    payload.metrics["spectral-centroid"] = { ...unrequested };
  }
  payload.rows = createMetricObservationReportRows(payload);
  return {
    ...legacy,
    pass: {
      ...legacy.pass,
      requestedMode: "arrangement",
      actualMode: "arrangement",
      status: partial ? "partial" : "completed",
      complete: !partial,
    },
    entries: [
      {
        ...entry,
        kind: "metric-audio-observation/v1",
        payload: metricAudioObservationSchema.parse(payload),
      },
    ],
    links: legacy.links.map((link) => ({ ...link, attribution: "unknown" })),
  };
}

function alignedMetricPublication(
  id = "aligned",
  startBeat = 0,
  endBeat = 8,
  alignment: Partial<ListeningMusicalAlignment> = {},
): AppendContextPass {
  const value = metricPublication(id);
  const entry = value.entries[0]!;
  if (entry.payload.schema !== "metric-audio-observation/v1")
    throw new Error("Expected metric fixture");
  const payload = createSyntheticMetricListeningObservation({
    startBeat,
    endBeat,
    tempoBpm: alignment.tempoBpm ?? 120,
  });
  payload.ownership = entry.payload.ownership;
  entry.payload = payload;
  entry.musicalAlignment = {
    version: 1,
    coordinate: "transport-beats",
    meter: { numerator: 4, denominator: 4 },
    barOriginBeat: 0,
    tempoBpm: 120,
    tempoEvidence: "message-rate-monitored-constant",
    provenance: "capture-snapshot/v1",
    ...alignment,
  };
  value.pass.requestedRange = { startBeat, endBeat };
  value.pass.actualRange = { startBeat, endBeat };
  for (const link of value.links) link.coverage = { startBeat, endBeat };
  return value;
}

function analyzerPublication(id: string, hz = 440): AppendContextPass {
  const value = alignedMetricPublication(id, 0, 1, {
    tempoBpm: 351.5625,
    meter: { numerator: 1, denominator: 4 },
  });
  const entry = value.entries[0]!;
  if (entry.payload.schema !== "metric-audio-observation/v1")
    throw new Error("Expected metric fixture");
  const payload = entry.payload;
  const common = {
    status: "complete",
    sampleRate: payload.geometry.sampleRate,
    sourceSupport: payload.sourceCoverage,
    expectedRecords: 4,
    trailingSupport: null,
    gaps: [],
  };
  const frames = Array.from({ length: 4 }, (_, index) => ({
    index,
    support: {
      startSample: payload.geometry.startSample + index * 2048,
      endSample: payload.geometry.startSample + (index + 1) * 2048,
    },
  }));
  payload.requestedMetrics.push("pitch", "spectral-shape");
  payload.metrics.pitch = pitchTimelineSchema.parse({
    ...common,
    schema: "pitch-timeline/v1",
    profile: PITCH_PROFILE,
    frames: frames.map((frame) => ({
      ...frame,
      channels: [
        classifyPitchEstimate(hz, 0.99),
        classifyPitchEstimate(hz, 0.99),
      ],
    })),
  });
  payload.metrics["spectral-shape"] = spectralShapeTimelineSchema.parse({
    ...common,
    schema: "spectral-shape-timeline/v1",
    profile: SPECTRAL_SHAPE_PROFILE,
    frames: frames.map((frame) => ({
      ...frame,
      channels: [
        { state: "valid", flatnessDb: -20, spreadHz: 500, rolloffHz: 1000 },
        { state: "silence", flatnessDb: null, spreadHz: null, rolloffHz: null },
      ],
    })),
  });
  payload.rows = createMetricObservationReportRows(payload);
  entry.payload = metricAudioObservationSchema.parse(payload);
  return value;
}

function sessionPublication(endBeat = 2): AppendContextPass {
  const value = descriptivePublication("session");
  const clipReference = "00000000-0000-4000-8000-000000000001";
  const trackReference = "00000000-0000-4000-8000-000000000002";
  const clip = value.subjects[0]!;
  clip.id = "subject:session";
  clip.binding.previousRuntimeBindings = [clipReference];
  clip.binding.dependencyScope = "unknown";
  const track = {
    ...clip,
    id: "track:1",
    kind: "track" as const,
    location: "track" as const,
    binding: { ...clip.binding, previousRuntimeBindings: [trackReference] },
  };
  return {
    ...value,
    pass: {
      ...value.pass,
      requestedMode: "session",
      actualMode: "session",
      requestedRange: { startBeat: 0, endBeat: Math.min(endBeat, 4) },
      actualRange: { startBeat: 0, endBeat },
    },
    subjects: [clip, track],
    entries: value.entries.map((entry) => ({
      ...entry,
      kind: "session-audio-observation/v1",
      payload: {
        ...entry.payload,
        schema: "session-audio-observation/v1",
        endBeat,
        source: {
          view: "session",
          target: {
            view: "session",
            track: {
              kind: "regular",
              index: 0,
              expectedReference: trackReference,
              expectedName: "Track",
            },
            sceneIndex: 0,
            expectedClipReference: clipReference,
            expectedClipName: "Clip",
          },
          kind: "warped-audio",
          coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat },
          transport: { startBeat: 100, endBeat: 100 + endBeat },
          origin: {
            evidence: "message-rate-start-time-with-native-transport",
            clipStartTimeBeats: 100,
            observedAtGlobalBeat: 100.1,
          },
          continuity: {
            evidence: "message-rate-monitored",
            followActions: "unknown",
          },
        },
      },
    })),
    links: [
      {
        ...value.links[0]!,
        subjectId: clip.id,
        coverage: {
          coordinate: "clip-local-beats",
          iteration: 0,
          startBeat: 0,
          endBeat,
        },
        observedContributorIds: [track.id],
        freshness: {
          status: "unknown",
          assessedAt: timestamp,
          reason: "Historical evidence",
        },
      },
      {
        ...value.links[0]!,
        id: "link:track",
        subjectId: track.id,
        relationship: "contributor",
        coverage: {
          coordinate: "transport-beats",
          startBeat: 100,
          endBeat: 100 + endBeat,
        },
        sourceFingerprint: track.binding,
        observedContributorIds: [track.id],
        freshness: {
          status: "unknown",
          assessedAt: timestamp,
          reason: "Historical evidence",
        },
      },
    ],
  };
}

function largeMetricPublication(
  id: string,
  partial = false,
  listeners = 1,
): AppendContextPass {
  const value = publication(id, listeners);
  const geometry = {
    tempoBpm: 240,
    endBeat: 120,
    startSample: 10_000,
  };
  const original = partial
    ? createSyntheticPartialMetricListeningObservation(geometry)
    : createSyntheticMetricListeningObservation(geometry);
  for (const record of original.metrics.level.records) {
    record.peak = [0.5000000000000001, 0.5000000000000002];
    record.rms = [0.2500000000000001, 0.2500000000000002];
  }
  original.rows = createMetricObservationReportRows(original);
  return {
    ...value,
    pass: {
      ...value.pass,
      requestedMode: "arrangement",
      actualMode: "arrangement",
      requestedRange: { startBeat: 0, endBeat: 120 },
      actualRange: { startBeat: 0, endBeat: 120 },
      status: partial ? "partial" : "completed",
      complete: !partial,
    },
    entries: value.entries.map((entry) => ({
      ...entry,
      kind: "metric-audio-observation/v1",
      producer: {
        ...entry.producer,
        connectionEpoch: original.ownership.connectionEpoch,
      },
      payload: {
        ...original,
        ownership: {
          ...original.ownership,
          listenerId: entry.producer.listenerId,
          passId: entry.passId,
          ...trace,
        },
      },
    })),
    links: value.links.map((link) => ({
      ...link,
      coverage: { startBeat: 0, endBeat: 120 },
      attribution: "unknown",
    })),
  };
}

describe("typed metric context history", () => {
  it.each([false, true])(
    "reopens a large complete/partial=%s metric pass with exact timelines and bounded paged summaries",
    async (partial) => {
      const path = await diskPath();
      const events: TelemetryEventEnvelope[] = [];
      const store = await openSessionContextStore({
        ...ownership,
        path,
        recorder: {
          enqueue: (event) => {
            events.push(telemetryEventEnvelopeSchema.parse(event));
          },
        },
      });
      stores.push(store);
      const value = largeMetricPublication(`large-${partial}`, partial, 8);
      const encodedBytes = Buffer.byteLength(JSON.stringify(value));
      expect(encodedBytes).toBeGreaterThan(2 * 1_024 * 1_024);
      expect(encodedBytes).toBeLessThan(CONTEXT_LIMITS.passBytes);
      for (const entry of value.entries) {
        expect(Buffer.byteLength(JSON.stringify(entry))).toBeGreaterThan(
          CONTEXT_LIMITS.entryBytes,
        );
        expect(entry.payload).toMatchObject({
          metrics: {
            level: { expectedRecords: 480 },
            attacks: { expectedRecords: 300 },
          },
        });
      }
      await store.reservePass(value.pass.id, CONTEXT_LIMITS.passBytes, {
        trace,
        activeAgentId: value.pass.initiatorAgentId,
      });
      await store.appendPass(value);
      await store.close();
      expect((await stat(path)).size).toBeLessThan(CONTEXT_LIMITS.storeBytes);
      expect(await readdir(dirname(path))).toEqual(["entity-context.sqlite"]);
      const reopened = await openSessionContextStore({ ...ownership, path });
      stores.push(reopened);
      expect(await reopened.getPass(value.pass.id)).toEqual(value.pass);
      for (const entry of value.entries) {
        const retained = await reopened.getEntry(entry.id, {
          trace,
          activeAgentId: value.pass.initiatorAgentId,
        });
        expect(retained).toEqual(entry);
        if (retained?.payload.schema !== "metric-audio-observation/v1")
          throw new Error("Expected retained metric observation");
        expect(retained.payload.rows).toHaveLength(480);
        expect(retained.payload.geometry.rows).toHaveLength(480);
        expect(retained.payload.metrics.level.records).toHaveLength(480);
        expect(retained.payload.metrics.attacks.records).toHaveLength(300);
        expect(
          retained.payload.metrics["spectral-centroid"].records,
        ).toHaveLength(partial ? 702 : 703);
        expect(retained.payload.rows).toEqual(
          createMetricObservationReportRows(retained.payload),
        );
      }
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await reopened.listEntries({
          kind: "metric-audio-observation/v1",
          passId: value.pass.id,
          subjectId: value.subjects[0]!.id,
          range: { startBeat: 119.5, endBeat: 120 },
          includeHistorical: true,
          limit: 3,
          ...(cursor === undefined ? {} : { cursor }),
        });
        ids.push(...page.items.map((entry) => entry.id));
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(32_768);
        expect(JSON.stringify(page)).not.toContain('"records"');
        expect(JSON.stringify(page)).not.toContain('"rows"');
        for (const entry of page.items) {
          expect(entry.trace).toEqual(trace);
          expect(entry.payload).toMatchObject({
            ownership: { ...trace, listenerId: entry.producer.listenerId },
            metrics: { level: { retainedRecords: 480 } },
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(ids).toEqual(value.entries.map((entry) => entry.id));
      await expect(reopened.appendPass(value)).rejects.toThrow("immutable");
      expect(await reopened.getEntry(value.entries[0]!.id)).toEqual(
        value.entries[0],
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const lifecycle = events.filter((event) =>
        event.name.startsWith("context.publish."),
      );
      expect(lifecycle.map((event) => event.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "completed",
      ]);
      for (const event of lifecycle) {
        expect(event).toMatchObject({
          ...ownership,
          activeAgentId: value.pass.initiatorAgentId,
          correlationId: trace.correlationId,
          trace: { traceId: trace.traceId },
        });
      }
      expect(lifecycle.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(events)).not.toContain('"records"');
    },
    30_000,
  );

  it("atomically denies oversized large publications and releases reservation/file ownership after failure or cancellation", async () => {
    const path = await diskPath();
    const value = largeMetricPublication("large-rejected");
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const events: TelemetryEventEnvelope[] = [];
    const store = await openSessionContextStore({
      ...ownership,
      path,
      maxPassBytes: bytes - 1,
      recorder: {
        enqueue: (event) => {
          events.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });
    stores.push(store);
    await store.reservePass(value.pass.id, bytes - 1, { trace });
    await expect(store.appendPass(value)).rejects.toThrow("publication quota");
    await expect(
      store.reservePass("pass:too-large", CONTEXT_LIMITS.passBytes + 1),
    ).rejects.toThrow("Invalid pass reservation");
    const oversizedMetadata = largeMetricPublication("large-metadata");
    oversizedMetadata.entries[0]!.createdAt = `2026-10-12T00:00:00.${"0".repeat(CONTEXT_LIMITS.metricEntryMetadataBytes)}Z`;
    await expect(store.appendPass(oversizedMetadata)).rejects.toThrow(
      "entry exceeds quota",
    );
    const abort = new AbortController();
    abort.abort(new Error("large capture cancelled"));
    await expect(
      store.appendPass(value, { signal: abort.signal }),
    ).rejects.toThrow("large capture cancelled");
    expect((await store.listPasses()).items).toEqual([]);
    expect((await store.listEntries()).items).toEqual([]);
    expect((await store.listLinks()).items).toEqual([]);
    expect(await store.getSubject(value.subjects[0]!.id)).toBeUndefined();
    await store.releaseReservation(value.pass.id, { trace });
    await store.close();
    expect(await readdir(dirname(path))).toEqual(["entity-context.sqlite"]);
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    await reopened.reservePass(value.pass.id, CONTEXT_LIMITS.passBytes);
    await reopened.appendPass(value);
    expect(await reopened.getEntry(value.entries[0]!.id)).toEqual(
      value.entries[0],
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events.map((event) => event.name)).toContain(
      "context.publish.failed",
    );
    expect(events.map((event) => event.name)).toContain(
      "context.publish.cancelled",
    );
  });

  it("uses existing attributed lifecycle, redaction and cancellation for metric publication and reads", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const store = await memory({
      ...ownership,
      recorder: {
        enqueue: (event) => {
          events.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
    });
    const value = metricPublication("redacted", true);
    const payload = value.entries[0]!.payload;
    if (payload.schema !== "metric-audio-observation/v1")
      throw new Error("Expected metric fixture");
    payload.limitations.push("Authorization: Bearer metric-secret-token");
    payload.metrics.level.limitations = ["token=metric-secret-token"];
    payload.metrics["spectral-centroid"].gaps[0]!.detail =
      "token=metric-secret-token";
    await store.appendPass(value);
    const retained = (await store.getEntry(value.entries[0]!.id))?.payload;
    expect(JSON.stringify(retained)).toContain("[REDACTED]");
    expect(JSON.stringify(retained)).not.toContain("metric-secret-token");
    expect(retained).toMatchObject({
      outcome: "partial",
      ownership: payload.ownership,
      metrics: { "spectral-centroid": { status: "failed" } },
    });
    const page = await store.listEntries({ includeHistorical: true });
    expect(JSON.stringify(page)).not.toContain("metric-secret-token");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lifecycle = events.filter((event) =>
      event.name.startsWith("context.publish."),
    );
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    for (const event of lifecycle) {
      expect(event).toMatchObject({
        ...ownership,
        activeAgentId: value.pass.initiatorAgentId,
        correlationId: trace.correlationId,
        trace: { traceId: trace.traceId },
      });
    }
    expect(lifecycle[0]?.causationId).toBe(trace.causationId);
    expect(lifecycle[1]?.causationId).toBe(lifecycle[0]?.id);
    expect(lifecycle[2]?.causationId).toBe(lifecycle[1]?.id);
    expect(lifecycle[3]?.causationId).toBe(lifecycle[2]?.id);
    expect(lifecycle[3]?.durationMs).toBeGreaterThanOrEqual(0);
    await expect(store.appendPass(value)).rejects.toThrow("immutable");
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(
      store.appendPass(metricPublication("cancelled"), {
        signal: abort.signal,
      }),
    ).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events.map((event) => event.name)).toContain(
      "context.publish.failed",
    );
    expect(events.map((event) => event.name)).toContain(
      "context.publish.cancelled",
    );
    expect(await store.getPass("pass:cancelled")).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("metric-secret-token");
    expect(JSON.stringify(events)).not.toContain('"records"');
  });

  it("rolls back physical metric quota failures and leaves no staging files or writer locks", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    stores.push(initial);
    const baseline = publication("physical-baseline");
    await initial.appendPass(baseline);
    await initial.close();
    const bytes = (await stat(path)).size;
    const limited = await openSessionContextStore({
      ...ownership,
      path,
      maxStoreBytes: bytes,
    });
    stores.push(limited);
    const value = largeMetricPublication("physical-quota");
    await expect(limited.appendPass(value)).rejects.toThrow("quota");
    expect(await limited.getPass(value.pass.id)).toBeUndefined();
    await limited.close();
    expect(await readdir(dirname(path))).toEqual(["entity-context.sqlite"]);
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(await reopened.getEntry(baseline.entries[0]!.id)).toEqual(
      baseline.entries[0],
    );
    expect(
      (await reopened.listEntries({ includeHistorical: true })).items.map(
        (entry) => entry.id,
      ),
    ).toEqual([baseline.entries[0]!.id]);
    await reopened.appendPass(value);
    expect(await reopened.getEntry(value.entries[0]!.id)).toEqual(
      value.entries[0],
    );
  });

  it("keeps Session metric coordinates and exact clip/track association guards", async () => {
    const store = await memory();
    const value = metricPublication("metric-session", true);
    const session = sessionPublication();
    const source = session.entries[0]!.payload;
    const entry = value.entries[0]!;
    if (
      source.schema !== "session-audio-observation/v1" ||
      entry.payload.schema !== "metric-audio-observation/v1"
    )
      throw new Error("Expected fixtures");
    value.pass.requestedMode = "session";
    value.pass.actualMode = "session";
    value.subjects = session.subjects;
    value.links = session.links.map((link, index) => ({
      ...link,
      id: `link:metric-session:${index}`,
      entryId: entry.id,
      coverage: { ...link.coverage, startBeat: 0, endBeat: 2 },
    }));
    entry.payload.source = {
      view: "session",
      target: source.source.target,
      clipReference: source.source.target.expectedClipReference,
      kind: source.source.kind,
      coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 2 },
      transport: { startBeat: 0, endBeat: 2 },
      clipStartTimeBeats: 0,
      synchronization: "transport-coupled-first-iteration",
    };
    for (const mutate of [
      (input: AppendContextPass) => {
        input.links[0]!.coverage = { startBeat: 0, endBeat: 2 };
      },
      (input: AppendContextPass) => {
        input.subjects[0]!.binding.previousRuntimeBindings = ["unrelated"];
      },
      (input: AppendContextPass) => {
        input.links[1]!.freshness.status = "fresh";
      },
    ]) {
      const invalid = structuredClone(value);
      mutate(invalid);
      await expect(store.appendPass(invalid)).rejects.toThrow();
      expect(await store.getEntry(entry.id)).toBeUndefined();
    }
    await store.appendPass(value);
    expect(await store.getEntry(entry.id)).toEqual(entry);
    expect(
      (
        await store.listLinks({
          passId: value.pass.id,
          includeHistorical: true,
        })
      ).items.map((link) => link.coverage),
    ).toEqual([
      {
        coordinate: "clip-local-beats",
        iteration: 0,
        startBeat: 0,
        endBeat: 2,
      },
      { coordinate: "transport-beats", startBeat: 0, endBeat: 2 },
    ]);
  });

  it("durably reopens resolver-owned full/partial metric evidence alongside unchanged old kinds", async () => {
    const root = join(process.cwd(), `.test-context-${randomUUID()}`);
    roots.push(root);
    const layout = resolveLiveAgentStorage({
      homeDirectory: root,
      environment: {},
      profile: "metric-context-test",
    });
    const path = resolveNestedSessionStorage(
      layout,
      ownership,
    ).entityContextPath;
    expect(path).toContain("/.live-agent/profiles/metric-context-test/");
    expect(path).toMatch(/\/context\/entity-context.sqlite$/u);
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    const values = [
      publication("legacy"),
      descriptivePublication(),
      sessionPublication(),
      metricPublication(),
      metricPublication("partial", true),
    ];
    for (const value of values) await store.appendPass(value);
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(reopened.schemaVersion).toBe(3);
    for (const value of values) {
      expect(await reopened.getEntry(value.entries[0]!.id)).toEqual(
        value.entries[0],
      );
      expect(await reopened.getPass(value.pass.id)).toEqual(value.pass);
      if (value.entries[0]!.payload.schema === "metric-audio-observation/v1") {
        expect(value.entries[0]!.payload.limitations).toContain(
          "Synthetic contract fixture; not actual audio evidence",
        );
      }
    }
    const partial = values[4]!;
    const page = await reopened.listEntries({
      kind: "metric-audio-observation/v1",
      listenerId: "listener:0",
      passId: partial.pass.id,
      range: { startBeat: 1, endBeat: 2 },
      includeHistorical: true,
    });
    expect(page.items).toHaveLength(1);
    const original = partial.entries[0]!;
    const payload = original.payload;
    if (payload.schema !== "metric-audio-observation/v1")
      throw new Error("Expected metric fixture");
    const { rows: _rows, geometry, metrics, ...provenance } = payload;
    const { rows: _geometryRows, ...coordinates } = geometry;
    expect(_rows).toHaveLength(8);
    expect(_geometryRows).toHaveLength(8);
    const compactMetric = <T extends { records: readonly unknown[] }>(
      metric: T,
    ) => {
      const { records, ...summary } = metric;
      return { ...summary, retainedRecords: records.length };
    };
    expect(page.items[0]).toEqual({
      ...original,
      payload: {
        ...provenance,
        geometry: coordinates,
        metrics: {
          level: compactMetric(metrics.level),
          "spectral-centroid": compactMetric(metrics["spectral-centroid"]),
          attacks: compactMetric(metrics.attacks),
        },
      },
    });
    expect(page.items[0]?.payload).not.toHaveProperty("complete");
    expect(page.items[0]?.payload).not.toHaveProperty("summaries");
    expect(JSON.stringify(page)).not.toContain('"records"');
    expect(JSON.stringify(page)).not.toContain('"rows"');
    expect(JSON.stringify(page)).not.toContain('"peak"');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(12_000);
    await expect(reopened.appendPass(partial)).rejects.toThrow("immutable");
    expect(
      (
        await reopened.listEntries({
          kind: "metric-audio-observation/v1",
          limit: 1,
          includeHistorical: true,
        })
      ).nextCursor,
    ).toBeDefined();
    const links = await reopened.listLinks({ passId: partial.pass.id });
    expect(links.items[0]?.freshness.status).toBe("unknown");
    await reopened.assessLink(
      partial.links[0]!.id,
      {
        status: "historical",
        assessedAt: timestamp,
        reason: "Explicit invalidation",
      },
      { trace },
    );
    expect(
      (await reopened.listEntries({ passId: partial.pass.id })).items,
    ).toEqual([]);
    expect(
      (
        await reopened.listEntries({
          passId: partial.pass.id,
          includeHistorical: true,
        })
      ).items[0]?.payload,
    ).toMatchObject({ outcome: "partial" });
  });

  it.each([
    "kind",
    "raw",
    "contradictory-outcome",
    "listener",
    "pass",
    "trace",
    "epoch",
    "ownership",
    "exclusive",
    "coverage",
    "mode",
    "pass-coverage",
    "promoted",
    "failed",
    "cancelled",
    "interrupted",
    "reservation",
    "quota",
    "abort",
  ] as const)(
    "atomically rejects metric %s violations without changing old evidence",
    async (failure) => {
      const store = await memory(
        failure === "quota" ? { ...ownership, maxPassBytes: 4_000 } : ownership,
      );
      const legacy = publication("legacy");
      await store.appendPass(legacy);
      const value = metricPublication("metric", true);
      const entry = value.entries[0]!;
      if (entry.payload.schema !== "metric-audio-observation/v1")
        throw new Error("Expected metric fixture");
      if (failure === "kind") entry.kind = "audio-observation/v1";
      if (failure === "raw") Object.assign(entry.payload, { samples: [0.5] });
      if (failure === "contradictory-outcome")
        entry.payload.outcome = "complete";
      if (failure === "listener")
        entry.payload.ownership.listenerId = "listener:other";
      if (failure === "pass") entry.payload.ownership.passId = "pass:other";
      if (failure === "trace")
        entry.payload.ownership.causationId = "cause:other";
      if (failure === "epoch") entry.producer.connectionEpoch = "epoch:other";
      if (failure === "ownership") entry.liveSetId = "set:other";
      if (failure === "exclusive") value.links[0]!.attribution = "exclusive";
      if (failure === "coverage") value.links[0]!.coverage.endBeat = 3;
      if (failure === "mode") value.pass.actualMode = "session";
      if (failure === "pass-coverage")
        value.pass.actualRange = { startBeat: 0, endBeat: 1 };
      if (failure === "promoted") {
        value.pass.complete = true;
        value.pass.status = "completed";
      }
      if (["failed", "cancelled", "interrupted"].includes(failure))
        value.pass.status = failure as "failed" | "cancelled" | "interrupted";
      if (failure === "reservation")
        await store.reservePass(value.pass.id, 1, { trace });
      const signal = new AbortController();
      if (failure === "abort") signal.abort(new Error("cancelled"));
      await expect(
        store.appendPass(value, { signal: signal.signal }),
      ).rejects.toThrow();
      expect(await store.getPass(value.pass.id)).toBeUndefined();
      expect(await store.getEntry(entry.id)).toBeUndefined();
      expect(
        (await store.listEntries({ includeHistorical: true })).items,
      ).toHaveLength(1);
      expect(await store.getEntry(legacy.entries[0]!.id)).toEqual(
        legacy.entries[0],
      );
      if (failure === "reservation") {
        await store.releaseReservation(value.pass.id, { trace });
        await store.appendPass(value);
        expect(await store.getEntry(entry.id)).toEqual(entry);
      }
    },
  );
});

describe("typed descriptive context history", () => {
  it("reopens exact rounded Session coverage while rejecting oversized nominal requests", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    const value = sessionPublication(4.001);
    const invalid = structuredClone(value);
    invalid.pass.requestedRange.endBeat = 499.502;
    await expect(store.appendPass(invalid)).rejects.toThrow("local coverage");
    expect(await store.getPass(value.pass.id)).toBeUndefined();
    await store.appendPass(value);
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(
      (await reopened.getPass(value.pass.id))?.requestedRange.endBeat,
    ).toBe(4);
    expect((await reopened.getPass(value.pass.id))?.actualRange?.endBeat).toBe(
      4.001,
    );
    expect(
      (await reopened.getEntry(value.entries[0]!.id))?.payload,
    ).toMatchObject({ endBeat: 4.001 });
    expect(
      (await reopened.listLinks({ includeHistorical: true })).items.map(
        (link) => link.coverage.endBeat,
      ),
    ).toEqual([4.001, 104.001]);
  });

  it("retains old store references and additively registers all four bounded observation kinds", () => {
    expect(
      sessionContextStoreReferenceSchema.parse({
        ...SESSION_CONTEXT_STORE_REFERENCE,
        kinds: ["audio-observation/v1"],
      }).kinds,
    ).toEqual(["audio-observation/v1"]);
    const oldReference = {
      schemaVersion: 2,
      relativePath: "context/entity-context.sqlite",
      kinds: [
        "audio-observation/v1",
        "audio-observation/v2",
        "session-audio-observation/v1",
      ],
    };
    expect(sessionContextStoreReferenceSchema.parse(oldReference)).toEqual({
      ...oldReference,
      schemaVersion: 3,
    });
    expect(SESSION_CONTEXT_STORE_REFERENCE.kinds).toEqual([
      "audio-observation/v1",
      "audio-observation/v2",
      "session-audio-observation/v1",
      "metric-audio-observation/v1",
    ]);
    expect(
      sessionContextStoreReferenceSchema.safeParse({
        ...SESSION_CONTEXT_STORE_REFERENCE,
        kinds: ["audio-observation/v2", "audio-observation/v2"],
      }).success,
    ).toBe(false);
  });

  it("reopens additive Session history alongside unchanged legacy shapes with bounded sanitized summaries", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    await store.appendPass(publication("legacy"));
    await store.appendPass(descriptivePublication());
    const value = sessionPublication();
    const payload = value.entries[0]!.payload;
    if (payload.schema !== "session-audio-observation/v1")
      throw new Error("Expected Session payload");
    const rawClipName = `password=p ${"x".repeat(117)}`;
    const rawTrackName = `token=t ${"y".repeat(120)}`;
    payload.source.target.expectedClipName = rawClipName;
    payload.source.target.track.expectedName = rawTrackName;
    value.subjects[0]!.binding.semanticLocator.name = sanitizePersistedText(
      rawClipName,
    ).slice(0, 128);
    const quality = structuredClone(payload.alignment);
    value.entries[0]!.payload.limitations = [
      "Authorization: Bearer secret-session-token",
    ];
    await store.appendPass(value);
    const page = await store.listEntries({
      kind: "session-audio-observation/v1",
      includeHistorical: true,
    });
    expect(page.items[0]?.payload).toMatchObject({
      schema: "session-audio-observation/v1",
      alignment: { verifiedAbsoluteErrorBoundSamples: null },
      source: {
        coordinate: { unit: "beats", iteration: 0 },
        transport: { startBeat: 100, endBeat: 102 },
      },
    });
    expect(JSON.stringify(page)).not.toContain("secret-session-token");
    expect(page.items[0]?.payload).not.toHaveProperty("samples");
    expect(page.items[0]?.payload).toMatchObject({
      alignment: quality,
    });
    expect(JSON.stringify(page)).not.toContain("password=p ");
    expect(JSON.stringify(page)).not.toContain("token=t ");
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(
      (await reopened.listEntries({ includeHistorical: true })).items,
    ).toHaveLength(3);
    expect(
      (await reopened.getEntry(value.entries[0]!.id))?.payload.schema,
    ).toBe("session-audio-observation/v1");
    for (const retained of [
      page.items[0]?.payload,
      (await reopened.getEntry(value.entries[0]!.id))?.payload,
    ]) {
      if (retained?.schema !== "session-audio-observation/v1")
        throw new Error("Expected retained Session payload");
      expect(retained.alignment).toEqual(quality);
      for (const name of [
        retained.source.target.expectedClipName,
        retained.source.target.track.expectedName,
      ]) {
        expect(name).toContain("[REDACTED]");
        expect(name.length).toBeLessThanOrEqual(128);
        expect(name).not.toContain("password=p ");
        expect(name).not.toContain("token=t ");
      }
    }
    expect(
      (
        await reopened.listLinks({
          subjectId: "track:1",
          includeHistorical: true,
        })
      ).items[0]?.coverage,
    ).toEqual({ coordinate: "transport-beats", startBeat: 100, endBeat: 102 });
  });

  it.each([
    "coverage",
    "exclusive",
    "mode",
    "fresh",
    "binding",
    "cancelled",
    "quota",
  ] as const)(
    "rolls back Session %s violations without affecting legacy history",
    async (failure) => {
      const store = await memory();
      await store.appendPass(publication("legacy"));
      const value = sessionPublication();
      if (failure === "coverage")
        value.links[1]!.coverage = { startBeat: 0, endBeat: 2 };
      if (failure === "exclusive") value.links[0]!.attribution = "exclusive";
      if (failure === "mode") value.pass.actualMode = "arrangement";
      if (failure === "fresh") value.links[0]!.freshness.status = "fresh";
      if (failure === "binding")
        value.subjects[0]!.binding.previousRuntimeBindings = ["unrelated"];
      if (failure === "quota")
        value.entries[0]!.payload.limitations = [
          "x".repeat(CONTEXT_LIMITS.entryBytes),
        ];
      const controller = new AbortController();
      if (failure === "cancelled") controller.abort(new Error("cancelled"));
      await expect(
        store.appendPass(value, { signal: controller.signal }),
      ).rejects.toThrow();
      expect(
        (await store.listEntries({ includeHistorical: true })).items,
      ).toHaveLength(1);
    },
  );

  it("persists v1/v2 together and preserves approximate quality in typed summaries and reopened detail", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    await store.appendPass(publication("legacy"));
    const value = descriptivePublication();
    await store.appendPass(value);
    const page = await store.listEntries({
      kind: "audio-observation/v2",
      includeHistorical: true,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.payload).toMatchObject({
      schema: "audio-observation/v2",
      alignment: {
        alignment: "approximate",
        intendedUse: "descriptive-only",
        estimatedAbsoluteErrorSamples: null,
        verifiedAbsoluteErrorBoundSamples: null,
        policy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
      },
    });
    expect(page.items[0]?.payload).not.toHaveProperty("samples");
    expect(page.items[0]?.payload).not.toHaveProperty("attacks");
    const retained = page.items[0]?.payload;
    if (retained?.schema !== "audio-observation/v2")
      throw new Error("Expected descriptive payload");
    expect(retained.algorithm).not.toHaveProperty("timingUncertaintySamples");
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(await reopened.getEntry(value.entries[0]!.id)).toEqual(
      value.entries[0],
    );
    expect((await reopened.getEntry("entry:legacy:0"))?.payload).toMatchObject({
      schema: "audio-observation/v1",
      algorithm: { timingUncertaintySamples: 64 },
    });
  });

  it.each(["kind", "exclusive", "incomplete", "cancelled"] as const)(
    "does not publish a descriptive %s violation",
    async (failure) => {
      const store = await memory();
      const value = descriptivePublication();
      const input =
        failure === "kind"
          ? {
              ...value,
              entries: value.entries.map((entry) => ({
                ...entry,
                kind: "audio-observation/v1" as const,
              })),
            }
          : failure === "exclusive"
            ? {
                ...value,
                links: value.links.map((link) => ({
                  ...link,
                  attribution: "exclusive" as const,
                })),
              }
            : value;
      if (failure === "incomplete") input.entries[0]!.payload.complete = false;
      const controller = new AbortController();
      if (failure === "cancelled") controller.abort(new Error("cancelled"));
      await expect(
        store.appendPass(input, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(await store.getPass(value.pass.id)).toBeUndefined();
      expect(await store.getEntry(value.entries[0]!.id)).toBeUndefined();
    },
  );
});

describe.each(["memory", "sqlite"] as const)(
  "session entity context (%s)",
  (adapter) => {
    async function store(): Promise<SessionContextStore> {
      if (adapter === "memory") return memory();
      const context = await openSessionContextStore({
        ...ownership,
        path: await diskPath(),
      });
      stores.push(context);
      return context;
    }

    it("publishes all listeners atomically, keeps immutable evidence, and returns bounded compact pages", async () => {
      const context = await store();
      const input = publication("1", 2);
      await context.appendPass(input);
      expect(await context.getPass(input.pass.id)).toEqual(input.pass);
      expect(await context.getEntry("entry:1:0")).toEqual(input.entries[0]);
      expect(await context.getSubject("subject:1")).toEqual(input.subjects[0]);
      expect((await context.getLink("link:1:0"))?.freshness.status).toBe(
        "unknown",
      );
      expect(
        (
          await context.listLinks({
            entryId: "entry:1:1",
            includeHistorical: true,
          })
        ).items.map((link) => link.id),
      ).toEqual(["link:1:1"]);
      expect(
        (await context.listPasses({ entryId: "entry:missing" })).items,
      ).toEqual([]);
      input.entries[0]!.payload.summaries.peak[0] = 1;
      expect((await context.getEntry("entry:1:0"))?.payload).toMatchObject({
        summaries: { peak: [0.5, 0.5] },
      });
      await expect(context.appendPass(publication())).rejects.toThrow(
        "immutable",
      );
      const first = await context.listEntries({
        includeHistorical: true,
        limit: 1,
      });
      expect(first.items[0]?.payload).not.toHaveProperty("samples");
      expect(first.items[0]?.payload).not.toHaveProperty("attacks");
      expect(first.nextCursor).toBeDefined();
      const next = await context.listEntries({
        includeHistorical: true,
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(next.items[0]?.id).toBe("entry:1:1");
      expect(next.nextCursor).toBeUndefined();
      await expect(context.listEntries({ limit: 101 })).rejects.toThrow();
      await expect(
        context.listEntries({
          includeHistorical: true,
          limit: 2,
          cursor: first.nextCursor!,
        }),
      ).rejects.toThrow("cursor");
      expect(
        (
          await context.listPasses({
            listenerId: "listener:1",
            subjectId: "subject:1",
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (
          await context.listEntries({
            range: { startBeat: 3, endBeat: 4 },
            includeHistorical: true,
          })
        ).items,
      ).toHaveLength(0);
    });

    it("rejects cross-session/Set, raw payloads, unknown kinds and inconsistent linkage without partial writes", async () => {
      const context = await store();
      for (const change of [
        "session",
        "set",
        "link",
        "listener",
        "raw",
        "kind",
        "agent",
        "trace",
        "coverage",
        "subject",
        "actual",
      ] as const) {
        const input = publication();
        if (change === "session") input.entries[0]!.sessionId = "session:2";
        if (change === "set") input.subjects[0]!.liveSetId = "set:2";
        if (change === "link") input.links[0]!.entryId = "entry:missing";
        if (change === "listener")
          input.entries[0]!.producer.listenerId = "listener:unknown";
        if (change === "raw")
          Object.assign(input.entries[0]!.payload, { rawAudio: "secret" });
        if (change === "kind")
          Object.assign(input.entries[0]!, { kind: "notes/v1" });
        if (change === "agent") input.entries[0]!.producer.agentId = "agent:2";
        if (change === "trace")
          input.entries[0]!.trace = { ...trace, correlationId: "operation:2" };
        if (change === "coverage") input.links[0]!.coverage.endBeat = 3;
        if (change === "subject") delete input.subjects[0]!.trackId;
        if (change === "actual") input.pass.actualRange = null;
        await expect(context.appendPass(input)).rejects.toThrow();
        expect(await context.getPass("pass:1")).toBeUndefined();
      }
      await context.appendPass(publication());
      const conflicting = publication("2", 2);
      conflicting.entries[1]!.id = "entry:1:0";
      await expect(context.appendPass(conflicting)).rejects.toThrow();
      expect(await context.getPass("pass:2")).toBeUndefined();
      expect(await context.getEntry("entry:2:0")).toBeUndefined();
    });

    it("prunes only explicit IDs, preserves other passes and cascades links/orphan subjects", async () => {
      const context = await store();
      await context.appendPass(publication("1", 2));
      await context.appendPass(publication("2"));
      await expect(context.prune({ trace })).rejects.toThrow("explicit");
      expect(await context.prune({ passIds: ["pass:1"], trace })).toEqual({
        deletedPasses: 1,
        deletedEntries: 2,
        deletedLinks: 2,
        deletedSubjects: 0,
      });
      expect(await context.getPass("pass:2")).toBeDefined();
      expect(await context.prune({ entryIds: ["entry:2:0"], trace })).toEqual({
        deletedPasses: 0,
        deletedEntries: 1,
        deletedLinks: 1,
        deletedSubjects: 1,
      });
      expect(await context.getPass("pass:2")).toBeDefined();
      expect(await context.getSubject("subject:1")).toBeUndefined();
      expect(
        (await context.listLinks({ includeHistorical: true })).items,
      ).toEqual([]);
    });

    it("redacts embedded credentials in every persisted free-text boundary", async () => {
      const context = await store();
      const input = publication();
      input.subjects[0]!.binding.semanticLocator.name =
        "Kick api_key=hidden-secret";
      input.subjects[0]!.binding.sourceIdentity =
        "https://alice:password@example.com/audio";
      input.links[0]!.sourceFingerprint = input.subjects[0]!.binding;
      input.links[0]!.freshness.reason = "Authorization: Bearer secret-auth";
      input.entries[0]!.payload.limitations = ["token=hidden-token"];
      input.entries[0]!.payload.algorithm.name = "password=hidden-password";
      await context.appendPass(input);
      const text = JSON.stringify([
        await context.getSubject("subject:1"),
        await context.getEntry("entry:1:0"),
        await context.listLinks({ includeHistorical: true }),
      ]);
      expect(text).toContain("[REDACTED]");
      for (const secret of [
        "hidden-secret",
        "alice:password",
        "secret-auth",
        "hidden-token",
        "hidden-password",
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  },
);

describe("context persistence lifecycle and recovery", () => {
  it("attributes every read to the invoking query, not the cached store opening context", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const openingTrace = {
      traceId: randomUUID(),
      correlationId: "open:1",
      causationId: "host:1",
    };
    const revalidationOptions: ContextOperationOptions[] = [];
    const context = await memory({
      ...ownership,
      trace: openingTrace,
      recorder: {
        enqueue: (event) => {
          events.push(telemetryEventEnvelopeSchema.parse(event));
        },
      },
      revalidate: async (subject, link, options) => {
        revalidationOptions.push(options);
        return {
          status: "fresh",
          assessedAt: timestamp,
          reason: `Verified ${subject.id}/${link.id}`,
        };
      },
    });
    await context.appendPass(publication());
    const reads = [
      [
        "get-pass",
        (options: ContextOperationOptions) =>
          context.getPass("pass:1", options),
      ],
      [
        "list-passes",
        (options: ContextOperationOptions) =>
          context.listPasses({ freshness: "fresh" }, options),
      ],
      [
        "get-entry",
        (options: ContextOperationOptions) =>
          context.getEntry("entry:1:0", options),
      ],
      [
        "list-entries",
        (options: ContextOperationOptions) => context.listEntries({}, options),
      ],
      [
        "get-subject",
        (options: ContextOperationOptions) =>
          context.getSubject("subject:1", options),
      ],
      [
        "get-link",
        (options: ContextOperationOptions) =>
          context.getLink("link:1:0", options),
      ],
      [
        "list-links",
        (options: ContextOperationOptions) => context.listLinks({}, options),
      ],
    ] as const;
    for (const agent of ["agent:query-a", "agent:query-b"]) {
      for (const [action, read] of reads) {
        const options = {
          trace: {
            traceId: randomUUID(),
            correlationId: `tool:${action}`,
            causationId: `request:${agent}`,
          },
          activeAgentId: agent,
        };
        await read(options);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const lifecycle = events.filter(
          (event) => event.trace?.traceId === options.trace.traceId,
        );
        expect(lifecycle.map((event) => event.name)).toEqual(
          ["queued", "started", "progress", "completed"].map(
            (stage) => `context.${action}.${stage}`,
          ),
        );
        expect(
          lifecycle.every(
            (event) =>
              event.activeAgentId === agent &&
              event.correlationId === options.trace.correlationId &&
              event.sessionId === ownership.sessionId &&
              event.liveSetId === ownership.liveSetId,
          ),
        ).toBe(true);
        expect(lifecycle[0]?.causationId).toBe(options.trace.causationId);
        for (let index = 1; index < lifecycle.length; index++) {
          expect(lifecycle[index]?.causationId).toBe(lifecycle[index - 1]?.id);
        }
        expect(lifecycle[1]?.durationMs).toBeGreaterThanOrEqual(0);
        expect(lifecycle.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
        expect(lifecycle[2]?.attributes.phase).toBe(
          "querying-and-revalidating",
        );
      }
    }
    expect(revalidationOptions).toHaveLength(8);
    expect(
      revalidationOptions.every(
        (options) =>
          options.trace?.traceId !== openingTrace.traceId &&
          ["agent:query-a", "agent:query-b"].includes(
            options.activeAgentId ?? "",
          ),
      ),
    ).toBe(true);
    expect(await context.getPass("pass:1")).toEqual(publication().pass);
    await expect(
      context.listEntries(
        { limit: 101 },
        {
          trace: openingTrace,
          activeAgentId: "agent:invalid-query",
        },
      ),
    ).rejects.toThrow();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events.at(-1)?.name).toBe("context.list-entries.failed");
    expect(events.at(-1)?.activeAgentId).toBe("agent:invalid-query");
  });

  it("cancels queued reads before revalidation without attributing them to the preceding reader", async () => {
    const events: TelemetryEventEnvelope[] = [];
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => {
      entered!();
      await blocking;
      return { status: "fresh", assessedAt: timestamp, reason: "Verified" };
    });
    const context = await memory({
      ...ownership,
      revalidate,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await context.appendPass(publication());
    const first = context.getLink("link:1:0", {
      trace,
      activeAgentId: "agent:reader-a",
    });
    await started;
    const abort = new AbortController();
    const queuedTrace = {
      traceId: randomUUID(),
      correlationId: "query:queued",
      causationId: "tool:queued",
    };
    const queued = context.listLinks(
      {},
      {
        trace: queuedTrace,
        signal: abort.signal,
        activeAgentId: "agent:reader-b",
      },
    );
    const rejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    release!();
    await first;
    await rejected;
    expect(revalidate).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const lifecycle = events.filter(
      (event) => event.trace?.traceId === queuedTrace.traceId,
    );
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "cancelled",
    ]);
    expect(
      lifecycle.every((event) => event.activeAgentId === "agent:reader-b"),
    ).toBe(true);
    expect(await context.getPass("pass:1")).toBeDefined();
  });

  it.each(["get-link", "list-passes", "list-entries", "list-links"] as const)(
    "cancels %s during revalidation, releases the queue and removes cancellation listeners",
    async (action) => {
      const events: TelemetryEventEnvelope[] = [];
      let finish:
        ((assessment: ContextFreshnessAssessment) => void) | undefined;
      let entered: (() => void) | undefined;
      const blocking = new Promise<ContextFreshnessAssessment>((resolve) => {
        finish = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const seen: ContextOperationOptions[] = [];
      const context = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
        revalidate: (_subject, _link, options) => {
          seen.push(options);
          entered!();
          return blocking;
        },
      });
      await context.appendPass(publication());
      const abort = new AbortController();
      const added = vi.spyOn(abort.signal, "addEventListener");
      const removed = vi.spyOn(abort.signal, "removeEventListener");
      const queryTrace = {
        traceId: randomUUID(),
        correlationId: "query:active",
        causationId: "tool:active",
      };
      const options = {
        trace: queryTrace,
        signal: abort.signal,
        activeAgentId: "agent:active-reader",
      };
      const pending =
        action === "get-link"
          ? context.getLink("link:1:0", options)
          : action === "list-passes"
            ? context.listPasses({ freshness: "fresh" }, options)
            : action === "list-entries"
              ? context.listEntries({}, options)
              : context.listLinks({}, options);
      await started;
      expect(seen[0]).toEqual(options);
      const rejected = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      abort.abort();
      await rejected;
      expect(added).toHaveBeenCalledTimes(1);
      expect(removed).toHaveBeenCalledTimes(1);
      expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1]);
      expect(await context.getPass("pass:1")).toBeDefined();
      await context.close();
      // A legacy two-argument revalidator may ignore cancellation and resolve after close.
      finish!({
        status: "fresh",
        assessedAt: timestamp,
        reason: "Late result",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const lifecycle = events.filter(
        (event) => event.trace?.traceId === queryTrace.traceId,
      );
      expect(lifecycle.map((event) => event.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "cancelled",
      ]);
      expect(
        lifecycle.every(
          (event) => event.activeAgentId === "agent:active-reader",
        ),
      ).toBe(true);
    },
  );

  it("publishes the owning session registry/manifest before context, retrying failures and cancellation", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const publishSessionContext = vi.fn(async () => undefined);
    const context = await memory({
      ...ownership,
      publishSessionContext,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    publishSessionContext.mockRejectedValueOnce(
      new Error("session registry unavailable"),
    );
    await expect(context.appendPass(publication())).rejects.toThrow(
      "registry unavailable",
    );
    expect(await context.getPass("pass:1")).toBeUndefined();
    await context.appendPass(publication());
    expect(publishSessionContext).toHaveBeenCalledTimes(2);
    expect(publishSessionContext).toHaveBeenLastCalledWith({
      ...ownership,
      contextStore: SESSION_CONTEXT_STORE_REFERENCE,
      trace,
      activeAgentId: "agent:1",
    });
    await context.appendPass(publication("2"));
    expect(publishSessionContext).toHaveBeenCalledTimes(2);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const successfulStages = events
      .filter((event) => event.name.startsWith("context.session-publication."))
      .map((event) => event.stage);
    expect(successfulStages).toEqual([
      "queued",
      "started",
      "progress",
      "failed",
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    const publicationCompleted = events.findIndex(
      (event) => event.name === "context.session-publication.completed",
    );
    const contextCompleted = events.findIndex(
      (event) => event.name === "context.publish.completed",
    );
    expect(publicationCompleted).toBeLessThan(contextCompleted);
    const abort = new AbortController();
    const cancelled = await memory({
      ...ownership,
      publishSessionContext: async () => {
        abort.abort();
      },
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await expect(
      cancelled.appendPass(publication(), { signal: abort.signal }),
    ).rejects.toThrow();
    expect(await cancelled.getEntry("entry:1:0")).toBeUndefined();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(
      events.some(
        (event) => event.name === "context.session-publication.cancelled",
      ),
    ).toBe(true);
  });

  it("stores only a bounded context reference in existing App-session metadata repositories", async () => {
    const session = {
      id: randomUUID(),
      activeLiveSetId: randomUUID(),
      startedAt: timestamp,
      updatedAt: timestamp,
      contextStore: SESSION_CONTEXT_STORE_REFERENCE,
    };
    const memoryMetadata = new InMemoryProjectStateStore();
    await memoryMetadata.sessions.save(session);
    expect(await memoryMetadata.sessions.get(session.id)).toEqual(session);
    const path = await diskPath();
    const metadata = await SqliteProjectStateStore.open({ path });
    await metadata.sessions.save(session);
    await metadata.close();
    const reopened = await SqliteProjectStateStore.open({ path });
    try {
      expect(await reopened.sessions.get(session.id)).toEqual(session);
    } finally {
      await reopened.close();
    }
    expect(() =>
      appSessionSchema.parse({
        ...session,
        contextStore: {
          ...SESSION_CONTEXT_STORE_REFERENCE,
          relativePath: "/arbitrary/path",
        },
      }),
    ).toThrow();
    expect(() =>
      appSessionSchema.parse({
        ...session,
        contextStore: { ...SESSION_CONTEXT_STORE_REFERENCE, measurements: [1] },
      }),
    ).toThrow();
  });

  it("reopens durable evidence, prevents concurrent writers and rejects wrong ownership", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ path, ...ownership });
    stores.push(store);
    await store.appendPass(publication());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      openSessionContextStore({ path, ...ownership }),
    ).rejects.toThrow("already open");
    await store.close();
    await expect(
      openSessionContextStore({
        path,
        sessionId: "session:2",
        liveSetId: "set:1",
      }),
    ).rejects.toThrow("another");
    await expect(
      openSessionContextStore({
        path,
        sessionId: "session:1",
        liveSetId: "set:2",
      }),
    ).rejects.toThrow("another");
    const reopened = await openSessionContextStore({ path, ...ownership });
    stores.push(reopened);
    expect(await reopened.getEntry("entry:1:0")).toEqual(
      publication().entries[0],
    );
    expect(
      (await reopened.listLinks({ includeHistorical: true })).items[0]
        ?.freshness.status,
    ).toBe("unknown");
    expect((await reopened.listEntries({ freshness: "fresh" })).items).toEqual(
      [],
    );
    const independent = await memory({
      sessionId: "session:2",
      liveSetId: "set:1",
    });
    expect(await independent.getEntry("entry:1:0")).toBeUndefined();
    await reopened.close();
    await expect(reopened.getPass("pass:1")).rejects.toThrow("closed");
  });

  it("reports corruption without replacing the store and reclaims dead-owner locks", async () => {
    const path = await diskPath();
    await writeFile(path, "not sqlite");
    await expect(
      openSessionContextStore({ path, ...ownership }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("not sqlite");
    await writeFile(path, "");
    await expect(
      openSessionContextStore({ path, ...ownership }),
    ).rejects.toThrow("corrupt");
    await rm(path);
    await writeFile(`${path}.lock`, "99999999");
    const reopened = await openSessionContextStore({ path, ...ownership });
    stores.push(reopened);
    await reopened.appendPass(publication());
    await reopened.close();
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("enforces publication and physical quotas/reservations atomically, without implicit retention", async () => {
    const context = await memory({ ...ownership, maxPassBytes: 100 });
    await expect(context.appendPass(publication())).rejects.toThrow("quota");
    expect(await context.getPass("pass:1")).toBeUndefined();
    const physical = await memory({ ...ownership, maxStoreBytes: 160_000 });
    await physical.reservePass("pass:1", 20_000, { trace });
    await expect(physical.reservePass("pass:2", 100_000)).rejects.toThrow(
      "quota",
    );
    await physical.releaseReservation("pass:1", { trace });
    await physical.reservePass("pass:2", 30_000, { trace });
    await physical.appendPass(publication("2"));
    await expect(physical.reservePass("pass:2", 1)).rejects.toThrow();
    expect(await physical.getPass("pass:2")).toBeDefined();
    await expect(
      physical.reservePass("pass:3", CONTEXT_LIMITS.passBytes + 1),
    ).rejects.toThrow();
    const underReserved = await memory();
    await underReserved.reservePass("pass:1", 1);
    await expect(underReserved.appendPass(publication())).rejects.toThrow(
      "quota",
    );
    expect(await underReserved.getPass("pass:1")).toBeUndefined();
    await underReserved.releaseReservation("pass:1");
    await underReserved.appendPass(publication());
    const tooLarge = publication("3", 2);
    for (const entry of tooLarge.entries) {
      entry.payload.samples = Array.from({ length: 1_024 }, (_, sample) => ({
        sample,
        beat: sample / 1_024,
        peak: [0.513569821, 0.536914374],
        rmsDbfs: [-12.232592477, -12.237156224],
        centroidHz: 103.64682537,
      }));
      entry.payload.reduction.originalSamples = 1_024;
    }
    await expect(physical.appendPass(tooLarge)).rejects.toThrow("quota");
    expect(await physical.getPass("pass:3")).toBeUndefined();
    expect(await physical.getEntry("entry:3:0")).toBeUndefined();
    expect(await physical.getPass("pass:2")).toBeDefined();
  });

  it("rolls back in-memory evidence when atomic disk publication fails, and cleans staging files", async () => {
    const path = await diskPath();
    const context = await openSessionContextStore({ path, ...ownership });
    stores.push(context);
    await rm(path);
    await mkdir(path);
    await expect(context.appendPass(publication())).rejects.toThrow();
    expect(await context.getPass("pass:1")).toBeUndefined();
    expect(await readdir(dirname(path))).toEqual([
      "entity-context.sqlite",
      "entity-context.sqlite.lock",
    ]);
    await rm(path, { recursive: true });
    await context.appendPass(publication());
    expect(await context.getPass("pass:1")).toBeDefined();
  });

  it.each([publication, sessionPublication])(
    "records ordered attributed timing, failures and cancellation independently of journal state (%#)",
    async (makePublication) => {
      const events: TelemetryEventEnvelope[] = [];
      const context = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(telemetryEventEnvelopeSchema.parse(event));
          },
        },
      });
      await context.appendPass(makePublication());
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const lifecycle = events.filter((event) =>
        event.name.startsWith("context.publish."),
      );
      expect(lifecycle.map((event) => event.stage)).toEqual([
        "queued",
        "started",
        "progress",
        "completed",
      ]);
      expect(
        lifecycle.every(
          (event) =>
            event.sessionId === ownership.sessionId &&
            event.activeAgentId === "agent:1" &&
            event.liveSetId === ownership.liveSetId &&
            event.trace?.traceId === trace.traceId &&
            event.correlationId === trace.correlationId,
        ),
      ).toBe(true);
      expect(lifecycle[0]?.causationId).toBe(trace.causationId);
      expect(lifecycle[1]?.causationId).toBe(lifecycle[0]?.id);
      expect(lifecycle.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
      const abort = new AbortController();
      abort.abort();
      await expect(
        context.appendPass(makePublication(), { signal: abort.signal }),
      ).rejects.toThrow();
      await expect(context.appendPass(makePublication())).rejects.toThrow(
        "immutable",
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(
        events.some((event) => event.name === "context.publish.cancelled"),
      ).toBe(true);
      expect(
        events.some((event) => event.name === "context.publish.failed"),
      ).toBe(true);
      expect(await context.getPass("pass:2")).toBeUndefined();
      const disabledJournal = await memory({
        ...ownership,
        recorder: {
          enqueue: () => {
            throw new Error("journal disabled");
          },
        },
      });
      await disabledJournal.appendPass(makePublication());
      expect(
        await disabledJournal.getPass(makePublication().pass.id),
      ).toBeDefined();
    },
  );

  it("revalidates current links and supports independent historical invalidation", async () => {
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: "fresh",
      assessedAt: timestamp,
      reason: "Verified current source",
    }));
    const context = await memory({ ...ownership, revalidate });
    await context.appendPass(publication());
    expect(
      (await context.listEntries({ freshness: "fresh" })).items,
    ).toHaveLength(1);
    expect(revalidate).toHaveBeenCalled();
    await context.assessLink(
      "link:1:0",
      { status: "stale", assessedAt: timestamp, reason: "Source replaced" },
      { trace },
    );
    expect((await context.getEntry("entry:1:0"))?.payload).toEqual(
      publication().entries[0]?.payload,
    );
    revalidate.mockImplementation(async () => ({
      status: "stale",
      assessedAt: timestamp,
      reason: "Source replaced",
    }));
    expect((await context.listEntries()).items).toHaveLength(0);
    expect(
      (
        await context.listEntries({
          includeHistorical: true,
          freshness: "stale",
        })
      ).items,
    ).toHaveLength(1);
    revalidate.mockRejectedValue(new Error("bridge unavailable"));
    expect(
      (await context.listLinks({ includeHistorical: true })).items[0]?.freshness
        .status,
    ).toBe("unknown");
  });

  it("serializes bounded work, cancels queued publication and still closes a full queue", async () => {
    let unblock: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const context = await memory({
      ...ownership,
      maxPendingOperations: 2,
      revalidate: async () => {
        await blocker;
        return { status: "fresh", assessedAt: timestamp, reason: "Verified" };
      },
    });
    await context.appendPass(publication());
    const reading = context.listLinks();
    const abort = new AbortController();
    const pending = context.appendPass(publication("2"), {
      signal: abort.signal,
    });
    await expect(context.reservePass("pass:3", 100)).rejects.toThrow(
      "queue is full",
    );
    abort.abort();
    const rejected = expect(pending).rejects.toThrow();
    const closing = context.close();
    expect(context.close()).toBe(closing);
    unblock!();
    await reading;
    await rejected;
    await closing;
    await expect(context.getPass("pass:1")).rejects.toThrow("closed");
  });

  it("combines range/listener/freshness on the same link and bounds privileged revalidation work", async () => {
    const revalidate = vi.fn(
      async (
        subject: { id: string },
        link: { id: string },
      ): Promise<ContextFreshnessAssessment> => ({
        status: link.id === "link:1:1" ? "stale" : "fresh",
        assessedAt: timestamp,
        reason: `Verified ${subject.id}`,
      }),
    );
    const context = await memory({ ...ownership, revalidate });
    const input = publication("1", 2);
    input.links[0]!.coverage = { startBeat: 0, endBeat: 0.5 };
    input.links[1]!.coverage = { startBeat: 1, endBeat: 2 };
    await context.appendPass(input);
    expect(
      (
        await context.listPasses({
          range: { startBeat: 1, endBeat: 2 },
          freshness: "fresh",
          includeHistorical: true,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await context.listPasses({
          listenerId: "listener:1",
          freshness: "fresh",
          includeHistorical: true,
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await context.listEntries({
          range: { startBeat: 1, endBeat: 2 },
          freshness: "stale",
          includeHistorical: true,
        })
      ).items.map((entry) => entry.id),
    ).toEqual(["entry:1:1"]);
    const many = publication("2", 8);
    const originalLinks = many.links;
    many.links = many.entries.flatMap((entry, index) =>
      Array.from({ length: 24 }, (_, link) => ({
        ...originalLinks[index]!,
        id: `link:2:${index}:${link}`,
        entryId: entry.id,
      })),
    );
    await context.appendPass(many);
    revalidate.mockClear();
    await context.listEntries({
      passId: "pass:2",
      freshness: "stale",
      includeHistorical: true,
    });
    expect(revalidate).toHaveBeenCalledTimes(
      CONTEXT_LIMITS.revalidationsPerQuery,
    );
  });

  it("preserves original provenance through explicit first-save ownership transitions and reopen", async () => {
    const path = await diskPath();
    const context = await openSessionContextStore({ path, ...ownership });
    stores.push(context);
    await context.appendPass(publication());
    await context.reservePass("pass:2", 5_000);
    await expect(
      context.transitionLiveSetOwnership("set:saved", { trace }),
    ).rejects.toThrow("reserved");
    await context.releaseReservation("pass:2");
    await context.transitionLiveSetOwnership("set:saved", { trace });
    expect(context.liveSetId).toBe("set:saved");
    expect((await context.getPass("pass:1"))?.liveSetId).toBe("set:1");
    expect((await context.getEntry("entry:1:0"))?.liveSetId).toBe("set:1");
    await expect(context.appendPass(publication("2"))).rejects.toThrow(
      "ownership",
    );
    const saved = publication("2");
    saved.subjects = [];
    for (const record of [saved.pass, ...saved.entries, ...saved.links])
      record.liveSetId = "set:saved";
    await context.appendPass(saved);
    await context.close();
    const resumed = await openSessionContextStore({
      ...ownership,
      liveSetId: "set:saved",
      path,
    });
    stores.push(resumed);
    expect(
      (await resumed.listPasses()).items.map((pass) => pass.liveSetId),
    ).toEqual(["set:1", "set:saved"]);
    expect((await resumed.getSubject("subject:1"))?.liveSetId).toBe("set:1");
  });

  it("migrates recognized context schemas, rejects future versions and records recovery failure", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    await initial.appendPass(publication());
    await initial.close();
    const sql = await loadSqlJs();
    async function mutate(
      operation: (database: Database) => void,
    ): Promise<void> {
      const database = new sql.Database(await readFile(path));
      operation(database);
      await writeFile(path, database.export());
      database.close();
    }
    await mutate((database) => {
      database.run(
        "DROP TABLE context_features; DROP TABLE context_segments; DROP TABLE context_feature_derivations; DROP TABLE context_live_set_ownership; PRAGMA user_version = 1",
      );
    });
    const migrated = await openSessionContextStore({ ...ownership, path });
    expect(migrated.schemaVersion).toBe(3);
    expect(await migrated.getEntry("entry:1:0")).toBeDefined();
    await migrated.close();
    await mutate((database) => {
      database.run("PRAGMA user_version = 999");
    });
    const events: TelemetryEventEnvelope[] = [];
    await expect(
      openSessionContextStore({
        ...ownership,
        path,
        trace,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
      }),
    ).rejects.toThrow("unsupported");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(events.at(-1)?.name).toBe("context.open.failed");
    expect(events.at(-1)?.trace?.traceId).toBe(trace.traceId);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("phase 1 derived context features", () => {
  it("publishes after measurements, preserves exact source bytes, and reopens stable identities without backfill", async () => {
    const path = await diskPath();
    const events: TelemetryEventEnvelope[] = [];
    const store = await openSessionContextStore({
      ...ownership,
      path,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    stores.push(store);
    const value = metricPublication();
    await store.appendPass(value);
    const state = await store.getFeatureDerivation(value.entries[0]!.id);
    expect(state).toMatchObject({
      status: "ready",
      definitionSet: "qualified-listening/v1",
    });
    expect(state!.featureIds).toHaveLength(15);
    const feature = await store.getFeature(state!.featureIds[0]!);
    expect(feature).toMatchObject({
      entryId: value.entries[0]!.id,
      sourceFingerprint: createHash("sha256")
        .update(JSON.stringify(value.entries[0]!.payload))
        .digest("hex"),
      feature: {
        type: "peak-summary/v1",
        status: "ready",
      },
      freshness: { status: "unknown" },
    });
    expect(feature?.feature.values).toHaveLength(2);
    const segment = await store.getSegment(feature!.segmentId);
    expect(segment).toMatchObject({
      kind: "unaligned",
      order: 0,
      startBeat: 0,
      endBeat: 2,
      startSample: 10000,
      endSample: 58000,
      sampleRate: 48000,
      alignmentReason: "musical-bar-alignment-not-established",
    });
    expect(await store.deriveFeatures(value.entries[0]!.id)).toEqual(state);
    expect(await store.getEntry(value.entries[0]!.id)).toEqual(
      value.entries[0],
    );
    await store.close();
    const sql = await loadSqlJs();
    const before = new sql.Database(await readFile(path));
    const sourceBytes = before.exec("SELECT payload FROM context_entries")[0]!
      .values;
    before.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(await reopened.deriveFeatures(value.entries[0]!.id)).toEqual(state);
    expect((await reopened.getFeature(feature!.id))?.createdAt).toBe(
      feature!.createdAt,
    );
    await reopened.close();
    const after = new sql.Database(await readFile(path));
    expect(
      after.exec("SELECT payload FROM context_entries")[0]!.values,
    ).toEqual(sourceBytes);
    expect(
      after.exec("SELECT COUNT(*) FROM context_features")[0]!.values,
    ).toEqual([[15]]);
    after.close();
    const names = events.map((event) => event.name);
    expect(names.indexOf("context.publish.completed")).toBeLessThan(
      names.indexOf("context.derive-features.started"),
    );
    const lifecycle = events
      .filter((event) => event.name.startsWith("context.derive-features."))
      .slice(0, 4);
    expect(lifecycle.map((event) => event.stage)).toEqual([
      "queued",
      "started",
      "progress",
      "completed",
    ]);
    expect(
      lifecycle.every(
        (event) =>
          event.activeAgentId === "agent:1" &&
          event.trace?.traceId === trace.traceId,
      ),
    ).toBe(true);
    for (let index = 1; index < lifecycle.length; index++)
      expect(lifecycle[index]!.causationId).toBe(lifecycle[index - 1]!.id);
  });

  it("additively migrates v2 with byte-identical observations and no implicit extraction", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    await store.appendPass(metricPublication());
    await store.getFeatureDerivation("entry:metric:0");
    await store.close();
    const sql = await loadSqlJs();
    const database = new sql.Database(await readFile(path));
    const payloads = database.exec("SELECT payload FROM context_entries")[0]!
      .values;
    database.run(
      "DROP TABLE context_features; DROP TABLE context_segments; DROP TABLE context_feature_derivations; PRAGMA user_version = 2",
    );
    await writeFile(path, database.export());
    database.close();
    const migrated = await openSessionContextStore({ ...ownership, path });
    stores.push(migrated);
    expect(migrated.schemaVersion).toBe(3);
    expect(
      await migrated.getFeatureDerivation("entry:metric:0"),
    ).toBeUndefined();
    expect(
      (await migrated.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    await migrated.close();
    const reopened = new sql.Database(await readFile(path));
    expect(
      reopened.exec("SELECT payload FROM context_entries")[0]!.values,
    ).toEqual(payloads);
    reopened.close();
  });

  it("recovers durable pending as explicit interrupted failure without extracting", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    await store.appendPass(metricPublication());
    const state = await store.getFeatureDerivation("entry:metric:0");
    await store.close();
    const sql = await loadSqlJs();
    const database = new sql.Database(await readFile(path));
    database.run("DELETE FROM context_features; DELETE FROM context_segments");
    database.run(
      "UPDATE context_feature_derivations SET status = 'pending', payload = ?",
      [JSON.stringify({ ...state, status: "pending", featureIds: [] })],
    );
    await writeFile(path, database.export());
    database.close();
    const events: TelemetryEventEnvelope[] = [];
    const resumed = await openSessionContextStore({
      ...ownership,
      path,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    stores.push(resumed);
    expect(await resumed.getFeatureDerivation("entry:metric:0")).toMatchObject({
      status: "failed",
      reason: "interrupted-before-publication",
      featureIds: [],
    });
    expect((await resumed.listFeatures()).items).toEqual([]);
    expect(
      events.some(
        (event) => event.name === "context.derive-recovery.completed",
      ),
    ).toBe(true);
    expect(await resumed.deriveFeatures("entry:metric:0")).toMatchObject({
      status: "ready",
    });
  });

  it("keeps unsupported old observations explicit and immutable", async () => {
    const store = await memory();
    const value = publication();
    await store.appendPass(value);
    expect(await store.getFeatureDerivation("entry:1:0")).toBeUndefined();
    expect(await store.deriveFeatures("entry:1:0")).toMatchObject({
      status: "unavailable",
      reason: "unsupported-source-kind",
      featureIds: [],
    });
    expect(
      (await store.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    expect(await store.getEntry("entry:1:0")).toEqual(value.entries[0]);
  });

  it("persists unavailable measurement families and computes nonzero exact distances without counting them as comparable", async () => {
    const store = await memory();
    const loud = metricPublication("loud");
    const loudPayload = loud.entries[0]!.payload;
    if (loudPayload.schema !== "metric-audio-observation/v1")
      throw new Error("Expected metric fixture");
    for (const record of loudPayload.metrics.level.records)
      record.peak = [1, 1];
    loudPayload.rows = createMetricObservationReportRows(loudPayload);
    const spectrum = metricPublication("spectrum");
    const spectrumPayload = spectrum.entries[0]!.payload;
    if (spectrumPayload.schema !== "metric-audio-observation/v1")
      throw new Error("Expected metric fixture");
    spectrumPayload.requestedMetrics = ["spectral-centroid"];
    spectrumPayload.metrics.level = {
      status: "not-requested",
      expectedRecords: 0,
      algorithm: null,
      records: [],
      gaps: [],
      limitations: [],
    };
    spectrumPayload.metrics["spectral-centroid"] =
      createSyntheticMetricListeningObservation({ endBeat: 2 }).metrics[
        "spectral-centroid"
      ];
    spectrumPayload.rows = createMetricObservationReportRows(spectrumPayload);
    for (const value of [metricPublication("quiet"), loud, spectrum]) {
      await store.appendPass(value);
      await store.getFeatureDerivation(value.entries[0]!.id);
    }
    const spectrumState = await store.getFeatureDerivation("entry:spectrum:0");
    expect(spectrumState).toMatchObject({
      status: "ready",
      definitionSet: "qualified-listening/v1",
    });
    expect(
      (await store.getFeature(spectrumState!.featureIds[0]!))?.feature,
    ).toMatchObject({
      status: "unavailable",
      reason: "unsupported-level-profile",
    });
    const quiet = await store.getFeatureDerivation("entry:quiet:0");
    const source = await store.getFeature(quiet!.featureIds[0]!);
    const result = await store.searchFeatures({ featureId: source!.id });
    expect(result).toMatchObject({
      eligibleCount: 2,
      scannedCount: 2,
      comparableCount: 1,
      excludedCount: 1,
      exhaustive: true,
      exclusionReasons: { unavailable: 1 },
    });
    expect(result.matches[0]!.distance).toBe(
      Math.hypot(
        1 - source!.feature.values![0]!,
        1 - source!.feature.values![1]!,
      ),
    );
    expect(result.matches[0]!.feature.entryId).toBe("entry:loud:0");
  });

  it("scopes every feature operation to the current Set, even historical queries", async () => {
    const store = await memory();
    await store.appendPass(metricPublication());
    const state = await store.getFeatureDerivation("entry:metric:0");
    const feature = await store.getFeature(state!.featureIds[0]!);
    await store.transitionLiveSetOwnership("set:other");
    expect(await store.getFeature(feature!.id)).toBeUndefined();
    expect(await store.getSegment(feature!.segmentId)).toBeUndefined();
    expect(await store.getFeatureDerivation("entry:metric:0")).toBeUndefined();
    expect(
      (await store.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    await expect(
      store.searchFeatures({ featureId: feature!.id, includeHistorical: true }),
    ).rejects.toThrow("ownership");
    await expect(store.deriveFeatures("entry:metric:0")).rejects.toThrow(
      "ownership",
    );
    expect(await store.getEntry("entry:metric:0")).toBeDefined();
  });

  it("uses stable pagination and exact bounded distance search with explicit exclusions", async () => {
    const store = await memory();
    for (const id of ["a", "b", "c", "d"]) {
      await store.appendPass(metricPublication(id));
      await store.getFeatureDerivation(`entry:${id}:0`);
    }
    const all = await store.listFeatures({ featureType: "peak-summary/v1" });
    expect(all.items).toHaveLength(4);
    const first = await store.listFeatures({
      limit: 1,
      featureType: "peak-summary/v1",
    });
    const second = await store.listFeatures({
      limit: 1,
      featureType: "peak-summary/v1",
      cursor: first.nextCursor,
    });
    expect(first.items[0]!.id < second.items[0]!.id).toBe(true);
    await expect(
      store.listFeatures({ includeHistorical: true, cursor: first.nextCursor }),
    ).rejects.toThrow("cursor");
    const query = all.items[0]!;
    const search = await store.searchFeatures({ featureId: query.id });
    expect(search).toMatchObject({
      eligibleCount: 3,
      scannedCount: 3,
      comparableCount: 3,
      excludedCount: 0,
      exhaustive: true,
      limitsHit: [],
    });
    expect(search.matches.every((hit) => hit.distance === 0)).toBe(true);
    expect(search.matches.map((hit) => hit.feature.id)).toEqual(
      search.matches.map((hit) => hit.feature.id).sort(),
    );
    const capped = await store.searchFeatures({
      featureId: query.id,
      candidateLimit: 1,
    });
    expect(capped).toMatchObject({
      eligibleCount: 3,
      scannedCount: 1,
      exhaustive: false,
      limitsHit: ["candidates"],
    });
    const excluded = await store.searchFeatures({
      featureId: query.id,
      excludeEntryIds: [search.matches[0]!.feature.entryId],
    });
    expect(excluded.eligibleCount).toBe(2);
    expect(
      excluded.matches.some(
        (hit) => hit.feature.entryId === search.matches[0]!.feature.entryId,
      ),
    ).toBe(false);
    await expect(
      store.searchFeatures({ featureId: query.id, candidateLimit: 1001 }),
    ).rejects.toThrow();
    await expect(store.listFeatures({ limit: 101 })).rejects.toThrow();
    await expect(store.getFeature("bad/id")).rejects.toThrow();
  });

  it("never upgrades historical links and filters fresh revalidation failures honestly", async () => {
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: "fresh",
      assessedAt: timestamp,
      reason: "Verified",
    }));
    const store = await memory({ ...ownership, revalidate });
    await store.appendPass(metricPublication("a"));
    await store.appendPass(metricPublication("b"));
    const first = await store.getFeatureDerivation("entry:a:0");
    await store.assessLink(
      "link:a:0",
      { status: "historical", assessedAt: timestamp, reason: "Old source" },
      {},
    );
    expect(
      (await store.listFeatures({ featureType: "peak-summary/v1" })).items,
    ).toHaveLength(1);
    expect(
      (await store.getFeature(first!.featureIds[0]!))?.freshness?.status,
    ).toBe("historical");
    expect(
      (
        await store.listFeatures({
          includeHistorical: true,
          featureType: "peak-summary/v1",
        })
      ).items,
    ).toHaveLength(2);
    revalidate.mockImplementation(async () => {
      throw new Error("token=feature-secret");
    });
    const remaining = await store.listFeatures({
      featureType: "peak-summary/v1",
    });
    expect(remaining.items[0]!.freshness).toMatchObject({
      status: "unknown",
      reason: "Current binding revalidation failed",
    });
    expect(JSON.stringify(remaining)).not.toContain("feature-secret");
    await expect(
      store.searchFeatures({ featureId: first!.featureIds[0]! }),
    ).rejects.toThrow("historical");
  });

  it.each(["pass", "entry", "missing-pass", "mixed"])(
    "keeps unrelated feature derivation running when pruning by %s",
    async (selection) => {
      const events: TelemetryEventEnvelope[] = [];
      const store = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
      });
      await store.appendPass(metricPublication("old"));
      await store.getFeatureDerivation("entry:old:0");
      const current = metricPublication("new");
      await store.appendPass(current);
      await store.prune({
        trace,
        ...(selection === "pass" || selection === "mixed"
          ? { passIds: ["pass:old"] }
          : selection === "missing-pass"
            ? { passIds: ["pass:missing"] }
            : {}),
        ...(selection === "entry" || selection === "mixed"
          ? { entryIds: ["entry:old:0"] }
          : {}),
      });
      const derived = await store.getFeatureDerivation("entry:new:0");
      expect(derived).toMatchObject({
        status: "ready",
        reason: null,
      });
      expect(derived!.featureIds.length).toBeGreaterThan(0);
      expect((await store.getEntry("entry:new:0"))?.payload).toEqual(
        current.entries[0]!.payload,
      );
      expect(
        events.filter(
          (event) => event.name === "context.derive-features.cancelled",
        ),
      ).toEqual([]);
      expect(
        events
          .filter((event) => event.name.startsWith("context.prune."))
          .map((event) => event.stage),
      ).toEqual(["queued", "started", "progress", "completed"]);
    },
  );

  it.each(["invalid", "cancelled"])(
    "does not cancel feature jobs for %s prune requests",
    async (mode) => {
      const events: TelemetryEventEnvelope[] = [];
      const store = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
      });
      await store.appendPass(metricPublication("new"));
      const abort = new AbortController();
      if (mode === "cancelled") abort.abort(new Error("Prune cancelled"));
      await expect(
        store.prune(
          {
            passIds: ["pass:new"],
            ...(mode === "invalid" ? { entryIds: ["bad/id"] } : {}),
            trace,
          },
          { signal: abort.signal, activeAgentId: "agent:pruner" },
        ),
      ).rejects.toThrow();
      expect(await store.getPass("pass:new")).toBeDefined();
      expect(await store.getFeatureDerivation("entry:new:0")).toMatchObject({
        status: "ready",
      });
      expect(
        events.filter(
          (event) => event.name === "context.derive-features.cancelled",
        ),
      ).toEqual([]);
      expect(
        events.find(
          (event) =>
            event.name ===
            `context.prune.${mode === "invalid" ? "failed" : "cancelled"}`,
        ),
      ).toMatchObject({
        activeAgentId: "agent:pruner",
        correlationId: trace.correlationId,
        trace: { traceId: trace.traceId },
      });
    },
  );

  it("does not cancel a queued feature job when prune admission is denied", async () => {
    let unblock!: () => void;
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const store = await memory({
      ...ownership,
      maxPendingOperations: 2,
      revalidate: async () => {
        await blocker;
        return { status: "fresh", assessedAt: timestamp, reason: "Verified" };
      },
    });
    await store.appendPass(publication());
    const reading = store.listLinks();
    const derivation = store.deriveFeatures("entry:1:0");
    try {
      await expect(store.prune({ passIds: ["pass:1"], trace })).rejects.toThrow(
        "queue is full",
      );
    } finally {
      unblock();
    }
    await reading;
    await expect(derivation).resolves.toMatchObject({ status: "unavailable" });
    expect(await store.getEntry("entry:1:0")).toBeDefined();
  });

  it("cancels pending derivation only for the selected pass and cascades its records", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const store = await memory({
      ...ownership,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await store.appendPass(metricPublication("selected"));
    await store.prune({ passIds: ["pass:selected"], trace });
    expect(await store.getPass("pass:selected")).toBeUndefined();
    expect(await store.getEntry("entry:selected:0")).toBeUndefined();
    expect(
      await store.getFeatureDerivation("entry:selected:0"),
    ).toBeUndefined();
    expect(
      (await store.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    expect(
      events.some(
        (event) => event.name === "context.derive-features.cancelled",
      ),
    ).toBe(true);
  });

  it("cancels extraction during shutdown/pruning and cannot resurrect removed sources", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    stores.push(store);
    await store.appendPass(metricPublication());
    await store.prune({ entryIds: ["entry:metric:0"], trace });
    expect(await store.getEntry("entry:metric:0")).toBeUndefined();
    expect(await store.getFeatureDerivation("entry:metric:0")).toBeUndefined();
    expect(
      (await store.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    await store.appendPass(metricPublication("ready-to-prune"));
    const ready = await store.getFeatureDerivation("entry:ready-to-prune:0");
    const readyFeature = await store.getFeature(ready!.featureIds[0]!);
    await store.prune({ passIds: ["pass:ready-to-prune"], trace });
    expect(await store.getFeature(readyFeature!.id)).toBeUndefined();
    expect(await store.getSegment(readyFeature!.segmentId)).toBeUndefined();
    expect(
      await store.getFeatureDerivation("entry:ready-to-prune:0"),
    ).toBeUndefined();
    await store.appendPass(metricPublication("close"));
    await store.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(await reopened.getEntry("entry:close:0")).toBeDefined();
    expect(await reopened.getFeatureDerivation("entry:close:0")).toMatchObject({
      status: "cancelled",
    });
    expect(await reopened.deriveFeatures("entry:close:0")).toMatchObject({
      status: "ready",
    });
  });

  it("records caller cancellation and independent automatic queue failures while retaining measurements", async () => {
    const events: TelemetryEventEnvelope[] = [];
    const store = await memory({
      ...ownership,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await store.appendPass(publication());
    const controller = new AbortController();
    controller.abort(new Error("token=feature-secret"));
    await expect(
      store.deriveFeatures("entry:1:0", {
        signal: controller.signal,
        trace,
        activeAgentId: "agent:derive",
      }),
    ).rejects.toThrow();
    expect(await store.getFeatureDerivation("entry:1:0")).toMatchObject({
      status: "cancelled",
    });
    const terminal = events.find(
      (event) => event.name === "context.derive-features.cancelled",
    );
    expect(terminal).toMatchObject({
      activeAgentId: "agent:derive",
      correlationId: trace.correlationId,
    });
    expect(JSON.stringify(events)).not.toContain("feature-secret");
    const crowded = await memory({
      ...ownership,
      maxPendingOperations: 1,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await crowded.appendPass(metricPublication());
    await yieldTurn();
    expect(await crowded.getFeatureDerivation("entry:metric:0")).toMatchObject({
      status: "failed",
    });
    expect(await crowded.getEntry("entry:metric:0")).toBeDefined();
    expect(
      events
        .filter((event) => event.name.startsWith("context.derive-status."))
        .map((event) => event.stage),
    ).toEqual(["queued", "started", "progress", "completed"]);
  });

  it("rolls back derived quota failure atomically using the reserved terminal status space", async () => {
    const path = await diskPath();
    const store = await openSessionContextStore({ ...ownership, path });
    await store.appendPass(metricPublication());
    const state = await store.getFeatureDerivation("entry:metric:0");
    await store.close();
    const sql = await loadSqlJs();
    const database = new sql.Database(await readFile(path));
    database.run("DELETE FROM context_features; DELETE FROM context_segments");
    const failed = JSON.stringify({
      ...state,
      status: "failed",
      reason: "retry",
      featureIds: [],
    });
    database.run(
      "UPDATE context_feature_derivations SET status = 'failed', payload = ?",
      [failed + " ".repeat(2048 - failed.length - 6)],
    );
    database.run("PRAGMA page_size = 512; VACUUM");
    const bytes = database.export();
    await writeFile(path, bytes);
    database.close();
    const bounded = await openSessionContextStore({
      ...ownership,
      path,
      maxStoreBytes: bytes.byteLength,
    });
    stores.push(bounded);
    await expect(bounded.deriveFeatures("entry:metric:0")).rejects.toThrow(
      "quota",
    );
    expect(await bounded.getFeatureDerivation("entry:metric:0")).toMatchObject({
      status: "failed",
      reason: "derived-store-quota-exceeded",
      featureIds: [],
    });
    expect(await bounded.getEntry("entry:metric:0")).toBeDefined();
    expect(
      (await bounded.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    expect((await stat(path)).size).toBeLessThanOrEqual(bytes.byteLength);
    expect(
      (await readdir(dirname(path))).filter((file) =>
        file.endsWith(".staging"),
      ),
    ).toEqual([]);
  });

  it("bounds search time even when privileged revalidation ignores cancellation", async () => {
    const store = await memory({
      ...ownership,
      revalidate: async () =>
        new Promise<ContextFreshnessAssessment>(() => undefined),
    });
    await store.appendPass(metricPublication());
    const state = await store.getFeatureDerivation("entry:metric:0");
    const result = await store.searchFeatures({
      featureId: state!.featureIds[0]!,
    });
    expect(result).toMatchObject({
      exhaustive: false,
      limitsHit: ["time"],
      scannedCount: 0,
    });
    expect(await store.getEntry("entry:metric:0")).toBeDefined();
  });

  it("bounds distinct-source revalidation and returns unknown beyond its budget", async () => {
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: "fresh",
      assessedAt: timestamp,
      reason: "Verified current binding",
    }));
    const store = await memory({ ...ownership, revalidate });
    for (let index = 0; index < 102; index++) {
      await store.appendPass(metricPublication(`budget-${index}`));
      await store.getFeatureDerivation(`entry:budget-${index}:0`);
    }
    const state = await store.getFeatureDerivation("entry:budget-0:0");
    const result = await store.searchFeatures({
      featureId: state!.featureIds[0]!,
      limit: 100,
    });
    expect(result).toMatchObject({
      scannedCount: 101,
      comparableCount: 101,
      exhaustive: true,
    });
    expect(revalidate).toHaveBeenCalledTimes(
      CONTEXT_LIMITS.revalidationsPerQuery,
    );
    expect(
      result.matches.some(
        (match) => match.feature.freshness?.status === "unknown",
      ),
    ).toBe(true);
    expect(
      result.matches
        .filter((match) => match.feature.freshness?.status === "unknown")
        .every(
          (match) =>
            match.feature.freshness?.reason ===
            "Current-query revalidation budget exhausted",
        ),
    ).toBe(true);
  });

  it("cancels active feature revalidation, frees the queue, and emits attributed cancellation", async () => {
    let started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const events: TelemetryEventEnvelope[] = [];
    const store = await memory({
      ...ownership,
      revalidate: async () => {
        started!();
        return new Promise<ContextFreshnessAssessment>(() => undefined);
      },
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    await store.appendPass(metricPublication());
    const state = await store.getFeatureDerivation("entry:metric:0");
    const controller = new AbortController();
    const search = store.searchFeatures(
      { featureId: state!.featureIds[0]! },
      {
        signal: controller.signal,
        trace,
        activeAgentId: "agent:search",
      },
    );
    await entered;
    controller.abort(new Error("Search cancelled"));
    await expect(search).rejects.toThrow("cancel");
    expect(await store.getEntry("entry:metric:0")).toBeDefined();
    expect(
      events.find(
        (event) => event.name === "context.search-features.cancelled",
      ),
    ).toMatchObject({
      activeAgentId: "agent:search",
      correlationId: trace.correlationId,
    });
  });
});

describe("stored feature catalog persistence", () => {
  it("persists qualified analyzer vectors, independent masks and exact cents search across reopen and prune", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    const source = analyzerPublication("pitch-a");
    await initial.appendPass(source);
    await initial.appendPass(analyzerPublication("pitch-b", 880));
    const state = await initial.getFeatureDerivation("entry:pitch-a:0");
    expect(state).toMatchObject({
      status: "ready",
      definitionSet: "qualified-listening/v1",
    });
    expect(state!.featureIds).toHaveLength(15);
    const pitch = (
      await initial.listFeatures({
        entryId: "entry:pitch-a:0",
        featureType: "pitch-grid/v1",
      })
    ).items[0]!;
    expect(pitch.feature).toMatchObject({
      values: Array(8).fill(69),
      units: "midi-semitones",
      distanceUnits: "cents",
    });
    const flatness = (
      await initial.listFeatures({
        entryId: "entry:pitch-a:0",
        featureType: "flatness-summary/v1",
      })
    ).items[0]!;
    expect(flatness.feature).toMatchObject({
      values: [-20, null],
      channelReasons: [null, "silence"],
    });
    const search = await initial.searchFeatures({ featureId: pitch.id });
    expect(search).toMatchObject({
      comparableCount: 1,
      eligibleCount: 1,
      exhaustive: true,
    });
    expect(search.matches[0]!.distance).toBe(1200);
    await initial.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    stores.push(reopened);
    expect(await reopened.deriveFeatures("entry:pitch-a:0")).toEqual(state);
    expect((await reopened.getFeature(flatness.id))!.feature).toEqual(
      flatness.feature,
    );
    expect(await reopened.getEntry("entry:pitch-a:0")).toEqual(
      source.entries[0],
    );
    await reopened.prune({ passIds: ["pass:pitch-b"], trace });
    expect(
      (await reopened.searchFeatures({ featureId: pitch.id })).matches,
    ).toEqual([]);
  });

  it("leaves stored-ten definitions and bytes untouched until explicit fifteen-type upgrade", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    await initial.appendPass(analyzerPublication("old-ten"));
    const current = await initial.getFeatureDerivation("entry:old-ten:0");
    await initial.close();
    const sql = await loadSqlJs();
    const database = new sql.Database(await readFile(path));
    const source = database.exec("SELECT payload FROM context_entries")[0]!
      .values;
    database.run(
      "DELETE FROM context_features WHERE feature_type IN ('pitch-grid/v1','pitch-confidence-summary/v1','flatness-summary/v1','spread-summary/v1','rolloff-summary/v1')",
    );
    for (const [id, payload] of database.exec(
      "SELECT id,payload FROM context_features",
    )[0]!.values) {
      const feature = contextFeatureSchema.parse(JSON.parse(String(payload)));
      const old = {
        ...feature,
        feature: Object.fromEntries(
          Object.entries(feature.feature).filter(
            ([key]) => key !== "distanceUnits",
          ),
        ),
      };
      database.run("UPDATE context_features SET payload = ? WHERE id = ?", [
        JSON.stringify(old),
        String(id),
      ]);
    }
    const ids = new Set(
      database
        .exec("SELECT id FROM context_features")[0]!
        .values.map(([id]) => String(id)),
    );
    const oldState = {
      ...current,
      definitionSet: "stored-listening/v1",
      featureIds: current!.featureIds.filter((id) => ids.has(id)),
    };
    database.run("UPDATE context_feature_derivations SET payload = ?", [
      JSON.stringify(oldState),
    ]);
    const oldRows = database.exec(
      "SELECT payload FROM context_features ORDER BY id",
    )[0]!.values;
    await writeFile(path, database.export());
    database.close();
    const reopened = await openSessionContextStore({ ...ownership, path });
    expect(await reopened.getFeatureDerivation("entry:old-ten:0")).toEqual(
      oldState,
    );
    const inventory = await reopened.listFeatures();
    expect(inventory.items).toHaveLength(10);
    expect(
      inventory.items.every(
        (feature) => feature.feature.distanceUnits === feature.feature.units,
      ),
    ).toBe(true);
    await reopened.close();
    const unchanged = new sql.Database(await readFile(path));
    expect(
      unchanged.exec("SELECT payload FROM context_features ORDER BY id")[0]!
        .values,
    ).toEqual(oldRows);
    unchanged.close();
    const upgrade = await openSessionContextStore({ ...ownership, path });
    stores.push(upgrade);
    const state = await upgrade.deriveFeatures("entry:old-ten:0");
    expect(state).toMatchObject({
      definitionSet: "qualified-listening/v1",
      status: "ready",
    });
    expect(state.featureIds).toHaveLength(15);
    expect(
      oldState.featureIds.every((id) => state.featureIds.includes(id)),
    ).toBe(true);
    expect(
      (await upgrade.listFeatures({ featureType: "pitch-grid/v1" })).items[0]!
        .feature.status,
    ).toBe("ready");
    await upgrade.close();
    const final = new sql.Database(await readFile(path));
    expect(
      final.exec("SELECT payload FROM context_entries")[0]!.values,
    ).toEqual(source);
    final.close();
  });

  it("counts enlarged ready-state IDs against physical quota and retains reserved failure metadata after rollback", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    const value = alignedMetricPublication("large-status", 0, 16, {
      meter: { numerator: 1, denominator: 16 },
    });
    await initial.appendPass(value);
    const ready = await initial.getFeatureDerivation("entry:large-status:0");
    expect(ready).toMatchObject({
      status: "ready",
      definitionSet: "qualified-listening/v1",
    });
    expect(ready!.featureIds).toHaveLength(960);
    expect(Buffer.byteLength(JSON.stringify(ready))).toBeGreaterThan(32 * 1024);
    await initial.close();
    const sql = await loadSqlJs();
    const completeBytes = await readFile(path);
    const database = new sql.Database(completeBytes);
    const originalSource = database.exec(
      "SELECT payload FROM context_entries",
    )[0]!.values;
    const failed = JSON.stringify({
      ...ready,
      status: "failed",
      reason: "explicit-retry",
      featureIds: [],
    });
    database.run(
      "UPDATE context_feature_derivations SET status = 'failed', payload = ?",
      [failed + " ".repeat(2048 - failed.length - 6)],
    );
    database.run("VACUUM");
    const rowsWithoutReadyIds = database.export().byteLength;
    const limit = completeBytes.byteLength - 16 * 1024;
    expect(rowsWithoutReadyIds).toBeLessThanOrEqual(limit);
    database.run(
      "DELETE FROM context_features; DELETE FROM context_segments; VACUUM",
    );
    await writeFile(path, database.export());
    database.close();
    const bounded = await openSessionContextStore({
      ...ownership,
      path,
      maxStoreBytes: limit,
    });
    stores.push(bounded);
    await expect(
      bounded.deriveFeatures("entry:large-status:0"),
    ).rejects.toThrow("quota");
    expect(
      await bounded.getFeatureDerivation("entry:large-status:0"),
    ).toMatchObject({
      status: "failed",
      reason: "derived-store-quota-exceeded",
      featureIds: [],
    });
    expect(
      (await bounded.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    expect(await bounded.getEntry("entry:large-status:0")).toEqual(
      value.entries[0],
    );
    await bounded.close();
    const retained = new sql.Database(await readFile(path));
    expect(
      retained.exec("SELECT payload FROM context_entries")[0]!.values,
    ).toEqual(originalSource);
    expect(
      retained.exec(
        "SELECT length(status) + length(payload) FROM context_feature_derivations",
      )[0]!.values,
    ).toEqual([[2048]]);
    expect(
      retained.exec("SELECT COUNT(*) FROM context_segments")[0]!.values,
    ).toEqual([[0]]);
    retained.close();
  }, 30000);

  it("rederives an old peak-only definition set only on explicit request, without rewriting the source", async () => {
    const path = await diskPath();
    const initial = await openSessionContextStore({ ...ownership, path });
    await initial.appendPass(metricPublication());
    const fullState = await initial.getFeatureDerivation("entry:metric:0");
    await initial.close();
    const sql = await loadSqlJs();
    const database = new sql.Database(await readFile(path));
    const sourceBytes = database.exec("SELECT payload FROM context_entries")[0]!
      .values;
    database.run(
      "DELETE FROM context_features WHERE feature_type <> 'peak-summary/v1'",
    );
    const oldState = {
      ...fullState,
      definitionSet: "peak-summary/v1",
      featureIds: fullState!.featureIds.slice(0, 1),
    };
    database.run(
      "UPDATE context_feature_derivations SET payload = ? WHERE entry_id = ?",
      [JSON.stringify(oldState), "entry:metric:0"],
    );
    await writeFile(path, database.export());
    database.close();
    const resumed = await openSessionContextStore({ ...ownership, path });
    stores.push(resumed);
    expect(await resumed.getFeatureDerivation("entry:metric:0")).toEqual(
      oldState,
    );
    expect((await resumed.listFeatures()).items).toHaveLength(1);
    const upgraded = await resumed.deriveFeatures("entry:metric:0");
    expect(upgraded).toMatchObject({
      definitionSet: "qualified-listening/v1",
      status: "ready",
    });
    expect(upgraded.featureIds).toHaveLength(15);
    expect((await resumed.listFeatures()).items).toHaveLength(15);
    await resumed.close();
    const final = new sql.Database(await readFile(path));
    expect(
      final.exec("SELECT payload FROM context_entries")[0]!.values,
    ).toEqual(sourceBytes);
    final.close();
  });

  it("persists two aligned bars and all definitions atomically, retaining source bytes and identities across reopen", async () => {
    const path = await diskPath();
    const events: TelemetryEventEnvelope[] = [];
    const store = await openSessionContextStore({
      ...ownership,
      path,
      recorder: {
        enqueue: (event) => {
          events.push(event);
        },
      },
    });
    stores.push(store);
    const value = alignedMetricPublication();
    const original = JSON.stringify(value.entries[0]);
    await store.appendPass(value);
    const state = await store.getFeatureDerivation("entry:aligned:0");
    expect(state).toMatchObject({
      status: "ready",
      definitionSet: "qualified-listening/v1",
    });
    expect(state!.featureIds).toHaveLength(30);
    const levels = await store.listFeatures({
      entryId: "entry:aligned:0",
      featureType: "level-grid/v1",
    });
    expect(levels.items).toHaveLength(2);
    for (const feature of levels.items) {
      expect(feature.feature).toMatchObject({
        status: "ready",
        values: Array.from({ length: 32 }, () => 0.25),
        grid: { meter: { numerator: 4, denominator: 4 }, phaseBeats: 0 },
      });
    }
    expect(
      compareListeningFeatures(
        levels.items[0]!.feature,
        levels.items[1]!.feature,
      ),
    ).toMatchObject({ status: "comparable", distance: 0 });
    const segments = await Promise.all(
      levels.items.map((feature) => store.getSegment(feature.segmentId)),
    );
    segments.sort((a, b) => a!.order - b!.order);
    expect(
      segments.map((segment) => [
        segment!.kind,
        segment!.startBeat,
        segment!.endBeat,
      ]),
    ).toEqual([
      ["bar", 0, 4],
      ["bar", 4, 8],
    ]);
    expect(segments[0]!.endSample).toBe(segments[1]!.startSample);
    expect(JSON.stringify(await store.getEntry("entry:aligned:0"))).toBe(
      original,
    );
    expect(
      events.some(
        (event) =>
          event.name === "context.derive-features.progress" &&
          event.attributes.completedSegments === 2 &&
          event.attributes.totalSegments === 2,
      ),
    ).toBe(true);
    await store.appendPass(alignedMetricPublication("other"));
    await store.getFeatureDerivation("entry:other:0");
    const results = await store.searchFeatures({
      featureId: levels.items[0]!.id,
      excludeEntryIds: ["entry:aligned:0"],
    });
    expect(results).toMatchObject({
      comparableCount: 2,
      eligibleCount: 2,
      exhaustive: true,
    });
    expect(
      results.matches.every(
        (match) =>
          match.feature.entryId === "entry:other:0" && match.distance === 0,
      ),
    ).toBe(true);
    await store.close();
    const resumed = await openSessionContextStore({ ...ownership, path });
    stores.push(resumed);
    expect(await resumed.deriveFeatures("entry:aligned:0")).toEqual(state);
    expect(JSON.stringify(await resumed.getEntry("entry:aligned:0"))).toBe(
      original,
    );
    await resumed.prune({ passIds: ["pass:aligned"], trace });
    expect(
      (await resumed.listFeatures({ entryId: "entry:aligned:0" })).items,
    ).toEqual([]);
    expect(await resumed.getSegment(segments[0]!.id)).toBeUndefined();
    expect(
      (await resumed.listFeatures({ entryId: "entry:other:0", limit: 100 }))
        .items,
    ).toHaveLength(30);
  });

  it("retains fractional 3/4 partials and short ranges without inventing sub-record RMS", async () => {
    const store = await memory();
    const value = alignedMetricPublication("fractional", 0.2, 6.2, {
      meter: { numerator: 3, denominator: 4 },
      barOriginBeat: 0.125,
    });
    await store.appendPass(value);
    const state = await store.getFeatureDerivation("entry:fractional:0");
    expect(state!.featureIds).toHaveLength(45);
    const features = await store.listFeatures({
      entryId: "entry:fractional:0",
      featureType: "level-grid/v1",
    });
    const segments = await Promise.all(
      features.items.map((feature) => store.getSegment(feature.segmentId)),
    );
    segments.sort((a, b) => a!.order - b!.order);
    expect(segments.map((s) => [s!.kind, s!.startBeat, s!.endBeat])).toEqual([
      ["partial", 0.2, 3.125],
      ["bar", 3.125, 6.125],
      ["partial", 6.125, 6.2],
    ]);
    expect(
      features.items.every(
        (feature) =>
          feature.feature.status === "unavailable" &&
          feature.feature.reason === "straddling-level-record",
      ),
    ).toBe(true);
    const middle = features.items.find(
      (feature) => feature.segmentId === segments[1]!.id,
    )!;
    expect(middle.feature.grid!.cells).toHaveLength(12);
    expect(await store.getEntry("entry:fractional:0")).toEqual(
      value.entries[0],
    );
    await store.appendPass(
      alignedMetricPublication("short", 2.75, 3.25, {
        meter: { numerator: 3, denominator: 4 },
      }),
    );
    await store.getFeatureDerivation("entry:short:0");
    const short = (
      await store.listFeatures({
        entryId: "entry:short:0",
        featureType: "level-grid/v1",
      })
    ).items[0]!;
    expect(await store.getSegment(short.segmentId)).toMatchObject({
      kind: "short",
      startBeat: 2.75,
      endBeat: 3.25,
    });
    expect(short.feature.values).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it.each([
    { coordinate: "clip-local-beats" as const },
    { tempoBpm: 121 },
    { provenance: "session-clip-markers/v1" as const },
    { meter: { numerator: 3, denominator: 3 } },
  ])(
    "rejects inconsistent alignment before persisting any source: %j",
    async (change) => {
      const store = await memory();
      const value = alignedMetricPublication();
      value.entries[0]!.musicalAlignment = {
        ...value.entries[0]!.musicalAlignment!,
        ...change,
      };
      await expect(store.appendPass(value)).rejects.toThrow();
      expect(await store.getEntry("entry:aligned:0")).toBeUndefined();
      expect(await store.getPass("pass:aligned")).toBeUndefined();
    },
  );

  it("does not promote historical observation kinds by attaching alignment metadata", async () => {
    const store = await memory();
    const value = publication();
    value.entries[0]!.musicalAlignment =
      alignedMetricPublication().entries[0]!.musicalAlignment!;
    await expect(store.appendPass(value)).rejects.toThrow(
      "authoritative metric",
    );
    expect(await store.getEntry("entry:1:0")).toBeUndefined();
  });

  it("reports geometry overflow durably without partial publication or source loss", async () => {
    const store = await memory();
    const value = alignedMetricPublication("geometry-limit", 0, 20, {
      meter: { numerator: 1, denominator: 128 },
    });
    await store.appendPass(value);
    expect(
      await store.getFeatureDerivation("entry:geometry-limit:0"),
    ).toMatchObject({
      status: "failed",
      reason: "unsupported-geometry:feature_segment_limit",
      featureIds: [],
    });
    expect(
      (await store.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    expect(await store.getEntry("entry:geometry-limit:0")).toEqual(
      value.entries[0],
    );
  });

  it("cancels a multi-segment extraction at a progress boundary and drains shutdown without partial features", async () => {
    const path = await diskPath();
    let shutdown: Promise<void> | undefined;
    const store = await openSessionContextStore({
      ...ownership,
      path,
      recorder: {
        enqueue: (event) => {
          if (
            event.name === "context.derive-features.progress" &&
            event.attributes.completedSegments === 8
          )
            shutdown = store.close();
        },
      },
    });
    stores.push(store);
    await store.appendPass(
      alignedMetricPublication("cancel-segments", 0, 20, {
        meter: { numerator: 1, denominator: 4 },
      }),
    );
    expect(
      await store.getFeatureDerivation("entry:cancel-segments:0"),
    ).toMatchObject({ status: "cancelled" });
    expect(shutdown).toBeDefined();
    await shutdown;
    const resumed = await openSessionContextStore({ ...ownership, path });
    stores.push(resumed);
    expect(
      await resumed.getFeatureDerivation("entry:cancel-segments:0"),
    ).toMatchObject({ status: "cancelled", featureIds: [] });
    expect(
      (await resumed.listFeatures({ includeHistorical: true })).items,
    ).toEqual([]);
    expect(await resumed.getEntry("entry:cancel-segments:0")).toBeDefined();
  });

  it.each([{ maxFeatureBytes: 64 }, { maxFeatureBatchBytes: 1024 }])(
    "keeps measurements and no partial derived rows when an encoded bound fails: %j",
    async (bounds) => {
      const events: TelemetryEventEnvelope[] = [];
      const store = await memory({
        ...ownership,
        ...bounds,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
      });
      await store.appendPass(metricPublication());
      expect(await store.getFeatureDerivation("entry:metric:0")).toMatchObject({
        status: "failed",
        reason: "derived-store-quota-exceeded",
        featureIds: [],
      });
      expect(
        (await store.listFeatures({ includeHistorical: true })).items,
      ).toEqual([]);
      expect(await store.getEntry("entry:metric:0")).toEqual(
        metricPublication().entries[0],
      );
      expect(
        events.some((event) => event.name === "context.publish.completed"),
      ).toBe(true);
      expect(
        events.some((event) => event.name === "context.derive-features.failed"),
      ).toBe(true);
    },
  );
  it("publishes all definition rows atomically and caches source freshness across type inventory", async () => {
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: "fresh",
      assessedAt: timestamp,
      reason: "Source validated",
    }));
    const store = await memory({ ...ownership, revalidate });
    await store.appendPass(metricPublication());
    const state = await store.getFeatureDerivation("entry:metric:0");
    expect(state).toMatchObject({
      status: "ready",
      definitionSet: "qualified-listening/v1",
    });
    expect(state!.featureIds).toHaveLength(15);
    const inventory = await store.listFeatures();
    expect(inventory.items).toHaveLength(15);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(
      inventory.items
        .filter((item) => item.feature.status === "ready")
        .map((item) => item.feature.type),
    ).toEqual(["peak-summary/v1"]);
    for (const feature of inventory.items) {
      expect(feature.freshness?.status).toBe("fresh");
      if (feature.feature.type === "level-grid/v1")
        expect(feature.feature.reason).toBe("missing-alignment");
    }
    const filtered = await store.listFeatures({ featureType: "level-grid/v1" });
    expect(filtered.items).toHaveLength(1);
    await expect(
      store.searchFeatures({
        featureId: state!.featureIds[0]!,
        featureType: "mel-shape/v1",
      }),
    ).rejects.toThrow("type");
  });

  it("honors the decoded candidate byte ceiling with truthful counts and no source mutation", async () => {
    const store = await memory({ ...ownership, maxFeatureSearchBytes: 1 });
    for (const id of ["byte-a", "byte-b"]) {
      await store.appendPass(metricPublication(id));
      await store.getFeatureDerivation(`entry:${id}:0`);
    }
    const state = await store.getFeatureDerivation("entry:byte-a:0");
    const result = await store.searchFeatures({
      featureId: state!.featureIds[0]!,
    });
    expect(result).toMatchObject({
      matches: [],
      eligibleCount: 1,
      scannedCount: 0,
      comparableCount: 0,
      excludedCount: 0,
      exhaustive: false,
      limitsHit: ["bytes"],
    });
    expect(await store.getEntry("entry:byte-a:0")).toEqual(
      metricPublication("byte-a").entries[0],
    );
    await expect(
      createInMemorySessionContextStore({
        ...ownership,
        maxFeatureSearchBytes: 16 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("bounds");
    await expect(
      createInMemorySessionContextStore({
        ...ownership,
        maxFeatureSearchMs: 1001,
      }),
    ).rejects.toThrow("bounds");
  });
});

describe("feature source snapshot attribution", () => {
  it("returns primary IDs with scan freshness and allows raw enrichment without another revalidation or persisted read metadata", async () => {
    const path = await diskPath();
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: revalidate.mock.calls.length <= 2 ? "fresh" : "stale",
      assessedAt: timestamp,
      reason: "Query-owned source assessment",
    }));
    const store = await openSessionContextStore({
      ...ownership,
      path,
      revalidate,
    });
    stores.push(store);
    for (const id of ["snapshot-a", "snapshot-b"]) {
      await store.appendPass(metricPublication(id));
      await store.getFeatureDerivation(`entry:${id}:0`);
    }
    const state = await store.getFeatureDerivation("entry:snapshot-a:0");
    const result = await store.searchFeatures({
      featureId: state!.featureIds[0]!,
    });
    expect(result.matches).toHaveLength(1);
    const snapshot = result.matches[0]!.feature;
    expect(snapshot).toMatchObject({
      entryId: "entry:snapshot-b:0",
      primarySubjectId: "subject:1",
      freshness: { status: "fresh" },
    });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(await store.getEntry(snapshot.entryId)).toEqual(
      metricPublication("snapshot-b").entries[0],
    );
    expect(await store.getSubject(snapshot.primarySubjectId!)).toMatchObject({
      id: "subject:1",
    });
    expect(await store.getSegment(snapshot.segmentId)).toBeDefined();
    expect(revalidate).toHaveBeenCalledTimes(2);
    const later = await store.getFeature(snapshot.id);
    expect(later).toMatchObject({
      primarySubjectId: "subject:1",
      freshness: { status: "stale" },
    });
    expect(snapshot.freshness?.status).toBe("fresh");
    const inventory = await store.listFeatures({ includeHistorical: true });
    expect(inventory.items).toHaveLength(20);
    expect(
      inventory.items.every(
        (feature) => feature.primarySubjectId === "subject:1",
      ),
    ).toBe(true);
    expect(revalidate).toHaveBeenCalledTimes(5);
    await store.close();
    const sql = await loadSqlJs();
    const database = new sql.Database(await readFile(path));
    const payloads = database.exec("SELECT payload FROM context_features")[0]!
      .values;
    expect(
      payloads.every(
        ([payload]) =>
          !String(payload).includes('"primarySubjectId"') &&
          !String(payload).includes('"freshness"'),
      ),
    ).toBe(true);
    database.close();
  });

  it.each(["missing", "ambiguous"] as const)(
    "fails explicitly for a %s primary association without guessing from contributors",
    async (mode) => {
      const events: TelemetryEventEnvelope[] = [];
      const store = await memory({
        ...ownership,
        recorder: {
          enqueue: (event) => {
            events.push(event);
          },
        },
      });
      await store.appendPass(metricPublication("valid-association"));
      const query = await store.getFeatureDerivation(
        "entry:valid-association:0",
      );
      const value = metricPublication("invalid-association");
      if (mode === "missing") value.links[0]!.relationship = "contributor";
      else value.links.push({ ...value.links[0]!, id: "link:second-primary" });
      await store.appendPass(value);
      const state = await store.getFeatureDerivation(
        "entry:invalid-association:0",
      );
      await expect(
        store.getFeature(state!.featureIds[0]!, {
          trace,
          activeAgentId: "agent:reader",
        }),
      ).rejects.toThrow("primary association");
      await expect(
        store.listFeatures({ entryId: "entry:invalid-association:0" }),
      ).rejects.toThrow("primary association");
      await expect(
        store.searchFeatures({ featureId: state!.featureIds[0]! }),
      ).rejects.toThrow("primary association");
      await expect(
        store.searchFeatures({ featureId: query!.featureIds[0]! }),
      ).rejects.toThrow("primary association");
      expect(await store.getEntry("entry:invalid-association:0")).toEqual(
        value.entries[0],
      );
      expect(
        events.find((event) => event.name === "context.get-feature.failed"),
      ).toMatchObject({ activeAgentId: "agent:reader" });
    },
  );

  it("does not substitute a fresh contributor assessment for a historical primary source", async () => {
    const revalidate = vi.fn(async (): Promise<ContextFreshnessAssessment> => ({
      status: "fresh",
      assessedAt: timestamp,
      reason: "Contributor exists",
    }));
    const store = await memory({ ...ownership, revalidate });
    const value = metricPublication("mixed-association");
    value.links.push({
      ...value.links[0]!,
      id: "a:contributor",
      relationship: "contributor",
    });
    value.links[0]!.freshness = {
      status: "historical",
      assessedAt: timestamp,
      reason: "Primary source is historical",
    };
    await store.appendPass(value);
    const state = await store.getFeatureDerivation("entry:mixed-association:0");
    expect(await store.getFeature(state!.featureIds[0]!)).toMatchObject({
      primarySubjectId: "subject:1",
      freshness: { status: "historical" },
    });
    expect((await store.listFeatures()).items).toEqual([]);
    const historical = await store.listFeatures({ includeHistorical: true });
    expect(historical.items).toHaveLength(15);
    expect(
      historical.items.every(
        (feature) =>
          feature.primarySubjectId === "subject:1" &&
          feature.freshness?.status === "historical",
      ),
    ).toBe(true);
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe("dependency-scoped context freshness", () => {
  it("ignores rename/runtime IDs but detects exact source, playback, routing and upstream changes", () => {
    const captured = binding();
    const renamed = {
      ...binding(),
      semanticLocator: { ...binding().semanticLocator, name: "Renamed" },
      previousRuntimeBindings: ["new-runtime"],
    };
    expect(
      assessContextFreshness(captured, renamed, true, timestamp).status,
    ).toBe("fresh");
    for (const key of [
      "sourceIdentity",
      "sourceContentHash",
      "playbackSettingsHash",
      "upstreamProcessingHash",
      "routingHash",
    ] as const) {
      expect(
        assessContextFreshness(
          captured,
          { ...binding(), [key]: "changed" },
          true,
          timestamp,
        ).status,
      ).toBe("stale");
    }
    expect(
      assessContextFreshness(
        captured,
        {
          ...binding(),
          semanticLocator: { ...binding().semanticLocator, sceneIndex: 1 },
        },
        true,
        timestamp,
      ).status,
    ).toBe("stale");
    expect(
      assessContextFreshness(captured, binding(), false, timestamp).status,
    ).toBe("unresolved");
    expect(
      assessContextFreshness(captured, undefined, true, timestamp).status,
    ).toBe("unresolved");
    expect(
      assessContextFreshness(
        captured,
        { ...binding(), dependencyScope: "unknown" },
        true,
        timestamp,
      ).status,
    ).toBe("unknown");
    const noHash = binding();
    delete noHash.sourceContentHash;
    expect(
      assessContextFreshness(captured, noHash, true, timestamp).status,
    ).toBe("unknown");
  });
});
