# Repository-wide Copilot instructions

- Every new capability and asynchronous stage must define application-owned
  observability events for relevant queued, started, progress, completed,
  failed, and cancelled lifecycle and timing.
- Sanitize and bound payloads before persistence. The local journal must retain
  bounded prompts, assistant text, paths, structured musical/MIDI and event
  payloads, and tool definitions/arguments/results for detailed history. Redact
  credentials embedded in every string and omit binary/audio bodies with visible
  markers.
- Propagate trace, correlation, and causation IDs across SDK, tool/workflow,
  bridge, Remote Script, Live Event, Output, and UI boundaries.
- Keep records visible through typed, redacted Desktop History queries; do not
  add raw SQL/filesystem renderer access or a network upload path.
- Add tests for event coverage, ordering, redaction, attribution, timing,
  failure/cancellation, and trace propagation.
- Update the relevant specifications and implementation to-do files with every
  behavior or lifecycle change.
