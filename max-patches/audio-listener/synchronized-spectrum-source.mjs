import {
  genDocument,
  SPECTRUM_STATE,
  SPECTRUM_STEP,
} from "./native-source.mjs";
import {
  descriptiveFiniteWords,
  descriptiveFinitePredicate,
} from "./host-timing-source.mjs";

export const TAGGED_SPECTRUM_CODE = `${SPECTRUM_STATE}
History frameStart(-1); History frameValid(0);
History publishedStart(-1); History publishedEnd(-1);
History publishedCentroid(0); History publishedEnergy(0); History invalidFrames(0);
History badBin(-1); History badActual(-1); History badExpected(-1);
History lastBadStart(-1); History lastBadBin(-1); History lastBadActual(-1); History lastBadExpected(-1);
History frameGuards(0); History lastBadGuards(0);
sourceClock = in6 + in7 * 1048576;
startGuards = (sourceClock >= 0 ? 1 : 0) +
    ((in7 < 16777215 || (in7 == 16777215 && in6 <= 1046528)) ? 2 : 0) +
    (in6 >= 0 ? 4 : 0) + (in6 < 1048576 ? 8 : 0) + (floor(in6) == in6 ? 16 : 0) +
    (in7 >= 0 ? 32 : 0) + (in7 < 16777216 ? 64 : 0) + (floor(in7) == in7 ? 128 : 0);
if (in5 == 0) {
  frameStart = sourceClock;
  badBin = -1; badActual = -1; badExpected = -1;
  frameGuards = startGuards;
  frameValid = startGuards == 255 ? 1 : 0;
}
if (in5 > 0 && sourceClock != frameStart + in5) {
  frameValid = 0;
  if (badBin < 0) { badBin = in5; badActual = sourceClock; badExpected = frameStart + in5; }
}
${SPECTRUM_STEP}
if (in5 == 2047) {
  if (frameValid > 0) {
    publishedStart = frameStart; publishedEnd = frameStart + 2048;
    publishedCentroid = heldCentroid; publishedEnergy = heldEnergy;
  } else {
    invalidFrames = min(4096, invalidFrames + 1);
    lastBadStart = frameStart; lastBadBin = badBin;
    lastBadActual = badActual; lastBadExpected = badExpected;
    lastBadGuards = frameGuards;
  }
}
out1 = publishedCentroid; out2 = publishedEnergy;
out3 = publishedStart; out4 = publishedEnd; out5 = invalidFrames;
out6 = lastBadStart; out7 = lastBadBin; out8 = lastBadActual; out9 = lastBadExpected;
out10 = lastBadGuards;`;

export function taggedSpectrumGenDocument() {
  return genDocument(TAGGED_SPECTRUM_CODE, 7, 10);
}

export const CLOCK_SPLIT_CODE = `high = floor(in1 / 1048576);
out1 = in1 - high * 1048576; out2 = high;`;
export function clockSplitDocument() {
  return genDocument(CLOCK_SPLIT_CODE, 1, 2);
}

// Same full-frame/native split-counter layout; rate comes from DSP, not the
// calibration default. Publication still names the actual complete 2048 frame.
export function descriptiveSpectrumCode() {
  const components = [1, 2, 3, 4];
  const finiteWords = components
    .map((n) => descriptiveFiniteWords(`in${n}`, n))
    .join("\n");
  const finiteChecks = components
    .map((n) => descriptiveFinitePredicate(n))
    .join(" &&\n    ");
  return (
    TAGGED_SPECTRUM_CODE.replace(
      "Param sourceSampleRate(48000);",
      "History previousBin(-1); History previousFrameEnd(-1);",
    )
      // Keep the DSP-rate expression after ALL inherited History declarations.
      // Max rejects declarations following expressions, unlike the Gen model.
      .replace(
        "sourceClock = in6",
        "sourceSampleRate = samplerate;\nsourceClock = in6",
      )
      .replace(
        "if (in5 > 0 && sourceClock",
        `if (in5 == 0 && previousFrameEnd >= 0 && sourceClock != previousFrameEnd) { frameValid = 0; }
if (in5 > 0 && sourceClock`,
      )
      .replace(
        SPECTRUM_STEP,
        `${finiteWords}
if (!(samplerate == 44100 || samplerate == 48000) ||
    !(in5 >= 0 && in5 <= 2047 && floor(in5) == in5) ||
    (in5 != 0 && in5 != previousBin + 1) ||
    !(${finiteChecks}) ||
    !(in6 >= 0 && in6 < 1048576 && floor(in6) == in6 &&
      in7 >= 0 && in7 < 16777216 && floor(in7) == in7)) { frameValid = 0; }
${SPECTRUM_STEP}
previousBin = in5;`,
      )
      .replace(
        "out1 = publishedCentroid;",
        "if (in5 == 2047) { previousFrameEnd = frameStart + 2048; frameValid = 0; }\nout1 = publishedCentroid;",
      )
  );
}
