# Tools

Tools are the only way the agent can see or change Ableton Live. Each tool is a
typed function registered with the Copilot SDK. When the agent calls one, the
app checks it, asks for approval if needed, and sends a command over the bridge
to our **Remote Script** (a Python script that Live loads as a control
surface). The Remote Script runs the command against Live's object model (the
**LOM**, Live Object Model) and reads back the result.

This page covers how tools are defined, the metadata each one carries, what a
result looks like, and the main tool families.

## Grouped tools and operations

There are about twenty agent-facing tools, all named `ableton_*`. Each one is a
**grouped tool**: it takes an `action` field, and each action is a separate
**operation** with its own strict input schema.

```json
{
  "action": "rename",
  "index": 2,
  "expectedReference": "6f1c…",
  "expectedName": "Bass",
  "name": "Sub Bass"
}
```

The result for that call echoes the track reference, `beforeName`,
`afterName` and `verified: true`.

Every operation has a stable **operation ID** like `tracks.rename` or
`midi_notes.add`. Agent definitions can allow whole tools (`ableton_tracks`) or
single operations (`tracks.delete`, `recording.set_*`). See
[agent.md](agent.md).

Two terms used throughout:

- **Session View** is Live's grid of clip slots (tracks × scenes) for launching
  loops. **Arrangement View** is the timeline.
- An **identity-bound** operation includes the expected reference _and_ name of
  its target (for example `expectedReference` and `expectedName`). If the
  target changed since the agent looked, the operation fails instead of editing
  the wrong thing.

## How a tool is defined

Three files in `packages/tools/src` do most of the work:

| File                      | Role                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `operation-descriptor.ts` | One **descriptor** per operation: ID, tool name, action, schemas, risk, duration, scope, capability.   |
| `index.ts`                | `createAbletonTools` calls the SDK's `defineTool` once per grouped tool and routes each action.        |
| `grouped-tool-schemas.ts` | The Zod input schemas for the grouped tools that are assembled here.                                   |

Most input/result schemas live in `packages/protocol`, so the TypeScript side
and the Remote Script agree on the same contract.

The descriptor is the single source of truth. Approval, edit-scope checks,
locking, history and observability all look up the descriptor from the call's
arguments (`resolveAbletonOperation`), never by guessing from the tool name.

### Adding an operation, end to end

1. Add the params/result schemas and command to `packages/protocol`.
2. Implement the command in the Remote Script (`remote-script/AbletonAgent/`),
   and report it as a capability in `capabilities.py`.
3. Add the bridge call in `packages/bridge/src/index.ts` (the service
   interface is in `packages/ableton-contracts`).
4. Add a descriptor in `packages/tools/src/operation-descriptor.ts`. Many
   domains use `domainOperationDescriptors`, where you just list the action
   and mark it as read, destructive, broad, long or track-scoped.
5. If it's a new grouped tool, add a `defineTool` call in `createAbletonTools`.

### Registration

At session start, `CopilotAgentService` calls `scopeAbletonTools`
(`packages/tools/src/index.ts`) to cut the full tool set down for one agent:

- drop tools and operations the agent definition doesn't allow;
- drop operations whose `requiredCapability` the connected Live doesn't report;
- rebuild each tool's schema and description so the model sees only the
  actions that remain.

Every handler is also wrapped so that it validates arguments, checks the Live
connection, turns errors into a structured failure, and records lifecycle
events (`agent.operation.requested`, `queued`, `started`, `completed`,
`failed`, ...). Mutations go through `runAuthorizedAbletonMutation` for edit
scope and locking (see [safety.md](safety.md)).

## Tool metadata

Each operation's descriptor carries:

| Field                | Values                                     | Used for                                                     |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `risk`               | `read`, `reversible`, `destructive`, `broad` | Whether to ask the user. See [safety.md](safety.md).         |
| `mutationTarget`     | `read`, `session`, `track`, `tracks`       | What must be locked and which edit scope is needed.          |
| `editScope`          | `none`, `session`, `affected-tracks`       | Whether a track-scoped agent may run it.                     |
| `duration`           | `instant`, `short`, `long`                 | `long` operations run as background jobs.                    |
| `requiredCapability` | e.g. `tracks.create`                       | Hidden if the Remote Script doesn't report it.               |
| `affectedTrackReferences` | function of the input                 | Which exact tracks to lock and check against edit scope.     |

**Read vs write:** an operation is a read when `risk` is `read`. Reads never
need approval (unless the user picks the "Always ask" policy) and are never
limited by edit scope. Everything else is a write.

