# Scoped Profiles Implementation To-Do

Companion specification: [Scoped Profiles](scoped-profiles.md)

## Storage and resolution

- [ ] Add root profile registry and active-profile selection.
- [ ] Add typed System, Profile, and Session agent/skill paths.
- [ ] Add bounded scope-local tombstones and metadata.
- [ ] Resolve effective artifacts as session > profile > system > bundled.
- [ ] Preserve the existing default profile without eager resource copying.

## Profile lifecycle

- [ ] Create, rename, switch, and delete visible user profiles.
- [ ] Keep development and automation as hidden reserved profiles.
- [ ] Persist and deactivate the active session before profile switching.
- [ ] Recompose profile-owned Desktop services without restarting the app.
- [ ] Roll back the active profile when the replacement composition fails.

## Artifact management

- [ ] List the System baseline and physical Profile/Session agents and skills.
- [ ] Copy and move artifacts through staged validated publication.
- [ ] Perform semantic agent and skill rename with same-scope references.
- [ ] Delete local overrides and reveal inherited artifacts.
- [ ] Disable and restore inherited artifacts with tombstones.
- [ ] Compare conflicts and require replace, rename, or cancel.

## Desktop and observability

- [ ] Add typed IPC and preload APIs without raw filesystem access.
- [ ] Build the nested Profile Manager hierarchy and conflict dialog.
- [ ] Reset profile-owned renderer state atomically after switching.
- [ ] Emit complete lifecycle, timing, redaction, and trace events.
- [ ] Surface validation and switching failures as actionable diagnostics.

## Verification

- [ ] Cover paths, permissions, bounds, symlinks, and registry concurrency.
- [ ] Cover precedence, tombstones, invalid definitions, and fallback.
- [ ] Cover mutation rollback, semantic rename, conflicts, and references.
- [ ] Cover profile switch guards, teardown/startup ordering, and rollback.
- [ ] Cover renderer interactions, accessibility, and state replacement.
- [ ] Add isolated Electron profile lifecycle and artifact workflow coverage.
- [ ] Run deterministic integration and Desktop UX validation workflows.
