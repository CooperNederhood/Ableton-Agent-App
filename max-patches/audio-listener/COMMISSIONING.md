# Isolated native commissioning harness

## Inactive Session transport candidate (wire 3, native ABI 2)

`build-native-authored --source <authored.amxd> --out <empty-staging-directory>
--native-version 3` explicitly stages the Session candidate only; it does not
install, promote, or qualify a device. V1/V2 packaging remains unchanged.
The candidate selects `audio_listener_native_v3_max.js`, the v3 watchdog, and
the **same generated ABI2 DSP/IO graph** as v2. The descriptor algorithm remains
`2.0.0`, and observations remain raw global-coordinate `audio-observation/v2`.

Negotiation requires listener version `3`, capability
`audio-listener/session-v1`, and scope `session-transport-coupled/v1`.
Prepare freezes `{geometry, timingPolicy, source}`; `source` is
`{mode: "session", synchronization: "transport-coupled-first-iteration",
target: <exact bounded Session clip target>}`. Duration is at most four beats;
all v2 rate/vector/hop/window/duration bounds remain in force.
Native arm/launch/capture evidence uses explicit `{scope, source, transport}`
wrappers. `transport` is independently validated, unchanged v2 evidence, **not
a relabelled Session proof**.

This branch measures only the first transport movement from stopped at the
frozen `geometry.startBeat`. Source metadata is expected context, never native
clip identity/onset evidence. The application must independently join actual
`Clip.start_time`, exact active clip and source epoch to the same origin, and
fail any mismatch before storing a Session observation. No delayed-source
buffer, second recorder, physical timing qualification, or Session agent-tool
availability is implied. The production shared SDK now negotiates this exact
candidate and retains bounded ownership, immutable source context and ABI2
wrapper guards. Authenticated synthetic runtime/typed-ingress tests cover the
wire path, not actual host execution. The application source join and physical
qualification remain independent requirements.

## Commissioning harness status

**Implemented portable source; not executed in Max or Live. Production timing
remains UNVERIFIED and readiness BLOCKED.** Node fixtures, simulated packets,
GenExpr models, source parity and artifact checks do not establish actual DSP
functionality, latency, host timing or readiness.

This standalone-Max harness is a separate engineering path. It bypasses neither
the production readiness check nor its certificate policy: it has no production
client, producer identity, profile configuration, credential reader, network
transport, context repository, production capture commands or pass identifiers.
It does not read a commissioning report to authorize production. No certificate
file is read, and no production listener is included in the artifact.

## Build and check without opening either application

From the repository root, with the existing development dependencies:

```sh
node scripts/audio-listener-device.mjs check-calibration
node scripts/audio-listener-device.mjs build-calibration --out /tmp/runner-native-commissioning
node scripts/audio-listener-device.mjs check-calibration-artifact /tmp/runner-native-commissioning
node --import tsx --test max-patches/audio-listener/*.test.cjs max-patches/audio-listener/*.test.mjs
```

The staging directory must be explicit, empty and separate from canonical
sources and the production artifact. This is staging, **not installation**.
Neither builder command starts a process, enables DSP, launches a clip, opens a
device, or changes Live. No dependency manifest/lockfile changes are required.

The checked artifact has these **13 resources**, plus
`calibration-manifest.json`:

- `Audio-Listener-Commissioning.maxpat`
- `calibration_clock.gendsp`
- `calibration_controller.js`, `calibration_guard.js`, `calibration_report.js`
- `package.json` (CommonJS declaration only; no dependencies)
- `audio_listener_analysis.maxpat`, `audio_listener_spectrum.maxpat`,
  `audio_listener_envelope.gendsp`, `audio_listener_spectrum_energy.gendsp`
- `commission-silence.wav`, `commission-quarter-sine.wav`,
  `commission-anti-phase-quarter-sine.wav`

All four native analysis resources are copied **byte-exact** from the production
source; the calibration graph does not reimplement the analyzer. The builder
uses the common resource publisher and imports the independent, read-only
`packages/test-support/src/listening-fixture.ts` generator in development only.
There is no shipped TypeScript/package dependency. Fixtures are known generated
input, not user recordings: stereo PCM16, 48 kHz, 96,000 frames / two seconds.
The tones are gated 440 Hz sine waves, either identical channels or anti-phase.
The manifest records byte counts and SHA-256 for every resource, fixture hashes
and independent reference peak/RMS. It always declares
`realDeviceValidated:false`.

