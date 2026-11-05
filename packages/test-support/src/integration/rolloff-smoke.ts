import type { RolloffSmokeEvidence } from "./contracts.js";
import { spectralShapeSmokeEvidence } from "./spectral-shape-smoke.js";
export type { SpectralShapeSmokeOwner as RolloffSmokeOwner } from "./spectral-shape-smoke.js";

const rolloff: ReturnType<typeof spectralShapeSmokeEvidence> =
  spectralShapeSmokeEvidence("rolloff");
export const projectRolloffSmoke = rolloff.project;
export function validateRolloffSmoke(
  value: unknown,
): asserts value is RolloffSmokeEvidence {
  rolloff.validate(value);
}
