import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCorrelationContext } from "@ableton-agent/correlation";
import type {
  AudioObservation,
  InspectListeningContextParams,
  InspectListeningContextResult,
} from "@ableton-agent/protocol";
import type {
  ListenerDescriptor,
  ListenerService,
} from "@ableton-agent/signal-routing";
import type {
  ListeningExecutionContext,
  ListeningJob,
} from "@ableton-agent/application";
import type { ListeningRuntimeDependencies } from "./composition.js";
import {
  assembleListeningRuntimeHostForTests,
  createListeningRuntimeHost,
  type ConcreteListeningRuntimeHost,
  type ListeningRuntimeHostOptions,
  type ListeningRuntimeTestAdapter,
} from "./listening-runtime-host.js";
import type { PrepareListenerCaptureInput } from "./listening-capture.js";

type Repository = Awaited<
  ReturnType<ListeningRuntimeHostOptions["resolveRepository"]>
>;
type Publication = Parameters<Repository["appendPass"]>[0];
const uuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const owner = { sessionId: "session", agentId: "agent", liveSetId: "set" };
const context: ListeningExecutionContext = {
  sessionId: owner.sessionId,
  agentId: owner.agentId,
  trace: { traceId: uuid(1), correlationId: "listen", causationId: "caller" },
  actorKind: "agent",
};
const request = {
  action: "play-arrangement-and-listen" as const,
  listenerIds: ["listener-0"],
  startBeat: 0,
  endBeat: 4,
  maximumDurationMs: 5000,
};
const hosts: ConcreteListeningRuntimeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  vi.useRealTimers();
});

function descriptor(index = 0): ListenerDescriptor {
  return {
    connectionId: `connection-${index}`,
    producer: {
      producerId: `listener-${index}`,
      instanceId: `instance-${index}`,
      signalKind: "audio",
      schemaVersion: "audio-observation/v1",
      displayName: `Synthetic listener ${index}`,
      track: { id: String(500 + index) },
      device: { id: String(600 + index) },
    },
    binding: { trackId: String(500 + index), deviceId: String(600 + index) },
    registration: {
      version: 1,
      capabilities: ["audio-listener/v1"],
      connectionEpoch: `epoch-${index}`,
      algorithmVersion: "test-measured-1",
      sampleRate: 48000,
      deviceCanonicalPath: `live_set tracks ${index} devices 0`,
      trackCanonicalPath: `live_set tracks ${index}`,
      nativeStatus: { version: 1, timing: "VERIFIED", readiness: "READY" },
    },
    phase: "idle",
  };
}

function inspection(
  input: InspectListeningContextParams,
): InspectListeningContextResult {
  return {
    schemaVersion: 1,
    bindingScope: "live-connection",
    ...(input.bindingQueryId ? { bindingQueryId: input.bindingQueryId } : {}),
    projectRevision: 1,
    transport: {
      playing: false,
      currentBeat: 0,
      tempo: 120,
      recording: {
        recordMode: false,
        sessionRecord: false,
        arrangementOverdub: false,
        sessionAutomationRecord: false,
      },
      safeToStart: true,
    },
    listeners: input.listeners.map((selector) => {
      if (!("canonicalPath" in selector))
        throw new Error("Expected canonical selector");
      const index = Number(selector.canonicalPath.split(" ")[2]);
      const trackReference = uuid(10 + index),
        deviceReference = uuid(20 + index);
      return {
        binding: {
          track: {
            kind: "regular",
            index,
            expectedReference: trackReference,
            expectedName: `Track ${index}`,
          },
          deviceIndex: 0,
          expectedDeviceReference: deviceReference,
          expectedDeviceName: "Test listener",
          expectedClassName: "MxDeviceAudioEffect",
        },
        canonicalPath: selector.canonicalPath,
        pathAttestation: {
          schemaVersion: 1,
          source: "remote-script-lom",
          canonicalDevicePath: selector.canonicalPath,
          canonicalTrackPath: `live_set tracks ${index}`,
          trackReference,
          deviceReference,
          placement: { kind: "track-device", deviceIndex: 0 },
        },
        verified: true,
        enabled: true,
        sessionOverride: false,
        clips: [],
        clipsTruncated: false,
        trackEvidence: [],
        upstreamDevices: [],
        dependenciesTruncated: false,
        fingerprint: {
          algorithm: "sha256",
          scope: "available-live-fields/v1",
          digest: "a".repeat(64),
          completeness: "unknown",
          unknownReasons: ["routing-unmeasured"],
        },
        attribution: "nonexclusive",
        unknownReasons: ["routing-unmeasured"],
      };
    }),
  };
}

