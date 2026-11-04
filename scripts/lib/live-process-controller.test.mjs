import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireLiveHostLease } from "./live-host-lease.mjs";
import { resolveLiveHostAutomationStorage } from "../../packages/storage/dist/index.js";
import { LiveProcessController as ProductionLiveProcessController } from "./live-process-controller.mjs";

const owned = {
  pid: 4242,
  startedAt: "Mon Jan 1 00:00:00 2026",
  command: "/Applications/Ableton Live 11 Suite.app/Contents/MacOS/Live",
};
const roots = [];
class LiveProcessController extends ProductionLiveProcessController {
  constructor(options) {
    const homeDirectory = resolve(
      ".test-artifacts",
      `controller-unit-${randomUUID()}`,
    );
    roots.push(homeDirectory);
    super({
      acquireHostLease: () => acquireLiveHostLease({ homeDirectory }),
      ...options,
    });
  }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LiveProcessController", () => {
  it("holds one suite lease across sequential controllers and rejects overlapping controllers", async () => {
    const homeDirectory = resolve(
      ".test-artifacts",
      `suite-lease-${randomUUID()}`,
    );
    roots.push(homeDirectory);
    const hostLease = await acquireLiveHostLease({ homeDirectory });
    const first = new LiveProcessController({
      hostLease,
      listProcesses: async () => [],
    });
    const second = new LiveProcessController({
      hostLease,
      listProcesses: async () => [],
    });
    await first.assertNoPreExistingLive();
    await expect(second.assertNoPreExistingLive()).rejects.toThrow(
      "active controller",
    );
    await expect(hostLease.release()).rejects.toThrow("still reserved");
    await first.close();
    await expect(acquireLiveHostLease({ homeDirectory })).rejects.toThrow(
      "already held",
    );
    await second.assertNoPreExistingLive();
    await second.close();
    await hostLease.release();
  });

  it("closes the parallel-runner preflight-to-launch gap", async () => {
    const homeDirectory = resolve(
      ".test-artifacts",
      `parallel-lease-${randomUUID()}`,
    );
    roots.push(homeDirectory);
    const acquireHostLease = () => acquireLiveHostLease({ homeDirectory });
    const first = new LiveProcessController({
      acquireHostLease,
      listProcesses: async () => [],
    });
    const inspect = vi.fn(async () => []);
    const second = new LiveProcessController({
      acquireHostLease,
      listProcesses: inspect,
    });
    await first.assertNoPreExistingLive();
    await expect(second.assertNoPreExistingLive()).rejects.toThrow(
      "already held",
    );
    expect(inspect).not.toHaveBeenCalled();
    await first.close();
    await second.assertNoPreExistingLive();
    await second.close();
  });

