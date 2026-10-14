// Development-only generator. The staged harness has no production Node runtime.
import { genDocument } from "./native-source.mjs";
import { isAbsolute, resolve } from "node:path";

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

function engineeringResources(resourceDirectory) {
  if (resourceDirectory !== null && !isAbsolute(resourceDirectory))
    throw new Error("absolute engineering resource directory required");
  return (name) =>
    resourceDirectory ? JSON.stringify(resolve(resourceDirectory, name)) : name;
}

export function hostClockDocument({ resourceDirectory = null } = {}) {
  const resource = engineeringResources(resourceDirectory);
  const boxes = [
    b("command", "in 1", 10, 10),
    b(
      "collector",
      `js ${resource("hosted_calibration_probe.js")}`,
      10,
      310,
      1,
      3,
    ),
    b(
      "clock",
      `gen~ ${resource("calibration_clock.gendsp")} @nocache 1`,
      200,
      10,
      1,
      7,
    ),
    b("phase", "plugphasor~", 480, 10),
    b("channels", "mc.pack~ 3", 200, 50, 3),
    b("snapshot", "mc.snapshot~ @offset 0", 200, 90, 1, 2),
    b("voice", "route voice", 450, 90, 1, 2),
    b("gate", "gate 3", 450, 125, 2, 3),
    b("clockPack", "pack anchor_clock 0.125 0.125 0.125", 200, 170, 4),
    b("clockHot", "trigger b f", 600, 125, 1, 2),
    b("host", "plugsync~", 10, 90, 1, 9),
    b("prePack", "pack anchor_pre 0 0.125 0.125 0", 10, 210, 5),
    b("postPack", "pack anchor_post 0 0.125 0.125 0", 400, 210, 5),
    b("poll", "qmetro 10 @active 0", 10, 50),
    b("order", "trigger b b b b", 10, 125, 1, 4),
    b("preOrder", "trigger b b", 10, 170, 1, 2),
    b("postOrder", "trigger b b", 120, 170, 1, 2),
    b("dspOrder", "trigger b b", 600, 50, 1, 2),
    b("dsp", "dspstate~", 600, 90, 1, 4),
    b("dspPack", "pack anchor_dsp 0 0.125 0", 400, 250, 4),
    b("output", "print host-clock-native-report", 10, 350, 1, 0),
    b("clockOutput", "out~ 1", 240, 350, 1, 0),
  ];
  for (const { box } of boxes) box.varname = `ml_anchor_${box.id}`;
  const lines = [
    w("command", 0, "collector"),
    w("collector", 0, "output"),
    w("collector", 1, "poll"),
    w("poll", 0, "order"),
    w("order", 3, "dspOrder"),
    w("dspOrder", 1, "dsp"),
    w("dspOrder", 0, "dspPack"),
    w("dsp", 0, "dspPack", 1),
    w("dsp", 1, "dspPack", 2),
    w("dsp", 2, "dspPack", 3),
    w("dspPack", 0, "collector"),
    w("order", 2, "preOrder"),
    w("preOrder", 1, "host"),
    w("preOrder", 0, "prePack"),
    w("prePack", 0, "collector"),
    w("order", 1, "snapshot"),
    w("order", 0, "postOrder"),
    w("postOrder", 1, "host"),
    w("postOrder", 0, "postPack"),
    w("postPack", 0, "collector"),
    w("clock", 1, "channels"),
    w("phase", 0, "channels", 1),
    w("clock", 1, "channels", 2),
    w("clock", 1, "clockOutput"),
    w("channels", 0, "snapshot"),
    w("snapshot", 1, "voice"),
    w("voice", 0, "gate"),
    w("snapshot", 0, "gate", 1),
    w("gate", 0, "clockPack", 1),
    w("gate", 1, "clockPack", 2),
    w("gate", 2, "clockHot"),
    w("clockHot", 1, "clockPack", 3),
    w("clockHot", 0, "clockPack"),
    w("clockPack", 0, "collector"),
  ];
  for (const destination of ["prePack", "postPack"]) {
    for (const [outlet, inlet] of [
      [0, 1],
      [6, 2],
      [7, 3],
      [8, 4],
    ]) {
      lines.push(w("host", outlet, destination, inlet));
    }
  }
  return { patcher: patch(boxes, lines) };
}

