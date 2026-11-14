import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { awaitElectronLaunch } from "../../tests/electron/acceptance-launch.js";

describe("owned Electron startup rejection containment", () => {
  it("preserves successful ownership and primary failures without leaking process listeners", async () => {
    const before = process.listeners("unhandledRejection");
    const application = { owned: true };
    expect(await awaitElectronLaunch(() => Promise.resolve(application))).toBe(
      application,
    );
    const failure = new Error("primary startup failure");
    await expect(
      awaitElectronLaunch(() => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(process.listeners("unhandledRejection")).toEqual(before);
  });
  it("does not suppress an unrelated rejection with the same error text", async () => {
    const code = `
      import { tsImport } from "tsx/esm/api";
      const { awaitElectronLaunch } = await tsImport("./tests/electron/acceptance-launch.ts", {
        parentURL: new URL("./package.json", "file://" + process.cwd() + "/").href
      });
      await awaitElectronLaunch(() => new Promise(() => {
        void Promise.reject(new Error("Process failed to launch!"));
      }));
    `;
    const child = spawn(
      process.execPath,
      ["--unhandled-rejections=throw", "--input-type=module", "-e", code],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    });
    expect(exit).toBe(1);
    expect(stderr).toContain("Error: Process failed to launch!");
  });
  it("returns an actual Playwright early-process rejection without orphaned startup promises crashing Node", async () => {
    const directory = resolve(
      ".test-artifacts",
      `launch-rejection-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true });
    const code = `
      import { tsImport } from "tsx/esm/api";
      import { _electron } from "@playwright/test";
      const { awaitElectronLaunch } = await tsImport("./tests/electron/acceptance-launch.ts", {
        parentURL: new URL("./package.json", "file://" + process.cwd() + "/").href
      });
      let cleanup = false;
      try {
        await awaitElectronLaunch(() => _electron.launch({
          executablePath: process.execPath,
          args: ["-e", "process.exit(1)"],
          artifactsDir: ${JSON.stringify(directory)},
          timeout: 2000
        }));
        throw new Error("Unexpected startup success");
      } catch (error) {
        if (!error.message.includes("Process failed to launch!")) throw error;
      } finally { cleanup = true; }
      await new Promise(resolve => setTimeout(resolve, 25));
      console.log(JSON.stringify({ cleanup, returned: true }));
    `;
    try {
      const child = spawn(
        process.execPath,
        ["--unhandled-rejections=throw", "--input-type=module", "-e", code],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exit = await new Promise<number | null>((accept, reject) => {
        child.once("error", reject);
        child.once("close", accept);
      });
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(JSON.parse(stdout.trim())).toEqual({
        cleanup: true,
        returned: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
