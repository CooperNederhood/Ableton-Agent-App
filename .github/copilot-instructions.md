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

# Testing workflows

- Start with the smallest deterministic unit, component, contract, or Playwright
  test that owns the changed behavior.
- After changing Electron UI, desktop interactions, approvals, progress/error
  presentation, or visible Ableton Agent/Ableton workflows, use the repository
  skill whose frontmatter describes visual desktop UX testing. Follow its full
  implement, build, launch, message, wait, inspect, close, fix, and repeat loop.
- After changing agent prompts, tools, workflows, bridge behavior, protocol
  handling, or exact Live mutations, use the repository skill whose frontmatter
  describes the runner-owned deterministic workflow smoke suite.
- When a change affects both exact Live behavior and visible UX, run
  deterministic integration validation first, then visual desktop UX
  validation.
- Never treat an accepted MCP message, assistant prose, or a screenshot alone
  as proof of exact Live state. Use deterministic postcondition reads when the
  requirement depends on counts, identities, ordering, MIDI content, rollback,
  or mutation scope.
- Automation must use an isolated Desktop profile and dedicated processes.
  Track and close only processes started by the validation workflow; never
  terminate or discard work from a pre-existing user process.

# Background About Ableton

- This project supports Ableton 11 **only** and we have no current plan to support 12. Project uses Ableton Suite 11.3.42 on Apple Silicon.
