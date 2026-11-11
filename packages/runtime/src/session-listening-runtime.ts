import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  persistMetricListeningObservations,
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
  listeningTimingPolicySchema,
  metricAudioObservationSchema,
  type InspectListeningContextResult,
  type InspectSessionListeningSourceResult,
  type ListeningTimingPolicy,
  type MetricListeningGeometry,
  type NativeMetricListeningConfig,
  type StoredAudioObservation,
  type SessionListeningLaunchDetail,
  type ListeningFailureEvidence,
  readListeningFailureEvidence,
  sessionMusicalAlignment,
} from "@ableton-agent/protocol";
import {
  recordSignalTelemetry,
  type ListenerDescriptor,
  type ListenerService,
} from "@ableton-agent/signal-routing";
import type { ListeningRuntimeDependencies } from "./composition.js";
import { prepareMetricListenerCapture } from "./metric-listening-capture.js";
import {
  createMetricCaptureBinding,
  validateMetricCaptureObservations,
  type MetricCaptureBinding,
} from "./metric-listening-config.js";
import {
  assertSessionFirstIterationCoverage,
  assertSessionSourceUnchanged,
  assertTransportCoupledSessionOrigin,
  freezeSessionSourceExpectation,
  type SessionSourceExpectation,
  type SessionSourceOrigin,
} from "./session-listening-source.js";
import { createSessionSourceDriver } from "./session-listening-driver.js";
import {
  assertSessionSignal,
  attributeSessionRejection,
  immutableSessionEvidence,
  validateSessionEvidence,
} from "./session-listening-source.js";
import {
  captureFailureEvidence,
  denyListening as deny,
  failureFact,
  ListeningRuntimeRejection,
} from "./listening-failure.js";

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
  readonly independentMetricListeners?: boolean;
  readonly requestedMetrics?: Readonly<
    NativeMetricListeningConfig["requestedMetrics"]
  >;
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

