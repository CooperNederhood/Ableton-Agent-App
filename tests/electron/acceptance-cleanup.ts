import type {
  DriverContext,
  LifecycleEvent,
  RunFailure,
} from "../../packages/test-support/src/integration/index.js";
import { describeScenarioError } from "../../scripts/lib/scenario-receipts.mjs";

export function describeCleanupError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  function visit(value: unknown, depth: number) {
    if (seen.has(value) || messages.length >= 8 || depth > 3) return;
    seen.add(value);
    messages.push(describeScenarioError(value));
    if (value instanceof AggregateError)
      for (const child of value.errors) visit(child, depth + 1);
    if (value instanceof Error && value.cause !== undefined)
      visit(value.cause, depth + 1);
  }
  visit(error, 0);
  return messages.join(": ").slice(0, 8192);
}

export class AcceptanceCleanup {
  readonly events: LifecycleEvent[] = [];
  readonly failures: RunFailure[] = [];
  constructor(
    private readonly context: Pick<
      DriverContext,
      "runId" | "traceId" | "correlationId" | "causationId" | "signal"
    >,
  ) {}

  async attempt(stage: string, action: () => Promise<void>): Promise<boolean> {
    const began = Date.now();
    const emit = (phase: LifecycleEvent["phase"]) =>
      this.events.push({
        schemaVersion: 1,
        runId: this.context.runId,
        traceId: this.context.traceId,
        correlationId: this.context.correlationId,
        causationId: this.context.causationId,
        stage: `cleanup.${stage}`,
        phase,
        timestamp: Date.now(),
        durationMs: Math.max(0, Date.now() - began),
      });
    emit("queued");
    emit("started");
    try {
      await action();
      emit("completed");
      return true;
    } catch (error) {
      this.failures.push({ stage, message: describeCleanupError(error) });
      emit(this.context.signal.aborted ? "cancelled" : "failed");
      return false;
    }
  }

  throwIfFailed(): void {
    if (this.failures.length)
      throw new AggregateError(
        this.failures.map(
          ({ stage, message }) => new Error(`${stage}: ${message}`),
        ),
        `Acceptance cleanup failed: ${this.failures
          .map(({ stage, message }) => `${stage}: ${message}`)
          .join("; ")
          .slice(0, 8192)}`,
      );
  }
}
