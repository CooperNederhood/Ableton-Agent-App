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
- When adding a new user-facing agent capability, ask the user once per
  capability whether they want to use the human-in-the-loop
  `author-integration-test` workflow to create or extend a durable fixture-backed
  test for test-driven development. Offer it early, before implementation when
  practical, and reuse an existing suitable case rather than duplicating it.
  Honor an answer already given in the task; an explicit authoring request is
  already an opt-in. If the user declines or is unavailable, defer fixture
  authoring without repeatedly asking or blocking ordinary implementation and
  deterministic regression tests. Opting into authoring is not blanket
  approval to launch Live or expand real-host coverage.
- After changing Electron UI, desktop interactions, approvals, progress/error
  presentation, or visible Ableton Agent/Ableton workflows, invoke the
  `desktop-ux-testing` skill. Follow its full implement, build, launch, message,
  wait, inspect, close, fix, and repeat loop.
- When both deterministic real-Live validation and visual UX inspection are
  selected for the task, run the exact-state validation before visual
  inspection. Selecting one does not automatically require the other.
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
  This lower-layer regression requirement does not automatically expand
  real-Live coverage beyond the agreed scenarios.

# Background About Ableton

- This project supports Ableton Live 11 **only**, not Live 12. Current development
  and real-host testing use installed Ableton Live Suite 11.3.43 on Apple Silicon.
  Record the actual full Live version in validation evidence and track changes
  after automatic updates. The installed patch version is not a support pin:
  do not require an older patch, downgrade, or block work solely because a Live
  11 patch changed. Preserve historical version provenance and investigate
  actual compatibility or capability failures.

# Reminders

- We are **developing** this App. So there is absolutely no concern about supporting legacy paths or functionality or backwards compatibility. When we make changes to the codebase we should always just fix forward and assume a clean break. **DO NOT** maintain code for backwards compatibility alone.
