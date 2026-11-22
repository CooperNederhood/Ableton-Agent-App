# Local storage

Everything the app saves on disk lives under one folder, `~/.live-agent`, split
into **profiles**. A single package, `@ableton-agent/storage`
(`packages/storage/src/index.ts`), decides every path. Other code asks it for
typed paths instead of building its own. This keeps data easy to find, back
up, and delete, and stops packages from scattering files across the machine.

Ableton itself stays the source of truth for music. We store app state:
settings, sessions, agent conversations, history, and listening analysis.

## Root and profiles

| Setting | Default | Override |
| --- | --- | --- |
| Root | `~/.live-agent` | `LIVE_AGENT_HOME` (absolute path, used by tests and automation) |
| Profile | `default` for the packaged app, `development` for dev builds | `LIVE_AGENT_PROFILE` |

A **profile** is a full, isolated copy of the app's data: think "one musical
identity". Users can create, rename, switch, and delete profiles in Desktop
(`apps/desktop/src/main/profile-manager.ts`). The list of visible profiles and
the selected one live in `config/profiles.json` at the root.

`development` and `automation` are reserved, hidden profiles. Automation runs
use their own root plus the `automation` profile, so tests never touch your
real data.

`resolveLiveAgentStorage()` returns a `LiveAgentStorageLayout` object with
every path for one root + profile. `ensureLiveAgentStorage()` creates the
directories with owner-only (`0700`) permissions.

## Directory tree

```text
~/.live-agent/
├── storage-version.json            layout version
├── config/profiles.json            profile registry + selected profile
├── system/                         System-scope agents/skills (all profiles)
│   ├── agents/  skills/  artifact-state/
└── profiles/{profile}/
    ├── config/preferences.json     user preferences
    ├── state/
    │   ├── sessions.json           Desktop app-session records
    │   ├── live-set-sessions.json  which session belongs to which Live Set
    │   ├── live-projects.json      known Live Projects
    │   └── signal-ingress.json     where Max devices connect
    ├── credentials/
    │   └── signal-ingress-secret.json
    ├── copilot/                    Copilot SDK home (owned by the SDK)
    │   ├── session-state/{sdk-session-id}/events.jsonl, workspace.yaml, …
    │   └── tool-output/            large tool outputs + sandboxed bash scratch
    ├── observability/
    │   └── agent-set-event-history.sqlite   the journal
    ├── logs/desktop.log            Desktop diagnostic log (JSON lines)
    ├── agents/  skills/  artifact-state/    Profile-scope agents/skills
    ├── memory/                     reserved, empty for now
    ├── project-state/{live-project-id}/
    │   ├── project.json
    │   ├── agents/  skills/  artifact-state/  memory/
    │   └── live-set-state/{live-set-id}/
    │       ├── live-set.json
    │       └── session-state/{app-session-id}/   (see below)
    └── unassigned-live-set-state/{live-set-id}/
        ├── live-set.json
        └── session-state/{app-session-id}/
            ├── session.json                    session manifest
            ├── artifacts/plan.md               shared plan document
            ├── context/entity-context.sqlite   listening observations
            └── agents/  skills/  artifact-state/  memory/
```

## Who owns what

| Path | What it holds | Owner |
| --- | --- | --- |
| `storage-version.json`, `config/profiles.json` | Layout version, profile registry | `packages/storage` (edited via Desktop profile manager) |
| `system/`, `{profile}/agents`, `skills`, `artifact-state` | Scoped agent and skill copies, plus "tombstones" that hide inherited ones | `apps/desktop/src/main/agent-catalog.ts` |
| `config/preferences.json` | Validated, non-secret preferences | `JsonPreferencesStore` in `apps/desktop/src/main/desktop-service.ts` |
| `state/sessions.json`, `live-set-sessions.json` | App-session records and Live Set links | `JsonSessionStore` (`desktop-service.ts`), `JsonLiveSetSessionStore` (`live-set-session-store.ts`) |
| `state/live-projects.json` | Bounded registry of Live Projects | Desktop main (`desktop-service.ts`) |
| `state/signal-ingress.json`, `credentials/signal-ingress-secret.json` | Address and key Max for Live devices use to reach the app | Desktop main (`signal-credentials.ts`, `ableton-integrations-install.ts`) |
| `copilot/` | Copilot SDK conversations and session state | Copilot SDK, via `CopilotAgentService` in `packages/application` |
| `observability/` | One profile-wide history database | `packages/observability` (see [Observability](observability.md)) |
| `logs/` | Redacted Desktop log | `apps/desktop/src/main/logger.ts` |
| `*/session-state/{id}/context/` | Listening passes and derived audio features | `packages/project-state` (`context-repository.ts`) |
| `*/session-state/{id}/artifacts/plan.md` | The session's plan | `packages/application/src/plan-artifact.ts` |

