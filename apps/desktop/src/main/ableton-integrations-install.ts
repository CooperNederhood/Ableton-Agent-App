import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import {
  readIntegrationDevicePayloads,
  decodeAmxd,
  encodeAmxd,
  freezeAmxd,
  renderInstalledDevice,
  assertDeviceResourceInventory,
  FLUCOMA_DEPENDENCY_FILES,
  isFlucomaDependencyResource,
  readFlucomaDependencyFile,
  type IntegrationDevicePayload,
} from "@ableton-agent/shared/m4l-devices";
import type { LiveAgentStorageLayout } from "@ableton-agent/storage";

import { assertAbletonLive11Stopped } from "./ableton-host-process.js";
export { assertAbletonLive11Stopped } from "./ableton-host-process.js";
import {
  inspectRemoteScriptInstallation,
  installRemoteScript,
} from "./remote-script-install.js";

export type IntegrationComponent =
  "remote-script" | "machine-listening" | "midi-capture";
export interface IntegrationInstallEvent {
  readonly name: string;
  readonly stage:
    "queued" | "started" | "progress" | "completed" | "failed" | "cancelled";
  readonly component?: IntegrationComponent;
  readonly durationMs: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}
export interface IntegrationComponentOutcome {
  readonly component: IntegrationComponent;
  readonly status: "installed" | "current" | "skipped" | "planned";
  readonly destination: string;
}
export interface IntegrationFailedOutcome {
  readonly component: IntegrationComponent;
  readonly status: "failed";
  readonly destination: string;
  readonly committed: boolean;
}
export class IntegrationInstallError extends Error {
  public constructor(
    public readonly components: readonly (
      IntegrationComponentOutcome | IntegrationFailedOutcome
    )[],
    public readonly failures: readonly unknown[],
    public readonly cancelled: boolean,
  ) {
    super(
      cancelled
        ? "Integration installation cancelled"
        : "Integration installation failed",
      { cause: failures[0] },
    );
    this.name = "IntegrationInstallError";
  }
}

const metadataName = ".ableton-agent-device-install.json";
const configName = "agent_signal_storage.js";
const profileConfiguredFile = (component: IntegrationComponent, name: string) =>
  name === configName ||
  (component === "machine-listening" && name.endsWith(".amxd"));
const allComponents: readonly IntegrationComponent[] = [
  "remote-script",
  "machine-listening",
  "midi-capture",
];
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Inspect every existing ancestor, including ancestors of the selected library.
async function safePath(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new Error("Unsafe installation directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function safeTree(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
    throw new Error("Unsafe installation file");
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await safeTree(join(path, name));
  }
}

async function remoteScriptCurrent(
  source: string,
  target: string,
  version: string,
): Promise<boolean> {
  if (
    (await inspectRemoteScriptInstallation(dirname(target), version)).state !==
    "current"
  )
    return false;
  const token = join(target, ".ableton-agent-token");
  if (!(await present(token)) || ((await lstat(token)).mode & 0o777) !== 0o600)
    return false;
  const matches = async (from: string, to: string): Promise<boolean> => {
    for (const name of await readdir(from)) {
      if (
        [
          ".ableton-agent-token",
          ".ableton-agent-install.json",
          "__pycache__",
        ].includes(name) ||
        name.endsWith(".pyc")
      )
        continue;
      const sourcePath = join(from, name);
      const targetPath = join(to, name);
      if (!(await present(targetPath))) return false;
      const info = await lstat(sourcePath);
      const targetInfo = await lstat(targetPath);
      if (info.isDirectory()) {
        if (
          !targetInfo.isDirectory() ||
          !(await matches(sourcePath, targetPath))
        )
          return false;
      } else if (
        !targetInfo.isFile() ||
        digest(await readFile(sourcePath)) !==
          digest(await readFile(targetPath))
      )
        return false;
    }
    return true;
  };
  return matches(source, target);
}

interface DeviceMetadata {
  readonly formatVersion: 1;
  readonly component: IntegrationComponent;
  readonly sourceIdentity: string;
  readonly installedHashes: Readonly<Record<string, string>>;
  readonly nativeVersion?: number;
  readonly nativeAbiVersion?: number;
}

interface PreparedDevice {
  readonly files: Map<string, Uint8Array>;
  readonly metadata: DeviceMetadata;
}

