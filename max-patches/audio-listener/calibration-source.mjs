// Development-only generator. The staged harness has no production Node runtime.
import { genDocument } from "./native-source.mjs";

export const CLOCK_CODE = `Param enabled(0); Param epoch(0);
Param fixtureFrames(96000); Param vectorSize(64);
History clock(0); History seenEpoch(0); History resetAt(0);
if (epoch != seenEpoch) { seenEpoch = epoch; resetAt = clock; }
position = clock - resetAt;
active = enabled > 0 && position < fixtureFrames;
out1 = active ? position : 0;
out2 = clock;
out3 = floor(clock / max(1, vectorSize));
out4 = clock - floor(clock / max(1, vectorSize)) * max(1, vectorSize);
out5 = seenEpoch; out6 = resetAt; out7 = active;
clock = clock + 1;`;

const b = (id, text, x, y, inputs = 1, outputs = 1, extra = {}) => ({
  box: {
    id,
    text,
    maxclass: "newobj",
    numinlets: inputs,
    numoutlets: outputs,
    patching_rect: [x, y, Math.min(780 - x, Math.max(50, text.length * 6)), 22],
    ...extra,
  },
});
const w = (s, o, d, i = 0) => ({
  patchline: { source: [s, o], destination: [d, i] },
});
const patch = (boxes, lines) => ({
  fileversion: 1,
  classnamespace: "box",
  rect: [0, 0, 800, 380],
  boxes,
  lines,
});

function packet() {
  const boxes = [
    b("bang", "", 0, 10, 0, 1, { maxclass: "inlet" }),
    b("tick", `trigger ${Array(13).fill("b").join(" ")}`, 10, 110, 1, 13),
    b("pack", `pack ${Array(13).fill("0.").join(" ")}`, 10, 165, 13),
    b("msg", "prepend frame", 10, 220),
    b("out", "", 10, 280, 1, 0, { maxclass: "outlet" }),
  ];
  const lines = [w("bang", 0, "tick"), w("pack", 0, "msg"), w("msg", 0, "out")];
  for (let i = 0; i < 13; i++) {
    boxes.push(
      b(`in${i}`, "", (i + 1) * 55, 10, 0, 1, { maxclass: "inlet" }),
      b(`snap${i}`, "snapshot~ @offset 0", (i + 1) * 55, 65, 2),
    );
    lines.push(
      w(`in${i}`, 0, `snap${i}`),
      w("tick", i, `snap${i}`),
      w(`snap${i}`, 0, "pack", i),
    );
  }
  return patch(boxes, lines);
}

export function calibrationDocuments() {
  const boxes = [
    b("buffer", "buffer~ #0-commission-fixture 0 2", 10, 20, 1, 2),
    b("info", "info~ #0-commission-fixture", 10, 65, 1, 10),
    b("loadedTrigger", "trigger b b", 10, 110, 1, 2),
    b("loaded", "pack loaded 0. 0. 0 s", 10, 150, 5),
    b("clock", "gen~ calibration_clock", 270, 20, 1, 7),
    b("left", "index~ #0-commission-fixture 1", 270, 65, 2),
    b("right", "index~ #0-commission-fixture 2", 450, 65, 2),
    b("gateL", "*~ 0.", 270, 110, 2),
    b("gateR", "*~ 0.", 450, 110, 2),
    b(
      "analysis",
      "poly~ audio_listener_analysis 1 @parallel 0",
      270,
      155,
      3,
      7,
    ),
    b("packet", "p native-packet", 10, 205, 14, 1, { patcher: packet() }),
    b("qmetro", "qmetro 10 @active 1", 10, 250),
    b("poll", "trigger b b b", 10, 290, 1, 3),
    b("spectralSnapshot", "snapshot", 160, 290, 1, 1, { maxclass: "message" }),
    b("dspTrigger", "trigger b b", 630, 20, 1, 2),
    b("dsp", "dspstate~", 630, 65, 1, 4),
    b("dspPack", "pack dsp 0 0. 0 0", 630, 110, 5),
    b("guard", "js calibration_guard.js", 470, 250, 1, 5),
    b(
      "node",
      "node.script calibration_controller.js @autostart 1 @watch 0",
      440,
      310,
      1,
      2,
    ),
    b("idle", "loadmess stop 1 startup", 270, 250),
  ];
  const lines = [
    w("buffer", 1, "loadedTrigger"),
    w("loadedTrigger", 1, "info"),
    w("loadedTrigger", 0, "loaded"),
    w("info", 0, "loaded", 1),
    w("info", 6, "loaded", 2),
    w("info", 8, "loaded", 3),
    w("info", 7, "loaded", 4),
    w("loaded", 0, "node"),
    w("clock", 0, "left"),
    w("clock", 0, "right"),
    w("left", 0, "gateL"),
    w("right", 0, "gateR"),
    w("clock", 6, "gateL", 1),
    w("clock", 6, "gateR", 1),
    w("gateL", 0, "analysis"),
    w("gateR", 0, "analysis", 1),
    w("qmetro", 0, "poll"),
    w("poll", 2, "dspTrigger"),
    w("poll", 1, "spectralSnapshot"),
    w("spectralSnapshot", 0, "analysis", 2),
    w("poll", 0, "packet"),
    w("dspTrigger", 1, "dsp"),
    w("dspTrigger", 0, "dspPack"),
    w("dsp", 0, "dspPack", 1),
    w("dsp", 1, "dspPack", 2),
    w("dsp", 2, "dspPack", 3),
    w("dsp", 3, "dspPack", 4),
    w("dspPack", 0, "node"),
    w("packet", 0, "node"),
    w("node", 0, "guard"),
    w("idle", 0, "guard"),
    w("guard", 0, "analysis"),
    w("guard", 1, "analysis", 2),
    w("guard", 2, "clock"),
    w("guard", 3, "buffer"),
    w("guard", 4, "node"),
  ];
  for (let i = 0; i < 7; i++) lines.push(w("analysis", i, "packet", i + 1));
  for (let i = 1; i < 7; i++) lines.push(w("clock", i, "packet", i + 7));
  for (const [id, text, x] of [
    ["authorize", "authorize runner-owned", 10],
    ["fixture", "fixture silence", 175],
    ["start", "start", 300],
    ["cancel", "cancel", 365],
    ["report", "report", 630],
  ]) {
    boxes.push(b(id, text, x, 345, 2, 1, { maxclass: "message" }));
    lines.push(w(id, 0, "node"));
  }
  return {
    "Audio-Listener-Commissioning.maxpat": { patcher: patch(boxes, lines) },
    "calibration_clock.gendsp": genDocument(CLOCK_CODE, 0, 7),
  };
}
