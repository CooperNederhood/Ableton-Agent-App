import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  dependencyInventoryHashes,
  type DependencyInventory,
  type ListenerBinding,
  bindFixtureProject,
} from "@ableton-agent/test-support/integration";
import {
  freezeAmxd,
  readIntegrationDevicePayloads,
  isFlucomaDependencyResource,
  isSafeDeviceResourceName,
  readFlucomaDependencyFile,
  assertResourceParents,
  FLUCOMA_DEPENDENCY_FILES,
} from "../../packages/shared/src/m4l-devices.js";
import { writeProducerDiscoveryConfiguration } from "../../scripts/m4l-producer-companions.mjs";

export async function provisionPackagedDependencies(options: {
  resourcesPath: string;
  workingDirectory: string;
  dependencies: readonly string[];
  storage: {
    signalIngressDescriptorPath: string;
    signalIngressSecretPath: string;
  };
  signal: AbortSignal;
  listenerBindings?: readonly ListenerBinding[];
}): Promise<{
  hashes: Readonly<Record<string, string>>;
  inventory: DependencyInventory;
}> {
  options.signal.throwIfAborted();
  const candidateRoot = join(options.resourcesPath, "ableton-integrations");
  const resources: Array<DependencyInventory["resources"][number]> = [];
  const generatedConfigurations: {
    id: string;
    target: string;
    sha256: string;
    bytes: number;
  }[] = [];
  const inventory = {
    schemaVersion: 1 as const,
    candidateRoot,
    resources,
    generatedConfigurations,
    frozenDevices: [] as Array<
      NonNullable<DependencyInventory["frozenDevices"]>[number]
    >,
  };
  let preparedProject: DependencyInventory["preparedProject"];
  if (options.dependencies.length === 0)
    return { hashes: dependencyInventoryHashes(inventory), inventory };
  const payloads = await readIntegrationDevicePayloads(candidateRoot);
  const selected = options.dependencies.map((id) => {
    const payload = payloads.find((item) => item.id === id);
    if (payload === undefined)
      throw new Error(`Unknown packaged fixture dependency: ${id}`);
    return payload;
  });
  options.signal.throwIfAborted();
  const root = join(options.workingDirectory, "dependencies");
  await mkdir(root, { mode: 0o700 });
  for (const payload of selected) {
    const destination = join(root, payload.id);
    await mkdir(destination, { mode: 0o700 });
    const resourceDestination = (name: string) =>
      join(
        destination,
        ...(payload.id === "machine-listening" &&
        isFlucomaDependencyResource(name)
          ? ["frozen"]
          : []),
        name,
      );
    for (const file of payload.files) {
      options.signal.throwIfAborted();
      if (!isSafeDeviceResourceName(file.name))
        throw new Error("Unsafe packaged dependency resource name");
      const source = join(payload.sourceDirectory, file.name);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes)
        throw new Error("Packaged dependency changed after verification");
      const bytes = isFlucomaDependencyResource(file.name)
        ? await readFlucomaDependencyFile(payload.sourceDirectory, file.name)
        : await readFile(source);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        throw new Error("Packaged dependency hash mismatch");
      const target = resourceDestination(file.name);
      const dependency = FLUCOMA_DEPENDENCY_FILES.find(
        (pin) => pin.name === file.name,
      );
      await assertResourceParents(target, true);
      options.signal.throwIfAborted();
      await writeFile(target, bytes, {
        flag: "wx",
        mode: dependency?.mode ?? 0o600,
      });
      if (dependency) await chmod(target, dependency.mode);
      resources.push({
        id: payload.id,
        path: relative(candidateRoot, source).split(sep).join("/"),
        target: relative(options.workingDirectory, target).split(sep).join("/"),
        sha256: file.sha256,
        bytes: file.bytes,
      });
    }
    await writeProducerDiscoveryConfiguration(destination, options.storage);
    const configuration = await readFile(
      join(destination, "agent_signal_storage.js"),
    );
    generatedConfigurations.push({
      id: payload.id,
      target: `dependencies/${payload.id}/agent_signal_storage.js`,
      sha256: createHash("sha256").update(configuration).digest("hex"),
      bytes: configuration.length,
    });
    if (payload.id === "machine-listening") {
      options.signal.throwIfAborted();
      const embedded = new Map<string, Uint8Array>();
      for (const file of payload.files)
        if (
          file.name !== payload.deviceFile &&
          file.name !== "audio-listener-manifest.json"
        )
          embedded.set(
            file.name,
            await readFile(resourceDestination(file.name)),
          );
      embedded.set("agent_signal_storage.js", configuration);
      const frozen = freezeAmxd(
        await readFile(join(destination, payload.deviceFile)),
        payload.deviceFile,
        embedded,
        { deviceDirectory: join(destination, "frozen") },
      );
      options.signal.throwIfAborted();
      await assertResourceParents(
        join(destination, "frozen", payload.deviceFile),
        true,
      );
      await writeFile(join(destination, "frozen", payload.deviceFile), frozen, {
        flag: "wx",
        mode: 0o600,
      });
      inventory.frozenDevices.push({
        id: payload.id,
        sourceTarget: `dependencies/${payload.id}/${payload.deviceFile}`,
        target: `dependencies/${payload.id}/frozen/${payload.deviceFile}`,
        sha256: createHash("sha256").update(frozen).digest("hex"),
        bytes: frozen.length,
      });
    }
  }
  if (options.listenerBindings?.length) {
    const bytes = bindFixtureProject(
      await readFile(join(options.workingDirectory, "project.als")),
      options.listenerBindings,
      inventory.frozenDevices,
      options.workingDirectory,
    );
    options.signal.throwIfAborted();
    await writeFile(join(options.workingDirectory, "prepared.als"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    preparedProject = {
      target: "prepared.als",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }
  options.signal.throwIfAborted();
  const result = {
    ...inventory,
    ...(preparedProject ? { preparedProject } : {}),
  };
  return { hashes: dependencyInventoryHashes(result), inventory: result };
}
