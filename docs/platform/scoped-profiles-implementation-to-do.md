# Scoped Profiles Implementation To-Do

Companion specification: [Scoped Profiles](scoped-profiles.md)

## Storage and resolution

- [x] Add root profile registry and active-profile selection.
- [x] Add typed System, Profile, and Session agent/skill paths.
- [x] Add bounded scope-local tombstones and metadata.
- [x] Resolve effective artifacts as session > profile > system > bundled.
- [x] Preserve the existing default profile without eager resource copying.

## Profile lifecycle

- [x] Create, rename, switch, and delete visible user profiles.
- [x] Keep development and automation as hidden reserved profiles.
- [x] Persist and deactivate the active session before profile switching.
- [x] Recompose profile-owned Desktop services without restarting the app.
- [x] Roll back the active profile when the replacement composition fails.

## Artifact management

- [x] List the System baseline and physical Profile/Session agents and skills.
- [x] Copy and move artifacts through staged validated publication.
- [x] Perform semantic agent and skill rename with same-scope references.
- [x] Delete local overrides and reveal inherited artifacts.
- [x] Disable and restore inherited artifacts with tombstones.
- [x] Compare conflicts and require replace, rename, or cancel.
- [x] Publish complete agent definitions from Agents as atomic Session-scope
  copy-on-write artifacts.

## Desktop and observability

- [x] Add typed IPC and preload APIs without raw filesystem access.
- [x] Build the nested Profile Manager hierarchy and conflict dialog.
- [x] Add compact toolbar Profile and Agent selectors.
- [x] Replace persistent Profile Manager actions with accessible context menus
      and an anchored create-profile popover.
- [x] Add bounded Copy/Cut/Paste state and scope-targeted Paste actions.
- [x] Add Move-by-default drag-and-drop with Option-drag Copy.
- [x] Keep the Profiles content pane scrollable while the Workspace-only
  composer is absent.
- [x] Reset profile-owned renderer state atomically after switching.
- [x] Emit complete lifecycle, timing, redaction, and trace events.
- [x] Surface validation and switching failures as actionable diagnostics.
- [x] Refresh Agents and Profiles from the same scoped source after definition
  publication.

## Verification

- [x] Cover paths, permissions, bounds, symlinks, and registry concurrency.
- [x] Cover precedence, tombstones, invalid definitions, and fallback.
- [x] Cover mutation rollback, semantic rename, conflicts, and references.
- [x] Cover agent-definition publication, stale-write cancellation, invalid
  listener references, and effective-origin refresh.
- [x] Cover profile switch guards, teardown/startup ordering, and rollback.
- [x] Cover renderer interactions, accessibility, and state replacement.
- [x] Add isolated Electron profile lifecycle and artifact workflow coverage.
- [x] Run deterministic integration validation.
- [x] Run the final Desktop UX validation workflow.
