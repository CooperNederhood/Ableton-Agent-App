import { createHash, randomUUID } from "node:crypto";
import {
  awaitListeningBoundary,
  createListeningHost,
  ListeningFailure,
  listeningLimits,
  persistListeningObservations,
  readConnectedListenerBinding,
  reserveListeningPublication,
  resolveListenerBinding,
  type ConnectedListenerBinding,
  type CopilotAgentServiceOptions,
  type ListeningCoordinatorServices,
  type ListeningExecutionContext,
  type ListeningJob,
  type ListeningOwner,
  type ListeningPassContext,
  type ListeningPublicationBinding,
  type ListeningRequest,
} from "@ableton-agent/application";
import { withCorrelation } from "@ableton-agent/correlation";
import {
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
} from "@ableton-agent/observability";
import {
  audioObservationSchema,
  NATIVE_LISTENER_SCOPE,
  inspectListeningContextResultSchema,
  type InspectListeningContextResult,
  type StartListeningPlaybackParams,
} from "@ableton-agent/protocol";
import {
  recordSignalTelemetry,
  type ListenerDescriptor,
  type ListenerService,
} from "@ableton-agent/signal-routing";
import { prepareListenerCapture } from "./listening-capture.js";
import type {
  ListeningRuntimeDependencies,
  ListeningRuntimeHost,
} from "./composition.js";

type Repository = Parameters<typeof reserveListeningPublication>[0];
type PassInput = Parameters<ListeningCoordinatorServices["prepare"]>[0];
type ContextPorts = Pick<
  CopilotAgentServiceOptions,
  "executeContextOperation" | "getSessionContextInventory"
>;

export interface ListeningRuntimeHostOptions {
  readonly resolveOwner: (
    context: ListeningExecutionContext,
  ) => Promise<ListeningOwner>;
  readonly resolveRepository: (
    owner: ListeningOwner,
    context: ListeningExecutionContext,
  ) => Promise<Repository>;
  /** Existing caller-scoped context ports; no Desktop dependency or raw storage access. */
  readonly contextPorts?: ContextPorts;
  readonly onChange?: (job: ListeningJob) => void;
}

export interface ConcreteListeningRuntimeHost extends ListeningRuntimeHost {
  executeListeningOperation: NonNullable<
    CopilotAgentServiceOptions["executeListeningOperation"]
  >;
  waitForListeningPass: NonNullable<
    CopilotAgentServiceOptions["waitForListeningPass"]
  >;
}

interface CaptureState {
  readonly owner: ListeningOwner;
  readonly request: ListeningRequest & { mode: "arrangement" };
  readonly descriptors: readonly ListenerDescriptor[];
  readonly connections: readonly ConnectedListenerBinding[];
  readonly inspection: InspectListeningContextResult;
  readonly createdAt: string;
  repository?: Repository;
  reserved: boolean;
  startedAt?: string;
  endedAt?: string;
  captureFailure?: string;
  nativeLaunch?: Promise<void>;
}

interface PlaybackResult {
  readonly cleanupPolicy: "leave-running";
  readonly startedAtBeat: number;
  readonly sourceOnset: "measured" | "unverified";
  release(): Promise<void>;
}

/**
 * Explicit test-owned assembly seam, NOT exported from the runtime package.
 * Its readiness check represents independent measured commissioning/onset
 * evidence, not producer READY metadata. Production has no such authority yet.
 */
export interface ListeningRuntimeTestAdapter {
  readonly provenance: "test-owned-certified-adapter";
  assertMeasuredReadiness(
    this: void,
    input: {
      readonly context: ListeningPassContext;
      readonly listeners: readonly ListenerDescriptor[];
      readonly inspection: InspectListeningContextResult;
      readonly signal: AbortSignal;
    },
  ): Promise<void>;
  prepare: typeof prepareListenerCapture;
  start(
    this: void,
    params: StartListeningPlaybackParams,
    signal: AbortSignal,
  ): Promise<PlaybackResult>;
}

interface RuntimeAdapter {
  assertReadiness: ListeningRuntimeTestAdapter["assertMeasuredReadiness"];
  prepare: typeof prepareListenerCapture;
  start: ListeningRuntimeTestAdapter["start"];
}

function deny(code: string): never {
  throw new ListeningFailure(code, code);
}

