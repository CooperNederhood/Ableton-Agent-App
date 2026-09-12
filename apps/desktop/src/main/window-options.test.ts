import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createWindowOptions,
  resolveDesktopIconPath,
  shouldOpenDevelopmentTools,
} from "./window-options.js";

describe("desktop window development options", () => {
  it("enables DevTools support only for development windows", () => {
    expect(
      createWindowOptions("/preload.cjs", true, "/icon.png").webPreferences
        ?.devTools,
    ).toBe(true);
    expect(
      createWindowOptions("/preload.cjs", false, "/icon.png").webPreferences
        ?.devTools,
    ).toBe(false);
  });

  it("applies the supplied application icon to the window", () => {
    expect(createWindowOptions("/preload.cjs", true, "/icon.png").icon).toBe(
      "/icon.png",
    );
  });

  it("opens DevTools only when explicitly requested in development", () => {
    expect(shouldOpenDevelopmentTools(true, "1")).toBe(true);
    expect(shouldOpenDevelopmentTools(true, undefined)).toBe(false);
    expect(shouldOpenDevelopmentTools(true, "0")).toBe(false);
    expect(shouldOpenDevelopmentTools(false, "1")).toBe(false);
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
