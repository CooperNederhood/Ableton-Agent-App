import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeAmxd,
  encodeAmxd,
  publishResources,
  renderPortableDevice,
} from "./max-device-publisher.mjs";
import {
  producerCompanionSource,
  SHARED_PRODUCER_COMPANION,
  SHARED_PRODUCER_IDENTITY,
  writeProducerDiscoveryConfiguration,
} from "./m4l-producer-companions.mjs";
import {
  addDevicePreviewRouting,
  sourceDocuments,
} from "../max-patches/audio-listener/native-source.mjs";
import { calibrationDocuments } from "../max-patches/audio-listener/calibration-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_DIRECTORY = join(root, "max-patches", "audio-listener");
export const DEVICE_FILE_NAME = "Audio-Listener.amxd";
export const DEVICE_DIRECTORY_PARTS = [
  "Presets",
  "Audio Effects",
  "Max Audio Effect",
  "Audio-Listener",
];
export const LOCAL_RESOURCES = [
  "audio_listener_engine.js",
  "audio_listener_runtime.js",
  "audio_listener_max.js",
  "audio_listener_guard.js",
  "package.json",
  "audio_listener_analysis.maxpat",
  "audio_listener_spectrum.maxpat",
  "audio_listener_envelope.gendsp",
  "audio_listener_spectrum_energy.gendsp",
];
export const SHARED_RESOURCES = [
  SHARED_PRODUCER_COMPANION,
  SHARED_PRODUCER_IDENTITY,
];
export const ALL_RESOURCES = [...LOCAL_RESOURCES, ...SHARED_RESOURCES];
export const PROFILE_CONFIGURATION = "agent_signal_storage.js";
const hash = (raw) => createHash("sha256").update(raw).digest("hex");

function isAudioTemplate(raw) {
  // Factory AMXD effect type is 'aaaa'; a MIDI ('mmmm') container is not reusable.
  if (
    raw.subarray(0, 4).toString("ascii") !== "ampf" ||
    raw.subarray(8, 12).toString("ascii") !== "aaaa"
  )
    throw new Error("not an Audio Effect AMXD template");
  return decodeAmxd(raw);
}

export function validateDocument(document) {
  const p = document?.patcher;
  if (!p || !Array.isArray(p.boxes) || !Array.isArray(p.lines))
    throw new Error("invalid patcher");
  const boxes = new Map(p.boxes.map(({ box }) => [box.id, box]));
  if (boxes.size !== p.boxes.length) throw new Error("duplicate box IDs");
  for (const b of boxes.values()) {
    const [x, y, w, h] = b.patching_rect;
    if (x < 0 || y < 0 || x + w > 800 || y + h > 380)
      throw new Error("object outside usable patching area");
    if (b.patcher) validateDocument({ patcher: b.patcher });
  }
  for (const {
    patchline: {
      source: [src, so],
      destination: [dst, di],
    },
  } of p.lines) {
    const a = boxes.get(src),
      b = boxes.get(dst);
    if (
      !a ||
      !b ||
      !Number.isInteger(so) ||
      !Number.isInteger(di) ||
      so < 0 ||
      di < 0 ||
      so >= a.numoutlets ||
      di >= b.numinlets
    )
      throw new Error("invalid patch cord");
  }
  const text = JSON.stringify(document);
  if (/mcp_bridge|m4l_mcp|\/Users\/|[A-Za-z]:[\\/]|__ABLETON/.test(text))
    throw new Error("nonportable source");
  return document;
}

function validatePassThrough(document) {
  const p = document.patcher;
  const input = p.boxes.find(({ box }) => box.text === "plugin~")?.box.id;
  const output = p.boxes.find(({ box }) => box.text === "plugout~")?.box.id;
  if (!input || !output) throw new Error("missing audio I/O");
  for (let channel = 0; channel < 2; channel++) {
    if (
      !p.lines.some(
        ({ patchline }) =>
          patchline.source[0] === input &&
          patchline.source[1] === channel &&
          patchline.destination[0] === output &&
          patchline.destination[1] === channel,
      )
    )
      throw new Error("missing independent stereo pass-through");
  }
}

async function resourceSource(name) {
  // The common publisher owns BOTH shared mappings, including the sole canonical
  // identity implementation. Do not assume an extracted duplicate exists on disk.
  if (SHARED_RESOURCES.includes(name))
    return producerCompanionSource(name, SOURCE_DIRECTORY);
  return join(SOURCE_DIRECTORY, name);
}

