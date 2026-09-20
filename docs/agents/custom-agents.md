# Custom Agents

## Purpose

Custom agents replace the fixed product-mode enum with validated,
definition-driven Ableton specialists. A definition describes reusable behavior;
an active agent instance is a session-owned conversation created from that
definition.

## Definitions and instances

A **defined agent** is loaded from the effective scoped catalog. Session,
Profile, and System Scope definitions override immutable bundled
`agents/*.yaml` resources by validated semantic name. It contains:

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

Scoped agent definitions use copy-on-write inheritance. Deleting a local
override reveals the next upstream definition; a scope-local tombstone hides an
inherited definition without deleting it upstream. Profile Manager copy, move,
and semantic rename operations validate the complete effective catalog before
publication.

Creating, resuming, resetting, or changing an active instance emits a sanitized
configuration snapshot to the local detailed event journal. The snapshot
captures the effective definition revision, model/reasoning settings, resolved
tools and skills, edit scope/bindings, approval policy, and Live Event/Output
delivery settings. It excludes secrets and raw prompt/configuration content;
safe revisions and hashes allow later History queries to explain which
configuration produced an SDK or tool trace.

## Native Copilot SDK integration

Each active instance uses one SDK session configured with:

- one native `customAgents` entry;
- that agent selected through the session `agent` option;
- an exact source-qualified session `availableTools` list;
- metadata-only system instructions for configured skills;
- an application-owned `skill` tool when the agent enables skills;
- inference disabled so the runtime does not switch app-defined agents.

The native custom-agent entry omits its optional `tools` field and inherits the
already restricted session surface. Duplicating the allowlist there with bare
names can hide source-qualified SDK built-ins such as `ask_user`.

The application does not pass `skillDirectories` or native custom-agent skills
to the SDK because those paths eagerly preload complete skill bodies. Instead,
the `skill` tool progressively loads one enabled body when the model selects it.

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
SDK session. The catalog contains Ableton tools, application-owned tools, and
the approved session-isolated SDK built-ins, so `tools: ["*"]` grants all three
groups. Unmatched patterns invalidate the definition. SDK built-ins are
source-qualified when the session is configured; host-capable coding, shell,
filesystem, and network tools are not in the catalog. The SDK `skill` built-in
is always excluded, and SDK tool search is disabled rather than inserted as an
implicit discovery tool. The application-owned `skill` tool is added
independently only when the definition enables at least one skill.

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

Active instances may also listen to project-scoped
[Live Events](../events/live-events.md). Each listener stores its own response
mode and message prefix. These listeners are session overrides and are not
seeded from canonical agent YAML in the initial implementation. One event may
feed multiple agents without creating duplicate LOM subscriptions.

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

The **Agents** tab is a two-column management workspace. Its narrow left
navigation lists every active instance first with a green status light, then
definitions without an active instance with a muted status light. Multiple
instances created from one definition remain separate rows. Selecting a row
only changes the inspected agent; it does not retarget the production
conversation until the user invokes **Select** or **Open**.

The detail workspace uses compact semantic icon tabs:

- **General** contains identity, lifecycle, source/revision details, model and
  reasoning settings, and instance lifecycle actions.
- **Capabilities** contains the session prompt, tool patterns and resolution,
  edit scope, and skills.
- **Connections** contains input channels and session-specific Live Event
  listeners with prepared-context settings.

Active instances expose editable session overrides and preserve the existing
model-change, reset, and deactivation safeguards. Inactive definitions present
the same groups read-only with an action to create an instance. Active
instances also expose **Create another** because a production session may own
multiple independent instances of one definition. Catalog diagnostics and
refresh remain visible at the workspace level.

The workspace's **Active Agent** selector switches among instances and
therefore switches the visible transcript, activity, approvals, composer
target, and cancellation target.

**Edit overrides** includes a **Listening Events** selector populated from the
current session's event catalog. Each selected event configures `Automatic` or
`Next prompt` response plus an optional message prefix. The existing **Inputs**
editor remains unchanged. Output subscriptions remain managed in Outputs until
those workflows are deliberately consolidated.

The canonical definitions are Default, Compose, Arrange, Sound, and Mix. They
initially have every Ableton tool and session scope. Default is the
general-purpose editing-capable production agent. Only actual approval,
edit-scope, connection, and automatic-analysis policy may block its edits.
