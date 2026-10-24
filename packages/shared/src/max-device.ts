import { Buffer } from "node:buffer";
import { copyFile, stat, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, normalize, resolve } from "node:path";

export type MaxValue =
  string | number | boolean | null | MaxValue[] | { [key: string]: MaxValue };
export interface AmxdContainer {
  readonly document: MaxValue;
  readonly prefix: Buffer;
  readonly suffix: Buffer;
}

export function decodeAmxd(raw: Buffer): AmxdContainer {
  const marker = raw.indexOf(Buffer.from("ptch"));
  if (marker < 0) throw new Error("AMXD does not contain a ptch chunk");
  if (marker + 8 > raw.length) throw new Error("AMXD ptch header is truncated");
  const end = marker + 8 + raw.readUInt32LE(marker + 4);
  if (end > raw.length) throw new Error("AMXD ptch chunk is truncated");
  const payload = raw.subarray(marker + 8, end);
  if (payload.subarray(0, 4).toString("ascii") === "mx@c")
    throw new Error(
      "Compressed AMXD ptch chunks are not supported by the publisher",
    );
  return {
    document: JSON.parse(
      payload
        .subarray(0, payload.length - (payload.at(-1) === 0 ? 1 : 0))
        .toString("utf8"),
    ) as MaxValue,
    prefix: raw.subarray(0, marker + 4),
    suffix: raw.subarray(end),
  };
}

export function encodeAmxd(
  container: Pick<AmxdContainer, "prefix" | "suffix">,
  document: MaxValue,
): Buffer {
  const json = Buffer.from(
    `${JSON.stringify(document, null, "\t")}\n\0`,
    "utf8",
  );
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([container.prefix, size, json, container.suffix]);
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
    resources.length > 32
  )
    throw new Error(
      "Resource publication requires a destination and at most 32 resources",
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
        basename(resource.fileName) !== resource.fileName ||
        [".", ".."].includes(resource.fileName) ||
        resource.fileName.includes("\\") ||
        names.has(resource.fileName) ||
        typeof resource.source !== "string" ||
        !resource.source ||
        resource.source.length > 4096
      )
        throw new Error("Resource names must be unique bounded basenames");
      names.add(resource.fileName);
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
      if (resolve(resource.source) !== resolve(destination)) {
        const staged = `${destination}.staged-${randomUUID()}`;
        try {
          await copyFile(resource.source, staged);
          if ((await stat(staged)).size > 8 * 1024 * 1024)
            throw new Error("Resource changed beyond publication size bounds");
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
