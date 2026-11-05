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
identify the same shared SpectralShape binary for both cases; they do not imply
a second analyzer or flatness-only loading proof.

This is a delivery/completion contract, not numerical qualification. The existing
90000-sample/48-kHz native capture assertion is not a spread FFT frame oracle.
The contract does not add custom spectra, an identification turn, exact spread
delivery counts, or silence validity. Real-host execution requires separate
approval; registration is not a successful run.

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
contrary to the independent completed-capture/context evidence. Preserve this
response/status discrepancy as a separate follow-up; the approved smoke oracle
does not grade assistant status prose. The run used the real installed bridge
credential through the supported environment source, so no successful Keychain
startup is claimed.

Named assertions come from the shared registry: `choice`, `capture`,
`capture-count`, `context`, `native-freshness`, `spectral-range`, `flatness-smoke`, `spread-smoke`, `no-capture`,
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
