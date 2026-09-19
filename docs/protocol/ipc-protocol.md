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
- Project identity.
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
- Copilot agent turn: an application-owned 180 seconds passed to the SDK
  `sendAndWait` call.

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

### Live 11 device/rack commands

The device/rack slice adds:

```text
devices.inspect_chain_mixer
devices.find_position
devices.move
devices.set_chain_properties
devices.set_chain_mixer
```

Device sources are strict discriminated `track-device`,
`rack-chain-device`, or `drum-pad-chain-device` targets. Destinations are
strict `track`, `rack-chain`, or `drum-pad-chain` parents with a requested
device index. Requests carry exact track, rack, pad, chain, device, and mixer
parameter identities as applicable. Results return canonical before/after
locations or states and explicit verification. Unknown fields and ambiguous
topologies are rejected rather than normalized heuristically.

`devices.set_chain_properties` accepts `name` and/or `colorIndex`. The color
index is an integer in Live 11's documented `0..69` palette range. Mutation
uses `Chain.color_index` for exact verification; before/after state includes
both the palette index and Live's observed RGB `color` value.

These commands do not imply support for empty-chain creation, native device
insertion, single-chain deletion, or chain reordering.

### Live 11 core-domain commands

The expanded Live 11 surface uses separate inspection and mutation commands so
read-only requests never advance project mutation state:

```text
scenes.inspect              scenes.mutate
tracks.inspect              tracks.mutate
mixer_routing.inspect       mixer_routing.mutate
transport.inspect           transport.mutate
midi_notes.inspect          midi_notes.mutate
audio_clips.inspect         audio_clips.mutate
```

Each command accepts a strict `action` discriminant. Mutation requests carry
the exact runtime identities required by the selected action. Routing
assignment additionally carries a recent snapshot ID and opaque option token;
the Remote Script rejects stale snapshots, mismatched display names, and
changed target/direction state. Modern MIDI mutation identifies notes by Live
11 note IDs and intentionally excludes per-note expression fields. Note removal
is destructive and cannot be assumed rollback- or retry-safe after an
indeterminate failure. Audio inspection returns the currently available warp
modes; assignment repeats that exact availability snapshot and selects one of
its modes. Warp-marker access is read-only.

Protocol 3 introduced the documented Live 11 integer domains for launch
quantization (`0..13`), record quantization (`0..8`), audio pitch fine
(`-50..49`), and warp mode (`0..6`).

## Live 11 workflow adapters

The additive public domain tools `recording`, `grooves`, `selection_view`,
`live_history`, `browser_adapters`, `clip_automation`, `warp_markers`,
`special_devices`, and `workflow_jobs` use action-discriminated request and
result schemas. Each validated action routes to its own granular protocol
command, capability, timeout class, mutation flag, and Remote Script registry
entry. Timed recording and Looper export return typed jobs rather than blocking
Live's main thread.

The handshake retains the boolean `capabilities` map and additively exposes
`capabilityDetails` with evidence, minimum/tested Live versions, and bounded
limitations. Private API shape detection alone is reported as
`private_detected_untested` and remains disabled until that exact Live 11 build
has real-Live validation evidence.

Protocol 4 adds the workflow-adapter commands and capability-detail handshake
shape. The version bump preserves compatibility by preventing protocol 3 peers
from accepting the extended `system.hello` contract without negotiation.
Remote Script `0.6.0` is the minimum compatible installation for protocol 4,
so a protocol-3 `0.5.0` installation is detected as outdated and reinstalled.

`events.inspect_curated_state` returns bounded initial transport,
tempo/signature, selection, topology, routing, and meter state.
`live_state.changed` carries only these enumerated topics. Workflow jobs emit
`workflow_job.queued|started|progress|completed|failed|cancelled|indeterminate`
with bounded IDs and progress; result bodies are not copied into lifecycle
events. Job linkage and ownership are injected from the active application
turn rather than accepted from model-authored tool arguments. Cancellation is
lock-free so it can stop the job holding that lock, but the Remote Script
rejects callers other than the originating agent.

See [the capability ledger](live-11-workflow-capability-ledger.md) for exact
Live 11 support and deliberate omissions.

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
