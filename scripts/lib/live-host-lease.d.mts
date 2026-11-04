declare const liveHostLease: unique symbol;

export interface LiveHostLease {
  readonly [liveHostLease]: true;
  assertOwned(): Promise<void>;
  /** Irreversibly retain the lock when any application cleanup is uncertain. */
  retain(): void;
  /** Refuses release while reserved, retained, replaced, or foreign-owned. */
  release(): Promise<void>;
}

export function isLiveHostLease(value: unknown): value is LiveHostLease;

export interface LiveHostLeaseEvent {
  type: `live.host_lease.${"queued" | "started" | "completed" | "failed" | "cancelled" | "retained" | "release_started" | "release_failed" | "released"}`;
  traceId: string;
  correlationId: string;
  causationId: string;
  durationMs: number;
}

export function acquireLiveHostLease(options?: {
  signal?: AbortSignal;
  onEvent?: (event: LiveHostLeaseEvent) => void;
  traceId?: string;
  correlationId?: string;
  causationId?: string;
  /** Explicit deterministic test seam; never populated from run environment. */
  homeDirectory?: string;
  inspectOwner?: () => Promise<{
    pid: number;
    startedAt: string;
    commandSha256: string;
  }>;
}): Promise<LiveHostLease>;

export function reserveLiveHostLease(
  handle: LiveHostLease,
  owner: object,
): Promise<void>;
export function unreserveLiveHostLease(
  handle: LiveHostLease,
  owner: object,
): void;
