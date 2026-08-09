#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline";

import {
  CopilotAgentService,
  HeadlessApplication,
  type AbletonService,
} from "@ableton-agent/application";
import { AbletonBridgeService } from "@ableton-agent/bridge";
import {
  InMemoryEventPublisher,
  noopLogger,
  type ConnectionStatus,
} from "@ableton-agent/shared";
import type {
  CapabilityDocument,
  PingResult,
  SessionSnapshot,
  SetTempoResult,
} from "@ableton-agent/protocol";

import { CliUsageError, parseArgs, runCommand, type CliIo } from "./cli.js";
import type { InteractiveInput } from "./cli.js";

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

class UnconfiguredAbletonService implements AbletonService {
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async getStatus(): Promise<ConnectionStatus> {
    return {
      state: "error",
      code: "configuration_missing",
      message: "Set ABLETON_AGENT_TOKEN to connect to the Remote Script",
    };
  }
  public async getCapabilities(): Promise<CapabilityDocument> {
    throw new Error("Ableton bridge is not configured");
  }
  public async ping(): Promise<PingResult> {
    throw new Error("Ableton bridge is not configured");
  }
  public async inspectSession(): Promise<SessionSnapshot> {
    throw new Error("Ableton bridge is not configured");
  }
  public async setTempo(): Promise<SetTempoResult> {
    throw new Error("Ableton bridge is not configured");
  }
}

const io: CliIo = {
  write: (text) => process.stdout.write(`${text}\n`),
  writeRaw: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(`${text}\n`),
};

async function main(): Promise<number> {
  try {
    const command = parseArgs(process.argv.slice(2));
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
    const events = new InMemoryEventPublisher();
    const token = process.env.ABLETON_AGENT_TOKEN;
    const configuredPort = Number(process.env.ABLETON_AGENT_PORT ?? "8765");
    if (
      !Number.isInteger(configuredPort) ||
      configuredPort < 1 ||
      configuredPort > 65_535
    ) {
      throw new CliUsageError(
        "ABLETON_AGENT_PORT must be an integer from 1 to 65535",
      );
    }
    const ableton =
      token === undefined
        ? new UnconfiguredAbletonService()
        : new AbletonBridgeService({
            authenticationToken: token,
            events,
            port: configuredPort,
          });
    const agent = new CopilotAgentService({
      events,
      getAbletonStatus: () => ableton.getStatus(),
      inspectSession: () => ableton.inspectSession(),
      setTempo: (tempo) => ableton.setTempo(tempo),
      ...(terminal === undefined
        ? {}
        : {
            requestToolApproval: async (request) => {
              io.write(
                `Approval required: ${request.metadata.title} (${request.metadata.risk})`,
              );
              io.write(`Arguments: ${JSON.stringify(request.arguments)}`);
              io.writeRaw("Approve once? [y/N] ");
              const answer = await terminal.readLine();
              return answer?.trim().toLowerCase() === "y";
            },
          }),
    });
    const application = new HeadlessApplication({
      agent,
      ableton,
      events,
      logger: noopLogger,
    });
    try {
      return await runCommand(command, application, io, terminal);
    } finally {
      terminal?.close();
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.writeError(error.message);
      return 2;
    }
    io.writeError(error instanceof Error ? error.message : String(error));
    return 5;
  }
}

process.exitCode = await main();
