import { randomUUID } from "node:crypto";
import {
  appendContextPassSchema,
  contextSubjectSchema,
  CONTEXT_LIMITS,
  type AppendContextPass,
  type ContextRange,
  type ContextSubject,
  type EntityContextRepository,
} from "@ableton-agent/project-state";
import {
  storedAudioObservationSchema,
  storedObservationCoordinates,
  storedObservationIdentity,
  type MetricAudioObservation,
  type StoredAudioObservation,
} from "@ableton-agent/protocol";
import {
  ListeningFailure,
  type ListeningOwner,
  type ListeningTrace,
  type ListeningCoordinatorServices,
  type ListeningPublicationReservation,
} from "./listening-coordinator.js";

export async function reserveListeningPublication(
  repository: EntityContextRepository,
  input: Parameters<ListeningCoordinatorServices["reservePublication"]>[0],
): Promise<ListeningPublicationReservation> {
  if (
    repository.sessionId !== input.owner.sessionId ||
    repository.liveSetId !== input.owner.liveSetId
  ) {
    throw new ListeningFailure(
      "permission_denied",
      "Context quota belongs to another session or Live Set",
    );
  }
  const operation = {
    trace: input.trace,
    activeAgentId: input.owner.agentId,
  };
  if (input.signal.aborted) throw input.signal.reason;
  await repository.reservePass(input.passId, CONTEXT_LIMITS.passBytes, {
    ...operation,
    signal: input.signal,
  });
  let release: Promise<void> | undefined;
  const reservation: ListeningPublicationReservation = {
    release: () =>
      (release ??= repository.releaseReservation(input.passId, operation)),
  };
  if (input.signal.aborted) {
    await reservation.release();
    throw input.signal.reason;
  }
  return reservation;
}

export interface ListeningPublicationBinding {
  readonly listenerId: string;
  readonly deviceReference: string;
  readonly connectionEpoch: string;
  readonly version: string;
  readonly primary: ContextSubject;
  readonly contributors: readonly ContextSubject[];
  readonly attribution: "exclusive" | "mixed" | "unknown";
}

export interface ListeningPublicationInput {
  readonly passId: string;
  readonly owner: ListeningOwner;
  readonly trace: ListeningTrace;
  readonly requestedMode: "session" | "arrangement";
  readonly actualMode: "session" | "arrangement";
  readonly requestedRange: ContextRange;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly observations: readonly StoredAudioObservation[];
  /** Privileged, inspected subject bindings, never model-supplied JSON. */
  readonly bindings: readonly ListeningPublicationBinding[];
}

export function buildListeningPublication(
  input: ListeningPublicationInput,
  createId: () => string = randomUUID,
): AppendContextPass {
  return buildPublication(input, false, createId);
}

export interface MetricListeningPublicationInput extends Omit<
  ListeningPublicationInput,
  "observations"
> {
  readonly observations: readonly MetricAudioObservation[];
}

/** Call only after independent runtime source/ownership verification. */
export function buildMetricListeningPublication(
  input: MetricListeningPublicationInput,
  createId: () => string = randomUUID,
): AppendContextPass {
  return buildPublication(input, true, createId);
}

