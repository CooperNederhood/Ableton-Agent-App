import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  awaitListeningBoundary,
  createListeningHost,
  ListeningFailure,
  listeningLimits,
  persistMetricListeningObservations,
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
  DEFAULT_LISTENING_TIMING_POLICY,
  listeningTimingPolicySchema,
  readListeningFailureEvidence,
  NATIVE_METRIC_LISTENING_SCOPE,
  MAX_METRIC_LISTENING_SECONDS,
  inspectListeningContextResultSchema,
  positionListeningPlaybackResultSchema,
  type InspectListeningContextResult,
  type PositionListeningPlaybackParams,
  type ListeningTimingPolicy,
  type ListeningFailureEvidence,
  type NativeMetricListeningConfig,
} from "@ableton-agent/protocol";
import {
  recordSignalTelemetry,
  type ListenerDescriptor,
  type ListenerService,
} from "@ableton-agent/signal-routing";
import { prepareMetricListenerCapture } from "./metric-listening-capture.js";
import {
  createMetricCaptureBinding,
  validateMetricCaptureObservations,
  type MetricCaptureBinding,
} from "./metric-listening-config.js";
import {
  captureFailureEvidence,
  failureFact,
  ListeningRuntimeRejection,
  denyListening as deny,
} from "./listening-failure.js";
import { createSessionListeningServices } from "./session-listening-runtime.js";
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
  /** Internal opt-in; production delivery remains gated on full native qualification. */
  readonly independentMetricListeners?: boolean;
  readonly requestedMetrics?: Readonly<
    NativeMetricListeningConfig["requestedMetrics"]
  >;
  readonly resolveTimingPolicy?: () => ListeningTimingPolicy;
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
  inspection: InspectListeningContextResult;
  readonly timingPolicy: Readonly<ListeningTimingPolicy>;
  readonly metricBindings: readonly MetricCaptureBinding[];
  readonly trace: ListeningPassContext["trace"];
  readonly createdAt: string;
  repositoryIdentity?: object;
  reserved: boolean;
  startedAt?: string;
  endedAt?: string;
  captureFailure?: ListeningFailure;
  nativeLaunch?: Promise<void>;
}

