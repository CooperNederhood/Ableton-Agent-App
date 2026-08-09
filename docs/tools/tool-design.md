# Tool Design

## Principles

Agent tools should be:

- Domain-specific.
- Typed.
- Small enough to reason about.
- Large enough to avoid excessive model round trips.
- Idempotent where practical.
- Explicit about mutation and risk.
- Structured in both success and failure.
- Verifiable.

## Three levels

### Inspection tools

Read current state without mutation:

- `get_project_overview`
- `get_track_details`
- `get_clip_details`
- `get_arrangement`
- `get_device_parameters`
- `search_browser`
- `list_external_plugins`
- `get_capabilities`

### Primitive mutation tools

Perform one coherent operation:

- `create_track`
- `set_track_mixer`
- `create_session_clip`
- `replace_clip_notes`
- `place_clip_in_arrangement`
- `set_arrangement_clip`
- `load_browser_item`
- `set_device_parameter`
- `set_transport`

### Workflow tools

Perform deterministic multi-step operations:

- `create_drum_pattern`
- `create_chord_progression`
- `build_song_section`
- `duplicate_and_vary_section`
- `apply_mix_change_set`
- `audition_device_presets`
- `import_audio_asset`

Workflow tools call application services and bridge primitives; they should not
recursively ask the agent to call more tools.

## Tool metadata

Every tool definition should include application-owned metadata:

```ts
interface AbletonToolMetadata {
  category: "inspect" | "compose" | "arrange" | "sound" | "mix" | "transport";
  risk: "read" | "reversible" | "destructive" | "broad";
  requiresConnection: boolean;
  requiredCapabilities: string[];
  expectedDuration: "fast" | "medium" | "long";
}
```

Hooks use this metadata for permissions and UI presentation.

## Tool results

Return two representations:

- A concise text result optimized for the model.
- Structured UI metadata containing affected objects, warnings, before/after
  summaries, and change-set IDs.

Do not return enormous browser trees or parameter lists to the model. Support
filtering, pagination, and targeted detail.

## Feature adoption from existing MCP projects

Adopt and improve:

- Extended's one-based user-facing indices.
- Extended's device parameter normalization and aliases.
- Extended's arrangement, cue-point, mixer, rack, Drum Rack, and external
  plug-in coverage.
- Original's audio clip capability detection and long-operation handling.
- Original's browser URI caching and URI-root hints.
- Both projects' proven session/clip/transport operations.

Do not copy forward:

- Duplicate MCP and Remote Script command definitions.
- String-formatted errors returned as successful tool calls.
- Fixed sleeps around mutations.
- Monolithic dispatch functions.
- Full browser-tree traversal on Live's main thread.
- Commands accepted by an API but ignored by the implementation.

## Musical transactions

A workflow operation should:

1. Resolve and validate targets.
2. Capture a minimal before-state.
3. Produce a proposed change set.
4. Request approval when policy requires it.
5. Execute serialized mutations.
6. Verify postconditions.
7. Persist the operation record.
8. Return a concise musical summary.

