import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/electron",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  projects: [{ name: "electron", testMatch: /desktop\.spec\.ts/u }],
  use: {
    trace: "retain-on-failure",
  },
});
