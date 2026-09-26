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
});