Startup rejects missing, changed, duplicate, oversized, nonregular or unexpected
resources. Do not combine the staging folder with production resources or place
unrelated files in it. The artifact checker additionally compares all executable
resources and native graphs to owned source. Hash checks establish artifact
integrity against this manifest, **not independent device attestation**.

## Loading instructions — runner-owned instance only

These instructions have not been exercised against a real Max instance.

1. Independently identify/attest a disposable **runner-owned standalone Max
   process**, its audio device, Max/Node versions, and artifact hashes. Operator
   acknowledgement below is not PID or ownership attestation. Do not use the
   user's Max, Live, audio-listener device, audio device configuration or set.
2. Check the staged artifact. In the verified runner Max process only, open the
   staged `Audio-Listener-Commissioning.maxpat`, not the repository source patch.
   Keep every resource adjacent. Ensure no conflicting same-named abstractions
   are resolving elsewhere on Max's search path.
3. Inspect the Max console and Node-for-Max status. Verify successful compilation
   of the actual `poly~`, `pfft~` and both original Gen analyzers and the reference
   clock; a missing/failed object must block the run. Confirm actual loaded paths
   against the checked artifact, not merely its name. Retain console evidence.
4. Set/enable DSP **manually in this isolated runner**, at 48 kHz. No harness
   control toggles DSP or connects to a speaker: there is no `dac~`, `ezdac~`,
   `plugin~`, or `plugout~`. Actual signal and I/O vector sizes come from
   `dspstate~`, not guessed defaults. Open a fresh harness for commissioning;
   the local sample clock runs whenever DSP is processing and long-running
   floating-point signal counter precision is not certified.
5. Send `authorize runner-owned`, then choose a fixture. Inspect actual
   `buffer~`/`info~` evidence: 48 kHz, 2,000 ms, two channels and the expected
   filename. Start only after load completion and valid DSP metadata.
6. Send `start`; wait for native reset and stop acknowledgements. Then `report`
   writes the bounded descriptor report to
   `<artifact>/native-commissioning-report.json`. Copy each report and the
   manifest to the runner's engineering evidence location before the next run:
   this local report is replaced, not appended to a context history.
7. Repeat for all three fixtures and each supported vector/driver configuration.
   Test cancellation, DSP stop/change, dropped Node heartbeat, actual queue gaps
   and shutdown. Re-run the artifact checker after each report export.

### Local controls

The visible message boxes send `authorize runner-owned`, `fixture silence`,
`start`, `cancel`, `report` into the **calibration** Node object. Change/send the
fixture message to `fixture quarter-sine` or
`fixture anti-phase-quarter-sine` to select the other fixed fixtures. Unknown
fixture names, arbitrary file paths and missing ownership/load/DSP evidence
cannot start a case.

- `start`: resets the analyzer and native clock epoch, then enables the finite
  source gate and unmutes analysis. A guard notice alone is **not** the reset
  acknowledgement; the collector waits for the epoch observed in native signals.
- `cancel`: disables the source, mutes/resets analysis and clears the fixture
  buffer, including when still loading. A running case waits for a native stop
  epoch before its cancelled report is available.
- `report`: exports only an available strict report. A premature/invalid command
  rejects input and fails an active case closed; it does not export partial raw
  data or force successful completion.
- Internal `dsp`, `loaded`, `frame`, `guard-event`, `heartbeat`, `configure`,
  `begin`, `stop`, `load` are graph messages, not production preparation APIs.

Loading has a 3-second timeout. The independent classic Max-JS guard mutes,
resets, disables PCM and clears the buffer after 2 seconds without heartbeat or
a 10-second case budget, even if Node has stalled. Collector watchdog is also
10 seconds. Native stop acknowledgement has a 1-second budget; absence produces
`failed/missing_reset_marker`, never collected. Before a case has valid DSP and
fixture evidence, startup/load errors are bounded notices, not invented reports
with fabricated native markers.

## Native signal path and coordinates

`buffer~ #0-commission-fixture 0 2` loads only a checked fixture. Native
`gen~ calibration_clock` provides integer source position and finite active
gate; stereo `index~` channel 1/2 feeds separate `*~` gates and the exact
`poly~ audio_listener_analysis 1 @parallel 0`. There is no channel downmix.
Buffer bounds are enforced by the native active gate, not assumed out-of-range
`index~` behavior.

