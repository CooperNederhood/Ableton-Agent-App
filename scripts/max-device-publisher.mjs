import { Buffer } from "node:buffer";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, normalize, resolve } from "node:path";

export function decodeAmxd(raw) {
  const marker = raw.indexOf(Buffer.from("ptch"));
  if (marker < 0) throw new Error("AMXD does not contain a ptch chunk");
  if (marker + 8 > raw.length) throw new Error("AMXD ptch header is truncated");
  const size = raw.readUInt32LE(marker + 4);
  const payloadStart = marker + 8;
  const payloadEnd = payloadStart + size;
  if (payloadEnd > raw.length) throw new Error("AMXD ptch chunk is truncated");
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
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([container.prefix, size, json, container.suffix]);
}

function mapStrings(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value))
    return value.map((entry) => mapStrings(entry, transform));
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
        ? patcher.lines.filter(
            ({ patchline }) =>
              !bridgeIds.has(patchline?.source?.[0]) &&
              !bridgeIds.has(patchline?.destination?.[0]),
          )
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

function placeholder(options) {
  const value = options?.pathPlaceholder;
  if (typeof value !== "string" || value.length < 1 || value.length > 256)
    throw new Error("A bounded device pathPlaceholder is required");
  return value;
}

export function renderPortableDevice(document, sourceDirectory, options) {
  const pathPlaceholder = placeholder(options);
  const source = normalize(sourceDirectory);
  const slashSource = source.replaceAll("\\", "/");
  return stripMcpBridge(
    mapStrings(document, (value) =>
      value
        .replaceAll(source, pathPlaceholder)
        .replaceAll(slashSource, pathPlaceholder),
    ),
  );
}

export function renderInstalledDevice(document, destinationDirectory, options) {
  const pathPlaceholder = placeholder(options);
  const destination = normalize(destinationDirectory).replaceAll("\\", "/");
  return mapStrings(document, (value) =>
    value.replaceAll(pathPlaceholder, destination),
  );
}

export async function publishResources(options) {
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
  let completedCount = 0;
  const emit = (stage, errorCode) => {
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
      // Observers cannot interrupt artifact publication.
    }
  };
  const cancelled = () => {
    if (signal?.aborted) {
      const error = new Error("Resource publication cancelled");
      error.name = "AbortError";
      throw error;
    }
  };
  emit("queued");
  try {
    cancelled();
    emit("started");
    const names = new Set();
    for (const resource of resources) {
      cancelled();
      if (
        typeof resource?.fileName !== "string" ||
        resource.fileName.length > 256 ||
        !resource.fileName ||
        basename(resource.fileName) !== resource.fileName ||
        resource.fileName === "." ||
        resource.fileName === ".." ||
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
    const paths = [];
    for (const resource of resources) {
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
      completedCount += 1;
      paths.push(destination);
      emit("progress");
    }
    cancelled();
    emit("completed");
    return paths;
  } catch (error) {
    emit(
      error.name === "AbortError" ? "cancelled" : "failed",
      error.name === "AbortError" ? "cancelled" : "resource-publication-failed",
    );
    throw error;
  }
}
