import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as buildListening } from "./audio-listener-device.mjs";
import { producerCompanionSource } from "./m4l-producer-companions.mjs";
import {
  INTEGRATION_DEVICE_INVENTORY,
  INTEGRATION_PAYLOAD_MANIFEST,
  MIDI_CAPTURE_PATH_PLACEHOLDER,
  decodeAmxd,
  encodeAmxd,
  publishResources,
  readIntegrationDevicePayloads,
  renderPortableDevice,
} from "../packages/shared/dist/m4l-devices.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_INTEGRATION_PAYLOAD_ROOT = join(
  root,
  "apps/desktop/build/ableton-integrations",
);

/** Build only from tracked canonical sources. Never install or configure a profile. */
export async function buildAbletonIntegrations(
  outDirectory = DEFAULT_INTEGRATION_PAYLOAD_ROOT,
  options = {},
) {
  const destination = resolve(outDirectory);
  const source = join(root, "max-patches");
  if (
    !relative(destination, root).startsWith(`..${sep}`) ||
    destination === source ||
    destination.startsWith(`${source}${sep}`)
  )
    throw new Error(
      "Payload output must not replace repository/canonical sources",
    );
  const stage = `${destination}.staged-${randomUUID()}`;
  const backup = `${destination}.previous-${randomUUID()}`;
  const startedAt = Date.now();
  const emit = (phase, errorCode) => {
    try {
      options.onEvent?.({
        operation: "m4l.integrations.package",
        stage: phase,
        durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : {}),
        ...Object.fromEntries(
          ["traceId", "correlationId", "causationId"]
            .filter((key) => typeof options[key] === "string")
            .map((key) => [key, options[key]]),
        ),
      });
    } catch {
      /* Observers cannot interrupt publication. */
    }
  };
  const cancelled = () => options.signal?.throwIfAborted();
  emit("queued");
  let backedUp = false;
  try {
    cancelled();
    emit("started");
    try {
      const metadata = await lstat(destination);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Payload output must be a regular directory");
      const entries = await readdir(destination);
      if (entries.length && !entries.includes(INTEGRATION_PAYLOAD_MANIFEST))
        throw new Error(
          "Refusing to replace an unowned nonempty output directory",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(stage, { recursive: true });
    await buildListening(join(stage, "machine-listening"), {
      ...options,
      authoredDevicePath: join(
        source,
        "audio-listener",
        "Machine-Listening-Development.amxd",
      ),
      keepMcpBridge: false,
      nativeMode: true,
      nativeVersion: 4,
    });
    emit("progress");
    cancelled();
    const midiSource = join(source, "midi-capture");
    const midiDestination = join(stage, "midi-capture");
    const midiInventory = INTEGRATION_DEVICE_INVENTORY["midi-capture"];
    await publishResources({
      ...options,
      destinationDirectory: midiDestination,
      resources: midiInventory.files
        .filter((name) => name !== midiInventory.deviceFile)
        .map((name) => ({
          fileName: name,
          source: producerCompanionSource(name, midiSource),
        })),
    });
    const midi = decodeAmxd(
      await readFile(join(midiSource, midiInventory.deviceFile)),
    );
    await writeFile(
      join(midiDestination, midiInventory.deviceFile),
      encodeAmxd(
        midi,
        renderPortableDevice(midi.document, midiSource, {
          pathPlaceholder: MIDI_CAPTURE_PATH_PLACEHOLDER,
        }),
      ),
    );
    emit("progress");
    const devices = [];
    for (const [id, inventory] of Object.entries(
      INTEGRATION_DEVICE_INVENTORY,
    )) {
      cancelled();
      const files = [];
      for (const name of inventory.files) {
        const raw = await readFile(join(stage, id, name));
        files.push({
          name,
          sha256: createHash("sha256").update(raw).digest("hex"),
          bytes: raw.length,
        });
      }
      devices.push({
        id,
        deviceFile: inventory.deviceFile,
        files,
        ...(id === "machine-listening"
          ? {
              nativeVersion: 4,
              nativeAbiVersion: 2,
              algorithmVersion: "2.0.0",
              measurementDelivery: "retention-v1",
            }
          : { pathPlaceholder: MIDI_CAPTURE_PATH_PLACEHOLDER }),
      });
    }
    await writeFile(
      join(stage, INTEGRATION_PAYLOAD_MANIFEST),
      `${JSON.stringify({ formatVersion: 1, devices }, null, 2)}\n`,
    );
    await readIntegrationDevicePayloads(stage);
    cancelled();
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (backedUp) {
        await rename(backup, destination);
        backedUp = false;
      }
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    backedUp = false;
    emit("completed");
    return destination;
  } catch (error) {
    emit(
      options.signal?.aborted || error.name === "AbortError"
        ? "cancelled"
        : "failed",
      options.signal?.aborted ? "cancelled" : "integration-package-failed",
    );
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!backedUp) await rm(backup, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (
    argv.length !== 0 &&
    (argv.length !== 2 || argv[0] !== "--out" || !argv[1])
  )
    throw new Error(
      "Usage: node scripts/build-ableton-integrations.mjs [--out directory]",
    );
  const output = await buildAbletonIntegrations(argv[1]);
  console.log(`Built canonical Ableton integrations: ${output}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
