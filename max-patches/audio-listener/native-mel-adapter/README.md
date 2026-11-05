# Frame-aware mel native producer (host qualification pending)

This directory implements a fixed-profile, application-owned DSP producer and
a thin Max external, generated production graph wiring, and byte-pinned
offline packaging. It does **not** by itself qualify host support or authorize
observations. Controller/report admission is parent-owned; existing metric
producers and the stereo passthrough are preserved. No Live/Max process was
launched or attached during this work.

## What actually runs

`mel_engine.hpp` calls the unmodified pinned FluCoMa core:

1. `algorithm::STFT(2048, 2048, 2048, 0)::processFrame` on exactly 2048
   consecutive, observed source samples per channel.
2. `STFT::magnitude`.
3. `algorithm::MelBands::init(20, 20000, 24, 1025, rate, 2048)` and
   `processFrame(magnitude, bands, false, false, false, allocator)`.

Thus window/hop/FFT are 2048, window type is periodic Hann, 24 triangular mel
bands are independent per stereo channel, normalize is 0, scale is linear
(0), and power is false. No channel downmix, callback-held output, pfft phase,
resampling, zero-padded startup, tail padding, or persisted audio is used.
Audio retention is two fixed 2048-sample working buffers plus two fixed
1025-sample pre-roll rings, erased at termination. This is transient DSP RAM,
not a recorded buffer, scheduler snapshot, or journal. **ABI 2 supersedes the
earlier handshake-phase ABI 1.** Frames now begin exactly at the existing
capture Gen's resolved absolute origin. That origin can arrive retrospectively
by at most its configured capture vector (up to 1024 samples). Missing
pre-roll fails closed; no guessed, repeated, or padded samples are substituted.
The source's sealed total length determines the exact full-frame count and
explicit unmeasured trailing support. The producer shuts down at capture end.

`FFT.hpp` multiplies HTL real-FFT results by 0.5. The native analytical test
confirms a unit bin-centered sine has center magnitude 512, with 256 in its
Hann neighbors. The source-binding test compares both channels against the
parent's independent `../mel-band-reference.mjs`, rather than reproducing
that oracle.

## Build and provenance

Dependency **sources** are not vendored or fetched in normal product builds.
The final universal app-owned bundle and verbatim notices are vendored at
`../dependencies/flucoma/listener.mel~.mxo`, beside the unchanged stock
spectralshape dependency.
`dependencies.json` locks complete commits. The core is
`f1551f7057bd0f14d2ca2b4a542715fe460354e0`, matching the release's `f1551f70`
claim; HISSTools and Eigen match that core's declared versions. The upstream
core declares Memory's moving `main`; this adapter instead pins the compatible
0.7-3 release. This is a new application build, **not** a bit-identical
reproduction of the stock FluCoMa binary or its unpinned transitive build.
The stock wrapper `a1f6f90a584f9d369344e6a81bf8f155e4a58972` is not compiled
or forked.

From this directory:

```sh
python3 -m venv node_modules/.native-mel/venv
node_modules/.native-mel/venv/bin/python -m pip install cmake==3.31.6
python3 build.py --fetch
python3 build.py
python3 build.py --sanitize
python3 build.py --universal
python3 publish.py --publish
python3 publish.py --check
```

Only the explicit `--fetch` command retrieves missing dependencies. Cached
checkouts must have the exact pin and no modifications/untracked files.
No global installation, product dependency mutation, trust bypass, or host
application is required. CMake does not enter the core's top-level build,
which would fetch unrelated/moving dependencies. It compiles only Memory,
the native test executables, and (on macOS, non-sanitized) the external.

Generated dependencies, tools, and outputs stay under this directory's
`node_modules/.native-mel/`, already excluded by repository-wide tooling.
This is an isolated native build cache, not an npm dependency or workspace.
Native test build: `node_modules/.native-mel/build/release/listener.mel~.mxo`.
Universal build: `node_modules/.native-mel/build/universal/listener.mel~.mxo`.
The tested toolchain is Apple clang 17,
CMake 3.31.6, macOS arm64. The bundle exports `ext_main`, has a valid plist,
and links MaxAudioAPI, Accelerate, libc++, and libSystem, with no build-cache
dylib paths. The vendored binary contains arm64 and x86_64 slices, deployment
target macOS 11.0; only the arm64 test slice has executed here. It is not
notarized, installed, or host-load-tested. The compiler/linker output and offline tests are the
reproducible evidence—not a runtime loading certificate.

