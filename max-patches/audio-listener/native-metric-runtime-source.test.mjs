import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import vm from "node:vm";
import {
  nativeRuntimeDocuments,
  appendNativeRuntimeGraph,
} from "./native-runtime-source.mjs";
import { addDevicePreviewRouting, sourceDocuments } from "./native-source.mjs";
import { retainedMusicalEnvelopeSource } from "./retained-native-source.mjs";
import { genModel } from "./gen-model.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const legacyHashes = [
  "d102081c366e48f040661f4d08d0ae8c597f8549ee0493a341c3f0fd2fe4473e",
  "31f79ee084b39a3eead7d7a63dd7781aa1ee38f33b88fd2537efaef1efe7136e",
  "31f79ee084b39a3eead7d7a63dd7781aa1ee38f33b88fd2537efaef1efe7136e",
  "838b20d3ba61c2cf933c02d53d283aa57a9c7ad537d7a5c2eba5a77e76493b57",
];
const boxes = (doc) =>
  new Map(doc.patcher.boxes.map(({ box }) => [box.id, box]));
const connected = (doc, source, outlet, target, inlet = 0) =>
  doc.patcher.lines.some(
    ({ patchline: p }) =>
      JSON.stringify(p.source) === JSON.stringify([source, outlet]) &&
      JSON.stringify(p.destination) === JSON.stringify([target, inlet]),
  );

const obsoleteParentIds = new Set([
  "threshold",
  "thresholdMsg",
  "spacing",
  "spacingMsg",
  "analysis",
  "idle",
  "enabled",
  "hostTrigger",
  "host",
  "hostPack",
  "snapTrigger",
  "spectralPoll",
  "spectralSnapshot",
  "framePack",
  "frameMsg",
  ...Array.from({ length: 7 }, (_, index) => `snap${index}`),
  "ml_device_preview",
  "ml_device_state_query",
  "ml_device_preview_latch",
]);

function authoredParent(preview = false) {
  const document = sourceDocuments()["Audio-Listener.maxpat"];
  if (preview) addDevicePreviewRouting(document);
  const node = document.patcher.boxes.find(({ box }) =>
    box.text?.startsWith("node.script "),
  ).box;
  const guard = document.patcher.boxes.find(
    ({ box }) => box.text === "js audio_listener_guard.js",
  ).box;
  node.varname = "ml_runtime";
  guard.varname = "ml_guard";
  return { document, node, guard };
}

test("v5 sends only implemented messages to its Node runtime, including preview-decorated startup", () => {
  for (const preview of [false, true]) {
    const { document, node } = authoredParent(preview);
    const result = appendNativeRuntimeGraph(document, {
      nativeVersion: 5,
      runtimeEntry: "audio_listener_native_v5_max.js",
    });
    const implementedSources = new Set([
      "identity",
      "dspPack",
      "scoped-native-clock",
      "scoped-native-analysis",
    ]);
    for (const { patchline } of result.patcher.lines) {
      if (patchline.destination[0] === node.id)
        assert.ok(
          implementedSources.has(patchline.source[0]),
          `unhandled Node source: ${patchline.source[0]}`,
        );
      assert.ok(!obsoleteParentIds.has(patchline.source[0]));
      assert.ok(!obsoleteParentIds.has(patchline.destination[0]));
    }
    for (const { box } of result.patcher.boxes)
      assert.ok(!obsoleteParentIds.has(box.id));
    assert.ok(connected(result, "identity", 0, node.id));
    assert.ok(connected(result, "dspPack", 0, node.id));
    assert.ok(connected(result, "input", 0, "output", 0));
    assert.ok(connected(result, "input", 1, "output", 1));
    if (boxes(result).has("ml_adapter_init")) {
      assert.equal(boxes(result).get("ml_adapter_init").text, "trigger b");
      assert.equal(boxes(result).get("ml_adapter_init").numoutlets, 1);
      assert.ok(connected(result, "nodeMessages", 0, "ml_adapter_init"));
      assert.ok(connected(result, "ml_adapter_init", 0, "init"));
    } else {
      assert.ok(connected(result, "nodeMessages", 0, "init"));
    }
    assert.ok(connected(result, "init", 0, "identity"));
  }
  const clock = nativeRuntimeDocuments({ nativeVersion: 5 })[
    "audio_listener_native_clock.maxpat"
  ];
  assert.equal(boxes(clock).get("host").text, "plugsync~");
  assert.equal(boxes(clock).get("phase").text, "plugphasor~");
});

