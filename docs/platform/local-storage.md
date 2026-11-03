# Local Storage Layout

This document is the canonical source of truth for application-owned local
storage. New persistence must follow this layout instead of selecting an
independent Electron, operating-system, repository, or home-directory path.

## Canonical root and profiles

The default root is:

```text
~/.live-agent/
```

Root-owned profile selection and editable System Scope artifacts are stored
outside individual profiles:

```text
~/.live-agent/config/profiles.json
~/.live-agent/system/agents/
~/.live-agent/system/skills/
~/.live-agent/system/artifact-state/{agents,skills}.json
```

`LIVE_AGENT_HOME` may override the root with an absolute path for tests,
portable environments, automation, and recovery. Data is isolated below a
profile:

An explicit `LIVE_AGENT_HOME` is isolated: Desktop does not import legacy
Electron application-data into that root. Automation profiles likewise skip
legacy import. The operator-invoked v1-to-v2 migration remains available for
storage deliberately copied into an isolated root.

```text
~/.live-agent/profiles/{profile}/
```

Profile selection follows these rules:

- packaged applications use `default`;
- development applications use `development`;
- isolated Desktop automation uses its automation-owned root and the
  `automation` profile; and
- `LIVE_AGENT_PROFILE` may select another filesystem-safe profile.

The shared resolver in `@ableton-agent/storage` owns these decisions. Callers
must consume its typed paths rather than reconstructing them.
App-session paths require a `SessionStorageOwnershipContext` containing
`liveSetId`, optional `liveProjectId`, and `sessionId`; a session ID alone is
never sufficient and no flat session-state compatibility path is exposed.

## Required directory structure

```text
~/.live-agent/
├── storage-version.json
└── profiles/
    ├── default/
    │   ├── storage-migration-v2.json
    │   ├── config/
    │   │   └── preferences.json
    │   ├── state/
    │   │   ├── sessions.json
    │   │   ├── live-set-sessions.json
    │   │   ├── live-projects.json
    │   │   └── signal-ingress.json
    │   ├── credentials/
    │   │   ├── {credential-key}
    │   │   └── signal-ingress-secret.json
    │   ├── copilot/
    │   │   ├── {Copilot SDK-owned data}
    │   │   └── tool-output/
    │   │       └── {bounded transient SDK spill files}
    │   ├── observability/
    │   │   ├── agent-set-event-history.sqlite
    │   │   └── agent-set-event-history.sqlite.lock
    │   ├── logs/
    │   │   └── desktop.log
    │   ├── agents/
    │   ├── skills/
    │   ├── artifact-state/
    │   │   ├── agents.json
    │   │   └── skills.json
    │   ├── memory/
    │   ├── project-state/
    │   │   └── {project-id}/
    │   │       ├── project.json
    │   │       ├── memory/
    │   │       ├── agents/
    │   │       ├── skills/
    │   │       ├── artifact-state/
    │   │       │   ├── agents.json
    │   │       │   └── skills.json
    │   │       └── live-set-state/
    │   │           └── {live-set-id}/
    │   │               ├── live-set.json
    │   │               ├── memory/
    │   │               └── session-state/
    │   │                   └── {app-session-id}/
    │   │                       └── {session-owned contents below}
    │   └── unassigned-live-set-state/
    │       └── {live-set-id}/
    │           ├── live-set.json
    │           ├── memory/
    │           └── session-state/
    │               └── {app-session-id}/
    │                   ├── session.json
    │                   ├── memory/
    │                   ├── agents/
    │                   ├── skills/
    │                   ├── artifact-state/
    │                   │   ├── agents.json
    │                   │   └── skills.json
    │                   ├── context/
    │                   │   └── entity-context.sqlite
    │                   └── artifacts/
    │                       └── plan.md
    ├── development/
    │   └── {same profile layout}
    └── automation/
        └── {same profile layout under the automation-owned root}
```

Lock and temporary files created beside an owned file are implementation
details. They must remain within the owning component directory and be cleaned
up or recovered atomically.

## Ownership by directory

