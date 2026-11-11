# Acceptance test authoring

The primary interface is the repository development skill
[`author-integration-test`](../../.github/skills/author-integration-test/SKILL.md),
not hand-written JSON and not a skill installed in the product's Default agent.
Start with the desired actions/messages, plain-language correctness, and the
parts of the Set that must not change. An existing `.als` is optional at intake.
The user prepares the Set in Live; the development agent specifies, verifies,
packages, and runs the test. Computer-use fixture creation is not required.

The [integration testing summary](integration-testing-summary.md) explains the
architecture. The [test strategy](test-strategy.md) defines evidence boundaries.

## Two-MIDI-track listener smoke (#113)

`session-two-midi-listening` uses the user-approved saved Operator/808 Set,
with Blackhole removed and both return tracks retained. The immutable Set hash
is `0f7c19b91a2716eb05efd1e24ac4f3032767ff598d50d31918b2df2ea34d0e16`.
Factory 808 samples and Hybrid IRs are verified installation dependencies, not
redistributed fixture assets. Both exact saved listener slots are bound to the
production candidate.

Separate read-only owned review `loaded-review-xblJCp` on Live 11.3.43 confirmed
stopped beat zero, 128 BPM, One Bar global/clip quantization, two remembered
Session slots, recording off, and both listener bindings. Saved and loaded
notes agree: four Operator C4 notes and an 808 kick/snare pattern. Instrument
fingerprints independently match the previously reviewed Operator and 808
fixtures. The review submitted no message or capture and closed all owned
processes and profile resources.

The approved smoke uses one Default-agent conversation and one Live process:
four beats from `1-Operator`/`clip-1`, exactly one runner-owned transport STOP
without seek, then four beats from `2-808 Core Kit`/`clip-2`. Each turn has five
minutes; the overall run has 630 seconds with separate 30-second collection and
cleanup budgets. There is no retry, device reload, app restart, feature-search,
classification quiz, or settings repair. The STOP preserves the nonzero position
reached after turn one rather than hiding a possible stopped-position defect.
The existing single-use STOP admission accepts either Session audio or Session
MIDI capability; owned restarts still require persistence capability.

Require exactly two source-attributed, non-silent, complete 90,000-frame captures
at 48 kHz, all six requested metric timelines, two distinct readable contexts,
native freshness, stable listener instances/connections, unchanged protected
state and terminal owned cleanup. Legitimately unavailable pitch values are not
fabricated notes. The shared driver rereads original contexts and listener
bindings; redundant agent read calls are not required. This is not a restart
persistence or exclusive-clip-audio claim.

Run only this registered case with
`pnpm live:acceptance --scenario session-two-midi-listening`.
Registration and the loaded review do not establish a capture pass. The original
manual failure remains separate evidence: both listeners were discovered, the
drum preparation used stopped beat `6.7356444444444445`, then
`metric_source_position_mismatch`, unconfirmed cleanup and disconnect occurred.
Its actual rejected clock operand was not retained.

The first registered execution, `run-wrQAle`, admitted the loaded fixture on
Live 11.3.43 with the unchanged qualified candidate, but stopped before capture:
the initial manifest omitted the approved `durationBeats: 4` argument from its
exact permission rule. The agent requested the correct four-beat Operator
capture and the strict policy rejected the undeclared argument. The corrected
manifest explicitly pins four beats for both turns; the policy, prompts, source
scope, use counts and assertions remain unchanged. Deterministic regression
reproduces that rejection and checks exact duration, source, step and single-use
guards. Preserve the original receipt as a harness-blocked run, not reproduction
of the user's native failure. All owned process/profile cleanup passed.

After that manifest correction, `run-68gHYg` reached one actual capture request
on the unchanged candidate
`bbb259e7d9184b4e85ce757a51aeee035b532007b360aca2774dcaf890c372ee`
and Live 11.3.43. It is a valid red product execution: the first Operator
capture failed during arming with `mel_invalid_drain_receipt`, then cancellation
was denied with `Listener ownership mismatch` and capture cleanup could not be
confirmed. No stored context was published. The second drum turn and runner
STOP were correctly unrun under the stop-at-first-failure contract. This
reproduces native failure/cleanup symptoms, not the original drum track's
`metric_source_position_mismatch`, and does not establish a shared root cause
or listener disappearance. No product fix or capture retry was made. Terminal
runner cleanup independently confirmed Desktop and Live stopped, host
reservation closed and isolated profile removed; that does not convert the
failed capture cleanup into success. Both failed receipts and staged projects
remain preserved under `.test-artifacts/acceptance/`.

Current-build comparison `run-7EFYKE` also exposes the native drain failure in
the historical quantized MIDI case. The first instrumented attempt
`run-1BGLe1` instead failed fixture admission at `a.stoppedPosition` before any
capture. Source-admission errors now retain bounded expected/observed transport
beats, playing flags and slot state, rather than a predicate name alone. No
precondition or saved fixture value is relaxed or repaired.

The fixed native candidate's `run-N92QN6` exposed a separate startup-budget
bug: owned Live started at 23:13:56 and logged its Remote Script listener at
23:14:57.155, just outside the driver's hardcoded 60-second readiness cap.
Live readiness now consumes the scenario's existing remaining overall budget
and receives its cancellation signal. No manifest budget, capture deadline,
source assertion or recovery-discard policy changes. This is separate from the
earlier Desktop shutdown during `run-WVTVNu`; neither is a native-fix verdict.

The subsequent `run-5Hp9Lr` reached both turns. Operator exercised
`mel_native_arm_pending`, completed all six metrics and persisted its context.
Before the drum turn, the owned Live log records the selected EarPods output
disappearing at 23:21:24 and becoming `Output Device: No Device`; drum preflight
began at 23:22:22 and failed with `metric_preflight_timeout`, without confirmed
capture cleanup. Runner process/profile cleanup passed. The failed receipt is
preserved alongside `audio-device-interruption.json`; it is not a two-track
pass or a resolution of the original position mismatch. Further real-host
qualification requires an available selected audio output, without repairing
settings during a scenario.

After EarPods were reconnected, `run-GpPZ2o` found that Live had retained its
disabled audio setting. Its startup log explicitly reported "Audio is disabled.
Please choose an audio output device in the Audio Preferences." The bridge and
Desktop became ready, but neither audio listener registered; both capture turns
remained unrun until the overall readiness deadline. Cleanup passed. Listening
acceptance now rejects the existing `audio-disabled` startup-dialog outcome
before Desktop launch rather than mistaking a reachable bridge for usable DSP.
Bridge-only inspection can still report that dialog without requiring audio.
Unit regressions reproduced admission of disabled audio with a ready bridge,
misleading port-timeout attribution with an unavailable bridge, and the missing
listening requirement at the driver boundary before this fix. This fail-fast
guard does not enable audio, repair settings, or qualify either capture.

After that harness correction, the complete Vitest run passed 5,895 tests in
256 files and full typechecking passed (`audio-disabled-final-*` logs). The
unchanged native and Python code had passed 1,044 and 294 tests respectively in
the preceding `pending-arm-final-*` run; those stages were not rerun for this
harness-only correction. The six targeted and 1,612 broader runner tests passed.
These deterministic results do not convert the blocked two-track case or the
remaining unrun packaged cases into successful real-host qualification.

With the audio output restored to MacBook Pro Speakers at 48 kHz,
`run-y4L4Rr` completed both four-beat MIDI captures, all six metric families,
both persisted context reads, capture-count and native-freshness checks. It
then exposed a run-level `context` assertion bug: `afterRestart: false` always
selected `turn.contexts`, but run completion has no current turn. Final context
assertions now use independently collected run evidence when no turn exists;
turn-scoped checks still use that turn's context reads, and restart checks still
require owned-restart evidence. Assertion and coordinator regressions reproduced
the failure before the correction, with guards for missing, mismatched,
duplicate, unreadable and replaced evidence. No scenario, capture, source or
context-integrity requirement was relaxed. The failed receipt remains preserved;
its original position-mismatch failure did not recur, but was not established
as fixed by this assertion correction.

The unchanged two-MIDI case subsequently passed in `run-f5eDKl`, including
all final protected-state assertions and runner cleanup. The same candidate
also passed identification, flatness, spread and rolloff. The next mel-bands
case, `run-DFFYC5`, exposed stale harness assumptions rather than a missing
native cleanup: its verifier required ABI 2 even before readiness and treated
the current stopped/drain diagnostic operands as summary lifecycle facts.
The verifier now follows the pinned native ABI, permits ABI zero only for
empty pre-readiness preparation/pending-arm events, and independently checks
the stopped/drain operands against the complete terminal summary. Diagnostic
records remain in History, separate from lifecycle summaries; neither an
empty startup receipt nor diagnostic evidence substitutes for terminal
physical cleanup. Synthetic fixtures model the current event shapes, with
negative guards for ABI, ownership, counters, clocks and receipt ordering.

`run-VOIYcE` then exposed the unchanged 512 KiB turn-evidence cap: the mel
receipt duplicated 164,364 bytes of report pages already deterministically
derivable from its complete observation. Receipts now retain the complete
observation plus each canonical page's SHA-256, offset, continuation and row
count. Validation reconstructs every page and compares every digest and
pagination field; agent-visible reports still undergo full independent
measurement comparisons. The regression was red at 113,125 bytes for the
synthetic projection before compaction and passes below 2 KiB afterward.
The cap, scenario and measurement requirements remain unchanged.

### Current-candidate suite result (2026-11-11)

All **13 selected packaged cases passed**, with **21 captures**, no selected
turns unrun, every terminal assertion passed, persisted receipts and complete
capture/runner cleanup. These are sequential supported single-case executions
of the registered suite, not a bypass of suite assertions or retention limits.
All used Live **11.3.43**, ASAR
`bbb259e7d9184b4e85ce757a51aeee035b532007b360aca2774dcaf890c372ee`,
and identical original candidate native-resource inventories. Per-run generated
configuration/frozen-device hashes differ because binding paths are owned by
each case. The packaged handoff is
`8edca2fa8f1da527182a8c78f7a5b19d4c96e9573547dfeb93d53cadb795fdca`;
the mapped native binary is
`9396867893605be398f8d7af4a5605a8289afbeb28d472c96bd43e67aa93995a`.

| Registered scenario | Passing receipt directory |
| --- | --- |
| `session-clip-identify` | `run-cyvfA6` |
| `session-listening-feature-search` | `run-QfOQyq` |
| `session-listening-peak-smoke` | `run-H6T9Tp` |
| `session-flucoma-flatness-smoke` | `run-cfWsCF` |
| `session-flucoma-spread-smoke` | `run-ClsYdw` |
| `session-flucoma-rolloff-smoke` | `run-4R4ZiY` |
| `session-flucoma-melbands-smoke` | `run-Vaguu3` |
| `session-flucoma-pitch-smoke` | `run-z9wNKZ` |
| `session-listening-continuity` | `run-Me7tyU` |
| `session-stopped-quantized-audio` | `run-8uaNj1` |
| `session-stopped-quantized-midi` | `run-PfzQAv` |
| `session-drum-rack-listening` | `run-ZqdZsh` |
| `session-two-midi-listening` | `run-f5eDKl` |

Directories are under `.test-artifacts/acceptance/`; the generated
`.test-artifacts/current-candidate-qualification.json` ledger retains terminal
receipt hashes, outcomes, capture counts, versions and failed attempts.
Historical evidence is preserved byte-for-byte in
`reviewed-history-issue113-prior.tar` (SHA-256
`bcf2cf43d1e972465d323f73b8033135cf8a77a41e7de9902a8365ec83107628`),
containing the eight original verified history archives. This does not rewrite
their failed/cancelled or cleanup verdicts. The user-session's original exact
position mismatch remains unexplained, not silently classified as this race.
The two separately deferred runtime fixtures and a normal-profile installed
update are outside this result.