type SessionState = SessionBindingSnapshot & {
  readonly pass: ListeningPassContext;
  readonly owner: ListeningOwner;
  readonly request: SessionRequest;
  readonly expected: SessionSourceExpectation;
  readonly policy: Readonly<ListeningTimingPolicy>;
  readonly createdAt: string;
  reserved: boolean;
  repositoryIdentity?: object;
  lease?: SessionSourceLease;
  nativeLaunch?: Promise<void>;
  captureFailure?: Error;
  startedAt?: string;
  endedAt?: string;
  validatedDigest?: string;
  release?: () => Promise<void>;
  readonly geometry: Readonly<MetricListeningGeometry>;
  readonly metricBinding: MetricCaptureBinding;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function execution(
  pass: ListeningPassContext,
  signal?: AbortSignal,
): ListeningExecutionContext & { readonly listeningPassId: string } {
  return {
    sessionId: pass.owner.sessionId,
    agentId: pass.owner.agentId,
    actorKind: "agent",
    trace: pass.trace,
    listeningPassId: pass.passId,
    ...(signal ? { signal } : {}),
  };
}

/** Source-specific services share the existing owned-job pipeline and publication transaction. */
export function createSessionListeningServices(
  options: SessionListeningServicesOptions,
) {
  const { dependencies } = options;
  const states = new Map<string, SessionState>();
  const guard = <T>(
    pass:
      (ListeningPassContext & { readonly signal?: AbortSignal }) | undefined,
    phase: ListeningFailureEvidence["phase"],
    operation: () => T,
  ): T => {
    const failed = (error: unknown): never => {
      if (pass) attributeSessionRejection(error, pass, phase, pass.signal);
      throw error;
    };
    try {
      const result = operation();
      return result instanceof Promise ? (result.catch(failed) as T) : result;
    } catch (error) {
      return failed(error);
    }
  };
  const sourceDriver = createSessionSourceDriver(dependencies.ableton);
  const stage = <T>(
    name: string,
    pass: PassInput,
    operation: (progress: (detail: string) => void) => Promise<T>,
    compensate?: (result: T) => Promise<void>,
  ) =>
    options.stage(
      name,
      execution(pass, pass.signal),
      (progress) =>
        guard(
          pass,
          name === "session-source-monitor-preparation"
            ? "preparation"
            : name === "session-launch" || name === "session-native-onset"
              ? "launch"
              : "capture",
          () => operation(progress),
        ),
      compensate,
      {
        passId: pass.passId,
        mode: "session",
      },
    );
  const state = (input: ListeningPassContext): SessionState => {
    const cached = states.get(input.passId);
    if (
      !cached ||
      cached.owner.sessionId !== input.owner.sessionId ||
      cached.owner.liveSetId !== input.owner.liveSetId ||
      cached.owner.agentId !== input.owner.agentId
    )
      deny("stale_session_pass", undefined, [
        failureFact("pass.cached", Boolean(cached), true),
        failureFact(
          "pass.owner.sessionId",
          cached?.owner.sessionId,
          input.owner.sessionId,
        ),
        failureFact(
          "pass.owner.liveSetId",
          cached?.owner.liveSetId,
          input.owner.liveSetId,
        ),
        failureFact(
          "pass.owner.agentId",
          cached?.owner.agentId,
          input.owner.agentId,
        ),
      ]);
    return cached;
  };
  const sourceSnapshot = async (
    request: SessionRequest,
    signal: AbortSignal,
  ) => {
    assertSessionSignal(signal, "runtime.source-snapshot.before-inspection");
    if (!request.target || !dependencies.ableton.inspectSessionListeningSource)
      deny("session_source_inspection_unavailable", undefined, [
        failureFact(
          "request.target.present",
          request.mode === "session" && Boolean(request.target),
          true,
        ),
        failureFact(
          "source.inspection.available",
          typeof dependencies.ableton.inspectSessionListeningSource ===
            "function",
          true,
        ),
      ]);
    const snapshot = await dependencies.ableton.inspectSessionListeningSource({
      schemaVersion: 1,
      queryId: randomUUID(),
      target: request.target,
    });
    assertSessionSignal(signal, "runtime.source-snapshot.after-inspection");
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
        deny("unsupported_session_request", undefined, [
          failureFact("request.mode", request.mode, "session"),
          failureFact(
            "request.target.present",
            request.mode === "session" && Boolean(request.target),
            true,
          ),
          failureFact("request.listenerCount", request.listenerIds.length, 1, {
            unit: "count",
          }),
        ]);
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
      if (current.stoppedBeat !== expected.stoppedBeat)
        deny("session_transport_changed", undefined, [
          failureFact(
            "source.startBeat",
            current.stoppedBeat,
            expected.stoppedBeat,
            { unit: "beats" },
          ),
        ]);
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
        options.independentMetricListeners !== true ||
        listener.binding.track.kind !== "regular" ||
        listener.binding.track.expectedReference !== request.trackReference ||
        listener.binding.track.expectedReference !==
          request.target.track.expectedReference ||
        listener.binding.track.index !== request.target.track.index
      )
        deny("session_same_track_native_listener_required", undefined, [
          failureFact("binding.listener.present", Boolean(listener), true),
          failureFact("binding.descriptor.present", Boolean(descriptor), true),
          failureFact(
            "binding.descriptorCount",
            binding.descriptors.length,
            1,
            { unit: "count" },
          ),
          failureFact(
            "binding.registration.version",
            descriptor?.registration.version,
            5,
          ),
          failureFact(
            "binding.track.kind",
            listener?.binding.track.kind,
            "regular",
          ),
          failureFact(
            "binding.track.reference",
            listener?.binding.track.expectedReference,
            request.trackReference,
          ),
          failureFact(
            "binding.target.trackReference",
            listener?.binding.track.expectedReference,
            request.target.track.expectedReference,
          ),
          failureFact(
            "binding.track.index",
            listener?.binding.track.index,
            request.target.track.index,
          ),
        ]);
      const registration = descriptor.registration;
      if (
        registration.sampleRate !== 44_100 &&
        registration.sampleRate !== 48_000
      )
        deny("unsupported_native_sample_rate", undefined, [
          failureFact(
            "listener.sampleRate",
            registration.sampleRate,
            "44100|48000",
            { unit: "Hz" },
          ),
        ]);
      if (
        !registration.nativeStatus.supportedModes.includes("session") ||
        binding.inspection.transport.playing !== false ||
        !binding.inspection.transport.safeToStart ||
        Object.values(binding.inspection.transport.recording).some(
          (value) => value !== false,
        ) ||
        binding.inspection.transport.tempo !==
          expected.source.settings.tempoBpm ||
        binding.inspection.transport.currentBeat !== expected.stoppedBeat
      )
        deny("session_transport_or_recording_unsafe", undefined, [
          failureFact(
            "listener.nativeStatus.scope",
            registration.nativeStatus.scope,
            "independent-metric-timelines/v1",
          ),
          failureFact(
            "listener.nativeStatus.sessionSupported",
            registration.nativeStatus.supportedModes.includes("session"),
            true,
          ),
          failureFact(
            "transport.playing",
            binding.inspection.transport.playing,
            false,
          ),
          failureFact(
            "transport.safeToStart",
            binding.inspection.transport.safeToStart,
            true,
          ),
          ...Object.entries(binding.inspection.transport.recording).map(
            ([key, value]) =>
              failureFact(`transport.recording.${key}`, value, false),
          ),
          failureFact(
            "transport.tempo",
            binding.inspection.transport.tempo,
            expected.source.settings.tempoBpm,
          ),
          failureFact(
            "transport.currentBeat",
            binding.inspection.transport.currentBeat,
            expected.stoppedBeat,
            { unit: "beats" },
          ),
        ]);
      const policyInput = previous?.policy ?? options.resolveTimingPolicy();
      const policy =
        previous?.policy ??
        Object.freeze(
          validateSessionEvidence(
            "session.timing-policy.schema",
            () => listeningTimingPolicySchema.parse(policyInput),
            policyInput,
          ),
        );
      const sourceKind = expected.source.sourceKind;
      if (sourceKind !== "midi" && sourceKind !== "warped-audio")
        deny("unsupported_session_source", undefined, [
          failureFact("source.kind", sourceKind, "midi|warped-audio"),
        ]);
      const metricBinding =
        previous?.metricBinding ??
        createMetricCaptureBinding({
          ...(options.requestedMetrics
            ? { requestedMetrics: options.requestedMetrics }
            : {}),
          descriptor,
          tempoBpm: binding.inspection.transport.tempo!,
          stoppedBeat: expected.stoppedBeat,
          timingPolicy: policy,
          source: {
            view: "session",
            target: request.target,
            clipReference: request.target.expectedClipReference,
            kind: sourceKind,
            coordinate: {
              unit: "beats",
              iteration: 0,
              startBeat: 0,
              endBeat: expected.durationBeats,
            },
            transport: {
              startBeat: expected.startBeat,
              endBeat: expected.endBeat,
            },
            clipStartTimeBeats: expected.startBeat,
            synchronization: "transport-coupled-first-iteration",
          },
        });
      const capturePlan = {
        metricBinding,
        geometry: metricBinding.config.geometry,
      };
      const geometry = capturePlan.geometry;
      assertSessionFirstIterationCoverage(expected, geometry);
      const durationMs = Math.ceil(
        (geometry.totalSamples * 1000) / geometry.sampleRate,
      );
      if (durationMs > request.maximumDurationMs)
        deny("native_capture_quota", undefined, [
          failureFact(
            "capture.durationMs",
            durationMs,
            request.maximumDurationMs,
            { comparison: "at-most", unit: "ms" },
          ),
          failureFact(
            "geometry.totalSamples",
            geometry.totalSamples,
            undefined,
            { unit: "samples" },
          ),
          failureFact("geometry.sampleRate", geometry.sampleRate, undefined, {
            unit: "Hz",
          }),
        ]);
      await sourceDriver.assertAvailable();
      assertSessionSignal(signal, "runtime.inspect.after-capabilities");
      if (!previous)
        states.set(context.passId, {
          ...binding,
          pass: structuredClone({
            passId: context.passId,
            owner: context.owner,
            trace: context.trace,
          }),
          owner: structuredClone(context.owner),
          request: structuredClone(request),
          expected,
          ...capturePlan,
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
      cached.repositoryIdentity = repository.publicationIdentity ?? repository;
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
      if (!cached.reserved)
        deny("context_reservation_required", undefined, [
          failureFact("publication.reserved", cached.reserved, true),
        ]);
      const fresh = await sourceSnapshot(cached.request, input.signal);
      assertSessionSourceUnchanged(cached.expected, fresh);
      cached.lease = await stage(
        "session-source-monitor-preparation",
        input,
        () =>
          sourceDriver.prepare({
            pass: input,
            target: cached.request.target!,
            durationBeats: cached.expected.durationBeats,
            expectedProjectRevision: fresh.projectRevision,
            binding: {
              ...cached.inspection.listeners[0]!.binding,
              track: cached.request.target!.track,
            },
            startBeat: cached.expected.stoppedBeat,
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
      const observedFailure = (
        cause: unknown,
        code: string,
        message: string,
      ): Error => {
        if (cause instanceof Error) return cause;
        const error = new ListeningRuntimeRejection(code, undefined, [
          failureFact("failure.errorInstance", false, true),
          failureFact("failure.valueType", typeof cause),
        ]);
        error.message = message;
        attributeSessionRejection(error, input, "capture", input.signal);
        return error;
      };
      const monitor = stage(
        "session-source-continuity-monitor",
        input,
        async (progress) => {
          let reported = false;
          try {
            while (!monitorController.signal.aborted) {
              assertSessionSignal(
                monitorSignal,
                "runtime.continuity.before-inspection",
              );
              await lease.assertCurrent(monitorSignal);
              if (!reported) {
                progress(
                  "Source continuity checked at message rate; between-observation changes remain unverified",
                );
                reported = true;
              }
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
        sourceFailure = observedFailure(
          cause,
          "session_source_invalid",
          "Session source monitoring failed",
        );
        cached.captureFailure ??= sourceFailure;
        captureController.abort(cached.captureFailure);
      });
      let native:
        Awaited<ReturnType<typeof prepareMetricListenerCapture>> | undefined;
      let cleanup: Promise<void> | undefined;
      const release = () =>
        (cleanup ??= (async () => {
          const started = performance.now();
          const event = (
            lifecycle: "queued" | "started" | "completed" | "failed",
            error?: unknown,
          ) => {
            const parsed = readListeningFailureEvidence(error);
            const evidenceOwned =
              parsed.status === "present" &&
              parsed.evidence.reference.passId === input.passId &&
              parsed.evidence.reference.traceId === input.trace.traceId;
            if (
              lifecycle === "failed" &&
              parsed.status !== "absent" &&
              !evidenceOwned
            )
              recordSignalTelemetry(dependencies.telemetry, {
                name: "listening.runtime.diagnostics.coverage-gap",
                source: "session-listening-runtime",
                sessionId: input.owner.sessionId,
                activeAgentId: input.owner.agentId,
                correlationId: input.trace.correlationId,
                causationId: input.trace.causationId,
                trace: { traceId: input.trace.traceId, spanId: randomUUID() },
                level: "warn",
                outcome: "unknown",
                attributes: {
                  passId: input.passId,
                  boundary: "session-source-cleanup",
                  reason:
                    parsed.status === "present"
                      ? "diagnostic-owner-mismatch"
                      : "invalid-evidence",
                },
              });
            recordSignalTelemetry(dependencies.telemetry, {
              name: `listening.runtime.session-source-cleanup.${lifecycle}`,
              source: "session-listening-runtime",
              sessionId: input.owner.sessionId,
              activeAgentId: input.owner.agentId,
              correlationId: input.trace.correlationId,
              causationId: input.trace.causationId,
              trace: { traceId: input.trace.traceId, spanId: randomUUID() },
              durationMs: Math.max(0, performance.now() - started),
              outcome: lifecycle === "failed" ? "failure" : "success",
              attributes: {
                passId: input.passId,
                mode: "session",
                cancelled: input.signal.aborted,
                ...(error === undefined
                  ? {}
                  : {
                      detail: sanitizePersistedText(
                        error instanceof Error
                          ? error.message
                          : "Session cleanup failed",
                      ).slice(0, 512),
                      ...(parsed.status === "present" && evidenceOwned
                        ? { failureEvidence: parsed.evidence }
                        : {}),
                    }),
              },
            });
          };
          event("queued");
          event("started");
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
          if (errors.length) {
            const error = new AggregateError(
              errors,
              "Session listener/source cleanup failed; playback was left running",
            );
            attributeSessionRejection(error, input, "cleanup");
            if (readListeningFailureEvidence(error).status === "absent")
              Object.defineProperty(error, "failureEvidence", {
                value: immutableSessionEvidence(
                  captureFailureEvidence({
                    code: "session_cleanup_failed",
                    message: error.message,
                    phase: "cleanup",
                    component: "cleanup",
                    checkId: "session.cleanup.resource-release",
                    trace: input.trace,
                    passId: input.passId,
                    facts: [
                      failureFact(
                        "cleanup.sourceRelease.status",
                        results[1].status,
                        "fulfilled",
                      ),
                      failureFact(
                        "cleanup.nativeDisarm.status",
                        native ? results[2]?.status : "not-acquired",
                        native ? "fulfilled" : "not-acquired",
                      ),
                      failureFact(
                        "cleanup.elapsedMs",
                        performance.now() - started,
                        undefined,
                        { unit: "ms" },
                      ),
                    ],
                    coverage: "partial",
                    coverageReasons: ["source-evidence-not-reported"],
                  }),
                ),
              });
            event("failed", error);
            throw error;
          }
          event("completed");
        })());
      cached.release = release;
      try {
        const captureInput = {
          passId: input.passId,
          trace: input.trace,
          signal: captureSignal,
          ...(dependencies.telemetry
            ? { telemetry: dependencies.telemetry }
            : {}),
        };
        native = await prepareMetricListenerCapture(options.listeners(), {
          ...captureInput,
          bindings: [cached.metricBinding],
        });
        void native.result.catch((cause: unknown) => {
          cached.captureFailure ??= observedFailure(
            cause,
            "capture_failed",
            "Native Session capture failed",
          );
        });
        if (native.nativeLaunch === undefined || native.nativeLaunch === null)
          deny("session_native_launch_proof_required", undefined, [
            failureFact(
              "capture.nativeLaunch.present",
              Boolean(native.nativeLaunch),
              true,
            ),
          ]);
        cached.nativeLaunch = native.nativeLaunch;
        const sealedObservations = native.result.then((raw) =>
          stage("session-source-observation-validation", input, async () => {
            const seal = await stage("session-source-seal", input, () =>
              lease.seal(captureSignal),
            );
            assertSessionSourceUnchanged(cached.expected, seal.source);
            assertTransportCoupledSessionOrigin(cached.expected, seal.origin);
            const validated = validateMetricCaptureObservations(
              raw,
              [cached.metricBinding],
              cached.pass,
            );
            const enriched = validated.map((observation) =>
              metricAudioObservationSchema.parse({
                ...observation,
                limitations: [
                  ...new Set([
                    ...observation.limitations,
                    ...cached.expected.limitations,
                  ]),
                ],
              }),
            );
            cached.validatedDigest = digest(enriched);
            return enriched;
          }),
        );
        const observations = Promise.race([
          sealedObservations,
          invalidation,
        ]).catch((cause: unknown) => {
          cached.captureFailure ??= observedFailure(
            cause,
            "capture_failed",
            "Session source sealing failed",
          );
          throw cached.captureFailure;
        });
        void observations.catch(() => {});
        return {
          observations,
          disarm: release,
          observationContract: native.observationContract,
        };
      } catch (error) {
        const failure = cached.captureFailure ?? sourceFailure ?? error;
        attributeSessionRejection(failure, input, "preparation", input.signal);
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
      assertSessionSignal(input.signal, "runtime.launch.before-dispatch");
      if (!cached.reserved || !cached.lease || !cached.nativeLaunch)
        deny("session_not_prepared", undefined, [
          failureFact("publication.reserved", cached.reserved, true),
          failureFact("source.lease.present", Boolean(cached.lease), true),
          failureFact(
            "capture.nativeLaunch.present",
            Boolean(cached.nativeLaunch),
            true,
          ),
        ]);
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
        deny("invalid_session_capture_observation", undefined, [
          failureFact("pass.cached", Boolean(cached), true),
          failureFact("request.mode", request.mode, "session"),
          failureFact("capture.failed", Boolean(cached?.captureFailure), false),
          failureFact("capture.started", Boolean(cached?.startedAt), true),
          failureFact(
            "observation.digest",
            digest(observations),
            cached?.validatedDigest,
          ),
        ]);
      if (observations.length !== 1)
        deny("invalid_session_capture_observation", undefined, [
          failureFact("observation.count", observations.length, 1, {
            unit: "count",
          }),
        ]);
      validateMetricCaptureObservations(
        observations,
        [cached.metricBinding],
        cached.pass,
      );
      cached.endedAt = new Date().toISOString();
      return;
    },

    async persist(
      input: Parameters<ListeningCoordinatorServices["persist"]>[0],
    ) {
      const cached = state(input);
      const repository = await options.resolveRepository(input);
      const sameRepository =
        cached.repositoryIdentity ===
        (repository.publicationIdentity ?? repository);
      if (
        !cached.reserved ||
        cached.captureFailure ||
        !sameRepository ||
        !cached.startedAt ||
        !cached.endedAt
      )
        deny("invalid_publication_lifecycle", undefined, [
          failureFact("publication.reserved", cached.reserved, true),
          failureFact("capture.failed", Boolean(cached.captureFailure), false),
          failureFact("publication.sameRepository", sameRepository, true),
          failureFact("capture.started", Boolean(cached.startedAt), true),
          failureFact("capture.ended", Boolean(cached.endedAt), true),
        ]);
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
        deny("session_same_track_native_listener_required", undefined, [
          failureFact("publication.track.kind", inspectedTrack.kind, "track"),
          failureFact(
            "publication.track.targetBound",
            inspectedTrack.binding.previousRuntimeBindings.includes(
              target.track.expectedReference,
            ),
            true,
          ),
          failureFact(
            "publication.target.trackReference",
            target.track.expectedReference,
          ),
        ]);
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
      const musicalAlignment = sessionMusicalAlignment(
        cached.expected.source.settings,
      );
      return persistMetricListeningObservations(
        repository,
        {
          passId: input.passId,
          owner: input.owner,
          trace: input.trace,
          requestedMode: "session",
          actualMode: "session",
          requestedRange: {
            startBeat: 0,
            endBeat: cached.expected.durationBeats,
          },
          createdAt: cached.createdAt,
          startedAt: cached.startedAt,
          endedAt: cached.endedAt,
          observations: validateMetricCaptureObservations(
            input.observations,
            [cached.metricBinding],
            { passId: input.passId, trace: input.trace },
          ),
          bindings: [
            {
              listenerId: cached.request.listenerIds[0]!,
              deviceReference: listener.binding.expectedDeviceReference,
              connectionEpoch: cached.connections[0]!.connectionEpoch,
              version: cached.descriptors[0]!.registration.algorithmVersion,
              primary,
              contributors: [contributor],
              attribution: "unknown",
              ...(musicalAlignment === undefined ? {} : { musicalAlignment }),
            },
          ],
        },
        input.signal,
      );
    },
  } satisfies ListeningCoordinatorServices;

  return {
    services: {
      ...services,
      inspect: (request, signal, pass) =>
        guard({ ...pass, signal }, "validation", () =>
          services.inspect(request, signal, pass),
        ),
      prepare: (input) =>
        guard(input, "preparation", () => services.prepare(input)),
      startPlayback: (input) =>
        guard(input, "launch", () => services.startPlayback(input)),
      validateObservations: (observations, request, passId) =>
        guard(states.get(passId)?.pass, "capture", () =>
          services.validateObservations(observations, request, passId),
        ),
      persist: (input) =>
        guard(input, "publication", () => services.persist(input)),
    } satisfies ListeningCoordinatorServices,
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
