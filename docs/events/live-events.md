# Live Events

## Purpose

Live Events let users define reusable observations of Ableton Live state and
route each observation to any active agent. The Python Remote Script owns all
LOM listeners. Max for Live is not required for the initial implementation.

Live Events are distinct from Outputs:

- **Outputs** are externally produced MIDI or audio observation streams.
- **Live Events** are user-defined watches over LOM properties and semantic
  state transitions.

Both features may reuse agent-delivery concepts, but they keep separate source
models, inventories, and user interfaces.

Live Event occurrences also participate in the application-wide local event
journal. The journal is detailed operational history for people using and
debugging Desktop; it is not the Live Event definition model, an Output
inventory, or remote product analytics.

## Domain model

Use explicit names internally because `event` is already used for application,
bridge, SDK, and Electron notifications.

### Live event definition

A `LiveEventDefinition` is shared by every active agent in the current
production session. It contains:

- stable event ID;
- user-facing name;
- event kind;
- project binding;
- target locator and latest runtime binding;
- track display metadata when applicable;
- enabled state;
- continuous or discrete classification;
- source-specific observation policy;
- creation and update timestamps.

Initial event kinds:

| Kind | Class | Meaning |
|---|---|---|
| `parameter.value_changed` | Continuous | A device parameter or rack macro changed value. |
| `track.playing_clip_changed` | Discrete | A track changed between Session clips, Arrangement playback, or stopped state. |
| `track.triggered_clip_changed` | Discrete | A track queued or cleared a pending Session clip launch. |
| `track.recording_state_changed` | Discrete | A track or its active clip started or stopped recording. |

The Remote Script also exposes a fixed, typed `live_state.changed` stream for
transport/recording, tempo/signature, selection, track/scene/clip/device
topology, routing, and meters. This stream is not an arbitrary-property
subscription API. `events.inspect_curated_state` provides the bounded initial
state, topology changes rebind dependent listeners, and meter callbacks are
coalesced before crossing the socket.

Long-running Live operations publish
`workflow_job.queued|started|progress|completed|failed|cancelled|indeterminate`.
These payloads contain bounded job metadata and trace/correlation/causation
identifiers, but omit prompts, binary data, and operation result bodies.

The schema must be a discriminated union. Each kind owns only the fields needed
to resolve and serialize that source.

### Live event occurrence

A `LiveEventOccurrence` is one normalized observation emitted by the Remote
Script:

- event ID and event kind;
- monotonically increasing bridge sequence;
- trace and correlation IDs that survive bridge ingestion and agent delivery;
- project revision when applicable;
- observed timestamp;
- target identity and display metadata;
- previous and current semantic state;
- formatted summary suitable for the UI;
- structured payload suitable for deterministic routing.

Raw LOM sentinel values stay inside the Remote Script. For example,
`playing_slot_index` values are translated into semantic states for Session
clip, Arrangement playback, and stopped playback.

### Agent event listener

An `AgentEventListener` belongs to one active-agent instance and one live event.
It stores:

- stable listener ID;
- event ID;
- enabled state;
- response mode: `next-prompt` or `automatic`;
- optional message prefix, up to a bounded length;
- delivery cursor and deduplication metadata.

One Live event definition may feed any number of agents. This fan-out happens
in the application; it must not create duplicate LOM listeners.

## Event creation experience

The **Events** tab has a primary **Add event** action. Creation uses progressive
disclosure rather than presenting the complete LOM.

### Quick actions

Show context-aware actions first:

1. **Watch selected parameter**
   - Enabled when Live exposes a selected `DeviceParameter`.
   - Creates `parameter.value_changed`.
   - Defaults the event name from track, device, and parameter.
2. **Watch selected track**
   - Enabled when a regular track is selected.
   - Opens a short list of recommended track events.

When a track is selected, present that track first in the target picker and
show its current color, name, playing clip, and recording state.

### Recommended discrete events

The first-level track choices are:

- **Playing clip changes**
- **Clip is triggered**
- **Recording starts or stops**

Less common event kinds belong under **More track events** in later iterations.
Do not initially expose arbitrary LOM object/property entry or free-form paths.

### Browse all

The secondary path is **Browse all event types**:

1. Choose Parameter or Track event.
2. Choose a track, defaulting to the active Live/app selection.
3. Choose a top-level device and parameter when needed.
4. Review the event name and source.
5. Create the event and install its runtime watch.

The picker must use existing snapshot colors and identity-bound inspection.
Ambiguous or stale targets fail visibly instead of silently rebinding.

## Runtime ownership

### Remote Script

Add a dynamic `LomSubscriptionManager` alongside the existing fixed
`LomListenerManager`.

It owns:

- resolving an exact target on Live's main thread;
- installing and removing `add_<property>_listener` callbacks;
- retaining callback references required for cleanup;
- capturing initial state;
- translating callbacks into semantic occurrences;
- throttling continuous sources;
- removing all dynamic listeners on disconnect, Set replacement, and script
  shutdown.

The generic mechanism is implemented once. Creating or deleting an event at
runtime must not require rebuilding or reinstalling the Remote Script.

### Protocol commands

Add commands:

