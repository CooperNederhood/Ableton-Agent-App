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
  metricRecordStreamContextReferenceSchema,
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
import {
  createSyntheticMetricListenerPeer,
  withSyntheticMetricStreamRegistration,
} from "./metric-listening-test-support.js";

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
      timeSignature: { numerator: 4, denominator: 4 },
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
    registration: withSyntheticMetricStreamRegistration(
      listenerRegistrationMetricSchema.parse({
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
    ),
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
  const finalizeMetricCaptures = vi.spyOn(repository, "finalizeMetricCaptures");
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
    finalizeMetricCaptures,
    requestListenerControl,
    positionListeningPlayback,
    startListeningPlayback,
    begin,
    run: async () => host.waitForListeningPass(await begin(), context),
  };
}

describe("production v5 Arrangement listening host with synthetic native peer", () => {
  it("persists monitored Arrangement meter as canonical musical alignment", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.stage).toBe("completed");
    expect(
      (await f.repository.getEntry(result.contextIds[0]!))?.musicalAlignment,
    ).toEqual({
      version: 1,
      coordinate: "transport-beats",
      meter: { numerator: 4, denominator: 4 },
      barOriginBeat: 0,
      tempoBpm: 120,
      tempoEvidence: "message-rate-monitored-constant",
      provenance: "capture-snapshot/v1",
    });
  });
  it("does not invent musical alignment for an unknown Arrangement meter", async () => {
    const f = await fixture();
    f.dependencies.ableton.inspectListeningContext = async (input) => {
      const snapshot = inspection(input);
      snapshot.transport.timeSignature = null;
      return snapshot;
    };
    const result = await f.run();
    expect(result.stage).toBe("completed");
    expect(
      (await f.repository.getEntry(result.contextIds[0]!))?.musicalAlignment,
    ).toBeUndefined();
  });
  it("rejects meter changes before native capture and releases owned resources", async () => {
    const f = await fixture();
    let reads = 0;
    f.dependencies.ableton.inspectListeningContext = async (input) => {
      const snapshot = inspection(input);
      if (++reads > 1)
        snapshot.transport.timeSignature = { numerator: 3, denominator: 4 };
      return snapshot;
    };
    expect((await f.run()).stage).toBe("failed");
    expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
  });
  it("exposes the authenticated continuous capability without claiming fresh native readiness or starting playback", async () => {
    const f = await fixture(false, true, true, true, true);
    const continuous = structuredClone(f.listener);
    vi.spyOn(
      f.dependencies.signals.listeners!,
      "inspectListeners",
    ).mockReturnValue([continuous]);
    const result = await f.host.executeListeningOperation(
      { action: "inspect-listeners" },
      context,
    );
    expect(result).toMatchObject({
      listeners: [
        {
          capabilities: continuous.registration.capabilities,
          ready: false,
        },
      ],
    });
    expect(result).toHaveProperty(
      "listeners.0.limitations",
      expect.arrayContaining(["native_per_pass_validation_required"]),
    );
    expect(f.requestListenerControl).not.toHaveBeenCalled();
    expect(f.positionListeningPlayback).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
  });
  it("journals independently checked listener-owner release before publishing without stopping playback", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.stage).toBe("completed");
    const events = f.telemetryEnqueue.mock.calls.map(([event]) => event);
    const released = events.find(
      (event) =>
        event.name === "listening.runtime.arrangement-source-cleanup.completed",
    );
    expect(released).toMatchObject({
      sessionId: owner.sessionId,
      activeAgentId: owner.agentId,
      correlationId: context.trace.correlationId,
      causationId: context.trace.causationId,
      trace: { traceId: context.trace.traceId },
      outcome: "success",
      attributes: {
        passId: result.passId,
        cleanupPolicy: "leave-running",
        sourceOwnership: "authenticated-listener-registry",
        listenerOwnerReleased: true,
        listeners: [
          {
            listenerId: f.listener.producer.producerId,
            connectionId: f.listener.connectionId,
            connectionEpoch: f.listener.registration.connectionEpoch,
            generation: f.peer.stream!.descriptor.ownership.generation,
            nativeEpoch: f.peer.stream!.descriptor.ownership.nativeEpoch,
          },
        ],
      },
    });
    expect(released?.durationMs).toBeGreaterThanOrEqual(0);
    const cleanupIndex = events.indexOf(released!);
    const publicationIndex = events.findIndex(
      (event) => event.name === "listening.runtime.publication.started",
    );
    expect(publicationIndex).toBeGreaterThan(cleanupIndex);
  });
  it("denies publication when a new native owner occupies the listener at source cleanup", async () => {
    const f = await fixture();
    const service = f.dependencies.signals.listeners!;
    const inspect = service.inspectListeners.bind(service);
    vi.spyOn(service, "inspectListeners").mockImplementation(() => {
      const current = inspect();
      const cleanupStarted = f.telemetryEnqueue.mock.calls.some(
        ([event]) =>
          event.name === "listening.runtime.arrangement-source-cleanup.started",
      );
      return cleanupStarted
        ? current.map((item) => ({
            ...item,
            phase: "armed" as const,
            jobId: "foreign-job",
            passId: "foreign-pass",
          }))
        : current;
    });
    const result = await f.run();
    expect(result.stage).toBe("failed");
    expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
    expect(
      f.telemetryEnqueue.mock.calls.some(
        ([event]) =>
          event.name === "listening.runtime.arrangement-source-cleanup.failed",
      ),
    ).toBe(true);
    expect(
      f.telemetryEnqueue.mock.calls.some(
        ([event]) =>
          event.name ===
          "listening.runtime.arrangement-source-cleanup.completed",
      ),
    ).toBe(false);
  });
  it.each([180, 600])(
    "does not advertise or start an unsupported %ss producer pass",
    async (seconds) => {
      const f = await fixture(false, true, true, true, true);
      Object.assign(f.listener, {
        registration: listenerRegistrationMetricSchema.parse(
          f.data.registration,
        ),
      });
      const result = await f.host.executeListeningOperation(
        {
          action: "play-arrangement-and-listen",
          listenerIds: [f.listener.producer.producerId],
          startBeat: 0,
          endBeat: seconds * 2,
          maximumDurationMs: seconds * 1000,
        },
        context,
      );
      if (!("job" in result)) throw new Error("Expected owned listening job");
      const job = await f.host.waitForListeningPass(result.job.passId, context);
      expect(job.stage).toBe("failed");
      expect(f.requestListenerControl).not.toHaveBeenCalled();
      expect(f.positionListeningPlayback).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
      expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
    },
  );
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
          capabilities: [...f.listener.registration.capabilities],
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
    const observed = metricRecordStreamContextReferenceSchema.parse(
      (await f.repository.getEntry(job.contextIds[0]!))?.payload,
    ).descriptor;
    expect(observed.requestedMetrics).toEqual([
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ]);
    const manifest = (await f.repository.getMetricCapture(job.contextIds[0]!))
      ?.manifest;
    expect(
      manifest?.metrics.find((metric) => metric.metric === "pitch")?.status,
    ).toBe("complete");
    expect(
      manifest?.metrics.find((metric) => metric.metric === "spectral-shape")
        ?.status,
    ).toBe("complete");
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
      expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
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
      expect(f.finalizeMetricCaptures).toHaveBeenCalledOnce();
      expect((await f.repository.getEntry(job.contextIds[0]!))?.kind).toBe(
        "metric-record-stream-context/v1",
      );
      expect((await f.repository.listEntries({})).items).toHaveLength(1);
      expect(f.jobs.at(-1)?.contextIds).toHaveLength(1);
      const observed = metricRecordStreamContextReferenceSchema.parse(
        (await f.repository.getEntry(job.contextIds[0]!))?.payload,
      ).descriptor;
      expect(observed).toMatchObject({
        requestedMetrics: [
          "level",
          "spectral-centroid",
          "attacks",
          "mel-bands",
          "pitch",
          "spectral-shape",
        ],
      });
      expect(
        (await f.repository.getMetricCapture(job.contextIds[0]!))?.manifest
          ?.metrics,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ metric: "mel-bands", status: "complete" }),
        ]),
      );
      const [melChunk] = (
        await f.repository.listMetricChunks({
          captureId: job.contextIds[0]!,
          metric: "mel-bands",
        })
      ).items;
      expect(melChunk?.metric).toBe("mel-bands");
      expect(melChunk?.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            magnitudes: [Array<number>(24).fill(0), Array<number>(24).fill(0)],
          }),
        ]),
      );
      expect(f.peer.subscribers.size).toBe(0);
      expect(f.releaseReservation).toHaveBeenCalledOnce();
    },
  );

  it("publishes honest unavailable mel alongside healthy metrics and releases ownership", async () => {
    const f = await fixture(false, true, true, false);
    const job = await f.run();
    expect(job.stage).toBe("partial");
    expect(f.startListeningPlayback).toHaveBeenCalledOnce();
    expect(f.finalizeMetricCaptures).toHaveBeenCalledOnce();
    expect(job.metricResults?.[0]?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "mel-bands", status: "failed" }),
        expect.objectContaining({ metric: "level", status: "complete" }),
      ]),
    );
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("denies disabled qualification before controls, playback or publication", async () => {
    const f = await fixture(false, false);
    expect((await f.run()).stage).toBe("failed");
    expect(f.requestListenerControl).not.toHaveBeenCalled();
    expect(f.positionListeningPlayback).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
  });

  it("requires authorized positioning before native prepare", async () => {
    const f = await fixture();
    delete f.dependencies.ableton.positionListeningPlayback;
    expect((await f.run()).stage).toBe("failed");
    expect(f.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
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
    expect(f.finalizeMetricCaptures).not.toHaveBeenCalled();
    expect(f.log).toContain("metric:cancel");
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });
});
