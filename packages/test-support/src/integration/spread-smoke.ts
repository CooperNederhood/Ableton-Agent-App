import type { SpreadSmokeEvidence } from "./contracts.js";
import { spectralShapeSmokeEvidence } from "./spectral-shape-smoke.js";
export type { SpectralShapeSmokeOwner as SpreadSmokeOwner } from "./spectral-shape-smoke.js";

const spread: ReturnType<typeof spectralShapeSmokeEvidence> =
  spectralShapeSmokeEvidence("spread");
export const projectSpreadSmoke = spread.project;
export function validateSpreadSmoke(
  value: unknown,
): asserts value is SpreadSmokeEvidence {
  spread.validate(value);
}
