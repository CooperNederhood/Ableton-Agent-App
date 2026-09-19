# Packaging and Operations

## Distribution

Ship a signed desktop application for macOS and Windows. The installer should:

- Install the desktop app.
- Detect Ableton installations and likely User Library locations.
- Install or update the Remote Script with user confirmation.
- Generate and store a local bridge authentication token.
- Explain the one-time Control Surface selection step.

Manual Remote Script installation remains available for diagnostics.

Unsigned development artifacts are built reproducibly from the pinned pnpm
lockfile:

```bash
pnpm desktop:dist
```

`electron-builder.yml` produces DMG/ZIP artifacts for Intel and Apple Silicon
macOS and an assisted, per-user NSIS installer for 64-bit Windows. Signing and
notarization are intentionally supplied only by the release environment.
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
| macOS 13, 14, 15 | Intel, Apple Silicon | 11.3.42 |
| Windows 10 22H2, Windows 11 | x64 | 11.3.42 |

Installer production is exercised on macOS 14 and Windows Server 2022 CI
runners. Real Live smoke testing on every supported OS/Live combination remains
a release requirement.

Capability detection handles feature variance, but a supported matrix is still
required.

## Real-Live release evidence

Build the repository, open the canonical validation Set in Ableton, and run:

```bash
export ABLETON_AGENT_TOKEN="<installed Remote Script token>"
pnpm live:validate -- --live-version 11.3.42
```

The runner records the commit, platform, architecture, Live version, and exit
status of non-mutating CLI smoke commands under
`.test-artifacts/live-validation/`. It intentionally excludes command output
and project content. Complete the pending manual check groups in that JSON
after testing clips, Arrangement/cue points, devices, racks, Browser loading,
and native undo. Attach the evidence files to the release candidate; a release
must not claim a Live/platform combination without a passing evidence file.

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
| Agent session does not start | Confirm GitHub Copilot authentication, inspect Diagnostics, and export a redacted support bundle. |
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
