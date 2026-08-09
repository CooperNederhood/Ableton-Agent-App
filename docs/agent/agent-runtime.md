# Agent Runtime

## Role

The agent translates musical intent into safe, observable, verifiable
operations. It is not the source of truth for the Live set and does not execute
arbitrary code inside Ableton.

## Copilot SDK configuration

The default session should:

- Use the Node.js Copilot SDK.
- Enable streaming.
- Register only approved custom tools.
- Exclude unrelated built-in coding and shell tools.
- Provide a custom permission handler.
- Register lifecycle and tool hooks.
- Use a stable application-owned session ID.
- Enable session persistence for project continuity.

The app should prefer an empty or tightly restricted tool environment rather
than inheriting the general Copilot CLI tool set.

## System behavior

The base system message should teach the agent:

- Ableton terminology and project structure.
- The difference between Session and Arrangement views.
- One-based identifiers shown to users versus internal stable references.
- The need to inspect before editing.
- The requirement to verify state after mutation.
- When user approval is required.
- How to report assumptions and partial failures.
- That tool results, not chat memory, determine current Live state.

Detailed genre recipes and composition guidance belong in skills or reference
content, not in an ever-growing base system message.

## Session context

Each turn may receive a compact context block containing:

- Current connection and capability status.
- Selected tracks, clips, and devices.
- Project tempo, signature, and arrangement summary.
- Current production plan.
- Pending approvals.
- Recent change sets.
- Relevant user preferences.

Do not inject a full project dump on every turn. The agent can call inspection
tools for detail.

## Hooks

### Session start

- Load project preferences.
- Inject current Ableton connection status.
- Restore the active production plan.

### User prompt submitted

- Attach explicit UI selections.
- Add mode information such as Compose, Arrange, Sound Design, or Mix.
- Avoid silently rewriting musical intent.

### Pre-tool use

- Enforce tool allowlists.
- Classify risk.
- Validate connection and project identity.
- Require approval for destructive or broad changes.
- Attach an operation correlation ID.

### Post-tool use

- Record change-set metadata.
- Redact internal protocol details.
- Update project state.
- Produce UI operation events.

### Tool failure

- Preserve structured failure codes.
- Tell the agent whether retrying is useful.
- Prevent retry loops for unsupported capabilities or permission denials.

## Specialized agents

Do not begin with many autonomous sub-agents. Add specialized agents only when
their tool and context boundaries are clear. Candidates include:

- Composer: harmonic, melodic, and rhythmic planning.
- Arranger: section structure and clip placement.
- Sound designer: browser, devices, racks, and parameters.
- Mix assistant: levels, pan, device settings, and comparative analysis.

The parent agent remains responsible for user communication and cross-domain
coordination.

## Completion

An agent turn is complete only when:

- Requested operations have returned.
- Required verification has completed.
- Any partial failures are clearly surfaced.
- Project-state updates are persisted.

Use the SDK's idle event as the mechanical completion signal. Application
workflow completion should be represented separately by operation and
change-set status.

