import { describe, expect, it } from "vitest";
import { createSyntheticMetricListeningObservation } from "./testing.js";
import { segmentListeningObservation } from "./listening-feature-segmentation.js";
import type { ListeningMusicalAlignment } from "./listening-musical-alignment.js";

const alignment: ListeningMusicalAlignment = {
  version: 1,
  coordinate: "transport-beats",
  meter: { numerator: 4, denominator: 4 },
  barOriginBeat: 0,
  tempoBpm: 120,
  tempoEvidence: "message-rate-monitored-constant",
  provenance: "capture-snapshot/v1",
};

describe("trusted listening feature segmentation", () => {
  it("keeps missing or mismatched evidence unaligned without guessing a short or bar range", () => {
    const observation = createSyntheticMetricListeningObservation({
      endBeat: 8,
    });
    expect(segmentListeningObservation(observation)).toMatchObject([
      {
        kind: "unaligned",
        startBeat: 0,
        endBeat: 8,
        alignment: null,
        alignmentReason: "musical-bar-alignment-not-established",
      },
    ]);
    for (const change of [
      { tempoBpm: 121 },
      { coordinate: "clip-local-beats" as const },
    ]) {
      expect(
        segmentListeningObservation(observation, { ...alignment, ...change }),
      ).toMatchObject([
        {
          kind: "unaligned",
          alignmentReason: "musical-alignment-incompatible",
        },
      ]);
    }
  });

  it("partitions two complete bars without gaps, overlap, rounding or duplicated source samples", () => {
    const observation = createSyntheticMetricListeningObservation({
      endBeat: 8,
    });

    const segments = segmentListeningObservation(observation, alignment);
    expect(
      segments.map((s) => [s.kind, s.startBeat, s.endBeat, s.order]),
    ).toEqual([
      ["bar", 0, 4, 0],
      ["bar", 4, 8, 1],
    ]);
    expect(segments.map((s) => s.grid!.cells.length)).toEqual([16, 16]);
    expect(segments[0]!.startSample).toBe(observation.geometry.startSample);
    expect(segments[0]!.endSample).toBe(segments[1]!.startSample);
    expect(segments[1]!.endSample).toBe(observation.geometry.endSample);
  });

  it("uses identical sample rounding to the retained source geometry at fractional tempi", () => {
    const observation = createSyntheticMetricListeningObservation({
      endBeat: 12,
      tempoBpm: 563.2,
    });
    const segments = segmentListeningObservation(observation, {
      ...alignment,
      tempoBpm: 563.2,
    });
    expect(segments.flatMap((segment) => segment.grid!.cells)).toEqual(
      observation.geometry.rows,
    );
  });

  it("keeps a sub-bar capture as one short segment even across a bar boundary", () => {
    const observation = createSyntheticMetricListeningObservation({
      startBeat: 3.75,
      endBeat: 4.5,
    });
    expect(segmentListeningObservation(observation, alignment)).toMatchObject([
      {
        kind: "short",
        startBeat: 3.75,
        endBeat: 4.5,
        grid: { phaseBeats: 3.75 },
      },
    ]);
  });

  it("retains explicit leading and trailing partials rather than stretching complete bars", () => {
    const observation = createSyntheticMetricListeningObservation({
      startBeat: 1,
      endBeat: 10,
    });
    expect(
      segmentListeningObservation(observation, alignment).map((s) => [
        s.kind,
        s.startBeat,
        s.endBeat,
      ]),
    ).toEqual([
      ["partial", 1, 4],
      ["bar", 4, 8],
      ["partial", 8, 10],
    ]);
  });

  it("uses twelve quarter-beat cells in 3/4 with a fractional evidenced origin", () => {
    const observation = createSyntheticMetricListeningObservation({
      startBeat: 0.125,
      endBeat: 6.125,
    });
    const segments = segmentListeningObservation(observation, {
      ...alignment,
      barOriginBeat: 0.125,
      meter: { numerator: 3, denominator: 4 },
    });
    expect(
      segments.map((s) => [
        s.kind,
        s.startBeat,
        s.endBeat,
        s.grid!.cells.length,
      ]),
    ).toEqual([
      ["bar", 0.125, 3.125, 12],
      ["bar", 3.125, 6.125, 12],
    ]);
    const partial = segmentListeningObservation(
      createSyntheticMetricListeningObservation({
        startBeat: 0.2,
        endBeat: 6.2,
      }),
      {
        ...alignment,
        barOriginBeat: 0.125,
        meter: { numerator: 3, denominator: 4 },
      },
    );
    expect(partial.map((s) => s.kind)).toEqual(["partial", "bar", "partial"]);
    expect(partial[0]!.grid!.cells[0]).toMatchObject({
      startBeat: 0.2,
      endBeat: 0.375,
    });
    expect(partial.at(-1)!.endBeat).toBe(6.2);
  });

  it("denies segment and total-cell overflow without truncating output", () => {
    expect(() =>
      segmentListeningObservation(
        createSyntheticMetricListeningObservation({ endBeat: 20 }),
        { ...alignment, meter: { numerator: 1, denominator: 128 } },
      ),
    ).toThrow("feature_segment_limit");
    expect(() =>
      segmentListeningObservation(
        createSyntheticMetricListeningObservation({
          endBeat: 499.5,
          tempoBpm: 999,
        }),
        {
          ...alignment,
          tempoBpm: 999,
          meter: { numerator: 33, denominator: 128 },
        },
      ),
    ).toThrow("feature_grid_cell_limit");
  });
});
