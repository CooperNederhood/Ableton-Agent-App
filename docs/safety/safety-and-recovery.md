# Safety and Recovery

## Risk classes

### Read

Inspection only. Automatically allowed.

### Reversible

Small mutations that can normally be undone or compensated, such as renaming a
track or adjusting a single parameter. May be automatically allowed according
to user preference.

### Destructive

Deletion, replacement of notes, clearing automation, or overwriting occupied
clip slots. Requires explicit approval unless the user initiated the exact
action through a direct UI control.

### Broad

Large multi-track or arrangement changes. Requires preview and approval.

## Guardrails

- Never delete the final required session track.
- Never overwrite an occupied clip slot without explicit policy.
- Never resolve ambiguous names by picking the first match.
- Never accept stale references silently.
- Clamp only when the API contract explicitly promises clamping and report it.
- Validate file paths and supported media before import.
- Detect unsupported Live capabilities before mutation.
- Limit workflow mutation counts and payload sizes.

## Approval model

Approval requests should include:

- Plain-language intent.
- Affected tracks/clips/devices.
- Destructive or broad consequences.
- Whether recovery is expected to be possible.
- A compact change preview.

Support:

- Approve once.
- Deny.
- Approve this low-risk category for the session.

Do not provide blanket approval for destructive actions.

## Undo and compensation

Investigate and test Live's available undo-grouping APIs per supported version.
Do not promise atomic rollback until it is proven.

Where native undo grouping is unavailable or insufficient:

- Capture minimal before-state.
- Implement compensating commands for supported operations.
- Mark operations that cannot be safely reversed.
- Encourage project saves before high-impact workflows.

## Verification

Mutation success means the intended postcondition was observed, not merely that
the command returned without an exception.

Examples:

- A created track exists and has the expected type.
- A clip contains the expected note count/range.
- An arrangement clip begins at the intended beat.
- A loaded device appears on the target track.
- A parameter's observed value matches the requested value within tolerance.

## Failure behavior

For partial workflow failure:

1. Stop subsequent dependent mutations.
2. Preserve successful changes.
3. Attempt compensation only when explicitly safe.
4. Refresh affected state.
5. Report completed and incomplete work separately.
6. Offer a targeted retry or recovery action.

