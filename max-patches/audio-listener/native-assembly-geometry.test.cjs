const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeDescriptorAssembler,
} = require("./audio_listener_native_assembler.js");

const FFT = 2048;
const MAX_COUNTER = 2 ** 44;
const owner = {
  passId: "internal-geometry",
  connectionEpoch: "connection",
  nativeEpoch: 7,
};

function fixture(
  sampleRate = 48000,
  totalSamples = sampleRate,
  overrides = {},
) {
  const hopSamples = Math.round(sampleRate / 10);
  const frames = [];
  const failures = [];
  const config = {
    owner,
    armCounter: 8000,
    originCounter: 8192,
    hostOffsetSamples: 12345,
    geometry: { sampleRate, hopSamples, totalSamples },
    invalidFrames: 11,
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
  };
  const assembler = new NativeDescriptorAssembler(config);
  const envelope = (samples, patch = {}) => ({
    nativeEpoch: owner.nativeEpoch,
    armCounter: config.armCounter,
    originCounter: config.originCounter,
    endCounter: config.originCounter + samples,
    peak: [0.5, 0.25],
    rms: [0.25, 0.125],
    ...patch,
  });
  const spectrum = (samples, centroid = sampleRate / 8, energy = 0.625) => {
    const end = config.originCounter + samples;
    return [end, centroid, energy, end - FFT, end, config.invalidFrames];
  };
  const stream = (envelopeFirst = false) => {
    let nextFFT = FFT;
    for (
      let end = hopSamples;
      ;
      end = Math.min(end + hopSamples, totalSamples)
    ) {
      if (envelopeFirst) assembler.pushEnvelope(envelope(end), owner);
      while (nextFFT <= end) {
        assembler.pushSpectrum(spectrum(nextFFT), owner);
        nextFFT += FFT;
      }
      if (!envelopeFirst) assembler.pushEnvelope(envelope(end), owner);
      if (end === totalSamples) break;
    }
  };
  return { assembler, config, frames, failures, envelope, spectrum, stream };
}

function cleaned(f, state, failures = 1) {
  assert.equal(f.assembler.state, state);
  assert.equal(f.assembler.pending.length, 0);
  assert.equal(f.assembler.spectra.length, 0);
  assert.equal(f.assembler.intervals.length, 0);
  assert.equal(f.assembler.lastEnvelope, null);
  assert.equal(f.assembler.lastSpectrum, null);
  assert.equal(f.failures.length, failures);
  assert.throws(() => f.assembler.spectralWindows(owner), /closed/);
  assert.throws(
    () =>
      f.assembler.pushEnvelope(f.envelope(f.config.geometry.hopSamples), owner),
    /closed/,
  );
  assert.throws(
    () => f.assembler.pushSpectrum(f.spectrum(FFT), owner),
    /closed/,
  );
}

