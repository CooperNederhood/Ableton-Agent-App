# Playback Listening Developer Dogfood

## Target and limits

The target is useful developer feedback, not general release certification.
Use copies of projects and audio you own or generated test audio.

Initial dogfood scope is Arrangement playback plus descriptive analysis, captures
up to 30 seconds, constant tempo, and the default descriptive timing policy
(64 samples). Keep that default initially so failures are comparable.
Do not depend on exact physical onset timing, exclusive clip attribution,
Session listening, transcription, pitch/key recognition, or tempo automation.
Tempo-change work is deferred to issue #55.

Real controlled runs have completed 30-second captures, retained track/range
context, read it back in a fresh process, and preserved playback/connection
postconditions. The latest normal saved bundle and visible app handoff still
need validation. This document is a test plan, not a claim those gates passed.

## Before developer handoff

- [ ] Freeze and normally save the final device bundle, retaining its sibling
      resources; verify the saved references and packaged source identity.
- [ ] Bind discovery to the intended normal Desktop profile through the shared
      storage resolver, not a preparation-only automation profile. Verify normal
      app connection; a runner's disposable discovery rewrite is not this proof.
- [ ] Run ordinary, non-instrumented short fractional and 30-second captures.
      Require real signal, correct track/range, durable retrieval and cleanup.
- [ ] Exercise the visible app's successful capture plus an actionable
      failure/cancellation path with isolated runner-owned processes.
- [ ] Record the exact app/device revision, Live version and sample rate for
      the developer build. Do not silently promote the prototype to globally
      qualified or physically precise.

These are the bounded handoff gates. Exhaustive diagnostic and hardware-matrix
qualification is not a prerequisite for developer use unless it exposes a
functional, safety, persistence or recovery defect.

## First dogfood pass

For each row, record pass/fail and the captured pass/context or History trace ID
when available. Start with a simple constant-tempo Arrangement at 48 kHz.

| Check | What to do | Expected outcome / bug signal |
| --- | --- | --- |
| Basic usefulness | Listen to a short region containing obvious audio. Ask for loudness/dynamics and brightness, then retrieve the saved result. | A terminal completed pass and matching track/range context, not just queued acceptance or confident assistant prose. Clearly audible input must not inexplicably become empty analysis. |
| Musical contrast | Capture comparable regions of silence, sustained sound and percussive sound. | Measurements and descriptions broadly distinguish the inputs. No invented pitch, transcription or exact clip ownership. A genuinely silent region is valid, not automatically a failure. |
| Correct target | Use two audibly different tracks and two different regions. Capture each explicitly. | Each result belongs to the requested listener/track/range. No swapped target or previous-pass data. |
| Boundaries and duration | Try a short nonzero/fractional range, then a 30-second range. | Requested coverage completes without a truncated tail, endless running state or unexplained timing rejection. A single capture over 30 seconds must be refused, not silently truncated or widened; an explicit multi-pass plan is different. |
| Repeatability | Repeat a region several times, including while transport is already playing. | New passes finish and retain separate identities. No reconnect requirement, stuck busy state or accidental overwrite. Exact FFT-derived summaries need not be bit-identical. |
| Persistence | Note a saved result, close normally, reopen the same saved project/app and retrieve it. | The historical result remains available with its original identity/range. Missing or misattributed context is a priority bug. |
| Cancellation and recovery | Cancel a running listening pass through its operation control, then try a short capture. | Cancellation is explicit, partial work is not advertised as complete, and the next pass works without restarting everything. Record actual playback behavior rather than assuming cancellation stops transport. |
| Missing listener | In a throwaway copy, make the requested listener unavailable, then request a capture. Restore it and retry. | Actionable refusal/failure, no fabricated completed analysis, and recovery after the listener is restored. |

Example request, adjusted to an existing listener and a constant 120 BPM Set:

> Use the listener on track "My Track" to listen to the Arrangement from bar 2
> to bar 6. Describe its loudness, dynamics and brightness, and retrieve the
> saved result when the listening pass completes. Leave playback running.
> Do not edit clips, routing or devices.

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
