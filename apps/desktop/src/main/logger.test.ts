import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopFileLogger,
  exportSupportBundle,
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
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("desktop diagnostics privacy", () => {
  it("redacts secrets, paths, prompts, and musical labels", () => {
    expect(
      redactDiagnosticValue({
        token: "secret",
        prompt: "compose drums",
        trackName: "Lead",
        status: "connected",
        message: `Bearer ${"a".repeat(40)}`,
      }),
    ).toEqual({
      token: "[REDACTED]",
      prompt: "[REDACTED]",
      trackName: "[REDACTED]",
      status: "connected",
      message: "Bearer [REDACTED]",
    });
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

    await writeFile(path, `${"x".repeat(4_000)}\n${"y".repeat(4_000)}\n`);
    await logger.prune({ maximumBytes: 4_000 });
    expect((await stat(path)).size).toBeLessThanOrEqual(4_000);
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
    expect(content).not.toContain("/private/project.als");
    expect(content).not.toContain("sessions");
  });
});