for (const rate of [44100, 48000]) {
  for (const envelopeFirst of [false, true]) {
    for (const duration of [0.1, 30]) {
      test(`internal ${rate} Hz geometry covers ${duration}s, ${envelopeFirst ? "envelope" : "FFT"} first, on the unchanged 2048-sample grid`, () => {
        const total = Math.round(rate * duration);
        const f = fixture(rate, total);
        f.stream(envelopeFirst);
        assert.equal(f.assembler.state, "covered");
        assert.equal(f.frames.length, duration * 10);
        assert.equal(f.assembler.windows, duration * 10);
        assert.equal(f.assembler.sampleRate, rate);
        assert.equal(f.assembler.totalSamples, total);
        for (const [index, frame] of f.frames.entries()) {
          const relativeEnd = ((index + 1) * rate) / 10;
          const fftEnd =
            f.config.originCounter + Math.floor(relativeEnd / FFT) * FFT;
          assert.deepEqual(frame, {
            sample:
              f.config.originCounter + f.config.hostOffsetSamples + relativeEnd,
            beat: relativeEnd / (rate / 2),
            peak: [0.5, 0.25],
            rms: [0.25, 0.125],
            centroidHz: rate / 8,
            spectralEnergy: 0.625,
            windowSamples: rate / 10,
            spectralWindow: {
              startSample: fftEnd - FFT + f.config.hostOffsetSamples,
              endSample: fftEnd + f.config.hostOffsetSamples,
            },
          });
        }
        assert.equal(f.assembler.pending.length, 0);
        assert.equal(f.assembler.spectra.length, 0);
        assert.equal(
          f.assembler.spectralWindows(owner).length,
          f.frames.length,
        );
        assert.deepEqual(f.failures, []);
      });
    }
  }

  for (const tail of [1, FFT - 1, FFT, rate / 10 - 1]) {
    test(`internal ${rate} Hz final interval is exactly ${tail} samples, never padded or retimed`, () => {
      const hop = rate / 10;
      for (const envelopeFirst of [false, true]) {
        const total = hop * 2 + tail;
        const f = fixture(rate, total, { windows: 3 });
        f.stream(envelopeFirst);
        assert.equal(f.assembler.state, "covered");
        assert.deepEqual(
          f.frames.map((frame) => frame.windowSamples),
          [hop, hop, tail],
        );
        assert.equal(
          f.frames.at(-1).sample,
          f.config.originCounter + f.config.hostOffsetSamples + total,
        );
        assert.equal(f.frames.at(-1).beat, total / (rate / 2));
        const expectedFFTEnd =
          f.config.originCounter + Math.floor(total / FFT) * FFT;
        assert.equal(
          f.frames.at(-1).spectralWindow.endSample,
          expectedFFTEnd + f.config.hostOffsetSamples,
        );
        assert.equal(
          f.frames.at(-1).spectralWindow.endSample -
            f.frames.at(-1).spectralWindow.startSample,
          FFT,
        );
        assert.equal(f.assembler.pushEnvelope(f.envelope(total), owner), false);
        assert.equal(f.frames.length, 3);
        assert.deepEqual(f.failures, []);
      }
    });
  }

  test(`internal ${rate} Hz geometry enforces Nyquist and unchanged finite stereo/FFT constraints`, () => {
    const good = fixture(rate, rate / 10);
    good.assembler.pushSpectrum(good.spectrum(FFT, rate / 2), owner);
    good.assembler.pushSpectrum(good.spectrum(FFT * 2, rate / 2), owner);
    good.assembler.pushEnvelope(good.envelope(rate / 10), owner);
    assert.equal(good.frames[0].centroidHz, rate / 2);
    for (const [index, value] of [
      [1, rate / 2 + 0.001],
      [1, -1],
      [1, NaN],
      [2, -1],
      [2, Infinity],
      [2, Number.MAX_SAFE_INTEGER + 1],
      [5, 12],
      [5, -1],
      [5, 11.5],
      [5, NaN],
      [5, "11"],
      [0, MAX_COUNTER],
      [3, -1],
      [4, FFT],
    ]) {
      const f = fixture(rate);
      const packet = f.spectrum(FFT);
      packet[index] = value;
      assert.throws(
        () => f.assembler.pushSpectrum(packet, owner),
        /invalid_native_spectrum_packet/,
      );
      cleaned(f, "failed");
    }
    for (const patch of [
      { peak: [NaN, 0] },
      { peak: [65, 0] },
      { peak: [-1, 0] },
      { rms: [0.51, 0] },
      { rms: [0, Infinity] },
      { rms: new Array(2) },
      { peak: [0, 0, 0] },
      { rawAudio: [0] },
      { nativeEpoch: 8 },
      { originCounter: 8193 },
      { armCounter: 8001 },
      { endCounter: MAX_COUNTER },
      { endCounter: 8192 + rate / 10 + 0.5 },
    ]) {
      const f = fixture(rate);
      assert.throws(
        () => f.assembler.pushEnvelope(f.envelope(rate / 10, patch), owner),
        /native_/,
      );
      cleaned(f, "failed");
    }
    const silent = fixture(rate, rate / 10);
    silent.assembler.pushSpectrum(silent.spectrum(FFT, 0, 0), owner);
    silent.assembler.pushSpectrum(silent.spectrum(FFT * 2, 0, 0), owner);
    silent.assembler.pushEnvelope(
      silent.envelope(rate / 10, { peak: [0, 0], rms: [0, 0] }),
      owner,
    );
    assert.equal(silent.frames[0].centroidHz, 0);
    assert.equal(silent.frames[0].spectralEnergy, 0);
    const inconsistent = fixture(rate);
    assert.throws(
      () =>
        inconsistent.assembler.pushSpectrum(
          inconsistent.spectrum(FFT, 1, 0),
          owner,
        ),
      /invalid_native_spectrum_packet/,
    );
    cleaned(inconsistent, "failed");
  });
}

