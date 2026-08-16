import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopDiagnosticsActions,
  formatDiagnosticsSummary,
} from "./diagnostics-actions.js";

const root = join(process.cwd(), ".test-artifacts", "diagnostics-actions");

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("desktop diagnostics actions", () => {
  it("reveals only the configured log and exports to the chosen destination", async () => {
    const logs = join(root, "logs");
    const logPath = join(logs, "desktop.log");
    const destination = join(root, "support.json");
    await mkdir(logs, { recursive: true });
    await writeFile(logPath, '{"level":"info","message":"ready"}\n');
    const revealItem = vi.fn();
    const actions = createDesktopDiagnosticsActions({
      logPath,
      getLoggingLevel: () => "info",
      appVersion: "1.2.3",
      platform: "test",
      chooseExportPath: vi.fn().mockResolvedValue(destination),
      revealItem,
      writeClipboard: vi.fn(),
    });
    const checks = [{ label: "Bridge", status: "pass" as const, detail: "OK" }];

    await actions.revealLog();
    await expect(actions.exportSupportBundle(checks)).resolves.toEqual({
      status: "saved",
      filePath: destination,
    });

    expect(revealItem).toHaveBeenCalledWith(logPath);
    expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({
      diagnostics: {
        appVersion: "1.2.3",
        logging: { level: "info", fileName: "desktop.log" },
        checks,
      },
    });
  });

  it("formats and copies a concise summary", async () => {
    const writeClipboard = vi.fn();
    const actions = createDesktopDiagnosticsActions({
      logPath: "/logs/desktop.log",
      getLoggingLevel: () => "debug",
      appVersion: "1",
      platform: "test",
      chooseExportPath: vi.fn().mockResolvedValue(undefined),
      revealItem: vi.fn(),
      writeClipboard,
    });
    const checks = [
      { label: "Security", status: "pass" as const, detail: "OK" },
      { label: "Bridge", status: "warn" as const, detail: "Offline" },
    ];

    await actions.copySummary(checks);

    expect(writeClipboard).toHaveBeenCalledWith(
      formatDiagnosticsSummary({
        checks,
        logging: {
          level: "debug",
          fileName: "desktop.log",
          filePath: "/logs/desktop.log",
        },
      }),
    );
    expect(writeClipboard.mock.calls[0]?.[0]).toContain(
      "Checks: 1 pass, 1 warning, 0 failed",
    );
  });
});
