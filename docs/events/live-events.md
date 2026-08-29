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

The schema must be a discriminated union. Each kind owns only the fields needed
to resolve and serialize that source.

### Live event occurrence

A `LiveEventOccurrence` is one normalized observation emitted by the Remote
Script:

- event ID and event kind;
- monotonically increasing bridge sequence;
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
- use normal tool allowlists, edit scopes, and approval behavior;
- never inherit another agent's permissions;
- serialize with that agent's active turn;
- deduplicate identical pending deliveries;
- use settled-value delivery for continuous events.

The generated prompt clearly states that the trigger is a Live observation,
not a user-authored message, followed by the configured prefix and structured
event summary.

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

Recent activity is hidden by default. Keep a bounded in-memory history per
event, newest first. Do not persist occurrence payloads in the initial
implementation.

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
- no occurrence history.

Migration defaults are empty arrays. Existing `inputChannels` and Output
subscriptions continue to load unchanged.

## Safety and privacy

- Creating a listener is read-only and requires no mutation approval.
- Automatic agent responses retain normal mutation approval rules.
- Event payloads are bounded and treated as local project data.
- Detailed note lists, audio, and high-volume parameter history are not
  persisted.
- Listener installation never accepts arbitrary Python, arbitrary property
  names, or unrestricted LOM paths.
