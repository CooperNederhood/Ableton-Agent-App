export * from "./compatibility.js";
export * from "./errors.js";
export * from "./product-versions.generated.js";

export type LifecycleState =
  "stopped" | "starting" | "ready" | "degraded" | "stopping";

export type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | {
      state: "connected";
      liveVersion: string;
      remoteScriptVersion: string;
      projectId: string;
    }
  | { state: "error"; code: string; message: string };

export interface AgentEventAttribution {
  agentInstanceId?: string;
  sdkSessionId?: string;
}

export type AgentMode = "interactive" | "plan";

export type AgentPlanExitAction = "exit_only" | "interactive";

export interface AgentPlanApprovalRequest {
  readonly requestId: string;
  readonly summary: string;
  readonly planContent: string;
  readonly planRevision: string;
  readonly planUpdatedAt: string;
  readonly recommendedAction: AgentPlanExitAction;
  readonly actions: readonly AgentPlanExitAction[];
}

export type PlanArtifactSnapshot =
  | {
      readonly exists: false;
      readonly productionSessionId: string;
    }
  | {
      readonly exists: true;
      readonly productionSessionId: string;
      readonly content: string;
      readonly revision: string;
      readonly bytes: number;
      readonly updatedAt: string;
    };

export type AgentElicitationField =
  | {
      readonly type: "string";
      readonly title?: string;
      readonly description?: string;
      readonly enum?: readonly string[];
      readonly enumNames?: readonly string[];
      readonly oneOf?: readonly {
        readonly const: string;
        readonly title: string;
      }[];
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly format?: "email" | "uri" | "date" | "date-time";
      readonly default?: string;
    }
  | {
      readonly type: "array";
      readonly title?: string;
      readonly description?: string;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly items:
        | { readonly enum: readonly string[] }
        | {
            readonly anyOf: readonly {
              readonly const: string;
              readonly title: string;
            }[];
          };
      readonly default?: readonly string[];
    }
  | {
      readonly type: "boolean";
      readonly title?: string;
      readonly description?: string;
      readonly default?: boolean;
    }
  | {
      readonly type: "number" | "integer";
      readonly title?: string;
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    };

export interface AgentElicitationRequest {
  readonly requestId: string;
  readonly message: string;
  readonly properties: Readonly<Record<string, AgentElicitationField>>;
  readonly required: readonly string[];
}

export type AgentElicitationValue = string | number | boolean | string[];

export interface AgentElicitationResolution {
  readonly requestId: string;
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Readonly<Record<string, AgentElicitationValue>>;
}

export type LiveEventTypedState =
  | {
      readonly kind: "parameter.value_changed";
      readonly state: {
        readonly normalizedValue: number;
        readonly value: number;
        readonly displayValue: string;
      };
    }
  | {
      readonly kind: "track.playing_clip_changed";
      readonly state:
        | { readonly state: "stopped" | "arrangement" }
        | {
            readonly state: "session-clip";
            readonly slotIndex: number;
            readonly clipName?: string | undefined;
          };
    }
  | {
      readonly kind: "track.triggered_clip_changed";
      readonly state:
        | { readonly state: "none" | "stop" }
        | {
            readonly state: "session-clip";
            readonly slotIndex: number;
            readonly clipName?: string | undefined;
          };
    }
  | {
      readonly kind: "track.recording_state_changed";
      readonly state: {
        readonly recording: boolean;
        readonly source: "track" | "session-clip" | "arrangement";
      };
    };

export interface LiveEventTriggerView {
  readonly deliveryId: string;
  readonly occurrenceId: string;
  readonly eventId: string;
  readonly listenerId: string;
  readonly agentInstanceId: string;
  readonly sdkSessionId: string;
  readonly kind: string;
  readonly sourceTrack: string;
  readonly state: LiveEventTypedState;
  readonly observedAt: string;
  readonly messagePrefix?: string;
  readonly occurrence: string;
  readonly summary: string;
  readonly status: "queued" | "completed" | "failed";
  readonly updatedAt: string;
  readonly error?: string;
}