function execution(
  context: ListeningPassContext,
  signal: AbortSignal,
): ListeningExecutionContext & { readonly listeningPassId: string } {
  return {
    sessionId: context.owner.sessionId,
    agentId: context.owner.agentId,
    trace: context.trace,
    actorKind: "agent",
    listeningPassId: context.passId,
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

function assertCaptureDuration(
  request: ListeningRequest & { mode: "arrangement" },
  inspection: InspectListeningContextResult,
): void {
  const tempo = inspection.transport.tempo;
  if (tempo === null)
    deny("tempo_unknown", undefined, [
      failureFact("transport.tempoKnown", false, true, {
        comparison: "equal",
        unit: "boolean",
      }),
    ]);
  const duration = Math.ceil(
    ((request.endBeat - request.startBeat) * 60000) / tempo,
  );
  const maximumDurationMs = MAX_METRIC_LISTENING_SECONDS * 1000;
  if (
    duration < 1 ||
    duration > maximumDurationMs ||
    duration > request.maximumDurationMs
  )
    deny("native_capture_quota", undefined, [
      failureFact("capture.durationMs", duration, maximumDurationMs, {
        comparison: "at-most",
        unit: "ms",
      }),
      failureFact(
        "capture.requestedMaximumMs",
        duration,
        request.maximumDurationMs,
        { comparison: "at-most", unit: "ms" },
      ),
      failureFact("capture.durationPositive", duration >= 1, true, {
        comparison: "equal",
        unit: "boolean",
      }),
    ]);
}

function bindingDescriptor(
  descriptor: ListenerDescriptor,
  independentMetrics = false,
): Parameters<typeof readConnectedListenerBinding>[0] {
  const registration = descriptor.registration;
  if (!independentMetrics)
    deny("listening_not_enabled", undefined, [
      failureFact("listening.enabled", independentMetrics, true),
    ]);
  return {
    connectionId: descriptor.connectionId,
    producer: {
      producerId: descriptor.producer.producerId,
      instanceId: descriptor.producer.instanceId,
      signalKind: descriptor.producer.signalKind,
      schemaVersion: descriptor.producer.schemaVersion,
    },
    registration: {
      version: registration.version,
      algorithmVersion: registration.algorithmVersion,
      sampleRate: registration.sampleRate,
      vectorSize: registration.vectorSize,
      capabilities: registration.capabilities,
      ...(registration.analyzerReadiness === undefined
        ? {}
        : { analyzerReadiness: registration.analyzerReadiness }),
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

function assertMetricDspGeometry(
  bindings: readonly MetricCaptureBinding[],
): void {
  const first = bindings[0]?.config.geometry;
  if (!first)
    deny("listener_unavailable_or_ambiguous", undefined, [
      failureFact("listener.count", bindings.length, "at least one"),
    ]);
  if (
    bindings.some(
      ({ config }) =>
        config.geometry.sampleRate !== first.sampleRate ||
        config.geometry.vectorSize !== first.vectorSize,
    )
  )
    deny(
      "listener_dsp_geometry_mismatch",
      undefined,
      bindings.flatMap(({ config }, index) => [
        failureFact(
          `listener.${index}.sampleRate`,
          config.geometry.sampleRate,
          first.sampleRate,
          { comparison: "equal", unit: "Hz" },
        ),
        failureFact(
          `listener.${index}.vectorSize`,
          config.geometry.vectorSize,
          first.vectorSize,
          { comparison: "equal", unit: "samples" },
        ),
      ]),
    );
}

function playbackParameters(
  cached: CaptureState,
  pass: ListeningPassContext,
): PositionListeningPlaybackParams {
  return {
    schemaVersion: 1,
    mode: "arrangement",
    ownerId: createHash("sha256")
      .update(JSON.stringify(pass.owner))
      .digest("hex"),
    passId: pass.passId,
    expectedLiveSetId: pass.owner.liveSetId,
    expectedProjectRevision: cached.inspection.projectRevision,
    listeners: cached.inspection.listeners.map((item) => item.binding),
    range: {
      startBeat: cached.request.startBeat,
      endBeat: cached.request.endBeat,
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
  const binding: ListeningPublicationBinding["primary"]["binding"] = {
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
  };
  return {
    id: digest({
      sessionId: owner.sessionId,
      liveSetId: owner.liveSetId,
      trackId,
      kind,
      range,
      binding,
    }),
    sessionId: owner.sessionId,
    liveSetId: owner.liveSetId,
    kind,
    trackId,
    location: kind === "track" ? "track" : "arrangement",
    binding,
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

export function createListeningRuntimeHost(
  dependencies: ListeningRuntimeDependencies,
  options: ListeningRuntimeHostOptions,
): ConcreteListeningRuntimeHost {
  const service: ListenerService | undefined =
    dependencies.signals.listeners ?? dependencies.signals.listenerTransport;
  const states = new Map<string, CaptureState>();
  const attestedBindings = new Map<
    string,
    {
      liveSetId: string;
      connection: ConnectedListenerBinding;
      target: InspectListeningContextResult["listeners"][number]["binding"];
    }
  >();
  let closed = false;

  async function stage<T>(
    name: string,
    context: ListeningExecutionContext & { readonly listeningPassId?: string },
    operation: (progress: (detail: string) => void) => Promise<T>,
    compensate?: (result: T) => Promise<void>,
    attributes?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const started = performance.now();
    const passId =
      context.listeningPassId ??
      (typeof attributes?.passId === "string" ? attributes.passId : undefined);
    const event = (
      lifecycle: string,
      detail?: string,
      evidence?: ListeningFailureEvidence,
    ) =>
      recordSignalTelemetry(dependencies.telemetry, {
        name: `listening.runtime.${name}.${lifecycle}`,
        source: "listening-runtime-host",
        sessionId: context.sessionId,
        activeAgentId: context.agentId,
        correlationId: context.trace.correlationId,
        causationId: context.trace.causationId,
        trace: { traceId: context.trace.traceId, spanId: randomUUID() },
        durationMs: Math.max(0, performance.now() - started),
        outcome:
          lifecycle === "failed"
            ? "failure"
            : lifecycle === "cancelled"
              ? "cancelled"
              : "success",
        attributes: sanitizeTelemetryAttributes({
          ...attributes,
          ...(detail === undefined ? {} : { detail }),
          ...(evidence === undefined ? {} : { failureEvidence: evidence }),
        }),
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
      if (closed)
        deny("listening_host_closed", undefined, [
          failureFact("runtime.closed", closed, false, {
            comparison: "equal",
            unit: "boolean",
          }),
        ]);
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
              const result = await operation((detail) =>
                event("progress", detail),
              );
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
      const parsedEvidence = readListeningFailureEvidence(cause);
      const evidenceOwned =
        parsedEvidence.status === "present" &&
        parsedEvidence.evidence.reference.traceId === context.trace.traceId &&
        (passId === undefined ||
          parsedEvidence.evidence.reference.passId === passId);
      let evidence =
        evidenceOwned && parsedEvidence.status === "present"
          ? parsedEvidence.evidence
          : undefined;
      if (parsedEvidence.status !== "absent" && !evidenceOwned) {
        recordSignalTelemetry(dependencies.telemetry, {
          name: "listening.runtime.diagnostics.coverage-gap",
          source: "listening-runtime-host",
          sessionId: context.sessionId,
          activeAgentId: context.agentId,
          correlationId: context.trace.correlationId,
          causationId: context.trace.causationId,
          trace: { traceId: context.trace.traceId, spanId: randomUUID() },
          outcome: "unknown",
          level: "warn",
          attributes: {
            boundary: name,
            reason:
              parsedEvidence.status === "present"
                ? "diagnostic-owner-mismatch"
                : "invalid-evidence",
          },
        });
      }
      if (cause instanceof ListeningRuntimeRejection) {
        const phase: ListeningFailureEvidence["phase"] =
          name === "publication" || name === "reservation"
            ? "publication"
            : name === "capture-preparation"
              ? "arming"
              : name === "playback-start" ||
                  name === "native-onset" ||
                  name === "source-positioning"
                ? "launch"
                : "validation";
        const component = phase === "publication" ? "publication" : "binding";
        if (passId !== undefined && evidence === undefined)
          evidence = captureFailureEvidence({
            code: cause.code,
            message: cause.message,
            phase,
            component,
            checkId: `runtime.${name}.${cause.code}`,
            trace: context.trace,
            passId,
            facts: cause.rejectionFacts,
            coverage: cause.rejectionFacts.length ? "complete" : "unavailable",
            coverageReasons: cause.rejectionFacts.length
              ? []
              : ["missing-operands"],
          });
        recordSignalTelemetry(dependencies.telemetry, {
          name: "listening.runtime.rejection.observed",
          source: "listening-runtime-host",
          sessionId: context.sessionId,
          activeAgentId: context.agentId,
          correlationId: context.trace.correlationId,
          causationId: context.trace.causationId,
          trace: { traceId: context.trace.traceId, spanId: randomUUID() },
          outcome: "failure",
          durationMs: Math.max(0, performance.now() - started),
          attributes: sanitizeTelemetryAttributes({
            boundary: name,
            checkId: evidence?.checkId ?? `runtime.${name}.${cause.code}`,
            code: cause.code,
            component: evidence?.component ?? component,
            facts: evidence?.facts ?? cause.rejectionFacts,
            coverage: evidence?.coverage ?? "unavailable",
            ...(passId === undefined ? {} : { passId }),
          }),
        });
      }
      event(
        context.signal?.aborted ? "cancelled" : "failed",
        cause instanceof Error ? cause.message : "Listening boundary failed",
        evidence,
      );
      if (cause instanceof ListeningFailure)
        throw new ListeningFailure(cause.code, cause.message, evidence);
      throw new ListeningFailure(
        context.signal?.aborted ? "cancelled" : "listening_runtime_failed",
        sanitizePersistedText(
          cause instanceof Error ? cause.message : "Listening boundary failed",
        ).slice(0, 512),
        evidence,
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
      deny("permission_denied", undefined, [
        failureFact("owner.sessionId", resolved.sessionId, context.sessionId, {
          comparison: "equal",
          unit: "identity",
        }),
        failureFact("owner.agentId", resolved.agentId, context.agentId, {
          comparison: "equal",
          unit: "identity",
        }),
        failureFact(
          "owner.liveSetAvailable",
          Boolean(resolved.liveSetId),
          true,
          { comparison: "equal", unit: "boolean" },
        ),
      ]);
    return { ...resolved };
  }

  function listeners(): ListenerService {
    if (!service)
      deny("listener_ingress_unavailable", undefined, [
        failureFact("ingress.available", false, true, {
          comparison: "equal",
          unit: "boolean",
        }),
      ]);
    return service;
  }

  function connected(descriptors: readonly ListenerDescriptor[]) {
    if (descriptors.length > 128)
      deny("listener_inventory_quota", undefined, [
        failureFact("listener.inventoryCount", descriptors.length, 128, {
          comparison: "at-most",
          unit: "count",
        }),
      ]);
    return descriptors.flatMap((descriptor) => {
      if (
        descriptor.registration.version === 5 &&
        options.independentMetricListeners !== true
      )
        return [];
      const result = readConnectedListenerBinding(
        bindingDescriptor(descriptor, options.independentMetricListeners),
      );
      return result.ok ? [result.connection] : [];
    });
  }

  async function inspect(
    ids: readonly string[],
    range: { startBeat: number; endBeat: number },
    context: ListeningExecutionContext,
    expectedOwner: ListeningOwner,
    previous?: Pick<CaptureState, "descriptors" | "connections" | "inspection">,
    discovery = false,
    allowPositionRevision = false,
    sourceBoundary?: {
      readonly passId: string;
      readonly boundary:
        | "initial-inspection"
        | "preparation-inspection"
        | "positioned-inspection"
        | "post-arm-inspection";
    },
    sourceMode: "arrangement" | "session" = "arrangement",
  ): Promise<
    Pick<CaptureState, "owner" | "descriptors" | "connections" | "inspection">
  > {
    return stage("binding-validation", context, async (progress) => {
      if (!dependencies.ableton.inspectListeningContext)
        deny("listening_inspection_unavailable", undefined, [
          failureFact("bridge.inspectListeningContextAvailable", false, true, {
            comparison: "equal",
            unit: "boolean",
          }),
        ]);
      const inspectionStarted = Date.now();
      const observedOwner = await owner(context);
      if (!sameOwner(observedOwner, expectedOwner))
        deny("permission_denied", undefined, [
          failureFact(
            "owner.sessionId",
            observedOwner.sessionId,
            expectedOwner.sessionId,
            { comparison: "equal", unit: "identity" },
          ),
          failureFact(
            "owner.agentId",
            observedOwner.agentId,
            expectedOwner.agentId,
            { comparison: "equal", unit: "identity" },
          ),
          failureFact(
            "owner.liveSetId",
            observedOwner.liveSetId,
            expectedOwner.liveSetId,
            { comparison: "equal", unit: "identity" },
          ),
        ]);
      const identity = await dependencies.ableton.getLiveIdentity();
      context.signal?.throwIfAborted();
      if (identity.liveSetId !== expectedOwner.liveSetId)
        deny("live_set_changed", undefined, [
          failureFact(
            "liveSet.id",
            identity.liveSetId,
            expectedOwner.liveSetId,
            { comparison: "equal", unit: "identity" },
          ),
        ]);
      const inventory = listeners().inspectListeners();
      if (inventory.length > 128)
        deny("listener_inventory_quota", undefined, [
          failureFact("listener.inventoryCount", inventory.length, 128, {
            comparison: "at-most",
            unit: "count",
          }),
        ]);
      for (const [id, attested] of attestedBindings) {
        if (
          attested.liveSetId !== expectedOwner.liveSetId ||
          !inventory.some(
            (item) =>
              item.connectionId === id &&
              item.producer.instanceId === attested.connection.instanceId &&
              item.registration.connectionEpoch ===
                attested.connection.connectionEpoch,
          )
        )
          attestedBindings.delete(id);
      }
      const selected = ids.map((id) => {
        const matches = inventory.filter(
          (item) => item.producer.producerId === id,
        );
        if (matches.length !== 1)
          deny("listener_unavailable_or_ambiguous", undefined, [
            failureFact("listener.matchingCount", matches.length, 1, {
              comparison: "equal",
              unit: "count",
            }),
            failureFact("listener.requestedId", id, undefined, {
              unit: "identity",
            }),
          ]);
        const candidate = readConnectedListenerBinding(
          bindingDescriptor(matches[0]!, options.independentMetricListeners),
        );
        if (!candidate.ok)
          deny(candidate.reason, undefined, [
            failureFact("binding.registrationAccepted", candidate.ok, true, {
              comparison: "equal",
              unit: "boolean",
            }),
            failureFact("binding.reason", candidate.reason, undefined, {
              unit: "state",
            }),
          ]);
        return {
          descriptor: structuredClone(matches[0]!),
          connection: candidate.connection,
        };
      });
      const queryId = randomUUID();
      progress(
        "Checking registered placement against independent Live evidence",
      );
      const inspection = inspectListeningContextResultSchema.parse(
        await dependencies.ableton
          .inspectListeningContext({
            schemaVersion: 1,
            bindingQueryId: queryId,
            listeners: selected.map(({ connection }) => ({
              canonicalPath: connection.canonicalPath,
            })),
            range: { startBeat: range.startBeat, endBeat: range.endBeat },
            maxClips: 32,
            maxParameters: 16,
          })
          .catch((cause: unknown) => {
            context.signal?.throwIfAborted();
            if (
              selected.some(({ connection }) =>
                attestedBindings.has(connection.connectionId),
              ) &&
              cause instanceof Error &&
              cause.message.includes(
                "Listener must be a Max for Live Audio Effect",
              )
            )
              deny(
                "listener_placement_stale",
                "The registered path no longer attests the previously inspected Max listener. Wait for placement refresh, inspect listeners again, and start a new capture.",
                [
                  failureFact("binding.maxAudioEffectAttested", false, true, {
                    comparison: "equal",
                    unit: "boolean",
                  }),
                ],
              );
            throw cause;
          }),
      );
      context.signal?.throwIfAborted();
      const confirmedIdentity = await dependencies.ableton.getLiveIdentity();
      if (confirmedIdentity.liveSetId !== expectedOwner.liveSetId)
        deny("live_set_changed", undefined, [
          failureFact(
            "liveSet.id",
            confirmedIdentity.liveSetId,
            expectedOwner.liveSetId,
            { comparison: "equal", unit: "identity" },
          ),
        ]);
      context.signal?.throwIfAborted();
      const confirmedOwner = await owner(context);
      if (!sameOwner(confirmedOwner, expectedOwner))
        deny("permission_denied", undefined, [
          failureFact(
            "owner.sessionId",
            confirmedOwner.sessionId,
            expectedOwner.sessionId,
            { comparison: "equal", unit: "identity" },
          ),
          failureFact(
            "owner.agentId",
            confirmedOwner.agentId,
            expectedOwner.agentId,
            { comparison: "equal", unit: "identity" },
          ),
          failureFact(
            "owner.liveSetId",
            confirmedOwner.liveSetId,
            expectedOwner.liveSetId,
            { comparison: "equal", unit: "identity" },
          ),
        ]);
      context.signal?.throwIfAborted();
      const currentInventory = listeners().inspectListeners();
      const candidates = connected(currentInventory);
      for (const { connection, descriptor } of selected) {
        const current = candidates.filter(
          (item) => item.connectionId === connection.connectionId,
        );
        const currentDescriptor = currentInventory.find(
          (item) => item.connectionId === connection.connectionId,
        );
        if (
          current.length !== 1 ||
          !isDeepStrictEqual(current[0], connection) ||
          !isDeepStrictEqual(
            currentDescriptor?.registration,
            descriptor.registration,
          )
        )
          deny(
            "listener_placement_changed",
            "Listener registration changed during inspection. Wait for placement refresh, inspect listeners again, and start a new capture.",
            [
              failureFact("binding.currentConnectionCount", current.length, 1, {
                comparison: "equal",
                unit: "count",
              }),
              failureFact(
                "binding.connectionUnchanged",
                isDeepStrictEqual(current[0], connection),
                true,
                { comparison: "equal", unit: "boolean" },
              ),
              failureFact(
                "binding.registrationUnchanged",
                isDeepStrictEqual(
                  currentDescriptor?.registration,
                  descriptor.registration,
                ),
                true,
                { comparison: "equal", unit: "boolean" },
              ),
            ],
          );
        if (
          !discovery &&
          previous === undefined &&
          currentDescriptor?.phase !== "idle"
        )
          deny("listener_not_idle", undefined, [
            failureFact("listener.phase", currentDescriptor?.phase, "idle", {
              comparison: "equal",
              unit: "state",
            }),
          ]);
      }
      if (inspection.listeners.length !== selected.length)
        deny("ambiguous_inspection", undefined, [
          failureFact(
            "binding.inspectedListenerCount",
            inspection.listeners.length,
            selected.length,
            { comparison: "equal", unit: "count" },
          ),
        ]);
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
          deny("listener_instance_changed", undefined, [
            failureFact(
              "listener.connectionId",
              connection.connectionId,
              old.connectionId,
              { comparison: "equal", unit: "identity" },
            ),
            failureFact(
              "listener.instanceId",
              connection.instanceId,
              old.instanceId,
              { comparison: "equal", unit: "identity" },
            ),
            failureFact(
              "listener.connectionEpoch",
              connection.connectionEpoch,
              old.connectionEpoch,
              { comparison: "equal", unit: "identity" },
            ),
            failureFact(
              "listener.canonicalPath",
              connection.canonicalPath,
              old.canonicalPath,
              { comparison: "equal", unit: "identity" },
            ),
          ]);
        const oldDescriptor = previous?.descriptors.find(
          (item) => item.producer.producerId === descriptor.producer.producerId,
        );
        if (
          oldDescriptor &&
          (oldDescriptor.registration.sampleRate !==
            descriptor.registration.sampleRate ||
            oldDescriptor.registration.algorithmVersion !==
              descriptor.registration.algorithmVersion ||
            oldDescriptor.registration.version !==
              descriptor.registration.version ||
            oldDescriptor.registration.vectorSize !==
              descriptor.registration.vectorSize)
        )
          deny("listener_algorithm_or_sample_rate_changed", undefined, [
            failureFact(
              "listener.sampleRate",
              descriptor.registration.sampleRate,
              oldDescriptor.registration.sampleRate,
              { comparison: "equal", unit: "Hz" },
            ),
            failureFact(
              "listener.algorithmVersion",
              descriptor.registration.algorithmVersion,
              oldDescriptor.registration.algorithmVersion,
              { comparison: "equal", unit: "identity" },
            ),
            failureFact(
              "listener.version",
              descriptor.registration.version,
              oldDescriptor.registration.version,
              { comparison: "equal" },
            ),
            failureFact(
              "listener.vectorSize",
              descriptor.registration.vectorSize,
              oldDescriptor.registration.vectorSize,
              { comparison: "equal", unit: "samples" },
            ),
          ]);
        const expectedTarget =
          previous?.inspection.listeners.find(
            (item) => item.canonicalPath === connection.canonicalPath,
          )?.binding ?? attestedBindings.get(connection.connectionId)?.target;
        const resolution = resolveListenerBinding({
          selected: {
            ...connection,
            ...(expectedTarget ? { expectedTarget } : {}),
          },
          connected: candidates,
          inspection,
          queryId,
        });
        if (!resolution.ok) {
          if (resolution.reason === "stale-inspection")
            deny(
              resolution.reason,
              "The reply does not match the current inspection. Request a fresh inspection before explicitly requesting a new listening pass.",
              [
                failureFact("binding.resolutionAccepted", false, true, {
                  comparison: "equal",
                  unit: "boolean",
                }),
                failureFact(
                  "binding.resolutionReason",
                  resolution.reason,
                  undefined,
                  { unit: "state" },
                ),
                failureFact("binding.requestQueryId", queryId, undefined, {
                  unit: "identity",
                }),
              ],
            );
          if (resolution.reason === "stale-connection")
            deny(
              "listener_instance_changed",
              "The listener connection changed during inspection. Rediscover the current listener before explicitly requesting a new listening pass.",
              [
                failureFact("binding.resolutionAccepted", false, true, {
                  comparison: "equal",
                  unit: "boolean",
                }),
                failureFact(
                  "binding.connectionId",
                  connection.connectionId,
                  undefined,
                  { unit: "identity" },
                ),
                failureFact(
                  "binding.connectionEpoch",
                  connection.connectionEpoch,
                  undefined,
                  { unit: "identity" },
                ),
              ],
            );
          deny(
            resolution.reason,
            resolution.reason === "stale-target"
              ? "Listener placement no longer matches its attested device. Wait for placement refresh, inspect listeners again, and start a new capture."
              : undefined,
            [
              failureFact("binding.resolutionAccepted", false, true, {
                comparison: "equal",
                unit: "boolean",
              }),
              failureFact(
                "binding.resolutionReason",
                resolution.reason,
                undefined,
                { unit: "state" },
              ),
              failureFact(
                "binding.registeredPath",
                connection.canonicalPath,
                undefined,
                { unit: "identity" },
              ),
            ],
          );
        }
        attestedBindings.set(connection.connectionId, {
          liveSetId: expectedOwner.liveSetId,
          connection: structuredClone(connection),
          target: structuredClone(resolution.target),
        });
        if (
          !discovery &&
          connection.nativeStatus.scope !== NATIVE_METRIC_LISTENING_SCOPE
        )
          deny("real_live_timing_validation_required", undefined, [
            failureFact(
              "listener.nativeScope",
              connection.nativeStatus.scope,
              undefined,
              { unit: "state" },
            ),
            failureFact(
              "listener.nativeReadiness",
              connection.nativeStatus.readiness,
              "READY",
              { comparison: "equal", unit: "state" },
            ),
            failureFact(
              "listener.nativeVersion",
              connection.nativeStatus.version,
              5,
              { comparison: "equal" },
            ),
          ]);
        if (!discovery && previous === undefined && descriptor.phase !== "idle")
          deny("listener_not_idle", undefined, [
            failureFact("listener.phase", descriptor.phase, "idle", {
              comparison: "equal",
              unit: "state",
            }),
          ]);
      }
      if (!discovery && sourceMode === "arrangement") {
        const hasOverride = inspection.listeners.some(
          (item) => item.sessionOverride === true,
        );
        const hasUnknown = inspection.listeners.some(
          (item) => item.sessionOverride === null,
        );
        const refusal = !inspection.transport.safeToStart
          ? "transport_not_safe_to_start"
          : hasUnknown
            ? "arrangement_source_unknown"
            : hasOverride
              ? "arrangement_session_override"
              : undefined;
        const inspectionCompleted = Date.now();
        recordSignalTelemetry(dependencies.telemetry, {
          name: "listening.source.validation",
          source: "listening-runtime-host",
          sessionId: context.sessionId,
          activeAgentId: context.agentId,
          liveSetId: expectedOwner.liveSetId,
          correlationId: context.trace.correlationId,
          causationId: context.trace.causationId,
          trace: { traceId: context.trace.traceId, spanId: randomUUID() },
          durationMs: Math.max(0, inspectionCompleted - inspectionStarted),
          outcome: refusal === undefined ? "success" : "failure",
          attributes: sanitizeTelemetryAttributes(
            {
              schemaVersion: 1,
              ...sourceBoundary,
              liveSetId: expectedOwner.liveSetId,
              bindingQueryId: queryId,
              inspectionStartedAt: new Date(inspectionStarted).toISOString(),
              inspectionCompletedAt: new Date(
                inspectionCompleted,
              ).toISOString(),
              projectRevision: inspection.projectRevision,
              decision: refusal ?? "arrangement-source-confirmed",
              listeners: selected.map(({ connection }) => {
                const listener = inspection.listeners.find(
                  (item) => item.canonicalPath === connection.canonicalPath,
                )!;
                return {
                  listenerId: connection.producerId,
                  instanceId: connection.instanceId,
                  connectionId: connection.connectionId,
                  connectionEpoch: connection.connectionEpoch,
                  canonicalPath: connection.canonicalPath,
                  sessionOverride: listener.sessionOverride,
                  state:
                    listener.sessionOverride === false
                      ? "arrangement"
                      : listener.sessionOverride === true
                        ? "session-override"
                        : "unknown",
                  sourceEvidence: listener.sourceEvidence ?? null,
                };
              }),
            },
            {
              maxStringCharacters: 512,
              maxArrayItems: 8,
              maxObjectFields: 32,
              maxDepth: 8,
              maxBytes: 16_384,
            },
          ),
        });
        if (refusal === "arrangement_session_override")
          deny(
            refusal,
            "A Session source override was detected for at least one selected listener. Return to Arrangement in Live for that track, then explicitly request a new listening pass. No capture was published.",
            [
              failureFact("source.sessionOverridePresent", hasOverride, false, {
                comparison: "equal",
                unit: "boolean",
              }),
            ],
          );
        if (refusal === "arrangement_source_unknown")
          deny(
            refusal,
            "Arrangement source selection could not be verified for at least one selected listener. Check the listener connection and source state in Live, then request a fresh inspection before a new listening pass. No capture was published.",
            [
              failureFact("source.selectionUnknown", hasUnknown, false, {
                comparison: "equal",
                unit: "boolean",
              }),
            ],
          );
        if (refusal !== undefined)
          deny(refusal, undefined, [
            failureFact(
              "transport.safeToStart",
              inspection.transport.safeToStart,
              true,
              { comparison: "equal", unit: "boolean" },
            ),
            failureFact("source.sessionOverridePresent", hasOverride, false, {
              comparison: "equal",
              unit: "boolean",
            }),
            failureFact("source.selectionUnknown", hasUnknown, false, {
              comparison: "equal",
              unit: "boolean",
            }),
          ]);
      }
      if (
        previous &&
        previous.inspection.projectRevision !== inspection.projectRevision &&
        !allowPositionRevision
      )
        deny("project_revision_changed", undefined, [
          failureFact(
            "project.revision",
            inspection.projectRevision,
            previous.inspection.projectRevision,
            { comparison: "equal", unit: "identity" },
          ),
          failureFact(
            "project.allowPositionRevision",
            allowPositionRevision,
            true,
            { comparison: "equal", unit: "boolean" },
          ),
        ]);
      if (
        previous &&
        (previous.inspection.transport.tempo !== inspection.transport.tempo ||
          previous.inspection.listeners.some(
            (before) =>
              inspection.listeners.find(
                (after) => after.canonicalPath === before.canonicalPath,
              )?.fingerprint.digest !== before.fingerprint.digest,
          ))
      )
        deny("listening_source_changed", undefined, [
          failureFact(
            "source.tempo",
            inspection.transport.tempo,
            previous.inspection.transport.tempo,
            { comparison: "equal" },
          ),
          ...previous.inspection.listeners.map((before, index) =>
            failureFact(
              `source.listener.${index}.fingerprint`,
              inspection.listeners.find(
                (after) => after.canonicalPath === before.canonicalPath,
              )?.fingerprint.digest,
              before.fingerprint.digest,
              { comparison: "equal", unit: "identity" },
            ),
          ),
        ]);
      return {
        owner: expectedOwner,
        descriptors: selected.map((item) => item.descriptor),
        connections: selected.map((item) => item.connection),
        inspection,
      };
    });
  }

  function state(input: ListeningPassContext): CaptureState {
    const cached = states.get(input.passId);
    if (!cached || !sameOwner(cached.owner, input.owner))
      deny("stale_listening_pass", undefined, [
        failureFact("pass.cached", cached !== undefined, true, {
          comparison: "equal",
          unit: "boolean",
        }),
        failureFact(
          "pass.ownerMatches",
          cached !== undefined && sameOwner(cached.owner, input.owner),
          true,
          { comparison: "equal", unit: "boolean" },
        ),
      ]);
    return cached;
  }

  async function repository(input: PassInput): Promise<Repository> {
    const context = execution(input, input.signal);
    const observedOwner = await owner(context);
    if (!sameOwner(observedOwner, input.owner))
      deny("permission_denied", undefined, [
        failureFact(
          "repository.ownerSession",
          observedOwner.sessionId,
          input.owner.sessionId,
          { comparison: "equal", unit: "identity" },
        ),
        failureFact(
          "repository.ownerAgent",
          observedOwner.agentId,
          input.owner.agentId,
          { comparison: "equal", unit: "identity" },
        ),
        failureFact(
          "repository.ownerSet",
          observedOwner.liveSetId,
          input.owner.liveSetId,
          { comparison: "equal", unit: "identity" },
        ),
      ]);
    const resolved = await options.resolveRepository(input.owner, context);
    input.signal.throwIfAborted();
    if (
      resolved.sessionId !== input.owner.sessionId ||
      resolved.liveSetId !== input.owner.liveSetId
    )
      deny("permission_denied", undefined, [
        failureFact(
          "repository.sessionId",
          resolved.sessionId,
          input.owner.sessionId,
          { comparison: "equal", unit: "identity" },
        ),
        failureFact(
          "repository.liveSetId",
          resolved.liveSetId,
          input.owner.liveSetId,
          { comparison: "equal", unit: "identity" },
        ),
      ]);
    return resolved;
  }

  const session = createSessionListeningServices({
    dependencies,
    resolveTimingPolicy: () =>
      options.resolveTimingPolicy?.() ?? DEFAULT_LISTENING_TIMING_POLICY,
    resolveRepository: repository,
    listeners,
    independentMetricListeners: options.independentMetricListeners === true,
    ...(options.requestedMetrics
      ? { requestedMetrics: options.requestedMetrics }
      : {}),
    stage,
    inspectBindings: (input) =>
      inspect(
        input.request.listenerIds,
        input.range,
        execution(input.context, input.signal),
        input.context.owner,
        input.previous,
        false,
        false,
        undefined,
        "session",
      ),
    trackSubject: (owner, listener, range) =>
      subject(owner, listener, range, "track"),
  });

  const services: ListeningCoordinatorServices = {
    inspect: (request, signal, pass) =>
      stage("inspection", execution(pass, signal), async () => {
        if (request.mode === "session")
          return session.services.inspect(request, signal, pass);
        const previous = states.get(pass.passId);
        const timingPolicy =
          previous?.timingPolicy ??
          Object.freeze(
            listeningTimingPolicySchema.parse(
              options.resolveTimingPolicy?.() ??
                DEFAULT_LISTENING_TIMING_POLICY,
            ),
          );
        const snapshot = await inspect(
          request.listenerIds,
          request,
          execution(pass, signal),
          pass.owner,
          previous,
          false,
          false,
          {
            passId: pass.passId,
            boundary: previous ? "post-arm-inspection" : "initial-inspection",
          },
        );
        assertCaptureDuration(request, snapshot.inspection);
        if (!dependencies.ableton.positionListeningPlayback)
          deny("listening_positioning_unavailable", undefined, [
            failureFact("playback.positioningAvailable", false, true),
          ]);
        const metricBindings = snapshot.descriptors.map((descriptor, index) => {
          const track = snapshot.inspection.listeners[index]!.binding.track;
          const targetIndex = track.kind === "master" ? null : track.index;
          if (targetIndex === undefined)
            deny("listener_track_index_unknown", undefined, [
              failureFact("binding.track.index", targetIndex, "known"),
            ]);
          return createMetricCaptureBinding({
            ...(options.requestedMetrics
              ? { requestedMetrics: options.requestedMetrics }
              : {}),
            descriptor,
            tempoBpm: snapshot.inspection.transport.tempo!,
            timingPolicy,
            source: {
              view: "arrangement",
              target: {
                kind: track.kind,
                index: targetIndex,
                expectedReference: track.expectedReference,
              },
              transport: {
                startBeat: request.startBeat,
                endBeat: request.endBeat,
              },
            },
          });
        });
        assertMetricDspGeometry(metricBindings);
        signal.throwIfAborted();
        if (!previous)
          states.set(pass.passId, {
            ...snapshot,
            owner: { ...pass.owner },
            request: structuredClone(request),
            createdAt: new Date().toISOString(),
            reserved: false,
            timingPolicy,
            trace: structuredClone(pass.trace),
            metricBindings,
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
          if (input.request.mode === "session")
            return session.services.reservePublication(input);
          const cached = state(input);
          const resolved = await repository(input);
          const receipt = await reserveListeningPublication(resolved, input);
          cached.repositoryIdentity = resolved.publicationIdentity ?? resolved;
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
          if (input.request.mode === "session")
            return session.services.prepare(input);
          const cached = state(input);
          if (!cached.reserved)
            deny("context_reservation_required", undefined, [
              failureFact("context.reserved", cached.reserved, true),
            ]);
          await repository(input);
          let snapshot = await inspect(
            input.request.listenerIds,
            cached.request,
            execution(input, input.signal),
            input.owner,
            cached,
            false,
            false,
            { passId: input.passId, boundary: "preparation-inspection" },
          );
          {
            const params = playbackParameters(cached, input);
            await stage(
              "source-positioning",
              execution(input, input.signal),
              async () => {
                if (!dependencies.ableton.positionListeningPlayback)
                  deny("listening_positioning_unavailable", undefined, [
                    failureFact("playback.positioningAvailable", false, true),
                  ]);
                const result = positionListeningPlaybackResultSchema.parse(
                  await dependencies.ableton.positionListeningPlayback(params),
                );
                if (result.requestedStartBeat !== cached.request.startBeat)
                  deny("invalid_source_position_readback", undefined, [
                    failureFact(
                      "playback.requestedStartBeat",
                      result.requestedStartBeat,
                      cached.request.startBeat,
                      { unit: "beats" },
                    ),
                  ]);
              },
            );
            snapshot = await stage(
              "positioned-inspection",
              execution(input, input.signal),
              () =>
                inspect(
                  input.request.listenerIds,
                  cached.request,
                  execution(input, input.signal),
                  input.owner,
                  cached,
                  false,
                  true,
                  { passId: input.passId, boundary: "positioned-inspection" },
                ),
            );
            if (
              snapshot.inspection.transport.currentBeat !==
              cached.request.startBeat
            )
              deny("source_position_changed", undefined, [
                failureFact(
                  "transport.currentBeat",
                  snapshot.inspection.transport.currentBeat,
                  cached.request.startBeat,
                  { unit: "beats" },
                ),
              ]);
            cached.inspection = snapshot.inspection;
          }
          input.signal.throwIfAborted();
          assertCaptureDuration(cached.request, snapshot.inspection);
          const captureInput = {
            passId: input.passId,
            trace: input.trace,
            signal: input.signal,
            ...(dependencies.telemetry
              ? { telemetry: dependencies.telemetry }
              : {}),
          };
          const capture = await prepareMetricListenerCapture(listeners(), {
            ...captureInput,
            bindings: cached.metricBindings,
          });
          void capture.result.catch((cause: unknown) => {
            const source = readListeningFailureEvidence(cause);
            cached.captureFailure = new ListeningFailure(
              "capture_failed",
              sanitizePersistedText(
                cause instanceof Error
                  ? cause.message
                  : "Listener capture failed",
              ).slice(0, 512),
              source.status === "present" ? source.evidence : undefined,
            );
          });
          if (capture.nativeLaunch !== undefined)
            cached.nativeLaunch = capture.nativeLaunch;
          else delete cached.nativeLaunch;
          return {
            observations: capture.result,
            disarm: () => capture.disarm(),
            observationContract: capture.observationContract,
          };
        },
        (capture) => capture.disarm(),
      ),
    startPlayback: (input) =>
      stage(
        "playback-start",
        execution(input, input.signal),
        async () => {
          if (input.request.mode === "session")
            return session.services.startPlayback(input);
          const cached = state(input);
          if (!cached.reserved)
            deny("context_reservation_required", undefined, [
              failureFact("context.reserved", cached.reserved, true),
            ]);
          await repository(input);
          input.signal.throwIfAborted();
          if (cached.captureFailure !== undefined) throw cached.captureFailure;
          if (!dependencies.ableton.startListeningPlayback)
            deny("listening_playback_unavailable", undefined, [
              failureFact("playback.startAvailable", false, true),
            ]);
          const nativeLaunch = cached.nativeLaunch;
          if (nativeLaunch === undefined)
            deny("source_onset_unverified", undefined, [
              failureFact("playback.nativeLaunchPresent", false, true),
            ]);
          const playback = await dependencies.ableton.startListeningPlayback(
            playbackParameters(cached, input),
          );
          if (playback.startedAtBeat !== cached.request.startBeat)
            deny("source_onset_unverified", undefined, [
              failureFact(
                "playback.startedAtBeat",
                playback.startedAtBeat,
                cached.request.startBeat,
                { unit: "beats" },
              ),
            ]);
          await stage(
            "native-onset",
            execution(input, input.signal),
            () => nativeLaunch,
          );
          cached.startedAt = new Date().toISOString();
          return {
            cleanupPolicy: "leave-running",
            release: async () => {},
          };
        },
        (playback) => playback.release(),
      ),
    validateObservations: (observations, request, passId) => {
      if (request.mode === "session")
        return session.services.validateObservations(
          observations,
          request,
          passId,
        );
      const cached = states.get(passId);
      if (!cached || request.mode !== "arrangement" || !cached.startedAt)
        deny("stale_listening_pass", undefined, [
          failureFact("pass.cached", cached !== undefined, true),
          failureFact("pass.mode", request.mode, "arrangement"),
          failureFact("pass.started", cached?.startedAt !== undefined, true),
        ]);
      validateMetricCaptureObservations(observations, cached.metricBindings, {
        passId,
        trace: cached.trace,
      });
      cached.endedAt = new Date().toISOString();
    },
    persist: (input) =>
      stage("publication", execution(input, input.signal), async () => {
        if (input.request.mode === "session")
          return session.services.persist(input);
        const cached = state(input);
        const resolved = await repository(input);
        const sameRepository =
          cached.repositoryIdentity ===
          (resolved.publicationIdentity ?? resolved);
        if (
          !cached.reserved ||
          !sameRepository ||
          !cached.startedAt ||
          !cached.endedAt
        )
          deny("invalid_publication_lifecycle", undefined, [
            failureFact("publication.reserved", cached.reserved, true),
            failureFact("publication.repositoryMatches", sameRepository, true),
            failureFact(
              "publication.started",
              cached.startedAt !== undefined,
              true,
            ),
            failureFact(
              "publication.ended",
              cached.endedAt !== undefined,
              true,
            ),
          ]);
        return persistMetricListeningObservations(
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
            observations: validateMetricCaptureObservations(
              input.observations,
              cached.metricBindings,
              { passId: input.passId, trace: input.trace },
            ),
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
            "native_per_pass_validation_required",
            "source_onset_unverified",
            "approximate_descriptive_only",
            "absolute_timing_accuracy_unknown",
            "constant_tempo_assumed_not_independently_verified",
            "tempo_automation_unsupported",
          );
          if (candidate.nativeStatus.supportedModes.includes("session"))
            limitations.push(
              "session_first_iteration_midi_or_warped_audio_only",
              "message_rate_source_monitoring_not_sample_accurate_continuity",
              "unknown_follow_actions_not_verified_disabled",
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
    resolveSessionTarget: (target, context) =>
      stage("session-target-resolution", context, async () => {
        const resolved = await owner(context);
        const snapshot = await dependencies.ableton.inspectSession();
        context.signal?.throwIfAborted();
        const identity = await dependencies.ableton.getLiveIdentity();
        if (identity.liveSetId !== resolved.liveSetId)
          deny("live_set_changed", undefined, [
            failureFact("liveSet.id", identity.liveSetId, resolved.liveSetId, {
              comparison: "equal",
              unit: "identity",
            }),
          ]);
        const track = snapshot.tracks.find(
          (item) =>
            item.index === target.track.index &&
            item.reference === target.track.expectedReference &&
            item.name === target.track.expectedName,
        );
        const clip = snapshot.clips?.find(
          (item) =>
            item.trackReference === track?.reference &&
            item.sceneIndex === target.sceneIndex &&
            item.reference === target.expectedClipReference &&
            item.name === target.expectedClipName,
        );
        if (!track || !clip)
          deny("stale_session_target", undefined, [
            failureFact("source.trackMatched", track !== undefined, true, {
              comparison: "equal",
              unit: "boolean",
            }),
            failureFact("source.clipMatched", clip !== undefined, true, {
              comparison: "equal",
              unit: "boolean",
            }),
            failureFact("source.trackIndex", target.track.index, undefined, {
              unit: "count",
            }),
            failureFact("source.sceneIndex", target.sceneIndex, undefined, {
              unit: "count",
            }),
            failureFact(
              "source.expectedTrackReference",
              target.track.expectedReference,
              undefined,
              { unit: "identity" },
            ),
            failureFact(
              "source.expectedClipReference",
              target.expectedClipReference,
              undefined,
              { unit: "identity" },
            ),
          ]);
        return {
          clipReference: clip.reference,
          trackReference: track.reference,
          target: structuredClone(target),
        };
      }),
    onChange: (job) => {
      if (
        ["completed", "partial", "failed", "cancelled", "interrupted"].includes(
          job.stage,
        )
      ) {
        states.delete(job.passId);
        session.forget(job.passId);
      }
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
        await session.shutdown();
        attestedBindings.clear();
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
        if (sessionId !== context.sessionId)
          deny("permission_denied", undefined, [
            failureFact("context.sessionId", sessionId, context.sessionId, {
              comparison: "equal",
              unit: "identity",
            }),
          ]);
        return contextPorts.getSessionContextInventory!(sessionId, context);
      });
  return ports;
}