| Path | Owner | Contents and rules |
| --- | --- | --- |
| `storage-version.json` | `@ableton-agent/storage` | Root layout version only. It is independent of application-data schema versions. |
| `config/profiles.json` | Profile registry | Versioned visible-profile registry and selected packaged-app profile. Reserved development and automation profiles are hidden. |
| `system/` | Scoped artifact manager | Editable System Scope agent and skill additions, overrides, and tombstones. Bundled resources remain immutable fallback content. |
| `config/` | Desktop/application configuration | Validated, non-secret preferences, including the global Off/Concise/Detailed agent reasoning-summary visibility setting. |
| `state/` | Desktop production-session stores | Validated app-session records, Live Set associations, and the bounded, revision-checked Live Projects registry. |
| `credentials/` | Main process credential providers | OS-backed encrypted credentials, plus the owner-only local producer-authentication key described below. Credentials never enter renderer state, logs, journal payloads, or support bundles. |
| `copilot/` | Copilot SDK adapter | SDK conversation/session data plus transient `tool-output/` spill files. Application code must not invent a parallel transcript store. Spill files are owner-only, age/size-pruned, and are not durable history. GitHub CLI authentication remains externally owned: Desktop may make a validated `gh` executable discoverable to the embedded runtime, but must not copy `~/.copilot` or persist the GitHub token in this directory. |
| `observability/` | Unified local history database | One profile-wide SQLite database for App events, agent history, Live Set history, cross-session queries, traces, retention, and health. Do not create one database per App session. |
| `logs/` | Structured diagnostic logger | Bounded, redacted newline-delimited JSON logs. |
| `memory/` | Reserved ownership scope | Reserved at profile, project, Live Set, and app-session scopes. No memory persistence behavior is defined yet. |
| `project-state/{project-id}/` | Live Project ownership | Project metadata, reserved memory, and child Live Sets. Project association must be explicit; storage never infers it. |
| `project-state/{project-id}/live-set-state/{live-set-id}/` | Project-owned Live Set persistence | Live Set metadata, reserved memory, and nested app sessions. |
| `unassigned-live-set-state/{live-set-id}/` | Unassigned Live Set persistence | Live Sets without a known Live Project, including all migrated legacy sets. |
| `*/session-state/{app-session-id}/` | App-session persistence | Bounded ownership manifest plus session-owned artifacts. `artifacts/plan.md` is the shared planning document for the app session. |
| `*/session-state/{app-session-id}/context/` | Typed entity-context repository | Immutable listening passes and processed observations, independent subject/freshness links, explicit pruning, and bounded quotas. This is not an event-journal database. |

Profile, Project, and app-session `agents/`, `skills/`, and `artifact-state/`
files implement copy-on-write scoped customization. Effective resolution is
Session, then Project when assigned, then Profile, then System, then bundled
fallback. Project artifact resolution requires a typed `liveProjectId`
ownership context. See [Scoped Profiles](scoped-profiles.md).

An active session for an unsaved Live Set may exist only in Desktop memory and
therefore be absent from `state/sessions.json`. Profiles still presents that
session as an in-memory active destination. The first Session-scope artifact
publication or transfer persists the session record and creates its canonical
`unassigned-live-set-state/{live-set-id}/session-state/{app-session-id}/`
directories. Conversation history
alone remains Copilot SDK-owned and does not promote the Desktop session.

## Listening context and producer discovery

`resolveNestedSessionStorage` returns `contextDirectory` and `entityContextPath`
from the required Set/Project/App-session ownership tuple. Store processed,
credential-redacted `audio-observation/v1`, `audio-observation/v2`,
`session-audio-observation/v1` and `metric-audio-observation/v1` payloads
only, with exact entry-kind/payload-version agreement. V2 retains approximate,
descriptive-only quality and unknown absolute timing error in both detail and
bounded summaries; it cannot certify exclusive attribution. Raw audio and
arbitrary JSON are not accepted. Legacy entry limits remain 256 KiB.
Independent metric observations allow the protocol's 2 MiB processed payload
plus at most 16 KiB of UTF-8 JSON entry framing and metadata (entry/ownership
IDs, producer, timestamps, trace and the enclosing `payload` field). Metric
entries therefore have a 2 MiB + 16 KiB serialized ceiling; both the total
entry and its metadata portion are checked after credential sanitation.
Publication admission measures the complete serialized
`{pass, subjects, entries, links}` object, not just observation payloads.
Its ceiling is eight metric entry ceilings plus 1 MiB for bounded
pass/subject/link framing: 17.125 MiB (17,956,864 bytes). Schema count limits do
not grant permission for arbitrarily large metadata: the aggregate byte ceiling
still applies. These quotas allow an atomic eight-listener metric pass without
enlarging unrelated observation-kind protocol limits.

