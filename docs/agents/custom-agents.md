# Custom Agents

## Purpose

Custom agents replace the fixed product-mode enum with validated,
definition-driven Ableton specialists. A definition describes reusable behavior;
an active agent instance is a session-owned conversation created from that
definition.

## Definitions and instances

A **defined agent** is loaded from a root `agents/*.yaml` file. It contains:

- stable name and user-facing description;
- a system prompt layered over immutable Ableton safety instructions;
- exact or wildcard tool patterns;
- session-wide or track-selector edit scope;
- configured Agent Skills;
- initial input-channel producer IDs.

An **active agent instance** has:

- an application instance ID and editable label;
- one independent Copilot SDK session and conversation history;
- a snapshot of its source definition;
- project-bound track references for scoped edits;
- session-level overrides and output subscriptions.

Multiple active instances may use the same definition. Definition refreshes do
not mutate existing instances until the user resets them.

## Native Copilot SDK integration

Each active instance uses one SDK session configured with:

- one native `customAgents` entry;
- that agent selected through the session `agent` option;
- an exact resolved tool list;
- root `skillDirectories`;
- configured per-agent skills;
- inference disabled so the runtime does not switch app-defined agents.

The SDK owns conversation persistence. The application uses SDK session IDs and
`getEvents()` to restore a selected agent's transcript.

## Tool sets

YAML tool entries support exact names and `*` wildcards:

```yaml
tools:
  - ableton_devices_*
  - ableton_browser_search
```

Patterns are expanded against the application tool catalog before creating the
SDK session. Unmatched patterns invalidate the definition. Only resolved tools
are registered, and permission policy checks the same allowlist again.

## Edit scopes

Session scope permits any allowed mutation:

```yaml
editScope:
  - session
```

Track scope uses human-readable selectors:

```yaml
editScope:
  - track:
      name: Drums
      occurrence: 0
```

Selectors resolve to stable project-specific track references when activated.
Reads remain available according to the tool allowlist; mutations must target
the bound tracks. Global mutations require session scope. Missing, ambiguous,
stale, or cross-project bindings block edits rather than guessing.

## Concurrent agents

Read-only work may run concurrently. Mutations acquire application locks:

- session mutations lock the full Live Set;
- track mutations lock every target track reference;
- disjoint track mutations may run concurrently;
- overlapping mutations serialize;
- scope and identity are revalidated after lock acquisition.

## Persistence

The application production-session record stores active instances, definition
snapshots, selected instance, scope bindings, overrides, and output
subscriptions. Editing an active agent updates this session artifact, not the
canonical repository YAML.

An active instance also stores `autoApprove`, which defaults to `false` during
schema migration. This is a production-session override, not part of the
canonical YAML definition: it follows that instance across selection changes
and restarts, remains isolated from instances created from the same definition,
and disappears when the instance is deactivated.

Legacy Explore sessions migrate to Default. Compose, Arrange, Sound, and Mix
sessions migrate to matching definitions while retaining their SDK history,
plans, and outputs.

## Approval layering and safety

`/yolo`, `/yolo on`, and `/yolo off` change automatic approval for the selected
instance. Appending `all` changes all instances active in the current production
session. These exact lowercase, single-spaced forms are local desktop commands;
they never become SDK messages or history turns.

Per-agent automatic approval is subordinate to the global base policy:
deny-all always denies, approve-all always approves, and the per-agent override
applies only under always-ask or risky-change policies. Approval attribution is
mandatory: another agent and an unattributed request cannot borrow an
instance's override. Enabling an override may resolve a pending request only
when that request is attributed to the targeted instance.

Automatic approval does not expand an agent's capabilities. Resolved tool
allowlists and edit scopes are checked before mutation execution and again
after lock acquisition. Track-scoped agents may auto-approve valid mutations
within their bound tracks, but out-of-scope tracks, stale or cross-project
bindings, and global mutations remain denied.

## Desktop experience

The **Agents** tab lists definitions, diagnostics, and active instances. Users
can create, rename, edit, reset, deactivate, and refresh. The workspace's
**Agent Mode** selector switches among active instances and therefore switches
the visible transcript, activity, approvals, composer target, and cancellation
target.

The canonical definitions are Default, Compose, Arrange, Sound, and Mix. They
initially have every Ableton tool and session scope.
