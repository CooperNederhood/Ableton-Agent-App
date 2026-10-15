const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");
const {
  NativeDescriptorAssembler: ArchivedNativeDescriptorAssembler,
} = require("./fixtures/native-assembler-0a01598.js");
const evidence = require("./fixtures/native-host-spectrum.json");

const owner = { passId: "pass", connectionEpoch: "connection", nativeEpoch: 1 };
const origin = evidence.nativeOrigin[2];
const offset = evidence.before.clockOffsetSamples;
const envelope = (index) => {
  const row = evidence.envelope.frames[index - 1];
  return {
    nativeEpoch: 1,
    armCounter: evidence.nativeOrigin[1],
    originCounter: origin,
    endCounter: origin + row[4],
    peak: row.slice(0, 2),
    rms: row.slice(2, 4),
  };
};

function fixture(overrides = {}, Assembler = NativeDescriptorAssembler) {
  const frames = [],
    failures = [];
  const assembler = new Assembler({
    owner,
    armCounter: evidence.nativeOrigin[1],
    originCounter: origin,
    hostOffsetSamples: offset,
    windows: 20,
    invalidFrames: 353,
    onFrame: (frame, actualOwner) => {
      assert.deepEqual(actualOwner, owner);
      frames.push(frame);
      return true;
    },
    onFailure: (reason, actualOwner) => {
      assert.deepEqual(actualOwner, owner);
      failures.push(reason);
    },
    ...overrides,
  });
  const stream = () => {
    const packets = [
      ...evidence.spectrum.frames.map((packet) => ({
        counter: packet[0],
        spectrum: packet,
      })),
      ...Array.from({ length: 20 }, (_, index) => {
        const packet = envelope(index + 1);
        return { counter: packet.endCounter, envelope: packet };
      }),
    ].sort((left, right) => left.counter - right.counter);
    for (const packet of packets) {
      if (packet.spectrum) assembler.pushSpectrum(packet.spectrum, owner);
      else assembler.pushEnvelope(packet.envelope, owner);
    }
  };
  return { assembler, frames, failures, stream };
}

test("bounded assembly pairs recorded envelope coordinates with the actual latest complete stereo FFT, without a time fit", () => {
  const f = fixture();
  // This is recorded-coordinate assembly, not actual Node/Max delivery acceptance.
  f.stream();
  assert.equal(f.assembler.state, "covered");
  assert.equal(f.frames.length, 20);
  for (const [index, frame] of f.frames.entries()) {
    const expected = evidence.spectrum.frames
      .filter((row) => row[4] <= envelope(index + 1).endCounter)
      .at(-1);
    assert.equal(frame.sample, envelope(index + 1).endCounter + offset);
    assert.equal(frame.beat, (index + 1) / 5);
    assert.equal(frame.centroidHz, expected[1]);
    assert.equal(frame.spectralEnergy, expected[2]);
    assert.deepEqual(frame.spectralWindow, {
      startSample: expected[3] + offset,
      endSample: expected[4] + offset,
    });
  }
  const intervals = f.assembler.spectralWindows(owner);
  assert.equal(intervals.length, 20);
  intervals[0][0]++;
  assert.notDeepEqual(intervals, f.assembler.spectralWindows(owner));
  assert.equal(f.assembler.pending.length, 0);
  assert.equal(f.assembler.spectra.length, 0);
  assert.deepEqual(f.failures, []);
});

test("current default and explicit-default assembly are byte-compatible with archived v1 recorded-packet replay, not new host execution", () => {
  const archived = fixture({}, ArchivedNativeDescriptorAssembler);
  const current = fixture();
  const explicit = fixture({
    geometry: { sampleRate: 48000, hopSamples: 4800, totalSamples: 96000 },
    coordinates: { startBeat: 0, tempoBpm: 120 },
  });
  archived.stream();
  for (const f of [current, explicit]) {
    f.stream();
    assert.equal(f.assembler.state, "covered");
    assert.equal(archived.assembler.state, "covered");
    assert.equal(JSON.stringify(f.frames), JSON.stringify(archived.frames));
    assert.equal(
      JSON.stringify(f.assembler.spectralWindows(owner)),
      JSON.stringify(archived.assembler.spectralWindows(owner)),
    );
    assert.deepEqual(f.failures, archived.failures);
  }
});

