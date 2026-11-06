import type { TelemetryEventPage } from "../../apps/desktop/src/contracts.js";
import type {
  CaptureEvidence,
  FlatnessSmokeEvidence,
  SpreadSmokeEvidence,
  RolloffSmokeEvidence,
  PitchSmokeEvidence,
  MelSmokeEvidence,
  SessionIdentity,
  SpectralShapeSmokeEvidence,
  SessionSourceEvidence,
} from "@ableton-agent/test-support/integration";
import {
  projectFlatnessSmoke,
  projectSpreadSmoke,
  projectRolloffSmoke,
  projectPitchSmoke,
  projectMelSmoke,
} from "@ableton-agent/test-support/integration";
import type { MetricAudioObservation } from "@ableton-agent/protocol";

/** Re-read raw typed context and cleanup History, never reuse cached mel vectors. */
export async function restoreMelSmoke(
  originals: readonly MelSmokeEvidence[],
  afterOwnedRestart: boolean,
  identity: SessionIdentity,
  readObservation: (contextId: string) => Promise<unknown>,
  readTrace: (traceId: string) => Promise<readonly EvidenceEvent[]>,
): Promise<MelSmokeEvidence[]> {
  const result: MelSmokeEvidence[] = [];
  for (const original of originals) {
    const owner = original.observation.ownership;
    const observation = await readObservation(original.contextId);
    const history = await readTrace(owner.traceId);
    const cleanupComplete = captureCleanupConfirmed(history, {
      traceId: owner.traceId,
      correlationId: owner.correlationId,
      passId: owner.passId,
      listenerId: owner.listenerId,
      sessionId: identity.appSessionId,
      agentId: identity.agentId,
      native: owner,
    });
    result.push(
      projectMelSmoke(
        observation,
        original.contextId,
        cleanupComplete,
        history,
        afterOwnedRestart,
      ),
    );
  }
  return result;
}

/** Re-read the typed History boundary; a pre-restart cached projection is not proof. */
export async function restoreFlatnessSmoke(
  original: readonly FlatnessSmokeEvidence[],
  afterOwnedRestart: boolean,
  readTrace: (traceId: string) => Promise<TelemetryEventPage["items"]>,
): Promise<FlatnessSmokeEvidence[]> {
  return restoreSmoke(
    original,
    afterOwnedRestart,
    readTrace,
    projectFlatnessSmoke,
  );
}

export async function restoreSpreadSmoke(
  original: readonly SpreadSmokeEvidence[],
  afterOwnedRestart: boolean,
  readTrace: (traceId: string) => Promise<TelemetryEventPage["items"]>,
): Promise<SpreadSmokeEvidence[]> {
  return restoreSmoke(
    original,
    afterOwnedRestart,
    readTrace,
    projectSpreadSmoke,
  );
}

export async function restoreRolloffSmoke(
  original: readonly RolloffSmokeEvidence[],
  afterOwnedRestart: boolean,
  readTrace: (traceId: string) => Promise<TelemetryEventPage["items"]>,
): Promise<RolloffSmokeEvidence[]> {
  return restoreSmoke(
    original,
    afterOwnedRestart,
    readTrace,
    projectRolloffSmoke,
  );
}

async function restoreSmoke(
  original: readonly SpectralShapeSmokeEvidence[],
  afterOwnedRestart: boolean,
  readTrace: (traceId: string) => Promise<TelemetryEventPage["items"]>,
  project: typeof projectFlatnessSmoke,
): Promise<SpectralShapeSmokeEvidence[]> {
  const result: SpectralShapeSmokeEvidence[] = [];
  for (const traceId of new Set(original.map((entry) => entry.traceId))) {
    const history = await readTrace(traceId);
    for (const entry of original.filter(
      (candidate) => candidate.traceId === traceId,
    ))
      result.push(
        project(
          history,
          {
            traceId: entry.traceId,
            correlationId: entry.correlationId,
            passId: entry.passId,
            listenerId: entry.listenerId,
            native: entry.native,
          },
          afterOwnedRestart,
        ),
      );
  }

  return result;
}

