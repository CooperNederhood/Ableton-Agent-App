import type { TelemetryEventPage } from "../../apps/desktop/src/contracts.js";

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
          listener.listenerId === owner.listenerId,
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
