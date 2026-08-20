import type {
  AgentHistoryMessage,
  AgentService,
  AgentSessionConfiguration,
} from "@ableton-agent/application";
import type { EventPublisher } from "@ableton-agent/shared";

export interface FakeAgentBehavior {
  /** Streams these deltas before completing a turn. */
  deltas?: readonly string[];
  reply?: string;
  /** Fails the turn instead of replying. */
  failWith?: Error;
  /** Blocks the turn until {@link FakeAgentService.release} is called. */
  block?: boolean;
}

/**
 * In-memory {@link AgentService}. Turns complete only when the test says so,
 * which makes cancellation and streaming observable without a Copilot runtime.
 */
export class FakeAgentService implements AgentService {
  public prompts: string[] = [];
  public started = false;
  public cancelCalls = 0;
  public readonly managedPrompts = new Map<string, string[]>();
  public readonly managedConfigurations = new Map<
    string,
    AgentSessionConfiguration
  >();
  #sessionId: string | undefined;
  #sessionCounter = 0;
  #release: (() => void) | undefined;
  #abort: ((error: Error) => void) | undefined;
  readonly #managedSessionIds = new Map<string, string>();
  readonly #managedHistory = new Map<string, AgentHistoryMessage[]>();
  readonly #managedAborts = new Map<string, (error: Error) => void>();
  readonly #managedReleases = new Map<string, () => void>();

  public constructor(
    private readonly events: EventPublisher,
    private behavior: FakeAgentBehavior = {},
  ) {}

  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  public setBehavior(behavior: FakeAgentBehavior): void {
    this.behavior = behavior;
  }

  public async start(preferredSessionId?: string): Promise<void> {
    this.started = true;
    if (preferredSessionId === undefined) {
      this.#sessionCounter += 1;
      this.#sessionId = `fake-session-${this.#sessionCounter}`;
    } else {
      try {
        await this.resumeSession(preferredSessionId);
      } catch {
        this.#sessionCounter += 1;
        this.#sessionId = `fake-session-${this.#sessionCounter}`;
      }
    }
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.#sessionId = undefined;
    this.managedConfigurations.clear();
    this.#managedSessionIds.clear();
    this.#managedAborts.clear();
    this.#managedReleases.clear();
  }

  public async createSession(): Promise<string> {
    if (!this.started) throw new Error("Fake agent service is not started");
    this.#sessionCounter += 1;
    this.#sessionId = `fake-session-${this.#sessionCounter}`;
    return this.#sessionId;
  }

  public async resumeSession(sessionId: string): Promise<void> {
    if (!this.started) throw new Error("Fake agent service is not started");
    this.#sessionId = sessionId;
  }

  public async cancel(): Promise<boolean> {
    this.cancelCalls += 1;
    const abort = this.#abort;
    if (!abort) return false;
    this.#abort = undefined;
    this.#release = undefined;
    abort(new Error("Turn aborted"));
    return true;
  }

  /** Completes a blocked turn. */
  public release(): void {
    const release = this.#release;
    this.#release = undefined;
    this.#abort = undefined;
    release?.();
    for (const managedRelease of this.#managedReleases.values()) {
      managedRelease();
    }
    this.#managedReleases.clear();
    this.#managedAborts.clear();
  }

  public async send(prompt: string): Promise<string> {
    if (!this.started) throw new Error("Fake agent service is not started");
    this.prompts.push(prompt);
    if (this.behavior.block === true) {
      await new Promise<void>((resolve, reject) => {
        this.#release = resolve;
        this.#abort = reject;
      });
    }
    if (this.behavior.failWith) throw this.behavior.failWith;
    for (const delta of this.behavior.deltas ?? []) {
      this.events.publish({ type: "agent.message_delta", content: delta });
    }
    const reply = this.behavior.reply ?? "fake reply";
    this.events.publish({ type: "agent.message_complete", content: reply });
    return reply;
  }

  public async createManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<string> {
    if (!this.started) throw new Error("Fake agent service is not started");
    this.#sessionCounter += 1;
    const sessionId = `fake-session-${this.#sessionCounter}`;
    this.#sessionId = sessionId;
    this.managedConfigurations.set(configuration.instanceId, configuration);
    this.#managedSessionIds.set(configuration.instanceId, sessionId);
    this.managedPrompts.set(configuration.instanceId, []);
    this.#managedHistory.set(configuration.instanceId, []);
    return sessionId;
  }

