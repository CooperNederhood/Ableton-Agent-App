import { describe, expect, it } from "vitest";
import {
  createMetricObservationReportRows,
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  type MetricAudioObservation,
} from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import { createInMemorySessionContextStore } from "@ableton-agent/project-state";
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
