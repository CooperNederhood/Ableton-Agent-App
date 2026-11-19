import { describe, expect, it } from "vitest";

import { listeningSummarySchema } from "./listening-feature-views.js";
import {
  detectListeningRelationships,
  type ListeningSummaryCell,
} from "./listening-relationships.js";

const empty = { featureRelationships: [], candidateChecks: [] };
const attackFeature = "attack-activity-grid/v1";
const centroidFeature = "centroid-grid/v1";
const levelFeature = "level-grid/v1";
const melFeature = "mel-grid/v1";

function grid(
  rows: readonly Partial<ListeningSummaryCell>[],
): ListeningSummaryCell[] {
  return rows.map((row, i) => ({
    startBeat: i,
    endBeat: i + 1,
    attacks: null,
    rmsAmplitude: null,
    centroidHz: null,
    ...row,
  }));
}

function read(startBeat: number, endBeat: number, ...featureTypes: string[]) {
  return { action: "read", range: { startBeat, endBeat }, featureTypes };
}

function mel(band: number, scale = 1): number[] {
  return Array.from({ length: 48 }, (_, index) => (index === band ? scale : 0));
}

describe("detectListeningRelationships", () => {
  it("finds the longest run across the full grid and cites only its exact witness", () => {
    const attacks = [
      1,
      0,
      1,
      0,
      1,
      0,
      1,
      null,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
      0,
      0,
      1,
    ];
    const cells = grid(attacks.map((value) => ({ attacks: value })));
    const result = detectListeningRelationships(cells);

    expect(result).toEqual({
      candidateChecks: [],
      featureRelationships: [
        {
          kind: "repeated-attack-spacing",
          version: 1,
          spacingBeats: 3,
          observations: 3,
          evidence: [read(8, 18, attackFeature)],
        },
      ],
    });
    expect(detectListeningRelationships(cells)).toEqual(result);
  });

  it.each([null, 2])(
    "does not infer spacing across an unknown or multi-attack cell (%s)",
    (gap) => {
      const values = [1, 0, 1, gap, 1, 0, 1];
      const result = detectListeningRelationships(
        grid(values.map((attacks) => ({ attacks }))),
      );
      expect(
        result.featureRelationships.some(
          (item) => item.kind === "repeated-attack-spacing",
        ),
      ).toBe(false);
    },
  );

  it("measures attack spacing in beats rather than cell indices", () => {
    const cells = grid([
      { startBeat: 4, endBeat: 4.25, attacks: 1 },
      { startBeat: 4.25, endBeat: 4.5, attacks: 1 },
      { startBeat: 4.5, endBeat: 4.75, attacks: 1 },
      { startBeat: 4.75, endBeat: 4.9, attacks: 1 },
    ]);
    expect(detectListeningRelationships(cells).featureRelationships).toEqual([
      {
        kind: "repeated-attack-spacing",
        version: 1,
        spacingBeats: 0.25,
        observations: 3,
        evidence: [read(4, 4.9, attackFeature)],
      },
    ]);
  });

  it("cites both supporting features for alternating brightness, in attack order", () => {
    const cells = grid([
      {},
      ...[74, 302, 72, 286].flatMap((centroidHz) => [
        { attacks: 1, centroidHz },
        { attacks: 0, centroidHz: null },
      ]),
      {},
    ]);
    const result = detectListeningRelationships(cells);
    expect(
      result.featureRelationships.find(
        (item) => item.kind === "alternating-attack-brightness",
      ),
    ).toEqual({
      kind: "alternating-attack-brightness",
      version: 1,
      centroidHzByPhase: [73, 294],
      observations: 4,
      evidence: [read(1, 8, attackFeature, centroidFeature)],
    });
    expect(
      listeningSummarySchema
        .pick({ featureRelationships: true, candidateChecks: true })
        .parse(result),
    ).toEqual(result);
  });

  it.each([
    ["unsupported", [300, 1000, null, 1000, 300, 1000]],
    ["trending", [300, 400, 500, 600, 700, 800]],
    ["weak", [300, 325, 300, 325, 300, 325]],
  ] as const)("rejects %s phase separation", (_, values) => {
    expect(
      detectListeningRelationships(
        grid(values.map((centroidHz) => ({ attacks: 1, centroidHz }))),
      ).featureRelationships.some(
        (item) => item.kind === "alternating-attack-brightness",
      ),
    ).toBe(false);
  });

  it("ranks local changes over all adjacent windows; a tie keeps the earliest boundary", () => {
    const cells = grid(
      [
        0.1,
        0.1,
        0.2,
        0.2,
        null,
        0.8,
        0.8,
        0.2,
        0.2,
        null,
        0.2,
        0.2,
        0.8,
        0.8,
      ].map((rmsAmplitude) => ({ rmsAmplitude })),
    );
    expect(detectListeningRelationships(cells).featureRelationships).toEqual([
      {
        kind: "local-change",
        metric: "rmsAmplitude",
        version: 1,
        before: 0.8,
        after: 0.2,
        observations: 4,
        evidence: [read(5, 7, levelFeature), read(7, 9, levelFeature)],
      },
    ]);
  });

  it("weights continuous changes by actual beat widths and does not compare unequal count windows", () => {
    const cells = grid([
      { attacks: 0, rmsAmplitude: 0.1 },
      { attacks: 0, rmsAmplitude: 0.1 },
      { attacks: 2, rmsAmplitude: 0.6 },
      { attacks: 2, rmsAmplitude: 0.2, endBeat: 3.25 },
    ]);
    expect(detectListeningRelationships(cells).featureRelationships).toEqual([
      {
        kind: "local-change",
        metric: "rmsAmplitude",
        version: 1,
        before: 0.1,
        after: 0.52,
        observations: 4,
        evidence: [read(0, 2, levelFeature), read(2, 3.25, levelFeature)],
      },
    ]);
  });

  it("reports actual attack totals over equal-duration windows and suppresses tiny changes", () => {
    const cells = grid([
      { attacks: 0, rmsAmplitude: 0.5, centroidHz: 500 },
      { attacks: 0, rmsAmplitude: 0.5, centroidHz: 500 },
      { attacks: 2, rmsAmplitude: 0.501, centroidHz: 550 },
      { attacks: 1, rmsAmplitude: 0.501, centroidHz: 550 },
    ]);
    expect(detectListeningRelationships(cells).featureRelationships).toEqual([
      {
        kind: "local-change",
        metric: "attackCount",
        version: 1,
        before: 0,
        after: 3,
        observations: 4,
        evidence: [read(0, 2, attackFeature), read(2, 4, attackFeature)],
      },
    ]);
  });

  it("does not bridge null support or a beat gap to find a local change", () => {
    expect(
      detectListeningRelationships(
        grid([
          { rmsAmplitude: 1 },
          { rmsAmplitude: 1 },
          {},
          { rmsAmplitude: 0 },
          { rmsAmplitude: 0 },
        ]),
      ),
    ).toEqual(empty);
    expect(
      detectListeningRelationships(
        grid([
          { rmsAmplitude: 1 },
          { rmsAmplitude: 1 },
          { rmsAmplitude: 0, startBeat: 2.5 },
          { rmsAmplitude: 0 },
        ]),
      ),
    ).toEqual(empty);
  });

  it("only nominates recurrence from distinct, comparable mel shapes, with two narrow reads", () => {
    const cells = grid([
      {},
      { mel: mel(0, 0.2) },
      { mel: mel(24, 0.3) },
      {},
      {},
      { mel: mel(0, 0.4) },
      { mel: mel(24, 0.5) },
      {},
    ]);
    const result = detectListeningRelationships(cells);
    expect(result).toEqual({
      featureRelationships: [],
      candidateChecks: [
        {
          kind: "spectral-recurrence",
          version: 1,
          evidence: [read(1, 3, melFeature), read(5, 7, melFeature)],
        },
      ],
    });
    expect(
      listeningSummarySchema
        .pick({ featureRelationships: true, candidateChecks: true })
        .parse(result),
    ).toEqual(result);
  });

  it.each([
    ["silent", mel(-1)],
    ["nonfinite", mel(0, Infinity)],
    ["negative", mel(0, -0.5)],
    ["wrong dimensions", [0.2, 0.3]],
    ["static", mel(24)],
    ["different shape", mel(26)],
  ] as const)(
    "does not nominate spectral recurrence with %s evidence",
    (_, suspect) => {
      expect(
        detectListeningRelationships(
          grid([
            { mel: suspect },
            { mel: mel(24) },
            { mel: mel(0) },
            { mel: mel(24) },
          ]),
        ),
      ).toEqual(empty);
    },
  );

  it("bounds spectral lag and excludes unequal-duration pattern windows", () => {
    const motif = [{ mel: mel(0) }, { mel: mel(24) }];
    expect(
      detectListeningRelationships(
        grid([...motif, ...Array.from({ length: 31 }, () => ({})), ...motif]),
      ),
    ).toEqual(empty);
    expect(
      detectListeningRelationships(
        grid([...motif, ...motif.slice(0, 1), { mel: mel(24), endBeat: 3.5 }]),
      ),
    ).toEqual(empty);
  });

  it("returns an empty result without support and propagates abort reasons", () => {
    expect(detectListeningRelationships([])).toEqual(empty);
    expect(detectListeningRelationships(grid([{}, {}, {}, {}]))).toEqual(empty);
    const reason = new Error("cancelled listening summary");
    expect(() =>
      detectListeningRelationships([], AbortSignal.abort(reason)),
    ).toThrow(reason);
  });
});
