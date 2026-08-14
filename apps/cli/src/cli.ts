import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { HeadlessApplication } from "@ableton-agent/application";
import type { BrowserRootKey } from "@ableton-agent/protocol";
import type { AppEvent } from "@ableton-agent/shared";

import { EXIT_CODES, exitCodeForOperationFailures } from "./exit-codes.js";
import {
  renderMarkdown,
  sanitizeTerminalText,
  StreamingMarkdownRenderer,
} from "./markdown.js";
import {
  browserRootsMarkdown,
  connectionStatusMarkdown,
  devicesMarkdown,
  snapshotMarkdown,
  transportMarkdown,
} from "./presentation.js";
import {
  createColorizer,
  plainColorizer,
  type Colorizer,
  type TerminalPresentation,
} from "./terminal.js";
import {
  captureScenarioBaseline,
  sanitizeTraceValue,
  scenarioPrompt,
  type ScenarioRunContext,
  verifyScenario,
} from "./scenario.js";

export type CliCommand =
  | { name: "chat"; json: false }
  | { name: "status"; json: boolean }
  | { name: "doctor"; json: boolean }
  | { name: "live-smoke"; json: boolean }
  | { name: "capabilities"; json: boolean }
  | { name: "snapshot"; json: boolean }
  | { name: "transport"; json: boolean }
  | { name: "browser-roots"; json: boolean }
  | {
      name: "browser-category";
      root: BrowserRootKey;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "browser-search";
      query: string;
      roots: BrowserRootKey[];
      maxNodes: number;
      maxResults: number;
      maxDepth: number;
      maxDurationMs: number;
      json: boolean;
    }
  | {
      name: "browser-load";
      trackNumber: number;
      query: string;
      resultNumber: number;
      roots: BrowserRootKey[];
      maxNodes: number;
      maxResults: number;
      maxDepth: number;
      maxDurationMs: number;
      json: boolean;
    }
  | { name: "devices"; trackNumber: number; json: boolean }
  | {
      name: "parameters";
      trackNumber: number;
      deviceNumber: number;
      json: boolean;
    }
  | {
      name: "rack-chains";
      trackNumber: number;
      deviceNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "drum-pads";
      trackNumber: number;
      deviceNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "chain-devices";
      trackNumber: number;
      deviceNumber: number;
      chainNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "pad-chains";
      trackNumber: number;
      deviceNumber: number;
      padNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "pad-chain-devices";
      trackNumber: number;
      deviceNumber: number;
      padNumber: number;
      chainNumber: number;
      offset: number;
      limit: number;
      json: boolean;
    }
  | {
      name: "run";
      prompt: string;
      json: boolean;
      scenarioId?: string;
      sessionId?: string;
      tracePath?: string;
      timeoutMs?: number;
    }
  | { name: "session-new"; json: boolean }
  | { name: "session-resume"; sessionId: string; json: boolean }
  | { name: "session-current"; json: boolean }
  | { name: "help"; json: false };

export class CliUsageError extends Error {}

