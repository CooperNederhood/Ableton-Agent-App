/* global URL */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { ENVELOPE_CODE, SPECTRUM_CODE } from "./native-source.mjs";
import { genModel } from "./gen-model.mjs";
import { fftReference as fft } from "./fft-reference.mjs";

// IMPORTANT: this is a numeric executable model of the authored GenExpr text,
// NOT a Max compiler/DSP test. It does not validate scheduling or FFT latency.
function spectrum(left, right, code = SPECTRUM_CODE, sampleRate = 48000) {
  const l = fft(left),
    r = fft(right);
  const gen = genModel(code, 2, sampleRate);
  let out;
  for (let bin = 0; bin < left.length; bin++) {
    out = gen.step(l.real[bin], l.imag[bin], r.real[bin], r.imag[bin], bin);
  }
  return out;
}
function close(actual, expected, tolerance = 1e-8) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
}
const zero = () => Array(2048).fill(0);
const tone = (bin = 32, amplitude = 1) =>
  Array.from(
    { length: 2048 },
    (_, i) => amplitude * Math.sin((2 * Math.PI * bin * i) / 2048),
  );

test("GenExpr model: native per-channel 100ms peak/RMS, reset and sample rate-dependent hop", () => {
  for (const sr of [8000, 44100, 48000, 96000, 384000]) {
    const gen = genModel(ENVELOPE_CODE, 5, sr);
    const hop = Math.round(sr / 10);
    let out;
    for (let i = 0; i < hop; i++) out = gen.step(i === 0 ? 1 : 0, 0.5);
    close(out[0], 1);
    close(out[1], 0.5);
    close(out[2], 1 / Math.sqrt(hop));
    close(out[3], 0.5);
    assert.equal(out[4], hop);
    gen.reset();
    for (let i = 0; i < hop; i++) out = gen.step(0, 0);
    assert.deepEqual(out, [0, 0, 0, 0, hop]);
  }
});
test("GenExpr model: silence, DC, mono tone, anti-phase stereo and Nyquist", () => {
  assert.deepEqual(spectrum(zero(), zero()), [0, 0]);
  close(spectrum(Array(2048).fill(1), zero())[0], 0);
  const wave = tone();
  const mono = spectrum(wave, zero());
  const inPhase = spectrum(wave, wave);
  const antiPhase = spectrum(
    wave,
    wave.map((x) => -x),
  );
  close(mono[0], 750, 1e-6);
  close(inPhase[0], mono[0]);
  close(antiPhase[0], mono[0]);
  close(antiPhase[1], 2 * mono[1], 1e-6);
  close(
    spectrum(
      Array.from({ length: 2048 }, (_, i) => (i % 2 ? -1 : 1)),
      zero(),
    )[0],
    24000,
  );
});
test("GenExpr model rejects assignment to the built-in Euler constant instead of masking the native regression", () => {
  assert.throws(
    () => genModel(SPECTRUM_CODE.replaceAll("binEnergy", "e"), 2),
    /Gen constant e cannot be assigned/,
  );
});
test("GenExpr model: impulse flat spectrum and energy-weighted independent channel tone pooling", () => {
  const impulse = zero();
  impulse[0] = 1;
  close(spectrum(impulse, zero())[0], 12000);
  // Channel energy ratio 1:4 => (750 + 4*1500)/5 = 1350Hz.
  close(spectrum(tone(32), tone(64, 2))[0], 1350, 1e-6);
  for (const sr of [44100, 48000, 96000]) {
    close(
      spectrum(tone(32), zero(), SPECTRUM_CODE, sr)[0],
      (32 * sr) / 2048,
      1e-6,
    );
  }
});
test("regressions are sensitive: downmix-before-FFT mutation fails anti-phase fixture", () => {
  const bad = SPECTRUM_CODE.replace(
    "in1 * in1 + in2 * in2 + in3 * in3 + in4 * in4",
    "(in1 + in3) * (in1 + in3) + (in2 + in4) * (in2 + in4)",
  );
  assert.notEqual(bad, SPECTRUM_CODE);
  const wave = tone();
  const out = spectrum(
    wave,
    wave.map((x) => -x),
    bad,
  );
  assert.throws(() => close(out[0], 750, 1e-6));
});
test("regressions are sensitive: RMS divide mutation and omitted reset fail numeric fixtures", () => {
  const bad = genModel(
    ENVELOPE_CODE.replace("sqrt(sumL / hop)", "sqrt(sumL)"),
    5,
  );
  let out;
  for (let i = 0; i < 4800; i++) out = bad.step(0.5, 0);
  assert.throws(() => close(out[2], 0.5));
  const gen = genModel(ENVELOPE_CODE, 5);
  for (let i = 0; i < 4800; i++) out = gen.step(1, 1);
  assert.throws(() => assert.deepEqual(out.slice(0, 4), [0, 0, 0, 0]));
});
test("native Max-JS watchdog independently mutes and resets on lost Node heartbeat and deletion", async () => {
  const code = await readFile(
    new URL("./audio_listener_guard.js", import.meta.url),
    "utf8",
  );
  const messages = [];
  const tasks = [];
  const context = vm.createContext({
    outlet: (...args) => messages.push(args),
    Task: function (fn) {
      this.fn = fn;
      this.repeat = () => {};
      this.cancel = () => {
        this.cancelled = true;
      };
      tasks.push(this);
    },
  });
  vm.runInContext(code, context);
  context.analysis(1, 1, 48000);
  assert.deepEqual(messages.slice(-1)[0], [0, "mute", 0, 0]);
  for (let i = 0; i < 7; i++) context.check();
  assert.equal(context.active, true);
  context.check();
  assert.equal(context.active, false);
  assert.deepEqual(messages.slice(-2), [
    [0, "mute", 0, 1],
    [1, "reset"],
  ]);
  context.analysis(1, 1, 44100);
  for (let i = 0; i < 1200; i++) {
    context.heartbeat();
    context.check();
  }
  assert.equal(context.active, false); // independent 300s maximum even with healthy Node
  context.notifydeleted();
  assert.equal(tasks[0].cancelled, true);
});
