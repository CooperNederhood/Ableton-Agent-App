import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListeningJob } from "@ableton-agent/application";
import { createInMemorySessionContextStore } from "@ableton-agent/project-state";
import {
  PROTOCOL_VERSION,
  metricAudioObservationSchema,
  type InspectListeningContextParams,
  type InspectListeningContextResult,
  type InspectSessionListeningSourceParams,
  type InspectSessionListeningSourceResult,
  type SessionListeningPassParams,
  type SessionListeningPassResult,
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
const hosts: ConcreteListeningRuntimeHost[] = [];
const stores: Awaited<ReturnType<typeof createInMemorySessionContextStore>>[] =
  [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function fixture(
  kind: "midi" | "warped-audio" = "midi",
  partial = false,
  completeOnLaunch = true,
  enabled = true,
  stopped?: { anchor: number; clipQuantization: number; remembered: boolean },
) {
  const data = createSyntheticMetricWireFixture(
    "session",
    partial,
    stopped
      ? {
          tempoBpm: 128,
          startBeat: 0,
          stoppedBeat: stopped.anchor,
          endBeat: 4,
        }
      : false,
  );
  const log: string[] = [];
  const jobs: ListeningJob[] = [];
  let playing = false;
  const anchor = stopped?.anchor ?? 0;
  const durationBeats =
    data.config.geometry.endBeat - data.config.geometry.startBeat;
  const tempo = data.config.geometry.tempoBpm;
  const listener: ListenerDescriptor = {
    connectionId: data.wire.connectionId,
    producer: {
      producerId: "listener-0",
      instanceId: "synthetic-instance",
      displayName: "Synthetic listener; not physical DSP evidence",
      signalKind: "audio",
      schemaVersion: "metric-audio-observation/v1",
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
    log.push(`native:${action}`),
  );
  const requestListenerControl = vi.fn(
    peer.service.requestListenerControl.bind(peer.service),
  );
  const service = { ...peer.service, requestListenerControl };
  const sourceState = (): InspectSessionListeningSourceResult["after"] => ({
    transportPlaying: playing,
    globalBeat: playing ? 0.2 : anchor,
    startTimeBeats: playing ? 0 : stopped?.remembered ? 0 : null,
    playingPosition: playing ? 0.2 : 0,
    targetPlaying: playing || stopped?.remembered === true,
    targetTriggered: false,
    targetRecording: false,
    playingSlotIndex: playing || stopped?.remembered === true ? 0 : -1,
    firedSlotIndex: -1,
    selectedClipReference: target.expectedClipReference,
  });
  const inspectSessionListeningSource = vi.fn(
    async (
      params: InspectSessionListeningSourceParams,
    ): Promise<InspectSessionListeningSourceResult> => {
      log.push("source");
      return {
        ...params,
        projectRevision: 1,
        evidence: "message-rate-only",
        nativeAlignment: "unverified",
        sourceKind: kind,
        positionUnit: "beats",
        before: sourceState(),
        after: sourceState(),
        settings: {
          tempoBpm: tempo,
          signatureNumerator: 4,
          signatureDenominator: 4,
          globalQuantization: stopped ? 4 : 0,
          launchQuantization: stopped?.clipQuantization ?? 0,
          launchMode: 0,
          legato: false,
          followActionEnabled: null,
          startMarker: 0,
          endMarker: 8,
          loopStart: 0,
          loopEnd: 8,
          looping: true,
        },
      };
    },
  );
  const inspectListeningContext = vi.fn(
    async (
      params: InspectListeningContextParams,
    ): Promise<InspectListeningContextResult> => ({
      schemaVersion: 1,
      bindingScope: "live-connection",
      bindingQueryId: params.bindingQueryId,
      projectRevision: 1,
      transport: {
        playing,
        currentBeat: anchor,
        tempo,
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
            expectedDeviceName: "Synthetic listener",
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
    }),
  );
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
      "Synthetic message-rate source evidence; not DSP proof",
      "Follow settings unavailable",
    ],
    durationBeats,
    expiresInMs: 39_000,
  });
  const sessionListeningPass = vi.fn<
    NonNullable<ListeningRuntimeDependencies["ableton"]["sessionListeningPass"]>
  >(async (params) => {
    log.push(`session:${params.action}`);
    if (params.action === "launch") {
      playing = true;
      peer.launch();
      if (completeOnLaunch) peer.complete();
    }
    return receipt(params);
  });
  const repository = await createInMemorySessionContextStore(owner);
  stores.push(repository);
  const appendPass = vi.spyOn(repository, "appendPass");
  const releaseReservation = vi.spyOn(repository, "releaseReservation");
  const stopTransport = vi.fn(async () => {
    throw new Error("Session cleanup must not stop user transport");
  });
  const positionListeningPlayback = vi.fn(async () => {
    throw new Error("Session source must not seek Arrangement");
  });
  const startListeningPlayback = vi.fn(async () => {
    throw new Error("Session source must not use Arrangement playback");
  });
  const dependencies = {
    ableton: {
      getLiveIdentity: vi.fn(async () => ({
        liveSetId: owner.liveSetId,
        liveSetName: "Synthetic Set",
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
      getCapabilities: vi.fn(async () => ({
        selectedProtocolVersion: PROTOCOL_VERSION,
        liveVersion: "11.3.43",
        remoteScriptVersion: "synthetic",
        liveSetId: owner.liveSetId,
        liveSetName: "Synthetic Set",
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
        limits: { maxFrameBytes: 1_048_576, maxBatchItems: 128 },
      })),
      inspectListeningContext,
      inspectSessionListeningSource,
      sessionListeningPass,
      startListeningPlayback,
      positionListeningPlayback,
      stopTransport,
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
  const begin = async (signal?: AbortSignal) => {
    const result = await host.executeListeningOperation(
      {
        action: "play-session-and-listen",
        target,
        listenerIds: [listener.producer.producerId],
        durationBeats,
        maximumDurationMs: 5_000,
      },
      { ...context, ...(signal ? { signal } : {}) },
    );
    if (!("job" in result)) throw new Error("Expected owned Session job");
    return result.job.passId;
  };
  return {
    host,
    log,
    jobs,
    peer,
    repository,
    appendPass,
    releaseReservation,
    requestListenerControl,
    sessionListeningPass,
    inspectSessionListeningSource,
    stopTransport,
    positionListeningPlayback,
    startListeningPlayback,
    receipt,
    begin,
    run: async () => host.waitForListeningPass(await begin(), context),
  };
}

describe("production v5 Session host with synthetic native peer", () => {
  it.each(["midi", "warped-audio"] as const)(
    "publishes the supplied nonzero One Bar %s case without stopping or seeking",
    async (kind) => {
      const anchor = 2.059377861721612;
      const f = await fixture(kind, false, true, true, {
        anchor,
        clipQuantization: kind === "midi" ? 5 : 0,
        remembered: true,
      });
      const job = await f.run();
      expect(job.stage, JSON.stringify({ job, log: f.log })).toBe("completed");
      expect(f.log.indexOf("native:arm")).toBeLessThan(
        f.log.indexOf("session:launch"),
      );
      expect(
        f.sessionListeningPass.mock.calls.filter(
          ([p]) => p.action === "launch",
        ),
      ).toHaveLength(1);
      expect(f.appendPass).toHaveBeenCalledOnce();
      const publication = f.appendPass.mock.calls[0]![0];
      expect(publication.pass.actualRange).toEqual({
        startBeat: 0,
        endBeat: 4,
      });
      expect(publication.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            coverage: {
              coordinate: "clip-local-beats",
              iteration: 0,
              startBeat: 0,
              endBeat: 4,
            },
          }),
          expect.objectContaining({
            coverage: {
              coordinate: "transport-beats",
              startBeat: 0,
              endBeat: 4,
            },
          }),
        ]),
      );
      const observed = metricAudioObservationSchema.parse(
        (await f.repository.getEntry(f.jobs.at(-1)!.contextIds[0]!))?.payload,
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
            expectedRecords: 43,
          },
        },
        source: {
          coordinate: { startBeat: 0, endBeat: 4 },
          transport: { startBeat: 0, endBeat: 4 },
          clipStartTimeBeats: 0,
        },
        geometry: {
          startBeat: 0,
          endBeat: 4,
          totalSamples: 90_000,
        },
      });
      expect(observed.metrics["mel-bands"]?.frames[0]?.magnitudes).toEqual([
        Array(24).fill(0.5),
        Array(24).fill(0.25),
      ]);
      expect(f.log).toContain("session:release");
      expect(f.peer.subscribers.size).toBe(0);
      expect(f.stopTransport).not.toHaveBeenCalled();
      expect(f.positionListeningPlayback).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["midi", false],
    ["midi", true],
    ["warped-audio", false],
    ["warped-audio", true],
  ] as const)(
    "publishes %s partial=%s after source preparation, monitoring and seal",
    async (kind, partial) => {
      const f = await fixture(kind, partial);
      const job = await f.run();
      expect(job.stage, JSON.stringify({ job, log: f.log })).toBe(
        partial ? "partial" : "completed",
      );
      expect(f.log.indexOf("session:prepare")).toBeLessThan(
        f.log.indexOf("native:prepare"),
      );
      expect(f.log.indexOf("native:arm")).toBeLessThan(
        f.log.indexOf("session:launch"),
      );
      expect(f.appendPass).toHaveBeenCalledOnce();
      expect(f.appendPass.mock.calls[0]?.[0].entries[0]?.kind).toBe(
        "metric-audio-observation/v1",
      );
      expect((await f.repository.listEntries({})).items).toHaveLength(1);
      expect(f.jobs.at(-1)?.contextIds).toHaveLength(1);
      expect(f.log).toContain("session:release");
      expect(f.peer.subscribers.size).toBe(0);
      expect(f.releaseReservation).toHaveBeenCalledOnce();
      expect(f.stopTransport).not.toHaveBeenCalled();
      expect(f.positionListeningPlayback).not.toHaveBeenCalled();
      expect(f.startListeningPlayback).not.toHaveBeenCalled();
    },
  );

  it("does not salvage useful partial data after the Session source seal changes", async () => {
    const f = await fixture("midi", true);
    const inspect = f.inspectSessionListeningSource.getMockImplementation()!;
    f.inspectSessionListeningSource.mockImplementation(async (params) => {
      const source = await inspect(params);
      if (f.log.includes("session:launch")) source.settings.loopEnd = 16;
      return source;
    });
    const job = await f.run();
    expect(job.stage).toBe("failed");
    expect(f.jobs.at(-1)?.failureEvidence).toMatchObject({
      code: "session_source_changed",
    });
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.log).toContain("session:release");
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.stopTransport).not.toHaveBeenCalled();
  });

  it("denies disabled qualification without acquiring a source or native capture", async () => {
    const f = await fixture("midi", false, true, false);
    expect((await f.run()).stage).toBe("failed");
    expect(f.sessionListeningPass).not.toHaveBeenCalled();
    expect(f.requestListenerControl).not.toHaveBeenCalled();
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
  });

  it("cancels incomplete native capture and releases the source without stopping transport", async () => {
    const f = await fixture("midi", false, false);
    const abort = new AbortController();
    const passId = await f.begin(abort.signal);
    await vi.waitFor(() => expect(f.jobs.at(-1)?.stage).toBe("capturing"));
    expect(f.appendPass).not.toHaveBeenCalled();
    abort.abort();
    expect((await f.host.waitForListeningPass(passId, context)).stage).toBe(
      "cancelled",
    );
    expect(f.log).toContain("native:cancel");
    expect(f.log).toContain("session:release");
    expect(f.appendPass).not.toHaveBeenCalled();
    expect(f.peer.subscribers.size).toBe(0);
    expect(f.releaseReservation).toHaveBeenCalledOnce();
    expect(f.stopTransport).not.toHaveBeenCalled();
  });
});
