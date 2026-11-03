export function describeScenarioError(error: unknown): string;
export function serializeScenarioReceipt(
  value: unknown,
  maximumBytes?: number,
): string;
export function writeScenarioReceipt(
  path: string,
  value: unknown,
): Promise<void>;
