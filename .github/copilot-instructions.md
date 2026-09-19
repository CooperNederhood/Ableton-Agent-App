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
- Follow the canonical application-owned storage contract in
  [`docs/platform/local-storage.md`](../docs/platform/local-storage.md). New
  persisted data must use the shared `@ableton-agent/storage` resolver and the
  documented `~/.live-agent/profiles/{profile}` ownership layout; do not invent
  independent Electron, OS application-data, repository, or home-directory
  paths. Update that document and its implementation to-do when the layout,
  migration, retention, security, or ownership behavior changes.

## Documentation
- In `docs/`there are rich implementation details - you should consult these and understand them when adding new features as you should aim to extend existing capabilities and structures when possible, rather than roll new greenfield solutions. This avoids codebloat and ensures extensibility.

# Testing workflows

- Start with the smallest deterministic unit, component, contract, or Playwright
  test that owns the changed behavior.
- Do not only run the existing suite. Every feature or bug fix must add or
  expand regression coverage at each relevant application-owned boundary.
- Add success, failure, denial/guard, cancellation where supported, and cleanup
  coverage for every changed critical path.
- Add or update React component interaction tests for renderer behavior. Add or
  update Electron Playwright tests when behavior crosses renderer/preload/main
  boundaries or changes a critical visible workflow, window state, IPC path,
  startup mode, approval flow, progress/error presentation, or recovery path.
- Add TypeScript and Python protocol/contract coverage when schemas, commands,
  framing, capabilities, or Remote Script behavior change. Add simulator-backed
  bridge tests for authentication, sequencing, timeout, reconnect, malformed
  input, or mutation serialization behavior.
- Add tool/workflow tests with controlled failures and exact postconditions when
  agent tools, safety policy, workflows, rollback, or verification change.
- Add or expand a reviewed `integration/live-scenarios/` manifest and its
  deterministic verifier when a user-facing natural-language workflow changes
  what the agent is allowed or expected to do in real Ableton Live. Do not add
  a real-Live scenario for presentation-only changes with no Live behavior.
- After changing Electron UI, desktop interactions, approvals, progress/error
  presentation, or visible Ableton Agent/Ableton workflows, invoke the
  `desktop-ux-testing` skill. Follow its full implement, build, launch, message,
  wait, inspect, close, fix, and repeat loop.
- After changing agent prompts, tools, workflows, bridge behavior, protocol
  handling, or exact Live mutations, invoke the `integration-testing` skill for
  the runner-owned deterministic workflow smoke suite.
- When a change affects both exact Live behavior and visible UX, run
  `integration-testing` first, then `desktop-ux-testing`.
- Never treat an accepted MCP message, assistant prose, or a screenshot alone
  as proof of exact Live state. Use deterministic postcondition reads when the
  requirement depends on counts, identities, ordering, MIDI content, rollback,
  or mutation scope.
- Automation must use an isolated Desktop profile and dedicated processes.
  Track and close only processes started by the validation workflow; never
  terminate or discard work from a pre-existing user process.
- A change is not complete until the new regression tests fail without the fix,
  pass with the fix, and the smallest relevant suites have been escalated to
  their broader owning suite.

# Background About Ableton

- This project supports Ableton 11 **only** and we have no current plan to support 12. Project uses Ableton Suite 11.3.42 on Apple Silicon.