test("FFT ownership controls exactly one parent scheduler and preserves cleanup after watchdog stop", () => {
  const docs = nativeRuntimeDocuments({ nativeVersion: 5 });
  const fft = docs["audio_listener_native_fft.maxpat"];
  const analysis = docs["audio_listener_native_analysis.maxpat"];
  assert.equal(
    boxes(fft).get("metricSpectrumPollControl").text,
    "prepend native_spectrum_poll",
  );
  assert(!boxes(fft).has("metricSpectrumPoll"));
  assert(connected(fft, "nativeControl", 0, "metricSpectrumPollControl"));
  assert(connected(fft, "metricSpectrumPollControl", 0, "out"));
  assert(connected(analysis, "fft", 0, "metricSpectrumMessages"));
  assert(
    connected(analysis, "metricSpectrumMessages", 0, "metricSpectrumPoll"),
  );
  assert(connected(analysis, "metricSpectrumMessages", 1, "nativeMessages"));
  assert(connected(analysis, "metricSpectrumPoll", 0, "fft", 4));
  for (const { patchline } of analysis.patcher.lines) {
    if (
      patchline.source[0] === "metricEmergency" &&
      patchline.destination[0] === "metricGuardStop"
    )
      assert.equal(patchline.order, 0);
    if (
      patchline.source[0] === "metricEmergency" &&
      patchline.destination[0] === "metricSpectrumGuardStop"
    )
      assert.equal(patchline.order, 1);
  }
});

test("v5 FFT readout carries the actual executed counter around all twenty retained cells", () => {
  const documents = nativeRuntimeDocuments({ nativeVersion: 5 });
  const fft = documents["audio_listener_native_fft.maxpat"];
  const readback = boxes(fft).get("measurementReadback");
  assert.equal(readback.numinlets, 23);
  assert.ok(connected(fft, "energy", 31, "measurementReadback", 0));
  assert.ok(connected(fft, "energy", 31, "measurementReadback", 21));
  assert.ok(connected(fft, "infoOrder", 0, "measurementReadback", 22));
  for (let index = 0; index < 20; index++)
    assert.ok(
      connected(fft, "energy", 11 + index, "measurementReadback", 1 + index),
    );
  const texts = [...boxes(readback).values()].map((box) => box.text || "");
  assert.ok(texts.some((text) => text.includes("spectrum_measurement_frame")));
  assert.ok(
    texts.some(
      (text) => text.includes("mc.snapshot~") && text.includes("@offset 2047"),
    ),
  );
  const code = boxes(documents["audio_listener_native_spectrum.gendsp"]).get(
    "code",
  );
  assert.equal(code.numoutlets, 32);
  const model = genModel(code.code, 32);
  for (const counter of [1048575, 1048576, 1048577])
    assert.equal(
      model.step(
        0,
        0,
        0,
        0,
        0,
        counter % 1048576,
        Math.floor(counter / 1048576),
      )[31],
      counter,
    );
});

test("v5 is explicit and every legacy document remains byte-identical with strict old guards", () => {
  legacyHashes.forEach((expected, i) =>
    assert.equal(
      hash(nativeRuntimeDocuments({ nativeVersion: i + 1 })),
      expected,
    ),
  );
  assert.equal(hash(nativeRuntimeDocuments()), legacyHashes[0]);
  for (const version of [0, 6, "5", null, 2.5])
    assert.throws(
      () => nativeRuntimeDocuments({ nativeVersion: version }),
      /unsupported_native_version/,
    );
  assert.throws(
    () =>
      nativeRuntimeDocuments({
        nativeVersion: 5,
        resourceDirectory: "relative",
      }),
    /must_be_absolute/,
  );
  assert.throws(
    () =>
      appendNativeRuntimeGraph(
        {},
        { nativeVersion: 6, runtimeEntry: "not-ready.js" },
      ),
    /unsupported_native_version/,
  );
});

