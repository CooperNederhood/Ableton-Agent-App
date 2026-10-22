import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { EXIT_CODES } from "./exit-codes.js";

const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
const testTsconfig = fileURLToPath(
  new URL("../../../tsconfig.test-runtime.json", import.meta.url),
);

function cliEnv(overrides: Record<string, string> = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.ABLETON_AGENT_TOKEN;
  return {
    ...baseEnv,
    TSX_TSCONFIG_PATH: testTsconfig,
    ...overrides,
  };
}

function runCli(args: readonly string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
    env: cliEnv(env),
  });
}

function ownChild(child: ChildProcess) {
  const exited = new Promise<
    | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "failed"; error: Error }
  >((resolve) => {
    child.once("exit", (code, signal) =>
      resolve({ kind: "exited", code, signal }),
    );
    child.once("error", (error) => resolve({ kind: "failed", error }));
  });
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    const result = await exited;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (result.kind === "failed") throw result.error;
  };
  onTestFinished(cleanup);
  return { exited, cleanup };
}

describe("main entry point exit-code mapping", () => {
  it("returns SUCCESS for the help command", () => {
    const result = runCli(["help"]);
    expect(result.status).toBe(EXIT_CODES.SUCCESS);
    expect(result.stdout).toContain("Ableton Agent");
    expect(result.stdout).toContain("--quiet");
  });

  it("returns USAGE_ERROR for an unknown command", () => {
    const result = runCli(["bogus-command"]);
    expect(result.status).toBe(EXIT_CODES.USAGE_ERROR);
    expect(result.stderr).toContain("Unknown command");
  });

  it("returns CONNECTION_ERROR when Ableton is not configured", () => {
    const result = runCli(["status", "--json"]);
    expect(result.status).toBe(EXIT_CODES.CONNECTION_ERROR);
    expect(JSON.parse(result.stdout)).toMatchObject({ healthy: false });
  });

  it("classifies unconfigured command failures as connection errors", () => {
    const result = runCli(["snapshot", "--json"]);
    expect(result.status).toBe(EXIT_CODES.CONNECTION_ERROR);
    expect(result.stderr).toContain("Ableton bridge is not configured");
  });

  it("returns USAGE_ERROR for an unusable bridge port", () => {
    const result = runCli(["status", "--json"], {
      ABLETON_AGENT_PORT: "not-a-port",
    });
    expect(result.status).toBe(EXIT_CODES.USAGE_ERROR);
    expect(result.stderr).toContain("ABLETON_AGENT_PORT must be an integer");
  });

  it("never emits ANSI color codes to redirected (non-TTY) output", () => {
    const result = runCli(["doctor"]);
    const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`);
    expect(result.stdout).not.toMatch(ansiEscape);
    expect(result.stderr).not.toMatch(ansiEscape);
  });

  it("returns INTERRUPTED when the chat session is sent SIGINT", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, "chat"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv(),
    });
    const { exited, cleanup } = ownChild(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          child.stdout.off("data", check);
          child.off("error", failed);
          child.off("exit", earlyExit);
          if (error === undefined) resolve();
          else reject(error);
        };
        const check = () => {
          if (stdout.includes("> ")) finish();
        };
        const failed = (error: Error) => finish(error);
        const earlyExit = () =>
          finish(new Error(`chat exited before its prompt: ${stderr}`));
        const timeout = setTimeout(
          () =>
            finish(
              new Error(`chat never printed a prompt: ${stdout}\n${stderr}`),
            ),
          10_000,
        );

        child.stdout.on("data", check);
        child.once("error", failed);
        child.once("exit", earlyExit);
        check();
      });

      expect(child.kill("SIGINT")).toBe(true);
      expect(await exited).toEqual({
        kind: "exited",
        signal: null,
        code: EXIT_CODES.INTERRUPTED,
      });
    } finally {
      await cleanup();
    }
  }, 15_000);

  it("reaps the owned child and closes its pipes when the test body fails", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { exited, cleanup } = ownChild(child);
    await once(child, "spawn");

    const failure = new Error("synthetic prompt failure");
    await expect(
      (async () => {
        try {
          throw failure;
        } finally {
          await cleanup();
        }
      })(),
    ).rejects.toBe(failure);

    expect(await exited).toEqual({
      kind: "exited",
      code: null,
      signal: "SIGKILL",
    });
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});
