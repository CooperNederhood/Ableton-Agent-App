# Packaging and Operations

## Current local payload promotion

The original Max publication/install correction is complete. Production uses
the tested JavaScript-generated parent rather than a separate saved AMXD;
qualification, packaging and installation retain the same identified bundle
and reject stale or tampered resources. Normal installed startup discovers
both listeners and captures all four MIDI/audio clips with complete records.

The user subsequently tested the normal installed app on 2026-10-31, reported
their tests passing, and accepted the original publication/install correction.
This local user acceptance is distinct from a public release or qualification
of the separate intermittent repeat-capture behavior.

Payload reuse also validates MIDI source freshness: the current canonical
companions and portable AMXD rendering must match the existing payload bytes.
An internally consistent manifest alone is insufficient. The attributed
`midi-current-source-check` stage fails or cancels explicitly without rewriting
the retained bundle. Positive builds and reuse share the same portable-device
rendering; MIDI-only source changes require a new payload rather than silently
shipping old code.

The single generated production parent and immutable payload reuse are
implemented, and the final corrected Session bundle is installed. A subsequent
silent-tail regression required retained publication and Max/Node scalar
transport corrections plus bounded failure-value observability.
Preserve the prior installation receipt's provenance rather
than treating its successful authentication/hash checks as qualification of
the newly changed bundle. The unchanged managed silent-tail fixture now passes
its standalone scenario and owning group. The final Session qualification,
local macOS `dir` packaging, installed authentication and four independent
normal-startup full-clip captures pass. Production and installed application
inventories match
`787fe8b6cbb8a66ea6a69d45d81a09ec09c4e8d5888e277ea1e7aad438ac54a9`;
all 21 immutable installed listening files match the qualified bundle.
The unchanged AMXD hash alone does not identify updated external DSP,
classic Max IO or Node runtime bytes.

The separate traced automation-MCP capture and Agent/Live inspection completed;
its private helper exited with a CLI-import error, so it is not a clean harness
pass. An extra run was cancelled during scope freeze; both owned PIDs are gone,
but its cleanup receipt reported an identity mismatch. Neither receipt changes
the independently verified production/installed byte continuity.
Intermittent repeated-capture failure and musical interpretation remain
separate listening follow-ups, not unfinished patch publishing work.
General DMG/ZIP
generation encountered electron-builder's null-provider update-info error;
it is not qualified as a public distribution by the successful local host
installation. The installer deliberately uses the validated host `dir` path.

## Distribution

### Local real-Live release check

Hosted CI and packaging do not run licensed Ableton. A successful build artifact
is not evidence of completed musical workflows. Before describing a candidate
as qualified, use the local packaged acceptance suite:

1. Use a clean committed checkout, the repository's Node/pnpm versions and
   `pnpm install --frozen-lockfile`. Run the ordinary production checks.
2. Build one host-architecture candidate with `pnpm build`,
   `node scripts/build-ableton-integrations.mjs`, and
   `pnpm --filter @ableton-agent/desktop dist --mac --dir --arm64` on the current
   Apple Silicon host. Use the matching architecture on another supported host.
   This unpacked development candidate does not establish signing/notarization.
3. Provision a licensed dedicated single-operator Mac with Live 11 and Max for
   Live. Record the actual full version; a different Live 11 patch is not by
   itself a reason to downgrade. Install/select the matching Remote Script
   through the existing integration setup. Establish real bridge authentication
   and Copilot access through supported credential sources before testing.
   Never copy tokens into fixtures, command-line arguments or evidence.
4. Obtain fixtures from the same checkout's tracked `integration/fixtures/`
   assets, not private ignored input files. Run
   `pnpm test:acceptance:validate`. The driver checks declared Builtin/Core
   Library resources in the licensed installation against manifest hashes;
   acquire missing licensed resources through the normal Live installation,
   never substitute media or redistribute those libraries.
5. Close normal Live yourself. Invoke `pnpm live:acceptance:suite` with the
   exact packaged executable (and `--live-app` when needed). This explicitly
   authorizes the documented owned test launches, not broad approvals or
   dismissal of credential prompts. All registered cases execute once.
6. Run `pnpm live:acceptance:verify --receipt <suite.json> --executable
   <same-executable>` before marking this candidate qualified. Preserve the
   receipt location, candidate hash and uncovered scope in the release/merge
   checklist. Changed source, package bytes or test registration require new
   qualification; an earlier candidate's green result is not transferable.