The physical exported SQLite store remains capped at 32 MiB per App session,
including database/index overhead and outstanding pass reservations. A full
eight-listener pass fits a fresh store; existing history can still require
explicit reviewed pruning before reservation or publication. Full-store failure is visible and does not
silently evict observations.
Quota failure/cancellation rolls back the entire publication; releasing the
reservation or closing its owner releases admission capacity. Reopen preserves
immutable exact native records, gaps, musical rows and causal attribution.
Typed inventory queries paginate compact summaries without copying measurement
records/rows. LLM report-page and Desktop IPC result ceilings are unchanged;
storage admission is not permission to send a full large entry through either
boundary.

Session and independent-metric observations add registered kinds without changing
the database format, schema version two, canonical path or historical semantics.
Existing one-, two- and three-kind declarations remain readable; publication
reconciles the four-kind declaration additively through the same registry/manifest
API. Independent metric entries retain indexed native records, explicit gaps,
actual support and reference-only musical rows; their typed compact summaries
do not duplicate full measurement timelines. Partial entries require an honest
partial pass and useful trustworthy requested data, never failed/cancelled
publication or fabricated legacy coverage. Attack records also retain the
bounded stereo peak/RMS input for their independent physical 100 ms detector
windows. These processed features are not raw audio or reconstructed musical
level rows. Retained attack inputs form a validated prefix; missing input ends
that detector's trustworthy coverage rather than inventing later event absence.
Missing musical-level delivery does not invalidate independently retained
detector inputs. Explicit pruning, 32 MiB store retention,
profile/session ownership and redaction remain unchanged. Geometry count limits
do not override byte admission. This stored-kind extension is not authorization
for unnegotiated native capture.

Opt-in wire5 native and metric lifecycle records use the same profile-owned
observability journal and typed redacted History reads. They retain bounded
generation/epoch, stage-parent causation, optional actual stage duration and
explicit metric scope; a metric failure is not stored as a second global
native failure. Exact event-ID deduplication has one wire5 writer, separate
from the legacy lifecycle projection. This adds no database, directory,
retention exception, raw-audio body or upload path.

Session descriptor/sample/attack beats cover clip-local first iteration zero,
starting at zero with a resolved full-active-region or explicit shorter/equal
duration. The legacy native envelope remains thirty seconds/300 windows; the
tempo-derived historical beat bound is 499.501 (999 BPM for thirty seconds,
plus the retained 0.001 historical rounding allowance). Historical
descriptor, primary coverage, and actual pass ranges retain nearest-sample-rounded
physical coverage (for example,
4.000024187452759 beats at 44.1 kHz / 128 BPM). Stored sample/attack beats are
never clamped or interpolated to hide the rounded span. Runtime independently
checks exact native geometry before firing and permits only a half-sample
rounding tail at the active boundary. Storage retains the existing 0.001
historical actual/requested allowance for compatibility; this is not admission
authority. No storage path, ownership, retention or database format changes.
Native sample indices retain
their original DSP-clock coordinates and may start above zero. Explicit source
transport coverage is global, with the same duration and message-rate clip
start-time origin; message-rate origin and monitored continuity are historical
approximate evidence, not admission authority or physical source proof.
Signed global origin diagnostics remain readable; the qualified native MVP
requires nonnegative global start. Unknown follow actions are never described
as disabled: capture requires monitored continuity with explicit message-rate
detection limitations, also exposed in typed summaries.

Session publication requires Session requested/actual modes, an exact inspected
Session clip subject (connection reference, semantic scene, track association),
and a contributing track subject; attribution cannot be exclusive. Primary
coverage is `{coordinate: "clip-local-beats", iteration: 0, startBeat: 0,
endBeat}`; track coverage uses `{coordinate: "transport-beats", startBeat,
endBeat}`. Requested/actual pass ranges remain clip-local. Legacy link coverage
remains the unchanged `{startBeat, endBeat}` shape. The typed summary and detail
readers preserve the Session kind, coordinate mapping, approximate alignment,
and timing limitations. Connection-scoped clip references are not durable Live
identities and do not prove current content/dependency freshness.
Publication validates target references, semantic scene, and exact track
association, not raw display-name equality. Session target display strings are
credential-redacted with the existing sanitizer and then bounded to 128
characters, including when redaction expands a short credential value. The same
redacted, bounded names remain safe in typed summaries, detail reads, and restart; caller-owned
observations and their alignment-quality shape are not mutated.

