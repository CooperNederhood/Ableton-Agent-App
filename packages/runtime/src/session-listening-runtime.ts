import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ListeningFailure,
  persistListeningObservations,
  reserveListeningPublication,
  type ConnectedListenerBinding,
  type ListeningCoordinatorServices,
  type ListeningExecutionContext,
  type ListeningOwner,
  type ListeningPassContext,
  type ListeningPublicationBinding,
  type ListeningRequest,
} from "@ableton-agent/application";
import { sanitizePersistedText } from "@ableton-agent/observability";
import {
  createNativeListeningGeometry,
  listeningTimingPolicySchema,
  mapSessionAudioObservation,
  sessionAudioObservationSchema,
  type InspectListeningContextResult,
  type InspectSessionListeningSourceResult,
  type ListeningTimingPolicy,
  type NativeListeningGeometry,
  type SessionAudioObservation,
  type StoredAudioObservation,
  type SessionListeningLaunchDetail,
} from "@ableton-agent/protocol";
import type {
  ListenerDescriptor,
  ListenerService,
} from "@ableton-agent/signal-routing";
import type { ListeningRuntimeDependencies } from "./composition.js";
import type { prepareListenerCapture } from "./listening-capture.js";
import {
  assertSessionFirstIterationCoverage,
  assertSessionSourceUnchanged,
  assertTransportCoupledSessionOrigin,
  freezeSessionSourceExpectation,
  type SessionSourceExpectation,
  type SessionSourceOrigin,
} from "./session-listening-source.js";
import { createSessionSourceDriver } from "./session-listening-driver.js";

type SessionRequest = Extract<ListeningRequest, { mode: "session" }>;
type PassInput = Parameters<ListeningCoordinatorServices["prepare"]>[0];
type Repository = Parameters<typeof reserveListeningPublication>[0];
type Range = { startBeat: number; endBeat: number };

export interface SessionBindingSnapshot {
  readonly descriptors: readonly ListenerDescriptor[];
  readonly connections: readonly ConnectedListenerBinding[];
  readonly inspection: InspectListeningContextResult;
}

export interface SessionSourceLease {
  launch(
    signal: AbortSignal,
    onProgress?: (detail: SessionListeningLaunchDetail) => void,
  ): Promise<SessionSourceOrigin>;
  assertCurrent(signal: AbortSignal): Promise<void>;
  seal(signal: AbortSignal): Promise<{
    origin: SessionSourceOrigin;
    source: InspectSessionListeningSourceResult;
  }>;
  release(): Promise<void>;
}