Final deterministic verification also passed: **5,936 Vitest tests in 256
files**, **1,044 Max patch tests**, **294 Python tests**, and all typecheck
scopes. These are fresh results from the completed
`.test-artifacts/final-validation-{vitest,max-patches,python,typecheck}.log`
runs, not counts inherited from earlier candidates. All four commands exited
zero, with no reported unhandled errors.

## Same-session peak fundamentals smoke (#113)

`session-listening-peak-smoke` reuses the unchanged `session-clip-identify`
assets for the user-approved first success milestone: two normal captures in
one Default-agent conversation, with exactly one declared runner transport STOP
before the second turn. There is no restart, third turn, or persistence
capability. Capture negotiation is unchanged; `coverage: "peak-only"` selects
only the reading/assertion scope, not a product metric flag or alternate
capture implementation.

The shared feature-search oracle independently recomputes stereo peaks and
Euclidean distance from retained level records, checks canonical units and
whole-source exclusion, and rereads the same stored source hashes at final
collection. Exact capture/context inventories, unchanged fixture/source state,
native freshness, mapped mel-binary proof at baseline and completion, and owned
process/lease cleanup remain required. Nonzero repeated-capture distance is
valid. The coordinator's collection deadline remains named `persistenceMs`;
using that existing deadline does not claim restart persistence.

The user-approved peak-only contract permits the first turn's genuine typed
`get-feature` result to satisfy the first-feature read in turn two. This is not
assistant-text recall: the oracle revalidates the original call/result and first
capture, requires the same App session, agent and conversation, and checks that
the persisted source projection is unchanged. Feature IDs, stored metadata,
segment, source provenance and independently recomputed stereo values must agree.
Any second-turn reread must preserve that immutable content, and the second-turn
search query/match must match the exact typed feature views. Read-time freshness
annotations are not immutable content or a substitute for the existing native
freshness and protected-state checks.

The second capture requires established peak values in turn two: its own genuine
typed `get-feature` read, or the narrowly approved exact-equality proof below.
The original measurement read, `compare-features`, and whole-first-source
exclusion search remain mandatory. No capture, cleanup, freshness, fixture,
native or source assertion is removed. The same approved principle extends
to the full pre-restart measurement reads described below. `run-Y4gRuG`, `run-TQyFgQ` and
`run-vSZQII` remain failed historical-contract receipts; do not rewrite their
verdicts or present an offline replay under this revision as a new host run.

The `session-listening-feature-search` manifest and prompts remain unchanged:
full coverage is the default, with fifteen definitions, authoritative
analyzers, and a third read-only turn after owned Desktop restart. Neither the
new registration nor offline harness tests qualify physical capture or resolve
the source-identity/baseline blocker. Preserve all prior attempts, including
`run-QE7CLE` and its `a.stoppedPosition` failure, separately from any future
peak smoke result. No new fixture authoring is required.

### Full measurement read reuse before restart

The user-approved immutable-read contract also covers the first source's
`peak-summary/v1`, `pitch-confidence-summary/v1`, `flatness-summary/v1`,
`spread-summary/v1` and `rolloff-summary/v1` reads during the second turn.
The verifier revalidates the completed first turn, requires the same App session,
agent and conversation with distinct attributable SDK turns, and requires the
unchanged source hash, native timelines and retained sample evidence. Reuse
is forbidden if either pre-restart turn claims an owned restart. Any first-source
reread must retain the exact feature ID, immutable metadata/provenance, values
and support page; a new identity cannot replace an original one.

The second source must still have its own genuine typed reads for confidence,
flatness, spread and rolloff in the second turn; its peak may instead use the
exact-equality proof below. Independent numerical/support checks, discovery of
all fifteen canonical feature types, native acquisition/validity, comparison,
source-excluding search and every capture/protected-state/cleanup guard remain
mandatory. No other feature family inherits prior-read permission.

The restored phase never borrows pre-restart reads: it requires fresh,
post-restart typed reads of every original feature from both sources, plus
fresh original source/measurement evidence. Original IDs and immutable content
are bound against both earlier turns, including features read only in turn one.
Missing or changed reads still fail; this is not a cache-based persistence claim.
Earlier failed receipts, including `run-sQ6iJ8`, retain their historical verdicts.

### Outcome-based feature evidence (approved 2026-11-07 revision)

The shared full/peak-only oracle distinguishes an actual direct peak read from
an equality-established peak; it never creates tool calls, results or value
pages. Only when the second peak read is absent may the first genuinely read
stereo vector establish the target vector through an attributable, requested,
**exactly zero** comparable `euclidean-linear-amplitude/v1` result in
`linear-amplitude` units. Nonzero distances, including tiny nonzero distances
within ordinary arithmetic tolerances, cannot identify an unread vector.

The target's actual inventory/search metadata must bind the exact feature,
context, segment, session, Live Set, pass, source hash, sample/beat ranges,
canonical profile, units, normalization and complete measured coverage.
Independent recomputation from the target source's retained samples must equal
the first vector exactly. Comparison provenance must match both features;
the separate source-excluding search must match those immutable views and the
recomputed distance. Malformed or contradictory actual feature reads still fail,
even when an otherwise valid equality proof exists. Other analyzer arithmetic
and explicit unavailable/validity checks are unchanged.

For full discovery, an actual bounded `list-features` inventory containing all
fifteen canonical types and their canonical available metadata may replace a
redundant `feature-definitions` call. Validate protocol fields, status/reason,
profile, units, distance definition/units, normalization, support policy,
counts, duration/ranges and source attribution. Descriptions and limitations
need not be repeated through the model; deterministic catalog/tool tests own
that API coverage. Any catalog response that is present must still be valid and
complete; it cannot be ignored in favor of inventory evidence.

After owned Desktop restart, both original peaks still require fresh actual
`get-feature` reads, including the formerly equality-established target. Its
original identity, immutable metadata/provenance and established vector must
match that fresh read. Caches, pre-restart reads, comparisons or assistant prose
cannot satisfy persistence. Frozen prompts, fixture assets, budgets,
permissions, capture counts, mutation guards and transport framing are unchanged.

### Optional read-only transport inspection

The outcome contract also separates fresh persistence evidence from redundant
frame downloads. Capture turns still consume complete original analyzer pages.
After restart, each source requires a fresh original report with matching
acquisition/profile/support metadata and actual validated frames from both
analyzers, plus fresh reads of all requested feature vectors. Independently
reread full persisted source records and analyzer timelines must exactly match
their originals. Missing reports, altered unread frames, stale feature values,
changed IDs or source hashes still fail. The agent need not redownload every
unchanged analyzer frame solely to satisfy a prescribed pagination sequence.

The 2026-11-07 reviewed feature-workflow contract also permits optional
`ableton_transport.get` inspection in any turn. Validate its exact read-only
arguments and typed transport result; accept plain JSON or only the exact
application-owned transport success-hook suffix. This does not permit stop,
seek, reset, other transport actions, or unrelated read tools. Failed, malformed,
foreign, duplicate or uncorrelated results still fail. All measurement-page,
feature, capture-count, restart, protected-state and cleanup assertions remain
unchanged. `run-zYhRGa` retains its original failed verdict: it exposed this
verifier restriction after successful capture and complete report consumption.

The transport-only revision passed 142 focused and 763 owning tests. Fresh Live
11.3.43 run `run-8Dr6MW` passes both capture assertions and the first feature
assertion, but fails `missing second-turn typed peak feature read`. The agent
reads the second source's four analyzer summaries but not its peak feature.
Under that historical contract, comparison/search distances could not replace
the requested read. The restored turn remains unrun and final owned cleanup
completes. The later explicitly approved outcome-based revision above accepts
both genuine first/second turn evidence offline (the two independently measured
peak vectors are equal and the comparison is exactly zero; the inventories
contain all fifteen canonical types). The historical receipt and failed verdict
are unchanged. This replay is not a new host pass or installation qualification:
fresh owned-restart reads, final persistence/native/protected-state assertions
and terminal cleanup still need a new real-host scenario.

### Runner-owned STOP socket handoff

The protocol 10 Remote Script serves one bridge client at a time. A second TCP
connection while Desktop owns that slot cannot complete `system.hello`;
`AbletonBridgeService.start()` records the handshake error without rejecting,
and a subsequent guarded STOP otherwise reports an unavailable capability.
Protocol 10 registers `transport.set_playing`; the runner must not bypass its
real capability guard or retry an ambiguous mutation.

For scenarios declaring STOP, the existing runner bridge proxy starts with zero
added delay (unless the separate read-timing diagnostic was explicitly selected).
Only the isolated Desktop profile's supported bridge port preference changes.
Between completed turns, one trace-attributed handoff waits at most five seconds
for pending requests, partial frames and queued responses to drain, closes the
idle Desktop tunnel, and excludes reconnects while the authenticated runner
bridge negotiates normally. A connected handshake, exactly one typed
`setPlaying(false)`, and its verified result are required. The runner bridge
closes in `finally`; the same Desktop process reconnects through its existing
typed API, and protected source/world reads must independently confirm STOP.
There is no seek, reset prompt, new permission, capture, or extra turn.

The handoff is single-use, bounded and fail-closed, with lifecycle/timing/trace
records containing no authentication payload. Cancellation before admission
preserves in-flight Desktop work; handshake, capability, mutation, reconnect or
verification failures stop the scenario without resending. This is runner-only
orchestration and requires no product repackaging. A fresh selected run must
launch Desktop through the proxy; simulator regressions do not qualify the
physical second capture or erase `run-6vu8LH`.

### Cancellation and owned proxy shutdown

Final cleanup claims and closes the proxy before stopping Desktop. Otherwise a
deliberate Desktop exit during a pending startup hello looks like an unexpected
client disconnect. The proxy classifies requests using the canonical protocol
catalog: pending read-only requests may terminate as cancelled during explicit
shutdown, but outstanding mutations or unknown commands retain a cleanup failure.
An already-observed disconnect, malformed frame or socket error remains failed.
The proxy never resends work; its terminal close accounts for owned sockets,
queues and timers, and late-acquired proxies are also closed before their owned
Desktop process.

Cancellation still means a cancelled/unrun scenario, not success. Cleanup is
complete only when the independent process, profile and reservation teardown
checks also succeed. `run-IpjSVr` remains the historical cancelled receipt:
no turns executed and all resource flags were true, but the old Desktop-first
shutdown order added `client_closed_with_pending_work` as a cleanup failure.
Its original verdict and bytes are not rewritten by this runner fix.

### Full-feature History receipt budget

`run-6soIhz` passes both capture/feature turns under the outcome contract but
fails aggregate turn retention at restart. The receipt projection now also
omits only non-evidentiary feature freshness/presentation summaries already
excluded from immutable comparisons, and report-entry display summaries.
Full typed product History and product evidence retain those fields. Every
call/result, attribution, immutable feature field, value/support page, source
timeline and report fingerprint remains; neither the 524,288-byte budget nor
the evidence assertions are enlarged. The original failed receipt is preserved.

The projection and fresh-source outcome regressions pass with 197 focused and
818 owning checks. Fresh `run-qFzkdY` again passes both capture/feature phases,
but the restored turn reaches its unchanged 120-second deadline while the agent
is still streaming its response. Owned cleanup completes; full scenario
qualification and normal-profile installation remain blocked. Neither the
timeout nor the earlier receipt-budget failure is rewritten as a pass.

The user subsequently approved five minutes for this scenario's restored step.
Use the existing per-step `timeoutMs: 300000` manifest parameter, not a global
runner override. Its deadline includes owned restart/setup, submission, agent
work and step assertions. Increase this scenario's outer `budget.runMs` from
480000 to 660000 to preserve the same 30-second allowance beyond its three
step budgets (150000, 180000, 300000); cleanup and persistence remain 30000
each. Other tests are unchanged. `run-qFzkdY` shows tool completions and growing
streamed output up to the cutoff, not evidence of a hung agent.

