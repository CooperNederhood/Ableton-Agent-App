import { basename, dirname } from "node:path";

import type {
  DesktopDiagnosticsReport,
  DiagnosticCheck,
  DesktopPreferences,
} from "../contracts.js";
import type { DiagnosticsActions } from "./ipc.js";
import { exportSupportBundle } from "./logger.js";

interface DesktopDiagnosticsActionsOptions {
  logPath: string;
  getLoggingLevel(): DesktopPreferences["loggingLevel"];
  environmentOverride?: boolean;
  appVersion: string;
  platform: string;
  chooseExportPath(): Promise<string | undefined>;
  revealItem(path: string): void;
  writeClipboard(text: string): void;
}

export function formatDiagnosticsSummary(
  report: DesktopDiagnosticsReport,
): string {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of report.checks) counts[check.status]++;
  const findings = report.checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.status.toUpperCase()}: ${check.label}`)
    .join("\n");
  return [
    "Ableton Agent diagnostics",
    `Logging: ${report.logging.level} (${report.logging.fileName})`,
    `Checks: ${counts.pass} pass, ${counts.warn} warning, ${counts.fail} failed`,
    findings,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createDesktopDiagnosticsActions(
  options: DesktopDiagnosticsActionsOptions,
): DiagnosticsActions {
  const getReport = async (
    checks: DiagnosticCheck[],
  ): Promise<DesktopDiagnosticsReport> => ({
    checks,
    logging: {
      level: options.getLoggingLevel(),
      fileName: basename(options.logPath),
      filePath: options.logPath,
      environmentOverride: options.environmentOverride ?? false,
    },
  });

  return {
    getReport,
    revealLog: async () => {
      options.revealItem(options.logPath);
    },
    exportSupportBundle: async (checks) => {
      const destination = await options.chooseExportPath();
      if (destination === undefined) return { status: "cancelled" };
      const report = await getReport(checks);
      await exportSupportBundle({
        destination,
        logsDirectory: dirname(options.logPath),
        diagnostics: {
          appVersion: options.appVersion,
          platform: options.platform,
          logging: report.logging,
          checks: report.checks,
        },
      });
      return { status: "saved", filePath: destination };
    },
    copySummary: async (checks) => {
      options.writeClipboard(formatDiagnosticsSummary(await getReport(checks)));
    },
  };
}