export function parseArgs(args: readonly string[]): CliCommand {
  const json = args.includes("--json");
  const positional = args.filter((argument) => argument !== "--json");
  const command = positional[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    return { name: "help", json: false };
  }
  if (command === "chat") {
    if (positional.length !== 1 || json) {
      throw new CliUsageError("chat does not accept arguments or --json");
    }
    return { name: "chat", json: false };
  }
  if (command === "session-new" || command === "session-current") {
    if (positional.length !== 1) {
      throw new CliUsageError(`${command} does not accept arguments`);
    }
    return { name: command, json };
  }
  if (command === "session-resume") {
    if (positional.length !== 2 || !positional[1]?.trim()) {
      throw new CliUsageError("session-resume requires a Copilot session ID");
    }
    return { name: command, sessionId: positional[1], json };
  }
  if (
    command === "status" ||
    command === "doctor" ||
    command === "live-smoke" ||
    command === "capabilities" ||
    command === "snapshot" ||
    command === "transport" ||
    command === "browser-roots"
  ) {
    if (positional.length !== 1) {
      throw new CliUsageError(
        `${command} does not accept positional arguments`,
      );
    }
    return { name: command, json };
  }
  if (command === "browser-category") {
    const page = parsePageArgs(positional, 32, 64);
    if (page.positional.length !== 2) {
      throw new CliUsageError("browser-category requires a browser root key");
    }
    return {
      name: command,
      root: parseBrowserRoot(page.positional[1] ?? ""),
      offset: page.offset,
      limit: page.limit,
      json,
    };
  }
  if (command === "browser-search") {
    const search = parseBrowserSearchArgs(positional);
    if (search.positional.length !== 2) {
      throw new CliUsageError(
        "browser-search requires one quoted search query",
      );
    }
    return {
      name: command,
      query: search.positional[1] ?? "",
      ...search.options,
      json,
    };
  }
  if (command === "browser-load") {
    const approved = positional.includes("--approve");
    const search = parseBrowserSearchArgs(
      positional.filter((argument) => argument !== "--approve"),
    );
    if (search.positional.length !== 4) {
      throw new CliUsageError(
        "browser-load requires track number, quoted query, and result number",
      );
    }
    if (!approved) {
      throw new CliUsageError(
        "browser-load requires --approve for this reversible mutation",
      );
    }
    return {
      name: command,
      trackNumber: parsePositiveIndex(search.positional[1] ?? "", "track"),
      query: search.positional[2] ?? "",
      resultNumber: parsePositiveIndex(search.positional[3] ?? "", "result"),
      ...search.options,
      json,
    };
  }
  if (command === "devices") {
    if (positional.length !== 2) {
      throw new CliUsageError("devices requires a one-based track number");
    }
    return {
      name: "devices",
      trackNumber: parsePositiveIndex(positional[1] ?? "", "track"),
      json,
    };
  }
  if (command === "parameters") {
    if (positional.length !== 3) {
      throw new CliUsageError(
        "parameters requires one-based track and device numbers",
      );
    }
    return {
      name: "parameters",
      trackNumber: parsePositiveIndex(positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(positional[2] ?? "", "device"),
      json,
    };
  }
  if (command === "rack-chains" || command === "drum-pads") {
    const page = parsePageArgs(
      positional,
      command === "rack-chains" ? 16 : 32,
      command === "rack-chains" ? 64 : 128,
    );
    if (page.positional.length !== 3) {
      throw new CliUsageError(
        `${command} requires one-based track and device numbers`,
      );
    }
    return {
      name: command,
      trackNumber: parsePositiveIndex(page.positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(page.positional[2] ?? "", "device"),
      offset: page.offset,
      limit: page.limit,
      json,
    };
  }
  if (command === "chain-devices") {
    const page = parsePageArgs(positional, 32, 128);
    if (page.positional.length !== 4) {
      throw new CliUsageError(
        "chain-devices requires one-based track, device, and chain numbers",
      );
    }
    return {
      name: command,
      trackNumber: parsePositiveIndex(page.positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(page.positional[2] ?? "", "device"),
      chainNumber: parsePositiveIndex(page.positional[3] ?? "", "chain"),
      offset: page.offset,
      limit: page.limit,
      json,
    };
  }
  if (command === "pad-chains" || command === "pad-chain-devices") {
    const page = parsePageArgs(
      positional,
      command === "pad-chains" ? 8 : 32,
      command === "pad-chains" ? 64 : 128,
    );
    const expectedLength = command === "pad-chains" ? 4 : 5;
    if (page.positional.length !== expectedLength) {
      throw new CliUsageError(
        `${command} requires one-based track, device, pad${command === "pad-chain-devices" ? ", and chain" : ""} numbers`,
      );
    }
    const common = {
      trackNumber: parsePositiveIndex(page.positional[1] ?? "", "track"),
      deviceNumber: parsePositiveIndex(page.positional[2] ?? "", "device"),
      padNumber: parsePositiveIndex(page.positional[3] ?? "", "pad"),
      offset: page.offset,
      limit: page.limit,
      json,
    };
    return command === "pad-chains"
      ? { name: command, ...common }
      : {
          name: command,
          ...common,
          chainNumber: parsePositiveIndex(page.positional[4] ?? "", "chain"),
        };
  }
  if (command === "run") {
    const run = parseRunArgs(positional.slice(1));
    const prompt = run.promptParts.join(" ").trim();
    if (!prompt) {
      throw new CliUsageError("run requires a prompt");
    }
    return {
      name: "run",
      prompt,
      json,
      ...(run.scenarioId === undefined ? {} : { scenarioId: run.scenarioId }),
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
      ...(run.tracePath === undefined ? {} : { tracePath: run.tracePath }),
      ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
    };
  }
  throw new CliUsageError(`Unknown command: ${command}`);
}

function parseRunArgs(args: readonly string[]): {
  promptParts: string[];
  scenarioId?: string;
  sessionId?: string;
  tracePath?: string;
  timeoutMs?: number;
} {
  const promptParts: string[] = [];
  const options: {
    scenarioId?: string;
    sessionId?: string;
    tracePath?: string;
    timeoutMs?: number;
  } = {};
  const flags: Readonly<
    Record<string, "scenarioId" | "sessionId" | "tracePath" | "timeoutMs">
  > = {
    "--scenario": "scenarioId",
    "--session": "sessionId",
    "--trace": "tracePath",
    "--timeout-ms": "timeoutMs",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const key = flags[argument];
    if (key === undefined) {
      if (argument.startsWith("--")) {
        throw new CliUsageError(`Unknown run option: ${argument}`);
      }
      promptParts.push(argument);
      continue;
    }
    if (options[key] !== undefined) {
      throw new CliUsageError(`${argument} may be specified only once`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || !value.trim()) {
      throw new CliUsageError(`${argument} requires a value`);
    }
    index += 1;
    if (key === "timeoutMs") {
      const timeoutMs = Number(value);
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 10_000 ||
        timeoutMs > 600_000
      ) {
        throw new CliUsageError(
          "--timeout-ms must be an integer from 10000 to 600000",
        );
      }
      options.timeoutMs = timeoutMs;
    } else if (key === "scenarioId" && !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new CliUsageError("--scenario must be a lowercase scenario ID");
    } else {
      options[key] = value;
    }
  }
  return { promptParts, ...options };
}

function parsePositiveIndex(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`${label} number must be a positive integer`);
  }
  return parsed;
}

function parsePageArgs(
  args: readonly string[],
  defaultLimit: number,
  maximumLimit: number,
): { positional: string[]; offset: number; limit: number } {
  const positional: string[] = [];
  let offset = 0;
  let limit = defaultLimit;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--offset" && argument !== "--limit") {
      positional.push(argument ?? "");
      continue;
    }

    const value = Number(args[index + 1]);
    if (
      !Number.isInteger(value) ||
      value < (argument === "--offset" ? 0 : 1) ||
      (argument === "--limit" && value > maximumLimit)
    ) {
      throw new CliUsageError(
        argument === "--offset"
          ? "offset must be a non-negative integer"
          : `limit must be an integer from 1 to ${maximumLimit}`,
      );
    }
    if (argument === "--offset") {
      offset = value;
    } else {
      limit = value;
    }
    index += 1;
  }
  return { positional, offset, limit };
}

const browserRootKeys = [
  "sounds",
  "drums",
  "instruments",
  "audio_effects",
  "midi_effects",
  "max_for_live",
  "plugins",
  "clips",
  "samples",
  "packs",
  "user_library",
  "current_project",
] as const;

