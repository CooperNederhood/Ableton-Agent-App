import { Buffer } from "node:buffer";
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  stat,
  mkdir,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize, parse, resolve } from "node:path";
import {
  decodeMaxCollective,
  encodeMaxCollective,
  type FrozenMaxFile,
} from "./max-collective.js";
import {
  assertResourceParents,
  FLUCOMA_DEPENDENCY_FILES,
  FLUCOMA_DEPENDENCY_DIRECTORY,
  isFlucomaDependencyResource,
  isSafeDeviceResourceName,
  readFlucomaDependencyFile,
  validateFlucomaDependencyBytes,
} from "./flucoma-dependency.js";

export type MaxValue =
  string | number | boolean | null | MaxValue[] | { [key: string]: MaxValue };
export interface AmxdContainer {
  readonly document: MaxValue;
  readonly prefix: Buffer;
  readonly suffix: Buffer;
  readonly frozenFiles?: readonly FrozenMaxFile[];
}

export interface DeviceDependencyBinding {
  /** Actual final device directory, never a publication staging directory. */
  readonly deviceDirectory?: string;
}

function dependencyBindingRequired(
  resources: ReadonlyMap<string, Uint8Array>,
): boolean {
  const names = [...resources.keys()].filter(isFlucomaDependencyResource);
  if (!names.length) return false;
  if (names.length !== FLUCOMA_DEPENDENCY_FILES.length)
    throw new Error("Missing pinned adjacent FluCoMa dependency resources");
  for (const name of names)
    validateFlucomaDependencyBytes(name, resources.get(name)!);
  return true;
}

/** Bind only the project-local dependency search; never edit Max global paths. */
export function bindFlucomaDependencyPaths(
  document: MaxValue,
  options: DeviceDependencyBinding,
): MaxValue {
  const directory = options.deviceDirectory;
  if (
    typeof directory !== "string" ||
    directory.length > 4096 ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory === parse(directory).root ||
    /[\0\r\n]/u.test(directory)
  )
    throw new Error(
      "Explicit final device directory required for pinned FluCoMa resources",
    );
  const root = object(document);
  const patcher = object(root?.patcher);
  if (!root || !patcher) throw new Error("Missing device patcher");
  return {
    ...root,
    patcher: {
      ...patcher,
      project: {
        ...object(patcher.project),
        searchpath: {
          "0": {
            bootpath: join(directory, FLUCOMA_DEPENDENCY_DIRECTORY).replaceAll(
              "\\",
              "/",
            ),
            label: "Bundled FluCoMa",
            recursive: 0,
            enabled: 1,
            includeincollective: 0,
          },
        },
      },
    },
  };
}

/** Derive an unfrozen device while leaving its portable source untouched. */
export function bindAmxdDependencyPaths(
  raw: Buffer,
  resources: ReadonlyMap<string, Uint8Array>,
  options: DeviceDependencyBinding = {},
): Buffer {
  if (!dependencyBindingRequired(resources)) return raw;
  const container = decodeAmxd(raw);
  if (container.frozenFiles)
    throw new Error("Dependency binding requires an unfrozen source device");
  return encodeAmxd(
    container,
    bindFlucomaDependencyPaths(container.document, options),
  );
}

export function decodeAmxd(raw: Buffer): AmxdContainer {
  const marker = raw.indexOf(Buffer.from("ptch"));
  if (marker < 0) throw new Error("AMXD does not contain a ptch chunk");
  if (marker + 8 > raw.length) throw new Error("AMXD ptch header is truncated");
  const end = marker + 8 + raw.readUInt32LE(marker + 4);
  if (end > raw.length) throw new Error("AMXD ptch chunk is truncated");
  const payload = raw.subarray(marker + 8, end);
  const frozenFiles =
    payload.subarray(0, 4).toString("ascii") === "mx@c"
      ? decodeMaxCollective(payload)
      : undefined;
  const patcher = frozenFiles?.[0]?.data ?? payload;
  return {
    document: JSON.parse(
      patcher
        .subarray(0, patcher.length - (patcher.at(-1) === 0 ? 1 : 0))
        .toString("utf8"),
    ) as MaxValue,
    prefix: raw.subarray(0, marker + 4),
    suffix: raw.subarray(end),
    ...(frozenFiles === undefined ? {} : { frozenFiles }),
  };
}

