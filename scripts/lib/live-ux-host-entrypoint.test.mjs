import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  launch: vi.fn(),
  close: vi.fn(),
  gracefulStop: vi.fn(),
  discardAfterFailure: vi.fn(),
  readiness: vi.fn(),
  fixture: vi.fn(),
  handlers: new Map(),
}));

vi.mock("./live-process-controller.mjs", () => ({
  LiveProcessController: class {
    launch = f.launch;
    close = f.close;
    gracefulStop = f.gracefulStop;
    discardAfterFailure = f.discardAfterFailure;
  },
  createComputerUseLiveController: vi.fn(),
}));
vi.mock("./live-ux-host.mjs", () => ({
  liveUxFixturePath: f.fixture,
  waitForRunnerOwnedLiveReady: f.readiness,
}));

describe("standalone Live UX host ownership cleanup", () => {
  let exitCode;
  let argv;
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    f.handlers.clear();
    exitCode = process.exitCode;
    argv = process.argv;
    process.argv = ["node", "live-ux-host.mjs"];
    const once = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation((event, callback) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        f.handlers.set(event, callback);
        return process;
      }
      return once(event, callback);
    });
    vi.spyOn(process, "removeListener");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.launch.mockResolvedValue({ pid: 1234 });
    f.readiness.mockImplementation(async () => {
      f.handlers.get("SIGTERM")();
      return { dismissedDialogs: [] };
    });
  });
  afterEach(() => {
    process.exitCode = exitCode;
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it("releases after graceful shutdown and removes its signal handlers", async () => {
    await import("../live-ux-host.mjs");
    expect(f.gracefulStop).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.discardAfterFailure).not.toHaveBeenCalled();
    expect(f.launch.mock.calls[0][2].signal).toBe(
      f.readiness.mock.calls[0][1].signal,
    );
    for (const event of ["SIGINT", "SIGTERM"]) {
      expect(process.removeListener).toHaveBeenCalledWith(
        event,
        f.handlers.get(event),
      );
    }
  });

  it("closes a safe failed prelaunch admission", async () => {
    f.fixture.mockImplementation(() => {
      throw new Error("invalid fixture");
    });
    await import("../live-ux-host.mjs");
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.discardAfterFailure).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not control an unrecorded process after cancelled uncertain launch", async () => {
    f.launch.mockImplementation(async (_application, _timeout, { signal }) => {
      f.handlers.get("SIGINT")();
      signal.throwIfAborted();
    });
    f.close.mockRejectedValue(new Error("uncertain host ownership"));
    await import("../live-ux-host.mjs");
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.discardAfterFailure).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("uncertain host ownership");
    expect(process.exitCode).toBe(1);
  });

  it("attempts process disposal and close after readiness failure without masking unsafe cleanup", async () => {
    f.readiness.mockRejectedValue(new Error("readiness failed"));
    f.discardAfterFailure.mockRejectedValue(new Error("process still running"));
    f.close.mockRejectedValue(new Error("uncertain host ownership"));
    await import("../live-ux-host.mjs");
    expect(f.discardAfterFailure).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith("process still running");
    expect(console.error).toHaveBeenCalledWith("uncertain host ownership");
    expect(process.exitCode).toBe(1);
  });
});