test("an envelope waits for its tagged FFT rather than using an old or future window", () => {
  const f = fixture();
  f.assembler.pushEnvelope(envelope(1), owner);
  assert.equal(f.frames.length, 0);
  assert.throws(() => f.assembler.spectralWindows(owner), /coverage_required/);
  for (const packet of evidence.spectrum.frames) {
    f.assembler.pushSpectrum(packet, owner);
    if (f.frames.length) break;
  }
  assert.equal(f.frames.length, 1);
  assert.ok(f.frames[0].spectralWindow.endSample <= f.frames[0].sample);
  const missing = fixture();
  missing.assembler.pushEnvelope(envelope(1), owner);
  const future = evidence.spectrum.frames.find(
    (row) => row[0] > envelope(1).endCounter,
  );
  assert.throws(
    () => missing.assembler.pushSpectrum(future, owner),
    /window_missing/,
  );
  assert.equal(missing.assembler.state, "failed");
  assert.equal(missing.frames.length, 0);
  assert.deepEqual(missing.failures, ["native_fft_window_missing"]);
});

test("owner, connection and epoch denials never mutate or cancel the selected capture", () => {
  const f = fixture();
  for (const patch of [
    { passId: "old" },
    { connectionEpoch: "old" },
    { nativeEpoch: 2 },
  ]) {
    assert.throws(
      () => f.assembler.pushEnvelope(envelope(1), { ...owner, ...patch }),
      /owner_mismatch/,
    );
  }
  assert.equal(f.assembler.state, "capturing");
  assert.equal(f.assembler.pending.length, 0);
  assert.deepEqual(f.failures, []);
  f.stream();
  assert.equal(f.frames.length, 20);
});

test("exact held packets are idempotent but changed holds, source tags and gaps fail with bounded cleanup", () => {
  for (const kind of [
    "hold",
    "epoch",
    "arm",
    "origin",
    "gap",
    "nonfinite",
    "sparse",
    "raw",
    "range",
    "rms",
  ]) {
    const f = fixture();
    f.assembler.pushEnvelope(envelope(1), owner);
    assert.equal(
      f.assembler.pushEnvelope(
        Object.fromEntries(Object.entries(envelope(1)).reverse()),
        owner,
      ),
      false,
    );
    const packet = envelope(kind === "gap" ? 3 : kind === "hold" ? 1 : 2);
    if (kind === "hold") packet.peak[0]++;
    if (kind === "epoch") packet.nativeEpoch++;
    if (kind === "arm") packet.armCounter++;
    if (kind === "origin") packet.originCounter++;
    if (kind === "nonfinite") packet.rms[0] = NaN;
    if (kind === "sparse") packet.peak = new Array(2);
    if (kind === "raw") packet.rawAudio = [0, 0];
    if (kind === "range") packet.peak[0] = 65;
    if (kind === "rms") packet.rms[0] = 1;
    assert.throws(() => f.assembler.pushEnvelope(packet, owner), /native_/);
    assert.equal(f.assembler.pending.length, 0);
    assert.equal(f.assembler.spectra.length, 0);
    assert.equal(f.failures.length, 1);
  }
  const f = fixture();
  const packet = evidence.spectrum.frames[0];
  f.assembler.pushSpectrum(packet, owner);
  assert.equal(f.assembler.pushSpectrum([...packet], owner), false);
  const changed = [...packet];
  changed[2] = 1;
  assert.throws(
    () => f.assembler.pushSpectrum(changed, owner),
    /changed_native_spectrum_hold/,
  );
});

