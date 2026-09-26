# Scoped Profiles

## Scope model

Ableton Agent resolves customizable artifacts through four nested user-facing
scopes:

1. **System Scope** applies to every user profile and production session.
2. **Profile Scope** represents one musical identity and applies to every
   production session owned by that profile.
3. **Project Scope** applies to every App session whose Live Set belongs to one
   verified Ableton Live Project.
4. **Session Scope** applies only to one App session.

Agents and skills use copy-on-write inheritance. Resolution order is:

```text
session > project > profile > system > bundled
```

Bundled resources are immutable fallback content. System Scope is the broadest
editable layer. A lower scope stores a physical copy only after an explicit copy, move, rename,
external edit, or an Agents-tab definition save. Scope-local tombstones can hide
inherited artifacts without modifying their upstream source.

## Profiles

The first visible user profile is `default`. Users may create, rename, switch,
and delete other profiles. `development` and `automation` are reserved hidden
profiles used by their corresponding runtime modes.

Profile-owned settings, sessions, credentials, Copilot SDK data, observability,
logs, and session artifacts remain under:

```text
~/.live-agent/profiles/{profile}/
```

The selected packaged-app profile and profile registry are root-owned metadata.
An explicit `LIVE_AGENT_PROFILE` override remains available for testing and
recovery and disables interactive switching for that process.

Switching profiles does not move a production session between profiles. The
active session must first be closed. Closing persists the session in its
current profile, deactivates its runtime agents, and leaves it resumable later.

## Artifact layout

```text
~/.live-agent/
├── config/
│   └── profiles.json
├── system/
│   ├── agents/
│   ├── skills/
│   └── artifact-state/
│       ├── agents.json
│       └── skills.json
└── profiles/
    └── {profile}/
        ├── agents/
        ├── skills/
        ├── artifact-state/
        │   ├── agents.json
        │   └── skills.json
        ├── project-state/
        │   └── {live-project-id}/
        │       ├── project.json
        │       ├── agents/
        │       ├── skills/
        │       ├── artifact-state/
        │       └── live-set-state/
        │           └── {live-set-id}/
        │               ├── live-set.json
        │               └── session-state/
        │                   └── {app-session-id}/
        │                       ├── agents/
        │                       ├── skills/
        │                       ├── artifact-state/
        │                       ├── session.json
        │                       └── artifacts/plan.md
        └── unassigned-live-set-state/
            └── {live-set-id}/
                ├── live-set.json
                └── session-state/{app-session-id}/
```

Agent identity is the validated YAML `name`. Skill identity is the validated
`SKILL.md` frontmatter `name`. Directory and file names remain filesystem-safe
representations of those identities.

A Live Project is the nearest ancestor of a saved `.als` file containing an
`Ableton Project Info` directory. A Live Set is one `.als` document. Live Set
is an identity and storage grouping, not a fifth agent/skill scope. Unsaved
Sets and saved Sets outside a verified Project remain under the unassigned
area and have no Project Scope.

## Profile Manager

The Desktop Profile Manager presents the persisted hierarchy directly:

```text
System
├── default
│   ├── Live Project
│   │   └── Live Set
│   │       ├── Live Set-1
│   │       └── Live Set-2
│   └── Unassigned Live Sets
│       └── Untitled
└── another-profile
```

Compact `v` and `^` disclosure controls expand or collapse each node. Expanded
nodes separate Agents and Skills and show only artifacts physically defined or
disabled at that exact scope. The System node also shows immutable bundled
resources as the application baseline. Inherited artifacts are not repeated
under every descendant; runtime resolution remains visible in artifact status
and continues to follow Session, Project, Profile, System, then bundled
precedence.

Profile nodes expose known Live Projects, their Live Sets, and persisted App
sessions even when closed. A Live Set with one App session uses the Set name as
the session label. Multiple App sessions are numbered in immutable creation
order (`Writing-1`, `Writing-2`, and so on); active and canonical association
state are separate indicators. Opaque identifiers remain limited to bounded
diagnostic surfaces and filesystem paths are never exposed.

The Profiles pane owns vertical scrolling inside the Desktop content row, so
large profile and session trees remain reachable without a Workspace composer.
The application toolbar presents compact Profile and Agent selectors.
Changing Profile while a production session is active requires confirmation;
the app persists and deactivates that session before switching and leaves it
available to resume.

Supported operations are:

- create a profile from the `+` popover beside the Profiles heading;
- switch, rename, or delete an eligible profile from its context menu;
- copy or cut an artifact from its context menu and paste it onto a compatible
  System, Profile, Project, or Session row;
- drag an artifact to another scope, moving it by default or copying it while
  Option is held;
- semantically rename an agent or skill;
- delete a local override, revealing the next inherited definition;
- disable or restore an inherited artifact with a tombstone.

Editing any resolved agent in the Agents tab is a Session-scope copy-on-write
operation for the active production session. The same-name version-2 YAML
definition is staged, validated against the complete layered catalog, and
published atomically. Profiles then shows that physical artifact beneath the
active session, while Agents immediately resolves it as the winning Session
definition.

Editing any resolved skill in the Skills tab follows the same Session-scope
copy-on-write rule. Existing skill names and descriptions are immutable in that
editor; only the Markdown body is replaced. New skills define their name,
description, and initial body before first publication, after which their
frontmatter is locked. A successful publication refreshes Profiles, the Skills
navigator, and Workspace slash-command discovery from the same effective
catalog.

Persisted inactive sessions and known Projects are valid drag-and-drop
destinations in Profiles. Writing into an inactive session or inactive Project
changes only stored scoped artifacts and does not reconfigure the active Agent
runtime. A newly started active session for an unsaved Live Set appears
immediately under Unassigned Live Sets; its first Session-scope save or
transfer promotes the session through the canonical session store before
publishing the artifact.

Agents and Skills editors always publish to the active App session. Project
definitions are created through Profiles copy/move operations. Catalog refresh
is dynamic: subsequent agent creation, skill invocation, and Workspace slash
completion use the current four-scope definition without restarting Desktop.

Destination conflicts never overwrite silently. The app returns a bounded
comparison and requires replace, semantic rename, or cancel. Skill rename
updates same-scope agent references atomically. All filesystem mutation stays
in the main process behind typed IPC. The UI receives the names, descriptions,
scope, status, and actions needed for management but does not receive
unrestricted filesystem access.

## Safety and observability

Profile and artifact operations reject traversal, symbolic links, oversized
content, malformed definitions, invalid references, unsafe names, stale
revisions, and writes outside canonical storage. Multi-file operations stage
and validate before atomic publication or roll back without partial changes.

Asynchronous profile and artifact operations emit queued, started, progress,
completed, failed, and cancelled lifecycle events with duration, trace,
correlation, causation, profile, scope, artifact kind, and safe artifact
identity. Persisted attributes are bounded and redacted. Artifact bodies and
credentials are never written to telemetry or renderer state.
