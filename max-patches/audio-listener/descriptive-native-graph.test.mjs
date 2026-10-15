import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendNativeRuntimeGraph,
  nativeRuntimeDocuments,
} from "./native-runtime-source.mjs";
import { sourceDocuments } from "./native-source.mjs";
import { genModel } from "./gen-model.mjs";
import { descriptiveEnvelopeCode } from "./synchronized-envelope-source.mjs";
import { descriptiveSpectrumCode } from "./synchronized-spectrum-source.mjs";
import { fftReference } from "./fft-reference.mjs";

const { NativeDescriptorAssembler } = createRequire(import.meta.url)(
  "./audio_listener_native_assembler.js",
);
const { NativeMessageIO } = createRequire(import.meta.url)(
  "./audio_listener_native_io.js",
);

// Executable GenExpr subset, NOT a Max compiler, host phase trace, DSP vector
// latency test or physical qualification. No IO/controller is enabled here.
const code = (document) => document.patcher.boxes[0].box.code;
const config = (rate = 48000, patch = {}) => ({
  totalSamples: rate / 10,
  hopSamples: rate / 10,
  tempoBpm: 93,
  startBeatFraction: 0.375,
  captureVector: 64,
  ...patch,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

// Structural guard for the emitted GenExpr subset, NOT a native compiler.
// Unlike the numeric model, Max rejects declarations after expressions.
function assertDeclarationsBeforeExpressions(source, label) {
  const stripped = source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (/^["']/.test(token) ? '""' : " "),
  );
  const body = stripped.replace(
    /^(?:\s*(?:Param|History|Buffer|Data|Delay)\s+\w+\s*\([^;]*\)\s*;)*/,
    "",
  );
  assert.doesNotMatch(
    body,
    /\b(?:Param|History|Buffer|Data|Delay)\s+\w+\s*\(/,
    `${label}: declarations must come before any expressions`,
  );
}

test("declaration-order guard rejects late declarations, including same-line composition", () => {
  for (const kind of ["Param", "History", "Buffer", "Data", "Delay"]) {
    assertDeclarationsBeforeExpressions(`${kind} state(0); out1 = 2;`, kind);
    for (const separator of [" ", "\n"]) {
      assert.throws(
        () =>
          assertDeclarationsBeforeExpressions(
            `out1 = 2;${separator}${kind} state(0);`,
            kind,
          ),
        /declarations must come before any expressions/,
      );
    }
  }
  assertDeclarationsBeforeExpressions(
    `// Header expression = 1;
History state(0); Buffer source("audio; // not a comment");
/* History ignored(0); */ out1 = state; // Delay ignored(64);`,
    "comments and quoted buffer name",
  );
});

test("all actual emitted v2 codeboxes put declarations before expressions", () => {
  const checked = [];
  const visit = (patcher, path) => {
    for (const { box } of patcher.boxes) {
      const label = `${path}/${box.id}`;
      if (box.maxclass === "codebox") {
        assertDeclarationsBeforeExpressions(box.code, label);
        checked.push(label);
      }
      if (box.patcher) visit(box.patcher, label);
    }
  };
  for (const [name, document] of Object.entries(
    nativeRuntimeDocuments({
      nativeVersion: 2,
      resourceDirectory: "/owned/descriptive",
    }),
  ))
    visit(document.patcher, name);
  for (const resource of ["clock", "envelope", "spectrum", "split"])
    assert.ok(
      checked.includes(`audio_listener_native_${resource}.gendsp/code`),
    );
});

test("v2 auxiliary configuration metadata snapshots the same capture Gen through envelope-owned IO only", () => {
  const documents = nativeRuntimeDocuments({ nativeVersion: 2 });
  for (const [resource, id, mode] of [
    ["clock", "collector", "clock"],
    ["analysis", "collector", "envelope"],
    ["fft", "nativeIO", "spectrum"],
  ]) {
    const selected = documents[
      `audio_listener_native_${resource}.maxpat`
    ].patcher.boxes.find(({ box }) => box.id === id).box;
    assert.equal(selected.text, `js audio_listener_native_io.js ${mode} 2`);
    const legacy = nativeRuntimeDocuments()[
      `audio_listener_native_${resource}.maxpat`
    ].patcher.boxes.find(({ box }) => box.id === id).box;
    assert.equal(legacy.text, `js audio_listener_native_io.js ${mode}`);
  }
  const graph = documents["audio_listener_native_analysis.maxpat"].patcher;
  const objects = new Map(graph.boxes.map(({ box }) => [box.id, box]));
  assert.equal(objects.get("gen").numoutlets, 23);
  assert.equal(objects.get("channels").numinlets, 16);
  assert.equal(objects.get("pack").numinlets, 17);
  assert.equal(objects.get("configurationMessages").text, "out 2");
  const has = (lines, source, outlet, destination, inlet = 0) =>
    lines.some(
      ({ patchline: p }) =>
        p.source[0] === source &&
        p.source[1] === outlet &&
        p.destination[0] === destination &&
        p.destination[1] === inlet,
    );
  for (let index = 0; index < 7; index++)
    assert.ok(
      has(graph.lines, "gen", 16 + index, "configurationReadback", index),
    );
  assert.ok(has(graph.lines, "pollOrder", 2, "fft", 4));
  assert.ok(has(graph.lines, "pollOrder", 1, "configurationReadback", 7));
  assert.ok(has(graph.lines, "pollOrder", 0, "snapshot"));
  assert.ok(
    has(graph.lines, "configurationReadback", 0, "configurationMessages"),
  );
  assert.equal(
    graph.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "configurationReadback" &&
        patchline.destination[0] === "collector",
    ),
    true,
  );
  assert.ok(has(graph.lines, "collector", 0, "nativeMessages"));
  assert.ok(has(graph.lines, "descriptiveConfig", 7, "nativeCommands"));
  assert.ok(has(graph.lines, "nativeCommands", 0, "collector"));
  assert.equal(
    graph.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "configurationReadback" &&
        !["collector", "configurationMessages"].includes(
          patchline.destination[0],
        ),
    ),
    false,
  );
  assert.equal(
    graph.lines.find(
      ({ patchline }) =>
        patchline.source[0] === "configurationReadback" &&
        patchline.destination[0] === "collector",
    ).patchline.order,
    0,
  );
  const subpatch = objects.get("configurationReadback").patcher;
  const packed = subpatch.boxes.find(({ box }) => box.id === "pack").box;
  assert.equal(
    packed.text,
    `pack configuration_frame ${Array(7).fill("0.125").join(" ")}`,
  );
  assert.equal(packed.numinlets, 8);
  assert.ok(has(subpatch.lines, "hot", 1, "pack", 7));
  assert.ok(has(subpatch.lines, "hot", 0, "pack"));
  const gen = documents["audio_listener_native_envelope.gendsp"];
  assert.equal(gen.patcher.boxes[0].box.numoutlets, 23);
  assert.ok(
    gen.patcher.boxes
      .filter(({ box }) => box.id.startsWith("out"))
      .every(({ box }) => box.patching_rect[1] + box.patching_rect[3] <= 380),
  );
});

test("root v2 composition is explicit, leaves raw metadata unbroadcast and preserves exact v1 bytes", () => {
  const authored = sourceDocuments()["Audio-Listener.maxpat"];
  authored.patcher.boxes.find(({ box }) =>
    box.text?.startsWith("node.script "),
  ).box.varname = "ml_runtime";
  authored.patcher.boxes.find(
    ({ box }) => box.text === "js audio_listener_guard.js",
  ).box.varname = "ml_guard";
  const original = JSON.stringify(authored);
  const options = { runtimeEntry: "audio_listener_native_max.js" };
  const legacy = appendNativeRuntimeGraph(authored, options);
  assert.equal(
    createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
    "a08db5d0ac32702856db0e9026bc9e4bd20baf0cafa24f781609561b9b1debe6",
  );
  assert.deepEqual(
    appendNativeRuntimeGraph(authored, { ...options, nativeVersion: 1 }),
    legacy,
  );
  const selected = appendNativeRuntimeGraph(authored, {
    nativeVersion: 2,
    runtimeEntry: "audio_listener_native_v2_max.js",
  });
  const analysis = selected.patcher.boxes.find(
    ({ box }) => box.id === "scoped-native-analysis",
  ).box;
  assert.equal(analysis.numoutlets, 3);
  assert.equal(
    selected.patcher.boxes.find(({ box }) => box.varname === "ml_guard").box
      .text,
    "js audio_listener_guard.js 2",
  );
  assert.equal(
    legacy.patcher.boxes.find(({ box }) => box.varname === "ml_guard").box.text,
    "js audio_listener_guard.js",
  );
  assert.equal(
    analysis.text,
    "poly~ audio_listener_native_analysis.maxpat 1 @parallel 0",
  );
  assert.equal(
    selected.patcher.lines.some(
      ({ patchline }) =>
        patchline.source[0] === analysis.id && patchline.source[1] === 2,
    ),
    false,
  );
  assert.equal(JSON.stringify(authored), original);
  assert.deepEqual(
    selected.patcher.lines.filter(
      ({ patchline }) =>
        !["scoped-native-control"].includes(patchline.source[0]),
    ),
    legacy.patcher.lines.filter(
      ({ patchline }) =>
        !["scoped-native-control"].includes(patchline.source[0]),
    ),
  );
  for (const nativeVersion of [0, 3, "2"])
    assert.throws(
      () => appendNativeRuntimeGraph(authored, { ...options, nativeVersion }),
      /unsupported_native_version/,
    );
});

test("generated DSP receipt traverses existing owned IO; setters never arm-proof or confirm stop", () => {
  const text = code(
    nativeRuntimeDocuments({ nativeVersion: 2 })[
      "audio_listener_native_envelope.gendsp"
    ],
  );
  function fixture() {
    const gen = genModel(text, 23);
    const packets = [],
      controls = [],
      diagnostics = [];
    let counter = 0;
    const step = () => gen.step(0.75, 0.2, -0.2, counter++);
    for (let i = 0; i < 2048; i++) step();
    const io = new NativeMessageIO(
      "envelope",
      (packet) => packets.push(packet),
      (control) => {
        controls.push(control);
        if (control[0] !== "poll") gen.configure({ [control[0]]: control[1] });
      },
      (reason) => diagnostics.push(reason),
      2,
    );
    return { io, packets, controls, diagnostics, step };
  }
  const generation = "11111111-1111-4111-8111-111111111111";
  const start = (f) => {
    assert.equal(f.io.begin(generation), true);
    assert.equal(
      f.io.configureV2(generation, [4800, 4800, 93, 0.375, 64]),
      true,
    );
    assert.equal(f.io.arm(generation, 7), true);
    assert.deepEqual(f.packets, []); // No DSP evaluation/readback yet.
    const row = f.step();
    assert.equal(f.io.configurationFrame(row.slice(16)), true);
    assert.equal(f.io.envelope(row.slice(0, 16)), true);
    assert.deepEqual(
      f.packets.find((packet) => packet[2] === "config"),
      ["native", generation, "config", 7, 4800, 4800, 93, 0.375, 64, 7],
    );
  };
  const confirmed = fixture();
  start(confirmed);
  assert.equal(confirmed.io.stop(generation), true);
  assert.equal(confirmed.io.generation, generation);
  assert.equal(
    confirmed.packets.some((packet) => packet[2] === "stopped"),
    false,
  );
  const disabled = confirmed.step();
  assert.equal(disabled[0], 0);
  assert.equal(disabled[5], 0);
  assert.equal(confirmed.io.envelope(disabled.slice(0, 16)), true);
  assert.deepEqual(confirmed.packets.at(-1), [
    "native",
    generation,
    "stopped",
    0,
    0,
    2,
  ]);
  assert.equal(confirmed.io.generation, null);
  const unconfirmed = fixture();
  start(unconfirmed);
  unconfirmed.io.stop(generation);
  assert.equal(
    unconfirmed.io.release("22222222-2222-4222-8222-222222222222"),
    false,
  );
  assert.equal(unconfirmed.io.generation, generation);
  assert.equal(unconfirmed.io.release(generation), true);
  assert.equal(unconfirmed.io.generation, null);
  assert.equal(
    unconfirmed.packets.some((packet) => packet[2] === "stopped"),
    false,
  );
  assert.ok(unconfirmed.diagnostics.includes("native_io_disarm_unconfirmed"));
  assert.equal(unconfirmed.io.envelope(unconfirmed.step().slice(0, 16)), false);
});

test("configuration readback is latched only on native epoch evaluation, revoked on change and zero disarm", () => {
  const text = code(
    nativeRuntimeDocuments({ nativeVersion: 2 })[
      "audio_listener_native_envelope.gendsp"
    ],
  );
  const model = genModel(text, 23);
  let counter = 0;
  const step = () => model.step(0.75, 0.2, -0.2, counter++);
  for (let i = 0; i < 2048; i++) step();
  model.configure(config());
  assert.deepEqual(step().slice(16), [0, 0, 0, 0, 0, 0, 0]);
  model.configure({ epoch: 7 });
  const sealed = step();
  assert.deepEqual(sealed.slice(16), [7, 4800, 4800, 93, 0.375, 64, 7]);
  assert.equal(sealed[0], 7);
  assert.equal(sealed[4], 0);
  assert.equal(sealed[12], 0);
  model.configure({ totalSamples: 4801 });
  const changed = step();
  assert.equal(changed[4], 13);
  assert.deepEqual(changed.slice(16), [7, 4800, 4800, 93, 0.375, 64, 0]);
  model.configure({ epoch: 0 });
  const stopped = step();
  assert.equal(stopped[0], 0);
  assert.equal(stopped[5], 0);
  assert.equal(stopped[22], 0);
  model.configure({ epoch: 7 });
  assert.equal(step()[5], 0);
  model.configure({ epoch: 8 });
  assert.deepEqual(step().slice(16), [8, 4801, 4800, 93, 0.375, 64, 8]);
  const invalid = genModel(text, 23);
  for (let i = 0; i < 2048; i++) invalid.step(0.75, 0, 0, i);
  invalid.configure({ epoch: 1 });
  const rejected = invalid.step(0.75, 0, 0, 2048);
  assert.equal(rejected[4], 13);
  assert.equal(rejected[22], 0);
});

function fixture({
  rate = 48000,
  patch = {},
  source = (i) => [0.35 + 0.2 * Math.sin(i / 19), -0.4],
  text = descriptiveEnvelopeCode(),
  nativeStart = 1048500,
  originClock = null,
} = {}) {
  const settings = config(rate, patch);
  const model = genModel(text, 16, rate);
  let counter = nativeStart;
  let output;
  const step = (phase = 0.75) => {
    const [left, right] = source(counter);
    output = model.step(phase, left, right, counter++);
    return output;
  };
  for (let i = 0; i < 2048; i++) step();
  model.configure({ ...settings, epoch: 1 });
  const armCounter = counter;
  step();
  const origin = originClock ?? settings.captureVector * 2 + 17;
  const offset = settings.captureVector;
  const launch = origin + offset;
  const beatSamples = (rate * 60) / settings.tempoBpm;
  const phase = (clock) =>
    (settings.startBeatFraction + (clock - origin) / beatSamples) % 1;
  const frames = [];
  let completed = 0;
  function advance(clock) {
    const row = step(clock < launch ? 0.75 : phase(clock));
    if (row[12] > completed) {
      frames.push([...row]);
      completed = row[12];
    }
    return row;
  }
  return {
    model,
    settings,
    armCounter,
    origin,
    launch,
    frames,
    source,
    step,
    advance,
    get output() {
      return output;
    },
    run() {
      for (
        let clock = 1;
        clock <
        origin +
          settings.captureVector +
          Math.ceil(settings.totalSamples / settings.hopSamples) *
            settings.hopSamples +
          2;
        clock++
      )
        advance(clock);
      return output;
    },
  };
}

function coverage(f) {
  const final = f.run();
  assert.equal(final[4], 0, `native failure ${final[4]}`);
  assert.equal(final[5], 0);
  assert.equal(final[12], f.settings.totalSamples);
  assert.equal(final[13], f.armCounter);
  assert.equal(final[14], f.armCounter + f.origin);
  assert.equal(final[15], 2);
  assert.equal(final[2], -1); // No first-nonzero authority.
  assert.equal(final[3], 0); // No onset-count admission.
  assert.equal(final[7], -1);
  assert.equal(
    f.frames.length,
    Math.ceil(f.settings.totalSamples / f.settings.hopSamples),
  );
  assert.ok(f.frames.length <= 300);
  let previous = 0;
  for (const row of f.frames) {
    const end = row[12];
    const length = end - previous;
    assert.equal(
      length,
      Math.min(f.settings.hopSamples, f.settings.totalSamples - previous),
    );
    const sums = [0, 0],
      peaks = [0, 0];
    for (let i = previous; i < end; i++) {
      const values = f.source(f.armCounter + f.origin + i);
      for (let channel = 0; channel < 2; channel++) {
        sums[channel] += values[channel] ** 2;
        peaks[channel] = Math.max(peaks[channel], Math.abs(values[channel]));
      }
    }
    close(row[8], peaks[0]);
    close(row[9], peaks[1]);
    close(row[10], Math.sqrt(sums[0] / length));
    close(row[11], Math.sqrt(sums[1] / length));
    close(
      Math.sqrt((row[10] ** 2 + row[11] ** 2) / 2),
      Math.sqrt((sums[0] + sums[1]) / (2 * length)),
    );
    previous = end;
  }
}

test("descriptive v2 is explicitly selected; default and explicit v1 retain the pre-change byte hash", () => {
  const original = JSON.stringify(nativeRuntimeDocuments());
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "d102081c366e48f040661f4d08d0ae8c597f8549ee0493a341c3f0fd2fe4473e",
  );
  assert.equal(
    JSON.stringify(nativeRuntimeDocuments({ nativeVersion: 1 })),
    original,
  );
  for (const nativeVersion of [0, 3, "2", null])
    assert.throws(
      () => nativeRuntimeDocuments({ nativeVersion }),
      /unsupported_native_version/,
    );
  const documents = nativeRuntimeDocuments({
    nativeVersion: 2,
    resourceDirectory: "/owned/descriptive",
  });
  assert.equal(Object.keys(documents).length, 7);
  for (const [resource, marker] of [
    ["clock", "out8 = 2"],
    ["envelope", "out16 = 2"],
    ["spectrum", "out11 = 2"],
  ])
    assert.ok(
      code(documents[`audio_listener_native_${resource}.gendsp`]).includes(
        marker,
      ),
    );
  assert.deepEqual(
    documents["audio_listener_native_split.gendsp"],
    nativeRuntimeDocuments()["audio_listener_native_split.gendsp"],
  );
  for (const [resource, target] of [
    ["clock", "clock"],
    ["analysis", "gen"],
  ]) {
    const graph = documents[`audio_listener_native_${resource}.maxpat`].patcher;
    for (const selector of Object.keys(config()).concat(["epoch", "cancel"])) {
      assert.ok(
        graph.boxes.some(({ box }) => box.text === `prepend ${selector}`),
      );
      assert.ok(
        graph.lines.some(
          ({ patchline }) =>
            patchline.source[0] === `descriptive-${selector}` &&
            patchline.destination[0] === target,
        ),
      );
    }
    assert.ok(
      graph.lines.some(
        ({ patchline }) =>
          patchline.source[0] === "command" &&
          patchline.destination[0] === "descriptiveConfig",
      ),
    );
  }
  // Resource selection never touches the authored plugin~ -> plugout~ graph.
  assert.equal(JSON.stringify(nativeRuntimeDocuments()), original);
  assert.match(
    JSON.stringify(documents["audio_listener_native_analysis.maxpat"]),
    /2048 1 0 1 @float32 0/,
  );
});

test("v2 exact 100ms, 30s and one-sample tail coverage at both rates, nonquiet and silence", () => {
  for (const rate of [44100, 48000])
    for (const totalSamples of [
      rate / 10,
      30 * rate,
      rate / 10 + 1,
      30 * rate - rate / 10 + 1,
    ])
      for (const source of [undefined, () => [0, 0]])
        coverage(fixture({ rate, patch: { totalSamples }, source }));
});

test("every power-of-two retained vector through 1024 keeps the first source vector and fractional wrap", () => {
  for (const captureVector of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024])
    for (const rate of [44100, 48000])
      for (const tempoBpm of [20, 93, 999])
        coverage(
          fixture({
            rate,
            patch: {
              captureVector,
              tempoBpm,
              startBeatFraction: 0.9999,
              totalSamples: rate / 10 + 1,
            },
            source: (i) => [i % 7 === 0 ? 0.9 : 0.2, i % 2 ? -0.5 : 0.5],
          }),
        );
});

