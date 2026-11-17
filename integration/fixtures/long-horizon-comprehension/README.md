# Long-horizon comprehension fixture

## Authoring status

The user approved this Set and its five project-local AIFF files as repository
test assets. Owned loaded-source review and manifest registration are complete.
**Latest requalification passed in `run-V9AxDB` on Live Suite 11.3.43.**
The unchanged natural message produced exactly four complete 90,000-frame
Session captures and one complete 1,800,000-frame Arrangement, all six metric
families without missing records, the exact twenty-measure answer without prose,
unchanged protected state, persisted evidence and complete owned cleanup.
There were no agent tool failures. The terminal receipt is
`.test-artifacts/acceptance/run-V9AxDB/receipt.json`.
Candidate `app.asar` SHA256:
`d2049f9553fb038d1c7cedadf0efe080e8ffb9cec36e8eb72766835a53e73233`;
active frozen listener SHA256:
`990bc8b0f99a99e18a10c60c9f0ae396700db310833c6d504fbc2e384e2c3fc4`.
Total runtime was 675.480 seconds. The same candidate also passes the original
three-minute Arrangement case in `run-RVpd1e`. This is recovered bounded
qualification after the failures below, not first-attempt reliability,
numerical equivalence between capture views or ten-minute qualification.

**Earlier real-host comprehension passed in `run-EPE87H` on Live Suite 11.3.43.**
The existing natural-message runner independently verified exactly four complete
90,000-frame Session captures and one complete 1,800,000-frame Arrangement,
all six metric families without missing records, the exact twenty-measure answer
with no prose, protected state, persisted final evidence and complete cleanup.
The historical terminal receipt is
`.test-artifacts/fixture-authoring/retained-acceptance/run-EPE87H/receipt.json`.
Candidate `app.asar` SHA256:
`79d7aefde7c729beca602d3466a3c238383ed0144bcc21c1810a45d7827a22cd`;
active frozen listener SHA256:
`885e29b04711e521f3b7a09228fa4d33ca7faa8427b3f8e33623ad5c890b5089`.
Total runtime was 950.8 seconds; the agent turn took 599.4 seconds within the
approved thirty-minute allowance. This does not prove that more time alone
fixed the earlier failures. This fixture is twenty measures / 37.5 seconds,
not the original three-minute recording or ten-minute support qualification.
The normal installed app was not replaced.

## Preserved failures and approved follow-on changes

`run-dpVv8M` reached the correct answer after five completed captures, but
independent final collection and cleanup evidence failed when runner bridge
diagnostics filled their inventory. The failed receipt remains preserved;
fresh complete verification was required at that checkpoint.
Earlier budget-limited `run-HFt0eC` completed all five captures with responsive summary reads
but exhausted the unchanged fifteen-minute analysis turn without an answer.
Those attempts remain failed; the later pass does not rewrite their verdicts.

On 2026-11-16 the user authorized a fresh run on the consolidated candidate with
a larger finite budget: thirty minutes for the single agent turn, thirty-five
minutes overall, and two minutes each for cleanup and persistence. Only those
time allowances change. The message, exact answer, five-capture limit, scoped
permissions, source/native evidence and protected-state/cleanup checks remain.
This tests whether additional time permits completion; it does not presume
that the earlier analysis was converging or establish an efficiency target.

The authorized rerun `run-BMEXv8` failed on Live Suite 11.3.43 with consolidated
candidate `c41d56b9211bf4a912fccd5940ed134d4f535d292e35a9ac4eed7996550bfabd`.
The isolated Desktop recorded the thirty-minute turn setting, but the complete
attempt lasted only 236.7 seconds. `clip-1` completed; launching `clip-2` failed
with `session_native_origin_mismatch` before publishing a second context.
Listener cancellation/disarm then reported disconnect/cleanup errors. The agent
made further failed listening calls and requested an unreviewed seek to beat
zero, producing terminal `Unexpected approval: no reviewed scoped rule matched`.
All owned processes, profile and host reservation closed; final evidence persisted.
The comprehension comparison and exact-answer assertions were never reached.
This is not evidence that more analysis time is insufficient or that it would
have succeeded: a consecutive-Session capture failure blocked the experiment.
Keep that native/source guard and the denied recovery visible, rather than
permitting transport rewinds to conceal the preceding capture failure.

The corrected runtime uses the stable track slot state: Session slots and Clip
Stop (`-2`) restart at zero, while idle/Arrangement (`-1`) retains the stopped
song anchor. Four source/full-host regressions reproduce the old error; 361
runtime tests pass. Candidate
`35378da8678deacbe909dc77ed97f462349332484d2be8ddc586d663cbc2cdfa`
then completed all four Session captures and the full Arrangement in
`run-Mqrk1q`, without origin, capture or disarm failure. That attempt remains
failed: the agent requested a fifth Stop after the Arrangement, exceeding the
old four-Stop allowlist before returning an answer. The user explicitly approved
up to five scoped `set-playing(false)` calls for a fresh attempt, one per listen.
No seek, extra capture, answer, media or other permission guard changed.

