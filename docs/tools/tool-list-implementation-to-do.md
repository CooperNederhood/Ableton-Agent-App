# Tool List Implementation To-Do

Companion reference: [Ableton Tool List](tool-list.md)

- [x] List every registered Ableton tool.
- [x] Group tools by broad Ableton workflow area.
- [x] Document purpose, risk, edit scope, duration, and key inputs.
- [x] Document source audio metadata/warp-marker and input/output meter coverage.
- [x] Verify track clip-stop effects on the next Live tick with identity
  revalidation and request-attributed progress/timing. Reproduce stale
  immediate-state rejection before correction; cover unconfirmed/unavailable
  state, replaced identity and queued cancellation without repeating mutations.
- [x] Reproduce delayed stopped-transport seek settlement before correction.
  Dispatch once and verify position, stopped state and Song identity next tick;
  preserve playing-seek behavior. Cover stale position, intervening playback,
  replaced Song, queued cancellation and attributed lifecycle without an
  unverified compensating seek.
- [x] Document ordinary descriptive Arrangement policy/geometry, guarded
  positioning, truthful approximate output, strict legacy compatibility and
  leave-running cleanup without claiming native v2 qualification.
- [x] Document assumed constant tempo, unsupported automation and deferred
  guaranteed change detection without weakening existing guards.
- [x] Preserve the shared bounded failure-evidence DTO across coordinator,
  public host and tool jobs; validate pass/trace ownership and retain primary
  evidence before cleanup. Cover absent/malformed/foreign evidence, redaction,
  exact application decision operands, timed cleanup, cancellation and recovery.
- [x] Accept validated source evidence as `ListeningFailure`'s optional third
  argument so runtime stage wrappers retain the source check and operands;
  preserve source component attribution, typed application guard descriptors
  and existing error codes.
- [x] Reuse the shared bounded error-evidence reader for aggregate/cause chains;
  test accessor refusal and cycle/depth coverage gaps without invoking getters.
- [x] Keep validated source component/phase immutable during normalization;
  downgrade complete coverage for unavailable actual/expected operands and
  mark oversized guard strings unavailable instead of silently clipping them.
- [x] Document the application rejection inventory, pre-pass attempt telemetry
  without fabricated pass IDs, explicit coverage gaps, and fresh-per-pass
  commissioning semantics in listener inspection and agent guidance.
- [ ] Complete the cross-owner real-journal/typed History, SDK and Desktop
  end-to-end observability release gate; application/tool unit evidence alone
  does not qualify a native capture or the user's current Session Set.
- [x] Verify the shared owner's canonical sanitizer fix for prefixed assignments
  and idempotence: `failed: password=value` redacts the credential, and
  re-sanitizing `password=[REDACTED]` does not append another closing bracket.
  No tool-local sanitizer copy was introduced.
- [x] Add owner-scoped read-only `context.report` with deterministic bounded
  musical-row paging, strict stacked-value DTO validation and metric-only guards.
  Reuse operation lifecycle, privacy and trace boundaries; retain ordinary
  legacy get behavior and the independent production-capture commissioning gate.
  Verify omitted paging defaults at the SDK boundary, ordered timed read events,
  and redacted serialized report failures producing failed rather than completed
  terminal operation events.
- [x] Bound the full typed metric context response to 64 KiB UTF-8 JSON, rejecting
  entry and report-metadata overflow without partial success and preserving the
  invoking App session, agent, trace and failed lifecycle. Consume the protocol
  owner's canonical 48 KiB report schema instead of duplicating its DTO.
- [ ] Enable optional listening/context services only after the device, timing,
  attribution, persistence/resume, and isolated workflow validation gates.
- [x] Explain identity-bound targeting and custom-agent wildcard selection.
- [~] Replace obvious direct tool families with canonical grouped action
  tables and document every specialized tool intentionally kept separate.
- [x] Keep this reference synchronized when
  `packages/tools/src/index.ts` changes.
- [x] Document the agent-facing Drum Rack pad and Session MIDI creation
  actions, direct versus destination track identities, explicit note-expression
  loss choice, and exact parameter-name handoff.
