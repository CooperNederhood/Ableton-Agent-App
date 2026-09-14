# Live 11 workflow capability ledger

The workflow-adapter layer is additive to the existing exact domain tools.
Every operation is capability-gated at handshake time, uses bounded schemas,
and fails with `unsupported_capability` when the detected Live 11 object shape
does not support the operation.

Each public action maps to a granular internal protocol command. Boolean
capabilities remain for compatibility, while `capabilityDetails` records
evidence, tested versions, and limitations. Private adapters detected on an
unvalidated Live build are reported as `private_detected_untested` and are not
advertised as supported.

The private-adapter tested-version allowlist is currently empty because the
destructive real-Live smoke matrix has not been completed in this worktree.
The implementations remain present, but Browser adapters, Session automation,
warp mutation, and specialized-device adapters fail closed until evidence for
an exact Live 11 build is recorded.

| Domain | Supported operations | Safety and verification |
|---|---|---|
| Recording | Inspect Arrangement Record, Session Record, overdub, Session automation record, and punch state; set each state; Capture MIDI to the explicit `selected-armed-tracks` destination; record an exact empty Session slot for a bounded beat duration | Global recording controls are broad approvals. Slot recording requires exact track and scene reference/name readback plus expected slot occupancy, an armed track, and a job ID. Completion is reported only after the exact created clip is observed no longer recording; quantized launch delay is not mistaken for elapsed recording duration. Launch remains a separate clip action. |
| Grooves | List/get the Groove Pool, inspect clip assignment, assign/clear a groove, edit exposed amount properties, set global groove amount | Runtime groove references are paired with a pool revision so index shifts fail stale. Creation, import, and removal are not exposed. |
| Selection/view | Read selected track, scene, clip, slot, device, and chain; select exact objects; show/hide/focus major views; follow, draw mode, fold, and collapse where exposed | Setters are semantic and identity-bound. Browser adapters save and restore track, scene, slot, clip, device, insertion mode, filter, and Hot-Swap state. |
| Live history | Inspect `canUndo`/`canRedo`; invoke undo/redo | Mutations require the literal `global-live-history` confirmation and always return a warning that Live history is global. Private undo grouping is not advertised as atomic rollback. |
| Curated state events | Transport/recording, tempo/signature, selection, track/scene/clip/device topology, routing, and meters | `events.inspect_curated_state` provides bounded initial state. `live_state.changed` is a typed event; listeners rebind after topology changes and clean up on shutdown. The entire meter path is aggressively coalesced and never advances project revision or emits `project.changed`. |
| Browser adapters | Preview/stop preview; Hot-Swap; optional adjacent insertion; optional exact empty Drum Rack pad loading | Private adapters require runtime shape checks and an exact tested-version allowlist entry. Browser and selection state, including explicit null values, are restored and identity-verified in `finally`; success is not claimed when restoration cannot be verified. Empty-chain creation and deterministic direct native insertion are not claimed. |
| Session clip automation | Discover envelope parameters, sample values, insert a bounded step, clear one envelope, clear all envelopes | Session clips only. Clear operations are destructive and require explicit confirmation. Private LOM method names remain in the Remote Script. |
| Warp markers | Inspect and add/move/remove markers | Mutations require exact clip identity and current snapshot revision, validate marker ordering, verify results, and attempt safe compensation. Segment BPM remains inspectable snapshot evidence but is not writable because a proven Live 11 setter is unavailable. |
| Specialized devices | Simpler marker/slice editing, Looper state/control/export, Wavetable modulation | Available only for exact class names and detected Live 11 members. No later-version replacement API is used. |
| Workflow jobs | Get/list/cancel timed Session recording and Looper export jobs | Bounded retained jobs emit queued, started, progress, completed, failed, cancelled, or indeterminate events with application-injected trace/correlation/causation identifiers. The originating mutation lock and application completion lifecycle remain active until a terminal job state; cancellation bypasses that held lock but is accepted only from the originating agent. Running jobs become indeterminate when the Remote Script disconnects. |

## Deliberate omissions

- Groove creation, import, and removal.
- Empty rack-chain creation.
- A claim of deterministic direct native device insertion.
- Direct Arrangement automation editing.
- Later-version Simpler replacement or device APIs.
- Arbitrary Python, reflection, raw OSC/LOM access, filesystem access, dialogs,
  or arbitrary property subscriptions.
- Atomic rollback guarantees for Live global history.
- Resampling/scene-pass and freeze/capture jobs until a Live 11 implementation
  is proven and added.
