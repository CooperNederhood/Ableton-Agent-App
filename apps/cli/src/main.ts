#!/usr/bin/env node
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

import { CliUsageError, parseArgs, runCommand, type CliIo } from "./cli.js";

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
}

const io: CliIo = {
  write: (text) => process.stdout.write(`${text}\n`),
  writeError: (text) => process.stderr.write(`${text}\n`),
};

async function main(): Promise<number> {
  try {
    const command = parseArgs(process.argv.slice(2));
    const events = new InMemoryEventPublisher();
    const token = process.env.ABLETON_AGENT_TOKEN;
    const ableton =
      token === undefined
        ? new UnconfiguredAbletonService()
        : new AbletonBridgeService({
            authenticationToken: token,
            events,
          });
    const agent = new CopilotAgentService({
      events,
      getAbletonStatus: () => ableton.getStatus(),
    });
    const application = new HeadlessApplication({
      agent,
      ableton,
      events,
      logger: noopLogger,
    });
    return await runCommand(command, application, io);
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
