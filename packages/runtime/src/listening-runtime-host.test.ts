import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ListeningExecutionContext,
  ListeningJob,
} from "@ableton-agent/application";
import { createInMemorySessionContextStore } from "@ableton-agent/project-state";
import {
  inspectListeningContextParamsSchema,
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
) {
  const data = createSyntheticMetricWireFixture("arrangement", partial);
  const log: string[] = [];
  const jobs: ListeningJob[] = [];
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
      nativeStatus: {
        ...data.registration.nativeStatus,
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        executedGen: null,
      },
    }),
    phase: "idle",
  };
  const peer = createSyntheticMetricListenerPeer(listener, data, (action) =>
    log.push(`metric:${action}`),
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
    telemetry: { enqueue: vi.fn(() => true) },
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
    log,
    jobs,
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
      expect(f.peer.subscribers.size).toBe(0);
      expect(f.releaseReservation).toHaveBeenCalledOnce();
    },
  );

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
