# Ableton Remote Script

## Responsibilities

The Remote Script is a narrow adapter between local protocol commands and the
Live Object Model.

It owns:

- Socket lifecycle inside Live.
- Authentication and protocol negotiation.
- Request decoding and response encoding.
- Main-thread scheduling.
- Command registration.
- LOM capability detection.
- LOM object serialization.
- Selected LOM listeners and outbound events.

It does not own:

- Agent prompts or model calls.
- User-facing prose.
- Production planning.
- Long-term project state.
- Third-party Python dependencies.
- Cloud communication.

## Structure

Avoid a single 2,000-line `__init__.py`. Organize the installable script while
remaining compatible with Ableton's loader:

```text
AbletonAgent/
├── __init__.py
├── control_surface.py
├── transport.py
├── protocol.py
├── executor.py
├── capabilities.py
├── serialization.py
└── commands/
    ├── session.py
    ├── tracks.py
    ├── clips.py
    ├── arrangement.py
    ├── devices.py
    └── browser.py
```

## Command registry

Use a registry rather than a central `if/elif` chain:

```python
@command("tracks.create_midi", mutates=True)
def create_midi_track(context, params):
    ...
```

Registry metadata should include:

- Command name.
- Mutation classification.
- Required capability.
- Timeout class.
- Validation function.
- Handler.

## Main-thread executor

All LOM access should flow through one executor:

1. Socket thread validates and enqueues work.
2. `schedule_message` schedules queue draining on Live's thread.
3. Handler performs bounded work.
4. Result is placed on a response queue.
5. Socket thread encodes and returns the response.

Large traversals such as browser discovery should be bounded and paginated.
Avoid blocking Live's thread for recursive full-tree scans.

Bounded device-parameter inspection snapshots the Set-wide reachable parameter
collection once per requested page and allocates runtime references in one
batch. It must not rescan the complete Live Set separately for every returned
parameter because all LOM access runs on Live's main thread.

Opaque bounded trace/correlation IDs from the request are carried through
queueing, main-thread execution, response, and outbound Live Events. Remote
Script logs and protocol metadata may record lifecycle and timing, but never
raw authentication, paths, or musical payloads. Journal persistence remains in
the application and must not add work to Live's main thread.

An explicitly requested global Back to Arrangement assigns the property once,
then verifies its aggregate state on one scheduled Live tick through the
existing deferred-result executor. It returns the same typed before/after
receipt only after verification. A failed postcondition retains bounded
before/after Boolean diagnostics; it never retries or writes the highlight
back to true as a fictitious restoration of per-track source selection.
Queued cancellation performs no mutation. Existing request-attributed
queued/started/completed/failed/cancelled logging and deferred timing apply.
This does not authorize automatic source recovery during listening.

## LOM compatibility

The script should:

- Detect attributes with narrow capability checks.
- Avoid broad exception swallowing.
- Return `unsupported_capability` distinctly from operation failures.
- Keep serializers stable across versions.
- Maintain an explicit supported Live-version matrix.

### Live 11 device and rack operations

The first supported structural device slice uses only the Live 11
`Song.find_device_position(device, target, target_position)` and
`Song.move_device(device, target, target_position)` APIs. Targets are strict,
discriminated paths to either a regular track device list, an existing rack
chain, or an existing Drum Rack pad chain. Every segment is revalidated by
index, runtime reference, and expected name (plus pad note where applicable).

Movement preflights the destination, translates same-parent final indexes to
the API's pre-removal index space, rejects nearest-but-not-exact positions,
then verifies the same device's canonical parent and actual index. Verification
failure attempts restoration to the original parent/index and still returns an
explicit failure. Chain property and exposed mixer edits similarly capture
before-state, verify, and restore on failure.

The checked-in support ledger is:

