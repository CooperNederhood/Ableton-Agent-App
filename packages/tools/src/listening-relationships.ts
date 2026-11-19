import type {
  FeatureRelationship,
  ListeningSummary,
} from "./listening-feature-views.js";

/** One cell of an ordered full grid. Unknown support must remain null, not zero. */
export interface ListeningSummaryCell {
  startBeat: number;
  endBeat: number;
  attacks: number | null;
  rmsAmplitude: number | null;
  centroidHz: number | null;
  /** Fully supported stereo 24-band mel-grid vector, when available. */
  mel?: readonly number[];
}

type Summary = Pick<
  ListeningSummary,
  "featureRelationships" | "candidateChecks"
>;
type Evidence = FeatureRelationship["evidence"][number];
type Metric = Extract<FeatureRelationship, { kind: "local-change" }>["metric"];
type Detector = (
  cells: readonly ListeningSummaryCell[],
  result: Summary,
  signal?: AbortSignal,
) => void;

const ATTACK = "attack-activity-grid/v1";
const CENTROID = "centroid-grid/v1";
const MEL = "mel-grid/v1";
const BEAT_TOLERANCE = 1e-8; // Only for grid arithmetic, not timing variation.

function evidence(
  first: ListeningSummaryCell,
  last: ListeningSummaryCell,
  ...featureTypes: Evidence["featureTypes"]
): Evidence {
  return {
    action: "read",
    range: { startBeat: first.startBeat, endBeat: last.endBeat },
    featureTypes,
  };
}

function measured(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function validGeometry(cell: ListeningSummaryCell): boolean {
  return (
    measured(cell.startBeat) &&
    Number.isFinite(cell.endBeat) &&
    cell.endBeat > cell.startBeat
  );
}

function sameBeats(a: number, b: number): boolean {
  return Math.abs(a - b) <= BEAT_TOLERANCE;
}

function touches(
  left: ListeningSummaryCell,
  right: ListeningSummaryCell,
): boolean {
  return (
    validGeometry(left) &&
    validGeometry(right) &&
    right.startBeat > left.startBeat &&
    sameBeats(left.endBeat, right.startBeat)
  );
}

// Null activity, ambiguous multi-attack cells and geometry gaps all break
// consecutive-attack claims. Supported zero cells do not.
function* attackRuns(
  cells: readonly ListeningSummaryCell[],
  signal?: AbortSignal,
): Generator<ListeningSummaryCell | null> {
  let previous: ListeningSummaryCell | undefined;
  for (const cell of cells) {
    signal?.throwIfAborted();
    if (previous && !touches(previous, cell)) yield null;
    previous = cell;
    if (!validGeometry(cell) || (cell.attacks !== 0 && cell.attacks !== 1)) {
      yield null;
    } else if (cell.attacks === 1) {
      yield cell;
    }
  }
}

const repeatedAttackSpacing: Detector = (cells, result, signal) => {
  let previous: ListeningSummaryCell | null = null;
  let first: ListeningSummaryCell | null = null;
  let spacing = 0;
  let intervals = 0;
  let bestLength = 0;
  let witness: FeatureRelationship | undefined;
  let best: FeatureRelationship | undefined;
  for (const attack of attackRuns(cells, signal)) {
    if (!attack || !previous) {
      intervals = 0;
      first = attack;
    } else {
      const step = attack.startBeat - previous.startBeat;
      if (intervals > 0 && sameBeats(spacing, step)) {
        intervals++;
      } else {
        first = previous;
        spacing = step;
        intervals = 1;
      }
      // Rank by the whole run, but report only the four attacks actually
      // cited by the witness. This keeps long steady passages cheap to read.
      if (intervals === 3 && first) {
        witness = {
          kind: "repeated-attack-spacing",
          version: 1,
          spacingBeats: spacing,
          observations: intervals,
          evidence: [evidence(first, attack, ATTACK)],
        };
      }
      if (intervals >= 3 && intervals > bestLength) {
        bestLength = intervals;
        best = witness;
      }
    }
    previous = attack;
  }
  if (best) result.featureRelationships.push(best);
};

const alternatingAttackBrightness: Detector = (cells, result, signal) => {
  const attacks: { cell: ListeningSummaryCell; centroid: number }[] = [];
  let bestGap = 0;
  let best: FeatureRelationship | undefined;
  for (const attack of attackRuns(cells, signal)) {
    if (!attack || !measured(attack.centroidHz)) {
      attacks.length = 0;
      continue;
    }
    attacks.push({ cell: attack, centroid: attack.centroidHz });
    if (attacks.length < 4) continue;

    const phase = (offset: number) => {
      const values = attacks
        .filter((_, i) => i % 2 === offset)
        .map(({ centroid }) => centroid);
      return {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value / values.length, 0),
      };
    };
    const a = phase(0);
    const b = phase(1);
    const gap = Math.max(a.min - b.max, b.min - a.max);
    const first = attacks.shift();
    if (first && gap > bestGap && gap >= 0.15 * Math.max(a.mean, b.mean)) {
      bestGap = gap;
      best = {
        kind: "alternating-attack-brightness",
        version: 1,
        centroidHzByPhase: [a.mean, b.mean],
        observations: 4,
        evidence: [evidence(first.cell, attack, ATTACK, CENTROID)],
      };
    }
  }
  if (best) result.featureRelationships.push(best);
};

