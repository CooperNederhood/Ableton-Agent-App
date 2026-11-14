import { describe, expect, it } from "vitest";
import {
  createContinuousMetricListeningGeometry,
  metricContinuousListeningGeometrySchema,
  MAX_ARRANGEMENT_LISTENING_EXECUTION_MS,
} from "./metric-continuous-geometry.js";
import {
  createMetricListeningGeometry,
  metricListeningGeometrySchema,
} from "./metric-listening-geometry.js";
import { nativeMetricListeningConfigSchema } from "./native-metric-listening-schemas.js";

const input = {
  captureMode: "arrangement-continuous" as const,
  sampleRate: 48_000 as const,
  vectorSize: 64,
  tempoBpm: 120,
  startBeat: 0,
  endBeat: 1200,
  startSample: 100_000,
};

describe("explicit continuous Arrangement geometry", () => {
  it("exports a finite 900-second Arrangement execution ceiling separate from audio duration", () => {
    expect(MAX_ARRANGEMENT_LISTENING_EXECUTION_MS).toBe(900_000);
    expect(MAX_ARRANGEMENT_LISTENING_EXECUTION_MS).toBeGreaterThan(600 * 1000);
  });
  it.each([44_100, 48_000] as const)(
    "admits exactly 600 seconds with canonical sample rounding at %i Hz",
    (sampleRate) => {
      const geometry = createContinuousMetricListeningGeometry({
        ...input,
        sampleRate,
        tempoBpm: 137.3,
        startBeat: 1_000_000.1,
        endBeat: 1_000_000.1 + 1373,
      });
      expect(geometry.totalSamples).toBe(sampleRate * 600);
      expect(geometry.rows.at(-1)?.endSample).toBe(geometry.endSample);
      expect(geometry.budgets.attackDetectorWindows).toBe(6000);
      expect(geometry.budgets.spectrumRecords).toBe(
        Math.ceil((sampleRate * 600) / 2048) + 2,
      );
      expect(Object.isFrozen(geometry.rows[0])).toBe(true);
      let previous = geometry.startSample;
      for (const row of geometry.rows) {
        expect(row.startSample).toBe(previous);
        expect(row.endSample).toBe(
          geometry.startSample +
            Math.round(
              ((row.endBeat - geometry.startBeat) * sampleRate * 60) /
                geometry.tempoBpm,
            ),
        );
        previous = row.endSample;
      }
    },
  );

  it("admits the maximum tempo and fractional global-grid edges without a hidden short row cap", () => {
    const geometry = createContinuousMetricListeningGeometry({
      ...input,
      tempoBpm: 999,
      startBeat: 0.1,
      endBeat: 9990.1,
    });
    expect(geometry.rows).toHaveLength(39_961);
    expect(geometry.budgets.spectrumRecords).toBe(14_065);
  });

  it.each([
    { endBeat: 1200 + 1 / 24000 },
    { endBeat: 0 },
    { endBeat: 0.000000001 },
    { startSample: 2 ** 44 - 10 },
    { captureMode: "session" },
    { captureMode: undefined },
  ])("rejects unsupported continuous geometry %#", (change) => {
    expect(() =>
      createContinuousMetricListeningGeometry({
        ...input,
        ...change,
      } as typeof input),
    ).toThrow();
  });

  it("rejects tampered sample coverage, budgets and grids", () => {
    const geometry = createContinuousMetricListeningGeometry(input);
    for (const change of [
      { totalSamples: geometry.totalSamples - 1 },
      { rows: geometry.rows.slice(1) },
      { endSample: geometry.endSample + 1 },
      { budgets: { ...geometry.budgets, spectrumRecords: 706 } },
      {
        rows: geometry.rows.map((row) => ({
          ...row,
          endSample: row.endSample + 1,
        })),
      },
    ])
      expect(
        metricContinuousListeningGeometrySchema.safeParse({
          ...geometry,
          ...change,
        }).success,
      ).toBe(false);
  });

  it("does not enable long v1 observations, native configs or Session captures", () => {
    const geometry = createContinuousMetricListeningGeometry(input);
    expect(metricListeningGeometrySchema.safeParse(geometry).success).toBe(
      false,
    );
    const { captureMode: _mode, ...legacyInput } = input;
    expect(_mode).toBe("arrangement-continuous");
    expect(() => createMetricListeningGeometry(legacyInput)).toThrow(
      "unsupported_metric_listening_duration",
    );
    for (const mode of ["session", "arrangement"]) {
      expect(
        nativeMetricListeningConfigSchema.safeParse({
          scope: "independent-metric-timelines/v1",
          algorithmVersion: "3.0.0",
          geometry,
          mode,
          sourceEvidence: "transport-only",
          requestedMetrics: ["level"],
          timingPolicy: {
            mode: "descriptive",
            maxClockDisagreementSamples: 64,
          },
          grid: {
            beats: 0.25,
            anchor: "global-beat-grid",
            rounding: "nearest-sample",
            coordinates: "capture-local",
          },
        }).success,
      ).toBe(false);
    }
  });
});
