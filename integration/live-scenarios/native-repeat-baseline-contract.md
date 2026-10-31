# Reviewed repeat Session fixture baseline revision

On 2026-10-25 the user explicitly approved **“Allow fixture-only beat-zero
resets”** after disclosure that the former harness `seek:false` contract
conflicted with production's stopped-beat-zero Session qualification.
`fixture-beat-zero-reset-v1` intentionally replaces that exact strict-reviewed
`betweenPasses` object; this is not an implicit relaxation or actor permission.

Only `native-dual-session-repeat-1-2-1` receives exactly two resets, each after
the preceding capture and independent native/source/context verification have
succeeded. Each reset:

1. Revalidates exact owned Live PID, fresh Live Set identity, immutable fixture
   pins, same loaded registration/binding, and both frozen clip targets.
2. Denies recording, queued launches, unknown source state, or changed identity.
3. Stops clips only on the exact fixture instrument track, unquantized, using
   the existing typed track adapter; confirms its receipt.
4. Revalidates identity/source/recording before stopping transport.
5. Revalidates identity/source/recording and stopped safe transport before
   calling the existing typed transport adapter with exactly
   `{action:"seek",time:0}`. This is harness fixture setup, not capture recovery.
6. Confirms the position receipt is stopped0 with otherwise identical transport
   settings; independently reads stopped0, both clips not playing/triggered/
   recording and no queued launch, unchanged musical/device/launch settings,
   immutable Set/resource bytes, and identical connection/instance/binding.
7. Enables the next actor only after all checks succeed.

No new production API or guard is introduced. In particular, the
`session_launch_case_unqualified` production guard remains unchanged.
Generic nonzero Arrangement baselines and actor tool/risk/mutation allowlists
remain unchanged. Actors cannot stop, seek, retry, repair or reset. Final
capture cleanup still leaves transport alone; resets never run on failure or
as cleanup, and partial setup failures are preserved without rollback/retry.

The red-before deterministic test reproduces the prior nonzero stopped-anchor
refusal. Owning tests cover exact three-pass order, two reset sequences,
foreign Set/source/PID, recording, stop denial/unconfirmed receipt, unapplied
or partially applied position, changed settings, queued launch, no later actor
after failure, and fixture retention until process closure.

## Failure evidence only

Every baseline mutation records its exact bounded/redacted typed request and
flushes the journal before dispatch. Original receipts/errors remain retained.
On an operation failure, exactly one diagnostic round checks owned PID/Set
identity, then reads exact-track `get`, the two frozen Session sources,
bounded transport `get` (limit1), and listening-context recording/transport
state. Each read is independently bounded to three seconds and records its
result or separate error in application-owned lifecycle events. No retry,
repair, additional mutation, actor or interpretation of conflict as success
is permitted, even if the later state shows that the stop applied. Unavailable
diagnostics never replace the original operation error. This adds read-only
harness evidence, not actor authority or a production adapter change.