function execution(
  context: ListeningPassContext,
  signal: AbortSignal,
): ListeningExecutionContext {
  return {
    sessionId: context.owner.sessionId,
    agentId: context.owner.agentId,
    trace: context.trace,
    actorKind: "agent",
    signal,
  };
}

function sameOwner(a: ListeningOwner, b: ListeningOwner): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.agentId === b.agentId &&
    a.liveSetId === b.liveSetId
  );
}

function captureDuration(
  request: ListeningRequest & { mode: "arrangement" },
  inspection: InspectListeningContextResult,
): number {
  const tempo = inspection.transport.tempo;
  if (tempo === null) deny("tempo_unknown");
  const duration = Math.ceil(
    ((request.endBeat - request.startBeat) * 60000) / tempo,
  );
  if (duration < 1 || duration > 120000 || duration > request.maximumDurationMs)
    deny("native_capture_quota");
  return duration;
}

function bindingDescriptor(
  descriptor: ListenerDescriptor,
): Parameters<typeof readConnectedListenerBinding>[0] {
  const registration = descriptor.registration;
  return {
    connectionId: descriptor.connectionId,
    producer: {
      producerId: descriptor.producer.producerId,
      instanceId: descriptor.producer.instanceId,
      signalKind: descriptor.producer.signalKind,
      schemaVersion: descriptor.producer.schemaVersion,
    },
    registration: {
      connectionEpoch: registration.connectionEpoch,
      ...(registration.deviceCanonicalPath === undefined
        ? {}
        : { deviceCanonicalPath: registration.deviceCanonicalPath }),
      ...(registration.trackCanonicalPath === undefined
        ? {}
        : { trackCanonicalPath: registration.trackCanonicalPath }),
      ...(registration.nativeStatus === undefined
        ? {}
        : { nativeStatus: registration.nativeStatus }),
    },
  };
}

function subject(
  owner: ListeningOwner,
  listener: InspectListeningContextResult["listeners"][number],
  range: { startBeat: number; endBeat: number },
  kind: "track" | "arrangement-range",
): ListeningPublicationBinding["primary"] {
  const trackId = listener.binding.track.expectedReference;
  const fingerprint = listener.fingerprint.digest;
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    id: digest({
      sessionId: owner.sessionId,
      liveSetId: owner.liveSetId,
      trackId,
      kind,
      range,
      fingerprint,
    }),
    sessionId: owner.sessionId,
    liveSetId: owner.liveSetId,
    kind,
    trackId,
    location: kind === "track" ? "track" : "arrangement",
    binding: {
      version: 1,
      semanticLocator: {
        name: sanitizePersistedText(listener.binding.track.expectedName).slice(
          0,
          128,
        ),
        trackId,
        ...(kind === "track" ? {} : { arrangementRange: range }),
      },
      sourceIdentity: `live-connection:${trackId}`,
      playbackSettingsHash: digest(listener.trackEvidence),
      upstreamProcessingHash: fingerprint,
      routingHash: digest({
        scope: "unknown",
        reasons: listener.unknownReasons,
      }),
      dependencyScope: "unknown",
      previousRuntimeBindings: [trackId],
    },
  };
}

function publicationBindings(
  state: CaptureState,
): ListeningPublicationBinding[] {
  const range = {
    startBeat: state.request.startBeat,
    endBeat: state.request.endBeat,
  };
  return state.connections.map((connection, index) => {
    const listener = state.inspection.listeners.find(
      (item) => item.canonicalPath === connection.canonicalPath,
    )!;
    return {
      listenerId: connection.producerId,
      deviceReference: listener.binding.expectedDeviceReference,
      connectionEpoch: connection.connectionEpoch,
      version: state.descriptors[index]!.registration.algorithmVersion,
      primary: subject(state.owner, listener, range, "arrangement-range"),
      contributors: [subject(state.owner, listener, range, "track")],
      // An independently inspected bus can be mixed; never infer exclusive clip audio.
      attribution:
        listener.binding.track.kind !== "regular" &&
        listener.fingerprint.completeness === "complete" &&
        !listener.dependenciesTruncated &&
        listener.unknownReasons.length === 0
          ? "mixed"
          : "unknown",
    };
  });
}

