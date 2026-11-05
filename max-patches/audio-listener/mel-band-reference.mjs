import { fftReference } from "./fft-reference.mjs";

const WINDOW = 2048;
const BANDS = 24;
const mel = (frequency) => 1127.01048 * Math.log1p(frequency / 700);
const lowerMel = mel(20);
const upperMel = mel(20000);
const edges = Array.from(
  { length: BANDS + 2 },
  (_, index) =>
    700 *
    Math.expm1(
      (lowerMel + ((upperMel - lowerMel) * index) / (BANDS + 1)) / 1127.01048,
    ),
);

export const melBandReferenceDefinitions = Object.freeze(
  Array.from({ length: BANDS }, (_, index) =>
    Object.freeze({
      index,
      lowerHz: edges[index],
      centerHz: edges[index + 1],
      upperHz: edges[index + 2],
    }),
  ),
);

// Test-only mathematical oracle. It imports no production mel implementation
// and establishes neither host frame support nor bundled-binary qualification.
export function melBandReference(samples, sampleRate) {
  if (sampleRate !== 44100 && sampleRate !== 48000)
    throw new RangeError("mel_reference_sample_rate");
  if (!Array.isArray(samples) || samples.length !== WINDOW)
    throw new RangeError("mel_reference_window");
  for (const sample of samples)
    if (!Number.isFinite(sample) || Math.abs(sample) > 64)
      throw new RangeError("mel_reference_input");

  const { real, imag } = fftReference(
    samples.map(
      (sample, index) =>
        sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / WINDOW)),
    ),
  );
  const magnitudes = real
    .slice(0, WINDOW / 2 + 1)
    .map((value, index) => Math.hypot(value, imag[index]));
  return melBandReferenceDefinitions.map((band) =>
    magnitudes.reduce((sum, magnitude, index) => {
      const frequency = (index * sampleRate) / WINDOW;
      const weight = Math.max(
        0,
        Math.min(
          (frequency - band.lowerHz) / (band.centerHz - band.lowerHz),
          (band.upperHz - frequency) / (band.upperHz - band.centerHz),
        ),
      );
      return sum + weight * magnitude;
    }, 0),
  );
}
