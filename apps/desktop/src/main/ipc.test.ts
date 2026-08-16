import { describe, expect, it, vi } from "vitest";

import type { DesktopService } from "./desktop-service.js";
import type { DiagnosticsActions } from "./ipc.js";
import { registerIpc } from "./ipc.js";

describe("desktop IPC", () => {
  it("guards diagnostics filesystem actions with the trusted sender check", async () => {
    const registered = new Map<
      string,
      (event: never, payload: unknown) => Promise<unknown>
    >();
    const ipcMain = {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: never, payload: unknown) => Promise<unknown>,
        ) => {
          registered.set(channel, handler);
        },
      ),
      removeHandler: vi.fn(),
    };
    const revealLog = vi.fn().mockResolvedValue(undefined);
    const diagnostics = {
      getReport: vi.fn(),
      revealLog,
      exportSupportBundle: vi.fn(),
      copySummary: vi.fn(),
    } as unknown as DiagnosticsActions;
    let trusted = false;

    registerIpc(ipcMain, {} as DesktopService, diagnostics, () => trusted);
    const handler = registered.get("diagnostics:reveal-log");
    expect(handler).toBeDefined();

    await expect(handler?.({} as never, {})).rejects.toThrow(
      "Untrusted IPC sender",
    );
    expect(revealLog).not.toHaveBeenCalled();

    trusted = true;
    await expect(handler?.({} as never, {})).resolves.toEqual({
      revealed: true,
    });
    expect(revealLog).toHaveBeenCalledTimes(1);
  });
});
