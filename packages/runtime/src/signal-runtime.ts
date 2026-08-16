import type {
  PendingSignalContext,
  SignalContextProvider,
  SignalDeliveryService,
} from "@ableton-agent/application";
import {
  DEFAULT_SIGNAL_INGRESS_HOST,
  InMemoryConnectionRegistry,
  SignalIngressServer,
  SignalRouter,
  SignalRoutingSummaryPublisher,
  type OutputAssignment,
  type OutputConnection,
  type SignalIngressEndpoint,
  type TranslatedSignalContext,
} from "@ableton-agent/signal-routing";
import { noopLogger, type Logger } from "@ableton-agent/shared";

export type SignalRuntimeStatus =
  | { readonly state: "disabled"; readonly detail: string }
  | { readonly state: "stopped" }
  | {
      readonly state: "listening";
      readonly host: string;
      readonly port: number;
    }
  | { readonly state: "error"; readonly detail: string };

export type SignalRuntimeEvent =
  | {
      readonly type: "connections.changed";
      readonly connections: readonly OutputConnection[];
    }
  | {
      readonly type: "assignments.changed";
      readonly assignments: readonly OutputAssignment[];
    }
  | {
      readonly type: "latest-window.changed";
      readonly assignmentId: string;
      readonly context?: TranslatedSignalContext;
    }
  | { readonly type: "status.changed"; readonly status: SignalRuntimeStatus }
  | {
      readonly type: "diagnostic";
      readonly level: "warning" | "error";
      readonly message: string;
    };

export interface SignalRuntimeOptions {
  readonly secret?: string;
  readonly descriptorPath?: string;
  readonly port?: number;
  readonly staleAfterMs?: number;
  readonly logger?: Logger;
}

export interface SignalRuntime {
  readonly provider: SignalContextProvider;
  getStatus(): SignalRuntimeStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  setActiveSession(sessionId: string | undefined): void;
  setDeliveryService(service: SignalDeliveryService): void;
  listConnections(): readonly OutputConnection[];
  listAssignments(): readonly OutputAssignment[];
  upsertAssignment(assignment: OutputAssignment): OutputAssignment;
  removeAssignment(assignmentId: string): boolean;
  subscribe(listener: (event: SignalRuntimeEvent) => void): () => void;
}

function deliveryId(context: TranslatedSignalContext): string {
  return `${context.assignmentId}:${context.sequence}`;
}

function parseDeliveryId(
  value: string,
): { assignmentId: string; sequence: number } | undefined {
  const separator = value.lastIndexOf(":");
  const sequence = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(sequence) || sequence < 0) {
    return undefined;
  }
  return { assignmentId: value.slice(0, separator), sequence };
}

