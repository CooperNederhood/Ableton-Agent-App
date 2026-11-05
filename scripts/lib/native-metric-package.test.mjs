/* global AbortController */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeRuntimeDocuments } from "../../max-patches/audio-listener/native-runtime-source.mjs";
import {
  build,
  checkArtifact,
  DEVICE_FILE_NAME,
  generatedListeningParent,
  main,
  SOURCE_DIRECTORY,
} from "../audio-listener-device.mjs";
import { decodeAmxd, encodeAmxd } from "../max-device-publisher.mjs";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";
import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import { FLUCOMA_DEPENDENCY_FILES } from "../../packages/shared/dist/flucoma-dependency.js";
import { bindAmxdDependencyPaths } from "../../packages/shared/dist/max-device.js";

const directories = [];
const fixture = {
  engineeringOnly: true,
  engineeringFixture: "native5-unavailable-spectrum/v1",
};
const fixtureEntry = "audio_listener_native_v5_unavailable_spectrum_max.js";
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function packageHarness() {
  const parent = resolve(".test-artifacts/independent-metric-listening");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "package5-"));
  directories.push(root);
  const template = decodeAmxd(
    await readFile(join(SOURCE_DIRECTORY, "audio-effect-template.amxd")),
  );
  const document = generatedListeningParent();
  const source = join(root, "Owned-Metric-Listener.amxd");
  await writeFile(source, encodeAmxd(template, document));
  const lifecycle = createNativeRunnerLifecycle({
    telemetry: { enqueue() {} },
    sanitize: sanitizeTelemetryAttributes,
    trace: {
      traceId: "00000000-0000-4000-8000-000000000001",
      correlationId: "metric-package",
      causationId: "caller",
    },
  });
  const output = join(root, "output");
  return { root, source, output, lifecycle };
}

it("checks destination-bound unfrozen devices against source pins and their actual final directory", async () => {
  const { root, output, lifecycle } = await packageHarness();
  const manifest = await build(output, { stage: lifecycle.stage });
  const destination = join(root, "bound");
  await cp(output, destination, { recursive: true });
  const original = await readFile(join(output, manifest.deviceFile));
  const resources = new Map(
    await Promise.all(
      manifest.resources.map(async ({ name }) => [
        name,
        await readFile(join(output, name)),
      ]),
    ),
  );
  const bound = bindAmxdDependencyPaths(original, resources, {
    deviceDirectory: destination,
  });
  await writeFile(join(destination, manifest.deviceFile), bound);
  const derived = {
    ...manifest,
    deviceSha256: hash(bound),
    dependencyBinding: {
      schema: "flucoma-device-path-binding/v1",
      sourceDeviceSha256: manifest.deviceSha256,
    },
  };
  await writeFile(
    join(destination, "audio-listener-manifest.json"),
    JSON.stringify(derived),
  );
  await expect(checkArtifact(destination)).resolves.toMatchObject({
    deviceSha256: hash(bound),
    dependencyBinding: derived.dependencyBinding,
  });
  expect(await readFile(join(output, manifest.deviceFile))).toEqual(original);
  const changed = decodeAmxd(bound);
  changed.document.patcher.project.searchpath["0"].bootpath = join(
    root,
    "wrong/dependencies/flucoma",
  );
  const wrong = encodeAmxd(changed, changed.document);
  await writeFile(join(destination, manifest.deviceFile), wrong);
  await writeFile(
    join(destination, "audio-listener-manifest.json"),
    JSON.stringify({
      ...derived,
      deviceSha256: hash(wrong),
    }),
  );
  await expect(checkArtifact(destination)).rejects.toThrow(
    "generated listening graph mismatch",
  );
});