export function prepareAuthoredDevice(
  document,
  { keepMcpBridge = false } = {},
) {
  const result = JSON.parse(JSON.stringify(document));
  const p = result?.patcher;
  if (!p || !Array.isArray(p.boxes) || !Array.isArray(p.lines))
    throw new Error("invalid authored patcher");
  const replacements = {
    ml_analysis: "poly~ audio_listener_analysis 1 @parallel 0",
    ml_runtime: "node.script audio_listener_max.js @autostart 1 @watch 0",
    ml_guard: "js audio_listener_guard.js",
    ml_identity: `js ${SHARED_PRODUCER_IDENTITY}`,
  };
  for (const [name, text] of Object.entries(replacements)) {
    const matches = p.boxes.filter(({ box }) => box?.varname === name);
    if (matches.length !== 1)
      throw new Error(`expected one owned object: ${name}`);
    const b = matches[0].box;
    if (
      b.maxclass !== "newobj" ||
      !b.text?.startsWith(`${text.split(" ")[0]} `)
    )
      throw new Error(`unexpected owned object type: ${name}`);
    b.text = text;
  }
  const bottom = Math.max(
    ...p.boxes.map(({ box }) =>
      Array.isArray(box.patching_rect)
        ? box.patching_rect[1] + box.patching_rect[3]
        : 0,
    ),
  );
  addDevicePreviewRouting(result, { x: 30, y: bottom + 30 });
  p.rect[3] = Math.max(
    p.rect[3],
    ...p.boxes.map(({ box }) =>
      Array.isArray(box.patching_rect)
        ? box.patching_rect[1] + box.patching_rect[3] + 30
        : 0,
    ),
  );
  const removed = new Set(
    p.boxes
      .filter(({ box }) =>
        ["ml_resource_path", "ml_add_resource_path"].includes(box?.varname),
      )
      .map(({ box }) => box.id),
  );
  p.boxes = p.boxes.filter(({ box }) => !removed.has(box.id));
  p.lines = p.lines.filter(
    ({ patchline }) =>
      !removed.has(patchline?.source?.[0]) &&
      !removed.has(patchline?.destination?.[0]),
  );
  const label = p.boxes.find(
    ({ box }) => box.varname === "ml_label_development",
  );
  if (label)
    label.box.text = "DEVELOPMENT CONTROLS - restart adapter / reload Gen";
  delete p.dependency_cache;
  const packaged = keepMcpBridge
    ? result
    : renderPortableDevice(result, "__NO_SOURCE_PATH__", {
        pathPlaceholder: "__NO_INSTALLED_PATH__",
      });
  validateAuthoredDocument(packaged, { keepMcpBridge });
  return packaged;
}

function validateAuthoredDocument(document, { keepMcpBridge = false } = {}) {
  const p = document?.patcher;
  if (!p || !Array.isArray(p.boxes) || !Array.isArray(p.lines))
    throw new Error("invalid authored patcher");
  const ids = new Set(p.boxes.map(({ box }) => box?.id));
  if (ids.size !== p.boxes.length || ids.has(undefined))
    throw new Error("invalid authored box IDs");
  for (const { patchline } of p.lines) {
    for (const endpoint of [patchline?.source, patchline?.destination]) {
      if (
        !Array.isArray(endpoint) ||
        !ids.has(endpoint[0]) ||
        !Number.isInteger(endpoint[1]) ||
        endpoint[1] < 0 ||
        endpoint[1] > 256
      )
        throw new Error("invalid authored patch cord");
    }
  }
  const text = JSON.stringify(document);
  if (
    /\/Users\/|[A-Za-z]:[\\/]|__ABLETON|copilot-worktrees/.test(text) ||
    (!keepMcpBridge && /mcp_bridge|m4l_mcp/.test(text))
  )
    throw new Error("nonportable authored device");
  validatePassThrough(document);
}

