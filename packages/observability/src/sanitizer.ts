import {
  MAX_ATTRIBUTES_BYTES,
  MAX_SANITIZED_ARRAY_ITEMS,
  MAX_SANITIZED_DEPTH,
  MAX_SANITIZED_FIELD_NAME_CHARACTERS,
  MAX_SANITIZED_OBJECT_FIELDS,
  MAX_SANITIZED_STRING_CHARACTERS,
  sanitizedAttributesSchema,
  type SanitizedAttributes,
} from "./contracts.js";

export const REDACTED_VALUE = "[REDACTED]";
export const CIRCULAR_VALUE = "[Circular]";
export const BINARY_OMITTED_VALUE = "[Binary data omitted]";
export const AUDIO_OMITTED_VALUE = "[Audio data omitted]";

const credentialFieldNames = new Set([
  "apikey",
  "apisecret",
  "accesstoken",
  "authenticationtoken",
  "authorization",
  "authtoken",
  "bearertoken",
  "bridgetoken",
  "clientsecret",
  "cookie",
  "copilottoken",
  "credential",
  "credentials",
  "githubtoken",
  "idtoken",
  "password",
  "passwd",
  "passphrase",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "sessioncookie",
  "setcookie",
  "signingsecret",
  "token",
  "xapikey",
]);

const authorizationPattern =
  /\b(Bearer|Basic)[ \t]+(?:"[^"\r\n]+"|'[^'\r\n]+'|[a-z0-9._~+/=-]+)/giu;
const digestAuthorizationPattern =
  /\b(Digest)[ \t]+(?=[a-z][\w-]*[ \t]*=)[^\r\n]+/giu;
