import type { FlatnessSmokeEvidence } from "./contracts.js";
import { spectralShapeSmokeEvidence } from "./spectral-shape-smoke.js";
export type { SpectralShapeSmokeOwner as FlatnessSmokeOwner } from "./spectral-shape-smoke.js";

const flatness: ReturnType<typeof spectralShapeSmokeEvidence> =
  spectralShapeSmokeEvidence("flatness");
export const projectFlatnessSmoke = flatness.project;
export function validateFlatnessSmoke(
  value: unknown,
): asserts value is FlatnessSmokeEvidence {
  flatness.validate(value);
}
