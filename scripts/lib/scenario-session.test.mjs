import { describe, expect, it, vi } from "vitest";

import { createIsolatedScenarioSession } from "./scenario-session.mjs";

describe("isolated live scenario sessions", () => {
  it("creates and returns a fresh Copilot session", async () => {
    const runCli = vi.fn().mockResolvedValue({
      status: 0,
      json: { sessionId: "scenario-session" },
      stderr: "",
    });

    await expect(createIsolatedScenarioSession(runCli)).resolves.toBe(
      "scenario-session",
    );
    expect(runCli).toHaveBeenCalledWith(["session-new", "--json", "--quiet"]);
  });

  it("rejects failed or malformed session creation", async () => {
    await expect(
      createIsolatedScenarioSession(async () => ({
        status: 3,
        json: undefined,
        stderr: "session unavailable",
      })),
    ).rejects.toThrow("session unavailable");
    await expect(
      createIsolatedScenarioSession(async () => ({
        status: 0,
        json: {},
        stderr: "",
      })),
    ).rejects.toThrow("Unable to create Copilot session");
  });
});