Missing auth, assets or licensed resources are setup blockers, not product
passes. Product failures are retained separately. Failed cleanup, missing
terminal evidence or persistence errors cannot be green. If the host lease is
left blocked after uncertain cleanup, inspect its owner and recorded processes;
never remove it just because it is old or kill a user's process.

An explicit human release exception must record the decision owner, exact
candidate, failed/unrun scope, reason and follow-up on the release or PR.
An exception is not a successful suite, does not rewrite evidence and cannot
make the local verifier pass. Do not upload private History, credentials, project
payloads or raw journals to satisfy the checklist.

Ship a signed desktop application for macOS and Windows. The installer should:

- Install the desktop app.
- Detect Ableton installations and likely User Library locations.
- Install or update the Remote Script with user confirmation.
- Deliver the complete canonical Machine-Listening-Development and Midi-Capture
  bundles into the same selected User Library.
- Generate and store a local bridge authentication token.
- Explain the one-time Control Surface selection step.

Manual Remote Script installation remains available for diagnostics.

Unsigned development artifacts are built reproducibly from the pinned pnpm
lockfile:

```bash
pnpm desktop:dist
```

For the complete local production gate, including formatting, linting,
typechecking, deterministic tests, the source-mode Electron suite, unsigned
packaging, and a smoke test that launches the generated macOS application:

```bash
pnpm install --frozen-lockfile
pnpm desktop:verify-production
```

The reusable verification script assumes dependencies are already installed.
It does not start Vite, use Electron development mode, enable debug automation,
or require Ableton Live. Generated DMG, ZIP, and unpacked application artifacts
are written under the repository-level `release/` directory. Signing and
notarization credentials remain available only in the release environment.
Generated release artifacts are excluded from source linting.

For the normal local development upgrade on macOS, fully quit Ableton Live and
every running copy of Ableton Agent, then run:

```bash
pnpm desktop:install:mac
```

This command reuses the repository's already bootstrapped pinned dependencies,
removes stale release artifacts,
runs the production quality and source-mode Electron gates, packages only the
host architecture, smoke-tests the packaged app, updates the managed Remote
Script and both Max-device bundles, applies a complete local ad-hoc signature, atomically replaces
`/Applications/Ableton Agent.app`, verifies Copilot authentication and model
discovery against that exact installed path with a Finder-like environment, and
launches it.
Application profiles, history, credentials, bridge tokens, and Ableton projects
are preserved. The command fails before mutation if Live or any Ableton Agent
copy is still running. Use `--skip-checks` only after a fully verified build,
`--skip-auth-smoke` only when offline or deliberately recovering authentication,
`--skip-remote-script` when Python sources are unchanged, or `--no-launch` when
the installed app should remain closed. Skipping Python does not skip either Max
device or permit Live to remain open. `--user-library <directory>` and
`--profile <name>` select one explicit destination/profile for all integrations.

Normal Desktop startup enables native-v5 machine-listening discovery and capture
without automation flags. The receiver and listening host share the same launch
admission, with a 2 MiB metric-message allowance and unchanged normal approval
preferences. Isolated automation still requires explicit
`--automation-metric-listeners`; omitting it keeps that test capability disabled.
Installing the matching device bundle does not replace device instances already
referenced by saved Sets. Installed-app review must use a copied Set rebound to
the installed User Library bundle, or manually replace devices in that copy.

## Canonical Max-device delivery

The authoritative listening patch is JavaScript:
`max-patches/audio-listener/native-source.mjs` and `native-runtime-source.mjs`.
`generatedListeningParent` in `scripts/audio-listener-device.mjs` owns the
common construction and object identities. `Machine-Listening-Development.amxd`
is generated output, not a separately maintained production input.
The repository also owns the native-v5/ABI3 metric runtime/DSP companions and the canonical
`max-patches/midi-capture/Midi-Capture.amxd` with shared producer resources.
These are build inputs, not permission to copy an arbitrary installed device
back into source. Neither installation nor packaging runs MIDI promotion or
uses ignored real-host fixture bundles as release inputs.

The electron-builder lifecycle generates or reuses and validates a complete integration
payload under `apps/desktop/build/ableton-integrations`, including when invoked
directly by CI or the macOS installer. Packaged resources contain
`ableton-integrations/` with both portable device bundles and hash manifests.
No machine-specific profile configuration or credential bodies enter that
payload. Installation uses bundled code/resources, not a repository checkout
or a package-manager subprocess in the installed application.

Build the production payload once with `node scripts/build-ableton-integrations.mjs`
before qualification. The before-pack hook uses `--reuse`: an existing payload
is validated without rewriting its files; changed graph/resource/codec inputs
or tampered files cause refusal, not silent regeneration. An absent payload is
built normally. The local macOS installer uses the same reuse check before
packaging rather than overwriting an already-qualified payload. After source
changes, explicitly build a fresh candidate and requalify it; stale existing
payloads are refused. Building an absent payload is not real-Live qualification.

