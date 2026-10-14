import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import {
  appendNativeRuntimeGraph,
  nativeRuntimeDocuments,
} from "./native-runtime-source.mjs";
import { sourceDocuments } from "./native-source.mjs";
import {
  CLOCK_CODE,
  hostClockDocument,
  synchronizedAnalysisDocument,
  taggedSpectrumDocument,
} from "./calibration-source.mjs";
import { CLOCK_ANCHORED_ENVELOPE_CODE } from "./synchronized-envelope-source.mjs";
import { TAGGED_SPECTRUM_CODE } from "./synchronized-spectrum-source.mjs";

const require = createRequire(import.meta.url);
const { NativeMessageIO } = require("./audio_listener_native_io.js");
const generation = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
function fixture(mode) {
  const packets = [],
    controls = [],
    diagnostics = [];
  return {
    packets,
    controls,
    diagnostics,
    io: new NativeMessageIO(
      mode,
      (packet) => packets.push(packet),
      (control) => controls.push(control),
      (reason) => diagnostics.push(reason),
    ),
  };
}
const boxes = (document) =>
  new Map(document.patcher.boxes.map(({ box }) => [box.id, box]));
const connected = (document, source, outlet, destination, inlet = 0) =>
  document.patcher.lines.some(
    ({ patchline }) =>
      patchline.source[0] === source &&
      patchline.source[1] === outlet &&
      patchline.destination[0] === destination &&
      patchline.destination[1] === inlet,
  );

test("opt-in authored native composition preserves the existing client, presentation and stereo path", () => {
  const authored = sourceDocuments()["Audio-Listener.maxpat"];
  const node = authored.patcher.boxes.find(({ box }) =>
    box.text?.startsWith("node.script "),
  ).box;
  node.varname = "ml_runtime";
  const guard = authored.patcher.boxes.find(
    ({ box }) => box.text === "js audio_listener_guard.js",
  ).box;
  guard.varname = "ml_guard";
  const original = JSON.stringify(authored);
  const native = appendNativeRuntimeGraph(authored, {
    runtimeEntry: "audio_listener_native_max.js",
  });
  assert.equal(JSON.stringify(authored), original);
  assert.equal(native.patcher.boxes.length, authored.patcher.boxes.length + 5);
  assert.equal(native.patcher.lines.length, authored.patcher.lines.length + 13);
  for (const { box: before } of authored.patcher.boxes) {
    const after = boxes(native).get(before.id);
    assert.deepEqual(
      after,
      before.id === node.id
        ? {
            ...before,
            text: "node.script audio_listener_native_max.js @autostart 1 @watch 0",
          }
        : before,
    );
  }
  assert.equal(
    native.patcher.boxes.filter(({ box }) =>
      box.text?.startsWith("node.script "),
    ).length,
    1,
  );
  for (const line of authored.patcher.lines) {
    const [source, outlet] = line.patchline.source;
    assert.ok(
      native.patcher.lines.some(
        (candidate) =>
          JSON.stringify(candidate) ===
          JSON.stringify(
            source === node.id && outlet === 0
              ? {
                  patchline: {
                    ...line.patchline,
                    source: ["scoped-native-control", 1],
                  },
                }
              : line,
          ),
      ),
    );
  }
  assert.ok(connected(native, node.id, 0, "scoped-native-control"));
  assert.ok(
    connected(native, "scoped-native-control", 0, "scoped-native-clock"),
  );
  assert.ok(
    connected(native, "scoped-native-control", 0, "scoped-native-analysis"),
  );
  assert.ok(
    connected(native, "scoped-native-clock", 0, "scoped-native-analysis", 3),
  );
  assert.ok(connected(native, "scoped-native-clock", 1, node.id));
  assert.ok(connected(native, "scoped-native-analysis", 1, node.id));
  assert.ok(connected(native, "scoped-native-control", 0, guard.id));
  assert.ok(connected(native, guard.id, 2, "scoped-native-clock"));
  assert.ok(connected(native, guard.id, 2, "scoped-native-analysis"));
  assert.deepEqual(
    native.patcher.lines
      .filter(
        ({ patchline }) =>
          patchline.source[0] === "scoped-native-control" &&
          patchline.source[1] === 0,
      )
      .map(({ patchline }) => [patchline.destination[0], patchline.order]),
    [
      ["scoped-native-clock", 0],
      ["scoped-native-analysis", 1],
      [guard.id, 2],
    ],
  );
  assert.throws(
    () => appendNativeRuntimeGraph(authored),
    /native_runtime_entry_required/,
  );
  assert.throws(
    () => appendNativeRuntimeGraph(native, { runtimeEntry: "native.js" }),
    /duplicate_authored_native_runtime/,
  );
});

