import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import type { ListenerBinding, DependencyInventory } from "./contracts.js";

function field(block: string, name: string): string {
  const values = [
    ...block.matchAll(new RegExp(`<${name}\\s+Value="([^"]*)"\\s*/>`, "gu")),
  ];
  if (values.length !== 1)
    throw new Error(`Ambiguous listener reference ${name}`);
  return values[0]![1]!.replace(
    /&(amp|quot|apos|lt|gt);/gu,
    (_, entity: string) =>
      ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity]!,
  );
}
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Only declared top-level listener references may change; all other XML is retained. */
export function bindFixtureProject(
  raw: Uint8Array,
  bindings: readonly ListenerBinding[],
  devices: NonNullable<DependencyInventory["frozenDevices"]>,
  workingDirectory: string,
): Buffer {
  if (
    raw.byteLength === 0 ||
    raw.byteLength > 8 * 1024 * 1024 ||
    bindings.length === 0 ||
    bindings.length > 32
  )
    throw new Error("Invalid bounded listener binding input");
  const xml = gunzipSync(raw, { maxOutputLength: 16 * 1024 * 1024 }).toString(
    "utf8",
  );
  if (
    !xml.includes("<Ableton ") ||
    /<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--/iu.test(xml)
  )
    throw new Error("Unsupported saved Set syntax for binding");
  const stack: string[] = [];
  const replacements: { start: number; end: number; text: string }[] = [];
  const seen = new Set<string>();
  let trackIndex = -1;
  let deviceIndex = -1;
  for (const match of xml.matchAll(
    /<\/?([A-Za-z][A-Za-z0-9_]*)(?:\s[^<>]*?)?\/?>/gu,
  )) {
    const tag = match[0];
    const name = match[1]!;
    if (tag.startsWith("</")) {
      if (stack.pop()?.split(":")[0] !== name)
        throw new Error("Unbalanced saved Set");
      continue;
    }
    const id = /\sId="(\d+)"/u.exec(tag)?.[1];
    if (stack.at(-1) === "Tracks" && /^(Audio|Midi|Group)Track$/u.test(name)) {
      trackIndex++;
      deviceIndex = -1;
    }
    const trackPosition = stack.findIndex((part) =>
      /^(Audio|Midi|Group)Track:/u.test(part),
    );
    const parent =
      trackPosition < 0 ? "" : stack.slice(trackPosition).join("/");
    if (
      /^(Audio|Midi|Group)Track:\d+\/DeviceChain\/DeviceChain\/Devices$/u.test(
        parent,
      )
    )
      deviceIndex++;
    if (
      name === "MxDPatchRef" &&
      stack.at(-1) === "Value" &&
      stack.at(-2) === "PatchSlot" &&
      !stack.includes("SourceContext")
    ) {
      const slot = stack.slice(trackPosition, -2).join("/");
      const end =
        xml.indexOf("</MxDPatchRef>", match.index) + "</MxDPatchRef>".length;
      if (end < match.index) throw new Error("Unterminated listener reference");
      const block = xml.slice(match.index, end);
      const source = field(block, "RelativePath");
      const binding = bindings.find((entry) => entry.slot === slot);
      if (
        binding ||
        source.endsWith("/Machine-Listening-Development.amxd") ||
        source === "Machine-Listening-Development.amxd"
      ) {
        if (!binding || seen.has(slot))
          throw new Error("Unreviewed or duplicate listener slot");
        if (
          !/^(Audio|Midi)Track:\d+\/DeviceChain\/DeviceChain\/Devices\/MxDeviceAudioEffect:\d+$/u.test(
            slot,
          )
        )
          throw new Error(
            "Only declared top-level listener slots are supported",
          );
        if (
          binding.trackIndex !== trackIndex ||
          binding.deviceIndex !== deviceIndex ||
          binding.sourcePath !== source ||
          field(block, "RelativePathType") !== "3"
        )
          throw new Error(
            "Saved listener placement or source differs from reviewed binding",
          );
        const device = devices.find((entry) => entry.id === binding.dependency);
        if (!device)
          throw new Error("Missing frozen candidate for listener binding");
        let changed = block;
        for (const [name, value] of [
          ["RelativePath", device.target],
          ["Path", join(workingDirectory, device.target)],
        ] as const)
          changed = changed.replace(
            new RegExp(`(<${name}\\s+Value=")[^"]*("\\s*/>)`, "u"),
            (_, before: string, after: string) =>
              before + escape(value) + after,
          );
        replacements.push({ start: match.index, end, text: changed });
        seen.add(slot);
      }
    }
    if (!tag.endsWith("/>"))
      stack.push(id === undefined ? name : `${name}:${id}`);
    if (stack.length > 128) throw new Error("Saved Set nesting exceeds bound");
  }
  if (stack.length || seen.size !== bindings.length)
    throw new Error("Missing declared listener slot");
  let result = xml;
  for (const replacement of replacements.reverse())
    result =
      result.slice(0, replacement.start) +
      replacement.text +
      result.slice(replacement.end);
  return gzipSync(result);
}
