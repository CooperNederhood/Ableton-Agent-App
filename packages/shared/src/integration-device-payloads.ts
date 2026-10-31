import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { decodeAmxd } from "./max-device.js";

export type IntegrationDeviceId = "machine-listening" | "midi-capture";
export interface IntegrationDevicePayload {
  readonly id: IntegrationDeviceId;
  readonly sourceDirectory: string;
  readonly deviceFile: string;
  readonly files: readonly {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly pathPlaceholder?: string;
  readonly nativeVersion?: number;
  readonly nativeAbiVersion?: number;
  readonly measurementDelivery?: "retention-v1";
}
export const INTEGRATION_PAYLOAD_MANIFEST = "integration-devices.json";
export const MIDI_CAPTURE_PATH_PLACEHOLDER =
  "__ABLETON_AGENT_MIDI_CAPTURE_DIR__";
export const INTEGRATION_DEVICE_INVENTORY = {
  "machine-listening": {
    deviceFile: "Machine-Listening-Development.amxd",
    files: [
      "Machine-Listening-Development.amxd",
      "audio-listener-manifest.json",
      "audio_listener_engine.js",
      "audio_listener_native_coordinates.js",
      "audio_listener_native_assembler.js",
      "audio_listener_native_controller.js",
      "audio_listener_runtime.js",
      "audio_listener_max.js",
      "audio_listener_guard.js",
      "package.json",
      "audio_listener_analysis.maxpat",
      "audio_listener_spectrum.maxpat",
      "audio_listener_envelope.gendsp",
      "audio_listener_spectrum_energy.gendsp",
      "agent_signal_client_common.js",
      "producer_identity_common.js",
      "audio_listener_native_v4_max.js",
      "audio_listener_native_io.js",
      "audio_listener_measurements.js",
      "audio_listener_native_clock.gendsp",
      "audio_listener_native_envelope.gendsp",
      "audio_listener_native_spectrum.gendsp",
      "audio_listener_native_split.gendsp",
      "audio_listener_native_clock.maxpat",
      "audio_listener_native_fft.maxpat",
      "audio_listener_native_analysis.maxpat",
    ],
  },
  "midi-capture": {
    deviceFile: "Midi-Capture.amxd",
    files: [
      "Midi-Capture.amxd",
      "midi_note_parser.js",
      "midi_capture_identity.js",
      "midi_capture_writer.js",
      "agent_signal_client.js",
      "agent_signal_client_common.js",
    ],
  },
} as const;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid integration payload object");
  return value as Record<string, unknown>;
}
function sameNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((name, index) => name === [...expected].sort()[index])
  );
}
async function directory(
  path: string,
  names: readonly string[],
): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameNames(await readdir(path), names)
  )
    throw new Error("Integration payload directory inventory mismatch");
}
async function boundedFile(
  path: string,
  limit = 8 * 1024 * 1024,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > limit
  )
    throw new Error("Integration payload requires bounded regular files");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.size !== metadata.size ||
      current.ino !== metadata.ino
    )
      throw new Error("Integration payload changed during validation");
    const data = await handle.readFile();
    if (data.length !== metadata.size)
      throw new Error("Integration payload size changed");
    return data;
  } finally {
    await handle.close();
  }
}
function validateWiring(raw: Buffer, id: IntegrationDeviceId): void {
  if (
    raw.subarray(0, 4).toString("ascii") !== "ampf" ||
    raw.subarray(8, 12).toString("ascii") !==
      (id === "machine-listening" ? "aaaa" : "mmmm")
  )
    throw new Error("Integration device AMXD type mismatch");
  const document = record(decodeAmxd(raw).document);
  const serialized = JSON.stringify(document);
  if (
    /mcp_bridge|m4l_mcp|\/Users\/|\/home\/|[A-Za-z]:[\\/]|agent_signal_storage\.js/.test(
      serialized,
    )
  )
    throw new Error(
      "Integration device contains nonportable authoring/profile data",
    );
  const patcher = record(document.patcher);
  if (!Array.isArray(patcher.boxes) || !Array.isArray(patcher.lines))
    throw new Error("Integration device is missing runtime wiring");
  const boxes = patcher.boxes.map((entry: unknown) =>
    record(record(entry).box),
  );
  const boxIds = new Set(boxes.map((box) => box.id));
  if (boxIds.size !== boxes.length)
    throw new Error("Duplicate integration device box IDs");
  for (const entry of patcher.lines) {
    const line = record(record(entry).patchline);
    if (
      !Array.isArray(line.source) ||
      !Array.isArray(line.destination) ||
      !boxIds.has(line.source[0]) ||
      !boxIds.has(line.destination[0]) ||
      !Number.isSafeInteger(line.source[1]) ||
      !Number.isSafeInteger(line.destination[1])
    )
      throw new Error("Invalid integration device patch cord");
  }
  const connected = (
    source: unknown,
    outlet: number,
    destination: unknown,
    inlet: number,
  ) =>
    patcher.lines instanceof Array &&
    patcher.lines.some((entry: unknown) => {
      const line = record(record(entry).patchline);
      return (
        Array.isArray(line.source) &&
        Array.isArray(line.destination) &&
        line.source[0] === source &&
        line.source[1] === outlet &&
        line.destination[0] === destination &&
        line.destination[1] === inlet
      );
    });
  const owned = (varname: string, text: string) => {
    const matches = boxes.filter((box) => box.varname === varname);
    if (matches.length !== 1 || matches[0]?.text !== text)
      throw new Error("Integration device runtime entry mismatch");
  };
  if (id === "machine-listening") {
    if (serialized.includes("__ABLETON"))
      throw new Error("Unexpected listening path placeholder");
    owned(
      "ml_runtime",
      "node.script audio_listener_native_v4_max.js @autostart 1 @watch 0",
    );
    owned("ml_identity", "js producer_identity_common.js watch");
    owned("ml_guard", "js audio_listener_guard.js 4");
    owned("ml_scoped_native_control", "route native_control");
    for (const text of [
      "plugin~",
      "plugout~",
      "poly~ audio_listener_native_clock.maxpat 1 @parallel 0",
      "poly~ audio_listener_native_analysis.maxpat 1 @parallel 0",
    ])
      if (!boxes.some((box) => box.text === text))
        throw new Error("Missing native runtime graph");
    const input = boxes.find((box) => box.text === "plugin~")?.id;
    const output = boxes.find((box) => box.text === "plugout~")?.id;
    for (const channel of [0, 1]) {
      if (!connected(input, channel, output, channel))
        throw new Error("Missing stereo pass-through");
    }
    const byName = (name: string) =>
      boxes.find((box) => box.varname === name)?.id;
    for (const [from, outlet, to, inlet] of [
      ["ml_runtime", 0, "ml_scoped_native_control", 0],
      ["ml_scoped_native_control", 0, "ml_scoped_native_clock", 0],
      ["ml_scoped_native_control", 0, "ml_scoped_native_analysis", 0],
      ["ml_scoped_native_clock", 0, "ml_scoped_native_analysis", 3],
      ["ml_scoped_native_clock", 1, "ml_runtime", 0],
      ["ml_scoped_native_analysis", 1, "ml_runtime", 0],
      ["ml_guard", 2, "ml_scoped_native_clock", 0],
      ["ml_guard", 2, "ml_scoped_native_analysis", 0],
    ] as const) {
      if (!connected(byName(from), outlet, byName(to), inlet))
        throw new Error("Missing native control/data wiring");
    }
    for (const channel of [0, 1]) {
      if (
        !connected(
          input,
          channel,
          byName("ml_scoped_native_analysis"),
          channel + 1,
        )
      )
        throw new Error("Missing native audio tap");
    }
  } else {
    if (
      !serialized.includes(MIDI_CAPTURE_PATH_PLACEHOLDER) ||
      /__ABLETON(?!_AGENT_MIDI_CAPTURE_DIR__)/.test(serialized)
    )
      throw new Error("MIDI install path placeholder mismatch");
    owned(
      "capture_identity",
      `js "${MIDI_CAPTURE_PATH_PLACEHOLDER}/midi_capture_identity.js"`,
    );
    owned(
      "capture_writer",
      `node.script "${MIDI_CAPTURE_PATH_PLACEHOLDER}/midi_capture_writer.js"`,
    );
    owned(
      "capture_parser",
      `js "${MIDI_CAPTURE_PATH_PLACEHOLDER}/midi_note_parser.js"`,
    );
    const input = boxes.find((box) => box.text === "midiin")?.id;
    const output = boxes.find((box) => box.text === "midiout")?.id;
    if (
      input === undefined ||
      output === undefined ||
      !connected(input, 0, output, 0)
    )
      throw new Error("Missing MIDI pass-through");
  }
}

