# Playback Listening and Entity Context

Companion checklist:
[Playback Listening Implementation To-Do](playback-listening-implementation-to-do.md).

Architecture decision:
[ADR 0006](../architecture/decisions/0006-playback-listening-and-entity-context.md).

## Ownership and scope

A listener is a transparent Max Audio Effect measuring the signal at its
device-chain position. Several listeners may share a track. Distinct listener
observations never overwrite one another merely because the track or clip is
the same.

An App session owns the context store. Subjects identify the exact Live Set,
clip/track/range, and observed settings. Agents in the same App session share
validated context; independent App sessions do not implicitly merge records.
Ableton remains the authority for musical state.

Tool execution carries the invoking agent's App-session ID, agent ID and
tool-call trace explicitly to the host. Never infer ownership from the globally
selected Desktop session; background agents and resumed agents retain their
own scope.

The first payload kind is `audio-observation/v1`. Persist measurements, not
recordings. Future typed context kinds can add other evidence without changing
the owning session or exposing arbitrary SQL/filesystem writes.

## Intended tool surface

The `ableton_listening` group provides bounded listener discovery, exact Session
clip playback-and-listen, Arrangement range playback-and-listen, pass get/list,
and owner-scoped cancellation. The `ableton_context` group provides bounded
context discovery/detail and destructive, explicitly approved pruning.

Play-and-listen is reversible-risk transport work. Require recording off and
stopped transport, acquire the application's shared transport lease, resolve exact inspected
targets, and wait for all listener readiness before starting. Never implicitly
solo/mute tracks, clear Session overrides, change routing, or alter loop/effect
settings. Existing ordinary launch and transport tools retain their behavior.

Recheck transport and recording guards after readiness. The playback adapter
must enforce those guards again at its mutation boundary and clean up partially
armed listeners or aborted starts. Retain the transport lease through the
owned pass's terminal cleanup, not merely through the initial tool response.

Capture begins at actual playback/clip launch, including quantization. A
requested start timestamp is not measured audio time. Use sample/beat/time
coordinates, frame sequence, epoch, and documented descriptor offsets.

Arrangement capture is bounded, but playback deliberately continues after
completion, cancellation, failure, or timeout. Cleanup disarms listeners and
releases local monitors and the application lease; it never stops or rewinds
Live. A cancellation request cancels measurement/publication, not transport.
Expose `cleanupPolicy: "leave-running"` in pass results and lifecycle events.

Live 11 property notifications cannot establish exclusive transport ownership:
a forward seek can resemble natural advancement, a same-value retrigger need
not notify, and polling can miss transient user actions. Therefore a successful
start must not mint an ownership token or imply that a later automatic stop is
safe. An application lease serializes application work only; it cannot prevent
the user's transport actions. The coordinator retains a legacy `stop-owned`
adapter contract for explicitly ownership-capable backends and tests, but the
Live 11 Arrangement adapter must not use it. Session capture remains unsupported
until actual quantized source onset can be independently established.

This policy is the conservative implementation decision while user confirmation
is unavailable. It preserves the ordinary playback-tool semantics without
risking an automatic stop of subsequent user playback. Listener disconnect and
timeout still require bounded watchdog cleanup; failed disarm or monitor release
is a visible failed pass, not fabricated cleanup success.

After initial transport/recording validation, the coordinator enters
`reserving-context` before any listener control or playback mutation. The
production publication adapter reserves the canonical two-MiB pass ceiling
against the invoking session's repository and preserves the caller trace and
agent attribution. Full-store failure therefore occurs before listening rather
than after an expensive capture. The reservation remains held through atomic
publication and is released idempotently during terminal cleanup for success,
failure, cancellation, and shutdown. Aborted reservation setup must compensate
its own late completion; release failures are visible failures, not successful
cleanup. No existing context is pruned implicitly to make room.

Caller abort is checked before job allocation and propagated through ownership
and Session-target resolution, capture and terminal cleanup. Queued lifecycle
notification occurs only after the terminal waiter is installed, so immediate
cancellation cannot return a misleading nonterminal receipt. Agent cancellation
also settles owned background passes after SDK idle; it never cancels another
agent's pass. Under the Arrangement `leave-running` policy it never stops
transport.

