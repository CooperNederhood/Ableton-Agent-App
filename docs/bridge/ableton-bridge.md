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
- Per-command timeout policy.
- Mutation serialization.
- Event subscription.
- Clean rejection of pending requests after disconnect.

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