export function encodeAmxd(
  container: Pick<AmxdContainer, "prefix" | "suffix" | "frozenFiles">,
  document: MaxValue,
): Buffer {
  const json = Buffer.from(
    `${JSON.stringify(document, null, "\t")}\n\0`,
    "utf8",
  );
  const payload = container.frozenFiles
    ? encodeMaxCollective(
        container.frozenFiles.map((file, index) =>
          index === 0 ? { ...file, data: json } : file,
        ),
      )
    : json;
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([container.prefix, size, payload, container.suffix]);
}

/** Freeze an explicit, complete bundle; never guess dependencies from search paths. */
export function freezeAmxd(
  raw: Buffer,
  deviceFile: string,
  resources: ReadonlyMap<string, Uint8Array>,
  options: DeviceDependencyBinding = {},
): Buffer {
  if (
    resources.size >= 512 ||
    raw.length +
      [...resources.values()].reduce(
        (sum, bytes) => sum + bytes.byteLength,
        0,
      ) >
      64 * 1024 * 1024
  )
    throw new Error("Frozen bundle exceeds file or byte bound");
  const container = decodeAmxd(raw);
  if (container.frozenFiles) throw new Error("Device is already frozen");
  if (
    raw.toString("ascii", 0, 4) !== "ampf" ||
    raw.readUInt32LE(4) !== 4 ||
    !["aaaa", "mmmm", "iiii"].includes(raw.toString("ascii", 8, 12))
  )
    throw new Error("Unsupported AMXD wrapper for freezing");
  const hasDependencies = dependencyBindingRequired(resources);
  const boundDocument = hasDependencies
    ? bindFlucomaDependencyPaths(container.document, options)
    : container.document;
  const root = object(boundDocument);
  const patcher = object(root?.patcher);
  if (!root || !patcher) throw new Error("Missing device patcher");
  const nodeScripts = new Set<string>();
  const pending: MaxValue[] = [container.document];
  while (pending.length) {
    const value = pending.pop()!;
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") {
      if (
        typeof value.text === "string" &&
        /^(?:fluid\.spectralshape|listener\.mel)~(?:\s|$)/u.test(value.text) &&
        !hasDependencies
      )
        throw new Error("Missing pinned adjacent FluCoMa dependency resources");
      if (
        typeof value.text === "string" &&
        value.text.startsWith("node.script ")
      ) {
        const match = /^node\.script\s+(?:"([^"]+)"|(\S+))/u.exec(value.text);
        const name = match?.[1] ?? match?.[2];
        if (!name || !resources.has(name))
          throw new Error("Missing frozen Node script dependency");
        nodeScripts.add(name);
      }
      pending.push(...Object.values(value));
    }
  }
  // Native signed bundles remain explicit adjacent files, not TEXT entries.
  const files: FrozenMaxFile[] = [...resources]
    .filter(([name]) => !isFlucomaDependencyResource(name))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, bytes]) => ({
      name,
      type:
        name.endsWith(".maxpat") || name.endsWith(".json")
          ? "JSON"
          : name.endsWith(".gendsp")
            ? "gDSP"
            : "TEXT",
      // Node cannot require archive-only entries; Max extracts only flag-8 files.
      flags: nodeScripts.size > 0 && /\.(?:[cm]?js|json)$/u.test(name) ? 8 : 0,
      data: Buffer.from(bytes),
    }));
  // Max requires project metadata in the main patcher of a collective.
  const document: MaxValue = {
    ...root,
    patcher: {
      ...patcher,
      project: {
        version: 1,
        creationdate: 2_082_844_800,
        modificationdate: 2_082_844_800,
        viewrect: [0, 0, 300, 500],
        autoorganize: 1,
        hideprojectwindow: 1,
        showdependencies: 1,
        autolocalize: 0,
        contents: { patchers: {}, media: {}, other: {} },
        layout: {},
        searchpath: {},
        detailsvisible: 0,
        amxdtype: raw.readUInt32BE(8),
        readonly: 1,
        devpathtype: 0,
        devpath: ".",
        sortmode: 0,
        viewmode: 0,
        includepackages: 0,
        ...object(patcher.project),
      },
    },
  };
  let prefix = Buffer.from(container.prefix);
  let metadata = false;
  for (let offset = 0; offset < prefix.length - 4;) {
    if (offset + 8 > prefix.length)
      throw new Error("Invalid AMXD wrapper chunk");
    const length = prefix.readUInt32LE(offset + 4);
    if (length > prefix.length - offset - 8)
      throw new Error("Invalid AMXD wrapper chunk");
    if (prefix.toString("ascii", offset, offset + 4) === "meta") {
      if (metadata || length !== 4) throw new Error("Invalid AMXD metadata");
      prefix.writeUInt32LE(7, offset + 8);
      metadata = true;
    }
    offset += length + 8;
  }
  if (!metadata) {
    const chunk = Buffer.alloc(12);
    chunk.write("meta", "ascii");
    chunk.writeUInt32LE(4, 4);
    chunk.writeUInt32LE(7, 8);
    prefix = Buffer.concat([
      prefix.subarray(0, -4),
      chunk,
      Buffer.from("ptch"),
    ]);
  }
  return encodeAmxd(
    {
      prefix,
      suffix: container.suffix,
      frozenFiles: [
        { name: deviceFile, type: "JSON", flags: 17, data: Buffer.alloc(0) },
        ...files,
      ],
    },
    document,
  );
}