With that budget, `run-uqZfOc` passes all six turn assertions, including fresh
post-restart features and no recapture, but fails final capture count because
the restarted Desktop's in-memory job registry is empty. The runner now retains
a bounded run-owned union of pass IDs from every actual inventory read,
including immediately before owned restart and at final collection. It does
not synthesize IDs from expected counts, source contexts or successful turns;
unexpected pre/post-restart passes remain visible to the unchanged count
assertion. Query failure aborts before restart, and cumulative inventory
overflow fails closed. The historical failed receipt remains unchanged.

Fresh `run-356zOY` passes all ten assertions on Live 11.3.43 with complete
terminal cleanup in 361 seconds overall. Both original captures, discovery,
comparison/search, fresh owned-restart reads, exactly two independently observed
pass IDs, persisted source/content and protected state are verified. Agent turns
complete in approximately 56, 116 and 103 seconds; step budgets also include
setup and assertions. This qualifies the selected case under the reviewed
outcome contract, not unrestricted listening reliability or the deferred native
repeat/switch cases. Earlier failed receipts retain their original verdicts.

The full feature/restart case retains the existing 524,288-byte aggregate turn
budget and typed History limits. `run-sQ6iJ8` reached that aggregate bound after
the second turn: its correctly scoped typed histories were 257,987 and 292,119
bytes. This was not a global-History scan or missing pagination; the first full
feature assertion passed, the second turn executed, and the restored turn was
unrun. Keep that failed receipt unchanged.

Only full-feature receipts use `acceptance-feature-report/v1` consumption
evidence. The runner first collects and validates the complete per-turn typed
query, including ownership, duplicate, truncation and byte guards, then validates
each original measurement report against its canonical schema. The receipt
retains every record, call, feature value, catalog, comparison, search and
terminal message. Report bodies retain source and pagination identity, all
metric statuses, acquisition counts/trailing support, and exact SHA-256
fingerprints of profiles and every distinct reported native frame. Identical
row-overlap copies collapse; conflicting frames fail. The oracle compares those
fingerprints to the complete authoritative source profiles/frames already
retained in `featureSources`, including all 43 pitch and shape frames, with the
same complete-page consumption and numerical checks. It does not substitute
assistant text, impute values, sample frames or accept truncated payloads.

Complete report bodies remain in the typed journal and the driver's bounded
product evidence. Restart verification compares those original typed histories
before applying the same deterministic receipt projection. The three-turn
regression includes four report pages per capture, eight restored report pages,
the fifteen-definition catalog and both sources' feature reads/inventories,
and must fit the unchanged aggregate budget. Peak-only and non-feature receipt
collection are unchanged. This budget fix does not itself authorize prior-read
reuse: the separately approved pre-restart contract above governs that. Fresh
post-restart feature and source reads remain mandatory.

## Authoring workflow

- Understand the scenario and choose a supported test entry point.
- Agree on the starting state, exact turns, allowed changes, and independent
  assertions. Obtain human contract approval before fixture preparation.
- Give the user an ordered Live 11 recipe with exact settings, required files,
  and instructions to save a separate project with its media.
- Ingest an owned copy of the prepared project; verify its baseline, dependencies,
  portability, and media rights. Report mismatches rather than silently repairing
  them, and obtain final asset/permission approval.
- Generate the fixture and scenario manifests and register the test using shared
  tooling. The user does not need to write JSON.
- Validate and run the approved scenario; report setup blockers separately from
  product failures, with evidence and cleanup outcomes.

## Basic draft intake

The skill's small helper works before a fixture manifest exists:

```bash
mkdir -p .test-artifacts/fixture-authoring
node .github/skills/author-integration-test/scripts/intake-project.mjs \
  --project "/path/to/Project" \
  --output ".test-artifacts/fixture-authoring"
```

- Selects exactly one root `.als`, never a backup.
- Copies the Set and its project-local referenced resources into a fresh owned
  directory, preserving relative paths; verifies source/copy hashes.
- Reports external references without reading or copying those locations. Some
  references describe preset history, not required runtime files.
- Intake permits up to 512 reference blocks including preset history; active
  dependency admission remains capped at 128. This admits the supplied 808
  Drum Rack's 230 reference blocks without discarding provenance.
- Writes a bounded redacted inventory/report beside the copy and emits traced
  intake lifecycle events. Failed or cancelled partial copies remain for review.
- Does not launch Live, check musical correctness, infer device companions,
  repair settings, or register a test. `copied-for-review` is not qualification.

Registered fixtures support neutral `resource-NNN.wav`/AIFF filenames under
`media/` or Live's `Samples/` directory hierarchy, including `Samples/Imported/`.
Staging preserves those references and retains the same ownership/hash guards.

Fixtures may pin licensed installation resources in `builtinResources` (up to
32 files) and `coreLibraryResources` (up to 128 files). They are verified in the
selected Live application's `Contents/App-Resources/Builtin` and
`Contents/App-Resources/Core Library`, respectively, and never copied into
fixture assets. Each declaration requires a safe relative path, exact byte size
and SHA256; each library has a 64 MiB total and 16 MiB per-file bound. Saved
reference type 7 is admitted only by a matching Builtin declaration; type 5 only
by a matching Core Library declaration. Absolute fallback, undeclared samples,
symlinks, missing files and changed hashes remain failures. The provisioning
receipt records each checked library's inventory hash.

## Persistent outputs

| Output | Location / owner |
| --- | --- |
| Reusable fixture | `integration/fixtures/<fixture-id>/fixture.json` plus small approved Set/media, hashes, baseline, dependency inventory, provenance and redistribution rights |
| Registered scenario | `integration/acceptance-scenarios/<scenario-id>.json`, registered by ID in `integration/acceptance-scenarios/suite.json`: exact ordered turns, scoped permissions, budgets and named assertions |
| Reusable contracts/assertions | `@ableton-agent/test-support/integration`; typed evidence rather than executable expressions in JSON |
| Execution evidence | Shared runner receipts and bounded allowlisted working-project resources from successful and failed runs; not a substitute for version-controlled definitions |

Each independent case gets a fresh neutral working project and isolated profile
using the [storage resolver](../platform/local-storage.md). Turns within a case
retain their conversation and project. The original source is never edited.
Oracle metadata and authoring instructions stay outside agent-visible projects,
prompts, filenames, and context. Build-supplied listener devices come from the
production candidate, not an old binary hidden in the fixture.

## Common command workflow

### Run every registered packaged test locally

After building one candidate and closing your normal Live process:

```bash
pnpm live:acceptance:suite --executable "/absolute/path/Ableton Agent.app/Contents/MacOS/Ableton Agent"
pnpm live:acceptance:verify --receipt "/absolute/path/suite.json" \
  --executable "/absolute/path/Ableton Agent.app/Contents/MacOS/Ableton Agent"
```

The suite discovers **all** IDs in `integration/acceptance-scenarios/suite.json`
in registry order and executes each once. New registrations join automatically;
templates, unregistered files and the separate runtime smoke catalog do not.
There are no automatic retries or suite repetitions. Scenario-internal captures,
conversation continuity and owned restarts retain their reviewed contracts.
Individual `live:acceptance --scenario` runs remain useful diagnostics but do
not qualify the whole suite.

The command is explicit operator approval for dedicated test-owned launches,
not permission to attach to a user's running Live or accept OS authentication.
A shared local host lease prevents overlapping runners across worktrees and
isolated profiles. Each case gets fresh owned apps, profile and project.
Ordinary failures remain recorded and later cases run only after safe cleanup.
Cancellation, uncertain ownership, changed inputs, failed cleanup or failed
evidence persistence stops execution; remaining and unknown work is visible.

The aggregate `suite.json` under `.test-artifacts/acceptance/suite-*/` identifies
the selected cases, every attempt, assertions, first failure, candidate/source/
fixture hashes, actual Live versions and terminal cleanup. Case receipts and
product evidence remain beside it. A checkpoint is not a final verdict.
Each case also writes `cleanup-evidence.json`, with separately attributed
History, Desktop shutdown, acquisition settlement, Live shutdown, host
reservation, profile removal and evidence-persistence stages. Nested failure
causes and the bounded packaged shutdown receipt are retained rather than
collapsed into a generic `AggregateError` message.
`resourcesReclaimed` is distinct from `cleanupComplete`: verified process,
reservation and profile reclamation permits releasing the host lease even when
History collection or graceful shutdown failed. Such a case still fails
qualification and stops later suite cases; reclaimed resources never turn a red
test green. Missing or mismatched resource proof remains fail-closed.
Product evidence carries the individual case run ID and scenario ID as well as
the shared suite trace; another case on that trace cannot substitute for it.
Cancellation during terminal persistence revokes provisional success rather
than leaving a passing receipt. Unknown acquisition/cleanup remains distinct
from cases known not to have run.
The verifier rejects changed candidates, changed registrations/fixtures,
incomplete cases and mismatched terminal evidence. A clean committed checkout
is required for qualification. A red or blocked suite is not retried until green;
preserve it and explicitly agree on any subsequent real-host investigation.