export async function checkSource() {
  const manifest = JSON.parse(
    await readFile(
      join(SOURCE_DIRECTORY, "audio-listener-resources.json"),
      "utf8",
    ),
  );
  if (
    JSON.stringify(manifest.resources) !== JSON.stringify(ALL_RESOURCES) ||
    manifest.optionalProfileConfiguration !== PROFILE_CONFIGURATION ||
    manifest.realLiveValidated !== false ||
    manifest.observationSchema !== "audio-observation/v1"
  ) {
    throw new Error("canonical resource manifest mismatch");
  }
  const documents = sourceDocuments();
  for (const [name, value] of Object.entries(documents)) {
    validateDocument(value);
    const actual = JSON.parse(
      await readFile(join(SOURCE_DIRECTORY, name), "utf8"),
    );
    if (JSON.stringify(actual) !== JSON.stringify(value))
      throw new Error(`stale canonical source: ${name}`);
  }
  validatePassThrough(documents["Audio-Listener.maxpat"]);
  isAudioTemplate(
    await readFile(join(SOURCE_DIRECTORY, "audio-effect-template.amxd")),
  );
  for (const name of ALL_RESOURCES) await readFile(await resourceSource(name));
  return documents;
}

/** Publication into an explicit staging directory only, NOT installation/promotion.
 * All resources are adjacent, with relative names and no repository dependency.
 */
function checkPackageCancellation(signal) {
  if (signal?.aborted) {
    const error = new Error("Listener packaging cancelled");
    error.name = "AbortError";
    throw error;
  }
}

export async function build(outDirectory, options = {}) {
  const startedAt = Date.now();
  const emit = (stage, errorCode) =>
    options.onEvent?.({
      operation: "m4l.audio-listener.package",
      stage,
      durationMs: Date.now() - startedAt,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
      ...(options.causationId === undefined
        ? {}
        : { causationId: options.causationId }),
    });
  emit("queued");
  emit("started");
  try {
    checkPackageCancellation(options.signal);
    const result = await buildPackage(outDirectory, options);
    checkPackageCancellation(options.signal);
    emit("completed");
    return result;
  } catch (error) {
    const cancelled = error.name === "AbortError";
    emit(
      cancelled ? "cancelled" : "failed",
      cancelled ? "cancelled" : "listener-package-failed",
    );
    throw error;
  }
}

async function buildPackage(
  outDirectory,
  {
    discoveryStorage,
    authoredDevicePath,
    keepMcpBridge = false,
    ...publicationOptions
  } = {},
) {
  if (!outDirectory || typeof outDirectory !== "string")
    throw new Error("explicit staging directory required");
  const destination = resolve(outDirectory);
  if (destination === SOURCE_DIRECTORY)
    throw new Error("build must not overwrite canonical sources");
  const documents = await checkSource();
  const rawTemplate = await readFile(
    join(SOURCE_DIRECTORY, "audio-effect-template.amxd"),
  );
  const container = isAudioTemplate(rawTemplate);
  let deviceFile = DEVICE_FILE_NAME;
  let rawDevice = encodeAmxd(container, documents["Audio-Listener.maxpat"]);
  if (authoredDevicePath !== undefined) {
    if (dirname(resolve(authoredDevicePath)) === destination)
      throw new Error(
        "authored packaging must not overwrite its source directory",
      );
    const metadata = await stat(authoredDevicePath);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
      throw new Error("authored device exceeds size bound");
    const source = await readFile(authoredDevicePath);
    if (source.length > 8 * 1024 * 1024)
      throw new Error("authored device exceeds size bound");
    deviceFile = basename(authoredDevicePath);
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}\.amxd$/.test(deviceFile))
      throw new Error("invalid authored device filename");
    const authored = isAudioTemplate(source);
    rawDevice = encodeAmxd(
      authored,
      prepareAuthoredDevice(authored.document, { keepMcpBridge }),
    );
  } else if (keepMcpBridge)
    throw new Error("authoring bridge requires an authored device");
  await mkdir(destination, { recursive: true });
  if (authoredDevicePath !== undefined && (await readdir(destination)).length) {
    throw new Error("authored staging directory must be empty");
  }
  const resources = [];
  const publication = [];
  for (const name of ALL_RESOURCES) {
    const source = await resourceSource(name);
    const raw = await readFile(source);
    publication.push({ fileName: name, source });
    resources.push({
      name,
      sha256: hash(raw),
      bytes: raw.length,
      scope: SHARED_RESOURCES.includes(name) ? "shared" : "audio",
    });
  }
  await publishResources({
    ...publicationOptions,
    destinationDirectory: destination,
    resources: publication,
  });
  if (discoveryStorage !== undefined) {
    // Staging only: caller supplies paths from the existing storage resolver.
    // The common publisher writes owner-only PATH configuration, never secrets.
    await writeProducerDiscoveryConfiguration(destination, discoveryStorage);
    const raw = await readFile(join(destination, PROFILE_CONFIGURATION));
    resources.push({
      name: PROFILE_CONFIGURATION,
      sha256: hash(raw),
      bytes: raw.length,
      scope: "profile",
    });
  }
  checkPackageCancellation(publicationOptions.signal);
  await writeFile(
    join(destination, deviceFile),
    rawDevice,
    authoredDevicePath === undefined ? undefined : { flag: "wx" },
  );
  const manifest = {
    formatVersion: authoredDevicePath === undefined ? 1 : 2,
    deviceFile,
    authored: authoredDevicePath !== undefined,
    externalAuthoringBridge: keepMcpBridge,
    deviceType: "MxDeviceAudioEffect",
    algorithmVersion: "1.0.0",
    observationSchema: "audio-observation/v1",
    sharedTransportProtocolVersion: 1,
    discoveryConfigured: discoveryStorage !== undefined,
    providerLimits: {
      durationMs: 120000,
      maxWindows: 512,
      envelopeUpdatesPerSecond: 10,
    },
    planningCeilings: {
      watchdogMs: 300000,
      observationPoints: 1024,
      attackCandidates: 512,
    },
    portable: !keepMcpBridge,
    listenerResourcesPortable: true,
    realLiveValidated: false,
    templateSha256: hash(rawTemplate),
    deviceSha256: hash(rawDevice),
    resources,
    validationGates: [
      "Max compilation/FFT offsets",
      "host validity flags/sample coordinate calibration",
      "quantized Session and Arrangement actual-launch alignment",
      "transparent pass-through/native watchdog on Node failure",
      "canonical Max path to connection-scoped bridge UUID ownership binding",
    ],
  };
  checkPackageCancellation(publicationOptions.signal);
  await writeFile(
    join(destination, "audio-listener-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    authoredDevicePath === undefined ? undefined : { flag: "wx" },
  );
  await checkArtifact(destination);
  return manifest;
}

