import type {
  OutputAssignment,
  OutputConnection,
  TranslatedSignalContext,
} from "./contracts.js";

export type SignalRoutingSummary =
  | {
      readonly kind: "connections";
      readonly total: number;
      readonly connected: number;
      readonly stale: number;
      readonly disconnected: number;
    }
  | {
      readonly kind: "assignments";
      readonly total: number;
      readonly enabled: number;
    }
  | {
      readonly kind: "inbox";
      readonly assignmentId: string;
      readonly size: number;
      readonly newestSequence?: number;
    };

export type SignalRoutingSummaryListener = (
  summary: SignalRoutingSummary,
) => void;

export class SignalRoutingSummaryPublisher {
  readonly #listeners = new Set<SignalRoutingSummaryListener>();

  subscribe(listener: SignalRoutingSummaryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publishConnections(connections: readonly OutputConnection[]): void {
    this.#publish({
      kind: "connections",
      total: connections.length,
      connected: connections.filter(({ status }) => status === "connected")
        .length,
      stale: connections.filter(({ status }) => status === "stale").length,
      disconnected: connections.filter(
        ({ status }) => status === "disconnected",
      ).length,
    });
  }

  publishAssignments(assignments: readonly OutputAssignment[]): void {
    this.#publish({
      kind: "assignments",
      total: assignments.length,
      enabled: assignments.filter(({ enabled }) => enabled).length,
    });
  }

  publishInbox(
    assignmentId: string,
    inbox: readonly TranslatedSignalContext[],
  ): void {
    const newest = inbox.at(-1);
    this.#publish({
      kind: "inbox",
      assignmentId,
      size: inbox.length,
      ...(newest === undefined ? {} : { newestSequence: newest.sequence }),
    });
  }

  #publish(summary: SignalRoutingSummary): void {
    for (const listener of this.#listeners) {
      listener(summary);
    }
  }
}