| Operation | Protocol capability | Live 11 basis | Status |
| --- | --- | --- | --- |
| Inspect an existing chain's exposed mixer state and parameter identities | `devices.inspect_chain_mixer` | Exposed `Chain` and `Chain.mixer_device` properties | Supported when exposed |
| Validate a destination for an existing device | `devices.find_position` | Callable `Song.find_device_position` | Supported |
| Reorder an existing device in a regular track or existing rack/Drum Rack pad chain | `devices.move` | Callable `Song.find_device_position` and `Song.move_device`; same-parent index translation | Supported |
| Move an existing device between regular tracks and existing chains | `devices.move` | Same APIs | Supported |
| Rename or recolor an existing chain | `devices.set_chain_properties` | Exposed writable `Chain.name` and `Chain.color_index`, with observed `Chain.color` | Supported when exposed; color index is bounded to `0..69` |
| Set existing chain mute, solo, volume, pan, or sends | `devices.set_chain_mixer` | Exposed `Chain` and `Chain.mixer_device` properties | Supported when exposed and exact parameter identity matches |
| Create an empty rack chain | None | No approved Live 11 operation in this slice | Unsupported |
| Insert a native device directly without Browser loading | None | No approved Live 11 operation in this slice | Unsupported |
| Delete one rack chain | None | No approved Live 11 operation in this slice | Unsupported |
| Reorder rack chains | None | No approved Live 11 operation in this slice | Unsupported |

Supported moves require an existing source device and destination parent. The
implementation rejects stale identities, out-of-range or nearest-only
positions, cross-kind aliases of the same chain, and unsupported or ambiguous
topology.

### Live 11 core domains

The core-domain commands are split into `*.inspect` and `*.mutate` protocol
entries while each agent-facing tool uses a strict action discriminator. This
preserves mutation invalidation and queue semantics without multiplying
read-only tools.

The final workflow-adapter domains keep their model-facing action unions but
register one internal command per action (for example,
`recording.record_session_slot` and `live_history.undo`). Validators reject a
valid action sent to the wrong command. The capability document includes
evidence and tested-version details; detected-but-untested private adapters
remain fail-closed.

Runtime references are cached for scenes, regular/return/master tracks, clips,
cue points, mixer parameters, MIDI note IDs, and routing options. Mutations
revalidate every supplied identity immediately before touching the LOM.
Routing options are short-lived snapshots: assignment requires the exact
snapshot ID, option token, display name, target, and direction, and returns
warnings for feedback-prone or external-MIDI routes. Current routing values and
snapshot entries are matched by Live's stable `RoutingOption.identifier`
because Live may return equivalent but distinct Python wrappers from the
current-value and available-options getters. Direct object equality remains a
fast path; when Live's current and available identifiers are not
equality-compatible, a display-name fallback is allowed only when the name
resolves to exactly one option. A non-null current route that cannot be matched
uniquely is reported as an explicit consistency failure rather than a
successful response with a null current token. Live can retain a current route
that it no longer exposes in the corresponding `available_*` collection, such
as `Ext. In` when no external input is available. The bridge includes that
actual value as a short-lived current-only snapshot entry so it remains
identity-bound for inspection, stale-state checking, rollback, and switching
to an available option.

Input-channel options are always read after the current input type. An empty
channel list is valid only when Live itself exposes no channels for that type,
such as a route with no selectable channel. Changing input type invalidates any
older input-channel snapshot, so callers must fetch fresh channel options
before assigning a channel.

Modern MIDI edits use Live 11 note IDs and the extended note API, retaining
probability, velocity deviation, and release velocity. The existing
full-replacement commands and note-ID removal are destructive operations.
Removal failures that cannot be verified exactly are reported as
non-retryable, applied-indeterminate outcomes. Audio clip inspection includes
the current `available_warp_modes`; warp-mode mutation rejects a selection
outside that exact inspected list or a list that has since changed.

This layer intentionally omits APIs that are not safely available in Live 11:
scene-scoped stop, arbitrary track reordering, per-note expression mutation,
unrestricted file import, take lanes, empty-chain creation, deterministic
direct native device insertion, and later-version Simpler replacement APIs.

Browser item identity remains exact across the search/load round trip. Runtime
reference, root, path, and name must match, while URI comparison treats
equivalent percent-encoded and decoded spellings as the same identity. A
materially different decoded URI remains a `stale_reference`.

Live may expose a loadable device such as Auto Filter as navigable because it
also has preset children. An item explicitly reported as both `is_device` and
`is_loadable` remains a supported device even when navigable. Navigable
non-device containers, unsupported media types, and external plug-ins remain
rejected before mutation.

## Live Set identity

The Remote Script derives Live Set identity directly from the LOM:

- saved sets use a SHA-256 hash of `Song.file_path`, truncated to 24
  hexadecimal characters;
- unsaved sets receive a collision-resistant runtime identity that remains
  stable when the Set is renamed and differs between distinct unsaved Sets.

For a saved Set, the script walks upward from the `.als` file and uses the
nearest ancestor containing `Ableton Project Info` as its Live Project. An
orphan saved Set has no `liveProjectId` or `liveProjectName` and reports a
bounded `live_project_not_found` diagnostic instead.

`live_set.get_identity` computes this value on demand. It returns explicit
`liveSetId`, `liveSetName`, and `saved` fields, optional `liveProjectId` and
`liveProjectName`, plus at most four diagnostics with messages limited to 256
characters. It never sends raw filesystem paths. Capability negotiation and
the dynamic command share the same helper so Save As and reconnect behavior
cannot use different identity rules. Entity stale guards use `liveSetId`; Live
Project identity never participates in object-reference validation.

## Save observation

The script polls only `Song.file_path` filesystem metadata and never opens,
reads, hashes, or transmits the `.als` path or contents. Existing saved Sets
establish a baseline on startup/reconnect. A changed `(mtime_ns, size)` tuple
must remain stable across two scheduled samples before the script publishes
`live_set.save_observed`; temporary file absence and intermediate replacement
metadata are ignored.

The nanosecond modification time crosses the protocol as a decimal string to
avoid JavaScript precision loss. File size is limited to JavaScript's maximum
safe integer. The payload also marks `firstSave` only when the same Song object
changes from an unsaved identity to its first saved identity; Save As and
ordinary saves report `false`. Each observation also carries the complete
bounded identity returned by `build_live_identity`, allowing clients to replace
Live Set and Live Project identity as one transition without exposing the path.
The first save of an unsaved Set and Save As are observed after stabilization.
Replacing the Song object establishes a fresh baseline so switching Sets cannot
mistaken for a save. Script shutdown cancels future sampling.

## Events

The script has two listener layers:

- fixed low-frequency listeners that invalidate project state;
- dynamic user-defined Live Event subscriptions.

Dynamic subscriptions are installed and removed at runtime through validated
protocol commands. They initially support parameter value changes, playing and
triggered clip transitions, and recording-state transitions. The script
also publishes typed curated `live_state.changed` events for transport,
tempo/signature, selection, track/scene/clip/device topology, routing, and
coalesced meters. `events.inspect_curated_state` supplies the initial state.

The event layer normalizes raw LOM values into semantic occurrences before
publishing them. Capability-detected workflow adapters additionally cover
recording/capture, Groove Pool operations, selection/view state, Live global
history, Browser preview and tested Hot-Swap/insertion, Session clip
envelopes, warp-marker mutation, and Live 11-specific Simpler, Looper, and
Wavetable operations. See
[the capability ledger](../protocol/live-11-workflow-capability-ledger.md).

Listeners must be removed during unsubscribe, client disconnect, Set
replacement, and script shutdown. Continuous parameter changes are coalesced
and bounded before crossing the socket. The application persists subscription
intent and reinstalls listeners after reconnect; runtime LOM references are not
durable.

See [Live Events](../events/live-events.md).

## Security

### Guarded listening playback

`listening.inspect_session_source` is a separate read-only diagnostic. It
resolves an exact bounded regular-track Session clip, reads source/launch
metadata, and re-resolves the target before returning. Replacement or movement
fails the exact identity guard. The two source readings are deferred LOM
observations, not an atomic snapshot. Unknown booleans/numbers/enums and
nonfinite/out-of-bound coordinates remain `null`; signed Session `start_time`
values are retained without claiming this target owns them. Selected playing
clip identity is reported separately from queued and target-playing state.
MIDI/warped position units are beats; unwarped units are seconds for diagnosis
only. A fresh owned Live 11.3.43 process returned valid results for both MIDI
and warped audio, but no usable `follow_action_enabled` boolean. This command
never fires a clip, changes transport/settings, creates observers, or certifies
native alignment. It uses existing executor and bridge read lifecycle events.