Session clip subject IDs identify immutable binding snapshots, including the
canonical contributing-track association and complete stored binding evidence.
Different requested ranges or upstream processing fingerprints can produce
different track/binding snapshots even when the clip/source settings are
unchanged. A later capture then gets a distinct subject rather than attempting
to overwrite old binding evidence; an identical snapshot can reuse its subject.
Prior observations/subjects remain unchanged, without a migration or durable
physical-clip-identity claim.

Context survives diagnostic-journal retention. Context pruning requires exact
reviewed IDs and removes context records only, never Live clips or source
files. Current freshness requires privileged revalidation; missing content,
identity or dependency evidence remains unknown or unresolved. Historical
passes retain their original attribution when Set ownership changes.

`mapSessionAudioObservation(observation, source)` converts validated native v2
global descriptor/sample/attack beats by subtracting the frozen
`source.transport.startBeat`. It retains native DSP sample indices, alignment,
and limitations without mutating the input or clamping beats. The supplied
Session source must describe the actual mapped coverage; inconsistent origins
or spans fail schema validation. Conversion does not grant source admission,
launch authority, or native geometry proof.

The first observation for an unsaved in-memory App session must also publish
its registry record and canonical session manifest with the typed context-store
reference. The repository provides an idempotent `publishSessionContext` hook;
production composition must inject it. Failure or cancellation of that hook
prevents observation publication. The main-process
`createDesktopSessionContextManager` resolves the invoking App-session ID,
checks initiating-agent membership, and shares one bounded cached repository
per session/ownership in its profile. Trusted main-process application readers
receive a read-only facade with no model-agent attribution; their get/list
queries still validate session, Set and profile ownership. Mutation and handle
closure are denied on that facade, including when it shares a cached store
with an agent. Repository resolution combines the invocation's cancellation
signal with an explicitly supplied operation signal; cancelled queued reads
never open or publish a store. Empty inventory reads do not promote an
ephemeral session. Closing an unpublished store after cancelled or failed
capture setup releases its reservation ownership and removes the empty file;
reopening returns empty inventory without claiming saved observations. Cleanup
of a retained shared repository releases the pass reservation without closing
other callers' repository. Its first append uses the specific-session
`HeadlessDesktopService.publishSessionContext` API, not selected-UI-session
publication, to commit the registry record and strict, credential-redacted
`session.json` reference before observations. The reference contains only
schema version, `context/entity-context.sqlite`, and registered kinds; it
never duplicates measurements. A declared missing/corrupt store or ownership
manifest is an explicit recovery failure, not an empty replacement.
Old v1-only kind declarations remain readable. On the next append, additive
supported-kind registration is reconciled through the same invoking-session
registry/manifest publication hook before accepting observations; failure
preserves the old history and declaration. The database remains schema version
2 at the same owned path; this adds registered payload kinds, not a file-layout
or SQLite-format migration.

Composition registers the manager's `prepareSessionTransition` through
`JsonSessionStore.setSessionContextTransitionHandler`. Preparation drains and
closes cached SQLite handles before moving the complete Live Set subtree.
Active append/publication/reservation work, including queued reservation
admission, denies relocation and requires a retry. Closing an evicted repository
handle cannot remove its replacement from the session cache. The lease applies
destination ownership headers before registry
publication, completes only after that publication, and restores source
headers after directory/manifest rollback on failure or cancellation. All
sessions sharing a moved Set directory must transition together. Earlier
pass, entry, subject, and link provenance is never rewritten or merged.
Implicit registry eviction or removal of declared context references is
rejected. Cache eviction closes a handle, not its persisted observations.
Unpublished empty stores are cleaned on ordinary shutdown; orphan stores
after a crash require explicit recovery rather than silent adoption.

