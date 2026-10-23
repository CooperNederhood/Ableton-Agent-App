import { isAbsolute, join } from "node:path";
import { genDocument } from "./native-source.mjs";
import {
  CLOCK_CODE,
  hostClockDocument,
  synchronizedAnalysisDocument,
  taggedSpectrumDocument,
} from "./calibration-source.mjs";
import {
  CLOCK_ANCHORED_ENVELOPE_CODE,
  descriptiveEnvelopeCode,
} from "./synchronized-envelope-source.mjs";
import { DESCRIPTIVE_CLOCK_CODE } from "./host-timing-source.mjs";
import {
  CLOCK_SPLIT_CODE,
  TAGGED_SPECTRUM_CODE,
  descriptiveSpectrumCode,
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

// Passive taps of existing Gen outputs 6..10: lastBadStart, lastBadBin,
// lastBadActual, lastBadExpected, lastBadGuards. Explicit scheduler ordering
// fills all cold pack inlets before emitting. Separate signal snapshots are
// NOT vector-atomic and this packet supplies no capture/admission authority.
function spectrumDiagnosticsPatcher() {
  const document = {
    patcher: {
      fileversion: 1,
      classnamespace: "box",
      rect: [0, 0, 800, 380],
      boxes: [],
      lines: [],
    },
  };
  add(document, "command", "", 0);
  box(document, "command").maxclass = "inlet";
  box(document, "command").patching_rect = [760, 10, 25, 25];
  add(document, "poll", "trigger b b b b b b", 1, 6);
  box(document, "poll").patching_rect = [100, 130, 180, 22];
  add(
    document,
    "pack",
    "pack spectrum_diagnostics 0.125 0.125 0.125 0.125 0.125",
    6,
  );
  box(document, "pack").patching_rect = [10, 180, 460, 22];
  add(document, "out", "", 1, 0);
  box(document, "out").maxclass = "outlet";
  box(document, "out").patching_rect = [10, 230, 50, 22];
  document.patcher.lines.push(
    wire("command", 0, "poll"),
    wire("poll", 0, "pack"),
    wire("pack", 0, "out"),
  );
  for (let index = 0; index < 5; index++) {
    const input = `input${index}`;
    const snapshot = `snapshot${index}`;
    add(document, input, "", 0);
    box(document, input).maxclass = "inlet";
    box(document, input).outlettype = ["signal"];
    box(document, input).patching_rect = [10 + index * 150, 10, 25, 25];
    add(document, snapshot, "snapshot~ @offset 0", 2);
    box(document, snapshot).patching_rect = [10 + index * 150, 70, 130, 22];
    document.patcher.lines.push(
      wire(input, 0, snapshot),
      wire("poll", 5 - index, snapshot),
      wire(snapshot, 0, "pack", index + 1),
    );
  }
  return document.patcher;
}

// A separate message cohort. The v2 analysis graph routes it through its own
// generation-owned envelope IO, never through the root broadcast. Both bookend
// epochs come from the SAME capture Gen evaluation.
function configurationReadbackPatcher() {
  const document = {
    patcher: {
      fileversion: 1,
      classnamespace: "box",
      rect: [0, 0, 800, 380],
      boxes: [],
      lines: [],
    },
  };
  const specs = [
    ["channels", "mc.pack~ 7", 7, 1, 10, 65],
    ["snapshot", "mc.snapshot~ @offset 0", 1, 2, 10, 110],
    ["voice", "route voice", 1, 2, 450, 110],
    ["gate", "gate 7", 2, 7, 450, 155],
    [
      "pack",
      `pack configuration_frame ${Array(7).fill("0.125").join(" ")}`,
      8,
      1,
      10,
      220,
    ],
    ["hot", "trigger b f", 1, 2, 650, 190],
    ["output", "", 1, 0, 10, 285],
  ];
  for (const [id, text, inputs, outputs, x, y] of specs) {
    add(document, id, text, inputs, outputs);
    box(document, id).patching_rect = [
      x,
      y,
      Math.min(780 - x, Math.max(60, text.length * 6)),
      22,
    ];
  }
  box(document, "output").maxclass = "outlet";
  for (let index = 0; index < 8; index++) {
    const id = `input${index}`;
    add(document, id, "", 0, 1);
    box(document, id).maxclass = "inlet";
    box(document, id).patching_rect = [10 + index * 100, 10, 25, 25];
    document.patcher.lines.push(
      index === 7 ? wire(id, 0, "snapshot") : wire(id, 0, "channels", index),
    );
    if (index < 7)
      document.patcher.lines.push(
        index === 6
          ? wire("gate", index, "hot")
          : wire("gate", index, "pack", index + 1),
      );
  }
  document.patcher.lines.push(
    wire("channels", 0, "snapshot"),
    wire("snapshot", 1, "voice"),
    wire("voice", 0, "gate"),
    wire("snapshot", 0, "gate", 1),
    wire("hot", 1, "pack", 7),
    wire("hot", 0, "pack"),
    wire("pack", 0, "output"),
  );
  return document.patcher;
}

/** Pair with nativeRuntimeDocuments using the same explicitly selected version.
 * Resource filenames stay shared; the selected document set carries the ABI.
 * Never adds a second SDK client or audio output.
 */
export function appendNativeRuntimeGraph(
  document,
  { runtimeEntry, nativeVersion = 1 } = {},
) {
  if (nativeVersion !== 1 && nativeVersion !== 2)
    throw new Error("unsupported_native_version");
  if (
    typeof runtimeEntry !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}\.js$/.test(runtimeEntry)
  )
    throw new Error("native_runtime_entry_required");
  const result = JSON.parse(JSON.stringify(document));
  const patcher = result?.patcher;
  if (!Array.isArray(patcher?.boxes) || !Array.isArray(patcher?.lines))
    throw new Error("invalid_authored_native_graph");
  const runtimes = patcher.boxes.filter(
    ({ box }) =>
      box.varname === "ml_runtime" && box.text?.startsWith("node.script "),
  );
  const inputs = patcher.boxes.filter(({ box }) => box.text === "plugin~");
  const guards = patcher.boxes.filter(
    ({ box }) =>
      box.varname === "ml_guard" &&
      box.text?.startsWith("js audio_listener_guard.js"),
  );
  if (runtimes.length !== 1 || inputs.length !== 1 || guards.length !== 1)
    throw new Error("ambiguous_authored_native_runtime_or_input");
  const runtime = runtimes[0].box;
  const input = inputs[0].box;
  const guard = guards[0].box;
  if (guard.numoutlets !== undefined && guard.numoutlets < 3)
    throw new Error("authored_native_watchdog_outlet_missing");
  // Select the parent's independently bounded v2 watchdog explicitly; its v1
  // default otherwise truncates a full 30-second capture plus lifecycle time.
  if (nativeVersion === 2) guard.text = "js audio_listener_guard.js 2";
  const routes = patcher.lines.filter(
    ({ patchline }) =>
      patchline.source[0] === runtime.id && patchline.source[1] === 0,
  );
  if (routes.length === 0)
    throw new Error("authored_native_runtime_routes_missing");
  const bottom = Math.max(
    ...patcher.boxes.map(({ box }) =>
      Array.isArray(box.patching_rect)
        ? box.patching_rect[1] + box.patching_rect[3]
        : 0,
    ),
  );
  const specs = [
    ["clock", "poly~ audio_listener_native_clock.maxpat 1 @parallel 0", 1, 2],
    [
      "analysis",
      "poly~ audio_listener_native_analysis.maxpat 1 @parallel 0",
      4,
      nativeVersion === 2 ? 3 : 2,
    ],
    ["clock_sink", "snapshot~ 100", 1, 1],
    ["analysis_sink", "snapshot~ 100", 1, 1],
    ["control", "route native_control", 1, 2],
  ];
  for (const [index, [name, text, inlets, outlets]] of specs.entries()) {
    const id = `scoped-native-${name}`;
    const varname = `ml_scoped_native_${name}`;
    if (patcher.boxes.some(({ box }) => box.varname === varname))
      throw new Error("duplicate_authored_native_runtime");
    add(result, id, text, inlets, outlets);
    const added = box(result, id);
    added.varname = varname;
    added.patching_rect[1] = bottom + 50 + index * 45;
  }
  patcher.lines = patcher.lines.filter((line) => !routes.includes(line));
  runtime.text = `node.script ${runtimeEntry} @autostart 1 @watch 0`;
  for (const route of routes)
    patcher.lines.push({
      patchline: {
        ...route.patchline,
        source: ["scoped-native-control", 1],
      },
    });
  patcher.lines.push(
    wire(runtime.id, 0, "scoped-native-control"),
    wire("scoped-native-control", 0, "scoped-native-clock"),
    wire("scoped-native-control", 0, "scoped-native-analysis"),
    wire(input.id, 0, "scoped-native-analysis", 1),
    wire(input.id, 1, "scoped-native-analysis", 2),
    wire("scoped-native-clock", 0, "scoped-native-analysis", 3),
    wire("scoped-native-clock", 0, "scoped-native-clock_sink"),
    wire("scoped-native-analysis", 0, "scoped-native-analysis_sink"),
    wire("scoped-native-clock", 1, runtime.id),
    wire("scoped-native-analysis", 1, runtime.id),
    wire("scoped-native-control", 0, guard.id),
    wire(guard.id, 2, "scoped-native-clock"),
    wire(guard.id, 2, "scoped-native-analysis"),
  );
  for (const { patchline } of patcher.lines) {
    if (
      patchline.source[0] === "scoped-native-control" &&
      patchline.source[1] === 0
    )
      patchline.order =
        patchline.destination[0] === "scoped-native-clock"
          ? 0
          : patchline.destination[0] === "scoped-native-analysis"
            ? 1
            : 2;
  }
  if (Array.isArray(patcher.rect))
    patcher.rect[3] = Math.max(patcher.rect[3], bottom + 300);
  return result;
}