test("legacy calibration graphs cannot pass the new nonquiet/silent rate and exact-tail regressions", () => {
  const legacy = code(
    nativeRuntimeDocuments()["audio_listener_native_envelope.gendsp"],
  );
  for (const options of [
    { rate: 44100, source: () => [0, 0] },
    { rate: 48000, source: () => [0.5, -0.5] },
    { rate: 48000, source: () => [0, 0], patch: { totalSamples: 4801 } },
  ]) {
    assert.throws(() => coverage(fixture({ ...options, text: legacy })));
    coverage(fixture(options));
  }
});

test("zero/unsupported/malformed configuration remains blocked before arm", () => {
  const initial = genModel(descriptiveEnvelopeCode(), 16);
  for (let i = 0; i < 1200; i++) assert.equal(initial.step(0.5, 0, 0, i)[5], 0);
  for (const patch of [
    { totalSamples: 0 },
    { totalSamples: 4799 },
    { totalSamples: 1440001 },
    { totalSamples: 4800.5 },
    { totalSamples: NaN },
    { hopSamples: 4801 },
    { hopSamples: Infinity },
    { tempoBpm: 19 },
    { tempoBpm: 1000 },
    { tempoBpm: NaN },
    { startBeatFraction: -0.01 },
    { startBeatFraction: 1 },
    { startBeatFraction: NaN },
    { captureVector: 0 },
    { captureVector: 63 },
    { captureVector: 64.5 },
    { captureVector: 2048 },
    { captureVector: Infinity },
  ]) {
    const f = fixture({ patch });
    assert.equal(f.output[4], 13, JSON.stringify(patch));
    assert.equal(f.output[5], 0);
    assert.equal(f.output[12], 0);
  }
  const unsupported = fixture({ rate: 96000 });
  assert.equal(unsupported.output[4], 13);
});