it("pins packaged FluCoMa resources independently of editable artifact hashes", async () => {
  const { root, output, lifecycle } = await packageHarness();
  const manifest = await build(output, { stage: lifecycle.stage });
  for (const name of [
    "audio_listener_flatness_smoke.js",
    "audio_listener_flatness_probe.js",
  ]) {
    expect(manifest.resources.find((file) => file.name === name)).toMatchObject(
      {
        sha256: hash(await readFile(join(SOURCE_DIRECTORY, name))),
        scope: "audio",
      },
    );
    expect(await readFile(join(output, name))).toEqual(
      await readFile(join(SOURCE_DIRECTORY, name)),
    );
  }
  const graph = decodeAmxd(
    await readFile(join(output, manifest.deviceFile)),
  ).document;
  const smoke = graph.patcher.boxes.find(
    ({ box }) => box.id === "flatness-smoke",
  )?.box.patcher;
  expect(smoke).toBeDefined();
  expect(
    smoke.boxes
      .filter(({ box }) => box.text?.startsWith("fluid.spectralshape~"))
      .map(({ box }) => box.text),
  ).toEqual([
    "fluid.spectralshape~ @select spread rolloff flatness @fftsettings 2048 2048 2048 @unit 0 @power 0 @minfreq 0 @maxfreq -1 @rolloffpercent 95",
    "fluid.spectralshape~ @select spread rolloff flatness @fftsettings 2048 2048 2048 @unit 0 @power 0 @minfreq 0 @maxfreq -1 @rolloffpercent 95",
  ]);
  const pin = FLUCOMA_DEPENDENCY_FILES.find((file) => file.mode === 0o755);
  expect(
    manifest.resources.find((file) => file.name === pin.name),
  ).toMatchObject({
    sha256: pin.sha256,
    bytes: pin.bytes,
    scope: "dependency",
  });
  const dependencyEvents = lifecycle.events.filter((event) =>
    event.name.includes(".flucoma-dependency-check."),
  );
  expect(dependencyEvents.map((event) => event.stage)).toEqual([
    "queued",
    "started",
    "progress",
    "completed",
  ]);
  for (const [index, event] of dependencyEvents.entries()) {
    expect(event.attributes).toEqual({
      dependency: "flucoma-spectralshape",
      version: "1.0.10",
    });
    expect(event.trace.traceId).toBe("00000000-0000-4000-8000-000000000001");
    expect(event.correlationId).toBe("metric-package");
    expect(event.causationId).toBe(
      index ? dependencyEvents[index - 1].id : "caller",
    );
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  }
  for (const failure of ["missing", "tampered", "linked", "manifest-path"]) {
    const candidate = join(root, failure);
    await cp(output, candidate, { recursive: true });
    const path = join(candidate, pin.name);
    if (failure === "missing") await rm(path);
    if (failure === "linked") {
      await rm(path);
      await symlink(join(output, pin.name), path);
    }
    const changed = JSON.parse(JSON.stringify(manifest));
    if (failure === "tampered") {
      const raw = await readFile(path);
      raw[100] ^= 1;
      await writeFile(path, raw);
      changed.resources.find((file) => file.name === pin.name).sha256 =
        hash(raw);
    }
    if (failure === "manifest-path")
      changed.resources.find((file) => file.name === pin.name).name =
        "../escape";
    await writeFile(
      join(candidate, "audio-listener-manifest.json"),
      JSON.stringify(changed),
    );
    await expect(checkArtifact(candidate)).rejects.toThrow();
  }
});

