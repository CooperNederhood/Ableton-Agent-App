export interface OwnedLiveRecord {
  pid: number;
  startedAt: string;
  command: string;
  applicationPath: string;
  runId: string;
  recordedAt: string;
}
export function runProcess(
  command: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;
export function listLiveProcesses(): Promise<
  {
    pid: number;
    startedAt: string;
    command: string;
  }[]
>;
export class LiveProcessController {
  constructor(options?: {
    hostLease?: LiveHostLease;
    acquireHostLease?: () => Promise<LiveHostLease>;
    listProcesses?: typeof listLiveProcesses;
    run?: typeof runProcess;
    kill?: typeof process.kill;
    sleep?: (milliseconds: number) => Promise<void>;
    randomUUID?: () => string;
    requestQuit?: (
      owned: Pick<OwnedLiveRecord, "pid" | "startedAt" | "command">,
    ) => Promise<void>;
    handleStartupDialogs?: (options: {
      discardRecovery?: boolean;
      launchedAt: string;
      pid: number;
    }) => Promise<string>;
    requestLaunch?: (
      applicationPath: string,
      options?: { fixturePath?: string },
    ) => Promise<void>;
  });
  publicRecord(): OwnedLiveRecord | undefined;
  close(): Promise<void>;
  assertNoPreExistingLive(): Promise<void>;
  launch(
    applicationPath: string,
    timeoutMs?: number,
    options?: { fixturePath?: string; signal?: AbortSignal },
  ): Promise<OwnedLiveRecord>;
  validateOwnership(): Promise<{
    pid: number;
    startedAt: string;
    command: string;
  }>;
  dismissKnownStartupDialogs(options?: {
    discardRecovery?: boolean;
  }): Promise<string>;
  gracefulStop(timeoutMs?: number): Promise<void>;
  discardAfterFailure(timeoutMs?: number): Promise<void>;
}

export function createComputerUseLiveController(options?: {
  hostLease?: LiveHostLease;
}): LiveProcessController;
import type { LiveHostLease } from "./live-host-lease.mjs";