```text
events.inspect_selection
events.subscribe
events.unsubscribe
events.list_subscriptions
events.clear_subscriptions
```

`events.subscribe` accepts an application-generated event ID plus a
kind-specific, identity-bound target. It returns the resolved target and
initial state.

The Remote Script publishes:

```text
live_event.occurred
live_event.invalidated
```

`invalidated` reports deletion, replacement, project change, or another reason
that makes the runtime target unusable.

### Reconnection

Persistent intent belongs to the desktop session. Runtime LOM subscriptions
belong only to the current authenticated bridge connection.

After reconnect or Set reload:

1. Clear stale runtime bindings.
2. Re-resolve every enabled event definition.
3. Reinstall one LOM listener per resolved event.
4. Publish current state without treating it as a user-triggering occurrence.
5. Mark missing or ambiguous definitions as unresolved in the Events UI.

Runtime object IDs and UUID references must not be treated as durable across
Live restarts. Persist semantic locators and project identity in addition to
the latest runtime references.

## Continuous and discrete delivery

Continuous and discrete sources use different buffering rules.

### Continuous

- Coalesce changes in the Remote Script before crossing the socket.
- Retain only the latest unread occurrence per event for `next-prompt`.
- Debounce automatic delivery until the value settles.
- Apply a minimum normalized-value delta to suppress noise.
- Bound UI rendering frequency independently from agent delivery frequency.

Initial thresholds should be named constants and covered by tests, not exposed
as primary UI controls. Advanced controls can be added later.

### Discrete

- Preserve transitions in sequence order.
- Deduplicate callbacks that do not change semantic state.
- Keep a bounded unread queue per event/listener.
- Include previous and current state.
- Never silently turn an event-sequence gap into a successful delivery.

After a bridge sequence gap, mark affected state uncertain, refresh the event
targets, and resume from current truth.

## Live Event trace

Every occurrence has one trace across the shared application infrastructure.
The journal records each applicable stage rather than only the final UI
occurrence:

1. **Observed** — the Remote Script callback captures source time and target.
2. **Transported** — the bridge validates sequence, receives the occurrence,
   and notes gaps or reconnect reconciliation.
3. **Normalized** — the application creates the semantic occurrence.
4. **Persisted** — the redacted occurrence is durably appended to the local
   journal before it is considered available to history queries.
5. **Routed** — fan-out records the eligible listeners and each delivery
   decision, including coalescing or deduplication.
6. **Delivered** — each target agent records queued, started, completed,
   failed, or cancelled lifecycle and relevant queue and execution timing.

One trace ID identifies the occurrence across these stages. Correlation IDs
connect resulting automatic turns, SDK activity, tool calls, workflows, bridge
requests, and Remote Script work. Fan-out deliveries receive child span/event
IDs so one agent's result cannot be confused with another's. Missing stages and
failed persistence are visible diagnostics, not silently successful traces.

## Agent delivery

Reuse the proven Output concepts of per-agent assignments, next-message
context, automatic turns, deduplication, and isolated delivery cursors. Do not
route Live Events through the MIDI/audio producer inventory.

### Next prompt

At the agent's next user-authored turn, prepend bounded hidden context
containing pending event occurrences. Continuous events contribute their
latest value. Discrete events contribute a bounded ordered list.

The user's configured message prefix appears immediately before the event
summary.

### Automatic

An occurrence schedules an internal agent turn. Automatic turns:

- use the target agent's existing SDK session;
- attach the listener's bounded prepared project context as SDK
  `additionalContext`;
- use normal tool allowlists, edit scopes, and approval behavior;
- never inherit another agent's permissions;
- serialize with that agent's active turn;
- deduplicate identical pending deliveries;
- use settled-value delivery for continuous events.

The generated prompt clearly states that the trigger is a Live observation,
not a user-authored message, followed by the configured prefix and structured
event summary. The visible occurrence payload does not duplicate prepared
project context. The context is a separate prompt attachment so the occurrence
remains stable, bounded, and suitable for local history.

#### Prepared context and exact identities

Prepared context is refreshed in the background and served stale-while-refresh
so an automatic turn does not wait for `session.inspect`. Its freshness field
describes the age of mutable state such as transport and mixer values; age
expiry does not by itself invalidate exact track or Session clip references.
Likewise, `projectRevision` is not an identity-validity boundary because it can
advance for tempo, transport, selection, and collection changes.

When prepared context contains one unambiguous exact-reference match for every
required track and clip, an automatic turn uses those references directly with
the mutation tool's expected-reference guards. It must not inspect merely
because the context is age-expired or its revision differs from the occurrence.
This keeps performance-time Event actions on one model-decision path.

Inspection is required before mutation when a required identity is absent,
ambiguous, unresolved, or omitted by context limits. If a guarded tool rejects
an identity as `stale_reference` or `ambiguous_reference`, the agent inspects
once and may continue only with a newly verified identity; it never retries the
unchanged rejected mutation.

Context diagnostics record only bounded metadata such as age, project revision,
selected-track and Session-clip counts, truncation, and unresolved-locator
counts. They do not persist the prepared context body or exact references.

## Events view

