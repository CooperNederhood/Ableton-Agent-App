const wire = (source, outlet, destination, inlet = 0) => ({
  patchline: { source: [source, outlet], destination: [destination, inlet] },
});

export function appendFlatnessSmokeGraph(
  document,
  inputId,
  runtimeId,
  guardId,
) {
  const patcher = document.patcher;
  const boxes = [];
  const lines = [];
  const add = (id, maxclass, text, x, y, numinlets, numoutlets) => {
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
  };
  add("left", "inlet", null, 10, 10, 0, 1);
  add("right", "inlet", null, 160, 10, 0, 1);
  add("control", "inlet", null, 650, 10, 0, 1);
  for (const [channel, name] of ["left", "right"].entries()) {
    add(
      `shape-${name}`,
      "newobj",
      "fluid.spectralshape~ @select flatness @fftsettings 2048 2048 2048 @power 0 @minfreq 0 @maxfreq -1",
      10,
      60 + channel * 45,
      1,
      2,
    );
    lines.push(
      wire(name, 0, `shape-${name}`),
      wire(`shape-${name}`, 0, "gate", channel + 1),
    );
  }
  add("gate", "newobj", "js audio_listener_flatness_smoke.js", 10, 160, 3, 1);
  add("out", "outlet", null, 10, 220, 1, 0);
  lines.push(wire("control", 0, "gate"), wire("gate", 0, "out"));
  const specs = [
    {
      id: "flatness-smoke",
      text: "p flatness-smoke",
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
      id: "flatness-smoke-control",
      text: "route flatness_smoke_control",
      numinlets: 1,
      numoutlets: 2,
    },
    {
      id: "flatness-smoke-output",
      text: "prepend flatness_smoke",
      numinlets: 1,
      numoutlets: 1,
    },
    {
      id: "flatness-smoke-guard-route",
      text: "route stop",
      numinlets: 1,
      numoutlets: 2,
    },
    {
      id: "flatness-smoke-guard-stop",
      text: "prepend guardstop",
      numinlets: 1,
      numoutlets: 1,
    },
  ];
  for (const [index, spec] of specs.entries()) {
    if (patcher.boxes.some(({ box }) => box.id === spec.id))
      throw new Error("duplicate_flatness_smoke_graph");
    patcher.boxes.push({
      box: {
        ...spec,
        maxclass: "newobj",
        patching_rect: [500, 400 + index * 40, 280, 22],
      },
    });
  }
  patcher.lines.push(
    wire(inputId, 0, "flatness-smoke", 0),
    wire(inputId, 1, "flatness-smoke", 1),
    wire(runtimeId, 0, "flatness-smoke-control"),
    wire("flatness-smoke-control", 0, "flatness-smoke", 2),
    wire("flatness-smoke", 0, "flatness-smoke-output"),
    wire("flatness-smoke-output", 0, runtimeId),
    wire(guardId, 2, "flatness-smoke-guard-route"),
    wire("flatness-smoke-guard-route", 0, "flatness-smoke-guard-stop"),
    wire("flatness-smoke-guard-stop", 0, "flatness-smoke", 2),
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
import { FLUCOMA_DEPENDENCY_DIRECTORY } from "../../packages/shared/dist/flucoma-dependency.js";