`publish.py --publish` explicitly rebuilds and tests, rejects extra build
files, publishes only eight enumerated bundle files and one provenance JSON,
and generates `packages/shared/src/native-mel-pins.ts`. It never recursively
copies arbitrary build directories. Provenance links the executable to
seven exact application source/tool inputs, complete public dependency pins,
compiler/CMake/SDK versions, architecture list, ABI, and fixed profile.
`publish.py --check` rebuilds and byte-compares every vendored resource and
the pin table without repinning. A clean-object universal rebuild reproduced
every pinned byte on this toolchain.

Ordinary application builds only read these immutable pins; they never run
CMake, fetch source, or regenerate native hashes. Source checking fails if
the native implementation/tool inputs no longer match their provenance.
The shared payload validator rejects missing, extra, linked, tampered, or
self-rehashed substituted native files, including licenses/provenance, and
validates the ten signal/control edges plus exact clock/capture Gen sources.
Native bundle files stay adjacent to frozen AMXD resources, not encoded as
archive-only text. The 32-flat-resource publisher budget is unchanged;
additional slots are allowed only for explicitly pinned native paths.
Regenerate the resource manifest with the existing listener tooling:
`node scripts/audio-listener-device.mjs generate-source-manifest`.

The bundle includes verbatim BSD-3, MPL-2, zlib, and Max SDK notices plus the
source manifest in `Contents/Resources/licenses`. Upstream Eigen and all
other corresponding sources are available at the repository URLs and exact
revisions in that manifest. No upstream files are modified. Preserve these
notices and source availability when packaging; compile with
`EIGEN_MPL2_ONLY=1`. Do not distribute the SDK frameworks with the external.

## Exact producer contract

Object: `listener.mel~`, ten **connected signal** inlets, one message outlet.
No adjustable arguments or parameters; the fixed profile above is ABI 2.
Source references below are inside `audio_listener_native_analysis.maxpat`;
`gen` is its existing retained musical capture Gen (compact ABI 3).

| Inlet | Required signal                                                          |
| ----- | ------------------------------------------------------------------------ |
| 0     | Existing `left` / `in~ 2`, same raw plugin L                             |
| 1     | Existing `right` / `in~ 3`, same raw plugin R                            |
| 2     | Existing `clock` / `in~ 4`, same absolute counter entering `gen` inlet 3 |
| 3     | `gen` outlet 0: seen epoch, **out1**                                     |
| 4     | `gen` outlet 2: rejection code, **out3**, must be zero                   |
| 5     | `gen` outlet 6: absolute capture origin, **out7**                        |
| 6     | `gen` outlet 7: executed capture ABI, **out8**, exactly 3                |
| 7     | `gen` outlet 9: sealed total samples, **out10**                          |
| 8     | `gen` outlet 13: sealed capture vector, **out14**                        |
| 9     | `gen` outlet 18: sealed epoch, **out19**                                 |

These are source samples from the **same DSP graph/evaluation**, not
`snapshot~`, message values, scheduler time, `out1` reset-local position,
or the retained FFT counter. Inspecting signal connection presence alone
cannot attest their provenance; the graph assembler/packager must bind these
exact edges to the existing generated retained musical capture Gen and its
actual input4 counter, ultimately supplied by `DESCRIPTIVE_CLOCK_CODE`.

The rate is frozen when the instance first gets a valid `dsp64` setup
(44100 or 48000 Hz, matching the existing capture producer). A changed rate
fails closed; recreate the external after the previous session is
physically stopped and drained. An in-flight DSP rebuild, even at the same
rate, faults the capture on the next perform. `generation` counts DSP
setups of this instance and is not a host identity or a Gen reset proof.

Messages (serialized via Max `defer_low` onto the control thread):

