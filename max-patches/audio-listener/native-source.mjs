/** Deterministic original patch source. Canonical docs researched before selection.
 * No user patch is read, modified, saved or used as a template by this generator.
 */
import { SHARED_PRODUCER_IDENTITY } from "../../scripts/m4l-producer-companions.mjs";
const box = (id, text, x, y, inputs = 1, outputs = 1, extra = {}) => ({
  box: {
    id,
    maxclass: "newobj",
    text,
    numinlets: inputs,
    numoutlets: outputs,
    patching_rect: [x, y, Math.min(780 - x, Math.max(60, text.length * 6)), 22],
    ...extra,
  },
});
const wire = (source, outlet, destination, inlet = 0) => ({
  patchline: { source: [source, outlet], destination: [destination, inlet] },
});
const patch = (boxes, lines, extra = {}) => ({
  patcher: {
    fileversion: 1,
    appversion: {
      major: 8,
      minor: 5,
      revision: 5,
      architecture: "x64",
      modernui: 1,
    },
    classnamespace: "box",
    rect: [0, 0, 800, 380],
    boxes,
    lines,
    ...extra,
  },
});

export function addDevicePreviewRouting(document, { x = 670, y = 240 } = {}) {
  const p = document.patcher;
  const one = (text) => {
    const matches = p.boxes.filter(({ box }) => box.text === text);
    if (matches.length !== 1)
      throw new Error(`expected one startup object: ${text}`);
    return matches[0].box.id;
  };
  const init = one("live.thisdevice");
  const route = one("route adapter-started");
  const node = one("node.script audio_listener_max.js @autostart 1 @watch 0");
  const boxes = [
    box("ml_device_preview", "prepend device-preview", x, y),
    box("ml_adapter_init", "trigger b b b", x, y + 35, 1, 3),
    box("ml_device_state_query", "getstate", x, y + 70, 2, 1, {
      maxclass: "message",
    }),
    // Retain the early preview emission; getstate can report only enabled state.
    box("ml_device_preview_latch", "int -1", x, y + 105, 2, 1),
  ];
  for (const { box: b } of boxes) b.varname = b.id;
  const lines = [
    wire(init, 2, "ml_device_preview"),
    wire("ml_device_preview", 0, node),
    wire(route, 0, "ml_adapter_init"),
    wire("ml_adapter_init", 2, "ml_device_state_query"),
    wire("ml_device_state_query", 0, init),
    wire("ml_adapter_init", 0, init),
    wire(init, 2, "ml_device_preview_latch", 1),
    wire("ml_adapter_init", 1, "ml_device_preview_latch"),
    wire("ml_device_preview_latch", 0, "ml_device_preview"),
  ];
  const matches = boxes.map(({ box: expected }) =>
    p.boxes.filter(
      ({ box: actual }) =>
        actual.id === expected.id || actual.varname === expected.varname,
    ),
  );
  const hasLine = (expected) =>
    p.lines.some(
      ({ patchline }) =>
        JSON.stringify(patchline.source) ===
          JSON.stringify(expected.patchline.source) &&
        JSON.stringify(patchline.destination) ===
          JSON.stringify(expected.patchline.destination),
    );
  const direct = wire(route, 0, init);
  if (matches.some((m) => m.length > 0)) {
    const sameBox = (m, i, text = boxes[i].box.text) =>
      m.length === 1 &&
      m[0].box.id === boxes[i].box.id &&
      m[0].box.text === text &&
      m[0].box.maxclass === boxes[i].box.maxclass;
    const oldQuery = wire("ml_adapter_init", 1, "ml_device_state_query");
    const legacyLines = [...lines.slice(0, 3), oldQuery, ...lines.slice(4, 6)];
    if (
      matches[3].length === 0 &&
      matches
        .slice(0, 3)
        .every((m, i) =>
          sameBox(m, i, i === 1 ? "trigger b b" : boxes[i].box.text),
        ) &&
      legacyLines.every(hasLine) &&
      !hasLine(direct) &&
      !hasLine(lines[3]) &&
      !p.lines.some(
        ({ patchline }) =>
          patchline.source[0] === "ml_device_preview_latch" ||
          patchline.destination[0] === "ml_device_preview_latch",
      )
    ) {
      matches[1][0].box.text = "trigger b b b";
      matches[1][0].box.numoutlets = 3;
      const query = p.lines.find(
        ({ patchline }) =>
          JSON.stringify(patchline.source) ===
            JSON.stringify(oldQuery.patchline.source) &&
          JSON.stringify(patchline.destination) ===
            JSON.stringify(oldQuery.patchline.destination),
      );
      query.patchline.source[1] = 2;
      p.boxes.push(boxes[3]);
      p.lines.push(...lines.slice(6));
      return document;
    }
    if (
      matches.some((m, i) => !sameBox(m, i)) ||
      !lines.every(hasLine) ||
      hasLine(direct) ||
      hasLine(oldQuery)
    ) {
      throw new Error("invalid device preview routing");
    }
    return document;
  }
  if (!hasLine(direct)) throw new Error("missing adapter startup route");
  p.lines = p.lines.filter(
    ({ patchline }) =>
      !(
        patchline.source[0] === route &&
        patchline.source[1] === 0 &&
        patchline.destination[0] === init &&
        patchline.destination[1] === 0
      ),
  );
  p.boxes.push(...boxes);
  p.lines.push(...lines);
  return document;
}