function parseBrowserRoot(value: string): BrowserRootKey {
  if (!(browserRootKeys as readonly string[]).includes(value)) {
    throw new CliUsageError(`unknown browser root: ${value}`);
  }
  return value as BrowserRootKey;
}

function parseBrowserSearchArgs(args: readonly string[]): {
  positional: string[];
  options: {
    roots: BrowserRootKey[];
    maxNodes: number;
    maxResults: number;
    maxDepth: number;
    maxDurationMs: number;
  };
} {
  const positional: string[] = [];
  const roots: BrowserRootKey[] = [];
  let maxNodes = 128;
  let maxResults = 20;
  let maxDepth = 4;
  let maxDurationMs = 100;
  const numeric = {
    "--max-nodes": { minimum: 1, maximum: 256 },
    "--limit": { minimum: 1, maximum: 32 },
    "--depth": { minimum: 0, maximum: 6 },
    "--duration-ms": { minimum: 10, maximum: 250 },
  } as const;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      roots.push(parseBrowserRoot(args[index + 1] ?? ""));
      index += 1;
      continue;
    }
    if (argument && argument in numeric) {
      const bounds = numeric[argument as keyof typeof numeric];
      const value = Number(args[index + 1]);
      if (
        !Number.isInteger(value) ||
        value < bounds.minimum ||
        value > bounds.maximum
      ) {
        throw new CliUsageError(
          `${argument} must be an integer from ${bounds.minimum} to ${bounds.maximum}`,
        );
      }
      if (argument === "--max-nodes") maxNodes = value;
      if (argument === "--limit") maxResults = value;
      if (argument === "--depth") maxDepth = value;
      if (argument === "--duration-ms") maxDurationMs = value;
      index += 1;
      continue;
    }
    positional.push(argument ?? "");
  }
  if (new Set(roots).size !== roots.length) {
    throw new CliUsageError("browser roots must be unique");
  }
  return {
    positional,
    options: {
      roots:
        roots.length > 0
          ? roots
          : ["instruments", "audio_effects", "midi_effects"],
      maxNodes,
      maxResults,
      maxDepth,
      maxDurationMs,
    },
  };
}

export interface CliIo {
  write(text: string): void;
  writeRaw(text: string): void;
  writeError(text: string): void;
}

export interface InteractiveInput {
  readLine(): Promise<string | undefined>;
}

export interface InteractiveApprovalRequest {
  metadata: {
    name?: string;
    title: string;
    risk: string;
    duration: string;
    requiredCapability?: string;
  };
  arguments: Readonly<Record<string, unknown>>;
}

export async function requestInteractiveApproval(
  request: InteractiveApprovalRequest,
  input: InteractiveInput,
  io: CliIo,
  presentation?: TerminalPresentation,
): Promise<boolean> {
  if (presentation?.rich) {
    io.write(
      renderMarkdown(
        [
          "## Approval required",
          "",
          `- **Action:** ${request.metadata.title}`,
          `- **Risk:** ${request.metadata.risk}`,
          `- **Duration:** ${request.metadata.duration}`,
          `- **Capability:** ${request.metadata.requiredCapability ?? "none"}`,
        ].join("\n"),
        presentation,
      ),
    );
  } else {
    io.write(
      `Approval required: ${request.metadata.title} (${request.metadata.risk})`,
    );
  }
  io.writeRaw("Approve once? [y/N/d for details] ");
  while (true) {
    const answer = (await input.readLine())?.trim().toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "d" || answer === "details") {
      const plainDetails = [
        `Title: ${request.metadata.title}`,
        `Risk: ${request.metadata.risk}`,
        `Duration: ${request.metadata.duration}`,
        `Capability: ${request.metadata.requiredCapability ?? "none"}`,
        `Arguments: ${JSON.stringify(request.arguments)}`,
      ].join("\n");
      const richDetails = [
        `Title: ${request.metadata.title}`,
        `Risk: ${request.metadata.risk}`,
        `Duration: ${request.metadata.duration}`,
        `Capability: ${request.metadata.requiredCapability ?? "none"}`,
        `Arguments:\n${JSON.stringify(request.arguments, null, 2)}`,
      ].join("\n");
      io.write(
        presentation?.rich
          ? renderMarkdown(
              `### Details\n\n${richDetails
                .split("\n")
                .map((line) => `    ${line}`)
                .join("\n")}`,
              presentation,
            )
          : plainDetails,
      );
      io.writeRaw("Approve once? [y/N] ");
      continue;
    }
    return false;
  }
}

/**
 * Renders a shared application event as a single line of terminal output.
 * Pass a `Colorizer` (see terminal.ts) to apply ANSI color to the status
 * glyph; the default is plain, uncolored text.
 */
export function renderEvent(
  event: AppEvent,
  colors: Colorizer = plainColorizer(),
): string | undefined {
  switch (event.type) {
    case "lifecycle.changed":
      return `application: ${sanitizeTerminalText(event.state)}`;
    case "ableton.connection_changed":
      return `ableton: ${event.status.state}`;
    case "ableton.event_received":
      return undefined;
    case "ableton.event_gap":
      return colors.red(
        `✗ Ableton event gap: expected #${event.expectedSequence}, received #${event.receivedSequence}`,
      );
    case "agent.message_delta":
      return sanitizeTerminalText(event.content);
    case "agent.message_complete":
      return sanitizeTerminalText(event.content);
    case "operation.started":
      return colors.dim(`• ${sanitizeTerminalText(event.label)}`);
    case "operation.completed":
      return colors.green(`✓ ${sanitizeTerminalText(event.summary)}`);
    case "operation.failed":
      return colors.red(`✗ ${sanitizeTerminalText(event.message)}`);
  }
}

