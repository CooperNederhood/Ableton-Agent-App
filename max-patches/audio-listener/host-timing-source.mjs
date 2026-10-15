import { genDocument } from "./native-source.mjs";

// Engineering-only 48 kHz/120 BPM marker; 24,000 samples per beat is not general.
// The standalone marker has no analysis gate or production readiness output.
export function hostTimingCode({
  extraState = "",
  beforeOutputs = "",
  captureDelay = 0,
  nativeVersion = 1,
} = {}) {
  if (nativeVersion === 2)
    return descriptiveHostTimingCode({ extraState, beforeOutputs });
  if (nativeVersion !== 1) throw new Error("unsupported_native_version");
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

// These parameters deliberately default to an invalid, blocked configuration.
// Values must be installed while idle, then a strictly newer epoch arms the pass.
export const DESCRIPTIVE_PARAMETERS = `Param epoch(0); Param cancel(0);
Param totalSamples(0); Param hopSamples(0); Param tempoBpm(0);
Param startBeatFraction(0); Param captureVector(0);`;
export const DESCRIPTIVE_CONFIG_VALID = `configValid =
 (samplerate == 44100 || samplerate == 48000) &&
 (totalSamples >= round(samplerate / 10) && totalSamples <= 30 * samplerate && floor(totalSamples) == totalSamples) &&
 (hopSamples == round(samplerate / 10)) &&
 (tempoBpm >= 20 && tempoBpm <= 999) &&
 (startBeatFraction >= 0 && startBeatFraction < 1) &&
 (captureVector == 1 || captureVector == 2 || captureVector == 4 ||
  captureVector == 8 || captureVector == 16 || captureVector == 32 ||
  captureVector == 64 || captureVector == 128 || captureVector == 256 ||
  captureVector == 512 || captureVector == 1024);`;

/**
 * Descriptive-only signal-rate alignment. No attack or quiet-input certificate.
 * The first phase transition resolves a nearby requested origin, not absolute
 * accuracy: vector retention is a bounded assumption awaiting Max qualification.
 * in4 is the continuously running native counter; no scheduler timestamps.
 */
export function descriptiveHostTimingCode({
  extraState = "",
  beforeOutputs = "",
} = {}) {
  return `${DESCRIPTIVE_PARAMETERS}
History seenEpoch(0); History clock(0); History armed(0); History active(0);
History launchClock(-1); History sourceClock(-1); History onsetCount(0);
History launchPhaseSamples(-1); History firstSourceClock(-1);
History rejected(0); History previousPhase(0); History stablePhaseSamples(0);
History armCounter(-1); History retainedSamples(0);
History sealedEpoch(0);
History passTotal(0); History passHop(0); History passTempo(0);
History passFraction(0); History passVector(0); History passRate(0);
${extraState}
${DESCRIPTIVE_CONFIG_VALID}
reportSamples = configValid ? floor((totalSamples + hopSamples - 1) / hopSamples) * hopSamples : 0;
newRequest = epoch != seenEpoch && epoch != 0;
counterValid = in4 >= 0 && in4 < 17592186044416 && floor(in4) == in4;
phaseValid = in1 >= 0 && in1 < 1;
wasRunning = armed > 0 || active > 0;
configurationSealed = epoch > 0 && epoch == seenEpoch && sealedEpoch == seenEpoch;
if ((wasRunning || configurationSealed) &&
 (!(configValid) || totalSamples != passTotal || hopSamples != passHop ||
  tempoBpm != passTempo || startBeatFraction != passFraction ||
  captureVector != passVector || samplerate != passRate)) {
 armed = 0; active = 0; rejected = 13; sealedEpoch = 0;
}
if (newRequest) {
 if (!(epoch > seenEpoch && epoch < 17592186044416 && floor(epoch) == epoch)) {
  armed = 0; active = 0; rejected = 6;
 } else {
  seenEpoch = epoch; sealedEpoch = 0;
  if (wasRunning) { armed = 0; active = 0; rejected = 6; }
  else {
   clock = 0; armed = 0; active = 0; rejected = 0;
   launchClock = -1; sourceClock = -1; onsetCount = 0;
   launchPhaseSamples = -1; firstSourceClock = -1; armCounter = in4;
   passTotal = totalSamples; passHop = hopSamples; passTempo = tempoBpm;
   passFraction = startBeatFraction; passVector = captureVector; passRate = samplerate;
   if (!(configValid)) { rejected = 13; }
   else if (!(counterValid) || in4 + 10 * samplerate + reportSamples + captureVector >= 17592186044416) { rejected = 12; }
   else if (!(phaseValid) || in1 != previousPhase || stablePhaseSamples < captureVector) { rejected = 1; }
   else if (retainedSamples < captureVector) { rejected = 10; }
   else { armed = 1; sealedEpoch = seenEpoch; }
  }
 }
}
if (epoch == 0) { armed = 0; active = 0; sealedEpoch = 0; }
if (cancel > 0 && (armed > 0 || active > 0)) {
 armed = 0; active = 0; rejected = 4;
}
if ((armed > 0 || active > 0) &&
 (!(counterValid) || in4 != armCounter + clock)) {
 armed = 0; active = 0; rejected = 12;
}
if ((armed > 0 || active > 0) && !(phaseValid)) {
 armed = 0; active = 0; rejected = 14;
}
if (armed > 0 && clock >= 10 * passRate) { armed = 0; rejected = 2; }
beatSamples = passTempo > 0 ? passRate * 60 / passTempo : 1;
if (armed > 0 && in1 != previousPhase) {
 phaseDistance = in1 - passFraction;
 if (phaseDistance < 0) { phaseDistance = phaseDistance + 1; }
 launchPhaseSamples = round(phaseDistance * beatSamples);
 origin = clock - launchPhaseSamples;
 if (launchPhaseSamples < 0 || launchPhaseSamples > passVector ||
     origin < 0 || retainedSamples < passVector) {
  armed = 0; rejected = 9;
 } else {
  launchClock = clock; armed = 0; active = 1;
 }
} else if (active > 0 && in1 != previousPhase) {
 phaseStep = in1 - previousPhase;
 if (phaseStep < 0) { phaseStep = phaseStep + 1; }
 if (abs(phaseStep * beatSamples - 1) > 0.01) {
  active = 0; rejected = 14;
 }
}
stablePhaseSamples = in1 == previousPhase ? min(1024, stablePhaseSamples + 1) : 0;
if (active > 0 && stablePhaseSamples >= passVector) { active = 0; rejected = 3; }
${beforeOutputs || "if (active > 0 && clock - launchClock + launchPhaseSamples - passVector >= passTotal) { active = 0; }"}
// Disarm reports zero on the wire, without lowering the internal high-water
// epoch. This confirms stopped state but never allows a stale epoch to re-arm.
out1 = epoch == 0 ? 0 : seenEpoch; out2 = launchClock; out3 = sourceClock;
out4 = onsetCount; out5 = rejected; out6 = active;
out7 = launchPhaseSamples; out8 = firstSourceClock;
previousPhase = in1;
retainedSamples = min(1024, retainedSamples + 1);
clock = min(17592186044416, clock + 1);`;
}

// Native counter never resets on request/zero/cancel. Epoch high-water survives
// queued epoch=0, so an old request cannot resurrect a completed pass.
export const DESCRIPTIVE_CLOCK_CODE = `${DESCRIPTIVE_PARAMETERS}
History clock(0); History seenEpoch(0); History resetAt(0);
${DESCRIPTIVE_CONFIG_VALID}
if (epoch > seenEpoch && epoch < 17592186044416 && floor(epoch) == epoch) {
 seenEpoch = epoch; resetAt = clock;
}
position = clock - resetAt;
vector = configValid ? captureVector : 1;
out1 = position; out2 = clock;
out3 = floor(clock / vector); out4 = clock - floor(clock / vector) * vector;
out5 = seenEpoch; out6 = resetAt;
out7 = configValid && epoch == seenEpoch && epoch > 0 && cancel == 0 && clock < 17592186044416 ? 1 : 0;
out8 = 2;
clock = min(17592186044416, clock + 1);`;