test("v5 composes its real Node entry without a second client or changed stereo path", () => {
  const { document: authored, node, guard } = authoredParent();
  const original = JSON.stringify(authored);
  const result = appendNativeRuntimeGraph(authored, {
    nativeVersion: 5,
    runtimeEntry: "audio_listener_native_v5_max.js",
  });
  assert.equal(JSON.stringify(authored), original);
  assert.ok(
    !result.patcher.boxes.some(({ box }) =>
      ["threshold", "thresholdMsg", "spacing", "spacingMsg"].includes(box.id),
    ),
  );
  assert.ok(!Object.hasOwn(result.patcher.parameters, "threshold"));
  assert.ok(!Object.hasOwn(result.patcher.parameters, "spacing"));
  const clients = result.patcher.boxes.filter(({ box }) =>
    box.text?.startsWith("node.script "),
  );
  assert.equal(clients.length, 1);
  assert.equal(
    clients[0].box.text,
    "node.script audio_listener_native_v5_max.js @autostart 1 @watch 0",
  );
  assert.equal(
    boxes(result).get(guard.id).text,
    "js audio_listener_guard.js 5",
  );
  for (const { patchline } of authored.patcher.lines) {
    if (
      patchline.source[0] !== node.id &&
      !obsoleteParentIds.has(patchline.source[0]) &&
      !obsoleteParentIds.has(patchline.destination[0])
    ) {
      assert(
        result.patcher.lines.some(
          (line) =>
            JSON.stringify(line.patchline) === JSON.stringify(patchline),
        ),
      );
    }
  }
});

