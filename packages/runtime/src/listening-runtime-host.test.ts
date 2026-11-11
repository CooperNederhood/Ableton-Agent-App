import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyntheticAnalyzerReadiness,
  withSyntheticAnalyzerTimelines,
} from "@ableton-agent/protocol/testing";
import type {
  ListeningExecutionContext,
  ListeningJob,
} from "@ableton-agent/application";
import { createInMemorySessionContextStore } from "@ableton-agent/project-state";
import {
  inspectListeningContextParamsSchema,
  metricAudioObservationSchema,
  type InspectListeningContextParams,
  type InspectListeningContextResult,
} from "@ableton-agent/protocol";
import {
  listenerRegistrationMetricSchema,
  type ListenerDescriptor,
} from "@ableton-agent/signal-routing";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import type { ListeningRuntimeDependencies } from "./composition.js";
import {
  createListeningRuntimeHost,
  type ConcreteListeningRuntimeHost,
} from "./listening-runtime-host.js";
import { createSyntheticMetricListenerPeer } from "./metric-listening-test-support.js";

const uuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const owner = { sessionId: "session", agentId: "agent", liveSetId: "set" };
const context: ListeningExecutionContext = {
  sessionId: owner.sessionId,
  agentId: owner.agentId,
  trace: { traceId: uuid(1), correlationId: "listen", causationId: "caller" },
  actorKind: "agent",
};
const hosts: ConcreteListeningRuntimeHost[] = [];
const stores: Awaited<ReturnType<typeof createInMemorySessionContextStore>>[] =
  [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function inspection(
  input: InspectListeningContextParams,
): InspectListeningContextResult {
  inspectListeningContextParamsSchema.parse(input);
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
      return {
        binding: {
          track: {
            kind: "regular",
            index: 0,
            expectedReference: uuid(10),
            expectedName: "Track",
          },
          deviceIndex: 0,
          expectedDeviceReference: uuid(20),
          expectedDeviceName: "Synthetic listener",
          expectedClassName: "MxDeviceAudioEffect",
        },
        canonicalPath: selector.canonicalPath,
        pathAttestation: {
          schemaVersion: 1,
          source: "remote-script-lom",
          canonicalDevicePath: selector.canonicalPath,
          canonicalTrackPath: "live_set tracks 0",
          trackReference: uuid(10),
          deviceReference: uuid(20),
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

async function fixture(
  partial = false,
  enabled = true,
  completeOnStart = true,
  provideMelBands = true,
  analyzers = false,
) {
  const data = createSyntheticMetricWireFixture("arrangement", partial);
  if (analyzers) {
    data.observation = withSyntheticAnalyzerTimelines(data.observation);
    data.ready.analyzerProducerAbi = 3;
    data.proof.armed.analyzerProducerAbi = 3;
  }
  const log: string[] = [];
  const jobs: ListeningJob[] = [];
  const telemetryEnqueue =
    vi.fn<NonNullable<ListeningRuntimeDependencies["telemetry"]>["enqueue"]>();
  const listener: ListenerDescriptor = {
    connectionId: data.wire.connectionId,
    producer: {
      producerId: "listener-0",
      instanceId: "synthetic-instance",
      signalKind: "audio",
      schemaVersion: "metric-audio-observation/v1",
      displayName: "Synthetic listener; not physical DSP evidence",
      track: { id: "500" },
      device: { id: "600" },
    },
    binding: { trackId: "500", deviceId: "600" },
    registration: listenerRegistrationMetricSchema.parse({
      ...data.registration,
      ...(analyzers
        ? {
            capabilities: [
              ...data.registration.capabilities,
              "audio-listener/analyzer-timelines-v1",
            ],
            analyzerReadiness: createSyntheticAnalyzerReadiness(),
          }
        : {}),
      nativeStatus: {
        ...data.registration.nativeStatus,
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        executedGen: null,
      },
    }),
    phase: "idle",
  };
  const peer = createSyntheticMetricListenerPeer(
    listener,
    data,
    (action) => log.push(`metric:${action}`),
    { provideMelBands },
  );
  const requestListenerControl = vi.fn(
    peer.service.requestListenerControl.bind(peer.service),
  );
  const service = { ...peer.service, requestListenerControl };
  const repository = await createInMemorySessionContextStore(owner);
  stores.push(repository);
  const reservePass = vi.spyOn(repository, "reservePass");
  const releaseReservation = vi.spyOn(repository, "releaseReservation");
  const appendPass = vi.spyOn(repository, "appendPass");
  const inspectListeningContext = vi.fn(
    async (input: InspectListeningContextParams) => inspection(input),
  );
  const positionListeningPlayback = vi.fn<
    NonNullable<
      ListeningRuntimeDependencies["ableton"]["positionListeningPlayback"]
    >
  >(async (input) => {
    log.push("position");
    return {
      schemaVersion: 1,
      mode: "arrangement",
      requestedStartBeat: input.range.startBeat,
      sourceOnset: "unverified",
      insertMarkerBeat: input.range.startBeat,
      currentBeat: input.range.startBeat,
      playing: false,
      changed: { insertMarker: false, currentPosition: false },
      cleanupPolicy: "leave-running",
    };
  });
  const startListeningPlayback = vi.fn<
    NonNullable<
      ListeningRuntimeDependencies["ableton"]["startListeningPlayback"]
    >
  >(async () => {
    log.push("start");
    peer.launch();
    if (completeOnStart) peer.complete();
    return {
      schemaVersion: 1,
      mode: "arrangement",
      cleanupPolicy: "leave-running",
      startedAtBeat: data.config.geometry.startBeat,
      sourceOnset: "unverified",
    };
  });
  const dependencies = {
    ableton: {
      getLiveIdentity: vi.fn(async () => ({
        liveSetId: owner.liveSetId,
        liveSetName: "Synthetic Set",
        saved: true,
        diagnostics: [],
      })),
      inspectListeningContext,
      positionListeningPlayback,
      startListeningPlayback,
    },
    signals: { listeners: service, listenerTransport: service },
    events: { publish: vi.fn(), subscribe: vi.fn(() => () => {}) },
    telemetry: { enqueue: telemetryEnqueue },
  } as unknown as ListeningRuntimeDependencies;
  const host = createListeningRuntimeHost(dependencies, {
    independentMetricListeners: enabled,
    resolveOwner: async () => owner,
    resolveRepository: async () => repository,
    resolveTimingPolicy: () => data.config.timingPolicy,
    onChange: (job) => jobs.push(job),
  });
  hosts.push(host);
  const request = {
    action: "play-arrangement-and-listen" as const,
    listenerIds: [listener.producer.producerId],
    startBeat: data.config.geometry.startBeat,
    endBeat: data.config.geometry.endBeat,
    maximumDurationMs: 5_000,
  };
  const begin = async (signal?: AbortSignal) => {
    const result = await host.executeListeningOperation(request, {
      ...context,
      ...(signal ? { signal } : {}),
    });
    if (!("job" in result)) throw new Error("Expected owned listening job");
    return result.job.passId;
  };
  return {
    data,
    listener,
    log,
    jobs,
    telemetryEnqueue,
    peer,
    repository,
    host,
    dependencies,
    reservePass,
    releaseReservation,
    appendPass,
    requestListenerControl,
    positionListeningPlayback,
    startListeningPlayback,
    begin,
    run: async () => host.waitForListeningPass(await begin(), context),
  };
}

describe("production v5 Arrangement listening host with synthetic native peer", () => {
  it("discovers an actual three-capability ABI3 registration and captures all six metric families without dropping readiness", async () => {
    const f = await fixture(false, true, true, true, true);
    const discovery = await f.host.executeListeningOperation(
      { action: "inspect-listeners" },
      context,
    );
    expect(discovery).toMatchObject({
      action: "inspect-listeners",
      truncated: false,
      listeners: [
        {
          listenerId: "listener-0",
          trackReference: uuid(10),
          deviceReference: uuid(20),
          ready: false,
        },
      ],
    });
    const discoveryEvents = f.telemetryEnqueue.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name.startsWith("listening.runtime.discovery."));
    expect(discoveryEvents.map((event) => event.name)).toEqual([
      "listening.runtime.discovery.queued",
      "listening.runtime.discovery.started",
      "listening.runtime.discovery.completed",
    ]);
    for (const event of discoveryEvents) {
      expect(event).toMatchObject({
        sessionId: context.sessionId,
        activeAgentId: context.agentId,
        trace: { traceId: context.trace.traceId },
        correlationId: context.trace.correlationId,
        causationId: context.trace.causationId,
      });
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    const job = await f.run();
    expect(job.stage, JSON.stringify({ job, log: f.log })).toBe("completed");
    const observed = metricAudioObservationSchema.parse(
      (await f.repository.getEntry(job.contextIds[0]!))?.payload,
    );
    expect(observed.requestedMetrics).toEqual([
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ]);
    expect(observed.metrics.pitch?.status).toBe("complete");
    expect(observed.metrics["spectral-shape"]?.status).toBe("complete");
    expect(f.listener.registration).toHaveProperty(
      "analyzerReadiness",
      createSyntheticAnalyzerReadiness(),
    );
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });
  it.each(["missing", "sample-rate", "abi", "unadvertised"] as const)(
    "denies %s analyzer registration during discovery and before capture controls",
    async (failure) => {
      const f = await fixture(false, true, true, true, true);
      const receipt = createSyntheticAnalyzerReadiness();
      Object.assign(
        f.listener.registration,
        failure === "unadvertised"
          ? {
              capabilities: [
                "audio-listener/independent-metric-timelines-v1",
                "audio-listener/mel-band-timelines-v1",
              ],
            }
          : {
              analyzerReadiness:
                failure === "missing"
                  ? undefined
                  : {
                      ...receipt,
                      ...(failure === "sample-rate"
                        ? { sampleRate: 44100 }
                        : {}),
                      ...(failure === "abi" ? { producerAbi: 2 } : {}),
                    },
            },
      );
      expect(
        await f.host.executeListeningOperation(
          { action: "inspect-listeners" },
          context,
        ),
      ).toMatchObject({ listeners: [], truncated: true });
      const job = await f.run();
      expect(job.stage).toBe("failed");
      expect(f.requestListenerControl).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
      expect(f.appendPass).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "positions and publishes negotiated metric partial=%s without legacy assembly",
    async (partial) => {
      const f = await fixture(partial);
      const job = await f.run();
      expect(job.stage, JSON.stringify({ job, log: f.log })).toBe(
        partial ? "partial" : "completed",
      );
      expect(f.log.indexOf("position")).toBeLessThan(
        f.log.indexOf("metric:prepare"),
      );
      expect(f.log.indexOf("metric:arm")).toBeLessThan(f.log.indexOf("start"));
      expect(f.positionListeningPlayback).toHaveBeenCalledOnce();
      expect(f.appendPass).toHaveBeenCalledOnce();
      expect(f.appendPass.mock.calls[0]?.[0].entries[0]?.kind).toBe(
        "metric-audio-observation/v1",
      );
      expect((await f.repository.listEntries({})).items).toHaveLength(1);
      expect(f.jobs.at(-1)?.contextIds).toHaveLength(1);
      const observed = metricAudioObservationSchema.parse(
        (await f.repository.getEntry(job.contextIds[0]!))?.payload,
      );
      expect(observed).toMatchObject({
        requestedMetrics: [
          "level",
          "spectral-centroid",
          "attacks",
          "mel-bands",
        ],
        metrics: {
          "mel-bands": {
            status: "complete",
            profile: { bandCount: 24 },
          },
        },
      });
      expect(observed.metrics["mel-bands"]?.frames[0]?.magnitudes).toEqual([
        Array(24).fill(0.5),
        Array(24).fill(0.25),
      ]);
      expect(f.peer.subscribers.size).toBe(0);
      expect(f.releaseReservation).toHaveBeenCalledOnce();
    },
  );

  it("fails missing mel independently of healthy baseline evidence and releases ownership", async () => {
    const f = await fixture(false, true, true, false);
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(f.startListeningPlayback).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("denies disabled qualification before controls, playback or publication", async () => {
    const f = await fixture(false, false);
    expect((await f.run()).stage).toBe("failed");
    expect(f.requestListenerControl).not.toHaveBeenCalled();
    expect(f.positionListeningPlayback).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
  });

  it("requires authorized positioning before native prepare", async () => {
    const f = await fixture();
    delete f.dependencies.ableton.positionListeningPlayback;
    expect((await f.run()).stage).toBe("failed");
    expect(f.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
  });

  it("cancels a launched incomplete capture without publishing and releases ownership", async () => {
    const f = await fixture(false, true, false);
    const abort = new AbortController();
    const passId = await f.begin(abort.signal);
    await vi.waitFor(() => expect(f.jobs.at(-1)?.stage).toBe("capturing"));
    abort.abort();
    const job = await f.host.waitForListeningPass(passId, context);
    expect(job.stage, JSON.stringify({ job, log: f.log })).toBe("cancelled");
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.log).toContain("metric:cancel");
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });
});