Clip launch quantization is normalized by semantic members of the installed
public `Live.Clip.ClipLaunchQuantization` enum, not by casting its raw integer
to a Max ordinal. The [public generated Live 11.0.0 Python API reference](https://github.com/NSUSpray/Live_API_Doc/blob/master/11.0.0.xml)
(unofficial, generated API documentation) names `q_global`, `q_none`, `q_bar`
and the other supported members, but does not establish their numeric values.
The [Max Clip reference](https://docs.cycling74.com/apiref/lom/clip/)
defines the protocol's canonical `launchQuantization` ordinals: Global `0`,
None `1`, 1 Bar `5`, with the remaining durations through `14`. The adapter
requires all 15 named native members to resolve uniquely before translating a
read value. Missing enum metadata, duplicate native values, unknown members
or malformed values yield `null`; Session admission then refuses unknown
settings. The simulator explicitly supplies a canonical simulated enum.

A raw Python value `5` is not independently Global or 1 Bar: it maps to Global
only if the installed public enum identifies that value as `q_global`, and to
1 Bar only if it identifies it as `q_bar`. Newly created/imported clips,
`fire()` quantization arguments, Song's global quantization enum, and the
serialized `LaunchQuantisation` value are not substitutes for that semantic
mapping. A fresh fixture-owner read must record the actual property type/raw
value and named `q_global`/`q_bar`/`q_none` values on the full installed Live 11
version; stale Remote Script diagnostics cannot qualify the correction.

The separate guarded Session pass uses four capability-negotiated commands:

| Command | Action | Project mutation |
| --- | --- | --- |
| `listening.prepare_session_pass` | `prepare` | No |
| `listening.launch_session_pass` | `launch` | Yes |
| `listening.inspect_session_pass` | `inspect` | No |
| `listening.release_session_pass` | `release` | No |

Every command retains its matching strict `action` discriminator. Prepare and
release change only application-owned observer/lease state; inspection must not
publish a project-mutation event or advance project revision. Launch still
checks the exact frozen Set/revision immediately before its one `Clip.fire`;
prepare does not waive unrelated project edits.

Prepare freezes owner/pass UUIDs, an exact regular-track Session clip, an
independently resolved same-track listener binding, duration, and the existing
stopped global beat. It requires known recording-off, no queued launch, MIDI or
warped audio, trigger mode `0`, legato false, clip launch quantization `0`,
global None `0` or 1 Bar `4`, 4/4, and start marker/loop start `0`. Duration is
positive, at most four beats and thirty seconds, and **strictly less than both
loop end and end marker**, including for nonlooping clips. Equal natural-end or
wrap boundaries are explicitly refused; the pass never silently trims a range
or infers exact transition time from callback receipt. Unlike Arrangement
positioning, admission does not require Arrangement selection, a cleared
Session override, or any particular insert marker.

This lower contract represents candidate launch cases, not application
qualification. The application currently admits only global None at stopped
beat zero, rejecting one-bar and nonzero stopped anchors before preparing a
source lease or native listener. It never seeks or edits launch settings to
make a candidate pass.

Only one pass is active per runtime context. Public source monitors are
installed before launch; an unavailable required listenable property refuses
the pass. The [legacy Max 8 LOM](https://docs.cycling74.com/legacy/max8/vignettes/live_object_model#live_obj_anchor_Clip)
lists Clip `start_time` as **get-only**, while `playing_status` is observable
and `playing_position` supports get/observe. The
[current Clip reference](https://docs.cycling74.com/apiref/lom/clip/)
lists `start_time` as get/observe; that newer documentation does not establish
Live 11 Python listener availability. The pass therefore deliberately never
requires or calls `add_start_time_listener`/`remove_start_time_listener`.
Instead, origin reads are mandatory on every real source callback, scheduled
tick and explicit inspection (including application polling). This is an
explicit polling policy, not a silent optional-monitor fallback.

Real `playing_status`, playing-position, track-slot and launch-setting
subscriptions remain required; missing infrastructure still refuses admission.
Source identity, `start_time` and launch settings are reread on callbacks and
scheduled ticks, not inferred from project revision alone. A missing/nonfinite
origin read also refuses the pass. Results explicitly disclose
`Clip.start_time` polling and that **changes between observations may be
missed**, without claiming notification coverage or an exact event timestamp.
Known enabled follow
actions are denied. Unknown follow state is admitted only with explicit
message-rate monitoring limitations: it is not independently known disabled,
and continuity is neither guaranteed nor sample-accurate. Observed switches,
retrigger, wrap, replacement, settings edits, and unsafe/unknown state latch
invalidation through final inspection. The one launch's expected queued and
playing transitions, including its initial stopped-position reset, are not
mistaken for a retrigger.

Acceptance and queued state are not playing evidence. The origin ledger is
filled only from actual `Clip.start_time` with matching active target identity;
it is never substituted with acceptance time. Results retain the first
invalidation reason, origin ledger and bounded last-observed source state.
`nativeAlignment` remains `unverified`: the application must independently join
the observed origin and identity to frozen native geometry, refusing publication
on mismatch. A pass expires after forty seconds; launch readback is bounded to
five seconds. Timeout or partial launch remains explicit, with
`mutationState:"indeterminate"` unless playing was independently observed.

Release is nonlaunching and idempotent for the latest 32 closed owner/pass
receipts. Receipts are bounded in-memory snapshots, not live LOM registrations
or persisted audio. A retained closed UUID cannot prepare again, and replaying
an old release cannot clear a newer pass. Release fences deferred work that has
not fired; it does not retract an already dispatched host queue. Monitors remain
until release/expiry, with failed removals tracked for explicit retry. Client
disconnect schedules `clear_session_listening_pass` on the Live main thread;
control-surface shutdown also invokes it before closing the executor. Other
subscription/shutdown cleanup still runs if pass cleanup fails. Every outcome
leaves playback, position, routing, solo/mute and settings unchanged except for
the one admitted fire. Existing request/executor lifecycle and trace logging
applies; no independent journal or audio-body persistence is introduced.

Public LOM access flags are not physical Python API qualification. The next
fixture-owner probe must record the full Live 11 version, verify each required
add/remove listener pair on the actual source/listener, establish finite
get-only origin reads, exercise queued-to-playing identity and actual-origin
readback, and verify sampled origin drift refusal plus cleanup. Publication
still requires matching active identity and actual origin equal to frozen
native geometry; no seek, callback timestamp inference, or weaker alignment
gate is permitted. No Live process was launched for this compatibility change.

`listening.position_playback` supports guarded stopped Arrangement positioning
before native arm. It validates exact Set/revision, bounded listener targets,
recording-off, disabled loop and no Session override/pending launch. It writes
the requested insert marker only if needed, independently reads it on a later
Live tick, writes the stopped position only if needed, then independently reads
that position on another tick. Source fingerprints and safety/identity are
revalidated between stages, including after our own revision-changing writes.
It never starts or stops transport. Partial failures remain explicitly
indeterminate and report the observed marker/current position; the surfaced
message warns that position may have changed. It does not restore a
marker/position over user activity.

`listening.start_playback` retains its matching-insert-marker guard, skips
redundant seeks that could reset an armed native phase, independently verifies
any needed seek, calls `start_playing` (not `continue_playing`, which resumes the
old stopped location), and verifies playing on a later tick. Both commands
leave routing, solo/mute, loop and Back to Arrangement unchanged. The App must
freshly inspect source/revision after positioning and before native arm/start.

The result is `{schemaVersion:1,mode:"arrangement",cleanupPolicy:"leave-running",
startedAtBeat,sourceOnset:"unverified"}`. Playback deliberately continues after
capture completion, cancellation, disconnect and errors. There is no ownership
token, automatic stop, or verified sounding-onset claim. Session mode on this
legacy start command and `listening.stop_playback` remain unsupported; guarded
Session launch uses the separate pass above. Native timing readiness is a
separate application gate.

Pre-mutation denials include `mutated:false`. Once a seek/start has been
attempted, failures report `mutationState:"indeterminate"`, the failed
`stage`, bounded observed `playing/currentBeat`, and the leave-running policy;
they never guess rollback or stop independent user playback. Existing executor
and bridge command events carry queued/start/completion/failure timing and trace
context. The command registers no monitoring resources or delayed cleanup.

- Bind to `127.0.0.1`, never `0.0.0.0`.
- Require a per-installation authentication token.
- Reject requests before authentication completes.
- Limit frame size and queue depth.
- Validate every command and parameter.
- Never implement arbitrary Python evaluation or unrestricted filesystem access.