- `arm <epoch>`: one positive Max integer below 2^44, strictly newer than
  previous accepted control epochs. Rejected if a previous terminal record
  remains undrained. Arm before the capture is launched. Records start only
  after source epoch and sealed epoch equal this value, rejection is zero,
  ABI is 3, total/vector are valid, origin is resolved, and every required
  source sample is present in the continuous retained clock history.
  Waiting for epoch/origin is bounded to ten seconds of actual samples.
  A newer/wrong epoch, invalid metadata, or broken clock faults closed.
  Wait for `mel_ready` before launching transport; it proves this producer
  has executed with the sealed source epoch and filled the required pre-roll,
  rather than borrowing readiness from another producer. No `mel_started`
  merely from handling this message.
- `stop <epoch>`: only the current control epoch. This is a **request**, not
  an acknowledgment. The next nonempty actual perform ends production and
  enqueues the terminal record without consuming more audio.
- `drain [token]`: optional positive Max integer below 2^44 (default token=0).
  Emits at most 64 retained records on the control thread in FIFO
  order. The audio thread never calls outlets, allocates a message, or waits
  for the control thread. Poll regularly (for example 10 ms); this is not a
  stock current-vector callback.

The four record selectors have this 11-atom header:

```text
abi epoch generation sequence start end lost partial reason sampleRate bandCount
```

- `mel_ready`: source epoch/configuration observed and pre-roll filled while
  origin remains unresolved. start=end is an exclusive clock receipt, not
  capture support. Sequence/lost/partial/reason are zero. Emitted at most once.
- `mel_started`: `[start,end)` is the entire sealed capture source support,
  with end=origin+total, sequence=0. Parent must match it to its expected capture.
- `mel_frame`: appends 24 left then 24 right doubles (59 atoms total).
  `sequence` is 1-based **published completed STFT frames**, `start/end` are exact
  absolute half-open support, `end-start=2048`; lost/partial/reason are zero.
- `mel_stopped`: terminal after physical producer shutdown. Sequence is the
  number of successfully published full frames. `lost` is the number of
  **all remaining full-frame slots without a record**, including unexecuted
  slots after a fault/early stop. Thus no expected slot disappears silently.
  `start` is origin+sequence*2048, `end` is capture end. The missing full-frame
  range is `[start, start+lost*2048)`; parent expands it into `lost` gap slots
  with the terminal reason. Trailing **unmeasured** support is
  `[end-partial,end)`, with partial=total%2048, independent of failure timing.
  On normal completion, lost=0 and reason=10. A tail is never a padded frame.
  Before a successful handshake, start/end/lost/partial are zero and no
  capture support is claimed.

After each drain batch, a **separate** `mel_drain` receipt has nine atoms:

```text
abi token epoch generation recordsDrained framesDrained terminalConsumed clockValid sourceClockExclusive
```

Counts are cumulative for this epoch, not just this batch. `terminalConsumed=1`
only after the reserved terminal was removed from the FIFO, following every
previous record. An empty poll while active is not drain completeness.
`clockValid=1` carries the actual source-clock receipt captured at terminal
execution; on normal completion it is at least capture end (later only when
an entire short capture was already in pre-roll when origin resolved).
For explicit stop it
samples the first counter value of the stopping perform, independently of
the terminal's missing-range coordinates. A discontinuous clock or invalid
source binding cannot reuse an old valid sample as a fresh receipt.

The token correlates a control drain request, **not** a DSP frame. Repeated
drains after terminal return the same retained terminal receipt, not a new
source-clock observation. Re-arm resets all receipt counts/state. No DSP
setup/no producer yields no drain response; parent must time out. Capture
faults remain faults even when physical shutdown and drain are confirmed.
Parent must separately require the expected epoch/generation, ordered
records, terminal reason/coverage, terminal consumption, and appropriate
source-clock evidence. A valid `mel-band-timeline/v1` object proves none of
these acquisition facts by itself.

Reason codes:

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Nonterminal                                                            |
| 1    | Requested stop                                                         |
| 2    | Sealed source configuration changed after handshake                    |
| 3    | Invalid / discontinuous / exhausted source clock                       |
| 4    | Wrong source epoch, ABI, rejection, or invalid metadata                |
| 5    | Nonfinite audio or absolute amplitude above 64                         |
| 6    | Retained FIFO overflow                                                 |
| 7    | Nonfinite / invalid computed band result                               |
| 8    | Source handshake timeout                                               |
| 9    | DSP reconfiguration, missing signal edge, or rate mismatch             |
| 10   | Entire sealed capture consumed; full frames and explicit tail complete |
| 11   | Origin outside retained history or retrospective vector bound          |

