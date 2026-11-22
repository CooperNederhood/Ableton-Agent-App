import assert from "node:assert/strict";

const offFractionOrigin =
  " // Live chooses the start beat; off the configured fraction, the first moving sample is the origin.\n if (launchPhaseSamples > passVector) { launchPhaseSamples = 0; }\n";
const offFractionLaunch = [
  " if (launchPhaseSamples < 0 || launchPhaseSamples > passVector ||\n     origin < 0 || retainedSamples < passVector) {",
  " if (launchPhaseSamples < 0 || origin < 0 || retainedSamples < passVector) {",
];

/** Reverse the one intended off-fraction launch change in descriptive envelope Gen code. */
export function reverseOffFractionLaunch(text) {
  assert.equal(text.split(offFractionOrigin + " origin = clock").length, 2);
  assert.equal(text.split(offFractionLaunch[1]).length, 2);
  return text
    .replace(offFractionOrigin, "")
    .replace(offFractionLaunch[1], offFractionLaunch[0]);
}
