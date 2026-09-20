# Scoped Profiles

## Scope model

Ableton Agent resolves customizable artifacts through three nested user-facing
scopes:

1. **System Scope** applies to every user profile and production session.
2. **Profile Scope** represents one musical identity and applies to every
   production session owned by that profile.
3. **Session Scope** applies only to one production session.

Agents and skills use copy-on-write inheritance. Resolution order is:

```text
session > profile > system > bundled
```

Bundled resources are immutable fallback content. System Scope is the broadest
editable layer. A lower scope stores a physical copy only after an explicit
copy, move, rename, or external edit. Scope-local tombstones can hide inherited
artifacts without modifying their upstream source.

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
        └── session-state/
            └── {production-session-id}/
                ├── agents/
                ├── skills/
                ├── artifact-state/
                │   ├── agents.json
                │   └── skills.json
                ├── session.json
                └── artifacts/
                    └── plan.md
```

Agent identity is the validated YAML `name`. Skill identity is the validated
`SKILL.md` frontmatter `name`. Directory and file names remain filesystem-safe
representations of those identities.

## Profile Manager

The Desktop Profile Manager presents the persisted hierarchy directly:

```text
System
├── default
│   ├── session-id
│   └── another-session-id
└── another-profile
```

Compact `v` and `^` disclosure controls expand or collapse each node. Expanded
nodes separate Agents and Skills and show only artifacts physically defined or
disabled at that exact scope. The System node also shows immutable bundled
resources as the application baseline. Inherited artifacts are not repeated
under every descendant; runtime resolution remains visible in artifact status
and continues to follow Session, Profile, System, then bundled precedence.

Profile nodes expose their persisted sessions even when the session is closed.
Session labels include a bounded user-facing title and identifier, and the
active profile and session are marked without exposing filesystem paths.

Supported operations are:

- copy an artifact down or back up the hierarchy;
- move a local artifact between editable scopes;
- semantically rename an agent or skill;
- delete a local override, revealing the next inherited definition;
- disable or restore an inherited artifact with a tombstone; and
- create, rename, switch, or delete eligible profiles.

Destination conflicts never overwrite silently. The app returns a bounded
comparison and requires replace, semantic rename, or cancel. Skill rename
updates same-scope agent references atomically. All filesystem mutation stays
in the main process behind typed IPC; renderers receive no raw paths or file
bodies.

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