`run-iUomM1` also completed all five captures, then failed after 283.5 seconds
because the harness attributed Arrangement derivation only through a step-level
`sourceId`, absent from this natural single-message case. The user approved one
feature derivation for that original Arrangement context, in addition to the
four Session contexts, and subsequent analysis/time budget relaxation. The
existing harness now reuses the canonical scenario Arrangement selector when
no step-level source is named, then checks the original record's admitted
track/listener, invoking job/trace/context/range ownership and per-source
approval limits for mixed-view batches. No captures, fixture data, prompts,
expected answers or source mutations change. The earlier failed verdict stands.

`run-MDLz5X` completed the five captures and reached an incorrect final answer,
substituting clip 4 for clip 1 and adding prose. It remains failed. Its independent
evidence collection also hit an obsolete short-diagnostic retention limit, then
fallback History exceeded an unrelated five-second cap. Owned processes/profile
closed, but History cleanup failed. The existing driver now verifies original
chunks without retaining unused whole diagnostic arrays for comprehension and
uses the reviewed remaining cleanup deadline. Generic tool guidance points to
the existing `featureType` filter and exact metadata binding after the agent
misidentified feature families by inventory position. The fixture, five captures
and exact-answer contract remain unchanged.

`run-IZxa27` subsequently completed all four Session captures but lost the
Arrangement listener during publication. Producer diagnostics reported
`invalid_metric_listener_payload` / `Metric lifecycle stage or ownership mismatch`;
native cleanup was unconfirmed, while overall owned process/profile cleanup
completed. Preserve that failed attempt. The runtime now forwards the existing
bounded SDK message-type/status diagnostic fields; the exact intermittent
publication cause remains unresolved and did not recur in `run-EPE87H`.
The passing run is bounded qualification, not an unrestricted reliability claim.

Final requalification `run-p8rKGl` used the same app candidate pinned above and
the cleaned existing driver on Live Suite 11.3.43. `clip-1` completed and
published its original context. The agent issued track Stop Clips without
stopping global transport, then attempted `clip-2`. Both inspection brackets
still reported `transportPlaying: true`, so normal admission rejected it with
`session_launch_state_unknown_or_active` before launch. The agent subsequently
stopped transport/clips, then requested unreviewed `set-playing(true)`;
the runner correctly denied that approval. The attempt failed after 227.8
seconds overall, without the other required captures or a final answer.
History/evidence persisted and Desktop, Live, profile and reservation cleanup
completed. No native origin mismatch was observed. This is a sequencing/agent
compliance failure, not another demonstrated long-capture defect or permission
to relax the guard, add a playback-start approval or silently retry.

Direct follow-up confirmed that subsequent unchanged-argument calls were blocked
by the existing non-retryable failure policy, not fresh source inspections.
That policy remains unchanged. Generic preparation guidance unnecessarily asked
for deselection of remembered clips, although stopped remembered Session sources
are supported. Preparation now requires the actual stopped-transport condition
without that redundant mutation. One shared clip-stop/transport explanation also
appears in track descriptions and successful Clip Stop hook context; Clip Stop
does not stop transport, and listening owns clip launch/playback start. Four
deterministic regressions fail without these changes; the owning tool, hook and
acceptance suites pass 572 tests. The fixture, message, permissions, five-capture
limit and answer oracle are unchanged.

`run-nJKfoL` used candidate `app.asar` SHA256
`208b49000e3a9ed81b65385ae3ea55557bf5d856b683ac4043e635878600511a`
on Live Suite 11.3.43. Four Session captures and one complete Arrangement
capture published with all six metric families and no agent tool failures.
The answer mislabeled measure four as clip 2, while correctly labeling the
other nineteen measures. The exact-answer assertion failed; the attempt remains
failed after 1,159.299 seconds. Evidence persisted and all owned cleanup completed.
Frozen listener SHA256:
`398c10586664742171deece3ef8b3629a1b0db9b0f01823766f61c7fa02de6d3`.

The user approved correcting the existing comparison calculator, not adding a
classifier or teaching this fixture's answer. Controlled independently captured
bar-versus-Arrangement tests reproduce phase and edge-mask refusals before the
fix. Musical grids now compare their shared valid dimensions, ignoring only
analysis-window phase in otherwise identical profile settings, and renormalize
joint-L2 subvectors over the shared values. Pair comparison and persisted search
report explicit compared/total value coverage through the typed agent tools.
Original measurements and feature vectors remain unchanged; incompatible
algorithms, musical grids, no common data, zero-norm shared subvectors and strict
summary-support guards remain explicit.

