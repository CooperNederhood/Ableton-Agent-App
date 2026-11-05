import { describe, expect, it, vi } from "vitest";
import type { AudioObservation } from "@ableton-agent/protocol";
import { createSyntheticPartialMetricListeningObservation } from "@ableton-agent/protocol/testing";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { createListeningTools } from "@ableton-agent/tools";
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
  const enqueue = vi.fn<(event: TelemetryEventEnvelope) => void>();
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
    telemetry: { enqueue },
    ...overrides,
  });
  return { host, services, resolveOwner, stop, disarm, enqueue };
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
  it("preserves published partial metrics through public get, list and terminal cancellation", async () => {
    const f = fixture();
    vi.mocked(f.services.prepare).mockImplementation(
      async ({ passId, trace }) => {
        const observation = createSyntheticPartialMetricListeningObservation({
          endBeat: request.endBeat,
        });
        observation.ownership = { ...observation.ownership, ...trace, passId };
        return {
          observationContract: "independent-metric-timelines/v1",
          observations: Promise.resolve([observation]),
          disarm: f.disarm,
        };
      },
    );
    const accepted = await f.host.executeListeningOperation(request, context);
    if (accepted.action !== request.action)
      throw new Error("Unexpected action");
    const terminal = await f.host.waitForListeningPass(
      accepted.job.passId,
      context,
    );
    expect(terminal.stage).toBe("partial");
    for (const action of ["get-pass", "cancel"] as const) {
      const result = await f.host.executeListeningOperation(
        {
          action,
          passId: terminal.passId,
        },
        context,
      );
      if (result.action !== action) throw new Error("Unexpected action");
      expect(result.job).toMatchObject({
        stage: "partial",
        contextIds: [`entry-${terminal.passId}`],
        metricResults: terminal.metricResults,
      });
      expect(result.job.error).toBeUndefined();
    }
    const listed = await f.host.executeListeningOperation(
      { action: "list-passes", limit: 20 },
      context,
    );
    if (listed.action !== "list-passes") throw new Error("Unexpected action");
    expect(listed.jobs[0]!.stage).toBe("partial");
    expect(listed.jobs[0]!.metricResults).toEqual(terminal.metricResults);
    expect(f.disarm).toHaveBeenCalledTimes(1);
    await f.host.shutdown();
  });

  it("redacts inspection strings without turning uncommissioned readiness into a mismatch or starting a pass", async () => {
    const f = fixture({
      inspectListeners: async () => ({
        action: "inspect-listeners",
        truncated: false,
        listeners: [
          {
            listenerId: "listener",
            instanceId: "instance",
            trackReference: "track",
            deviceReference: "device",
            displayName: "password=inspection-private-secret",
            ready: false,
            limitations: [
              "native_per_pass_validation_required",
              "Bearer limitation-private-secret",
            ],
          },
        ],
      }),
    });
    const result = await f.host.executeListeningOperation(
      { action: "inspect-listeners" },
      context,
    );
    expect(result).toMatchObject({
      listeners: [
        {
          ready: false,
          limitations: [
            "native_per_pass_validation_required",
            "Bearer [REDACTED]",
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(f.services.prepare).not.toHaveBeenCalled();
    await f.host.shutdown();
  });

  it("records the exact input-schema value and bound before pass admission", async () => {
    const f = fixture();
    await expect(
      f.host.executeListeningOperation(
        {
          ...request,
          maximumDurationMs: 300_001,
        },
        context,
      ),
    ).rejects.toThrow();
    expect(f.enqueue.mock.lastCall?.[0].attributes.facts).toContainEqual({
      field: "issue.0.value",
      actual: { state: "observed", value: 300_001 },
      expected: { state: "observed", value: 300_000 },
      comparison: "at-most",
    });
    expect(f.enqueue.mock.lastCall?.[0].attributes).not.toHaveProperty(
      "passId",
    );
    expect(f.resolveOwner).not.toHaveBeenCalled();
    await f.host.shutdown();
  });

  it.each([
    "input-schema",
    "initiating-agent",
    "resolve-owner",
    "session-target",
    "inspect-listeners",
    "result-schema",
    "result-action",
  ] as const)(
    "attributes pre-pass %s rejection without logging rejected bodies",
    async (boundary) => {
      const overrides: {
        -readonly [
          Key in keyof ListeningHostOptions
        ]?: ListeningHostOptions[Key];
      } = {};
      if (boundary === "resolve-owner")
        overrides.resolveOwner = async () => {
          throw new Error("Owner unavailable");
        };
      if (boundary === "inspect-listeners")
        overrides.inspectListeners = async () => {
          throw new Error("Inspection unavailable");
        };
      if (boundary === "result-schema")
        overrides.inspectListeners = async () =>
          ({
            action: "inspect-listeners",
            rawAudio: "rejected-private-body",
          }) as never;
      if (boundary === "result-action")
        overrides.inspectListeners = async () =>
          ({ action: "list-passes", jobs: [] }) as never;
      const f = fixture(overrides);
      const input =
        boundary === "input-schema"
          ? { ...request, rawAudio: "rejected-private-body" }
          : boundary === "session-target"
            ? {
                action: "play-session-and-listen" as const,
                target: {
                  view: "session" as const,
                  track: {
                    kind: "regular" as const,
                    index: 0,
                    expectedName: "Track",
                    expectedReference: context.trace.traceId,
                  },
                  sceneIndex: 0,
                  expectedClipName: "Clip",
                  expectedClipReference: context.trace.correlationId,
                },
                listenerIds: ["listener"],
                maximumDurationMs: 1000,
              }
            : ["inspect-listeners", "result-schema", "result-action"].includes(
                  boundary,
                )
              ? { action: "inspect-listeners" as const }
              : request;
      await expect(
        f.host.executeListeningOperation(input, {
          ...context,
          ...(boundary === "initiating-agent"
            ? { actorKind: "application" as const }
            : {}),
        }),
      ).rejects.toThrow();
      expect(f.enqueue.mock.lastCall?.[0]).toMatchObject({
        name: "listening.attempt.failed",
        trace: { traceId: context.trace.traceId },
        attributes: {
          checkId: `application.host.${boundary}`,
          passIdState: "not-accepted",
        },
      });
      expect(JSON.stringify(f.enqueue.mock.calls)).not.toContain(
        "rejected-private-body",
      );
      expect(f.services.prepare).not.toHaveBeenCalled();
      await f.host.shutdown();
    },
  );

  it("carries bounded primary evidence through wait, get/list and the tool contract without owner leakage", async () => {
    const f = fixture();
    f.services.prepare = async ({ passId, trace }) => {
      throw Object.assign(new Error("Native preflight rejected"), {
        code: "stale_native_preflight",
        failureEvidence: {
          schema: "listening-failure/v1",
          code: "stale_native_preflight",
          phase: "preflight",
          component: "native-controller",
          checkId: "native.preflight.clock-coverage",
          summary: "password=host-private-secret",
          coverage: "complete",
          coverageReasons: [],
          facts: [
            {
              field: "acceptedClocks",
              actual: { state: "observed", value: 0 },
              expected: { state: "observed", value: 1 },
              comparison: "at-least",
              unit: "count",
            },
          ],
          reference: { passId, traceId: trace.traceId },
        },
      });
    };
    const accepted = await f.host.executeListeningOperation(request, context);
    if (accepted.action !== request.action)
      throw new Error("Unexpected action");
    const terminal = await f.host.waitForListeningPass(
      accepted.job.passId,
      context,
    );
    const get = await f.host.executeListeningOperation(
      { action: "get-pass", passId: accepted.job.passId },
      context,
    );
    const list = await f.host.executeListeningOperation(
      { action: "list-passes", limit: 20 },
      context,
    );
    expect(terminal).toMatchObject({
      stage: "failed",
      failureEvidence: {
        checkId: "native.preflight.clock-coverage",
        component: "native-controller",
        coverage: "complete",
      },
    });
    const expectedEvidence = {
      checkId: terminal.failureEvidence?.checkId,
      component: "native-controller",
      facts: terminal.failureEvidence?.facts,
      reference: terminal.failureEvidence?.reference,
      coverage: terminal.failureEvidence?.coverage,
    };
    expect(get).toMatchObject({ job: { failureEvidence: expectedEvidence } });
    expect(list).toMatchObject({
      jobs: [{ failureEvidence: expectedEvidence }],
    });
    const [tool] = createListeningTools({
      executeListeningOperation: (params) =>
        f.host.executeListeningOperation(params, context),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    const toolParams = {
      action: "get-pass" as const,
      passId: accepted.job.passId,
    };
    const toolResult = await tool.handler?.(toolParams, {
      sessionId: "sdk-session",
      toolCallId: "sdk-call",
      toolName: "ableton_listening",
      arguments: toolParams,
    });
    expect(toolResult).toMatchObject({
      job: { failureEvidence: expectedEvidence },
    });
    expect(JSON.stringify(toolResult)).not.toContain("host-private-secret");
    expect(JSON.stringify([terminal, get, list])).not.toContain(
      "host-private-secret",
    );
    expect(JSON.stringify([get, list])).not.toContain("live-set");
    expect(get).not.toHaveProperty("job.session");
    await f.host.shutdown();
  });

  it("records pre-pass host guards with original trace and no invented pass or raw parameters", async () => {
    const enqueue = vi.fn<(event: TelemetryEventEnvelope) => void>();
    const f = fixture({
      telemetry: { enqueue },
      resolveOwner: async () => ({ ...owner, agentId: "other-agent" }),
    });
    await expect(
      f.host.executeListeningOperation(request, context),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(enqueue.mock.lastCall?.[0]).toMatchObject({
      name: "listening.attempt.failed",
      trace: { traceId: context.trace.traceId },
      attributes: {
        checkId: "application.host.resolved-owner",
        passIdState: "not-accepted",
      },
    });
    expect(enqueue.mock.lastCall?.[0].attributes.facts).toContainEqual({
      field: "agentId",
      actual: { state: "observed", value: "other-agent" },
      expected: { state: "observed", value: context.agentId },
      comparison: "equal",
    });
    expect(enqueue.mock.lastCall?.[0].attributes).not.toHaveProperty("passId");
    expect(f.services.prepare).not.toHaveBeenCalled();
    await f.host.shutdown();
  });

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

  it("returns only the public terminal job and rejects corrupted IDs without revoking the real pass", async () => {
    const passId = "1b295ab8-5018-4ce6-8966-8e6b4caf0454";
    const f = fixture({ createId: () => passId });
    try {
      await complete(f);
      const terminal = await f.host.waitForListeningPass(passId, context);
      expect(terminal).toMatchObject({
        passId,
        stage: "completed",
        contextIds: [`entry-${passId}`],
      });
      expect(terminal).not.toHaveProperty("owner");
      expect(terminal).not.toHaveProperty("request");
      for (const wrongId of [
        "1b295ab8-5018-4ce6-8966-8e6b4CE4-6872-4ce6-8966-8e6b4CE4-6872",
        "1b295ab8-5018-4ce6-8966-8e6b4ce40454",
      ]) {
        await expect(
          f.host.executeListeningOperation(
            { action: "get-pass", passId: wrongId },
            context,
          ),
        ).rejects.toMatchObject({
          code: "permission_denied",
        });
        const failure = f.enqueue.mock.calls
          .map(([event]) => event)
          .filter((event) => event.name === "listening.attempt.failed")
          .at(-1);
        expect(failure?.attributes.facts).toContainEqual({
          field: "passExists",
          actual: { state: "observed", value: false },
          expected: { state: "observed", value: true },
          comparison: "equal",
        });
      }
      terminal.contextIds.length = 0;
      expect(
        await f.host.executeListeningOperation(
          { action: "get-pass", passId },
          context,
        ),
      ).toMatchObject({
        job: { stage: "completed", contextIds: [`entry-${passId}`] },
      });
      expect(f.services.startPlayback).toHaveBeenCalledOnce();
    } finally {
      await f.host.shutdown();
    }
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
