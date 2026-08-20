import { resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

const desktopPath = resolve("apps/desktop");

test("launches the packaged desktop contract securely", async () => {
  const application = await electron.launch({
    args: [desktopPath],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      NODE_ENV: "test",
    },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window).toHaveTitle("Ableton Agent");
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Workspace" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Settings" }),
    ).toBeVisible();

    const isolation = await window.evaluate(() => ({
      desktop: typeof window.desktop,
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }));
    expect(isolation).toEqual({
      desktop: "object",
      require: "undefined",
      process: "undefined",
    });

    const shortcutModifier = process.platform === "darwin" ? "Meta" : "Control";
    await window.keyboard.press(`${shortcutModifier}+,`);
    await expect(
      window.getByRole("heading", { name: "Settings" }),
    ).toBeVisible();
    await window.keyboard.press(`${shortcutModifier}+k`);
    const composer = window.getByRole("textbox", {
      name: "Message the Ableton agent",
    });
    await expect(composer).toBeEnabled();
    await expect(composer).toBeFocused();
  } finally {
    await application.close();
  }
});

test("exposes essential landmarks and labels", async () => {
  const application = await electron.launch({
    args: [desktopPath],
    cwd: process.cwd(),
  });
  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.locator("main#main-content")).toBeVisible();
    await expect(window.locator("header")).toBeVisible();
    await expect(window.locator("nav[aria-label]")).toHaveCount(1);
    const unnamedButtons = await window
      .locator("button")
      .evaluateAll(
        (buttons) =>
          buttons.filter(
            (button) =>
              !button.getAttribute("aria-label")?.trim() &&
              !button.textContent?.trim(),
          ).length,
      );
    expect(unnamedButtons).toBe(0);
  } finally {
    await application.close();
  }
});
