import { afterEach, describe, expect, it, vi } from "vitest";
import { currentCorrelationContext } from "@ableton-agent/correlation";
import { listeningLimits, type ListeningJob } from "@ableton-agent/application";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { createInMemorySessionContextStore } from "@ableton-agent/project-state";
import {
  PROTOCOL_VERSION,
  sessionListeningJobDetailSchema,
  type InspectListeningContextParams,
  type InspectListeningContextResult,
  type InspectSessionListeningSourceParams,
  type InspectSessionListeningSourceResult,
  type SessionListeningPassParams,
  type SessionListeningPassResult,
} from "@ableton-agent/protocol";
import { createSyntheticNativeSessionListeningFixture } from "@ableton-agent/protocol/testing";
import {
  listenerRegistrationSessionSchema,
  type ListenerDescriptor,
  type ListenerResultEvent,
  type ListenerResultSession,
  type ListenerService,
  type VersionedListenerControlInput,
  type VersionedListenerReply,
} from "@ableton-agent/signal-routing";
import type { ListeningRuntimeDependencies } from "./composition.js";
import {
  createListeningRuntimeHost,
  type ConcreteListeningRuntimeHost,
  type ListeningRuntimeHostOptions,
} from "./listening-runtime-host.js";

type Repository = Awaited<
  ReturnType<ListeningRuntimeHostOptions["resolveRepository"]>
>;
type Publication = Parameters<Repository["appendPass"]>[0];
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { sessionId: "session", agentId: "agent", liveSetId: "set" };
const context = {
  sessionId: owner.sessionId,
  agentId: owner.agentId,
  actorKind: "agent" as const,
  trace: { traceId: uuid(1), correlationId: "listen", causationId: "caller" },
};
const target = {
  view: "session" as const,
  track: {
    kind: "regular" as const,
    index: 0,
    expectedReference: uuid(10),
    expectedName: "Track",
  },
  sceneIndex: 0,
  expectedClipReference: uuid(30),
  expectedClipName: "Clip",
};
const request = {
  action: "play-session-and-listen" as const,
  target,
  listenerIds: ["listener-0"],
  durationBeats: 4,
  maximumDurationMs: 5000,
};
const hosts: ConcreteListeningRuntimeHost[] = [];
const stores: Repository[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.useRealTimers();
});