test("configuration changes while armed or active fail without retuning, even if restored", () => {
  for (const active of [false, true])
    for (const patch of [
      { totalSamples: 4801 },
      { hopSamples: 4410 },
      { tempoBpm: 94 },
      { startBeatFraction: 0.5 },
      { captureVector: 128 },
    ]) {
      const f = fixture();
      let clock = 1;
      if (active) for (; clock <= f.launch; clock++) f.advance(clock);
      f.model.configure(patch);
      assert.equal(f.advance(clock++)[4], 13);
      f.model.configure(f.settings);
      assert.equal(f.advance(clock)[4], 13);
      assert.equal(f.output[5], 0);
    }
});

test("configuration seal lasts for the whole epoch, including completed and cancelled passes", () => {
  for (const completed of [false, true]) {
    for (const patch of [
      { totalSamples: 4801 },
      { hopSamples: 4410 },
      { tempoBpm: 94 },
      { startBeatFraction: 0.5 },
      { captureVector: 128 },
      { captureVector: 0 },
    ]) {
      const f = fixture();
      if (completed) f.run();
      else {
        f.model.configure({ cancel: 1 });
        assert.equal(f.advance(1)[4], 4);
      }
      const count = f.output[12];
      f.model.configure(patch);
      assert.equal(f.step()[4], 13);
      f.model.configure({ ...f.settings, cancel: 0 });
      assert.equal(f.step()[4], 13);
      assert.equal(f.output[12], count);
      assert.equal(f.output[5], 0);

      // A disabled interval permits installing the next configuration; an old
      // epoch still cannot re-arm it. A newer epoch must validate and seal anew.
      f.model.configure({ epoch: 0, totalSamples: 4801 });
      for (let i = 0; i < 128; i++) f.step();
      f.model.configure({ epoch: 1 });
      assert.equal(f.step()[5], 0);
      assert.equal(f.output[12], count);
      f.model.configure({ epoch: 2 });
      const next = f.step();
      assert.equal(next[0], 2);
      assert.equal(next[4], 0);
      assert.equal(next[12], 0);
      assert.ok(next[13] > f.armCounter);
    }
  }
});

