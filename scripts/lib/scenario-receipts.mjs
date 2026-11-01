import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tsImport } from "tsx/esm/api";

// Admission failures must be reportable before the workspace has been built.
const {
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
  REDACTED_VALUE,
  AUDIO_OMITTED_VALUE,
  BINARY_OMITTED_VALUE,
} = await tsImport(
  "../../packages/observability/src/sanitizer.ts",
  import.meta.url,
);
const omissions = new Set([
  REDACTED_VALUE,
  AUDIO_OMITTED_VALUE,
  BINARY_OMITTED_VALUE,
]);
const maximumReceiptBytes = 64 * 1024 * 1024;

export function describeScenarioError(error) {
  return sanitizePersistedText(String(error?.message ?? error)).slice(0, 2048);
}

export function serializeScenarioReceipt(
  value,
  maximumBytes = maximumReceiptBytes,
) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > maximumReceiptBytes
  )
    throw new Error("Invalid scenario receipt byte limit");
  const copies = new WeakMap();
  const text = JSON.stringify(
    value,
    function (key, item) {
      const original = this[key];
      if (original instanceof ArrayBuffer || ArrayBuffer.isView(original))
        return BINARY_OMITTED_VALUE;
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        if (copies.has(item)) return copies.get(item);
        const copy = Object.create(null);
        copies.set(item, copy);
        const metadata = Object.fromEntries(
          ["contentType", "mediaType", "mimeType", "type"]
            .filter((name) => typeof item[name] === "string")
            .map((name) => [name, item[name]]),
        );
        // Reuse canonical field policies without truncating scenario/measurement arrays.
        for (const [field, entry] of Object.entries(item)) {
          const name = sanitizePersistedText(field).slice(0, 256);
          if (Object.hasOwn(copy, name))
            throw new Error("Scenario receipt field collision after redaction");
          const [policy] = Object.values(
            sanitizeTelemetryAttributes({ [field]: null, ...metadata }),
          );
          copy[name] = omissions.has(policy) ? policy : entry;
        }
        return copy;
      }
      if (typeof item !== "string") return item;
      const sanitized = sanitizePersistedText(item);
      return sanitized.length > 16_384
        ? `${sanitized.slice(0, 16_384)}[truncated]`
        : sanitized;
    },
    2,
  );
  if (Buffer.byteLength(text, "utf8") + 1 > maximumBytes)
    throw new Error("Scenario receipt exceeds bounded evidence size");
  return `${text}\n`;
}

export async function writeScenarioReceipt(path, value) {
  const text = serializeScenarioReceipt(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