function fixture(
  kind: "midi" | "warped-audio" = "midi",
  contextRepository?: Repository,
) {
  let playing = false;
  let durationBeats = request.durationBeats;
  let sequence = -1;
  let armed: VersionedListenerControlInput | undefined;
  let data:
    ReturnType<typeof createSyntheticNativeSessionListeningFixture> | undefined;
  const log: string[] = [];
  const traces: unknown[] = [];
  const publications: Publication[] = [];
  const jobs: ListeningJob[] = [];
  const events: TelemetryEventEnvelope[] = [];
  const subscribers = new Set<(event: ListenerResultEvent) => void>();
  const listener: {
    -readonly [K in keyof ListenerDescriptor]: ListenerDescriptor[K];
  } = {
    connectionId: "connection-0",
    producer: {
      producerId: "listener-0",
      instanceId: "instance-0",
      displayName: "Listener",
      signalKind: "audio",
      schemaVersion: "audio-observation/v2",
      track: { id: "500" },
      device: { id: "600" },
    },
    binding: { trackId: "500", deviceId: "600" },
    registration: listenerRegistrationSessionSchema.parse({
      version: 3,
      connectionEpoch: "epoch-0",
      capabilities: ["audio-listener/session-v1"],
      sampleRate: 48000,
      vectorSize: 64,
      algorithmVersion: "2.0.0",
      deviceCanonicalPath: "live_set tracks 0 devices 0",
      trackCanonicalPath: "live_set tracks 0",
      nativeStatus: {
        version: 3,
        scope: "session-transport-coupled/v1",
        sourceEvidence: "expected-context-only",
        synchronization: "transport-coupled-first-iteration",
        maxDurationBeats: 4,
        readiness: "READY",
        alignment: "approximate",
        verifiedAbsoluteErrorBoundSamples: null,
        acceptedSampleRates: [44100, 48000],
        acceptedVectorSizes: [64],
        timingModes: ["descriptive", "strict"],
        maxClockDisagreementSamples: 480,
        maxAudioDurationMs: 30000,
        maxWindows: 300,
        abiVersion: 2,
      },
    }),
    phase: "idle",
  };
  const sourceState = (): InspectSessionListeningSourceResult["after"] => ({
    transportPlaying: playing,
    globalBeat: playing ? 0.2 : 0,
    startTimeBeats: playing ? 0 : null,
    playingPosition: playing ? 0.2 : 0,
    targetPlaying: playing,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: playing ? 0 : -1,
    firedSlotIndex: -1,
    selectedClipReference: target.expectedClipReference,
  });
  const source = (
    params: InspectSessionListeningSourceParams,
  ): InspectSessionListeningSourceResult => ({
    ...params,
    projectRevision: 1,
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    sourceKind: kind,
    positionUnit: "beats",
    before: sourceState(),
    after: sourceState(),
    settings: {
      tempoBpm: 120,
      signatureNumerator: 4,
      signatureDenominator: 4,
      globalQuantization: 0,
      launchQuantization: 0,
      launchMode: 0,
      legato: false,
      followActionEnabled: null,
      startMarker: 0,
      endMarker: 8,
      loopStart: 0,
      loopEnd: 8,
      looping: true,
    },
  });
  const inspectListeningContext = vi.fn(
    async (
      params: InspectListeningContextParams,
    ): Promise<InspectListeningContextResult> => {
      log.push("binding");
      return {
        schemaVersion: 1,
        bindingScope: "live-connection",
        bindingQueryId: params.bindingQueryId,
        projectRevision: 1,
        transport: {
          playing,
          currentBeat: 0,
          tempo: 120,
          safeToStart: !playing,
          recording: {
            recordMode: false,
            sessionRecord: false,
            arrangementOverdub: false,
            sessionAutomationRecord: false,
          },
        },
        listeners: [
          {
            binding: {
              track: target.track,
              deviceIndex: 0,
              expectedDeviceReference: uuid(20),
              expectedDeviceName: "Listener",
              expectedClassName: "MxDeviceAudioEffect",
            },
            canonicalPath: "live_set tracks 0 devices 0",
            pathAttestation: {
              schemaVersion: 1,
              source: "remote-script-lom",
              canonicalDevicePath: "live_set tracks 0 devices 0",
              canonicalTrackPath: "live_set tracks 0",
              trackReference: target.track.expectedReference,
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
          },
        ],
      };
    },
  );
  const inspectSessionListeningSource = vi.fn(
    async (params: InspectSessionListeningSourceParams) => {
      log.push("source");
      return source(params);
    },
  );
  const capabilities = {
    selectedProtocolVersion: PROTOCOL_VERSION,
    liveVersion: "11.3.43",
    remoteScriptVersion: "test",
    liveSetId: "set",
    liveSetName: "Set",
    saved: true,
    diagnostics: [],
    capabilities: Object.fromEntries(
      [
        "prepare_session_pass",
        "launch_session_pass",
        "inspect_session_pass",
        "release_session_pass",
        "inspect_session_source",
      ].map((name) => [`listening.${name}`, true]),
    ),
    limits: { maxFrameBytes: 1048576, maxBatchItems: 128 },
  };
  const receipt = (
    params: SessionListeningPassParams,
  ): SessionListeningPassResult => ({
    schemaVersion: 1,
    ownerId: params.ownerId,
    passId: params.passId,
    status:
      params.action === "release"
        ? "released"
        : playing
          ? "playing"
          : "prepared",
    mutationState: playing ? "observed-playing" : "not-attempted",
    reason: null,
    cleanupPolicy: "leave-running",
    evidence: "message-rate-only",
    nativeAlignment: "unverified",
    lastObservedSource: sourceState(),
    sourceEpoch: playing
      ? {
          startTimeBeats: 0,
          clipReference: target.expectedClipReference,
          observedGlobalBeat: 0.2,
        }
      : null,
    followActionState: "unknown",
    limitations: [
      "Message-rate source evidence",
      "Follow settings unavailable",
    ],
    durationBeats,
    expiresInMs: 39000,
  });
  const emit = (patch: Partial<ListenerResultSession>) => {
    if (!armed || !data) throw new Error("Result before arm");
    const result: ListenerResultSession = {
      ...context.trace,
      jobId: armed.jobId,
      passId: armed.passId,
      type: "listener.result",
      protocolVersion: 1,
      listenerVersion: 3,
      requestId: `result-${sequence + 1}`,
      sequence: ++sequence,
      connectionEpoch: listener.registration.connectionEpoch,
      status: "progress",
      ...patch,
    };
    for (const subscriber of subscribers)
      subscriber({
        connectionId: listener.connectionId,
        binding: listener.binding,
        producer: listener.producer,
        result,
      });
  };
  const launchNative = () => emit({ nativeLaunch: data!.launch });
  const completeNative = () => {
    emit({
      status: "completed",
      nativeCapture: data!.proof,
      observation: data!.observation,
    });
    listener.phase = "idle";
    delete listener.jobId;
    delete listener.passId;
  };
  const sessionListeningPass = vi.fn<
    NonNullable<ListeningRuntimeDependencies["ableton"]["sessionListeningPass"]>
  >(async (params) => {
    traces.push(currentCorrelationContext());
    log.push(`session:${params.action}`);
    if (params.action === "prepare") durationBeats = params.durationBeats;
    if (params.action === "launch") {
      playing = true;
      launchNative();
      completeNative();
    }
    return receipt(params);
  });
  const service: ListenerService = {
    inspectListeners: () => structuredClone([listener]),
    onListenerResult(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    requestListenerControl: vi.fn<ListenerService["requestListenerControl"]>(
      async (_id, control) => {
        log.push(`native:${control.action}`);
        if (control.action === "prepare") {
          const config = control.config;
          if (!config || !("geometry" in config) || !("source" in config))
            throw new Error("Expected Session config");
          data = createSyntheticNativeSessionListeningFixture({
            listenerId: listener.producer.producerId,
            passId: control.passId,
            source: config.source,
            geometry: {
              sampleRate: config.geometry.sampleRate,
              vectorSize: config.geometry.vectorSize,
              tempoBpm: config.geometry.tempoBpm,
              startBeat: config.geometry.startBeat,
              endBeat: config.geometry.endBeat,
            },
            timingPolicy: config.timingPolicy,
          });
        }
        if (control.action === "arm") armed = control;
        listener.phase =
          control.action === "prepare"
            ? "ready"
            : control.action === "arm"
              ? "armed"
              : "idle";
        if (control.action === "cancel") {
          delete listener.jobId;
          delete listener.passId;
        } else {
          listener.jobId = control.jobId;
          listener.passId = control.passId;
        }
        return {
          ...context.trace,
          jobId: control.jobId,
          passId: control.passId,
          type: "listener.reply",
          protocolVersion: 1,
          listenerVersion: 3,
          requestId: `reply-${sequence + 1}`,
          sequence: ++sequence,
          connectionEpoch: listener.registration.connectionEpoch,
          status:
            control.action === "prepare"
              ? "ready"
              : control.action === "arm"
                ? "armed"
                : "cancelled",
          ...(control.action === "arm" ? { nativeArm: data!.arm } : {}),
        };
      },
    ),
  };
  const reservePass = vi.fn<Repository["reservePass"]>(async () => {
    log.push("reserve");
  });
  const releaseReservation = vi.fn<Repository["releaseReservation"]>(
    async () => {
      log.push("release-reservation");
    },
  );
  const appendPass = vi.fn<Repository["appendPass"]>(async (publication) => {
    log.push("publish");
    publications.push(structuredClone(publication));
  });
  const repository = {
    sessionId: owner.sessionId,
    liveSetId: owner.liveSetId,
    reservePass,
    releaseReservation,
    appendPass,
  } as unknown as Repository;
  const dependencies = {
    ableton: {
      getLiveIdentity: vi.fn(async () => ({
        liveSetId: "set",
        liveSetName: "Set",
        saved: true,
        diagnostics: [],
      })),
      inspectSession: vi.fn(async () => ({
        tracks: [
          {
            index: 0,
            reference: target.track.expectedReference,
            name: "Track",
          },
        ],
        clips: [
          {
            trackReference: target.track.expectedReference,
            sceneIndex: 0,
            reference: target.expectedClipReference,
            name: "Clip",
          },
        ],
      })),
      getCapabilities: vi.fn(async () => capabilities),
      inspectListeningContext,
      inspectSessionListeningSource,
      sessionListeningPass,
      startListeningPlayback: vi.fn(async () => {
        log.push("arrangement-start");
        throw new Error("Unexpected Arrangement start");
      }),
      positionListeningPlayback: vi.fn(async () => {
        log.push("arrangement-position");
        throw new Error("Unexpected seek");
      }),
      stopTransport: vi.fn(async () => {
        throw new Error("Never stop transport");
      }),
    },
    signals: { listeners: service, listenerTransport: service },
    events: { publish: vi.fn(), subscribe: vi.fn(() => () => {}) },
    telemetry: {
      enqueue(event: TelemetryEventEnvelope) {
        events.push(event);
        return true;
      },
    },
  } as unknown as ListeningRuntimeDependencies;
  const options: ListeningRuntimeHostOptions = {
    resolveOwner: vi.fn(async () => owner),
    resolveRepository: vi.fn(async () => contextRepository ?? repository),
    onChange: (job) => {
      jobs.push(job);
    },
  };
  const host = createListeningRuntimeHost(dependencies, options);
  hosts.push(host);
  const begin = async (
    signal?: AbortSignal,
    requestedDurationBeats = request.durationBeats,
  ) => {
    const result = await host.executeListeningOperation(
      { ...request, durationBeats: requestedDurationBeats },
      {
        ...context,
        ...(signal ? { signal } : {}),
      },
    );
    if (!("job" in result)) throw new Error("Expected job");
    return result.job.passId;
  };
  const run = async (requestedDurationBeats = request.durationBeats) =>
    host.waitForListeningPass(
      await begin(undefined, requestedDurationBeats),
      context,
    );
  return {
    host,
    run,
    begin,
    listener,
    service,
    dependencies,
    options,
    receipt,
    source,
    inspectListeningContext,
    inspectSessionListeningSource,
    sessionListeningPass,
    reservePass,
    releaseReservation,
    appendPass,
    repository,
    publications,
    log,
    jobs,
    events,
    traces,
    subscribers,
    launchNative,
    completeNative,
    data: () => data!,
    setPlaying: (value: boolean) => {
      playing = value;
    },
  };
}

describe("shared runtime Session listening", () => {
  it.each(["duration", "processing"] as const)(
    "persists repeated captures with changed %s without overwriting immutable clip history",
    async (change) => {
      const repository = await createInMemorySessionContextStore(owner);
      stores.push(repository);
      const f = fixture("midi", repository);
      const first = await f.run(change === "duration" ? 2 : 4);
      expect(first.stage, first.error).toBe("completed");
      const initialEntries = await repository.listEntries({
        kind: "session-audio-observation/v1",
      });
      expect(initialEntries.items).toHaveLength(1);
      const initialEntry = initialEntries.items[0]!;
      const initialPrimary = (
        await repository.listLinks({ entryId: initialEntry.id })
      ).items.find((link) => link.relationship === "primary")!;
      const initialSubject = await repository.getSubject(
        initialPrimary.subjectId,
      );
      const initialPayload = (await repository.getEntry(initialEntry.id))!
        .payload;
      expect(initialSubject?.kind).toBe("clip");

      f.setPlaying(false);
      if (change === "processing") {
        const inspect = f.inspectListeningContext.getMockImplementation()!;
        f.inspectListeningContext.mockImplementation(async (params) => {
          const snapshot = await inspect(params);
          snapshot.listeners[0]!.fingerprint.digest = "b".repeat(64);
          return snapshot;
        });
      }
      const second = await f.run(4);
      expect(second.stage, second.error).toBe("completed");
      const entries = await repository.listEntries({
        kind: "session-audio-observation/v1",
      });
      expect(entries.items).toHaveLength(2);
      const subsequent = entries.items.find(
        (entry) => entry.id !== initialEntry.id,
      )!;
      const subsequentPrimary = (
        await repository.listLinks({ entryId: subsequent.id })
      ).items.find((link) => link.relationship === "primary")!;
      expect(subsequentPrimary.subjectId).not.toBe(initialPrimary.subjectId);
      expect(await repository.getSubject(initialPrimary.subjectId)).toEqual(
        initialSubject,
      );
      expect((await repository.getEntry(initialEntry.id))?.payload).toEqual(
        initialPayload,
      );

      f.setPlaying(false);
      const third = await f.run(4);
      expect(third.stage, third.error).toBe("completed");
      const repeated = await repository.listEntries({
        kind: "session-audio-observation/v1",
      });
      expect(repeated.items).toHaveLength(3);
      const primaryLinks = (await repository.listLinks()).items.filter(
        (link) => link.relationship === "primary",
      );
      expect(new Set(primaryLinks.map((link) => link.subjectId)).size).toBe(2);
    },
  );

  it("exposes observed rather than verified source launch until native onset validates", async () => {
    const f = fixture();
    f.sessionListeningPass.mockImplementation(async (params) => {
      if (params.action === "launch") f.setPlaying(true);
      return f.receipt(params);
    });
    const passId = await f.begin();
    await vi.waitFor(() =>
      expect(f.jobs.at(-1)?.session?.launch?.state).toBe("observed"),
    );
    const pending = await f.host.executeListeningOperation(
      { action: "get-pass", passId },
      context,
    );
    if (!("job" in pending)) throw new Error("Expected public job");
    expect(sessionListeningJobDetailSchema.parse(pending.job.session)).toEqual({
      clipName: target.expectedClipName,
      trackName: target.track.expectedName,
      sceneIndex: 0,
      durationBeats: 4,
      launch: { state: "observed", mutationState: "observed-playing" },
    });
    expect(pending.job.stage).toBe("starting-playback");
    expect(f.appendPass).not.toHaveBeenCalled();
    f.launchNative();
    f.completeNative();
    expect((await f.host.waitForListeningPass(passId, context)).stage).toBe(
      "completed",
    );
    const completed = await f.host.executeListeningOperation(
      { action: "get-pass", passId },
      context,
    );
    if (!("job" in completed)) throw new Error("Expected public job");
    expect(completed.job.session?.launch).toEqual({
      state: "verified",
      mutationState: "observed-playing",
    });
    const states = [
      ...new Set(
        f.jobs.flatMap((job) =>
          job.session?.launch ? [job.session.launch.state] : [],
        ),
      ),
    ];
    expect(states).toEqual(["requested", "observed", "verified"]);
  });

  it("exposes queued quantized launch through the public job without replaying the mutation", async () => {
    const f = fixture();
    const gate = deferred<SessionListeningPassResult>();
    let launch: SessionListeningPassParams | undefined;
    f.sessionListeningPass.mockImplementation(async (params) => {
      if (params.action === "launch") {
        launch = params;
        return {
          ...f.receipt(params),
          status: "queued",
          mutationState: "indeterminate",
        };
      }
      if (params.action === "inspect" && launch) return gate.promise;
      return f.receipt(params);
    });
    const passId = await f.begin();
    await vi.waitFor(() =>
      expect(f.jobs.at(-1)?.session?.launch?.state).toBe("queued"),
    );
    const publicJob = await f.host.executeListeningOperation(
      { action: "get-pass", passId },
      context,
    );
    if (!("job" in publicJob)) throw new Error("Expected public job");
    expect(
      sessionListeningJobDetailSchema.parse(publicJob.job.session).launch,
    ).toEqual({ state: "queued", mutationState: "indeterminate" });
    f.setPlaying(true);
    gate.resolve(f.receipt(launch!));
    f.launchNative();
    f.completeNative();
    expect((await f.host.waitForListeningPass(passId, context)).stage).toBe(
      "completed",
    );
    expect(
      f.sessionListeningPass.mock.calls.filter(([p]) => p.action === "launch"),
    ).toHaveLength(1);
    expect(f.jobs.at(-1)?.session?.launch?.state).toBe("verified");
  });

  it.each(["midi", "warped-audio"] as const)(
    "publishes %s through real wire3 capture with canonical contributing track identity",
    async (kind) => {
      const f = fixture(kind);
      const job = await f.run();
      expect(
        job.stage,
        JSON.stringify({
          error: job.error,
          log: f.log,
          failures: f.events.filter((e) => e.outcome === "failure"),
        }),
      ).toBe("completed");
      expect(f.publications).toHaveLength(1);
      const publication = f.publications[0]!;
      const primary = publication.subjects.find(
        (item) => item.kind === "clip",
      )!;
      const track = publication.subjects.find((item) => item.kind === "track")!;
      expect(primary.id).toMatch(/^[a-f0-9]{64}$/);
      expect(track.id).toMatch(/^[a-f0-9]{64}$/);
      expect(primary.trackId).toBe(track.id);
      expect(track.trackId).toBe(track.id);
      expect(primary.binding.semanticLocator.trackId).toBe(track.id);
      expect(track.binding.semanticLocator.trackId).toBe(track.id);
      expect(track.id).not.toBe(target.track.expectedReference);
      expect(track.binding.previousRuntimeBindings).toContain(
        target.track.expectedReference,
      );
      expect(primary.binding.previousRuntimeBindings).toContain(
        target.expectedClipReference,
      );
      expect(publication.pass).toMatchObject({
        requestedMode: "session",
        actualMode: "session",
        requestedRange: { startBeat: 0, endBeat: 4 },
        actualRange: { startBeat: 0, endBeat: 4 },
      });
      expect(publication.entries).toHaveLength(1);
      expect(publication.links).toHaveLength(2);
      const entryId = publication.entries[0]!.id;
      expect(entryId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      expect(publication.entries[0]!.passId).toBe(job.passId);
      expect(publication.pass.id).toBe(job.passId);
      expect(publication.links.map((link) => link.subjectId)).toEqual([
        primary.id,
        track.id,
      ]);
      expect(
        publication.links.every(
          (link) =>
            link.entryId === entryId &&
            link.observedContributorIds.length === 1 &&
            link.observedContributorIds[0] === track.id,
        ),
      ).toBe(true);
      const observed = publication.entries[0]!.payload;
      expect(observed).toMatchObject({
        schema: "session-audio-observation/v1",
        startBeat: 0,
        endBeat: 4,
        source: {
          kind,
          transport: { startBeat: 0, endBeat: 4 },
          coordinate: { unit: "beats", iteration: 0, startBeat: 0, endBeat: 4 },
          continuity: { followActions: "unknown" },
        },
      });
      expect(observed.samples.map((p) => p.beat)).toEqual(
        f.data().observation.samples.map((p) => p.beat),
      );
      expect(observed.attacks.map((p) => p.beat)).toEqual(
        f.data().observation.attacks.map((p) => p.beat),
      );
      expect(observed.samples.map((p) => p.sample)).toEqual(
        f.data().observation.samples.map((p) => p.sample),
      );
      expect(f.reservePass).toHaveBeenCalledOnce();
      expect(f.reservePass.mock.calls[0]?.[1]).toBe(2 * 1024 * 1024);
      expect(f.appendPass).toHaveBeenCalledOnce();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.log.indexOf("reserve")).toBeLessThan(
        f.log.indexOf("native:prepare"),
      );
      expect(f.log.indexOf("native:arm")).toBeLessThan(
        f.log.indexOf("session:launch"),
      );
      expect(f.log.indexOf("session:release")).toBeLessThan(
        f.log.indexOf("publish"),
      );
      expect(f.subscribers.size).toBe(0);
      expect(f.log).not.toContain("arrangement-start");
      expect(f.log).not.toContain("arrangement-position");
      expect(
        f.traces.every((item) =>
          JSON.stringify(item).includes(context.trace.traceId),
        ),
      ).toBe(true);
      const lifecycle = f.events.filter((e) =>
        e.name.startsWith("listening.runtime.session-source-seal."),
      );
      expect(lifecycle.map((e) => e.name.split(".").at(-1))).toEqual([
        "queued",
        "started",
        "completed",
      ]);
      expect(
        lifecycle.every(
          (e) =>
            e.sessionId === owner.sessionId &&
            e.activeAgentId === owner.agentId &&
            e.trace?.traceId === context.trace.traceId &&
            e.correlationId === context.trace.correlationId &&
            e.causationId === context.trace.causationId &&
            (e.durationMs ?? -1) >= 0,
        ),
      ).toBe(true);
    },
  );

  it("retains unknown nonexclusive quality for an Operator with 195 parameters inspected under the unchanged 16-parameter bound", async () => {
    const f = fixture();
    const canonicalPath = "live_set tracks 0 devices 1";
    f.listener.registration.deviceCanonicalPath = canonicalPath;
    const parameters = Array.from({ length: 195 }, (_, index) => ({
      reference: uuid(100 + index),
      name: `Operator parameter ${index}`,
      value: index / 195,
    }));
    const original = f.inspectListeningContext.getMockImplementation()!;
    f.inspectListeningContext.mockImplementation(async (params) => {
      const snapshot = await original(params);
      const listener = snapshot.listeners[0]!;
      listener.binding.deviceIndex = 1;
      listener.canonicalPath = canonicalPath;
      listener.pathAttestation!.canonicalDevicePath = canonicalPath;
      listener.pathAttestation!.placement = {
        kind: "track-device",
        deviceIndex: 1,
      };
      listener.upstreamDevices = [
        {
          reference: uuid(40),
          name: "Operator",
          className: "Operator",
          enabled: true,
          parameters: parameters.slice(0, params.maxParameters),
        },
        {
          reference: listener.binding.expectedDeviceReference,
          name: "Listener",
          className: "MxDeviceAudioEffect",
          enabled: true,
          parameters: [],
        },
      ];
      listener.dependenciesTruncated = true;
      listener.unknownReasons = [
        "nonexclusive-audio-tap",
        "routing-dependencies-unverified",
        "automation-unverified",
        "device-hidden-state-unverified",
        "dependency-scan-truncated",
      ];
      listener.fingerprint = {
        ...listener.fingerprint,
        digest: "b".repeat(64),
        completeness: "unknown",
        unknownReasons: listener.unknownReasons,
      };
      expect(listener.upstreamDevices).toHaveLength(
        listener.binding.deviceIndex + 1,
      );
      expect(listener.upstreamDevices[0]!.parameters).toHaveLength(16);
      return snapshot;
    });
    const job = await f.run();
    expect(job.stage, job.error).toBe("completed");
    expect(
      f.inspectListeningContext.mock.calls.every(
        ([params]) => params.maxParameters === 16,
      ),
    ).toBe(true);
    const publication = f.publications[0]!;
    expect(publication.subjects).toHaveLength(2);
    expect(
      publication.subjects.every(
        (subject) =>
          subject.binding.dependencyScope === "unknown" &&
          subject.binding.upstreamProcessingHash === "b".repeat(64),
      ),
    ).toBe(true);
    expect(
      publication.links.every(
        (link) =>
          link.attribution === "unknown" &&
          link.sourceFingerprint.dependencyScope === "unknown" &&
          link.freshness.status === "unknown",
      ),
    ).toBe(true);
    expect(publication.entries[0]!.payload).toMatchObject({
      schema: "session-audio-observation/v1",
      complete: true,
      alignment: {
        alignment: "approximate",
        verifiedAbsoluteErrorBoundSamples: null,
      },
    });
    expect(
      f.sessionListeningPass.mock.calls.filter(([p]) => p.action === "launch"),
    ).toHaveLength(1);
    expect(f.subscribers.size).toBe(0);
  });

  it.each([
    ["midi", 0, 4],
    ["warped-audio", 0, 4],
    ["midi", 4, 0],
    ["warped-audio", 4, 0],
    ["midi", 0.25, 0],
    ["warped-audio", 0.25, 0],
  ] as const)(
    "refuses unqualified %s at beat %s with global quantization %s before acquisition or launch",
    async (kind, globalBeat, globalQuantization) => {
      const f = fixture(kind);
      f.inspectSessionListeningSource.mockImplementation(async (params) => {
        const snapshot = f.source(params);
        snapshot.before.globalBeat = snapshot.after.globalBeat = globalBeat;
        snapshot.settings.globalQuantization = globalQuantization;
        return snapshot;
      });
      const job = await f.run();
      expect(job.stage).toBe("failed");
      expect(job.error).toContain("session_launch_case_unqualified");
      expect(f.reservePass).not.toHaveBeenCalled();
      expect(f.sessionListeningPass).not.toHaveBeenCalled();
      expect(f.log.some((item) => item.startsWith("native:"))).toBe(false);
      expect(f.log).not.toContain("arrangement-position");
      expect(f.appendPass).not.toHaveBeenCalled();
      expect(f.publications).toEqual([]);
      expect(f.subscribers.size).toBe(0);
      const failures = f.events.filter((event) => event.outcome === "failure");
      expect(failures.length).toBeGreaterThan(0);
      expect(
        failures.every(
          (event) =>
            event.trace?.traceId === context.trace.traceId &&
            event.correlationId === context.trace.correlationId,
        ),
      ).toBe(true);
    },
  );

  it("denies quota before acquiring a source monitor or arming", async () => {
    const f = fixture();
    f.reservePass.mockRejectedValueOnce(new Error("quota_exceeded"));
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(job.error).toContain("quota_exceeded");
    expect(f.sessionListeningPass).not.toHaveBeenCalled();
    expect(f.log.some((item) => item.startsWith("native:"))).toBe(false);
    expect(f.appendPass).not.toHaveBeenCalled();
  });

  it("does not expose partial context IDs when atomic append fails", async () => {
    const f = fixture();
    f.appendPass.mockRejectedValueOnce(new Error("atomic append refused"));
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(f.jobs.at(-1)?.contextIds).toEqual([]);
    expect(f.appendPass).toHaveBeenCalledOnce();
    expect(f.publications).toEqual([]);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
  });

  it.each([2, 3, 4])(
    "invalidates changed source settings at inspection %s without publication or relaunch",
    async (boundary) => {
      const f = fixture();
      let calls = 0;
      f.inspectSessionListeningSource.mockImplementation(async (params) => {
        const snapshot = f.source(params);
        if (++calls === boundary) snapshot.settings.loopEnd = 9;
        return snapshot;
      });
      const job = await f.run();
      expect(job.stage).toBe("failed");
      expect(job.error).toContain("session_source_changed");
      expect(f.appendPass).not.toHaveBeenCalled();
      expect(
        f.sessionListeningPass.mock.calls.filter(
          ([p]) => p.action === "launch",
        ),
      ).toHaveLength(boundary === 4 ? 1 : 0);
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.subscribers.size).toBe(0);
    },
  );

  it("never rebinds a replaced source track during post-arm inspection", async () => {
    const f = fixture();
    const original = f.inspectListeningContext.getMockImplementation()!;
    let calls = 0;
    f.inspectListeningContext.mockImplementation(async (params) => {
      const snapshot = await original(params);
      if (++calls === 2) {
        snapshot.listeners[0]!.binding.track.expectedReference = uuid(99);
        snapshot.listeners[0]!.pathAttestation!.trackReference = uuid(99);
      }
      return snapshot;
    });
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(
      f.sessionListeningPass.mock.calls.filter(([p]) => p.action === "launch"),
    ).toHaveLength(0);
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.log).toContain("native:cancel");
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("rejects a different clip launch origin and leaves accepted playback running", async () => {
    const f = fixture();
    f.sessionListeningPass.mockImplementation(async (params) => {
      if (params.action === "launch") {
        f.setPlaying(true);
        f.launchNative();
        f.completeNative();
        const result = f.receipt(params);
        result.sourceEpoch!.startTimeBeats = 0.1;
        return result;
      }
      return f.receipt(params);
    });
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(job.error).toContain("session_native_origin_mismatch");
    expect(f.publications).toEqual([]);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
    expect(
      f.source({ schemaVersion: 1, queryId: uuid(99), target }).after
        .transportPlaying,
    ).toBe(true);
  });

  it("invalidates ongoing capture when a source monitor latches a source change", async () => {
    const f = fixture();
    let launched = false;
    f.sessionListeningPass.mockImplementation(async (params) => {
      if (params.action === "launch") {
        launched = true;
        f.setPlaying(true);
        f.launchNative();
      }
      const result = f.receipt(params);
      if (params.action === "inspect" && launched) {
        result.status = "invalidated";
        result.reason = "source replaced";
      }
      return result;
    });
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(job.error).toContain("source replaced");
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.log).toContain("native:cancel");
    expect(f.subscribers.size).toBe(0);
    expect(
      f.events.some(
        (e) =>
          e.name ===
          "listening.runtime.session-source-continuity-monitor.failed",
      ),
    ).toBe(true);
  });

  it("does not dispatch a launch after native capture has already failed during the final source read", async () => {
    const f = fixture();
    let calls = 0;
    f.inspectSessionListeningSource.mockImplementation(async (params) => {
      if (++calls === 3) {
        f.data().proof.transport.envelopeWindows.pop();
        f.launchNative();
        f.completeNative();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return f.source(params);
    });
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(
      f.sessionListeningPass.mock.calls.filter(([p]) => p.action === "launch"),
    ).toHaveLength(0);
    expect(f.publications).toEqual([]);
  });

  it("invalidates promptly while independent source sealing is still pending", async () => {
    const f = fixture();
    const gate = deferred<InspectSessionListeningSourceResult>();
    let pendingSource: InspectSessionListeningSourceParams | undefined;
    let launched = false;
    let playingChecks = 0;
    f.inspectSessionListeningSource.mockImplementation(async (params) => {
      if (launched) {
        pendingSource = params;
        return gate.promise;
      }
      return f.source(params);
    });
    const original = f.sessionListeningPass.getMockImplementation()!;
    f.sessionListeningPass.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].action === "launch") launched = true;
      if (args[0].action === "inspect" && launched && ++playingChecks > 1) {
        result.status = "invalidated";
        result.reason = "source changed while sealing";
      }
      return result;
    });
    const passId = await f.begin();
    try {
      await vi.waitFor(() => expect(pendingSource).toBeDefined());
      await vi.waitFor(() => expect(f.jobs.at(-1)?.stage).toBe("failed"), {
        timeout: 1000,
      });
      const job = await f.host.waitForListeningPass(passId, context);
      expect(job.error).toContain("source changed while sealing");
      expect(f.publications).toEqual([]);
    } finally {
      if (pendingSource) gate.resolve(f.source(pendingSource));
    }
  });

  it.each(["before-dispatch", "after-dispatch"] as const)(
    "cancels %s without launching again or publishing",
    async (boundary) => {
      const f = fixture();
      const controller = new AbortController();
      const gate = deferred<SessionListeningPassResult>();
      f.sessionListeningPass.mockImplementation(async (params) => {
        if (params.action === "launch") {
          f.setPlaying(true);
          return gate.promise;
        }
        return f.receipt(params);
      });
      if (boundary === "before-dispatch") {
        const original = f.inspectListeningContext.getMockImplementation()!;
        let calls = 0;
        f.inspectListeningContext.mockImplementation(async (params) => {
          if (++calls === 2) controller.abort();
          return original(params);
        });
      }
      const passId = await f.begin(controller.signal);
      if (boundary === "after-dispatch") {
        await vi.waitFor(() =>
          expect(
            f.sessionListeningPass.mock.calls.some(
              ([p]) => p.action === "launch",
            ),
          ).toBe(true),
        );
        controller.abort();
      }
      const job = await f.host.waitForListeningPass(passId, context);
      expect(job.stage).toBe("cancelled");
      expect(f.appendPass).not.toHaveBeenCalled();
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.subscribers.size).toBe(0);
      const launches = f.sessionListeningPass.mock.calls.filter(
        ([p]) => p.action === "launch",
      );
      expect(launches).toHaveLength(boundary === "before-dispatch" ? 0 : 1);
      if (launches[0]) {
        gate.resolve(f.receipt(launches[0][0]));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(f.publications).toEqual([]);
      }
      expect(
        f.jobs.some(
          (snapshot) => snapshot.session?.launch?.state === "verified",
        ),
      ).toBe(false);
    },
  );

  it("times out a pending source launch and compensates without stopping accepted playback", async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.sessionListeningPass.mockImplementation(async (params) => {
      if (params.action === "launch") {
        f.setPlaying(true);
        return new Promise<SessionListeningPassResult>(() => {});
      }
      return f.receipt(params);
    });
    const passId = await f.begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      f.sessionListeningPass.mock.calls.some(([p]) => p.action === "launch"),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(request.maximumDurationMs);
    const job = await f.host.waitForListeningPass(passId, context);
    expect(job.stage).toBe("failed");
    expect(job.error).toContain("total budget");
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
    expect(f.publications).toEqual([]);
  });

  it("compensates a source lease acquired after caller cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const gate = deferred<SessionListeningPassResult>();
    let prepared: SessionListeningPassParams | undefined;
    f.sessionListeningPass.mockImplementation(async (params) => {
      if (params.action === "prepare") {
        prepared = params;
        return gate.promise;
      }
      return f.receipt(params);
    });
    const passId = await f.begin(controller.signal);
    await vi.waitFor(() => expect(prepared).toBeDefined());
    controller.abort();
    expect((await f.host.waitForListeningPass(passId, context)).stage).toBe(
      "cancelled",
    );
    gate.resolve(f.receipt(prepared!));
    await vi.waitFor(() =>
      expect(
        f.sessionListeningPass.mock.calls.filter(
          ([p]) => p.action === "release",
        ),
      ).toHaveLength(1),
    );
    expect(f.log.some((item) => item.startsWith("native:"))).toBe(false);
    expect(f.publications).toEqual([]);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("compensates late quota reservation without acquiring any source or listener resource", async () => {
    const f = fixture();
    const controller = new AbortController();
    const gate = deferred<void>();
    f.reservePass.mockImplementationOnce(() => gate.promise);
    const passId = await f.begin(controller.signal);
    await vi.waitFor(() => expect(f.reservePass).toHaveBeenCalledOnce());
    controller.abort();
    expect((await f.host.waitForListeningPass(passId, context)).stage).toBe(
      "cancelled",
    );
    gate.resolve();
    await vi.waitFor(() => expect(f.releaseReservation).toHaveBeenCalledOnce());
    expect(f.sessionListeningPass).not.toHaveBeenCalled();
    expect(f.log.some((item) => item.startsWith("native:"))).toBe(false);
    expect(f.publications).toEqual([]);
  });

  it("cleans both owners during pending native arm and ignores a late arm acknowledgement", async () => {
    const f = fixture();
    const controller = new AbortController();
    const gate = deferred<VersionedListenerReply>();
    let reply: VersionedListenerReply | undefined;
    const original = f.service.requestListenerControl.bind(f.service);
    vi.spyOn(f.service, "requestListenerControl").mockImplementation(
      async (...args) => {
        const actual = await original(...args);
        if (args[1].action === "arm") {
          reply = actual;
          return gate.promise;
        }
        return actual;
      },
    );
    const passId = await f.begin(controller.signal);
    await vi.waitFor(() => expect(reply).toBeDefined());
    controller.abort();
    expect((await f.host.waitForListeningPass(passId, context)).stage).toBe(
      "cancelled",
    );
    gate.resolve(reply!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      f.sessionListeningPass.mock.calls.filter(([p]) => p.action === "release"),
    ).toHaveLength(1);
    expect(
      f.sessionListeningPass.mock.calls.filter(([p]) => p.action === "launch"),
    ).toHaveLength(0);
    expect(f.log.filter((line) => line === "native:cancel")).toHaveLength(1);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
    expect(f.publications).toEqual([]);
  });

  it("reports indeterminate publication rather than retrying a committed append with a lost acknowledgement", async () => {
    const f = fixture();
    const controller = new AbortController();
    const gate = deferred<void>();
    f.appendPass.mockImplementation(async (publication) => {
      f.publications.push(structuredClone(publication));
      return gate.promise;
    });
    const passId = await f.begin(controller.signal);
    await vi.waitFor(() => expect(f.appendPass).toHaveBeenCalledOnce());
    controller.abort();
    const job = await f.host.waitForListeningPass(passId, context);
    expect(job.stage).toBe("failed");
    expect(job.error).toContain("may have committed");
    expect(f.publications).toHaveLength(1);
    expect(f.jobs.at(-1)?.contextIds).toEqual([]);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.appendPass).toHaveBeenCalledOnce();
    expect(f.releaseReservation).toHaveBeenCalledOnce();
  });

  it("does not publish when resource release fails after capture", async () => {
    const f = fixture();
    const original = f.sessionListeningPass.getMockImplementation()!;
    f.sessionListeningPass.mockImplementation(async (...args) => {
      if (args[0].action === "release")
        throw new Error("release denied token=secret");
      return original(...args);
    });
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(f.publications).toEqual([]);
    expect(job.error).not.toContain("secret");
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
  });

  it("bounds unconfirmed source release and emits cleanup failure", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const original = f.sessionListeningPass.getMockImplementation()!;
    f.sessionListeningPass.mockImplementation(async (...args) => {
      if (args[0].action === "release")
        return new Promise<SessionListeningPassResult>(() => {});
      return original(...args);
    });
    const passId = await f.begin();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(listeningLimits.cleanupTimeoutMs * 3);
    const job = await f.host.waitForListeningPass(passId, context);
    expect(job.stage).toBe("failed");
    expect(job.error).toMatch(/cleanup|release|budget/i);
    expect(f.publications).toEqual([]);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
  });
});