test("zero-epoch disarm matches the native IO contract without lowering the epoch high-water mark", () => {
  const f = fixture();
  f.model.configure({ cancel: 1, epoch: 0 });
  const disabled = f.step();
  assert.equal(disabled[0], 0);
  assert.equal(disabled[5], 0);
  assert.equal(disabled[15], 2);
  // Old/new owners see an inactive zero epoch, but cannot reuse the last epoch.
  f.model.configure({ cancel: 0, epoch: 1 });
  for (let i = 0; i < 128; i++) {
    const stale = f.step();
    assert.equal(stale[0], 1);
    assert.equal(stale[5], 0);
    assert.equal(stale[12], 0);
  }
  f.model.configure({ epoch: 2 });
  const fresh = f.step();
  assert.equal(fresh[0], 2);
  assert.equal(fresh[4], 0);
  assert.equal(fresh[12], 0);
  assert.ok(fresh[13] > f.armCounter);
});

test("epoch/counter regressions, queued zero, bounds and moving arm cannot resurrect or relabel a pass", () => {
  for (const epoch of [-1, 0.5, 17592186044416, NaN, Infinity]) {
    const f = fixture();
    f.model.configure({ epoch });
    assert.equal(f.advance(1)[5], 0);
    assert.equal(f.output[4], 6);
  }
  const queued = fixture();
  queued.model.configure({ epoch: 0 });
  queued.advance(1);
  queued.model.configure({ epoch: 1 });
  assert.equal(queued.advance(2)[5], 0);
  assert.equal(queued.output[12], 0);
  const replaced = fixture();
  replaced.model.configure({ epoch: 2 });
  assert.equal(replaced.advance(1)[4], 6);
  assert.equal(replaced.output[5], 0);
  for (const counter of [-1, 0.5, NaN, Infinity, 17592186044416, 0]) {
    const f = fixture();
    assert.equal(f.model.step(0.75, 0, 0, counter)[4], 12);
  }
  const nearLimit = fixture({ nativeStart: 17592186044416 - 2049 });
  assert.equal(nearLimit.output[4], 12);
  const largeEpoch = fixture();
  largeEpoch.model.configure({ cancel: 1 });
  largeEpoch.advance(1);
  largeEpoch.model.configure({ epoch: 17592186044415, cancel: 0 });
  assert.equal(largeEpoch.advance(2)[0], 17592186044415);
  assert.equal(largeEpoch.output[4], 0);
  const moving = genModel(descriptiveEnvelopeCode(), 16);
  moving.configure(config());
  for (let i = 0; i < 2048; i++) moving.step((i / 24000) % 1, 0.2, 0, i);
  moving.configure({ epoch: 1 });
  assert.equal(moving.step(2048 / 24000, 0.2, 0, 2048)[4], 1);
  const reset = fixture();
  reset.model.reset();
  // The subset's reset() resets histories/delays only. Explicitly model the
  // parameter defaults that a real Gen reset also restores.
  reset.model.configure({
    totalSamples: 0,
    hopSamples: 0,
    tempoBpm: 0,
    captureVector: 0,
    epoch: 1,
  });
  assert.equal(reset.step()[4], 13); // Reset clears configuration, not an implicit re-arm.
});