async function prepareDevice(
  payload: IntegrationDevicePayload,
  target: string,
  storage: LiveAgentStorageLayout,
  freeze: (
    raw: Buffer,
    resources: ReadonlyMap<string, Uint8Array>,
  ) => Promise<Buffer> = async (raw, resources) =>
    freezeAmxd(raw, payload.deviceFile, resources, { deviceDirectory: target }),
): Promise<PreparedDevice> {
  const files = new Map<string, Uint8Array>();
  for (const file of payload.files) {
    const bytes = isFlucomaDependencyResource(file.name)
      ? await readFlucomaDependencyFile(payload.sourceDirectory, file.name)
      : await readFile(join(payload.sourceDirectory, file.name));
    if (digest(bytes) !== file.sha256 || bytes.length !== file.bytes)
      throw new Error("Payload changed during validation");
    files.set(file.name, bytes);
  }
  if (payload.pathPlaceholder !== undefined) {
    const container = decodeAmxd(Buffer.from(files.get(payload.deviceFile)!));
    files.set(
      payload.deviceFile,
      encodeAmxd(
        container,
        renderInstalledDevice(container.document, target, {
          pathPlaceholder: payload.pathPlaceholder,
        }),
      ),
    );
  }
  for (const path of [
    storage.signalIngressDescriptorPath,
    storage.signalIngressSecretPath,
  ]) {
    if (!isAbsolute(path) || path.length > 4096)
      throw new Error("Invalid signal storage path");
  }
  const configuration = Buffer.from(
    `module.exports = ${JSON.stringify({ version: 1, descriptorPath: storage.signalIngressDescriptorPath, secretPath: storage.signalIngressSecretPath })};\n`,
  );
  files.set(configName, configuration);
  if (payload.id === "machine-listening") {
    const manifestName = "audio-listener-manifest.json";
    const raw = files.get(manifestName);
    if (raw === undefined)
      throw new Error("Missing portable listener manifest");
    const value = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid portable listener manifest");
    const manifest = value as Record<string, unknown>;
    if (
      manifest.discoveryConfigured !== false ||
      !Array.isArray(manifest.resources)
    )
      throw new Error("Invalid portable listener discovery manifest");
    const resources = new Map(files);
    resources.delete(payload.deviceFile);
    resources.delete(manifestName);
    const frozen = await freeze(
      Buffer.from(files.get(payload.deviceFile)!),
      resources,
    );
    files.set(payload.deviceFile, frozen);
    files.set(
      manifestName,
      Buffer.from(
        `${JSON.stringify(
          {
            ...manifest,
            discoveryConfigured: true,
            deviceSha256: digest(frozen),
            resources: [
              ...(manifest.resources as unknown[]),
              {
                name: configName,
                sha256: digest(configuration),
                bytes: configuration.length,
                scope: "profile",
              },
            ],
          },
          undefined,
          2,
        )}\n`,
      ),
    );
  }
  return {
    files,
    metadata: {
      formatVersion: 1,
      component: payload.id,
      sourceIdentity: digest(JSON.stringify(payload.files)),
      installedHashes: Object.fromEntries(
        [...files].map(([name, bytes]) => [name, digest(bytes)]),
      ),
      ...(payload.nativeVersion === undefined
        ? {}
        : { nativeVersion: payload.nativeVersion }),
      ...(payload.nativeAbiVersion === undefined
        ? {}
        : { nativeAbiVersion: payload.nativeAbiVersion }),
    },
  };
}

async function deviceCurrent(
  path: string,
  previous: DeviceMetadata | undefined,
  expected: DeviceMetadata,
): Promise<boolean> {
  return (
    previous?.sourceIdentity === expected.sourceIdentity &&
    previous.nativeVersion === expected.nativeVersion &&
    previous.nativeAbiVersion === expected.nativeAbiVersion &&
    JSON.stringify(previous.installedHashes) ===
      JSON.stringify(expected.installedHashes) &&
    (
      await Promise.all(
        Object.keys(expected.installedHashes)
          .filter((name) => profileConfiguredFile(expected.component, name))
          .map(
            async (name) =>
              ((await lstat(join(path, name))).mode & 0o777) === 0o600,
          ),
      )
    ).every(Boolean)
  );
}

