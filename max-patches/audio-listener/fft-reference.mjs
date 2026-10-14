// Independent test/engineering oracle; no listener implementation is imported.
export function fftReference(samples) {
  const n = samples.length;
  if (n < 2 || n > 65536 || (n & (n - 1)) !== 0)
    throw new Error("bounded power-of-two FFT input required");
  const real = Array.from(samples),
    imag = Array(n).fill(0);
  if (real.some((value) => !Number.isFinite(value)))
    throw new Error("finite FFT input required");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let size = 2; size <= n; size *= 2) {
    for (let base = 0; base < n; base += size) {
      for (let i = 0; i < size / 2; i++) {
        const a = base + i,
          b = a + size / 2,
          angle = (-2 * Math.PI * i) / size;
        const tr = real[b] * Math.cos(angle) - imag[b] * Math.sin(angle);
        const ti = real[b] * Math.sin(angle) + imag[b] * Math.cos(angle);
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
      }
    }
  }
  return { real, imag };
}