it("packages a matched v5 executable, actual controller and fresh same-folder codec", async () => {
  const { source, output, lifecycle } = await packageHarness();
  const manifest = await build(output, {
    authoredDevicePath: source,
    stage: lifecycle.stage,
  });
  expect(manifest).toMatchObject({
    nativeVersion: 5,
    nativeScope: "independent-metric-timelines/v1",
    observationSchema: "metric-audio-observation/v1",
    realLiveValidated: false,
    metricProtocol: { schema: "native-metric-protocol-bundle/v1" },
  });
  expect(await checkArtifact(output)).toEqual(manifest);
  expect(manifest.engineeringFixture).toBeUndefined();
  expect(
    manifest.resources.some((r) =>
      /^audio_listener_(?:engine|runtime|max|native_(?:coordinates|assembler|controller|v[1-4]_max))\.js$/.test(
        r.name,
      ),
    ),
  ).toBe(false);
  expect(
    manifest.resources.find(
      (r) => r.name === "audio_listener_metric_runtime.js",
    ).sha256,
  ).toBe(
    hash(
      await readFile(
        join(SOURCE_DIRECTORY, "audio_listener_metric_runtime.js"),
      ),
    ),
  );
  const defaultDevice = decodeAmxd(
    await readFile(join(output, manifest.deviceFile)),
  );
  expect(JSON.stringify(defaultDevice.document)).not.toMatch(
    /node\.script audio_listener_(?:max|native_max|native_v[234]_max)\.js/,
  );
  expect(
    defaultDevice.document.patcher.boxes.find(
      ({ box }) => box.varname === "ml_runtime",
    ).box.text,
  ).toBe("node.script audio_listener_native_v5_max.js @autostart 1 @watch 0");
  const require = createRequire(join(output, "probe.cjs"));
  const { createMetricRuntime } = require("./audio_listener_metric_runtime.js");
  const {
    createMetricController,
  } = require("./audio_listener_metric_controller.js");
  const codec = require("./audio_listener_metric_protocol.js");
  expect(typeof createMetricRuntime).toBe("function");
  const controller = createMetricController({
    codec,
    now: Date.now,
    sendControl() {},
    sendListenerReply: () => true,
    sendListenerResult: () => true,
    onEvent() {},
  });
  expect(controller.snapshot().state).toBe("idle");
  expect(typeof codec.createMetricObservationReportRows).toBe("function");
  expect(codec.MAX_AUDIO_OBSERVATION_BYTES).toBe(256 * 1024);
  expect(codec.MAX_METRIC_OBSERVATION_BYTES).toBe(2 * 1024 * 1024);
  expect(codec.MAX_METRIC_RESULT_FRAME_BYTES).toBe(2 * 1024 * 1024);
  for (const nativeVersion of [undefined, 1, 2, 3, 4]) {
    await writeFile(
      join(output, "audio-listener-manifest.json"),
      JSON.stringify({
        ...manifest,
        nativeVersion,
      }),
    );
    await expect(checkArtifact(output)).rejects.toThrow(/native version/);
  }
  await writeFile(
    join(output, "audio-listener-manifest.json"),
    JSON.stringify({
      ...manifest,
      engineeringFixture: {
        schema: "native-metric-engineering-fixture/v1",
        id: fixture.engineeringFixture,
        engineeringOnly: true,
        unavailableMetric: "spectral-centroid",
        sourceSemantics: "spectral-acquisition-not-started",
        runtimeEntry: fixtureEntry,
        runtimeEntrySha256: hash(
          await readFile(join(SOURCE_DIRECTORY, fixtureEntry)),
        ),
      },
    }),
  );
  await expect(checkArtifact(output)).rejects.toThrow(
    /engineering fixture manifest/,
  );
});