The analyzer uses the original 2,048-sample FFT and energy pooling, plus
4,800-sample / 100 ms peak-RMS windows at 48 kHz. The latest completed FFT
centroid is not an envelope-window averaged spectrum. The harness samples all
seven analyzer outputs and six native clock outputs using explicit
right-to-left triggers and `snapshot~ @offset 0`; it polls at 10 ms to reduce,
not eliminate, lost 100 ms windows. Duplicate analysis counters are ignored;
missing windows fail instead of interpolation or synthesized replacements.

The clock supplies `dspSample`, `vectorIndex`, `vectorOffset`, `resetEpoch`,
`resetSample`, and the finite `sourceActive` gate. Epoch application records
`resetSample` **in Gen on a DSP sample**, not from Node receipt time. The start
and stop markers describe the first observed packet for each applied epoch;
their `dspSample` is an observation coordinate, while `resetSample` is the
native epoch-application coordinate. `referenceSample` subtracts those native
clock values; no wall-clock sample coordinate is invented.

**Vector markers are harness-local grouping**: floor/remainder of the local
native sample counter using the actual reported signal vector size. They are
not a certified absolute engine vector boundary, host timeline, hardware input
latency, clip/source launch coordinate or plugsync validity bit. Snapshot
atomicity, queue delay, reset/analyzer/source phase alignment, FFT alignment,
and counter precision must be checked in real Max. A positive counter and a
well-shaped JSON report alone do not prove any of these.

## Descriptor-only report contract

`calibration_report.js` exports `validateReport(value)` and
`SCHEMA="native-commissioning/v1"`. The strict report contains exactly:

```text
schema, calibrationOnly:true, nativeTiming:"UNVERIFIED", productionReady:false,
outcome:"collected"|"cancelled"|"failed", reason,
fixture:{id,sha256,sampleRate,frames},
dsp:{sampleRate,vectorSize,ioVectorSize},
resources:{<four native analysis filenames>:sha256},
markers:{start:<native marker>|null,stop:<native marker>|null},
descriptors:[{
  analysisSample,referenceSample,
  marker:{dspSample,vectorIndex,vectorOffset,resetEpoch,resetSample},
  sourceActive:boolean,peak:[L,R],rms:[L,R],centroidHz:number|null,spectralEnergy
}],
limitations:[bounded explanatory strings]
```

No waveform, arbitrary attachments, credentials, production IDs or context
fields are accepted. Numeric values must be finite and bounded; centroids
cannot exceed Nyquist, RMS cannot exceed peak, marker fields must be coherent
and epochs ordered. Successful collection needs all 20 ordered 4,800-sample
windows through 96,000 samples and a subsequent actual native reset marker.
The absolute guard is 128 points and a 65,536-byte encoded report. Export
revalidates and atomically replaces the fixed local JSON file. The collector
does not compute fixture measurements, run a JavaScript DSP model, record live
audio, or infer readiness from report success.

## Remaining real-device validation — intentionally non-circular

The separate runner can now gather engineering descriptors from real Max
signals while ordinary production preparation **continues to fail closed**.
An independent PCM verifier must compare fixture hashes and native peak/RMS,
silence, anti-phase energy and centroid values, using the actual FFT-window
semantics; it must measure snapshot/reset/window/FFT offsets and uncertainty,
not assume them from this collector or its synthetic tests. Test actual vector
sizes, gaps, watchdog/reset cleanup and resource resolution with console and
runner ownership evidence.

Standalone DSP evidence does **not** establish Live host timing. Independently
runner-owned Live validation still needs actual quantized Session/Arrangement
source launch, host-validity semantics, host/sample/vector alignment, exact
canonical-path binding, stereo pass-through and real stop/disconnect/cleanup.
No user-owned device may be mutated for this commissioning. Neither a collected
report nor a certificate file changes shipping native status or production
readiness; any eventual production gate requires a separate reviewed
implementation and independent real-device evidence.

## Executable independent numeric verifier

After a runner has produced an actual report, run this **offline, read-only**
command from the development checkout with its existing development dependencies.
The CLI uses scoped `tsx` loading on Node 20 and does not require native
TypeScript stripping:

