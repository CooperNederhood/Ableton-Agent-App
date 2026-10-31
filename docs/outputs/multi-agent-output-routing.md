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

Audio listener placement refresh is opt-in to the shared identity companion;
MIDI producers retain one-shot initialization. After an audio device/track path
changes, the runtime replaces registration and its instance/connection epoch.
The existing path-derived producer ID changes as well. The old connection is
not a current Output, and old captures/callbacks cannot publish through the
new registration. A new listening request must rediscover the moved device
and independently attest its current LOM placement. Subscriptions remain
keyed to their original producer ID; this fix adds no subscription migration
across changed paths or durable-device guarantee for path-keyed subscriptions.
Historical observations retain their original identities and unknown freshness.
The placement guard cache is bounded, memory-only and non-authoritative;
there is no new storage path, migration or remote diagnostic upload.

## Native listener feature negotiation

The canonical profile-owned signal ingress descriptor and its enabled legacy
compatibility alias publish the same supported listener capabilities. Listener
hello acknowledgements advertise that same application-owned list, including
`audio-listener/retention-v1`. `SignalIngressServer.start()` returns a TCP endpoint,
not the complete discovery descriptor: consumers must read the published
descriptor rather than reconstructing feature support from the endpoint.

Production wire4 registrations use one shared protocol validator in ingress
and independent application binding. Accepted tuples are the exact legacy tuple
`[audio-listener/dual-mode-v1]` or the exact retained-measurement tuple
`[audio-listener/dual-mode-v1, audio-listener/retention-v1]`. The retained feature
is advertised only when wire4 retained measurements are enabled. Public wire2
and wire3 producers retain their existing single primary capability.

The shared producer client requires every configured capability in discovery
and, for feature-bearing registrations, in the authenticated hello ACK. Missing,
malformed, or unsupported feature support rejects admission before arm or result
delivery; it does not downgrade the retained producer to an older algorithm.
Legacy single-primary producers remain usable with old and new peers, including
old hello ACKs that omit the optional supported-capability list.

The feature covers the explicit `measurement` native lifecycle phase without
changing wire versions or public observation formats. A measurement-stage
`completed` event remains a progress result, not completed capture authority.
Queue counters belong only in the strict
`native-measurement-delivery-rejection/v1` failure diagnostic; they are not
additional untyped lifecycle fields. See
[Playback Listening](../tools/playback-listening.md) for retained producer
behavior and native qualification requirements.

## Listening rejection evidence

Native failure diagnostics remain non-authoritative, optional metadata on the
existing listener transport. The closed `native-check-rejection/v1` scope and
optional `checkEvidence` on the existing scopes identify the source owner,
phase/check/predicate, original reason, launch disposition and exact typed
operands with units/clock domains. Receipt timing may be unavailable before
admission; null is not an observed zero. Bounded accepted/rejected inputs use
numeric cells or fixed invalid-value markers, never arbitrary private payloads
or audio. Separate cleanup evidence must not replace the initiating failure.

Diagnostics may accompany failed replies/results, partial results and cancelled
replies without changing those statuses or granting proof/completion authority.
Successful readiness or capture still requires its ordinary independently
validated native proof. A matched App/listener is required for new optional
diagnostic shapes; malformed/unsupported evidence cannot silently erase the
primary failure or become an automatic retry.

The Max runtime opts into the shipping SDK's FAILED-only
`sendListenerFailureMessage(type, control, payload)` path. If optional
`nativeFailureDiagnostic` alone is invalid, unencodable or over the frame
quota, the SDK can omit that field only after independently validating and
framing the original bare failure. It retains status, reason and ownership,
emits a diagnostic-gap status, and performs at most one transport write.
Ordinary reply/result APIs remain strict; mandatory payload/context/framing
failures remain rejected. There is no retry after a write. Authenticated
ingress then records the original failure and explicit absent-source coverage,
not a fabricated source explanation or a generic replacement timeout.

The private `retention-snapshot` path retains at most the latest bounded reader
state per family, throttled to one receipt per 250 ms/family. Optional terminal
reader snapshots preserve actual nonterminal epoch/request/readback state and
receipt age; they do not advance readiness, freshness, ACKs, descriptor
consumption or capture. This is diagnostic-only collection through the existing
private numeric codec, not a new native audio ABI or datastore.

Ingress retains the full validated diagnostic in the existing redacted journal
and records `output.listener.rejection.observed`. Missing/partial/dropped or
truncated source evidence produces `output.listener.diagnostics.coverage-gap`.
Application-owned schema, ownership and proof rejections retain bounded issue
paths or validated proof/configuration operands, never rejected raw bodies.
An internal typed service side-channel carries these App rejections through
fatal connection release; producers cannot add it to wire messages.
The common `listening-failure/v1` summary propagates through capture/runtime,
coordinator and public agent result to Desktop. Owned trace navigation uses
the typed `readTrace` route and retains system/native rows even when those rows
have no App-session/agent attribution; ownership filters from the root list do
not hide rows inside the validated job's linked trace.

The diagnostic callback's existing rate limit is separate from journal
rejections. Bounded `output.ingress.diagnostics.suppressed` first/final counts
identify that callback sink; they do not claim rejection journal loss.
Recorder health and durable persistence remain the shared journal's
responsibility, without blocking DSP or capture on journal writes.
See [Playback Listening](../tools/playback-listening.md) for controlled-source
evidence and the remaining actual-host/delivery gates.

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
Callback emission alone does not qualify application-owned History coverage.
The ordinary audio runtime now forwards actual callbacks into bounded,
metadata-only collection. Optional `write-backpressure/v1` diagnostics ride
existing authenticated heartbeats after ordinary drain; support must be
confirmed by the authenticated hello ACK, not a descriptor hint alone. Legacy
peers keep unchanged heartbeats; missing support marks diagnostics unsupported,
not a failed native capture.

Collection retains at most 64 events for 60 seconds. Each batch fits both eight
events and 8 KiB, plus the negotiated complete-frame limit. Within those bounds,
source event IDs survive until heartbeat ACK; metadata-only redelivery after normal
reconnect is deduplicated. Diagnostic writes suppress self-instrumentation.
No measurement data is replayed and cancellation/shutdown is not delayed.

Ingress records typed, redacted source lifecycle/timing and actual socket
metrics as `output.producer.write-backpressure.{stage}`. Coverage diagnostics
use `output.producer.diagnostics.{coverage-gap,source-gap,handler-failed}`.
IDs are at most 128 string units; source age must be below 60 seconds, with at
most one second future tolerance. App audit receipts and source-order streams
are capped at 2,048 each, dedup identities at 4,096, all with 60-second TTL.
Dedup identity is authenticated producer + instance + source event ID.
Frozen originating request receipts validate delayed capture
ownership after release; the current delivery connection is recorded separately,
never substituted as the source capture owner. Transport-only writes have no
fabricated capture ownership. Diagnostics remain journal-only, not signal
observations, agent input or automatic turns.

Overflow, expiry, malformed or forged metadata, unsupported delivery and recorder
errors are explicit nonfatal coverage failures. A heartbeat ACK is not a durable
journal guarantee. Producer death before delivery can leave source coverage
unknown; record the App-observed disconnect/gap rather than inventing a source
completion/cancellation. Software callback-to-authenticated-ingress-to-typed-
journal coverage passes; real-native History qualification remains separate.
The first new-resource physical attempt (`f3b93259`) passes native capture and
final checks but retains no source write-lifecycle rows, only an unknown-coverage
disconnect. Neither source callbacks/write-return nor its cause were observed;
the separately retained failed History gate must not be promoted to a pass.
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