async function ownedDevice(
  path: string,
  component: IntegrationComponent,
): Promise<DeviceMetadata | undefined> {
  if (!(await present(path))) return undefined;
  await safeTree(path);
  const bytes = await readFile(join(path, metadataName));
  if (bytes.length > 128 * 1024)
    throw new Error("Invalid device ownership metadata");
  const metadata = JSON.parse(bytes.toString("utf8")) as DeviceMetadata;
  if (
    metadata.formatVersion !== 1 ||
    metadata.component !== component ||
    typeof metadata.sourceIdentity !== "string" ||
    metadata.installedHashes === null ||
    typeof metadata.installedHashes !== "object"
  ) {
    throw new Error("Unmanaged device destination");
  }
  try {
    await assertDeviceResourceInventory(path, [
      metadataName,
      ...Object.keys(metadata.installedHashes),
    ]);
  } catch {
    throw new Error("Device destination contains unrelated files");
  }
  for (const [name, hash] of Object.entries(metadata.installedHashes)) {
    const raw = isFlucomaDependencyResource(name)
      ? await readFlucomaDependencyFile(path, name)
      : await readFile(join(path, name));
    if (digest(raw) !== hash)
      throw new Error("Device destination has modified files");
  }
  return metadata;
}

function destination(library: string, component: IntegrationComponent): string {
  if (component === "remote-script")
    return join(library, "Remote Scripts", "AbletonAgent");
  return component === "machine-listening"
    ? join(
        library,
        "Presets",
        "Audio Effects",
        "Max Audio Effect",
        "Machine-Listening-Development",
      )
    : join(
        library,
        "Presets",
        "MIDI Effects",
        "Max MIDI Effect",
        "Midi-Capture",
      );
}

