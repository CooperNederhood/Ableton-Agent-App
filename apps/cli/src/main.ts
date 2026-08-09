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
import { shouldUseColor } from "./terminal.js";

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
    const color = shouldUseColor({ isTTY: process.stdout.isTTY }, process.env);
    const command = parseArgs(args);
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
    const { application } = createAgentRuntime({
      ableton: resolveAbletonSettingsFromEnvironment(process.env),
      agent: resolveAgentSettingsFromEnvironment(process.env),
      ...(terminal === undefined
        ? {}
        : {
            requestToolApproval: async (request) => {
              return requestInteractiveApproval(request, terminal, io);
            },
          }),
    });
    try {
      return await runCommand(command, application, io, terminal, {
        quiet,
        color,
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