function assemble(
  dependencies: ListeningRuntimeDependencies,
  options: ListeningRuntimeHostOptions,
  adapter: RuntimeAdapter,
): ConcreteListeningRuntimeHost {
  const service: ListenerService | undefined =
    dependencies.signals.listeners ?? dependencies.signals.listenerTransport;
  const states = new Map<string, CaptureState>();
  let closed = false;

  async function stage<T>(
    name: string,
    context: ListeningExecutionContext,
    operation: () => Promise<T>,
    compensate?: (result: T) => Promise<void>,
  ): Promise<T> {
    const started = Date.now();
    const event = (lifecycle: string, detail?: string) =>
      recordSignalTelemetry(dependencies.telemetry, {
        name: `listening.runtime.${name}.${lifecycle}`,
        source: "listening-runtime-host",
        sessionId: context.sessionId,
        activeAgentId: context.agentId,
        correlationId: context.trace.correlationId,
        causationId: context.trace.causationId,
        trace: { traceId: context.trace.traceId, spanId: randomUUID() },
        durationMs: Date.now() - started,
        outcome:
          lifecycle === "failed"
            ? "failure"
            : lifecycle === "cancelled"
              ? "cancelled"
              : "success",
        attributes: sanitizeTelemetryAttributes({ detail }),
      });
    const compensateAbort = async (result: T) => {
      if (!compensate) return;
      event("progress", "Compensating resource acquisition after cancellation");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          compensate(result),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new ListeningFailure(
                    "cleanup_timeout",
                    "Late listening resource cleanup timed out",
                  ),
                ),
              listeningLimits.cleanupTimeoutMs,
            );
            timer.unref?.();
          }),
        ]);
      } catch (cause) {
        event(
          "failed",
          cause instanceof Error
            ? cause.message
            : "Late resource cleanup failed",
        );
        throw cause;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    event("queued");
    event("started");
    try {
      if (closed) deny("listening_host_closed");
      context.signal?.throwIfAborted();
      const result = await withCorrelation(
        {
          ...context.trace,
          sessionId: context.sessionId,
          activeAgentId: context.agentId,
        },
        () =>
          awaitListeningBoundary(
            (async () => {
              const result = await operation();
              if (context.signal?.aborted) {
                await compensateAbort(result);
                context.signal.throwIfAborted();
              }
              return result;
            })(),
            context.signal,
          ),
      );
      if (context.signal?.aborted) {
        await compensateAbort(result);
        context.signal.throwIfAborted();
      }
      event("completed");
      return result;
    } catch (cause) {
      event(
        context.signal?.aborted ? "cancelled" : "failed",
        cause instanceof Error ? cause.message : "Listening boundary failed",
      );
      if (cause instanceof ListeningFailure) throw cause;
      throw new ListeningFailure(
        context.signal?.aborted ? "cancelled" : "listening_runtime_failed",
        sanitizePersistedText(
          cause instanceof Error ? cause.message : "Listening boundary failed",
        ).slice(0, 512),
      );
    }
  }

  async function owner(
    context: ListeningExecutionContext,
  ): Promise<ListeningOwner> {
    const resolved = await options.resolveOwner(context);
    context.signal?.throwIfAborted();
    if (
      resolved.sessionId !== context.sessionId ||
      resolved.agentId !== context.agentId ||
      !resolved.liveSetId
    )
      deny("permission_denied");
    return { ...resolved };
  }

  function listeners(): ListenerService {
    if (!service) deny("listener_ingress_unavailable");
    return service;
  }

  function connected(descriptors: readonly ListenerDescriptor[]) {
    if (descriptors.length > 128) deny("listener_inventory_quota");
    return descriptors.flatMap((descriptor) => {
      const result = readConnectedListenerBinding(
        bindingDescriptor(descriptor),
      );
      return result.ok ? [result.connection] : [];
    });
  }

  async function inspect(
    ids: readonly string[],
    range: { startBeat: number; endBeat: number },
    context: ListeningExecutionContext,
    expectedOwner: ListeningOwner,
    previous?: CaptureState,
    discovery = false,
  ): Promise<Omit<CaptureState, "request" | "createdAt" | "reserved">> {
    if (!dependencies.ableton.inspectListeningContext)
      deny("listening_inspection_unavailable");
    if (!sameOwner(await owner(context), expectedOwner))
      deny("permission_denied");
    const identity = await dependencies.ableton.getLiveIdentity();
    context.signal?.throwIfAborted();
    if (identity.liveSetId !== expectedOwner.liveSetId)
      deny("live_set_changed");
    const inventory = listeners().inspectListeners();
    const candidates = connected(inventory);
    const selected = ids.map((id) => {
      const matches = inventory.filter(
        (item) => item.producer.producerId === id,
      );
      if (matches.length !== 1) deny("listener_unavailable_or_ambiguous");
      const candidate = readConnectedListenerBinding(
        bindingDescriptor(matches[0]!),
      );
      if (!candidate.ok) deny(candidate.reason);
      return {
        descriptor: structuredClone(matches[0]!),
        connection: candidate.connection,
      };
    });
    const queryId = randomUUID();
    const inspection = inspectListeningContextResultSchema.parse(
      await dependencies.ableton.inspectListeningContext({
        schemaVersion: 1,
        bindingQueryId: queryId,
        listeners: selected.map(({ connection }) => ({
          canonicalPath: connection.canonicalPath,
        })),
        range: { startBeat: range.startBeat, endBeat: range.endBeat },
        maxClips: 32,
        maxParameters: 16,
      }),
    );
    context.signal?.throwIfAborted();
    if (
      (await dependencies.ableton.getLiveIdentity()).liveSetId !==
      expectedOwner.liveSetId
    )
      deny("live_set_changed");
    context.signal?.throwIfAborted();
    if (inspection.listeners.length !== selected.length)
      deny("ambiguous_inspection");
    if (!discovery && !inspection.transport.safeToStart)
      deny("transport_not_safe_to_start");
    if (
      !discovery &&
      inspection.listeners.some((item) => item.sessionOverride !== false)
    )
      deny("arrangement_source_unknown");
    for (const { connection, descriptor } of selected) {
      const old = previous?.connections.find(
        (item) => item.producerId === connection.producerId,
      );
      if (
        old &&
        (old.connectionId !== connection.connectionId ||
          old.instanceId !== connection.instanceId ||
          old.connectionEpoch !== connection.connectionEpoch ||
          old.canonicalPath !== connection.canonicalPath)
      )
        deny("listener_instance_changed");
      const oldDescriptor = previous?.descriptors.find(
        (item) => item.producer.producerId === descriptor.producer.producerId,
      );
      if (
        oldDescriptor &&
        (oldDescriptor.registration.sampleRate !==
          descriptor.registration.sampleRate ||
          oldDescriptor.registration.algorithmVersion !==
            descriptor.registration.algorithmVersion)
      )
        deny("listener_algorithm_or_sample_rate_changed");
      const expectedTarget = previous?.inspection.listeners.find(
        (item) => item.canonicalPath === connection.canonicalPath,
      )?.binding;
      const resolution = resolveListenerBinding({
        selected: {
          ...connection,
          ...(expectedTarget ? { expectedTarget } : {}),
        },
        connected: candidates,
        inspection,
        queryId,
      });
      if (!resolution.ok) deny(resolution.reason);
      if (
        !discovery &&
        connection.nativeStatus.scope !== NATIVE_LISTENER_SCOPE &&
        (connection.nativeStatus.timing !== "VERIFIED" ||
          connection.nativeStatus.readiness !== "READY")
      )
        deny("real_live_timing_validation_required");
      if (
        !discovery &&
        connection.nativeStatus.scope === NATIVE_LISTENER_SCOPE &&
        (range.startBeat !== 0 ||
          range.endBeat <= 0 ||
          range.endBeat > 20 ||
          !Number.isInteger(range.endBeat * 5))
      )
        deny("unsupported_native_capture_scope");
      if (!discovery && previous === undefined && descriptor.phase !== "idle")
        deny("listener_not_idle");
    }
    if (
      previous &&
      previous.inspection.projectRevision !== inspection.projectRevision
    )
      deny("project_revision_changed");
    return {
      owner: expectedOwner,
      descriptors: selected.map((item) => item.descriptor),
      connections: selected.map((item) => item.connection),
      inspection,
    };
  }

  function state(input: ListeningPassContext): CaptureState {
    const cached = states.get(input.passId);
    if (!cached || !sameOwner(cached.owner, input.owner))
      deny("stale_listening_pass");
    return cached;
  }

  async function repository(input: PassInput): Promise<Repository> {
    const context = execution(input, input.signal);
    if (!sameOwner(await owner(context), input.owner))
      deny("permission_denied");
    const resolved = await options.resolveRepository(input.owner, context);
    input.signal.throwIfAborted();
    if (
      resolved.sessionId !== input.owner.sessionId ||
      resolved.liveSetId !== input.owner.liveSetId
    )
      deny("permission_denied");
    return resolved;
  }

  const services: ListeningCoordinatorServices = {
    inspect: (request, signal, pass) =>
      stage("inspection", execution(pass, signal), async () => {
        if (request.mode !== "arrangement")
          deny("session_quantized_onset_unverified");
        const previous = states.get(pass.passId);
        const snapshot = await inspect(
          request.listenerIds,
          request,
          execution(pass, signal),
          pass.owner,
          previous,
        );
        captureDuration(request, snapshot.inspection);
        await adapter.assertReadiness({
          context: pass,
          listeners: snapshot.descriptors,
          inspection: snapshot.inspection,
          signal,
        });
        signal.throwIfAborted();
        if (!previous)
          states.set(pass.passId, {
            ...snapshot,
            owner: { ...pass.owner },
            request: structuredClone(request),
            createdAt: new Date().toISOString(),
            reserved: false,
          });
        const recording = Object.values(
          snapshot.inspection.transport.recording,
        );
        return {
          liveSetId: pass.owner.liveSetId,
          isPlaying: snapshot.inspection.transport.playing !== false,
          isRecording: recording.some((value) => value === true),
          recordingStateKnown: recording.every((value) => value !== null),
          identityVerified: snapshot.inspection.transport.safeToStart,
        };
      }),
    reservePublication: (input) =>
      stage(
        "reservation",
        execution(input, input.signal),
        async () => {
          const cached = state(input);
          const resolved = await repository(input);
          const receipt = await reserveListeningPublication(resolved, input);
          cached.repository = resolved;
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
        (receipt) => receipt.release(),
      ),
    prepare: (input) =>
      stage(
        "capture-preparation",
        execution(input, input.signal),
        async () => {
          const cached = state(input);
          if (!cached.reserved) deny("context_reservation_required");
          await repository(input);
          const snapshot = await inspect(
            input.request.listenerIds,
            cached.request,
            execution(input, input.signal),
            input.owner,
            cached,
          );
          await adapter.assertReadiness({
            context: input,
            listeners: snapshot.descriptors,
            inspection: snapshot.inspection,
            signal: input.signal,
          });
          input.signal.throwIfAborted();
          const durationMs = captureDuration(
            cached.request,
            snapshot.inspection,
          );
          const capture = await adapter.prepare(listeners(), {
            listeners: snapshot.descriptors,
            config: {
              durationMs,
              maxWindows: 512,
              source: {
                mode: "arrangement",
                startBeat: cached.request.startBeat,
                endBeat: cached.request.endBeat,
              },
            },
            passId: input.passId,
            trace: input.trace,
            signal: input.signal,
            ...(dependencies.telemetry
              ? { telemetry: dependencies.telemetry }
              : {}),
          });
          void capture.result.catch((cause: unknown) => {
            cached.captureFailure = sanitizePersistedText(
              cause instanceof Error
                ? cause.message
                : "Listener capture failed",
            ).slice(0, 512);
          });
          if (capture.nativeLaunch !== undefined)
            cached.nativeLaunch = capture.nativeLaunch;
          else delete cached.nativeLaunch;
          return {
            observations: capture.result,
            disarm: () => capture.disarm(),
          };
        },
        (capture) => capture.disarm(),
      ),
    startPlayback: (input) =>
      stage(
        "playback-start",
        execution(input, input.signal),
        async () => {
          const cached = state(input);
          if (!cached.reserved) deny("context_reservation_required");
          await repository(input);
          input.signal.throwIfAborted();
          if (cached.captureFailure !== undefined)
            throw new ListeningFailure("capture_failed", cached.captureFailure);
          const playback = await adapter.start(
            {
              schemaVersion: 1,
              mode: "arrangement",
              ownerId: createHash("sha256")
                .update(JSON.stringify(input.owner))
                .digest("hex"),
              passId: input.passId,
              expectedLiveSetId: input.owner.liveSetId,
              expectedProjectRevision: cached.inspection.projectRevision,
              listeners: cached.inspection.listeners.map(
                (item) => item.binding,
              ),
              range: {
                startBeat: cached.request.startBeat,
                endBeat: cached.request.endBeat,
              },
            },
            input.signal,
          );
          try {
            const scoped = (descriptor: ListenerDescriptor) =>
              descriptor.registration.nativeStatus?.scope ===
              NATIVE_LISTENER_SCOPE;
            const nativeLaunch = cached.nativeLaunch;
            if (
              playback.startedAtBeat !== cached.request.startBeat ||
              (cached.descriptors.some(scoped) && nativeLaunch === undefined) ||
              (playback.sourceOnset !== "measured" &&
                (!cached.descriptors.every(scoped) ||
                  nativeLaunch === undefined))
            )
              deny("source_onset_unverified");
            if (cached.descriptors.some(scoped) && nativeLaunch !== undefined)
              await stage(
                "native-onset",
                execution(input, input.signal),
                () => nativeLaunch,
              );
          } catch (cause) {
            try {
              await awaitListeningBoundary(
                playback.release(),
                AbortSignal.timeout(listeningLimits.cleanupTimeoutMs),
              );
            } catch (cleanupCause) {
              throw new AggregateError(
                [cause, cleanupCause],
                "Native onset failed and playback monitor release failed",
              );
            }
            throw cause;
          }
          cached.startedAt = new Date().toISOString();
          return {
            cleanupPolicy: "leave-running",
            release: () => playback.release(),
          };
        },
        (playback) => playback.release(),
      ),
    validateObservations: (observations, request, passId) => {
      const cached = states.get(passId);
      if (!cached || request.mode !== "arrangement" || !cached.startedAt)
        deny("stale_listening_pass");
      for (const raw of observations) {
        const item = audioObservationSchema.parse(raw);
        const descriptor = cached.descriptors.find(
          (entry) => entry.producer.producerId === item.listenerId,
        );
        if (
          !descriptor ||
          !item.complete ||
          item.passId !== passId ||
          item.startBeat !== request.startBeat ||
          item.endBeat !== request.endBeat ||
          item.endSample <= item.startSample ||
          item.samples.length > 512 ||
          item.sampleRate !== descriptor.registration.sampleRate ||
          item.algorithm.version !== descriptor.registration.algorithmVersion
        )
          deny("invalid_capture_observation");
      }
      cached.endedAt = new Date().toISOString();
    },
    persist: (input) =>
      stage("publication", execution(input, input.signal), async () => {
        const cached = state(input);
        const resolved = await repository(input);
        if (
          !cached.reserved ||
          cached.repository !== resolved ||
          !cached.startedAt ||
          !cached.endedAt
        )
          deny("invalid_publication_lifecycle");
        return persistListeningObservations(
          resolved,
          {
            passId: input.passId,
            owner: input.owner,
            trace: input.trace,
            requestedMode: "arrangement",
            actualMode: "arrangement",
            requestedRange: {
              startBeat: cached.request.startBeat,
              endBeat: cached.request.endBeat,
            },
            createdAt: cached.createdAt,
            startedAt: cached.startedAt,
            endedAt: cached.endedAt,
            observations: input.observations,
            bindings: publicationBindings(cached),
          },
          input.signal,
        );
      }),
  };

  const host = createListeningHost({
    services,
    ...(dependencies.telemetry ? { telemetry: dependencies.telemetry } : {}),
    resolveOwner: (context) =>
      stage("owner-resolution", context, () => owner(context)),
    inspectListeners: (context) =>
      stage("discovery", context, async () => {
        const resolved = await owner(context);
        const inventory = listeners().inspectListeners();
        const candidates = connected(inventory);
        const views = [];
        for (const candidate of candidates.slice(0, 8)) {
          let trackReference = "unresolved";
          let deviceReference = "unresolved";
          const limitations: string[] = [];
          try {
            const snapshot = await inspect(
              [candidate.producerId],
              { startBeat: 0, endBeat: 1 },
              context,
              resolved,
              undefined,
              true,
            );
            const binding = snapshot.inspection.listeners[0]!.binding;
            trackReference = binding.track.expectedReference;
            deviceReference = binding.expectedDeviceReference;
          } catch (cause) {
            context.signal?.throwIfAborted();
            limitations.push(
              sanitizePersistedText(
                cause instanceof Error ? cause.message : "unresolved",
              ).slice(0, 128),
            );
          }
          // Producer self-report is never independent commissioning evidence.
          limitations.push(
            candidate.nativeStatus.scope === NATIVE_LISTENER_SCOPE
              ? "native_per_pass_validation_required"
              : "real_live_timing_validation_required",
            "source_onset_unverified",
          );
          views.push({
            listenerId: candidate.producerId,
            instanceId: candidate.instanceId,
            trackReference,
            deviceReference,
            displayName: sanitizePersistedText(
              inventory.find(
                (item) => item.producer.producerId === candidate.producerId,
              )!.producer.displayName,
            ).slice(0, 128),
            ready: false,
            limitations: [...new Set(limitations)],
          });
        }
        return {
          action: "inspect-listeners",
          listeners: views,
          truncated: inventory.length > views.length,
        };
      }),
    resolveSessionTarget: async () =>
      deny("session_quantized_onset_unverified"),
    onChange: (job) => {
      if (
        ["completed", "failed", "cancelled", "interrupted"].includes(job.stage)
      )
        states.delete(job.passId);
      try {
        options.onChange?.(structuredClone(job));
      } catch (cause) {
        recordSignalTelemetry(dependencies.telemetry, {
          name: "listening.runtime.notification.failed",
          source: "listening-runtime-host",
          outcome: "failure",
          sessionId: job.owner.sessionId,
          activeAgentId: job.owner.agentId,
          correlationId: job.trace.correlationId,
          causationId: job.trace.causationId,
          trace: { traceId: job.trace.traceId, spanId: randomUUID() },
          attributes: sanitizeTelemetryAttributes({
            detail:
              cause instanceof Error
                ? cause.message
                : "Listening observer failed",
          }),
        });
      }
    },
  });
  const ports: ConcreteListeningRuntimeHost = {
    executeListeningOperation: (input, context) =>
      stage("operation", context, () =>
        host.executeListeningOperation(input, context),
      ),
    waitForListeningPass: (passId, context) =>
      stage("wait", context, () => host.waitForListeningPass(passId, context)),
    shutdown: async () => {
      closed = true;
      try {
        await host.shutdown();
      } finally {
        states.clear();
      }
    },
  };
  const contextPorts = options.contextPorts;
  if (contextPorts?.executeContextOperation)
    ports.executeContextOperation = (params, context) =>
      stage("context-operation", context, async () => {
        await owner(context);
        return contextPorts.executeContextOperation!(params, context);
      });
  if (contextPorts?.getSessionContextInventory)
    ports.getSessionContextInventory = (sessionId, context) =>
      stage("context-inventory", context, async () => {
        await owner(context);
        if (sessionId !== context.sessionId) deny("permission_denied");
        return contextPorts.getSessionContextInventory!(sessionId, context);
      });
  return ports;
}

