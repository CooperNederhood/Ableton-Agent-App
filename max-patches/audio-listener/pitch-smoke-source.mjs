import { FLUCOMA_DEPENDENCY_DIRECTORY } from "../../packages/shared/dist/flucoma-dependency.js";

const wire = (source, outlet, destination, inlet = 0) => ({
  patchline: { source: [source, outlet], destination: [destination, inlet] },
});
export function appendPitchSmokeGraph(document, inputId, runtimeId, guardId) {
  const patcher = document.patcher;
  if (patcher.boxes.some(({ box }) => box.id === "pitch-smoke"))
    throw new Error("duplicate_pitch_smoke_graph");
  const boxes = [];
  const lines = [];
  const add = (id, maxclass, text, x, y, numinlets, numoutlets) =>
    boxes.push({
      box: {
        id,
        varname: id,
        maxclass,
        ...(text ? { text } : {}),
        patching_rect: [x, y, maxclass === "newobj" ? 560 : 25, 22],
        numinlets,
        numoutlets,
      },
    });
  add("left", "inlet", null, 10, 10, 0, 1);
  add("right", "inlet", null, 160, 10, 0, 1);
  add("control", "inlet", null, 650, 10, 0, 1);
  for (const [channel, name] of ["left", "right"].entries()) {
    add(
      `pitch-${name}`,
      "newobj",
      "fluid.pitch~ @algorithm 2 @unit 0 @minfreq 50 @maxfreq 2000 @fftsettings 2048 2048 2048 @select pitch confidence",
      10,
      60 + channel * 45,
      1,
      2,
    );
    lines.push(
      wire(name, 0, `pitch-${name}`),
      wire(`pitch-${name}`, 0, "gate", channel + 1),
    );
  }
  add("gate", "newobj", "js audio_listener_pitch_smoke.js", 10, 160, 3, 1);
  add("out", "outlet", null, 10, 220, 1, 0);
  lines.push(wire("control", 0, "gate"), wire("gate", 0, "out"));
  const specs = [
    {
      id: "pitch-smoke",
      text: "p pitch-smoke",
      numinlets: 3,
      numoutlets: 1,
      patcher: {
        fileversion: 1,
        classnamespace: "box",
        rect: [0, 0, 800, 380],
        boxes,
        lines,
      },
    },
    {
      id: "pitch-smoke-control",
      text: "route pitch_smoke_control",
      numinlets: 1,
      numoutlets: 2,
    },
    {
      id: "pitch-smoke-output",
      text: "prepend pitch_smoke",
      numinlets: 1,
      numoutlets: 1,
    },
    {
      id: "pitch-smoke-guard-stop",
      text: "prepend guardstop",
      numinlets: 1,
      numoutlets: 1,
    },
  ];
  // Reuse the existing guard's stop selector but retain a separate physical gate.
  // A standalone graph gets its own uniquely named selector for deterministic tests.
  const guardRoute = "flatness-smoke-guard-route";
  if (!patcher.boxes.some(({ box }) => box.id === guardRoute)) {
    specs.push({
      id: guardRoute,
      text: "route stop",
      numinlets: 1,
      numoutlets: 2,
    });
    patcher.lines.push(wire(guardId, 2, guardRoute));
  }
  for (const [index, spec] of specs.entries())
    patcher.boxes.push({
      box: {
        ...spec,
        maxclass: "newobj",
        patching_rect: [500, 160 + index * 40, 280, 22],
      },
    });
  patcher.lines.push(
    wire(inputId, 0, "pitch-smoke", 0),
    wire(inputId, 1, "pitch-smoke", 1),
    wire(runtimeId, 0, "pitch-smoke-control"),
    wire("pitch-smoke-control", 0, "pitch-smoke", 2),
    wire("pitch-smoke", 0, "pitch-smoke-output"),
    wire("pitch-smoke-output", 0, runtimeId),
    wire(guardRoute, 0, "pitch-smoke-guard-stop"),
    wire("pitch-smoke-guard-stop", 0, "pitch-smoke", 2),
  );
  patcher.project = {
    ...patcher.project,
    searchpath: {
      0: {
        bootpath: `./${FLUCOMA_DEPENDENCY_DIRECTORY}`,
        projectrelativepath: `./${FLUCOMA_DEPENDENCY_DIRECTORY}`,
        label: "Bundled FluCoMa",
        recursive: 0,
        enabled: 1,
        includeincollective: 0,
      },
    },
  };
}