FIFO capacity is 64 complete records. Nonterminal publications may use 63;
one slot is reserved for the terminal. With no drain, ready+start plus 61
frames fit (or start plus 62 if origin resolved before a ready receipt).
The next computed frame ends capture and explicitly marks every
remaining expected full-frame slot missing. For a 100-frame capture, that is
sequence=61, lost=39 with both receipts (not merely one lost callback).
Nothing is overwritten or silently coalesced. There is only one terminal
per epoch. The consumer must reject incomplete/lost captures; after a fault
the unprocessed rest of the stream is **not** claimed as measured.

DSP off means no perform and therefore **no physical stop ack**. Parent
cleanup must time out/fail closed instead of synthesizing one from a control
callback. Deletion frees resources but is not a delivered stop receipt.
The C++ core's `arm/stop/drain` require one serialized consumer thread;
`process` requires one producer; `dspSetup` requires perform to be suspended
(the Max DSP setup contract).

## Minimal integration into the existing listener

No separate listener or playback route is needed. The least intrusive
integration is **inside `audio_listener_native_analysis.maxpat`**:

1. Keep the existing clock Gen and all its outputs, source counter fanout,
   analysis graph, spectralshape diagnostics, and plugin/plugout passthrough.
2. No root inlets/outlets or extra audio route are needed. Reuse its existing
   `left`, `right`, and `clock` signal objects, connected to external inlets
   0,1,2. Keep the existing `@parallel 0` poly behavior.
3. Connect existing capture `gen` zero-based outlets **0,2,6,7,9,13,18**
   to external inlets **3,4,5,6,7,8,9**, respectively.
4. The root runtime emits `mel_native_control <selector> ...args`. The
   generated `melControlRoute` strips only this prefix, sending the remainder
   to analysis poly inlet 4 (dedicated `in 5`, `melCommand`), then directly
   to the external. Its unmatched outlet preserves `scoped-native-control`.
   Existing Gen command routes remain separate.
   `melMessages` prepends `native_mel` to the external selector/header, then
   sends it through `nativeMessages` / `out 1` and the existing root return
   to the runtime handler `native_mel`.
5. Parent must implement request ownership, capability/build pinning,
   bounded draining, strict record admission, stop/timeout cleanup, and
   observation assembly. Do not send these messages through the old
   retained metric reader or reinterpret spectralshape smoke as authority.

These routes are implemented in `native-runtime-source.mjs` for v5; legacy
v1..v4 graphs are unchanged. Generated-graph and payload tests exercise the
connections. They are not claims of native Max graph compilation/execution.

## Evidence and remaining gates

- Native tests: framing, arbitrary host partitioning, stale ownership,
  source stop, missing edges, reset/rate fault, nonfinite audio, strict clock
  bounds, waiting timeout, overflow, terminal retention, concurrent FIFO,
  retrospective origin, short captures, exact lengths, unpadded tails, and
  terminal-consumed versus merely queued/empty drain receipts.
- Eigen's runtime no-malloc check is enabled during native test `process`.
  This is narrower than complete host real-time allocation/CPU qualification.
- Offline source-binding test feeds **the existing Gen-source model** into
  the compiled native core, at 44.1/48 kHz with block sizes 7/64/2048/8192
  and capture-origin announcement delays 1/32/1024 samples,
  verifies exact source support, compares 24 independent stereo bands to the
  parent's oracle, and rejects a corrupted source counter. The Gen subset
  model explicitly is **not a Max compiler or DSP timing oracle**.
- Release and ASan/UBSan builds are separate and run the same offline tests.
- Existing owning graph/clock/retained-source tests are run unchanged.

Still required: parent controller/report admission, actual source
binding in the generated Max DSP graph, exact bundle resolution/loading,
in-host scheduling and stop/drain behavior, and the authorized real-Live
smoke. A smoke result remains smoke-only, not numerical/support acceptance.
Do not advertise production completion, automatically include F3 in listen,
or admit these records as qualified observations solely from these tests.
