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
- Writes a bounded redacted inventory/report beside the copy and emits traced
  intake lifecycle events. Failed or cancelled partial copies remain for review.
- Does not launch Live, check musical correctness, infer device companions,
  repair settings, or register a test. `copied-for-review` is not qualification.

Registered fixtures support neutral `resource-NNN.wav`/AIFF filenames under
`media/` or Live's `Samples/` directory hierarchy, including `Samples/Imported/`.
Staging preserves those references and retains the same ownership/hash guards.

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

The catalog/CLI implementation and
[packaged Desktop adapter](../../tests/electron/acceptance-driver.ts) exist.
The first reviewed fixture and `session-clip-identify` scenario are registered.
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
catalog contains `session-clip-identify`. Neither listing nor offline validation
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

Named assertions come from the shared registry: `choice`, `capture`,
`capture-count`, `context`, `no-capture`, `unchanged`, and `fact-equals`. The
template illustrates their actual parameter shapes; consult
[`ScenarioManifest` and `FixtureManifest`](../../packages/test-support/src/integration/contracts.ts)
and the registry validators when generating definitions. Do not invent JSON
fields, silently drop a required check, or turn a missing read into an
assistant-prose assertion.
The generic fixture baseline is a declared scalar fact map, not an obligatory
listening baseline. Audio source/listener/path evidence and the supported audio
baseline belong to the Desktop audio driver and audio assertions; non-listening
cases need not invent them. Strict manifest and built-in assertion validators
reject unknown fields, so consult the current schemas instead of guessing.

## Current-candidate listener binding

Machine-listening fixtures must declare `listenerBindings`, identifying each
saved instance by its exact slot, original project-relative `sourcePath`,
`dependency: "machine-listening"`, and zero-based `trackIndex`/`deviceIndex`.
For example, a slot can be
`AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0`.
Saved XML IDs are not track/device indexes. Only top-level Audio/MIDI track
slots are supported; rack, return and Master placement is rejected, not inferred.
Missing, duplicated, stale and additional known listener references block
preparation. Unrelated devices are not replaced.

Provisioning preserves the immutable `project.als` and portable candidate files.
After generating isolated-profile discovery configuration, it freezes a separate
complete device at `dependencies/machine-listening/frozen/<device>.amxd`, using
the same freezer as installation. It derives `prepared.als` by changing only the
declared listener reference paths. Saved musical/device settings and media are
not repaired. The dependency inventory records `frozenDevices` and
`preparedProject` identities; admission independently reconstructs both from
verified sources. Rehashing a modified Set or embedded runtime cannot admit it.

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
returns `{ source, audio, recording }` using the existing source, audio inspection,
and recording reads. Actual Live audio file path, sample rate, and sample length
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
prepared Set. It records `followActionEvidence` with the Set hash, never defaults
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
bind only `$source.trackId`, `$source.clipId`, and `$source.slotIndex` from the
independently observed source; unresolved/unknown references fail closed. There
is no wildcard expansion. The adapter must enforce complete exact actual
arguments with no extras, actual metadata/risk, ownership and pending operation,
and consume the declared usage budget. Declarations cannot override high,
destructive, or unknown runtime metadata.

Review the mutation oracle's actual extent. `session-structure` hashes public
snapshot track/clip/device identities and exposed mixer/routing fields, with
scenes/Arrangement/cues when present; it does not enumerate every plug-in/device
parameter. `source-settings` hashes exact source launch/audio settings plus
recording and file identity from the typed source read. The registry checks
explicitly named, observed scopes. Additional protected parameters require
additional independent evidence, not an “all state unchanged” claim.

Use the skill's [contract checklist and exact first-case example](../../.github/skills/author-integration-test/references/test-contract.md)
to agree turns, initial conditions, actions, mutation scope, evidence, and
cleanup. Generate from the repository's current schemas/templates, then list,
validate, and run through the common path. Missing assertions or evidence
providers require reviewed reusable extensions and regression tests, not a
private scenario runner or a weaker oracle.

## Authoring versus execution

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

The retention contract keeps successful and failed allowlisted project
resources: declared fixture resources, `prepared.als` when listener bindings are
declared, and the driver's explicit dependency
preservation paths under `dependencies/<declared-dependency>/`, not arbitrary
working files. Failed preparation output is retained for diagnosis, not treated
as admitted or verified merely because it was preserved.
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