See [Packaging and Operations](../platform/packaging-and-operations.md#local-real-live-release-check)
for clean-checkout prerequisites and the release checklist. This local lane is
not run by ordinary hosted CI.

The catalog/CLI implementation and
[packaged Desktop adapter](../../tests/electron/acceptance-driver.ts) exist.
The reviewed `session-clip-identify` and `session-listening-continuity` scenarios
are registered.
Registration does not establish real-host qualification; inspect terminal run
receipts for execution and assertion outcomes.

The selected `session-flucoma-pitch-smoke` reuses the unchanged
`session-clip-identify` fixture, its exact-source one-use listening permission,
and existing finite run/restart/cleanup budgets. Its one turn requests pitch and
confidence. Pitch assertions require paired finite diagnostics on both channels,
at least one positive candidate per channel, the fixed YinFFT Hz profile,
attributable lifecycle and physical cleanup, independently pinned loaded pitch
binary identity, and fresh typed History persistence after an owned Desktop
restart. Healthy baseline/mel/SpectralShape evidence cannot substitute for
missing pitch; agent context consumption remains about the existing report,
not nonexistent pitch report fields. The kick fixture establishes delivery,
not note accuracy, calibrated confidence, voicing or independent FFT support.
The user authorized this one case's root-cause fixes and retries until passing,
with prior failures retained and no broader real-host suite selected.
The selected case passed all 16 assertions in `run-IYzggs` on Live 11.3.43,
candidate source `7ea89023`, including pitch binary identity, both-channel
candidates, fresh restart History and complete capture/final cleanup.
The existing exported `readSuiteAttempt` independently accepted its saved
receipt/checkpoint/product/cleanup evidence against the candidate and registered
case. This is single-case verification, not suite qualification; the
`live:acceptance:verify` CLI expects a suite receipt.
The two earlier failures remain preserved: `run-fVUDqx` exposed unsupported
agent diagnostic retrieval, corrected by guidance; `run-1H55t8` exposed a
pre-pitch native-mel integrity failure that is not resolved by this later pass.
See the [bounded execution record](../tools/playback-listening.md#f4-pitchconfidence-diagnostic-smoke-95)
for immutable candidate identity and separate visible-workflow cleanup recovery.

The approved `session-flucoma-melbands-smoke` reuses the unchanged
`session-clip-identify` fixture and rolloff smoke permissions/budgets. Its one
turn requests mel bands and low/mid and high/mid ratios. `melbands-smoke`
requires one 90,000-sample 48 kHz capture, the three baseline timelines plus
43 complete independently stereo 24-band mel frames, canonical raw-magnitude
profile, no gaps, explicit unmeasured trailing support and genuine acquisition
cleanup. Flatness/spread/rolloff remain separate unqualified diagnostics.
Mel cleanup additionally requires its own attributable native
`mel_native_cleanup_complete` drain event: the bounded 16 numeric facts must
match the complete timeline, terminal reason 10, consumed terminal, zero loss,
frame count plus three readiness/start/terminal records physically drained,
and an exclusive source clock at or beyond capture end. The positive numeric
DSP-instance generation is distinct from the UUID pass generation and must
remain stable within the pass. Fresh typed History after restart must preserve
the original lifecycle receipts, not merely generic baseline cleanup.
The packaged driver independently verifies the app-owned `listener.mel~`
executable mapping at baseline and again after capture cleanup, in addition to
the spectralshape mapping. Both reads require the immutable shared-package pin,
owned Live/Max ancestry, installed resource path and matching file device/inode.
Capture proof carries the exact native acquisition ownership; the assertion
requires the same pinned identity across baseline and capture. Restart evidence
retains that original acquisition proof—it does not claim a fresh mapping or
new acquisition after the read-only Desktop restart. Missing, denied, cancelled,
foreign or malformed mel mapping proof cannot borrow healthy spectralshape proof.
The same Default agent must consume the matching typed context or report.
The driver also projects all bounded report pages from typed Desktop context;
`typed-desktop-context-projection` is explicitly **not** a claim that the agent
requested every page. Full vectors, profile, ratios and support are compared
against fresh typed reads after the owned Desktop restart. Offline synthetic
tests establish contracts and wiring only, not an independent acoustic oracle,
Arrangement qualification or a real-host pass.

On 2026-11-02 the unchanged registered case passed twice in fresh owned
Live 11.3.43 / packaged Desktop processes: terminal receipts
`.test-artifacts/acceptance/run-c27nOv/receipt.json` and
`.test-artifacts/acceptance/run-jTIy7p/receipt.json`. Both verify one complete
48-kHz/90,000-frame capture from the declared source, all three metric families,
exact `(B)`, no recapture, same conversation, typed context after owned restart,
unchanged declared scopes, and confirmed cleanup. Packaged candidate SHA-256:
`286f16e9df27fdc71c45090cf2c4331320aac2b8c90102427697a8561e58ff63`.
Profile-configured frozen device hashes differ per isolated run and are recorded
with actual extraction proof. This qualifies this case, not general listening
reliability, UI submission, arbitrary processing or restart recapture.

Earlier failed receipts remain preserved (`run-WHxg7F`, `run-dFDylc`,
`run-3hiaI6`, `run-9JP6fe`, `run-9mCI64`, `run-IXvuLi`). They exposed browser
callback serialization, endpoint publication timing, production listener-ID
validation, UUID causation propagation, successful release/finalization evidence,
and an inappropriate reconnect gate on persistence-only restart. None was
converted into a passing receipt or fixed by changing the musical oracle.

Start with offline discovery and validation:

```bash
pnpm test:acceptance:list
pnpm test:acceptance:validate
pnpm test:acceptance:validate --template integration/acceptance-scenarios/templates/session-clip-identify.json
```

The [reviewed template](../../integration/acceptance-scenarios/templates/session-clip-identify.json)
contains separate `fixture` and `scenario` objects. Template validation is
explicitly schema-only and reports `runnable: false`; it does not admit missing
assets. An empty catalog reports `awaiting-joint-fixture-onboarding`; the current
catalog contains `session-clip-identify` and `session-listening-continuity`.
Neither listing nor offline validation
is a successful acceptance run.
No import/generate command or UI driver is implied.

After joint review and real fixture registration, the intended focused workflow
is:

```bash
pnpm test:acceptance:validate --scenario session-clip-identify
pnpm live:acceptance --scenario session-clip-identify
```

Real-host execution is explicit opt-in. The real scenario uses reviewed assets;
the separate schema-valid template still does not imply physical qualification.
The run command also supports `--executable <packaged-app-executable>` and
`--live-app <Live-11-app-path>` when explicit candidate paths are needed. These
select test-owned launch inputs; they do not authorize attaching to a user's
running application. Validation accepts either `--scenario <id>` or
`--template <path>`, not both.

## Generate the reviewed definitions

For registration, split the template objects into the fixture and scenario
files above, assign their reviewed final IDs, and add the scenario ID to
`suite.json`'s `scenarios` array. The scenario's `fixtureId` must match the
fixture manifest ID and directory. Replace placeholder hashes/byte counts with
the actual approved inventory and complete provenance/rights. Only reviewed real
fixtures use `qualification: "reviewed-live"`; changing the template's
`synthetic-only` label alone is not review or asset validation.
Fill its empty `listenerBindings` from the actual reviewed saved slots; an empty
list is not runnable machine-listening setup.
Prepare portable neutral media references before freezing the reviewed Set:
staging does not rewrite media references. It creates an empty, owner-only
`Ableton Project Info` directory so Live recognizes the copied Project root
and resolves type-3 references there, not against a parent or historical path.
This marker contains no copied preferences or user metadata. Admission independently reads the
loaded clip's actual file path and requires the staged media path and hash, not
just matching bytes at the catalog's original location.

The template's empty permissions and example capture sample rate/frame count
are not a frozen execution contract. Review exact supported action arguments,
derive expected frames from fixture duration and independently established host
sample rate, and verify the loaded baseline before running. Never copy observed
result counters into the expected values.

The `session-flucoma-flatness-smoke` sibling reuses the unchanged
`session-clip-identify` fixture, permission, and budgets with one turn:
“Listen to the first Session clip on track audio-track, including spectral
flatness.” There is no classification turn. Its `flatness-smoke` assertion
requires attributable native lifecycle diagnostics for both independent stereo
channels, bounded finite dB values and positive delivery counts, exact native
ownership, causal stage ordering, and successful smoke cleanup without local
failure/cancellation. It re-reads those diagnostics through typed Desktop
History after the owned restart and compares the projection with the original.
Pre-output facts use the canonical unavailable reason `not-reported`; a missing
channel at completion still fails with lifecycle reason `flatness_no_output`.
The successful projection retains exactly fifteen facts, including both actual
Max class witnesses: unavailable before start, then exactly
`fluid.spectralshape~` from started through cleanup. Optional rejected-value
diagnostics remain failure evidence in History; they cannot qualify a success.
Both SpectralShape smoke scenarios additionally require `owned-mapped-flucoma/v1`
loaded-binary provenance before baseline admission and after successful capture.
The existing owned Live/Node ancestry proof selects Live/Max ancestor PIDs for
bounded, read-only `lsof` text-mapping reads; unrelated Max processes are never
queried. The mapped path, device/inode and pinned binary bytes must identify the
staged frozen dependency, not an identically named global Max external.
Missing mappings, ambiguous ownership, global fallback, changed process/file
identity, inspection failure or cancellation fail closed with bounded product
provenance. These controlled checks do not establish a new real-host result.
The baseline capture, publication, source cleanup, context, and unchanged-world
checks remain intact. `flucoma-flatness-smoke/v1` explicitly marks support and
value validity **unqualified**: coalesced outlet deliveries are not FFT frames,
sample-support evidence, or proof of numerical accuracy. Offline admission and
controlled regression tests do not establish real-host acceptance.
Acceptance provisioning retains pinned signed FluCoMa files as a nested
`dependencies/flucoma` bundle adjacent to the derived frozen device rather than
embedding its Mach-O binary into the collective. Inventory verification preserves
relative resource names, validates pinned bytes and executable permissions on
both candidate and staged copies, and rejects linked parents. Candidate hashes
still refer to immutable packaged bytes; no additional fixture assets are used.

The reviewed `session-flucoma-spread-smoke` case also reuses the unchanged
`session-clip-identify` fixture, scoped permission and finite budgets. Its sole
message is "Listen to the first Session clip on track audio-track, including
spectral spread." In addition to every flatness smoke/native/protected-state
assertion, it requires `spread-smoke` before and after the owned Desktop restart:
finite nonnegative Hz snapshots on both channels, positive bounded delivery
counts, exact pass/native ownership, ordered capture completion and successful
gate cleanup. The strict eighteen-fact projection uses `flucoma-spread-smoke/v1`
with unqualified support/validity; missing or invalid spread cannot pass on
flatness or native evidence alone. Restart re-reads typed History, never just a
cached successful projection. Existing `flatnessLoadedBinary*` provenance fields
identify the same shared SpectralShape binary for all three smoke cases; they do not imply
a second analyzer or flatness-only loading proof.

This is a delivery/completion contract, not numerical qualification. The existing
90000-sample/48-kHz native capture assertion is not a spread FFT frame oracle.
The contract does not add custom spectra, an identification turn, exact spread
delivery counts, or silence validity. Real-host execution requires separate
approval; registration is not a successful run.

The reviewed `session-flucoma-rolloff-smoke` case reuses that **unchanged**
`session-clip-identify` fixture, spread scenario permissions and budgets. Its
exact sole prompt is "Listen to the first Session clip on track audio-track,
including spectral rolloff." It requires `agent-listening-result`, the baseline
90000-sample/48-kHz capture and context, and all three `flatness-smoke`,
`spread-smoke`, and `rolloff-smoke` assertions before and after the owned Desktop
restart. Exactly one capture, unchanged protected scopes, and existing cleanup
requirements remain mandatory; no fixture assets or extra turns are added.

The fixed rolloff projection uses `flucoma-rolloff-smoke/v1`, metric
`spectral-rolloff`, and nineteen facts: the eighteen spread fields renamed with
the `rolloff.` prefix plus observed `rolloff.rolloffpercent: 95`. It requires
independent stereo, window/hop 2048, power/unit/minfreq 0, maxfreq -1, finite
nonnegative Hz snapshots (including actual zero), bounded positive deliveries,
exact trace/pass/native attribution, ordered lifecycle/timing, and completed
cleanup. Both support and value validity remain **unqualified**, with lifecycle
frames 0. No numerical accuracy, silence validity, or FFT-support qualification
is inferred. Existing flatness and spread schemas are unchanged.

Production SpectralShape packets use the fixed order
`[generation, epoch, "value", channel, sequence, spreadHz, rolloffHz, flatnessDb]`.
Missing, malformed, foreign, failed, or cancelled rolloff never passes because
its sibling metrics are healthy. Restart evidence is reprojected from freshly
read typed, redacted History and compared with original ownership and facts,
not replayed from cached successful values. The same loaded-binary identity
verification applies to this scenario. Deterministic registration and transport
tests are not real-host acceptance; no rolloff real-host result is claimed here.

On 2026-11-04, the approved single run `run-GUn1Ho` passed all nine frozen
assertions on Live 11.3.43. It recorded one complete 90000-sample capture at
48 kHz, 20 spread deliveries per channel, healthy flatness/native outputs,
exact retained diagnostic/context evidence after owned Desktop restart,
unchanged protected scopes and terminal cleanup. Candidate SHA-256:
`d6ecc4457cd39ebeade6d62cba8483cce050d0610ae0dc6d99c435e78eb9794f`.
The original terminal receipt and product/cleanup evidence remain under
`.test-artifacts/acceptance/run-GUn1Ho/`; the persisted assertions were revalidated
without another submission. No retry or broader campaign occurred.

The terminal assistant text reported permission denial and no publication,
contrary to the independent completed-capture/context evidence. This was an
agent result-delivery/consumption failure, not merely a prose discrepancy:
the original start returned queued, subsequent wrong-ID polls were denied,
and the agent never read the published context. The nine historical assertions
did not cover consumption; preserve that receipt without relabeling it as
passing the strengthened contract below. The run used the real installed bridge
credential through the supported environment source, so no successful Keychain
startup is claimed.

### Agent listening result consumption

The spread smoke now adds `agent-listening-result` with `sourceId: "a"`.
It retains all nine independent backend assertions, the exact fixture and prompt,
one scoped medium-risk permission, and run/turn/persistence/cleanup budgets
300000/120000/30000/30000 ms. No second capture, oracle hint, prompt override,
exact prose oracle or model grader is introduced.

The assertion joins typed `tool_call`, `tool_result`, `message` and terminal
`turn` records to the submitted Default agent's App session, SDK conversation,
SDK turn and trace. Tool correlation IDs remain the SDK tool-call IDs, with the
SDK turn as causation; they are not confused with listening-pass correlation.
It requires exactly one original Session start returning `stage: completed`
and the independently published pass/context IDs for source `a`. A successful
`ableton_context` `get` or `report` must then return the matching typed measurement
before the final assistant answer in that same normally completed turn.
`get` additionally matches the independent observation digest; `report` must
contain valid nonempty measurement rows and matching source/context identity.
Partial publication is not full smoke success. Any failed/cancelled or
success-shaped error listening/context call, additional start, missing or
truncated records, foreign identity, or result delivered after the answer fails.
Explicit successful `get-pass` inspection is allowed but cannot replace the
original start result or context read.

The packaged driver uses `window.desktop.eventHistory.agent`, a bounded typed
query over the existing local journal. It does not expose SQL, files, raw audio,
or a new storage location to the renderer. Queries page in batches of 100,
cap each turn at 256 records / 8 MiB, and reject missing/repeated pages and
changing totals. Existing aggregate runner/receipt bounds still apply.
Runtime decodes listening/context SDK JSON against the public tool-result
schemas **before** generic journal string sanitization (1 MiB input/output
bound). The existing typed result record retains structured content instead of
a duplicate raw JSON string. Invalid JSON, absent SDK content, invalid public
results and oversize inputs retain explicit `history_projection_unavailable`
evidence rather than success-shaped empty data. No application SDK event field
or new transcript store is required. The collector also decodes SDK JSON text
when supplied by a typed query and persists structured evidence, so the receipt's
16384-character string bound cannot silently clip a measurement.
Credentials remain redacted; omitted audio/binary or
truncation markers cannot satisfy the contract.
Receipt sanitization applies the existing depth limit to each typed history
record independently, and sanitizes turn/run metadata separately. Wrapping a
valid report in turn, restart and final-receipt envelopes must not consume its
payload depth allowance or truncate nested mel ratios. Structural equality,
record schemas and unchanged aggregate byte limits still gate persistence.

The original evidence is retained in `TurnEvidence.agentListening` and product
evidence. After the already-owned Desktop restart the driver re-reads the same
typed records and requires exact equality (apart from restart provenance),
retaining them in `RunEvidence.agentListening` and product evidence. Persisted
verification re-evaluates the assertion and cross-checks both receipt and product
copies; a stored `passed` flag alone is insufficient. Runner-owned context reads,
generic telemetry, publication events and UI job completion cannot substitute
for an SDK result. This proves tool-boundary delivery and consumption, not the
model's internal understanding. Deterministic synthetic regressions cover the
historical false-positive shape; they do not constitute a new real-Live run.

The separately authorized corrected attempt `run-lFeD5Y` passed all ten
assertions on Live 11.3.43. Its retained single-case evidence independently
passed assertion re-evaluation and original/reopened agent-history equality.
Prior attempts `run-wz3Mp8` and `run-CIeyEv` remain failed; they exposed,
respectively, appended SDK post-tool guidance and missing terminal-turn
submission timestamps. The fixes preserve strict parsing and ordering rather
than relaxing the assertion. This case is not a suite receipt:
`live:acceptance:verify` is the suite verifier, not a single-case CLI verifier.
Candidate pins and the separate attended visual outcome are recorded in the
[listening checkpoint](../tools/playback-listening.md).

Named assertions come from the shared registry: `choice`, `capture`,
`capture-count`, `context`, `native-freshness`, `spectral-range`, `flatness-smoke`, `spread-smoke`, `rolloff-smoke`, `agent-listening-result`, `no-capture`,
`unchanged`, and `fact-equals`. The
template illustrates their actual parameter shapes; consult
[`ScenarioManifest` and `FixtureManifest`](../../packages/test-support/src/integration/contracts.ts)
and the registry validators when generating definitions. Do not invent JSON
fields, silently drop a required check, or turn a missing read into an
assistant-prose assertion.
For repeated listening, `capture-count` requires distinct pass IDs in both the
attributable turns and the complete run inventory. `context` requires exactly one
distinct readable context for **every** capture so far, matched to the original
context from that capture's own turn. Later reads must preserve each pass's source,
context ID and content hash, including after an explicitly requested owned
restart. An earlier context cannot substitute for a new capture, and evidence
first appearing in a later turn cannot retroactively establish publication.
`native-freshness` requires unique pass/generation identities and increasing
native epochs per listener on unchanged connections. `spectral-range` checks an
energy-weighted centroid from complete retained spectral records against frozen
source-specific bounds, not a clip name or assistant classification.
Registration and these controlled checks do not qualify real-host continuity.
The generic fixture baseline is a declared scalar fact map, not an obligatory
listening baseline. Audio source/listener/path evidence and the supported audio
baseline belong to the Desktop audio driver and audio assertions; non-listening
cases need not invent them. Strict manifest and built-in assertion validators
reject unknown fields, so consult the current schemas instead of guessing.

### Stopped launch-state admission for #81

The existing packaged acceptance driver can admit declared global quantization `none` or
`bar` (One Bar), with independently declared clip quantization, and a stopped
`currentSongTime` from zero through 1,576,800 beats. Each fixture must declare
its exact position and quantization; accepting these values does not relax
comparison against the loaded Set. Both source-read brackets must agree on
the declared stopped position, known false transport/triggered/recording flags,
and no fired slot. Original fixtures require an inactive playing slot and a
false target-playing flag. A fixture explicitly declaring a nonzero stopped
Session playing count
may instead retain a stable active target slot in both brackets while transport
is stopped. This is remembered Session selection, not running transport.
The snapshot's remembered clip count must match the declaration exactly;
`playingSessionClips` retains the observed Session playing flags, including
remembered stopped selection; it is not forced to zero. With transport stopped,
it must equal `rememberedSessionClips` when that additional fact is declared;
otherwise the explicitly declared stopped `playingSessionClips` count also
defines the remembered count. For the
supplied Set both counts are 2, while `transportPlaying` is false and
`queuedSessionClips` is 0. Running transport and queued clips remain denied.
A mismatch blocks submission,
without stopping, seeking, or changing settings. The existing continuity
scenario still explicitly requires stopped beat zero between its captures.

This is **runner admission only**, not product support or a successful
real-host test. Product/native timing qualification remains independent.
The simplified user-reviewed #81 scope is **one supplied combined Set**, global
**One Bar**, stopped at its declared nonzero position, both Session clips
remembered active (Space resumes both). Run two independent fresh-copy tests:
`audio-track` / `clip-1` and `midi-track` / `clip-2`. MIDI is sine-wave Operator
quarter notes; the existing audio is unchanged. There are no four saved variants,
eight-case matrix, or repetition campaign. Already-running transport
is deferred and remains denied; there is no automatic stop-first fallback.
No hidden stop, seek, or quantization edits are permitted. Independent
source/native launch alignment still requires product and real-host evidence.
Both registered cases now have that bounded qualification; see the receipts
and candidate pins in [Playback Listening](../tools/playback-listening.md).

Success for these two cases is a usable, completed listening result for the
requested target, not a musical-classification quiz. Reuse the shared `capture`,
`capture-count`, `context` and `unchanged` assertions: exact frame count/sample
rate, complete non-silent metrics, correct source/listener attribution, retained
usable context, no hidden mutations, and independently confirmed owned cleanup.
Do not add a choice assertion, spectral-classification threshold, repetition
schedule, or extra starting-state variants. The user's explicit red-then-green
request authorizes source intake; physical evidence remains required rather
than another authoring-approval round.

Each source may declare `clipLaunchQuantization: "global" | "none" | "bar"`,
overriding the fixture baseline default for that source only. The driver and
coordinator compare every source against its own declaration; the top-level
baseline facts describe the first declared source. Omitted source declarations
retain the fixture default, preserving the original audio cases. Unknown or
mismatched loaded values block admission. Mapping uses the normalized protocol
enum (`0=Global`, `1=None`, `5=One Bar`), **not saved XML ordinals**.
For the combined Set, the common baseline may omit both `clipWarped` and
`clipLaunchQuantization`. Optional individual declarations can pin audio
`"global"` / MIDI `"bar"` explicitly. When neither source nor common baseline
declares clip quantization, admission still requires a supported, known loaded
protocol value for each source and the correct audio/MIDI kind. The exact
observed settings are retained and protected by the source-settings fingerprint,
alongside the immutable supplied Set hash; no default Global setting is
substituted into observed evidence. Existing explicit expectations remain exact.

The supplied Set intake reports saved `Transport/CurrentTime` as
`2.0593777777777778`, not a rounded UI position. Its MIDI notes are pitch 60 at
beats 0, 1, 2, 3, duration 0.25, velocity 100, unmuted; both clips loop 0..4.
Audio track/index 0 has listener device 0; MIDI track/index 1 has Operator
device 0 and listener device 1. Saved XML track/device IDs are distinct from
these indices. MIDI XML `LaunchQuantisation=5` and audio `=0` are intake facts,
not loaded enum evidence. Independent physical reads confirmed stopped position
`2.059377861721612`, audio Global and MIDI One Bar using the public protocol enum.
The fixture pins the reviewed complete note and exposed Operator hashes; the
original supplied project remains untouched.

The typed compound preflight now reads complete MIDI notes through the
existing bridge command, with matching clip/track/slot identity and a 2,048-note
ceiling. It rejects partial pages rather than borrowing audio metadata. This
read is covered through production Electron IPC and attributed History using
an owned simulator; it is not rendered-content or native timing proof. The
driver rejects wrong-kind results for either audio- or MIDI-declared fixtures.
Preflight brackets the complete top-level inventory around exact parameter
reads: at most eight top-level devices and 256 parameters per device. Racks
add a complete `devices.inspect` instrument tree, capped at 64 devices, four
nested chain levels and 4,096 parameters. Regular/return chain ownership and
drum-pad chain assignments, mute and solo are included in the reference-neutral
fingerprint; both tree reads must agree. These are exposed message-rate values,
not an atomic or opaque plugin-state dump. MIDI source declarations independently
pin canonical note content and exposed instrument-chain hashes, and the runner
checks those expectations at baseline, between capture turns and during final
collection. Physical completion, exact capture coverage and native timing
evidence remain independent requirements; content hashes do not replace them.

The user approved the proposed Operator fixture and preparation contract on
2026-11-03; a copied audio Set and generated listener kit were supplied without
operating Live. Subsequent authorized copy-only intake, independent loaded reads
and red/green execution registered `session-stopped-quantized-audio` and
`session-stopped-quantized-midi`. Both pass unchanged on Live 11.3.43, including
exact source/context/coverage checks and terminal cleanup. Preserve the
existing `session-clip-identify` as a separate unchanged regression. Controlled
runner failures are lower-layer regression evidence, not the packaged product
red receipts required before changing launch support.

Session-audio fixtures declare a bounded `sources` array: each entry has `id`,
`trackName`, `clipName`, `sceneIndex`, and an exact declared `mediaTarget`.
Baseline evidence retains each source's actual media path/hash, runtime clip and
track identities, listener, and observed facts separately. Capture steps name
their `sourceId`; the `capture` assertion independently names the same expected
source. Never copy a primary source's media hash onto another context.

MIDI entries use the same `id`, `trackName`, `clipName`, and `sceneIndex`, plus
an exact `trackIndex`, `listenerBindingSlot`, and
`midi: { notesSha256, instrumentChainSha256 }`, **instead of** `mediaTarget`.
Declare the expected hashes from reviewed note/instrument specifications before
running; never promote the first observed baseline to an expectation. The shared
`midiContentIdentity` helper validates complete protocol evidence before hashing.
It sorts note tuples without deduplication, preserving pitch, beat position,
duration, velocity and mute. Device/parameter order, indices, names, classes,
enabled state, ranges, and exposed values are retained; session-specific UUIDs,
query IDs and paging metadata are not hash inputs.

Only the exact verified enabled listener slot can exclude its known runtime
`Attack rise dB` / `Attack gap ms` values and normalized values. Their indices,
names and parameter metadata remain hashed; other listener parameter values
remain protected. Identically named parameters on instruments are never excluded.
The driver requires the listener's reviewed slot to match the snapshot and
complete preflight device inventory. Producer UUIDs must match exactly. Decimal
native Max IDs are not Remote Script UUIDs: their binding instead requires the
reviewed saved slot and exactly one same-name `MxDeviceAudioEffect` on that
track, at the pinned index. Unknown IDs, ambiguous duplicates and mismatched
UUIDs are rejected. A name match alone is insufficient.
Set topology and the listener connection/instance identity remain independently
protected. The chain hash is **not** a frozen plug-in state or a sound identity.

MIDI baseline evidence retains full bounded preflight and listener placement,
with `midiNotesSha256` / `instrumentChainSha256` in the source identity; it has no
audio path or fake `mediaSha256`. Capture and persisted-context source selection
must match the admitted kind, track, clip, slot and listener. For a combined
fixture, omit the audio-only `clipWarped` baseline fact; admission still requires
warped audio for audio declarations and MIDI for MIDI declarations. The original
audio manifests and `session-clip-identify` retain their existing contract.

### Same-process continuity schedule

`session-listening-continuity` uses the user-saved two-track derivative of the
original fixture, preserving the original Set/media. The user auditioned and
approved both assets and the revised spectral ranges: A 50-3,000 Hz, B
6,000-22,000 Hz (original A minimum and revision history below).
A is the original kick; B is original procedural hi-hat-like
audio. The oracle stays outside the staged project.

The frozen schedule has **six captures A/A/A/A/B/A**, six identification
follow-ups with no new capture, and five explicit stop/seek turns: 17 messages.
Each capture covers one four-beat loop at 128 BPM, independently requiring
90,000 frames at the reviewed 48-kHz host rate and all three metric families.
Transitions explicitly stop only the previous source track without quantization,
stop transport, and seek to zero. Read-only preconditions require both sources
stopped/unqueued and recording off before the next capture; the driver never
repairs them. Both source-read brackets must agree on stopped beat zero, known
false playing/triggered/recording flags, `firedSlotIndex: -1`, and a Live-supported
inactive `playingSlotIndex` of either `-2` or `-1`. Unknown flags, queued slots,
and inconsistent brackets fail closed. Scoped approvals permit each declared action once per listed step
and enforce the total use budget.

Desktop, Live, the loaded listeners/connections, and the conversation remain
unchanged. This scenario deliberately omits `persistence`: there is no collection
restart. Every turn re-reads protected source settings, media, Set structure and
unrelated playback; prior context identities/hashes remain intact. Query IDs are
retained with turn facts and typed History evidence. Native cleanup records must
match the actual generation, epoch, connection and pass, not just listener name.
The original identification scenario separately retains its fresh-process and
persistence-only restart scope. Neither registry validation nor fixture authoring
is a passing physical run; require terminal receipts and owned cleanup.

#### First continuity attempt: red oracle, not continuity qualification

On 2026-11-03 (UTC), `run-5VpmX3` admitted both independently hashed sources and
the candidate-supplied listeners on Live Suite **11.3.43**. Only `listen-1`
executed; the other 16 messages remain unrun. The first capture passed source,
90,000-frame coverage, all three metric families, native identity, context and
release checks, but its energy-weighted centroid **95.08665294248082 Hz** failed
the frozen A minimum of **100 Hz**. The runner stopped without retries,
restarts, repairs, or changes to the musical oracle. Terminal owned cleanup
succeeded. Receipt:
`.test-artifacts/acceptance/run-5VpmX3/receipt.json`
(SHA-256 `84892cc82d1ef0455c004904928c1195fb6b1a6a0789334759cd2860a5a8c124`).

Diagnosis: the authoring reference reported a **magnitude-weighted** centroid
of 691 Hz for A, but the acceptance assertion measures **energy-weighted**
centroid. An independent post-failure PCM analysis using stereo pooled power,
2048-point periodic Hann FFT, 2048-sample hop and four predetermined phases
gives A **84.39-90.99 Hz** and B **16,823-16,920 Hz**. These unwarped-file
diagnostics explain why the proposed minimum was unsuitable; they do not prove
exact warped Live DSP output or qualify subsequent passes. Diagnostic report:
`.test-artifacts/fixture-authoring/independent-energy-reference.json`.
No runtime/native defect is established by this threshold failure.

The user subsequently approved correcting A to **50-3,000 Hz**. The registered
case now uses that reviewed range; B, all 17 turns, permissions, deadlines and
other assertions are unchanged. The original failed receipt remains immutable.
Qualification requires a fresh full-schedule run, not skipping the failed
assertion or continuing the original conversation. Attended cross-app continuity
UX is separate and remains unqualified.

The original `session-clip-identify` passed all eight assertions in fresh owned
processes on the same candidate, including no recapture, typed contexts after
the explicit persistence restart, and terminal cleanup:
`.test-artifacts/acceptance/run-YaPYyO/receipt.json`
(SHA-256 `8a0a06d292b60feb325397f4229bf1237c7c1dbf90d4a05707d5850bfe93edcc`).
Both runs used app archive SHA-256
`286f16e9df27fdc71c45090cf2c4331320aac2b8c90102427697a8561e58ff63`;
active frozen-device hashes are respectively
`1ea35d3d789fdf41b7c40f782704e98df3e1276103acec003eb65b99780d5ac3` and
`3ccfbb566a7b29994ce62de093c3afc923095a4b1adc442aa0b8c25ebaed9cec`.
The app-directory packaging target succeeded; DMG/ZIP packaging separately
failed in electron-builder updater metadata (`null.provider`). No distribution
success or same-process repetition success follows from the original case.

#### Final bounded qualification

On 2026-11-03 the user accepted the passing reviewed schedule as sufficient for
#78 and requested a merge-ready PR. Investigation of the earlier intermittent
native failure and additional attended visual qualification are deferred
follow-ups, not additional acceptance gates for this bounded scope. Their
unresolved status and unsuccessful attempts remain recorded below.

The reviewed revised contract **passed all 60 assertions** on Live Suite
**11.3.43** in `run-QSnsCe` (2026-11-03 UTC): all 17 messages executed, six fresh
captures in A/A/A/A/B/A order, no unrun turns or hidden captures, six stable
contexts, one App session/Default agent/conversation, unchanged listener
connections, complete native coverage and per-pass release, five verified
stopped-zero transitions, and terminal owned cleanup. A's native epochs were
1/2/3/4/5; B's separate listener had epoch 1. Measured centroids in capture order
were 100.35, 91.24, 100.35, 109.30, 16,882.23, and 95.15 Hz. Identical musical
values do not establish freshness: pass/generation identities and native epochs
are checked separately.

Final receipt: `.test-artifacts/acceptance/run-QSnsCe/receipt.json`, SHA-256
`dc932e96a1de61744f64b9ee820069c2650ee3a80420f860e2950bd61d661a9c`.
The original identification case also passed all eight assertions on the same
final candidate in `.test-artifacts/acceptance/run-1VAnU1/receipt.json`, SHA-256
`6142b428500028b6073c8c9635c072aac83d3ab432f8f21d48e2e6af903c5cfe`.
Both used app archive
`14da7322062d931cc4bcd80d083d9323fd24b29ec35c66aeae8caa2b65aff3b9`
and spectral handoff JS
`ef9ceeb819dc1479be15a27bbd46556151ad100b017689171b9047ea1fce1598`.
Continuity's active frozen-device hash is
`64e3684edb0a89747a18ffc7444e32612f733bd20100e0f5fdacc89cf2293dea`;
the original case's separately configured device hash is
`7699d812440af7f91fb822300b7f0a7700ab5e3850f59c7aa8f18827f9781c6f`.

All intervening attempts remain failed, not rewritten as recovered passes:

| Receipt directory | First failure and disposition |
| --- | --- |
| `run-VECZgw` | First capture partial: spectral 36/43 records, `upstream_immutable_slot_changed`; level 16/16 and attacks 19/19. Cleanup confirmed. Added bounded rejection-readback diagnostics, not a bypass of immutable-slot validation. The intermittent native cause remains unresolved. |
| `run-QHbXBo` | Agent stopped transport and sought zero but omitted the requested track clip-stop. The independent transition assertion failed. Added scoped tool guidance distinguishing Session selection from transport state; no scenario prompt or permission changes. Cleanup confirmed. |
| `run-Z5awFn` | All 17 turns passed their assertions, but collection exceeded the single-case 10,000-event aggregate limit. Cleanup also reported that evidence failure, although owned PIDs were subsequently confirmed absent. Not a qualification pass. |
| `run-gcP1xA` | Additional diagnostic attempt failed during launch: Live never exposed Remote Script port 8765. No turns or captures executed; cleanup confirmed. This does not reproduce or resolve the retained-slot fault. |

History collection now retains up to 10,000 records **per trace**, permits an
aggregate count of 10,000 per declared turn (at most 32 turns), and keeps the
unchanged **32 MiB aggregate byte ceiling**. It deduplicates by event ID without
dropping required traces. Successful collection is not redundantly repeated
during cleanup; failed collection still attempts bounded diagnostic retrieval.
The final continuity receipt retains 10,807 typed History events. Count/byte
overflow, redaction, complete multi-turn retention and owned shutdown have
controlled regressions; no deadline, completeness or source guard was loosened.
These are runner evidence limits, not application storage-layout changes.

Separate attended UX attempt `.test-artifacts/desktop-ux/issue-78-stop/receipt.json`
was **blocked before message submission**: the scratch observer checked
automation discovery before its descriptor was published. It is not a product
capture failure or visual pass. Desktop/profile cleanup and the exact owned Live
PID's termination are recorded in the sibling `cleanup.json`. This bounded
automation qualification does not resolve that separate visual coverage gap,
the intermittent native fault, or historical unrestricted repeat reliability.

The observer now waits boundedly for descriptor publication and checks its exact
Desktop PID, but the fresh `issue-78-stop-02` attempt was also **blocked before
submission**. Computer-use exposed Live's recovery prompt for the earlier
disposable `Untitled` Set; Desktop visibly reported connection refused, no Live
Set, and waiting for snapshot. Approval to decline recovery was requested but
not received, so recovery data was left untouched. Desktop was closed through
its UI; the scratch observer's cleanup then encountered Playwright's disposed
process handle. The UX host's stop signal did not cancel its readiness wait,
so only the independently recorded owned Live PID was terminated. Host and
Desktop cleanup errors remain failures, with supplemental evidence in
`.test-artifacts/desktop-ux/issue-78-stop-02/cleanup.json`: all three exact
owned PIDs were subsequently absent and the isolated profile was removed.
Neither this blocked inspection nor the earlier passing automation run closes
the native-cause or attended-workflow coverage gaps.

## Current-candidate listener binding

Machine-listening fixtures must declare `listenerBindings`, identifying each
saved instance by its exact slot, original saved `sourcePath`,
`dependency: "machine-listening"`, and zero-based `trackIndex`/`deviceIndex`.
For example, a slot can be
`AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0`.
Saved XML IDs are not track/device indexes. Only top-level Audio/MIDI track
slots are supported; rack, return and Master placement is rejected, not inferred.
Missing, duplicated, stale and additional known listener references block
preparation. Unrelated devices are not replaced.

For an exactly reviewed listener slot, the original reference may have
`RelativePathType=3` (project-local) or `6` (User Library). This does **not**
authorize opening, following, or copying the external User Library reference:
the immutable input Set hash, saved slot, source path and placement remain
pinned. Replacement always writes `RelativePathType=3` and the declared frozen
candidate's project-local relative and owned absolute paths. Other reference
types remain rejected; this is candidate rebinding, not a musical source repair.

Provisioning preserves the immutable `project.als` and portable candidate files.
After generating isolated-profile discovery configuration, it freezes a separate
complete device at `dependencies/machine-listening/frozen/<device>.amxd`, using
the same freezer as installation. It derives `prepared.als` by changing only the
declared listener reference paths and their project-local reference type. Saved musical/device settings and media are
not repaired. The dependency inventory records `frozenDevices` and
`preparedProject` identities; admission independently reconstructs both from
verified sources. Rehashing a modified Set or embedded runtime cannot admit it.

For the supplied #81 Set, the first authoring inspection stopped during
provisioning on the MIDI listener's User Library reference, before any host
launched. Its setup-failure receipt is retained at
`.test-artifacts/issue-81-fixture-intake/physical-inspection/inspection.json`.
The parent added a failing-before binding regression and is retrying on the
fresh `physical-inspection-2` copy. This records a setup correction, not a
packaged listening red, a successful inspection, or physical launch proof.

The driver opens only that derived Set, waits for the owned Remote Script before
starting Desktop, then waits for Desktop/service readiness. Before messaging, it
checks listener count and declared placement, and verifies the actual Node for
Max extraction files against the frozen candidate. This macOS check uses the
owned Live PID/start time, descendant Node processes, exact cwd and bounded
no-follow file reads, then rechecks process identities. The receipt records
`activeCandidateVerified`, `activeNodePids` and `activeFrozenSha256`. Producer
numeric Max IDs are not equated with application snapshot UUIDs.

These checks use the existing traced provision, fixture-admission, launch,
readiness and preconditions lifecycle, and failure/cancellation/cleanup paths. Frozen and
derived project files join the bounded preservation inventory; credential
profiles do not. No raw renderer filesystem query or upload path is added.

Active undeclared preset/media references still block admission. `SourceContext`
and `LastPresetRef` are saved provenance, excluded from execution dependency
checks but visible in intake reports. Active SampleRef/IR files are not history.
The fixture's bounded `builtinResources` inventory declares exact paths, sizes
and SHA-256 hashes under the selected Live application's `Contents/App-Resources/Builtin`.
Provisioning rejects missing, changed or symlinked resources and records
`builtinResourcesSha256`; those licensed files are never copied into Git or
preserved run artifacts. This keeps the approved original processing without
silently accepting arbitrary external references. Loading-only evidence does not qualify listening,
classification, persistence or the Collect All and Save interaction.

## Evidence and approval boundaries

The packaged adapter reads public typed `eventHistory.trace` evidence and
preserves bounded, redacted `product-evidence.json`. A completed listening-job
lifecycle alone does not establish capture/source cleanup: require its separately
journaled cleanup evidence. Keep these reads independent of model output; do not
replace missing records with inferred success.
The narrow source read is `DesktopApi.ableton.inspectSessionListeningSource`,
using existing `InspectSessionListeningSourceParams` and result types. It calls
the existing read-only bridge `listening.inspect_session_source`; `queryId`
carries trace/correlation through the existing lifecycle. This is not a new
mutation command, automatic repair, or proof of native readiness.
Global recording preflight separately reads `window.desktop.ableton.inspectRecording()`
through the existing `recording.inspect` capability. Require both
`state.arrangementRecord === false` and `state.sessionRecord === false`, in
addition to target recording being off. Missing or malformed recording evidence
rejects admission; never substitute false or infer global state from
`targetRecording`. This read reuses existing schemas and bridge lifecycle.
The compound `window.desktop.ableton.inspectSessionListeningPreflight(params)`
returns the strict audio `{ source, audio, recording }` or MIDI
`{ source, midi, recording, instrumentChain }` union using existing typed reads.
Actual Live audio file path, sample rate, and sample length
come from `audio_clips.inspect`, not fixture metadata. `audio.sampleRate` is the
loaded media rate, **not** the host capture/audio-engine rate; independently
establish the latter for capture-coverage expectations. The driver verifies the
actual loaded path against staged media and hashes that admitted file rather
than assigning the expected fixture hash. The response type is
`DesktopSessionListeningPreflight` in `apps/desktop/src/contracts.ts`.
Source reference/name mismatches reject; null path or sample rate must fail
closed in the driver.
For Live 11's unavailable public follow-action property, the driver independently
reads the explicit flag from the exact saved Session slot in the verified
prepared Set. The saved path must match its kind: `AudioTrack` / `AudioClip` or
`MidiTrack` / `MidiClip`; a mismatched kind is not interchangeable evidence.
Parent-owned Audio/MIDI regressions cover explicit true/false flags and
missing/malformed evidence, with the original MIDI failure retained.
It records `followActionEvidence` with the Set hash, never defaults
unknown to false, and rejects enabled, missing or ambiguous flags. Other source
properties still use the live preflight. This is initial-state evidence, not a
claim of continuously monitoring an unavailable property.
The persistence restart checks the restored Default agent/conversation and typed
stored context, not another live capture. Native v5 intentionally invalidates on
disconnect and requires device reload (see
`max-patches/audio-listener/COMMISSIONING.md`), so post-restart persistence does not
wait for listener reconnection or reload the device. Initial listener admission
remains mandatory. Passing this case does not qualify capture after an app restart.
These three sequential reads share `queryId` correlation but are **not an atomic
snapshot**. Individual source/recording APIs remain available; none of these
reads injects the expected media hash or creates a new mutation command.

Unattended approval matching requires structured `ApprovalRequest.tool` with
`argumentsComplete === true` and exact tool name/action/arguments, plus complete
agent/session ownership. Never match permission from display prose. Main bounds
and sanitizes arguments (16 KiB total, 2,048 characters/value, 128 fields/items,
depth eight), omits binary/audio, and marks arguments incomplete whenever the
sanitized value differs. Missing/incomplete arguments or attribution fail
closed. `approval.requested` carries agent/SDK ownership and an application
session ID when attributable; absence does not authorize inference. These
surfaces do not broaden approval policy.
Scenario permission declarations require `tool`, `action`, `risk` (`low` or
`medium`), `maxUses` (1–16), and scalar `arguments`. Dotted argument leaf keys may
bind only `$source.trackId`, `$source.clipId`, `$source.slotIndex`, and
`$source.listenerId` from the step's independently observed source;
unresolved/unknown references fail closed. Optional `stepIds` limits a rule to
those named turns, at most once per turn as well as within `maxUses`. There
is no wildcard expansion. The adapter must enforce complete exact actual
arguments with no extras, actual metadata/risk, ownership and pending operation,
and consume the declared usage budget. Declarations cannot override high,
destructive, or unknown runtime metadata.

Review the mutation oracle's actual extent. `session-structure` hashes public
snapshot track/clip/device identities and exposed mixer/routing fields, with
scenes/Arrangement/cues when present; it does not enumerate every plug-in/device
parameter. `source-settings` hashes exact source launch settings plus
recording and either audio file identity/settings or canonical complete MIDI
notes and exposed instrument-chain state from the typed source read.
The registry checks
explicitly named, observed scopes. Additional protected parameters require
additional independent evidence, not an “all state unchanged” claim.

Use the skill's [contract checklist and exact first-case example](../../.github/skills/author-integration-test/references/test-contract.md)
to agree turns, initial conditions, actions, mutation scope, evidence, and
cleanup. Generate from the repository's current schemas/templates, then list,
validate, and run through the common path. Missing assertions or evidence
providers require reviewed reusable extensions and regression tests, not a
private scenario runner or a weaker oracle.

## Authoring versus execution

For an approved MIDI intake, `PackagedAcceptanceDriver.reviewMidiSources`
provides the separate read-only loaded review without invented expected
instrument hashes. It uses the same owned processes, candidate binding and
typed preflight as execution, submits no message, requires stopped transport,
and returns observations for review. It does not qualify a scenario or weaken
`readBaseline`'s execution-time comparison with independently frozen expectations.

Bounded recursive instrument trees have a separate aggregate 4 MiB allowance
in baseline evidence and the final receipt. Only the actual tree bytes receive
this allowance; ordinary evidence, turn history and combined non-tree report
limits remain unchanged. Oversized trees fail before submission rather than
being truncated or represented by an unverifiable fingerprint alone.

Authoring can prepare the owned copy as agreed and freeze reviewed assets.
Execution only verifies the frozen baseline; it must not regenerate assets,
seek transport, change quantization, repair sources, or revise expectations to
make a case pass.

A correctly admitted scenario that violates its reviewed product contract is a
**valid red test**. Invalid references, missing or changed resources, unsupported
drivers, absent credentials/dependencies, and failed admission are **invalid or
blocked test setup**, not product correctness evidence. Incomplete evidence,
cleanup failures, and receipt persistence failures cannot be clean success.
Preserve the first failure. Changing the oracle after a result requires renewed
human review, not tuning to match the output.

### Supplied Drum Rack: reproduction status and environment gap

The registered `session-drum-rack-listening` case uses the user's unchanged Set
and exact `listen to clip-1` prompt. Owned review
`drum-rack-review-BWtxSz` on Live 11.3.43 confirmed 42 devices / 1,244 parameters,
the four-beat MIDI content, One Bar quantization and saved nonzero stopped
position before any agent capture.

`run-quAx7U` was blocked before submission by the old 512 KiB baseline report
cap: complete evidence was 681,620 bytes, including 669,410 bytes of bracketed
instrument trees. That was a harness capacity error, not the reported spectrum
failure. The separate bounded tree allowance preserves the complete evidence.

`run-6JQUIX` executed one real Default-agent turn and completed all metrics:
level 16/16, spectrum 43/43, attacks 19/19, 90,000 frames, no gaps, readable
context and confirmed cleanup. Its final restart-context assertion failed
because the scenario omitted the `persistence` capability, so no restart was
requested. The manifest is corrected and offline validation now rejects this
misconfiguration. This run is neither a spectrum reproduction nor a clean
whole-scenario pass.

After correcting that capability, `run-97pAoc` passed all five assertions,
including the real owned restart, unchanged scopes and terminal cleanup. It
again used the unchanged spectrum implementation and a shorter post-arm
inspection (3,295.4 ms). This qualifies the fresh-copy contract only; it does not
resolve the historical failure.

The historical first failure and this successful capture used identical
non-identity listener configurations except for stopped beat (0 versus
37.36462209665335). The installed reader, native I/O, metric controller,
spectrum collector and runtime JavaScript match the candidate byte-for-byte.
The rebuilt codec differs in the new inspection schemas, not capture logic.
Disk identity does not retroactively prove which companions Max had loaded
in the historical process.

| Observed interval | Historical first failure | Fresh-process successful capture |
| --- | ---: | ---: |
| Spectrum phase binding | 206 ms | 101 ms |
| Post-arm source reinspection | 5,649.8 ms | 3,380.7 ms |
| Session launch command | 1,259.2 ms | 916.5 ms |

Both agents used the same listening operation and repeated `get-pass` reads.
The slower historical interval includes longer real bridge requests and queue
waits, including one additional background identity query. Its failure
diagnostic proves retention overflow: 178 produced records, 146 forwarded,
capacity 32, fault 1, with no source-window spectral records accepted. The
second historical pass instead reports invalid DSP control, not just overflow.

The fresh-process test currently verifies musical state and results, not
equivalent scheduler timing, backlog, or request/acknowledgement interleavings.
Successful runs do not retain the same detailed reader counters as failures.
Shorter prelaunch exposure is a concrete candidate explanation, not a proven
causal reproduction; neither repeated green runs nor a larger ring establishes
the missing guarantee. A production-timing replay and bounded reader-state
evidence are needed before claiming the original native defect fixed.

For a bounded timing-only diagnostic, the same registered case accepts
`--bridge-read-min-ms 550`. An owned loopback proxy forwards the real Live
protocol bytes unchanged and imposes a minimum request-to-response duration
only on source/pass/context/identity inspection reads. It does not synthesize
responses, alter capture configuration, stress the CPU, or change the prompt,
permissions or oracle. Authentication and mutation requests are not selected
for pacing; downstream frame ordering is preserved.

The option is explicit, limited to 1-1,000 ms and recorded as a diagnostic in
the checkpoint, terminal receipt and CLI output. Bounded timing/lifecycle
records are retained in `product-evidence.json` without arguments, tokens or
response bodies. Proxy faults invalidate the run; cleanup closes its owned
sockets and timers as well as the applications. A timed result qualifies only
that recorded condition, not ordinary execution or arbitrary scheduler load.

Timing diagnostic evidence:

- `run-3sPqTz` passed the musical assertions but did **not** exercise pacing:
  the proxy recorded zero tunnels/requests. The initial adapter supplied a
  CLI-only environment variable, while Desktop reads its bridge port from
  preferences. Preserve this receipt as an invalid timing experiment, not
  evidence against a scheduling defect. The adapter now seeds only its owned
  profile through the shared storage resolver and refuses submission without
  a completed paced read.
- Corrected `run-MmE4iY` on Live 11.3.43 recorded 50 paced reads, delivered
  roundtrips 550.29-604.99 ms, and a 5.271-second post-arm inspection interval
  (versus 3.30-3.38 seconds unpaced and 5.650 seconds in the historical failure).
  All five unchanged assertions passed: complete three-metric capture over
  90,000 samples, exactly one pass, retained context including owned restart,
  and preserved source scopes. Proxy sockets, pending frames and pending bytes
  were all zero after confirmed cleanup.
- These runs used candidate `app.asar`
  `7e1cbd38cbbf590f03a9eea25fe7a42a1e21b2c5e3665b8473ee18a57434ecf8`;
  no spectrum fix was applied. All installed/candidate native DSP `.gendsp`
  and `.maxpat` files match byte-for-byte; the canonical denoised top-level
  AMXD graphs also match. This is disk evidence, not retrospective proof of
  what the historical Max process had loaded.

Pacing alone at this measured setting did not reproduce the native failure.
It delays real responses without reproducing Max scheduler starvation or stale
instance state, so neither is ruled out. The intended retained queue activates
at arm, while the DSP clock can run from Set opening. No direct idle queue
observation was captured in the historical instance: opening-time accumulation
or startup/reset state must not be dismissed solely from intended code.

Final-source rebuild status: workspace build, full typechecks and the 1,181-test
owning sweep passed. Rebuilt candidate `app.asar`
`3d58c6baecf356eabfebee47babfed728017dffcc27d634d5328bf440842b340`
then hit a pre-submission Desktop `firstWindow` timeout in `run-kpxm8W`.
Its terminal cleanup verdict is failed and remains failed; subsequent process
inspection found neither its recorded Live PID nor its candidate Desktop
process running, and its isolated profile had been removed. No listening
message was submitted. The owning packaged-only launch diagnostic passed on
that same binary, without Live or a listening message; it does not requalify
the failed acceptance run. The related stopped-quantized MIDI case was not
executed because the selected sequence stopped at this failure. Earlier
successful captures remain evidence for their recorded candidate, not a
red-to-green fix or qualification of this final-source rebuild.

### Demonstrated native mechanisms and controlled real red/green

The next investigation separated bridge response latency from **Max's own
descriptor polling cadence**. The former had not reproduced failure. The latter
did: with an explicitly diagnostic 30 ms spectrum timer, the unchanged
`session-drum-rack-listening` scenario failed in `run-EeD9MI`. Its actual Max
readbacks progressed from backlog 0 to 12 to 22 to 32 and fault 1 during
post-arm inspection, before playback. The agent obtained a partial result;
acceptance rejected it and confirmed cleanup. No response, audio, model turn,
metric expectation or permission was mocked or changed.

Two separate real counter-bookended reads now execute within each spectrum
timer callback, rather than requiring another low-priority timer turn to settle
one descriptor. The same 30 ms condition passed in `run-c0ybSQ`: all three
metrics complete, 90,000 samples, exactly one pass, original context after
restart, unchanged scopes, and terminal cleanup. Sampled backlog remained 1.
This is a controlled reproduction of the historical overflow mechanism, not
proof that the historical process had an exact 30 ms cadence. Production's
10 ms timer is restored; only the paired real acquisitions remain.

The paired runs used identical controller and reader bytes:

| Resource | SHA256 |
| --- | --- |
| Controller | `e853eed41888366c89689347b57113c962ee91c135b0994aa24b8465daf61d48` |
| Reader | `a4a33aef64281e35b44a193738261d17f928c93438fd773d84e71ebde13f4f82` |
| Red analysis graph | `ba16858d0a097700e061b05410e454ba9634fa504227e93cc7f8de33fd36d1c2` |
| Green analysis graph | `8a9c277374191c0e42773d425c0f796d6d4fb731afc9e59d0376337ee4481bfd` |

The reader pin includes an independently demonstrated ACK-ordering fix. Before
that fix, the reader could consume a settled next slot while the prior ACK was
still unapplied in DSP, then issue an ACK that skipped the last executed value.
The actual generated Gen program rejects that sequence with fault 2. The reader
now waits for executed ACK readback, retaining immutable-slot, cancellation and
sequence guards. This matches a possible mechanism for the historical second
failure; the historical rejected request/ACK tuple was not retained, so exact
retrospective attribution remains unavailable.

The automatic coverage gap was execution-condition coverage: ordinary
fresh-process scenarios exercised the real Default agent and real Max at a
healthy cadence, but did not deliberately exercise delayed native settlement.
Their completeness oracle was correct. The new source fixture and a
production-graph-linked six-second/30 ms controller regression retain the
coverage; the physical adverse-condition receipts preserve the real-host proof.
The ordinary fresh-process fixture alone is not a deterministic reproduction of
scheduler jitter. The temporary 30 ms device-build variant is diagnostic and is
not the production default or a separate registered scenario.

Native lifecycle evidence now includes bounded success-path retention counters
once per second and the immediate rejected row on failure. `run-VKcIuz` observed
an initial zero-owner/zero-backlog row and then fresh epoch-one production,
despite the Set already having been open: opening-time accumulation was not
carried into that first capture.

Keychain qualification is separate. `run-7Tr4X5` also failed before submission;
the existing packaged OS-vault diagnostic isolated its main-thread block to
`SecKeychainFindGenericPassword`/SecurityServer decryption. Its owned process was
terminated by the existing cleanup policy. No OS authorization or mock keychain
was supplied. The later listening replays used the existing, real Remote Script
token through the supported environment credential source, never persisted in
receipts. They prove authenticated listening, not successful vault startup.

Final production-cadence validation on Live 11.3.43:

| Scenario | Receipt | Result |
| --- | --- | --- |
| `session-drum-rack-listening` | `run-Amnyfh` | Five assertions passed; one complete three-metric capture, 90,000 samples, original context after owned restart, unchanged scopes and cleanup. |
| `session-stopped-quantized-midi` | `run-YcdEAB` | Four assertions passed; one complete three-metric capture, 90,000 samples, retained context, unchanged scopes and cleanup. |

Both used packaged analysis graph
`b5aaf07307836f8c721d45b586545fe72aaaa75bb41d11061aecf012de5eb075`
with the restored `qmetro 10 @active 0`, controller/reader pins above, and
`app.asar` `3d58c6baecf356eabfebee47babfed728017dffcc27d634d5328bf440842b340`.
The full native owning suite passed 731 tests after restoration; the acceptance,
protocol, application and integration owning sweep passed 1,181 tests, with full
workspace typechecks/build and changed-code lint. The user's installed
application/listener was not replaced by these candidates.

The retention contract keeps successful and failed allowlisted project
resources: declared fixture resources, `prepared.als` when listener bindings are
declared, and the driver's explicit dependency
preservation paths under `dependencies/<declared-dependency>/`, not arbitrary
working files. Failed preparation output is retained for diagnosis, not treated
as admitted or verified merely because it was preserved.
Nested signed FluCoMa resources are retained only at the exact pinned
`dependencies/machine-listening/frozen/dependencies/flucoma/` file paths.
The shared pin inventory admits their `~` and `_CodeSignature` names without
relaxing ordinary dependency-name guards or allowing arbitrary nested bundles.
Retention preserves diagnostic bytes even after a failed run; it does not
re-admit their contents. Linked files/parents and unknown paths still fail before
any pruning, and primary capture failure/cancellation remains independent.
The driver must remove its isolated credential-bearing profile;
never archive it. Require a durable checkpoint before pruning, confirmed cleanup
before pruning/deletion, and a
durable final receipt before successful exit. Cleanup failure leaves working
files in place for recovery; final persistence failure preserves the checkpoint
and run evidence and reports their paths. Retained directory/byte limits reject
new admission rather than automatically deleting old evidence.

The CLI uses the existing `.test-artifacts/acceptance/` tooling location, not a
second application-profile layout. Admission limits are 16 immediate entries,
8,192 recursive entries, and 2 GiB with a 256 MiB reservation for a new run.
Working-tree retention is bounded to 256 MiB, 8,192 inventory entries, and 256
allowlisted paths. An atomic admission lock protects concurrent allocations;
inspect a stale lock and retained evidence before any manual cleanup. There is
no automatic expiry or deletion of unrelated evidence. These limits gate
admission/preservation; they do not
authorize destructive enforcement while cleanup is unsettled. A residual
isolated profile blocks pruning.

Cancellation is not proof that all resource acquisition has stopped. If owned
setup remains in flight after the bounded cleanup grace, report incomplete
cleanup and deferred recovery; reclaim late-owned resources without rewriting
the earlier failed/cancelled receipt into success. Evidence that loses required
fields or is truncated by bounds cannot silently satisfy typed assertions.
Late cleanup lifecycle diagnostics use bounded, redacted
`acceptance-late-lifecycle` stdout records with `receiptUnchanged: true`, including
after finalization; they are not a replacement receipt or permission to prune.
The CLI caps them at 64 records of 16 KiB each, followed by one truncation
marker. Diagnostic sink failures must not reject late resource cleanup.

The TDD loop is review → persist → validate → run → diagnose at the owning lower
boundary → fix → rerun the same checks. Already-working behavior can pass first
time. No second model grades correctness, and `(B)` alone never proves the first
listening case.

## Stage boundary and separate suites

The first fixture has completed joint contract review and registration, with
the user's existing Set and original reference audio in Git. Its names and
128-BPM processing were approved on 2026-11-02. Real packaged listening acceptance
and fresh-run isolation require actual terminal receipts; registration alone
does not qualify them.

The existing `pnpm live:agent-smoke` runtime/CLI catalog is separate and is not
migrated by this work. Its passes do not qualify the new packaged driver.
`integration-testing` runs and diagnoses deterministic scenarios;
`desktop-ux-testing` validates visible cross-app behavior. A reusable real UI
acceptance driver is deferred; controlled alternate-driver tests prove contract
reuse only, not delivered UI/CLI acceptance adapters.
