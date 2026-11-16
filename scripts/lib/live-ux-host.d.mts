import type { LiveProcessController } from "./live-process-controller.mjs";

export function waitForRunnerOwnedLiveReady(
  controller: LiveProcessController,
  options?: {
    coordinatedStartup?: boolean;
    discardRecovery?: boolean;
    requireAudio?: boolean;
    fixturePath?: string;
    host?: string;
    port?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ dismissedDialogs: string[] }>;
