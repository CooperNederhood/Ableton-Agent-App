# Playback Listening Developer Dogfood

## Target and limits

**Current status: not accepted for dogfood.** The delivered package failed
ordinary developer use: `68bf5bc1` exposed an unreconciled orphan App session,
and `d3987415` exhausted the coordinator deadline after native arm succeeded,
during the final App safety inspection. Both App defects are fixed in source,
with red-before/green-after regressions. The rebuilt package below includes the
fixes, but its end-to-end listening check remains **blocked**, not passed.

The fixed source passed 1,023 application/runtime/Desktop/owned-host tests,
all 12 Electron tests and 212 Python tests. The first-connect Electron test
verified visible ownership and restart restoration. A fresh reviewed short
native-runtime scenario independently verified pass
`47da7d1b-10ae-4b45-a4cb-7e5c1c2879ec`, context
`1b77622d-4fb9-4478-b6e4-c6feb00269f2`, 84,000 frames/18 windows and all nine
postconditions on Live 11.3.43. These are not packaged listening acceptance.

The exact new signed package was launched with ordinary approvals, an isolated
profile and a runner-owned copy of the saved Set. Before opening its window,
it blocked in macOS Keychain access (`SecKeychainFindGenericPassword` in the
owned startup sample). No authentication prompt was directly observed, so the
precise reason for that Keychain wait is not yet established. No listening
message was submitted and no pass/context was created. The developer was
unavailable to check or handle any OS authentication prompt; access was not
bypassed. Both owned processes were closed and the original
saved Set hash was unchanged. The next physical check requires the developer
to handle any macOS Keychain prompt for this new local signature.

The target is useful developer feedback, not general release certification.
Use copies of projects and audio you own or generated test audio.

Initial dogfood scope is Arrangement playback plus descriptive analysis, captures
up to 30 seconds, constant tempo, and the default descriptive timing policy
(64 samples). Keep that default initially so failures are comparable.
Do not depend on exact physical onset timing, exclusive clip attribution,
Session listening, transcription, pitch/key recognition, or tempo automation.
Tempo-change work is deferred to issue #55.

The normally saved bundle now passes ordinary, non-instrumented short fractional
and 30-second captures: 84,000 frames/18 windows and 1,440,000 frames/300 windows,
respectively. Both have independently validated native proof, real signal,
fresh-process typed context retrieval and all nine runner postconditions.

The isolated visible app also completed the short capture, displayed its result
and retrieved durable context. It recovered after a first pass failed with
`changed_native_spectrum_sequence` and an intervening playing-transport denial;
this is **not a clean first-attempt pass**. The failed pass remains failed.
The separate earlier group timing rejection also remains unresolved. Evidence
is retained in `max-patches/audio-listener/fixtures/native-v2-developer-dogfood-checkpoint.json`.

## Before developer handoff

- [x] Freeze and normally save the final device bundle, retaining its sibling
      resources; verify the saved references and packaged source identity.
- [x] Bind discovery to the intended normal Desktop profile through the shared
      storage resolver, not a preparation-only automation profile.
- [ ] Developer first launch: verify normal-profile app/device connection.
      Isolated automation does not prove this normal-profile connection.
- [x] Run ordinary, non-instrumented short fractional and 30-second captures.
      Require real signal, correct track/range, durable retrieval and cleanup.
- [x] Exercise visible capture and guarded failure/recovery with isolated
      runner-owned processes. Retain first-attempt failures; cancellation is
      still an exploratory developer check, not physically qualified here.
- [x] Record the exact app/device revision, Live version and sample rate for
      the developer build. Do not silently promote the prototype to globally
      qualified or physically precise.

These are the bounded handoff gates. Exhaustive diagnostic and hardware-matrix
qualification is not a prerequisite for developer use unless it exposes a
functional, safety, persistence or recovery defect.

## Local developer setup

