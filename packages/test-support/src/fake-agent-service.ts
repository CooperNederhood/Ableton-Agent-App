import type { AgentService } from "@ableton-agent/application";
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
  #sessionId: string | undefined;
  #sessionCounter = 0;
  #release: (() => void) | undefined;
  #abort: ((error: Error) => void) | undefined;

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
}
