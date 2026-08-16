import { describe, expect, it } from "vitest";

import {
  createWindowOptions,
  shouldOpenDevelopmentTools,
} from "./window-options.js";

describe("desktop window development options", () => {
  it("enables DevTools support only for development windows", () => {
    expect(
      createWindowOptions("/preload.cjs", true).webPreferences?.devTools,
    ).toBe(true);
    expect(
      createWindowOptions("/preload.cjs", false).webPreferences?.devTools,
    ).toBe(false);
  });

  it("opens DevTools only when explicitly requested in development", () => {
    expect(shouldOpenDevelopmentTools(true, "1")).toBe(true);
    expect(shouldOpenDevelopmentTools(true, undefined)).toBe(false);
    expect(shouldOpenDevelopmentTools(true, "0")).toBe(false);
    expect(shouldOpenDevelopmentTools(false, "1")).toBe(false);
  });
});