const LOCAL_METRICS = [
  { metric: "attackCount", key: "attacks", feature: ATTACK, minimum: 2 },
  {
    metric: "rmsAmplitude",
    key: "rmsAmplitude",
    feature: "level-grid/v1",
    minimum: 0.01,
  },
  { metric: "centroidHz", key: "centroidHz", feature: CENTROID, minimum: 100 },
] as const satisfies readonly {
  metric: Metric;
  key: "attacks" | "rmsAmplitude" | "centroidHz";
  feature: Evidence["featureTypes"][number];
  minimum: number;
}[];

const localChanges: Detector = (cells, result, signal) => {
  for (const { metric, key, feature, minimum } of LOCAL_METRICS) {
    let bestDelta = 0;
    let best: FeatureRelationship | undefined;
    for (let i = 3; i < cells.length; i++) {
      signal?.throwIfAborted();
      const a = cells[i - 3];
      const b = cells[i - 2];
      const c = cells[i - 1];
      const d = cells[i];
      if (
        !a ||
        !b ||
        !c ||
        !d ||
        !touches(a, b) ||
        !touches(b, c) ||
        !touches(c, d)
      )
        continue;
      const av = a[key];
      const bv = b[key];
      const cv = c[key];
      const dv = d[key];
      if (!measured(av) || !measured(bv) || !measured(cv) || !measured(dv))
        continue;

      const width = (cell: ListeningSummaryCell) =>
        cell.endBeat - cell.startBeat;
      const left = width(a) + width(b);
      const right = width(c) + width(d);
      // Counts can only be compared as counts over equal durations. For
      // continuous grid values, weight each contribution by its actual width.
      if (
        metric === "attackCount" &&
        (!sameBeats(left, right) ||
          ![av, bv, cv, dv].every(Number.isSafeInteger))
      )
        continue;
      const before =
        metric === "attackCount"
          ? av + bv
          : av * (width(a) / left) + bv * (width(b) / left);
      const after =
        metric === "attackCount"
          ? cv + dv
          : cv * (width(c) / right) + dv * (width(d) / right);
      const delta = Math.abs(after - before);
      if (
        !Number.isFinite(delta) ||
        delta <= bestDelta ||
        delta < Math.max(minimum, 0.2 * Math.max(before, after))
      )
        continue;
      bestDelta = delta;
      best = {
        kind: "local-change",
        metric,
        version: 1,
        before,
        after,
        observations: 4,
        evidence: [evidence(a, b, feature), evidence(c, d, feature)],
      };
    }
    if (best) result.featureRelationships.push(best);
  }
};

const MAX_SPECTRAL_LAG_CELLS = 32;
const MEL_DIMENSIONS = 48;

function unitMel(mel: ListeningSummaryCell["mel"]): number[] | null {
  if (mel?.length !== MEL_DIMENSIONS) return null;
  let peak = 0;
  for (const value of mel) {
    if (!measured(value)) return null;
    peak = Math.max(peak, value);
  }
  if (peak === 0) return null;
  // The protocol normalizes across a sequence. Normalize each cell again to
  // compare shape independently of both that scale and per-cell magnitude.
  const scaled = mel.map((value) => value / peak);
  const norm = Math.hypot(...scaled);
  return scaled.map((value) => value / norm);
}

function shapeDistance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(
    a.reduce((sum, value, i) => sum + (value - (b[i] ?? NaN)) ** 2, 0),
  );
}

const spectralRecurrenceCandidates: Detector = (cells, result, signal) => {
  const windows = cells.map((first, i) => {
    signal?.throwIfAborted();
    const second = cells[i + 1];
    if (!second || !touches(first, second)) return null;
    const a = unitMel(first.mel);
    const b = unitMel(second.mel);
    // A static spectrum is not evidence for a recurring two-cell shape.
    if (!a || !b || shapeDistance(a, b) < 0.25) return null;
    return { first, second, a, b };
  });
  let bestDistance = Infinity;
  let best: Summary["candidateChecks"][number] | undefined;
  for (const [i, left] of windows.entries()) {
    signal?.throwIfAborted();
    if (!left) continue;
    for (
      let lag = 2;
      lag <= MAX_SPECTRAL_LAG_CELLS && i + lag < windows.length;
      lag++
    ) {
      const right = windows[i + lag];
      if (
        !right ||
        left.second.endBeat > right.first.startBeat ||
        !sameBeats(
          left.first.endBeat - left.first.startBeat,
          right.first.endBeat - right.first.startBeat,
        ) ||
        !sameBeats(
          left.second.endBeat - left.second.startBeat,
          right.second.endBeat - right.second.startBeat,
        )
      )
        continue;
      const distance = Math.max(
        shapeDistance(left.a, right.a),
        shapeDistance(left.b, right.b),
      );
      if (distance > 0.15 || distance >= bestDistance) continue;
      bestDistance = distance;
      best = {
        kind: "spectral-recurrence",
        version: 1,
        evidence: [
          evidence(left.first, left.second, MEL),
          evidence(right.first, right.second, MEL),
        ],
      };
    }
  }
  // A bounded shape match proposes what to inspect; it does not verify recurrence.
  if (best) result.candidateChecks.push(best);
};

const DETECTORS: readonly Detector[] = [
  repeatedAttackSpacing,
  alternatingAttackBrightness,
  localChanges,
  spectralRecurrenceCandidates,
];

export function detectListeningRelationships(
  cells: readonly ListeningSummaryCell[],
  signal?: AbortSignal,
): Summary {
  const result: Summary = { featureRelationships: [], candidateChecks: [] };
  for (const detect of DETECTORS) {
    signal?.throwIfAborted();
    detect(cells, result, signal);
  }
  return result;
}
