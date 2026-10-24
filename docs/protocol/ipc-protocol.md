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

### Listening placement state

Device-chain placement refresh (#58) does not change wire schemas or protocol
versions. Audio companions renew existing authenticated producer registration
when device-owned canonical placement changes; they do not mutate a live
connection's placement in place. Connection/instance/epoch and path-derived
producer identity are fenced against old controls/results. A fresh
`listening.inspect_context` query nonce still requires independent current LOM
attestation; Max numeric IDs never become Remote Script reference UUIDs.
Runtime admission rechecks registration after asynchronous inspection and
rejects stale proof, including another Max device at a previously attested
path. A new capture rediscovers the current producer; an in-flight capture is
not rebound. No new persisted state, retention rule or storage layout is added.

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

The lifecycle subscription `live_set.save_observed` reports a settled
filesystem-metadata change for the current saved Set. Its payload contains the
complete bounded `live_set.get_identity` result plus `observedAt`,
decimal-string `fileModifiedTimeNs`, and a non-negative JavaScript-safe
`fileSizeBytes`. The `firstSave` flag is true only when the same in-memory Song
changes from an unsaved identity to its first path-derived saved identity; it
defaults to false when reading events from an older compatible script. The
event never contains the path or file contents. Carrying the
complete identity lets the bridge replace Set and optional Live Project
identity atomically when first save or Save As changes the path-derived ID. A
connection starts from a baseline, so reconnecting does not replay a save. Save
As emits only after the new path's metadata is stable.

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

### Session source inspection diagnostic

`listening.inspect_session_source` is a read-only additive command with normal
timeouts. Version 1 requires a UUID `queryId` and exact Session clip target:
regular track index and scene index `0..255`, expected track/clip UUIDs and
names bounded to 128 characters. No launch or ownership parameters are accepted.
The bridge capability-checks before dispatch and matches the echoed query and
target after parsing the strict result.

The result carries `projectRevision`, `evidence:"message-rate-only"` and
`nativeAlignment:"unverified"`, a clip kind and matching position unit, separate
`before`/`after` source readings and nullable launch/marker settings. Global beat,
`startTimeBeats`, position and markers permit finite signed coordinates within
`-1576800..1576800`; this does not make them interchangeable coordinates.
Playing/fired slot indices retain `-2` and `-1` sentinels. Unknown or unavailable
metadata is `null`, not a default safety value. Reads do not certify atomicity,
target onset, continuous source identity or native capture coverage. Existing
Arrangement results and wire versions are unchanged; clients must negotiate the
new capability rather than infer support from the Remote Script version.

`settings.launchQuantization` is a **canonical Max ordinal**, not an
uninterpreted Python enum integer: Global `0`, None `1`, and 1 Bar `5`.
Production normalizes the installed public
`Live.Clip.ClipLaunchQuantization.q_*` members to all 15 canonical values.
The [public Live 11.0.0 generated Python API dump](https://github.com/NSUSpray/Live_API_Doc/blob/master/11.0.0.xml)
declares the semantic enum (unofficial reference, without numeric values);
the [Max reference](https://docs.cycling74.com/apiref/lom/clip/) declares the
canonical ordinal order. Missing/incomplete/ambiguous native enum metadata or
an unknown read becomes `null`, never a guessed Global default. In particular,
raw `5`, clip-creation defaults, and serialized `LaunchQuantisation` alone
cannot establish Global. This does not alter Song's separate
`globalQuantization` semantics (None `0`, 1 Bar `4`) or relax admission's
requirement for canonical clip Global `0`.

### Guarded Session source pass

`SessionListeningPassParams` and `SessionListeningPassResult` are canonical
strict schemas for a bounded source lease, not native alignment authority.
There is no unified `listening.session_pass` wire command:

| Command | Required `action` | `mutates` |
| --- | --- | --- |
| `listening.prepare_session_pass` | `prepare` | `false` |
| `listening.launch_session_pass` | `launch` | `true` |
| `listening.inspect_session_pass` | `inspect` | `false` |
| `listening.release_session_pass` | `release` | `false` |

Each command rejects another action even if that action is otherwise valid.
All use normal timeout metadata. The application may expose a local
`sessionListeningPass(params)` dispatcher, but only launch participates in
project-mutation serialization and emits `ableton.project_mutated`.
Prepare/inspect/release do not increment project revision or turn polling into
a user-visible mutation; launch still checks the expected revision without
waiving unrelated edits.

All requests contain `schemaVersion:1`, UUID `ownerId`/`passId`, and `action`.
Prepare additionally requires `expectedLiveSetId`, `expectedProjectRevision`,
the diagnostic's exact bounded Session `target`, one full same-track `listener`
binding (device index `0..31`), `durationBeats` in `(0,4]`, and
`timingAnchor:{globalBeat}`. The anchor must equal the existing stopped global
position; no seek occurs. Physical admission also requires at most thirty
seconds, known recording-off, no pending launch, MIDI/warped source, supported
launch settings and tempo, global None/1 Bar in 4/4, and
`durationBeats < min(loopEnd,endMarker)`. Exact natural-end/wrap equality is
refused even for nonlooping clips; no silent range trimming is allowed.
Release additionally requires `reason:"completed"|"cancelled"`.

The shared result echoes owner/pass and carries `status` (`prepared`,
`accepted`, `queued`, `playing`, `unverified`, `invalidated`, `released`,
`cancelled`, or `expired`), `mutationState` (`not-attempted`, `indeterminate`,
or `observed-playing`), nullable `reason`, `durationBeats`, `expiresInMs`
(`0..40000`), and the diagnostic's bounded `lastObservedSource` state.
`sourceEpoch` is null until actual `Clip.start_time` and exact active clip
identity agree, then contains `startTimeBeats`, `clipReference`, and
`observedGlobalBeat`. First origin and invalidation reason remain latched.
Acceptance/queueing is not source onset. Constants remain
`cleanupPolicy:"leave-running"`, `evidence:"message-rate-only"`, and
`nativeAlignment:"unverified"`.

`followActionState` distinguishes `known-disabled` from `unknown`; enabled
follow actions are refused. Unknown is never converted to disabled: admission
requires pass-owned public source monitoring and a second explicit limitation
in `limitations`. Message-rate callbacks/readbacks cannot guarantee continuous
identity or sample-accurate transition times. Runtime separately requires the
actual origin and target identity to match frozen native geometry before
publication; these source schemas cannot certify that alignment.

Origin monitoring is explicitly event-assisted polling: the
[legacy Max 8 Clip LOM](https://docs.cycling74.com/legacy/max8/vignettes/live_object_model#live_obj_anchor_Clip)
marks `start_time` get-only, unlike the
[current reference](https://docs.cycling74.com/apiref/lom/clip/) that marks it
get/observe. The source pass does not infer Live 11 Python notification support
from the newer page and never requires an origin listener. It requires real
playing-status/position, track-slot and launch-setting subscriptions, plus
readable finite `start_time` on every source callback, scheduled tick and
explicit inspect. Result limitations disclose that `Clip.start_time` is polled,
not subscribed, and changes between observations may be missed. An unavailable
required event source or origin read still refuses admission. No new wire
fields or relaxed identity/origin/native-publication checks are introduced.
The fixture owner must physically qualify Python listener/readback behavior on
the actual full Live 11 version before treating a case as supported.

At most one pass is active per context, with a forty-second lifetime and
five-second launch readback. Required monitor unavailability refuses admission.
Release, expiry, scheduled client-disconnect cleanup and script shutdown remove
registrations without stopping playback. The latest 32 closed owner/pass
receipts remain bounded in memory for idempotent release, retaining origin and
invalidation details but no audio bodies or LOM listeners. Old release retries
cannot clear a newer lease; closed identities require fresh pass UUIDs while
retained. Release fences deferred fire that has not been dispatched, never
claims to retract an accepted host queue, and leaves partial mutation explicit.
Existing request trace/lifecycle telemetry applies to all four commands.

The registry/catalog scan and generated JSON Schema plus command fixtures
include all four commands. Fixtures cover nonmutating phases, an actually
observed playing epoch, and cancellation before fire, retaining unknown-follow
limitations and unverified native authority across TypeScript/Python framing.

### Listening source evidence (protocol 7)

`listening.inspect_context` includes optional bounded per-listener
`sourceEvidence` alongside its unchanged nullable `sessionOverride`. Versioned
source inputs distinguish Arrangement selection, Session override and
unknown/unavailable evidence; the evidence state must agree with the boolean.
See [playback listening](../tools/playback-listening.md) for the decision fields,
freshness/ownership attribution and refusal recovery contract.

This uses protocol 7 and Remote Script/minimum installation `0.7.0`: older
clients use strict result parsers and must not negotiate an extended inspection
shape they cannot read. Older response fixtures without the optional detailed
evidence remain parseable, but this is not mixed-version handshake support.
The canonical version generator updates TypeScript, Python and handshake
fixtures together.

Compatibility comparison reads the actual committed schema with an explicit
8 MiB process-output bound. A missing baseline may be skipped; process/read
failures or malformed JSON must fail, not masquerade as a missing contract.
The regression uses the committed schema (already larger than Node's default
1 MiB output buffer) to prevent another false-green comparison.

### Listening start cleanup contract

`listening.position_playback` is an additive Arrangement-only serialized
mutation with the same bounded owner/pass/Set/revision/listener/range guards.
Its result includes requested beat, independently observed marker/current beat,
`playing:false`, changed-field flags, `cleanupPolicy:"leave-running"` and
`sourceOnset:"unverified"`. All three beat fields must agree; the bridge also
matches them to its request. This is stopped positioning before arm, not an
onset/ownership certificate. The App must re-inspect afterward.

`listening.start_playback` returns only `schemaVersion:1`, `mode:"arrangement"`,
`cleanupPolicy:"leave-running"`, `startedAtBeat` (requested beat after verified
seek), and `sourceOnset:"unverified"`. No ownership field is accepted. This
acknowledges guarded marker start with later readback, not exact audible onset.
Session mode on this legacy command and automatic stop remain unsupported;
the separate granular Session source pass does not authorize stopping Live.
Partial mutation errors retain explicit indeterminate stage/observation details
without claiming rollback. Command correlation/trace uses the existing request
envelope, not arbitrary fields in the strict parameters.

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

Protocol 6 adds the workflow-adapter commands and capability-detail handshake
shape. The version bump preserves compatibility by preventing protocol 5 peers
from accepting the extended `system.hello` contract without negotiation.
Remote Script `0.6.0` is the minimum compatible installation for protocol 6,
so an older installation is detected as outdated and reinstalled.

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