Add **Events** as a top-level tab next to Outputs.

The default view shows event definitions grouped by track. Track groups reuse
the snapshot's color and display conventions from Outputs. Global or unresolved
events appear in separate groups.

Each event card shows:

- name and event type;
- current target and resolution status;
- current value or latest semantic state;
- continuous/discrete badge;
- enabled state;
- listening agents;
- edit, disable, and delete actions;
- collapsed **Recent activity** disclosure.

Recent activity is hidden by default and queries the local event journal,
newest first. It uses cursor pagination rather than loading an event's complete
history into renderer memory. In-memory queues remain bounded delivery
mechanisms only; they are not the history source of truth.

## Agent editing experience

Add a **Listening Events** fieldset to active-agent editing. Leave the existing
**Inputs** editor unchanged; it may be revised or deprecated separately.
Existing Output subscriptions remain managed in Outputs until their future UX
is deliberately consolidated.

The fieldset lists current Live Events as selectable cards or checkbox rows,
similar to Skills. Each selected event expands agent-specific controls:

- **Response:** `Automatic` or `Next prompt`
- **Message prefix:** optional bounded textarea
- enabled state

The agent summary lists the names of listened-to events. Deleting an event
removes or disables every associated agent listener transactionally.

Canonical agent YAML does not initially seed Live Event listeners. Event
definitions are project/session-specific and are configured on active
instances.

## Persistence

Increment the desktop production-session schema. Persist:

- Live event definitions on the production session;
- agent event listeners on each active-agent instance;
- semantic locators required for reconnect;
- redacted occurrence traces in the local event journal.

Migration defaults are empty arrays. Existing `inputChannels` and Output
subscriptions continue to load unchanged.

## Local detailed event journal

Desktop captures a complete, unsampled operational journal by default. Records
use a versioned envelope containing record/event type, source and lifecycle
stage, event and recorded timestamps, trace/correlation/causation IDs, relevant
project/session/active-agent IDs, outcome, duration fields, and a bounded
sanitized payload.

The journal includes:

- sanitized agent-configuration snapshots when an active agent is created,
  resumed, or changed, including definition revision, model/reasoning settings,
  tool and skill allowlists, edit scopes, approval policy, and Live Event/Output
  delivery settings;
- the complete SDK lifecycle and activity stream, including session and turn
  lifecycle, message metadata, streaming lifecycle, errors, cancellation, and
  usage/timing metadata;
- every tool and workflow request, policy/approval decision, start, progress,
  bridge operation, result, failure, cancellation, verification, and relevant
  queue/execution timing;
- every Live Event trace stage above; and
- Output ingress and per-agent delivery lifecycle through the shared journal
  writer and trace infrastructure.

“Complete” means activity types and useful local history content are not sampled
or silently discarded. Bounded prompts, assistant text, file paths, structured
musical/MIDI and event payloads, and tool definitions/arguments/results are
preserved. Credentials and tokens embedded in any string are redacted, while
binary/audio bodies are replaced with visible omission markers. Sanitization
occurs at the producer boundary and again in the journal writer.

The journal is stored only in the current user's application-data directory. It
has no uploader or network transport and is excluded from anonymous telemetry.
Capture defaults on, remains on across upgrades, and has explicit pause, clear,
and per-session deletion controls. The default rolling retention is 30 days
with a 250 MiB hard cap per application profile; age pruning runs first and
oldest records are removed when the cap is reached. The existing diagnostic log
files and support-bundle limits remain separate.

### Query experience

Desktop provides a **History** query surface with:

- time range, event/category, lifecycle stage, outcome, active agent, Live
  Event, Output, tool, session, trace ID, and correlation ID filters;
- newest-first cursor pagination and bounded detail expansion;
- trace view that reconstructs parent/child stages and timing without joining
  records in the renderer; and
- clear empty, truncated-by-retention, capture-paused, and storage-error states.

The renderer receives already-redacted view models through typed preload APIs.
There is no generic SQL, filesystem access, or raw journal IPC.

### Performance requirements

- Journal writes are asynchronous and bounded; they never block the Live
  callback, bridge reader, SDK stream, tool execution, or renderer.
- Batching preserves per-trace order. Queue saturation and write failure are
  counted and surfaced, with lifecycle/error records retained where possible.
- Payload and batch sizes are bounded, pruning is incremental, and indexed
  cursor queries never require a full-table scan.
- At the 250 MiB cap, a first page of a normal filtered query should complete in
  200 ms p95 on the supported desktop baseline and journal work must not cause
  visible streaming or Live Event delivery stalls.
- Query results are paginated/virtualized and stale queries are cancellable.

## Safety and privacy

- Creating a listener is read-only and requires no mutation approval.
- Automatic agent responses retain normal mutation approval rules.
- Cached exact identities are used only through identity-guarded mutations;
  missing or rejected identities fall back to inspection.
- Event payloads are bounded, sanitized before storage, and treated as local
  project data.
- Detailed note/event payloads are retained within the documented bounds;
  binary/audio bodies and unsanitized high-volume payloads are not persisted.
- Listener installation never accepts arbitrary Python, arbitrary property
  names, or unrestricted LOM paths.