function mapStrings(
  value: MaxValue,
  transform: (text: string) => string,
): MaxValue {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value))
    return value.map((entry) => mapStrings(entry, transform));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        mapStrings(entry, transform),
      ]),
    );
  return value;
}

function object(
  value: MaxValue | undefined,
): { [key: string]: MaxValue } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function stripMcpBridge(document: MaxValue): MaxValue {
  const root = object(document);
  const patcher = object(root?.patcher);
  if (!root || !patcher || !Array.isArray(patcher.boxes)) return document;
  const bridgeIds = new Set(
    patcher.boxes.flatMap((entry) => {
      const box = object(object(entry)?.box);
      return box?.text === "mcp_bridge" ? [box.id] : [];
    }),
  );
  if (!bridgeIds.size) return document;
  return {
    ...root,
    patcher: {
      ...patcher,
      boxes: patcher.boxes.filter(
        (entry) => !bridgeIds.has(object(object(entry)?.box)?.id),
      ),
      ...(Array.isArray(patcher.lines)
        ? {
            lines: patcher.lines.filter((entry) => {
              const line = object(object(entry)?.patchline);
              return (
                !bridgeIds.has(
                  Array.isArray(line?.source) ? line.source[0] : undefined,
                ) &&
                !bridgeIds.has(
                  Array.isArray(line?.destination)
                    ? line.destination[0]
                    : undefined,
                )
              );
            }),
          }
        : {}),
      ...(Array.isArray(patcher.dependency_cache)
        ? {
            dependency_cache: patcher.dependency_cache.filter(
              (entry) => !/mcp_bridge|m4l_mcp/.test(JSON.stringify(entry)),
            ),
          }
        : {}),
    },
  };
}

export interface DevicePathOptions {
  readonly pathPlaceholder: string;
}
function placeholder(options: DevicePathOptions): string {
  const value = options?.pathPlaceholder;
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new Error("A bounded device pathPlaceholder is required");
  return value;
}

export function renderPortableDevice(
  document: MaxValue,
  sourceDirectory: string,
  options: DevicePathOptions,
): MaxValue {
  const token = placeholder(options);
  const source = normalize(sourceDirectory);
  return stripMcpBridge(
    mapStrings(document, (value) =>
      value
        .replaceAll(source, token)
        .replaceAll(source.replaceAll("\\", "/"), token),
    ),
  );
}

export function renderInstalledDevice(
  document: MaxValue,
  destinationDirectory: string,
  options: DevicePathOptions,
): MaxValue {
  const token = placeholder(options);
  const destination = normalize(destinationDirectory).replaceAll("\\", "/");
  return mapStrings(document, (value) => value.replaceAll(token, destination));
}

export interface ResourcePublicationEvent {
  readonly operation: "m4l.resources.publish";
  readonly stage:
    "queued" | "started" | "progress" | "completed" | "failed" | "cancelled";
  readonly resourceCount: number;
  readonly completedCount: number;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}
