import { ListeningFailure } from "@ableton-agent/application";
import type { ListeningMusicalAlignment } from "@ableton-agent/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createMonitoringController,
  type MonitoringPassHandle,
  type MonitoringPassPlan,
} from "./monitoring-controller.js";

const alignment: ListeningMusicalAlignment = {
  version: 1,
  coordinate: "transport-beats",
  meter: { numerator: 4, denominator: 4 },
  barOriginBeat: 0,
  tempoBpm: 120,
  tempoEvidence: "message-rate-monitored-constant",
  provenance: "capture-snapshot/v1",
};
const owner = { sessionId: "s", agentId: "a", liveSetId: "l" };
const context = {
  sessionId: "s",
  agentId: "a",
  trace: { traceId: "t", correlationId: "c", causationId: "c" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const passes: {
    plan: MonitoringPassPlan;
    result: ReturnType<typeof deferred<unknown>>;
    launch: ReturnType<typeof deferred<void>>;
    disarm: ReturnType<typeof vi.fn>;
  }[] = [];
  const plans: (number | "playing")[] = [];
  const controller = createMonitoringController({
    pollMs: 1,
    plan: async ({ maxBars }) => {
      const next = plans.shift() ?? 0;
      if (next === "playing")
        throw new ListeningFailure("transport_not_stopped", "playing");
      return {
        startBeat: next,
        endBeat: next + maxBars * 4,
        alignment,
        tracks: [{ listenerId: "L1", trackReference: "T1" }],
      };
    },
    arm: async ({ plan }): Promise<MonitoringPassHandle> => {
      const pass = {
        plan,
        result: deferred<unknown>(),
        launch: deferred<void>(),
        disarm: vi.fn(async () => {}),
      };
      pass.disarm.mockImplementation(async () =>
        pass.result.reject(new Error("cancelled")),
      );
      passes.push(pass);
      return {
        result: pass.result.promise,
        nativeLaunch: pass.launch.promise,
        disarm: pass.disarm,
      };
    },
  });
  return { controller, passes, plans };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("monitoring controller", () => {
  it("re-arms from the new stopped playhead after playback stops, then completes", async () => {
    const { controller, passes, plans } = harness();
    plans.push(8, "playing", 32);
    const started = await controller.start(
      { listenerIds: ["L1"], maxBars: 16, maxWindowBars: 8 },
      owner,
      context,
    );
    expect(started).toMatchObject({ status: "armed", startBeat: 8 });

    passes[0]!.launch.resolve();
    await settle();
    expect((await controller.get(started.monitoringId, owner)).status).toBe(
      "monitoring",
    );
    passes[0]!.result.reject(new Error("metric_source_transport_stopped"));
    await settle();

    const rearmed = await controller.get(started.monitoringId, owner);
    expect(rearmed).toMatchObject({ status: "armed", startBeat: 32 });
    expect(rearmed.barsRemaining).toBe(16);

    const waiting = controller.get(started.monitoringId, owner, {
      afterSequence: started.nextSequence,
      waitMs: 5_000,
    });
    passes[1]!.launch.resolve();
    passes[1]!.result.resolve([]);
    const done = await waiting;
    expect(done).toMatchObject({
      status: "completed",
      barsRemaining: 0,
      nextSequence: 0,
    });
    expect(done.episodes.map(({ episode }) => episode.kind)).toEqual([
      "closed",
    ]);
    expect(
      (
        await controller.get(started.monitoringId, owner, {
          afterSequence: done.nextSequence,
        })
      ).episodes,
    ).toEqual([]);
  });

  it("stop disarms the armed pass and refuses other owners", async () => {
    const { controller, passes } = harness();
    const started = await controller.start(
      { listenerIds: ["L1"], maxBars: 8, maxWindowBars: 8 },
      owner,
      context,
    );
    await expect(
      controller.get(started.monitoringId, { ...owner, agentId: "other" }),
    ).rejects.toThrow(ListeningFailure);
    const stopped = await controller.stop(started.monitoringId, owner);
    expect(passes[0]!.disarm).toHaveBeenCalled();
    expect(stopped.status).toBe("stopped");
    expect(passes).toHaveLength(1);
  });
});
