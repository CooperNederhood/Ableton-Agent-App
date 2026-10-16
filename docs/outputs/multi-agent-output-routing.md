# Multi-Agent Output Routing

## Subscription model

Outputs are stable MIDI or audio producers. Active agents subscribe
independently, so one producer may feed any number of agents and each agent may
listen to any number of producers.

Outputs are not the same as
[Live Events](../events/live-events.md). Outputs ingest MIDI/audio observation
streams from producers; Live Events observe LOM properties and semantic
transitions. They may share delivery primitives but retain separate source
inventories and user interfaces.

Outputs also share the local event journal's writer, sanitized trace envelope,
correlation, retention, and query infrastructure. This does not merge the
domains: bounded structured MIDI/event payloads are retained while binary/audio
bodies are omitted with visible markers. Output records use Output-specific
categories and source IDs, and Outputs remain separate from Live Event
definitions, listeners, routing rules, inventory, and UI.

A subscription is keyed by active-agent instance and producer. It stores:

- stable producer ID;
- enabled state;
- next-prompt, automatic-analysis, or automatic-action delivery;
- usage instruction;
- processing-policy IDs.

Canonical agent `inputChannels` seed new instances. Each entry is a stable
producer ID; it does not contain display, track, device, or signal metadata.
Session edits then belong to the active instance snapshot and do not rewrite
canonical YAML.

## Delivery

The signal router creates an independent assignment inbox for every
subscription. One incoming producer frame fans out to each enabled assignment.
Acknowledgement, latest-window state, automatic-turn deduplication, and delivery
mode remain isolated per subscription.

Subscribed agents receive observations even when another agent is selected in
the workspace. Missing or disconnected producers do not delete subscriptions;
routing resumes when the same stable producer ID reconnects. Disconnected
connection records are not part of the current output inventory.

## Producer transport backpressure

The shared Max producer client's audio path treats Node `socket.write(false)` as accepted
data awaiting drain, not failed delivery. Drain does not constitute a protocol
ACK. Subsequent frames use a same-connection FIFO bounded by the existing
pending-request quota (64 by default) and twice the negotiated maximum frame
bytes across queued and socket-buffered data (256 KiB for native v2, including
wire newlines). The per-frame native-v2 limit remains 131072 JSON bytes excluding
the newline; this local aggregate cap does not enlarge packet or capture budgets.

The drain deadline is one second. Write-callback errors, socket error/close,
quota exhaustion and drain timeout remain explicit failures. Stop cancels the
wait and drops queued frames; timers/listeners are removed and stale callbacks
cannot affect a replacement socket. Accepted frames are never resent, and no
offline or reconnect replay is introduced. Authentication, epochs, sequencing,
ACK meaning and outer operation deadlines are unchanged.

The existing producer `onStatus` callback emits bounded, redacted `write_backpressure`
queued, started, progress, completed, failed and cancelled lifecycle/timing
records with request, trace, correlation, causation, job/pass and queue-count/
byte attribution. Raw frames or audio bodies are not added to status records.
The module is shared by MIDI and audio producers, but the new FIFO applies only
to audio. MIDI retains its existing immediate accepted-write behavior on false
and existing offline sample policy. Subscription and agent delivery
acknowledgement remain separate.

## Runtime consumers

SignalRuntime tracks a set of active agent consumers rather than one active SDK
session. Next-prompt context is queried by active-agent instance ID. Automatic
turns are dispatched through the multi-agent manager using the subscription's
consumer ID.

## Desktop experience

Each live Output row or card contains one checkbox per active agent. Checking
creates or enables that subscription; unchecking disables or removes only that
agent/output relationship. Detailed delivery controls are scoped to the chosen
subscription.

Subscriptions whose producer is absent appear separately as unmatched
subscriptions for active agents. They do not count as discovered outputs and do
not appear as synthetic Unknown/ungrouped output cards. Users can remove an
unmatched subscription or leave it in place for stable-ID reconnection.

The Outputs view refreshes from the signal service when opened and also provides
an explicit refresh action. Project snapshot refresh remains independent: it
updates Live track and device metadata used for grouping, but signal ingress
determines which producers are currently connected.

The same subscriptions appear in active-agent editing and persist with the
production session.

Output history records sanitized ingress metadata and each per-agent queued,
started, completed, failed, cancelled, coalesced, or deduplicated delivery
stage. Child delivery records retain the ingress trace and get distinct child
IDs, so fan-out can be queried without exposing signal content or conflating
agents.
