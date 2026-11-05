import assert from "node:assert/strict";
import test from "node:test";
import {
  appendNativeRuntimeGraph,
  nativeRuntimeDocuments,
} from "./native-runtime-source.mjs";
import { sourceDocuments } from "./native-source.mjs";

const boxes = (doc) =>
  new Map(doc.patcher.boxes.map(({ box }) => [box.id, box]));
const has = (doc, source, outlet, target, inlet = 0) =>
  doc.patcher.lines.some(
    ({ patchline: p }) =>
      JSON.stringify(p.source) === JSON.stringify([source, outlet]) &&
      JSON.stringify(p.destination) === JSON.stringify([target, inlet]),
  );

test("production mel has ten exact source-bound signals and a dedicated control inlet", () => {
  const docs = nativeRuntimeDocuments({ nativeVersion: 5 });
  const graph = docs["audio_listener_native_analysis.maxpat"];
  const b = boxes(graph);
  assert.equal(b.get("melEngine").text, "listener.mel~");
  assert.equal(b.get("melEngine").numinlets, 10);
  assert.equal(b.get("melEngine").numoutlets, 1);
  assert.equal(b.get("melCommand").text, "in 5");
  const sources = [
    ["left", 0],
    ["right", 0],
    ["clock", 0],
    ...[0, 2, 6, 7, 9, 13, 18].map((outlet) => ["gen", outlet]),
  ];
  sources.forEach(([source, outlet], inlet) =>
    assert(has(graph, source, outlet, "melEngine", inlet)),
  );
  assert(has(graph, "melCommand", 0, "melEngine"));
  assert(!has(graph, "command", 0, "melEngine"));
  assert(!has(graph, "melCommand", 0, "gen"));
  assert.equal(b.get("melMessages").text, "prepend native_mel");
  assert(has(graph, "melEngine", 0, "melMessages"));
  assert(has(graph, "melMessages", 0, "nativeMessages"));
  assert.doesNotMatch(JSON.stringify(graph), /fluid\.(?:buf)?melbands~/);
  for (const version of [1, 2, 3, 4])
    assert(
      !JSON.stringify(
        nativeRuntimeDocuments({ nativeVersion: version }),
      ).includes("listener.mel~"),
    );
});

test("production root routes mel controls exclusively and preserves stereo and diagnostics", () => {
  const parent = sourceDocuments()["Audio-Listener.maxpat"];
  boxes(parent).get("node").varname = "ml_runtime";
  boxes(parent).get("guard").varname = "ml_guard";
  const graph = appendNativeRuntimeGraph(parent, {
    nativeVersion: 5,
    runtimeEntry: "audio_listener_native_v5_max.js",
  });
  const b = boxes(graph);
  assert.equal(b.get("melControlRoute").text, "route mel_native_control");
  assert.equal(b.get("scoped-native-analysis").numinlets, 5);
  assert(has(graph, "node", 0, "melControlRoute"));
  assert(has(graph, "melControlRoute", 0, "scoped-native-analysis", 4));
  assert(has(graph, "melControlRoute", 1, "scoped-native-control"));
  assert(!has(graph, "node", 0, "scoped-native-control"));
  assert(has(graph, "scoped-native-analysis", 1, "node"));
  for (const channel of [0, 1]) {
    assert(has(graph, "input", channel, "output", channel));
    assert(has(graph, "input", channel, "scoped-native-analysis", channel + 1));
  }
  assert.equal(b.get("flatness-smoke-output").text, "prepend flatness_smoke");
  assert(has(graph, "flatness-smoke-output", 0, "node"));
});
