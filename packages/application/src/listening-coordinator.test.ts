import { afterEach, describe, expect, it, vi } from "vitest";
import {
  audioObservationSchema,
  type AudioObservation,
} from "@ableton-agent/protocol";
import { telemetryEventEnvelopeSchema } from "@ableton-agent/observability";

import {
  ListeningCoordinator,
  listeningLimits,
  type ListeningCoordinatorOptions,
  type ListeningCoordinatorServices,
  type ListeningRequest,
  type ListeningJob,
} from "./listening-coordinator.js";

const owner = {
  sessionId: "app-session",
  liveSetId: "live-set",
  agentId: "agent",
};
const trace = {
  traceId: "00000000-0000-4000-8000-000000000001",
  correlationId: "00000000-0000-4000-8000-000000000002",
  causationId: "00000000-0000-4000-8000-000000000003",
};
const request: ListeningRequest = {
  mode: "arrangement",
  listenerIds: ["listener"],
  startBeat: 0,
  endBeat: 16,
  maximumDurationMs: 1000,
};

function observation(
  passId: string,
  listenerId = "listener",
): AudioObservation {
  const sample = (index: number) => ({
    sample: index * 48_000,
    beat: index * 2,
    peak: [0.5, 0.25],
    rmsDbfs: [-12, -18],
    centroidHz: 1000,
  });
  return audioObservationSchema.parse({
    schema: "audio-observation/v1",
    listenerId,
    passId,
    sampleRate: 48_000,
    startSample: 0,
    endSample: 384_000,
    startBeat: 0,
    endBeat: 16,
    complete: true,
    limitations: ["Synthetic coordinator fixture; not real-device validation"],
    algorithm: {
      name: "synthetic-test",
      version: "fixture-v1",
      windowSamples: 48_000,
      hopSamples: 48_000,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 480 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 0,
    },
    summaries: { peak: [0.5, 0.25], rmsDbfs: [-12, -18], centroidHz: 1000 },
    samples: Array.from({ length: 8 }, (_, index) => sample(index)),
    attacks: [],
    reduction: { originalSamples: 8, originalAttacks: 0, truncated: false },
  });
}

function fixture(
  overrides: Partial<ListeningCoordinatorServices> = {},
  onChange?: ListeningCoordinatorOptions["onChange"],
) {
  let resolveCapture: (
    observations: readonly AudioObservation[],
  ) => void = () => {};
  const observations = new Promise<readonly AudioObservation[]>((resolve) => {
    resolveCapture = resolve;
  });
  const stop = vi.fn(async () => {});
  const disarm = vi.fn(async () => {});
  const releaseReservation = vi.fn(async () => {});
  const services: ListeningCoordinatorServices = {
    inspect: vi.fn(async () => ({
      liveSetId: owner.liveSetId,
      isPlaying: false,
      isRecording: false,
      recordingStateKnown: true,
      identityVerified: true,
    })),
    reservePublication: vi.fn(async () => ({ release: releaseReservation })),
    prepare: vi.fn(async () => ({ observations, disarm })),
    startPlayback: vi.fn(async () => ({ isOwned: () => true, stop })),
    persist: vi.fn(async () => ["entry"]),
    validateObservations: vi.fn(),
    ...overrides,
  };
  const enqueue = vi.fn();
  const coordinator = new ListeningCoordinator({
    services,
    telemetry: { enqueue },
    ...(onChange === undefined ? {} : { onChange }),
  });
  return {
    coordinator,
    services,
    stop,
    disarm,
    releaseReservation,
    resolveCapture,
    enqueue,
  };
}

afterEach(() => vi.useRealTimers());