test("geometry is strict, complete, bounded, and consistent with an optional window count", () => {
  const valid = { sampleRate: 44100, hopSamples: 4410, totalSamples: 1323000 };
  for (const geometry of [
    null,
    [],
    44100,
    {},
    { ...valid, extra: 1 },
    { hopSamples: 4410, totalSamples: 4410 },
    { sampleRate: 44100, totalSamples: 4410 },
    { sampleRate: 44100, hopSamples: 4410 },
    { ...valid, sampleRate: 96000 },
    { ...valid, sampleRate: "44100" },
    { ...valid, hopSamples: 4800 },
    { ...valid, hopSamples: 4409 },
    ...[0, -1, 4409, 4410.5, NaN, Infinity, "4410", 1323001].map(
      (totalSamples) => ({ ...valid, totalSamples }),
    ),
  ]) {
    assert.throws(
      () => fixture(44100, 4410, { geometry }),
      /invalid_native_assembler_configuration/,
    );
  }
  for (const windows of [0, 299, 301, 300.5, NaN, null, "300"]) {
    assert.throws(
      () => fixture(44100, 1323000, { windows }),
      /invalid_native_assembler_configuration/,
    );
  }
  assert.equal(
    fixture(44100, 1323000, { windows: 300 }).assembler.windows,
    300,
  );
  assert.equal(fixture(48000, 4801, { windows: 2 }).assembler.windows, 2);
  assert.throws(
    () => fixture(48000, 1440001),
    /invalid_native_assembler_configuration/,
  );
  for (const invalidFrames of [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "11",
  ]) {
    assert.throws(
      () => fixture(48000, 4800, { invalidFrames }),
      /invalid_native_assembler_configuration/,
    );
  }
});

test("native and translated host counters retain exact safe-integer bounds", () => {
  for (const overrides of [
    { armCounter: -1 },
    { armCounter: MAX_COUNTER },
    { originCounter: 7999 },
    { originCounter: 8000 + 441001 },
    { armCounter: MAX_COUNTER - 4410, originCounter: MAX_COUNTER - 4410 },
    { hostOffsetSamples: -8193 },
    { hostOffsetSamples: Number.MAX_SAFE_INTEGER - 8192 - 4409 },
    { hostOffsetSamples: 0.5 },
  ]) {
    assert.throws(
      () => fixture(44100, 4410, overrides),
      /invalid_native_assembler_configuration/,
    );
  }
  for (const overrides of [
    {
      armCounter: MAX_COUNTER - 4411,
      originCounter: MAX_COUNTER - 4411,
      hostOffsetSamples: 0,
    },
    { hostOffsetSamples: -8192 },
    { hostOffsetSamples: Number.MAX_SAFE_INTEGER - 8192 - 4410 },
  ]) {
    const f = fixture(44100, 4410, overrides);
    f.stream();
    assert.equal(f.assembler.state, "covered");
    assert(Number.isSafeInteger(f.frames[0].sample));
  }
});

