import { AsyncLocalStorage } from "node:async_hooks";

export interface CorrelationTraceContext {
  readonly correlationId: string;
  readonly traceId?: string;
  readonly parentSpanId?: string;
  readonly causationId?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly activeAgentId?: string;
  readonly liveEventId?: string;
  readonly outputId?: string;
  readonly toolName?: string;
}

const storage = new AsyncLocalStorage<CorrelationTraceContext>();
const registeredContexts = new Map<string, CorrelationTraceContext>();

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function currentCorrelationContext():
  CorrelationTraceContext | undefined {
  return storage.getStore();
}

export function registerCorrelationContext(
  context: CorrelationTraceContext,
): void {
  registeredContexts.set(context.correlationId, { ...context });
}

export function unregisterCorrelationContext(correlationId: string): void {
  registeredContexts.delete(correlationId);
}

export function withCorrelation<T>(
  correlationId: string,
  operation: () => T,
): T {
  return storage.run(
    registeredContexts.get(correlationId) ?? { correlationId },
    operation,
  );
}