export async function checkArtifact(directory) {
  const manifest = JSON.parse(
    await readFile(join(directory, "audio-listener-manifest.json"), "utf8"),
  );
  const expectedResources = [
    ...ALL_RESOURCES,
    ...(manifest.discoveryConfigured === true ? [PROFILE_CONFIGURATION] : []),
  ];
  const authored = manifest.formatVersion === 2;
  const validPackagingFlags = authored
    ? manifest.authored === true &&
      typeof manifest.externalAuthoringBridge === "boolean" &&
      manifest.portable === !manifest.externalAuthoringBridge &&
      manifest.listenerResourcesPortable === true
    : (manifest.authored === undefined || manifest.authored === false) &&
      (manifest.externalAuthoringBridge === undefined ||
        manifest.externalAuthoringBridge === false) &&
      manifest.portable === true &&
      (manifest.listenerResourcesPortable === undefined ||
        manifest.listenerResourcesPortable === true);
  if (
    ![1, 2].includes(manifest.formatVersion) ||
    manifest.realLiveValidated !== false ||
    manifest.sharedTransportProtocolVersion !== 1 ||
    typeof manifest.discoveryConfigured !== "boolean" ||
    manifest.deviceType !== "MxDeviceAudioEffect" ||
    !validPackagingFlags ||
    (!authored && manifest.deviceFile !== DEVICE_FILE_NAME) ||
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}\.amxd$/.test(manifest.deviceFile) ||
    JSON.stringify(manifest.resources.map((r) => r.name)) !==
      JSON.stringify(expectedResources)
  ) {
    throw new Error("invalid resource manifest");
  }
  if (!manifest.discoveryConfigured) {
    try {
      await readFile(join(directory, PROFILE_CONFIGURATION));
      throw new Error("unmanifested profile configuration");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const device = await readFile(join(directory, manifest.deviceFile));
  const { document } = isAudioTemplate(device);
  if (hash(device) !== manifest.deviceSha256)
    throw new Error("device hash mismatch");
  if (authored)
    validateAuthoredDocument(document, {
      keepMcpBridge: manifest.externalAuthoringBridge,
    });
  else validateDocument(document);
  validatePassThrough(document);
  for (const { name, sha256, bytes } of manifest.resources) {
    if (basename(name) !== name) throw new Error("unsafe resource name");
    const raw = await readFile(join(directory, name));
    if (hash(raw) !== sha256 || raw.length !== bytes)
      throw new Error(`resource hash mismatch: ${name}`);
  }
  return manifest;
}

export const CALIBRATION_RESOURCES = [
  "Audio-Listener-Commissioning.maxpat",
  "calibration_clock.gendsp",
  "calibration_controller.js",
  "calibration_guard.js",
  "calibration_report.js",
  "package.json",
  "audio_listener_analysis.maxpat",
  "audio_listener_spectrum.maxpat",
  "audio_listener_envelope.gendsp",
  "audio_listener_spectrum_energy.gendsp",
];
const CALIBRATION_FIXTURES = [
  "silence",
  "quarter-sine",
  "anti-phase-quarter-sine",
];
const FORBIDDEN_CALIBRATION_FILES = [
  DEVICE_FILE_NAME,
  "audio_listener_runtime.js",
  "audio_listener_engine.js",
  SHARED_PRODUCER_COMPANION,
  SHARED_PRODUCER_IDENTITY,
  PROFILE_CONFIGURATION,
];

export async function checkCalibrationSource() {
  // Check byte parity of both calibration documents; analyzer files are checked
  // against the original native source, not a forked measurement implementation.
  await checkSource();
  for (const [name, doc] of Object.entries(calibrationDocuments())) {
    validateDocument(doc);
    const stored = JSON.parse(
      await readFile(join(SOURCE_DIRECTORY, name), "utf8"),
    );
    if (JSON.stringify(stored) !== JSON.stringify(doc))
      throw new Error(`stale calibration source: ${name}`);
  }
  for (const name of CALIBRATION_RESOURCES)
    await readFile(join(SOURCE_DIRECTORY, name));
}

/** Separate standalone-Max artifact, not a production device or installer.
 * Only generated test PCM is materialized. No user audio is read or recorded.
 */
export async function buildCalibration(outDirectory) {
  if (!outDirectory || typeof outDirectory !== "string")
    throw new Error("explicit calibration staging directory required");
  const directory = resolve(outDirectory);
  if (directory === SOURCE_DIRECTORY)
    throw new Error("cannot overwrite canonical calibration sources");
  await checkCalibrationSource();
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length)
    throw new Error("calibration staging directory must be empty");
  const resources = [];
  const publication = [];
  for (const name of CALIBRATION_RESOURCES) {
    const source = join(SOURCE_DIRECTORY, name),
      raw = await readFile(source);
    resources.push({ name, sha256: hash(raw), bytes: raw.length });
    publication.push({ fileName: name, source });
  }
  await publishResources({
    destinationDirectory: directory,
    resources: publication,
  });
  // Tooling-only import. No TypeScript/parent-package dependency is shipped.
  const { createKnownListeningFixture } =
    await import("../packages/test-support/src/listening-fixture.ts");
  const fixtures = [];
  for (const id of CALIBRATION_FIXTURES) {
    const input = createKnownListeningFixture(id);
    const raw = input.wav,
      name = `commission-${id}.wav`;
    await writeFile(join(directory, name), raw);
    const sha256 = hash(raw);
    resources.push({ name, sha256, bytes: raw.length });
    fixtures.push({
      id,
      file: name,
      sha256,
      sampleRate: input.sampleRate,
      frames: (raw.byteLength - 44) / 4,
      reference: input.reference,
    });
  }
  const manifest = {
    schema: "native-commissioning-resources/v1",
    calibrationOnly: true,
    realDeviceValidated: false,
    patch: "Audio-Listener-Commissioning.maxpat",
    fftWindowSamples: 2048,
    envelopeWindowSamples: 4800,
    maxReportBytes: 65536,
    fixtures,
    resources,
  };
  await writeFile(
    join(directory, "calibration-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await checkCalibrationArtifact(directory);
  return manifest;
}

export async function checkCalibrationArtifact(directory) {
  for (const name of FORBIDDEN_CALIBRATION_FILES) {
    try {
      await readFile(join(directory, name));
      throw new Error(
        `production resource forbidden in calibration artifact: ${name}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const manifest = JSON.parse(
    await readFile(join(directory, "calibration-manifest.json"), "utf8"),
  );
  const expected = [
    ...CALIBRATION_RESOURCES,
    ...CALIBRATION_FIXTURES.map((id) => `commission-${id}.wav`),
  ];
  if (
    manifest.schema !== "native-commissioning-resources/v1" ||
    manifest.calibrationOnly !== true ||
    manifest.realDeviceValidated !== false ||
    manifest.patch !== "Audio-Listener-Commissioning.maxpat" ||
    JSON.stringify(manifest.resources.map((r) => r.name)) !==
      JSON.stringify(expected)
  ) {
    throw new Error("invalid_calibration_manifest");
  }
  for (const r of manifest.resources) {
    if (basename(r.name) !== r.name)
      throw new Error("unsafe calibration resource");
    const raw = await readFile(join(directory, r.name));
    if (hash(raw) !== r.sha256 || raw.length !== r.bytes)
      throw new Error(`calibration hash mismatch: ${r.name}`);
  }
  const { createRequire } = await import("node:module");
  const { readArtifact } = createRequire(import.meta.url)(
    "../max-patches/audio-listener/calibration_controller.js",
  );
  readArtifact(directory);
  for (const name of [
    "Audio-Listener-Commissioning.maxpat",
    "calibration_clock.gendsp",
  ]) {
    const doc = JSON.parse(await readFile(join(directory, name), "utf8"));
    validateDocument(doc);
    if (JSON.stringify(doc) !== JSON.stringify(calibrationDocuments()[name]))
      throw new Error(`modified calibration graph: ${name}`);
  }
  for (const name of CALIBRATION_RESOURCES) {
    if (
      !(await readFile(join(directory, name))).equals(
        await readFile(join(SOURCE_DIRECTORY, name)),
      )
    ) {
      throw new Error(`calibration must use exact owned resources: ${name}`);
    }
  }
  const { createKnownListeningFixture } =
    await import("../packages/test-support/src/listening-fixture.ts");
  for (const id of CALIBRATION_FIXTURES) {
    const input = createKnownListeningFixture(id);
    if (
      !(await readFile(join(directory, `commission-${id}.wav`))).equals(
        input.wav,
      )
    )
      throw new Error(`fixture differs from independent known PCM: ${id}`);
  }
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv[0] === "build-authored" &&
    argv[1] === "--source" &&
    argv[2] &&
    argv[3] === "--out" &&
    argv[4] &&
    (argv.length === 5 ||
      (argv.length === 6 && argv[5] === "--keep-authoring-bridge"))
  ) {
    const manifest = await build(argv[4], {
      authoredDevicePath: argv[2],
      keepMcpBridge: argv[5] === "--keep-authoring-bridge",
    });
    console.log(
      `Staged ${manifest.deviceFile}; listener resources are adjacent. ` +
        (manifest.externalAuthoringBridge
          ? "External MCP authoring bridge retained. "
          : "") +
        "Real-Live acceptance remains REQUIRED.",
    );
    return;
  }
  if (
    argv[0] === "verify-calibration-report" &&
    argv[1] &&
    (argv.length === 2 ||
      (argv.length === 4 && argv[2] === "--artifact" && argv[3]))
  ) {
    const { verifyCalibrationReportFile } =
      await import("../max-patches/audio-listener/calibration-verifier.mjs");
    const result = await verifyCalibrationReportFile(argv[1], {
      artifactDirectory: argv[3],
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (argv[0] === "check" && argv.length === 1) {
    await checkCalibrationSource();
    return;
  }
  if (
    argv[0] === "build" &&
    argv[1] === "--out" &&
    argv[2] &&
    argv.length === 3
  ) {
    const manifest = await build(argv[2]);
    console.log(
      `Built staged ${manifest.deviceFile}; real-Live validation is REQUIRED.`,
    );
    return;
  }
  if (argv[0] === "check-artifact" && argv[1] && argv.length === 2) {
    await checkArtifact(argv[1]);
    return;
  }
  if (argv[0] === "check-calibration" && argv.length === 1) {
    await checkCalibrationSource();
    return;
  }
  if (
    argv[0] === "build-calibration" &&
    argv[1] === "--out" &&
    argv[2] &&
    argv.length === 3
  ) {
    await buildCalibration(argv[2]);
    console.log(
      "Built isolated commissioning harness; no real DSP validation was performed.",
    );
    return;
  }
  if (
    argv[0] === "check-calibration-artifact" &&
    argv[1] &&
    argv.length === 2
  ) {
    await checkCalibrationArtifact(argv[1]);
    return;
  }
  throw new Error(
    "Usage: audio-listener-device.mjs check | build --out <staging-directory> | build-authored --source <device.amxd> --out <staging-directory> [--keep-authoring-bridge] | check-artifact <directory> | check-calibration | build-calibration --out <directory> | check-calibration-artifact <directory> | verify-calibration-report <report.json> [--artifact <directory>]. No installation/promotion.",
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
