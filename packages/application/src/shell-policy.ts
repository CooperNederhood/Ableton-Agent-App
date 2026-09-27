import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type {
  PermissionRequest,
  PermissionRequestResult,
} from "@github/copilot-sdk";

const allowedCommands = new Set(["grep", "head", "jq", "tail", "wc"]);
const spillFilePattern = /^\d+-copilot-tool-output-[a-f0-9]+\.txt$/u;
const maximumSpillFileBytes = 16 * 1024 * 1024;
const maximumLineCount = 500;
const maximumRetainedBytes = 64 * 1024 * 1024;
const maximumAgeMs = 24 * 60 * 60 * 1000;

export interface SpillDirectoryPreparation {
  readonly removedFileCount: number;
  readonly removedBytes: number;
  readonly retainedFileCount: number;
  readonly retainedBytes: number;
}

export type SpillShellPolicyStage =
  | "approved"
  | "invalid_arguments"
  | "invalid_spill_path"
  | "invalid_syntax"
  | "managed_approval_required"
  | "missing_segments"
  | "missing_spill_operand"
  | "network_access"
  | "sandbox_escalation"
  | "spill_directory_unavailable"
  | "unsupported_command"
  | "write_redirection";

export interface SpillShellPolicyDiagnostics {
  readonly stage: SpillShellPolicyStage;
  readonly commandIdentifiers: readonly string[];
  readonly commandCount: number;
  readonly segmentCount: number;
  readonly fileOperandCount: number;
  readonly sdkCommandSummaryDisagrees: boolean;
  readonly sdkPathSummaryDisagrees: boolean;
  readonly durationMs: number;
}

export interface SpillShellPolicyEvaluation {
  readonly result: PermissionRequestResult | undefined;
  readonly diagnostics?: SpillShellPolicyDiagnostics;
}

export function prepareSpillDirectory(
  spillDirectory: string,
  now = Date.now(),
): SpillDirectoryPreparation {
  mkdirSync(spillDirectory, { recursive: true, mode: 0o700 });
  const directoryDetails = lstatSync(spillDirectory);
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
    throw new Error("Copilot spill path must be a physical directory");
  }
  chmodSync(spillDirectory, 0o700);
  const files = readdirSync(spillDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && spillFilePattern.test(entry.name))
    .map((entry) => {
      const path = join(spillDirectory, entry.name);
      const details = statSync(path);
      return { path, size: details.size, modifiedAt: details.mtimeMs };
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  let removedFileCount = 0;
  let removedBytes = 0;
  const retained = [];
  for (const file of files) {
    if (now - file.modifiedAt > maximumAgeMs) {
      unlinkSync(file.path);
      removedFileCount += 1;
      removedBytes += file.size;
    } else {
      retained.push(file);
    }
  }
  let retainedBytes = retained.reduce((total, file) => total + file.size, 0);
  while (retainedBytes > maximumRetainedBytes && retained.length > 0) {
    const file = retained.shift()!;
    unlinkSync(file.path);
    removedFileCount += 1;
    removedBytes += file.size;
    retainedBytes -= file.size;
  }
  return {
    removedFileCount,
    removedBytes,
    retainedFileCount: retained.length,
    retainedBytes,
  };
}

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
  );
}

function hasUnsafeShellSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "`" || character === "$") {
        return true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === ";" ||
      character === "&" ||
      character === "<" ||
      character === ">" ||
      character === "`" ||
      character === "$" ||
      character === "\n" ||
      character === "\r" ||
      command.slice(index, index + 2) === "||"
    ) {
      return true;
    }
  }
  return quote !== undefined || escaped;
}

function splitShellPipeline(command: string): string[] | undefined {
  const segments: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "|") {
      const segment = command.slice(start, index).trim();
      if (segment.length === 0) return undefined;
      segments.push(segment);
      start = index + 1;
    }
  }
  if (quote !== undefined || escaped) return undefined;
  const segment = command.slice(start).trim();
  if (segment.length === 0) return undefined;
  segments.push(segment);
  return segments;
}

function tokenizeShellSegment(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const finishToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    if ("|;&<>()".includes(character)) return undefined;
    token += character;
    tokenStarted = true;
  }
  if (quote !== undefined || escaped) return undefined;
  finishToken();
  return tokens;
}

interface ParsedCommand {
  readonly fileOperands: readonly string[];
}

function parseJqCommand(tokens: readonly string[]): ParsedCommand | undefined {
  const safeLongFlags = new Set([
    "--ascii-output",
    "--binary",
    "--color-output",
    "--compact-output",
    "--exit-status",
    "--join-output",
    "--jsonargs",
    "--monochrome-output",
    "--raw-input",
    "--raw-output",
    "--raw-output0",
    "--seq",
    "--slurp",
    "--sort-keys",
    "--stream",
    "--stream-errors",
    "--unbuffered",
  ]);
  const safeShortFlags = new Set([
    "0",
    "C",
    "M",
    "R",
    "S",
    "a",
    "c",
    "e",
    "j",
    "r",
    "s",
  ]);
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "--arg" || token === "--argjson") {
      if (index + 2 >= tokens.length) return undefined;
      index += 3;
      continue;
    }
    if (token.startsWith("--")) {
      if (!safeLongFlags.has(token)) return undefined;
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (![...token.slice(1)].every((flag) => safeShortFlags.has(flag))) {
        return undefined;
      }
      index += 1;
      continue;
    }
    break;
  }
  if (index >= tokens.length) return undefined;
  index += 1;
  return { fileOperands: tokens.slice(index) };
}

