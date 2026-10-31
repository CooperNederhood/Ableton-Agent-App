import { describe, expect, it } from "vitest";
import {
  createMetricListeningGeometry,
  metricListeningGeometryInputSchema,
  metricListeningGeometrySchema,
} from "./metric-listening-geometry.js";

const input = {
  sampleRate: 48_000 as const,
  vectorSize: 64,
  tempoBpm: 128,
  startBeat: 0,
  endBeat: 4,
  startSample: 1_594_560,
};

describe("independent metric musical geometry", () => {
  it("uses sixteen exact musical rows for the user's four-beat capture", () => {
    const value = createMetricListeningGeometry(input);
    expect(value.totalSamples).toBe(90_000);
    expect(value.rows).toHaveLength(16);
    expect(value.budgets.levelRecords).toBe(16);
    expect(value.rows[0]).toEqual({
      startBeat: 0,
      endBeat: 0.25,
      startSample: input.startSample,
      endSample: input.startSample + 5_625,
    });
    expect(value.rows.at(-1)?.endSample).toBe(input.startSample + 90_000);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.rows[0])).toBe(true);
    expect(Object.isFrozen(value.budgets)).toBe(true);
  });

  it("keeps fractional Arrangement boundaries on the global musical grid", () => {
    const value = createMetricListeningGeometry({
      ...input,
      startBeat: 3.9,
      endBeat: 4.3,
    });
    expect(
      value.rows.map(({ startBeat, endBeat }) => [startBeat, endBeat]),
    ).toEqual([
      [3.9, 4],
      [4, 4.25],
      [4.25, 4.3],
    ]);
    expect(value.rows.at(-1)?.endSample).toBe(value.endSample);
  });

  it.each([44_100, 48_000] as const)(
    "rounds each boundary independently without drift at %i Hz",
    (sampleRate) => {
      const value = createMetricListeningGeometry({
        ...input,
        sampleRate,
        tempoBpm: 137,
        endBeat: 60,
      });
      let previous = value.startSample;
      for (const row of value.rows) {
        expect(row.startSample).toBe(previous);
        expect(row.endSample).toBe(
          value.startSample + Math.round((row.endBeat * sampleRate * 60) / 137),
        );
        previous = row.endSample;
      }
      expect(previous).toBe(value.endSample);
      expect(
        new Set(value.rows.map((row) => row.endSample - row.startSample)).size,
      ).toBeGreaterThan(1);
    },
  );

  it.each([120, 128, 180, 999])(
    "retains thirty seconds with bounded row counts at %i BPM",
    (tempoBpm) => {
      const value = createMetricListeningGeometry({
        ...input,
        tempoBpm,
        endBeat: tempoBpm / 2,
      });
      expect(value.totalSamples).toBe(1_440_000);
      expect(value.rows).toHaveLength(tempoBpm * 2);
      expect(value.budgets.spectrumRecords).toBeLessThanOrEqual(706);
      expect(value.budgets.attackDetectorWindows).toBe(300);
    },
  );

  it.each([44_100, 48_000] as const)(
    "admits exact thirty-second fractional-tempo ranges at large song positions at %i Hz",
    (sampleRate) => {
      for (const tempoBpm of [20.1, 83.7, 128.3, 137.3]) {
        for (const startBeat of [3.9, 1234.125, 1_000_000.1]) {
          const endBeat = startBeat + tempoBpm / 2;
          const value = createMetricListeningGeometry({
            ...input,
            sampleRate,
            tempoBpm,
            startBeat,
            endBeat,
          });
          expect(value.totalSamples).toBe(sampleRate * 30);
          expect(value.rows.at(-1)?.endSample).toBe(value.endSample);
          expect(() =>
            createMetricListeningGeometry({
              ...input,
              sampleRate,
              tempoBpm,
              startBeat,
              endBeat: endBeat + tempoBpm / (60 * sampleRate),
            }),
          ).toThrow("unsupported_metric_listening_duration");
        }
      }
    },
  );

  it.each([
    { endBeat: 0 },
    { endBeat: 65 },
    { tempoBpm: 1_000 },
    { sampleRate: 96_000 },
    { vectorSize: 63 },
    { startSample: 2 ** 44 - 10 },
    { endBeat: 0.00000001 },
  ])("rejects unsupported input before any acquisition %#", (change) => {
    expect(() =>
      createMetricListeningGeometry(
        metricListeningGeometryInputSchema.parse({ ...input, ...change }),
      ),
    ).toThrow();
  });

  it("rejects fractional end slices that round to an empty sample interval", () => {
    expect(() =>
      createMetricListeningGeometry({ ...input, endBeat: 0.2500000001 }),
    ).toThrow();
  });

  it("does not accept forged coverage, row coordinates or record budgets", () => {
    const value = createMetricListeningGeometry(input);
    for (const change of [
      { totalSamples: 90_001 },
      { endSample: value.endSample + 1 },
      { rows: value.rows.slice(1) },
      {
        rows: value.rows.map((row) => ({
          ...row,
          endSample: row.endSample + 1,
        })),
      },
      { budgets: { ...value.budgets, spectrumRecords: 1 } },
      { budgets: { ...value.budgets, levelRecords: 300 } },
      { rawAudio: "forbidden" },
    ]) {
      expect(
        metricListeningGeometrySchema.safeParse({ ...value, ...change })
          .success,
      ).toBe(false);
    }
  });
});
