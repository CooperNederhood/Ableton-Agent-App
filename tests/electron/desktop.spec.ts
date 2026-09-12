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
    await window.getByRole("button", { name: "Hide project sidebar" }).click();
    await expect(
      window.getByRole("complementary", { name: "Project outline" }),
    ).toHaveCount(0);
    await window.getByRole("button", { name: "Show project sidebar" }).click();
    await expect(
      window.getByRole("complementary", { name: "Project outline" }),
    ).toBeVisible();
    await window
      .getByRole("button", { name: "Hide inspector sidebar" })
      .click();
    await expect(
      window.getByRole("complementary", { name: "Selection inspector" }),
    ).toHaveCount(0);
    await window
      .getByRole("button", { name: "Show inspector sidebar" })
      .click();
    await expect(
      window.getByRole("complementary", { name: "Selection inspector" }),
    ).toBeVisible();
    await window
      .getByRole("button", { name: "Hide application toolbar" })
      .click();
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toHaveCount(0);
    await window
      .getByRole("button", { name: "Show application toolbar" })
      .click();
    await expect(
      window.getByRole("navigation", { name: "Application views" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Settings" }),
    ).toBeVisible();
    const composer = window.getByRole("textbox", {
      name: "Message the Ableton agent",
    });
    await composer.fill("Keep this draft");
    await window.getByRole("button", { name: "Events" }).click();
    await expect(window.getByRole("heading", { name: "Events" })).toBeVisible();
    await expect(window.getByText("No Live Events")).toBeVisible();

    await window.getByRole("button", { name: "Agents" }).click();
    await expect(
      window.getByRole("heading", { name: "Agents", exact: true }),
    ).toBeVisible();
    const editOverrides = window.getByRole("button", {
      name: "Edit overrides",
    });
    await expect(editOverrides.first()).toBeVisible();
    await editOverrides.first().click();
    await expect(
      window.getByRole("group", { name: "Listening Events" }).first(),
    ).toBeVisible();
    await expect(
      window.getByText(
        "No Live events are available in this production session.",
      ),
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
    await expect(composer).toBeEnabled();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");
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

test("supports a terminal-sized chat-only window", async () => {
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

    await window.getByRole("button", { name: "Hide project sidebar" }).click();
    await window
      .getByRole("button", { name: "Hide inspector sidebar" })
      .click();
    await window
      .getByRole("button", { name: "Hide application toolbar" })
      .click();

    const size = await application.evaluate(({ BrowserWindow }) => {
      const desktopWindow = BrowserWindow.getAllWindows()[0];
      if (desktopWindow === undefined)
        throw new Error("Desktop window missing");
      desktopWindow.setSize(320, 360);
      return desktopWindow.getSize();
    });

    expect(size).toEqual([320, 360]);
    await expect(
      window.getByRole("region", {
        name: "Conversation and operation timeline",
      }),
    ).toBeVisible();
    const composer = window.getByRole("textbox", {
      name: "Message the Ableton agent",
    });
    await expect(composer).toBeVisible();
    await composer.fill("Compact chat");
    await expect(composer).toHaveValue("Compact chat");
    await expect(
      window.getByRole("button", { name: "Show application toolbar" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Show project sidebar" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "Show inspector sidebar" }),
    ).toBeVisible();
  } finally {
    await application.close();
  }
});