it("rejects a substituted parent even with valid runtime names and stereo wiring", async () => {
  const { source, output, lifecycle } = await packageHarness();
  const decoded = decodeAmxd(await readFile(source));
  decoded.document.patcher.lines = decoded.document.patcher.lines.filter(
    ({ patchline }) =>
      !(
        patchline.source[0] === "init" &&
        patchline.destination[0] === "identity"
      ),
  );
  await writeFile(source, encodeAmxd(decoded, decoded.document));
  const events = [];
  await expect(
    build(output, {
      authoredDevicePath: source,
      stage: lifecycle.stage,
      onEvent: (event) => events.push(event),
    }),
  ).rejects.toThrow("alternate listening patch source denied");
  expect(events.map((event) => event.stage)).toEqual([
    "queued",
    "started",
    "failed",
  ]);
  await expect(
    readFile(join(output, "audio-listener-manifest.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("clean-break packaging denies retired versions/non-native requests before publication", async () => {
  const { root, source, lifecycle } = await packageHarness();
  for (const [index, options] of [
    ...[1, 2, 3, 4, 6, null, "5"].map((nativeVersion) => ({ nativeVersion })),
    { nativeMode: false },
  ].entries()) {
    const destination = join(root, `retired-${index}`);
    await expect(
      build(destination, {
        authoredDevicePath: source,
        ...options,
        stage: lifecycle.stage,
      }),
    ).rejects.toThrow(/native.*5|v5/);
    await expect(
      readFile(join(destination, "audio-listener-manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("default v5 build still requires codec lifecycle and canonical default source is authored", async () => {
  const { output, source } = await packageHarness();
  await expect(build(output, { authoredDevicePath: source })).rejects.toThrow(
    "native_metric_codec_lifecycle_required",
  );
  await expect(
    readFile(join(output, "audio-listener-manifest.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("canonical default authored package is v5 and rejects retired CLI selectors without publication", async () => {
  const { root, output, lifecycle } = await packageHarness();
  const manifest = await build(output, { stage: lifecycle.stage });
  expect(manifest).toMatchObject({
    deviceFile: DEVICE_FILE_NAME,
    authored: true,
    nativeVersion: 5,
    nativeAbiVersion: 3,
    algorithmVersion: "3.0.0",
    measurementDelivery: "independent-metric-timelines/v1",
    realLiveValidated: false,
  });
  expect(manifest.engineeringFixture).toBeUndefined();
  const production = decodeAmxd(
    await readFile(join(output, manifest.deviceFile)),
  ).document;
  const incoming = production.patcher.lines
    .filter(({ patchline }) => patchline.destination[0] === "node")
    .map(({ patchline }) => patchline.source[0]);
  expect(incoming.sort()).toEqual([
    "dspPack",
    "flatness-smoke-output",
    "identity",
    "scoped-native-analysis",
    "scoped-native-clock",
  ]);
  expect(
    production.patcher.lines.some(
      ({ patchline }) =>
        JSON.stringify(patchline.source) === JSON.stringify(["init", 0]) &&
        JSON.stringify(patchline.destination) ===
          JSON.stringify(["identity", 0]),
    ),
  ).toBe(true);
  const generated = join(root, "generated");
  const qualified = await build(generated, {
    authoredDevicePath: join(root, "Owned-Metric-Listener.amxd"),
    stage: lifecycle.stage,
  });
  expect(await readFile(join(output, manifest.deviceFile))).toEqual(
    await readFile(join(generated, qualified.deviceFile)),
  );
  expect(
    JSON.stringify(
      decodeAmxd(await readFile(join(output, manifest.deviceFile))).document,
    ),
  ).not.toMatch(
    /node\.script audio_listener_(?:max|native_max|native_v[234]_max)\.js/,
  );
  expect(await checkArtifact(output)).toEqual(manifest);
  for (const command of [
    [
      "build-native-v2-authored",
      "--source",
      "unused.amxd",
      "--out",
      join(root, "cli-denied"),
    ],
    [
      "build-native-authored",
      "--source",
      "unused.amxd",
      "--out",
      join(root, "cli-denied"),
      "--native-version",
      "4",
    ],
  ])
    await expect(main(command)).rejects.toThrow(/native v5 only/);
  await expect(
    readFile(join(root, "cli-denied", "audio-listener-manifest.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("pins a separately named engineering-only unavailable-spectrum v5 entry and matched artifact/resources", async () => {
  const { source, output, lifecycle } = await packageHarness();
  const manifest = await build(output, {
    authoredDevicePath: source,
    nativeMode: true,
    nativeVersion: 5,
    ...fixture,
    stage: lifecycle.stage,
  });
  expect(manifest.engineeringFixture).toEqual({
    schema: "native-metric-engineering-fixture/v1",
    id: fixture.engineeringFixture,
    engineeringOnly: true,
    unavailableMetric: "spectral-centroid",
    sourceSemantics: "spectral-acquisition-not-started",
    runtimeEntry: fixtureEntry,
    runtimeEntrySha256: hash(
      await readFile(join(SOURCE_DIRECTORY, fixtureEntry)),
    ),
  });
  expect(manifest.realLiveValidated).toBe(false);
  expect(
    manifest.resources.some(
      (r) => r.name === "audio_listener_native_v5_max.js",
    ),
  ).toBe(false);
  const device = await readFile(join(output, manifest.deviceFile));
  expect(hash(device)).toBe(manifest.deviceSha256);
  const { document } = decodeAmxd(device);
  expect(JSON.stringify(document)).not.toMatch(
    /node\.script audio_listener_(?:max|native_max|native_v[234]_max)\.js/,
  );
  expect(
    document.patcher.boxes.find(({ box }) => box.varname === "ml_runtime").box
      .text,
  ).toBe(`node.script ${fixtureEntry} @autostart 1 @watch 0`);
  for (const resource of manifest.resources) {
    const raw = await readFile(join(output, resource.name));
    expect(hash(raw)).toBe(resource.sha256);
    expect(raw.length).toBe(resource.bytes);
    if (
      [
        "audio_listener_metric_runtime.js",
        "audio_listener_metric_controller.js",
        fixtureEntry,
      ].includes(resource.name)
    )
      expect(raw).toEqual(
        await readFile(join(SOURCE_DIRECTORY, resource.name)),
      );
  }
  // The negative variant keeps exactly the default v5 DSP sources.
  for (const [name, graph] of Object.entries(
    nativeRuntimeDocuments({ nativeVersion: 5 }),
  ))
    expect(await readFile(join(output, name), "utf8")).toBe(
      JSON.stringify(graph, null, 2),
    );
  expect(await checkArtifact(output)).toEqual(manifest);
  expect(
    lifecycle.events.some(
      (event) =>
        event.attributes.engineeringFixture === fixture.engineeringFixture &&
        event.stage === "completed",
    ),
  ).toBe(true);
  // Metadata alone cannot relabel a default or qualify a fixture.
  for (const patch of [
    { engineeringFixture: undefined },
    { engineeringFixture: { ...manifest.engineeringFixture, id: "unknown" } },
    {
      engineeringFixture: {
        ...manifest.engineeringFixture,
        engineeringOnly: false,
      },
    },
    {
      engineeringFixture: {
        ...manifest.engineeringFixture,
        runtimeEntrySha256: "0".repeat(64),
      },
    },
    { engineeringFixture: { ...manifest.engineeringFixture, extra: true } },
    { nativeVersion: 4 },
    { realLiveValidated: true },
  ]) {
    await writeFile(
      join(output, "audio-listener-manifest.json"),
      JSON.stringify({ ...manifest, ...patch }),
    );
    await expect(checkArtifact(output)).rejects.toThrow();
  }
});

it("denies unsupported or implicit fixtures before publication with bounded failure lifecycle", async () => {
  const { root, source, lifecycle } = await packageHarness();
  for (const [index, options] of [
    { engineeringFixture: fixture.engineeringFixture },
    { ...fixture, engineeringOnly: false },
    { ...fixture, engineeringFixture: "unknown" },
    { ...fixture, engineeringFixture: null },
    { ...fixture, engineeringFixture: undefined },
    { engineeringOnly: true },
    { spectrumEnabled: false },
    { ...fixture, nativeVersion: 4 },
    { ...fixture, nativeVersion: 1 },
    { ...fixture, nativeVersion: 6 },
    { ...fixture, nativeMode: false },
  ].entries()) {
    const destination = join(root, `denied-${index}`);
    const events = [];
    await expect(
      build(destination, {
        authoredDevicePath: source,
        nativeMode: true,
        nativeVersion: 5,
        ...options,
        stage: lifecycle.stage,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(/engineering.fixture/);
    await expect(
      readFile(join(destination, "audio-listener-manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.at(-1)).toMatchObject({
      stage: "failed",
      errorCode: "listener-package-failed",
    });
    expect(JSON.stringify(events)).not.toContain("unknown");
  }
});

it("fixture packaging cancellation cannot publish an artifact manifest", async () => {
  const { source, output } = await packageHarness();
  const abort = new AbortController();
  const events = [];
  abort.abort();
  await expect(
    build(output, {
      authoredDevicePath: source,
      nativeMode: true,
      nativeVersion: 5,
      ...fixture,
      signal: abort.signal,
      stage: async (_name, operation) => operation(),
      onEvent: (event) => events.push(event),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(events.at(-1).stage).toBe("cancelled");
  await expect(
    readFile(join(output, "audio-listener-manifest.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