export const ENVELOPE_STATE = `History n(0);
History sumL(0); History sumR(0);
History peakL(0); History peakR(0);
History heldL(0); History heldR(0);
History heldRmsL(0); History heldRmsR(0);
History completed(0);`;
export const ENVELOPE_STEP = `hop = max(1, round(samplerate / 10));
sumL = sumL + in1 * in1; sumR = sumR + in2 * in2;
peakL = max(peakL, abs(in1)); peakR = max(peakR, abs(in2));
n = n + 1;
if (n >= hop) {
 heldL = peakL; heldR = peakR;
 heldRmsL = sqrt(sumL / hop); heldRmsR = sqrt(sumR / hop);
 completed = completed + hop;
 n = 0; sumL = 0; sumR = 0; peakL = 0; peakR = 0;
}`;
export const ENVELOPE_OUTPUT = `out1 = heldL; out2 = heldR; out3 = heldRmsL; out4 = heldRmsR;
out5 = completed;`;
export const ENVELOPE_CODE = `${ENVELOPE_STATE}\n${ENVELOPE_STEP}\n${ENVELOPE_OUTPUT}`;

export const SPECTRUM_CODE = `Param sourceSampleRate(48000);
History energy(0); History weighted(0);
History heldCentroid(0); History heldEnergy(0);
bin = in5;
if (bin == 0) { energy = 0; weighted = 0; }
if (bin <= 1024) {
 binEnergy = in1 * in1 + in2 * in2 + in3 * in3 + in4 * in4;
 energy = energy + binEnergy;
 weighted = weighted + binEnergy * bin * sourceSampleRate / 2048;
 if (bin == 1024) {
  heldEnergy = energy;
  heldCentroid = energy > 0.00000000000000000001 ? weighted / energy : 0;
 }
}
out1 = heldCentroid; out2 = heldEnergy;`;

export function genDocument(code, inputs, outputs) {
  const boxes = [
    {
      box: {
        id: "code",
        maxclass: "codebox",
        code,
        numinlets: inputs,
        numoutlets: outputs,
        patching_rect: [100, 50, 580, 240],
      },
    },
  ];
  const lines = [];
  for (let i = 0; i < inputs; i++) {
    boxes.push(box(`in${i}`, `in ${i + 1}`, 10, 20 + i * 35, 0, 1));
    lines.push(wire(`in${i}`, 0, "code", i));
  }
  for (let i = 0; i < outputs; i++) {
    boxes.push(box(`out${i}`, `out ${i + 1}`, 690, 20 + i * 35, 1, 0));
    lines.push(wire("code", i, `out${i}`));
  }
  return patch(boxes, lines, { classnamespace: "dsp.gen" });
}

export function spectrumDocument() {
  const boxes = [
    box("left", "fftin~ 1 square", 10, 20, 1, 3),
    box("right", "fftin~ 2 square", 250, 20, 1, 3),
    box("config", "in 3", 530, 20),
    box(
      "energy",
      "gen~ audio_listener_spectrum_energy @nocache 1",
      10,
      110,
      5,
      2,
    ),
    box("route", "route snapshot reload", 530, 60, 1, 3),
    box("reload", "reload", 660, 100, 1, 1, { maxclass: "message" }),
    box("poll", "trigger b b", 530, 100, 1, 2),
    box("centroidSnap", "snapshot~", 10, 175, 2),
    box("energySnap", "snapshot~", 240, 175, 2),
    // Descriptor messages bypass fftout~ windowing and overlap-add.
    box("centroid", "out 1", 10, 230, 1, 0),
    box("total", "out 2", 240, 230, 1, 0),
  ];
  return patch(boxes, [
    wire("left", 0, "energy", 0),
    wire("left", 1, "energy", 1),
    wire("right", 0, "energy", 2),
    wire("right", 1, "energy", 3),
    wire("left", 2, "energy", 4),
    wire("config", 0, "route"),
    wire("route", 2, "energy"),
    wire("route", 0, "poll"),
    wire("route", 1, "reload"),
    wire("reload", 0, "energy"),
    wire("poll", 0, "centroidSnap"),
    wire("poll", 1, "energySnap"),
    wire("energy", 0, "centroidSnap"),
    wire("energy", 1, "energySnap"),
    wire("centroidSnap", 0, "centroid"),
    wire("energySnap", 0, "total"),
  ]);
}

