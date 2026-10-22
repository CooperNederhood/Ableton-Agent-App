import {
  genDocument,
  ENVELOPE_STATE,
  ENVELOPE_STEP,
  ENVELOPE_OUTPUT,
} from "./native-source.mjs";
import {
  hostTimingCode,
  descriptiveFiniteWords,
  descriptiveFinitePredicate,
} from "./host-timing-source.mjs";

const reset = [...ENVELOPE_STATE.matchAll(/History (\w+)\((\d+)\);/g)]
  .map(([, name, initial]) => `${name} = ${initial};`)
  .join(" ");

export function synchronizedEnvelopeCode({
  clockAnchored = false,
  nativeVersion = 1,
} = {}) {
  if (nativeVersion === 2) return descriptiveEnvelopeCode();
  if (nativeVersion !== 1) throw new Error("unsupported_native_version");
  return hostTimingCode({
    captureDelay: 64,
    extraState: `${ENVELOPE_STATE}
History envelopeEpoch(0); History preQuiet(0);${clockAnchored ? "\nHistory armCounter(-1);" : ""}
Delay preL(64); Delay preR(64);
newRequest = epoch != seenEpoch && epoch != 0;
${clockAnchored ? "if (newRequest) { armCounter = in4; }\n" : ""}delayedL = preL.read(64); delayedR = preR.read(64);
preL.write(in2); preR.write(in3);`,
    beforeOutputs: `${
      clockAnchored
        ? `if ((armed > 0 || active > 0) &&
  (!(in4 >= 0 && floor((in4 + 480000) / 1048576) < 16777216 && floor(in4) == in4) ||
   in4 != armCounter + clock)) {
  armed = 0; active = 0; rejected = 12;
}
`
        : ""
    }if (envelopeEpoch != seenEpoch) {
  envelopeEpoch = seenEpoch; ${reset}
}
if (newRequest && (armed > 0 || active > 0) && preQuiet < 64) {
  armed = 0; active = 0; rejected = 10;
}
origin = launchClock - launchPhaseSamples;
if (active > 0 && (launchPhaseSamples < 0 || launchPhaseSamples > 64 || origin < 0)) {
  active = 0; rejected = 9;
}
renderIndex = clock - origin - 64;
if (active > 0 && renderIndex >= 0 && renderIndex < 480000) {
  if (renderIndex != completed + n) { active = 0; rejected = 11; }
  else {
${ENVELOPE_STEP.replace(/\bin1\b/g, "delayedL").replace(/\bin2\b/g, "delayedR")}
  }
}
preQuiet = abs(in2) + abs(in3) <= 0.000000000001 ? min(64, preQuiet + 1) : 0;
${ENVELOPE_OUTPUT.replace(/\bout([1-5])\b/g, (_, n) => `out${Number(n) + 8}`)}${clockAnchored ? "\nout14 = armCounter; out15 = launchClock >= 0 ? armCounter + origin : -1;" : ""}`,
  });
}

export const SYNCHRONIZED_ENVELOPE_CODE = synchronizedEnvelopeCode();
export const CLOCK_ANCHORED_ENVELOPE_CODE = synchronizedEnvelopeCode({
  clockAnchored: true,
});

export function synchronizedEnvelopeDocument() {
  const document = genDocument(SYNCHRONIZED_ENVELOPE_CODE, 3, 13);
  for (let i = 0; i < 13; i++) {
    document.patcher.boxes.find(
      ({ box }) => box.id === `out${i}`,
    ).box.patching_rect[1] = 20 + i * 25;
  }

  return document;
}

export function clockAnchoredEnvelopeDocument() {
  const document = genDocument(CLOCK_ANCHORED_ENVELOPE_CODE, 4, 15);
  for (let i = 0; i < 15; i++) {
    document.patcher.boxes.find(
      ({ box }) => box.id === `out${i}`,
    ).box.patching_rect[1] = 20 + i * 22;
  }
  return document;
}

export function descriptiveEnvelopeCode({
  configurationReadback = false,
} = {}) {
  return hostTimingCode({
    nativeVersion: 2,
    extraState: `${ENVELOPE_STATE}
History envelopeEpoch(0);
History publishedCompleted(0); History publishClock(-1); History pendingFinal(0);
History finalL(0); History finalR(0); History finalRmsL(0); History finalRmsR(0);
Delay preL(1024); Delay preR(1024);
// Read before write. Invalid parameters must never reach a Delay read.
retention = 1;
if (captureVector == 1 || captureVector == 2 || captureVector == 4 ||
    captureVector == 8 || captureVector == 16 || captureVector == 32 ||
    captureVector == 64 || captureVector == 128 || captureVector == 256 ||
    captureVector == 512 || captureVector == 1024) { retention = captureVector; }
delayedL = preL.read(retention); delayedR = preR.read(retention);
preL.write(in2); preR.write(in3);`,
    beforeOutputs: `if (envelopeEpoch != seenEpoch) {
 envelopeEpoch = seenEpoch; ${reset}
 publishedCompleted = 0; publishClock = -1; pendingFinal = 0;
 finalL = 0; finalR = 0; finalRmsL = 0; finalRmsR = 0;
}
origin = launchClock - launchPhaseSamples;
renderIndex = clock - origin - passVector;
if (active > 0 && renderIndex >= 0 && renderIndex < passTotal) {
${["L", "R"].map((side) => descriptiveFiniteWords(`delayed${side}`, side)).join("\n")}
 if (renderIndex != completed + n) { active = 0; rejected = 11; }
 else if (!(${["L", "R"].map((side) => descriptiveFinitePredicate(side)).join(" &&\n    ")})) {
  active = 0; rejected = 15;
 } else {
  sumL = sumL + delayedL * delayedL; sumR = sumR + delayedR * delayedR;
  peakL = max(peakL, abs(delayedL)); peakR = max(peakR, abs(delayedR));
  n = n + 1;
  if (n == passHop || completed + n == passTotal) {
   if (n == passHop) {
    heldL = peakL; heldR = peakR;
    heldRmsL = sqrt(sumL / n); heldRmsR = sqrt(sumR / n);
    publishedCompleted = completed + n; publishClock = clock;
   } else {
    // A tail can follow the preceding full hop by just one sample. Keep that
    // hop observable for a whole reporting cadence, without padding the tail.
    finalL = peakL; finalR = peakR;
    finalRmsL = sqrt(sumL / n); finalRmsR = sqrt(sumR / n);
    pendingFinal = 1;
   }
   completed = completed + n;
   n = 0; sumL = 0; sumR = 0; peakL = 0; peakR = 0;
  }
  if (completed == passTotal && pendingFinal == 0) { active = 0; }
 }
}
if (active > 0 && pendingFinal > 0 && clock - publishClock >= passHop) {
 heldL = finalL; heldR = finalR;
 heldRmsL = finalRmsL; heldRmsR = finalRmsR;
 publishedCompleted = completed; pendingFinal = 0; active = 0;
}
if (active == 0) { pendingFinal = 0; }
${ENVELOPE_OUTPUT.replace(/\bout([1-5])\b/g, (_, n) => `out${Number(n) + 8}`).replace("out13 = completed", "out13 = publishedCompleted")}
out14 = armCounter; out15 = launchClock >= 0 ? armCounter + origin : -1;
out16 = 2;${
      configurationReadback
        ? `
// Separate metadata only. These are capture-Gen histories, not setter echoes.
out17 = seenEpoch; out18 = passTotal; out19 = passHop; out20 = passTempo;
out21 = passFraction; out22 = passVector; out23 = sealedEpoch;`
        : ""
    }`,
  });
}