Use the manifest's device and resource hashes and the integration inventory's
source identity to bind qualification to the actual bundle, not just v5 version
metadata. Positive Live fixtures must load this production payload, without a
test-local generated replacement. Installation preserves the listening graph and
runtime/DSP resource bytes, adds resolver-owned profile discovery configuration,
then headlessly freezes the ordinary listener resources into an `mx@c` AMXD
collective. The pinned native FluCoMa bundle described below remains adjacent.
The main patcher includes Max project metadata; Node entrypoints, CommonJS
dependencies, package JSON and configuration all have disk-extraction flags.
Max 8.5.8 does not extract unflagged files for `require()`, even when they are
present in the archive. Max/Gen patchers remain embedded archive resources.
The sidecar manifest is excluded to avoid a self-hash cycle. Its device hash and
the managed receipt identify the resulting frozen bytes; embedded resource bytes
must match the validated portable bundle, except the generated profile config.
The portable source remains unconfigured and unchanged.

Freezing is deterministic (sorted resources and fixed 1970 file timestamps),
bounded to 512 flat ASCII filenames and 64 MiB, and rejects missing Node
entrypoints, duplicate names and malformed archives. Frozen re-encoding retains
embedded dependencies rather than silently unfreezing. `check-artifact` verifies
the frozen graph and embedded inventory against the canonical graph and hashed
sidecars. Dry-run/detection prepare the same frozen bytes without writing;
publication remains atomic and failure/cancellation never falls back to an
unfrozen device. `integrations.freeze` reports queued, started, progress,
completed, failed or cancelled with component attribution and timing through the
existing trace/redaction journal. No Max GUI is needed for installation.

The frozen device and standalone profile configuration are owner-readable only.
The embedded configuration contains descriptor/secret **paths**, never credential
bodies; collection does not make those paths portable to another user/profile.
Reinstall and replace the device when changing machines or profile.
A different source identity is a different candidate.
Actual normal-profile discovery and capture remain distinct acceptance gates;
archive inspection, app authentication and successful copying do not certify
Live loading, Collect All and Save/reopen behavior, or listening. Those real-host
checks remain pending for the newly frozen candidate.

### Pinned FluCoMa smoke dependency

The #92 smoke packages only the stock macOS `fluid.spectralshape~.mxo` from
FluCoMa Max 1.0.10, its upstream notices/reference metadata and a provenance
README. Its signed bundle lives at
`dependencies/flucoma/fluid.spectralshape~.mxo`, adjacent to the AMXD. Exact
file/size/SHA-256 pins and the nested-path allowlist are application-owned in
`packages/shared/src/flucoma-dependency.ts`. Ordinary builds never download
dependencies. Builds, portable payload validation and installed artifact checks
reject missing, extra, stale, self-rehashed, or symlinked dependency files.
Publication preserves executable permissions and the upstream signature; native
bundle files are not encoded as `TEXT` collective entries.
The publisher, Desktop installer and both packaged/runtime fixture stagers
explicitly apply pinned file modes after writing: `0755` for the Mach-O
executable and `0644` for its other pinned resources. They do not rely on
`writeFile` creation modes, which a restrictive `umask` can reduce. Profile
configuration remains `0600`; the executable-mode validator stays strict.
The standalone native/saved fixture scripts import the built shared Node entry
by its explicit repository-relative path, so raw Node admission does not depend
on Vitest aliases or a workspace-root package link.

Installation/freezing requires the **final device directory** when these signed
resources are present. A shared binding helper derives the project's sole
FluCoMa search entry with an absolute `bootpath` ending in
`dependencies/flucoma`, `recursive: 0`, `enabled: 1` and
`includeincollective: 0`. It removes `projectrelativepath` rather than retaining a
relative alternative. Desktop uses the final installation directory, not its
atomic staging directory. Packaged acceptance uses the actual `frozen/`
directory containing the loaded device. No Max global search paths are changed.
An omitted/invalid binding directory or incomplete pinned resource map is an
error, not a request to fall back to relative lookup.

Portable source devices remain unchanged. Installed/frozen identities are
derived from the source, destination binding and existing profile configuration;
verification reconstructs the expected device for its actual final directory.
Runtime fixture stagers likewise retain original source pins and separately
record derived device/manifest bytes. Copying a bound device to a different
directory requires rebinding, not rehashing an old absolute path. All existing
regular-file, ancestor, inventory and signed-file checks still apply before
publication and verification. A prospective installation path may not exist
during pure artifact derivation; its pinned adjacent files must be staged and
verified before any device load.