export function analysisDocument() {
  const boxes = [
    box("left", "in~ 1", 10, 15),
    box("right", "in~ 2", 180, 15),
    box("command", "in 3", 440, 15),
    box("route", "route reset sourceSampleRate snapshot reload", 440, 60, 1, 5),
    box("reset", "reset", 440, 100, 1, 1, { maxclass: "message" }),
    box("fftclear", "clear", 560, 100, 1, 1, { maxclass: "message" }),
    box("sr", "prepend sourceSampleRate", 570, 60),
    box("envelope", "gen~ audio_listener_envelope @nocache 1", 10, 135, 2, 5),
    box("spectrum", "pfft~ audio_listener_spectrum 2048 1 0 1", 350, 155, 3, 2),
    box("snapshot", "snapshot", 440, 130, 1, 1, { maxclass: "message" }),
    box("reload", "reload", 590, 130, 1, 1, { maxclass: "message" }),
    box("centroidHold", "sig~ 0.", 350, 205),
    box("energyHold", "sig~ 0.", 500, 205),
    box("clearHold", "0", 650, 205, 1, 1, { maxclass: "message" }),
  ];
  const lines = [
    wire("left", 0, "envelope"),
    wire("right", 0, "envelope", 1),
    wire("left", 0, "spectrum"),
    wire("right", 0, "spectrum", 1),
    wire("command", 0, "route"),
    wire("route", 0, "reset"),
    wire("reset", 0, "envelope"),
    wire("route", 0, "fftclear"),
    wire("fftclear", 0, "spectrum"),
    wire("route", 1, "sr"),
    wire("sr", 0, "spectrum", 2),
    wire("route", 2, "snapshot"),
    wire("snapshot", 0, "spectrum", 2),
    wire("route", 3, "reload"),
    wire("reload", 0, "spectrum", 2),
    wire("spectrum", 0, "centroidHold"),
    wire("spectrum", 1, "energyHold"),
    wire("route", 0, "clearHold"),
    wire("clearHold", 0, "centroidHold"),
    wire("clearHold", 0, "energyHold"),
  ];
  // Clear the spectrum Gen histories as well as pfft~'s internal FFT buffers.
  boxes.push(box("genreset", "reset", 675, 100, 1, 1, { maxclass: "message" }));
  lines.push(wire("route", 0, "genreset"), wire("genreset", 0, "spectrum", 2));
  for (let i = 0; i < 7; i++) {
    boxes.push(box(`out${i}`, `out~ ${i + 1}`, 10 + i * 105, 260, 1, 0));
    lines.push(
      i < 5
        ? wire("envelope", i, `out${i}`)
        : wire(i === 5 ? "centroidHold" : "energyHold", 0, `out${i}`),
    );
  }
  return patch(boxes, lines);
}

