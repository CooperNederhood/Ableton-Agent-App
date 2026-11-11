import type { MetricAudioObservation } from "./metric-observation-schemas.js";
import { extractListeningFeature } from "./listening-feature-arithmetic.js";
import {
  listeningFeatureComparisonSchema,
  listeningFeatureSchema,
  type ListeningFeature,
} from "./listening-feature-contracts.js";

export * from "./listening-feature-contracts.js";
export * from "./listening-feature-arithmetic.js";
export * from "./listening-feature-segmentation.js";

export function extractPeakFeature(
  observation: MetricAudioObservation,
): ListeningFeature {
  return extractListeningFeature("peak-summary/v1", observation);
}

export function compareListeningFeatures(
  left: ListeningFeature,
  right: ListeningFeature,
) {
  const a = listeningFeatureSchema.parse(left);
  const b = listeningFeatureSchema.parse(right);
  const unavailable = (
    reason:
      | "unavailable"
      | "insufficient-support"
      | "incompatible-type"
      | "incompatible-profile"
      | "incompatible-grid"
      | "incompatible-support",
  ) =>
    listeningFeatureComparisonSchema.parse({
      status: "not-comparable",
      reason,
    });
  if (a.type !== b.type) return unavailable("incompatible-type");
  if (a.values === null || b.values === null) return unavailable("unavailable");
  if (
    a.profileKey !== b.profileKey ||
    a.supportPolicy !== b.supportPolicy ||
    (a.channelSupport !== undefined && a.sampleRate !== b.sampleRate)
  )
    return unavailable("incompatible-profile");
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9;
  if ((a.grid === null) !== (b.grid === null))
    return unavailable("incompatible-grid");
  if (
    a.grid !== null &&
    b.grid !== null &&
    (a.grid.meter.numerator !== b.grid.meter.numerator ||
      a.grid.meter.denominator !== b.grid.meter.denominator ||
      !near(a.grid.phaseBeats, b.grid.phaseBeats) ||
      a.grid.cells.length !== b.grid.cells.length ||
      a.grid.cells.some((cell, index) => {
        const other = b.grid!.cells[index]!;
        return (
          !near(cell.startBeat, other.startBeat) ||
          !near(cell.endBeat, other.endBeat)
        );
      }))
  )
    return unavailable("incompatible-grid");
  if (
    a.grid !== null &&
    b.grid !== null &&
    a.grid.cells.some(
      (cell, index) => cell.reason !== b.grid!.cells[index]!.reason,
    )
  )
    return unavailable("incompatible-support");
  if (a.channelSupport !== undefined && b.channelSupport !== undefined) {
    const channelKey = (feature: ListeningFeature) =>
      feature.channelSupport?.map((intervals) =>
        intervals.map(([start, end]) => [
          start / feature.expectedSamples,
          end / feature.expectedSamples,
        ]),
      );
    if (
      JSON.stringify(channelKey(a)) !== JSON.stringify(channelKey(b)) ||
      JSON.stringify(a.channelReasons) !== JSON.stringify(b.channelReasons) ||
      JSON.stringify(a.grid?.cells.map((cell) => cell.channelReasons)) !==
        JSON.stringify(b.grid?.cells.map((cell) => cell.channelReasons))
    )
      return unavailable("incompatible-support");
  }
  if (a.supportPolicy === "complete-required") {
    if (
      a.coveredSamples !== a.expectedSamples ||
      b.coveredSamples !== b.expectedSamples
    )
      return unavailable("insufficient-support");
  } else if (a.supportPolicy === "retained-overlap") {
    const supportKey = (feature: ListeningFeature) =>
      feature.support.map(([start, end]) => [
        start / feature.expectedSamples,
        end / feature.expectedSamples,
      ]);
    if (JSON.stringify(supportKey(a)) !== JSON.stringify(supportKey(b)))
      return unavailable("incompatible-support");
  }
  if (a.values.length !== b.values.length)
    return unavailable("incompatible-grid");
  if (
    a.values.some(
      (value, index) => (value === null) !== (b.values![index] === null),
    )
  )
    return unavailable("incompatible-support");
  let count = 0;
  const sum = a.values.reduce<number>((total, value, index) => {
    if (value === null) return total;
    count++;
    return total + (value - b.values![index]!) ** 2;
  }, 0);
  if (count === 0) return unavailable("unavailable");
  const distance = Math.sqrt(
    a.distanceDefinition.startsWith("rms-") ? sum / count : sum,
  );
  return listeningFeatureComparisonSchema.parse({
    status: "comparable",
    distanceDefinition: a.distanceDefinition,
    units: a.distanceUnits,
    distance: a.distanceUnits === "cents" ? distance * 100 : distance,
  });
}