  it("rechecks pre-existing processes immediately before requesting launch", async () => {
    const lists = [[], [owned]];
    const requestLaunch = vi.fn();
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [],
      requestLaunch,
    });
    await expect(
      controller.launch("/Applications/Ableton Live 11 Suite.app"),
    ).rejects.toThrow("already running");
    expect(requestLaunch).not.toHaveBeenCalled();
    await expect(controller.close()).resolves.toBeUndefined();
  });

  it("releases cancelled prelaunch reservations but retains cancellation after launch request", async () => {
    const homeDirectory = resolve(
      ".test-artifacts",
      `cancel-lease-${randomUUID()}`,
    );
    roots.push(homeDirectory);
    const acquireHostLease = () => acquireLiveHostLease({ homeDirectory });
    const before = new globalThis.AbortController();
    const controller = new LiveProcessController({
      acquireHostLease,
      listProcesses: async () => [],
    });
    await controller.assertNoPreExistingLive();
    before.abort();
    await expect(
      controller.launch("unused", 1000, { signal: before.signal }),
    ).rejects.toThrow();
    const after = new globalThis.AbortController();
    const next = new LiveProcessController({
      acquireHostLease,
      listProcesses: async () => [],
      requestLaunch: async () => after.abort(),
    });
    await expect(
      next.launch("unused", 1000, { signal: after.signal }),
    ).rejects.toThrow();
    await expect(next.close()).rejects.toThrow("uncertain");
    await expect(acquireHostLease()).rejects.toThrow("already held");
  });

  it("releases a standalone lease only after confirmed process exit", async () => {
    const homeDirectory = resolve(
      ".test-artifacts",
      `stop-lease-${randomUUID()}`,
    );
    roots.push(homeDirectory);
    const acquireHostLease = () => acquireLiveHostLease({ homeDirectory });
    const lists = [[], [], [owned], [owned]];
    let exited = false;
    const controller = new LiveProcessController({
      acquireHostLease,
      listProcesses: async () => lists.shift() ?? [owned],
      requestLaunch: async () => undefined,
      requestQuit: async () => undefined,
      kill: () => {
        if (exited) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      },
    });
    await controller.launch("/Applications/Ableton Live 11 Suite.app");
    await expect(controller.gracefulStop(0)).rejects.toThrow(
      "manual intervention",
    );
    await expect(acquireHostLease()).rejects.toThrow("already held");
    exited = true;
    await controller.gracefulStop(0);
    const next = await acquireHostLease();
    await next.release();
  });

  it("refuses process control after its host lease is replaced", async () => {
    const homeDirectory = resolve(
      ".test-artifacts",
      `foreign-lease-${randomUUID()}`,
    );
    roots.push(homeDirectory);
    const hostLease = await acquireLiveHostLease({ homeDirectory });
    const lists = [[], [], [owned]];
    const requestQuit = vi.fn();
    const kill = vi.fn();
    const controller = new LiveProcessController({
      hostLease,
      listProcesses: async () => lists.shift() ?? [owned],
      requestLaunch: async () => undefined,
      requestQuit,
      kill,
    });
    await controller.launch("/Applications/Ableton Live 11 Suite.app");
    const { leaseDirectory } = resolveLiveHostAutomationStorage({
      homeDirectory,
    });
    await rename(leaseDirectory, `${leaseDirectory}.old`);
    await mkdir(leaseDirectory);
    await expect(controller.discardAfterFailure(0)).rejects.toThrow();
    expect(requestQuit).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    await expect(hostLease.release()).rejects.toThrow("reserved");
  });
  it("opens only a bounded copied Set during a fresh exact-PID startup", async () => {
    const root = resolve(".test-artifacts", `startup-unit-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const fixturePath = join(root, "copied.als");
    await writeFile(fixturePath, "test-only Set, never launched");
    const lists = [[], [], [owned]];
    const run = vi.fn(async () => ({ status: 0 }));
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [owned],
      run,
    });
    await controller.launch("/Applications/Ableton Live 11 Suite.app", 1000, {
      fixturePath,
    });
    expect(run).toHaveBeenCalledWith(
      "open",
      ["-n", "-a", "/Applications/Ableton Live 11 Suite.app", fixturePath],
      { timeoutMs: 15000 },
    );
    expect(controller.publicRecord().pid).toBe(owned.pid);
  });

  it("refuses unsafe startup files without launching or adopting Live", async () => {
    const root = resolve(".test-artifacts", `startup-denial-${randomUUID()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const target = join(root, "copied.als");
    const linked = join(root, "linked.als");
    await writeFile(target, "test");
    await symlink(target, linked);
    const run = vi.fn();
    const controller = new LiveProcessController({
      listProcesses: async () => [],
      run,
    });
    await expect(
      controller.launch("/Applications/Ableton Live 11 Suite.app", 1000, {
        fixturePath: linked,
      }),
    ).rejects.toThrow("runner-owned");
    expect(run).not.toHaveBeenCalled();
    expect(controller.publicRecord()).toBeUndefined();
  });

  it("never opens a copied fixture while a pre-existing process exists", async () => {
    const run = vi.fn();
    const controller = new LiveProcessController({
      listProcesses: async () => [owned],
      run,
    });
    await expect(
      controller.launch("/Applications/Ableton Live 11 Suite.app", 1000, {
        fixturePath: "not-read.als",
      }),
    ).rejects.toThrow("already running");
    expect(run).not.toHaveBeenCalled();
  });
  it("allows an externally coordinated launch beyond the ordinary 90-second startup deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const startedAt = Date.now();
      const requestLaunch = vi.fn(async () => undefined);
      const controller = new LiveProcessController({
        listProcesses: async () =>
          Date.now() - startedAt >= 120_000 ? [owned] : [],
        requestLaunch,
        sleep: async (ms) => vi.setSystemTime(Date.now() + ms),
      });

      await controller.launch("/Applications/Ableton Live 11 Suite.app");
      expect(controller.publicRecord().pid).toBe(owned.pid);
      expect(requestLaunch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an explicit external launch deadline bounded without claiming or controlling a late process", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const kill = vi.fn();
      const controller = new LiveProcessController({
        listProcesses: async () => [],
        requestLaunch: vi.fn(async () => undefined),
        sleep: async (ms) => vi.setSystemTime(Date.now() + ms),
        kill,
      });
      await expect(
        controller.launch("/Applications/Ableton Live 11 Suite.app", 1_000),
      ).rejects.toThrow("Timed out");
      expect(controller.publicRecord()).toBeUndefined();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coordinates a sanctioned external launch without shell launch or dialog actions", async () => {
    const lists = [[], [], [owned], [owned]];
    const run = vi.fn();
    const requestLaunch = vi.fn(async () => undefined);
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [owned],
      run,
      requestLaunch,
      handleStartupDialogs: async () => "none",
    });
    await controller.launch("/Applications/Ableton Live 11 Suite.app", 1000);
    expect(requestLaunch).toHaveBeenCalledWith(
      "/Applications/Ableton Live 11 Suite.app",
    );
    expect(run).not.toHaveBeenCalled();
    expect(controller.publicRecord().pid).toBe(owned.pid);
    await expect(controller.dismissKnownStartupDialogs()).resolves.toBe("none");
  });

  it("refuses external launch when a user process already exists", async () => {
    const requestLaunch = vi.fn();
    const controller = new LiveProcessController({
      listProcesses: async () => [owned],
      requestLaunch,
    });
    await expect(
      controller.launch("/Applications/Ableton Live 11 Suite.app"),
    ).rejects.toThrow("already running");
    expect(requestLaunch).not.toHaveBeenCalled();
  });

  it("refuses an unexpected executable after an external launch", async () => {
    const lists = [
      [],
      [],
      [
        {
          ...owned,
          command:
            "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live",
        },
      ],
    ];
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [],
      requestLaunch: async () => undefined,
    });
    await expect(
      controller.launch("/Applications/Ableton Live 11 Suite.app", 1000),
    ).rejects.toThrow("does not match");
    expect(controller.publicRecord()).toBeUndefined();
  });
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

  it("accepts an exit observed on the final deadline check", async () => {
    const lists = [[], [], [owned], [owned]];
    const kill = vi.fn((_pid, signal) => {
      if (signal === 0) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    });
    const controller = new LiveProcessController({
      listProcesses: async () => lists.shift() ?? [owned],
      run: async () => ({ status: 0, stdout: "", stderr: "" }),
      kill,
      requestQuit: vi.fn(async () => undefined),
    });

    await controller.launch("/Applications/Ableton Live 11 Suite.app", 1_000);
    await expect(controller.gracefulStop(0)).resolves.toBeUndefined();
    expect(controller.publicRecord()).toBeUndefined();
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

  it.each(["already-exited", "exit-during-signal", "replacement"])(
    "handles a failed quit with %s without unsafe fallback process control",
    async (mode) => {
      const lists = [[], [], [owned]];
      let exited = false;
      let replaced = false;
      const kill = vi.fn((_pid, signal) => {
        if (signal !== 0 && replaced)
          throw new Error("Replacement must never be signalled");
        if (signal !== 0 && mode === "exit-during-signal") exited = true;
        if (exited) {
          const error = new Error("gone");
          error.code = "ESRCH";
          throw error;
        }
      });
      const controller = new LiveProcessController({
        listProcesses: async () =>
          lists.shift() ?? [
            replaced
              ? { ...owned, startedAt: "a different birth time" }
              : owned,
          ],
        run: async () => ({ status: 0, stdout: "", stderr: "" }),
        kill,
        requestQuit: async () => {
          if (mode === "already-exited") exited = true;
          if (mode === "replacement") replaced = true;
          throw new Error("Quit helper returned after process state changed");
        },
      });
      await controller.launch("/Applications/Ableton Live 11 Suite.app", 1000);
      if (mode === "replacement") {
        await expect(controller.discardAfterFailure(0)).rejects.toThrow(
          "identity no longer matches",
        );
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        expect(controller.publicRecord().pid).toBe(owned.pid);
      } else {
        await expect(
          controller.discardAfterFailure(0),
        ).resolves.toBeUndefined();
        expect(controller.publicRecord()).toBeUndefined();
        expect(
          kill.mock.calls.filter(([, signal]) => signal !== 0),
        ).toHaveLength(mode === "already-exited" ? 0 : 1);
      }
    },
  );

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