test("candidate native graphs preserve every existing default graph and native math", () => {
  const before = JSON.stringify([
    hostClockDocument(),
    synchronizedAnalysisDocument(),
    taggedSpectrumDocument(),
  ]);
  const documents = nativeRuntimeDocuments();
  assert.equal(Object.keys(documents).length, 7);
  assert.equal(
    boxes(documents["audio_listener_native_clock.gendsp"]).get("code").code,
    `${CLOCK_CODE}\nout8 = 1;`,
  );
  assert.equal(
    boxes(documents["audio_listener_native_envelope.gendsp"]).get("code").code,
    `${CLOCK_ANCHORED_ENVELOPE_CODE}\nout16 = 1;`,
  );
  assert.equal(
    boxes(documents["audio_listener_native_spectrum.gendsp"]).get("code").code,
    `${TAGGED_SPECTRUM_CODE}\nout11 = 1;`,
  );
  assert.equal(
    JSON.stringify([
      hostClockDocument(),
      synchronizedAnalysisDocument(),
      taggedSpectrumDocument(),
    ]),
    before,
  );
  assert.throws(
    () => nativeRuntimeDocuments({ resourceDirectory: "./relative" }),
    /absolute/,
  );
  const text = JSON.stringify(
    nativeRuntimeDocuments({ resourceDirectory: "/owned/native" }),
  );
  assert(text.includes("/owned/native/audio_listener_native_io.js"));
  assert.doesNotMatch(
    text,
    /print |live\.object|live\.path|hosted_calibration_probe|node\.script|buffer~|index~|plugout~|dac~/,
  );
});

test("authored native composition denies ambiguous ownership and unsafe entries without mutating its source", () => {
  for (const entry of [
    undefined,
    "../native.js",
    "/native.js",
    "native.js extra",
  ]) {
    const source = sourceDocuments()["Audio-Listener.maxpat"];
    const before = JSON.stringify(source);
    assert.throws(
      () => appendNativeRuntimeGraph(source, { runtimeEntry: entry }),
      /native_runtime_entry_required/,
    );
    assert.equal(JSON.stringify(source), before);
  }
  for (const failure of [
    "missing-runtime",
    "duplicate-runtime",
    "duplicate-input",
    "missing-routes",
  ]) {
    const source = sourceDocuments()["Audio-Listener.maxpat"];
    const node = source.patcher.boxes.find(({ box }) =>
      box.text?.startsWith("node.script "),
    ).box;
    node.varname = "ml_runtime";
    if (failure === "missing-runtime") node.varname = "other";
    if (failure === "duplicate-runtime")
      source.patcher.boxes.push({ box: { ...node, id: "other-runtime" } });
    if (failure === "duplicate-input")
      source.patcher.boxes.push({
        box: { id: "other-input", text: "plugin~", maxclass: "newobj" },
      });
    if (failure === "missing-routes")
      source.patcher.lines = source.patcher.lines.filter(
        ({ patchline }) =>
          patchline.source[0] !== node.id || patchline.source[1] !== 0,
      );
    const before = JSON.stringify(source);
    assert.throws(() =>
      appendNativeRuntimeGraph(source, { runtimeEntry: "native.js" }),
    );
    assert.equal(JSON.stringify(source), before);
  }
});

test("native host phase is signal-rate wrapped before strict clock validation without delaying the counter", () => {
  const clock = nativeRuntimeDocuments()["audio_listener_native_clock.maxpat"];
  assert.equal(boxes(clock).get("nativePhase")?.text, "pong~ 1 0. 1.");
  assert(connected(clock, "phase", 0, "nativePhase"));
  assert(connected(clock, "nativePhase", 0, "channels", 1));
  assert.equal(connected(clock, "phase", 0, "channels", 1), false);
  assert(connected(clock, "clock", 1, "channels", 0));
  assert(connected(clock, "clock", 1, "channels", 2));
  assert(connected(clock, "clock", 1, "clockOutput"));
  assert.equal(boxes(clock).get("snapshot").text, "mc.snapshot~ @offset 0");
});

