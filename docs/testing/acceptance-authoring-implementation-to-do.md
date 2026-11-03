# Acceptance Test Authoring Implementation To-Do

Companion specification: [Acceptance test authoring](acceptance-authoring.md).

- [x] Add the development-agent-only human-in-the-loop authoring skill and concise
      review checklist, preserving the original project and requiring explicit
      human contract approval.
- [x] Make user-authored Sets the default: understand the scenario, review the
      contract, provide concrete Live preparation steps, ingest and verify the
      project, then package and run it. Remove implementation-stage instructions
      and repeated runner internals from the reusable skill.
- [x] Add a skill-local intake script using bounded reference inspection and
      shared redacted receipts. Copy only project-local referenced files; report
      external references, reject unsafe/missing inputs, and retain interrupted
      copies without modifying the original. Preserve collected Samples paths
      in fixture staging while retaining neutral media names and integrity guards.
- [x] Use the same collected-media predicate in packaged driver baseline
      selection and final media fingerprints; cover both boundaries in driver
      regression tests, not only shared staging tests.
- [x] Create an empty owner-only `Ableton Project Info` marker in each staged
      project, as the native fixture runners already do. Without it, Live 11
      failed to resolve copied type-3 media/device references despite valid files
      and hashes. Regress media, Imported and Recorded targets without changing
      saved Set bytes.
- [x] Demonstrate fresh B/A/B loading from standalone frozen devices on owned
      Live 11.3.43 / Max 8.5.8, checking the actual Node process's extracted runtime
      and configuration hashes. This proves the replacement route, not capture
      or the agreed two-turn listening case.
- [x] Integrate frozen replacement/loading enforcement into the shared driver:
      exact reviewed top-level listener bindings, immutable source plus separate
      frozen device/prepared Set, independent reconstruction, owned active Node
      extraction checks, count/placement/identity guards and bounded provenance.
      Reject stale bindings, rehashed repairs, duplicate resource names and
      unsupported placement. Keep failed attempts and scoped cleanup.
- [x] Include the declared derived Set in CLI retention after success, failure
      and cancellation; keep undeclared outputs denied and profiles excluded.
      Red/green finalization regressions preserve outcome and traced retention.
- [x] Complete full repository quality gates and the final 1,231-test
      harness/test-support owning run. Keep loading proof separate from blocked
      musical fixture admission and unrun two-turn qualification.
- [x] Wait for owned Remote Script readiness before launching Desktop; do not
      misclassify a bridge startup error as listener discovery failure. Controlled
      ordering/denial regressions failed before the fix. The shared active-runtime
      verifier passed on fresh Live 11.3.43 / Max 8.5.8, with owned cleanup.
- [x] Distinguish inactive nested `SourceContext` history from active external
      dependencies. Unresolved factory preset/IR references remain an admission
      issue, not permission to repair the Set at runtime.
- [x] Record the user's 2026-11-02 approval of `audio-track`, `clip-1`, 128 BPM
      and existing processing. Update the first-case contract/template and
      illustrative capture coverage together, retaining `(B)`, no-recapture,
      persistence, source attribution and cleanup requirements.
- [x] Resolve and verify approved factory resources in the owned environment
      before registration; do not equate approval of processing with resource
      availability or redistribution rights.
- [x] Admit pinned Live Builtin resources in place, distinguish LastPresetRef
      provenance, and read the exact saved follow-action flag when Live 11's
      public property is unavailable. Keep missing/changed evidence denied.
- [x] Fix actual CLI serialization, automation endpoint publication readiness,
      valid production listener IDs, UUID stage causation and successful native
      release/finalization evidence with lower-level regressions. Preserve earlier
      failed attempts rather than rewriting them.
- [x] Document portable approved assets, hashes, neutral agent-visible names,
      build-supplied listener dependencies, and shared fixture/scenario outputs.
- [x] Preserve the exact first listening example, independent assertions,
      persistence restart, scoped approvals, and cleanup requirements.
- [x] Separate invalid/blocked setup from valid red product tests; prohibit
      adapting the oracle to output or repairing the baseline during execution.
- [x] Document the allowlisted success/failure preservation contract, checkpoint
      before pruning, cleanup-failure recovery, final-receipt requirement, and
      bounded admission without automatic deletion of old evidence.
- [x] Confirm shared manifest/registry filenames and offline list, catalog
      validation, and schema-only template validation command examples against
      the actual tooling. Empty catalogs report pending onboarding; the separate
      template explicitly reports non-runnable despite the now-registered case.
