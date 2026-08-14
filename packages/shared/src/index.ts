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
  | { type: "agent.message_delta"; content: string }
  | { type: "agent.message_complete"; content: string }
  | {
      type: "operation.started";
      operationId: string;
      label: string;
      toolName?: string;
      arguments?: Readonly<Record<string, unknown>>;
    }
  | {
      type: "operation.completed";
      operationId: string;
      summary: string;
      toolName?: string;
      result?: string;
    }
  | {
      type: "operation.failed";
      operationId: string;
      code: string;
      message: string;
      toolName?: string;
    };

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
