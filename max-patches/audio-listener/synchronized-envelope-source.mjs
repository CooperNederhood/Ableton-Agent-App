import {
  genDocument,
  ENVELOPE_STATE,
  ENVELOPE_STEP,
  ENVELOPE_OUTPUT,
} from "./native-source.mjs";
import { hostTimingCode } from "./host-timing-source.mjs";

const reset = [...ENVELOPE_STATE.matchAll(/History (\w+)\((\d+)\);/g)]
  .map(([, name, initial]) => `${name} = ${initial};`)
  .join(" ");

export function synchronizedEnvelopeCode({ clockAnchored = false } = {}) {
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
