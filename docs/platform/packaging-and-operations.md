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

The same Remote Script artifact is bundled in the desktop resources and can be
managed independently:

```bash
pnpm --filter @ableton-agent/desktop remote-script detect
pnpm --filter @ableton-agent/desktop remote-script install --confirm
pnpm --filter @ableton-agent/desktop remote-script update --confirm
pnpm --filter @ableton-agent/desktop remote-script install --confirm \
  --path "/path/to/User Library"
```

Detection covers the standard macOS Music/Documents and Windows
Documents/OneDrive User Library locations. `ABLETON_USER_LIBRARY` overrides
detection. Installation is staged, keeps the bridge token, and moves the prior
installation into `.ableton-agent-backups` before replacement. Unmanaged
installations are never overwritten without the explicit `--confirm` action.

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

## Telemetry

Telemetry is optional and privacy-first. If implemented, default collection
should be limited to:

- App and Remote Script versions.
- Platform and Live major version.
- Feature/tool name.
- Success/failure category.
- Duration.
- Connection reliability metrics.

Prompts, MIDI notes, track names, device names, file paths, and project content
require separate explicit consent and are not needed for initial product
telemetry.

Telemetry remains disabled by default through the validated desktop preference.
No telemetry transport is configured in the initial release; enabling the
preference alone does not upload data.

## Diagnostics

Provide an in-app diagnostics page containing:

- App, SDK runtime, Remote Script, protocol, and Live versions.
- Connection state and last error code.
- Capability report.
- Remote Script installation path.
- Redacted recent operation logs.
- Exportable support bundle.

## Supported platform matrix

Initial supported matrix:

| Platform | Architectures | Ableton Live |
| --- | --- | --- |
| macOS 13, 14, 15 | Intel, Apple Silicon | 11.3 or newer, 12.x |
| Windows 10 22H2, Windows 11 | x64 | 11.3 or newer, 12.x |

Installer production is exercised on macOS 14 and Windows Server 2022 CI
runners. Real Live smoke testing on every supported OS/Live combination remains
a release requirement.

Capability detection handles feature variance, but a supported matrix is still
required.

## Real-Live release evidence

Build the repository, open the canonical validation Set in Ableton, and run:

```bash
export ABLETON_AGENT_TOKEN="<installed Remote Script token>"
pnpm live:validate -- --live-version 12.1
```

The runner records the commit, platform, architecture, Live version, and exit
status of non-mutating CLI smoke commands under
`.test-artifacts/live-validation/`. It intentionally excludes command output
and project content. Complete the pending manual check groups in that JSON
after testing clips, Arrangement/cue points, devices, racks, Browser loading,
and native undo. Attach the evidence files to the release candidate; a release
must not claim a Live/platform combination without a passing evidence file.
