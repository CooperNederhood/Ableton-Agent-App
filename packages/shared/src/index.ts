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
  | { type: "agent.message_delta"; content: string }
  | { type: "agent.message_complete"; content: string }
  | {
      type: "operation.started";
      operationId: string;
      label: string;
    }
  | {
      type: "operation.completed";
      operationId: string;
      summary: string;
    }
  | {
      type: "operation.failed";
      operationId: string;
      code: string;
      message: string;
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

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