export interface ResourcePublicationOptions {
  readonly destinationDirectory: string;
  readonly resources: readonly {
    readonly fileName: string;
    readonly source: string;
  }[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ResourcePublicationEvent) => void;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}
export async function publishResources(
  options: ResourcePublicationOptions,
): Promise<string[]> {
  const { destinationDirectory, resources, signal, onEvent } = options;
  if (
    typeof destinationDirectory !== "string" ||
    !destinationDirectory ||
    destinationDirectory.length > 4096 ||
    !Array.isArray(resources) ||
    resources.length > 32 + FLUCOMA_DEPENDENCY_FILES.length ||
    resources.filter(
      (resource: unknown) =>
        !resource ||
        typeof resource !== "object" ||
        !("fileName" in resource) ||
        typeof resource.fileName !== "string" ||
        !isFlucomaDependencyResource(resource.fileName),
    ).length > 32
  )
    throw new Error(
      "Resource publication requires a destination and at most 32 flat resources plus pinned dependencies",
    );
  const startedAt = Date.now();
  const publication = resources as ResourcePublicationOptions["resources"];
  let completedCount = 0;
  const emit = (
    stage: ResourcePublicationEvent["stage"],
    errorCode?: string,
  ) => {
    try {
      onEvent?.({
        operation: "m4l.resources.publish",
        stage,
        resourceCount: resources.length,
        completedCount,
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
    } catch {
      /* Observers cannot interrupt artifact publication. */
    }
  };
  const cancelled = () => {
    signal?.throwIfAborted();
  };
  emit("queued");
  try {
    cancelled();
    emit("started");
    const names = new Set<string>();
    for (const resource of publication) {
      cancelled();
      if (
        typeof resource.fileName !== "string" ||
        !resource.fileName ||
        resource.fileName.length > 256 ||
        !isSafeDeviceResourceName(resource.fileName) ||
        names.has(resource.fileName) ||
        typeof resource.source !== "string" ||
        !resource.source ||
        resource.source.length > 4096
      )
        throw new Error(
          "Resource names must be unique bounded basenames or pinned dependency paths",
        );
      names.add(resource.fileName);
      if (isFlucomaDependencyResource(resource.fileName)) {
        const suffix = resource.fileName;
        const source = resolve(resource.source).replaceAll("\\", "/");
        if (!source.endsWith(`/${suffix}`))
          throw new Error("Pinned dependency source path mismatch");
        await readFlucomaDependencyFile(
          source.slice(0, -suffix.length),
          resource.fileName,
        );
      }
      const metadata = await stat(resource.source);
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
        throw new Error("Resources must be regular files no larger than 8 MiB");
    }
    cancelled();
    await mkdir(destinationDirectory, { recursive: true });
    const paths: string[] = [];
    for (const resource of publication) {
      cancelled();
      const destination = join(destinationDirectory, resource.fileName);
      if (isFlucomaDependencyResource(resource.fileName)) {
        await assertResourceParents(destination, true);
        try {
          const metadata = await lstat(destination);
          if (!metadata.isFile() || metadata.isSymbolicLink())
            throw new Error("Dependency destination must be a regular file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (resolve(resource.source) !== resolve(destination)) {
        const staged = `${destination}.staged-${randomUUID()}`;
        try {
          await copyFile(resource.source, staged);
          if ((await stat(staged)).size > 8 * 1024 * 1024)
            throw new Error("Resource changed beyond publication size bounds");
          const pin = FLUCOMA_DEPENDENCY_FILES.find(
            (file) => file.name === resource.fileName,
          );
          if (pin) {
            validateFlucomaDependencyBytes(
              resource.fileName,
              await readFile(staged),
            );
            await chmod(staged, pin.mode);
          }
          cancelled();
          await rename(staged, destination);
        } finally {
          await rm(staged, { force: true });
        }
      }
      completedCount++;
      paths.push(destination);
      emit("progress");
    }
    cancelled();
    emit("completed");
    return paths;
  } catch (error) {
    const aborted =
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError");
    emit(
      aborted ? "cancelled" : "failed",
      aborted ? "cancelled" : "resource-publication-failed",
    );
    throw error;
  }
}