export async function installAbletonIntegrations(options: {
  readonly payloadDirectory: string;
  readonly remoteScriptSourcePath: string;
  readonly userLibraryPath: string;
  readonly storage: LiveAgentStorageLayout;
  readonly remoteScriptVersion: string;
  readonly confirmed: boolean;
  readonly dryRun?: boolean;
  readonly components?: readonly IntegrationComponent[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: IntegrationInstallEvent) => void;
  readonly assertHostStopped?: () => Promise<void>;
}): Promise<{ readonly components: readonly IntegrationComponentOutcome[] }> {
  const start = performance.now();
  const outcomes: (IntegrationComponentOutcome | IntegrationFailedOutcome)[] =
    [];
  const failures: unknown[] = [];
  const selected = new Set(options.components ?? allComponents);
  const library = resolve(options.userLibraryPath);
  const lock = join(library, ".ableton-agent-integrations.lock");
  let locked = false;
  let active: IntegrationComponent | undefined;
  let committed = false;
  let cancelled = false;
  const componentStarts = new Map<IntegrationComponent, number>();
  const emit = (
    name: string,
    stage: IntegrationInstallEvent["stage"],
    component?: IntegrationComponent,
    since = start,
    attributes?: Readonly<Record<string, unknown>>,
  ) => {
    options.onEvent?.({
      name: `integrations.${name}`,
      stage,
      ...(component === undefined ? {} : { component }),
      durationMs: Math.max(0, performance.now() - since),
      ...(attributes === undefined ? {} : { attributes }),
    });
  };
  const check = () => {
    if (options.signal?.aborted) {
      cancelled = true;
      throw new Error("Installation cancelled");
    }
  };
  const stage = async <T>(
    name: string,
    component: IntegrationComponent | undefined,
    action: (
      progress: (attributes: Readonly<Record<string, unknown>>) => void,
    ) => Promise<T>,
  ): Promise<T> => {
    const since = performance.now();
    emit(name, "queued", component, since);
    emit(name, "started", component, since);
    try {
      const value = await action((attributes) =>
        emit(name, "progress", component, since, attributes),
      );
      emit(name, "completed", component, since);
      return value;
    } catch (error) {
      try {
        emit(
          name,
          cancelled && !committed ? "cancelled" : "failed",
          component,
          since,
        );
      } catch (eventError) {
        failures.push(eventError);
      }
      throw error;
    }
  };
  const cleanup = async (
    component: IntegrationComponent | undefined,
    action: () => Promise<void>,
  ) => {
    const since = performance.now();
    const report = (eventStage: IntegrationInstallEvent["stage"]) => {
      try {
        emit("cleanup", eventStage, component, since);
      } catch (error) {
        failures.push(error);
      }
    };
    report("queued");
    report("started");
    try {
      await action();
      report("completed");
    } catch (error) {
      failures.push(error);
      report("failed");
    }
  };
  try {
    emit("install", "queued");
    emit("install", "started");
    check();
    if (!options.confirmed && !options.dryRun)
      throw new Error(
        "Explicit integration installation confirmation is required",
      );
    if (!isAbsolute(options.userLibraryPath) || dirname(library) === library)
      throw new Error("Select an absolute User Library directory");
    if ([...selected].some((component) => !allComponents.includes(component)))
      throw new Error("Unknown integration component");
    await stage("validation", undefined, async () => {
      if (!options.dryRun)
        await (options.assertHostStopped ?? assertAbletonLive11Stopped)();
      await safePath(library);
    });
    const payloads = [...selected].some(
      (component) => component !== "remote-script",
    )
      ? await stage("payload-validation", undefined, () =>
          readIntegrationDevicePayloads(options.payloadDirectory),
        )
      : [];
    const prepared = new Map<IntegrationComponent, PreparedDevice>();
    for (const component of allComponents.filter((item) =>
      selected.has(item),
    )) {
      active = component;
      await stage("validation", component, async () => {
        const target = destination(library, component);
        await safePath(target);
        if (component === "remote-script") {
          await safeTree(options.remoteScriptSourcePath);
          const init = await lstat(
            join(options.remoteScriptSourcePath, "__init__.py"),
          );
          if (!init.isFile())
            throw new Error("Missing Remote Script entry point");
          if (await present(target)) {
            await safeTree(target);
            const token = join(target, ".ableton-agent-token");
            if (await present(token)) {
              const info = await lstat(token);
              if (!info.isFile() || info.size < 1 || info.size > 4096)
                throw new Error("Invalid Remote Script token file");
            }
            const inspection = await inspectRemoteScriptInstallation(
              dirname(target),
              options.remoteScriptVersion,
            );
            if (inspection.state === "unmanaged")
              throw new Error("Unmanaged Remote Script destination");
          }
          await safePath(join(dirname(target), ".ableton-agent-backups"));
          return;
        }
        const payload = payloads.find((item) => item.id === component);
        if (payload === undefined) throw new Error("Missing device payload");
        const item = await prepareDevice(
          payload,
          target,
          options.storage,
          (raw, resources) =>
            stage("freeze", component, async (progress) => {
              check();
              const frozen = freezeAmxd(raw, payload.deviceFile, resources, {
                deviceDirectory: target,
              });
              const adjacentDependencyFiles = [...resources.keys()].filter(
                isFlucomaDependencyResource,
              ).length;
              progress({
                embeddedFiles: resources.size - adjacentDependencyFiles + 1,
                ...(adjacentDependencyFiles ? { adjacentDependencyFiles } : {}),
                bytes: frozen.length,
              });
              check();
              return frozen;
            }),
        );
        await ownedDevice(target, component);
        prepared.set(component, item);
      });
    }
    active = undefined;
    check();
    if (options.dryRun) {
      for (const component of allComponents) {
        const target = destination(library, component);
        let current = false;
        if (selected.has(component)) {
          if (component === "remote-script")
            current = await remoteScriptCurrent(
              options.remoteScriptSourcePath,
              target,
              options.remoteScriptVersion,
            );
          else {
            const previous = await ownedDevice(target, component);
            const expected = prepared.get(component)!.metadata;
            current = await deviceCurrent(target, previous, expected);
          }
        }
        outcomes.push({
          component,
          status: current
            ? "current"
            : selected.has(component)
              ? "planned"
              : "skipped",
          destination: target,
        });
      }
      emit("install", "completed", undefined, start, { dryRun: true });
      return { components: outcomes as IntegrationComponentOutcome[] };
    }
    await safePath(library);
    await mkdir(library, { recursive: true });
    await stage("lock", undefined, async () => {
      await mkdir(lock, { mode: 0o700 });
      locked = true;
    });
    for (const component of allComponents) {
      active = component;
      committed = false;
      const target = destination(library, component);
      if (!selected.has(component)) {
        outcomes.push({ component, status: "skipped", destination: target });
        continue;
      }
      const componentStart = performance.now();
      componentStarts.set(component, componentStart);
      emit("component", "queued", component, componentStart);
      emit("component", "started", component, componentStart);
      check();
      await safePath(target);
      if (component === "remote-script") {
        await safeTree(options.remoteScriptSourcePath);
        if (await present(target)) {
          await safeTree(target);
          if (
            (
              await inspectRemoteScriptInstallation(
                dirname(target),
                options.remoteScriptVersion,
              )
            ).state === "unmanaged"
          )
            throw new Error("Unmanaged Remote Script destination");
        }
        if (
          await remoteScriptCurrent(
            options.remoteScriptSourcePath,
            target,
            options.remoteScriptVersion,
          )
        ) {
          outcomes.push({ component, status: "current", destination: target });
          emit("component", "completed", component, componentStart, {
            status: "current",
          });
          continue;
        }
        const snapshot = join(
          dirname(target),
          `.ableton-agent-source-${randomUUID()}`,
        );
        try {
          await stage("staging", component, async (progress) => {
            check();
            await mkdir(dirname(target), { recursive: true });
            await cp(options.remoteScriptSourcePath, snapshot, {
              recursive: true,
              errorOnExist: true,
              force: false,
              filter: (path) => {
                const name = path.split(/[\\/]/u).at(-1);
                return (
                  name !== ".ableton-agent-token" &&
                  name !== ".ableton-agent-install.json" &&
                  name !== "__pycache__" &&
                  !path.endsWith(".pyc")
                );
              },
            });
            await safeTree(snapshot);
            progress({ files: (await readdir(snapshot)).length });
          });
          await stage("publication", component, async () => {
            await (options.assertHostStopped ?? assertAbletonLive11Stopped)();
            check();
            await safePath(join(dirname(target), ".ableton-agent-backups"));
            await installRemoteScript({
              sourcePath: snapshot,
              remoteScriptsPath: dirname(target),
              version: options.remoteScriptVersion,
            });
            committed = true;
            outcomes.push({
              component,
              status: "installed",
              destination: target,
            });
          });
          await stage("verification", component, async () => {
            if (
              !(await remoteScriptCurrent(
                snapshot,
                target,
                options.remoteScriptVersion,
              ))
            )
              throw new Error("Remote Script verification failed");
          });
        } finally {
          await cleanup(component, () =>
            rm(snapshot, { recursive: true, force: true }),
          );
        }
        if (failures.length > 0) throw new Error("Integration cleanup failed");
        emit("component", "completed", component, componentStart, {
          status: "installed",
        });
        continue;
      }
      const item = prepared.get(component)!;
      const previous = await ownedDevice(target, component);
      if (await deviceCurrent(target, previous, item.metadata)) {
        outcomes.push({ component, status: "current", destination: target });
        emit("component", "completed", component, componentStart, {
          status: "current",
        });
        continue;
      }
      const staging = join(
        dirname(target),
        `.ableton-agent-stage-${randomUUID()}`,
      );
      const backup = join(
        dirname(target),
        `.ableton-agent-previous-${randomUUID()}`,
      );
      let moved = false;
      let verified = false;
      try {
        await stage("staging", component, async (progress) => {
          check();
          await mkdir(dirname(target), { recursive: true });
          await mkdir(staging, { mode: 0o700 });
          for (const [name, bytes] of item.files) {
            const dependency = FLUCOMA_DEPENDENCY_FILES.find(
              (file) => file.name === name,
            );
            if (dependency)
              await mkdir(dirname(join(staging, name)), { recursive: true });
            await writeFile(join(staging, name), bytes, {
              mode: profileConfiguredFile(component, name)
                ? 0o600
                : (dependency?.mode ?? 0o644),
              flag: "wx",
            });
          }
          await writeFile(
            join(staging, metadataName),
            `${JSON.stringify(item.metadata)}\n`,
            { mode: 0o600, flag: "wx" },
          );
          await ownedDevice(staging, component);
          progress({ files: item.files.size });
        });
        await stage("publication", component, async () => {
          await (options.assertHostStopped ?? assertAbletonLive11Stopped)();
          check();
          await safePath(target);
          await ownedDevice(target, component);
          if (await present(target)) {
            await rename(target, backup);
            moved = true;
          }
          try {
            await rename(staging, target);
          } catch (error) {
            if (moved) {
              try {
                await rename(backup, target);
                moved = false;
              } catch (rollbackError) {
                failures.push(rollbackError);
              }
            }
            throw error;
          }
          committed = true;
          outcomes.push({
            component,
            status: "installed",
            destination: target,
          });
        });
        await stage("verification", component, async () => {
          await ownedDevice(target, component);
        });
        verified = true;
      } finally {
        await cleanup(component, async () => {
          await rm(staging, { recursive: true, force: true });
          if (verified && moved)
            await rm(backup, { recursive: true, force: true });
        });
      }
      if (failures.length > 0) throw new Error("Integration cleanup failed");
      emit("component", "completed", component, componentStart, {
        status: "installed",
      });
    }
    active = undefined;
  } catch (error) {
    failures.unshift(error);
    if (active !== undefined) {
      const failed: IntegrationFailedOutcome = {
        component: active,
        status: "failed",
        destination: destination(library, active),
        committed,
      };
      const index = outcomes.findIndex((item) => item.component === active);
      if (index < 0) outcomes.push(failed);
      else outcomes[index] = failed;
      try {
        if (componentStarts.has(active)) {
          emit(
            "component",
            cancelled && !committed ? "cancelled" : "failed",
            active,
            componentStarts.get(active),
          );
        }
      } catch (eventError) {
        failures.push(eventError);
      }
    }
  } finally {
    if (locked) {
      await cleanup(undefined, () => rm(lock, { recursive: true }));
    }
  }
  try {
    emit(
      "install",
      failures.length > 0 ? (cancelled ? "cancelled" : "failed") : "completed",
    );
  } catch (error) {
    failures.push(error);
    try {
      emit("install", "failed");
    } catch (eventError) {
      failures.push(eventError);
    }
  }
  if (failures.length > 0)
    throw new IntegrationInstallError(outcomes, failures, cancelled);
  return { components: outcomes as IntegrationComponentOutcome[] };
}