Manager resolution, first publication, transition preparation/application/
rollback, and closure have application-owned bounded, redacted lifecycle
records with timing and caller trace/correlation/causation/agent IDs. Queries
forward per-invocation context rather than inheriting an opening trace.
Parent composition still owns wiring and shutdown order: stop new work,
drain Desktop session actions, then close the context manager. Native timing,
physical-listener-to-bridge identity verification, and isolated Live/visible
Desktop acceptance are separate production gates; storage does not establish
musical identity. No `.als` or Ableton Project-folder sidecars are introduced.

The resolver also supplies `signalIngressDescriptorPath` under `state/` and
`signalIngressSecretPath` under `credentials/`. The descriptor is bounded local
discovery metadata, not a second server. Node-for-Max requires the local
producer-authentication key, so this specific secret is an owner-only local
key file rather than an Electron-only encrypted credential. Keep its directory
owner-only, its file mode `0600`, and its contents out of renderer APIs, logs,
history payloads and support bundles.

Already-installed MIDI clients may require an explicitly configured legacy
discovery descriptor. Compatibility uses the same authenticated ingress and
secret, not a second listener or a separate context store. Legacy publication
is explicit; the resolver does not invent or automatically write an additional
home-directory path.

The migration-only resolver fields `legacySignalIngressDescriptorPath` and
`legacySignalIngressSecretPath` identify the historical
`~/.ableton-agent/signal-ingress.json` and
`~/.ableton-agent/signal-ingress.secret` locations. They remain independent of
`LIVE_AGENT_HOME` and profile selection. Storage bootstrap never creates or
writes them. Desktop consumes these resolver fields only when explicitly
enabling compatibility publication; already-installed MIDI clients require a
plaintext key body even though upgraded clients also support canonical JSON.

Desktop now passes the selected profile's canonical descriptor and credential
reference to runtime composition and publishes the same local key before
starting ingress. The existing credential writer uses the supported plaintext
key format; a `.json` filename does not imply a second key or different secret.
Normal, non-isolated startup also explicitly requests the pre-existing legacy
MIDI descriptor/key pair for compatibility. Automation and explicit
`LIVE_AGENT_HOME` roots do not publish that global compatibility pair. Legacy
discovery remains a single compatibility endpoint, not profile selection;
upgraded companions use their generated canonical profile configuration.
Publication failure/cancellation cleans owned values, and cleanup preserves a
file replaced by another publisher. Lifecycle events contain paths/counts and
timing, never key bytes.

Integration installation resolves producer configuration from the explicitly
selected profile/environment, or the normal packaged app's selected registry
profile. It does not silently substitute `default`, `development` or a previous
automation endpoint. Profile registry reads used by detect/dry-run are
side-effect-free: a missing registry yields the normal default in memory without
creating directories or writing metadata. Invalid existing registries still fail.
Actual installation lifecycle records use the selected profile's existing event
journal and typed History; no new journal location or upload path is introduced.

## Data that intentionally remains outside the root

- The installed Remote Script token remains in the managed Ableton Remote
  Script directory because Live must read it. Desktop may copy it into the
  encrypted credential vault.
- Host-consumed Machine-Listening-Development and Midi-Capture bundles, their
  hash/installation manifests and owner-only discovery path configuration reside
  in their dedicated preset folders in the selected Ableton User Library.
  These are deployed host assets, not another application-state root. Portable
  packaged copies contain no profile configuration or credentials.
  Machine-listening installation also embeds that configuration in an owner-only
  frozen AMXD. It contains only shared-resolver descriptor/secret paths, never
  secret contents, and introduces no new runtime storage location. Collected
  copies therefore retain profile-specific paths; use an installation/replacement
  for the destination profile rather than treating collection as profile migration.
  Max extracts flagged Node resources into its own temporary host cache while
  loading a frozen device. This host-managed cache is not application persistence
  or a replacement journal/profile root.
- User-selected exports and support bundles are written only to the explicit
  destination selected by the user.
- Build, test, and release artifacts remain in their repository-defined or
  temporary locations and are not runtime application state.
- Operating-system keychain material used by Electron `safeStorage` remains
  operating-system managed.

### Packaged acceptance isolation

The acceptance runner stages disposable projects and bounded evidence under
`.test-artifacts/acceptance/`. Each run passes its private `profile/` directory
through the existing `--automation-profile` option. Desktop still resolves
application data through `@ableton-agent/storage`, under that directory's
`live-agent/profiles/automation/`; this does not introduce another application
storage format.