export function taggedSpectrumDocument({ resourceDirectory = null } = {}) {
  const resource = engineeringResources(resourceDirectory);
  const boxes = [
    b("left", "fftin~ 1 square", 10, 10, 1, 3),
    b("right", "fftin~ 2 square", 250, 10, 1, 3),
    b("clock", "fftin~ 3 nofft", 500, 10, 1, 3),
    b("clockHigh", "fftin~ 4 nofft", 500, 45, 1, 3),
    b(
      "energy",
      `gen~ ${resource("tagged_spectrum_probe.gendsp")} @nocache 1`,
      10,
      70,
      7,
      10,
    ),
    b("command", "in 5", 10, 120),
    b("commandRoute", "route diagnostics", 10, 90, 1, 2),
    b("diagPoll", "trigger b b b b b", 10, 350, 1, 5),
    b("diagPack", "pack 0.125 0.125 0.125 0.125 0", 250, 310, 5),
    b("diagPrint", "print native-fft-clock-diagnostics", 250, 350, 1, 0),
    b("infoOrder", "trigger b b b", 500, 120, 1, 3),
    b("info", "fftinfo~", 500, 150, 1, 4),
    b("infoPack", "pack fft-info 0.125 0.125 0.125 0.125", 500, 270, 5),
    b("infoChange", "zl.change", 500, 310, 2, 2),
    b("infoPrint", "print native-fft-information", 500, 350, 1, 0),
    b("poll", "trigger b b b b b b", 10, 160, 1, 6),
    b(
      "pack",
      "pack spectrum_frame 0.125 0.125 0.125 0.125 0.125 0",
      10,
      270,
      7,
    ),
    b("hot", "trigger b f", 10, 230, 1, 2),
    b("out", "out 1", 10, 320, 1, 0),
  ];
  const lines = [
    w("left", 0, "energy"),
    w("left", 1, "energy", 1),
    w("right", 0, "energy", 2),
    w("right", 1, "energy", 3),
    w("left", 2, "energy", 4),
    w("clock", 1, "energy", 5),
    w("clockHigh", 1, "energy", 6),
    w("command", 0, "commandRoute"),
    w("commandRoute", 1, "infoOrder"),
    w("commandRoute", 0, "diagPoll"),
    w("diagPack", 0, "diagPrint"),
    w("infoOrder", 2, "info"),
    w("infoOrder", 1, "infoPack"),
    w("infoOrder", 0, "poll"),
    w("infoPack", 0, "infoChange"),
    w("infoChange", 0, "infoPrint"),
    w("pack", 0, "out"),
    w("hot", 1, "pack", 5),
    w("hot", 0, "pack"),
  ];
  for (let i = 0; i < 4; i++) lines.push(w("info", i, "infoPack", i + 1));
  for (let i = 0; i < 5; i++) {
    boxes.push(b(`diagSnap${i}`, "snapshot~ @offset 0", 250 + i * 100, 240, 2));
    lines.push(
      w("energy", i + 5, `diagSnap${i}`),
      w("diagPoll", i, `diagSnap${i}`),
      w(`diagSnap${i}`, 0, "diagPack", i),
    );
  }
  for (const [i, signal, inlet] of [
    [5, 3, 1],
    [4, 0, 2],
    [3, 1, 3],
    [2, 2, 4],
    [1, 4, 6],
    [0, 3, -1],
  ]) {
    boxes.push(b(`snap${i}`, "snapshot~ @offset 0", 120 + i * 100, 210, 2));
    lines.push(
      w("energy", signal, `snap${i}`),
      w("poll", i, `snap${i}`),
      w(`snap${i}`, 0, inlet < 0 ? "hot" : "pack", inlet < 0 ? 0 : inlet),
    );
  }
  for (const { box } of boxes) box.varname = `ml_fft_${box.id}`;
  return { patcher: patch(boxes, lines) };
}

