export interface KnownListeningFixture {
  readonly wav: Uint8Array;
  readonly sampleRate: number;
  readonly tempo: number;
  readonly durationBeats: number;
  readonly onsetBeats: readonly number[];
  readonly gateDurationBeats: number;
  readonly fadeSamples: number;
  readonly frequencyHz: number | null;
  readonly reference: {
    readonly peak: readonly [number, number];
    readonly rmsDbfs: readonly [number | null, number | null];
  };
}

/** Test input, never a recording or a runtime context payload. */
export function createKnownListeningFixture(
  kind: "quarter-sine" | "anti-phase-quarter-sine" | "silence",
): KnownListeningFixture {
  if (!["quarter-sine", "anti-phase-quarter-sine", "silence"].includes(kind)) {
    throw new Error("Unsupported listening fixture");
  }
  const sampleRate = 48_000;
  const tempo = 120;
  const frames = 96_000;
  const beatSamples = 24_000;
  const gateSamples = 12_000;
  const fadeSamples = 240;
  const wav = new Uint8Array(44 + frames * 4);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 4, true);
  const peaks: [number, number] = [0, 0];
  const energy: [number, number] = [0, 0];
  for (let frame = 0; frame < frames; frame += 1) {
    const position = frame % beatSamples;
    const envelope = Math.max(
      0,
      Math.min(
        1,
        position / fadeSamples,
        (gateSamples - position) / fadeSamples,
      ),
    );
    const left =
      kind === "silence"
        ? 0
        : Math.round(
            16_384 *
              envelope *
              Math.sin((2 * Math.PI * 440 * frame) / sampleRate),
          );
    const values: [number, number] = [
      left,
      kind === "anti-phase-quarter-sine" ? -left : left,
    ];
    values.forEach((value, channel) => {
      view.setInt16(44 + frame * 4 + channel * 2, value, true);
      const normalized = value / 32_768;
      peaks[channel] = Math.max(peaks[channel] ?? 0, Math.abs(normalized));
      energy[channel] = (energy[channel] ?? 0) + normalized * normalized;
    });
  }
  const rmsDbfs = (power: number) =>
    power === 0 ? null : 10 * Math.log10(power / frames);
  return {
    wav,
    sampleRate,
    tempo,
    durationBeats: 4,
    onsetBeats: kind === "silence" ? [] : [0, 1, 2, 3],
    gateDurationBeats: 0.5,
    fadeSamples,
    frequencyHz: kind === "silence" ? null : 440,
    reference: {
      peak: peaks,
      rmsDbfs: [rmsDbfs(energy[0]), rmsDbfs(energy[1])],
    },
  };
}
