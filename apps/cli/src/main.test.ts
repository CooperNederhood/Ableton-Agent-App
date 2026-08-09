import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXIT_CODES } from "./exit-codes.js";

const tsxBin = fileURLToPath(
  new URL("../../../node_modules/.bin/tsx", import.meta.url),
);
const entry = fileURLToPath(new URL("./main.ts", import.meta.url));

function cliEnv(overrides: Record<string, string> = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.ABLETON_AGENT_TOKEN;
  return { ...baseEnv, ...overrides };
}

function runCli(args: readonly string[], env: Record<string, string> = {}) {
  return spawnSync(tsxBin, [entry, ...args], {
    encoding: "utf8",
    env: cliEnv(env),
  });
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

  it("never emits ANSI color codes to redirected (non-TTY) output", () => {
    const result = runCli(["doctor"]);
    const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`);
    expect(result.stdout).not.toMatch(ansiEscape);
    expect(result.stderr).not.toMatch(ansiEscape);
  });

  it("returns INTERRUPTED when the chat session is sent SIGINT", async () => {
    const child = spawn(tsxBin, [entry, "chat"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: cliEnv(),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`chat never printed a prompt: ${stdout}`)),
        10_000,
      );
      const check = () => {
        if (stdout.includes("> ")) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });

    child.kill("SIGINT");
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(EXIT_CODES.INTERRUPTED);
  }, 15_000);
});
