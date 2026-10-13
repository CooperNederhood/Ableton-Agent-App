import { describe, expect, it, vi } from "vitest";
import type { AudioObservation } from "@ableton-agent/protocol";
import {
  createListeningHost,
  type ListeningHostOptions,
} from "./listening-host.js";
import type { ListeningExecutionContext } from "./index.js";

const context: ListeningExecutionContext = {
  sessionId: "app-session",
  agentId: "agent",
  trace: {
    traceId: "00000000-0000-4000-8000-000000000001",
    correlationId: "00000000-0000-4000-8000-000000000002",
    causationId: "00000000-0000-4000-8000-000000000003",
  },
};
const owner = {
  sessionId: context.sessionId,
  agentId: context.agentId,
  liveSetId: "live-set",
};
const request = {
  action: "play-arrangement-and-listen" as const,
  listenerIds: ["listener"],
  startBeat: 0,
  endBeat: 8,
  maximumDurationMs: 1000,
};

function observation(passId: string): AudioObservation {
  return {
    schema: "audio-observation/v1",
    passId,
    listenerId: "listener",
    sampleRate: 48_000,
    startSample: 0,
    endSample: 192_000,
    startBeat: 0,
    endBeat: 8,
    complete: true,
    limitations: ["Synthetic tool-host fixture"],
    algorithm: {
      name: "synthetic",
      version: "1",
      windowSamples: 2048,
      hopSamples: 4800,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 6000 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
      timingUncertaintySamples: 64,
    },
    summaries: { peak: [0.5, 0.5], rmsDbfs: [-12, -12], centroidHz: 440 },
    samples: [],
    attacks: [],
    reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
  };
}

function fixture(overrides: Partial<ListeningHostOptions> = {}) {
  let id = 0;
  const stop = vi.fn(async () => {});
  const disarm = vi.fn(async () => {});
  const services: ListeningHostOptions["services"] = {
    inspect: vi.fn(async () => ({
      liveSetId: owner.liveSetId,
      isPlaying: false,
      isRecording: false,
      recordingStateKnown: true,
      identityVerified: true,
    })),
    reservePublication: vi.fn(async () => ({ release: async () => {} })),
    prepare: vi.fn(
      async ({
        passId,
      }: Parameters<ListeningHostOptions["services"]["prepare"]>[0]) => ({
        observations: Promise.resolve([observation(passId)]),
        disarm,
      }),
    ),
    startPlayback: vi.fn(async () => ({ isOwned: () => true, stop })),
    persist: vi.fn(
      async ({
        passId,
      }: Parameters<ListeningHostOptions["services"]["persist"]>[0]) => [
        `entry-${passId}`,
      ],
    ),
    validateObservations: vi.fn(),
  };
  const resolveOwner = vi.fn(async () => owner);
  const host = createListeningHost({
    services,
    resolveOwner,
    inspectListeners: async () => ({
      action: "inspect-listeners",
      listeners: [],
      truncated: false,
    }),
    resolveSessionTarget: async () => {
      throw new Error("Session target not configured for this fixture");
    },
    createId: () => `pass-${++id}`,
    ...overrides,
  });
  return { host, services, resolveOwner, stop, disarm };
}

async function complete(f: ReturnType<typeof fixture>) {
  const result = await f.host.executeListeningOperation(request, context);
  if (result.action !== request.action) throw new Error("Unexpected action");
  const completed = await f.host.waitForListeningPass(
    result.job.passId,
    context,
  );
  expect(completed.stage).toBe("completed");
  return result.job.passId;
}

