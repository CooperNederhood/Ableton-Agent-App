import { describe, expect, it } from "vitest";

import { ipcSchemas } from "../contracts.js";
import { createWindowOptions } from "./window-options.js";

describe("Electron security", () => {
  it("uses an isolated sandbox with no renderer Node integration", () => {
    const options = createWindowOptions("/preload.js", false);
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    });
  });

  it("has a finite allowlist and no generic IPC channel", () => {
    const channels = Object.keys(ipcSchemas);
    expect(channels.length).toBeGreaterThan(5);
    expect(channels).toContain("agents:invoke-skill");
    expect(
      channels.every(
        (channel) =>
          channel === "agents:invoke-skill" ||
          (!channel.includes("invoke") && !channel.includes("execute")),
      ),
    ).toBe(true);
  });
});
