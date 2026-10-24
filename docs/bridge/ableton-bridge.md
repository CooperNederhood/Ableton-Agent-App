# Ableton Bridge

## Purpose

The Ableton bridge is a framework-neutral TypeScript client for the Remote
Script protocol. Neither Copilot nor Electron concepts belong in this package.

This separation allows the same bridge to support:

- Copilot SDK custom tools.
- Deterministic application UI actions.
- Automated integration tests.
- A future CLI.
- A future optional MCP adapter.

## Public interface

The initial interface should expose domain operations rather than raw socket
messages:

```ts
interface AbletonBridge {
  connect(options?: ConnectOptions): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  getCapabilities(): Promise<LiveCapabilities>;
  getProjectSnapshot(options?: SnapshotOptions): Promise<ProjectSnapshot>;
  tracks: TrackOperations;
  clips: ClipOperations;
  arrangement: ArrangementOperations;
  devices: DeviceOperations;
  browser: BrowserOperations;
  transport: TransportOperations;
}
```

An internal `sendCommand()` remains available only within the package.

## Connection manager

Responsibilities:

- Loopback connection establishment.
- Authentication handshake.
- Version and capability negotiation.
- Reconnection with bounded exponential backoff.
- Heartbeats or explicit ping requests.
- Pending-request tracking.
- Per-command normal and long timeout policy.
- Bounded FIFO serialization for every Live request, with response timeouts
  starting only when a queued request is dispatched.
- Shared admission for all callers: initially four outstanding requests, at
  most eight admitted and eight waiting, with a five-second admission wait by
  default. Execution or queue wait above one second halves the active limit;
  three consecutive sub-250 ms responses restore one slot. Admission expiry
  returns retryable `queue_full` before dispatch with depth/limit details.
  Waiters resume FIFO and are cancelled when the connection closes. Dispatched
  timeouts close the connection rather than dispatching followers behind
  potentially still-running Live work. Read timeouts remain retryable; mutation
  timeouts require reinspection, never an automatic retry.
- A separate 60-second default response deadline for bounded
  `arrangement.fill_region`, rather than the generic 15-second long deadline.
- Event subscription.
- Clean rejection of pending requests after disconnect.
- Trace/correlation propagation and sanitized timing/lifecycle publication for
  backpressure, resume, queue, dispatch, completion, failure, timeout,
  cancellation, reconnect, and event ingestion. Request records distinguish
  admission wait, queue wait, execution, and total duration.

Bridge events feed the application-owned local journal through typed
observability events. The bridge does not persist history itself, and
observability publication must not delay socket reads, pending-request
resolution, or reconnect handling.

## Stable references

Numeric indices are convenient for display but become stale after insertions,
deletions, or reordering. The bridge should expose references containing:

- Object type.
- Current index.
- Name.
- LOM persistent ID where the Live version provides one.
- Snapshot revision.

Commands should use the strongest available identity and reject stale ambiguous
references rather than guessing.

## Results

Bridge methods return structured data:

```ts
type BridgeResult<T> =
  | { ok: true; value: T; warnings: BridgeWarning[]; revision?: number }
  | { ok: false; error: BridgeError };
```

The agent tool layer converts these results into model-facing summaries.
Application code can use the full structured value.

## Capability handling

The bridge exposes explicit capabilities such as:

- Session audio clip creation.
- Arrangement clip creation.
- Arrangement clip property support.
- Browser roots.
- Persistent object IDs.
- Device preset navigation.
- Automation editing.
- Undo grouping.

Tools and UI controls are hidden, disabled, or adapted based on capabilities
rather than failing late.