/** Only exact native scope may attempt fresh proof; metadata never certifies timing. */
export function createListeningRuntimeHost(
  dependencies: ListeningRuntimeDependencies,
  options: ListeningRuntimeHostOptions,
): ConcreteListeningRuntimeHost {
  return assemble(dependencies, options, {
    assertReadiness: async ({ listeners, inspection, signal }) => {
      signal.throwIfAborted();
      if (
        listeners.length === 0 ||
        listeners.some(
          (listener) =>
            listener.registration.nativeStatus?.scope !== NATIVE_LISTENER_SCOPE,
        )
      )
        deny("real_live_timing_validation_required");
      if (
        inspection.transport.currentBeat !== 0 ||
        inspection.transport.tempo !== 120 ||
        listeners.some((listener) => listener.registration.sampleRate !== 48000)
      )
        deny("unsupported_native_preflight");
    },
    prepare: prepareListenerCapture,
    start: async (params, signal) => {
      signal.throwIfAborted();
      if (!dependencies.ableton.startListeningPlayback)
        deny("listening_playback_unavailable");
      const result = await dependencies.ableton.startListeningPlayback(params);
      return {
        cleanupPolicy: "leave-running",
        startedAtBeat: result.startedAtBeat,
        sourceOnset: "unverified",
        release: async () => {},
      };
    },
  });
}

/** Positive composition tests inject measured, test-owned adapters, never production flags/files. */
export function assembleListeningRuntimeHostForTests(
  dependencies: ListeningRuntimeDependencies,
  options: ListeningRuntimeHostOptions,
  adapter: ListeningRuntimeTestAdapter,
): ConcreteListeningRuntimeHost {
  if (adapter.provenance !== "test-owned-certified-adapter")
    deny("invalid_test_adapter");
  return assemble(dependencies, options, {
    ...adapter,
    assertReadiness: adapter.assertMeasuredReadiness,
  });
}