## Results

- **Success**: the handler returns a JSON object matching the operation's
  result schema. Mutations read state back in Live and include the observed
  values, usually with `verified: true`. The post-tool hook adds a reminder to
  treat this as the current state.
- **Failure**: the handler returns an SDK failure result instead of throwing.
  It contains a stable `code`, `message`, `retryable` flag and bounded
  `details` (`failureToolResult` in `packages/tools/src/index.ts`). Errors are
  sanitized and bounded; stacks and credentials never reach the model.
- **Big results**: inspection results are paged and filtered. If a result is
  still too large, the SDK writes it to a file and the agent reads parts of it
  with a restricted, read-only `bash`.

## Tool families

| Family                    | Tool(s)                                              | Examples                                                                 |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| Connection and inspection | `ableton_session`                                    | connection status, inspect the whole Set                                 |
| Tracks                    | `ableton_tracks`                                     | list, create, rename, duplicate, stop clips, delete                     |
| Mixer and routing         | `ableton_mixer_routing`                              | volume, pan, sends, meters, routing options and assignment               |
| Transport and cue points  | `ableton_transport`                                  | play/stop, tempo, loop, seek, metronome, cue points                      |
| Scenes                    | `ableton_scenes`                                     | create, rename, fire, delete                                             |
| Session clips             | `ableton_session_clips`                              | create MIDI clip, replace notes, launch, duplicate, delete               |
| MIDI notes                | `ableton_midi_notes`                                 | query, add, update, remove, quantize individual notes                    |
| Arrangement               | `ableton_arrangement`                                | inspect, create MIDI clip, copy a clip to the timeline, fill a region   |
| Audio clips               | `ableton_audio_clips`, `ableton_warp_markers`        | gain, pitch, warp mode, warp markers                                     |
| Clip automation           | `ableton_clip_automation`                            | list and sample envelopes, insert a step, clear (Session clips only)     |
| Devices                   | `ableton_devices`                                    | inspect devices, parameters, racks and Drum Rack pads; set, move, enable |
| Special devices           | `ableton_special_devices`                            | Simpler markers/slices, Looper, Wavetable modulation                    |
| Browser                   | `ableton_browser`, `ableton_browser_adapters`        | search, load an item, preview, Hot-Swap                                  |
| Recording and grooves     | `ableton_recording`, `ableton_grooves`               | record modes, Capture MIDI, record a slot, Groove Pool                   |
| Selection and view        | `ableton_selection_view`                             | read or set the selected track/clip/device, show views                   |
| Live undo history         | `ableton_live_history`                               | inspect, undo, redo                                                      |
| Background jobs           | `ableton_workflow_jobs`                              | get, list, cancel long jobs (slot recording, Looper export)              |
| Listening                 | `ableton_listening`, `ableton_context`               | play and analyze audio, read stored analysis (see [listening.md](listening.md)) |
| Set History               | `set_sql_search`                                     | read-only SQL over saved snapshots and past agent actions                |

Some families are only offered when Live reports the needed capability. Private
or untested Live APIs (for example the Browser adapters) fail closed with
`unsupported_capability`.

Besides Ableton tools, the agent also gets a few application tools (`skill`,
`read_plan`, `write_plan`) and approved SDK built-ins such as `ask_user`; see
[agent.md](agent.md).

## A note on `packages/workflows`

`packages/workflows` contains planners (drum pattern, chord progression, song
section, mix change set) and a step-by-step executor with before-state capture,
verification and compensation. It is a library with its own tests; it is not
currently registered as agent tools or used by the app. Multi-step work today
is done by the agent calling single operations in sequence.

## Where to look in the code

| Topic                                 | File                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| Operation descriptors (metadata)      | `packages/tools/src/operation-descriptor.ts`          |
| Tool definitions, permission handler  | `packages/tools/src/index.ts`                         |
| Argument validation and hints         | `packages/tools/src/argument-validation.ts`           |
| Edit scope and locks                  | `packages/tools/src/mutation-policy.ts`               |
| Listening and context tools           | `packages/tools/src/listening-tools.ts`               |
| Set History SQL tool                  | `packages/tools/src/set-sql-search.ts`                |
| Wire schemas                          | `packages/protocol/src/`                              |
| Remote Script commands                | `remote-script/AbletonAgent/`                         |
| Tool wrapping and lifecycle events    | `packages/application/src/index.ts` (`#scopedAbletonTools`) |