Only typed Desktop queries supply exported history and context evidence.
Receipts use the shared bounded, redacted atomic writer; neither the renderer nor
the runner gains raw application-database access or an upload path. Packaged
producer discovery contains isolated descriptor/secret **paths**, not credential
bodies.

After confirmed owned Desktop and Live shutdown, the runner removes the
credential-bearing profile before preserving allowlisted project assets and
diagnostic receipts. If shutdown is unconfirmed, it reports failed cleanup and
does not prune resources still potentially in use. Such a private run directory
is not an exportable support bundle. Successful and failed allowlisted project
copies are retained under bounded admission, not silently expired or deleted.
Admission requires fewer than 16 existing top-level entries, at most 8,192
recursive entries, and at most 1.75 GiB of existing data (256 MiB headroom below
2 GiB). A retained working copy is limited to 256 MiB, 8,192 entries, and 256
allowlisted paths. These are admission and preservation limits, not permission
to delete old runs. Allocation uses an atomic admission lock; a stale lock
requires explicit inspection.
The [acceptance authoring guide](../testing/acceptance-authoring.md) defines the
explicit operator cleanup procedure. Test evidence is not a second
authoritative application history store.

Draft intake is separate from a running acceptance case. The skill-local helper
copies at most 128 referenced files (64 MiB per file, 128 MiB total) into a fresh
directory under an explicitly selected existing authoring output, conventionally
`.test-artifacts/fixture-authoring/`. Its adjacent reports use the same bounded,
redacted receipt writer. It creates no app profile, reads no external referenced
locations, and retains failed/cancelled copies for explicit operator cleanup.

## Security and durability invariants

- Create profile directories with owner-only permissions and persisted files
  with owner read/write permissions.
- Validate root/profile overrides and reject traversal, filesystem-root
  targets, and unsafe profile names.
- Do not follow or migrate symbolic links into the canonical store.
- Sanitize and bound persisted payloads. Redact credentials embedded in every
  string and replace binary/audio bodies with visible omission markers.
- Credential assignment scanning must continue inside ordinary diagnostic
  prefixes such as `failed: token=...`; an unrecognized outer assignment cannot
  hide a nested credential. Repeated sanitation across runtime, publication,
  IPC and History boundaries must preserve existing redaction markers without
  growing them or exposing the original value. This uses the canonical
  sanitizer, not a listening-specific copy, and requires no history migration.
- Persist only the reasoning-summary preference, never model reasoning text, in
  `config/preferences.json`. Bounded, redacted Working summaries belong in the
  profile-wide observability journal and typed renderer history.
- Keep renderer access typed and redacted. Never expose raw filesystem access,
  raw SQLite access, or a generic storage IPC channel.
- Restrict agent shell reads to validated regular
  `copilot/tool-output/*-copilot-tool-output-*.txt` files in the active
  profile. Spill files must not grant access to sibling profile data or other
  filesystem paths.
- Keep one writer lock per profile-wide journal. A second writer degrades with
  an actionable diagnostic instead of forking or corrupting history.
- Drain journal writes through one worker batch at a time and expose pending,
  in-flight, rejected, high-water, and latest-drain health. Typed history reads
  use a bounded accepted-write barrier and return a degraded/unavailable error
  rather than waiting indefinitely for a stalled writer.
- Keep App events and configuration snapshots physically separate from agent
  sessions/turns/messages/tool calls/results/approvals and Live Set
  saves/snapshots/trajectory records. The worker exposes only bounded,
  parameterized, read-only queries over the stable `agent_history_*` and
  `set_history_*` public views; physical tables and SQLite metadata are not
  queryable through that API.
- Preserve grouped-tool semantics in those views: stable operation ID,
  discriminated action, mutation scope, bounded target identity, and exact
  tool-call/turn/agent links. Save/manual snapshots are checkpoints; terminal
  mutation trajectories describe the causal operations between checkpoints.
- The v1 age and size retention policy prunes App events and App configuration
  snapshots only. Agent and Live Set history remains until an explicit clear or
  a future independently versioned retention policy is introduced.
- Publish files atomically and preserve the prior valid state when validation,
  migration, or publication fails.
- App-session titles are mutable display metadata. Storage ownership,
  canonical associations, directory identities, and Agent/Set History joins
  use immutable App-session IDs. A first-save ownership change updates
  `sessions.json`, session/Set/Project manifests, and
  `live-set-sessions.json` as one rollback-capable operation; history capture
  is subsequent and cannot roll back successful ownership.