test("v5 preserves retained FFT computation with coherent silence and a counter tap", () => {
  const docs = nativeRuntimeDocuments({ nativeVersion: 5 });
  const old = nativeRuntimeDocuments({ nativeVersion: 4 });
  assert.equal(Object.keys(docs).length, 7);
  assert.equal(
    docs["audio_listener_native_envelope.gendsp"].patcher.boxes.find(
      ({ box }) => box.id === "code",
    ).box.code,
    retainedMusicalEnvelopeSource().code,
  );
  for (const resource of [
    "audio_listener_native_split.gendsp",
    "audio_listener_native_clock.gendsp",
  ])
    assert.deepEqual(docs[resource], old[resource], resource);
  assert.equal(
    boxes(docs["audio_listener_native_spectrum.gendsp"]).get("code").code,
    `${boxes(old["audio_listener_native_spectrum.gendsp"]).get("code").code}\nout23 = out24 == 0 ? 0 : out23;\nout32 = sourceClock;`,
  );
  const clockGraph = docs["audio_listener_native_clock.maxpat"];
  assert.equal(
    boxes(clockGraph).get("collector").text,
    "js audio_listener_native_io.js clock metric-v1",
  );
  assert.equal(
    boxes(docs["audio_listener_native_fft.maxpat"]).get("nativeIO").text,
    "js audio_listener_native_io.js spectrum metric-v1",
  );
  assert(connected(clockGraph, "clock", 1, "clockOutput"));
  assert.equal(boxes(clockGraph).get("clockOutput").text, "out~ 1");
  const graph = docs["audio_listener_native_analysis.maxpat"],
    b = boxes(graph);
  assert.equal(b.get("gen").numinlets, 4);
  assert.equal(b.get("gen").numoutlets, 64);
  assert.equal(
    b.get("collector").text,
    "js audio_listener_metric_io.js musical-v1",
  );
  assert.equal(b.get("collector").numoutlets, 3);
  for (const id of [
    "channels",
    "snapshot",
    "voice",
    "gate",
    "pack",
    "nativeHot",
    "measurementReadback",
    "nativeCommands",
  ])
    assert(!b.has(id), id);
  assert(connected(graph, "clock", 0, "gen", 3));
  assert.equal(b.get("clock").text, "in~ 4");
  assert.equal(
    b.get("metricCommands").text,
    "route metric_envelope metric_spectrum metric_parameter",
  );
  assert(connected(graph, "metricCommands", 0, "collector"));
  assert(connected(graph, "metricCommands", 1, "fft", 4));
  assert(connected(graph, "metricCommands", 2, "nativeControl"));
  assert(connected(graph, "metricCommands", 3, "metricEmergency"));
  assert(connected(graph, "metricEmergency", 0, "metricGuardStop"));
  assert(connected(graph, "metricGuardStop", 0, "collector"));
  assert(connected(graph, "collector", 1, "nativeControl"));
  assert(connected(graph, "nativeControl", 1, "gen"));
  assert(
    !graph.patcher.lines.some(
      ({ patchline: p }) =>
        p.source[0] === "nativeControl" && p.destination[0] === "fft",
    ),
  );
  assert.equal(b.get("pollOrder").text, "trigger b b b b");
  for (const [id, first, width, selector, order] of [
    ["configurationReadback", 8, 12, "metric_configuration_sample", 3],
    ["timingReadback", 0, 8, "metric_timing_sample", 2],
    ["levelReadback", 20, 22, "metric_level_sample", 1],
    ["detectorReadback", 42, 22, "metric_detector_sample", 0],
  ]) {
    const sub = { patcher: b.get(id).patcher },
      s = boxes(sub);
    assert.equal(b.get(id).numinlets, width + 3);
    assert.equal(s.get("channels").text, `mc.pack~ ${width + 2}`);
    assert.equal(s.get("snapshot").text, "mc.snapshot~ @offset 0");
    assert.equal(
      s.get("pack").text,
      `pack ${selector} ${Array(width + 2)
        .fill("0.125")
        .join(" ")}`,
    );
    assert(connected(graph, "clock", 0, id, 0));
    assert(connected(graph, "clock", 0, id, width + 1));
    for (let i = 0; i < width; i++)
      assert(connected(graph, "gen", first + i, id, i + 1));
    assert(connected(graph, "pollOrder", order, id, width + 2));
    assert(connected(graph, id, 0, "collector"));
    assert(connected(sub, "gate", width + 1, "hot"));
    assert(connected(sub, "hot", 1, "pack", width + 2));
    assert(connected(sub, "hot", 0, "pack"));
  }
  assert(connected(graph, "poll", 0, "metricPoll"));
  assert(connected(graph, "metricPoll", 0, "collector"));
  assert(connected(graph, "collector", 2, "metricPollRoute"));
  assert(connected(graph, "metricPollRoute", 0, "pollOrder"));
  assert(connected(graph, "metricPollRoute", 1, "metricSpectrumPoll"));
  assert(connected(graph, "metricSpectrumPoll", 0, "fft", 4));
  assert.equal(b.get("metricSpectrumPoll").text, "qmetro 10 @active 0");
  for (const { patchline: p } of graph.patcher.lines) {
    assert(b.has(p.source[0]), p.source[0]);
    assert(b.has(p.destination[0]), p.destination[0]);
    assert(p.source[1] < b.get(p.source[0]).numoutlets);
    assert(p.destination[1] < b.get(p.destination[0]).numinlets);
  }
  const absolute = nativeRuntimeDocuments({
    nativeVersion: 5,
    resourceDirectory: "/owned/source",
  });
  assert.equal(
    boxes(absolute["audio_listener_native_analysis.maxpat"]).get("collector")
      .text,
    "js /owned/source/audio_listener_metric_io.js musical-v1",
  );
});