export interface IntegrationComponentInspection {
  readonly component: IntegrationComponent;
  readonly status:
    "installed" | "missing" | "current" | "outdated" | "unmanaged";
  readonly destination: string;
}

export async function inspectAbletonIntegrations(
  options: Pick<
    Parameters<typeof installAbletonIntegrations>[0],
    | "payloadDirectory"
    | "remoteScriptSourcePath"
    | "userLibraryPath"
    | "storage"
    | "remoteScriptVersion"
  >,
): Promise<{ readonly components: readonly IntegrationComponentInspection[] }> {
  try {
    const library = resolve(options.userLibraryPath);
    if (!isAbsolute(options.userLibraryPath) || dirname(library) === library)
      throw new Error("Select an absolute User Library directory");
    await safePath(library);
    const payloads = await readIntegrationDevicePayloads(
      options.payloadDirectory,
    );
    await safeTree(options.remoteScriptSourcePath);
    if (
      !(
        await lstat(join(options.remoteScriptSourcePath, "__init__.py"))
      ).isFile()
    )
      throw new Error("Missing Remote Script entry point");
    const expected = new Map<IntegrationComponent, PreparedDevice>();
    for (const component of allComponents) {
      if (component === "remote-script") continue;
      const payload = payloads.find((item) => item.id === component);
      if (payload === undefined) throw new Error("Missing device payload");
      expected.set(
        component,
        await prepareDevice(
          payload,
          destination(library, component),
          options.storage,
        ),
      );
    }
    const components: IntegrationComponentInspection[] = [];
    for (const component of allComponents) {
      const target = destination(library, component);
      let status: IntegrationComponentInspection["status"];
      try {
        await safePath(target);
        if (!(await present(target))) status = "missing";
        else if (component === "remote-script") {
          await safeTree(target);
          const remote = await inspectRemoteScriptInstallation(
            dirname(target),
            options.remoteScriptVersion,
          );
          status =
            remote.state === "unmanaged"
              ? "unmanaged"
              : (await remoteScriptCurrent(
                    options.remoteScriptSourcePath,
                    target,
                    options.remoteScriptVersion,
                  ))
                ? "current"
                : "outdated";
        } else {
          const previous = await ownedDevice(target, component);
          status = (await deviceCurrent(
            target,
            previous,
            expected.get(component)!.metadata,
          ))
            ? "current"
            : "outdated";
        }
      } catch {
        status = "unmanaged";
      }
      components.push({ component, status, destination: target });
    }
    return { components };
  } catch (error) {
    throw new IntegrationInstallError([], [error], false);
  }
}