```sh
node scripts/audio-listener-device.mjs verify-calibration-report \
  .test-artifacts/audio-listener-commissioning-2026-10-12/native-commissioning-report.json
```

The default evidence directory is the report's directory, containing the
checked calibration artifact. For a report archived outside that directory:

```sh
node scripts/audio-listener-device.mjs verify-calibration-report \
  /path/to/archived-report.json --artifact /path/to/checked-calibration-artifact
```

No real report currently exists merely because a staged artifact checks. A
missing report fails; the verifier does not synthesize one. It opens no
application and must not be used to bypass macOS permissions or interact with
the user's Live process.

API exports in `calibration-verifier.mjs`:

- `verifyCalibrationReport(value, {artifactDirectory})`
- `verifyCalibrationReportFile(path, {artifactDirectory?})`

The CLI emits `native-commissioning-verification/v1` JSON, exits **0 only when
all supported numeric/evidence checks pass**, and exits **1** on rejection.
The verdict always includes `calibrationOnly:true`,
`nativeTiming:"UNVERIFIED"`, `productionReady:false`, bounded failure codes,
individual `checked` booleans, acceptance tolerances and an explicit `unproved`
list. `passed:true` means **offline numeric acceptance only**, never commissioned
or certified. There is no production observation adapter, readiness writer,
certificate reader or client dependency.

### Checked against independent input

The verifier reuses the test-support known PCM fixture generator and its
independent whole-fixture peak/RMS references. It decodes the quantized PCM and
integrates each 4,800-sample stereo window independently; it imports neither Gen
text nor the listener's DSP model/measurement engine. The existing
test-support production observation verifier cannot consume this schema
without fabricated pass IDs and host coordinates, so it is not adapted here.
Numeric tolerances follow its policy where applicable:

- Exact 48 kHz, two-second fixture identity/hash and checked staged PCM bytes;
  report native-resource hashes must match checked source/artifact resources.
- Strict bounded report shape, ordered complete 20 windows, collected
  `fixture_end`, one subsequent reset epoch, coherent native marker fields,
  monotonic window coverage, and source-active flags consistent with the finite
  source counter. Declared reset-to-stop duration must cover the fixture and
  remain within the ten-second harness budget.
- Per-channel **per-window and whole-fixture** peak within 0.001 linear and RMS
  within 0.25 dB; independently silent windows require peak/RMS at most 1e-6.
- Silence requires null centroid and at most 1e-20 spectral energy throughout.
  Tones require positive spectral energy and centroid within **46.875 Hz**
  (two 2,048-sample FFT bins) of independent 440 Hz at four nominal steady-gate
  checkpoints, windows 2/7/12/17. Transient FFT frames are not assigned invented
  coordinates or compared to an assumed envelope-window spectral mean.

Coverage also requires first epoch observation before a full envelope window
and each reference counter within the declared current window's observation
interval (`analysisSample - 1` through `analysisSample + 4799`). These are
consistency/acceptance bounds for this harness, **not a measured timing
uncertainty or host-vector certificate**. A run outside them is rejected rather
than silently realigned.

### Explicitly unproved

The report lacks native attack events/thresholds, FFT-frame timestamps and
signal-derived loaded-buffer identity. Consequently the verdict does **not**
claim attack count/timing, exact FFT latency/phase, absolute FFT energy scaling,
actual Max execution or loaded-buffer identity. Matching independently hashed
staged bytes and declared hashes is not attestation that Max loaded those bytes.
Independent runner console/resource/buffer evidence remains mandatory.

These equal-amplitude fixtures cannot distinguish channel swaps or signal
polarity from per-channel meters and energy pooling; individual FFT-channel
participation/energy normalization is also unproved. Spectrum-only anti-phase
downmix cancellation _is_ detected by the required nonzero steady-tone spectrum,
even if envelope meters are intact. Wrong gain, RMS and frequency/alias values
are independently rejected. No claim of arbitrary-input numeric coverage is
made by three fixtures.

Native attack events, Live source onset, global/host vector phase,
pass-through, runner-process attestation/report authenticity and production
certification remain unknown. Synthetic positive DTOs and deliberate negative
mutations test verifier sensitivity, **not actual Max DSP proof**. No harness
report/resource change was required or made for this verifier.