export type AppEvent =
  | { type: "lifecycle.changed"; state: LifecycleState }
  | { type: "ableton.connection_changed"; status: ConnectionStatus }
  | {
      type: "ableton.event_received";
      event: string;
      sequence: number;
      payload: unknown;
      projectRevision?: number;
    }
  | {
      type: "ableton.event_gap";
      expectedSequence: number;
      receivedSequence: number;
    }
  | {
      type: "ableton.project_mutated";
      command: string;
      requestId: string;
      correlationId?: string;
      projectRevision?: number;
    }
  | ({ type: "agent.message_delta"; content: string } & AgentEventAttribution)
  | ({
      type: "agent.message_complete";
      content: string;
    } & AgentEventAttribution)
  | ({
      type: "agent.mode_changed";
      previousMode: AgentMode;
      mode: AgentMode;
    } & AgentEventAttribution)
  | ({
      type: "agent.plan_changed";
      operation: string;
    } & AgentEventAttribution)
  | ({
      type: "agent.plan_approval_requested";
      request: AgentPlanApprovalRequest;
    } & AgentEventAttribution)
  | ({
      type: "agent.plan_approval_completed";
      requestId: string;
      approved: boolean;
      selectedAction?: AgentPlanExitAction;
      feedback?: string;
    } & AgentEventAttribution)
  | ({
      type: "agent.plan_artifact_changed";
      artifact: PlanArtifactSnapshot;
    } & AgentEventAttribution)
  | ({
      type: "agent.elicitation_requested";
      request: AgentElicitationRequest;
    } & AgentEventAttribution)
  | ({
      type: "agent.elicitation_completed";
      requestId: string;
      action: "accept" | "decline" | "cancel";
    } & AgentEventAttribution)
  | ({
      type: "operation.started";
      operationId: string;
      label: string;
      toolName?: string;
      arguments?: Readonly<Record<string, unknown>>;
    } & AgentEventAttribution)
  | ({
      type: "operation.completed";
      operationId: string;
      summary: string;
      toolName?: string;
      result?: string;
    } & AgentEventAttribution)
  | ({
      type: "operation.failed";
      operationId: string;
      code: string;
      message: string;
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
      toolName?: string;
    } & AgentEventAttribution)
  | ({
      type: "agent.sdk_session_rotated";
      agentInstanceId: string;
      oldSdkSessionId: string;
      newSdkSessionId: string;
      reason: "missing-session";
    } & AgentEventAttribution)
  | ({
      type: "agent.live_event_trigger_changed";
      trigger: LiveEventTriggerView;
    } & AgentEventAttribution);

export interface EventPublisher {
  publish(event: AppEvent): void;
  subscribe(listener: (event: AppEvent) => void): () => void;
}

export class InMemoryEventPublisher implements EventPublisher {
  readonly #listeners = new Set<(event: AppEvent) => void>();

  public publish(event: AppEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  public subscribe(listener: (event: AppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface Clock {
  now(): Date;
  nowMs(): number;
}

export interface IdGenerator {
  create(): string;
}

export interface ConfigurationStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
}

export interface SecureStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ShutdownParticipant {
  readonly name: string;
  shutdown(signal: AbortSignal): Promise<void>;
}

export class ShutdownError extends AggregateError {
  public constructor(
    public readonly failures: readonly {
      participant: string;
      error: unknown;
    }[],
  ) {
    super(
      failures.map(({ error }) => error),
      `Shutdown failed for: ${failures
        .map(({ participant }) => participant)
        .join(", ")}`,
    );
    this.name = "ShutdownError";
  }
}

export class ShutdownCoordinator {
  readonly #participants: ShutdownParticipant[] = [];
  #shutdown: Promise<void> | undefined;

  public register(participant: ShutdownParticipant): () => void {
    if (this.#shutdown !== undefined) {
      throw new Error("Cannot register shutdown participants after shutdown");
    }
    if (this.#participants.some(({ name }) => name === participant.name)) {
      throw new Error(
        `Shutdown participant '${participant.name}' is already registered`,
      );
    }
    this.#participants.push(participant);
    return () => {
      const index = this.#participants.indexOf(participant);
      if (index >= 0) this.#participants.splice(index, 1);
    };
  }

  public shutdown(signal: AbortSignal): Promise<void> {
    this.#shutdown ??= this.#run(signal);
    return this.#shutdown;
  }

  async #run(signal: AbortSignal): Promise<void> {
    const failures: { participant: string; error: unknown }[] = [];
    for (const participant of [...this.#participants].reverse()) {
      try {
        await participant.shutdown(signal);
      } catch (error) {
        failures.push({ participant: participant.name, error });
      }
    }
    if (failures.length > 0) throw new ShutdownError(failures);
  }
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
