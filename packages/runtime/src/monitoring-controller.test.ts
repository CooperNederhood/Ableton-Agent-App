import { ListeningFailure } from "@ableton-agent/application";
import type { ListeningMusicalAlignment } from "@ableton-agent/protocol";
import { createSyntheticMetricRecordStreamFixture } from "@ableton-agent/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createMonitoringController,
  type MonitoringPassHandle,
  type MonitoringPassPlan,
} from "./monitoring-controller.js";
import type { MetricRecordStagedSink } from "./metric-record-ingestion.js";

const alignment: ListeningMusicalAlignment = {
  version: 1,
  coordinate: "transport-beats",
  meter: { numerator: 4, denominator: 4 },
  barOriginBeat: 0,
  tempoBpm: 120,
  tempoEvidence: "message-rate-monitored-constant",
  provenance: "capture-snapshot/v1",
};
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

function harness(passBeats = 64) {
  const passes: {
    plan: MonitoringPassPlan;
    result: ReturnType<typeof deferred<unknown>>;
    launch: ReturnType<typeof deferred<void>>;
    disarm: ReturnType<typeof vi.fn>;
    sink: MetricRecordStagedSink;
  }[] = [];
  const plans: (number | "playing")[] = [];
  const planned: string[][] = [];
  const budgets: (number | undefined)[] = [];
  const controller = createMonitoringController({
    pollMs: 1,
    plan: async ({ listenerIds, maxBars }) => {
      planned.push([...listenerIds]);
      budgets.push(maxBars);
      const next = plans.shift() ?? 0;
      if (next === "playing")
        throw new ListeningFailure("transport_not_stopped", "playing");
      return {
        startBeat: next,
        endBeat: next + passBeats,
        alignment,
        tracks: listenerIds.map((listenerId) => ({
          listenerId,
          trackReference: `T-${listenerId}`,
        })),
      };
    },
    arm: async ({ plan, sink }): Promise<MonitoringPassHandle> => {
      const pass = {
        plan,
        sink,
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
  return { controller, passes, plans, planned, budgets };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const appContext = {
  ...context,
  agentId: "app",
  actorKind: "application" as const,
};

describe("monitoring controller", () => {
  it("re-arms from the new stopped playhead after playback stops", async () => {
    const { controller, passes, plans } = harness();
    plans.push(8, "playing", 32);
    const armed = await controller.arm({ listenerIds: ["L1"] }, context);
    expect(armed).toMatchObject({ status: "armed", startBeat: 8 });
    expect(armed.tracks[0]).toMatchObject({
      trackReference: "T-L1",
      pending: false,
    });

    passes[0]!.launch.resolve();
    await settle();
    expect(controller.snapshot().status).toBe("monitoring");
    passes[0]!.result.reject(new Error("metric_source_transport_stopped"));
    await settle();

    const rearmed = await controller.read();
    expect(rearmed).toMatchObject({ status: "armed", startBeat: 32 });
    expect(rearmed.episodes).toEqual([]);
  });

  it("closes a monitor after maxBars and ends monitoring", async () => {
    const { controller, passes, budgets } = harness();
    const fixture = await createSyntheticMetricRecordStreamFixture({
      seconds: 12,
      requestedMetrics: ["mel-bands"],
    });
    const listenerId = fixture.descriptor.ownership.listenerId;
    await controller.arm({ listenerIds: [listenerId], maxBars: 2 }, context);
    // The pass is sized to the budget so it ends without a mid-capture cancel.
    expect(budgets).toEqual([2]);
    const { sink, launch, result, disarm } = passes[0]!;
    launch.resolve();
    await sink.begin(fixture.descriptor);
    for await (const chunk of fixture.chunks()) await sink.append(chunk);
    result.resolve(undefined);
    await settle();

    const done = await controller.read();
    expect(done.status).toBe("off");
    expect(done.tracks).toEqual([]);
    expect(done.episodes.at(-1)?.episode).toMatchObject({
      kind: "closed",
      bar: 2,
      reason: "completed",
    });
    expect(disarm).not.toHaveBeenCalled();
  });

  it("reports a pass that filled while playing as pass-limit, not a stop", async () => {
    const { controller, passes } = harness(8);
    const fixture = await createSyntheticMetricRecordStreamFixture({
      seconds: 12,
      requestedMetrics: ["mel-bands"],
    });
    await controller.arm(
      { listenerIds: [fixture.descriptor.ownership.listenerId] },
      context,
    );
    const { sink, launch, result } = passes[0]!;
    launch.resolve();
    await sink.begin(fixture.descriptor);
    for await (const chunk of fixture.chunks()) await sink.append(chunk);
    result.resolve(undefined);
    await settle();

    const reasons = (await controller.read()).episodes.flatMap(({ episode }) =>
      episode.kind === "uncertain" ? [episode.reason] : [],
    );
    expect(reasons).toEqual(["pass-limit"]);
  });

  it("is shared: the app arms, an agent adds a track, and both are reported", async () => {
    const { controller, passes, planned } = harness();
    const updates: string[] = [];
    controller.subscribe((update) => {
      if (update !== undefined)
        updates.push(`${update.listenerId}:${update.episode.kind}`);
    });
    await controller.arm({ listenerIds: ["L1"] }, appContext);
    const both = await controller.arm({ listenerIds: ["L2"] }, context);
    // Not playing yet: the first pass is disarmed and re-planned with both.
    expect(passes[0]!.disarm).toHaveBeenCalled();
    expect(planned.at(-1)).toEqual(["L1", "L2"]);
    expect(both.status).toBe("armed");
    expect(both.tracks.map(({ listenerId }) => listenerId)).toEqual([
      "L1",
      "L2",
    ]);

    const off = await controller.disarm(undefined, appContext);
    expect(off.status).toBe("off");
    expect(off.tracks).toEqual([]);
    expect(updates).toEqual(["L1:closed", "L2:closed"]);
  });

  it("arms a track while playing as pending until the next stop", async () => {
    const { controller, passes, planned } = harness();
    await controller.arm({ listenerIds: ["L1"] }, context);
    passes[0]!.launch.resolve();
    await settle();
    const pending = await controller.arm({ listenerIds: ["L2"] }, appContext);
    expect(passes[0]!.disarm).not.toHaveBeenCalled();
    expect(
      pending.tracks.find(({ listenerId }) => listenerId === "L2"),
    ).toMatchObject({ pending: true });
    passes[0]!.result.reject(new Error("metric_source_transport_stopped"));
    await settle();
    expect(planned.at(-1)).toEqual(["L1", "L2"]);
    expect(controller.snapshot().tracks.every(({ pending }) => !pending)).toBe(
      true,
    );
  });

  it("waits instead of failing when Live is playing at arm time", async () => {
    const { controller, plans } = harness();
    plans.push("playing", "playing");
    const waiting = await controller.arm({ listenerIds: ["L1"] }, appContext);
    expect(waiting.status).toBe("waiting");
    await settle();
    expect(controller.snapshot().status).toBe("armed");
  });
});