test("stale, changed-held, torn, missing and off-grid data never fill a partial final interval", () => {
  for (const kind of [
    "stale",
    "changed",
    "gap",
    "early-tail",
    "padded-tail",
    "fft-gap",
    "torn",
    "fft-grid",
    "fft-stale",
    "fft-hold",
  ]) {
    const hop = 4410;
    const f = fixture(44100, hop * 2 + 1);
    f.assembler.pushSpectrum(f.spectrum(FFT), owner);
    f.assembler.pushSpectrum(f.spectrum(FFT * 2), owner);
    f.assembler.pushEnvelope(f.envelope(hop), owner);
    assert.equal(f.frames.length, 1);
    assert.throws(() => {
      if (kind === "stale")
        f.assembler.pushEnvelope(f.envelope(hop - 1), owner);
      if (kind === "changed")
        f.assembler.pushEnvelope(f.envelope(hop, { peak: [0.6, 0.25] }), owner);
      if (kind === "gap")
        f.assembler.pushEnvelope(f.envelope(hop * 2 + 1), owner);
      if (kind === "early-tail")
        f.assembler.pushEnvelope(f.envelope(hop * 2 - 1), owner);
      if (kind === "padded-tail")
        f.assembler.pushEnvelope(f.envelope(hop * 3), owner);
      if (kind === "fft-gap") {
        f.assembler.pushEnvelope(f.envelope(hop * 2), owner);
        f.assembler.pushSpectrum(f.spectrum(FFT * 5), owner);
      }
      if (kind === "torn") {
        const packet = f.spectrum(FFT * 3);
        packet[4]++;
        f.assembler.pushSpectrum(packet, owner);
      }
      if (kind === "fft-grid")
        f.assembler.pushSpectrum(f.spectrum(FFT * 3 + 1), owner);
      if (kind === "fft-stale")
        f.assembler.pushSpectrum(f.spectrum(FFT), owner);
      if (kind === "fft-hold")
        f.assembler.pushSpectrum(f.spectrum(FFT * 2, 100), owner);
    }, /native_/);
    cleaned(f, "failed");
    assert.equal(f.frames.length, 1);
  }
});

test("stale pre-origin FFTs cannot substitute for a missing in-range FFT", () => {
  const f = fixture(44100, 4410);
  f.assembler.pushSpectrum(f.spectrum(FFT - 1000), owner);
  f.assembler.pushEnvelope(f.envelope(4410), owner);
  assert.deepEqual(f.frames, []);
  assert.throws(
    () => f.assembler.pushSpectrum(f.spectrum(FFT * 3 - 1000), owner),
    /native_fft_window_missing/,
  );
  cleaned(f, "failed");
});

test("extended captures retain queue quotas, ownership fencing and terminal cleanup", () => {
  for (const action of [
    "pushEnvelope",
    "pushSpectrum",
    "cancel",
    "spectralWindows",
  ]) {
    const f = fixture(48000, 1440000);
    for (const patch of [
      { passId: "stale" },
      { connectionEpoch: "old" },
      { nativeEpoch: 8 },
    ]) {
      const foreign = { ...owner, ...patch };
      assert.throws(() => {
        if (action === "pushEnvelope")
          f.assembler[action](f.envelope(4800), foreign);
        else if (action === "pushSpectrum")
          f.assembler[action](f.spectrum(FFT), foreign);
        else f.assembler[action](foreign);
      }, /owner_mismatch/);
    }
    assert.equal(f.assembler.state, "capturing");
    assert.deepEqual(f.failures, []);
    f.assembler.cancel(owner);
    cleaned(f, "cancelled", 0);
  }
  const pending = fixture(48000, 1440000);
  for (let index = 1; index <= 8; index++)
    pending.assembler.pushEnvelope(pending.envelope(index * 4800), owner);
  assert.throws(
    () => pending.assembler.pushEnvelope(pending.envelope(9 * 4800), owner),
    /buffer_overflow/,
  );
  cleaned(pending, "failed");
  const spectra = fixture(44100, 1323000);
  for (let index = 1; index <= 128; index++)
    spectra.assembler.pushSpectrum(spectra.spectrum(index * FFT), owner);
  assert.throws(
    () => spectra.assembler.pushSpectrum(spectra.spectrum(129 * FFT), owner),
    /buffer_overflow/,
  );
  cleaned(spectra, "failed");
  for (const kind of [
    "pending",
    "spectra",
    "covered",
    "partial-evidence",
    "reject",
    "throw",
    "reentrant",
  ]) {
    let f;
    f = fixture(44100, 4411, {
      onFrame: (frame) => {
        if (kind === "reject") return false;
        if (kind === "throw") throw new Error("consumer_failed");
        if (kind === "reentrant") f.assembler.cancel(owner);
        f.frames.push(frame);
        return true;
      },
    });
    if (["reject", "throw"].includes(kind)) {
      assert.throws(f.stream, /native_descriptor_rejected|consumer_failed/);
      cleaned(f, "failed");
    } else {
      if (kind === "pending") f.assembler.pushEnvelope(f.envelope(4410), owner);
      else if (kind === "spectra")
        f.assembler.pushSpectrum(f.spectrum(FFT), owner);
      else if (kind === "partial-evidence") {
        f.assembler.pushSpectrum(f.spectrum(FFT), owner);
        f.assembler.pushSpectrum(f.spectrum(FFT * 2), owner);
        f.assembler.pushEnvelope(f.envelope(4410), owner);
        assert.equal(f.assembler.intervals.length, 1);
      } else if (kind === "reentrant") assert.throws(f.stream, /closed/);
      else f.stream();
      f.assembler.cancel(owner);
      f.assembler.cancel(owner);
      cleaned(f, "cancelled", 0);
    }
  }
});

