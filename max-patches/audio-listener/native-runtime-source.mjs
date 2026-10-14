import { isAbsolute, join } from "node:path";
import { genDocument } from "./native-source.mjs";
import {
  CLOCK_CODE,
  hostClockDocument,
  synchronizedAnalysisDocument,
  taggedSpectrumDocument,
} from "./calibration-source.mjs";
import { CLOCK_ANCHORED_ENVELOPE_CODE } from "./synchronized-envelope-source.mjs";
import {
  CLOCK_SPLIT_CODE,
  TAGGED_SPECTRUM_CODE,
} from "./synchronized-spectrum-source.mjs";

const wire = (source, outlet, destination, inlet = 0) => ({
  patchline: { source: [source, outlet], destination: [destination, inlet] },
});
function box(document, id) {
  const matches = document.patcher.boxes.filter(({ box }) => box.id === id);
  if (matches.length !== 1) throw new Error(`invalid_native_graph_box:${id}`);
  return matches[0].box;
}
function add(document, id, text, inputs = 1, outputs = 1) {
  if (document.patcher.boxes.some(({ box }) => box.id === id))
    throw new Error(`duplicate_native_graph_box:${id}`);
  document.patcher.boxes.push({
    box: {
      id,
      text,
      maxclass: "newobj",
      numinlets: inputs,
      numoutlets: outputs,
      patching_rect: [10, 400, Math.max(60, text.length * 6), 22],
      varname: `ml_native_${id}`,
    },
  });
}
function prune(document, ids) {
  for (const id of ids) box(document, id);
  const removed = new Set(ids);
  document.patcher.boxes = document.patcher.boxes.filter(
    ({ box }) => !removed.has(box.id),
  );
  document.patcher.lines = document.patcher.lines.filter(
    ({ patchline }) =>
      !removed.has(patchline.source[0]) &&
      !removed.has(patchline.destination[0]),
  );
}
function replaceResources(document, resource) {
  const names = {
    "calibration_clock.gendsp": "audio_listener_native_clock.gendsp",
    "clock_anchored_envelope_probe.gendsp":
      "audio_listener_native_envelope.gendsp",
    "clock_split_probe.gendsp": "audio_listener_native_split.gendsp",
    "tagged_spectrum_probe.gendsp": "audio_listener_native_spectrum.gendsp",
    "tagged_spectrum_probe.maxpat": "audio_listener_native_fft.maxpat",
  };
  for (const { box } of document.patcher.boxes)
    for (const [before, after] of Object.entries(names))
      box.text = box.text?.replace(resource(before), resource(after));
}

