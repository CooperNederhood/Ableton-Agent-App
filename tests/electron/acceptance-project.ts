import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  safeRelativePath,
  type FixtureManifest,
} from "@ableton-agent/test-support/integration";

function attribute(block: string, name: string): string {
  const matches = [
    ...block.matchAll(new RegExp(`<${name}\\s+Value="([^"]*)"\\s*/>`, "gu")),
  ];
  if (matches.length !== 1)
    throw new Error(`Ambiguous fixture reference ${name}`);
  const value = matches[0]![1]!;
  if (/&(?!amp;|quot;|apos;|lt;|gt;)/u.test(value))
    throw new Error("Unsupported fixture reference encoding");
  return value.replace(/&(amp|quot|apos|lt|gt);/gu, (_, entity: string) => {
    const replacements: Record<string, string> = {
      amp: "&",
      quot: '"',
      apos: "'",
      lt: "<",
      gt: ">",
    };
    return replacements[entity]!;
  });
}

export interface SavedProjectReference {
  readonly path: string;
  readonly relativePath: string;
  readonly relativePathType: string;
}

/** Bounded reference inspection, not a semantic validator for Live settings. */
export function readAcceptanceProjectReferences(
  bytes: Uint8Array,
  activeOnly = false,
): readonly SavedProjectReference[] {
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Fixture Set exceeds its input bound");
  let xml = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString(
    "utf8",
  );
  if (
    !xml.includes("<Ableton ") ||
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/iu.test(xml)
  )
    throw new Error("Unsupported fixture Set document");
  if (activeOnly) {
    const ranges: { start: number; end: number }[] = [];
    const history: string[] = [];
    let start = 0;
    for (const match of xml.matchAll(
      /<\/?(SourceContext|LastPresetRef)(?:\s[^<>]*)?\/?>/gu,
    )) {
      if (match[0].endsWith("/>")) continue;
      if (match[0].startsWith("</")) {
        if (history.pop() !== match[1])
          throw new Error("Unbalanced source history");
        if (history.length === 0)
          ranges.push({ start, end: match.index + match[0].length });
      } else {
        if (history.length === 0) start = match.index;
        history.push(match[1]!);
        if (history.length > 64)
          throw new Error("Source history nesting exceeds bound");
      }
    }
    if (history.length) throw new Error("Unterminated source history");
    for (const range of ranges.reverse())
      xml = xml.slice(0, range.start) + xml.slice(range.end);
  }
  const blocks = [
    ...xml.matchAll(/<FileRef(?:\s[^>]*)?>([\s\S]*?)<\/FileRef>/gu),
  ];
  if (blocks.length > 128) throw new Error("Fixture reference count exceeded");
  const resources: SavedProjectReference[] = [];
  for (const [, block] of blocks) {
    const path = attribute(block!, "Path");
    const relative = attribute(block!, "RelativePath");
    if (path === "" && relative === "") continue;
    resources.push({
      path,
      relativePath: relative,
      relativePathType: attribute(block!, "RelativePathType"),
    });
  }
  return Object.freeze(resources);
}

/** Admission only: never rewrites the saved Set or guesses replacement paths. */
export function inspectAcceptanceProject(
  bytes: Uint8Array,
  allowedResources: ReadonlySet<string>,
  requireResource = true,
  builtinResources: NonNullable<FixtureManifest["builtinResources"]> = [],
): readonly string[] {
  const references = readAcceptanceProjectReferences(bytes, true);
  const resources: string[] = [];
  for (const reference of references) {
    const relative = reference.relativePath;
    if (
      reference.relativePathType === "7" &&
      builtinResources.some((entry) => entry.path === relative)
    ) {
      safeRelativePath(relative);
      continue;
    }
    if (
      reference.relativePathType !== "3" ||
      relative === "" ||
      /[\\:\0]/u.test(relative) ||
      relative
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      !allowedResources.has(relative)
    )
      throw new Error(
        "Fixture references an undeclared or non-project-local dependency",
      );
    resources.push(relative);
  }

  if (requireResource && resources.length === 0)
    throw new Error("Audio fixture has no declared project resources");
  return Object.freeze(resources);
}

export async function verifyBuiltinResources(
  resources: NonNullable<FixtureManifest["builtinResources"]>,
  liveApplicationPath: string,
  signal: AbortSignal,
): Promise<string> {
  const hashes: string[] = [];
  for (const resource of resources) {
    signal.throwIfAborted();
    safeRelativePath(resource.path);
    const path = resolve(
      liveApplicationPath,
      "Contents/App-Resources/Builtin",
      resource.path,
    );
    if ((await realpath(path)) !== path)
      throw new Error("Builtin resource traverses a symlink");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.size !== resource.bytes ||
        before.size > 16 * 1024 * 1024
      )
        throw new Error("Builtin resource size mismatch");
      const bytes = await handle.readFile({ signal });
      const after = await handle.stat();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        sha256 !== resource.sha256
      )
        throw new Error("Builtin resource hash mismatch");
      hashes.push(`${resource.path}:${sha256}`);
    } finally {
      await handle.close();
    }
  }
  signal.throwIfAborted();
  return createHash("sha256")
    .update(JSON.stringify(hashes.sort()))
    .digest("hex");
}

/** Live 11 omits this public property; inspect only the exact saved Session slot. */
export function readSavedFollowAction(
  bytes: Uint8Array,
  expectedTrack: number,
  expectedSlot: number,
): boolean {
  readAcceptanceProjectReferences(bytes);
  const xml = gunzipSync(bytes, {
    maxOutputLength: 16 * 1024 * 1024,
  }).toString("utf8");
  const stack: string[] = [];
  let track = -1;
  let slot = -1;
  const values: string[] = [];
  for (const match of xml.matchAll(
    /<\/?([A-Za-z][A-Za-z0-9_]*)(?:\s[^<>]*?)?\/?>/gu,
  )) {
    const tag = match[0],
      name = match[1]!;
    if (tag.startsWith("</")) {
      if (stack.pop() !== name)
        throw new Error("Unbalanced saved follow-action evidence");
      continue;
    }
    if (stack.at(-1) === "Tracks" && /^(Audio|Midi|Group)Track$/u.test(name)) {
      track++;
      slot = -1;
    }
    if (
      name === "ClipSlot" &&
      stack.slice(-2).join("/") === "MainSequencer/ClipSlotList"
    )
      slot++;
    if (
      track === expectedTrack &&
      slot === expectedSlot &&
      name === "FollowActionEnabled" &&
      /^Ableton\/LiveSet\/Tracks\/(?:Audio|Midi)Track\/DeviceChain\/MainSequencer\/ClipSlotList\/ClipSlot\/ClipSlot\/Value\/AudioClip\/FollowAction$/u.test(
        stack.join("/"),
      )
    )
      values.push(/\sValue="([^"]*)"/u.exec(tag)?.[1] ?? "");
    if (!tag.endsWith("/>")) stack.push(name);
    if (stack.length > 128)
      throw new Error("Saved follow-action nesting exceeds bound");
  }
  if (
    stack.length ||
    values.length !== 1 ||
    !["true", "false"].includes(values[0]!)
  )
    throw new Error("Missing or ambiguous saved follow-action evidence");
  return values[0] === "true";
}