describe("owned listening tool host", () => {
  it("rejects cancelled ownership resolution before starting any native job", async () => {
    const resolveOwner = vi.fn(() => new Promise<typeof owner>(() => {}));
    const f = fixture({ resolveOwner });
    const controller = new AbortController();
    const pending = f.host.executeListeningOperation(request, {
      ...context,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(resolveOwner).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.services.inspect).not.toHaveBeenCalled();
    expect(f.services.prepare).not.toHaveBeenCalled();
    await f.host.shutdown();
  });

  it("does not resolve or allocate for a pre-cancelled caller", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.host.executeListeningOperation(request, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.resolveOwner).not.toHaveBeenCalled();
    expect(f.services.inspect).not.toHaveBeenCalled();
    await f.host.shutdown();
  });

  it("forwards owned lifecycle snapshots without removing its query inventory", async () => {
    const onChange = vi.fn();
    const f = fixture({ onChange });
    const passId = await complete(f);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ passId, stage: "reserving-context" }),
    );
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ passId, stage: "completed" }),
    );
    expect(
      await f.host.executeListeningOperation(
        { action: "get-pass", passId },
        context,
      ),
    ).toMatchObject({
      action: "get-pass",
      job: { passId, stage: "completed" },
    });
    await f.host.shutdown();
  });

  it("publishes a typed job and retains trace/owner across deferred stages", async () => {
    const f = fixture();
    const passId = await complete(f);
    expect(f.services.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "arrangement" }),
      expect.any(AbortSignal),
      expect.objectContaining({ passId, owner, trace: context.trace }),
    );
    expect(f.services.startPlayback).toHaveBeenCalledWith(
      expect.objectContaining({ passId, owner, trace: context.trace }),
    );
    expect(f.services.persist).toHaveBeenCalledWith(
      expect.objectContaining({ passId, owner, trace: context.trace }),
    );
    const result = await f.host.executeListeningOperation(
      { action: "get-pass", passId },
      context,
    );
    expect(result).toMatchObject({
      action: "get-pass",
      job: { stage: "completed", contextIds: [`entry-${passId}`] },
    });
    expect(JSON.stringify(result)).not.toContain("live-set");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    await f.host.shutdown();
  });

  it("denies reads, waits and cancellation from other sessions or agents", async () => {
    const f = fixture();
    const passId = await complete(f);
    for (const other of [
      { ...context, sessionId: "other-session" },
      { ...context, agentId: "other-agent" },
    ]) {
      await expect(
        f.host.executeListeningOperation({ action: "get-pass", passId }, other),
      ).rejects.toThrow("invoking App session");
      await expect(
        f.host.executeListeningOperation({ action: "cancel", passId }, other),
      ).rejects.toThrow("invoking App session");
      await expect(f.host.waitForListeningPass(passId, other)).rejects.toThrow(
        "invoking App session",
      );
      expect(
        await f.host.executeListeningOperation(
          { action: "list-passes", limit: 20 },
          other,
        ),
      ).toEqual({ action: "list-passes", jobs: [] });
    }
    await f.host.shutdown();
  });

  it("rejects an incorrectly resolved owner before playback", async () => {
    const f = fixture({
      resolveOwner: async () => ({
        ...owner,
        sessionId: "selected-ui-session",
      }),
    });
    await expect(
      f.host.executeListeningOperation(request, context),
    ).rejects.toThrow("invoking session");
    expect(f.services.inspect).not.toHaveBeenCalled();
    await f.host.shutdown();
  });

  it("paginates bounded jobs with owner-scoped, expiring opaque cursors", async () => {
    const f = fixture();
    await complete(f);
    const second = await complete(f);
    const firstPage = await f.host.executeListeningOperation(
      { action: "list-passes", limit: 1 },
      context,
    );
    if (firstPage.action !== "list-passes" || !firstPage.nextCursor) {
      throw new Error("Expected cursor");
    }
    expect(firstPage.jobs[0]?.passId).toBe(second);
    const next = await f.host.executeListeningOperation(
      { action: "list-passes", limit: 1, cursor: firstPage.nextCursor },
      context,
    );
    expect(next).toMatchObject({
      action: "list-passes",
      jobs: [{ passId: "pass-1" }],
    });
    await expect(
      f.host.executeListeningOperation(
        { action: "list-passes", limit: 1, cursor: firstPage.nextCursor },
        { ...context, agentId: "other" },
      ),
    ).rejects.toThrow("another session or agent");
    await expect(
      f.host.executeListeningOperation(
        { action: "list-passes", limit: 1, cursor: "not-json" },
        context,
      ),
    ).rejects.toThrow("Invalid listening cursor");
    for (let index = 0; index < 100; index += 1) await complete(f);
    await expect(
      f.host.executeListeningOperation(
        { action: "list-passes", limit: 1, cursor: firstPage.nextCursor },
        context,
      ),
    ).rejects.toThrow("expired");
    await f.host.shutdown();
  });

  it("keeps historical job ownership when the same App session is rehomed", async () => {
    const f = fixture();
    const passId = await complete(f);
    f.resolveOwner.mockResolvedValue({ ...owner, liveSetId: "saved-set" });
    expect(
      await f.host.executeListeningOperation(
        { action: "get-pass", passId },
        context,
      ),
    ).toMatchObject({ job: { passId, stage: "completed" } });
    await f.host.shutdown();
  });

  it("exposes explicit failures and cleans up cancellation and shutdown", async () => {
    const f = fixture();
    vi.mocked(f.services.prepare).mockImplementation(async () => ({
      observations: new Promise<readonly AudioObservation[]>(() => {}),
      disarm: f.disarm,
    }));
    const result = await f.host.executeListeningOperation(request, context);
    if (result.action !== request.action) throw new Error("Unexpected action");
    const cancelled = await f.host.executeListeningOperation(
      { action: "cancel", passId: result.job.passId },
      context,
    );
    expect(cancelled).toMatchObject({ job: { stage: "cancelled" } });
    const next = await f.host.executeListeningOperation(request, context);
    if (next.action !== request.action) throw new Error("Unexpected action");
    await f.host.shutdown();
    expect(
      await f.host.waitForListeningPass(next.job.passId, context),
    ).toMatchObject({ stage: "cancelled" });
    await expect(
      f.host.executeListeningOperation(request, context),
    ).rejects.toThrow("shut down");
  });
});