function parseGrepCommand(
  tokens: readonly string[],
): ParsedCommand | undefined {
  const safeLongFlags = new Set([
    "--basic-regexp",
    "--byte-offset",
    "--count",
    "--extended-regexp",
    "--fixed-strings",
    "--files-with-matches",
    "--files-without-match",
    "--ignore-case",
    "--invert-match",
    "--line-number",
    "--line-regexp",
    "--no-filename",
    "--no-messages",
    "--only-matching",
    "--perl-regexp",
    "--quiet",
    "--regexp",
    "--text",
    "--with-filename",
    "--word-regexp",
  ]);
  const safeShortFlags = new Set([
    "E",
    "F",
    "G",
    "H",
    "I",
    "L",
    "P",
    "a",
    "b",
    "c",
    "h",
    "i",
    "l",
    "n",
    "o",
    "q",
    "s",
    "v",
    "w",
    "x",
  ]);
  let index = 1;
  let hasPattern = false;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-e" || token === "--regexp") {
      if (index + 1 >= tokens.length) return undefined;
      hasPattern = true;
      index += 2;
      continue;
    }
    if (token.startsWith("--")) {
      if (!safeLongFlags.has(token)) return undefined;
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (![...token.slice(1)].every((flag) => safeShortFlags.has(flag))) {
        return undefined;
      }
      index += 1;
      continue;
    }
    break;
  }
  if (!hasPattern) {
    if (index >= tokens.length) return undefined;
    index += 1;
  }
  return { fileOperands: tokens.slice(index) };
}

function parseHeadOrTailCommand(
  identifier: "head" | "tail",
  tokens: readonly string[],
): ParsedCommand | undefined {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-n" || token === "--lines") {
      if (index + 1 >= tokens.length) return undefined;
      const countText = tokens[index + 1]!;
      if (!/^\d+$/u.test(countText)) return undefined;
      const count = Number(countText);
      if (count > maximumLineCount) {
        return undefined;
      }
      index += 2;
      continue;
    }
    const countMatch = /^(?:--lines=|-)(\d+)$/u.exec(token);
    if (countMatch !== null) {
      const count = Number(countMatch[1]);
      if (count > maximumLineCount) return undefined;
      index += 1;
      continue;
    }
    if (
      identifier === "tail" &&
      (token === "-f" || token === "-F" || token === "--follow")
    ) {
      return undefined;
    }
    if (token.startsWith("-")) return undefined;
    break;
  }
  return { fileOperands: tokens.slice(index) };
}

function parseWcCommand(tokens: readonly string[]): ParsedCommand | undefined {
  const safeLongFlags = new Set([
    "--bytes",
    "--chars",
    "--lines",
    "--max-line-length",
    "--words",
  ]);
  const safeShortFlags = new Set(["L", "c", "l", "m", "w"]);
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("--")) {
      if (!safeLongFlags.has(token)) return undefined;
      index += 1;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (![...token.slice(1)].every((flag) => safeShortFlags.has(flag))) {
        return undefined;
      }
      index += 1;
      continue;
    }
    break;
  }
  return { fileOperands: tokens.slice(index) };
}

function parseCommand(
  identifier: string,
  command: string,
): ParsedCommand | undefined {
  const tokens = tokenizeShellSegment(command);
  if (tokens === undefined || tokens[0] !== identifier) return undefined;
  if (identifier === "jq") return parseJqCommand(tokens);
  if (identifier === "grep") return parseGrepCommand(tokens);
  if (identifier === "head" || identifier === "tail") {
    return parseHeadOrTailCommand(identifier, tokens);
  }
  if (identifier === "wc") return parseWcCommand(tokens);
  return undefined;
}

function validateSpillPath(
  requestedPath: string,
  resolvedPath: string | undefined,
  workingDirectory: string,
  spillDirectory: string,
): boolean {
  const absoluteRequestedPath = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(workingDirectory, requestedPath);
  let requestedDetails;
  let canonicalRequestedPath;
  try {
    requestedDetails = lstatSync(absoluteRequestedPath);
    canonicalRequestedPath = realpathSync(absoluteRequestedPath);
    if (
      resolvedPath !== undefined &&
      realpathSync.native(resolvedPath) !== canonicalRequestedPath
    ) {
      return false;
    }
  } catch {
    return false;
  }
  if (requestedDetails.isSymbolicLink() || !requestedDetails.isFile()) {
    return false;
  }
  if (
    !isWithin(spillDirectory, canonicalRequestedPath) ||
    !spillFilePattern.test(basename(canonicalRequestedPath)) ||
    requestedDetails.size > maximumSpillFileBytes
  ) {
    return false;
  }
  return true;
}