  public async resumeManagedAgent(
    configuration: AgentSessionConfiguration,
    sdkSessionId: string,
  ): Promise<void> {
    await this.resumeSession(sdkSessionId);
    this.managedConfigurations.set(configuration.instanceId, configuration);
    this.#managedSessionIds.set(configuration.instanceId, sdkSessionId);
    if (!this.managedPrompts.has(configuration.instanceId)) {
      this.managedPrompts.set(configuration.instanceId, []);
    }
    if (!this.#managedHistory.has(configuration.instanceId)) {
      this.#managedHistory.set(configuration.instanceId, []);
    }
  }

  public async reconfigureManagedAgent(
    configuration: AgentSessionConfiguration,
  ): Promise<void> {
    if (!this.#managedSessionIds.has(configuration.instanceId)) {
      throw new Error(
        `Managed agent '${configuration.instanceId}' is not active`,
      );
    }
    this.managedConfigurations.set(configuration.instanceId, configuration);
  }

  public async deactivateManagedAgent(instanceId: string): Promise<void> {
    this.managedConfigurations.delete(instanceId);
    this.#managedSessionIds.delete(instanceId);
  }

  public getManagedAgentSessionId(instanceId: string): string | undefined {
    return this.#managedSessionIds.get(instanceId);
  }

  public sendToManagedAgent(
    instanceId: string,
    prompt: string,
  ): Promise<string> {
    return this.#sendManaged(instanceId, prompt);
  }

  public invokeManagedAgentSkill(
    instanceId: string,
    invocation:
      string | { readonly skillName: string; readonly request: string },
  ): Promise<string> {
    const prompt =
      typeof invocation === "string"
        ? invocation
        : `/${invocation.skillName}${invocation.request ? ` ${invocation.request}` : ""}`;
    return this.#sendManaged(instanceId, prompt);
  }

  async #sendManaged(instanceId: string, prompt: string): Promise<string> {
    const sdkSessionId = this.#managedSessionIds.get(instanceId);
    if (sdkSessionId === undefined) {
      throw new Error(`Managed agent '${instanceId}' is not active`);
    }
    this.managedPrompts.get(instanceId)?.push(prompt);
    this.prompts.push(prompt);
    const history = this.#managedHistory.get(instanceId)!;
    history.push({
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
      eventId: `event-${history.length + 1}`,
      agentInstanceId: instanceId,
      sdkSessionId,
    });
    if (this.behavior.block === true) {
      await new Promise<void>((resolve, reject) => {
        this.#managedReleases.set(instanceId, resolve);
        this.#managedAborts.set(instanceId, reject);
      });
    }
    if (this.behavior.failWith) throw this.behavior.failWith;
    for (const delta of this.behavior.deltas ?? []) {
      this.events.publish({
        type: "agent.message_delta",
        content: delta,
        agentInstanceId: instanceId,
        sdkSessionId,
      });
    }
    const reply = this.behavior.reply ?? "fake reply";
    history.push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      eventId: `event-${history.length + 1}`,
      agentInstanceId: instanceId,
      sdkSessionId,
    });
    this.events.publish({
      type: "agent.message_complete",
      content: reply,
      agentInstanceId: instanceId,
      sdkSessionId,
    });
    return reply;
  }

  public async cancelManagedAgent(instanceId: string): Promise<boolean> {
    this.cancelCalls += 1;
    const abort = this.#managedAborts.get(instanceId);
    if (abort === undefined) return false;
    this.#managedAborts.delete(instanceId);
    this.#managedReleases.delete(instanceId);
    abort(new Error("Turn aborted"));
    return true;
  }

  public releaseManaged(instanceId: string): void {
    const release = this.#managedReleases.get(instanceId);
    this.#managedReleases.delete(instanceId);
    this.#managedAborts.delete(instanceId);
    release?.();
  }

  public async getManagedAgentHistory(
    instanceId: string,
  ): Promise<readonly AgentHistoryMessage[]> {
    if (!this.#managedSessionIds.has(instanceId)) {
      throw new Error(`Managed agent '${instanceId}' is not active`);
    }
    return [...(this.#managedHistory.get(instanceId) ?? [])];
  }
}
