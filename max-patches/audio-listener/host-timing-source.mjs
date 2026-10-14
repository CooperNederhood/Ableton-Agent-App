import { genDocument } from "./native-source.mjs";

// Engineering-only 48 kHz/120 BPM marker; 24,000 samples per beat is not general.
// The standalone marker has no analysis gate or production readiness output.
export function hostTimingCode({
  extraState = "",
  beforeOutputs = "",
  captureDelay = 0,
} = {}) {
  if (captureDelay !== 0 && captureDelay !== 64)
    throw new Error("unsupported engineering capture delay");
  return `Param epoch(0); Param cancel(0);
History seenEpoch(0); History clock(0); History armed(0); History active(0);
History launchClock(-1); History sourceClock(-1); History onsetCount(0);
History launchPhaseSamples(-1); History firstSourceClock(-1);
History rejected(0); History previousPhase(0); History quietSamples(240);
History stablePhaseSamples(0);
${extraState ? `${extraState}\n` : ""}if (epoch != seenEpoch && epoch != 0) {
  if (epoch > seenEpoch && epoch <= 1000000 && floor(epoch) == epoch) {
    seenEpoch = epoch; clock = 0; armed = 0; active = 0;
    launchClock = -1; sourceClock = -1; onsetCount = 0;
    launchPhaseSamples = -1; firstSourceClock = -1;
    quietSamples = 240; rejected = 0;
    if (in1 != previousPhase || stablePhaseSamples < 64) { rejected = 1; }
    else if (abs(in2) + abs(in3) > 0.000000000001) { rejected = 8; }
    else { armed = 1; }
  } else { armed = 0; active = 0; rejected = 6; }
}
if (epoch == 0) { armed = 0; active = 0; }
if (seenEpoch > 0 && samplerate != 48000) {
  armed = 0; active = 0; rejected = 5;
}
if (cancel > 0 && (armed > 0 || active > 0)) {
  armed = 0; active = 0; rejected = 4;
}
if (armed > 0 && clock >= 480000) {
  armed = 0; rejected = 2;
}
if (armed > 0 && in1 != previousPhase) {
  launchClock = clock; armed = 0; active = 1;
  launchPhaseSamples = round(in1 * 24000);
}
if (armed > 0 || active > 0) {
  hasInput = abs(in2) + abs(in3) > 0.000000000001;
  if (hasInput) {
    if (quietSamples >= 240) {
      sourceClock = clock;
      if (onsetCount == 0) { firstSourceClock = clock; }
      onsetCount = onsetCount + 1;
      if (onsetCount > 8) { armed = 0; active = 0; rejected = 7; }
    }
    quietSamples = 0;
  } else { quietSamples = min(240, quietSamples + 1); }
}
stablePhaseSamples = in1 == previousPhase ? min(128, stablePhaseSamples + 1) : 0;
if (active > 0 && stablePhaseSamples >= 64) { active = 0; rejected = 3; }
if (active > 0 && ${captureDelay ? "clock - launchClock + launchPhaseSamples >= 480064" : "clock - launchClock >= 480000"}) { active = 0; }
${beforeOutputs ? `${beforeOutputs}\n` : ""}out1 = seenEpoch; out2 = launchClock; out3 = sourceClock;
out4 = onsetCount; out5 = rejected; out6 = active;
out7 = launchPhaseSamples; out8 = firstSourceClock;
previousPhase = in1;
clock = clock + 1;`;
}

export const HOST_TIMING_CODE = hostTimingCode();

export function hostTimingDocument() {
  return genDocument(HOST_TIMING_CODE, 3, 8);
}