function buildPublication(
  input: ListeningPublicationInput,
  independentMetrics: boolean,
  createId: () => string,
): AppendContextPass {
  const observations = input.observations.map((raw) => {
    if ((raw.schema === "metric-audio-observation/v1") !== independentMetrics) {
      throw new ListeningFailure(
        "invalid_publication",
        "Observation requires its explicitly negotiated publication path",
      );
    }
    return storedAudioObservationSchema.parse(raw);
  });
  if (
    observations.length === 0 ||
    observations.length > CONTEXT_LIMITS.listenersPerPass ||
    input.bindings.length !== observations.length ||
    new Set(input.bindings.map(({ listenerId }) => listenerId)).size !==
      input.bindings.length ||
    new Set(
      observations.map((item) => storedObservationIdentity(item).listenerId),
    ).size !== observations.length
  ) {
    throw new ListeningFailure(
      "invalid_publication",
      "Publication requires one distinct binding and observation per listener",
    );
  }
  const subjects = new Map<string, ContextSubject>();
  const entries: AppendContextPass["entries"] = [];
  const links: AppendContextPass["links"] = [];
  for (const observation of observations) {
    const identity = storedObservationIdentity(observation);
    const coordinates = storedObservationCoordinates(observation);
    const sessionSource =
      observation.schema === "session-audio-observation/v1"
        ? observation.source
        : observation.schema === "metric-audio-observation/v1" &&
            observation.source.view === "session"
          ? observation.source
          : undefined;
    const isSession = sessionSource !== undefined;
    if (
      input.requestedMode !== (isSession ? "session" : "arrangement") ||
      input.actualMode !== (isSession ? "session" : "arrangement") ||
      (isSession &&
        (input.requestedRange.startBeat !== 0 ||
          input.requestedRange.endBeat > 499.5 ||
          input.requestedRange.endBeat <= 0))
    ) {
      throw new ListeningFailure(
        "invalid_publication",
        "Observation kind must match requested and actual playback coordinates",
      );
    }
    const binding = input.bindings.find(
      ({ listenerId }) => listenerId === identity.listenerId,
    );
    if (
      binding === undefined ||
      identity.passId !== input.passId ||
      (observation.schema !== "metric-audio-observation/v1" &&
        !observation.complete) ||
      coordinates.endSample <= coordinates.startSample ||
      coordinates.endBeat <= coordinates.startBeat
    ) {
      throw new ListeningFailure(
        "invalid_publication",
        "Incomplete or mismatched observations cannot be published as completed",
      );
    }
    const associated = [binding.primary, ...binding.contributors].map(
      (subject) => contextSubjectSchema.parse(subject),
    );
    if (
      observation.schema === "metric-audio-observation/v1" &&
      (observation.ownership.connectionEpoch !== binding.connectionEpoch ||
        observation.ownership.traceId !== input.trace.traceId ||
        observation.ownership.correlationId !== input.trace.correlationId ||
        observation.ownership.causationId !== input.trace.causationId ||
        coordinates.startBeat !== input.requestedRange.startBeat ||
        coordinates.endBeat !== input.requestedRange.endBeat ||
        (observation.source.view === "arrangement" &&
          !associated[0]!.binding.previousRuntimeBindings.includes(
            observation.source.target.expectedReference,
          )))
    ) {
      throw new ListeningFailure(
        "invalid_publication",
        "Metric source, trace, connection epoch and requested range must match inspected ownership",
      );
    }
    if (
      observation.schema !== "audio-observation/v1" &&
      binding.attribution === "exclusive"
    ) {
      throw new ListeningFailure(
        "invalid_publication",
        "Approximate descriptive observations cannot certify exclusive attribution",
      );
    }
    if (sessionSource !== undefined) {
      const { target } = sessionSource;
      const primary = associated[0]!;
      const track = associated
        .slice(1)
        .find(
          (subject) =>
            subject.kind === "track" &&
            subject.id === primary.trackId &&
            subject.trackId === primary.trackId &&
            subject.binding.previousRuntimeBindings.includes(
              target.track.expectedReference,
            ),
        );
      if (
        primary.kind !== "clip" ||
        primary.location !== "session" ||
        primary.binding.semanticLocator.sceneIndex !== target.sceneIndex ||
        !primary.binding.previousRuntimeBindings.includes(
          target.expectedClipReference,
        ) ||
        track === undefined ||
        associated.slice(1).some((subject) => subject.kind !== "track")
      ) {
        throw new ListeningFailure(
          "invalid_publication",
          "Session publication requires an exact inspected clip and contributing track binding",
        );
      }
    }
    if (new Set(associated.map(({ id }) => id)).size !== associated.length) {
      throw new ListeningFailure(
        "invalid_publication",
        "A listener cannot duplicate its primary or contributing subject",
      );
    }
    const entryId = createId();
    entries.push({
      id: entryId,
      sessionId: input.owner.sessionId,
      liveSetId: input.owner.liveSetId,
      passId: input.passId,
      kind: observation.schema,
      producer: {
        listenerId: identity.listenerId,
        deviceId: binding.deviceReference,
        agentId: input.owner.agentId,
        connectionEpoch: binding.connectionEpoch,
        version: binding.version,
      },
      createdAt: input.endedAt,
      capturedAt: input.startedAt,
      trace: input.trace,
      payload: observation,
    });
    associated.forEach((subject, index) => {
      if (
        subject.sessionId !== input.owner.sessionId ||
        subject.liveSetId !== input.owner.liveSetId
      ) {
        throw new ListeningFailure(
          "permission_denied",
          "Context subject belongs to another App session or Live Set",
        );
      }
      const previous = subjects.get(subject.id);
      if (
        previous !== undefined &&
        JSON.stringify(previous) !== JSON.stringify(subject)
      ) {
        throw new ListeningFailure(
          "invalid_publication",
          "A subject ID has inconsistent inspected binding evidence",
        );
      }
      subjects.set(subject.id, subject);
      links.push({
        id: createId(),
        sessionId: input.owner.sessionId,
        liveSetId: input.owner.liveSetId,
        entryId,
        subjectId: subject.id,
        relationship: index === 0 ? "primary" : "contributor",
        coverage:
          sessionSource !== undefined
            ? index === 0
              ? {
                  coordinate: "clip-local-beats",
                  iteration: 0,
                  startBeat: 0,
                  endBeat: coordinates.endBeat,
                }
              : {
                  coordinate: "transport-beats",
                  ...sessionSource.transport,
                }
            : {
                startBeat: coordinates.startBeat,
                endBeat: coordinates.endBeat,
              },
        attribution: binding.attribution,
        observedContributorIds: binding.contributors.map(({ id }) => id),
        sourceFingerprint: subject.binding,
        freshness: {
          status: "unknown",
          assessedAt: input.endedAt,
          reason:
            "Historical capture evidence; current source/dependency freshness requires independent revalidation",
        },
      });
    });
  }
  const complete = observations.every((observation) =>
    observation.schema === "metric-audio-observation/v1"
      ? observation.outcome === "complete"
      : observation.complete,
  );
  const publication = appendContextPassSchema.parse({
    pass: {
      id: input.passId,
      sessionId: input.owner.sessionId,
      liveSetId: input.owner.liveSetId,
      initiatorAgentId: input.owner.agentId,
      listenerIds: observations.map(
        (item) => storedObservationIdentity(item).listenerId,
      ),
      requestedMode: input.requestedMode,
      actualMode: input.actualMode,
      requestedRange: input.requestedRange,
      actualRange: {
        startBeat: Math.min(
          ...observations.map(
            (item) => storedObservationCoordinates(item).startBeat,
          ),
        ),
        endBeat: Math.max(
          ...observations.map(
            (item) => storedObservationCoordinates(item).endBeat,
          ),
        ),
      },
      status: complete ? "completed" : "partial",
      complete,
      createdAt: input.createdAt,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      interruptionReason: complete
        ? null
        : "Some requested metric evidence is unavailable; see metric coverage",
      trace: input.trace,
    },
    subjects: [...subjects.values()],
    entries,
    links,
  });
  if (
    new TextEncoder().encode(JSON.stringify(publication)).byteLength >
    CONTEXT_LIMITS.passBytes
  ) {
    throw new ListeningFailure(
      "quota_exceeded",
      "Listening publication exceeds the per-pass context budget",
    );
  }
  return publication;
}

export async function persistListeningObservations(
  repository: EntityContextRepository,
  input: ListeningPublicationInput,
  signal: AbortSignal,
): Promise<readonly string[]> {
  return persistPublication(repository, input, signal, () =>
    buildListeningPublication(input),
  );
}

export async function persistMetricListeningObservations(
  repository: EntityContextRepository,
  input: MetricListeningPublicationInput,
  signal: AbortSignal,
): Promise<readonly string[]> {
  return persistPublication(repository, input, signal, () =>
    buildMetricListeningPublication(input),
  );
}

async function persistPublication(
  repository: EntityContextRepository,
  input: Pick<ListeningPublicationInput, "owner" | "trace">,
  signal: AbortSignal,
  build: () => AppendContextPass,
): Promise<readonly string[]> {
  signal.throwIfAborted();
  if (
    repository.sessionId !== input.owner.sessionId ||
    repository.liveSetId !== input.owner.liveSetId
  ) {
    throw new ListeningFailure(
      "permission_denied",
      "Listening publication repository belongs to another session or Set",
    );
  }
  const publication = build();
  await repository.appendPass(publication, {
    signal,
    trace: input.trace,
    activeAgentId: input.owner.agentId,
  });
  return publication.entries.map(({ id }) => id);
}
