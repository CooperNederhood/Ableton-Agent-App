import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";

import {
  bridgeTokenKey,
  resolveBridgeCredential,
} from "./bridge-credentials.js";

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
  it("discovers, persists, and records a redacted lifecycle", async () => {
    const root = await workspace();
    const remoteScriptsPath = join(root, "User Library", "Remote Scripts");
    const token = "d".repeat(64);
    await writeInstalledToken(remoteScriptsPath, `${token}\n`);
    const persisted = new Map<string, string>();
    const events: TelemetryEventEnvelope[] = [];
    const times = [
      new Date("2026-09-14T20:00:00.000Z"),
      new Date("2026-09-14T20:00:00.010Z"),
      new Date("2026-09-14T20:00:00.025Z"),
    ];

    const result = await resolveBridgeCredential({
      environment: {},
      remoteScriptLocation: join(root, "User Library"),
      platform: "darwin",
      vault: {
        get: async () => undefined,
        set: async (key, value) => {
          persisted.set(key, value);
        },
      },
      telemetry: {
        enqueue: (event) => events.push(event),
      },
      now: () => times.shift() ?? new Date("2026-09-14T20:00:00.025Z"),
    });

    expect(result).toMatchObject({
      token,
      source: "remote-script",
      notices: [
        {
          status: "pass",
          detail:
            "The installed Remote Script token was discovered and stored in the desktop credential vault.",
        },
      ],
    });
    expect(persisted.get(bridgeTokenKey)).toBe(token);
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
        persisted: true,
      },
    });
    expect(events.every(({ trace }) => trace?.traceId === result.traceId)).toBe(
      true,
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(root);
  });

  it("preserves vault and environment precedence without persisting overrides", async () => {
    const root = await workspace();
    const discovered = "d".repeat(64);
    const environment = "e".repeat(64);
    const vault = "v".repeat(64);
    await writeInstalledToken(
      join(root, "User Library", "Remote Scripts"),
      discovered,
    );
    const set = vi.fn();

    const fromVault = await resolveBridgeCredential({
      storedToken: vault,
      environment: { ABLETON_AGENT_TOKEN: environment },
      remoteScriptLocation: join(root, "User Library"),
      platform: "darwin",
      vault: { get: vi.fn(), set },
    });
    expect(fromVault).toMatchObject({ token: vault, source: "vault" });
    expect(set).not.toHaveBeenCalled();

    const fromEnvironment = await resolveBridgeCredential({
      environment: { ABLETON_AGENT_TOKEN: environment },
      remoteScriptLocation: join(root, "User Library"),
      platform: "darwin",
      vault: { get: async () => undefined, set },
    });
    expect(fromEnvironment).toMatchObject({
      token: environment,
      source: "environment",
    });
    expect(set).not.toHaveBeenCalled();
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

  it("uses a discovered token for the current process when vault persistence fails", async () => {
    const root = await workspace();
    const token = "c".repeat(64);
    await writeInstalledToken(join(root, "Remote Scripts"), token);

    const result = await resolveBridgeCredential({
      environment: {},
      remoteScriptLocation: join(root, "Remote Scripts"),
      platform: "darwin",
      vault: {
        get: async () => undefined,
        set: async () => {
          throw new Error("encryption unavailable");
        },
      },
    });

    expect(result).toMatchObject({ token, source: "remote-script" });
    expect(result.notices[0]?.status).toBe("warn");
    expect(result.notices[0]?.detail).toContain("could not be saved");
  });
});