export interface RunOptions {
  /** Suppress ambient/informational output (banners, operation progress). */
  quiet?: boolean;
  /** Enable ANSI color for status glyphs in rendered events. */
  color?: boolean;
  /** Terminal capabilities used by the interactive rich transcript. */
  terminal?: TerminalPresentation;
  /** Reviewed integration scenario context, present only for run --scenario. */
  scenario?: ScenarioRunContext;
}

function humanOutput(
  plain: string,
  markdown: string,
  options: RunOptions,
): string {
  return options.terminal?.rich
    ? renderMarkdown(markdown, options.terminal)
    : sanitizeTerminalText(plain);
}

export async function runCommand(
  command: CliCommand,
  application: HeadlessApplication,
  io: CliIo,
  input?: InteractiveInput,
  options: RunOptions = {},
): Promise<number> {
  if (command.name === "help") {
    io.write(
      [
        "Ableton Agent",
        "",
        "Usage:",
        "  ableton-agent chat",
        "  ableton-agent status [--json]",
        "  ableton-agent doctor [--json]",
        "  ableton-agent live-smoke [--json]",
        "  ableton-agent capabilities [--json]",
        "  ableton-agent snapshot [--json]",
        "  ableton-agent transport [--json]",
        "  ableton-agent browser-roots [--json]",
        "  ableton-agent browser-category <root-key> [--offset N] [--limit N] [--json]",
        '  ableton-agent browser-search "<query>" [--root KEY] [--max-nodes N] [--limit N] [--depth N] [--duration-ms N] [--json]',
        '  ableton-agent browser-load <track-number> "<query>" <result-number> --approve [browser search options] [--json]',
        "  ableton-agent devices <track-number> [--json]",
        "  ableton-agent parameters <track-number> <device-number> [--json]",
        "  ableton-agent rack-chains <track-number> <device-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent chain-devices <track-number> <device-number> <chain-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent drum-pads <track-number> <device-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent pad-chains <track-number> <device-number> <pad-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent pad-chain-devices <track-number> <device-number> <pad-number> <chain-number> [--offset N] [--limit N] [--json]",
        "  ableton-agent run <prompt> [--scenario ID] [--session ID] [--trace PATH] [--timeout-ms N] [--json]",
        "  ableton-agent session-current [--json]",
        "  ableton-agent session-new [--json]",
        "  ableton-agent session-resume <session-id> [--json]",
        "",
        "Global flags:",
        "  --json    Emit structured JSON instead of human-readable text.",
        "  --quiet   Print only the final result, suppressing progress output.",
        "",
        "Color is used only for a real terminal and is disabled by the",
        "NO_COLOR environment variable or when output is redirected.",
      ].join("\n"),
    );
    return EXIT_CODES.SUCCESS;
  }

  if (command.name === "chat") {
    if (!input) {
      throw new Error("Interactive input is required for chat");
    }
    return runInteractive(application, io, input, options);
  }

  await application.start({
    startAgent:
      command.name === "run" ||
      command.name === "session-new" ||
      command.name === "session-resume" ||
      command.name === "session-current",
    ...(command.name === "run" && command.sessionId !== undefined
      ? { preferredAgentSessionId: command.sessionId }
      : {}),
  });
  const operationFailures: Array<
    Extract<AppEvent, { type: "operation.failed" }>
  > = [];
  const turnEvents: AppEvent[] = [];
  const unsubscribe = application.subscribe((event) => {
    turnEvents.push(event);
    if (event.type === "operation.failed") {
      operationFailures.push(event);
    }
  });
  try {
    if (command.name === "session-current") {
      const payload = { sessionId: application.agentSessionId };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : `Session: ${payload.sessionId ?? "none"}`,
      );
      return EXIT_CODES.SUCCESS;
    }
    if (command.name === "session-new") {
      const payload = { sessionId: await application.createAgentSession() };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : `Session created: ${payload.sessionId}`,
      );
      return EXIT_CODES.SUCCESS;
    }
    if (command.name === "session-resume") {
      await application.resumeAgentSession(command.sessionId);
      const payload = { sessionId: application.agentSessionId };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : `Session resumed: ${payload.sessionId ?? command.sessionId}`,
      );
      return EXIT_CODES.SUCCESS;
    }
    if (command.name === "status") {
      const status = await application.getStatus();
      const payload = {
        application: application.state,
        ableton: status,
        healthy: application.state === "ready" && status.state === "connected",
      };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : humanOutput(
              [
                `Application: ${payload.application}`,
                `Ableton: ${status.state}`,
                `Healthy: ${payload.healthy ? "yes" : "no"}`,
              ].join("\n"),
              connectionStatusMarkdown(payload.application, status),
              options,
            ),
      );
      return payload.healthy ? EXIT_CODES.SUCCESS : EXIT_CODES.CONNECTION_ERROR;
    }

    if (command.name === "doctor") {
      const status = await application.getStatus();
      const ping =
        status.state === "connected" ? await application.ping() : null;
      const payload = {
        application: application.state,
        ableton: status,
        ping,
        healthy: status.state === "connected" && ping?.pong === true,
      };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : [
              `Application: ${payload.application}`,
              `Ableton: ${status.state}`,
              `Ping: ${ping?.pong === true ? "ok" : "unavailable"}`,
              `Healthy: ${payload.healthy ? "yes" : "no"}`,
            ].join("\n"),
      );
      return payload.healthy ? EXIT_CODES.SUCCESS : EXIT_CODES.CONNECTION_ERROR;
    }

    if (command.name === "live-smoke") {
      const status = await application.getStatus();
      if (status.state !== "connected") {
        io.write(
          command.json
            ? JSON.stringify({ healthy: false, ableton: status })
            : `Real-Live smoke failed: Ableton is ${status.state}`,
        );
        return EXIT_CODES.CONNECTION_ERROR;
      }
      const [ping, capabilities, snapshot, transport, browser] =
        await Promise.all([
          application.ping(),
          application.getCapabilities(),
          application.inspectSession(),
          application.inspectArrangementTransport({ offset: 0, limit: 16 }),
          application.inspectBrowserRoots(),
        ]);
      const payload = {
        healthy: ping.pong,
        liveVersion: status.liveVersion,
        remoteScriptVersion: status.remoteScriptVersion,
        projectId: status.projectId,
        supportedCapabilities: Object.values(capabilities.capabilities).filter(
          Boolean,
        ).length,
        trackCount: snapshot.trackCount,
        cuePointCount: transport.totalCuePoints,
        browserRootCount: browser.roots.length,
      };
      io.write(
        command.json
          ? JSON.stringify(payload)
          : [
              `Live ${payload.liveVersion} · Remote Script ${payload.remoteScriptVersion}`,
              `Tracks: ${payload.trackCount}`,
              `Capabilities: ${payload.supportedCapabilities}`,
              `Cue points: ${payload.cuePointCount}`,
              `Browser roots: ${payload.browserRootCount}`,
              `Healthy: ${payload.healthy ? "yes" : "no"}`,
            ].join("\n"),
      );
      return payload.healthy ? EXIT_CODES.SUCCESS : EXIT_CODES.CONNECTION_ERROR;
    }

    if (command.name === "capabilities") {
      const capabilities = await application.getCapabilities();
      io.write(
        command.json
          ? JSON.stringify(capabilities)
          : Object.entries(capabilities.capabilities)
              .filter(([, supported]) => supported)
              .map(([name]) => name)
              .join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "browser-roots") {
      const result = await application.inspectBrowserRoots();
      io.write(
        command.json
          ? JSON.stringify(result)
          : humanOutput(
              [
                `Browser roots: ${result.roots.length}`,
                ...result.roots.map(
                  (root) =>
                    `  ${root.root}: ${root.name}${(root.isNavigable ?? root.isFolder) ? " (navigable)" : ""}`,
                ),
              ].join("\n"),
              browserRootsMarkdown(result),
              options,
            ),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "browser-category") {
      const roots = await application.inspectBrowserRoots();
      const root = roots.roots.find(
        (candidate) => candidate.root === command.root,
      );
      if (!root) {
        throw new CliUsageError(
          "browser root is unavailable in this Live version",
        );
      }
      const result = await application.inspectBrowserChildren({
        expectedItemReference: root.reference,
        expectedItemRoot: root.root,
        expectedItemPath: root.path,
        expectedItemName: root.name,
        expectedItemUri: root.uri,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(result)
          : [
              `${root.name}: ${result.total}`,
              ...result.items.map(
                (item, index) =>
                  `  ${command.offset + index + 1}. ${item.name}${(item.isNavigable ?? item.isFolder) ? "/" : ""}${(item.isLoadableDevice ?? item.isBuiltInDevice) ? " (device preset)" : item.isLoadable ? " (unsupported load type)" : ""}`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "browser-search") {
      const result = await application.searchBrowser({
        query: command.query,
        roots: command.roots,
        maxNodes: command.maxNodes,
        maxResults: command.maxResults,
        maxDepth: command.maxDepth,
        maxDurationMs: command.maxDurationMs,
      });
      io.write(
        command.json
          ? JSON.stringify(result)
          : [
              `Browser matches: ${result.items.length} (${result.visitedNodes} nodes, ${result.stopReason})`,
              ...result.items.map(
                (item, index) =>
                  `  ${index + 1}. [${item.root}] ${item.path.map((segment) => segment.name).join(" / ")}${item.isLoadable ? " (loadable)" : ""}`,
              ),
              ...(result.truncated
                ? ["  Results truncated by configured limits."]
                : []),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "browser-load") {
      const track = await resolveTrack(application, command.trackNumber);
      const search = await application.searchBrowser({
        query: command.query,
        roots: command.roots,
        maxNodes: command.maxNodes,
        maxResults: command.maxResults,
        maxDepth: command.maxDepth,
        maxDurationMs: command.maxDurationMs,
      });
      const item = search.items[command.resultNumber - 1];
      if (!item) {
        throw new CliUsageError("browser result number is out of range");
      }
      const result = await application.loadBrowserItem({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        expectedItemReference: item.reference,
        expectedItemRoot: item.root,
        expectedItemPath: item.path,
        expectedItemName: item.name,
        expectedItemUri: item.uri,
      });
      io.write(
        command.json
          ? JSON.stringify(result)
          : `Loaded ${result.item.name} on ${result.track.name}; devices ${result.before.deviceCount} → ${result.after.deviceCount} (verified).`,
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "snapshot") {
      const snapshot = await application.inspectSession();
      io.write(
        command.json
          ? JSON.stringify(snapshot)
          : humanOutput(
              [
                `Tempo: ${snapshot.tempo}`,
                `Time signature: ${snapshot.timeSignature.numerator}/${snapshot.timeSignature.denominator}`,
                `Playing: ${snapshot.isPlaying ? "yes" : "no"}`,
                `Tracks: ${snapshot.trackCount}`,
                ...snapshot.tracks.map(
                  (track) => `  ${track.index + 1}. ${track.name}`,
                ),
              ].join("\n"),
              snapshotMarkdown(snapshot),
              options,
            ),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "transport") {
      const transport = await application.inspectArrangementTransport({
        offset: 0,
        limit: 100,
      });
      io.write(
        command.json
          ? JSON.stringify(transport)
          : humanOutput(
              [
                `Arrangement loop: ${transport.loop.enabled ? "enabled" : "disabled"}`,
                `Loop range: ${transport.loop.start} + ${transport.loop.length} beats`,
                `Cue points: ${transport.totalCuePoints}`,
                ...transport.cuePoints.map(
                  (cuePoint) => `  ${cuePoint.time}: ${cuePoint.name}`,
                ),
              ].join("\n"),
              transportMarkdown(transport),
              options,
            ),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "devices") {
      const track = await resolveTrack(application, command.trackNumber);
      const devices = await application.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: 0,
        limit: 128,
      });
      io.write(
        command.json
          ? JSON.stringify(devices)
          : humanOutput(
              [
                `Devices on track ${command.trackNumber} (${track.name}): ${devices.total}`,
                ...devices.devices.map(
                  (device) =>
                    `  ${device.index + 1}. ${device.name} (${device.parameterCount} parameters, ${device.enabled === null ? "enable state unavailable" : device.enabled ? "enabled" : "disabled"})`,
                ),
              ].join("\n"),
              devicesMarkdown(command.trackNumber, track.name, devices),
              options,
            ),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "parameters") {
      const track = await resolveTrack(application, command.trackNumber);
      const devicePage = await application.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: command.deviceNumber - 1,
        limit: 1,
      });
      const device = devicePage.devices[0];
      if (!device) {
        throw new CliUsageError("device number is out of range");
      }
      const parameters = await application.inspectDeviceParameters({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: 0,
        limit: 256,
      });
      io.write(
        command.json
          ? JSON.stringify(parameters)
          : [
              `Parameters for ${device.name}: ${parameters.total}`,
              ...parameters.parameters.map(
                (parameter) =>
                  `  ${parameter.index + 1}. ${parameter.name}: ${parameter.normalizedValue.toFixed(3)}${parameter.isQuantized ? " (quantized)" : ""}${parameter.isEnabled ? "" : " (disabled)"}`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "rack-chains") {
      const { track, device } = await resolveDevice(
        application,
        command.trackNumber,
        command.deviceNumber,
      );
      const chains = await application.inspectRackChains({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(chains)
          : [
              `Chains in ${device.name}: ${chains.total}`,
              ...chains.chains.map(
                (chain) =>
                  `  ${chain.index + 1}. ${chain.name || "(unnamed)"} (${chain.deviceCount} devices)`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "chain-devices") {
      const { track, device, chain } = await resolveRackChain(
        application,
        command.trackNumber,
        command.deviceNumber,
        command.chainNumber,
      );
      const devices = await application.inspectRackChainDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        chainIndex: chain.index,
        expectedChainReference: chain.reference,
        expectedChainName: chain.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(devices)
          : [
              `Devices in chain ${chain.name || command.chainNumber}: ${devices.total}`,
              ...devices.devices.map(
                (nestedDevice) =>
                  `  ${nestedDevice.index + 1}. ${nestedDevice.name} (${nestedDevice.parameterCount} parameters)`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "drum-pads") {
      const { track, device } = await resolveDevice(
        application,
        command.trackNumber,
        command.deviceNumber,
      );
      const pads = await application.inspectDrumRackPads({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(pads)
          : [
              `Pads in ${device.name}: ${pads.total}`,
              ...pads.pads.map(
                (pad) =>
                  `  ${pad.index + 1}. note ${pad.note} ${pad.name || "(unnamed)"} (${pad.chainCount} chains)`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "pad-chains") {
      const { track, device, pad } = await resolveDrumPad(
        application,
        command.trackNumber,
        command.deviceNumber,
        command.padNumber,
      );
      const chains = await application.inspectDrumPadChains({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        padIndex: pad.index,
        expectedPadReference: pad.reference,
        expectedPadNote: pad.note,
        expectedPadName: pad.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(chains)
          : [
              `Chains for pad ${pad.note} ${pad.name || "(unnamed)"}: ${chains.total}`,
              ...chains.chains.map(
                (chain) =>
                  `  ${chain.index + 1}. ${chain.name || "(unnamed)"} (${chain.deviceCount} devices)`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    if (command.name === "pad-chain-devices") {
      const { track, device, pad, chain } = await resolveDrumPadChain(
        application,
        command.trackNumber,
        command.deviceNumber,
        command.padNumber,
        command.chainNumber,
      );
      const devices = await application.inspectDrumPadChainDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        deviceIndex: device.index,
        expectedDeviceReference: device.reference,
        expectedDeviceName: device.name,
        padIndex: pad.index,
        expectedPadReference: pad.reference,
        expectedPadNote: pad.note,
        expectedPadName: pad.name,
        chainIndex: chain.index,
        expectedChainReference: chain.reference,
        expectedChainName: chain.name,
        offset: command.offset,
        limit: command.limit,
      });
      io.write(
        command.json
          ? JSON.stringify(devices)
          : [
              `Devices in pad chain ${chain.name || command.chainNumber}: ${devices.total}`,
              ...devices.devices.map(
                (nestedDevice) =>
                  `  ${nestedDevice.index + 1}. ${nestedDevice.name} (${nestedDevice.parameterCount} parameters)`,
              ),
            ].join("\n"),
      );
      return EXIT_CODES.SUCCESS;
    }

    const scenario = options.scenario;
    if (
      command.scenarioId !== undefined &&
      (scenario === undefined || scenario.manifest.id !== command.scenarioId)
    ) {
      throw new CliUsageError(
        `Scenario '${command.scenarioId}' was not loaded for this run`,
      );
    }
    const baseline =
      scenario === undefined
        ? undefined
        : await captureScenarioBaseline(application);
    const response = await application.send(
      scenario === undefined
        ? command.prompt
        : scenarioPrompt(command.prompt, scenario),
    );
    const assertions =
      scenario === undefined || baseline === undefined
        ? []
        : await verifyScenario(application, scenario, baseline);
    const approvalDecisions = scenario?.approvals.decisions ?? [];
    const policyViolations: string[] = [];
    if (approvalDecisions.some((decision) => !decision.approved)) {
      policyViolations.push("scenario approval policy denied a tool request");
    }
    const startedOperations = turnEvents.filter(
      (event): event is Extract<AppEvent, { type: "operation.started" }> =>
        event.type === "operation.started",
    );
    if (
      scenario !== undefined &&
      startedOperations.length > scenario.manifest.maxToolCalls
    ) {
      policyViolations.push("tool call budget exceeded");
    }
    if (
      assertions.some((assertion) => !assertion.passed) &&
      /\b(done|success|successful|created|loaded|verified)\b/i.test(response)
    ) {
      policyViolations.push(
        "assistant claimed success while deterministic assertions failed",
      );
    }
    const status = await application.getStatus();
    const ok =
      operationFailures.length === 0 &&
      policyViolations.length === 0 &&
      assertions.every((assertion) => assertion.passed);
    const payload = {
      ok,
      response,
      sessionId: application.agentSessionId,
      scenarioId: command.scenarioId,
      ableton:
        status.state === "connected"
          ? {
              liveVersion: status.liveVersion,
              remoteScriptVersion: status.remoteScriptVersion,
            }
          : { state: status.state },
      operationFailures: operationFailures.map((failure) =>
        sanitizeTraceValue(failure),
      ),
      operations: turnEvents
        .filter((event) => event.type.startsWith("operation."))
        .map((event) => sanitizeTraceValue(event)),
      approvals: approvalDecisions,
      assertions,
      policyViolations,
      budgets:
        scenario === undefined
          ? undefined
          : {
              toolCalls: startedOperations.length,
              maxToolCalls: scenario.manifest.maxToolCalls,
              mutations: approvalDecisions.filter(
                (decision) => decision.approved && decision.risk !== "read",
              ).length,
              maxMutations: scenario.manifest.maxMutations,
            },
      exitClassification: ok
        ? "success"
        : policyViolations.length > 0 ||
            assertions.some((assertion) => !assertion.passed)
          ? "scenario_failed"
          : "operation_failed",
    };
    if (command.tracePath !== undefined) {
      await writeTraceFile(command.tracePath, payload);
    }
    io.write(
      command.json
        ? JSON.stringify(payload)
        : humanOutput(response, response, options),
    );
    if (ok) return EXIT_CODES.SUCCESS;
    return operationFailures.length > 0
      ? exitCodeForOperationFailures(operationFailures)
      : EXIT_CODES.OPERATION_ERROR;
  } finally {
    unsubscribe();
    await application.stop();
  }

  async function writeTraceFile(path: string, payload: unknown): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    const tracePayload =
      typeof payload === "object" && payload !== null && "response" in payload
        ? {
            ...(payload as Record<string, unknown>),
            response:
              "[assistant response omitted from trace; retained in stdout]",
          }
        : payload;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(sanitizeTraceValue(tracePayload), undefined, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, path);
  }

  async function resolveTrack(
    application: HeadlessApplication,
    trackNumber: number,
  ) {
    const snapshot = await application.inspectSession();
    const track = snapshot.tracks[trackNumber - 1];
    if (!track) {
      throw new CliUsageError("track number is out of range");
    }
    return track;
  }

  async function resolveDevice(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
  ) {
    const track = await resolveTrack(application, trackNumber);
    const page = await application.inspectDevices({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      offset: deviceNumber - 1,
      limit: 1,
    });
    const device = page.devices[0];
    if (!device) {
      throw new CliUsageError("device number is out of range");
    }
    return { track, device };
  }

  async function resolveRackChain(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
    chainNumber: number,
  ) {
    const { track, device } = await resolveDevice(
      application,
      trackNumber,
      deviceNumber,
    );
    const page = await application.inspectRackChains({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      offset: chainNumber - 1,
      limit: 1,
    });
    const chain = page.chains[0];
    if (!chain) {
      throw new CliUsageError("chain number is out of range");
    }
    return { track, device, chain };
  }

  async function resolveDrumPad(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
    padNumber: number,
  ) {
    const { track, device } = await resolveDevice(
      application,
      trackNumber,
      deviceNumber,
    );
    const page = await application.inspectDrumRackPads({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      offset: padNumber - 1,
      limit: 1,
    });
    const pad = page.pads[0];
    if (!pad) {
      throw new CliUsageError("pad number is out of range");
    }
    return { track, device, pad };
  }

  async function resolveDrumPadChain(
    application: HeadlessApplication,
    trackNumber: number,
    deviceNumber: number,
    padNumber: number,
    chainNumber: number,
  ) {
    const { track, device, pad } = await resolveDrumPad(
      application,
      trackNumber,
      deviceNumber,
      padNumber,
    );
    const page = await application.inspectDrumPadChains({
      index: track.index,
      expectedReference: track.reference,
      expectedName: track.name,
      deviceIndex: device.index,
      expectedDeviceReference: device.reference,
      expectedDeviceName: device.name,
      padIndex: pad.index,
      expectedPadReference: pad.reference,
      expectedPadNote: pad.note,
      expectedPadName: pad.name,
      offset: chainNumber - 1,
      limit: 1,
    });
    const chain = page.chains[0];
    if (!chain) {
      throw new CliUsageError("chain number is out of range");
    }
    return { track, device, pad, chain };
  }
}

export async function runInteractive(
  application: HeadlessApplication,
  io: CliIo,
  input: InteractiveInput,
  options: RunOptions = {},
): Promise<number> {
  const quiet = options.quiet ?? false;
  const presentation =
    options.terminal ??
    ({
      rich: false,
      width: 80,
      unicode: false,
      colors: createColorizer(options.color ?? false),
    } satisfies TerminalPresentation);
  const colors = presentation.colors;
  let turnProducedOutput = false;
  let streamingRenderer: StreamingMarkdownRenderer | undefined;
  const unsubscribe = application.subscribe((event) => {
    if (event.type === "agent.message_delta") {
      turnProducedOutput = true;
      if (presentation.rich) {
        streamingRenderer ??= new StreamingMarkdownRenderer(
          presentation,
          (text) => io.write(text),
        );
        streamingRenderer.push(event.content);
      } else {
        io.writeRaw(sanitizeTerminalText(event.content));
      }
    } else if (event.type === "agent.message_complete") {
      if (presentation.rich) {
        streamingRenderer ??= new StreamingMarkdownRenderer(
          presentation,
          (text) => io.write(text),
        );
        streamingRenderer.complete(event.content);
        streamingRenderer = undefined;
      } else if (turnProducedOutput) {
        io.writeRaw("\n");
      } else {
        io.write(sanitizeTerminalText(event.content));
      }
      turnProducedOutput = true;
    } else if (
      event.type === "operation.started" ||
      event.type === "operation.completed" ||
      event.type === "operation.failed"
    ) {
      if (!quiet) {
        const rendered = renderEvent(event, colors);
        if (rendered) {
          io.write(rendered);
        }
      }
    }
  });

  try {
    await application.start({ startAgent: true });
    if (!quiet) {
      const status = await application.getStatus();
      io.write(
        presentation.rich
          ? renderMarkdown(
              [
                "# Ableton Agent",
                "",
                `${status.state === "connected" ? "✓" : "!"} Ableton: **${status.state}**${
                  status.state === "connected"
                    ? ` · Live ${status.liveVersion} · Session ${application.agentSessionId ?? "starting"}`
                    : ""
                }`,
                "",
                "Type `/help` for commands.",
              ].join("\n"),
              presentation,
            )
          : "Ableton Agent chat. Type /help for commands.",
      );
    }
    while (true) {
      io.writeRaw(presentation.rich ? presentation.colors.cyan("› ") : "> ");
      const next = await input.readLine();
      if (next === undefined) {
        io.writeRaw("\n");
        return EXIT_CODES.SUCCESS;
      }
      const line = next.trim();
      if (!line) {
        continue;
      }
      if (line === "/exit") {
        return EXIT_CODES.SUCCESS;
      }
      if (line === "/help") {
        io.write(
          [
            "/help      Show commands",
            "/status    Show connection status",
            "/doctor    Ping the Remote Script",
            "/snapshot  Inspect the current Live set",
            "/transport Inspect Arrangement loop and cue points",
            "/session   Show the current Copilot session",
            "/session new",
            "/session resume <session-id>",
            "/exit      End the chat session",
          ].join("\n"),
        );
        continue;
      }

      try {
        if (line === "/status") {
          const status = await application.getStatus();
          io.write(
            presentation.rich
              ? renderMarkdown(
                  [
                    "## Status",
                    "",
                    `- **Ableton:** ${status.state}`,
                    ...(status.state === "connected"
                      ? [
                          `- **Live:** ${status.liveVersion}`,
                          `- **Remote Script:** ${status.remoteScriptVersion}`,
                        ]
                      : []),
                    `- **Session:** ${application.agentSessionId ?? "none"}`,
                  ].join("\n"),
                  presentation,
                )
              : `Ableton: ${status.state}`,
          );
          continue;
        }
        if (line === "/doctor") {
          const ping = await application.ping();
          io.write(`Ping: ${ping.pong ? "ok" : "failed"}`);
          continue;
        }
        if (line === "/snapshot") {
          const snapshot = await application.inspectSession();
          io.write(
            presentation.rich
              ? renderMarkdown(snapshotMarkdown(snapshot), presentation)
              : sanitizeTerminalText(
                  `Snapshot: ${snapshot.trackCount} tracks at ${snapshot.tempo} BPM`,
                ),
          );
          continue;
        }
        if (line === "/transport") {
          const transport = await application.inspectArrangementTransport({
            offset: 0,
            limit: 100,
          });
          io.write(
            presentation.rich
              ? renderMarkdown(transportMarkdown(transport), presentation)
              : `Transport: loop ${transport.loop.enabled ? "enabled" : "disabled"}, ${transport.totalCuePoints} cue points`,
          );
          continue;
        }
        if (line === "/session") {
          io.write(`Session: ${application.agentSessionId ?? "none"}`);
          continue;
        }
        if (line === "/session new") {
          io.write(
            `Session created: ${await application.createAgentSession()}`,
          );
          continue;
        }
        if (line.startsWith("/session resume ")) {
          const sessionId = line.slice("/session resume ".length).trim();
          if (!sessionId) {
            io.writeError("session resume requires a session ID");
            continue;
          }
          await application.resumeAgentSession(sessionId);
          io.write(
            `Session resumed: ${application.agentSessionId ?? sessionId}`,
          );
          continue;
        }
        if (line.startsWith("/")) {
          io.writeError(`Unknown command: ${line}`);
          continue;
        }

        turnProducedOutput = false;
        streamingRenderer = undefined;
        const response = await application.send(line);
        if (!turnProducedOutput) {
          io.write(
            presentation.rich
              ? renderMarkdown(response, presentation)
              : response,
          );
        }
      } catch (error) {
        if (streamingRenderer !== undefined) {
          streamingRenderer.complete("");
          streamingRenderer = undefined;
        } else if (turnProducedOutput) {
          io.writeRaw("\n");
        }
        io.writeError(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    unsubscribe();
    if (application.state !== "stopped") {
      await application.stop();
    }
  }
}
