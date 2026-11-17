# Listening consolidation: message-driven storage shape and counts

This user-authorized Set and its five project-owned AIFFs support four cases in
the **existing user-message acceptance runner**. Every capture and derivation
must come from a real agent turn and normal production tools. There is no
direct-operation test endpoint or substitute native-only execution.

The current milestone is matching **production storage systems, schemas and
expected logical counts**, not equal measured feature values. Numerical
equivalence, tolerance calibration and repeatability controls are deferred.

## Status and provenance

`qualification: "reviewed-live"` denotes **declared source admission**, not a
passing capture, storage-shape comparison or numerical result.

**Final storage-shape qualification is green on Live Suite 11.3.43.**

| Case        | Terminal receipt | Measures / features per context |
| ----------- | ---------------- | ------------------------------- |
| Short audio | `run-J7vvwY`     | 1 / 15                          |
| Short MIDI  | `run-U5xT9Q`     | 1 / 15                          |
| Long audio  | `run-LozNle`     | 20 / 300                        |
| Long MIDI   | `run-LkQQml`     | 20 / 300                        |

All four independently pin packaged candidate SHA-256
`c41d56b9211bf4a912fccd5940ed134d4f535d292e35a9ac4eed7996550bfabd`.
Each passes the three normal messages, all six assertions, Session/Arrangement
original persisted schemas/counts, owned restart inventories, protected state
and complete cleanup. Both long cases prove durable appends during capture.
The final candidate includes native FFT readiness, partial-write transport and
explicit-deep-inspection timeout corrections. The existing runner also waits
for this exact fixture to finish loading rather than accepting a template's
early bridge. Historical failed receipts, including `run-m1AuKA`'s pre-message
startup failure, remain failed. This qualifies 37.5 seconds, not three-to-ten
minutes, numerical feature equivalence or real-time listening.

Owned source review `consolidation-source-review-5HHNZT`, run
`b3b0c521-b40e-4b90-beb0-d6c50affc631`, verified all four Session sources and
the full five-clip audio Arrangement on Live 11.3.43. It verified the declared
loaded media/MIDI/instrument identities, baseline, candidate bindings and
installed resources without repair. Scoped review
`consolidation-source-review-xLQVW1` subsequently admitted short MIDI
Arrangement. Scoped review `consolidation-source-review-xA63fb`, run
`a7b40c03-0ff0-4237-a27c-3df84c365b33`, admitted long MIDI Session and all
twenty MIDI Arrangement clips with matching saved/loaded note hashes,
instrument/listener identities and unchanged unarmed/auto-monitoring baseline.
Every execution still verifies its current candidate and baseline independently.

After scoping deep Session inspection to scenario-used sources, message-driven
short-audio run `run-yh0GVa` passed baseline and executed `listen-session`.
The production tool rejected launch with `session_native_origin_mismatch`:
the correct clip launched at global beat 16, while the origin guard expected
clip-local beat 0 as the global anchor. No context was published; Arrangement
and restart steps remained unrun. Owned cleanup completed without finalization
failures. The existing deterministic global-16 origin regression reproduces
the rejection. This is a valid red capture test, not storage-shape qualification;
do not seek the fixture to zero or relax the alignment guard to bypass it.

The corrected runtime passed the actual six-family Session capture and derived
all fifteen features in `run-hqGE1A`, preserving global beats 16-20 separately
from clip-local 0-4. That run and subsequent `run-T6q7lP` exposed existing
STOP/Back to Arrangement harness guards, now corrected with deterministic
regressions. They remain failed comparisons. Earlier `run-2BwI5M` failed at
startup bridge readiness before any message; all processes/profile closed,
but proxy cleanup correctly remains failed. The user subsequently authorized
autonomous debugging and owned-process restarts until this short-audio case
passes through both captures, shape/count comparison and persistence restart.

**Historical pre-consolidation short audio passed in `run-DrZgBC`**, run
`485a4545-c05c-441c-9ff3-ae70f5277be6`, on Live Suite 11.3.43.
Session capture, Arrangement capture, persisted schemas/one-measure/fifteen-feature
inventories/applicable sixteen-cell grids, exactly two captures, original
contexts/features after owned Desktop restart, protected state and cleanup
all passed. `run-8yHiej`, `run-BsVhJq` and `run-gsmDAH` preserve the intervening
cleanup-verifier, hook-framing/musical-alignment and stale-installed-script
failures. This is recovered short-audio evidence, not a four-case or numerical
pass. That historical candidate used bounded observation capture and does not
qualify the consolidated stream.

**Earlier canonical qualification on Live Suite 11.3.43.** Previous-candidate
short audio (`run-qXLQNl`) and short MIDI (`run-orV5RE`) passed after long audio
(`run-HCPoEN`) and long MIDI (`run-ASzl6t`). Both views use the shared finite
native stream, original immutable chunks/manifests and common feature derivation.
Every case passed all three normal-message steps and all six assertions:
original Session capture, Arrangement capture, complete persisted feature
inventories, owned Desktop restart, original rereads, protected state and cleanup.
The short cases retain fifteen features per context; the long cases retain all
300 feature IDs and twenty complete measure shapes per original/restored context,
with durable appends before capture ends.
Earlier pagination, receipt-budget, invalid-agent-call and native failures
retain their separate failed receipts. Combined retained turns were 500,957 bytes
for long audio and 462,992 for long MIDI, below the unchanged 524,288-byte bound.
Candidate provenance remains specific to each receipt. Earlier canonical short
successes (`run-1V8iAU`, `run-MEqqU8`) do not independently qualify later changes.

