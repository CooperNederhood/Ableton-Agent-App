import type { ListeningFeatureSource } from "./listening-feature-source.js";
import { z } from "zod";
import { extractListeningFeature } from "./listening-feature-arithmetic.js";
import {
  listeningFeatureComparisonSchema,
  listeningFeatureSchema,
  type ListeningFeature,
} from "./listening-feature-contracts.js";

export * from "./listening-feature-contracts.js";
export * from "./listening-feature-arithmetic.js";
export * from "./listening-feature-segmentation.js";
export type { ListeningFeatureSource } from "./listening-feature-source.js";

export function extractPeakFeature(
  observation: ListeningFeatureSource,
): ListeningFeature {
  return extractListeningFeature("peak-summary/v1", observation);
}

const phasedProfileSchema = z
  .object({ phaseSamples: z.number().int().nonnegative() })
  .catchall(z.unknown());

function comparisonProfileKey(feature: ListeningFeature): string {
  if (feature.grid === null) return feature.profileKey;
  let value: unknown;
  try {
    value = JSON.parse(feature.profileKey);
  } catch (error) {
    if (error instanceof SyntaxError) return feature.profileKey;
    throw error;
  }
  const parsed = phasedProfileSchema.safeParse(value);
  if (!parsed.success) return feature.profileKey;
  const { phaseSamples, ...profile } = parsed.data;
  void phaseSamples;
  return JSON.stringify(profile);
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
    comparisonProfileKey(a) !== comparisonProfileKey(b) ||
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
    a.grid === null &&
    a.channelSupport !== undefined &&
    b.channelSupport !== undefined
  ) {
    const channelKey = (feature: ListeningFeature) =>
      feature.channelSupport?.map((intervals) =>
        intervals.map(([start, end]) => [
          start / feature.expectedSamples,
          end / feature.expectedSamples,
        ]),
      );
    if (
      JSON.stringify(channelKey(a)) !== JSON.stringify(channelKey(b)) ||
      JSON.stringify(a.channelReasons) !== JSON.stringify(b.channelReasons)
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
    a.grid === null &&
    a.values.some(
      (value, index) => (value === null) !== (b.values![index] === null),
    )
  )
    return unavailable("incompatible-support");
  let count = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [index, value] of a.values.entries()) {
    const other = b.values[index]!;
    if (value === null || other === null) continue;
    count++;
    leftNorm += value ** 2;
    rightNorm += other ** 2;
  }
  if (count === 0)
    return unavailable(
      a.grid === null ? "unavailable" : "insufficient-support",
    );
  const normalize = a.grid !== null && a.normalization === "joint-l2";
  if (normalize && (leftNorm === 0 || rightNorm === 0))
    return unavailable("unavailable");
  const leftScale = normalize ? Math.sqrt(leftNorm) : 1;
  const rightScale = normalize ? Math.sqrt(rightNorm) : 1;
  const sum = a.values.reduce<number>((total, value, index) => {
    const other = b.values![index]!;
    if (value === null || other === null) return total;
    return total + (value / leftScale - other / rightScale) ** 2;
  }, 0);
  const distance = Math.sqrt(
    a.distanceDefinition.startsWith("rms-") ? sum / count : sum,
  );
  return listeningFeatureComparisonSchema.parse({
    status: "comparable",
    distanceDefinition: a.distanceDefinition,
    units: a.distanceUnits,
    distance: a.distanceUnits === "cents" ? distance * 100 : distance,
    ...(a.grid === null
      ? {}
      : {
          coverage: {
            policy: "shared-valid-musical-cells",
            comparedValues: count,
            totalValues: a.values.length,
          },
        }),
  });
}