Comparator candidate `app.asar` SHA256
`50361e2e59603d2b3cedb3be00e2375f2a1c66d0ff7cbb1f22ecadce9e4fbcb5`
completed all five captures in `run-F2Gi6p` without agent tool failures.
It still failed after 795.646 seconds: the agent selected level-grid comparisons,
confused the clip-1 material with clip 4, and included unrequested prose.
Evidence persisted and all owned cleanup completed. An offline replay of this
attempt's retained records through the production comparator admits the mel-grid
comparisons and distinguishes all twenty measures; level envelopes alone do not.
That diagnostic is not a passing acceptance result or numerical-equivalence
qualification. Generic feature descriptions now distinguish loudness envelopes
from time-frequency content, with an arithmetic counterexample and red/green
tool-contract tests. No classifier, fixture labels or oracle instructions were
added.

`run-LuBbBh` tested candidate `app.asar` SHA256
`26002b99884b756413833ed75e3762fcffd8a42804b13ff2fac9c3de4df4ac75`
on Live Suite 11.3.43, with frozen listener SHA256
`af193ddba26665e3952325a17dbd46f58a5cb89357a318094f93a9b072e55547`.
It again completed all five captures without tool failures, but returned the
same incorrect labels and unrequested prose; the terminal attempt failed after
864.334 seconds, with evidence persisted and complete owned cleanup.
The comparison guidance was only in action-schema descriptions. It is now
consolidated once in the top-level agent-facing context-tool description,
with a red/green boundary test; generic measurement-reporting instructions also
explicitly defer to the user's requested response format. This does not establish
why the model ignored the earlier action guidance. Subsequent `run-V9AxDB`
passed on the consolidated contract; the two failed attempts remain preserved,
not reclassified. The calculator, persisted search, typed tools and acceptance
owning suites pass 1,824 tests after the final changes.

## Asset intake

The original project is
`long-horizon-comprehension Project/long-horizon-comprehension.als`.
The original Set SHA256 is
`0eeb476c4ea3bc8b49f218d268dc507b1524abb6a6d8c7176d044007e3a51e4b`.
The portable repository `project.als` has SHA256
`77001f0352ebb173d23603df5613ff208823c9d2007e2d7fdcfbf0092fa9605f`.
Exactly five project-local FileRef blocks use neutral staged
`Samples/Imported/resource-001.aif` through `resource-005.aif` paths and cleared
absolute paths. All other uncompressed Set XML is unchanged, and all five AIFF
files retain their original bytes. The user's original project was not modified.

## Reviewed scenario

One natural request asks the Default agent to listen to MIDI Session
`clip-1` through `clip-4` on `1-808 Core Kit`, then identify their sequence in
the Arrangement on `2-Audio`. Exactly five complete listens are required:
one for each Session clip and one for the entire Arrangement.

Each Session clip is four beats long. The Arrangement is one consolidated
audio clip over beats 0-80, or twenty measures at 128 BPM. The answer has one
clip number per measure, hyphens within groups of four and vertical bars
between groups, including leading and trailing bars, without spaces.
The exact answer is runner-only oracle data, never agent-visible instructions.

## Assets and prerequisites

- Four stereo, 24-bit, 48 kHz crop files retain 90,000 sample frames each.
- The consolidated stereo, 24-bit, 48 kHz file retains 1,800,000 frames.
- Preserve the audio track's four Session clips, every MIDI note, both return
  tracks, routing, Hybrid processing and the Blackhole plug-in.
- The 69 active Core Library sample references and two Builtin Hybrid impulse
  responses are installed Live prerequisites, not redistributed assets.
  Their installed bytes were independently hashed during intake.
- Live 11 and the required Blackhole plug-in must be available. Record the
  actual full Live version and host sample rate during loaded review.

The two top-level listener slots are bound to the packaged candidate during
staging: MIDI track 0, device 1, and audio track 1, device 0. No musical,
quantization or transport settings may be silently repaired to admit a run.
Independent review on Live Suite 11.3.43 confirmed all four MIDI identities,
the shared instrument chain and both listeners. The saved global Arrangement
override is explicitly recorded in the initial baseline, not silently cleared.

## Execution boundary

Use the shared packaged acceptance runner, a fresh isolated Desktop profile
and only runner-owned Live processes after the user's normal Live is closed.
Do not inject stop/reset actions between the five listens, coach the agent,
retry a failed capture, or substitute several Arrangement segments for the
single requested Arrangement listen.

Require independent source, sample-coverage, native proof, original context,
ownership and cleanup evidence for every listen, plus the exact terminal
answer and protected-state checks. A correct answer with any failed, missing,
extra, foreign or unclean pass is a failure.

The original installed-candidate baseline exposed consecutive Session preparation
failure. Later candidates completed all five captures, but analysis attempted
extra captures and did not produce the required answer. Those are failures,
not qualification or reproduction of the historical launch timeout.