test("native graphs have unique valid cables, request-gated polling and compiled ABI reads", () => {
  const documents = nativeRuntimeDocuments();
  for (const [name, document] of Object.entries(documents)) {
    const mapping = boxes(document),
      cables = new Set();
    assert.equal(mapping.size, document.patcher.boxes.length, name);
    for (const { patchline } of document.patcher.lines) {
      const [source, outlet] = patchline.source,
        [destination, inlet] = patchline.destination;
      assert(
        mapping.has(source) && mapping.has(destination),
        `${name}: missing endpoint`,
      );
      assert(
        outlet >= 0 && outlet < mapping.get(source).numoutlets,
        `${name}: invalid outlet ${source}`,
      );
      assert(
        inlet >= 0 && inlet < mapping.get(destination).numinlets,
        `${name}: invalid inlet ${destination}`,
      );
      const key = JSON.stringify([patchline.source, patchline.destination]);
      assert(!cables.has(key), `${name}: duplicate cable`);
      cables.add(key);
    }
    for (const box of mapping.values())
      if (box.text?.startsWith("qmetro"))
        assert.equal(box.text, "qmetro 10 @active 0");
  }
  const clock = documents["audio_listener_native_clock.maxpat"];
  assert.equal(boxes(clock).get("nativeMessages").text, "out 1");
  assert.equal(boxes(clock).get("clockOutput").text, "out~ 1");
  assert(connected(clock, "clock", 7, "channels", 3));
  assert(connected(clock, "host", 5, "nativeTempo"));
  assert(connected(clock, "gate", 2, "clockPack", 3));
  assert(connected(clock, "clockHot", 1, "clockPack", 4));
  assert(connected(clock, "nativeControl", 0, "poll"));
  assert(!connected(clock, "nativeControl", 1, "clock"));
  const analysis = documents["audio_listener_native_analysis.maxpat"];
  assert.equal(boxes(analysis).get("nativeMessages").text, "out 1");
  assert.equal(boxes(analysis).get("clockOut").text, "out~ 1");
  assert.equal(boxes(analysis).get("pack").numinlets, 17);
  for (let index = 0; index < 16; index++)
    assert(connected(analysis, "gen", index, "channels", index));
  assert(connected(analysis, "nativeCommands", 1, "fft", 4));
  assert(connected(analysis, "nativeCommands", 0, "collector"));
  assert(connected(analysis, "nativeHot", 1, "pack", 16));
  assert(connected(analysis, "nativeControl", 1, "gen"));
  const fft = documents["audio_listener_native_fft.maxpat"];
  assert(connected(fft, "energy", 10, "nativeABI"));
  assert(connected(fft, "infoPack", 0, "nativeIO"));
  assert(connected(fft, "nativeIO", 0, "out"));
});

test("native IO brackets actual host/clock values with the owned generation and compiled ABI", () => {
  const f = fixture("clock");
  assert.equal(f.io.anchorPre([0, 0, 1000, 31]), false);
  f.io.begin(generation);
  assert.deepEqual(f.controls, [
    ["poll", 0],
    ["poll", 1],
  ]);
  f.io.packet("dsp", [1, 48000, 64], 3);
  f.io.packet("tempo", [120], 1);
  f.io.anchorPre([0, 0, 1000, 31]);
  f.io.anchorClock([64, 0.25, 64, 1]);
  f.io.anchorPost([0, 0, 1000, 31]);
  assert.deepEqual(f.packets, [
    ["native", generation, "dsp", 1, 48000, 64],
    ["native", generation, "tempo", 120],
    ["native", generation, "abi-clock", 1],
    [
      "native",
      generation,
      "clock",
      0,
      0,
      1000,
      31,
      64,
      0.25,
      64,
      0,
      0,
      1000,
      31,
    ],
  ]);
  assert.equal(f.io.pre, null);
  assert.equal(f.io.clock, null);
  f.io.stop(generation);
  assert.deepEqual(f.controls.at(-1), ["poll", 0]);
  assert.equal(f.io.anchorPost([0, 0, 1000, 31]), false);
  assert.equal(f.packets.length, 4);
});

