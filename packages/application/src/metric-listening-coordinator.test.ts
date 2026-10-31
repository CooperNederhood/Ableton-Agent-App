import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  metricListeningResultSummariesSchema,
  type StoredAudioObservation,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricListeningObservation,
  createSyntheticPartialMetricListeningObservation,
} from "@ableton-agent/protocol/testing";
import {
  LocalObservabilityJournal,
  telemetryEventEnvelopeSchema,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";
import { resolveLiveAgentStorage } from "@ableton-agent/storage";
import {
  ListeningCoordinator,
  type ListeningCoordinatorServices,
} from "./listening-coordinator.js";

const owner = {
  sessionId: "session",
  liveSetId: "live-set",
  agentId: "00000000-0000-4000-8000-000000000001",
};
const trace = {
  traceId: "00000000-0000-4000-8000-000000000002",
  correlationId: "correlation",
  causationId: "causation",
};
const request = {
  mode: "arrangement" as const,
  listenerIds: ["listener"],
  startBeat: 0,
  endBeat: 1,
  maximumDurationMs: 1_000,
};

function fixture(
  options: {
    partial?: boolean;
    negotiated?: boolean;
    mutate?: (
      observation: ReturnType<typeof createSyntheticMetricListeningObservation>,
    ) => void;
    disarm?: () => Promise<void>;
  } = {},
) {
  const events: TelemetryEventEnvelope[] = [];
  let published: readonly StoredAudioObservation[] = [];
  const disarm = vi.fn(options.disarm ?? (async () => {}));
  const release = vi.fn(async () => {});
  const persist = vi.fn<ListeningCoordinatorServices["persist"]>(
    async (input) => {
      published = input.observations;
      return ["context"];
    },
  );
  const coordinator = new ListeningCoordinator({
    telemetry: { enqueue: (event) => events.push(event) },
    services: {
      inspect: async () => ({
        liveSetId: owner.liveSetId,
        isPlaying: false,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
      }),
      reservePublication: async () => ({ release }),
      prepare: async ({ passId }) => {
        const observation = options.partial
          ? createSyntheticPartialMetricListeningObservation()
          : createSyntheticMetricListeningObservation();
        observation.ownership = { ...observation.ownership, ...trace, passId };
        options.mutate?.(observation);
        return {
          ...(options.negotiated === false
            ? {}
            : {
                observationContract: "independent-metric-timelines/v1" as const,
              }),
          observations: Promise.resolve([observation]),
          disarm,
        };
      },
      startPlayback: async () => ({ cleanupPolicy: "leave-running", release }),
      persist,
      validateObservations: () => {},
    },
  });
  const start = () => coordinator.start(request, owner, trace);
  return {
    coordinator,
    events,
    disarm,
    release,
    persist,
    start,
    published: () => published,
  };
}

describe("explicit independent metric coordinator contract", () => {
  it.each([false, true])(
    "publishes the honest terminal outcome (partial=%s) only after cleanup and commit",
    async (partial) => {
      const f = fixture({ partial });
      const accepted = f.start();
      const job = await f.coordinator.wait(accepted.passId, owner);
      expect(job.stage).toBe(partial ? "partial" : "completed");
      expect(job.contextIds).toEqual(["context"]);
      expect(job.error).toBeUndefined();
      expect(job.metricResults).toHaveLength(1);
      expect(
        metricListeningResultSummariesSchema.safeParse(job.metricResults)
          .success,
      ).toBe(true);
      expect(job.metricResults![0]!.metrics).toContainEqual(
        expect.objectContaining({
          metric: "spectral-centroid",
          status: partial ? "partial" : "complete",
          missingRecords: partial ? 1 : 0,
        }),
      );
      expect(f.published()[0]!.schema).toBe("metric-audio-observation/v1");
      expect(f.disarm.mock.invocationCallOrder[0]).toBeLessThan(
        f.persist.mock.invocationCallOrder[0]!,
      );
      const terminal = f.events.filter((event) =>
        [
          "listening.partial",
          "listening.completed",
          "listening.failed",
        ].includes(event.name),
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.name).toBe(
        partial ? "listening.partial" : "listening.completed",
      );
      expect(terminal[0]!.trace?.traceId).toBe(trace.traceId);
      expect(terminal[0]!.correlationId).toBe(trace.correlationId);
      expect(terminal[0]!.causationId).toBe(trace.causationId);
      expect(terminal[0]!.durationMs).toBeGreaterThanOrEqual(0);
      for (const event of f.events)
        expect(telemetryEventEnvelopeSchema.safeParse(event).success).toBe(
          true,
        );
      expect(terminal[0]!.attributes).toMatchObject({
        passId: job.passId,
        metricResults: job.metricResults,
      });
      expect(await f.coordinator.cancel(job.passId, owner)).toEqual(job);
      expect(f.disarm).toHaveBeenCalledTimes(1);
      await f.coordinator.shutdown();
    },
  );

  it("retains the partial terminal stage, metrics, timing and attribution in typed History after reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "metric-publication-history-"));
    const storage = resolveLiveAgentStorage({
      environment: { LIVE_AGENT_HOME: root },
      profile: "automation",
    });
    await mkdir(storage.observabilityDirectory, { recursive: true });
    let journal: LocalObservabilityJournal | undefined;
    try {
      const f = fixture({ partial: true });
      const job = await f.coordinator.wait(f.start().passId, owner);
      journal = await LocalObservabilityJournal.open({
        path: storage.eventJournalPath,
      });
      for (const event of f.events) await journal.enqueue(event);
      await journal.close();
      journal = await LocalObservabilityJournal.open({
        path: storage.eventJournalPath,
      });
      const history = await journal.readTrace(trace.traceId, {
        limit: 100,
        order: "asc",
      });
      const terminal = history.items.filter(
        (event) => event.name === "listening.partial",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        stage: "partial",
        source: "listening-coordinator",
        trace: { traceId: trace.traceId },
        correlationId: trace.correlationId,
        causationId: trace.causationId,
        durationMs: job.durationMs,
        attributes: {
          passId: job.passId,
          contextIds: ["context"],
          metricResults: job.metricResults,
        },
      });
      expect(history.items.at(-1)!.name).toBe("listening.partial");
      expect(
        history.items.filter(
          (event) => event.name === "listening.cleanup.completed",
        ),
      ).toHaveLength(3);
      await f.coordinator.shutdown();
    } finally {
      await journal?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not accept a new observation merely because saved readers support it", async () => {
    const f = fixture({ negotiated: false, partial: true });
    const job = await f.coordinator.wait(f.start().passId, owner);
    expect(job.stage).toBe("failed");
    expect(job.contextIds).toEqual([]);
    expect(f.persist).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });

  it.each([
    "passId",
    "listenerId",
    "traceId",
    "correlationId",
    "causationId",
  ] as const)(
    "rejects foreign %s rather than salvaging a partial result",
    async (field) => {
      const f = fixture({
        partial: true,
        mutate: (observation) => {
          observation.ownership[field] =
            field === "traceId"
              ? "00000000-0000-4000-8000-000000000099"
              : "foreign";
        },
      });
      const job = await f.coordinator.wait(f.start().passId, owner);
      expect(job.stage).toBe("failed");
      expect(job.contextIds).toEqual([]);
      expect(f.persist).not.toHaveBeenCalled();
      await f.coordinator.shutdown();
    },
  );

  it("does not hide cleanup uncertainty behind a partial label", async () => {
    const f = fixture({
      partial: true,
      disarm: async () => {
        throw new Error("Unconfirmed DSP cleanup");
      },
    });
    const job = await f.coordinator.wait(f.start().passId, owner);
    expect(job.stage).toBe("failed");
    expect(job.contextIds).toEqual([]);
    expect(f.persist).not.toHaveBeenCalled();
    expect(job.error).toContain("Unconfirmed DSP cleanup");
    await f.coordinator.shutdown();
  });

  it("cancels a partial capture before commit without publishing it", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const disarming = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = fixture({
      partial: true,
      disarm: async () => {
        entered();
        await blocked;
      },
    });
    const accepted = f.start();
    await disarming;
    const cancelled = f.coordinator.cancel(accepted.passId, owner);
    finish();
    const job = await cancelled;
    expect(job.stage).toBe("cancelled");
    expect(job.contextIds).toEqual([]);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.name === "listening.partial")).toBe(
      false,
    );
    await f.coordinator.shutdown();
  });
});