Use the generated Apple Silicon app at `release/mac-arm64/Ableton Agent.app`;
the installed `/Applications` app is not overwritten by this workflow.
The local package was rebuilt with the first-connection and readiness-budget
fixes (`faa134a` and `349eebe`), ad-hoc signed and verified.
Its `Contents/Resources/app.asar` SHA-256 is
`78ca31e0d8230654af187bde063a1300e499dec0395760f351aa9315ca2006f2`.
The earlier `6ea0d20` package passed startup/authentication checks but failed
developer listening; those checks do not certify this new package.
This is a local developer build, not a notarized release.
The normally saved developer bundle is in
`~/Documents/Machine-Listening-Developer-Dogfood-nBR5zW/`. Open
`Machine-Listening-Developer-Dogfood-Saved.als` and keep
`Native-Listener-Candidate/` and all sibling resources together. No further
device replacement or manual save is required.

Use ordinary approval mode initially, a disposable project copy, a stopped
transport and constant 120 BPM/48 kHz. The automation walkthrough used an isolated
profile and YOLO; it is not a recommendation to disable developer approvals.
Confirm the normal app reports Connected and discovers the intended listener.
After a pass leaves playback running, explicitly stop it before another capture
when doing so is safe. An already-playing arm is currently guarded.

## First dogfood pass

For each row, record pass/fail and the captured pass/context or History trace ID
when available. Start with a simple constant-tempo Arrangement at 48 kHz.

| Check | What to do | Expected outcome / bug signal |
| --- | --- | --- |
| Basic usefulness | Listen to a short region containing obvious audio. Ask for loudness/dynamics and brightness, then retrieve the saved result. | A terminal completed pass and matching track/range context, not just queued acceptance or confident assistant prose. Clearly audible input must not inexplicably become empty analysis. |
| Musical contrast | Capture comparable regions of silence, sustained sound and percussive sound. | Measurements and descriptions broadly distinguish the inputs. No invented pitch, transcription or exact clip ownership. A genuinely silent region is valid, not automatically a failure. |
| Correct target | Use two audibly different tracks and two different regions. Capture each explicitly. | Each result belongs to the requested listener/track/range. No swapped target or previous-pass data. |
| Boundaries and duration | Try a short nonzero/fractional range, then a 30-second range. | Requested coverage completes without a truncated tail, endless running state or unexplained timing rejection. A single capture over 30 seconds must be refused, not silently truncated or widened; an explicit multi-pass plan is different. |
| Repeatability | Repeat a region several times from stopped transport; separately try an already-playing request. | Completed passes retain separate identities. Already-playing arm is explicitly refused; stop safely before retrying. No reconnect requirement, stuck busy state or accidental overwrite. Exact FFT-derived summaries need not be bit-identical. |
| Persistence | Note a saved result, close normally, reopen the same saved project/app and retrieve it. | The historical result remains available with its original identity/range. Missing or misattributed context is a priority bug. |
| Cancellation and recovery | Cancel a running listening pass through its operation control, then try a short capture. | Cancellation is explicit, partial work is not advertised as complete, and the next pass works without restarting everything. Record actual playback behavior rather than assuming cancellation stops transport. |
| Missing listener | In a throwaway copy, make the requested listener unavailable, then request a capture. Restore it and retry. | Actionable refusal/failure, no fabricated completed analysis, and recovery after the listener is restored. |

Example request, adjusted to an existing listener and a constant 120 BPM Set:

> Use the listener on track "My Track" to listen to the Arrangement from bar 2
> to bar 6. Describe its loudness, dynamics and brightness, and retrieve the
> saved result when the listening pass completes. Leave playback running.
> Do not edit clips, routing or devices. If a pass fails, report its ID and
> reason and stop; do not retry automatically. If transport is already playing,
> ask before stopping it.

This is four bars/eight seconds at 120 BPM. Check the resolved range in the
result; do not rely on the assistant's wording alone.

