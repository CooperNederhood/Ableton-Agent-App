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
import {
  build as buildListening,
  checkCurrentArtifact,
} from "./audio-listener-device.mjs";
import { producerCompanionSource } from "./m4l-producer-companions.mjs";
import { createNativeRunnerLifecycle } from "./lib/native-listening-lifecycle.mjs";
import { sanitizeTelemetryAttributes } from "../packages/observability/dist/sanitizer.js";
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
  const traceId = randomUUID();
  const trace = Object.fromEntries(
    ["traceId", "correlationId", "causationId"].map((key) => [
      key,
      typeof options[key] === "string" &&
      /^[A-Za-z0-9_.:-]{1,128}$/.test(options[key])
        ? options[key]
        : traceId,
    ]),
  );
  const lifecycle = createNativeRunnerLifecycle({
    signal: options.signal,
    trace,
    sanitize: sanitizeTelemetryAttributes,
    telemetry: {
      enqueue(event) {
        try {
          options.onEvent?.({ ...event, operation: "m4l.integrations.stage" });
        } catch {
          /* Observers cannot interrupt publication. */
        }
      },
    },
  });
  const packageStage = options.stage ?? lifecycle.stage;
  const publicationOptions = { ...options, ...trace, stage: packageStage };
  const emit = (phase, errorCode) => {
    try {
      options.onEvent?.({
        operation: "m4l.integrations.package",
        stage: phase,
        durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : {}),
        ...trace,
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
    if (
      ["engineeringFixture", "engineeringOnly", "spectrumEnabled"].some(
        (field) => Object.hasOwn(options, field),
      )
    )
      throw new Error(
        "Engineering fixture selection is forbidden in production packaging",
      );
    if (
      (Object.hasOwn(options, "nativeVersion") &&
        options.nativeVersion !== 5) ||
      (Object.hasOwn(options, "nativeMode") && options.nativeMode !== true)
    )
      throw new Error("Production integration packaging requires native v5");
    if (options.reuse === true) {
      let existing = false;
      try {
        await lstat(join(destination, INTEGRATION_PAYLOAD_MANIFEST));
        existing = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing) {
        await readIntegrationDevicePayloads(destination);
        await checkCurrentArtifact(join(destination, "machine-listening"), {
          stage: packageStage,
          signal: options.signal,
        });
        cancelled();
        emit("completed");
        return destination;
      }
    }
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
    const listeningManifest = await buildListening(
      join(stage, "machine-listening"),
      {
        ...publicationOptions,
        keepMcpBridge: false,
        nativeMode: true,
        nativeVersion: 5,
        stage: packageStage,
      },
    );
    emit("progress");
    cancelled();
    const midiSource = join(source, "midi-capture");
    const midiDestination = join(stage, "midi-capture");
    const midiInventory = INTEGRATION_DEVICE_INVENTORY["midi-capture"];
    await publishResources({
      ...publicationOptions,
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
              nativeVersion: 5,
              nativeAbiVersion: 3,
              algorithmVersion: "3.0.0",
              measurementDelivery: "independent-metric-timelines/v1",
              metricProtocol: listeningManifest.metricProtocol,
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
  const reuse = argv.includes("--reuse");
  argv = argv.filter((argument) => argument !== "--reuse");
  if (
    argv.length !== 0 &&
    (argv.length !== 2 || argv[0] !== "--out" || !argv[1])
  )
    throw new Error(
      "Usage: node scripts/build-ableton-integrations.mjs [--reuse] [--out directory]",
    );
  const output = await buildAbletonIntegrations(argv[1], {
    reuse,
    onEvent: (event) => console.error(JSON.stringify(event)),
  });
  console.log(`Built canonical Ableton integrations: ${output}`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