test("invalid scope, callback and coordinate configuration cannot create an assembler", () => {
  for (const change of [
    { windows: 0 },
    { windows: 101 },
    { hostOffsetSamples: Number.MAX_SAFE_INTEGER },
    { originCounter: 2 ** 44 },
    { invalidFrames: -1 },
    { onFrame: null },
    { owner: { ...owner, nativeEpoch: 0 } },
    { owner: { ...owner, passId: "x".repeat(129) } },
  ])
    assert.throws(
      () => fixture(change),
      /invalid_native_assembler_configuration/,
    );
});

test("torn FFT tags, changing invalid counts, grid changes and backwards delivery cannot enter a frame", () => {
  for (const kind of [
    "torn",
    "invalid",
    "grid",
    "backwards",
    "energy",
    "centroid",
  ]) {
    const f = fixture();
    f.assembler.pushSpectrum(evidence.spectrum.frames[1], owner);
    const packet = [...evidence.spectrum.frames[kind === "backwards" ? 0 : 2]];
    if (kind === "torn") packet[4]++;
    if (kind === "invalid") packet[5]++;
    if (kind === "grid") {
      packet[0]++;
      packet[3]++;
      packet[4]++;
    }
    if (kind === "energy") packet[2] = Infinity;
    if (kind === "centroid") packet[1] = 24001;
    assert.throws(() => f.assembler.pushSpectrum(packet, owner), /native_/);
    assert.equal(f.frames.length, 0);
    assert.equal(f.assembler.spectra.length, 0);
    assert.equal(f.failures.length, 1);
  }
});

test("queues have fixed quotas and cancellation prevents late packets or retained evidence", () => {
  const pending = fixture();
  for (let index = 1; index <= 8; index++)
    pending.assembler.pushEnvelope(envelope(index), owner);
  assert.throws(
    () => pending.assembler.pushEnvelope(envelope(9), owner),
    /buffer_overflow/,
  );
  const spectra = fixture();
  const first = evidence.spectrum.frames[0];
  for (let index = 0; index < 128; index++) {
    const packet = [...first];
    packet[0] += index * 2048;
    packet[3] += index * 2048;
    packet[4] += index * 2048;
    spectra.assembler.pushSpectrum(packet, owner);
  }
  const overflow = [...first];
  overflow[0] += 128 * 2048;
  overflow[3] += 128 * 2048;
  overflow[4] += 128 * 2048;
  assert.throws(
    () => spectra.assembler.pushSpectrum(overflow, owner),
    /buffer_overflow/,
  );
  const cancelled = fixture();
  cancelled.assembler.pushEnvelope(envelope(1), owner);
  cancelled.assembler.cancel(owner);
  cancelled.assembler.cancel(owner);
  assert.throws(
    () => cancelled.assembler.pushEnvelope(envelope(2), owner),
    /closed/,
  );
  assert.throws(() => cancelled.assembler.spectralWindows(owner), /closed/);
  assert.equal(cancelled.assembler.pending.length, 0);
  assert.deepEqual(cancelled.failures, []);
});

test("consumer rejection/exception and reentrant cancellation cannot leave buffered work or manufacture completion", () => {
  for (const kind of ["reject", "throw", "cancel"]) {
    let assembler;
    const f = fixture({
      onFrame: () => {
        if (kind === "throw") throw new Error("consumer_rejected");
        if (kind === "cancel") assembler.cancel(owner);
        return false;
      },
    });
    assembler = f.assembler;
    assert.throws(
      f.stream,
      /native_descriptor_rejected|consumer_rejected|native_assembler_closed/,
    );
    assert.equal(assembler.state, kind === "cancel" ? "cancelled" : "failed");
    assert.equal(assembler.pending.length, 0);
    assert.equal(assembler.spectra.length, 0);
    assert.equal(assembler.intervals.length, 0);
  }
});
