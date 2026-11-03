import type { LiveProcessController } from "./live-process-controller.mjs";

export function waitForRunnerOwnedLiveReady(
  controller: LiveProcessController,
  options?: {
    coordinatedStartup?: boolean;
    discardRecovery?: boolean;
    host?: string;
    port?: number;
    timeoutMs?: number;
  },
): Promise<{ dismissedDialogs: string[] }>;
