import { sanitizeTelemetryAttributes } from "@ableton-agent/observability";
import type { AppEvent, OperationFailureSource } from "@ableton-agent/shared";

import type {
  OperationDetail,
  OperationDisclosure,
  OperationFailure,
} from "../contracts.js";

type OperationEvent = Extract<
  AppEvent,
  {
    type: "operation.started" | "operation.completed" | "operation.failed";
  }
>;

const presentationSanitizerOptions = {
  maxDepth: 4,
  maxStringCharacters: 4_096,
  maxArrayItems: 24,
  maxObjectFields: 48,
  maxBytes: 16_384,
} as const;
const maximumDetailCount = 16;
const maximumDisplayCharacters = 4_096;
const spillPathPattern =
  /(?:\/[^\s"'`]+\/)?\d+-copilot-tool-output-[a-f0-9]+\.txt/giu;

function boundedText(value: string): string {
  if (value.length <= maximumDisplayCharacters) return value;
  return `${value.slice(0, maximumDisplayCharacters - 18)}… [truncated]`;
}

function isShellTool(toolName: string | undefined): boolean {
  return (
    toolName === "bash" || toolName === "shell" || toolName === "shell_exec"
  );
}

function sanitizeShellText(value: string): string {
  return value.replace(spillPathPattern, "<spill-file>");
}

function humanizeFieldName(value: string): string {
  const spaced = value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]+/gu, " ")
    .trim();
  return spaced.length === 0
    ? "Value"
    : `${spaced[0]!.toUpperCase()}${spaced.slice(1)}`;
}

function sanitizedValue(value: unknown): unknown {
  const sanitized = sanitizeTelemetryAttributes(
    { value },
    presentationSanitizerOptions,
  );
  return "value" in sanitized ? sanitized.value : sanitized;
}

function displayValue(
  value: unknown,
  shell: boolean,
): Pick<OperationDetail, "value" | "format"> {
  const sanitized = sanitizedValue(value);
  if (typeof sanitized === "string") {
    const text = sanitizeShellText(sanitized);
    return {
      value: boundedText(text),
      ...(text.includes("\n") || shell ? { format: "code" as const } : {}),
    };
  }
  if (
    sanitized === null ||
    typeof sanitized === "number" ||
    typeof sanitized === "boolean"
  ) {
    return { value: String(sanitized) };
  }
  if (Array.isArray(sanitized)) {
    const sanitizedArray = sanitized as readonly unknown[];
    const truncation = sanitizedArray.at(-1);
    const truncationRecord =
      truncation !== null &&
      typeof truncation === "object" &&
      !Array.isArray(truncation)
        ? (truncation as Record<string, unknown>)
        : undefined;
    const omittedItems =
      truncationRecord?.reason === "max_array_items" &&
      typeof truncationRecord.omittedItems === "number"
        ? truncationRecord.omittedItems
        : 0;
    if (
      omittedItems === 0 &&
      sanitizedArray.length <= 6 &&
      sanitizedArray.every(
        (item) =>
          item === null ||
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    ) {
      return { value: boundedText(JSON.stringify(sanitizedArray)) };
    }
    return {
      value: `${sanitizedArray.length - (omittedItems > 0 ? 1 : 0) + omittedItems} items`,
    };
  }
  return {
    value: boundedText(JSON.stringify(sanitized, undefined, 2)),
    format: "code",
  };
}

function detailEntries(
  value: unknown,
  options: { shell?: boolean; omit?: ReadonlySet<string> } = {},
): OperationDetail[] {
  const sanitized = sanitizedValue(value);
  if (
    sanitized === null ||
    typeof sanitized !== "object" ||
    Array.isArray(sanitized)
  ) {
    return [
      {
        label: "Value",
        ...displayValue(sanitized, options.shell ?? false),
      },
    ];
  }
  return Object.entries(sanitized)
    .filter(([key]) => !options.omit?.has(key))
    .slice(0, maximumDetailCount)
    .map(([key, child]) => ({
      label: humanizeFieldName(key),
      ...displayValue(child, options.shell ?? false),
    }));
}

function parseResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 32_768 ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function summaryFromValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ["summary", "message", "status"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return boundedText(candidate.trim());
    }
  }
  return undefined;
}

function targetSummary(
  argumentsValue: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (argumentsValue === undefined) return undefined;
  const names = [
    argumentsValue.expectedName,
    argumentsValue.expectedDeviceName,
    argumentsValue.expectedParameterName,
    argumentsValue.expectedClipName,
    argumentsValue.name,
    argumentsValue.query,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim())
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(-2);
  return names.length === 0 ? undefined : names.join(" › ");
}

function baseOperationLabel(event: OperationEvent): string {
  if ("label" in event && event.label !== undefined) return event.label;
  if (event.type === "operation.completed") {
    return event.summary.replace(/\s+completed$/iu, "");
  }
  if (event.type === "operation.failed") return "Tool operation";
  return event.label;
}

export function operationLabel(event: OperationEvent): string {
  const base = boundedText(baseOperationLabel(event));
  if (isShellTool(event.toolName)) return base;
  const target = targetSummary(event.arguments);
  if (
    target === undefined ||
    base.toLocaleLowerCase().includes(target.toLocaleLowerCase())
  ) {
    return base;
  }
  return boundedText(`${base} · ${target}`);
}

export function operationRequest(
  event: OperationEvent,
): OperationDisclosure | undefined {
  if (event.arguments === undefined) return undefined;
  const details = detailEntries(event.arguments, {
    shell: isShellTool(event.toolName),
    omit: new Set(["action"]),
  });
  if (details.length === 0) return undefined;
  return { details };
}

function isObservation(event: OperationEvent): boolean {
  const value = `${event.action ?? ""} ${baseOperationLabel(event)}`
    .toLocaleLowerCase()
    .replaceAll(/[_-]+/gu, " ");
  return /\b(inspect|search|list|read|status|history|find)\b/u.test(value);
}

export function operationOutcome(
  event: Extract<AppEvent, { type: "operation.completed" }>,
): (OperationDisclosure & { kind: "observed" | "result" }) | undefined {
  if (event.result === undefined) return undefined;
  const result = sanitizedValue(parseResult(event.result));
  const summary = summaryFromValue(result);
  const details =
    typeof result === "string"
      ? [
          {
            label: "Output",
            ...displayValue(result, isShellTool(event.toolName)),
          },
        ]
      : detailEntries(result, { shell: isShellTool(event.toolName) });
  return {
    kind: isObservation(event) ? "observed" : "result",
    ...(summary === undefined ? {} : { summary }),
    details,
  };
}

export function operationFailure(
  event: Extract<AppEvent, { type: "operation.failed" }>,
): OperationFailure {
  const source: OperationFailureSource = event.failureSource ?? "tool";
  return {
    source,
    code: boundedText(event.code).slice(0, 128),
    message: displayValue(event.message, false).value,
    ...(event.recovery === undefined
      ? {}
      : { recovery: displayValue(event.recovery, false).value }),
    details: event.details === undefined ? [] : detailEntries(event.details),
  };
}
