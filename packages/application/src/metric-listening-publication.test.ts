import { describe, expect, it } from "vitest";
import {
  createMetricObservationReportRows,
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  classifyPitchEstimate,
  type MetricAudioObservation,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricListeningObservation,
  withSyntheticAnalyzerTimelines,
} from "@ableton-agent/protocol/testing";
import { createInMemorySessionContextStore } from "@ableton-agent/project-state";
import { contextOperationResultSchema } from "@ableton-agent/tools";
import { createSessionContextHost } from "./session-context-host.js";
import {
  buildListeningPublication,
  buildMetricListeningPublication,
  persistMetricListeningObservations,
  type MetricListeningPublicationInput,
} from "./listening-publication.js";

const uuid = "00000000-0000-4000-8000-000000000001";

function fixture(partial = false): MetricListeningPublicationInput {
  const observation = createSyntheticMetricListeningObservation();
  observation.ownership.correlationId = "capture";
  observation.ownership.causationId = "publication";
  observation.source = {
    view: "arrangement",
    target: { kind: "regular", index: 0, expectedReference: uuid },
    transport: { startBeat: 0, endBeat: 1 },
  };
  if (partial) {
    const spectral = observation.metrics["spectral-centroid"];
    observation.outcome = "partial";
    spectral.status = "failed";
    spectral.gaps = [
      {
        firstIndex: 0,
        count: spectral.expectedRecords,
        startSample: spectral.records[0]!.support.startSample,
        endSample: spectral.records.at(-1)!.support.endSample,
        reason: "drain-timeout",
        detail: "Synthetic frequency reader delivery failure",
      },
    ];
    spectral.records = [];
    observation.rows = createMetricObservationReportRows(observation);
  }
  return {
    passId: "pass",
    owner: { sessionId: "session", liveSetId: "set", agentId: "agent" },
    trace: {
      traceId: uuid,
      correlationId: "capture",
      causationId: "publication",
    },
    requestedMode: "arrangement",
    actualMode: "arrangement",
    requestedRange: { startBeat: 0, endBeat: 1 },
    createdAt: "2026-10-30T12:00:00.000Z",
    startedAt: "2026-10-30T12:00:00.100Z",
    endedAt: "2026-10-30T12:00:01.000Z",
    observations: [observation],
    bindings: [
      {
        listenerId: "listener",
        deviceReference: "device",
        connectionEpoch: uuid,
        version: "metric-audio-observation/v1",
        primary: {
          id: "track-subject",
          sessionId: "session",
          liveSetId: "set",
          kind: "track",
          trackId: "track",
          location: "track",
          binding: {
            version: 1,
            semanticLocator: {
              name: "Synthetic metric track",
              trackId: "track",
            },
            sourceIdentity: "runtime-only:track",
            playbackSettingsHash: "settings-inspected",
            upstreamProcessingHash: "upstream-inspected",
            routingHash: "routing-inspected",
            dependencyScope: "unknown",
            previousRuntimeBindings: [uuid],
          },
        },
        contributors: [],
        attribution: "unknown",
      },
    ],
  };
}

