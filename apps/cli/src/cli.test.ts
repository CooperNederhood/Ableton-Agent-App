import { describe, expect, it, vi } from "vitest";

import {
  HeadlessApplication,
  type AbletonService,
  type AgentService,
} from "@ableton-agent/application";
import {
  InMemoryEventPublisher,
  noopLogger,
  type ConnectionStatus,
} from "@ableton-agent/shared";

import {
  CliUsageError,
  parseArgs,
  renderEvent,
  runCommand,
  type CliIo,
} from "./cli.js";

function application(status: ConnectionStatus, reply = "ok") {
  const agentStart = vi.fn(async () => undefined);
  const agent: AgentService = {
    start: agentStart,
    stop: vi.fn(async () => undefined),
    send: vi.fn(async () => reply),
  };
  const ableton: AbletonService = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => status),
  };
  return {
    application: new HeadlessApplication({
      agent,
      ableton,
      events: new InMemoryEventPublisher(),
      logger: noopLogger,
    }),
    agentStart,
  };
}

function output() {
  const lines: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    write: (text) => lines.push(text),
    writeError: (text) => errors.push(text),
  };
  return { lines, errors, io };
}

describe("CLI", () => {
  it("parses a one-shot prompt", () => {
    expect(parseArgs(["run", "inspect", "the", "set", "--json"])).toEqual({
      name: "run",
      prompt: "inspect the set",
      json: true,
    });
  });

  it("rejects missing prompts", () => {
    expect(() => parseArgs(["run"])).toThrow(CliUsageError);
  });

  it("returns connection failure for disconnected status", async () => {
    const out = output();
    const exitCode = await runCommand(
      { name: "status", json: true },
      application({ state: "disconnected" }).application,
      out.io,
    );
    expect(exitCode).toBe(3);
    expect(JSON.parse(out.lines[0] ?? "{}")).toMatchObject({
      healthy: false,
      ableton: { state: "disconnected" },
    });
  });

  it("runs a prompt through the headless application", async () => {
    const out = output();
    const exitCode = await runCommand(
      { name: "run", prompt: "hello", json: false },
      application(
        {
          state: "connected",
          liveVersion: "12.1",
          remoteScriptVersion: "0.1.0",
          projectId: "project",
        },
        "response",
      ).application,
      out.io,
    );
    expect(exitCode).toBe(0);
    expect(out.lines).toEqual(["response"]);
  });

  it("does not start Copilot for status checks", async () => {
    const out = output();
    const fixture = application({ state: "disconnected" });

    await runCommand(
      { name: "status", json: false },
      fixture.application,
      out.io,
    );

    expect(fixture.agentStart).not.toHaveBeenCalled();
  });

  it("renders operation events consistently", () => {
    expect(
      renderEvent({
        type: "operation.completed",
        operationId: "1",
        summary: "Inspected 4 tracks",
      }),
    ).toBe("✓ Inspected 4 tracks");
  });
});
