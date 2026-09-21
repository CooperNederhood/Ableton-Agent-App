# Tool Design

Current registered catalog: [Ableton Tool List](tool-list.md)

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

The tool factory must also define sanitized observability events for request,
policy/approval, queued, started, progress, child workflow/bridge operations,
verification, completed, failed, and cancelled stages. Each stage propagates
the originating trace/correlation context and records relevant queue/execution
timing. Bounded tool definitions, arguments, and results are required in the
local journal for useful history; the shared sanitizer redacts embedded
credentials and replaces binary/audio bodies with visible omission markers.

## Tool results

Return two representations:

- A concise text result optimized for the model.
- Structured UI metadata containing affected objects, warnings, before/after
  summaries, and change-set IDs.

Do not return enormous browser trees or parameter lists to the model. Support
filtering, pagination, and targeted detail.

`set_sql_search` is the read-only agent surface for local Set History. It
accepts one `SELECT` or CTE, rejects comments and mutation/administrative
keywords and recursive CTEs, restricts sources to documented `agent_history_*`
and `set_history_*` public views, accepts bounded named scalar parameters, and
caps returned rows. Results report the database `schemaVersion` and query
`elapsedMs`. Tool guidance requires needed columns, narrow Live Set/time/ID
filters, modest limits, summary/ID discovery before detail queries, and narrower
follow-ups after truncation; it warns against `SELECT *`, broad joins, and broad
scans. The injected query service must open storage read-only, honor
cancellation, and must not expose a database handle or filesystem path to the
model or renderer.

Custom tool failures use the Copilot SDK's native failure result rather than a
thrown handler exception. The bounded failure payload retains a stable code,
message, retryability, and sanitized details for model guidance, operation UI,
logs, and Desktop History. Unknown exceptions fail closed as non-retryable and
never expose stacks, credentials, binary bodies, or unbounded values.

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

The operation record and its stages remain queryable in Desktop History after
the live activity UI has moved on.
