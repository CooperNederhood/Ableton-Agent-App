import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCorrelationContext } from "@ableton-agent/correlation";
import {
  inspectListeningContextParamsSchema,
  type createNativeListeningGeometry,
  NATIVE_LISTENER_SCOPE,
  positionListeningPlaybackParamsSchema,
  startListeningPlaybackParamsSchema,
} from "@ableton-agent/protocol";
import {
  createSyntheticNativeListeningFixture,
  createSyntheticNativeListeningFixtureV2,
} from "@ableton-agent/protocol/testing";
import {
  listenerControlInputSchema,
  listenerConfigSchema,
  listenerRegistrationV2Schema,
  listenerConfigV2Schema,
} from "@ableton-agent/signal-routing";
import type {
  AudioObservation,
  InspectListeningContextParams,
  InspectListeningContextResult,
} from "@ableton-agent/protocol";
import type {
  ListenerDescriptor,
  ListenerService,
  ListenerControlInput,
  ListenerResult,
  ListenerResultEvent,
  ListenerResultV2,
  VersionedListenerControlInput,
} from "@ableton-agent/signal-routing";
import {
  listeningLimits,
  type ListeningExecutionContext,
  type ListeningJob,
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
  const configuration = listenerConfigSchema.parse(input.config);
  return {
    schema: "audio-observation/v1",
    listenerId,
    passId: input.passId,
    sampleRate: 48000,
    startSample: 0,
    endSample: 96000,
    startBeat: configuration.source.startBeat,
    endBeat: configuration.source.endBeat,
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

function fixture(
  count = 1,
  nativeLaunch?: Promise<void>,
  sourceOnset: "measured" | "unverified" = "measured",
) {
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
      inspectListeningContextParamsSchema.parse(input);
      return inspection(input);
    },
  );
  const startListeningPlayback = vi.fn<
    NonNullable<
      ListeningRuntimeDependencies["ableton"]["startListeningPlayback"]
    >
  >(async () => {
    throw new Error("Production playback must stay gated");
  });
  const service = {
    inspectListeners: () => inventory,
    requestListenerControl: vi.fn<ListenerService["requestListenerControl"]>(
      async () => {
        throw new Error("Unexpected raw control");
      },
    ),
    onListenerResult: vi.fn<ListenerService["onListenerResult"]>(() => {
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
    resolveTimingPolicy: () => ({
      mode: "strict",
      maxClockDisagreementSamples: 0,
    }),
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
        return {
          jobId: uuid(100),
          passId: input.passId,
          result,
          disarm,
          ...(nativeLaunch ? { nativeLaunch } : {}),
        };
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
        sourceOnset,
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

function nativeProductionFixture(armProof = true) {
  const f = fixture();
  const listener = f.inventory[0]!;
  const data = createSyntheticNativeListeningFixture({
    listenerId: listener.producer.producerId,
  });
  Object.assign(listener.registration, {
    algorithmVersion: data.observation.algorithm.version,
    nativeStatus: {
      version: 1,
      timing: "UNVERIFIED",
      readiness: "BLOCKED",
      reason: "native_per_pass_validation_required",
      scope: NATIVE_LISTENER_SCOPE,
    },
  });
  const subscribers = new Set<(event: ListenerResultEvent) => void>();
  let sequence = 0;
  let armed: ListenerControlInput | undefined;
  f.service.onListenerResult.mockImplementation((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  f.service.requestListenerControl.mockImplementation(async (_id, control) => {
    if (control.action === "arm")
      armed = listenerControlInputSchema.parse(control);
    Object.assign(listener, {
      phase:
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "idle",
    });
    if (control.action === "cancel") {
      Reflect.deleteProperty(listener, "jobId");
      Reflect.deleteProperty(listener, "passId");
    } else {
      Object.assign(listener, { jobId: control.jobId, passId: control.passId });
    }
    return {
      type: "listener.reply",
      protocolVersion: 1,
      listenerVersion: 1,
      requestId: `synthetic-control-${sequence}`,
      sequence: sequence++,
      connectionEpoch: listener.registration.connectionEpoch,
      jobId: control.jobId,
      passId: control.passId,
      traceId: control.traceId,
      correlationId: control.correlationId,
      causationId: control.causationId,
      status:
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "cancelled",
      ...(control.action === "arm" && armProof
        ? { nativeArm: data.proof.armed }
        : {}),
    };
  });
  f.startListeningPlayback.mockImplementation(async (input) => {
    startListeningPlaybackParamsSchema.parse(input);
    const control = armed;
    if (!control) throw new Error("Synthetic source requested before arm");
    const publish = (patch: Partial<ListenerResult>) => {
      const result: ListenerResult = {
        type: "listener.result",
        protocolVersion: 1,
        listenerVersion: 1,
        requestId: `synthetic-result-${sequence}`,
        sequence: sequence++,
        connectionEpoch: listener.registration.connectionEpoch,
        jobId: control.jobId,
        passId: control.passId,
        traceId: control.traceId,
        correlationId: control.correlationId,
        causationId: control.causationId,
        status: "progress",
        ...patch,
      };
      for (const callback of subscribers)
        callback({
          connectionId: listener.connectionId,
          producer: listener.producer,
          binding: listener.binding,
          result,
        });
    };
    publish({ nativeLaunch: data.proof.launched });
    publish({
      status: "completed",
      observation: { ...data.observation, passId: control.passId },
      nativeCapture: data.proof,
    });
    Object.assign(listener, { phase: "idle" });
    Reflect.deleteProperty(listener, "jobId");
    Reflect.deleteProperty(listener, "passId");
    return {
      schemaVersion: 1,
      mode: "arrangement",
      cleanupPolicy: "leave-running",
      startedAtBeat: 0,
      sourceOnset: "unverified",
    };
  });
  return { ...f, subscribers, data };
}

function descriptiveProductionFixture(
  geometry: Parameters<typeof createNativeListeningGeometry>[0] = {
    sampleRate: 44_100,
    vectorSize: 128,
    tempoBpm: 127.5,
    startBeat: 5.25,
    endBeat: 9.50001,
  },
) {
  const f = fixture();
  const old = f.inventory[0]!;
  const listener: ListenerDescriptor = {
    ...old,
    producer: { ...old.producer, schemaVersion: "audio-observation/v2" },
    registration: listenerRegistrationV2Schema.parse({
      ...old.registration,
      version: 2,
      capabilities: ["audio-listener/v2"],
      algorithmVersion: "2.0.0",
      sampleRate: geometry.sampleRate,
      vectorSize: geometry.vectorSize,
      nativeStatus: {
        version: 2,
        scope: "arrangement-descriptive/v2",
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        alignment: "approximate",
        verifiedAbsoluteErrorBoundSamples: null,
        acceptedSampleRates: [44_100, 48_000],
        acceptedVectorSizes: [geometry.vectorSize],
        timingModes: ["descriptive", "strict"],
        maxClockDisagreementSamples: 480,
        maxAudioDurationMs: 30_000,
        maxWindows: 300,
        abiVersion: 2,
      },
    }),
  };
  f.inventory[0] = listener;
  const nativeState: {
    currentBeat: number;
    revision: number;
    tempo: number;
    fingerprint: string;
    playing: boolean;
    onPosition?: () => void;
  } = {
    currentBeat: 9,
    revision: 1,
    tempo: geometry.tempoBpm,
    fingerprint: "a".repeat(64),
    playing: false,
  };
  f.inspectListeningContext.mockImplementation(async (input) => {
    const result = inspection(input);
    return {
      ...result,
      projectRevision: nativeState.revision,
      transport: {
        ...result.transport,
        currentBeat: nativeState.currentBeat,
        tempo: nativeState.tempo,
        playing: nativeState.playing,
        safeToStart: !nativeState.playing,
      },
      listeners: result.listeners.map((item) => ({
        ...item,
        fingerprint: { ...item.fingerprint, digest: nativeState.fingerprint },
      })),
    };
  });
  const position = vi.fn<
    NonNullable<
      ListeningRuntimeDependencies["ableton"]["positionListeningPlayback"]
    >
  >(async (input) => {
    positionListeningPlaybackParamsSchema.parse(input);
    expect(input.expectedProjectRevision).toBe(nativeState.revision);
    f.log.push("position");
    nativeState.currentBeat = input.range.startBeat;
    nativeState.revision += 1;
    nativeState.onPosition?.();
    return {
      schemaVersion: 1,
      mode: "arrangement",
      cleanupPolicy: "leave-running",
      sourceOnset: "unverified",
      requestedStartBeat: input.range.startBeat,
      insertMarkerBeat: input.range.startBeat,
      currentBeat: nativeState.currentBeat,
      playing: false,
      changed: { insertMarker: true, currentPosition: true },
    };
  });
  Object.assign(f.dependencies.ableton, {
    positionListeningPlayback: position,
  });
  const subscribers = new Set<(event: ListenerResultEvent) => void>();
  f.service.onListenerResult.mockImplementation((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  let sequence = 0;
  let armed: VersionedListenerControlInput | undefined;
  let data:
    ReturnType<typeof createSyntheticNativeListeningFixtureV2> | undefined;
  f.service.requestListenerControl.mockImplementation(async (_id, control) => {
    f.log.push(control.action);
    if (control.action === "prepare") {
      const config = listenerConfigV2Schema.parse(control.config);
      const value = config.geometry;
      data = createSyntheticNativeListeningFixtureV2({
        listenerId: listener.producer.producerId,
        passId: control.passId,
        timingPolicy: config.timingPolicy,
        geometry: {
          sampleRate: value.sampleRate,
          vectorSize: value.vectorSize,
          tempoBpm: value.tempoBpm,
          startBeat: value.startBeat,
          endBeat: value.endBeat,
        },
      });
    }
    if (control.action === "arm") armed = control;
    Object.assign(listener, {
      phase:
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "idle",
      jobId: control.jobId,
      passId: control.passId,
    });
    return {
      type: "listener.reply",
      protocolVersion: 1,
      listenerVersion: 2,
      requestId: `synthetic-v2-control-${sequence}`,
      sequence: sequence++,
      connectionEpoch: listener.registration.connectionEpoch,
      jobId: control.jobId,
      passId: control.passId,
      traceId: control.traceId,
      correlationId: control.correlationId,
      causationId: control.causationId,
      status:
        control.action === "prepare"
          ? "ready"
          : control.action === "arm"
            ? "armed"
            : "cancelled",
      ...(control.action === "arm" && data
        ? { nativeArm: data.proof.armed }
        : {}),
    };
  });
  f.startListeningPlayback.mockImplementation(async (input) => {
    const control = armed;
    const captured = data;
    if (!control || !captured)
      throw new Error("Synthetic playback before native arm");
    expect(input.expectedProjectRevision).toBe(nativeState.revision);
    f.log.push("start");
    nativeState.playing = true;
    const publish = (patch: Partial<ListenerResultV2>) => {
      const result: ListenerResultV2 = {
        type: "listener.result",
        protocolVersion: 1,
        listenerVersion: 2,
        requestId: `synthetic-v2-result-${sequence}`,
        sequence: sequence++,
        connectionEpoch: listener.registration.connectionEpoch,
        jobId: control.jobId,
        passId: control.passId,
        traceId: control.traceId,
        correlationId: control.correlationId,
        causationId: control.causationId,
        status: "progress",
        ...patch,
      };
      for (const callback of subscribers)
        callback({
          connectionId: listener.connectionId,
          producer: listener.producer,
          binding: listener.binding,
          result,
        });
    };
    publish({ nativeLaunch: captured.proof.launched });
    publish({
      status: "completed",
      nativeCapture: captured.proof,
      observation: captured.observation,
    });
    Object.assign(listener, { phase: "idle" });
    return {
      schemaVersion: 1,
      mode: "arrangement",
      cleanupPolicy: "leave-running",
      startedAtBeat: input.range.startBeat,
      sourceOnset: "unverified",
    };
  });
  const options: ListeningRuntimeHostOptions = {
    resolveOwner: f.options.resolveOwner,
    resolveRepository: f.options.resolveRepository,
    onChange: f.options.onChange!,
  };
  return {
    ...f,
    position,
    nativeState,
    subscribers,
    options,
    request: {
      ...request,
      startBeat: geometry.startBeat,
      endBeat: geometry.endBeat,
      maximumDurationMs: 60_000,
    },
    host: (override = options) => f.host(true, override),
    data: () => data,
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
  it("admits a blocked v2 producer only for fresh per-pass proof without promoting readiness", async () => {
    const f = descriptiveProductionFixture();
    const status = f.inventory[0]!.registration.nativeStatus!;
    Object.assign(status, {
      readiness: "BLOCKED",
      reason: "fresh_per_pass_native_validation_required",
    });
    const before = structuredClone(status);
    const result = await run(f.host(), f.request);
    expect(result.stage, result.error).toBe("completed");
    expect(f.position).toHaveBeenCalledOnce();
    expect(f.startListeningPlayback).toHaveBeenCalledOnce();
    expect(f.publications).toHaveLength(1);
    expect(status).toEqual(before);
    expect(f.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it.each(["unsupported_native_dsp", "real_live_timing_validation_required"])(
    "denies blocked v2 reason %s before positioning or reservation",
    async (reason) => {
      const f = descriptiveProductionFixture();
      Object.assign(f.inventory[0]!.registration.nativeStatus!, {
        readiness: "BLOCKED",
        reason,
      });
      const result = await run(f.host(), f.request);
      expect(result.stage).toBe("failed");
      expect(f.position).not.toHaveBeenCalled();
      expect(f.reservePass).not.toHaveBeenCalled();
      expect(f.service.requestListenerControl).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
      expect(f.publications).toEqual([]);
    },
  );

  it("discloses assumed rather than proven tempo stability before v2 playback", async () => {
    const f = descriptiveProductionFixture();
    const result = await f
      .host()
      .executeListeningOperation({ action: "inspect-listeners" }, context);
    expect(result).toMatchObject({
      action: "inspect-listeners",
      listeners: [{ ready: false }],
    });
    if (!("listeners" in result))
      throw new Error("Expected listener inventory");
    expect(result.listeners[0]?.limitations).toContain(
      "constant_tempo_assumed_not_independently_verified",
    );
    expect(result.listeners[0]?.limitations).toContain(
      "tempo_automation_unsupported",
    );
    expect(f.position).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
  });

  it("defaults to descriptive v2, positions before arm, and preserves fractional requested versus measured ranges", async () => {
    const f = descriptiveProductionFixture();
    const result = await run(f.host(), f.request);
    expect(result.stage, result.error).toBe("completed");
    expect(f.position).toHaveBeenCalledOnce();
    expect(f.log.indexOf("reserve")).toBeLessThan(f.log.indexOf("position"));
    expect(f.log.indexOf("position")).toBeLessThan(f.log.indexOf("prepare"));
    expect(f.log.indexOf("arm")).toBeLessThan(f.log.indexOf("start"));
    expect(f.subscribers.size).toBe(0);
    expect(f.nativeState.playing).toBe(true);
    expect(f.publications[0]!.entries[0]).toMatchObject({
      kind: "audio-observation/v2",
      payload: {
        startBeat: 5.25,
        endBeat: 9.5,
        sampleRate: 44_100,
        alignment: {
          policy: { mode: "descriptive", maxClockDisagreementSamples: 64 },
          vectorSize: 128,
          alignment: "approximate",
          intendedUse: "descriptive-only",
          estimatedAbsoluteErrorSamples: null,
          verifiedAbsoluteErrorBoundSamples: null,
        },
      },
    });
    expect(f.data()!.proof.armed.geometry.endBeat).toBe(9.50001);
    for (const stage of ["source-positioning", "positioned-inspection"]) {
      const lifecycle = f.events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "name" in event &&
          typeof event.name === "string" &&
          event.name.startsWith(`listening.runtime.${stage}.`),
      );
      expect(lifecycle).toMatchObject([
        {
          name: `listening.runtime.${stage}.queued`,
          sessionId: "session",
          trace: { traceId: context.trace.traceId },
          correlationId: context.trace.correlationId,
        },
        { name: `listening.runtime.${stage}.started` },
        {
          name: `listening.runtime.${stage}.completed`,
          outcome: "success",
        },
      ]);
      expect(lifecycle.at(-1)).toHaveProperty("durationMs", expect.any(Number));
    }
  });

  it.each([
    [0.1, 1],
    [0.1 + 1 / 48_000, 2],
    [30, 300],
  ])(
    "accepts %s native seconds with exactly %s windows, including a one-sample tail",
    async (seconds, windows) => {
      const f = descriptiveProductionFixture({
        sampleRate: 48_000,
        vectorSize: 64,
        tempoBpm: 100,
        startBeat: 3.125,
        endBeat: 3.125 + (seconds * 100) / 60,
      });
      const result = await run(f.host(), f.request);
      expect(result.stage, result.error).toBe("completed");
      expect(f.data()!.observation.samples).toHaveLength(windows);
      expect(f.data()!.proof.envelopeWindows.at(-1)?.[0]).toBe(
        f.data()!.proof.armed.armCounter + 512 + Math.round(seconds * 48_000),
      );
    },
  );

  it.each([9.50001, 9.50003])(
    "preserves requested end %s separately from either direction of sample quantization",
    async (endBeat) => {
      const f = descriptiveProductionFixture({
        sampleRate: 44_100,
        vectorSize: 128,
        tempoBpm: 127.5,
        startBeat: 5.25,
        endBeat,
      });
      const result = await run(f.host(), f.request);
      expect(result.stage, result.error).toBe("completed");
      const pass = f.publications[0]!.pass;
      if (pass.actualRange === null)
        throw new Error("Expected actual capture range");
      expect(pass.requestedRange).toEqual({ startBeat: 5.25, endBeat });
      expect(pass.actualRange).toEqual({
        startBeat: 5.25,
        endBeat: f.data()!.observation.endBeat,
      });
      expect(pass.actualRange.endBeat).not.toBe(endBeat);
      const signedDifference =
        ((pass.actualRange.endBeat - endBeat) * 44_100 * 60) / 127.5;
      expect(Math.abs(signedDifference)).toBeLessThanOrEqual(0.5);
      expect(signedDifference > 0).toBe(endBeat === 9.50003);
    },
  );

  it("freezes the live preference once per pass and retains the accepted policy through publication", async () => {
    const f = descriptiveProductionFixture();
    const preference = {
      mode: "descriptive" as const,
      maxClockDisagreementSamples: 64,
    };
    const resolveTimingPolicy = vi.fn(() => preference);
    f.nativeState.onPosition = () => {
      preference.maxClockDisagreementSamples = 0;
    };
    const result = await run(
      f.host({ ...f.options, resolveTimingPolicy }),
      f.request,
    );
    expect(result.stage, result.error).toBe("completed");
    expect(resolveTimingPolicy).toHaveBeenCalledOnce();
    expect(
      f.data()!.observation.alignment.policy.maxClockDisagreementSamples,
    ).toBe(64);
    expect(preference.maxClockDisagreementSamples).toBe(0);
  });

  it.each([64, 65])(
    "independently accepts only observed clock disagreement within the frozen 64-sample budget (%s)",
    async (disagreement) => {
      const f = descriptiveProductionFixture();
      const original = f.startListeningPlayback.getMockImplementation()!;
      f.startListeningPlayback.mockImplementation(async (input) => {
        const data = f.data()!;
        for (const row of data.proof.after.frames) {
          row[2] += disagreement;
          row[9] += disagreement;
        }
        const launch = data.proof.launched.host;
        const counter = data.proof.armed.armCounter + 512 + 640;
        data.proof.timingWitnesses.minBeatOrigin = [
          1,
          launch.beat,
          launch.sample,
          launch.flags,
          counter,
          launch.beat - Math.floor(launch.beat),
          counter,
          1,
          launch.beat,
          launch.sample,
          launch.flags,
        ];
        data.proof.timingWitnesses.maxHostOffset = [
          ...data.proof.after.frames[0]!,
        ];
        data.proof.timingWitnesses.maxBeatOrigin = [
          ...data.proof.after.frames[0]!,
        ];
        data.proof.timingWitnesses.maxPhaseDisagreement = [
          ...data.proof.after.frames[0]!,
        ];
        data.observation.alignment.observedClockDisagreementSamples = Math.min(
          disagreement,
          64,
        );
        data.observation.alignment.observedBeatDisagreementSamples = Math.min(
          disagreement,
          64,
        );
        return original(input);
      });
      const result = await run(f.host(), f.request);
      expect(result.stage, result.error).toBe(
        disagreement === 64 ? "completed" : "failed",
      );
      expect(f.publications).toHaveLength(disagreement === 64 ? 1 : 0);
      expect(f.nativeState.playing).toBe(true);
      expect(f.subscribers.size).toBe(0);
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      if (disagreement === 64)
        expect(f.publications[0]!.entries[0]!.payload).toMatchObject({
          alignment: {
            observedClockDisagreementSamples: 64,
            observedBeatDisagreementSamples: 64,
            verifiedAbsoluteErrorBoundSamples: null,
          },
        });
    },
  );

  it("keeps explicit strict v2 descriptive-only rather than fabricating absolute accuracy", async () => {
    const f = descriptiveProductionFixture();
    const result = await run(
      f.host({
        ...f.options,
        resolveTimingPolicy: () => ({
          mode: "strict",
          maxClockDisagreementSamples: 0,
        }),
      }),
      f.request,
    );
    expect(result.stage, result.error).toBe("completed");
    expect(f.data()!.observation.alignment).toMatchObject({
      policy: { mode: "strict", maxClockDisagreementSamples: 0 },
      alignment: "approximate",
      verifiedAbsoluteErrorBoundSamples: null,
    });
  });

  it("does not silently fall back from default descriptive policy to legacy v1", async () => {
    const f = nativeProductionFixture();
    const result = await run(
      f.host(true, {
        resolveOwner: f.options.resolveOwner,
        resolveRepository: f.options.resolveRepository,
      }),
    );
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("descriptive_requires_v2_listener");
    expect(result.error).toContain("Update the listener");
    expect(result.error).toContain("explicitly choose Strict mode");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
  });

  it.each(["tempo", "fingerprint", "vector"] as const)(
    "re-inspects and denies changed %s after positioning without arming or rewinding",
    async (changed) => {
      const f = descriptiveProductionFixture();
      f.nativeState.onPosition = () => {
        if (changed === "tempo") f.nativeState.tempo += 1;
        if (changed === "fingerprint")
          f.nativeState.fingerprint = "b".repeat(64);
        if (changed === "vector") {
          const registration = f.inventory[0]!.registration;
          if (registration.version !== 2)
            throw new Error("Expected v2 fixture");
          registration.vectorSize = 64;
        }
      };
      const result = await run(f.host(), f.request);
      expect(result.stage).toBe("failed");
      expect(f.position).toHaveBeenCalledOnce();
      expect(f.service.requestListenerControl).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
      expect(f.appendPass).not.toHaveBeenCalled();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.nativeState.currentBeat).toBe(5.25);
      expect(f.nativeState.playing).toBe(false);
    },
  );

  it("denies audio longer than 30 seconds before reserving or positioning", async () => {
    const f = descriptiveProductionFixture({
      sampleRate: 48_000,
      vectorSize: 64,
      tempoBpm: 120,
      startBeat: 5.25,
      endBeat: 67.25,
    });
    const result = await run(f.host(), f.request);
    expect(result.stage).toBe("failed");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.position).not.toHaveBeenCalled();
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
  });

  it("redacts a positioning failure, releases reservation, and never starts or arms", async () => {
    const f = descriptiveProductionFixture();
    f.position.mockRejectedValue(
      new Error("position failed token=private-position-secret"),
    );
    const result = await run(f.host(), f.request);
    expect(result.stage).toBe("failed");
    expect(JSON.stringify([result, f.events])).not.toContain(
      "private-position-secret",
    );
    expect(f.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "listening.runtime.source-positioning.failed",
          outcome: "failure",
        }),
      ]),
    );
    expect(
      f.events.find(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "name" in event &&
          event.name === "listening.runtime.source-positioning.failed",
      ),
    ).toHaveProperty("durationMs", expect.any(Number));
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("cancels during admitted positioning without arming, starting, or undoing a late position", async () => {
    const f = descriptiveProductionFixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = f.position.getMockImplementation()!;
    f.position.mockImplementation(async (input) => {
      await pending;
      return original(input);
    });
    const host = f.host();
    const started = await host.executeListeningOperation(f.request, context);
    if (!("job" in started)) throw new Error("Expected pass");
    await vi.waitFor(() => expect(f.position).toHaveBeenCalledOnce());
    await host.executeListeningOperation(
      { action: "cancel", passId: started.job.passId },
      context,
    );
    expect(
      (await host.waitForListeningPass(started.job.passId, context)).stage,
    ).toBe("cancelled");
    finish();
    await vi.waitFor(() => expect(f.nativeState.currentBeat).toBe(5.25));
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "listening.runtime.source-positioning.cancelled",
          outcome: "cancelled",
        }),
      ]),
    );
  });
  it("does not route a negotiated v2 listener through the legacy capture adapter", async () => {
    const f = fixture(2);
    const candidate = f.inventory[1]!;
    candidate.producer.schemaVersion = "audio-observation/v2";
    const registration = listenerRegistrationV2Schema.parse({
      ...candidate.registration,
      version: 2,
      capabilities: ["audio-listener/v2"],
      algorithmVersion: "2.0.0",
      vectorSize: 64,
      nativeStatus: {
        version: 2,
        scope: "arrangement-descriptive/v2",
        readiness: "READY",
        alignment: "approximate",
        verifiedAbsoluteErrorBoundSamples: null,
        acceptedSampleRates: [44_100, 48_000],
        acceptedVectorSizes: [64],
        timingModes: ["descriptive", "strict"],
        maxClockDisagreementSamples: 480,
        maxAudioDurationMs: 30_000,
        maxWindows: 300,
        abiVersion: 2,
      },
    });
    f.inventory[1] = { ...candidate, registration };
    const discovered = await f
      .host(true)
      .executeListeningOperation({ action: "inspect-listeners" }, context);
    expect(discovered).toMatchObject({
      action: "inspect-listeners",
      listeners: [{ listenerId: "listener-0" }, { listenerId: "listener-1" }],
    });
    if (discovered.action !== "inspect-listeners")
      throw new Error("Unexpected discovery result");
    expect(discovered.listeners).toHaveLength(2);
    const result = await run(f.host(true), {
      ...request,
      listenerIds: ["listener-1"],
    });
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("listening_positioning_unavailable");
    expect(f.reservePass).not.toHaveBeenCalled();
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
  });

  it("bounds native preparation to the exact requested canonical window count", async () => {
    const f = nativeProductionFixture();
    const result = await run(f.host(true));
    expect(result.stage, result.error).toBe("completed");
    const prepare = f.service.requestListenerControl.mock.calls.find(
      ([, control]) => control.action === "prepare",
    )?.[1];
    expect(prepare).toMatchObject({
      config: {
        durationMs: 2000,
        maxWindows: 20,
        source: { mode: "arrangement", startBeat: 0, endBeat: 4 },
      },
    });
    expect(f.publications).toHaveLength(1);
  });

  it("projects only beat bounds into every strict bridge inspection range", async () => {
    const f = nativeProductionFixture();
    const result = await run(f.host(true));
    expect(result.stage, result.error).toBe("completed");
    expect(f.inspectListeningContext.mock.calls.length).toBeGreaterThan(1);
    for (const [input] of f.inspectListeningContext.mock.calls) {
      expect(input.range).toEqual({ startBeat: 0, endBeat: 4 });
      expect(() =>
        inspectListeningContextParamsSchema.parse(input),
      ).not.toThrow();
    }
    expect(f.publications).toHaveLength(1);
  });

  it("exact native scope admits only fresh per-pass proof, without promoting registration readiness", async () => {
    const f = nativeProductionFixture();
    const result = await run(f.host(true));
    expect(result.stage, result.error).toBe("completed");
    expect(f.startListeningPlayback).toHaveBeenCalledOnce();
    expect(f.publications).toHaveLength(1);
    expect(f.subscribers.size).toBe(0);
    expect(f.inventory[0]!.registration.nativeStatus).toMatchObject({
      timing: "UNVERIFIED",
      readiness: "BLOCKED",
      scope: NATIVE_LISTENER_SCOPE,
    });
  });

  it("scope metadata alone cannot start playback without genuine armed proof", async () => {
    const f = nativeProductionFixture(false);
    const result = await run(f.host(true));
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("native-arm-proof-required");
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
    expect(f.publications).toEqual([]);
    expect(f.subscribers.size).toBe(0);
  });

  it("invalid native completion after source start cannot publish and releases its reservation", async () => {
    const f = nativeProductionFixture();
    f.data.proof.after.frames[0]![9] += 64;
    const result = await run(f.host(true));
    expect(result.stage).toBe("failed");
    expect(f.startListeningPlayback).toHaveBeenCalledOnce();
    expect(f.publications).toEqual([]);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
  });

  it.each([
    "sample-rate",
    "range-start",
    "range-end",
    "window-grid",
    "mixed",
  ] as const)(
    "denies unsupported native %s before reservation or controls",
    async (failure) => {
      const f = nativeProductionFixture();
      let selected = request;
      if (failure === "sample-rate")
        Object.assign(f.inventory[0]!.registration, { sampleRate: 96000 });
      if (failure === "range-start") selected = { ...request, startBeat: 1 };
      if (failure === "range-end") selected = { ...request, endBeat: 20.2 };
      if (failure === "window-grid") selected = { ...request, endBeat: 0.3 };
      if (failure === "mixed") {
        f.inventory.push(descriptor(1));
        selected = { ...request, listenerIds: ["listener-0", "listener-1"] };
      }
      const result = await run(f.host(true), selected);
      expect(result.stage).toBe("failed");
      expect(f.reservePass).not.toHaveBeenCalled();
      expect(f.service.requestListenerControl).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
      expect(f.publications).toEqual([]);
    },
  );

  it("discovery exposes native preflight eligibility without claiming ready timing", async () => {
    const f = nativeProductionFixture();
    const result = await f
      .host(true)
      .executeListeningOperation({ action: "inspect-listeners" }, context);
    expect(result).toMatchObject({
      action: "inspect-listeners",
      listeners: [
        {
          ready: false,
          limitations: [
            "native_per_pass_validation_required",
            "source_onset_unverified",
          ],
        },
      ],
    });
    expect(f.service.requestListenerControl).not.toHaveBeenCalled();
    expect(f.startListeningPlayback).not.toHaveBeenCalled();
  });

  it.each([
    { field: "tempo" as const, value: 121 },
    { field: "currentBeat" as const, value: 1 },
  ])(
    "denies unsupported native preflight $field before reservation",
    async ({ field, value }) => {
      const f = nativeProductionFixture();
      f.inspectListeningContext.mockImplementation(async (input) => {
        const snapshot = inspection(input);
        return {
          ...snapshot,
          transport: { ...snapshot.transport, [field]: value },
        };
      });
      const result = await run(f.host(true));
      expect(result.stage).toBe("failed");
      expect(f.reservePass).not.toHaveBeenCalled();
      expect(f.service.requestListenerControl).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
    },
  );

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

  it("awaits validated native onset rather than upgrading an unverified bridge acknowledgement", async () => {
    let launch!: () => void;
    const nativeLaunch = new Promise<void>((resolve) => {
      launch = resolve;
    });
    const f = fixture(1, nativeLaunch, "unverified");
    Object.assign(f.inventory[0]!.registration.nativeStatus!, {
      scope: NATIVE_LISTENER_SCOPE,
    });
    const pending = run(f.host());
    await vi.waitFor(() => expect(f.adapter.start).toHaveBeenCalledOnce());
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    launch();
    expect((await pending).stage).toBe("completed");
    expect(f.appendPass).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    const lifecycle = f.events.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "name" in event &&
        String(event.name).startsWith("listening.runtime.native-onset."),
    );

    expect(lifecycle).toMatchObject([
      {
        name: "listening.runtime.native-onset.queued",
        sessionId: "session",
        trace: { traceId: context.trace.traceId },
      },
      { name: "listening.runtime.native-onset.started" },
      { name: "listening.runtime.native-onset.completed", outcome: "success" },
    ]);
  });

  it.each(["missing", "mixed"] as const)(
    "denies unverified playback for a %s native receipt cohort",
    async (cohort) => {
      const f = fixture(
        cohort === "mixed" ? 2 : 1,
        cohort === "mixed" ? Promise.resolve() : undefined,
        "unverified",
      );
      Object.assign(f.inventory[0]!.registration.nativeStatus!, {
        scope: NATIVE_LISTENER_SCOPE,
      });
      const result = await run(f.host(), {
        ...request,
        listenerIds: f.inventory.map((item) => item.producer.producerId),
      });
      expect(result.stage).toBe("failed");
      expect(result.error).toContain("source_onset_unverified");
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.disarm).toHaveBeenCalledOnce();
      expect(f.appendPass).not.toHaveBeenCalled();
    },
  );

  it("native-onset rejection releases only the playback monitor and preserves failure without publication", async () => {
    let rejectLaunch!: (reason: Error) => void;
    const nativeLaunch = new Promise<void>((_resolve, reject) => {
      rejectLaunch = reject;
    });
    const f = fixture(1, nativeLaunch, "unverified");
    Object.assign(f.inventory[0]!.registration.nativeStatus!, {
      scope: NATIVE_LISTENER_SCOPE,
    });
    const pending = run(f.host());
    await vi.waitFor(() => expect(f.adapter.start).toHaveBeenCalledOnce());
    rejectLaunch(new Error("native binding failed token=super-secret-value"));
    const result = await pending;
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("native binding failed");
    expect(JSON.stringify([result, f.events])).not.toContain(
      "super-secret-value",
    );
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it.each(["legacy-promise", "measured-without-native-proof"] as const)(
    "cannot bypass onset proof with %s",
    async (claim) => {
      const f = fixture(
        1,
        claim === "legacy-promise" ? Promise.resolve() : undefined,
        claim === "legacy-promise" ? "unverified" : "measured",
      );
      if (claim !== "legacy-promise")
        Object.assign(f.inventory[0]!.registration.nativeStatus!, {
          scope: NATIVE_LISTENER_SCOPE,
        });
      const result = await run(f.host());
      expect(result.stage).toBe("failed");
      expect(result.error).toContain("source_onset_unverified");
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.disarm).toHaveBeenCalledOnce();
      expect(f.appendPass).not.toHaveBeenCalled();
    },
  );

  it("surfaces failed monitor cleanup after native onset denial without retrying or publishing", async () => {
    let rejectLaunch!: (reason: Error) => void;
    const f = fixture(
      1,
      new Promise<void>((_resolve, reject) => {
        rejectLaunch = reject;
      }),
      "unverified",
    );
    Object.assign(f.inventory[0]!.registration.nativeStatus!, {
      scope: NATIVE_LISTENER_SCOPE,
    });
    f.release.mockRejectedValue(
      new Error("monitor release failed token=super-secret-value"),
    );
    const pending = run(f.host());
    await vi.waitFor(() => expect(f.adapter.start).toHaveBeenCalledOnce());
    rejectLaunch(new Error("native binding rejected"));
    const result = await pending;
    expect(result.stage).toBe("failed");
    expect(result.error).toContain(
      "Native onset failed and playback monitor release failed",
    );
    expect(JSON.stringify([result, f.events])).not.toContain(
      "super-secret-value",
    );
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.disarm).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("bounds hung monitor release after onset denial independently of the caller's cancellation", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadline = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementationOnce((milliseconds) => {
        expect(milliseconds).toBe(listeningLimits.cleanupTimeoutMs);
        return timeout(20);
      });
    try {
      const f = fixture();
      Object.assign(f.inventory[0]!.registration.nativeStatus!, {
        scope: NATIVE_LISTENER_SCOPE,
      });
      f.release.mockImplementation(() => new Promise<void>(() => {}));
      const result = await run(f.host());
      expect(result.stage).toBe("failed");
      expect(result.error).toContain("playback monitor release failed");
      expect(deadline).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.disarm).toHaveBeenCalledOnce();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.appendPass).not.toHaveBeenCalled();
    } finally {
      deadline.mockRestore();
    }
  });

  it("cancels while waiting for native onset and ignores a late receipt without stopping transport", async () => {
    let launch!: () => void;
    const f = fixture(
      1,
      new Promise<void>((resolve) => {
        launch = resolve;
      }),
      "unverified",
    );
    Object.assign(f.inventory[0]!.registration.nativeStatus!, {
      scope: NATIVE_LISTENER_SCOPE,
    });
    const host = f.host();
    const started = await host.executeListeningOperation(request, context);
    if (!("job" in started)) throw new Error("Missing job");
    await vi.waitFor(() =>
      expect(f.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "listening.runtime.native-onset.started",
          }),
        ]),
      ),
    );
    const cancelled = await host.executeListeningOperation(
      { action: "cancel", passId: started.job.passId },
      context,
    );
    expect("job" in cancelled && cancelled.job.stage).toBe("cancelled");
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    launch();
    await Promise.resolve();
    await Promise.resolve();
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
