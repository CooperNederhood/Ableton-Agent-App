import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import { sendAutomationMessage } from "../../packages/debug-control/src/client.js";

const desktopPath = resolve("apps/desktop");

test.setTimeout(60_000);

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

test("accepts an MCP-style user message in the visible desktop session", async () => {
  const profilePath = await mkdtemp(
    join(tmpdir(), "ableton-agent-electron-automation-"),
  );
  const descriptorPath = join(profilePath, "automation-endpoint.json");
  const application = await electron.launch({
    args: [
      desktopPath,
      "--automation",
      "--automation-profile",
      profilePath,
      "--automation-agent",
      "default",
      "--automation-yolo",
    ],
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
    await expect
      .poll(
        async () =>
          sendAutomationMessage({
            descriptorPath,
            message: "Verify this message is visible in the desktop app.",
          })
            .then(() => "accepted")
            .catch(() => "waiting"),
        { timeout: 15_000 },
      )
      .toBe("accepted");
    await expect(
      window.getByText("Verify this message is visible in the desktop app.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      window.getByText("YOLO", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(profilePath, { recursive: true, force: true });
  }
});

test("delivers a plan request to the Inspector and routes its response through IPC", async () => {
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
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const desktop = (
              window as unknown as {
                desktop: {
                  lifecycle: { get: () => Promise<string> };
                };
              }
            ).desktop;
            return await desktop.lifecycle.get();
          }),
        { timeout: 30_000 },
      )
      .toMatch(/ready|degraded/u);
    const agentInstanceId = await window.evaluate(async () => {
      const desktop = (
        window as unknown as {
          desktop: {
            agent: {
              getSessions: () => Promise<
                Array<{ selectedAgentInstanceId?: string }>
              >;
              createSession: () => Promise<string>;
            };
          };
        }
      ).desktop;
      let sessions = await desktop.agent.getSessions();
      if (!sessions.some((session) => session.selectedAgentInstanceId)) {
        await desktop.agent.createSession();
        sessions = await desktop.agent.getSessions();
      }
      const selected = sessions.find(
        (session) => session.selectedAgentInstanceId !== undefined,
      )?.selectedAgentInstanceId;
      if (selected === undefined) throw new Error("Selected agent missing");
      return selected;
    });
    await expect(window.getByLabel("Active Agent")).toHaveValue(
      agentInstanceId,
    );
    await window
      .getByRole("button", { name: "Hide inspector sidebar" })
      .click();
    await expect(
      window.getByRole("complementary", { name: "Selection inspector" }),
    ).toHaveCount(0);

    await application.evaluate(
      (
        { BrowserWindow },
        request: {
          type: "agent.plan_approval_requested";
          agentInstanceId: string;
          request: {
            requestId: string;
            summary: string;
            planContent: string;
            recommendedAction: "interactive";
            actions: Array<"interactive" | "exit_only">;
          };
        },
      ) => {
        const desktopWindow = BrowserWindow.getAllWindows()[0];
        if (desktopWindow === undefined)
          throw new Error("Desktop window missing");
        desktopWindow.webContents.send("app:event", request);
      },
      {
        type: "agent.plan_approval_requested",
        agentInstanceId,
        request: {
          requestId: "electron-plan-request",
          summary: "Electron approval plan",
          planContent:
            "**Electron plan** Use the current project: - **Inspect:** verify the Arrangement - **Implement:** place existing clips Implementation: preserve the original plan payload.",
          recommendedAction: "interactive",
          actions: ["interactive", "exit_only"],
        },
      },
    );

    await expect(
      window.getByRole("complementary", { name: "Selection inspector" }),
    ).toBeVisible();
    await expect(window.getByText("Electron approval plan")).toBeVisible();
    await expect(window.locator(".plan-approval-content li")).toHaveCount(2);
    await expect(
      window.getByRole("heading", { name: "Implementation:" }),
    ).toBeVisible();
    await window.getByRole("button", { name: "Approve and continue" }).click();
    await expect(
      window.getByText("This plan request is no longer pending."),
    ).toBeVisible();
    await expect(window.getByText("Electron approval plan")).toBeVisible();
  } finally {
    await application.close();
  }
});

test("resizes both workspace sidebars and restores their session widths", async () => {
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
    await application.evaluate(({ BrowserWindow }) => {
      const desktopWindow = BrowserWindow.getAllWindows()[0];
      if (desktopWindow === undefined) {
        throw new Error("Desktop window missing");
      }
      desktopWindow.setSize(1440, 780);
    });
    const workspace = window.locator(".workspace");
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    const project = window.getByRole("complementary", {
      name: "Project outline",
    });
    const inspector = window.getByRole("complementary", {
      name: "Selection inspector",
    });
    const leftHandle = window.locator(".sidebar-resize-handle-left");
    const rightHandle = window.locator(".sidebar-resize-handle-right");
    await expect(project).toBeVisible();
    await expect(inspector).toBeVisible();
    await expect(leftHandle).toBeVisible();
    await expect(rightHandle).toBeVisible();
    const projectBefore = await project.boundingBox();
    const inspectorBefore = await inspector.boundingBox();
    const leftHandleBox = await leftHandle.boundingBox();
    if (
      projectBefore === null ||
      inspectorBefore === null ||
      leftHandleBox === null
    ) {
      throw new Error("Workspace resize geometry is unavailable");
    }

    await window.mouse.move(
      leftHandleBox.x + leftHandleBox.width / 2,
      leftHandleBox.y + 40,
    );
    await window.mouse.down();
    await window.mouse.move(leftHandleBox.x + 70, leftHandleBox.y + 40);
    await window.mouse.up();
    await expect
      .poll(async () => (await project.boundingBox())?.width)
      .toBeGreaterThan(projectBefore.width + 40);
    const expandedProject = await project.boundingBox();
    const rightHandleBox = await rightHandle.boundingBox();
    if (expandedProject === null || rightHandleBox === null) {
      throw new Error("Updated workspace resize geometry is unavailable");
    }

    await window.mouse.move(
      rightHandleBox.x + rightHandleBox.width / 2,
      rightHandleBox.y + 40,
    );
    await window.mouse.down();
    await window.mouse.move(rightHandleBox.x - 70, rightHandleBox.y + 40);
    await window.mouse.up();
    await expect
      .poll(async () => (await inspector.boundingBox())?.width)
      .toBeGreaterThan(inspectorBefore.width + 40);
    const expandedInspector = await inspector.boundingBox();
    if (expandedInspector === null) {
      throw new Error("Expanded Inspector geometry is unavailable");
    }

    await window.getByRole("button", { name: "Hide project sidebar" }).click();
    await expect(project).toHaveCount(0);
    await window.getByRole("button", { name: "Show project sidebar" }).click();
    await expect
      .poll(async () => (await project.boundingBox())?.width)
      .toBeCloseTo(expandedProject.width, 0);
    await expect
      .poll(async () => (await inspector.boundingBox())?.width)
      .toBeCloseTo(expandedInspector.width, 0);
  } finally {
    await application.close();
  }
});