test("native envelope arm, cancellation and stale generations never control transport or another pass", () => {
  const f = fixture("envelope");
  f.io.begin(generation);
  assert.deepEqual(f.controls, [
    ["poll", 0],
    ["cancel", 1],
    ["epoch", 0],
    ["poll", 1],
  ]);
  assert.equal(f.io.arm(other, 1), false);
  assert.equal(f.io.stop(other), false);
  assert.equal(f.io.generation, generation);
  assert.equal(f.packets.length, 0);
  f.io.arm(generation, 7);
  assert.deepEqual(f.controls.slice(-2), [
    ["cancel", 0],
    ["epoch", 7],
  ]);
  const envelope = [7, -1, -1, 0, 0, 0, -1, -1, 0, 0, 0, 0, 0, 1000, -1, 1];
  f.io.envelope(envelope);
  assert.deepEqual(f.packets, [
    ["native", generation, "abi-envelope", 1],
    ["native", generation, "envelope", ...envelope],
  ]);
  f.io.stop(generation);
  assert.deepEqual(f.controls.slice(-3), [
    ["poll", 0],
    ["cancel", 1],
    ["epoch", 0],
  ]);
  assert.equal(f.io.generation, null);
  assert.equal(f.io.envelope(envelope), false);
  assert.equal(f.io.stop(generation), false);
  assert(
    f.controls.every(([action]) =>
      ["poll", "cancel", "epoch"].includes(action),
    ),
  );
});

test("native IO rejects bounded malformed inputs without retaining or echoing unsafe bodies", () => {
  const f = fixture("clock");
  assert.equal(f.io.begin("token=super-secret-value"), false);
  f.io.begin(generation);
  for (let repeat = 0; repeat < 100; repeat++)
    f.io.anchorPre([Infinity, "token=super-secret-value"]);
  assert.deepEqual(f.packets, [["native", generation, "ioError", 1]]);
  assert.equal(f.io.pre, null);
  assert.equal(f.io.clock, null);
  assert(
    !JSON.stringify([f.packets, f.diagnostics]).includes("super-secret-value"),
  );
  assert.equal(f.io.begin(other), true);
  f.io.anchorPre([0, 0, 1000, 31]);
  f.io.anchorPost([0, 0, 1000, 31]);
  assert.deepEqual(f.packets.at(-1), ["native", other, "ioError", 1]);
  assert.throws(() => fixture("invalid"), /mode/);
});

test("metadata is deduplicated per generation while changes and every descriptor remain visible", () => {
  const f = fixture("clock");
  f.io.begin(generation);
  for (let index = 0; index < 1000; index++) f.io.packet("tempo", [120], 1);
  assert.equal(f.packets.length, 1);
  f.io.packet("tempo", [121], 1);
  assert.deepEqual(f.packets.at(-1), ["native", generation, "tempo", 121]);
  for (let index = 0; index < 10; index++)
    f.io.packet("spectrum", [2048, 0, 0, 0, 2048, 0], 6);
  assert.equal(f.packets.length, 12);
  f.io.stop(generation);
  assert.deepEqual(f.io.metadata, {});
  f.io.begin(other);
  f.io.packet("tempo", [121], 1);
  assert.deepEqual(f.packets.at(-1), ["native", other, "tempo", 121]);
  assert.equal(f.io.packet("raw", [1], 1), false);
  assert.deepEqual(f.packets.at(-1), ["native", other, "ioError", 1]);
});

test("the actual Max script has global ES5-compatible message handlers and cleanup", async () => {
  const source = await readFile(
    new URL("./audio_listener_native_io.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /,\s*\)|=>|\b(?:const|let|async|await|require)\b/,
  );
  for (const mode of ["clock", "envelope", "spectrum"]) {
    const packets = [],
      diagnostics = [];
    const context = {
      jsarguments: ["native_io.js", mode],
      outlet: (index, values) =>
        packets.push([index, JSON.parse(JSON.stringify(values))]),
      post: (value) => diagnostics.push(value),
      arrayfromargs: (values) => Array.from(values),
    };
    runInNewContext(source, context);
    for (const handler of [
      "begin",
      "arm",
      "stop",
      "anchor_pre",
      "anchor_clock",
      "anchor_post",
      "anchor_dsp",
      "tempo",
      "fft_info",
      "spectrum_frame",
      "envelope_frame",
      "abi_value",
      "notifydeleted",
    ])
      assert.equal(typeof context[handler], "function", `${mode}:${handler}`);
    context.begin(generation);
    context.fft_info(2048, 2048, 2048, 1);
    context.abi_value(1);
    context.spectrum_frame(2048, 0, 0, 0, 2048, 0);
    assert(
      packets.some(
        ([index, values]) => index === 0 && values[2] === "spectrum",
      ),
    );
    context.notifydeleted();
    assert.equal(context.nativeIO.generation, null);
    assert.deepEqual(diagnostics, []);
  }
});