const credentialAssignmentPattern =
  /(?<![a-z0-9_.-])((["']?)((?:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)|(?:(?:x[ \t]+)?api[ \t]+(?:key|secret))|(?:(?:proxy[ \t]+)?authorization)|(?:(?:access|auth(?:entication)?|bearer|bridge|client|consumer|copilot|github|id|oauth|refresh|session|signing|webhook)[ \t]+(?:token|secret))|(?:personal[ \t]+access[ \t]+token)|(?:secret[ \t]+access[ \t]+key)|(?:private[ \t]+key))\2[ \t]*(?:=|:)[ \t]*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;&}\])]+)/giu;
const urlUserInfoPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/giu;
const privateKeyPattern =
  /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/giu;
const providerTokenPatterns = [
  /\bgithub_pat_[a-z0-9_]{20,}\b/giu,
  /\bgh[pousr]_[a-z0-9]{20,}\b/giu,
  /\bxox[baprs]-[a-z0-9-]{10,}\b/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\b(?:sk|rk)_(?:live|test)_[a-z0-9]{16,}\b/giu,
  /\bsk-(?:ant-(?:api\d{2}-)?)?[a-z0-9_-]{20,}\b/giu,
  /\bAIza[a-z0-9_-]{35}\b/giu,
  /\bglpat-[a-z0-9_-]{20,}\b/giu,
  /\bnpm_[a-z0-9]{36}\b/giu,
  /\bpypi-[a-z0-9_-]{40,}\b/giu,
  /\bhf_[a-z0-9]{20,}\b/giu,
  /\bSG\.[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}\b/giu,
  /\b(?:dop_v1|lin_api|shpat|shpca|shppa|shpss)_[a-z0-9_-]{20,}\b/giu,
  /\bya29\.[a-z0-9_-]{20,}\b/giu,
] as const;

const audioBodyFieldNames = new Set([
  "audiobody",
  "audiobuffer",
  "audiobytes",
  "audiodata",
  "pcmdata",
]);
const binaryBodyFieldNames = new Set([
  "binarybody",
  "binarybuffer",
  "binarybytes",
  "binarydata",
]);
const bodyFieldNames = new Set([
  "body",
  "buffer",
  "bytes",
  "content",
  "data",
  "payload",
]);
const credentialSuffixes = [
  ["api", "key"],
  ["secret", "access", "key"],
  ["secret", "key"],
  ["private", "key"],
  ["authorization"],
  ["credentials"],
  ["credential"],
  ["passphrase"],
  ["password"],
  ["passwd"],
  ["cookie"],
  ["secret"],
  ["token"],
] as const;
const credentialValueQualifiers = new Set([
  "body",
  "bytes",
  "content",
  "contents",
  "data",
  "header",
  "json",
  "pem",
  "raw",
  "string",
  "text",
  "value",
]);

export interface TelemetrySanitizerOptions {
  readonly maxDepth?: number;
  readonly maxStringCharacters?: number;
  readonly maxArrayItems?: number;
  readonly maxObjectFields?: number;
  readonly maxBytes?: number;
}

interface SanitizerLimits {
  readonly maxDepth: number;
  readonly maxStringCharacters: number;
  readonly maxArrayItems: number;
  readonly maxObjectFields: number;
  readonly maxBytes: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > fallback) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${fallback}`,
    );
  }
  return resolved;
}

function limits(options: TelemetrySanitizerOptions): SanitizerLimits {
  return {
    maxDepth: boundedInteger(options.maxDepth, MAX_SANITIZED_DEPTH, "maxDepth"),
    maxStringCharacters: boundedInteger(
      options.maxStringCharacters,
      MAX_SANITIZED_STRING_CHARACTERS,
      "maxStringCharacters",
    ),
    maxArrayItems: boundedInteger(
      options.maxArrayItems,
      MAX_SANITIZED_ARRAY_ITEMS,
      "maxArrayItems",
    ),
    maxObjectFields: boundedInteger(
      options.maxObjectFields,
      MAX_SANITIZED_OBJECT_FIELDS,
      "maxObjectFields",
    ),
    maxBytes: boundedInteger(
      options.maxBytes,
      MAX_ATTRIBUTES_BYTES,
      "maxBytes",
    ),
  };
}

function isCredentialField(key: string): boolean {
  if (credentialFieldNames.has(normalizedFieldName(key))) return true;
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
  return credentialSuffixes.some((suffix) => {
    for (let index = 0; index <= tokens.length - suffix.length; index += 1) {
      if (!suffix.every((token, offset) => tokens[index + offset] === token)) {
        continue;
      }
      const trailing = tokens.slice(index + suffix.length);
      return (
        trailing.length === 0 ||
        trailing.every((token) => credentialValueQualifiers.has(token))
      );
    }
    return false;
  });
}

function normalizedFieldName(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function redactSensitiveText(value: string): string {
  let redacted = value
    .replace(privateKeyPattern, REDACTED_VALUE)
    .replace(authorizationPattern, "$1 [REDACTED]")
    .replace(digestAuthorizationPattern, "$1 [REDACTED]")
    .replace(urlUserInfoPattern, `$1${REDACTED_VALUE}@`)
    .replace(
      credentialAssignmentPattern,
      (match, assignment: string, _quote: string, key: string) => {
        if (!isCredentialField(key)) return match;
        const assignedValue = match.slice(assignment.length);
        const quote =
          assignedValue.startsWith('"') || assignedValue.startsWith("'")
            ? assignedValue[0]
            : "";
        return `${assignment}${quote}${REDACTED_VALUE}${quote}`;
      },
    );
  for (const pattern of providerTokenPatterns) {
    redacted = redacted.replace(pattern, REDACTED_VALUE);
  }
  return redacted;
}

function truncateString(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "…[truncated]";
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function fieldName(key: string): string {
  const redacted = redactSensitiveText(key);
  const nonempty = redacted.length === 0 ? "[empty field]" : redacted;
  return truncateString(nonempty, MAX_SANITIZED_FIELD_NAME_CHARACTERS);
}

function setField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  let candidate = fieldName(key);
  let suffix = 1;
  while (Object.prototype.hasOwnProperty.call(target, candidate)) {
    const collision = `…[${suffix}]`;
    candidate = `${candidate.slice(
      0,
      MAX_SANITIZED_FIELD_NAME_CHARACTERS - collision.length,
    )}${collision}`;
    suffix += 1;
  }
  Object.defineProperty(target, candidate, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function binarySummary(value: ArrayBuffer | ArrayBufferView): object {
  const byteLength =
    value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
  return {
    type: "binary",
    byteLength,
    value: BINARY_OMITTED_VALUE,
  };
}

function hasAudioBody(value: Record<string, unknown>): boolean {
  return ["contentType", "mediaType", "mimeType", "type"].some((key) => {
    let type: unknown;
    try {
      type = value[key];
    } catch {
      return false;
    }
    return typeof type === "string" && /^audio(?:\/|$)/iu.test(type);
  });
}

function sanitizeValue(
  value: unknown,
  active: Set<object>,
  depth: number,
  settings: SanitizerLimits,
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return truncateString(
      redactSensitiveText(value),
      settings.maxStringCharacters,
    );
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : `[Non-finite number: ${String(value)}]`;
  }
  if (typeof value === "bigint") return `${String(value)}n`;
  if (typeof value === "undefined") return "[Undefined]";
  if (typeof value === "symbol")
    return `[Symbol: ${redactSensitiveText(value.description ?? "")}]`;
  if (typeof value === "function")
    return `[Function: ${redactSensitiveText(value.name || "anonymous")}]`;
  if (depth >= settings.maxDepth) {
    return {
      truncated: true,
      reason: "max_depth",
      limit: settings.maxDepth,
    };
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return binarySummary(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? "[Invalid Date]"
      : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      type: "error",
      name: redactSensitiveText(value.name),
      message: truncateString(
        redactSensitiveText(value.message),
        settings.maxStringCharacters,
      ),
    };
  }
  if (active.has(value)) return CIRCULAR_VALUE;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const truncated = value.length > settings.maxArrayItems;
      const itemLimit = truncated
        ? Math.max(0, settings.maxArrayItems - 1)
        : value.length;
      const result = value
        .slice(0, itemLimit)
        .map((item) => sanitizeValue(item, active, depth + 1, settings));
      if (truncated) {
        result.push({
          truncated: true,
          reason: "max_array_items",
          omittedItems: value.length - itemLimit,
        });
      }
      return result;
    }
    if (value instanceof Map) {
      return sanitizeValue(
        [...(value as Map<unknown, unknown>).entries()].map(([key, item]) => ({
          key,
          value: item,
        })),
        active,
        depth + 1,
        settings,
      );
    }
    if (value instanceof Set) {
      return sanitizeValue([...value], active, depth + 1, settings);
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return {
        type: "unsupported_object",
        className: redactSensitiveText(value.constructor?.name ?? "unknown"),
      };
    }
    const keys = Object.keys(value);
    const truncated = keys.length > settings.maxObjectFields;
    const fieldLimit = truncated
      ? Math.max(0, settings.maxObjectFields - 1)
      : keys.length;
    const result: Record<string, unknown> = {};
    const audioContainer = hasAudioBody(value as Record<string, unknown>);
    for (const key of keys.slice(0, fieldLimit)) {
      if (isCredentialField(key)) {
        setField(result, key, REDACTED_VALUE);
        continue;
      }
      const normalizedKey = normalizedFieldName(key);
      if (audioBodyFieldNames.has(normalizedKey)) {
        setField(result, key, AUDIO_OMITTED_VALUE);
        continue;
      }
      if (binaryBodyFieldNames.has(normalizedKey)) {
        setField(result, key, BINARY_OMITTED_VALUE);
        continue;
      }
      if (audioContainer && bodyFieldNames.has(normalizedKey)) {
        setField(result, key, AUDIO_OMITTED_VALUE);
        continue;
      }
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        item = "[Property access failed]";
      }
      setField(result, key, sanitizeValue(item, active, depth + 1, settings));
    }
    if (truncated) {
      setField(result, "[truncation]", {
        truncated: true,
        reason: "max_object_fields",
        omittedFields: keys.length - fieldLimit,
      });
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Creates a detached, JSON-safe copy. Credential fields and bearer-token
 * values are replaced before the result can be handed to persistence.
 */
export function sanitizeTelemetryAttributes(
  attributes: Readonly<Record<string, unknown>>,
  options: TelemetrySanitizerOptions = {},
): SanitizedAttributes {
  const settings = limits(options);
  const sanitized = sanitizeValue(attributes, new Set(), 0, settings);
  const record =
    typeof sanitized === "object" &&
    sanitized !== null &&
    !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : { value: sanitized };
  const bytes = byteLength(record);
  const bounded =
    bytes <= settings.maxBytes
      ? record
      : {
          truncated: true,
          reason: "max_bytes",
          originalBytes: bytes,
          preview: truncateString(
            JSON.stringify(record),
            Math.min(
              settings.maxStringCharacters,
              Math.floor(settings.maxBytes / 4),
            ),
          ),
        };
  return sanitizedAttributesSchema.parse(bounded);
}
