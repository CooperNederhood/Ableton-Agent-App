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
import type { AudioObservation } from "@ableton-agent/protocol";
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
  readonly observations: readonly AudioObservation[];
  /** Privileged, inspected subject bindings, never model-supplied JSON. */
  readonly bindings: readonly ListeningPublicationBinding[];
}

export function buildListeningPublication(
  input: ListeningPublicationInput,
  createId: () => string = randomUUID,
): AppendContextPass {
  if (
    input.observations.length === 0 ||
    input.observations.length > CONTEXT_LIMITS.listenersPerPass ||
    input.bindings.length !== input.observations.length ||
    new Set(input.bindings.map(({ listenerId }) => listenerId)).size !==
      input.bindings.length ||
    new Set(input.observations.map(({ listenerId }) => listenerId)).size !==
      input.observations.length
  ) {
    throw new ListeningFailure(
      "invalid_publication",
      "Publication requires one distinct binding and observation per listener",
    );
  }
  const subjects = new Map<string, ContextSubject>();
  const entries: AppendContextPass["entries"] = [];
  const links: AppendContextPass["links"] = [];
  for (const observation of input.observations) {
    const binding = input.bindings.find(
      ({ listenerId }) => listenerId === observation.listenerId,
    );
    if (
      binding === undefined ||
      observation.passId !== input.passId ||
      !observation.complete ||
      observation.endSample <= observation.startSample ||
      observation.endBeat <= observation.startBeat
    ) {
      throw new ListeningFailure(
        "invalid_publication",
        "Incomplete or mismatched observations cannot be published as completed",
      );
    }
    const associated = [binding.primary, ...binding.contributors].map(
      (subject) => contextSubjectSchema.parse(subject),
    );
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
      kind: "audio-observation/v1",
      producer: {
        listenerId: observation.listenerId,
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
        coverage: {
          startBeat: observation.startBeat,
          endBeat: observation.endBeat,
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
  const publication = appendContextPassSchema.parse({
    pass: {
      id: input.passId,
      sessionId: input.owner.sessionId,
      liveSetId: input.owner.liveSetId,
      initiatorAgentId: input.owner.agentId,
      listenerIds: input.observations.map(({ listenerId }) => listenerId),
      requestedMode: input.requestedMode,
      actualMode: input.actualMode,
      requestedRange: input.requestedRange,
      actualRange: {
        startBeat: Math.min(
          ...input.observations.map(({ startBeat }) => startBeat),
        ),
        endBeat: Math.max(...input.observations.map(({ endBeat }) => endBeat)),
      },
      status: "completed",
      complete: true,
      createdAt: input.createdAt,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      interruptionReason: null,
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
  const publication = buildListeningPublication(input);
  await repository.appendPass(publication, {
    signal,
    trace: input.trace,
    activeAgentId: input.owner.agentId,
  });
  return publication.entries.map(({ id }) => id);
}
