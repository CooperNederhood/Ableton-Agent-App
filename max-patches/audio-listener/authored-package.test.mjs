/* global structuredClone, AbortSignal, AbortController, console */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sourceDocuments } from "./native-source.mjs";
import {
  build,
  main,
  checkArtifact,
  prepareAuthoredDevice,
  SOURCE_DIRECTORY,
  ALL_RESOURCES,
  NATIVE_CANDIDATE_RESOURCES,
} from "../../scripts/audio-listener-device.mjs";
import { decodeAmxd, encodeAmxd } from "../../scripts/max-device-publisher.mjs";
import { nativeRuntimeDocuments } from "./native-runtime-source.mjs";

function fixture() {
  const d = sourceDocuments()["Audio-Listener.maxpat"];
  const names = {
    analysis: "ml_analysis",
    node: "ml_runtime",
    guard: "ml_guard",
    identity: "ml_identity",
  };
  for (const { box } of d.patcher.boxes) {
    if (names[box.id]) {
      box.varname = names[box.id];
      box.text = box.text.replace(
        /((?:audio_listener|producer_identity)[\w.]+)/,
        "/Users/test/copilot-worktrees/development/$1",
      );
    }
  }
  d.patcher.rect = [0, 0, 1200, 1000];
  d.patcher.boxes.push(
    {
      box: {
        id: "panel",
        maxclass: "comment",
        varname: "ml_panel_title",
        text: "Machine Listening",
        presentation: 1,
        presentation_rect: [12, 16, 200, 24],
        patching_rect: [30, 900, 200, 24],
      },
    },
    { box: { id: "mcp", maxclass: "newobj", text: "mcp_bridge" } },
    {
      box: {
        id: "path",
        varname: "ml_resource_path",
        text: "filepath search 0",
      },
    },
    {
      box: {
        id: "append",
        varname: "ml_add_resource_path",
        text: "append /Users/test/copilot-worktrees/development 0",
      },
    },
  );
  d.patcher.lines.push({
    patchline: { source: ["append", 0], destination: ["path", 0] },
  });
  d.patcher.dependency_cache = [
    { name: "audio_listener_runtime.js", bootpath: "/Users/test/development" },
  ];
  return d;
}