The coordinator bounds readiness and each cleanup operation to ten seconds.
An unresponsive disarm or monitor-release adapter produces a visible failed pass
even when the original request was cancellation.
The playback/capture wall-clock budget starts at the playback mutation boundary;
unused readiness time does not extend it. The listener's actual sample/beat
window remains the measurement authority.
Publication also observes cancellation and the remaining pass deadline.
An interrupted publication acknowledgement is an indeterminate failed pass,
not proof that no context was committed; query by pass ID before retrying.
Persistence adapters must honor abort before their atomic commit point.

The concrete `createListeningHost` facade owns one coordinator and an inventory
of at most 100 jobs. Typed get/list/wait/cancel requests are checked against the
invoking App session and initiating agent, not UI selection. Pagination cursors
are opaque, owner-scoped, and fail explicitly after their anchor is evicted.
Historical job ownership is retained across a Set-identity transition within
the same App session. Inspection and playback adapters receive the pass owner
and trace explicitly even after the initial SDK tool invocation returns.

## Measurement semantics

Native descriptors include peak, RMS envelope, estimated envelope-rise attacks,
and spectral centroid. Channel handling must preserve anti-phase stereo energy.
Silence must not persist non-finite values. Record units, algorithm/version,
window/hop/settings, captured coordinates, limitations, and truncation.

The current shared control contract bounds a provider capture to 120 seconds
and 512 windows; the tool's 300-second budget and canonical 1,024-point payload
are ceilings, not proof of provider support. Reconcile provider limits before
playback and reject unsupported coverage rather than silently truncating a
complete observation.

Peak/RMS dBFS is not perceptual LUFS. Estimated attacks are not guaranteed
onsets or section boundaries. Centroid differences are not proof of quality or
that one specific effect caused a change.

## Attribution and freshness

Persist each listening pass as immutable evidence and create independently
validated links to entities. Record actual Session/Arrangement activity,
listener placement, and relevant source/upstream/routing context.

The implemented `listening.inspect_context` boundary supports exact top-level
Max Audio Effects and reports bounded Live activity/settings evidence.
Its fingerprints describe available LOM fields, not source-file content or
durable entity identity, so incomplete dependencies remain unknown. The
reported current beat is inspection evidence, not a sample-aligned onset
certificate. A Session launch acknowledgement can mean triggered rather than
actually sounding; neither acknowledgement can certify a complete capture.

Max LiveAPI physical IDs and bridge connection-scoped reference UUIDs are
different identity namespaces. Do not copy the transport's physical track or
device IDs into bridge-reference fields or certify their equivalence from
names. The implemented binding helpers join authenticated
`descriptor.registration.deviceCanonicalPath` and `trackCanonicalPath` against
independent Remote Script LOM path attestations with fresh query IDs, exact
connection/instance/epoch checks and collision rejection. Top-level regular,
return and master devices are supported; nested placements remain unsupported.
`nativeStatus` is producer-reported readiness, not certification. A successful
path join proves only the current connection binding, not DSP timing, durable
identity, exclusive audio, or playback ownership.

Mixed/master observations belong primarily to track/range context. Contributors
can be linked without storing a mix as an isolated descriptor of each clip.
Unknown attribution is a valid historical outcome, not a successful exclusive
clip attribution.

`buildListeningPublication` projects inspected bindings and complete canonical
observations into one atomic pass publication. It retains one entry per listener
and uses primary/contributor links instead of duplicating mixed measurements
onto each clip. Conflicting subject evidence, duplicate bindings, foreign
owners, mismatched pass IDs, empty coverage and payload-budget violations fail
before publication. Initial link freshness is explicitly unknown; even a
completed capture is not proof of current source/dependency identity.

Source, gain/pitch/warp/marker changes invalidate affected links. Track
relocation and listener movement have explicit placement/range effects.
Upstream changes do not automatically invalidate unaffected upstream taps.
Unobservable plug-in state or external input makes freshness unverified.

Revalidate relevant fingerprints before returning current-only context.
Events accelerate invalidation but cannot prove freshness alone. Runtime UUIDs,
track indices, names, and canonical M4L paths are not durable identity. On
reconnect, ambiguous clip/device reconciliation preserves unresolved historical
records instead of attaching them to replacement entities.

## Session persistence and resume

The shared storage resolver owns the nested App-session context path. Store
references, not duplicate measurements, in the session manifest/registry.
Publishing the first context for an unsaved in-memory session must also make
that session rediscoverable after restart.

Resuming restores passes and context links before preparing the agent's bounded
inventory. Detailed arrays stay behind typed queries. Set/session switching
clears prepared context. Missing or corrupt stores surface recovery failures,
not silently empty inventories.