describe("headless listening coordinator", () => {
  it("retains redacted Session source and ordered launch details through terminal failure", async () => {
    const seen: ListeningJob[] = [];
    const f = fixture(
      {
        startPlayback: async ({ onSessionLaunch }) => {
          onSessionLaunch?.({
            state: "requested",
            mutationState: "indeterminate",
          });
          onSessionLaunch?.({
            state: "queued",
            mutationState: "indeterminate",
          });
          onSessionLaunch?.({
            state: "observed",
            mutationState: "observed-playing",
          });
          throw new Error("Source origin did not match native anchor");
        },
      },
      (job) => seen.push(job),
    );
    const job = f.coordinator.start(
      {
        mode: "session",
        listenerIds: ["listener"],
        clipReference: trace.traceId,
        trackReference: trace.correlationId,
        durationBeats: 4,
        maximumDurationMs: 1000,
        target: {
          view: "session",
          sceneIndex: 0,
          expectedClipReference: trace.traceId,
          expectedClipName: "Authorization: Bearer private-clip-token",
          track: {
            kind: "regular",
            index: 0,
            expectedReference: trace.correlationId,
            expectedName: "MIDI",
          },
        },
      },
      owner,
      trace,
    );
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.session?.launch).toEqual({
      state: "observed",
      mutationState: "observed-playing",
    });
    expect(JSON.stringify(result)).not.toContain("private-clip-token");
    expect(
      seen
        .filter((value) => value.stage === "starting-playback")
        .map((value) => value.session?.launch?.state),
    ).toEqual([undefined, "requested", "queued", "observed"]);
    expect(f.stop).not.toHaveBeenCalled();
    const launchEvents = f.enqueue.mock.calls
      .map(([event]) => telemetryEventEnvelopeSchema.parse(event))
      .filter((event) => event.attributes.stage === "starting-playback");
    expect(launchEvents).toHaveLength(4);
    expect(
      launchEvents.every(
        (event) =>
          event.trace?.traceId === trace.traceId &&
          event.causationId === trace.causationId,
      ),
    ).toBe(true);
  });

  it.each([
    "initial-inspection",
    "context-reservation",
    "listener-preparation",
    "post-arm-inspection",
    "playback-launch",
    "capture",
  ])(
    "bounds the entire Session pass from acceptance during %s",
    async (boundary) => {
      vi.useFakeTimers();
      const pending = () => new Promise<never>(() => {});
      let inspections = 0;
      const release = vi.fn(async () => {});
      const f = fixture();
      const inspect = f.services.inspect;
      f.services.inspect = async (...args) => {
        inspections++;
        if (
          (boundary === "initial-inspection" && inspections === 1) ||
          (boundary === "post-arm-inspection" && inspections === 2)
        )
          return pending();
        return inspect(...args);
      };
      if (boundary === "context-reservation")
        f.services.reservePublication = pending;
      if (boundary === "listener-preparation") f.services.prepare = pending;
      f.services.startPlayback =
        boundary === "playback-launch"
          ? pending
          : async () => ({ cleanupPolicy: "leave-running", release });
      const job = f.coordinator.start(
        {
          mode: "session",
          listenerIds: ["listener"],
          clipReference: "clip",
          trackReference: "track",
          durationBeats: 4,
          maximumDurationMs: 500,
        },
        owner,
        trace,
      );
      await vi.advanceTimersByTimeAsync(499);
      expect(f.coordinator.get(job.passId, owner).stage).not.toBe("failed");
      await vi.advanceTimersByTimeAsync(1);
      expect(f.coordinator.get(job.passId, owner).stage).toBe("failed");
      const result = await f.coordinator.wait(job.passId, owner);
      expect(result).toMatchObject({
        stage: "failed",
        durationMs: 500,
      });
      expect(result.error).toContain("including setup and launch");
      expect(f.services.persist).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(boundary === "capture" ? 1 : 0);
      await f.coordinator.shutdown();
    },
  );

  it("does not extend a Session budget when the wall clock moves backwards", async () => {
    vi.useFakeTimers();
    const f = fixture({ inspect: () => new Promise(() => {}) });
    const job = f.coordinator.start(
      {
        mode: "session",
        listenerIds: ["listener"],
        clipReference: "clip",
        trackReference: "track",
        durationBeats: 4,
        maximumDurationMs: 500,
      },
      owner,
      trace,
    );
    await vi.advanceTimersByTimeAsync(250);
    vi.setSystemTime(Date.now() - 86_400_000);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.coordinator.get(job.passId, owner).stage).toBe("failed");
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result).toMatchObject({
      stage: "failed",
      durationMs: 500,
    });
    expect(result.error).toContain("including setup and launch");
    await f.coordinator.shutdown();
  });

  it.each([
    { durationBeats: 4.01 },
    { durationBeats: 0 },
    { listenerIds: ["listener", "second-listener"] },
  ])("rejects Session MVP bounds before inspection: %j", (change) => {
    const f = fixture();
    expect(() =>
      f.coordinator.start(
        {
          mode: "session",
          listenerIds: ["listener"],
          clipReference: "clip",
          trackReference: "track",
          durationBeats: 4,
          maximumDurationMs: 500,
          ...change,
        },
        owner,
        trace,
      ),
    ).toThrow("at most four first-iteration beats");
    expect(f.services.inspect).not.toHaveBeenCalled();
  });

  it.each(["completed", "cancelled"] as const)(
    "releases monitors but leaves transport running when capture is %s",
    async (stage) => {
      const release = vi.fn(async () => {});
      const f = fixture({
        startPlayback: async () => ({
          cleanupPolicy: "leave-running",
          release,
        }),
      });
      const job = f.coordinator.start(request, owner, trace);
      await vi.waitFor(() =>
        expect(f.coordinator.get(job.passId, owner).stage).toBe("capturing"),
      );
      if (stage === "completed") f.resolveCapture([observation(job.passId)]);
      else await f.coordinator.cancel(job.passId, owner);
      expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
        stage,
        cleanupPolicy: "leave-running",
      });
      expect(release).toHaveBeenCalledOnce();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.disarm).toHaveBeenCalledOnce();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.services.persist).toHaveBeenCalledTimes(
        stage === "completed" ? 1 : 0,
      );
    },
  );

  it("surfaces leave-running monitor cleanup failure without stopping transport or publishing", async () => {
    const release = vi.fn(async () => {
      throw new Error("Monitor release failed");
    });
    const f = fixture({
      startPlayback: async () => ({ cleanupPolicy: "leave-running", release }),
    });
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.coordinator.get(job.passId, owner).stage).toBe("capturing"),
    );
    f.resolveCapture([observation(job.passId)]);
    expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
      stage: "failed",
      cleanupPolicy: "leave-running",
    });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.services.persist).not.toHaveBeenCalled();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it.each(["failure", "timeout", "shutdown"] as const)(
    "never checks ownership or stops leave-running transport during %s",
    async (reason) => {
      vi.useFakeTimers();
      const release = vi.fn(async () => {});
      const stop = vi.fn(async () => {});
      const isOwned = vi.fn(() => true);
      const f = fixture({
        startPlayback: async () => ({
          cleanupPolicy: "leave-running",
          release,
          stop,
          isOwned,
        }),
        validateObservations: () => {
          throw new Error("Source timing could not be verified");
        },
      });
      const job = f.coordinator.start(request, owner, trace);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.coordinator.get(job.passId, owner).stage).toBe("capturing");
      if (reason === "failure") {
        f.resolveCapture([observation(job.passId)]);
      } else if (reason === "timeout") {
        await vi.advanceTimersByTimeAsync(request.maximumDurationMs);
      } else {
        await f.coordinator.shutdown();
      }
      const result = await f.coordinator.wait(job.passId, owner);
      expect(result).toMatchObject({
        stage: reason === "shutdown" ? "cancelled" : "failed",
        cleanupPolicy: "leave-running",
        contextIds: [],
      });
      expect(release).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(isOwned).not.toHaveBeenCalled();
      expect(f.disarm).toHaveBeenCalledOnce();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.services.persist).not.toHaveBeenCalled();
      const terminalEvent = telemetryEventEnvelopeSchema.parse(
        f.enqueue.mock.calls.at(-1)?.[0],
      );
      expect(terminalEvent).toMatchObject({
        name: `listening.${result.stage}`,
        sessionId: owner.sessionId,
        liveSetId: owner.liveSetId,
        trace: { traceId: trace.traceId },
        correlationId: trace.correlationId,
        causationId: trace.causationId,
        attributes: { cleanupPolicy: "leave-running" },
      });
      expect(terminalEvent.durationMs).toBeGreaterThanOrEqual(0);
    },
  );

  it("rejects a pre-cancelled caller before inspection or allocation", () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      f.coordinator.start(request, owner, trace, controller.signal),
    ).toThrow();
    expect(f.coordinator.list(owner)).toHaveLength(0);
    expect(f.services.inspect).not.toHaveBeenCalled();
  });

  it("supports cancellation at the queued notification without returning a nonterminal receipt", async () => {
    let cancellation: Promise<unknown> | undefined;
    const f = fixture({}, (job) => {
      if (job.stage === "queued") {
        cancellation = f.coordinator.cancel(job.passId, owner);
      }
    });
    const job = f.coordinator.start(request, owner, trace);
    expect(await cancellation).toMatchObject({ stage: "cancelled" });
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe(
      "cancelled",
    );
    expect(f.services.inspect).not.toHaveBeenCalled();
  });

  it("links caller abort to owned playback, listener and quota cleanup", async () => {
    const f = fixture();
    const controller = new AbortController();
    const job = f.coordinator.start(request, owner, trace, controller.signal);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    controller.abort();
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe(
      "cancelled",
    );
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.services.persist).not.toHaveBeenCalled();
  });

  it("fails quota reservation before listener controls or playback", async () => {
    const f = fixture({
      reservePublication: vi.fn(async () => {
        throw new Error("Context quota exhausted");
      }),
    });
    const job = f.coordinator.start(request, owner, trace);
    expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
      stage: "failed",
      error: "Context quota exhausted",
    });
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.services.startPlayback).not.toHaveBeenCalled();
    expect(f.services.persist).not.toHaveBeenCalled();
  });

  it("retains quota through publication and releases it after terminal cleanup", async () => {
    const f = fixture();
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    expect(f.releaseReservation).not.toHaveBeenCalled();
    f.resolveCapture([observation(job.passId)]);
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe(
      "completed",
    );
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(
      vi.mocked(f.services.reservePublication).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(f.services.prepare).mock.invocationCallOrder[0]!);
    expect(f.releaseReservation.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(f.services.persist).mock.invocationCallOrder[0]!,
    );
  });

  it("releases quota when listener readiness fails and surfaces release errors", async () => {
    const f = fixture({
      prepare: vi.fn(async () => {
        throw new Error("Listener unavailable");
      }),
    });
    f.releaseReservation.mockRejectedValueOnce(
      new Error("Release unavailable"),
    );
    const job = f.coordinator.start(request, owner, trace);
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("Context quota release failed");
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.services.startPlayback).not.toHaveBeenCalled();
  });

  it.each([
    { isPlaying: true },
    { isRecording: true },
    { recordingStateKnown: false },
    { identityVerified: false },
    { liveSetId: "other-set" },
  ])("fails safely before arming or playback for %j", async (patch) => {
    const f = fixture({
      inspect: async () => ({
        liveSetId: owner.liveSetId,
        isPlaying: false,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
        ...patch,
      }),
    });
    const job = f.coordinator.start(request, owner, trace);
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe("failed");
    expect(f.services.prepare).not.toHaveBeenCalled();
    expect(f.services.startPlayback).not.toHaveBeenCalled();
  });

  it("rejects duplicate listeners, unbounded duration, and reversed ranges", () => {
    const f = fixture();
    expect(() =>
      f.coordinator.start(
        {
          ...request,
          listenerIds: ["tap", "tap"],
        },
        owner,
        trace,
      ),
    ).toThrow("distinct");
    expect(() =>
      f.coordinator.start(
        {
          ...request,
          maximumDurationMs: 300_001,
        },
        owner,
        trace,
      ),
    ).toThrow("300 seconds");
    expect(() =>
      f.coordinator.start(
        {
          ...request,
          startBeat: 17,
        },
        owner,
        trace,
      ),
    ).toThrow("ordered");
    expect(f.services.inspect).not.toHaveBeenCalled();
  });

  it("rechecks transport after readiness and disarms without starting user playback", async () => {
    const f = fixture();
    vi.mocked(f.services.inspect)
      .mockResolvedValueOnce({
        liveSetId: owner.liveSetId,
        isPlaying: false,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
      })
      .mockResolvedValueOnce({
        liveSetId: owner.liveSetId,
        isPlaying: true,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
      });
    const job = f.coordinator.start(request, owner, trace);
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe("failed");
    expect(f.services.inspect).toHaveBeenCalledTimes(2);
    expect(f.services.startPlayback).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.services.persist).not.toHaveBeenCalled();
  });

  it("observes an adapter rejection when cancellation races the arming transition", async () => {
    const f = fixture(
      {
        prepare: vi.fn(() =>
          Promise.reject(new Error("Adapter observed abort")),
        ),
      },
      (job) => {
        if (job.stage === "arming")
          void f.coordinator.cancel(job.passId, owner);
      },
    );
    const job = f.coordinator.start(request, owner, trace);
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe(
      "cancelled",
    );
    expect(f.services.prepare).toHaveBeenCalledOnce();
    expect(f.services.startPlayback).not.toHaveBeenCalled();
  });

  it("serializes listening and rejects cross-session/agent job access", async () => {
    const f = fixture();
    const job = f.coordinator.start(request, owner, trace);
    expect(() => f.coordinator.start(request, owner, trace)).toThrow("active");
    expect(() =>
      f.coordinator.get(job.passId, { ...owner, sessionId: "another" }),
    ).toThrow("belongs");
    expect(f.coordinator.list({ ...owner, agentId: "another" })).toEqual([]);
    await expect(
      f.coordinator.cancel(job.passId, { ...owner, agentId: "another" }),
    ).rejects.toThrow("belongs");
    await f.coordinator.cancel(job.passId, owner);
    expect(f.coordinator.get(job.passId, owner).stage).toBe("cancelled");
    await f.coordinator.shutdown();
  });

  it("does not start playback until readiness and cancellation disarms prepared listeners", async () => {
    const f = fixture();
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    const result = await f.coordinator.cancel(job.passId, owner);
    expect(result.stage).toBe("cancelled");
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.services.persist).not.toHaveBeenCalled();
    const events = f.enqueue.mock.calls.map(([event]) =>
      telemetryEventEnvelopeSchema.parse(event),
    );
    expect(events.map((event) => event.name)).toEqual([
      "listening.queued",
      "listening.started",
      "listening.progress",
      "listening.progress",
      "listening.progress",
      "listening.progress",
      "listening.progress",
      "listening.cancelled",
    ]);
    expect(
      events
        .filter((event) => event.attributes.readinessBoundary !== undefined)
        .map((event) => event.attributes.readinessBoundary),
    ).toEqual([
      "initial-inspection",
      "context-reservation",
      "listener-preparation",
      "post-arm-inspection",
    ]);
    expect(events.map((event) => event.attributes.stage)).toContain(
      "reserving-context",
    );
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(
      events.every(
        (event) =>
          event.trace?.traceId === trace.traceId &&
          event.correlationId === trace.correlationId &&
          event.causationId === trace.causationId &&
          event.sessionId === owner.sessionId &&
          event.liveSetId === owner.liveSetId,
      ),
    ).toBe(true);
    expect(events.every((event) => (event.durationMs ?? -1) >= 0)).toBe(true);
  });

  it("verifies and cleans up before atomically publishing completed context", async () => {
    const f = fixture();
    const order: string[] = [];
    f.stop.mockImplementation(async () => {
      order.push("stop");
    });
    f.disarm.mockImplementation(async () => {
      order.push("disarm");
    });
    vi.mocked(f.services.validateObservations).mockImplementation(() => {
      order.push("verify");
    });
    vi.mocked(f.services.persist).mockImplementation(async () => {
      order.push("persist");
      return ["entry"];
    });
    const job = f.coordinator.start(
      { ...request, maximumDurationMs: 10_000 },
      owner,
      trace,
    );
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    const measured = observation(job.passId);
    f.resolveCapture([measured]);
    expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
      stage: "completed",
      contextIds: ["entry"],
    });
    expect(order).toEqual(["verify", "stop", "disarm", "persist"]);
    expect(vi.mocked(f.services.persist).mock.lastCall?.[0]).toMatchObject({
      passId: job.passId,
      owner,
      trace,
      observations: [measured],
    });
    expect(
      telemetryEventEnvelopeSchema.parse(f.enqueue.mock.lastCall?.[0]).name,
    ).toBe("listening.completed");
  });

  it("keeps before/after listeners separate in a single atomic publication", async () => {
    const f = fixture({
      persist: vi.fn(async () => ["before-entry", "after-entry"]),
    });
    const job = f.coordinator.start(
      {
        ...request,
        maximumDurationMs: 10_000,
        listenerIds: ["before", "after"],
      },
      owner,
      trace,
    );
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    f.resolveCapture([
      observation(job.passId, "before"),
      observation(job.passId, "after"),
    ]);
    expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
      stage: "completed",
      contextIds: ["before-entry", "after-entry"],
    });
    expect(f.services.persist).toHaveBeenCalledOnce();
  });

  it.each(["missing", "duplicate", "wrong-pass", "partial"] as const)(
    "rejects %s multi-listener evidence without publication",
    async (failure) => {
      const f = fixture();
      const job = f.coordinator.start(
        {
          ...request,
          listenerIds: ["before", "after"],
        },
        owner,
        trace,
      );
      await vi.waitFor(() =>
        expect(f.services.startPlayback).toHaveBeenCalledOnce(),
      );
      const before = observation(job.passId, "before");
      const after = observation(
        failure === "wrong-pass" ? "other-pass" : job.passId,
        "after",
      );
      f.resolveCapture(
        failure === "missing"
          ? [before]
          : [
              before,
              failure === "duplicate"
                ? before
                : { ...after, complete: failure !== "partial" },
            ],
      );
      expect((await f.coordinator.wait(job.passId, owner)).stage).toBe(
        "failed",
      );
      expect(f.services.persist).not.toHaveBeenCalled();
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.disarm).toHaveBeenCalledOnce();
    },
  );

  it("rejects zero-coverage observations even when their complete flag is set", async () => {
    const f = fixture();
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    f.resolveCapture([
      audioObservationSchema.parse({
        ...observation(job.passId),
        endSample: 0,
        endBeat: 0,
        samples: [],
        reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
      }),
    ]);
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe("failed");
    expect(f.services.persist).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
  });

  it("surfaces atomic persistence failure without claiming published context", async () => {
    const f = fixture({
      persist: vi.fn(async () => {
        throw new Error("Context quota exceeded");
      }),
    });
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    f.resolveCapture([observation(job.passId)]);
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.contextIds).toEqual([]);
    expect(result.error).toContain("quota exceeded");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
  });

  it.each(["cancellation", "timeout"] as const)(
    "bounds an unresponsive publication on %s and exposes indeterminate commit state",
    async (failure) => {
      vi.useFakeTimers();
      const f = fixture({
        persist: vi.fn(() => new Promise<readonly string[]>(() => {})),
      });
      const job = f.coordinator.start(request, owner, trace);
      f.resolveCapture([observation(job.passId)]);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.coordinator.get(job.passId, owner).stage).toBe("persisting");
      const finished =
        failure === "cancellation"
          ? f.coordinator.cancel(job.passId, owner)
          : f.coordinator.wait(job.passId, owner);
      await vi.advanceTimersByTimeAsync(
        failure === "timeout" ? request.maximumDurationMs : 0,
      );
      const result = await finished;
      expect(result.stage).toBe("failed");
      expect(result.contextIds).toEqual([]);
      expect(result.error).toContain("may have committed");
      expect(result.error).toContain(job.passId);
      expect(f.stop).toHaveBeenCalledOnce();
      expect(f.disarm).toHaveBeenCalledOnce();
      await f.coordinator.shutdown();
    },
  );

  it("rejects duplicate publication receipts without returning misleading context IDs", async () => {
    const f = fixture({
      persist: vi.fn(async () => ["same-entry", "same-entry"]),
    });
    const job = f.coordinator.start(
      {
        ...request,
        listenerIds: ["before", "after"],
      },
      owner,
      trace,
    );
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    f.resolveCapture([
      observation(job.passId, "before"),
      observation(job.passId, "after"),
    ]);
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.contextIds).toEqual([]);
    expect(result.error).toContain("every listener observation");
  });

  it("interrupts complete observations after takeover rather than stopping user playback", async () => {
    const stop = vi.fn(async () => {});
    const f = fixture({
      startPlayback: async () => ({ isOwned: () => false, stop }),
    });
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.coordinator.get(job.passId, owner).stage).toBe("capturing"),
    );
    f.resolveCapture([observation(job.passId)]);
    expect((await f.coordinator.wait(job.passId, owner)).stage).toBe(
      "interrupted",
    );
    expect(stop).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.services.persist).not.toHaveBeenCalled();
  });

  it("fails an incomplete capture without persisting and performs cleanup", async () => {
    const f = fixture();
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    f.resolveCapture([]);
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result).toMatchObject({
      stage: "failed",
      contextIds: [],
    });
    expect(result.error).toContain("complete observation");
    expect(f.services.persist).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("surfaces and redacts cleanup errors rather than claiming cancellation succeeded", async () => {
    const f = fixture();
    f.disarm.mockRejectedValue(
      new Error("Authorization: Bearer secret-credential"),
    );
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    const result = await f.coordinator.cancel(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("disarm failed");
    expect(result.error).not.toContain("secret-credential");
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("surfaces unavailable ownership during cleanup without stopping unrelated playback or wedging jobs", async () => {
    const stop = vi.fn(async () => {});
    const f = fixture({
      startPlayback: async () => ({
        isOwned: () => {
          throw new Error("Ownership unavailable");
        },
        stop,
      }),
    });
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.coordinator.get(job.passId, owner).stage).toBe("capturing"),
    );
    const result = await f.coordinator.cancel(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("Ownership unavailable");
    expect(stop).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    const next = f.coordinator.start(request, owner, trace);
    await f.coordinator.cancel(next.passId, owner);
    await f.coordinator.shutdown();
  });

  it("bounds readiness even when the transport adapter never resolves", async () => {
    vi.useFakeTimers();
    const f = fixture({
      prepare: () => new Promise(() => {}),
    });
    const job = f.coordinator.start(request, owner, trace);
    await vi.advanceTimersByTimeAsync(listeningLimits.readinessTimeoutMs);
    const result = await f.coordinator.wait(job.passId, owner);
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("readiness timed out");
    expect(f.services.startPlayback).not.toHaveBeenCalled();
  });

  it("does not let preflight consume the independent preparation and post-arm verification budget", async () => {
    vi.useFakeTimers();
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const f = fixture();
    const inspect = f.services.inspect;
    let reads = 0;
    f.services.inspect = async (...args) => {
      await delay(++reads === 1 ? 2500 : 2000);
      return inspect(...args);
    };
    f.services.reservePublication = async () => {
      await delay(500);
      return { release: f.releaseReservation };
    };
    f.services.prepare = async ({ passId }) => {
      await delay(6500);
      return {
        observations: Promise.resolve([observation(passId)]),
        disarm: f.disarm,
      };
    };
    const job = f.coordinator.start(request, owner, trace);
    await vi.advanceTimersByTimeAsync(11_500);
    expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
      stage: "completed",
      contextIds: ["entry"],
      durationMs: 11_500,
    });
    expect(f.services.startPlayback).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("bounds preparation and post-arm verification together and identifies the stalled boundary", async () => {
    vi.useFakeTimers();
    const delay = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const f = fixture();
    const inspect = f.services.inspect;
    let reads = 0;
    f.services.inspect = async (...args) => {
      if (++reads === 1) {
        await delay(3000);
        return inspect(...args);
      }
      return new Promise(() => {});
    };
    f.services.prepare = async () => {
      await delay(6500);
      return { observations: new Promise(() => {}), disarm: f.disarm };
    };
    const job = f.coordinator.start(request, owner, trace);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
      stage: "failed",
      contextIds: [],
      error: "Listener readiness timed out during post-arm-inspection",
      durationMs: 13_000,
    });
    expect(f.services.startPlayback).not.toHaveBeenCalled();
    expect(f.services.persist).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    const terminal = telemetryEventEnvelopeSchema.parse(
      f.enqueue.mock.calls.at(-1)?.[0],
    );
    expect(terminal).toMatchObject({
      name: "listening.failed",
      durationMs: 13_000,
      sessionId: owner.sessionId,
      liveSetId: owner.liveSetId,
      trace: { traceId: trace.traceId },
      correlationId: trace.correlationId,
      causationId: trace.causationId,
      attributes: { readinessBoundary: "post-arm-inspection" },
    });
  });

  it.each([
    "initial-inspection",
    "context-reservation",
    "listener-preparation",
  ] as const)(
    "bounds a stalled %s and releases only acquired resources",
    async (boundary) => {
      vi.useFakeTimers();
      const f = fixture();
      if (boundary === "initial-inspection")
        f.services.inspect = () => new Promise(() => {});
      else if (boundary === "context-reservation")
        f.services.reservePublication = () => new Promise(() => {});
      else f.services.prepare = () => new Promise(() => {});
      const job = f.coordinator.start(request, owner, trace);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await f.coordinator.wait(job.passId, owner)).toMatchObject({
        stage: "failed",
        contextIds: [],
        error: `Listener readiness timed out during ${boundary}`,
        durationMs: 10_000,
      });
      expect(f.services.startPlayback).not.toHaveBeenCalled();
      expect(f.services.persist).not.toHaveBeenCalled();
      expect(f.disarm).not.toHaveBeenCalled();
      expect(f.releaseReservation).toHaveBeenCalledTimes(
        boundary === "listener-preparation" ? 1 : 0,
      );
      expect(f.enqueue.mock.calls.at(-1)?.[0]).toMatchObject({
        name: "listening.failed",
        attributes: { readinessBoundary: boundary },
      });
    },
  );

  it("cancels during post-arm inspection without playback and permits a later explicit pass", async () => {
    const f = fixture();
    const inspect = vi.mocked(f.services.inspect);
    inspect
      .mockImplementationOnce(async () => ({
        liveSetId: owner.liveSetId,
        isPlaying: false,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
        listenersReady: true,
        expectedCaptureMs: 100,
      }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(await f.coordinator.cancel(job.passId, owner)).toMatchObject({
      stage: "cancelled",
      contextIds: [],
    });
    expect(f.services.startPlayback).not.toHaveBeenCalled();
    expect(f.services.persist).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.enqueue.mock.calls.at(-1)?.[0]).toMatchObject({
      name: "listening.cancelled",
      attributes: { readinessBoundary: "post-arm-inspection" },
    });
    const next = f.coordinator.start(request, owner, trace);
    f.resolveCapture([observation(next.passId)]);
    expect(await f.coordinator.wait(next.passId, owner)).toMatchObject({
      stage: "completed",
      contextIds: ["entry"],
    });
    expect(f.services.startPlayback).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledTimes(2);
    expect(f.releaseReservation).toHaveBeenCalledTimes(2);
  });

  it.each(["inspection", "capture"] as const)(
    "bounds an unresponsive %s stage without publishing context",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture(
        stage === "inspection"
          ? {
              inspect: () => new Promise(() => {}),
            }
          : {},
      );
      const job = f.coordinator.start(request, owner, trace);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(
        stage === "inspection"
          ? listeningLimits.readinessTimeoutMs
          : request.maximumDurationMs,
      );
      const result = await f.coordinator.wait(job.passId, owner);
      expect(result.stage).toBe("failed");
      expect(result.error).toContain(
        stage === "inspection" ? "readiness timed out" : "exceeded its budget",
      );
      expect(f.services.persist).not.toHaveBeenCalled();
      expect(f.stop).toHaveBeenCalledTimes(stage === "capture" ? 1 : 0);
    },
  );

  it("bounds cleanup and reports failure when a listener never disarms", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.disarm.mockImplementation(() => new Promise(() => {}));
    const job = f.coordinator.start(request, owner, trace);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.services.startPlayback).toHaveBeenCalledOnce();
    const cancelled = f.coordinator.cancel(job.passId, owner);
    await vi.advanceTimersByTimeAsync(listeningLimits.cleanupTimeoutMs);
    const result = await cancelled;
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("cleanup timed out");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.services.persist).not.toHaveBeenCalled();
  });

  it("never stops playback after the user takes ownership", async () => {
    const stop = vi.fn(async () => {});
    const f = fixture({
      startPlayback: async () => ({ isOwned: () => false, stop }),
    });
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.coordinator.get(job.passId, owner).stage).toBe("capturing"),
    );
    await f.coordinator.cancel(job.passId, owner);
    expect(stop).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.services.persist).not.toHaveBeenCalled();
  });

  it("shutdown cancels work before closing and never reuses the coordinator", async () => {
    const f = fixture();
    const job = f.coordinator.start(request, owner, trace);
    await vi.waitFor(() =>
      expect(f.services.startPlayback).toHaveBeenCalledOnce(),
    );
    await f.coordinator.shutdown();
    expect(f.coordinator.get(job.passId, owner).stage).toBe("cancelled");
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(() => f.coordinator.start(request, owner, trace)).toThrow(
      "shut down",
    );
  });
});
