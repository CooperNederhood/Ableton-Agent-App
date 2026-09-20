# IPC Protocol

## Goals

The protocol must provide:

- Unambiguous message framing.
- Request/response correlation.
- Protocol version negotiation.
- Structured errors.
- Capability discovery.
- Optional events from Ableton.
- Cross-platform local operation.
- Backward-compatible evolution.

## Transport

Use TCP bound to loopback for the first release because it works consistently
on macOS and Windows and is supported by Ableton's embedded Python.

Each message is:

```text
4-byte unsigned big-endian payload length
UTF-8 JSON payload
```

Set a conservative maximum payload size. Larger musical data should use
chunking or purpose-specific batching rather than unlimited frames.

## Envelope

Request:

```json
{
  "protocolVersion": 3,
  "kind": "request",
  "requestId": "uuid",
  "command": "clips.add_notes",
  "params": {},
  "projectRevision": 42
}
```

Success:

```json
{
  "protocolVersion": 3,
  "kind": "response",
  "requestId": "uuid",
  "ok": true,
  "result": {},
  "projectRevision": 43,
  "warnings": []
}
```

Failure:

```json
{
  "protocolVersion": 3,
  "kind": "response",
  "requestId": "uuid",
  "ok": false,
  "error": {
    "code": "stale_reference",
    "message": "The target track changed after the snapshot was created.",
    "retryable": true,
    "details": {}
  }
}
```

Event:

```json
{
  "protocolVersion": 3,
  "kind": "event",
  "event": "tracks.changed",
  "sequence": 104,
  "payload": {},
  "projectRevision": 44
}
```

Dynamic Live Event subscriptions use validated commands rather than arbitrary
LOM paths:

```text
events.inspect_selection
events.subscribe
events.unsubscribe
events.list_subscriptions
events.clear_subscriptions
```

The Remote Script emits typed `live_event.occurred` and
`live_event.invalidated` envelopes. Continuous sources are coalesced before
transport; discrete transitions preserve sequence order. See
[Live Events](../events/live-events.md).

Requests and unsolicited events carry application-provided trace/correlation
context when available. The bridge preserves it across request/response and
Live Event ingestion so the local journal can connect Remote Script work to SDK
turns, tools, workflows, and per-agent delivery. IDs are opaque, bounded
metadata; they never carry user or musical content.

## Handshake

The client begins with `system.hello` containing:

- Authentication token.
- Supported protocol versions.
- App version.
- Requested event subscriptions.

The Remote Script returns:

- Selected protocol version.
- Remote Script version.
- Ableton version.
- Explicit Live Set identity (`liveSetId`, `liveSetName`, and `saved`) plus
  optional Live Project identity when the Set is inside the nearest ancestor
  containing `Ableton Project Info`.
- Capability document.
- Limits such as maximum frame and batch size.

## Session snapshots and timeout classes

`session.inspect` returns each regular track with up to 32 ordered top-level
device summaries. Each summary includes stable device identity, name and class,
enabled state when exposed, and parameter count. A per-track truncation flag
indicates that additional devices exist. Full parameter bodies and nested rack
contents remain explicit paginated reads.

The command catalog classifies requests as `normal` or `long`. The bridge
applies that class only after FIFO dispatch to Live. In particular,
`devices.inspect_parameters` is long-running because some native devices expose
large or comparatively expensive parameter surfaces.
`arrangement.fill_region` is also long-running: one bridge request executes a
bounded deferred state machine that places at most four clips per Live tick and
at most 128 clips total.

`arrangement.fill_region` uses a half-open `[regionStart, regionEnd)` interval.
It places every complete source-length copy that fits and reports the uncovered
tail in `unusedRemainder`. Live 11.3.43 does not expose a writable Arrangement
right edge, so partial-tile creation is not part of the command. Callers must
use a shorter source clip when exact coverage is required and must not place a
full clip past `regionEnd`. Any post-mutation failure rolls back the complete
batch or returns `applied_indeterminate`.

Three timeout layers are intentionally distinct:

- normal bridge request: 5 seconds by default;
- long bridge request: 15 seconds by default;
- Copilot agent turn: an application-owned cumulative active-work budget,
  defaulting to 600 seconds and configured from Desktop Settings. The
  application waits on SDK events directly and pauses this budget during human
  decisions.

An SDK turn abort does not prove that a dispatched mutation was cancelled.
Read-only operations still report `operation_timeout`; an in-flight mutation
reports `applied_indeterminate` and requires state reinspection.

## Error taxonomy

Initial stable error codes:

- `authentication_failed`
- `protocol_version_unsupported`
- `invalid_request`
- `unknown_command`
- `invalid_params`
- `unsupported_capability`
- `not_found`
- `ambiguous_reference`
- `stale_reference`
- `conflict`
- `operation_timeout`
- `queue_full`
- `lom_error`
- `applied_indeterminate`
- `internal_error`

## Schema ownership

TypeScript schemas are canonical for the application packages. Export JSON
Schema fixtures and validate them against Python-side parsing in contract tests.
Do not rely on manually synchronized interfaces.

## Compatibility rules

- `system.hello` selects the highest version present in both the client's
  `supportedProtocolVersions` and the Remote Script's available versions. No
  overlap returns `protocol_version_unsupported` and the connection is not
  authenticated.
- Request IDs are UUIDs unique for the lifetime of a client process. A
  response repeats exactly one request ID; unknown or duplicate responses are
  ignored by the client.
- Event sequences are monotonically increasing per Remote Script process. The
  first event after a connection may have any non-negative sequence; every
  subsequent event must increment by one. A gap invalidates incremental cache
  assumptions and requires targeted refresh.
- Project revisions are monotonically increasing observations of meaningful
  LOM changes. Clients attach their latest revision to requests. Responses and
  events advance the client's revision; exact-reference mutations still
  perform their own identity checks.
- Additive result fields are backward compatible.
- New optional request fields are backward compatible when old peers can
  ignore them. New required fields, removed fields, narrowed values, changed
  defaults, and changed error semantics are breaking.
- Existing field meanings cannot change within a protocol version.
- New commands do not require a protocol bump.
- Framing, envelope, or semantic changes require a new protocol version.
- Capability negotiation handles Live-version differences separately from
  protocol versions.