describe("explicit independent metric publication", () => {
  it("exposes all five analyzer features through persisted typed detail, comparison and source-excluding search", async () => {
    const original = fixture();
    const first: MetricListeningPublicationInput = {
      ...original,
      observations: [withSyntheticAnalyzerTimelines(original.observations[0]!)],
      bindings: original.bindings.map((binding) => ({
        ...binding,
        musicalAlignment: {
          version: 1,
          coordinate: "transport-beats",
          meter: { numerator: 4, denominator: 4 },
          barOriginBeat: 0,
          tempoBpm: original.observations[0]!.geometry.tempoBpm,
          tempoEvidence: "message-rate-monitored-constant",
          provenance: "capture-snapshot/v1",
        },
      })),
    };
    const observation = structuredClone(first.observations[0]!);
    observation.ownership.passId = "second-analyzers";
    observation.metrics.pitch = {
      ...observation.metrics.pitch!,
      frames: observation.metrics.pitch!.frames.map((frame) => ({
        ...frame,
        channels: [classifyPitchEstimate(880, 0.9), frame.channels[1]] as const,
      })),
    };
    observation.metrics["spectral-shape"] = {
      ...observation.metrics["spectral-shape"]!,
      frames: observation.metrics["spectral-shape"]!.frames.map((frame) => ({
        ...frame,
        channels: [
          {
            state: "valid",
            flatnessDb: -30,
            spreadHz: 750,
            rolloffHz: 1250,
          },
          frame.channels[1],
        ] as const,
      })),
    };
    observation.rows = createMetricObservationReportRows(observation);
    const second = {
      ...first,
      passId: observation.ownership.passId,
      observations: [observation],
    };
    const store = await createInMemorySessionContextStore({
      sessionId: first.owner.sessionId,
      liveSetId: first.owner.liveSetId,
    });
    const host = createSessionContextHost({
      resolveRepository: async () => store,
    });
    const actor = {
      sessionId: first.owner.sessionId,
      agentId: first.owner.agentId,
      trace: first.trace,
    };
    try {
      const sourceIds: string[] = [];
      for (const input of [first, second])
        sourceIds.push(
          ...(await persistMetricListeningObservations(
            store,
            input,
            new AbortController().signal,
          )),
        );
      const before = await Promise.all(
        sourceIds.map((id) => store.getEntry(id)),
      );
      const derived = await host.executeContextOperation(
        {
          action: "derive-features",
          contextIds: sourceIds,
          includeHistorical: true,
        },
        actor,
      );
      expect(derived).toMatchObject({
        derivations: [
          { status: "ready", featureCount: 15 },
          { status: "ready", featureCount: 15 },
        ],
      });
      for (const [featureType, distance, units] of [
        ["pitch-grid/v1", 1200, "cents"],
        ["pitch-confidence-summary/v1", 0.05, "algorithm-score"],
        ["flatness-summary/v1", 10, "dB"],
        ["spread-summary/v1", 250, "Hz"],
        ["rolloff-summary/v1", 250, "Hz"],
      ] as const) {
        const features = [];
        for (const contextId of sourceIds) {
          const result = await host.executeContextOperation(
            {
              action: "list-features",
              contextId,
              featureType,
              includeHistorical: true,
              limit: 10,
            },
            actor,
          );
          if (result.action !== "list-features")
            throw new Error("Expected inventory");
          expect(result.features).toHaveLength(1);
          expect(result.features[0]!.record.feature.status).toBe("ready");
          features.push(result.features[0]!.record);
        }
        const detail = contextOperationResultSchema.parse(
          await host.executeContextOperation(
            {
              action: "get-feature",
              featureId: features[0]!.id,
              includeHistorical: true,
              offset: 0,
              supportOffset: 0,
              limit: 32,
            },
            actor,
          ),
        );
        if (detail.action !== "get-feature") throw new Error("Expected detail");
        expect(detail.feature.record.feature.distanceUnits).toBe(units);
        expect(detail.feature.record.feature).not.toHaveProperty(
          "channelSupport",
        );
        expect(detail.page.channelSupportIntervals).toBeDefined();
        if (featureType === "pitch-grid/v1")
          expect(detail.feature.record.feature.units).toBe("midi-semitones");
        if (featureType === "flatness-summary/v1")
          expect(detail.page.values).toEqual([-20, null]);
        const compared = await host.executeContextOperation(
          {
            action: "compare-features",
            pairs: [
              {
                leftFeatureId: features[0]!.id,
                rightFeatureId: features[1]!.id,
              },
            ],
            includeHistorical: true,
          },
          actor,
        );
        if (compared.action !== "compare-features")
          throw new Error("Expected comparison");
        const comparison = compared.comparisons[0]!.result;
        if (comparison.status !== "comparable")
          throw new Error(`Not comparable: ${featureType}`);
        expect(comparison.distance).toBeCloseTo(distance, 8);
        expect(comparison.units).toBe(units);
        const searched = contextOperationResultSchema.parse(
          await host.executeContextOperation(
            {
              action: "search-features",
              featureId: features[0]!.id,
              excludeContextIds: [sourceIds[0]!],
              includeHistorical: true,
              limit: 10,
              candidateLimit: 1000,
            },
            actor,
          ),
        );
        if (searched.action !== "search-features")
          throw new Error("Expected search");
        expect(searched.distanceUnits).toBe(units);
        expect(searched.matches).toHaveLength(1);
        expect(searched.matches[0]!.feature.record.entryId).toBe(sourceIds[1]);
        expect(searched.matches[0]!.distance).toBeCloseTo(distance, 8);
      }
      expect(
        await Promise.all(sourceIds.map((id) => store.getEntry(id))),
      ).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it.each([undefined, "overflow"] as const)(
    "persists synthetic authoritative analyzer evidence unchanged with isolated %s outcome",
    async (failure) => {
      const original = fixture();
      const observation = withSyntheticAnalyzerTimelines(
        original.observations[0]!,
        failure,
      );
      const input = { ...original, observations: [observation] };
      const store = await createInMemorySessionContextStore({
        sessionId: input.owner.sessionId,
        liveSetId: input.owner.liveSetId,
      });
      try {
        const ids = await persistMetricListeningObservations(
          store,
          input,
          new AbortController().signal,
        );
        expect((await store.getEntry(ids[0]!))?.payload).toEqual(observation);
        const publication = buildMetricListeningPublication(input);
        expect(publication.entries[0]?.payload).toEqual(observation);
        expect(publication.pass.status).toBe(failure ? "partial" : "completed");
        expect(observation.metrics["spectral-shape"]?.status).toBe("complete");
        expect(observation.metrics.level.status).toBe("complete");
      } finally {
        await store.close();
      }
    },
  );
  it("derives, compares and searches persisted peaks through the same typed host without recapture", async () => {
    const first = fixture();
    const secondObservation = structuredClone(first.observations[0]!);
    secondObservation.ownership.passId = "pass-two";
    for (const record of secondObservation.metrics.level.records) {
      record.peak = [0.75, 0.75];
    }
    const second = {
      ...first,
      passId: "pass-two",
      observations: [secondObservation],
    };
    const store = await createInMemorySessionContextStore({
      sessionId: first.owner.sessionId,
      liveSetId: first.owner.liveSetId,
    });
    const host = createSessionContextHost({
      resolveRepository: async () => store,
    });
    const actor = {
      sessionId: first.owner.sessionId,
      agentId: first.owner.agentId,
      trace: first.trace,
    };
    try {
      const sourceIds = [];
      for (const input of [first, second]) {
        sourceIds.push(
          ...(await persistMetricListeningObservations(
            store,
            input,
            new AbortController().signal,
          )),
        );
      }
      const before = await Promise.all(
        sourceIds.map((id) => store.getEntry(id)),
      );
      const derived = await host.executeContextOperation(
        {
          action: "derive-features",
          contextIds: sourceIds,
          includeHistorical: true,
        },
        actor,
      );
      expect(derived).toMatchObject({
        derivations: [{ status: "ready" }, { status: "ready" }],
      });
      const features = [];
      for (const id of sourceIds) {
        const page = await host.executeContextOperation(
          {
            action: "list-features",
            contextId: id,
            featureType: "peak-summary/v1",
            includeHistorical: true,
            limit: 10,
          },
          actor,
        );
        if (page.action !== "list-features")
          throw new Error("Expected feature inventory");
        expect(page.features).toHaveLength(1);
        features.push(page.features[0]!.record);
      }
      const comparison = await host.executeContextOperation(
        {
          action: "compare-features",
          pairs: [
            { leftFeatureId: features[0]!.id, rightFeatureId: features[1]!.id },
          ],
          includeHistorical: true,
        },
        actor,
      );
      if (comparison.action !== "compare-features")
        throw new Error("Expected comparison");
      const persisted = await Promise.all(
        features.map((feature) => store.getFeature(feature.id)),
      );
      const left = persisted[0]!.feature.values!;
      const right = persisted[1]!.feature.values!;
      const expected = Math.hypot(left[0]! - right[0]!, left[1]! - right[1]!);
      const detail = await host.executeContextOperation(
        {
          action: "get-feature",
          featureId: features[0]!.id,
          includeHistorical: true,
          offset: 0,
          supportOffset: 0,
          limit: 32,
        },
        actor,
      );
      expect(contextOperationResultSchema.parse(detail)).toMatchObject({
        action: "get-feature",
        page: { values: left, nextOffset: null },
      });
      expect(comparison.comparisons[0]!.result).toMatchObject({
        status: "comparable",
        distance: expected,
      });
      expect(expected).toBeGreaterThan(0);
      const result = contextOperationResultSchema.parse(
        await host.executeContextOperation(
          {
            action: "search-features",
            featureId: features[0]!.id,
            excludeContextIds: [sourceIds[0]!],
            includeHistorical: true,
            limit: 10,
            candidateLimit: 1_000,
          },
          actor,
        ),
      );
      if (result.action !== "search-features")
        throw new Error("Expected search");
      expect(result.exhaustive).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        distance: expected,
        feature: {
          record: { entryId: sourceIds[1] },
          segment: { kind: "unaligned" },
        },
      });
      expect(
        await Promise.all(sourceIds.map((id) => store.getEntry(id))),
      ).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it.each([false, true])(
    "persists full mel vectors and explicit gaps: partial=%s",
    async (partial) => {
      const input = fixture();
      const observation = input.observations[0]!;
      const expectedRecords = Math.floor(
        observation.geometry.totalSamples / 2_048,
      );
      const frames = Array.from({ length: expectedRecords }, (_, index) => ({
        index,
        support: {
          startSample: observation.geometry.startSample + index * 2_048,
          endSample: observation.geometry.startSample + (index + 1) * 2_048,
        },
        magnitudes: [Array<number>(24).fill(1), Array<number>(24).fill(2)],
      }));
      observation.requestedMetrics.push("mel-bands");
      observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
        schema: "mel-band-timeline/v1",
        status: partial ? "partial" : "complete",
        profile: MEL_BAND_PROFILE,
        sampleRate: observation.geometry.sampleRate,
        sourceSupport: observation.sourceCoverage,
        expectedRecords,
        frames: partial ? frames.slice(1) : frames,
        gaps: partial
          ? [
              {
                firstIndex: 0,
                count: 1,
                support: frames[0]!.support,
                reason: "malformed-record",
              },
            ]
          : [],
      });
      observation.outcome = partial ? "partial" : "complete";
      observation.rows = createMetricObservationReportRows(observation);
      const store = await createInMemorySessionContextStore({
        sessionId: input.owner.sessionId,
        liveSetId: input.owner.liveSetId,
      });
      try {
        const malformed = {
          ...input,
          observations: [
            {
              ...observation,
              metrics: { ...observation.metrics, "mel-bands": undefined },
            },
          ],
        };
        await expect(
          persistMetricListeningObservations(
            store,
            malformed,
            new AbortController().signal,
          ),
        ).rejects.toThrow();
        expect(
          (await store.listEntries({ includeHistorical: true })).items,
        ).toHaveLength(0);
        const ids = await persistMetricListeningObservations(
          store,
          input,
          new AbortController().signal,
        );
        expect((await store.getEntry(ids[0]!))?.payload).toEqual(observation);
        expect(buildMetricListeningPublication(input).pass.status).toBe(
          partial ? "partial" : "completed",
        );
        expect(observation.metrics.level.records.length).toBeGreaterThan(0);
      } finally {
        await store.close();
      }
    },
  );
  it.each([false, true])(
    "publishes the truthful complete or partial outcome: partial=%s",
    (partial) => {
      const input = fixture(partial);
      const publication = buildMetricListeningPublication(input);
      expect(publication.pass.status).toBe(partial ? "partial" : "completed");
      expect(publication.pass.complete).toBe(!partial);
      expect(publication.entries[0]!.kind).toBe("metric-audio-observation/v1");
      expect(publication.entries[0]!.payload).toEqual(input.observations[0]);
      expect(publication.pass.actualRange).toEqual(input.requestedRange);
      expect(publication.links[0]!.coverage).toEqual(input.requestedRange);
      expect(publication.pass.interruptionReason === null).toBe(!partial);
    },
  );

  it("does not accept new evidence through the legacy publication entry point", () => {
    expect(() => buildListeningPublication(fixture(true))).toThrow(
      "explicitly negotiated publication path",
    );
  });

  it.each([
    (value: MetricAudioObservation) => {
      value.ownership.passId = "other-pass";
    },
    (value: MetricAudioObservation) => {
      value.ownership.listenerId = "other-listener";
    },
    (value: MetricAudioObservation) => {
      value.ownership.connectionEpoch = "00000000-0000-4000-8000-000000000002";
    },
    (value: MetricAudioObservation) => {
      value.ownership.traceId = "00000000-0000-4000-8000-000000000002";
    },
    (value: MetricAudioObservation) => {
      value.ownership.correlationId = "other-correlation";
    },
    (value: MetricAudioObservation) => {
      value.ownership.causationId = "other-causation";
    },
  ])(
    "rejects foreign attribution even for useful partial data %#",
    (change) => {
      const input = fixture(true);
      change(input.observations[0]!);
      expect(() => buildMetricListeningPublication(input)).toThrow();
    },
  );

  it("requires the inspected source and exact requested range", () => {
    const input = fixture();
    input.observations[0]!.source = {
      view: "arrangement",
      target: {
        kind: "regular",
        index: 0,
        expectedReference: "00000000-0000-4000-8000-000000000002",
      },
      transport: { startBeat: 0, endBeat: 1 },
    };
    expect(() => buildMetricListeningPublication(input)).toThrow(
      "inspected ownership",
    );
    expect(() =>
      buildMetricListeningPublication({
        ...fixture(),
        requestedRange: { startBeat: 0, endBeat: 2 },
      }),
    ).toThrow("inspected ownership");
  });

  it("never promotes partial descriptive evidence to exclusive attribution", () => {
    const input = fixture(true);
    expect(() =>
      buildMetricListeningPublication({
        ...input,
        bindings: input.bindings.map((binding) => ({
          ...binding,
          attribution: "exclusive",
        })),
      }),
    ).toThrow("exclusive attribution");
  });

  it("rejects fabricated completeness before building context entries", () => {
    const input = fixture(true);
    input.observations[0]!.outcome = "complete";
    expect(() => buildMetricListeningPublication(input)).toThrow(
      "Overall outcome",
    );
  });

  it("persists a partial result with all valid data and explicit gaps intact", async () => {
    const input = fixture(true);
    const store = await createInMemorySessionContextStore({
      sessionId: input.owner.sessionId,
      liveSetId: input.owner.liveSetId,
    });
    try {
      const [id] = await persistMetricListeningObservations(
        store,
        input,
        new AbortController().signal,
      );
      expect(id).toBeDefined();
      const entry = await store.getEntry(id!);
      expect(entry?.payload).toEqual(input.observations[0]);
      expect(entry?.kind).toBe("metric-audio-observation/v1");
    } finally {
      await store.close();
    }
  });

  it("does not commit an aborted or foreign-session partial publication", async () => {
    const input = fixture(true);
    const store = await createInMemorySessionContextStore({
      sessionId: input.owner.sessionId,
      liveSetId: input.owner.liveSetId,
    });
    try {
      await expect(
        persistMetricListeningObservations(
          store,
          input,
          AbortSignal.abort(new Error("capture cancelled before commit")),
        ),
      ).rejects.toThrow("capture cancelled");
      await expect(
        persistMetricListeningObservations(
          store,
          { ...input, owner: { ...input.owner, sessionId: "foreign-session" } },
          new AbortController().signal,
        ),
      ).rejects.toThrow("another session or Set");
      expect(
        (await store.listEntries({ includeHistorical: true })).items,
      ).toHaveLength(0);
    } finally {
      await store.close();
    }
  });
});
