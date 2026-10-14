import { describe, expect, it, vi } from "vitest";

import { waitForRunnerOwnedLiveReady } from "./live-ux-host.mjs";

describe("Live UX host readiness", () => {
  it("dismisses known dialogs until the Remote Script is ready", async () => {
    const dismissKnownStartupDialogs = vi
      .fn()
      .mockResolvedValueOnce("recovery-discarded")
      .mockResolvedValueOnce("none");
    const isReady = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let time = 0;

    await expect(
      waitForRunnerOwnedLiveReady(
        { dismissKnownStartupDialogs },
        {
          isReady,
          now: () => time,
          sleep: async (milliseconds) => {
            time += milliseconds;
          },
        },
      ),
    ).resolves.toEqual({ dismissedDialogs: ["recovery-discarded"] });
    expect(dismissKnownStartupDialogs).toHaveBeenCalledWith({
      discardRecovery: true,
    });
    expect(isReady).toHaveBeenCalledTimes(2);
  });

  it("fails when the Remote Script never becomes ready", async () => {
    let time = 0;
    await expect(
      waitForRunnerOwnedLiveReady(
        { dismissKnownStartupDialogs: vi.fn(async () => "none") },
        {
          timeoutMs: 2_000,
          isReady: async () => false,
          now: () => time,
          sleep: async (milliseconds) => {
            time += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("Remote Script port");
  });

  it("allows coordinated startup to wait beyond the ordinary readiness deadline", async () => {
    let time = 0;
    const dismissKnownStartupDialogs = vi.fn(async () => "none");
    await expect(
      waitForRunnerOwnedLiveReady(
        { dismissKnownStartupDialogs },
        {
          coordinatedStartup: true,
          isReady: async () => time === 121_000,
          now: () => time,
          sleep: async (milliseconds) => {
            time += milliseconds;
          },
        },
      ),
    ).resolves.toEqual({ dismissedDialogs: [] });
    expect(time).toBe(121_000);
    expect(dismissKnownStartupDialogs).toHaveBeenCalledWith({
      discardRecovery: false,
    });
  });

  it.each([
    { coordinatedStartup: false, expectedDeadline: 120_000 },
    { coordinatedStartup: true, expectedDeadline: 600_000 },
    { coordinatedStartup: true, timeoutMs: 2_000, expectedDeadline: 2_000 },
  ])("keeps startup bounded at $expectedDeadline ms", async (options) => {
    let time = 0;
    const dismissKnownStartupDialogs = vi.fn(async () => "none");
    await expect(
      waitForRunnerOwnedLiveReady(
        { dismissKnownStartupDialogs },
        {
          ...options,
          discardRecovery: false,
          isReady: async () => false,
          now: () => time,
          sleep: async (milliseconds) => {
            time += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("Remote Script port");
    expect(time).toBe(options.expectedDeadline);
    expect(dismissKnownStartupDialogs).toHaveBeenCalledWith({
      discardRecovery: false,
    });
  });
});