test("v2 clock stays monotonic across requests, stale/zero epochs and split-counter rollover", () => {
  const text = code(
    nativeRuntimeDocuments({ nativeVersion: 2 })[
      "audio_listener_native_clock.gendsp"
    ],
  );
  const model = genModel(text, 8);
  model.configure(config());
  for (let clock = 0; clock <= 1048577; clock++) {
    if (clock === 3) model.configure({ epoch: 7 });
    if (clock === 10) model.configure({ epoch: 0 });
    if (clock === 11) model.configure({ epoch: 6 });
    if (clock === 12) model.configure({ epoch: 8 });
    const row = model.step();
    assert.equal(row[1], clock);
    assert.equal(row[2] * 64 + row[3], clock);
    assert.equal(row[7], 2);
    if (clock >= 3 && clock < 12) assert.equal(row[4], 7);
    if (clock >= 12) assert.equal(row[4], 8);
  }
  // Test-only near-limit initialization: no million-year DSP simulation.
  const nearLimit = genModel(
    text.replace("History clock(0)", "History clock(17592186044415)"),
    8,
  );
  nearLimit.configure({ ...config(), epoch: 1 });
  assert.equal(nearLimit.step()[1], 17592186044415);
  const bounded = nearLimit.step();
  assert.equal(bounded[1], 17592186044416);
  assert.equal(bounded[6], 0);
  assert.equal(nearLimit.step()[1], bounded[1]);
});