Packaged acceptance and native/saved runtime fixture staging use the same pinned
resource contract: retain nested paths and executable modes, reject linked or
unapproved resources, and verify the staged dependency bytes. Cancellation
cleans up partial fixture output; staging does not qualify host loading.

The production inventory also includes `audio_listener_flatness_smoke.js` and
`audio_listener_flatness_probe.js`; the generated smoke subpatch is embedded in
the canonical parent graph. This adds diagnostics transport, not a new
authoritative observation schema or independently attested FFT frames.
F2a reuses these same companions and the two stereo analyzers for spread and
flatness. Production graph admission checks the exact two-descriptor selection,
canonical configuration, signal taps, shared gate and control/cleanup wiring;
rehashing a graph that omits spread cannot make it a valid current candidate.

**Loading remains a separate qualification gate.** Max 8 documents current
patcher-folder lookup before global search paths, but this is not proof that a
basename object resolves a bundle nested in `dependencies/flucoma`. Max project
local dependencies take priority, yet the documented behavior explicitly falls
back to global files when the local version cannot be found. Therefore basename
lookup, a `dependency_cache` entry, or a successful package hash check alone
must not be treated as exclusive executable identity. The graph uses the
registered `fluid.spectralshape~` class name, not a relative bundle pathname.
The absolute binding addresses frozen project-root ambiguity. The smoke checks
actual mapped Mach-O files using only verified owned Live/Max ancestry, requiring
the staged canonical path, device/inode and pinned bytes at baseline and capture
completion. Absent mappings, global fallback, ownership changes and inspection
errors fail closed. This witness is separate from finite descriptor delivery,
native measurement validity and terminal cleanup.
Do not add global search paths or silently use a user-installed external.