export function synchronizedAnalysisDocument({
  resourceDirectory = null,
  rmsReference = false,
} = {}) {
  const resource = engineeringResources(resourceDirectory);
  const boxes = [
    b("command", "in 1", 10, 10),
    b("left", "in~ 2", 150, 10),
    b("right", "in~ 3", 250, 10),
    b("clock", "in~ 4", 350, 10),
    b("phase", "plugphasor~", 450, 10),
    b(
      "gen",
      `gen~ ${resource("clock_anchored_envelope_probe.gendsp")} @nocache 1`,
      150,
      60,
      4,
      15,
    ),
    b(
      "fft",
      `pfft~ ${resource("tagged_spectrum_probe.maxpat")} 2048 1 0 1 @float32 0`,
      150,
      110,
      5,
    ),
    b(
      "collector",
      `js ${resource("hosted_calibration_probe.js")}`,
      10,
      270,
      1,
      3,
    ),
    b("poll", "qmetro 10 @active 1", 10, 110),
    b(
      "clockSplit",
      `gen~ ${resource("clock_split_probe.gendsp")} @nocache 1`,
      550,
      150,
      1,
      2,
    ),
    b("pollOrder", "trigger b b", 10, 150, 1, 2),
    b("channels", "mc.pack~ 13", 150, 150, 13),
    b("snapshot", "mc.snapshot~ @offset 0", 150, 190, 1, 2),
    b("voice", "route voice", 400, 150, 1, 2),
    b("gate", "gate 13", 400, 190, 2, 13),
    b("pack", `pack ${Array(13).fill("0.125").join(" ")}`, 150, 230, 13),
    b("print", "print synchronized-native-report", 10, 320, 1, 0),
    b("load", "loadbang", 600, 10),
    b("path", "live.path live_set", 600, 50, 1, 3),
    b("song", "live.object", 600, 110, 2),
    b("sourceId", "print synchronized-native-source", 500, 320, 1, 0),
    b("route", "route origin fft-diagnostics", 10, 60, 1, 3),
    b("diagCommand", "diagnostics", 10, 90, 2, 1, { maxclass: "message" }),
    b("originPoll", "trigger b b b", 400, 60, 1, 3),
    b("originPack", "pack origin 0 0.125 0.125", 400, 270, 4),
    b("originHot", "trigger b f", 650, 230, 1, 2),
    b("originPrint", "print synchronized-native-origin", 300, 320, 1, 0),
    b("clockOut", "out~ 1", 150, 350, 1, 0),
  ];
  const lines = [
    w("command", 0, "route"),
    w("route", 2, "collector"),
    w("route", 0, "originPoll"),
    w("route", 1, "diagCommand"),
    w("diagCommand", 0, "fft", 4),
    w("left", 0, "gen", 1),
    w("right", 0, "gen", 2),
    w("phase", 0, "gen"),
    w("clock", 0, "gen", 3),
    w("clock", 0, "clockOut"),
    w("left", 0, "fft"),
    w("right", 0, "fft", 1),
    w("clock", 0, "clockSplit"),
    w("clockSplit", 0, "fft", 2),
    w("clockSplit", 1, "fft", 3),
    w("fft", 0, "collector"),
    w("collector", 0, "print"),
    w("collector", 1, "gen"),
    w("collector", 2, "song"),
    w("load", 0, "path"),
    w("path", 0, "song"),
    w("path", 0, "sourceId"),
    w("poll", 0, "pollOrder"),
    w("pollOrder", 1, "fft", 4),
    w("pollOrder", 0, "snapshot"),
    w("channels", 0, "snapshot"),
    w("snapshot", 1, "voice"),
    w("voice", 0, "gate"),
    w("snapshot", 0, "gate", 1),
    w("pack", 0, "collector"),
    w("originHot", 1, "originPack", 3),
    w("originHot", 0, "originPack"),
    w("originPack", 0, "originPrint"),
  ];
  for (let i = 0; i < 13; i++) {
    lines.push(
      w("gen", i, "channels", i),
      w(
        "gate",
        i,
        "pack",
        rmsReference ? (i === 12 ? 1 : i + 2) : i === 12 ? 0 : i + 1,
      ),
    );
  }
  for (const [i, output] of [
    [2, 0],
    [1, 13],
    [0, 14],
  ]) {
    boxes.push(
      b(`originSnap${i}`, "snapshot~ @offset 0", 400 + i * 100, 230, 2),
    );
    lines.push(
      w("gen", output, `originSnap${i}`),
      w("originPoll", i, `originSnap${i}`),
      w(
        `originSnap${i}`,
        0,
        i === 0 ? "originHot" : "originPack",
        i === 0 ? 0 : 3 - i,
      ),
    );
  }
  if (rmsReference) {
    boxes.find(({ box }) => box.id === "poll").box.text = "qmetro 10 @active 0";
    boxes.find(({ box }) => box.id === "channels").box.text = "mc.pack~ 15";
    boxes.find(({ box }) => box.id === "channels").box.numinlets = 15;
    boxes.find(({ box }) => box.id === "gate").box.text = "gate 15";
    boxes.find(({ box }) => box.id === "gate").box.numoutlets = 15;
    boxes.find(({ box }) => box.id === "pack").box.text =
      `pack rms_reference ${Array(15).fill("0.125").join(" ")}`;
    boxes.find(({ box }) => box.id === "pack").box.numinlets = 16;
    boxes.push(
      b("refDone", "delta~", 780, 50),
      b("refInterval", "4800", 780, 10, 2, 1, { maxclass: "message" }),
      b("refHot", "trigger b f", 780, 230, 1, 2),
      b("refRoute", "route reference_poll", 10, 200, 1, 2),
    );
    const controlIndex = lines.findIndex(
      ({ patchline }) =>
        patchline.source[0] === "collector" &&
        patchline.source[1] === 1 &&
        patchline.destination[0] === "gen",
    );
    if (controlIndex < 0)
      throw new Error("Missing native envelope control route");
    lines.splice(controlIndex, 1);
    lines.push(
      w("collector", 1, "refRoute"),
      w("refRoute", 0, "poll"),
      w("refRoute", 1, "gen"),
    );
    lines.push(
      w("gen", 12, "refDone"),
      w("load", 0, "refInterval"),
      w("gate", 14, "refHot"),
      w("refHot", 1, "pack", 15),
      w("refHot", 0, "pack"),
    );
    for (const [index, input] of ["left", "right"].entries()) {
      boxes.push(
        b(`refDelay${index}`, "delay~ 64 64", 780 + index * 150, 90, 2),
        b(`refAverage${index}`, "average~ 4800 rms", 780 + index * 150, 130),
        b(`refHold${index}`, "sah~ 0", 780 + index * 150, 170, 2),
      );
      lines.push(
        w(input, 0, `refDelay${index}`),
        w(`refDelay${index}`, 0, `refAverage${index}`),
        w("refInterval", 0, `refAverage${index}`),
        w(`refAverage${index}`, 0, `refHold${index}`),
        w("refDone", 0, `refHold${index}`, 1),
        w(`refHold${index}`, 0, "channels", 13 + index),
      );
    }
    lines.push(w("gate", 13, "pack", 14));
  }
  for (const { box } of boxes) box.varname = `ml_synced_${box.id}`;
  return { patcher: patch(boxes, lines) };
}