Context and pass pages are capped at 100 entries. Opaque continuation cursors
are bounded to 2,048 characters independently of entity IDs, matching the
repository contract; they do not expose SQL or filesystem query access.

The headless `createSessionContextHost` adapter connects list/get/prune and
resume-inventory callbacks to the typed repository through an invoking-session
resolver. It forwards per-query trace, agent and cancellation context, includes
subject names and attribution caveats in summaries, and retains explicit
unknown freshness rather than presenting it as fresh evidence. Detailed arrays
are returned only by get. Inventory JSON stays within 16,384 characters by
dropping excess summaries with an explicit truncation flag, not by cutting JSON.
Missing/corrupt repositories fail visibly. Production Desktop now composes the
canonical invoking-session resolver, first-publication registry/manifest hook,
readonly main reader, SDK inventory and transactional ownership relocation.
The synthetic Electron restart fixture proves typed persistence and isolation,
not real-device measurements.

The event journal records lifecycle and trace history but is not the context
store. Disabling diagnostics or pruning 30-day journal data does not erase
session context. Enforce bounded entry/pass/session quotas; full-store failure
is visible. Pruning requires exact reviewed scope and must not delete source
audio or musical Live objects.

## Device/app integration and lifecycle

Build on MIDI-Capture's shared producer transport. Authenticate registration,
negotiate listener capabilities, and handle prepare/arm/readiness, bounded
results, completion, cancellation, epochs, sequencing, and reconnect on the
same ingress. Preserve MIDI IDs, schema, subscriptions, JSONL independence,
and existing overflow semantics.

Audio gaps/overflow cannot be treated as complete capture. Native sampling and
measurement work stays separate from Node message transport. Device audio
pass-through must keep working with the app absent.
Completed playback observations must cover positive sample and beat intervals;
a complete flag on an empty interval is not publication evidence.

Lifecycle records cover queued, started, progress, completed, failed, cancelled,
interrupted, persistence, invalidation, and recovery with timing and
trace/correlation/causation IDs. Sanitize/bound descriptors, metadata, settings,
paths, errors, and results before persistence. Raw audio is never an ingress or
journal payload. Typed Desktop context/history views remain local-only.

Runtime composition accepts an optional listening-host factory supplied with
the same Ableton bridge, authenticated Signal runtime, event publisher and
recorder used by other tools. It does not construct an independent transport.
Static and factory-produced playback hosts must both provide a terminal-pass
wait boundary; host shutdown runs before normal runtime teardown.
Production Desktop now composes `createListeningRuntimeHost` alongside the
canonical context manager when profile storage is configured. Invoking-owner
and repository callbacks preserve exact session attribution. The fixed
application-owned commissioning gate refuses capture before reservation,
controls, playback, or publication; producer `READY` and synthetic adapter
evidence do not unlock it.

## Production readiness

The guarded Arrangement start backend and production runtime assembly are
separate implementation gates. No transport generation tokens are minted, and
`listening.stop_playback` remains unavailable. An Arrangement start may report
`sourceOnset: "unverified"`; neither its bridge acknowledgement nor its requested
beat establishes measured audio onset. Do not substitute an
inspect-then-`setPlaying` sequence for atomic mutation-boundary guards. Session
quantized source onset remains unproved. Native commissioning and independent
capture timing evidence are required before enabling successful production
playback/capture/publication, even when guarded start is available.

The separate `Audio-Listener-Commissioning.maxpat` harness feeds independent PCM
through the exact production native analysis resources without the production
client, credentials, context repository or preparation API. Its bounded
`native-commissioning/v1` reports always retain calibration-only, unverified,
not-production-ready status. Portable resource and synthetic report checks do
not establish actual Max compilation, DSP correctness, host vector phase,
transparent pass-through or Live onset alignment.

Do not advertise installed-device capability solely because a development MCP
connection exists. Promotion and installation are explicit, separate workflows;
the shipped device must not contain `mcp_bridge`.

The authored-device staging command preserves a saved Audio Effect's AMXD
container, layout, presentation, unrelated objects and direct stereo cords:
`node scripts/audio-listener-device.mjs build-authored --source <device.amxd>
--out <empty-staging-directory>`. It relinks the four owned listener entry
objects to adjacent resources, removes development search-path helpers and
stale dependency metadata, and rejects remaining absolute development paths.
The source file is never written. The destination must be empty; a failed or
cancelled stage can retain already published resources for inspection, but must
not be installed or opened as a completed bundle. Device and manifest writes
are exclusive, resources are published atomically per file, and cancellation is
checked before terminal success.

