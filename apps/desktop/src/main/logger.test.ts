import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesktopFileLogger,
  exportSupportBundle,
  parseLogLevel,
  redactDiagnosticValue,
} from "./logger.js";

const root = join(process.cwd(), ".test-artifacts", "logger");
const paths: string[] = [];

function workspace(): string {
  const path = join(root, randomUUID());
  paths.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("desktop diagnostics privacy", () => {
  it("parses supported environment log levels", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("warn")).toBe("warn");
    expect(parseLogLevel("verbose")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });

  it("redacts only credentials while retaining diagnostic payloads", () => {
    expect(
      redactDiagnosticValue({
        token: "secret",
        credentials: { password: "hunter2" },
        prompt: "compose drums",
        content: "arrangement notes",
        notes: "compress lightly",
        trackName: "Lead",
        device: "Operator",
        filePath: "/private/project.als",
        applicationPayload: { action: "play" },
        projectId: "0123456789abcdef0123456789abcdef",
        status: "connected",
        message: `Bearer ${"a".repeat(40)}`,
      }),
    ).toEqual({
      token: "[REDACTED]",
      credentials: "[REDACTED]",
      prompt: "compose drums",
      content: "arrangement notes",
      notes: "compress lightly",
      trackName: "Lead",
      device: "Operator",
      filePath: "/private/project.als",
      applicationPayload: { action: "play" },
      projectId: "0123456789abcdef0123456789abcdef",
      status: "connected",
      message: "******",
    });
  });

  it("omits binary data and bounds oversized diagnostic values", () => {
    const result = redactDiagnosticValue({
      audio: Buffer.alloc(128),
      text: "x".repeat(9_000),
      items: Array.from({ length: 120 }, (_, index) => index),
      object: Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [`key${index}`, index]),
      ),
    }) as Record<string, unknown>;

    expect(result.audio).toBe("[OMITTED BINARY DATA]");
    expect((result.text as string).length).toBeLessThan(9_000);
    expect(result.text).toContain("[TRUNCATED]");
    expect(result.items).toHaveLength(101);
    expect(result.object).toMatchObject({ __truncated__: "20 entries" });
  });

  it("filters ordered levels and supports runtime level updates", async () => {
    const directory = workspace();
    const path = join(directory, "desktop.log");
    const logger = new DesktopFileLogger(path, "warn");

    await logger.write("error", "error");
    await logger.write("warn", "warn");
    await logger.write("info", "hidden info");
    await logger.write("debug", "hidden debug");
    logger.setLevel("debug");
    await logger.write("info", "visible info");
    await logger.write("debug", "visible debug");

    const messages = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages).toEqual([
      "error",
      "warn",
      "visible info",
      "visible debug",
    ]);
  });

  it("serializes concurrent writes in invocation order", async () => {
    const directory = workspace();
    const path = join(directory, "desktop.log");
    const logger = new DesktopFileLogger(path, "debug");

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        logger.write("info", `message-${index}`),
      ),
    );

    const messages = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages).toEqual(
      Array.from({ length: 50 }, (_, index) => `message-${index}`),
    );
  });

  it("reports write failures directly to stderr without rejecting", async () => {
    const directory = workspace();
    const blockingFile = join(directory, "not-a-directory");
    await mkdir(directory, { recursive: true });
    await writeFile(blockingFile, "blocking");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const logger = new DesktopFileLogger(join(blockingFile, "desktop.log"));

    await expect(logger.write("error", "failure")).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("[desktop-logger] Failed to write log:"),
    );

    await rm(blockingFile);
    await logger.write("error", "recovered");
    expect(await readFile(join(blockingFile, "desktop.log"), "utf8")).toContain(
      '"message":"recovered"',
    );
  });

  it("writes redacted logs and bounds oversized history", async () => {
    const directory = workspace();
    const path = join(directory, "desktop.log");
    const logger = new DesktopFileLogger(path);
    await logger.write("info", "Connected", {
      token: "do-not-store",
      projectId: "project-1",
    });
    expect(await readFile(path, "utf8")).not.toContain("do-not-store");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await writeFile(path, `${"x".repeat(4_000)}\n${"y".repeat(4_000)}\n`, {
      mode: 0o600,
    });
    await logger.prune({ maximumBytes: 4_000 });
    expect((await stat(path)).size).toBeLessThanOrEqual(4_000);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("exports a redacted support bundle without preferences or sessions", async () => {
    const directory = workspace();
    const logs = join(directory, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, "desktop.log"),
      `${JSON.stringify({ level: "error", token: "secret", code: "offline" })}\n`,
    );
    const destination = join(directory, "support.json");
    await exportSupportBundle({
      destination,
      logsDirectory: logs,
      diagnostics: { protocolVersion: 2, filePath: "/private/project.als" },
    });

    const content = await readFile(destination, "utf8");
    expect(content).toContain('"protocolVersion": 2');
    expect(content).not.toContain("secret");
    expect(content).toContain("/private/project.als");
    expect(content).not.toContain("sessions");
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });
});
