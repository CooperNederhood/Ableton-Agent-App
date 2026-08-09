import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

export function currentCorrelationId(): string | undefined {
  return storage.getStore();
}

export function withCorrelation<T>(
  correlationId: string,
  operation: () => T,
): T {
  return storage.run(correlationId, operation);
}
