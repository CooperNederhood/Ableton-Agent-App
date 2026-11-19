import type {
  ListeningAnalysisFeature,
  ListeningSummary,
} from "./listening-feature-views.js";
import {
  detectListeningRelationships,
  type ListeningSummaryCell,
} from "./listening-relationships.js";

const STEP = 0.25;
const EPSILON = 1e-8;
const round = (value: number | null) =>
  value === null ? null : Number(value.toPrecision(4));

export function projectListeningSummary(
  base: Pick<ListeningSummary, "source" | "readTarget" | "status" | "reason">,
  views: readonly ListeningAnalysisFeature[],
  budget: number,
  signal?: AbortSignal,
): ListeningSummary {
  const { startBeat, endBeat } = base.readTarget.range;
  const result: ListeningSummary = {
    ...base,
    grid: null,
    peakAmplitude: null,
    featureRelationships: [],
    candidateChecks: [],
  };
  let peakExtent = startBeat;
  let peak = 0;
  for (const {
    record: { feature },
    segment,
  } of views) {
    if (
      feature.type !== "peak-summary/v1" ||
      Math.abs(segment.startBeat - peakExtent) > EPSILON ||
      segment.endBeat > endBeat + EPSILON ||
      feature.coveredSamples !== feature.expectedSamples
    )
      continue;
    const [left, right] = feature.values ?? [];
    if (left == null || right == null) continue;
    peak = Math.max(peak, left, right);
    peakExtent = segment.endBeat;
  }
  if (peakExtent > startBeat && Math.abs(peakExtent - endBeat) <= EPSILON)
    result.peakAmplitude = round(peak);
  const alignment = views.find(
    ({ record, segment }) => record.feature.grid && segment.alignment,
  )?.segment.alignment;
  if (!alignment) return result;
  const phase = (((startBeat - alignment.barOriginBeat) % STEP) + STEP) % STEP;
  const firstWidth =
    phase < EPSILON || STEP - phase < EPSILON ? STEP : STEP - phase;
  const count = Math.max(
    1,
    1 + Math.ceil((endBeat - startBeat - firstWidth) / STEP - EPSILON),
  );
  if (count < 1 || count > 100_000) return result;
  const cells: ListeningSummaryCell[] = Array.from(
    { length: count },
    (_, index) => ({
      startBeat:
        index === 0 ? startBeat : startBeat + firstWidth + (index - 1) * STEP,
      endBeat: Math.min(endBeat, startBeat + firstWidth + index * STEP),
      attacks: null,
      rmsAmplitude: null,
      centroidHz: null,
    }),
  );
  let aligned = false;
  for (const {
    record: { feature },
    segment,
  } of views) {
    signal?.throwIfAborted();
    if (
      !feature.grid ||
      ![
        "attack-activity-grid/v1",
        "level-grid/v1",
        "centroid-grid/v1",
        "mel-grid/v1",
      ].includes(feature.type)
    )
      continue;
    for (const [i, native] of feature.grid.cells.entries()) {
      const start = segment.startBeat + native.startBeat;
      const end = segment.startBeat + native.endBeat;
      const index =
        Math.abs(start - startBeat) < EPSILON
          ? 0
          : 1 + Math.round((start - startBeat - firstWidth) / STEP);
      const cell = cells[index];
      if (
        !cell ||
        Math.abs(start - cell.startBeat) > EPSILON ||
        Math.abs(end - cell.endBeat) > EPSILON
      )
        continue;
      aligned = true;
      if (
        native.reason !== null ||
        native.coveredSamples !== native.expectedSamples ||
        !feature.values
      )
        continue;
      switch (feature.type) {
        case "attack-activity-grid/v1":
          cell.attacks = feature.values[i] ?? null;
          break;
        case "level-grid/v1": {
          const left = feature.values[i * 2];
          const right = feature.values[i * 2 + 1];
          if (left != null && right != null)
            cell.rmsAmplitude = Math.hypot(left, right) / Math.SQRT2;
          break;
        }
        case "centroid-grid/v1":
          cell.centroidHz = feature.values[i] ?? null;
          break;
        case "mel-grid/v1": {
          const bands = feature.values.slice(i * 48, (i + 1) * 48);
          if (bands.length === 48 && bands.every((value) => value !== null))
            cell.mel = bands;
          break;
        }
      }
    }
  }
  if (!aligned) return result;
  Object.assign(result, detectListeningRelationships(cells, signal));
  for (let stride = 1; ; stride *= 2) {
    const binCount = Math.ceil(count / stride);
    if (binCount > 2048) continue;
    const grid: NonNullable<ListeningSummary["grid"]> = {
      startBeat,
      firstBinBeats: cells[Math.min(count, stride) - 1]!.endBeat - startBeat,
      stepBeats: STEP * stride,
      binCount,
      aggregation: stride === 1 ? "native" : "sum-and-mean",
      attacks: [],
      attackCoverage: [],
      rmsAmplitude: [],
      centroidHz: [],
    };
    for (let bin = 0; bin < binCount; bin++) {
      const slice = cells.slice(bin * stride, (bin + 1) * stride);
      const aggregate = (key: "attacks" | "rmsAmplitude" | "centroidHz") => {
        let total = 0;
        let weight = 0;
        for (const cell of slice) {
          const value = cell[key];
          if (value === null) return null;
          const width = cell.endBeat - cell.startBeat;
          total += key === "attacks" ? value : value * width;
          weight += width;
        }
        return key === "attacks" ? total : total / weight;
      };
      const attacks = aggregate("attacks");
      if (attacks !== null) {
        const run = grid.attackCoverage.at(-1);
        if (run?.[1] === bin) run[1]++;
        else grid.attackCoverage.push([bin, bin + 1]);
        if (attacks > 0) grid.attacks.push([bin, attacks]);
      }
      grid.rmsAmplitude.push(round(aggregate("rmsAmplitude")));
      grid.centroidHz.push(round(aggregate("centroidHz")));
    }
    result.grid = grid;
    if (Buffer.byteLength(JSON.stringify(result)) <= budget) return result;
    if (binCount === 1) {
      while (Buffer.byteLength(JSON.stringify(result)) > budget) {
        if (result.candidateChecks.length) result.candidateChecks.pop();
        else if (result.featureRelationships.length)
          result.featureRelationships.pop();
        else
          throw new Error(
            "Listening summary metadata exceeds its response budget",
          );
      }
      return result;
    }
  }
}
