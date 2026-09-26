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

function requestedLineCount(command: string): number | undefined {
  const match = /(?:^|\s)(?:-n\s+|--lines(?:=|\s+)|-)(\d+)(?=\s|$)/u.exec(
    command,
  );
  return match === null ? undefined : Number(match[1]);
}

function commandArgumentsAreAllowed(
  identifier: string,
  command: string,
): boolean {
  const commandStart = command.trimStart();
  if (
    !commandStart.startsWith(identifier) ||
    !/^\s/u.test(commandStart.slice(identifier.length))
  ) {
    return false;
  }
  if (identifier === "grep") {
    return !/(?:^|\s)(?:-[^\s]*[rRPf]|--(?:recursive|dereference-recursive|file|include|exclude|exclude-dir))(?=\s|=|$)/u.test(
      command,
    );
  }
  if (identifier === "head" || identifier === "tail") {
    if (
      identifier === "tail" &&
      /(?:^|\s)(?:-[^\s]*[fF]|--follow)(?=\s|=|$)/u.test(command)
    ) {
      return false;
    }
    const count = requestedLineCount(command);
    return count === undefined || count <= maximumLineCount;
  }
  if (identifier === "wc") {
    return !/(?:^|\s)--files0-from(?=\s|=|$)/u.test(command);
  }
  if (identifier === "jq") {
    return !/(?:^|\s)(?:-n|--null-input|-L|--library-path|--from-file|--rawfile|--slurpfile|--argfile|--run-tests)(?=\s|=|$)|(?:^|[^A-Za-z0-9_])(?:env|\$ENV|input|inputs|include|import|module)(?:[^A-Za-z0-9_]|$)/u.test(
      command,
    );
  }
  return false;
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

export function evaluateSpillFileShellPermission(
  request: PermissionRequest,
  spillDirectory: string,
): PermissionRequestResult | undefined {
  if (request.kind !== "shell") return undefined;
  if (request.managedApprovalRequired === true) return { kind: "no-result" };
  if (
    request.requestSandboxBypass === true ||
    request.requestSandboxPermissive === true
  ) {
    return reject("Sandbox escalation is not allowed.");
  }
  if (request.hasWriteFileRedirection) {
    return reject("Shell access is read-only.");
  }
  if (request.possibleUrls.length > 0) {
    return reject("Shell network access is not allowed.");
  }
  if (
    request.commands.length === 0 ||
    request.commands.some(
      ({ identifier, readOnly }) =>
        !readOnly || !allowedCommands.has(identifier),
    )
  ) {
    return reject(
      "Shell access is limited to read-only grep, head, tail, wc, and jq commands.",
    );
  }
  if (
    hasUnsafeShellSyntax(request.fullCommandText) ||
    request.commandSegments === undefined ||
    request.commandSegments.length !== request.commands.length ||
    request.commandSegments.some(
      ({ identifier, fullCommandText }) =>
        !allowedCommands.has(identifier) ||
        !commandArgumentsAreAllowed(identifier, fullCommandText),
    )
  ) {
    return reject("The requested shell syntax or arguments are not allowed.");
  }
  if (request.possiblePaths.length === 0) {
    return reject("A Copilot spill file path is required.");
  }
  let canonicalSpillDirectory;
  try {
    canonicalSpillDirectory = realpathSync(spillDirectory);
  } catch {
    return reject("The Copilot spill directory is unavailable.");
  }
  const workingDirectory =
    request.resolvedWorkingDirectory ?? canonicalSpillDirectory;
  if (
    !request.possiblePaths.every((path) =>
      validateSpillPath(
        path,
        request.resolvedPaths?.[path],
        workingDirectory,
        canonicalSpillDirectory,
      ),
    )
  ) {
    return reject(
      "Shell access is limited to current profile Copilot spill files.",
    );
  }
  return { kind: "approve-once" };
}