function observation(
  input: PrepareListenerCaptureInput,
  listenerId: string,
): AudioObservation {
  return {
    schema: "audio-observation/v1",
    listenerId,
    passId: input.passId,
    sampleRate: 48000,
    startSample: 0,
    endSample: 96000,
    startBeat: input.config.source.startBeat,
    endBeat: input.config.source.endBeat,
    complete: true,
    limitations: [
      "Explicitly synthetic certified test-owned capture; not production evidence",
    ],
    algorithm: {
      name: "test-owned-measured",
      version: "test-measured-1",
      windowSamples: 2048,
      hopSamples: 4800,
      timingUncertaintySamples: 64,
      settings: { attackThresholdDb: 6, minAttackSpacingSamples: 6000 },
      units: { amplitude: "linear", rms: "dBFS", centroid: "Hz" },
    },
    summaries: { peak: [0.5, 0.5], rmsDbfs: [-12, -12], centroidHz: 440 },
    samples: [],
    attacks: [],
    reduction: { originalSamples: 0, originalAttacks: 0, truncated: false },
  };
}

function fixture(count = 1) {
  const log: string[] = [];
  const inventory = Array.from({ length: count }, (_, index) =>
    descriptor(index),
  );
  const publications: Publication[] = [];
  const reservePass = vi.fn(async () => {
    log.push("reserve");
  });
  const releaseReservation = vi.fn(async () => {
    log.push("release-reservation");
  });
  const appendPass = vi.fn(async (publication: Publication) => {
    log.push("publish");
    publications.push(publication);
  });
  const repository = {
    sessionId: "session",
    liveSetId: "set",
    reservePass,
    releaseReservation,
    appendPass,
  } as unknown as Repository;
  const traces: unknown[] = [];
  const getLiveIdentity = vi.fn(async () => ({
    liveSetId: "set",
    liveSetName: "Set",
    saved: true,
    diagnostics: [],
  }));
  const inspectListeningContext = vi.fn(
    async (input: InspectListeningContextParams) => {
      traces.push(currentCorrelationContext());
      return inspection(input);
    },
  );
  const startListeningPlayback = vi.fn(async () => {
    throw new Error("Production playback must stay gated");
  });
  const service = {
    inspectListeners: () => inventory,
    requestListenerControl: vi.fn(async () => {
      throw new Error("Unexpected raw control");
    }),
    onListenerResult: vi.fn(() => {
      throw new Error("Unexpected raw subscription");
    }),
  } satisfies ListenerService;
  const events: unknown[] = [];
  const dependencies = {
    ableton: {
      getLiveIdentity,
      inspectListeningContext,
      startListeningPlayback,
    },
    signals: { listeners: service, listenerTransport: service },
    events: { publish: vi.fn(), subscribe: vi.fn(() => () => {}) },
    telemetry: {
      enqueue: vi.fn((event: unknown) => {
        events.push(event);
      }),
    },
  } as unknown as ListeningRuntimeDependencies;
  const jobs: ListeningJob[] = [];
  const options: ListeningRuntimeHostOptions = {
    resolveOwner: vi.fn(async () => owner),
    resolveRepository: vi.fn(async () => repository),
    onChange: (job) => {
      jobs.push(job);
    },
  };
  let prepared: PrepareListenerCaptureInput | undefined;
  let resolveObservations!: (observations: AudioObservation[]) => void;
  const result = new Promise<AudioObservation[]>((resolve) => {
    resolveObservations = resolve;
  });
  const disarm = vi.fn(async () => {
    log.push("disarm");
  });
  const release = vi.fn(async () => {
    log.push("release-playback");
  });
  const adapter: ListeningRuntimeTestAdapter = {
    provenance: "test-owned-certified-adapter",
    assertMeasuredReadiness: vi.fn(async () => {
      log.push("measured-readiness");
    }),
    prepare: vi.fn<ListeningRuntimeTestAdapter["prepare"]>(
      async (_service, input) => {
        expect(_service).toBe(service);
        log.push("prepare");
        prepared = input;
        return { jobId: uuid(100), passId: input.passId, result, disarm };
      },
    ),
    start: vi.fn<ListeningRuntimeTestAdapter["start"]>(async (params) => {
      log.push("start");
      resolveObservations(
        params.listeners.map((_, index) =>
          observation(prepared!, `listener-${index}`),
        ),
      );
      return {
        cleanupPolicy: "leave-running",
        sourceOnset: "measured",
        startedAtBeat: params.range.startBeat,
        release,
      };
    }),
  };
  const host = (production = false, override = options) => {
    const created = production
      ? createListeningRuntimeHost(dependencies, override)
      : assembleListeningRuntimeHostForTests(dependencies, override, adapter);
    hosts.push(created);
    return created;
  };
  return {
    host,
    dependencies,
    options,
    adapter,
    inventory,
    service,
    log,
    traces,
    events,
    jobs,
    repository,
    reservePass,
    releaseReservation,
    appendPass,
    publications,
    disarm,
    release,
    getLiveIdentity,
    inspectListeningContext,
    startListeningPlayback,
    prepared: () => prepared,
  };
}