- Plan artifact updates require the current SHA-256 revision once the file
  exists. The application rejects stale or missing expected revisions rather
  than silently overwriting concurrent agent or user edits.
- Do not add a network upload path. Anonymous product telemetry is a separate,
  opt-in facility and is disabled unless explicitly implemented and consented.

## Migration contract

Legacy Electron application-data/log locations and
`~/.ableton-agent/copilot` migrate through a staged copy:

1. Discover legacy components.
2. Copy existing canonical data into staging when a profile already contains
   non-conflicting client data.
3. Copy legacy components only when their destination is absent.
4. Validate known JSON and SQLite files.
5. Harden permissions and reject symbolic links.
6. Atomically publish the complete profile.
7. Write the migration marker and retain legacy sources for rollback.

The former `event-history.sqlite` is intentionally not copied or renamed into
`agent-set-event-history.sqlite`. The unified history database starts fresh so
its distinct App, agent, and Live Set ownership contracts are never inferred
from the legacy event-only file. The old file remains in place for rollback or
manual diagnostics.

A destination conflict or corrupt source fails without overwriting either side.
Migration emits application-owned queued, started, progress, completed, failed,
and cancelled lifecycle events with trace, correlation, causation, attribution,
and timing. Bootstrap records are mirrored to the structured log and replayed
into Desktop History after the journal opens.

### Storage v1 to v2 nested-layout migration

The v1-to-v2 migration is operator invoked. Runtime startup does not migrate or
silently reinterpret storage.

```sh
# Dry-run is the default.
LIVE_AGENT_HOME="$HOME/.live-agent" \
  pnpm --filter @ableton-agent/storage migrate:v2 -- --profile default

# Apply after reviewing the report.
LIVE_AGENT_HOME="$HOME/.live-agent" \
  pnpm --filter @ableton-agent/storage migrate:v2 -- --profile default --apply
```

`LIVE_AGENT_PROFILE` is honored when `--profile` is omitted. The command:

1. requires a complete supported v1 layout and refuses missing version markers,
   mixed v1/v2 paths, symbolic links, and incomplete session directories;
2. creates `backups/storage-v1-{timestamp}/{profile}` and backs up the root
   version marker before changing profile data;
3. atomically renames top-level legacy `projectId`/`projectName` session fields
   to `liveSetId`/`liveSetName`, upgrades the session collection to v4, and
   populates missing immutable `createdAt` values from `updatedAt`;
4. renames `state/project-sessions.json` to
   `state/live-set-sessions.json`;
5. groups complete legacy session directories below
   `unassigned-live-set-state/{live-set-id}/session-state/`, never inferring a
   Live Project;
6. creates the empty bounded Live Projects registry and reserved `memory/`
   ownership directories; and
7. publishes the root storage version only after every profile with legacy
   session data has been migrated.

Run the command once for each legacy profile. Until the last profile is
migrated, the root remains marked as v1 and Desktop startup continues to fail
closed rather than accepting a mixed layout. If an incompatible profile is
archived after other profiles have already migrated, rerun the command for any
migrated profile to back up and finalize the root version marker without
rewriting that profile.

Using legacy `updatedAt` as `createdAt` is an explicit approximation because v3
did not retain the original creation time. Migrated sessions are ordered by
`createdAt`, with session ID as the deterministic tie-break, so user-facing
session numbering remains stable across repeated reads and migrations.

Reports are bounded. Validation or application failures return a nonzero exit
status, preserve the legacy profile, and retain any completed backup.

## Adding new persisted data

Before adding a file, database, cache, or directory:

1. Choose the owning directory from the table above. Extend the shared typed
   resolver only when no existing owner fits.
2. Define schema/version, size bounds, retention/deletion, atomicity, and
   concurrency behavior.
3. Define redaction and binary-omission behavior before persistence.
4. Add application-owned lifecycle and timing events for asynchronous work.
5. Expose only typed, redacted queries or diagnostics to Desktop.
6. Add tests for path safety, permissions, migration, ordering, redaction,
   failure/cancellation, trace propagation, cleanup, and restart behavior.
7. Update this document and the relevant feature specification and
   implementation to-do file.
