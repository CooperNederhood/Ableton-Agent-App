#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline";

import {
  createAgentRuntime,
  resolveAbletonSettingsFromEnvironment,
  resolveAgentSettingsFromEnvironment,
  RuntimeConfigurationError,
} from "@ableton-agent/runtime";

import {
  CliUsageError,
  parseArgs,
  requestInteractiveApproval,
  runCommand,
  type CliIo,
} from "./cli.js";
import type { InteractiveInput } from "./cli.js";
import { EXIT_CODES, exitCodeForError } from "./exit-codes.js";
import { createScenarioRunContext, loadScenarioManifest } from "./scenario.js";
import { createTerminalPresentation } from "./terminal.js";

class BufferedLineInput implements InteractiveInput {
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | undefined) => void> = [];
  #closed = false;

  public constructor(private readonly terminal: Interface) {
    terminal.on("SIGINT", () => terminal.close());
    terminal.on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        this.#lines.push(line);
      }
    });
    terminal.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) {
        waiter(undefined);
      }
    });
  }

  public readLine(): Promise<string | undefined> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  public close(): void {
    this.terminal.close();
  }
}

const io: CliIo = {
  write: (text) => process.stdout.write(`${text}\n`),
  writeRaw: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(`${text}\n`),
};

async function main(): Promise<number> {
  try {
    const rawArgs = process.argv.slice(2);
    const quiet = rawArgs.includes("--quiet") || rawArgs.includes("-q");
    const args = rawArgs.filter(
      (argument) => argument !== "--quiet" && argument !== "-q",
    );
    const presentation = createTerminalPresentation(
      { isTTY: process.stdout.isTTY, columns: process.stdout.columns },
      process.env,
    );
    const command = parseArgs(args);
    const scenario =
      command.name === "run" && command.scenarioId !== undefined
        ? createScenarioRunContext(
            await loadScenarioManifest(command.scenarioId),
          )
        : undefined;
    if (
      command.name === "run" &&
      scenario !== undefined &&
      command.prompt !== scenario.manifest.prompt
    ) {
      throw new CliUsageError(
        `Scenario '${scenario.manifest.id}' requires its reviewed prompt: ${JSON.stringify(scenario.manifest.prompt)}`,
      );
    }
    if (
      command.name === "run" &&
      scenario !== undefined &&
      command.timeoutMs !== undefined &&
      command.timeoutMs > scenario.manifest.timeoutMs
    ) {
      throw new CliUsageError(
        `--timeout-ms cannot exceed scenario limit ${scenario.manifest.timeoutMs}`,
      );
    }
    const terminal =
      command.name === "chat"
        ? new BufferedLineInput(
            createInterface({
              input: process.stdin,
              output: process.stdout,
              terminal: process.stdin.isTTY,
            }),
          )
        : undefined;
    const agentSettings = resolveAgentSettingsFromEnvironment(process.env);
    const { application } = createAgentRuntime({
      ableton: resolveAbletonSettingsFromEnvironment(process.env),
      agent: {
        ...agentSettings,
        ...(command.name === "run" &&
        (command.timeoutMs !== undefined || scenario !== undefined)
          ? {
              turnTimeoutMs: command.timeoutMs ?? scenario?.manifest.timeoutMs,
            }
          : {}),
      },
      ...(scenario === undefined
        ? {}
        : {
            requestToolApproval: scenario.approvals.request,
            askForReadApproval: true,
          }),
      ...(terminal === undefined
        ? {}
        : {
            requestToolApproval: async (request) => {
              return requestInteractiveApproval(
                request,
                terminal,
                io,
                presentation,
              );
            },
          }),
    });
    try {
      return await runCommand(command, application, io, terminal, {
        quiet,
        color: presentation.colors.enabled,
        terminal: presentation,
        ...(scenario === undefined ? {} : { scenario }),
      });
    } finally {
      terminal?.close();
    }
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof RuntimeConfigurationError
    ) {
      io.writeError(error.message);
      return EXIT_CODES.USAGE_ERROR;
    }
    io.writeError(error instanceof Error ? error.message : String(error));
    return exitCodeForError(error);
  }
}

process.on("SIGINT", () => {
  // Force an immediate, unambiguous exit on Ctrl+C rather than waiting for
  // in-flight I/O (e.g. a pending Ableton round trip) to settle.
  process.exit(EXIT_CODES.INTERRUPTED);
});

process.exitCode = await main();
