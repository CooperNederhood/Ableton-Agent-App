import { homedir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityDocument,
  PingResult,
  SessionSnapshot,
} from "@ableton-agent/protocol";
import type {
  AppEvent,
  ConnectionStatus,
  EventPublisher,
  LifecycleState,
  Logger,
} from "@ableton-agent/shared";
import {
  abletonToolMetadata,
  createAbletonTools,
  handleAbletonToolPermission,
} from "@ableton-agent/tools";
import {
  CopilotClient,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";

export interface AgentService {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(prompt: string): Promise<string>;
}

export interface AbletonService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<ConnectionStatus>;
  getCapabilities(): Promise<CapabilityDocument>;
  ping(): Promise<PingResult>;
  inspectSession(): Promise<SessionSnapshot>;
}

export interface ApplicationServices {
  agent: AgentService;
  ableton: AbletonService;
  events: EventPublisher;
  logger: Logger;
}

export interface ApplicationStartOptions {
  startAgent?: boolean;
}

interface CopilotResponse {
  data: { content: string };
}

interface CopilotSessionAdapter {
  sendAndWait(prompt: string): Promise<CopilotResponse | undefined>;
  disconnect(): Promise<void>;
  on(listener: (event: SessionEvent) => void): () => void;
}

interface CopilotClientAdapter {
  createSession(config: SessionConfig): Promise<CopilotSessionAdapter>;
  stop(): Promise<unknown>;
}

export interface CopilotAgentServiceOptions {
  events: EventPublisher;
  getAbletonStatus: () => Promise<ConnectionStatus>;
  inspectSession: () => Promise<SessionSnapshot>;
  clientFactory?: () => CopilotClientAdapter;
  baseDirectory?: string;
  model?: string;
}

export const BASE_SYSTEM_MESSAGE_VERSION = 1;
export const BASE_SYSTEM_MESSAGE =
  "You are an Ableton Live production assistant. Use only the provided Ableton tools. Inspect current project state before making claims. Clearly distinguish observed state from suggestions.";

export class CopilotAgentService implements AgentService {
  readonly #clientFactory: () => CopilotClientAdapter;
  #client: CopilotClientAdapter | undefined;
  #session: CopilotSessionAdapter | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #operationNames = new Map<string, string>();

  public constructor(private readonly options: CopilotAgentServiceOptions) {
    this.#clientFactory =
      options.clientFactory ??
      (() =>
        new CopilotClient({
          mode: "empty",
          baseDirectory:
            options.baseDirectory ??
            join(homedir(), ".ableton-agent", "copilot"),
        }));
  }

  public async start(): Promise<void> {
    if (this.#session) {
      return;
    }

    const client = this.#clientFactory();
    const toolSet = createAbletonTools({
      getConnectionStatus: this.options.getAbletonStatus,
      inspectSession: this.options.inspectSession,
    });

    try {
      const session = await client.createSession({
        clientName: "ableton-agent-app",
        ...(this.options.model === undefined
          ? {}
          : { model: this.options.model }),
        tools: toolSet.tools,
        availableTools: toolSet.availableTools,
        onPermissionRequest: handleAbletonToolPermission,
        systemMessage: {
          mode: "replace",
          content: BASE_SYSTEM_MESSAGE,
        },
      });
      this.#client = client;
      this.#session = session;
      this.#unsubscribe = session.on((event) => {
        if (event.type === "assistant.message_delta") {
          this.options.events.publish({
            type: "agent.message_delta",
            content: event.data.deltaContent,
          });
        } else if (event.type === "tool.execution_start") {
          const metadata = abletonToolMetadata.find(
            (candidate) => candidate.name === event.data.toolName,
          );
          const label = metadata?.title ?? event.data.toolName;
          this.#operationNames.set(event.data.toolCallId, label);
          this.options.events.publish({
            type: "operation.started",
            operationId: event.data.toolCallId,
            label,
          });
        } else if (event.type === "tool.execution_complete") {
          const label =
            this.#operationNames.get(event.data.toolCallId) ?? "Tool operation";
          this.#operationNames.delete(event.data.toolCallId);
          if (event.data.success) {
            this.options.events.publish({
              type: "operation.completed",
              operationId: event.data.toolCallId,
              summary: `${label} completed`,
            });
          } else {
            this.options.events.publish({
              type: "operation.failed",
              operationId: event.data.toolCallId,
              code: event.data.error?.code ?? "tool_failed",
              message: event.data.error?.message ?? `${label} failed`,
            });
          }
        }
      });
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const session = this.#session;
    const client = this.#client;
    this.#session = undefined;
    this.#client = undefined;
    this.#operationNames.clear();
    if (session) {
      await session.disconnect();
    }
    if (client) {
      await client.stop();
    }
  }

  public async send(prompt: string): Promise<string> {
    if (!this.#session) {
      throw new Error("Copilot agent service is not started");
    }
    const response = await this.#session.sendAndWait(prompt);
    if (!response) {
      throw new Error(
        "Copilot session completed without an assistant response",
      );
    }
    this.options.events.publish({
      type: "agent.message_complete",
      content: response.data.content,
    });
    return response.data.content;
  }
}

export class HeadlessApplication {
  #state: LifecycleState = "stopped";

  public constructor(private readonly services: ApplicationServices) {}

  public get state(): LifecycleState {
    return this.#state;
  }

  public async start(options: ApplicationStartOptions = {}): Promise<void> {
    if (this.#state !== "stopped") {
      throw new Error(`Cannot start application from ${this.#state}`);
    }
    this.#setState("starting");
    try {
      await this.services.ableton.start();
      if (options.startAgent ?? true) {
        await this.services.agent.start();
      }
      const status = await this.services.ableton.getStatus();
      this.services.events.publish({
        type: "ableton.connection_changed",
        status,
      });
      this.#setState(status.state === "connected" ? "ready" : "degraded");
    } catch (error) {
      this.#setState("degraded");
      this.services.logger.error("Application startup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === "stopped") {
      return;
    }
    this.#setState("stopping");
    const failures: unknown[] = [];
    for (const stop of [
      () => this.services.agent.stop(),
      () => this.services.ableton.stop(),
    ]) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#setState("stopped");
    if (failures.length > 0) {
      throw new AggregateError(failures, "Application shutdown failed");
    }
  }

  public async send(prompt: string): Promise<string> {
    if (this.#state !== "ready" && this.#state !== "degraded") {
      throw new Error(`Application is not running (${this.#state})`);
    }
    return this.services.agent.send(prompt);
  }

  public getStatus(): Promise<ConnectionStatus> {
    return this.services.ableton.getStatus();
  }

  public getCapabilities(): Promise<CapabilityDocument> {
    return this.services.ableton.getCapabilities();
  }

  public ping(): Promise<PingResult> {
    return this.services.ableton.ping();
  }

  public inspectSession(): Promise<SessionSnapshot> {
    return this.services.ableton.inspectSession();
  }

  public subscribe(listener: (event: AppEvent) => void): () => void {
    return this.services.events.subscribe(listener);
  }

  #setState(state: LifecycleState): void {
    this.#state = state;
    this.services.events.publish({ type: "lifecycle.changed", state });
  }
}