async function run(
  host: ConcreteListeningRuntimeHost,
  input = request,
  caller = context,
) {
  const started = await host.executeListeningOperation(input, caller);
  if (!("job" in started)) throw new Error("Expected pass");
  return host.waitForListeningPass(started.job.passId, {
    sessionId: caller.sessionId,
    agentId: caller.agentId,
    trace: caller.trace,
  });
}

describe("same-runtime production listening factory", () => {
  it("production self-reported READY/VERIFIED is not commissioned evidence and dispatches nothing", async () => {
    const f = fixture();
    const result = await run(f.host(true));
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("real_live_timing_validation_required");
    expect(f.inspectListeningContext).toHaveBeenCalledOnce();
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
    expect(f.service.onListenerResult).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.adapter.prepare).not.toHaveBeenCalled();
  });

  it("production discovery joins exact canonical path to bridge UUIDs but remains unready", async () => {
    const f = fixture();
    Object.assign(f.inventory[0]!.registration, {
      nativeStatus: {
        version: 1,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
        reason: "real_live_timing_validation_required",
      },
    });
    const result = await f
      .host(true)
      .executeListeningOperation({ action: "inspect-listeners" }, context);
    if (result.action !== "inspect-listeners")
      throw new Error("Unexpected result");
    expect(result.listeners[0]).toMatchObject({
      listenerId: "listener-0",
      instanceId: "instance-0",
      trackReference: uuid(10),
      deviceReference: uuid(20),
      ready: false,
    });
    expect(result.listeners[0]!.trackReference).not.toBe("500");
    expect(result.listeners[0]!.limitations).toContain(
      "source_onset_unverified",
    );
  });

  it("certified test-owned assembly reserves 2MiB, prepares all, starts guarded Arrangement, publishes truthful unknown associations and leaves playback running", async () => {
    const f = fixture(2);
    const result = await run(f.host(), {
      ...request,
      listenerIds: ["listener-0", "listener-1"],
    });
    expect(result.stage).toBe("completed");
    expect(f.reservePass.mock.calls[0]).toMatchObject([
      result.passId,
      2 * 1024 * 1024,
      { trace: context.trace, activeAgentId: context.agentId },
    ]);
    expect(f.log.indexOf("reserve")).toBeLessThan(f.log.indexOf("prepare"));
    expect(f.log.indexOf("prepare")).toBeLessThan(f.log.indexOf("start"));
    expect(f.log.indexOf("publish")).toBeLessThan(
      f.log.indexOf("release-reservation"),
    );
    expect(f.prepared()).toMatchObject({
      passId: result.passId,
      trace: context.trace,
      config: {
        durationMs: 2000,
        maxWindows: 512,
        source: { mode: "arrangement", startBeat: 0, endBeat: 4 },
      },
    });
    expect(f.adapter.start).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedLiveSetId: "set",
        expectedProjectRevision: 1,
        passId: result.passId,
        mode: "arrangement",
        range: { startBeat: 0, endBeat: 4 },
      }),
      expect.any(AbortSignal),
    );
    expect(vi.mocked(f.adapter.start).mock.calls[0]![0].ownerId).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(f.publications[0]!.entries).toHaveLength(2);
    expect(
      f.publications[0]!.links.every(
        (link) =>
          link.attribution === "unknown" && link.freshness.status === "unknown",
      ),
    ).toBe(true);
    expect(
      f.publications[0]!.subjects.every(
        (item) => item.binding.dependencyScope === "unknown",
      ),
    ).toBe(true);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.jobs.at(-1)).toMatchObject({
      stage: "completed",
      cleanupPolicy: "leave-running",
    });
    expect(
      f.traces.every((trace) =>
        JSON.stringify(trace).includes(context.trace.traceId),
      ),
    ).toBe(true);
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
  });

  it("refuses blocked native status before reservation even with a certified test-owned adapter", async () => {
    const f = fixture();
    Object.assign(f.inventory[0]!.registration, {
      nativeStatus: {
        version: 1,
        timing: "UNVERIFIED",
        readiness: "BLOCKED",
        reason: "real_live_timing_validation_required",
      },
    });
    const result = await run(f.host());
    expect(result.error).toContain("real_live_timing_validation_required");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.adapter.prepare).not.toHaveBeenCalled();
    expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it("Session mode remains unsupported until measured quantized onset", async () => {
    const f = fixture();
    const host = f.host(true);
    await expect(
      host.executeListeningOperation(
        {
          action: "play-session-and-listen",
          target: {
            view: "session",
            track: {
              kind: "regular",
              index: 0,
              expectedReference: uuid(10),
              expectedName: "Track",
            },
            sceneIndex: 0,
            expectedClipReference: uuid(30),
            expectedClipName: "Clip",
          },
          listenerIds: ["listener-0"],
          durationBeats: 4,
          maximumDurationMs: 5000,
        },
        context,
      ),
    ).rejects.toThrow("session_quantized_onset_unverified");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it("caller isolation rejects owner/repository mismatch and hides foreign pass IDs", async () => {
    const f = fixture();
    const host = f.host();
    const result = await run(host);
    await expect(
      host.executeListeningOperation(
        { action: "get-pass", passId: result.passId },
        { ...context, agentId: "other" },
      ),
    ).rejects.toThrow("belongs");
    await expect(
      host.waitForListeningPass(result.passId, {
        ...context,
        sessionId: "other",
      }),
    ).rejects.toThrow("belongs");
    const wrongOwner = f.host(false, {
      ...f.options,
      resolveOwner: async () => ({ ...owner, agentId: "other" }),
    });
    await expect(
      wrongOwner.executeListeningOperation(request, context),
    ).rejects.toThrow("permission_denied");
    const wrongRepository = f.host(false, {
      ...f.options,
      resolveRepository: async () => ({ ...f.repository, liveSetId: "other" }),
    });
    const failed = await run(wrongRepository);
    expect(failed.stage).toBe("failed");
    expect(failed.error).toContain("permission_denied");
    expect(f.reservePass).toHaveBeenCalledOnce();
  });

  it.each(["native-range", "reservation"] as const)(
    "quota guard %s denies before controls and playback",
    async (failure) => {
      const f = fixture();
      if (failure === "reservation")
        f.reservePass.mockRejectedValue(new Error("context quota exhausted"));
      const result = await run(
        f.host(),
        failure === "native-range"
          ? { ...request, endBeat: 300, maximumDurationMs: 300000 }
          : request,
      );
      expect(result.stage).toBe("failed");
      expect(f.adapter.prepare).not.toHaveBeenCalled();
      expect(f.adapter.start).not.toHaveBeenCalled();
      expect(f.appendPass).not.toHaveBeenCalled();
    },
  );

  it("guarded start failure disarms, releases quota, publishes nothing and redacts errors", async () => {
    const f = fixture();
    vi.mocked(f.adapter.start).mockRejectedValue(
      new Error("guard failed token=super-secret-value"),
    );
    const result = await run(f.host());
    expect(result.stage).toBe("failed");
    expect(result.error).not.toContain("super-secret-value");
    expect(JSON.stringify(f.events)).not.toContain("super-secret-value");
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("unverified playback onset cannot produce positive publication", async () => {
    const f = fixture();
    vi.mocked(f.adapter.start).mockResolvedValue({
      cleanupPolicy: "leave-running",
      startedAtBeat: 0,
      sourceOnset: "unverified",
      release: f.release,
    });
    const result = await run(f.host());
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("source_onset_unverified");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("publication indeterminate never returns successful contexts or retries", async () => {
    const f = fixture();
    f.appendPass.mockRejectedValue(new Error("commit acknowledgement unknown"));
    const result = await run(f.host());
    expect(result.stage).not.toBe("completed");
    expect(result.error).toContain("acknowledgement unknown");
    expect(f.appendPass).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
  });

  it("aborted invocation dispatches no inspection, controls, quota or playback", async () => {
    const f = fixture();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      f.host().executeListeningOperation(request, { ...context, signal }),
    ).rejects.toThrow("cancelled");
    expect(f.inspectListeningContext).not.toHaveBeenCalled();
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.adapter.prepare).not.toHaveBeenCalled();
  });

  it("cancellation during capture releases monitors and reservation, never stops playback", async () => {
    const f = fixture();
    vi.mocked(f.adapter.start).mockResolvedValue({
      cleanupPolicy: "leave-running",
      startedAtBeat: 0,
      sourceOnset: "measured",
      release: f.release,
    });
    const host = f.host();
    const started = await host.executeListeningOperation(request, context);
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() => expect(f.adapter.start).toHaveBeenCalledOnce());
    const cancelled = await host.executeListeningOperation(
      { action: "cancel", passId: started.job.passId },
      context,
    );
    expect("job" in cancelled && cancelled.job.stage).toBe("cancelled");
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("canonical instance/epoch replacement after reservation prevents capture controls and releases quota", async () => {
    const f = fixture();
    f.reservePass.mockImplementation(async () => {
      f.inventory[0]!.registration.connectionEpoch = "replacement";
    });
    const result = await run(f.host());
    expect(result.error).toContain("listener_instance_changed");
    expect(f.adapter.prepare).not.toHaveBeenCalled();
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("fresh inspection nonce and path attestation are mandatory", async () => {
    const f = fixture();
    f.inspectListeningContext.mockImplementation(async (input) => ({
      ...inspection(input),
      bindingQueryId: uuid(999),
    }));
    const result = await run(f.host());
    expect(result.error).toContain("stale-inspection");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.adapter.prepare).not.toHaveBeenCalled();
  });

  it("combined context ports validate the caller and session inventory scope", async () => {
    const f = fixture();
    const inventory = vi.fn(async () => "typed inventory");
    const execute = vi.fn(async () => ({
      action: "list" as const,
      entries: [],
    }));
    const host = f.host(true, {
      ...f.options,
      contextPorts: {
        executeContextOperation: execute,
        getSessionContextInventory: inventory,
      },
    });
    expect(await host.getSessionContextInventory!("session", context)).toBe(
      "typed inventory",
    );
    await expect(
      host.getSessionContextInventory!("other", context),
    ).rejects.toThrow("permission_denied");
    expect(inventory).toHaveBeenCalledOnce();
    expect(
      await host.executeContextOperation!(
        { action: "list", includeHistorical: false, limit: 10 },
        context,
      ),
    ).toEqual({ action: "list", entries: [] });
    await host.shutdown();
    await expect(
      host.executeListeningOperation({ action: "inspect-listeners" }, context),
    ).rejects.toThrow("listening_host_closed");
  });

  it("late reservation completion after abort releases canonical quota without preparing", async () => {
    const f = fixture();
    let finish!: () => void;
    f.reservePass.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const host = f.host();
    const started = await host.executeListeningOperation(request, {
      ...context,
      signal: controller.signal,
    });
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() => expect(f.reservePass).toHaveBeenCalledOnce());
    controller.abort();
    expect(
      (await host.waitForListeningPass(started.job.passId, context)).stage,
    ).toBe("cancelled");
    finish();
    await vi.waitFor(() => expect(f.releaseReservation).toHaveBeenCalledOnce());
    expect(f.adapter.prepare).not.toHaveBeenCalled();
    expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it("late capture preparation after cancellation compensates its actual handle", async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.adapter.prepare).mockImplementation(
      (_service, input) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              jobId: uuid(100),
              passId: input.passId,
              result: new Promise(() => {}),
              disarm: f.disarm,
            });
        }),
    );
    const controller = new AbortController();
    const host = f.host();
    const started = await host.executeListeningOperation(request, {
      ...context,
      signal: controller.signal,
    });
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() => expect(f.adapter.prepare).toHaveBeenCalledOnce());
    controller.abort();
    expect(
      (await host.waitForListeningPass(started.job.passId, context)).stage,
    ).toBe("cancelled");
    finish();
    await vi.waitFor(() => expect(f.disarm).toHaveBeenCalledOnce());
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("late guarded start after cancellation releases only local monitors, never stops", async () => {
    const f = fixture();
    let finish!: () => void;
    vi.mocked(f.adapter.start).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              cleanupPolicy: "leave-running",
              sourceOnset: "measured",
              startedAtBeat: 0,
              release: f.release,
            });
        }),
    );
    const controller = new AbortController();
    const host = f.host();
    const started = await host.executeListeningOperation(request, {
      ...context,
      signal: controller.signal,
    });
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() => expect(f.adapter.start).toHaveBeenCalledOnce());
    controller.abort();
    expect(
      (await host.waitForListeningPass(started.job.passId, context)).stage,
    ).toBe("cancelled");
    finish();
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("abort during commit acknowledgement remains explicitly publication-indeterminate", async () => {
    const f = fixture();
    let finish!: () => void;
    f.appendPass.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const host = f.host();
    const started = await host.executeListeningOperation(request, {
      ...context,
      signal: controller.signal,
    });
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() => expect(f.appendPass).toHaveBeenCalledOnce());
    controller.abort();
    const result = await host.waitForListeningPass(started.job.passId, context);
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("may have committed");
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    expect(f.appendPass).toHaveBeenCalledOnce();
  });

  it.each(["disarm", "reservation"] as const)(
    "cleanup %s failure cannot become a successful pass",
    async (target) => {
      const f = fixture();
      if (target === "disarm")
        f.disarm.mockRejectedValue(new Error("listener cleanup failed"));
      else
        f.releaseReservation.mockRejectedValue(
          new Error("reservation cleanup failed"),
        );
      const result = await run(f.host());
      expect(result.stage).toBe("failed");
      expect(result.error).toContain("cleanup failed");
      expect(f.releaseReservation).toHaveBeenCalledOnce();
    },
  );

  it("capture rejection before start prevents guarded playback", async () => {
    const f = fixture();
    vi.mocked(f.adapter.prepare).mockImplementation(
      async (_service, input) => ({
        jobId: uuid(100),
        passId: input.passId,
        result: Promise.reject(new Error("audio partial failure")),
        disarm: f.disarm,
      }),
    );
    const result = await run(f.host());
    expect(result.error).toContain("audio partial failure");
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("observer mutation/failure cannot corrupt caller ownership or leak credentials", async () => {
    const f = fixture();
    const host = f.host(false, {
      ...f.options,
      onChange: (job) => {
        Object.assign(job.owner, { sessionId: "foreign", agentId: "foreign" });
        throw new Error("observer token=private-observer-secret");
      },
    });
    expect((await run(host)).stage).toBe("completed");
    const listing = await host.executeListeningOperation(
      { action: "list-passes", limit: 10 },
      context,
    );
    expect(listing.action === "list-passes" && listing.jobs.length).toBe(1);
    expect(JSON.stringify(f.events)).not.toContain("private-observer-secret");
  });

  it("independently inspected mix-bus association stays mixed, never exclusive or clip-specific", async () => {
    const f = fixture();
    Object.assign(f.inventory[0]!.registration, {
      deviceCanonicalPath: "live_set master_track devices 0",
      trackCanonicalPath: "live_set master_track",
    });
    f.inspectListeningContext.mockImplementation(async (input) => {
      const result = inspection({
        ...input,
        listeners: [{ canonicalPath: "live_set tracks 0 devices 0" }],
      });
      const listener = result.listeners[0]!;
      listener.binding.track = {
        kind: "master",
        expectedReference: uuid(10),
        expectedName: "Master",
      };
      listener.canonicalPath = "live_set master_track devices 0";
      listener.pathAttestation!.canonicalDevicePath =
        "live_set master_track devices 0";
      listener.pathAttestation!.canonicalTrackPath = "live_set master_track";
      listener.fingerprint.completeness = "complete";
      listener.fingerprint.unknownReasons = [];
      listener.unknownReasons = [];
      return result;
    });
    expect((await run(f.host())).stage).toBe("completed");
    expect(
      f.publications[0]!.links.every((item) => item.attribution === "mixed"),
    ).toBe(true);
    expect(
      f.publications[0]!.subjects.every((item) => item.kind !== "clip"),
    ).toBe(true);
  });

  it.each(["sample-rate", "tempo", "transport", "session-override"] as const)(
    "fresh %s guard is revalidated before capture controls",
    async (change) => {
      const f = fixture();
      if (change === "sample-rate")
        f.reservePass.mockImplementation(async () => {
          f.inventory[0]!.registration.sampleRate = 44100;
        });
      else
        f.inspectListeningContext.mockImplementation(async (input) => {
          const result = inspection(input);
          if (f.reservePass.mock.calls.length) {
            if (change === "tempo") result.transport.tempo = 1;
            if (change === "transport") {
              result.transport.playing = true;
              result.transport.safeToStart = false;
            }
            if (change === "session-override")
              result.listeners[0]!.sessionOverride = true;
          }
          return result;
        });
      const result = await run(f.host());
      expect(result.stage).toBe("failed");
      expect(f.adapter.prepare).not.toHaveBeenCalled();
      expect(f.adapter.start).not.toHaveBeenCalled();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.appendPass).not.toHaveBeenCalled();
    },
  );

  it("independent Set identity is checked again after the path join", async () => {
    const f = fixture();
    f.getLiveIdentity
      .mockResolvedValueOnce({
        liveSetId: "set",
        liveSetName: "Set",
        saved: true,
        diagnostics: [],
      })
      .mockResolvedValue({
        liveSetId: "foreign-set",
        liveSetName: "Other",
        saved: true,
        diagnostics: [],
      });
    const result = await run(f.host());
    expect(result.error).toContain("live_set_changed");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.adapter.prepare).not.toHaveBeenCalled();
  });

  it("hung late capture cleanup is bounded and visibly failed, not a success-shaped late reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    f.disarm.mockImplementation(() => new Promise<void>(() => {}));
    vi.mocked(f.adapter.prepare).mockImplementation(
      (_service, input) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              jobId: uuid(100),
              passId: input.passId,
              result: new Promise(() => {}),
              disarm: f.disarm,
            });
        }),
    );
    const controller = new AbortController();
    const host = f.host();
    const started = await host.executeListeningOperation(request, {
      ...context,
      signal: controller.signal,
    });
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() => expect(f.adapter.prepare).toHaveBeenCalledOnce());
    controller.abort();
    expect(
      (await host.waitForListeningPass(started.job.passId, context)).stage,
    ).toBe("cancelled");
    finish();
    await vi.waitFor(() => expect(f.disarm).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10001);
    expect(JSON.stringify(f.events)).toContain(
      "Late listening resource cleanup timed out",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(f.adapter.start).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
  });
});
