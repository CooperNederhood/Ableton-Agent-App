import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { publishResources } from "./max-device-publisher.mjs";
export {
  decodeAmxd,
  encodeAmxd,
  renderPortableDevice,
  renderInstalledDevice,
  publishResources,
} from "./max-device-publisher.mjs";

export const SHARED_PRODUCER_COMPANION = "agent_signal_client_common.js";
export const SHARED_PRODUCER_IDENTITY = "producer_identity_common.js";
const sharedRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../max-patches/shared",
);

export function producerCompanionSource(fileName, deviceSourceDirectory) {
  if (
    fileName === SHARED_PRODUCER_IDENTITY ||
    fileName === "midi_capture_identity.js"
  )
    return join(sharedRoot, "producer_identity.js");
  return fileName === SHARED_PRODUCER_COMPANION
    ? join(sharedRoot, "agent_signal_client.js")
    : join(deviceSourceDirectory, fileName);
}

export async function copySharedProducerCompanions(
  destinationDirectory,
  options = {},
) {
  const fileNames = [
    SHARED_PRODUCER_COMPANION,
    ...(options.includeIdentity === false ? [] : [SHARED_PRODUCER_IDENTITY]),
  ];
  await publishResources({
    ...options,
    destinationDirectory,
    resources: fileNames.map((fileName) => ({
      fileName,
      source: producerCompanionSource(fileName, sharedRoot),
    })),
  });
}

export async function writeProducerDiscoveryConfiguration(
  destinationDirectory,
  storage,
) {
  const { signalIngressDescriptorPath, signalIngressSecretPath } = storage;
  if (
    ![signalIngressDescriptorPath, signalIngressSecretPath].every(
      (value) =>
        typeof value === "string" && isAbsolute(value) && value.length <= 4096,
    )
  ) {
    throw new Error(
      "Producer discovery must use absolute paths from the shared storage resolver",
    );
  }
  await mkdir(destinationDirectory, { recursive: true });
  const destination = join(destinationDirectory, "agent_signal_storage.js");
  const staged = `${destination}.staged-${randomUUID()}`;
  try {
    await writeFile(
      staged,
      `/* global module */\nmodule.exports = ${JSON.stringify(
        {
          version: 1,
          descriptorPath: signalIngressDescriptorPath,
          secretPath: signalIngressSecretPath,
        },
        null,
        2,
      )};\n`,
      { mode: 0o600 },
    );
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
}

export async function resolveProducerDiscoveryStorage(options = {}) {
  let resolver;
  try {
    resolver = await import("../packages/storage/dist/index.js");
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(
      "Build @ableton-agent/storage before installing producers: pnpm --filter @ableton-agent/storage build",
    );
  }
  const storage = resolver.resolveLiveAgentStorage(options);
  if (!storage.signalIngressDescriptorPath || !storage.signalIngressSecretPath)
    throw new Error(
      "Shared storage resolver does not expose producer discovery paths; rebuild @ableton-agent/storage",
    );
  return storage;
}
