# Continuous Arrangement producer: implementation status

**Implemented candidate capability; real-host qualification is separate.** After
actual ABI3 analyzer readiness, runtime enables the tested continuous controller
and advertises v6 native status plus the continuous capability. Per-pass native
readiness remains BLOCKED until fresh executed proofs; no host qualification is
fabricated. Session and ordinary v1 observations remain limited to 30 seconds.

## Implemented acquisition and bounded delivery

- The native engine accepts at most 600 seconds. Its 64-slot realtime FIFO,
  reserved terminal slot, FFT/history state, epoch, DSP generation and physical
  terminal-consumed receipt are unchanged in ownership and size.
- The production musical Gen source accepts the corresponding duration and row
  geometry. The legacy descriptive Gen configuration retains its old bound.
- Continuous Max envelope IO uses `configure_metric_continuous` and two fixed
  64-slot stores. `metric_record_ack` releases only the exact owner/family/
  sequence handed to the bounded Node sink. Unacknowledged exhaustion fails
  explicitly without overwriting existing slots. This is not a storage ACK.
- Continuous reducers deliver canonical records through `onRecord`, retain one
  last record/fingerprint per family, and preserve the attack detector and FFT
  phase across batches. `finalizeStream` returns bounded collector accounting,
  never a v1 observation or a whole-pass projection.
- Mel/pitch/spectral-shape handoffs have bounded streaming sinks and explicit
  malformed/missing supports. Native terminal consumption is still required;
  streaming, a stop request, or successful delivery cannot establish cleanup.
- `audio_listener_metric_stream.js` uses the canonical protocol descriptor,
  chunk, digest, state and manifest validators. Data queues are capped at eight
  pending chunks plus at most 256 buffered entries per requested family. Chunks
  encode to at most 128 KiB. Rejection, malformed data or backlog overflow
  triggers failure, not retry, downsampling or silent loss.
- Controller ticks flush nonempty short batches every five seconds, below the
  runtime's 15-second inactivity bound even for sparse level-only delivery.
  Timer flushes share the same global pending cap and never reset acquisition;
  stalled acknowledgements fail explicitly instead of growing retention.
- The controller branch shares existing arm/launch/source monitoring, ticks,
  cleanup and writer attribution. It emits a terminal manifest rather than a
  duplicate full observation. The independent v5 watchdog can freeze a
  duration-derived total ceiling (capture duration plus 20 seconds) before
  `begin`; heartbeats still cannot renew its 2-second inactivity bound.

Writer acceptance permits discarding a batch from the producer, but does **not**
mean SQLite durability. Runtime must stage and verify the complete digest chain
and manifest before exposing success. Failed/cancelled producer queues are
discarded only as failed/cancelled data; they are not reported as complete.

## Integration gates still outstanding

Continuous control/configuration, readiness and arm now use the canonical
continuous schemas. The source codec adapter preserves the existing source-proof
shape with continuous arm/receipt validators and calls the same canonical
clock/alignment checker. The shared compact launch proof retains its existing v1
scope; the continuous command/arm scope is distinct. A 31-second all-six
controller regression executes Gen/IO/FFT/analyzer acquisition, asynchronously
replays every chunk at an independent receiver and verifies the compact terminal.

The terminal proof now correctly requires independently observed **still-playing**
clocks: the producer disarms/drains analyzers, never stops Live to manufacture a
proof. After physical cleanup is confirmed, the controller waits for a new
32-frame running bracket whose first counter exceeds both cleanup readback
counters and the spectrum stop watermark; the earlier source-coverage postcheck
is not reused as the final clock proof.

Canonical streaming APIs are exported through the Max source codec entry. The
SDK writer now accepts the typed descriptor, chunk and manifest envelopes.
Runtime awaits matching `producer.ack` (`action: listener`) after the durable
subscriber settles; socket acceptance alone cannot release queued chunks.
Disconnect/error/timeout resolves pending deliveries as failed. Stream frames
are bounded at 128 KiB including root attribution and newline. The executed
31-second regression now traverses the actual runtime and SDK writer/ACK path.
Runtime now bootstraps missing WebCrypto/TextEncoder globals from Node's
built-in crypto/util modules before using the canonical codec. An isolated VM
test with both globals absent verifies the standard SHA256 vector; absent
built-in crypto fails explicitly. This is not a real-Max qualification claim.
Descriptor geometry size still requires explicit admission handling. No divergent wire implementation or
larger unrelated frame limit is a substitute.

Canonical schema-parsed size audit confirms this is an executable admission
gate, not theoretical: 600 seconds at 999 BPM / 48 kHz yields 39,960 rows,
a 3,238,665-byte prepare envelope and a 3,245,398-byte descriptor result
envelope with ordinary UUID attribution (limit: 2,097,152 bytes). At 44.1 kHz
the corresponding sizes are 3,235,933 and 3,242,682 bytes. The existing compact
descriptor admission is only 7,565 bytes. Source admission is now coordinated:
`metricStream` sends `compactMetricRecordStreamDescriptor(descriptor)`, and
ingress expands before validation/staging. A 600-second / 999-BPM regression
proves bounded transmission and identical expanded descriptor/digest. Compact
**control** admission is still needed for control/config, readiness and arm.
At 120 BPM / 48 kHz the full descriptor result is 389,309 bytes; that successful
test geometry does not qualify the supported maximum tempo.

The approved 180-second, 128-BPM smoke geometry fits existing control bounds;
maximum-tempo compact control is not a prerequisite for that run. Deterministic
SDK evidence does not establish real-host qualification or replace actual
SQLite persistence/restart checks.

## Deterministic evidence

No Live/Max instance was launched, device installed, fixture frozen or real-host
test run.

- Native `build.py` and universal `publish.py --publish` build/CTest pass all
  three targets. Native tests process 180/600-second continuous sources with one
  arm/generation, exact sequences/supports, finite queue high-water, explicit
  overflow/cancellation/over-limit failure and physical drain receipts.
- Actual generated Gen plus production IO tests process 180 and 600 seconds
  without seeking/rearming and verify every musical row and 100-ms window.
  Their first run exposed the remaining 30-second normalizer bound; the fixed
  continuous normalizer passes both.
- Canonical all-six-family chunk replay, constant-retention reducer/analyzer
  tests, slow/rejected writers, in-flight cancellation, ring reuse/exhaustion,
  and finite watchdog regressions pass.
- Controller/recorded-proof suites: 79/79 pass, including the new executed
  31-second continuous case. A concurrent
  broad run initially rejected its codec snapshot with
  `native_metric_codec_input_changed` during other agents' edits; the owning
  controller rerun passed without weakening that integrity check.
- Packaging/runtime adapter/native-resource-pin suites: 48/48 pass; source
  inventory check and lint pass.

The universal native bundle, provenance and source pin inventory were generated
with the existing publisher. No `.amxd` bytes were edited.