/** Candidate processed-message graph only; does not modify or activate the shipping device. */
export function nativeRuntimeDocuments({
  resourceDirectory = null,
  nativeVersion = 1,
} = {}) {
  if (nativeVersion !== 1 && nativeVersion !== 2)
    throw new Error("unsupported_native_version");
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
  add(clock, "nativePhase", "pong~ 1 0. 1.", 3);
  clock.patcher.lines = clock.patcher.lines.filter(
    ({ patchline }) =>
      !(patchline.source[0] === "collector" && patchline.source[1] === 1) &&
      !(
        patchline.source[0] === "phase" &&
        patchline.destination[0] === "channels"
      ),
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
    wire("phase", 0, "nativePhase"),
    wire("nativePhase", 0, "channels", 1),
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

  if (nativeVersion === 2) {
    // Authoritative samples cannot use qmetro's queue-overload drops.
    for (const document of [clock, analysis])
      box(document, "poll").text = "metro 10 @active 0";

    // Offset zero follows scheduler sub-vector time in Audio Interrupt mode.
    // Compare the host bracket with the latest available DSP sample instead.
    add(clock, "snapshotLastIndex", "- 1");
    add(clock, "snapshotOffset", "prepend offset");
    box(clock, "snapshotLastIndex").patching_rect = [600, 285, 60, 22];
    box(clock, "snapshotOffset").patching_rect = [670, 285, 115, 22];
    clock.patcher.lines.push(
      wire("dsp", 2, "snapshotLastIndex"),
      wire("snapshotLastIndex", 0, "snapshotOffset"),
      wire("snapshotOffset", 0, "snapshot"),
    );

    // Version selection is part of the opt-in graph, not a change to IO code or
    // shipping/default resources.
    for (const [document, id] of [
      [clock, "collector"],
      [analysis, "collector"],
      [fft, "nativeIO"],
    ])
      box(document, id).text += " 2";

    // Finish diagnostic reads/publication before beginning the main spectrum
    // snapshots. Retain fft_info and ABI ordering and the six-value frame ABI.
    box(fft, "infoOrder").text = "trigger b b b b b";
    box(fft, "infoOrder").numoutlets = 5;
    box(fft, "infoOrder").patching_rect[2] = 110;
    for (const { patchline } of fft.patcher.lines)
      if (patchline.source[0] === "infoOrder" && patchline.source[1] > 0)
        patchline.source[1] += 1;
    add(fft, "spectrumDiagnostics", "p native-spectrum-diagnostics", 6);
    box(fft, "spectrumDiagnostics").patching_rect = [300, 305, 310, 22];
    box(fft, "spectrumDiagnostics").patcher = spectrumDiagnosticsPatcher();
    fft.patcher.lines.push(
      wire("infoOrder", 1, "spectrumDiagnostics", 5),
      wire("spectrumDiagnostics", 0, "nativeIO"),
    );
    for (let index = 0; index < 5; index++)
      fft.patcher.lines.push(
        wire("energy", 5 + index, "spectrumDiagnostics", index),
      );

    box(analysis, "gen").numoutlets = 23;
    add(
      analysis,
      "configurationReadback",
      "p native-configuration-readback",
      8,
    );
    box(analysis, "configurationReadback").patcher =
      configurationReadbackPatcher();
    box(analysis, "configurationReadback").patching_rect = [540, 300, 250, 22];
    add(analysis, "configurationMessages", "out 2", 1, 0);
    box(analysis, "configurationMessages").patching_rect = [430, 300, 80, 22];
    box(analysis, "pollOrder").text = "trigger b b b";
    box(analysis, "pollOrder").numoutlets = 3;
    for (const { patchline } of analysis.patcher.lines)
      if (
        patchline.source[0] === "pollOrder" &&
        patchline.destination[0] === "fft"
      )
        patchline.source[1] = 2;
    const ownedReceipt = wire("configurationReadback", 0, "collector");
    ownedReceipt.patchline.order = 0;
    const diagnosticReceipt = wire(
      "configurationReadback",
      0,
      "configurationMessages",
    );
    diagnosticReceipt.patchline.order = 1;
    analysis.patcher.lines.push(
      wire("pollOrder", 1, "configurationReadback", 7),
      ownedReceipt,
      diagnosticReceipt,
    );
    for (let index = 0; index < 7; index++)
      analysis.patcher.lines.push(
        wire("gen", 16 + index, "configurationReadback", index),
      );

    // Explicit graph-level routing only: no IO/Node/controller activation.
    // Old IO deliberately cannot configure or grant eligibility to these ABIs.
    for (const [document, target] of [
      [clock, "clock"],
      [analysis, "gen"],
    ]) {
      const selectors = [
        "epoch",
        "cancel",
        "totalSamples",
        "hopSamples",
        "tempoBpm",
        "startBeatFraction",
        "captureVector",
      ];
      const routes = document.patcher.lines.filter(
        ({ patchline }) => patchline.source[0] === "command",
      );
      document.patcher.lines = document.patcher.lines.filter(
        (line) => !routes.includes(line),
      );
      add(
        document,
        "descriptiveConfig",
        `route ${selectors.join(" ")}`,
        1,
        selectors.length + 1,
      );
      box(document, "descriptiveConfig").patching_rect = [10, 335, 780, 22];
      document.patcher.lines.push(wire("command", 0, "descriptiveConfig"));
      for (const route of routes)
        document.patcher.lines.push({
          patchline: {
            ...route.patchline,
            source: ["descriptiveConfig", selectors.length],
          },
        });
      for (const [index, selector] of selectors.entries()) {
        const id = `descriptive-${selector}`;
        add(document, id, `prepend ${selector}`);
        box(document, id).patching_rect = [10 + index * 110, 358, 105, 22];
        document.patcher.lines.push(
          wire("descriptiveConfig", index, id),
          wire(id, 0, target),
        );
      }
    }
  }

  const documents = {
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
  if (nativeVersion === 2) {
    documents["audio_listener_native_clock.gendsp"] = genDocument(
      DESCRIPTIVE_CLOCK_CODE,
      0,
      8,
    );
    documents["audio_listener_native_envelope.gendsp"] = genDocument(
      descriptiveEnvelopeCode({ configurationReadback: true }),
      4,
      23,
      { outputSpacing: 15 },
    );
    documents["audio_listener_native_spectrum.gendsp"] = genDocument(
      `${descriptiveSpectrumCode()}\nout11 = 2;`,
      7,
      11,
      { outputSpacing: 22 },
    );
  }
  return documents;
}