test("explicit default-equivalent geometry emits byte-identical v1 frames and evidence", () => {
  const explicit = fixture(48000, 480000, { windows: 100 });
  const coordinates = fixture(48000, 480000, {
    windows: 100,
    coordinates: { startBeat: 0, tempoBpm: 120 },
  });
  const legacy = fixture(48000, 480000, { geometry: undefined, windows: 100 });
  explicit.stream();
  coordinates.stream();
  legacy.stream();
  assert.equal(JSON.stringify(explicit.frames), JSON.stringify(legacy.frames));
  assert.equal(
    JSON.stringify(coordinates.frames),
    JSON.stringify(legacy.frames),
  );
  assert.equal(
    JSON.stringify(explicit.assembler.spectralWindows(owner)),
    JSON.stringify(legacy.assembler.spectralWindows(owner)),
  );
  assert.equal(
    JSON.stringify(coordinates.assembler.spectralWindows(owner)),
    JSON.stringify(legacy.assembler.spectralWindows(owner)),
  );
});

for (const rate of [44100, 48000]) {
  test(`internal ${rate} Hz coordinates start at beat 5.25 at 93 BPM with an exact short final interval`, () => {
    for (const envelopeFirst of [false, true]) {
      const coordinates = { startBeat: 5.25, tempoBpm: 93 };
      const f = fixture(rate, rate * 30 - 1, { coordinates });
      const reference = fixture(rate, rate * 30 - 1);
      coordinates.startBeat = 100;
      coordinates.tempoBpm = 999;
      f.stream(envelopeFirst);
      reference.stream(envelopeFirst);
      assert.equal(f.assembler.state, "covered");
      assert.equal(f.frames.length, 300);
      for (const [index, frame] of f.frames.entries()) {
        const elapsedSamples =
          frame.sample - f.config.originCounter - f.config.hostOffsetSamples;
        assert.equal(frame.beat, 5.25 + elapsedSamples / ((rate * 60) / 93));
        assert.deepEqual(
          { ...frame, beat: reference.frames[index].beat },
          reference.frames[index],
        );
      }
      assert.equal(f.frames[0].beat, 5.405);
      assert.equal(f.frames.at(-1).windowSamples, rate / 10 - 1);
      assert.equal(
        f.frames.at(-1).sample,
        f.config.originCounter + f.config.hostOffsetSamples + rate * 30 - 1,
      );
      assert.deepEqual(
        f.assembler.spectralWindows(owner),
        reference.assembler.spectralWindows(owner),
      );
      assert.deepEqual(f.failures, []);
    }
  });
}

test("coordinates require explicit geometry and exactly two finite bounded numeric fields", () => {
  for (const coordinates of [
    null,
    [],
    120,
    {},
    { startBeat: 0 },
    { tempoBpm: 120 },
    { startBeat: 0, tempoBpm: 120, extra: 1 },
    ...[-1, 1576800.001, NaN, Infinity, -Infinity, "5.25", undefined].map(
      (startBeat) => ({ startBeat, tempoBpm: 93 }),
    ),
    ...[0, 19.999, 999.001, NaN, Infinity, -Infinity, "93", undefined].map(
      (tempoBpm) => ({ startBeat: 5.25, tempoBpm }),
    ),
  ]) {
    assert.throws(
      () => fixture(48000, 4800, { coordinates }),
      /invalid_native_assembler_configuration/,
    );
  }
  assert.throws(
    () =>
      fixture(48000, 4800, {
        windows: 1,
        geometry: undefined,
        coordinates: { startBeat: 0, tempoBpm: 120 },
      }),
    /invalid_native_assembler_configuration/,
  );
  assert.throws(
    () =>
      fixture(48000, 4800, {
        geometry: {
          sampleRate: 48000,
          hopSamples: 4800,
          totalSamples: 4800,
          startBeat: 5.25,
          tempoBpm: 93,
        },
      }),
    /invalid_native_assembler_configuration/,
  );
});