export async function restorePitchSmoke(
  original: readonly PitchSmokeEvidence[],
  afterOwnedRestart: boolean,
  readTrace: (traceId: string) => Promise<TelemetryEventPage["items"]>,
): Promise<PitchSmokeEvidence[]> {
  return restoreSmoke(
    original,
    afterOwnedRestart,
    readTrace,
    projectPitchSmoke,
  );
}

/** Persisted observations must select an admitted kind and location, not invent content identity. */
export function observedSessionSource(
  observed: MetricAudioObservation["source"],
  listenerId: string,
  sources: Readonly<Record<string, SessionSourceEvidence>>,
): SessionSourceEvidence {
  if (
    observed.view !== "session" ||
    (observed.kind !== "midi" && observed.kind !== "warped-audio")
  )
    throw new Error("Expected persisted Session source evidence");
  const matches = Object.values(sources).filter(
    (candidate) =>
      ("midi" in candidate
        ? observed.kind === "midi"
        : observed.kind === "warped-audio") &&
      candidate.source.trackId === observed.target.track.expectedReference &&
      candidate.source.clipId === observed.clipReference &&
      candidate.source.clipId === observed.target.expectedClipReference &&
      candidate.source.slotIndex === observed.target.sceneIndex &&
      candidate.facts.trackName === observed.target.track.expectedName &&
      candidate.facts.trackIndex === observed.target.track.index &&
      candidate.facts.clipName === observed.target.expectedClipName &&
      candidate.listenerId === listenerId,
  );
  if (matches.length !== 1)
    throw new Error(
      "Context belongs to an unadmitted or ambiguous source or listener",
    );
  return matches[0]!;
}

type EvidenceEvent = Pick<
  TelemetryEventPage["items"][number],
  | "name"
  | "trace"
  | "correlationId"
  | "attributes"
  | "outcome"
  | "durationMs"
  | "sessionId"
  | "activeAgentId"
>;

/** Job completion is lifecycle-only; require separately journaled resource release. */
export function captureCleanupConfirmed(
  events: readonly EvidenceEvent[],
  owner: {
    traceId: string;
    correlationId: string;
    passId: string;
    listenerId: string;
    sessionId: string;
    agentId: string;
    native: NonNullable<CaptureEvidence["native"]>;
  },
): boolean {
  const owned = events.filter(
    (event) =>
      event.trace?.traceId === owner.traceId &&
      event.correlationId === owner.correlationId &&
      event.attributes.passId === owner.passId,
  );
  if (
    owned.some(
      (event) =>
        event.name.startsWith("listening.") &&
        (event.outcome === "failure" || event.outcome === "cancelled"),
    )
  )
    throw new Error("Listening trace contains a failed or cancelled stage");
  const successful = owned.filter(
    (event) =>
      event.outcome === "success" &&
      event.durationMs !== undefined &&
      Number.isFinite(event.durationMs) &&
      event.durationMs >= 0,
  );
  const nativeEvents = successful.filter(
    (event) =>
      event.name === "listening.metric-capture.completed" &&
      Array.isArray(event.attributes.listeners) &&
      event.attributes.listeners.length === 1 &&
      event.attributes.listeners.some(
        (listener: unknown) =>
          listener !== null &&
          typeof listener === "object" &&
          !Array.isArray(listener) &&
          "listenerId" in listener &&
          listener.listenerId === owner.listenerId &&
          (
            [
              "generation",
              "nativeEpoch",
              "connectionId",
              "connectionEpoch",
            ] as const
          ).every(
            (key) =>
              Object.hasOwn(listener, key) &&
              Reflect.get(listener, key) === owner.native[key],
          ),
      ),
  );
  const actions = new Set(nativeEvents.map((event) => event.attributes.action));
  const native =
    actions.has("cleanup") ||
    (actions.has("release") && actions.has("finalization"));
  const source = successful.some(
    (event) =>
      event.name === "listening.runtime.session-source-cleanup.completed" &&
      event.sessionId === owner.sessionId &&
      event.activeAgentId === owner.agentId,
  );
  return native && source;
}
