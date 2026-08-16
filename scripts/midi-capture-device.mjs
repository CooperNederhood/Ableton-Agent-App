import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEVICE_FILE_NAME = "midi-capture.amxd";
export const DEVICE_DIRECTORY_PARTS = [
  "Presets",
  "MIDI Effects",
  "Max MIDI Effect",
];
export const PATH_PLACEHOLDER = "__ABLETON_AGENT_MIDI_CAPTURE_DIR__";
export const COMPANION_FILES = [
  "midi_note_parser.js",
  "midi_capture_identity.js",
  "midi_capture_writer.js",
  "agent_signal_client.js",
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const canonicalDirectory = join(repositoryRoot, "max-patches", "midi-capture");
const canonicalDevice = join(canonicalDirectory, "Midi-Capture.amxd");
const metadataFileName = ".ableton-agent-midi-capture.json";

function uint32LittleEndian(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

export function decodeAmxd(raw) {
  const marker = raw.indexOf(Buffer.from("ptch"));
  if (marker < 0) {
    throw new Error("AMXD does not contain a ptch chunk");
  }
  const size = raw.readUInt32LE(marker + 4);
  const payloadStart = marker + 8;
  const payloadEnd = payloadStart + size;
  if (payloadEnd > raw.length) {
    throw new Error("AMXD ptch chunk is truncated");
  }
  const payload = raw.subarray(payloadStart, payloadEnd);
  if (payload.subarray(0, 4).toString("ascii") === "mx@c") {
    throw new Error(
      "Compressed AMXD ptch chunks are not supported by the publisher",
    );
  }
  const json = payload.subarray(
    0,
    payload.length - (payload.at(-1) === 0 ? 1 : 0),
  );
  return {
    document: JSON.parse(json.toString("utf8")),
    prefix: raw.subarray(0, marker + 4),
    suffix: raw.subarray(payloadEnd),
  };
}

export function encodeAmxd(container, document) {
  const json = Buffer.from(
    `${JSON.stringify(document, null, "\t")}\n\0`,
    "utf8",
  );
  return Buffer.concat([
    container.prefix,
    uint32LittleEndian(json.length),
    json,
    container.suffix,
  ]);
}

function mapStrings(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    return value.map((entry) => mapStrings(entry, transform));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        mapStrings(entry, transform),
      ]),
    );
  }
  return value;
}

function stripMcpBridge(document) {
  const patcher = document?.patcher;
  if (!patcher || !Array.isArray(patcher.boxes)) return document;
  const bridgeIds = new Set(
    patcher.boxes
      .filter(({ box }) => box?.text === "mcp_bridge")
      .map(({ box }) => box.id),
  );
  if (bridgeIds.size === 0) return document;
  return {
    ...document,
    patcher: {
      ...patcher,
      boxes: patcher.boxes.filter(({ box }) => !bridgeIds.has(box?.id)),
      lines: Array.isArray(patcher.lines)
        ? patcher.lines.filter(({ patchline }) => {
            const source = patchline?.source?.[0];
            const destination = patchline?.destination?.[0];
            return !bridgeIds.has(source) && !bridgeIds.has(destination);
          })
        : patcher.lines,
      dependency_cache: Array.isArray(patcher.dependency_cache)
        ? patcher.dependency_cache.filter((dependency) => {
            const serialized = JSON.stringify(dependency);
            return (
              !serialized.includes("mcp_bridge") &&
              !serialized.includes("m4l_mcp")
            );
          })
        : patcher.dependency_cache,
    },
  };
}

export function normalizeValidatedDevice(document, sourceDirectory) {
  const source = normalize(sourceDirectory);
  const slashSource = source.replaceAll("\\", "/");
  const portable = mapStrings(document, (value) =>
    value
      .replaceAll(source, PATH_PLACEHOLDER)
      .replaceAll(slashSource, PATH_PLACEHOLDER),
  );
  return stripMcpBridge(portable);
}