test("explicit v2 candidate packages the matching bootstrap, generated ABI and honest descriptive limits", async (t) => {
  const dir = await mkdtemp(
    join(SOURCE_DIRECTORY, ".native-v2-authored-test-"),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(SOURCE_DIRECTORY, "Machine-Listening-Development.amxd");
  const before = await readFile(source);
  const out = join(dir, "candidate");
  const events = [];
  const manifest = await build(out, {
    authoredDevicePath: source,
    nativeMode: true,
    nativeVersion: 2,
    traceId: "v2-package-trace",
    correlationId: "v2-package-correlation",
    causationId: "v2-package-cause",
    onEvent: (event) => events.push(event),
  });
  assert.equal(manifest.nativeVersion, 2);
  assert.equal(manifest.nativeScope, "arrangement-descriptive/v2");
  assert.equal(manifest.algorithmVersion, "2.0.0");
  assert.equal(manifest.observationSchema, "audio-observation/v2");
  assert.equal(manifest.realLiveValidated, false);
  assert.deepEqual(manifest.providerLimits, {
    durationMs: 30000,
    maxWindows: 300,
    envelopeUpdatesPerSecond: 10,
  });
  assert.equal(manifest.planningCeilings.watchdogMs, 60000);
  assert.equal(manifest.tempoPolicy, "constant-tempo-assumed");
  assert.equal(manifest.tempoAutomationSupported, false);
  const generated = nativeRuntimeDocuments({ nativeVersion: 2 });
  assert.deepEqual(
    manifest.resources.map(({ name }) => name),
    [
      ...ALL_RESOURCES,
      "audio_listener_native_v2_max.js",
      "audio_listener_native_io.js",
      ...Object.keys(generated),
    ],
  );
  for (const [name, expected] of Object.entries(generated)) {
    assert.deepEqual(
      JSON.parse(await readFile(join(out, name), "utf8")),
      expected,
    );
  }
  const { document } = decodeAmxd(
    await readFile(join(out, manifest.deviceFile)),
  );
  assert.equal(
    document.patcher.boxes.find(({ box }) => box.varname === "ml_runtime").box
      .text,
    "node.script audio_listener_native_v2_max.js @autostart 1 @watch 0",
  );
  assert.equal(
    document.patcher.boxes.filter(({ box }) =>
      box.text?.startsWith("node.script "),
    ).length,
    1,
  );
  assert.ok(
    document.patcher.boxes.some(({ box }) => box.varname === "ml_panel_title"),
  );
  assert.doesNotMatch(
    JSON.stringify(document),
    /mcp_bridge|\/Users\/|copilot-worktrees/,
  );
  assert.deepEqual(await readFile(source), before);
  assert.equal((await checkArtifact(out)).nativeVersion, 2);
  assert.equal(events[0].stage, "queued");
  assert.equal(events.at(-1).stage, "completed");
  for (const event of events.filter(
    ({ operation }) => operation === "m4l.audio-listener.package",
  )) {
    assert.equal(event.traceId, "v2-package-trace");
    assert.equal(event.correlationId, "v2-package-correlation");
    assert.equal(event.causationId, "v2-package-cause");
    assert.ok(event.durationMs >= 0);
  }
  for (const change of [
    { nativeVersion: 1 },
    { nativeScope: "arrangement-beat0-120bpm-48000hz-vector64/v1" },
    { algorithmVersion: "1.0.1" },
    { observationSchema: "audio-observation/v1" },
    { providerLimits: { ...manifest.providerLimits, maxWindows: 100 } },
    { tempoAutomationSupported: true },
  ]) {
    await writeFile(
      join(out, "audio-listener-manifest.json"),
      JSON.stringify({ ...manifest, ...change }),
    );
    await assert.rejects(checkArtifact(out), /manifest|limit mismatch/);
  }
});

test("native packaging rejects an implicit or unknown v2 selection before publication", async (t) => {
  const dir = await mkdtemp(join(SOURCE_DIRECTORY, ".native-selection-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(SOURCE_DIRECTORY, "Machine-Listening-Development.amxd");
  for (const [index, options] of [
    { nativeVersion: 2 },
    { nativeMode: false, nativeVersion: 2 },
    { nativeMode: true, nativeVersion: 0 },
    { nativeMode: true, nativeVersion: 3 },
    { nativeMode: true, nativeVersion: "2" },
  ].entries()) {
    const events = [];
    await assert.rejects(
      build(join(dir, `invalid-${index}`), {
        authoredDevicePath: source,
        ...options,
        onEvent: (event) => events.push(event),
      }),
      /native version/,
    );
    assert.equal(events.at(-1).stage, "failed");
  }
  const cancelled = [];
  await assert.rejects(
    build(join(dir, "cancelled"), {
      authoredDevicePath: source,
      nativeMode: true,
      nativeVersion: 2,
      signal: AbortSignal.abort(),
      onEvent: (event) => cancelled.push(event),
    }),
    /cancelled/,
  );
  assert.equal(cancelled.at(-1).stage, "cancelled");
});

test("the explicit native v2 CLI stages rather than installs or promotes", async (t) => {
  const dir = await mkdtemp(join(SOURCE_DIRECTORY, ".native-v2-cli-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(SOURCE_DIRECTORY, "Machine-Listening-Development.amxd");
  const out = join(dir, "candidate");
  t.mock.method(console, "log", () => {});
  await main(["build-native-v2-authored", "--source", source, "--out", out]);
  const manifest = await checkArtifact(out);
  assert.equal(manifest.nativeVersion, 2);
  assert.equal(manifest.realLiveValidated, false);
  assert.equal(manifest.portable, true);
  assert.equal(manifest.externalAuthoringBridge, false);
});

test("native candidate stages the authored UI and one SDK client with hashed relative native resources", async (t) => {
  const dir = await mkdtemp(join(SOURCE_DIRECTORY, ".native-authored-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(SOURCE_DIRECTORY, "Machine-Listening-Development.amxd");
  const before = await readFile(source);
  const out = join(dir, "candidate");
  const events = [];
  const manifest = await build(out, {
    authoredDevicePath: source,
    nativeMode: true,
    traceId: "native-package",
    onEvent: (event) => events.push(event),
  });
  assert.equal(manifest.nativeMode, true);
  assert.equal(manifest.nativeVersion, undefined);
  assert.equal(manifest.observationSchema, "audio-observation/v1");
  assert.equal(
    manifest.nativeScope,
    "arrangement-beat0-120bpm-48000hz-vector64/v1",
  );
  assert.equal(manifest.realLiveValidated, false);
  assert.equal(manifest.providerLimits.durationMs, 10000);
  assert.equal(manifest.providerLimits.maxWindows, 100);
  assert.equal(manifest.planningCeilings.watchdogMs, 30000);
  assert.equal(manifest.portable, true);
  assert.deepEqual(
    manifest.resources.map(({ name }) => name),
    [...ALL_RESOURCES, ...NATIVE_CANDIDATE_RESOURCES],
  );
  assert.equal((await checkArtifact(out)).nativeMode, true);
  const { document } = decodeAmxd(
    await readFile(join(out, manifest.deviceFile)),
  );
  const runtime = document.patcher.boxes.find(
    ({ box }) => box.varname === "ml_runtime",
  ).box;
  assert.equal(
    runtime.text,
    "node.script audio_listener_native_max.js @autostart 1 @watch 0",
  );
  assert.equal(
    document.patcher.boxes.filter(({ box }) =>
      box.text?.startsWith("node.script "),
    ).length,
    1,
  );
  assert.ok(
    document.patcher.boxes.some(({ box }) => box.varname === "ml_panel_title"),
  );
  assert.doesNotMatch(
    JSON.stringify(document),
    /mcp_bridge|\/Users\/|copilot-worktrees/,
  );
  assert.match(
    await readFile(join(out, "audio_listener_native_max.js"), "utf8"),
    /nativeMode: true/,
  );
  assert.deepEqual(await readFile(source), before);
  assert.equal(events[0].stage, "queued");
  assert.equal(events.at(-1).stage, "completed");
  await assert.rejects(
    build(join(dir, "no-source"), { nativeMode: true }),
    /explicit authored source/,
  );
  await writeFile(join(out, "audio_listener_native_clock.gendsp"), "tampered");
  await assert.rejects(checkArtifact(out), /resource hash mismatch/);
});

test("checkpointed authored development device preserves both presentation comments and relative listener references", async () => {
  const raw = await readFile(
    join(SOURCE_DIRECTORY, "Machine-Listening-Development.amxd"),
  );
  const { document } = decodeAmxd(raw);
  const refreshed = structuredClone(document);
  refreshed.patcher.boxes.find(
    ({ box }) => box.varname === "ml_identity",
  ).box.text = "js producer_identity_common.js watch";
  assert.deepEqual(
    prepareAuthoredDevice(document, { keepMcpBridge: true }),
    refreshed,
  );
  for (const name of ["ml_panel_title", "ml_panel_note"]) {
    const matches = document.patcher.boxes.filter(
      ({ box }) => box.varname === name,
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].box.presentation, 1);
  }
  assert.ok(JSON.stringify(document).includes("mcp_bridge"));
  assert.ok(
    !JSON.stringify(prepareAuthoredDevice(document)).includes("mcp_bridge"),
  );
});

test("authored packaging preserves presentation, layout, unrelated boxes and cords while relinking owned resources", () => {
  const original = fixture(),
    snapshot = structuredClone(original);
  const d = prepareAuthoredDevice(original, { keepMcpBridge: true });
  assert.deepEqual(original, snapshot);
  assert.deepEqual(
    d.patcher.boxes.find(({ box }) => box.id === "panel"),
    original.patcher.boxes.find(({ box }) => box.id === "panel"),
  );
  assert.deepEqual(d.patcher.lines, original.patcher.lines.slice(0, -1));
  assert.equal(d.patcher.dependency_cache, undefined);
  assert.ok(d.patcher.boxes.some(({ box }) => box.text === "mcp_bridge"));
  assert.ok(!JSON.stringify(d).includes("/Users/"));
  assert.equal(
    d.patcher.boxes.find(({ box }) => box.varname === "ml_runtime").box.text,
    "node.script audio_listener_max.js @autostart 1 @watch 0",
  );
  assert.ok(
    !d.patcher.boxes.some(
      ({ box }) => box.id === "path" || box.id === "append",
    ),
  );
  assert.ok(
    !JSON.stringify(prepareAuthoredDevice(original)).includes("mcp_bridge"),
  );
});

test("missing/duplicate owned boxes, foreign absolute references, wrong types and broken stereo are denied", () => {
  for (const mutate of [
    (d) => {
      d.patcher.boxes = d.patcher.boxes.filter(
        ({ box }) => box.varname !== "ml_runtime",
      );
    },
    (d) => {
      d.patcher.boxes.push(
        structuredClone(
          d.patcher.boxes.find(({ box }) => box.varname === "ml_runtime"),
        ),
      );
    },
    (d) => {
      d.patcher.boxes.find(({ box }) => box.id === "panel").box.text =
        "/Users/other/private";
    },
    (d) => {
      d.patcher.boxes.find(({ box }) => box.varname === "ml_runtime").box.text =
        "js foreign.js";
    },
    (d) => {
      d.patcher.lines = d.patcher.lines.filter(
        ({ patchline }) =>
          !(
            patchline.source[0] === "input" &&
            patchline.destination[0] === "output"
          ),
      );
    },
    (d) => {
      d.patcher.lines[0].patchline.destination[0] = "missing";
    },
  ]) {
    const d = fixture();
    mutate(d);
    assert.throws(() => prepareAuthoredDevice(d, { keepMcpBridge: true }));
  }
});

test("older authored devices acquire native preview routing without replacing their layout or unrelated wiring", () => {
  const original = fixture();
  const helperIds = new Set([
    "ml_device_preview",
    "ml_adapter_init",
    "ml_device_state_query",
    "ml_device_preview_latch",
  ]);
  original.patcher.boxes = original.patcher.boxes.filter(
    ({ box }) => !helperIds.has(box.id),
  );
  original.patcher.lines = original.patcher.lines.filter(
    ({ patchline }) =>
      !helperIds.has(patchline.source[0]) &&
      !helperIds.has(patchline.destination[0]),
  );
  original.patcher.lines.push({
    patchline: { source: ["nodeMessages", 0], destination: ["init", 0] },
  });
  const snapshot = structuredClone(original);
  const result = prepareAuthoredDevice(original, { keepMcpBridge: true });
  assert.deepEqual(original, snapshot);
  assert.deepEqual(
    prepareAuthoredDevice(result, { keepMcpBridge: true }),
    result,
  );
  for (const { box } of original.patcher.boxes) {
    if (
      [
        "ml_analysis",
        "ml_runtime",
        "ml_guard",
        "ml_identity",
        "ml_resource_path",
        "ml_add_resource_path",
      ].includes(box.varname)
    )
      continue;
    assert.deepEqual(
      result.patcher.boxes.find((b) => b.box.id === box.id)?.box,
      box,
    );
  }
  for (const line of original.patcher.lines) {
    if (
      line.patchline.source[0] === "append" ||
      line.patchline.source[0] === "nodeMessages"
    )
      continue;
    assert.ok(
      result.patcher.lines.some(
        (l) => JSON.stringify(l) === JSON.stringify(line),
      ),
    );
  }
  assert.deepEqual(
    result.patcher.boxes
      .filter(({ box }) => helperIds.has(box.id))
      .map(({ box }) => box.text),
    ["prepend device-preview", "trigger b b b", "getstate", "int -1"],
  );
  assert.ok(
    result.patcher.lines.some(
      ({ patchline }) =>
        patchline.source[0] === "init" &&
        patchline.source[1] === 2 &&
        patchline.destination[0] === "ml_device_preview",
    ),
  );
});

test("complete older preview routing is upgraded idempotently without treating enabled state as preview", () => {
  const original = fixture();
  const p = original.patcher;
  p.boxes = p.boxes.filter(({ box }) => box.id !== "ml_device_preview_latch");
  const trigger = p.boxes.find(({ box }) => box.id === "ml_adapter_init").box;
  trigger.text = "trigger b b";
  trigger.numoutlets = 2;
  p.lines = p.lines.filter(
    ({ patchline: l }) =>
      l.source[0] !== "ml_device_preview_latch" &&
      l.destination[0] !== "ml_device_preview_latch",
  );
  p.lines.find(
    ({ patchline: l }) =>
      l.source[0] === "ml_adapter_init" &&
      l.destination[0] === "ml_device_state_query",
  ).patchline.source[1] = 1;
  const snapshot = structuredClone(original);
  const result = prepareAuthoredDevice(original, { keepMcpBridge: true });
  assert.deepEqual(original, snapshot);
  assert.deepEqual(
    prepareAuthoredDevice(result, { keepMcpBridge: true }),
    result,
  );
  assert.equal(
    result.patcher.boxes.find(({ box }) => box.id === "ml_device_preview_latch")
      .box.text,
    "int -1",
  );
});

test("partial, conflicting or damaged preview routing and ambiguous startup objects are rejected", () => {
  for (const mutate of [
    (d) => {
      d.patcher.boxes = d.patcher.boxes.filter(
        ({ box }) => box.id !== "ml_device_preview",
      );
    },
    (d) => {
      d.patcher.boxes.find(
        ({ box }) => box.id === "ml_device_state_query",
      ).box.text = "bang";
    },
    (d) => {
      d.patcher.lines = d.patcher.lines.filter(
        ({ patchline }) =>
          !(
            patchline.source[0] === "ml_adapter_init" &&
            patchline.source[1] === 1
          ),
      );
    },
    (d) => {
      d.patcher.lines.push({
        patchline: { source: ["nodeMessages", 0], destination: ["init", 0] },
      });
    },
    (d) => {
      const b = structuredClone(
        d.patcher.boxes.find(({ box }) => box.id === "init"),
      );
      b.box.id = "second-init";
      d.patcher.boxes.push(b);
    },
  ]) {
    const d = fixture();
    mutate(d);
    assert.throws(() => prepareAuthoredDevice(d, { keepMcpBridge: true }));
  }
});

test("existing canonical v1 artifact manifests remain readable without new authored-package fields", async (t) => {
  const dir = await mkdtemp(join(SOURCE_DIRECTORY, ".legacy-artifact-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = await build(dir);
  delete manifest.authored;
  delete manifest.externalAuthoringBridge;
  delete manifest.listenerResourcesPortable;
  await writeFile(
    join(dir, "audio-listener-manifest.json"),
    JSON.stringify(manifest),
  );
  assert.equal((await checkArtifact(dir)).deviceFile, "Audio-Listener.amxd");
});

test("authored bundle stages adjacent resources, guards original file, hashes every file and propagates lifecycle", async (t) => {
  const dir = await mkdtemp(join(SOURCE_DIRECTORY, ".authored-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "Machine-Listening.amxd"),
    out = join(dir, "packaged");
  const template = decodeAmxd(
    await readFile(join(SOURCE_DIRECTORY, "audio-effect-template.amxd")),
  );
  const raw = encodeAmxd(template, fixture());
  await writeFile(source, raw);
  const events = [];
  const manifest = await build(out, {
    authoredDevicePath: source,
    keepMcpBridge: true,
    onEvent: (event) => events.push(event),
    traceId: "trace",
    correlationId: "correlation",
    causationId: "cause",
  });
  assert.equal(manifest.deviceFile, "Machine-Listening.amxd");
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.externalAuthoringBridge, true);
  assert.equal(manifest.portable, false);
  assert.equal(manifest.listenerResourcesPortable, true);
  assert.equal(manifest.realLiveValidated, false);
  assert.deepEqual(
    manifest.resources.map((r) => r.name),
    ALL_RESOURCES,
  );
  assert.deepEqual(await readFile(source), raw);
  await checkArtifact(out);
  const production = await build(join(dir, "production"), {
    authoredDevicePath: source,
  });
  assert.equal(production.portable, true);
  assert.equal(production.externalAuthoringBridge, false);
  assert.ok(
    !JSON.stringify(
      decodeAmxd(await readFile(join(dir, "production", production.deviceFile)))
        .document,
    ).includes("mcp_bridge"),
  );
  await checkArtifact(join(dir, "production"));
  await writeFile(
    join(out, "audio-listener-manifest.json"),
    JSON.stringify({
      ...manifest,
      portable: true,
    }),
  );
  await assert.rejects(() => checkArtifact(out), /invalid resource manifest/);
  await writeFile(
    join(out, "audio-listener-manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(
    () => build(out, { authoredDevicePath: source }),
    /must be empty/,
  );
  await checkArtifact(out);
  assert.deepEqual(
    events
      .filter((e) => e.operation === "m4l.audio-listener.package")
      .map((e) => e.stage),
    ["queued", "started", "completed"],
  );
  assert.ok(events.some((e) => e.stage === "progress"));
  assert.ok(
    events.every(
      (e) =>
        e.traceId === "trace" &&
        e.correlationId === "correlation" &&
        e.causationId === "cause" &&
        e.durationMs >= 0,
    ),
  );
  await assert.rejects(
    () => build(dir, { authoredDevicePath: source }),
    /must not overwrite/,
  );
  assert.deepEqual(await readFile(source), raw);
  const cancelled = [];
  await assert.rejects(
    () =>
      build(join(dir, "cancelled"), {
        authoredDevicePath: source,
        signal: AbortSignal.abort(),
        onEvent: (e) => cancelled.push(e),
      }),
    { name: "AbortError" },
  );
  assert.deepEqual(
    cancelled.map((e) => e.stage),
    ["queued", "started", "cancelled"],
  );
  assert.equal(cancelled.at(-1).errorCode, "cancelled");
  const controller = new AbortController();
  const lateEvents = [],
    lateOut = join(dir, "late-cancelled");
  await assert.rejects(
    () =>
      build(lateOut, {
        authoredDevicePath: source,
        signal: controller.signal,
        onEvent: (e) => {
          lateEvents.push(e);
          if (
            e.operation === "m4l.resources.publish" &&
            e.stage === "completed"
          )
            controller.abort();
        },
      }),
    { name: "AbortError" },
  );
  assert.equal(lateEvents.at(-1).stage, "cancelled");
  await assert.rejects(
    () => readFile(join(lateOut, "Machine-Listening.amxd")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    () => readFile(join(lateOut, "audio-listener-manifest.json")),
    { code: "ENOENT" },
  );
  assert.deepEqual(await readFile(source), raw);
  const failed = [];
  await assert.rejects(() =>
    build(join(dir, "failed"), {
      authoredDevicePath: join(dir, "missing.amxd"),
      onEvent: (e) => failed.push(e),
    }),
  );
  assert.deepEqual(
    failed.map((e) => e.stage),
    ["queued", "started", "failed"],
  );
  assert.equal(failed.at(-1).errorCode, "listener-package-failed");
  await writeFile(join(out, "audio_listener_max.js"), "tampered");
  await assert.rejects(() => checkArtifact(out), /hash mismatch/);
});
