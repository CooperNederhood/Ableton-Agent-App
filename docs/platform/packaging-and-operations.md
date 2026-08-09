# Packaging and Operations

## Distribution

Ship a signed desktop application for macOS and Windows. The installer should:

- Install the desktop app.
- Detect Ableton installations and likely User Library locations.
- Install or update the Remote Script with user confirmation.
- Generate and store a local bridge authentication token.
- Explain the one-time Control Surface selection step.

Manual Remote Script installation remains available for diagnostics.

## Versioning

Version independently:

- Desktop app.
- Remote Script.
- IPC protocol.
- Project-state schema.

The app should detect an incompatible or outdated Remote Script and offer a
guided update.

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

## Diagnostics

Provide an in-app diagnostics page containing:

- App, SDK runtime, Remote Script, protocol, and Live versions.
- Connection state and last error code.
- Capability report.
- Remote Script installation path.
- Redacted recent operation logs.
- Exportable support bundle.

## Supported platform matrix

Define and test exact combinations before release:

- macOS versions.
- Windows versions.
- Ableton Live 11 and 12 minor versions.
- Intel and Apple Silicon behavior.

Capability detection handles feature variance, but a supported matrix is still
required.