test("missed launch, pre-roll underrun, invalid phase, incoherent motion and stopped transport fail closed", () => {
  const missed = fixture();
  assert.equal(missed.step(0.6)[4], 9);
  const early = fixture();
  const beatSamples = (48000 * 60) / 93;
  assert.equal(early.step(0.375 + 64 / beatSamples)[4], 9);
  const unprimed = genModel(descriptiveEnvelopeCode(), 16);
  unprimed.configure({ ...config(), epoch: 1 });
  assert.notEqual(unprimed.step(0, 0, 0, 0)[4], 0);
  for (const phase of [-0.1, 1, NaN, Infinity]) {
    const f = fixture();
    assert.equal(f.step(phase)[4], 14);
  }
  const jump = fixture();
  for (let i = 1; i <= jump.launch; i++) jump.advance(i);
  assert.equal(jump.step(0.9)[4], 14);
  const stopped = fixture();
  for (let i = 1; i <= stopped.launch; i++) stopped.advance(i);
  const heldPhase = 0.375 + 64 / beatSamples;
  for (let i = 0; i < 64; i++) stopped.step(heldPhase);
  assert.equal(stopped.output[4], 3);
});

test("ten-second arm deadline is distinct from thirty-second capture; cancel/watchdog is terminal", () => {
  for (const rate of [44100, 48000]) {
    const f = fixture({ rate });
    for (let i = 1; i <= 10 * rate; i++) f.step();
    assert.equal(f.output[4], 2);
    assert.equal(f.output[12], 0);
    coverage(
      fixture({
        rate,
        patch: { totalSamples: 30 * rate },
        originClock: 9 * rate + 17,
      }),
    );
  }
  for (const active of [false, true]) {
    const f = fixture();
    if (active) for (let i = 1; i <= f.launch; i++) f.advance(i);
    // The eventual watchdog uses this existing cancel parameter.
    f.model.configure({ cancel: 1 });
    assert.equal(f.step()[4], 4);
    const completed = f.output[12];
    f.model.configure({ cancel: 0 });
    for (let i = 0; i < 100; i++) f.step();
    assert.equal(f.output[5], 0);
    assert.equal(f.output[12], completed);
  }
});