Notes:

- `credentials/` files are plain files with `0600` permissions, not encrypted
  blobs. The **bridge token** is not stored here at all: it lives next to the
  installed Remote Script (`.ableton-agent-token`) so Live can read it.
- GitHub sign-in is owned by the `gh` CLI and `~/.copilot`. The app never
  copies that token into the profile.
- The journal is profile-wide on purpose: one database makes cross-session
  queries and retention simple. Do not create one database per session.
- The CLI only uses `copilot/` (always in the `default` profile under
  `~/.live-agent`). It does not write the journal, log, or session folders.

## Ownership hierarchy: Project → Live Set → Session

Session data is filed under the Live Set it belongs to:

- A **Live Set** is one `.als` file, identified by a `liveSetId`.
- A **Live Project** is Ableton's project folder that groups Sets. If the app
  knows the Set's project, data goes under `project-state/{live-project-id}/`.
  Otherwise it goes under `unassigned-live-set-state/`. Storage never guesses
  the project.
- An **app session** is one conversation with the agent(s) about a Set.

To get a session's folder, you must pass all three IDs as a
`SessionStorageOwnershipContext` (`liveSetId`, optional `liveProjectId`,
`sessionId`) to `resolveNestedSessionStorage()`. A session ID alone is not
enough. `relocateLiveSetStorage()` moves a Set's folder when it gets assigned
to a project.

## Scoped agents and skills

Agents and skills can be customised at four levels. The most specific one wins:

```text
session > project > profile > system > bundled (agents/ and skills/ in the repo)
```

A lower scope only gets its own copy when the user edits, copies, or moves an
artifact there (copy-on-write). `resolveArtifactScopePaths()` returns the
`agents/`, `skills/`, and tombstone paths for any scope.

## Adding new persisted data

1. Decide the scope: root, profile, project, Live Set, or app session.
2. Add a typed field to `LiveAgentStorageLayout` (or to the matching
   `ProjectStoragePaths` / `LiveSetStoragePaths` / `AppSessionStoragePaths`) in
   `packages/storage/src/index.ts`. Keep it inside the profile root;
   `assertWithin` guards this.
3. If it is a profile-level directory that should always exist, add it to
   `ensureLiveAgentStorage()`.
4. Read the path from the layout in your code. Do not call `homedir()`,
   `app.getPath()`, or `join(...)` to build your own location.
5. Write files atomically (the package exports `writeJsonAtomically`), with
   owner-only permissions, and keep them bounded.
6. Never write secrets into logs, the journal, or renderer state.
7. Add tests in `packages/storage/src/index.test.ts` and update this page.

## Where to look in the code

| Topic | File |
| --- | --- |
| Path resolver and profile registry | `packages/storage/src/index.ts` |
| Desktop picks root and profile at startup | `apps/desktop/src/main/main.ts` |
| Profile create/rename/switch/delete | `apps/desktop/src/main/profile-manager.ts` |
| Scoped agent/skill resolution | `apps/desktop/src/main/agent-catalog.ts` |
| Session context store | `packages/project-state/src/context-repository.ts` |

Related: [Architecture](architecture.md), [Observability](observability.md),
[Desktop app](desktop-app.md).
