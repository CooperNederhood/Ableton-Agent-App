export interface MetricListeningDeadlineOptions {
  readonly setupMs?: number;
  readonly inactivityMs?: number;
  readonly drainMs?: number;
  readonly cleanupMs?: number;
}

/** Duration bounds do not replace the independently finite stalled-stage bounds. */
export function metricListeningDeadlines(
  durationMs: number,
  options: MetricListeningDeadlineOptions = {},
): {
  readonly totalMs: number;
  readonly setupMs: number;
  readonly inactivityMs: number;
  readonly drainMs: number;
  readonly cleanupMs: number;
} {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 600_000)
    throw new Error("invalid-capture-duration");
  const bounded = (value: number): number => {
    if (!Number.isInteger(value) || value <= 0 || value > 120_000)
      throw new Error("invalid-capture-deadline");
    return value;
  };
  const setupMs = bounded(options.setupMs ?? 20_000);
  const inactivityMs = bounded(options.inactivityMs ?? 15_000);
  const drainMs = bounded(options.drainMs ?? 60_000);
  const cleanupMs = bounded(options.cleanupMs ?? 5_000);
  return Object.freeze({
    totalMs: Math.ceil(durationMs) + setupMs + drainMs + cleanupMs,
    setupMs,
    inactivityMs,
    drainMs,
    cleanupMs,
  });
}