test("retention, denominator and contiguous-count mutations are caught by exact numeric coverage", () => {
  for (const text of [
    descriptiveEnvelopeCode().replace("preL.read(retention)", "preL.read(1)"),
    descriptiveEnvelopeCode().replaceAll(
      "sqrt(sumL / n)",
      "sqrt(sumL / passHop)",
    ),
    descriptiveEnvelopeCode().replace(
      "completed = completed + n",
      "completed = completed + passHop",
    ),
  ]) {
    assert.notEqual(text, descriptiveEnvelopeCode());
    assert.throws(() =>
      coverage(fixture({ text, patch: { totalSamples: 4801 } })),
    );
  }
  const nonfinite = fixture({ source: () => [NaN, 0] });
  assert.equal(nonfinite.run()[4], 15);
  assert.equal(nonfinite.output[12], 0);
});

test("10ms polling observes the full hop and retained one-sample tail at every polling offset", () => {
  for (const rate of [44100, 48000]) {
    const pollSamples = rate / 100;
    function polls(f) {
      const observed = Array.from({ length: pollSamples }, () => []);
      const publishedAt = Array.from({ length: pollSamples }, () => []);
      const previous = new Float64Array(pollSamples);
      for (
        let clock = 1;
        clock < f.origin + 64 + (2 * rate) / 10 + 2 + pollSamples;
        clock++
      ) {
        const row = f.advance(clock);
        const offset = clock % pollSamples;
        if (row[12] > previous[offset]) {
          observed[offset].push(row[12]);
          publishedAt[offset].push(clock);
          previous[offset] = row[12];
        }
      }
      return { observed, publishedAt };
    }
    const f = fixture({
      rate,
      patch: { totalSamples: rate / 10 + 1 },
    });

    const { observed, publishedAt } = polls(f);
    for (let offset = 0; offset < pollSamples; offset++) {
      assert.deepEqual(observed[offset], [rate / 10, rate / 10 + 1]);
      assert.ok(
        publishedAt[offset][1] - publishedAt[offset][0] >=
          rate / 10 - pollSamples,
      );
    }
    assert.equal(f.output[4], 0);
    assert.equal(f.output[5], 0);
    // Removing the cadence hold makes ordinary polling lose the full-hop row.
    const immediate = fixture({
      rate,
      patch: { totalSamples: rate / 10 + 1 },
      text: descriptiveEnvelopeCode().replace(
        "clock - publishClock >= passHop",
        "clock - publishClock >= 0",
      ),
    });
    const missed = polls(immediate).observed.filter((rows) => rows.length < 2);
    assert.equal(missed.length, pollSamples - 1);
  }
});

test("cancellation and a newer idle request cannot publish a stale retained terminal row", () => {
  const f = fixture({ patch: { totalSamples: 4801 } });
  const captureEnd = f.origin + 64 + 4801;
  for (let clock = 1; clock < captureEnd; clock++) f.advance(clock);
  assert.equal(f.output[12], 4800);
  assert.equal(f.output[5], 1); // Exact tail captured, pending its reporting cadence.
  f.model.configure({ cancel: 1 });
  assert.equal(f.advance(captureEnd)[4], 4);
  f.model.configure({ cancel: 0 });
  for (let clock = captureEnd + 1; clock < captureEnd + 5000; clock++)
    f.advance(clock);
  assert.equal(f.output[12], 4800);
  assert.equal(f.output[5], 0);
  for (let i = 0; i < 128; i++) f.step();
  f.model.configure({ epoch: 2, totalSamples: 4800 });
  const row = f.step();
  assert.equal(row[0], 2);
  assert.equal(row[4], 0);
  assert.equal(row[12], 0);
  assert.ok(row[13] > f.armCounter);
  assert.equal(row[14], -1);
});