export class DefaultSignalRuntime
  implements SignalRuntime, SignalContextProvider
{
  readonly #publisher = new SignalRoutingSummaryPublisher();
  readonly #registry: InMemoryConnectionRegistry;
  readonly #router: SignalRouter;
  readonly #ingress: SignalIngressServer | undefined;
  readonly #listeners = new Set<(event: SignalRuntimeEvent) => void>();
  readonly #scheduledAutomatic = new Set<string>();
  readonly #logger: Logger;
  #activeSessionId: string | undefined;
  #deliveryService: SignalDeliveryService | undefined;
  #status: SignalRuntimeStatus;

  constructor(options: SignalRuntimeOptions) {
    this.#logger = options.logger ?? noopLogger;
    this.#registry = new InMemoryConnectionRegistry({
      staleAfterMs: options.staleAfterMs ?? 15_000,
      publisher: this.#publisher,
    });
    this.#router = new SignalRouter({
      registry: this.#registry,
      publisher: this.#publisher,
    });
    this.#status =
      options.secret === undefined
        ? {
            state: "disabled",
            detail:
              "Signal ingress is disabled because no local authentication token is configured.",
          }
        : { state: "stopped" };
    this.#ingress =
      options.secret === undefined
        ? undefined
        : new SignalIngressServer({
            secret: options.secret,
            registry: this.#registry,
            router: this.#router,
            host: DEFAULT_SIGNAL_INGRESS_HOST,
            ...(options.port === undefined ? {} : { port: options.port }),
            ...(options.descriptorPath === undefined
              ? {}
              : { descriptorPath: options.descriptorPath }),
            onDiagnostic: ({ message }) =>
              this.#emit({
                type: "diagnostic",
                level: "warning",
                message: `Signal ingress: ${message}`,
              }),
          });
    this.#publisher.subscribe((summary) => {
      this.#logger.debug("Signal routing summary", { summary });
      if (summary.kind === "connections") {
        this.#emit({
          type: "connections.changed",
          connections: this.listConnections(),
        });
      } else if (summary.kind === "assignments") {
        this.#emit({
          type: "assignments.changed",
          assignments: this.listAssignments(),
        });
      } else {
        const context = this.#router.inbox(summary.assignmentId).at(-1);
        this.#emit({
          type: "latest-window.changed",
          assignmentId: summary.assignmentId,
          ...(context === undefined ? {} : { context }),
        });
        if (context !== undefined) this.#scheduleAutomatic(context);
      }
    });
  }

  get provider(): SignalContextProvider {
    return this;
  }

  getStatus(): SignalRuntimeStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#ingress === undefined) {
      this.#emit({ type: "status.changed", status: this.#status });
      return;
    }
    try {
      const endpoint: SignalIngressEndpoint = await this.#ingress.start();
      this.#logger.info("Signal ingress started", { ...endpoint });
      this.#setStatus({ state: "listening", ...endpoint });
    } catch (error) {
      this.#logger.error("Signal ingress startup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.#setStatus({
        state: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#activeSessionId = undefined;
    if (this.#ingress !== undefined) await this.#ingress.stop();
    this.#logger.info("Signal ingress stopped");
    if (this.#status.state !== "disabled")
      this.#setStatus({ state: "stopped" });
  }

  setActiveSession(sessionId: string | undefined): void {
    this.#activeSessionId = sessionId;
  }

  setDeliveryService(service: SignalDeliveryService): void {
    this.#deliveryService = service;
  }

  listConnections(): readonly OutputConnection[] {
    return this.#registry.list();
  }

  listAssignments(): readonly OutputAssignment[] {
    return this.#router.listAssignments();
  }

  upsertAssignment(assignment: OutputAssignment): OutputAssignment {
    const result = this.#router.upsertAssignment(assignment);
    this.#logger.debug("Signal assignment updated", { assignment: result });
    return result;
  }

  removeAssignment(assignmentId: string): boolean {
    const removed = this.#router.removeAssignment(assignmentId);
    this.#logger.debug("Signal assignment removed", {
      assignmentId,
      removed,
    });
    return removed;
  }

  subscribe(listener: (event: SignalRuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getPendingContexts(
    sessionId: string,
  ): Promise<readonly PendingSignalContext[]> {
    if (sessionId !== this.#activeSessionId) return [];
    return this.#router
      .listAssignments()
      .filter(
        (assignment) =>
          assignment.enabled &&
          assignment.consumer.kind === "agent-session" &&
          assignment.consumer.id === sessionId &&
          assignment.deliveryMode === "next-prompt",
      )
      .flatMap((assignment) =>
        this.#router.inbox(assignment.assignmentId).map((context) => ({
          deliveryId: deliveryId(context),
          context,
          usageInstruction: assignment.usageInstruction,
        })),
      );
  }

  async markDelivered(
    sessionId: string,
    deliveryIds: readonly string[],
  ): Promise<void> {
    if (sessionId !== this.#activeSessionId) return;
    const grouped = new Map<string, number[]>();
    for (const id of deliveryIds) {
      const parsed = parseDeliveryId(id);
      if (parsed === undefined) continue;
      const assignment = this.#router
        .listAssignments()
        .find(({ assignmentId }) => assignmentId === parsed.assignmentId);
      if (
        assignment?.consumer.kind !== "agent-session" ||
        assignment.consumer.id !== sessionId
      ) {
        continue;
      }
      const sequences = grouped.get(parsed.assignmentId) ?? [];
      sequences.push(parsed.sequence);
      grouped.set(parsed.assignmentId, sequences);
    }
    for (const [assignmentId, sequences] of grouped) {
      this.#router.acknowledge(assignmentId, sequences);
      for (const sequence of sequences) {
        this.#scheduledAutomatic.delete(`${assignmentId}:${sequence}`);
      }
    }
  }

  #scheduleAutomatic(context: TranslatedSignalContext): void {
    if (context.deliveryMode === "next-prompt") return;
    const sessionId = this.#activeSessionId;
    if (
      sessionId === undefined ||
      context.consumer.kind !== "agent-session" ||
      context.consumer.id !== sessionId
    ) {
      return;
    }
    const id = deliveryId(context);
    if (this.#scheduledAutomatic.has(id)) return;
    const assignment = this.#router
      .listAssignments()
      .find(({ assignmentId }) => assignmentId === context.assignmentId);
    const service = this.#deliveryService;
    if (assignment === undefined || service === undefined) return;
    this.#scheduledAutomatic.add(id);
    this.#logger.debug("Automatic signal turn scheduled", {
      deliveryId: id,
      context,
      usageInstruction: assignment.usageInstruction,
    });
    void service
      .enqueueSignalTurn({
        deliveryId: id,
        context: context as TranslatedSignalContext & {
          deliveryMode: "automatic-analysis" | "automatic-action";
        },
        usageInstruction: assignment.usageInstruction,
      })
      .catch((error: unknown) => {
        this.#logger.error("Automatic signal delivery failed", {
          deliveryId: id,
          context,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#scheduledAutomatic.delete(id);
        this.#emit({
          type: "diagnostic",
          level: "error",
          message: `Automatic signal delivery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }

  #setStatus(status: SignalRuntimeStatus): void {
    this.#status = status;
    this.#emit({ type: "status.changed", status });
  }

  #emit(event: SignalRuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