Authored packages use manifest format 2; existing canonical format-1 artifacts
remain readable. `--keep-authoring-bridge` explicitly retains the external MCP
dependency for continued development: the manifest then declares
`externalAuthoringBridge: true`, `portable: false`, and
`listenerResourcesPortable: true`. Omitting it strips MCP for a self-contained
candidate, not a production readiness claim. Packaging emits
`m4l.audio-listener.package` queued/started/completed/failed/cancelled events,
with resource progress supplied by `m4l.resources.publish`, elapsed timing,
bounded failure codes and propagated trace/correlation/causation IDs; events
contain neither source paths nor device contents. Staging does not install,
reopen, configure the App profile, or establish native timing acceptance.

The authorized `Machine-Listening` development copy has now been published into
a dedicated folder under the User Library's Max Audio Effect presets and loaded
on DRUMS, with its panel preserved and the original AMXD retained. A temporary
read-only metadata probe confirmed that the loaded analysis and spectrum
patchers and both Gen patchers resolve from that adjacent folder. Native
`node.script` reveal and Finder Get Info confirmed the same location for the
Node entry. The probes were removed; the packaged device has no temporary
search-path helpers. These checks establish resource provenance for this load,
not independent timing or capture readiness. The normal Max editor save/reopen
round-trip now preserves the panel, relative listener references and stereo
wiring. Max adds local dependency-cache metadata and changes the AMXD digest;
the working development manifest was updated only after inspection, and the
saved device was rebuilt through authored staging to remove that metadata from
the checkpoint asset. Repackaging remains necessary after further authoring.