- Original immutable Set SHA256:
  `2598679f4044b75e09ecb9c0105214f2c2d3b36754ea21036646bac0880c9ef5`.
- Portable `project.als` SHA256:
  `8653f285d73eeb33bbf4762ec72017fb5a470776b26de96baf35881b6267dde4`.
  Only ten audio `FileRef` blocks were relocated to project-local neutral
  targets; no notes, gains, warp, launch settings, devices or routing changed.
- The five AIFFs match approved `long-horizon-comprehension` resource hashes.
  Four have 90,000 stereo frames; the long file has 1,800,000, all 24-bit/48 kHz.
  Media rate is not proof of actual capture host rate.
- The 69 Core Library resources and two Builtin Hybrid IRs are licensed
  installed prerequisites, not redistributed assets. Preserve Blackhole,
  both returns and all processing.
- Saved listeners remain at track/device indexes 0/1 and 1/0. Shared provisioning
  binds these exact slots to the current production candidate; do not copy the
  original external User Library listener or modify the user's project.

The exact listener slots are:

| Track | Device | Saved slot                                                             |
| ----- | ------ | ---------------------------------------------------------------------- |
| 0     | 1      | `MidiTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:1`  |
| 1     | 0      | `AudioTrack:176/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0` |

`offline-reference.json` records saved topology, asset identities, relocation
proof and the source-review inventory. Offline checks validate those records;
they do not repeat loaded review or qualify listening.

## Cases and execution order

| Order | Scenario suffix | Session source                                | Same-track Arrangement | Measures |
| ----- | --------------- | --------------------------------------------- | ---------------------- | -------- |
| 1     | `short-audio`   | track 1 `2-Audio`, scene 0 `audio-1`          | Beats 0-4              | 1        |
| 2     | `short-midi`    | track 0 `1-808 Core Kit`, scene 0 `clip-1`    | Beats 0-4              | 1        |
| 3     | `long-audio`    | track 1 `2-Audio`, scene 4 `long-audio`       | Beats 0-80             | 20       |
| 4     | `long-midi`     | track 0 `1-808 Core Kit`, scene 4 `long-clip` | Beats 0-80             | 20       |

The Set is 128 BPM, 4/4: short ranges last 1.875 seconds and long ranges 37.5.
**Saved stopped transport is beat 16, not zero.** Audio track armed with
monitoring off is the reviewed baseline. Do not repair these settings. Short
Session clips loop 0-4; long clips are nonlooping 0-80; follow actions are false.

Audio Arrangement clips cover 0-4, 4-8, 8-12, 12-16 and 16-80 with resource IDs
001-005. The final clip has source loop-start 16. Its gain and long Session gain
are `0.3545654118`; the first four Arrangement clips and short Session gain are

1. Keep these differences: numerical acoustic equivalence is not this milestone.
   Saved short/long MIDI counterparts contain 14/200 notes; source verification
   must preserve note content and instrument chains.

## Test contract

Each case uses a fresh owned fixture/profile and dedicated Live 11 process:

1. A user message requests exactly one Session listen, original measurement
   access, canonical feature derivation and complete inventory.
2. Declared scoped STOP/Back to Arrangement setup precedes a second user message
   requesting exactly one corresponding Arrangement listen and the same feature
   operations. These are normal tools, not runner calls to listening hosts.
3. After owned STOP/Desktop restart, a read-only user message retrieves the
   original IDs/inventories without recapture or rederivation.

The shared runner independently checks exactly two owned published contexts,
the same canonical storage schemas and metric/feature systems, one or twenty
complete corresponding measures, expected fifteen-definition feature coverage
and counts, and matching applicable channel/vector/grid dimensions. A complete
4/4 sixteenth grid has sixteen cells. Long cases also require durable appends
before capture ends. Physical chunk counts and native window counts need not
be identical across captures; each must satisfy its own integrity contract.

Keep actual SDK/tool attribution, source/recording guards, finite deadlines,
normal approvals, protected state, persisted identities and terminal cleanup.
Do not fabricate rows, accept equally empty inventories, or translate different
production storage formats into a matching test-only representation. Assistant
claims, accepted submissions and screenshots are not correctness evidence.

Do not compare numerical feature values, distances, exact masks or acoustic
output. No calibration ID or tolerance policy gates this milestone. Historical
direct-adapter failures remain failed receipts; they are not successful captures.
The unchanged comprehension case and ten-minute/realtime claims remain separate.

All four reviewed cases are registered in `suite.json`. Source admission and
case outcomes remain separate evidence; registration and offline checks alone
are not execution qualification.

## Checks and commands

```bash
python3 integration/fixtures/listening-consolidation-suite/check_offline.py
python3 integration/fixtures/listening-consolidation-suite/check_offline.py --test
pnpm exec tsx --tsconfig tsconfig.test-runtime.json integration/fixtures/listening-consolidation-suite/check_shared.ts
pnpm test:acceptance:validate --scenario listening-consolidation-short-audio
pnpm live:acceptance --scenario listening-consolidation-short-audio
```

Real-host commands require an admitted candidate, scoped authorization and
owned-process cleanup. Offline checks do not launch Live. Never stage this README,
either checker, or runner-only reference data into the agent-visible project.
