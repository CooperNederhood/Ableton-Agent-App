import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";

import { resolveBridgeCredential } from "./bridge-credentials.js";

const directories: string[] = [];

async function workspace(): Promise<string> {
  const path = join(tmpdir(), `ableton-bridge-credentials-${randomUUID()}`);
  directories.push(path);
  await mkdir(path, { recursive: true });
  return path;
}

async function writeInstalledToken(
  remoteScriptsPath: string,
  token: string,
): Promise<void> {
  const directory = join(remoteScriptsPath, "AbletonAgent");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".ableton-agent-token"), token, "utf8");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bridge credential resolution", () => {
  it("reads into memory without consulting or populating a vault", async () => {
    const root = await workspace();
    const remoteScriptsPath = join(root, "User Library", "Remote Scripts");
    const token = "d".repeat(64);
    await writeInstalledToken(remoteScriptsPath, `${token}\n`);
    const get = vi.fn(async () => undefined);
    const set = vi.fn(async () => undefined);
    const events: TelemetryEventEnvelope[] = [];
    const times = [
      new Date("2026-09-14T20:00:00.000Z"),
      new Date("2026-09-14T20:00:00.010Z"),
      new Date("2026-09-14T20:00:00.025Z"),
    ];

    const options = {
      environment: {},
      remoteScriptLocation: join(root, "User Library"),
      platform: "darwin" as const,
      vault: {
        get,
        set,
      },
      telemetry: {
        enqueue: (event: TelemetryEventEnvelope) => events.push(event),
      },
      now: () => times.shift() ?? new Date("2026-09-14T20:00:00.025Z"),
    };
    const result = await resolveBridgeCredential(options);

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      token,
      source: "remote-script",
      notices: [
        {
          status: "pass",
          detail:
            "The installed Remote Script token was read into process memory.",
        },
      ],
    });
    expect(events.map(({ name }) => name)).toEqual([
      "desktop.bridge_credentials.queued",
      "desktop.bridge_credentials.started",
      "desktop.bridge_credentials.completed",
    ]);
    expect(events[2]).toMatchObject({
      outcome: "success",
      durationMs: 25,
      correlationId: result.traceId,
      attributes: {
        source: "remote-script",
        candidateCount: 1,
        validCandidateCount: 1,
        persisted: false,
      },
    });
    expect(events.every(({ trace }) => trace?.traceId === result.traceId)).toBe(
      true,
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
  });

  it("preserves explicit environment precedence over the installed file", async () => {
    const root = await workspace();
    const discovered = "d".repeat(64);
    const environment = "e".repeat(64);
    await writeInstalledToken(
      join(root, "User Library", "Remote Scripts"),
      discovered,
    );
    const fromEnvironment = await resolveBridgeCredential({
      environment: { ABLETON_AGENT_TOKEN: environment },
      remoteScriptLocation: join(root, "User Library"),
      platform: "darwin",
    });
    expect(fromEnvironment).toMatchObject({
      token: environment,
      source: "environment",
    });
  });

  it("rejects conflicting auto-detected tokens without exposing them", async () => {
    const home = await workspace();
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    await writeInstalledToken(
      join(home, "Music", "Ableton", "User Library", "Remote Scripts"),
      first,
    );
    await writeInstalledToken(
      join(home, "Documents", "Ableton", "User Library", "Remote Scripts"),
      second,
    );

    const result = await resolveBridgeCredential({
      environment: {},
      homeDirectory: home,
      platform: "darwin",
      remoteScriptLocation: "Auto-detect",
    });

    expect(result.token).toBeUndefined();
    expect(result.notices[0]?.status).toBe("fail");
    expect(result.notices[0]?.detail).toContain("different tokens");
    expect(JSON.stringify(result.notices)).not.toContain(first);
    expect(JSON.stringify(result.notices)).not.toContain(second);
    expect(JSON.stringify(result.notices)).not.toContain(home);
  });

  it("accepts the same token from multiple auto-detected installations", async () => {
    const home = await workspace();
    const token = "a".repeat(64);
    await writeInstalledToken(
      join(home, "Music", "Ableton", "User Library", "Remote Scripts"),
      token,
    );
    await writeInstalledToken(
      join(home, "Documents", "Ableton", "User Library", "Remote Scripts"),
      token,
    );

    const result = await resolveBridgeCredential({
      environment: {},
      homeDirectory: home,
      platform: "darwin",
      remoteScriptLocation: "Auto-detect",
    });

    expect(result).toMatchObject({ token, source: "remote-script" });
  });

  it("uses ABLETON_USER_LIBRARY as the auto-detection override", async () => {
    const home = await workspace();
    const customLibrary = join(home, "Custom Library");
    const expected = "c".repeat(64);
    await writeInstalledToken(join(customLibrary, "Remote Scripts"), expected);
    await writeInstalledToken(
      join(home, "Music", "Ableton", "User Library", "Remote Scripts"),
      "d".repeat(64),
    );

    const result = await resolveBridgeCredential({
      environment: { ABLETON_USER_LIBRARY: customLibrary },
      homeDirectory: home,
      platform: "darwin",
      remoteScriptLocation: "Auto-detect",
    });

    expect(result).toMatchObject({
      token: expected,
      source: "remote-script",
    });
  });

  it.each([
    ["too short", "short"],
    ["oversized", "x".repeat(4 * 1024 + 1)],
  ])("rejects an %s installed token", async (_label, token) => {
    const root = await workspace();
    await writeInstalledToken(join(root, "Remote Scripts"), token);

    const result = await resolveBridgeCredential({
      environment: {},
      remoteScriptLocation: join(root, "Remote Scripts"),
      platform: "darwin",
    });

    expect(result.token).toBeUndefined();
    expect(result.notices[0]?.status).toBe("fail");
    expect(result.notices[0]?.detail).toContain("invalid or unreadable");
  });

  it("rereads a rotated token and does not reuse it when its file disappears", async () => {
    const root = await workspace();
    const token = "c".repeat(64);
    await writeInstalledToken(join(root, "Remote Scripts"), token);

    const options = {
      environment: {},
      remoteScriptLocation: join(root, "Remote Scripts"),
    };

    const first = await resolveBridgeCredential(options);
    expect(first).toMatchObject({ token, source: "remote-script" });
    const rotated = "r".repeat(64);
    await writeInstalledToken(join(root, "Remote Scripts"), rotated);
    const second = await resolveBridgeCredential(options);
    expect(second).toMatchObject({ token: rotated, source: "remote-script" });
    expect(second.traceId).not.toBe(first.traceId);

    await rm(
      join(root, "Remote Scripts", "AbletonAgent", ".ableton-agent-token"),
    );
    const events: TelemetryEventEnvelope[] = [];
    const missing = await resolveBridgeCredential({
      ...options,
      telemetry: { enqueue: (event) => events.push(event) },
    });
    expect(missing.token).toBeUndefined();
    expect(missing.notices[0]?.detail).toContain("No Remote Script token");
    expect(events.map(({ name }) => name)).toEqual([
      "desktop.bridge_credentials.queued",
      "desktop.bridge_credentials.started",
      "desktop.bridge_credentials.failed",
    ]);
    expect(events[2]).toMatchObject({
      outcome: "failure",
      correlationId: missing.traceId,
      attributes: { failureCategory: "missing" },
    });
    expect(typeof events[2]?.durationMs).toBe("number");
    expect(JSON.stringify(events)).not.toContain(rotated);
  });
});