test("inclusive coordinate bounds preserve counter translation and finite beat arithmetic", () => {
  for (const rate of [44100, 48000]) {
    for (const startBeat of [0, 1576800]) {
      for (const tempoBpm of [20, 999]) {
        for (const hostOffsetSamples of [
          -8192,
          Number.MAX_SAFE_INTEGER - 8192 - rate / 10,
        ]) {
          const f = fixture(rate, rate / 10, {
            hostOffsetSamples,
            coordinates: { startBeat, tempoBpm },
          });
          f.stream();
          assert.equal(f.assembler.state, "covered");
          const frame = f.frames[0];
          assert.equal(
            frame.beat,
            startBeat +
              (frame.sample - f.config.originCounter - hostOffsetSamples) /
                ((rate * 60) / tempoBpm),
          );
          assert(Number.isFinite(frame.beat));
        }
      }
    }
  }
});

test("independent stereo FFT and envelope numeric references survive both sample rates without rescaling", async () => {
  const { fftReference } = await import("./fft-reference.mjs");
  const channels = [
    Array.from(
      { length: FFT },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 32 * i) / FFT),
    ),
    Array.from(
      { length: FFT },
      (_, i) => 0.25 * Math.cos((2 * Math.PI * 96 * i) / FFT),
    ),
  ];
  const bins = channels.map((channel) => fftReference(channel));
  const powers = Array.from({ length: FFT / 2 + 1 }, (_, bin) =>
    bins.reduce(
      (sum, { real, imag }) => sum + real[bin] ** 2 + imag[bin] ** 2,
      0,
    ),
  );
  const energy = powers.reduce((sum, power) => sum + power, 0);
  assert(Math.abs(energy - (FFT ** 2 * (0.5 ** 2 + 0.25 ** 2)) / 4) < 1e-7);
  for (const rate of [44100, 48000]) {
    const centroid =
      powers.reduce((sum, power, bin) => sum + (power * bin * rate) / FFT, 0) /
      energy;
    assert(Math.abs(centroid - (((32 * 4 + 96) / 5) * rate) / FFT) < 1e-7);
    const f = fixture(rate, rate / 10 + 1);
    f.assembler.pushSpectrum(f.spectrum(FFT, centroid, energy), owner);
    f.assembler.pushSpectrum(f.spectrum(FFT * 2, centroid, energy), owner);
    const peak = channels.map((channel) => Math.max(...channel.map(Math.abs)));
    const rms = channels.map((channel) =>
      Math.sqrt(channel.reduce((sum, sample) => sum + sample ** 2, 0) / FFT),
    );
    assert(Math.abs(rms[0] - 0.5 / Math.sqrt(2)) < 1e-12);
    assert(Math.abs(rms[1] - 0.25 / Math.sqrt(2)) < 1e-12);
    f.assembler.pushEnvelope(f.envelope(rate / 10, { peak, rms }), owner);
    f.assembler.pushEnvelope(
      f.envelope(rate / 10 + 1, { peak: [0.5, 0.25], rms: [0.5, 0.25] }),
      owner,
    );
    assert.equal(f.assembler.state, "covered");
    for (const frame of f.frames) {
      assert.equal(frame.centroidHz, centroid);
      assert.equal(frame.spectralEnergy, energy);
    }
    assert.deepEqual(f.frames[0].rms, rms);
    assert.deepEqual(f.frames[1].rms, [0.5, 0.25]);
    assert.equal(f.frames[1].windowSamples, 1);
  }
});
