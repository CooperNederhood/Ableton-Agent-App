import { describe, expect, it, vi } from "vitest";

import { LiveProcessController } from "./live-process-controller.mjs";

const owned = {
  pid: 4242,
  startedAt: "Mon Jan 1 00:00:00 2026",
  command: "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live",
};

describe("LiveProcessController", () => {
  it("refuses a pre-existing Live process", async () => {
    const controller = new LiveProcessController({
      listProcesses: async () => [owned],
    });
    await expect(controller.assertNoPreExistingLive()).rejects.toThrow(
      "already running",
    );
  });

  it("records a newly launched process and requests a clean quit", async () => {
    const lists = [[], [], [owned], [owned]];
    let exited = false;
    const kill = vi.fn((pid, signal) => {
      expect(pid).toBe(owned.pid);
      if (signal === 0 && exited) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    });
    const requestQuit = vi.fn(async (process) => {
      expect(process.pid).toBe(owned.pid);
      exited = true;
    });
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [owned],
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
      kill,
      sleep: async () => undefined,
      randomUUID: () => "run-id",
      requestQuit,
    });

    await controller.launch("/Applications/Ableton Live 11 Suite.app", 1_000);
    await controller.gracefulStop(1_000);

    expect(requestQuit).toHaveBeenCalledOnce();
    expect(kill.mock.calls.every(([pid]) => pid === owned.pid)).toBe(true);
  });

  it("fails closed when the recorded PID identity changes", async () => {
    const lists = [
      [],
      [],
      [owned],
      [{ ...owned, command: "/unexpected/process" }],
    ];
    const kill = vi.fn();
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [],
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
      kill,
      sleep: async () => undefined,
      requestQuit: vi.fn(),
    });
    await controller.launch("/Applications/Ableton Live 11 Suite.app", 1_000);

    await expect(controller.gracefulStop()).rejects.toThrow(
      "identity no longer matches",
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("dismisses only through the injected known-dialog handler", async () => {
    const handleStartupDialogs = vi.fn(async () => "audio-disabled");
    const lists = [[], [], [owned], [owned]];
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [owned],
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
      handleStartupDialogs,
    });
    await controller.launch("/Applications/Ableton Live 11 Suite.app", 1_000);

    await expect(
      controller.dismissKnownStartupDialogs({ discardRecovery: true }),
    ).resolves.toBe("audio-disabled");
    expect(handleStartupDialogs).toHaveBeenCalledWith(
      expect.objectContaining({
        discardRecovery: true,
        launchedAt: expect.any(String),
      }),
    );
  });
});