- [x] Complete the broader foundation/driver owning deterministic validation
      and report its implementation status separately from real-host qualification.
      The combined owning run passed 2,009 tests; after the startup-readiness
      regression, the harness/test-support owning suites passed 1,179 tests.
      The real packaged Default agent completed two pinned automation turns
      with normal approvals. The first attempt exposed a premature agent query;
      the new guard has a failing-before/passing-after regression.
      The existing read-only runtime scenario passed on Live 11.3.43 with
      terminal cleanup. None of these checks qualifies the real listening case
      or attended cross-app listening UX.
- [x] Complete joint first-fixture onboarding through the skill with the user,
      addressing usability friction through shared tooling rather than a private
      bootstrap path.
- [x] Qualify the real packaged listening scenario and fresh-run isolation with
      all independent checks and terminal cleanup. No framework test substitutes
      for this result. Two fresh terminal passes on Live 11.3.43:
      `run-c27nOv`, `run-jTIy7p` (2026-11-02), all eight assertions passing.
      Persistence-only readiness does not require the intentionally invalidated
      native runtime to reconnect; initial capture admission remains mandatory.
      Its regression failed before the fix. Final `pnpm check`: 4,098 TS tests,
      819 Max tests, 286 Python tests and all build/lint/type/docs gates.
- [ ] Deliver a real UI acceptance adapter in a later phase; do not infer it from
      alternate controlled drivers.

## Same-session listening continuity (#78)

- [x] Reject duplicate pass inventories and require every capture's original
      source/context identity/content on subsequent reads. Controlled regressions
      expose first-context substitution, wrong-source joins, changed prior
      contexts, missing original publication, incomplete captures, and pass reuse.
- [x] Complete joint authoring and approval of the two-source derivative fixture.
      Keep the original identification Set/media unchanged.
- [x] Extend source-aware packaged admission, permissions, native freshness,
      explicit transition verification, and per-pass release evidence.
- [x] Register the reviewed six-capture A/A/A/A/B/A conversation,
      with five explicit stopped-zero transition turns and six non-listening
      follow-ups. Require both Live source-read brackets and accept only the two
      supported inactive slot sentinels (-2/-1), with red/green adapter coverage.
- [x] Preserve first attempt `run-5VpmX3`: complete first capture but frozen
      spectral-range assertion fails (95.09 Hz versus minimum 100 Hz).
      Independent PCM analysis diagnoses the authoring magnitude/energy weighting
      mismatch; it does not authorize changing the expected bound.
- [x] Qualify the original identification case on the same candidate:
      `run-YaPYyO`, all eight assertions pass, terminal cleanup confirmed.
- [x] Review the incorrect source-A minimum with the user and apply the approved
      50 Hz minimum; leave B and every other contract requirement unchanged.
- [x] Qualify all 17 turns in one conversation without intermediate
      resets/reloads. Preserve the red attempt and historical
      repetition failure; first-capture success is not continuity evidence.
      `run-QSnsCe`: 60 assertions pass, six captures/contexts, terminal cleanup.
      Final-candidate original case `run-1VAnU1`: eight assertions pass.
- [x] Fix explicit Session stop guidance and multi-turn History capacity with
      red/green regressions; retain per-trace/count/byte limits and redaction.
      Preserve `run-QHbXBo` and `run-Z5awFn` as failed attempts.
- [x] Preserve partial spectral attempt `run-VECZgw` and add bounded immutable
      readback failure facts without relaxing native validation.
- [ ] Deferred follow-up (outside the user-accepted #78 scope): resolve the
      intermittent native `upstream_immutable_slot_changed` cause;
      later complete captures do not erase the partial run. Additional diagnostic
      attempt `run-gcP1xA` failed before any capture at Remote Script readiness.
- [ ] Deferred follow-up (outside the user-accepted #78 scope): complete attended
      cross-app stop-workflow inspection. The separate scratch
      UX attempt stopped before submission at descriptor-publication readiness;
      owned cleanup was confirmed, but no visual pass is claimed. A bounded
      descriptor wait was added; `issue-78-stop-02` instead encountered Live's
      recovery prompt before submission. Declining recovery still requires
      approval. Preserve observer/host cleanup errors and the supplemental
      exact-PID/profile cleanup evidence; recovery data remains untouched.