The working device now has path-only discovery configuration for the explicitly
selected `development` profile, generated through the shared storage resolver.
No secret was copied into the device or repository. The App ingress descriptor
was initially absent. After manual development-App startup, the App advertised
`audio-listener/v1`, and its typed Outputs view showed one connected
Audio-Listener on DRUMS associated with Machine-Listening. This output remained
connected after the editor-preview adapter was stopped and the Max editor was
closed. Opening the editor also produced duplicate-listener connection
rejections. The updated candidate now uses the documented third outlet of
[`live.thisdevice`](https://docs.cycling74.com/reference/live.thisdevice) rather
than guessing editor state from identity, DSP activity, names or connection
errors. After `adapter-started`, a native `trigger b b` sends `getstate` before
the identity bang. Native `device-preview 0` permits registration; `1` blocks
it. Missing or malformed state fails closed. Preview/state failures produce
bounded diagnostics and reset only analysis; they never interrupt stereo
pass-through or control Live transport.

A transition to preview terminates any local pass as partial, using its
existing control and trace attribution, before closing its registration.
Queued callbacks from that registration are fenced. Returning to explicit
non-preview state creates a fresh producer instance if all other prerequisites
remain valid; stopping the adapter prevents subsequent state updates from
restarting it. Existing authenticated ingress/disconnect and capture-terminal
events retain their application-owned lifecycle; a blocked preview does not
create a second App listener or a new persisted payload. The
single-active-listener ingress guard is unchanged. Authored staging adds the
three native routing objects to older saved devices without replacing their
layout or unrelated wiring, and rejects partial or conflicting routing.

Runtime, serialized-graph and staged-artifact regressions cover unknown,
preview, malformed state, bounded polling, transitions, stale callbacks,
partial-pass attribution and cleanup. The regenerated repository AMXD and
staging bundle contain the routing; the User Library installation has **not**
been replaced with this candidate. Actual editor open/preview-toggle/close and
hosted-listener continuity still require isolated Live validation. Registration
establishes transport connectivity only, not capture readiness or calibrated
timing; `real_live_timing_validation_required` remains unchanged.

`max-patches/audio-listener/Machine-Listening-Development.amxd` checkpoints the
authored layout and presentation with relative listener references and the
external authoring bridge retained. Reconstruct a staging bundle with
`build-authored --source <checkpointed-amxd> --out <empty-directory>
--keep-authoring-bridge`; never treat this development asset as a production
release or readiness certificate.

Require deterministic protocol/repository/coordinator/device tests, reviewed
runner-owned Live scenarios with exact postconditions, and isolated desktop UX
validation. Timing accuracy, transparent pass-through, numerical descriptor
tolerances, bounded resources, cancellation/cleanup, and session resumption must
be demonstrated. A connected user-owned Live process is not an isolated runner.

## Known-source acceptance tests

Use independently generated test inputs, not listener-generated expectations.
`@ableton-agent/test-support` provides two-second 48 kHz stereo PCM fixtures:
440 Hz sine bursts at beats 0, 1, 2 and 3 at 120 BPM, half-beat gates and
five-millisecond fades; the same input with opposite stereo phase; and exact
silence. Their peak and whole-pass RMS references are calculated from the
quantized PCM samples independently of the listener. The WAV bytes are test
source assets, never recordings or runtime context payloads.

`verifyKnownListeningObservation` validates the canonical result and checks
pass/listener identity, complete coverage, sample rate, per-channel peak within
0.001 linear, and whole-pass RMS within 0.25 dB of those PCM references.
Centroid must be within two declared FFT bins; a window too short to distinguish
the reference frequency is rejected rather than enlarging the tolerance without
bound. Silence requires null RMS/centroid and no attacks. Quarter-note fixtures
require exactly four attacks, each within the source fade plus descriptor hop
plus one DSP vector in both sample and beat coordinates. Coarse hops that cannot
separate attacks are rejected. Anti-phase fixtures retain the same independent
per-channel level expectations.

The native candidate declares a 2,048-sample rectangular, non-overlapping FFT
window in `algorithm.windowSamples`. Its `algorithm.hopSamples` instead declares
the 100 ms envelope/reporting interval, not the FFT hop. Spectral reports use
the latest complete FFT frame rather than an average across that envelope
interval. Centroid tolerance therefore uses the FFT window; attack tolerance
uses the separate reporting interval. This source-level metadata distinction
does not certify actual Max operation or descriptor offsets.

The Max-facing Node entry installs handlers before emitting `adapter-started`.
Only that acknowledgement requests device identity again, avoiding a race with
`live.thisdevice` firing before Node startup. It is not capture readiness.
Missing or invalid profile discovery emits one diagnostic and disarms once per
distinct failure reason rather than resetting native analysis on every poll.
Both Gen analyzers compile without the shared compiled-code cache; development
reload is an explicit native command, not a timing certificate.

Spectral Gen code uses `binEnergy`, not Gen's built-in Euler constant `e`.
Completed centroid/energy values are sampled inside `pfft~` and returned as
messages to outer native `sig~` holds. They never traverse `fftout~` synthesis
windowing/overlap-add, which can scale a descriptor or produce zero between
frames. Reset clears these holds. The 10 ms scheduler polls spectral values
before the seven-value frame collector; the envelope interval remains 100 ms.
Control-to-signal conversion and FFT/report offsets still require independent
timing calibration.

Direct development checks in the authorized `Machine-Listening` device on
Live 11.3.43 measured a continuous, inaudible 440 Hz native test source:
stereo peak 0.5, RMS 0.353553, and centroid 452.028311 Hz. Opposite-polarity
stereo retained those levels and a 442.163645 Hz centroid; both frequencies
are within the declared two-bin tolerance. Reset/mute returned seven zeros.
The temporary source fed only the analyzer, never `plugout~`, and was removed.
These limited native measurements are not independent PCM acceptance,
transparent-pass-through measurement, attack timing, host alignment, or an
App capture/publication result. Production remains blocked.

Capture boundaries and declared timing uncertainty must remain within one DSP
vector of independently supplied host coordinates. The verifier must not be
given start coordinates copied from the observation being tested. These numeric
criteria do not establish transport synchronization, calibrated descriptor
offsets, transparent pass-through, or entity attribution on their own.

Source-fixture and synthetic verifier tests do not establish an end-to-end result.
Runner-owned scenarios still must load the real device, verify exact source
content/settings, call the actual playback-and-listen tool, compare observed
coverage/onsets/levels/centroid to independent references, verify subject
attribution and persistence/resume, and assert listener cleanup plus deliberately
continued playback. A tool-built
Operator sequence supplies complementary workflow coverage; its preset defaults
are not an absolute-amplitude oracle.

The reviewed `operator-quarter-note-fixture` scenario in `listening-fixtures`
constructs the Operator/Arrangement source through normal bounded agent tools
by writing a Session source and duplicating its exact identity into Arrangement
(direct Arrangement MIDI creation is not advertised by the observed Live 11
tool surface). It independently verifies device identity plus exact A4 notes in
both clips at beats 0-3,
half-beat durations and velocity 100. It does not play or listen, and leaves only
the generated Session source and Arrangement copy in its runner-owned group Set.
It is a source-fixture
scenario, not real listener acceptance; waveform/settings and measured audio
still need independent verification.