export interface SessionListeningServicesOptions {
  readonly dependencies: ListeningRuntimeDependencies;
  readonly resolveTimingPolicy: () => ListeningTimingPolicy;
  readonly resolveRepository: (input: PassInput) => Promise<Repository>;
  readonly listeners: () => ListenerService;
  readonly inspectBindings: (input: {
    request: SessionRequest;
    range: Range;
    context: ListeningPassContext;
    signal: AbortSignal;
    previous?: SessionBindingSnapshot;
  }) => Promise<SessionBindingSnapshot>;
  readonly prepareCapture: typeof prepareListenerCapture;
  readonly trackSubject: (
    owner: ListeningOwner,
    listener: InspectListeningContextResult["listeners"][number],
    range: Range,
  ) => ListeningPublicationBinding["primary"];
  readonly stage: <T>(
    name: string,
    context: ListeningExecutionContext,
    operation: (progress: (detail: string) => void) => Promise<T>,
    compensate?: (result: T) => Promise<void>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => Promise<T>;
}

interface SessionState extends SessionBindingSnapshot {
  readonly owner: ListeningOwner;
  readonly request: SessionRequest;
  readonly expected: SessionSourceExpectation;
  readonly geometry: Readonly<NativeListeningGeometry>;
  readonly policy: Readonly<ListeningTimingPolicy>;
  readonly createdAt: string;
  reserved: boolean;
  repository?: Repository;
  lease?: SessionSourceLease;
  nativeLaunch?: Promise<void>;
  captureFailure?: Error;
  startedAt?: string;
  endedAt?: string;
  validatedDigest?: string;
  release?: () => Promise<void>;
}

function deny(code: string): never {
  throw new ListeningFailure(code, code);
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function execution(
  pass: ListeningPassContext,
  signal?: AbortSignal,
): ListeningExecutionContext {
  return {
    sessionId: pass.owner.sessionId,
    agentId: pass.owner.agentId,
    actorKind: "agent",
    trace: pass.trace,
    ...(signal ? { signal } : {}),
  };
}

/** Source-specific services share the existing owned-job pipeline and publication transaction. */
export function createSessionListeningServices(
  options: SessionListeningServicesOptions,
) {
  const { dependencies } = options;
  const states = new Map<string, SessionState>();
  const sourceDriver = createSessionSourceDriver(dependencies.ableton);
  const stage = <T>(
    name: string,
    pass: PassInput,
    operation: (progress: (detail: string) => void) => Promise<T>,
    compensate?: (result: T) => Promise<void>,
  ) =>
    options.stage(name, execution(pass, pass.signal), operation, compensate, {
      passId: pass.passId,
      mode: "session",
    });
  const state = (input: ListeningPassContext): SessionState => {
    const cached = states.get(input.passId);
    if (
      !cached ||
      cached.owner.sessionId !== input.owner.sessionId ||
      cached.owner.liveSetId !== input.owner.liveSetId ||
      cached.owner.agentId !== input.owner.agentId
    )
      deny("stale_session_pass");
    return cached;
  };
  const sourceSnapshot = async (
    request: SessionRequest,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (!request.target || !dependencies.ableton.inspectSessionListeningSource)
      deny("session_source_inspection_unavailable");
    const snapshot = await dependencies.ableton.inspectSessionListeningSource({
      schemaVersion: 1,
      queryId: randomUUID(),
      target: request.target,
    });
    signal.throwIfAborted();
    return snapshot;
  };

  const services = {
    async inspect(
      request: ListeningRequest,
      signal: AbortSignal,
      context: ListeningPassContext,
    ) {
      if (
        request.mode !== "session" ||
        !request.target ||
        request.listenerIds.length !== 1
      )
        deny("unsupported_session_request");
      const previous = states.get(context.passId);
      const snapshot = await sourceSnapshot(request, signal);
      const expected =
        previous?.expected ??
        freezeSessionSourceExpectation(
          snapshot,
          request.target,
          request.durationBeats,
        );
      assertSessionSourceUnchanged(expected, snapshot);
      const current = freezeSessionSourceExpectation(
        snapshot,
        request.target,
        request.durationBeats,
      );
      if (current.startBeat !== expected.startBeat)
        deny("session_transport_changed");
      const binding = await options.inspectBindings({
        request,
        range: { startBeat: expected.startBeat, endBeat: expected.endBeat },
        context,
        signal,
        ...(previous ? { previous } : {}),
      });
      const listener = binding.inspection.listeners[0];
      const descriptor = binding.descriptors[0];
      if (
        !listener ||
        !descriptor ||
        binding.descriptors.length !== 1 ||
        descriptor.registration.version !== 3 ||
        listener.binding.track.kind !== "regular" ||
        listener.binding.track.expectedReference !== request.trackReference ||
        listener.binding.track.expectedReference !==
          request.target.track.expectedReference ||
        listener.binding.track.index !== request.target.track.index
      )
        deny("session_same_track_native_listener_required");
      const registration = descriptor.registration;
      if (
        registration.sampleRate !== 44_100 &&
        registration.sampleRate !== 48_000
      )
        deny("unsupported_native_sample_rate");
      if (
        registration.nativeStatus.scope !== "session-transport-coupled/v1" ||
        binding.inspection.transport.playing !== false ||
        !binding.inspection.transport.safeToStart ||
        Object.values(binding.inspection.transport.recording).some(
          (value) => value !== false,
        ) ||
        binding.inspection.transport.tempo !==
          expected.source.settings.tempoBpm ||
        binding.inspection.transport.currentBeat !== expected.startBeat
      )
        deny("session_transport_or_recording_unsafe");
      const policy =
        previous?.policy ??
        Object.freeze(
          listeningTimingPolicySchema.parse(options.resolveTimingPolicy()),
        );
      const geometry =
        previous?.geometry ??
        createNativeListeningGeometry({
          sampleRate: registration.sampleRate,
          vectorSize: registration.vectorSize,
          tempoBpm: binding.inspection.transport.tempo!,
          startBeat: expected.startBeat,
          endBeat: expected.endBeat,
        });
      assertSessionFirstIterationCoverage(expected, geometry);
      const durationMs = Math.ceil(
        (geometry.totalSamples * 1000) / geometry.sampleRate,
      );
      if (durationMs > request.maximumDurationMs) deny("native_capture_quota");
      await sourceDriver.assertAvailable();
      signal.throwIfAborted();
      if (!previous)
        states.set(context.passId, {
          ...binding,
          owner: structuredClone(context.owner),
          request: structuredClone(request),
          expected,
          geometry,
          policy,
          createdAt: new Date().toISOString(),
          reserved: false,
        });
      await previous?.lease?.assertCurrent(signal);
      return {
        liveSetId: context.owner.liveSetId,
        isPlaying: false,
        isRecording: false,
        recordingStateKnown: true,
        identityVerified: true,
      };
    },

    async reservePublication(input: PassInput) {
      const cached = state(input);
      const repository = await options.resolveRepository(input);
      const receipt = await reserveListeningPublication(repository, input);
      cached.repository = repository;
      cached.reserved = true;
      return {
        release: async () => {
          try {
            await receipt.release();
          } finally {
            cached.reserved = false;
          }
        },
      };
    },

    async prepare(input: PassInput) {
      const cached = state(input);
      if (!cached.reserved) deny("context_reservation_required");
      const fresh = await sourceSnapshot(cached.request, input.signal);
      assertSessionSourceUnchanged(cached.expected, fresh);
      cached.lease = await stage(
        "session-source-monitor-preparation",
        input,
        () =>
          sourceDriver.prepare({
            pass: input,
            target: cached.request.target!,
            durationBeats: cached.request.durationBeats,
            expectedProjectRevision: fresh.projectRevision,
            binding: {
              ...cached.inspection.listeners[0]!.binding,
              track: cached.request.target!.track,
            },
            startBeat: cached.expected.startBeat,
          }),
        (lease) => lease.release(),
      );
      const monitorController = new AbortController();
      const captureController = new AbortController();
      const captureSignal = AbortSignal.any([
        input.signal,
        captureController.signal,
      ]);
      const monitorSignal = AbortSignal.any([
        input.signal,
        monitorController.signal,
      ]);
      const lease = cached.lease;
      const monitor = stage(
        "session-source-continuity-monitor",
        input,
        async (progress) => {
          try {
            while (!monitorController.signal.aborted) {
              monitorSignal.throwIfAborted();
              await lease.assertCurrent(monitorSignal);
              progress(
                "Source continuity checked at message rate; between-observation changes remain unverified",
              );
              await delay(100, undefined, { signal: monitorSignal });
            }
          } catch (error) {
            if (!monitorController.signal.aborted || input.signal.aborted)
              throw error;
          }
        },
      );
      const invalidation = new Promise<never>((_resolve, reject) => {
        void monitor.catch(reject);
      });
      let sourceFailure: Error | undefined;
      void invalidation.catch((cause: unknown) => {
        sourceFailure =
          cause instanceof Error
            ? cause
            : new ListeningFailure(
                "session_source_invalid",
                "Session source monitoring failed",
              );
        cached.captureFailure = sourceFailure;
        captureController.abort(sourceFailure);
      });
      let native:
        Awaited<ReturnType<typeof prepareListenerCapture>> | undefined;
      let cleanup: Promise<void> | undefined;
      const release = () =>
        (cleanup ??= (async () => {
          monitorController.abort();
          const results = await Promise.allSettled([
            monitor,
            lease.release(),
            ...(native ? [native.disarm()] : []),
          ]);
          // Monitor failures already invalidate capture; only resource-release failures are cleanup errors.
          const errors: unknown[] = [];
          results.forEach((result, index) => {
            if (index > 0 && result.status === "rejected")
              errors.push(result.reason);
          });
          if (errors.length)
            throw new AggregateError(
              errors,
              "Session listener/source cleanup failed; playback was left running",
            );
        })());
      cached.release = release;
      try {
        native = await options.prepareCapture(options.listeners(), {
          listeners: cached.descriptors,
          config: {
            geometry: cached.geometry,
            timingPolicy: cached.policy,
            source: {
              mode: "session",
              synchronization: "transport-coupled-first-iteration",
              target: cached.request.target!,
            },
          },
          passId: input.passId,
          trace: input.trace,
          signal: captureSignal,
          ...(dependencies.telemetry
            ? { telemetry: dependencies.telemetry }
            : {}),
        });
        void native.result.catch((cause: unknown) => {
          cached.captureFailure =
            cause instanceof Error
              ? cause
              : new ListeningFailure(
                  "capture_failed",
                  "Native Session capture failed",
                );
        });
        if (!native.nativeLaunch) deny("session_native_launch_proof_required");
        cached.nativeLaunch = native.nativeLaunch;
        const sealedObservations = native.result.then(async (raw) => {
          const seal = await stage("session-source-seal", input, () =>
            lease.seal(captureSignal),
          );
          assertSessionSourceUnchanged(cached.expected, seal.source);
          assertTransportCoupledSessionOrigin(cached.expected, seal.origin);
          const mapped = raw.map((observation): SessionAudioObservation => {
            if (observation.schema !== "audio-observation/v2")
              deny("invalid_session_native_observation");
            const kind = cached.expected.source.sourceKind;
            if (kind !== "midi" && kind !== "warped-audio")
              deny("unsupported_session_source");
            return mapSessionAudioObservation(
              {
                ...observation,
                limitations: [
                  ...new Set([
                    ...observation.limitations,
                    ...cached.expected.limitations,
                  ]),
                ],
              },
              {
                view: "session",
                target: cached.request.target!,
                kind,
                coordinate: {
                  unit: "beats",
                  iteration: 0,
                  startBeat: 0,
                  endBeat: observation.endBeat - cached.expected.startBeat,
                },
                transport: {
                  startBeat: observation.startBeat,
                  endBeat: observation.endBeat,
                },
                origin: {
                  evidence: "message-rate-start-time-with-native-transport",
                  clipStartTimeBeats: seal.origin.clipStartTimeBeats,
                  observedAtGlobalBeat: seal.origin.observedAtGlobalBeat,
                },
                continuity: {
                  evidence: "message-rate-monitored",
                  followActions: cached.expected.followActions,
                },
              },
            );
          });
          cached.validatedDigest = digest(mapped);
          return mapped;
        });
        const observations = Promise.race([sealedObservations, invalidation]);
        void observations.catch((cause: unknown) => {
          cached.captureFailure =
            cause instanceof Error
              ? cause
              : new ListeningFailure(
                  "capture_failed",
                  "Session source sealing failed",
                );
        });
        return { observations, disarm: release };
      } catch (error) {
        const failure = sourceFailure ?? error;
        try {
          await release();
        } catch (cleanupError) {
          throw new AggregateError(
            [failure, cleanupError],
            "Session preparation and cleanup failed",
          );
        }
        throw failure;
      }
    },

    async startPlayback(
      input: Parameters<ListeningCoordinatorServices["startPlayback"]>[0],
    ) {
      const cached = state(input);
      input.signal.throwIfAborted();
      if (!cached.reserved || !cached.lease || !cached.nativeLaunch)
        deny("session_not_prepared");
      if (cached.captureFailure) throw cached.captureFailure;
      const origin = await stage("session-launch", input, () =>
        cached.lease!.launch(input.signal, input.onSessionLaunch),
      );
      assertTransportCoupledSessionOrigin(cached.expected, origin);
      await stage("session-native-onset", input, () => cached.nativeLaunch!);
      input.onSessionLaunch?.({
        state: "verified",
        mutationState: "observed-playing",
      });
      cached.startedAt = new Date().toISOString();
      return {
        cleanupPolicy: "leave-running" as const,
        release: () => cached.release!(),
      };
    },

    validateObservations(
      observations: readonly StoredAudioObservation[],
      request: ListeningRequest,
      passId: string,
    ) {
      const cached = states.get(passId);
      if (
        !cached ||
        request.mode !== "session" ||
        cached.captureFailure ||
        !cached.startedAt ||
        digest(observations) !== cached.validatedDigest
      )
        deny("invalid_session_capture_observation");
      if (observations.length !== 1)
        deny("invalid_session_capture_observation");
      const item = sessionAudioObservationSchema.parse(observations[0]);
      if (
        item.passId !== passId ||
        item.listenerId !== cached.request.listenerIds[0] ||
        item.sampleRate !== cached.geometry.sampleRate ||
        item.endSample - item.startSample !== cached.geometry.totalSamples ||
        item.source.transport.startBeat !== cached.geometry.startBeat ||
        item.source.transport.endBeat !==
          cached.geometry.startBeat +
            cached.geometry.totalSamples /
              ((cached.geometry.sampleRate * 60) / cached.geometry.tempoBpm)
      )
        deny("invalid_session_capture_geometry");
      cached.endedAt = new Date().toISOString();
    },

    async persist(
      input: Parameters<ListeningCoordinatorServices["persist"]>[0],
    ) {
      const cached = state(input);
      const repository = await options.resolveRepository(input);
      if (
        !cached.reserved ||
        cached.captureFailure ||
        cached.repository !== repository ||
        !cached.startedAt ||
        !cached.endedAt
      )
        deny("invalid_publication_lifecycle");
      const listener = cached.inspection.listeners[0]!;
      const target = cached.request.target!;
      const inspectedTrack = options.trackSubject(input.owner, listener, {
        startBeat: cached.expected.startBeat,
        endBeat: cached.expected.endBeat,
      });
      if (
        inspectedTrack.kind !== "track" ||
        !inspectedTrack.binding.previousRuntimeBindings.includes(
          target.track.expectedReference,
        )
      )
        deny("session_same_track_native_listener_required");
      const trackId = inspectedTrack.id;
      const contributor = {
        ...inspectedTrack,
        trackId,
        binding: {
          ...inspectedTrack.binding,
          semanticLocator: {
            ...inspectedTrack.binding.semanticLocator,
            trackId,
          },
        },
      };
      const binding: ListeningPublicationBinding["primary"]["binding"] = {
        version: 1,
        semanticLocator: {
          name: sanitizePersistedText(target.expectedClipName).slice(0, 128),
          trackId,
          sceneIndex: target.sceneIndex,
        },
        sourceIdentity: `live-connection:${target.expectedClipReference}`,
        playbackSettingsHash: cached.expected.fingerprint,
        upstreamProcessingHash: listener.fingerprint.digest,
        routingHash: digest({
          scope: "unknown",
          reasons: listener.unknownReasons,
        }),
        dependencyScope: "unknown",
        previousRuntimeBindings: [target.expectedClipReference],
      };
      const primary: ListeningPublicationBinding["primary"] = {
        id: digest({
          sessionId: cached.owner.sessionId,
          liveSetId: cached.owner.liveSetId,
          target,
          trackId,
          binding,
        }),
        sessionId: input.owner.sessionId,
        liveSetId: input.owner.liveSetId,
        kind: "clip",
        location: "session",
        trackId,
        binding,
      };
      return persistListeningObservations(
        repository,
        {
          passId: input.passId,
          owner: input.owner,
          trace: input.trace,
          requestedMode: "session",
          actualMode: "session",
          requestedRange: {
            startBeat: 0,
            endBeat: cached.request.durationBeats,
          },
          createdAt: cached.createdAt,
          startedAt: cached.startedAt,
          endedAt: cached.endedAt,
          observations: input.observations,
          bindings: [
            {
              listenerId: cached.request.listenerIds[0]!,
              deviceReference: listener.binding.expectedDeviceReference,
              connectionEpoch: cached.connections[0]!.connectionEpoch,
              version: cached.descriptors[0]!.registration.algorithmVersion,
              primary,
              contributors: [contributor],
              attribution: "unknown",
            },
          ],
        },
        input.signal,
      );
    },
  } satisfies ListeningCoordinatorServices;

  return {
    services,
    forget: (passId: string) => {
      states.delete(passId);
    },
    shutdown: async () => {
      const results = await Promise.allSettled(
        [...states.values()].map(
          (cached) => cached.release?.() ?? Promise.resolve(),
        ),
      );
      states.clear();
      const errors: unknown[] = [];
      results.forEach((result) => {
        if (result.status === "rejected") errors.push(result.reason);
      });
      if (errors.length)
        throw new AggregateError(errors, "Session source shutdown failed");
    },
  };
}