test("the v5 clock graph's actual classic-JS constructor loads the current IO", () => {
  const graph = nativeRuntimeDocuments({ nativeVersion: 5 })[
    "audio_listener_native_clock.maxpat"
  ];
  const text = boxes(graph).get("collector").text;
  const context = {
    jsarguments: text.split(" ").slice(1),
    outlet() {},
    post() {},
  };
  vm.runInNewContext(
    readFileSync(
      new URL("./audio_listener_native_io.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  assert.equal(context.nativeIO.mode, "clock");
});

const owner = [
  "generation-1",
  "pass-1",
  "connection-1",
  "trace-1",
  "correlation-1",
  "causation-1",
];
function maxFixture(rate = 48000, options = {}) {
  const docs = nativeRuntimeDocuments({ nativeVersion: 5 });
  const code = docs["audio_listener_native_envelope.gendsp"].patcher.boxes.find(
    ({ box }) => box.id === "code",
  ).box.code;
  const model = genModel(code, 64, rate),
    emitted = [],
    controls = [];
  const clockCode = docs[
    "audio_listener_native_clock.gendsp"
  ].patcher.boxes.find(({ box }) => box.id === "code").box.code;
  const nativeClock = genModel(clockCode, 8, rate);
  let context,
    output,
    counter = 0,
    time = 0,
    pollOverride = null;
  context = vm.createContext({
    jsarguments: ["audio_listener_metric_io.js", "musical-v1"],
    Date: class extends Date {
      static now() {
        return time;
      }
      getTime() {
        return time;
      }
    },
    outlet(index, values) {
      const list = Array.from(values);
      if (index === 0) emitted.push(list);
      if (index === 1) {
        controls.push(list);
        if (list[0] !== "poll") model.configure({ [list[0]]: list[1] });
      }
      if (index === 2) {
        if (list[0] === "spectrum_poll") return;
        assert.deepEqual(list, ["poll_frames"]);
        if (pollOverride) return pollOverride();
        pollFrames();
      }
      if (options.onOutlet) options.onOutlet(index, list, context);
    },
    arrayfromargs: (args) => Array.from(args),
    include(name) {
      assert.equal(name, "audio_listener_measurements.js");
      vm.runInContext(
        readFileSync(new URL(name, import.meta.url), "utf8"),
        context,
      );
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("audio_listener_metric_io.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  function message(selector, ...args) {
    context.messagename = selector;
    return context.anything(...args);
  }
  function step(phase = 0.618, left = 0, right = 0) {
    counter = nativeClock.step()[1];
    output = model.step(phase, left, right, counter);
    return output;
  }
  function pollFrames() {
    for (const [selector, first, width] of [
      ["metric_configuration_sample", 8, 12],
      ["metric_timing_sample", 0, 8],
      ["metric_level_sample", 20, 22],
      ["metric_detector_sample", 42, 22],
    ]) {
      const payload = [counter, ...output.slice(first, first + width), counter];
      if (options.transformFrame) options.transformFrame(selector, payload);
      message(selector, ...payload);
    }
  }
  for (let n = 0; n < 2048; n++) step();
  return {
    context,
    model,
    emitted,
    controls,
    message,
    step,
    pollFrames,
    poll: () => message("metric_poll"),
    get output() {
      return output;
    },
    get counter() {
      return counter;
    },
    setTime(value) {
      time = value;
    },
    overridePoll(fn) {
      pollOverride = fn;
    },
  };
}
function configure(f, rate, tempo = 137, start = 12.125, end = 13.01) {
  const total = Math.round(((end - start) * rate * 60) / tempo);
  const config = [
    rate,
    total,
    Math.round(rate / 10),
    tempo,
    start - Math.floor(start),
    64,
    1,
    start,
    end,
    Math.ceil(end * 4) - Math.floor(start * 4),
  ];
  f.message("begin", ...owner, 1, 100000);
  f.poll();
  f.message("configure_metric", ...owner, ...config);
  f.message("arm", ...owner);
  f.step();
  f.poll();
  return { total, tempo, start, end };
}
function capture(f, g, rate) {
  for (let n = -127; n <= g.total + 70; n++) {
    const phase = n < 64 ? 0.618 : (g.start + (n * g.tempo) / (rate * 60)) % 1;
    f.step(
      phase,
      n >= 0 && n < g.total ? (n % 7 === 0 ? -0.5 : 0.125) : 0,
      n >= 0 && n < g.total ? (n % 11 === 0 ? 0.75 : -0.25) : 0,
    );
    if (n % 16 === 0) f.poll();
  }
  for (let n = 0; n < 10; n++) {
    f.step(0.7);
    f.poll();
  }
}

for (const rate of [44100, 48000]) {
  test(`${rate}: generated Gen -> actual loaded Max selectors -> independent moment readers`, () => {
    const f = maxFixture(rate),
      g = configure(f, rate);
    assert.equal(f.context.inlets, 1);
    assert.equal(f.context.outlets, 3);
    capture(f, g, rate);
    assert(!f.emitted.some((e) => e[0] === "native_metric_record"));
    f.message("stop", ...owner);
    f.step();
    f.poll();
    const bounds = [0];
    for (let q = Math.floor(g.start * 4) + 1; q / 4 < g.end; q++)
      bounds.push(Math.round(((q / 4 - g.start) * rate * 60) / g.tempo));
    bounds.push(g.total);
    const detector = [0];
    for (
      let end = Math.round(rate / 10);
      end < g.total;
      end += Math.round(rate / 10)
    )
      detector.push(end);
    detector.push(g.total);
    for (const [family, edges] of [
      ["level", bounds],
      ["detector-level", detector],
    ]) {
      for (let i = 0; i < edges.length - 1; i++) {
        f.message("metric_record", ...owner, family, i + 1);
        const packet = JSON.parse(f.emitted.at(-1)[1]),
          record = packet.record;
        assert.equal(record.startSample, edges[i]);
        assert.equal(record.endSample, edges[i + 1]);
        assert.equal(packet.owner.traceId, owner[3]);
        let l = 0,
          r = 0;
        for (let n = edges[i]; n < edges[i + 1]; n++) {
          l += (n % 7 === 0 ? -0.5 : 0.125) ** 2;
          r += (n % 11 === 0 ? 0.75 : -0.25) ** 2;
        }
        assert.deepEqual(record.sumSquares, [l, r]);
      }
    }
    f.message("release", ...owner);
    assert(f.controls.some((c) => c[0] === "poll" && c[1] === 0));
  });
}

test("family statistics failure in real selectors stays local and preserves independent detector data", () => {
  const f = maxFixture(48000, {
    transformFrame(selector, values) {
      if (selector === "metric_level_sample" && values[5] > 0) values[17] = -1;
    },
  });
  const g = configure(f, 48000);
  capture(f, g, 48000);
  f.message("stop", ...owner);
  f.step();
  f.poll();
  f.message("metric_status", ...owner);
  const status = JSON.parse(f.emitted.at(-1)[1]);
  assert.equal(status.state, "completed");
  assert.equal(status.families.level.state, "failed");
  assert.equal(status.families["detector-level"].state, "completed");
  assert(
    !f.controls.some(
      (c) => c[0] === "levelMeasurementAcknowledged" && c[1] > 0,
    ),
  );
  f.message("metric_record", ...owner, "detector-level", 1);
  assert.equal(f.emitted.at(-1)[0], "native_metric_record");
});

test("actual Max startup is opt-in; scope, reentrancy, fixed deadline and deletion remain guarded", () => {
  const text = readFileSync(
    new URL("audio_listener_metric_io.js", import.meta.url),
    "utf8",
  );
  for (const args of [
    ["audio_listener_metric_io.js"],
    ["audio_listener_metric_io.js", "wrong"],
  ]) {
    const scope = vm.createContext({
      jsarguments: args,
      outlet() {},
      include() {},
      AudioListenerMeasurements: {},
    });
    assert.throws(
      () => vm.runInContext(text, scope),
      /unsupported_metric_io_mode/,
    );
  }
  const f = maxFixture();
  f.message("begin", ...owner, 1, 100000);
  assert.throws(
    () => f.message("configure_metric", ...owner, ...Array(10).fill(0)),
    /executed_idle/,
  );
  f.poll();
  f.message("metric_spectrum_poll", ...owner, 1);
  const before = f.controls.length;
  f.message("arm", "stale-generation", ...owner.slice(1));
  assert.equal(f.controls.length, before);
  f.overridePoll(() => f.message("metric_poll"));
  f.step();
  f.poll();
  f.message("metric_status", ...owner);
  assert.equal(JSON.parse(f.emitted.at(-1)[1]).state, "failed");
  f.setTime(100001);
  f.message("callerTick", ...owner);
  f.message("metric_status", ...owner);
  assert.equal(JSON.parse(f.emitted.at(-1)[1]).cleanup, "failed");
  f.context.notifydeleted();
  assert.deepEqual(f.controls.at(-1), ["poll", 0]);
});

test("one numeric callback per family per scheduler cohort: duplicate data cannot short-circuit settling", () => {
  const f = maxFixture(),
    g = configure(f, 48000);
  let first = false,
    before;
  f.overridePoll(() => {
    f.message(
      "metric_configuration_sample",
      f.counter,
      ...f.output.slice(8, 20),
      f.counter,
    );
    f.message(
      "metric_timing_sample",
      f.counter,
      ...f.output.slice(0, 8),
      f.counter,
    );
    if (!first && f.output[24] === 1) {
      first = true;
      before = f.controls.filter(
        (c) => c[0] === "levelMeasurementAcknowledged" && c[1] === 1,
      ).length;
      const args = [f.counter, ...f.output.slice(20, 42), f.counter];
      f.message("metric_level_sample", ...args);
      f.message("metric_level_sample", ...args);
      assert.equal(
        f.controls.filter(
          (c) => c[0] === "levelMeasurementAcknowledged" && c[1] === 1,
        ).length,
        before,
      );
    } else {
      f.message(
        "metric_level_sample",
        f.counter,
        ...f.output.slice(20, 42),
        f.counter,
      );
    }
    f.message(
      "metric_detector_sample",
      f.counter,
      ...f.output.slice(42, 64),
      f.counter,
    );
  });
  capture(f, g, 48000);
  assert(first);
  assert.equal(
    f.controls.filter(
      (c) => c[0] === "levelMeasurementAcknowledged" && c[1] === 1,
    ).length,
    1,
  );
});
test("numeric snapshots discard advancing bookends without fabricating proof", () => {
  const f = maxFixture();
  configure(f, 48000);
  f.message("metric_timing_sample", 0, ...Array(8).fill(0), 0);
  f.overridePoll(() => {
    f.message(
      "metric_configuration_sample",
      f.counter,
      ...f.output.slice(8, 20),
      f.counter + 1,
    );
  });
  f.step();
  f.poll();
  const events = f.emitted
    .filter((e) => e[0] === "native_metric")
    .map((e) => JSON.parse(e[1]));
  assert(
    events.some(
      (e) =>
        e.family === "control" &&
        e.stage === "progress" &&
        e.reason === "readback_cohort_skipped",
    ),
  );
  assert(!events.some((e) => e.stage === "failed"));
  assert(!f.emitted.some((e) => /READY|nativeProof/.test(JSON.stringify(e))));
});

test("cancellation with stale callbacks never exposes records; cleanup requires a fresh native sample", () => {
  const f = maxFixture();
  configure(f, 48000);
  f.message("cancel", ...owner);
  f.poll();
  f.message("metric_status", ...owner);
  assert.equal(JSON.parse(f.emitted.at(-1)[1]).cleanup, "started");
  f.step();
  f.poll();
  f.message("metric_status", ...owner);
  assert.equal(JSON.parse(f.emitted.at(-1)[1]).cleanup, "completed");
  assert.throws(
    () => f.message("metric_record", ...owner, "level", 1),
    /unavailable/,
  );
  f.message("release", ...owner);
  const next = ["generation-2", ...owner.slice(1)];
  assert.throws(() => f.message("begin", ...next, 1, 100000), /native_epoch/);
  f.message("begin", ...next, 2, 100000);
  f.overridePoll(() =>
    f.message(
      "metric_timing_sample",
      f.counter - 1,
      ...f.output.slice(0, 8),
      f.counter - 1,
    ),
  );
  f.poll();
  f.message("metric_status", ...next);
  assert.equal(JSON.parse(f.emitted.at(-1)[1]).idleConfirmed, false);
});

test("reentrant cancellation from admitted-reader progress withholds ACK and all staged record reads", () => {
  let cancelled = false;
  const f = maxFixture(48000, {
    onOutlet(index, values, context) {
      if (index !== 0 || values[0] !== "native_metric") return;
      const event = JSON.parse(values[1]);
      if (
        !cancelled &&
        event.family === "level" &&
        event.stage === "progress" &&
        event.progress?.accepted === 1
      ) {
        cancelled = true;
        context.messagename = "cancel";
        context.anything(...owner);
      }
    },
  });
  const g = configure(f, 48000);
  capture(f, g, 48000);
  assert(cancelled);
  assert(
    !f.controls.some(
      (c) => c[0] === "levelMeasurementAcknowledged" && c[1] > 0,
    ),
  );
  assert.throws(
    () => f.message("metric_record", ...owner, "level", 1),
    /unavailable/,
  );
  f.message("metric_status", ...owner);
  assert.equal(JSON.parse(f.emitted.at(-1)[1]).state, "cancelled");
});
