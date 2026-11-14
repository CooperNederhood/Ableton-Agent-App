import { describe, expect, it, vi } from "vitest";
import {
  metricRecordStreamDescriptorDigest,
  type MetricRecordStreamManifest,
} from "@ableton-agent/protocol";
import {
  createSyntheticMetricRecordStreamFixture,
  createSyntheticMetricRecordStreamTerminalProof,
} from "@ableton-agent/protocol/testing";
import {
  ListeningCoordinator,
  type ListeningCoordinatorServices,
} from "./listening-coordinator.js";

const owner = { sessionId: "session", liveSetId: "set", agentId: "agent" };
const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
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

async function harness(
  options: {
    mutate?: (manifest: MetricRecordStreamManifest) => void;
    disarm?: () => Promise<void>;
    validate?: ListeningCoordinatorServices["validateStreams"];
    publish?: ListeningCoordinatorServices["persistStreams"];
  } = {},
) {
  const synthetic = await createSyntheticMetricRecordStreamFixture();
  const release = vi.fn(async () => {});
  const disarm = vi.fn(options.disarm ?? (async () => {}));
  const persist = vi.fn(async () => ["wrong-observation-path"]);
  const publish = vi.fn(options.publish ?? (async () => ["stream-context"]));
  const validate = vi.fn(options.validate ?? (() => {}));
  const events: string[] = [];
  const coordinator = new ListeningCoordinator({
    telemetry: { enqueue: (event) => events.push(event.name) },
    services: {
      inspect: async () => ({
        liveSetId: owner.liveSetId,
        isPlaying: false,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
      }),
      reservePublication: async () => ({ release: async () => {} }),
      prepare: async ({ passId }) => {
        const descriptor = structuredClone(synthetic.descriptor);
        descriptor.ownership = { ...descriptor.ownership, ...trace, passId };
        const manifest = {
          ...synthetic.manifest,
          ownership: descriptor.ownership,
          descriptorDigest:
            await metricRecordStreamDescriptorDigest(descriptor),
          nativeProof:
            createSyntheticMetricRecordStreamTerminalProof(descriptor),
        };
        options.mutate?.(manifest);
        return {
          observationContract: "metric-record-stream/v1",
          manifests: Promise.resolve([manifest]),
          disarm,
        };
      },
      startPlayback: async () => ({ cleanupPolicy: "leave-running", release }),
      validateObservations: vi.fn(),
      persist,
      validateStreams: validate,
      persistStreams: publish,
    },
  });
  const start = () => coordinator.start(request, owner, trace);
  return {
    coordinator,
    start,
    release,
    disarm,
    persist,
    publish,
    validate,
    events,
  };
}

describe("continuous coordinator publication gate", () => {
  it("publishes only after validation and cleanup, without reassembling observations", async () => {
    const f = await harness();
    const job = await f.coordinator.wait(f.start().passId, owner);
    expect(job).toMatchObject({
      stage: "completed",
      cleanupPolicy: "leave-running",
      contextIds: ["stream-context"],
    });
    expect(job.metricResults?.[0]?.metrics).toHaveLength(6);
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.validate.mock.invocationCallOrder[0]).toBeLessThan(
      f.disarm.mock.invocationCallOrder[0]!,
    );
    expect(f.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      f.publish.mock.invocationCallOrder[0]!,
    );
    expect(f.release.mock.invocationCallOrder[0]).toBeLessThan(
      f.publish.mock.invocationCallOrder[0]!,
    );
    expect(
      f.events.filter((name) => name === "listening.completed"),
    ).toHaveLength(1);
    await f.coordinator.shutdown();
  });

  it.each([
    "passId",
    "listenerId",
    "traceId",
    "correlationId",
    "causationId",
  ] as const)("rejects a foreign manifest %s", async (field) => {
    const f = await harness({
      mutate: (manifest) => {
        manifest.ownership[field] = "foreign";
      },
    });
    const job = await f.coordinator.wait(f.start().passId, owner);
    expect(job.stage).toBe("failed");
    expect(job.contextIds).toEqual([]);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    await f.coordinator.shutdown();
  });

  it.each(["validation", "cleanup", "publication"] as const)(
    "does not report success after %s failure",
    async (stage) => {
      const failure = () => {
        throw new Error(`synthetic ${stage} failure`);
      };
      const f = await harness({
        ...(stage === "validation" ? { validate: failure } : {}),
        ...(stage === "cleanup" ? { disarm: async () => failure() } : {}),
        ...(stage === "publication" ? { publish: async () => failure() } : {}),
      });
      const job = await f.coordinator.wait(f.start().passId, owner);
      expect(job.stage).toBe("failed");
      expect(job.contextIds).toEqual([]);
      expect(job.metricResults).toBeUndefined();
      if (stage !== "publication") expect(f.publish).not.toHaveBeenCalled();
      expect(f.persist).not.toHaveBeenCalled();
      await f.coordinator.shutdown();
    },
  );
});
