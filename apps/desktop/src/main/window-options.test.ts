import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { preferencesSchema } from "../contracts.js";
import {
  applyAlwaysOnTop,
  applyWindowPreferenceEvent,
  createWindowOptions,
  resolveDesktopIconPath,
  shouldOpenDevelopmentTools,
} from "./window-options.js";

describe("desktop window development options", () => {
  it("enables DevTools support only for development windows", () => {
    expect(
      createWindowOptions("/preload.cjs", true, "/icon.png", false)
        .webPreferences?.devTools,
    ).toBe(true);
    expect(
      createWindowOptions("/preload.cjs", false, "/icon.png", false)
        .webPreferences?.devTools,
    ).toBe(false);
  });

  it("applies the supplied application icon to the window", () => {
    expect(
      createWindowOptions("/preload.cjs", true, "/icon.png", false).icon,
    ).toBe("/icon.png");
  });

  it("allows a terminal-sized chat window", () => {
    const options = createWindowOptions(
      "/preload.cjs",
      false,
      "/icon.png",
      false,
    );

    expect(options).toMatchObject({
      width: 1440,
      height: 940,
      minWidth: 320,
      minHeight: 360,
    });
  });

  it("restores the saved always-on-top state before showing the window", () => {
    expect(
      createWindowOptions("/preload.cjs", false, "/icon.png", true).alwaysOnTop,
    ).toBe(true);
  });

  it("opens DevTools only when explicitly requested in development", () => {
    expect(shouldOpenDevelopmentTools(true, "1")).toBe(true);
    expect(shouldOpenDevelopmentTools(true, undefined)).toBe(false);
    expect(shouldOpenDevelopmentTools(true, "0")).toBe(false);
    expect(shouldOpenDevelopmentTools(false, "1")).toBe(false);
  });
});

describe("always-on-top behavior", () => {
  it("pins and unpins the window", () => {
    const window = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
    };

    applyAlwaysOnTop(window, true, "win32");
    applyAlwaysOnTop(window, false, "win32");

    expect(window.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true);
    expect(window.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false);
    expect(window.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  it("follows macOS Spaces and full-screen windows when enabled", () => {
    const window = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
    };

    applyAlwaysOnTop(window, true, "darwin");
    applyAlwaysOnTop(window, false, "darwin");

    expect(window.setVisibleOnAllWorkspaces).toHaveBeenNthCalledWith(1, true, {
      visibleOnFullScreen: true,
    });
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenNthCalledWith(2, false, {
      visibleOnFullScreen: false,
    });
  });

  it("applies live preference events and ignores unrelated events", () => {
    const window = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
    };

    applyWindowPreferenceEvent(
      window,
      {
        type: "preferences.changed",
        preferences: {
          ...preferencesSchema.parse({}),
          alwaysOnTop: true,
        },
      },
      "darwin",
    );
    applyWindowPreferenceEvent(
      window,
      { type: "diagnostic", level: "info", message: "Connected" },
      "darwin",
    );

    expect(window.setAlwaysOnTop).toHaveBeenCalledOnce();
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledOnce();
  });
});

describe("desktop icon path", () => {
  it("uses the unpacked build asset during development", () => {
    expect(resolveDesktopIconPath(false, "/resources", "/app/dist/main")).toBe(
      join("/app/dist/main", "../../build/icon.png"),
    );
  });

  it("uses the copied resource in packaged applications", () => {
    expect(resolveDesktopIconPath(true, "/resources", "/app/dist/main")).toBe(
      join("/resources", "icon.png"),
    );
  });
});
