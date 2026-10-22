import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeOwnedPackagedApplication,
  withPackagedFixtureCleanup,
  type OwnedPackagedApplication,
  type PackagedCleanupReceipt,
} from "../../../../tests/electron/packaged-cleanup.js";

const timeouts = { gracefulMs: 30, terminateMs: 20, killMs: 10 };

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 55998,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true),
  });
  const exit = (signal: NodeJS.Signals | null = null) => {
    child.exitCode = signal === null ? 0 : null;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
  };
  const application: OwnedPackagedApplication = {
    close: vi.fn(async () => exit()),
    process: vi.fn(() => child as unknown as ChildProcess),
  };
  return { child, application, exit };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("packaged Electron owned cleanup", () => {
  it("closes cleanly without signalling and removes listeners and deadlines", async () => {
    vi.useFakeTimers();
    const { application, child } = fixture();
    const receipt = await closeOwnedPackagedApplication(application, timeouts);
    expect(receipt).toMatchObject({ stopped: true, successful: true });
    expect(receipt.events.map(({ status }) => status)).toEqual([
      "queued",
      "started",
      "completed",
    ]);
    expect(receipt.events.at(-1)).toMatchObject({
      stage: "close",
      pid: child.pid,
      durationMs: 0,
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a blocked close and escalates only the captured child through SIGTERM and SIGKILL", async () => {
    vi.useFakeTimers();
    const { application, child, exit } = fixture();
    const unrelated = fixture().child;
    unrelated.pid = 88059;
    const globalKill = vi.spyOn(process, "kill");
    vi.mocked(application.close).mockImplementation(
      () => new Promise(() => {}),
    );
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") exit("SIGKILL");
      return true;
    });
    let receipt: PackagedCleanupReceipt | undefined;
    const pending = closeOwnedPackagedApplication(application, timeouts).then(
      (value) => (receipt = value),
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(receipt).toMatchObject({ stopped: true, successful: false });
    await pending;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(application.process).toHaveBeenCalledTimes(1);
    expect(globalKill).not.toHaveBeenCalled();
    expect(unrelated.kill).not.toHaveBeenCalled();
    expect(
      receipt!.events.filter(({ status }) => status === "timed-out"),
    ).toMatchObject([
      { stage: "close", durationMs: 30 },
      { stage: "SIGTERM", durationMs: 20 },
    ]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the primary failure, reports teardown, and cleans all owned resources and profile", async () => {
    vi.useFakeTimers();
    const { application, child, exit } = fixture();
    vi.mocked(application.close).mockImplementation(
      () => new Promise(() => {}),
    );
    child.kill.mockImplementation(() => {
      exit("SIGTERM");
      return true;
    });
    const primary = new Error("original firstWindow timeout");
    const resources = [vi.fn(async () => {}), vi.fn(async () => {})];
    const removeProfile = vi.fn(async () => {});
    const report = vi.fn<(receipt: PackagedCleanupReceipt) => Promise<void>>(
      async () => {},
    );
    let failure: unknown;
    const pending = withPackagedFixtureCleanup({
      run: async () => {
        throw primary;
      },
      getApplication: () => application,
      resources,
      removeProfile,
      report,
      timeouts,
    }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(failure).toBe(primary);
    await pending;
    expect(resources.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(
      true,
    );
    expect(removeProfile).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0].events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "close", status: "timed-out" }),
        expect.objectContaining({ stage: "SIGTERM", status: "completed" }),
        expect.objectContaining({ stage: "profile", status: "completed" }),
      ]),
    );
  });

  it("does not signal an exited child and still bounds a stuck Playwright close", async () => {
    vi.useFakeTimers();
    const { application, child, exit } = fixture();
    exit();
    vi.mocked(application.close).mockImplementation(
      () => new Promise(() => {}),
    );
    let receipt: PackagedCleanupReceipt | undefined;
    const pending = closeOwnedPackagedApplication(application, timeouts).then(
      (value) => (receipt = value),
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(receipt?.stopped).toBe(true);
    await pending;
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a live profile when exact-child termination fails, but cleans other resources", async () => {
    vi.useFakeTimers();
    const { application, child } = fixture();
    vi.mocked(application.close).mockImplementation(
      () => new Promise(() => {}),
    );
    child.kill.mockImplementation(() => {
      throw new Error("denied token=do-not-persist");
    });
    const removeProfile = vi.fn(async () => {});
    const resource = vi.fn(async () => {});
    const report = vi.fn<(receipt: PackagedCleanupReceipt) => Promise<void>>(
      async () => {},
    );
    const primary = new Error("firstWindow timeout");
    let failure: unknown;
    const pending = withPackagedFixtureCleanup({
      run: async () => {
        throw primary;
      },
      getApplication: () => application,
      resources: [resource],
      removeProfile,
      report,
      timeouts,
    }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(failure).toBe(primary);
    await pending;
    expect(resource).toHaveBeenCalledOnce();
    expect(removeProfile).not.toHaveBeenCalled();
    expect(report.mock.calls[0]![0]).toMatchObject({
      stopped: false,
      successful: false,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("do-not-persist");
    expect(report.mock.calls[0]![0].events).toContainEqual(
      expect.objectContaining({
        stage: "profile",
        status: "cancelled",
        reason: "process-running",
      }),
    );
  });

  it("attempts remaining cleanup after resource failure and does not mask the primary error with reporting failure", async () => {
    const primary = new Error("firstWindow timeout");
    const resource = vi.fn(async () => {});
    const removeProfile = vi.fn(async () => {});
    const report = vi.fn<(receipt: PackagedCleanupReceipt) => Promise<void>>(
      async () => {
        throw new Error("attachment failed");
      },
    );
    await expect(
      withPackagedFixtureCleanup({
        run: async () => {
          throw primary;
        },
        getApplication: () => undefined,
        resources: [
          async () => {
            throw new Error("resource failed");
          },
          resource,
        ],
        removeProfile,
        report,
        timeouts,
      }),
    ).rejects.toBe(primary);
    expect(resource).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });

  it("retains a successful result after clean resource and profile cleanup", async () => {
    const { application } = fixture();
    const order: string[] = [];
    const report = vi.fn<(receipt: PackagedCleanupReceipt) => Promise<void>>(
      async () => {
        order.push("report");
      },
    );
    await expect(
      withPackagedFixtureCleanup({
        run: async () => "verified",
        getApplication: () => application,
        resources: [
          async () => {
            order.push("resource");
          },
        ],
        removeProfile: async () => {
          order.push("profile");
        },
        report,
        timeouts,
      }),
    ).resolves.toBe("verified");
    expect(order).toEqual(["resource", "profile", "report"]);
    expect(report.mock.calls[0]![0]).toMatchObject({
      stopped: true,
      successful: true,
    });
  });

  it("uses exact-child SIGTERM and consumes a late close rejection", async () => {
    vi.useFakeTimers();
    const { application, child, exit } = fixture();
    let rejectClose!: (error: Error) => void;
    vi.mocked(application.close).mockImplementation(
      () =>
        new Promise<void>((...callbacks) => {
          rejectClose = callbacks[1];
        }),
    );
    child.kill.mockImplementation(() => {
      exit("SIGTERM");
      return true;
    });
    const pending = closeOwnedPackagedApplication(application, timeouts);
    await vi.advanceTimersByTimeAsync(30);
    const receipt = await pending;
    rejectClose(new Error("late native rejection"));
    await vi.advanceTimersByTimeAsync(1);
    expect(receipt.stopped).toBe(true);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0, -55998, process.pid])(
    "refuses signalling an invalid/non-child PID %s",
    async (pid) => {
      vi.useFakeTimers();
      const { application, child } = fixture();
      Object.defineProperty(child, "pid", { value: pid });
      vi.mocked(application.close).mockRejectedValue(new Error("close failed"));
      const receipt = await closeOwnedPackagedApplication(
        application,
        timeouts,
      );
      expect(receipt).toMatchObject({ stopped: false, successful: false });
      expect(receipt.events).toContainEqual(
        expect.objectContaining({
          status: "cancelled",
          reason: "invalid-pid",
        }),
      );
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.listenerCount("exit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds ineffective SIGKILL without claiming that the child stopped", async () => {
    vi.useFakeTimers();
    const { application, child } = fixture();
    vi.mocked(application.close).mockImplementation(
      () => new Promise(() => {}),
    );
    let receipt: PackagedCleanupReceipt | undefined;
    const pending = closeOwnedPackagedApplication(application, timeouts).then(
      (value) => (receipt = value),
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(receipt).toMatchObject({ stopped: false, successful: false });
    await pending;
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(receipt!.events.at(-1)).toMatchObject({
      stage: "SIGKILL",
      status: "timed-out",
      durationMs: 10,
    });
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a blocked resource, cleans subsequent resources/profile, and fails teardown without a primary failure", async () => {
    vi.useFakeTimers();
    const resource = vi.fn(async () => {});
    const removeProfile = vi.fn(async () => {});
    const report = vi.fn<(receipt: PackagedCleanupReceipt) => Promise<void>>(
      async () => {},
    );
    let failure: unknown;
    const pending = withPackagedFixtureCleanup({
      run: async () => {},
      getApplication: () => undefined,
      resources: [() => new Promise(() => {}), resource],
      removeProfile,
      report,
      timeouts,
    }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(failure).toBeInstanceOf(Error);
    await pending;
    expect(resource).toHaveBeenCalledOnce();
    expect(removeProfile).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0].events).toContainEqual(
      expect.objectContaining({
        stage: "resource",
        resourceIndex: 0,
        status: "timed-out",
        durationMs: 3_000,
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a profile removal failure without persisting raw error payloads", async () => {
    const report = vi.fn<(receipt: PackagedCleanupReceipt) => Promise<void>>(
      async () => {},
    );
    await expect(
      withPackagedFixtureCleanup({
        run: async () => {},
        getApplication: () => undefined,
        resources: [],
        removeProfile: async () => {
          throw new Error("private path and credential value");
        },
        report,
      }),
    ).rejects.toThrow("Packaged fixture teardown failed");
    expect(report.mock.calls[0]![0].events).toContainEqual(
      expect.objectContaining({ stage: "profile", status: "failed" }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("private path");
  });
});