export function evaluateSpillFileShellPolicy(
  request: PermissionRequest,
  spillDirectory: string,
): SpillShellPolicyEvaluation {
  if (request.kind !== "shell") return { result: undefined };
  const startedAt = performance.now();
  const commandIdentifiers = (request.commandSegments ?? [])
    .slice(0, 8)
    .map(({ identifier }) => identifier.slice(0, 32));
  const finish = (
    result: PermissionRequestResult,
    stage: SpillShellPolicyStage,
    fileOperands: readonly string[] = [],
  ): SpillShellPolicyEvaluation => {
    const sdkCommandIdentifiers = request.commands
      .slice(0, 8)
      .map(({ identifier }) => identifier.slice(0, 32));
    const sdkPathSet = new Set(request.possiblePaths);
    const fileOperandSet = new Set(fileOperands);
    return {
      result,
      diagnostics: {
        stage,
        commandIdentifiers,
        commandCount: request.commands.length,
        segmentCount: request.commandSegments?.length ?? 0,
        fileOperandCount: fileOperands.length,
        sdkCommandSummaryDisagrees:
          sdkCommandIdentifiers.length !== commandIdentifiers.length ||
          sdkCommandIdentifiers.some(
            (identifier, index) => identifier !== commandIdentifiers[index],
          ),
        sdkPathSummaryDisagrees:
          sdkPathSet.size !== fileOperandSet.size ||
          [...sdkPathSet].some((path) => !fileOperandSet.has(path)),
        durationMs: Math.max(0, performance.now() - startedAt),
      },
    };
  };
  if (request.managedApprovalRequired === true) {
    return finish({ kind: "no-result" }, "managed_approval_required");
  }
  if (
    request.requestSandboxBypass === true ||
    request.requestSandboxPermissive === true
  ) {
    return finish(
      reject("Sandbox escalation is not allowed."),
      "sandbox_escalation",
    );
  }
  if (request.hasWriteFileRedirection) {
    return finish(reject("Shell access is read-only."), "write_redirection");
  }
  if (request.possibleUrls.length > 0) {
    return finish(
      reject("Shell network access is not allowed."),
      "network_access",
    );
  }
  if (
    request.commandSegments === undefined ||
    request.commandSegments.length === 0
  ) {
    return finish(
      reject(
        "Shell access is limited to read-only grep, head, tail, wc, and jq commands.",
      ),
      "missing_segments",
    );
  }
  const pipelineSegments = splitShellPipeline(request.fullCommandText);
  if (
    hasUnsafeShellSyntax(request.fullCommandText) ||
    pipelineSegments === undefined ||
    pipelineSegments.length !== request.commandSegments.length
  ) {
    return finish(
      reject("The requested shell syntax or arguments are not allowed."),
      "invalid_syntax",
    );
  }
  const fileOperands: string[] = [];
  for (const [index, segment] of request.commandSegments.entries()) {
    if (
      !allowedCommands.has(segment.identifier) ||
      pipelineSegments[index] !== segment.fullCommandText.trim()
    ) {
      return finish(
        reject(
          "Shell access is limited to read-only grep, head, tail, wc, and jq commands.",
        ),
        "unsupported_command",
        fileOperands,
      );
    }
    const parsed = parseCommand(segment.identifier, segment.fullCommandText);
    if (parsed === undefined) {
      return finish(
        reject("The requested shell syntax or arguments are not allowed."),
        "invalid_arguments",
        fileOperands,
      );
    }
    if (index === 0 && parsed.fileOperands.length === 0) {
      return finish(
        reject("A Copilot spill file path is required."),
        "missing_spill_operand",
        fileOperands,
      );
    }
    fileOperands.push(...parsed.fileOperands);
  }
  if (fileOperands.length === 0) {
    return finish(
      reject("A Copilot spill file path is required."),
      "missing_spill_operand",
    );
  }
  let canonicalSpillDirectory;
  try {
    canonicalSpillDirectory = realpathSync(spillDirectory);
  } catch {
    return finish(
      reject("The Copilot spill directory is unavailable."),
      "spill_directory_unavailable",
      fileOperands,
    );
  }
  const workingDirectory =
    request.resolvedWorkingDirectory ?? canonicalSpillDirectory;
  if (
    !fileOperands.every((path) =>
      validateSpillPath(
        path,
        request.resolvedPaths?.[path],
        workingDirectory,
        canonicalSpillDirectory,
      ),
    ) ||
    !request.possiblePaths.every((path) =>
      validateSpillPath(
        path,
        request.resolvedPaths?.[path],
        workingDirectory,
        canonicalSpillDirectory,
      ),
    )
  ) {
    return finish(
      reject("Shell access is limited to current profile Copilot spill files."),
      "invalid_spill_path",
      fileOperands,
    );
  }
  return finish({ kind: "approve-once" }, "approved", fileOperands);
}

export function evaluateSpillFileShellPermission(
  request: PermissionRequest,
  spillDirectory: string,
): PermissionRequestResult | undefined {
  return evaluateSpillFileShellPolicy(request, spillDirectory).result;
}
