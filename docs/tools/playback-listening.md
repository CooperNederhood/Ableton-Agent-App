# Playback Listening and Entity Context

Companion checklist:
[Playback Listening Implementation To-Do](playback-listening-implementation-to-do.md).

Architecture decision:
[ADR 0006](../architecture/decisions/0006-playback-listening-and-entity-context.md).

## Current acceptance checkpoint

The [implementation checkpoint and regression
baseline](playback-listening-implementation-to-do.md#issue-29-checkpoint---2026-10-13)
records achieved code, native measurements, remaining acceptance and rerun
commands at code baseline `bf61bc3`. The feature is not end-to-end ready.

Earlier development registration on DRUMS remains historical evidence. The
candidate at `bf61bc3` on `14 Audio` retained its initial flag but reported
`editor_preview_blocked` with the editor closed, preventing discovery. The
approved prototype now removes that unverified flag as a registration
requirement; automatic editor isolation is deferred and the editor must stay
closed during hosted-device commissioning. Actual registration with this
replacement still needs isolated Live validation. Authentication,
duplicate-listener protection, exact identity/epoch ownership, production timing
denial and safe transport cleanup remain mandatory.

The next acceptance target is one actual, bounded Arrangement capture with
independently verified measurements and correct durable context publication.
Session onset support, portable promotion and production enablement remain
unaccepted. Neither passing synthetic capture/IPC tests nor the successful
source-fixture scenario is evidence of a successful real audio capture.

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
rejections. An earlier candidate used the documented third outlet of
[`live.thisdevice`](https://docs.cycling74.com/reference/live.thisdevice) rather
than guessing editor state from identity, DSP activity, names or connection
errors. The native third-outlet preview emission is also retained in the cold
inlet of `int -1`, so an emission before Node readiness is not lost. After
`adapter-started`, a native `trigger b b b` queries enabled state with `getstate`,
reads the retained preview flag, then requests identity. `getstate` is **not**
relied on to query preview: the isolated Live 11.3.43 device emitted enabled
state `1` on outlet 1 but nothing on outlet 2 when queried. Native
zero/one gate semantics were not validated: fresh loading retained a flag
that blocked a hosted device with its editor closed. That policy is superseded.

Registration now depends on actual identity, valid DSP/host metadata and
explicit profile discovery through the existing shared authenticated client,
not on a preview flag. The authored `device-preview` selector and native
metadata routing remain compatible without replacing the layout. Numeric
zero/one reports have no control effect; malformed reports produce one bounded
`invalid_device_preview_state_ignored` diagnostic per invalid run, without
logging their raw value, disarming analysis or closing registration. No preview
value grants capture readiness or disables authentication.

Actual identity, DSP configuration and producer instance/connection-epoch
changes still reset local analysis, terminate affected passes with existing
attribution, close stale registrations and fence late callbacks. Stop remains
terminal. Existing authenticated ingress/disconnect and capture-terminal
events retain their application-owned lifecycle. The single-active-listener
ingress guard is unchanged; editor duplicates are still denied by ingress,
not guessed from this native flag. Keep the editor closed for the first
prototype; automatic editor-preview isolation is explicitly deferred.

Native metadata helpers remain for authored compatibility, including
idempotent migration of complete earlier routing and rejection of partial or
conflicting routing. They are not an authoritative context classifier.
Runtime and staged-artifact regressions cover missing/zero/one/malformed flags,
bounded diagnostics, identity/epoch replacement, stale callbacks, partial-pass
attribution, cancellation and production denial. The User Library installation
has **not** been replaced. Registration
establishes transport connectivity only, not capture readiness or calibrated
timing; `real_live_timing_validation_required` remains unchanged.

The isolated staged device was confirmed on `14-Audio`, with native
`dsp 1 48000 64`, stopped transport, valid host metadata and canonical identity
`live_set tracks 13 devices 0`. The isolated App was restarted after its prior
process exited; it connected to Live but discovered no output from the earlier
candidate. Startup console evidence showed preview messages arriving before
Node readiness. Temporary metadata probes were removed without saving the
loaded patch or changing audio routing. The subsequent latch candidate still
reported `editor_preview_blocked` with the editor closed, motivating the
approved simpler registration policy.

After code checkpoint `a0cb4e8`, the actual hosted listener registered with the
fresh isolated App on `14-Audio`. The checked runtime, path-only profile
configuration and manifest were published into the already loaded engineering
bundle with its polling paused and Node adapter stopped. Original
companions were backed up. The AMXD and Node entry were byte-identical to the
staged candidate and were not replaced; stereo wiring, presentation and the
User Library installation were unchanged. An unsuccessful UI loading attempt
also left an empty temporary `15-Audio` track, which remains explicitly
accounted for rather than silently deleted.

The App Outputs view showed exactly one connected Audio-Listener. A completed
agent turn used only `ableton_listening:inspect-listeners`; its expanded
observed tool result returned one non-truncated listener with exact App track
and device references. Independent native inspection resolved
`Machine-Listening-Development` on `14-Audio`, canonical path
`live_set tracks 13 devices 0`, LOM device ID `2142`. Pausing the 10 ms poll
before stopping the adapter removed the output. Restarting it and restoring
polling returned exactly one output. A second single-inspection turn returned
the same listener/track/device references and a fresh producer instance ID.
Both observed results retained `ready: false`,
`real_live_timing_validation_required` and `source_onset_unverified`.
`inspect-listeners` does not expose sample rate or connection epoch; those
fields were not inferred from assistant prose.

This passes the narrow hosted connection/reconnect milestone, not native
timing or audio acceptance. Transport remained stopped, no listening pass or
stored observation was created, and the Max editor remained closed. The next
measurement step required a clean runner-owned known-source Set without armed
external-hardware tracks. The unsaved template was not played or discarded
during those connection checks. Approval to replace it was subsequently
granted: the user saved the original Set and approved a clean calibration Set.
The later known-PCM check below records that continuation.
These connection checks are not timing certification.

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

The subsequent clean, runner-owned Set now has an actual generated stereo PCM
clip feeding the hosted device through Live's audio track, not an injected
`cycle~` source. Native `live.object` inspection confirmed the exact generated
`ML-Calibration-quarter-sine.wav` path. Its independently checked bytes are
48 kHz, stereo 16-bit PCM, 96,000 frames, SHA-256
`f04440ac779afee5aa9352244d03312c9b03b65d5e798fad01c68b47a14e7f21`.
The listener is on track index 2; importing the clip automatically renamed
`3-Audio` to `3-ML-Calibration-quarter-sine`. Looping and warping were disabled.

A manual, watchdog-protected analyzer enable and temporary native console
probe measured per-channel peak **0.5** and maximum 100 ms window RMS
**0.353553**. Independent quantized PCM samples 4,800-9,599 give plateau-window
RMS **0.3535529554794787** per channel; the measured peak and window RMS pass
the 0.001-linear and 0.25 dB subset tolerances. Twelve retained full-level,
high-energy spectral frames reported centroids **441.668179-459.932376 Hz**,
within two 2,048-sample FFT bins of 440 Hz. These are selected steady-signal
frames, not a claim that every transient FFT frame has that centroid.

This is **partial native level/spectral evidence**, not a complete listening
pass. The Max bridge retains only 200 console messages: the first unfiltered
collection lost the active region and was inconclusive. A temporary `zl change`
removed duplicate held frames for the repeat; its retained evidence contains
33 nonzero records but still does not establish complete pass coverage or
four verified attacks. Whole-pass RMS, anti-phase PCM, independent timing,
offsets/gaps, transparent pass-through and actual capture/publication remain
unaccepted. No certificate or production prepare/arm path was enabled.

The Master fader was temporarily set to zero for inaudible playback and restored
to its observed 0.85 after the non-looping source finished. Analysis was
disabled/reset, all four temporary probe objects were removed, the object list
and named cables were checked, and both direct stereo pass-through cables were
verified. The inspector populated previously blank nested destination IDs, so
those initial unnamed endpoints are not a byte-for-byte wiring oracle. The
authored AMXD on disk and User Library were not replaced. Transport was left
running; the source clip itself was verified no longer playing.

Engineering evidence is bounded in
`.test-artifacts/listener-calibration-native-quarter-sine-levels.json`.
The earlier clean-Set attempt exposed stale bridge reads/timeouts and was
abandoned, not counted as success. Recovery of the empty test Set was declined
only after explicit user approval. The coordinated UX readiness deadline fix
at `3d78a19` preserves the ordinary deadline and prevents the interactive path
from inheriting its short timeout; see the testing specification.

### Bounded hosted descriptor collection

`hosted_calibration_probe.js` is a temporary engineering probe, not an installed
listener companion or commissioning authority. It taps the existing seven-value
native frame list; it does not synthesize descriptors or change the stereo
audio path. The operator must independently attest the owned Live process and
exact source clip before providing the `runner-owned` acknowledgement and a
UUID trace. Acknowledgement is not process or source attestation.

The probe resets/enables analysis through the existing watchdog guard, observes
a zero counter, then requires one completed, silent 4,800-sample native window
before requesting the source clip's `fire`. A stale zero alone cannot trigger
the source. It retains exactly 100 contiguous envelope windows in bounded
memory, ignores duplicate held counters, fails on malformed data, non-silent
baseline, gaps or resets, and has a 12-second reset/collection deadline.
Completion, failure and cancellation disable/reset analysis. Object deletion
requests the same cleanup and cancels the probe timer, but native cleanup must
explicitly disarm before removal rather than relying on cables during object
destruction. None of these paths stops a clip, rewinds or stops transport.

Queued, started, four progress checkpoints and terminal events retain elapsed
time and trace/correlation/causation identifiers in the descriptor-only report.
Exports contain one bounded header and at most 13 indexed eight-frame chunks,
well below the console's 200-record cap. JSON is hex-encoded as ASCII for the
Max message boundary: directly printing JSON symbols reinterpreted quotes and
commas in the observed native path. Consumers must decode, verify the trace,
require every declared chunk exactly once, and check all sample increments
before using a collected report. Native `js` syntax is checked as ES5 and its
message handlers are tested with eval-scoped loading, rather than assuming
modern Node parsing proves Max compatibility.

The report always declares `calibrationOnly: true`, `nativeTiming: UNVERIFIED`
and `productionReady: false`. It has no filesystem, credentials, network,
context publication or production prepare/arm access. Source identity/hash,
independent sample-rate verification, host/source timing and transparent
pass-through still require separate evidence. Any retained engineering report
belongs under the documented test artifacts, not the App context database.

The actual guarded-start run retained all 100 windows (10 seconds) with an
initial silent window; source fire was requested after 106 ms. Both the normal
and independently generated anti-phase PCM measured stereo peak 0.5. Summing
the squared native 100 ms RMS windows and normalizing by the known 96,000
source frames gives **0.24662070585665122**, versus independent whole-fixture
PCM RMS **0.24665487816027645**: **-0.001203452463732628 dB** error per channel.
The denominator is the two-second source, not the ten-second padded collection.
Each run has four separated positive-envelope groups and trailing silence.
Four selected steady spectral windows per run remain within the two-bin
tolerance: normal **442.4286824110682-459.9323760696037 Hz**, anti-phase
**441.71705667354917-459.77766789894224 Hz**. This demonstrates non-cancelled
spectral analysis of actual opposite-polarity track input, not an internally
inverted synthetic signal.

The anti-phase and silence sources were imported into previously empty Session
slots 1 and 2 through the running Live 11 ClipSlot's inspected
`create_audio_clip` method. Native reads confirmed the exact generated paths;
looping/warping were disabled and end markers set to two seconds. This is
engineering setup, not a new advertised agent import or Session-listening tool.
After the anti-phase run, the silence run retained 100 windows with exactly
zero peak, RMS, centroid signal and spectral energy. Independent track
`playing_slot_index` observation changed from -2 to 2 and back to -2 across
the two-second source. The Clip's `is_playing` property could not be observed
through `live.observer`; track slot state supplied the separate playback proof.
These are scheduler-level observations, not sample-accurate launch markers.

An actual cancellation retained 28 contiguous windows and reported
`cancelled/operator_cancelled` after 2,848 ms rather than presenting a partial
report as collected. Earlier native syntax/framing failures and a zero-frame
collection timeout remain failed engineering attempts; they are not acceptance.
After all runs, analysis was disabled/reset, all six temporary objects and
their cables removed, and the entire inspected native graph matched this run's
complete baseline exactly. All three non-looping source clips were independently
verified no longer playing before the Master fader was restored to 0.85.
Transport was deliberately not stopped. The current calibration Set retains
the three generated clips; no saved authored device or User Library asset
was replaced.

Bounded evidence is in
`.test-artifacts/listener-calibration-hosted-contiguous-quarter-sine-guarded-start.json`,
`.test-artifacts/listener-calibration-hosted-contiguous-anti-phase.json`,
`.test-artifacts/listener-calibration-hosted-contiguous-silence.json` and
`.test-artifacts/listener-calibration-hosted-cancelled.json`. These results
establish the narrow continuous level/energy and silence-reset checks. Four
envelope groups do not certify production attack events. Host/source
sample/beat alignment, FFT/report offsets, attack timing, transparent
pass-through, actual Arrangement capture/publication and resource-cost
acceptance remain open; production readiness is still denied.

### Attack phase correction and host-validity fencing

Algorithm **1.0.1** fixes a phase-dependent double count found in the retained
native windows: the same four-burst PCM source could produce four or eight
estimates depending on how its rising envelope crossed the reporting windows.
After one estimate is emitted, subsequent increasing windows in that same
continuous rise do not emit another. A plateau or fall rearms estimation;
threshold and minimum-spacing controls still apply. A subthreshold or
spacing-suppressed rise does not latch the episode. State resets for each pass.
This remains a coarse envelope-rise estimator, not exact onset detection.

Four regressions failed before the correction. The corrected engine produces
four estimates for both retained normal-source phases and the anti-phase run,
and none for silence when replayed with explicitly synthetic host coordinates.
Independent quantized-PCM tests sweep 76 reporting phases for normal,
anti-phase and silence at thresholds 0 and 6 dB: 456 combinations check counts
and the declared coarse timing bound. Neither replay nor numeric integration
certifies execution/timing of an actual production capture.

The source manifest, staged package metadata and runtime now share algorithm
version 1.0.1. An older 1.0.0 timing certificate cannot authorize this version;
historical 1.0.0 observations remain readable. These code/packaging changes
have not replaced the current hosted engineering bundle or User Library.

Approved-runner timing declarations must require `plugsync~` validity bits
sample count (1), PPQ beats (2) and transport (16), minimum mask **19**.
The official [Max reference](https://docs.cycling74.com/legacy/max8/refpages/plugsync~)
defines those bits; sample validity alone is not transport validity.
Loss of mandatory flags before actual launch fails without enabling analysis.
Loss during capture yields an explicit partial result. A changed DSP vector
invalidates an in-flight timing binding just as a changed sample rate does.
These fences do not supply a missing certificate or calibrate a launch.

Read-only native probes on the owned device observed `host` flags **31** and
`dsp 1 48000 64`, corroborated by a separate Live transport read at 120 BPM.
Two host sample/PPQ pairs advanced coherently at 24,000 samples/beat; this is
counter/beat evidence, not a source-launch or FFT-offset measurement. The
sixth `plugsync~` outlet returned **120** in this host, despite the legacy
reference describing samples/beat there; do not blindly apply that legacy
unit conversion. The listener uses the separately verified PPQ/sample/flag
outlets, not that tempo outlet. Both temporary probes were removed and the
inspected native graph restored exactly, without altering transport.

The remaining launch-adapter gap is concrete: a 10 ms scheduler poll and a
Node receipt cannot prove the requested DSP launch boundary or align an
analyzer reset to it. The current exact-boundary guard must continue rejecting
missed launches; widening tolerance or writing a generic certificate is not a
fix. A native signal-rate launch/source marker, paired with independent host
coordinates and descriptor-offset evidence, is still required.

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