References: [Max 8 search path](https://docs.cycling74.com/legacy/max8/vignettes/search_path),
[project-local search and fallback](https://docs.cycling74.com/userguide/projects/#project-search-paths).
The exact release/build/license and static architecture/signature evidence are
retained in `max-patches/audio-listener/dependencies/flucoma/README.md`.

### Prior native-only qualification

The corrected production payload is physically qualified on Live 11.3.43:
MIDI/audio one-beat captures, repeated captures, MIDI/audio/MIDI switching and
four-beat MIDI/audio phrases pass with retained reports and verified cleanup.
Qualification binds payload inventory SHA256
`3888e9a78a19446d4bdcc7c3030820fb4b06ca8c5f3e150d048c01cdcb9dd53d`;
the packaged payload is byte-identical. Evidence is
`.test-artifacts/independent-metric-listening/single-source-production.json`.
The same immutable listening files are now installed in the normal `default`
profile and the packaged app is installed at `/Applications/Ableton Agent.app`.
Installed-byte comparison and installed-app authentication pass. Normal-profile
capture/restart review and attribution of the earlier invalid-object console
messages remain separate checks.

The listener builder and artifact checker accept only native v5 and default to
the canonical JavaScript-generated device. They declare
`measurementDelivery: "independent-metric-timelines/v1"`, algorithm `3.0.0` and
the metric observation schema, and package only the matching metric runtime,
measurements, genuine clock/musical/spectrum IO/DSP and producer companions.
Retired versions, non-native requests and retired manifest claims are denied;
old controller/engine imports and runtime/assembler/coordinates publication are
removed. Historical wire4 retained-delivery deployment evidence and unchanged
graph sources are not executable packaging fallback. Runtime admission still
requires actual per-pass native source/clock/cleanup proof, not a manifest claim.

Independent-metric integration has an opt-in protocol compiler,
`compileNativeMetricProtocol` in `scripts/lib/native-metric-protocol-bundle.mjs`.
It compiles the canonical TypeScript/Zod schemas and source-proof checks into a
self-contained CommonJS resource for Node for Max, rather than maintaining a
second handwritten validator. The compiler returns code and immutable
compiler/input/lockfile/license hashes to the existing resource publisher; it
does not write or install a bundle. Caller-owned lifecycle stages cover failure
and cancellation. External runtime imports, unpinned or changing inputs and
oversized output are rejected, and the bundled Zod MIT notice is retained.
Standalone Node loading is a format/contract check, not Max execution evidence.
The production integration caller and shared payload inventory/validator use the
same native5/ABI3/algorithm3 bundle and independent metric delivery. Both manifests
bind compiler/input/lockfile/license provenance to the packaged codec SHA/bytes;
the managed reader rejects mismatches and unbounded or foreign provenance.
Validated provenance is returned as a frozen snapshot, including compiler,
inputs and input records. Its codec size must satisfy the compiler's same
4 MiB output ceiling, with at most 512 inputs totaling 16 MiB.
Owned bounded codec compilation stages preserve cancellation and the existing
atomic publication/rollback behavior. Retired explicit versions fail closed.
Managed packaging denies engineering selection, and managed reading denies
fixture metadata or a renamed/rehashed negative entry through the unchanged
default-entry SHA pin. The application before-pack hook calls this same
lifecycle-backed production CLI; MIDI payload rendering/inventory is unchanged.
That source-role pin and deterministic packaging checks are not qualification
certificates.
Fresh real-host qualification and installation remain parent-owned gates,
separate from these source-only package checks.
Every staged manifest remains `realLiveValidated: false`.

An engineering-only negative v5 candidate can be staged through the builder API
with `nativeMode: true`, `nativeVersion: 5`, `engineeringOnly: true` and
`engineeringFixture: "native5-unavailable-spectrum/v1"`, plus the existing
explicit authored source and lifecycle stage. This is not an agent permission,
production profile/environment switch, installer option, or qualification claim.
It selects `audio_listener_native_v5_unavailable_spectrum_max.js` while retaining
the default v5 generated DSP documents. Spectral acquisition is not started;
the controller's existing unknown-phase path returns no FFT records, no invented
first endpoint, and no spectral cleanup receipt for an unowned source. Measured
level/attacks and shared clock/envelope cleanup remain mandatory. An all-three
request can therefore be honestly partial; spectrum-only remains blocked.
The separately declared entry injects a controller factory that overrides only
spectral acquisition and adds fixture-only lifecycle attribution. The shared
runtime, default v5 entry and generated DSP documents remain byte-identical;
default v5 still enables actual spectrum acquisition.

Negative-scenario pins must bind the manifest's
`engineeringFixture.id`, `engineeringFixture.runtimeEntry`,
`engineeringFixture.runtimeEntrySha256`, `deviceSha256`, complete resource
hash inventory and `metricProtocol` provenance to the same staged bundle.
The fixture manifest uses `native-metric-engineering-fixture/v1`, declares
`sourceSemantics: "spectral-acquisition-not-started"` and remains
`realLiveValidated: false`. Artifact checking rejects missing/foreign fixture
metadata or relabeling a default bundle. Build lifecycle attributes contain the
bounded fixture identifier. The fixture entry uses the existing Max API diagnostic
log to attribute spectral failure to that identifier and its owned lifecycle
event/generation/epoch, without changing normal bridge failure evidence or
including code/audio. Deterministic source tests are not real Max/Live
qualification.

The common CLI installs all host integrations:

```bash
pnpm --filter @ableton-agent/desktop integrations detect
pnpm --filter @ableton-agent/desktop integrations update --confirm
pnpm --filter @ableton-agent/desktop integrations install --confirm \
  --user-library "/path/to/User Library" --profile studio
pnpm --filter @ableton-agent/desktop integrations install --dry-run
```

Source-mode commands consume the generated payload; build/package it first.
`--resources <directory>` selects an app's packaged Resources directory;
`--payload <directory>` and `--remote-script-source <directory>` support explicit
diagnostic inputs. `--components machine-listening,midi-capture` intentionally
updates devices only. Detect and dry-run do not create profile data or publish
host assets. Explicitly named `remote-script install/update` commands below
remain Python-only diagnostics, not a complete integration reinstall.

Live indexes the two managed devices at:

```text
User Library/Presets/Audio Effects/Max Audio Effect/
  Machine-Listening-Development/Machine-Listening-Development.amxd
User Library/Presets/MIDI Effects/Max MIDI Effect/
  Midi-Capture/Midi-Capture.amxd
```

Each folder contains its own required companion files and installed metadata.
Unrelated similarly named copies are not removed. Drag the intended device from
that folder onto a track manually; installation never inserts a device or edits
a Set. On-disk validation and app authentication are distinct from a loaded
Max device resolving its resources and registering compatible capabilities.
The Development listener advertises Arrangement and Session modes and freezes
the explicitly requested mode per pass; the installer verifies the wire-4
bootstrap, guard, two-mode manifest and 30-second/300-window provider limits.
Mode-specific proofs and source restrictions still apply; packaging does not
establish physical qualification. App/Remote Script protocol upgrades must be
delivered together rather than assuming a listener-only update upgrades the
bridge contract.

The integrated wire4/protocol8 candidate is built and covered by strict
payload and synthetic installed-artifact checks, including the actual qmetro
clock/analysis entries. After user-confirmed app closure, the compatible Desktop,
Remote Script and both canonical device bundles were installed in the selected
default profile. Installed mode/qmetro resources and production Desktop
signing/authentication/startup were verified. This does not reload a saved Set's
device instance; fresh physical registration, capture and visible cross-app
acceptance remain separate checks.

The installer resolves the Library once, honoring an explicit selection,
`ABLETON_USER_LIBRARY`, or the selected profile's configured Remote Script
location before refusing ambiguous automatic selection. It follows
the normal packaged app's selected profile unless an explicit profile override
is provided. Installed owner-only producer configuration contains canonical
descriptor/secret paths, never copied secret values or automation endpoints.

Payloads are validated before publication. Each managed component is staged
and atomically replaced, preserving its previous valid installation on a failed
promotion. This is not an atomic transaction across the app and every host
directory. Later failures report successful earlier components and failed
cleanup/recovery, with bounded redacted underlying error messages so a generic
installation error does not hide the required recovery action. The overall
command fails instead of announcing complete success. Requested installs require confirmation, stopped Live, safe managed
paths and serialized ownership. User processes are never terminated.

Installation lifecycle/timings and trace/correlation/causation links are retained
in the selected profile's bounded redacted event journal and existing typed
Desktop History. Binary device bodies and credentials are omitted. A history
persistence failure is explicit even if some host components already changed.
The Settings UI installation action remains deferred.

The packaged app keeps Copilot session/configuration state under the selected
Ableton Agent profile, but GitHub authentication remains owned by GitHub CLI.
Finder does not inherit a terminal's Homebrew PATH, so Desktop resolves a
bounded executable candidate such as `/opt/homebrew/bin/gh` and exposes only
that directory to the embedded Copilot runtime. It does not execute
`gh auth token`, copy `~/.copilot`, or persist a GitHub token. If the app reports
that authentication is required, run:

```bash
gh auth login
```

Then choose **Check again** in Ableton Agent. A GitHub CLI sign-in problem is
separate from macOS Keychain prompts used by Electron `safeStorage` for the
Ableton Remote Script bridge credential.

`electron-builder.yml` produces DMG/ZIP artifacts for Intel and Apple Silicon
macOS and an assisted, per-user NSIS installer for 64-bit Windows. Signing and
notarization are intentionally supplied only by the release environment.
The desktop declares both macOS Copilot SDK and Koffi runtime variants as
optional dependencies, and pnpm installs both supported CPU architectures so
cross-architecture packaging never substitutes the host native runtime.
Packaged applications use the canonical interlocking triple-A artwork in
`apps/desktop/build`: `icon.svg` is the editable master, `icon.png` is the
runtime resource, and `icon.icns`/`icon.ico` supply native macOS and Windows
icons.
macOS release jobs provide `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; Windows release jobs
provide the appropriate `CSC_LINK` and `CSC_KEY_PASSWORD`. Unsigned pull-request
builds must never receive those secrets.

The same Remote Script artifact is bundled in the desktop resources and can be
managed independently:

```bash
pnpm --filter @ableton-agent/desktop remote-script detect
pnpm --filter @ableton-agent/desktop remote-script install --confirm
pnpm --filter @ableton-agent/desktop remote-script update --confirm
pnpm --filter @ableton-agent/desktop remote-script install --confirm \
  --path "/path/to/User Library"
```

Building and installing are separate operations. `pnpm build` compiles the
workspace but does not copy Python files into Ableton's User Library.
`pnpm desktop:dev` rebuilds the desktop's TypeScript dependencies, preload, and
Electron main process automatically; it also does not install the Remote
Script.

After changing `remote-script/AbletonAgent/**`, use this development sequence:

1. Fully quit Ableton Live.
2. Run
   `pnpm --filter @ableton-agent/desktop remote-script update --confirm`.
3. Reopen Live so its embedded Python runtime loads the updated modules.
4. Run `pnpm desktop:dev`.

Renderer changes hot reload. Electron main, preload, and shared TypeScript
package changes require restarting `pnpm desktop:dev`, but do not require a
Remote Script update unless files under `remote-script/AbletonAgent/**` also
changed.

## Desktop automation operations

Developer UX testing may launch Desktop with `--automation` and an absolute
isolated `--automation-profile`. The profile owns its sessions, Copilot data,
logs, event journal, endpoint descriptor, and per-launch secret; it must never
be the normal Electron user-data path.

The endpoint binds to `127.0.0.1` on an ephemeral port, limits requests and
frames, accepts only authenticated `send_user_message` operations, and removes
only descriptor/secret files whose content still matches the current process.
The MCP adapter reads those owner-only files locally. Secrets and raw frames
must not enter logs, Desktop History, support bundles, or screenshots.

Detection covers the standard macOS Music/Documents and Windows
Documents/OneDrive User Library locations. `ABLETON_USER_LIBRARY` overrides
detection. Installation is staged, keeps the bridge token, and moves the prior
installation into `.ableton-agent-backups` before replacement. Unmanaged
installations are never overwritten without the explicit `--confirm` action.
A fresh managed installation generates a cryptographically random token with
owner-only permissions before the staged directory is promoted. At Desktop
startup, the app reads only the exact token file under the configured or
auto-detected `AbletonAgent` installation and copies a valid token into
OS-backed secure storage. An existing vault token or explicit
`ABLETON_AGENT_TOKEN` override takes precedence. Distinct tokens found in
multiple installations require an explicit location selection.

## Versioning

Version independently:

- Desktop app.
- Remote Script.
- IPC protocol.
- Project-state schema.

The app should detect an incompatible or outdated Remote Script and offer a
guided update.

`config/product-versions.json` is the source for app, Remote Script, protocol,
database, minimum compatible Remote Script, and Live support versions. Run
`pnpm versions:generate` after changing it and `pnpm versions:check` in CI.

## Updates

- Use signed application updates.
- Treat Remote Script updates as explicit artifacts.
- Preserve compatibility with at least the immediately previous protocol
  version when practical.
- Provide release notes focused on user-visible behavior and Live compatibility.

## Logging

Maintain separate structured logs:

- Application lifecycle.
- Copilot session lifecycle.
- Tool/workflow operations.
- Bridge/protocol diagnostics.
- Remote Script log messages.

Correlation IDs connect an agent tool call to bridge requests and Remote Script
execution. Logs should redact authentication tokens, credentials, prompts, file
paths, and musical content by default.

Desktop logs are newline-delimited JSON, permissioned to the current user, and
redacted before serialization. Startup pruning removes logs older than 14 days
and bounds the active file to 5 MiB. Support bundles are local JSON artifacts
containing version/connection diagnostics and at most 500 redacted recent log
entries per file; preferences, sessions, prompts, paths, credentials, track
names, device names, and musical content are excluded.

All application-owned local data is rooted at
`~/.live-agent/profiles/{profile}/`. Packaged builds use `default` and
development builds use `development`. `LIVE_AGENT_HOME` and
`LIVE_AGENT_PROFILE` provide explicit overrides. Logs live under `logs/`, the
local event journal under `observability/`, Copilot SDK state under `copilot/`,
and production-session ownership manifests under `session-state/`. OS-encrypted
credential blobs remain under the profile, while the Remote Script's token
remains in its managed Ableton installation so Live can authenticate. The
complete contract is defined in
[Local Storage Layout](local-storage.md).

On first use, the app stages and validates data from prior Electron
application-data/log directories and `~/.ableton-agent/copilot`, then atomically
publishes the profile. It retains legacy copies for rollback and refuses to
overwrite a conflicting destination.

## Telemetry

Two different facilities must not be conflated:

- **Local detailed telemetry/event journal** is captured by default, stored only
  in the current user's application-data directory, and powers Desktop history
  and debugging. It contains a complete unsampled but sanitized record of agent
  configuration snapshots, SDK/tool/workflow activity, Live Event trace stages,
  and Output delivery lifecycle.
- **Anonymous product telemetry** is optional, disabled by default, and would
  require an explicit uploader and consent. No such transport is configured in
  the initial release.

If anonymous product telemetry is implemented, collection should be limited to:

- App and Remote Script versions.
- Platform and Live major version.
- Feature/tool name.
- Success/failure category.
- Duration.
- Connection reliability metrics.

Prompts, MIDI notes, track names, device names, file paths, and project content
require separate explicit consent and are not needed for initial product
telemetry.

The local journal is not governed by anonymous telemetry consent and never
uploads. It can be paused or cleared independently. Its default retention is 30
days with a 250 MiB profile cap and oldest-first deletion. Sanitization preserves
bounded prompts, assistant text, paths, structured musical/MIDI and event
payloads, and tool definitions/arguments/results. It redacts credentials in
every string and replaces binary/audio bodies with visible omission markers. See
[Live Events](../events/live-events.md#local-detailed-event-journal).

## Diagnostics

Provide an in-app diagnostics page containing:

- App, SDK runtime, Remote Script, protocol, and Live versions.
- Connection state and last error code.
- Capability report.
- Remote Script installation path.
- Redacted recent operation logs.
- Queryable local event history and trace timing.
- Exportable support bundle.

## Supported platform matrix

Initial supported matrix:

| Platform | Architectures | Ableton Live |
| --- | --- | --- |
| macOS 13, 14, 15 | Intel, Apple Silicon | Live 11 (11.3+ API baseline) |
| Windows 10 22H2, Windows 11 | x64 | Live 11 (11.3+ API baseline) |

Live 11 is the supported major version; Live 12 is outside scope. Current
development and real-host testing use installed Live Suite 11.3.43 on Apple
Silicon. Track the actual full version in every validation receipt, including
changes after automatic updates, without pinning support to that patch.
A different Live 11 patch is not itself a development blocker or a reason to
downgrade. Preserve historical receipts at their observed versions; investigate
actual capability or compatibility failures rather than requiring 11.3.42.

Installer production is currently exercised on macOS 14 CI only while the
application is in macOS-first development. Windows packaging and smoke jobs
must be restored before Windows support is claimed for a release. Real Live
smoke testing on every supported OS/Live combination remains a release
requirement.

Capability detection handles feature variance, but a supported matrix is still
required.

## Real-Live release evidence

Build the repository, open the canonical validation Set in Ableton, and run:

```bash
export ABLETON_AGENT_TOKEN="<installed Remote Script token>"
pnpm live:validate -- --live-version 11.3.43
```

The runner records the commit, platform, architecture, Live version, and exit
status of non-mutating CLI smoke commands under
`.test-artifacts/live-validation/`. It intentionally excludes command output
and project content. Complete the pending manual check groups in that JSON
after testing clips, Arrangement/cue points, devices, racks, Browser loading,
and native undo. Attach the evidence files to the release candidate; a release
must not claim a Live/platform combination without a passing evidence file.
Use the actually installed version for `--live-version`, not a fixed value
copied from this example. A receipt documents the tested host; it does not
certify every Live 11 patch or make untested patches unsupported.

## Installation

1. Install the desktop artifact for the current release.
2. Run the bundled Remote Script installer, or use
   `pnpm --filter @ableton-agent/desktop remote-script install --confirm`.
3. Restart Ableton Live and select `AbletonAgent` as a Control Surface.
4. Restart the desktop app, open Diagnostics, and confirm the bridge,
   compatibility, and agent-session checks.

The Remote Script token remains in the installed `AbletonAgent` directory, is
preserved across managed updates, and is automatically provisioned into the
desktop credential vault. CLI users still provide it through
`ABLETON_AGENT_TOKEN`. Do not paste it into issues or support bundles.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Bridge remains disconnected | Confirm the Control Surface is selected, Live was restarted after installation, and the app port matches the Remote Script port. |
| Authentication fails | Reinstall/update the Remote Script to preserve or regenerate its token, then restart the desktop app. |
| Compatibility check fails | Update the Remote Script first; if Live is outside the supported matrix, do not force mutations. |
| GitHub authentication required | Install GitHub CLI if needed, run `gh auth login`, then choose **Check again**. Finder-launched apps do not inherit the terminal's Homebrew PATH; Desktop resolves supported standard locations explicitly. |
| Copilot entitlement unavailable | Confirm the authenticated GitHub account has Copilot access, then retry. |
| Agent session does not start | Inspect the typed Copilot authentication state and Diagnostics, then export a redacted support bundle. |
| Renderer recovers or restarts | Preserve the support bundle; the isolated main-process session should remain available after reload. |
| Upgrade behaves unexpectedly | Restore the timestamped Remote Script backup from `.ableton-agent-backups` and attach version evidence to the issue. |

## Privacy

All Ableton control traffic stays on authenticated loopback TCP. The renderer
cannot access Node, Electron, sockets, or credentials. Anonymous telemetry is
disabled by default and no telemetry transport is configured. The default-on
local event journal has no upload path, and its query API returns redacted view
models rather than raw database access. Logs, journal records, and support
bundles redact tokens, credentials, prompts, paths, labels, notes, raw
audio/MIDI, and project content. Users should still inspect any exported
artifact before sharing it.

## Release notes

Each release must publish:

- Desktop, Remote Script, protocol, database, and minimum-compatible versions.
- Supported Live/OS matrix with links to recorded evidence.
- User-visible tool, workflow, safety, and recovery changes.
- Known limitations and unsupported LOM behavior.
- Installation or migration steps and rollback instructions.
- Artifact checksums and signing/notarization status.
