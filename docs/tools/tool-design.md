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

New domain operations may define this metadata through an internal operation
descriptor. A descriptor binds a stable operation ID and action to strict
input/result schemas, risk, duration, mutation target/edit scope, required
capability, affected-track extraction, service handler, and target-specific
lifecycle identity. Permission checks and mutation locks resolve the descriptor
from the invocation arguments, so cross-track operations authorize and lock
both exact track references rather than relying on a static tool name.

Device, rack, Drum Rack, and parameter operations are exposed through the
`ableton_devices` grouped public tool. Their descriptors preserve independent
schemas, capability gates, approval presentation, affected-track locking, and
lifecycle identity beneath that one agent-facing name.

The tool factory must also define sanitized observability events for request,
policy/approval, queued, started, progress, child workflow/bridge operations,
verification, completed, failed, and cancelled stages. Each stage propagates
the originating trace/correlation context and records relevant queue/execution
timing. Bounded tool definitions, arguments, and results are required in the
local journal for useful history; the shared sanitizer redacts embedded
credentials and replaces binary/audio bodies with visible omission markers.
Grouped public tools must preserve their stable operation ID, discriminated
action, mutation target, and bounded target identity in agent tool-call/result
history. Terminal mutations also project a Set trajectory record linked by
agent session, turn, and tool-call ID. This keeps domain-tool consolidation
queryable as semantic operations instead of collapsing history into generic
tool names such as `ableton_tracks`.

## Tool results

Return two representations:

- A concise text result optimized for the model.
- Structured UI metadata containing affected objects, warnings, before/after
  summaries, and change-set IDs.

Do not return enormous browser trees or parameter lists to the model. Support
filtering, pagination, and targeted detail.

Drum Rack pad inspection filters empty pads by default after one bounded
128-pad bridge read and reports total, occupied, empty, returned, and
scan-completeness metadata. Callers can explicitly request paginated empty-pad
mapping for diagnostics. The complete bridge result remains available to
bounded local observability while the model-facing result stays compact.

The SDK may externalize other legitimate large results, including SQL query
results. Those files live in profile-owned transient Copilot storage. Agents
inspect them with policy-gated SDK `bash` commands such as `grep`, bounded
`head`/`tail`, `wc`, or restricted `jq`; arbitrary host shell access remains
denied.

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

For dense Live 11 domains, one agent-facing tool may expose a strict
discriminated union of actions. Each action still resolves to its own operation
descriptor before authorization, so read and mutation variants preserve their
individual risk, capability, edit-scope, lock, target-identity, and lifecycle
semantics. The protocol keeps inspection and mutation commands separate to
avoid mutation invalidation for reads.

The binding catalog topology is eager domain grouping with `action` as the
discriminator. SDK tool search remains disabled. Splitting the same operations
into action-specific tools does not materially reduce total schema information,
but it multiplies tool names and exceeds the bounded eager-catalog strategy.
Obvious Live domain operations must be added as actions on their canonical
grouped tool rather than left as direct tools merely because the grouped branch
did not already exist. Superseded direct names must not be registered beside
their canonical grouped action. Separate public tools are reserved for
specialized adapters or application workflows whose capability, restoration,
revision, or asynchronous-job semantics do not fit the ordinary domain
contract.

The schema transmitted to the SDK must be the application-owned wire contract,
not an accidental projection that drops runtime-only refinements. Constraints
that JSON Schema can express, including required-field alternatives and strict
identity variants, are emitted structurally. Relational constraints that JSON
Schema cannot express, such as cross-field ordering or uniqueness by one object
field, remain explicit semantic preconditions in the tool description and
runtime validator. A grouped tool remains a root `type: object` schema and
advertises the complete action enum at the root while `oneOf` carries each
complete action branch; function-tool runtimes may omit a top-level union that
does not declare an object root. Invalid model-authored arguments fail before
connection, authorization, queueing, or mutation with
`invalid_tool_arguments`, `retryable: true`, bounded issue paths, valid
actions, and the selected branch's expected shape.