## Weak spots to explore next

| Area | Useful test / uncertainty |
| --- | --- |
| Real project signal paths | Try drums, instruments, effect-heavy tracks, stereo/anti-phase audio and track level/mute/solo changes. Compare analysis to the signal reaching the listener: listener placement can differ from what the master output sounds like. Record placement and routing when results surprise you. |
| Multiple listeners | Put listeners on different eligible tracks and request each explicitly. Ambiguity must be surfaced rather than capturing an arbitrary track. |
| Safety guards | On a disposable Set, try listening while recording is already active or the audio engine is unavailable. Expect a clear guard/failure, not disrupted recording or false success. |
| Interruption | Quit/disconnect the device or Live during a disposable capture. Expect terminal failure/cancellation and understandable recovery, not a permanently active pass or completed context. |
| Historical freshness | Edit the source after a capture, then retrieve the old result. It must remain historical/unknown-freshness rather than silently claiming to describe the edited audio. |
| Agent action selection | A first ordinary actor refused before making any call despite all required actions being present in its recorded schema. Scoped descriptions now make action alternatives explicit. Report false "tool unavailable" claims separately from audio failures; this remains a natural-language reliability weak spot to watch. |
| Default-agent retries and tool selection | The visible app recovered, but made failed tool attempts and retried the failed native pass after stopping transport. Do not judge only its final success: retain every failed pass/reason, keep approvals enabled and request no automatic retry when collecting a reproduction. This walkthrough does not establish clean first-attempt reliability. |
| Timing rejection reliability | One ordinary short capture passed with real signal and durable context; the next group attempt failed with `listening_alignment_budget_exceeded` after two windows, published no context and cleaned up correctly. The rejected measurement/magnitude was not retained, so neither its cause nor a suitable tolerance increase is established. Report these failures; do not silently retry until success or loosen integrity guards. The group remains failed. |
| Native spectrum rejection | The first visible-app pass failed with `changed_native_spectrum_sequence`; a later pass completed at the unchanged 64-sample default and survived fresh typed retrieval. The first failure's root cause is not established, and recovery does not erase it or justify relaxing the integrity guard. |
| Device caption | The development device still displays a prototype "Capture not enabled yet" caption even though the per-pass v2 path can complete. Treat the App's authenticated discovery/pass result as authoritative; the static caption is not a live readiness indicator or a release certification. |
| Portability | Save, close and reopen a copied project with its device resources. Missing JS/Gen/audio dependencies, reconnect failures and stale device bindings are priority bugs. |
| Rate/vector settings | Controlled positive evidence is currently 48 kHz/vector 64. Try 44.1 kHz and other practical buffer/vector settings separately and record the actual settings. Intended support and unit coverage are not physical qualification of every combination. |
| Live patch version | Current physical evidence is Live 11.3.43; the contextual target 11.3.42 is not separately qualified. Live 12 is outside scope. |
| Diagnostic completeness | The newest controlled capture succeeded but its typed History had no source write-backpressure lifecycle rows, only an explicit unknown-coverage disconnect. Whether callbacks/backpressure actually occurred is unproven. This is a documented diagnostic uncertainty, not proof audio capture failed. |

Stop normal dogfooding and prioritize a fix for wrong-target capture, unintended
Set edits, recording interference, lost/corrupt context, crashes or recovery
that requires repeatedly restarting Live. Merely imperfect descriptive wording
or absent low-level diagnostics should not be conflated with these failures.

## Useful bug report

Include the exact request, expected versus actual result, approximate time,
pass/context/trace ID, app/device revision, Live version, sample rate, track
and listener placement, region and tempo, whether transport was already
playing, and whether a clean retry worked. Capture the visible error and
relevant typed History details before restarting, when practical.

Do not send credentials, raw profile databases, private project bundles or
audio unless separately requested and deliberately approved. A minimal
reproduction using generated audio is preferable.
