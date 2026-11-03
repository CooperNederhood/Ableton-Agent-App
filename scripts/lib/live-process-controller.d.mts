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
  constructor();
  publicRecord(): OwnedLiveRecord | undefined;
  assertNoPreExistingLive(): Promise<void>;
  launch(
    applicationPath: string,
    timeoutMs?: number,
    options?: { fixturePath?: string },
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