test("v2 modeled rows fit explicit assembler geometry/coordinates and reuse an honest FFT for a one-sample silent tail", () => {
  for (const rate of [44100, 48000]) {
    const f = fixture({
      rate,
      patch: { totalSamples: rate / 10 + 1 },
      source: () => [0, 0],
    });
    coverage(f);
    const owner = {
      passId: "graph-only-v2",
      connectionEpoch: "offline",
      nativeEpoch: 1,
    };
    const frames = [];
    const originCounter = f.output[14];
    const assembler = new NativeDescriptorAssembler({
      owner,
      armCounter: f.armCounter,
      originCounter,
      hostOffsetSamples: 0,
      geometry: {
        sampleRate: rate,
        hopSamples: rate / 10,
        totalSamples: rate / 10 + 1,
      },
      coordinates: { startBeat: 8.375, tempoBpm: 93 },
      invalidFrames: 0,
      onFrame: (frame) => {
        frames.push(frame);
        return true;
      },
      onFailure: (reason) => assert.fail(reason),
    });
    const end = originCounter + 4096;
    assembler.pushSpectrum([end, 0, 0, end - 2048, end, 0], owner);
    for (const row of f.frames) {
      assembler.pushEnvelope(
        {
          nativeEpoch: row[0],
          armCounter: row[13],
          originCounter: row[14],
          endCounter: row[14] + row[12],
          peak: row.slice(8, 10),
          rms: row.slice(10, 12),
        },
        owner,
      );
    }
    assert.equal(assembler.state, "covered");
    assert.deepEqual(
      frames.map((frame) => frame.windowSamples),
      [rate / 10, 1],
    );
    // Raw descriptor remains numeric; the existing engine's zero-energy
    // boundary, not this DSP/assembler ABI, converts its centroid to null.
    assert.equal(frames[1].centroidHz, 0);
    assert.equal(frames[1].spectralEnergy, 0);
    assert.deepEqual(frames[1].spectralWindow, frames[0].spectralWindow);
    assert.equal(frames[1].spectralWindow.endSample, end);
    close(frames[1].beat, 8.375 + ((rate / 10 + 1) * 93) / (rate * 60));
  }
});

function spectral(rate, left, right, mutate = () => {}) {
  const gen = genModel(`${descriptiveSpectrumCode()}\nout11 = 2;`, 11, rate);
  const l = fftReference(left),
    r = fftReference(right);
  let out;
  for (let bin = 0; bin < 2048; bin++) {
    const counter = 1048500 + bin;
    const inputs = [
      l.real[bin],
      l.imag[bin],
      r.real[bin],
      r.imag[bin],
      bin,
      counter % 1048576,
      Math.floor(counter / 1048576),
    ];
    mutate(inputs, bin);
    out = gen.step(...inputs);
  }
  return out;
}

test("v2 stereo FFT is finite, Nyquist/rate aware, silence-zero and counter-tagged independently of final tails", () => {
  const zero = Array(2048).fill(0);
  for (const rate of [44100, 48000]) {
    const silent = spectral(rate, zero, zero);
    assert.deepEqual(silent.slice(0, 5), [0, 0, 1048500, 1050548, 0]);
    assert.equal(silent[10], 2); // Existing zero-energy consumer retains null centroid.
    const wave = Array.from({ length: 2048 }, (_, i) =>
      Math.sin((2 * Math.PI * 32 * i) / 2048),
    );
    const mono = spectral(rate, wave, zero);
    const anti = spectral(
      rate,
      wave,
      wave.map((x) => -x),
    );
    close(anti[0], (32 * rate) / 2048);
    close(anti[1], 2 * mono[1]);
    assert.equal(anti[3] - anti[2], 2048);
    const nyquist = spectral(
      rate,
      Array.from({ length: 2048 }, (_, i) => (i % 2 ? -1 : 1)),
      zero,
    );
    close(nyquist[0], rate / 2);
  }
  for (const mutate of [
    (inputs, bin) => {
      if (bin === 10) inputs[0] = NaN;
    },
    (inputs, bin) => {
      if (bin === 10) inputs[1] = Infinity;
    },
    (inputs, bin) => {
      if (bin === 10) inputs[5] += 1;
    },
    (inputs, bin) => {
      if (bin === 10) inputs[6] = 0.5;
    },
    (inputs, bin) => {
      if (bin === 10) inputs[4] = 11;
    },
  ]) {
    const out = spectral(48000, zero, zero, mutate);
    assert.equal(out[2], -1);
    assert.equal(out[4], 1);
  }
});

test("v2 FFT rejects cross-frame native regression, skipped frames and out-of-bound split counters", () => {
  for (const nextStart of [0, 2048, 4097, 17592186044416 - 2047]) {
    const gen = genModel(descriptiveSpectrumCode(), 10);
    let out;
    const frame = (start) => {
      for (let bin = 0; bin < 2048; bin++) {
        const counter = start + bin;
        out = gen.step(
          0,
          0,
          0,
          0,
          bin,
          counter % 1048576,
          Math.floor(counter / 1048576),
        );
      }
    };
    frame(2048);
    assert.equal(out[2], 2048);
    assert.equal(out[3], 4096);
    frame(nextStart);
    assert.equal(out[4], 1);
    assert.equal(out[2], 2048); // Invalid frames never replace the last valid interval.
    assert.equal(out[3], 4096);
  }
});
