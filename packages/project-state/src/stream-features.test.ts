import { afterEach, describe, expect, it } from "vitest";
import {
  LISTENING_FEATURE_DEFINITIONS,
  MEL_BAND_PROFILE,
  metricStreamMelBandRecordSchema,
  compareListeningFeatures,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricRecordStreamFixture,
  type SyntheticMetricRecordStreamOptions,
} from "@ableton-agent/protocol/testing";
import {
  createInMemorySessionContextStore,
  type SessionContextStore,
} from "./context-repository.js";
import type { MetricCaptureStart } from "./metric-capture-schemas.js";

const stores: SessionContextStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture(
  recordsPerChunk = 8,
  {
    aligned = false,
    ...options
  }: SyntheticMetricRecordStreamOptions & {
    aligned?: boolean;
  } = {},
) {
  const stream = await createSyntheticMetricRecordStreamFixture({
    seconds: 2,
    ...options,
    recordsPerChunk,
  });
  const { descriptor, manifest } = stream;
  const trace = {
    traceId: descriptor.ownership.traceId,
    correlationId: descriptor.ownership.correlationId,
    causationId: descriptor.ownership.causationId,
  };
  const range = {
    startBeat: descriptor.geometry.startBeat,
    endBeat: descriptor.geometry.endBeat,
  };
  const start: MetricCaptureStart = {
    descriptor,
    metadata: {
      id: "stream-context",
      trace,
      ...(aligned
        ? {
            musicalAlignment: {
              version: 1 as const,
              coordinate: "transport-beats" as const,
              meter: { numerator: 4, denominator: 4 },
              barOriginBeat: 0,
              tempoBpm: descriptor.geometry.tempoBpm,
              tempoEvidence: "message-rate-monitored-constant" as const,
              provenance: "capture-snapshot/v1" as const,
            },
          }
        : {}),
      pass: {
        id: descriptor.ownership.passId,
        sessionId: "session",
        liveSetId: "set",
        initiatorAgentId: "agent",
        listenerIds: [descriptor.ownership.listenerId],
        requestedMode: "arrangement",
        actualMode: "arrangement",
        requestedRange: range,
        actualRange: null,
        status: "partial",
        complete: false,
        createdAt: "2026-11-15T00:00:00.000Z",
        startedAt: "2026-11-15T00:00:00.000Z",
        endedAt: "2026-11-15T00:00:00.000Z",
        interruptionReason: null,
        trace,
      },
      producer: {
        listenerId: descriptor.ownership.listenerId,
        deviceId: "device",
        agentId: "agent",
        connectionEpoch: descriptor.ownership.connectionEpoch,
        version: "1",
      },
      subject: {
        id: "subject",
        sessionId: "session",
        liveSetId: "set",
        kind: "arrangement-range",
        binding: {
          version: 1,
          semanticLocator: { name: "source", arrangementRange: range },
          sourceIdentity: "source",
          playbackSettingsHash: "settings",
          upstreamProcessingHash: "processing",
          routingHash: "routing",
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
  const store = await createInMemorySessionContextStore({
    sessionId: "session",
    liveSetId: "set",
  });
  stores.push(store);
  const owner = await store.beginMetricCapture(start);
  for await (const chunk of stream.chunks())
    await store.appendMetricChunk(owner, chunk);
  const publish = () =>
    store.finalizeMetricCapture(owner, manifest, {
      ...start.metadata.pass,
      actualRange: range,
      status: "completed",
      complete: true,
    });
  return { store, owner, start, manifest, publish };
}

describe("features backed by persisted measurement streams", () => {
  it("searches stored musical grids across acquisition phases and preserves comparison coverage", async () => {
    const sourceOrigin = 100_000;
    const { store, owner, publish } = await fixture(8, {
      seconds: 4,
      aligned: true,
      sourceOrigin,
      records: {
        "mel-bands": Array.from(
          { length: Math.floor((4 * 48000) / MEL_BAND_PROFILE.hopSamples) },
          (_, index) =>
            metricStreamMelBandRecordSchema.parse({
              index,
              support: {
                startSample: sourceOrigin + index * MEL_BAND_PROFILE.hopSamples,
                endSample:
                  sourceOrigin + (index + 1) * MEL_BAND_PROFILE.hopSamples,
              },
              magnitudes: [
                Array.from({ length: 24 }, (_, band) => band + 1),
                Array.from({ length: 24 }, (_, band) => band + 1),
              ],
            }),
        ),
      },
    });
    await publish();
    await store.deriveFeatures(owner.captureId);
    const page = await store.listFeatures({
      entryId: owner.captureId,
      featureType: "mel-grid/v1",
      limit: 100,
    });
    expect(page.items).toHaveLength(2);
    const [left, right] = page.items;
    expect(left!.feature.profileKey).not.toEqual(right!.feature.profileKey);
    const comparison = compareListeningFeatures(left!.feature, right!.feature);
    const result = await store.searchFeatures({ featureId: left!.id });
    expect(result.exclusionReasons).toEqual({});
    expect(result).toMatchObject({
      comparableCount: 1,
      excludedCount: 0,
      exhaustive: true,
      matches: [{ feature: { id: right!.id } }],
    });
    expect(comparison.status).toBe("comparable");
    if (comparison.status === "comparable")
      expect(result.matches[0]).toMatchObject({
        distance: comparison.distance,
        coverage: comparison.coverage,
      });
    expect(
      (
        await store.searchFeatures({
          featureId: left!.id,
          excludeEntryIds: [owner.captureId],
        })
      ).matches,
    ).toEqual([]);
  });

  it("derives the complete feature catalog without recapture or whole-observation publication", async () => {
    const { store, owner, publish } = await fixture();
    await publish();
    const before = await store.getMetricCapture(owner.captureId);
    const derivation = await store.deriveFeatures(owner.captureId);
    expect(derivation.status).toBe("ready");
    const page = await store.listFeatures({
      entryId: owner.captureId,
      limit: 100,
    });
    expect(page.items.map((item) => item.feature.type).sort()).toEqual(
      LISTENING_FEATURE_DEFINITIONS.map((definition) => definition.type).sort(),
    );
    const after = await store.getMetricCapture(owner.captureId);
    expect(after?.state).toEqual(before?.state);
    expect(after?.manifest).toEqual(before?.manifest);
    expect(after?.chunkCount).toBe(before?.chunkCount);
  });

  it("keeps repeated derivation idempotent and attributable to the original context", async () => {
    const { store, owner, publish } = await fixture();
    await publish();
    const first = await store.deriveFeatures(owner.captureId);
    const second = await store.deriveFeatures(owner.captureId);
    expect(first.status).toBe("ready");
    expect(second).toEqual(first);
    const page = await store.listFeatures({
      entryId: owner.captureId,
      limit: 100,
    });
    expect(page.items).toHaveLength(15);
    expect(
      page.items.every(
        (item) =>
          item.entryId === owner.captureId &&
          item.sessionId === "session" &&
          item.liveSetId === "set",
      ),
    ).toBe(true);
  });

  it("derives identical values and support independently of physical chunk boundaries", async () => {
    const sources = await Promise.all([fixture(4), fixture(256)]);
    const values = [];
    const chunkCounts = [];
    for (const { store, owner, publish } of sources) {
      await publish();
      const capture = await store.getMetricCapture(owner.captureId);
      chunkCounts.push(capture?.chunkCount);
      await store.deriveFeatures(owner.captureId);
      const page = await store.listFeatures({
        entryId: owner.captureId,
        limit: 100,
      });
      expect(page.items).toHaveLength(15);
      values.push(
        page.items
          .map((item) => item.feature)
          .sort((left, right) => left.type.localeCompare(right.type)),
      );
    }
    expect(chunkCounts[0]).toBeGreaterThan(chunkCounts[1]!);
    expect(values[0]).toEqual(values[1]);
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "does not derive or expose features from a %s capture",
    async (status) => {
      const { store, owner } = await fixture();
      await store.terminateMetricCapture(owner, status, "Controlled stop");
      await expect(store.deriveFeatures(owner.captureId)).rejects.toThrow();
      expect((await store.listFeatures({ limit: 100 })).items).toHaveLength(0);
      expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
        status,
      );
    },
  );

  it("does not derive or expose features from an unfinished capture", async () => {
    const { store, owner } = await fixture();
    await expect(store.deriveFeatures(owner.captureId)).rejects.toThrow();
    const page = await store.listFeatures({ limit: 100 });
    expect(page.items).toHaveLength(0);
    expect((await store.getMetricCapture(owner.captureId))?.status).toBe(
      "staging",
    );
  });
});