/** Validate portable, canonical runtime payloads before any host installation. */
export async function readIntegrationDevicePayloads(
  payloadRoot: string,
): Promise<readonly IntegrationDevicePayload[]> {
  if (
    typeof payloadRoot !== "string" ||
    !payloadRoot ||
    payloadRoot.length > 4096
  )
    throw new Error("Invalid integration payload root");
  const root = resolve(payloadRoot);
  const ids: IntegrationDeviceId[] = ["machine-listening", "midi-capture"];
  await directory(root, [INTEGRATION_PAYLOAD_MANIFEST, ...ids]);
  const manifest = record(
    JSON.parse(
      (
        await boundedFile(join(root, INTEGRATION_PAYLOAD_MANIFEST), 64 * 1024)
      ).toString("utf8"),
    ),
  );
  if (
    manifest.formatVersion !== 1 ||
    !Array.isArray(manifest.devices) ||
    manifest.devices.length !== 2
  )
    throw new Error("Invalid integration payload manifest");
  const payloads: IntegrationDevicePayload[] = [];
  for (const id of ids) {
    const matches = manifest.devices
      .map((entry: unknown) => record(entry))
      .filter((entry) => entry.id === id);
    if (matches.length !== 1)
      throw new Error("Missing/duplicate integration device");
    const entry = matches[0]!;
    const expected = INTEGRATION_DEVICE_INVENTORY[id];
    if (
      entry.deviceFile !== expected.deviceFile ||
      !Array.isArray(entry.files) ||
      entry.files.length !== expected.files.length
    )
      throw new Error("Integration device inventory mismatch");
    if (
      id === "machine-listening" &&
      (entry.nativeVersion !== 4 ||
        entry.nativeAbiVersion !== 2 ||
        entry.measurementDelivery !== "retention-v1" ||
        entry.algorithmVersion !== "2.0.0")
    )
      throw new Error("Integration native version mismatch");
    if (
      id === "midi-capture" &&
      entry.pathPlaceholder !== MIDI_CAPTURE_PATH_PLACEHOLDER
    )
      throw new Error("Integration MIDI placeholder mismatch");
    const sourceDirectory = join(root, id);
    await directory(sourceDirectory, expected.files);
    const files: { name: string; sha256: string; bytes: number }[] = [];
    const contents = new Map<string, Buffer>();
    for (const item of entry.files) {
      const file = record(item);
      if (
        typeof file.name !== "string" ||
        !expected.files.some((name) => name === file.name) ||
        files.some(({ name }) => name === file.name) ||
        typeof file.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        typeof file.bytes !== "number" ||
        file.bytes < 1 ||
        file.bytes > 8 * 1024 * 1024
      )
        throw new Error("Invalid integration file inventory");
      const raw = await boundedFile(join(sourceDirectory, file.name));
      if (
        raw.length !== file.bytes ||
        createHash("sha256").update(raw).digest("hex") !== file.sha256
      )
        throw new Error("Integration payload hash mismatch");
      files.push({ name: file.name, sha256: file.sha256, bytes: file.bytes });
      contents.set(file.name, raw);
    }
    validateWiring(contents.get(expected.deviceFile)!, id);
    if (id === "machine-listening") {
      const native = record(
        JSON.parse(
          contents.get("audio-listener-manifest.json")!.toString("utf8"),
        ),
      );
      if (
        native.nativeVersion !== 4 ||
        native.nativeAbiVersion !== 2 ||
        native.measurementDelivery !== "retention-v1" ||
        native.algorithmVersion !== "2.0.0" ||
        native.nativeMode !== true ||
        native.authored !== true ||
        native.portable !== true ||
        native.externalAuthoringBridge !== false ||
        native.discoveryConfigured !== false ||
        native.deviceFile !== expected.deviceFile
      )
        throw new Error("Invalid canonical native manifest");
      if (
        native.formatVersion !== 2 ||
        native.nativeScope !== "mode-negotiated-transport/v1" ||
        native.observationSchema !== "audio-observation/v2" ||
        native.sharedTransportProtocolVersion !== 1 ||
        !Array.isArray(native.supportedModes) ||
        !sameNames(native.supportedModes, ["arrangement", "session"]) ||
        native.modeNegotiation !== "explicit-per-pass" ||
        native.sourceEvidence !== undefined ||
        native.synchronization !== undefined ||
        native.maxDurationBeats !== undefined ||
        native.realLiveValidated !== false ||
        native.deviceSha256 !==
          files.find(({ name }) => name === expected.deviceFile)?.sha256 ||
        !Array.isArray(native.resources)
      )
        throw new Error("Invalid canonical native runtime metadata");
      const limits = record(native.providerLimits);
      if (
        limits.durationMs !== 30_000 ||
        limits.maxWindows !== 300 ||
        limits.envelopeUpdatesPerSecond !== 10
      )
        throw new Error("Invalid canonical native provider limits");
      const expectedResources = expected.files.filter(
        (name) =>
          name !== expected.deviceFile &&
          name !== "audio-listener-manifest.json",
      );
      const resources = native.resources.map((resource: unknown) =>
        record(resource),
      );
      if (
        !sameNames(
          resources.map((resource) =>
            typeof resource.name === "string" ? resource.name : "",
          ),
          expectedResources,
        )
      )
        throw new Error("Invalid canonical native resource inventory");
      for (const resource of resources) {
        const file = files.find(({ name }) => name === resource.name);
        if (
          !file ||
          file.sha256 !== resource.sha256 ||
          file.bytes !== resource.bytes
        )
          throw new Error("Canonical native resource hash mismatch");
      }
      const companionPackage = record(
        JSON.parse(contents.get("package.json")!.toString("utf8")),
      );
      if (
        companionPackage.type !== "commonjs" ||
        Object.keys(companionPackage).length !== 1
      )
        throw new Error("Native companions must remain portable CommonJS");
      if (
        !contents
          .get("audio_listener_native_v4_max.js")!
          .toString("utf8")
          .includes("nativeVersion: 4")
      )
        throw new Error("Invalid native runtime version");
    }
    payloads.push({
      id,
      sourceDirectory,
      deviceFile: expected.deviceFile,
      files,
      ...(id === "machine-listening"
        ? {
            nativeVersion: 4,
            nativeAbiVersion: 2,
            measurementDelivery: "retention-v1",
          }
        : { pathPlaceholder: MIDI_CAPTURE_PATH_PLACEHOLDER }),
    });
  }
  return payloads;
}