/** Candidate processed-message graph only; does not modify or activate the shipping device. */
export function nativeRuntimeDocuments({ resourceDirectory = null } = {}) {
  if (resourceDirectory !== null && !isAbsolute(resourceDirectory))
    throw new Error("native_resource_directory_must_be_absolute");
  const resource = (name) =>
    resourceDirectory === null ? name : join(resourceDirectory, name);
  const clock = hostClockDocument({ resourceDirectory });
  replaceResources(clock, resource);
  prune(clock, ["output"]);
  box(clock, "collector").text =
    `js ${resource("audio_listener_native_io.js")} clock`;
  box(clock, "collector").numoutlets = 2;
  box(clock, "clock").numoutlets = 8;
  box(clock, "channels").text = "mc.pack~ 4";
  box(clock, "channels").numinlets = 4;
  box(clock, "gate").text = "gate 4";
  box(clock, "gate").numoutlets = 4;
  box(clock, "clockPack").text = "pack anchor_clock 0.125 0.125 0.125 0.125";
  box(clock, "clockPack").numinlets = 5;
  add(clock, "nativeMessages", "out 1", 1, 0);
  add(clock, "nativeControl", "route poll", 1, 2);
  add(clock, "nativeTempo", "prepend tempo");
  clock.patcher.lines = clock.patcher.lines.filter(
    ({ patchline }) =>
      !(patchline.source[0] === "collector" && patchline.source[1] === 1),
  );
  for (const { patchline } of clock.patcher.lines) {
    if (patchline.source[0] === "gate" && patchline.source[1] === 2)
      patchline.destination = ["clockPack", 3];
    if (patchline.source[0] === "clockHot" && patchline.source[1] === 1)
      patchline.destination = ["clockPack", 4];
  }
  clock.patcher.lines.push(
    wire("collector", 0, "nativeMessages"),
    wire("collector", 1, "nativeControl"),
    wire("nativeControl", 0, "poll"),
    wire("clock", 7, "channels", 3),
    wire("gate", 3, "clockHot"),
    wire("host", 5, "nativeTempo"),
    wire("nativeTempo", 0, "collector"),
  );

  const fft = taggedSpectrumDocument({ resourceDirectory });
  replaceResources(fft, resource);
  prune(fft, [
    "diagPoll",
    "diagPack",
    "diagPrint",
    "infoChange",
    "infoPrint",
    "diagSnap0",
    "diagSnap1",
    "diagSnap2",
    "diagSnap3",
    "diagSnap4",
  ]);
  box(fft, "energy").numoutlets = 11;
  box(fft, "commandRoute").text = "route bang";
  box(fft, "infoPack").text = "pack fft_info 0.125 0.125 0.125 0.125";
  box(fft, "infoOrder").text = "trigger b b b b";
  box(fft, "infoOrder").numoutlets = 4;
  fft.patcher.lines = fft.patcher.lines.filter(
    ({ patchline }) =>
      !["commandRoute", "infoOrder", "pack"].includes(patchline.source[0]),
  );
  add(
    fft,
    "nativeIO",
    `js ${resource("audio_listener_native_io.js")} spectrum`,
    1,
    2,
  );
  add(fft, "nativeABI", "snapshot~ @offset 0", 2);
  add(fft, "nativeABIPrefix", "prepend abi_value");
  fft.patcher.lines.push(
    wire("commandRoute", 0, "infoOrder"),
    wire("commandRoute", 1, "nativeIO"),
    wire("infoOrder", 3, "info"),
    wire("infoOrder", 2, "infoPack"),
    wire("infoOrder", 1, "nativeABI"),
    wire("infoOrder", 0, "poll"),
    wire("infoPack", 0, "nativeIO"),
    wire("pack", 0, "nativeIO"),
    wire("energy", 10, "nativeABI"),
    wire("nativeABI", 0, "nativeABIPrefix"),
    wire("nativeABIPrefix", 0, "nativeIO"),
    wire("nativeIO", 0, "out"),
  );

  const analysis = synchronizedAnalysisDocument({ resourceDirectory });
  replaceResources(analysis, resource);
  prune(analysis, [
    "print",
    "load",
    "path",
    "song",
    "sourceId",
    "route",
    "diagCommand",
    "originPoll",
    "originPack",
    "originHot",
    "originPrint",
    "originSnap0",
    "originSnap1",
    "originSnap2",
  ]);
  box(analysis, "collector").text =
    `js ${resource("audio_listener_native_io.js")} envelope`;
  box(analysis, "collector").numoutlets = 2;
  box(analysis, "gen").numoutlets = 16;
  box(analysis, "poll").text = "qmetro 10 @active 0";
  box(analysis, "channels").text = "mc.pack~ 16";
  box(analysis, "channels").numinlets = 16;
  box(analysis, "gate").text = "gate 16";
  box(analysis, "gate").numoutlets = 16;
  box(analysis, "pack").text =
    `pack envelope_frame ${Array(16).fill("0.125").join(" ")}`;
  box(analysis, "pack").numinlets = 17;
  add(analysis, "nativeMessages", "out 1", 1, 0);
  add(analysis, "nativeControl", "route poll", 1, 2);
  add(analysis, "nativeCommands", "trigger l l", 1, 2);
  add(analysis, "nativeHot", "trigger b f", 1, 2);
  analysis.patcher.lines = analysis.patcher.lines.filter(
    ({ patchline }) =>
      !(patchline.source[0] === "collector" && patchline.source[1] === 1) &&
      !(
        patchline.source[0] === "fft" &&
        patchline.destination[0] === "collector"
      ) &&
      !(
        patchline.source[0] === "gen" && patchline.destination[0] === "channels"
      ) &&
      !(patchline.source[0] === "gate" && patchline.destination[0] === "pack"),
  );
  analysis.patcher.lines.push(
    wire("command", 0, "nativeCommands"),
    wire("nativeCommands", 1, "fft", 4),
    wire("nativeCommands", 0, "collector"),
    wire("collector", 0, "nativeMessages"),
    wire("fft", 0, "nativeMessages"),
    wire("collector", 1, "nativeControl"),
    wire("nativeControl", 0, "poll"),
    wire("nativeControl", 1, "gen"),
    wire("nativeHot", 1, "pack", 16),
    wire("nativeHot", 0, "pack"),
  );
  for (let index = 0; index < 16; index++) {
    analysis.patcher.lines.push(wire("gen", index, "channels", index));
    analysis.patcher.lines.push(
      index === 15
        ? wire("gate", index, "nativeHot")
        : wire("gate", index, "pack", index + 1),
    );
  }

  return {
    "audio_listener_native_clock.gendsp": genDocument(
      `${CLOCK_CODE}\nout8 = 1;`,
      0,
      8,
    ),
    "audio_listener_native_envelope.gendsp": genDocument(
      `${CLOCK_ANCHORED_ENVELOPE_CODE}\nout16 = 1;`,
      4,
      16,
    ),
    "audio_listener_native_spectrum.gendsp": genDocument(
      `${TAGGED_SPECTRUM_CODE}\nout11 = 1;`,
      7,
      11,
    ),
    "audio_listener_native_split.gendsp": genDocument(CLOCK_SPLIT_CODE, 1, 2),
    "audio_listener_native_clock.maxpat": clock,
    "audio_listener_native_fft.maxpat": fft,
    "audio_listener_native_analysis.maxpat": analysis,
  };
}
