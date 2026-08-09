import { describe, expect, it, vi } from "vitest";

import {
  parseDeepLink,
  startDesktopLifecycle,
  stopDesktopLifecycle,
} from "./lifecycle.js";

describe("Electron lifecycle adapter", () => {
  it("starts services before opening the window and stops cleanly", async () => {
    const order: string[] = [];
    const deps = {
      requestSingleInstanceLock: () => true,
      onSecondInstance: vi.fn(),
      createWindow: async () => {
        order.push("window");
      },
      focusWindow: vi.fn(),
      startServices: async () => {
        order.push("services");
      },
      stopServices: async () => {
        order.push("stop");
      },
      quit: vi.fn(),
    };
    expect(await startDesktopLifecycle(deps)).toBe(true);
    await stopDesktopLifecycle(deps);
    expect(order).toEqual(["services", "window", "stop"]);
  });

  it("quits a second instance without starting services", async () => {
    const quit = vi.fn();
    const startServices = vi.fn();
    expect(
      await startDesktopLifecycle({
        requestSingleInstanceLock: () => false,
        onSecondInstance: vi.fn(),
        createWindow: vi.fn(),
        focusWindow: vi.fn(),
        startServices,
        stopServices: vi.fn(),
        quit,
      }),
    ).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(startServices).not.toHaveBeenCalled();
  });

  it("accepts only the narrow session deep-link shape", () => {
    expect(parseDeepLink(["ableton-agent://session/abc"])).toBe("abc");
    expect(parseDeepLink(["ableton-agent://open/file"])).toBeUndefined();
    expect(parseDeepLink(["ableton-agent://session/%E0%A4%A"])).toBeUndefined();
    expect(
      parseDeepLink(["ableton-agent://session/../../secret"]),
    ).toBeUndefined();
  });

  it("focuses and handles a validated second-instance deep link", async () => {
    let secondInstance: ((argv: string[]) => void) | undefined;
    const handleDeepLink = vi.fn();
    const focusWindow = vi.fn();
    await startDesktopLifecycle({
      requestSingleInstanceLock: () => true,
      onSecondInstance: (handler) => {
        secondInstance = handler;
      },
      handleDeepLink,
      createWindow: vi.fn(),
      focusWindow,
      startServices: vi.fn(),
      stopServices: vi.fn(),
      quit: vi.fn(),
    });
    secondInstance?.(["ableton-agent://session/session-1"]);
    expect(focusWindow).toHaveBeenCalledOnce();
    expect(handleDeepLink).toHaveBeenCalledWith("session-1");
  });
});