export function renderInstalledDevice(document, destinationDirectory) {
  const destination = normalize(destinationDirectory).replaceAll("\\", "/");
  return mapStrings(document, (value) =>
    value.replaceAll(PATH_PLACEHOLDER, destination),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (name === "dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

export function defaultUserLibraryCandidates(options = {}) {
  const home = options.homeDirectory ?? homedir();
  const environment = options.environment ?? process.env;
  return [
    environment.ABLETON_USER_LIBRARY,
    process.platform === "darwin"
      ? join(home, "Music", "Ableton", "User Library")
      : undefined,
    process.platform === "darwin"
      ? join(home, "Documents", "Ableton", "User Library")
      : undefined,
    process.platform === "win32"
      ? join(home, "Documents", "Ableton", "User Library")
      : undefined,
    process.platform === "win32" && environment.OneDrive
      ? join(environment.OneDrive, "Documents", "Ableton", "User Library")
      : undefined,
  ].filter(Boolean);
}

async function resolveUserLibrary(explicitPath) {
  if (explicitPath) return resolve(explicitPath);
  for (const candidate of defaultUserLibraryCandidates()) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(
    "No Ableton User Library was detected; pass --user-library <path> or set ABLETON_USER_LIBRARY",
  );
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function promote(options) {
  const sourcePath = resolve(
    options.source ??
      join(
        await resolveUserLibrary(options["user-library"]),
        ...DEVICE_DIRECTORY_PARTS,
        DEVICE_FILE_NAME,
      ),
  );
  if (!(await exists(sourcePath))) {
    throw new Error(`Validated MIDI Capture device not found: ${sourcePath}`);
  }
  const sourceDirectory = dirname(sourcePath);
  const raw = await readFile(sourcePath);
  const container = decodeAmxd(raw);
  const portable = normalizeValidatedDevice(
    container.document,
    sourceDirectory,
  );
  const encoded = encodeAmxd(container, portable);
  for (const fileName of COMPANION_FILES) {
    const source = join(sourceDirectory, fileName);
    if (!(await exists(source))) {
      throw new Error(`Missing validated companion script: ${source}`);
    }
  }
  if (!options.dryRun) {
    await atomicWrite(canonicalDevice, encoded);
    for (const fileName of COMPANION_FILES) {
      const source = join(sourceDirectory, fileName);
      await copyFile(source, join(canonicalDirectory, fileName));
    }
  }
  console.log(
    `${options.dryRun ? "Would promote" : "Promoted"} ${sourcePath} -> ${canonicalDevice}`,
  );
}

async function checkCanonical() {
  const raw = await readFile(canonicalDevice);
  const { document } = decodeAmxd(raw);
  const serialized = JSON.stringify(document);
  if (!serialized.includes(PATH_PLACEHOLDER)) {
    throw new Error(
      "Canonical AMXD does not contain the install path placeholder",
    );
  }
  if (serialized.includes("mcp_bridge")) {
    throw new Error("Canonical AMXD still contains the development MCP bridge");
  }
  if (/\/Users\/|[A-Za-z]:[\\/]/.test(serialized)) {
    throw new Error("Canonical AMXD contains an absolute machine path");
  }
  for (const fileName of COMPANION_FILES) {
    if (!(await exists(join(canonicalDirectory, fileName)))) {
      throw new Error(`Canonical companion script is missing: ${fileName}`);
    }
  }
  console.log("Canonical MIDI Capture device is portable and complete.");
}

async function install(options) {
  await checkCanonical();
  const userLibrary = await resolveUserLibrary(options["user-library"]);
  const destinationDirectory = join(userLibrary, ...DEVICE_DIRECTORY_PARTS);
  const destinationDevice = join(destinationDirectory, DEVICE_FILE_NAME);
  const raw = await readFile(canonicalDevice);
  const container = decodeAmxd(raw);
  const installed = renderInstalledDevice(
    container.document,
    destinationDirectory,
  );
  const encoded = encodeAmxd(container, installed);
  if (!options.dryRun) {
    await mkdir(destinationDirectory, { recursive: true });
    for (const fileName of COMPANION_FILES) {
      await copyFile(
        join(canonicalDirectory, fileName),
        join(destinationDirectory, fileName),
      );
    }
    await atomicWrite(destinationDevice, encoded);
    await atomicWrite(
      join(destinationDirectory, metadataFileName),
      `${JSON.stringify(
        {
          formatVersion: 1,
          installedAt: new Date().toISOString(),
          deviceFile: basename(destinationDevice),
          canonicalSha256: sha256(raw),
          installedSha256: sha256(encoded),
        },
        null,
        2,
      )}\n`,
    );
  }
  console.log(
    `${options.dryRun ? "Would install" : "Installed"} MIDI Capture at ${destinationDevice}`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "promote") return promote(options);
  if (command === "install") return install(options);
  if (command === "check") return checkCanonical();
  throw new Error(
    "Usage: midi-capture-device.mjs <promote|install|check> [--source path] [--user-library path] [--dry-run]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