export function deviceDocument() {
  const boxes = [
    box("input", "plugin~", 10, 30, 2, 2),
    box("output", "plugout~", 10, 310, 2, 2),
    box(
      "analysis",
      "poly~ audio_listener_analysis 1 @parallel 0",
      170,
      55,
      3,
      7,
    ),
    box("idle", "loadmess mute 0 1", 10, 90),
    box("guard", "js audio_listener_guard.js", 460, 95, 1, 3),
    box(
      "node",
      "node.script audio_listener_max.js @autostart 1 @watch 0",
      340,
      310,
      1,
      2,
    ),
    box("nodeMessages", "route adapter-started", 460, 340, 1, 2),
    box("identity", `js ${SHARED_PRODUCER_IDENTITY}`, 570, 30),
    box("init", "live.thisdevice", 460, 30, 1, 3),
    box("enabled", "prepend device-enabled", 10, 120),
    box("clock", "qmetro 10 @active 1", 10, 160),
    box("tick", "trigger b b b", 10, 200, 1, 3),
    box("hostTrigger", "trigger b b", 170, 200, 1, 2),
    box("host", "plugsync~", 170, 160, 1, 9),
    box("hostPack", "pack host 0 0. 0. 0", 170, 245, 5),
    box("dspTrigger", "trigger b b", 670, 160, 1, 2),
    box("dsp", "dspstate~", 560, 160, 1, 4),
    box("dspPack", "pack dsp 0 0. 0", 600, 200, 4),
    box("snapTrigger", "trigger b b b b b b b", 10, 245, 1, 7),
    box("spectralPoll", "trigger b b", 10, 280, 1, 2),
    box("spectralSnapshot", "snapshot", 170, 280, 1, 1, {
      maxclass: "message",
    }),
    box("framePack", "pack 0. 0. 0. 0. 0. 0. 0.", 340, 245, 7),
    box("frameMsg", "prepend frame", 340, 280),
  ];
  // Host and DSP packs are explicitly banged AFTER polling, irrespective of outlet order.
  const lines = [
    wire("input", 0, "output", 0),
    wire("input", 1, "output", 1),
    wire("input", 0, "analysis"),
    wire("input", 1, "analysis", 1),
    wire("idle", 0, "analysis"),
    wire("node", 0, "nodeMessages"),
    wire("nodeMessages", 0, "init"),
    wire("nodeMessages", 1, "guard"),
    wire("guard", 0, "analysis"),
    wire("guard", 1, "analysis", 2),
    wire("guard", 2, "clock"),
    wire("init", 0, "identity"),
    wire("identity", 0, "node"),
    wire("init", 1, "enabled"),
    wire("enabled", 0, "node"),
    wire("clock", 0, "tick"),
    wire("tick", 2, "dspTrigger"),
    wire("tick", 1, "hostTrigger"),
    wire("tick", 0, "spectralPoll"),
    wire("spectralPoll", 1, "spectralSnapshot"),
    wire("spectralSnapshot", 0, "analysis", 2),
    wire("spectralPoll", 0, "snapTrigger"),
    wire("hostTrigger", 1, "host"),
    wire("hostTrigger", 0, "hostPack"),
    wire("host", 0, "hostPack", 1),
    wire("host", 6, "hostPack", 2),
    wire("host", 7, "hostPack", 3),
    wire("host", 8, "hostPack", 4),
    wire("hostPack", 0, "node"),
    wire("dspTrigger", 1, "dsp"),
    wire("dspTrigger", 0, "dspPack"),
    wire("dsp", 0, "dspPack", 1),
    wire("dsp", 1, "dspPack", 2),
    wire("dsp", 2, "dspPack", 3),
    wire("dspPack", 0, "node"),
    wire("framePack", 0, "frameMsg"),
    wire("frameMsg", 0, "node"),
  ];
  for (const [id, selector, name, minimum, maximum, initial, x] of [
    ["threshold", "attack-threshold", "Attack rise dB", 0, 120, 6, 10],
    ["spacing", "attack-spacing-ms", "Attack gap ms", 100, 2000, 100, 85],
  ]) {
    boxes.push(
      box(id, "", x, 55, 1, 2, {
        maxclass: "live.dial",
        varname: id,
        parameter_enable: 1,
        presentation: 1,
        patching_rect: [x, 55, 60, 40],
        presentation_rect: [x, 55, 70, 50],
        saved_attribute_attributes: {
          valueof: {
            parameter_longname: name,
            parameter_shortname: name,
            parameter_type: 0,
            parameter_mmin: minimum,
            parameter_mmax: maximum,
            parameter_initial_enable: 1,
            parameter_initial: [initial],
          },
        },
      }),
    );
    boxes.push(box(`${id}Msg`, `prepend ${selector}`, x, 15));
    lines.push(
      wire(id, 0, `${id}Msg`),
      wire(`${id}Msg`, 0, "node"),
      wire("init", 0, id),
    );
  }
  for (let i = 0; i < 7; i++) {
    boxes.push(box(`snap${i}`, "snapshot~", 170 + i * 85, 120, 2));
    lines.push(
      wire("analysis", i, `snap${i}`),
      wire("snapTrigger", i, `snap${i}`),
      wire(`snap${i}`, 0, "framePack", i),
    );
  }
  boxes.push(
    box(
      "label",
      "Audio Listener — transparent stereo tap; production capture requires real-Live calibration",
      10,
      350,
      1,
      0,
      {
        maxclass: "comment",
        presentation: 1,
        presentation_rect: [8, 8, 540, 40],
      },
    ),
  );
  return addDevicePreviewRouting(
    patch(boxes, lines, {
      devicewidth: 560,
      openinpresentation: 1,
      parameters: {
        threshold: ["Attack rise dB", "Attack rise dB", 0],
        spacing: ["Attack gap ms", "Attack gap ms", 0],
      },
      description:
        "On-demand native measurements. No audio recording. Calibration required.",
      dependency_cache: [],
    }),
  );
}

export function sourceDocuments() {
  return {
    "Audio-Listener.maxpat": deviceDocument(),
    "audio_listener_analysis.maxpat": analysisDocument(),
    "audio_listener_spectrum.maxpat": spectrumDocument(),
    "audio_listener_envelope.gendsp": genDocument(ENVELOPE_CODE, 2, 5),
    "audio_listener_spectrum_energy.gendsp": genDocument(SPECTRUM_CODE, 5, 2),
  };
}
