import type { ChildProcess } from "node:child_process";

export interface OwnedPackagedApplication {
  close: () => Promise<void>;
  process: () => ChildProcess;
}

export interface ShutdownTimeouts {
  gracefulMs: number;
  terminateMs: number;
  killMs: number;
}

export interface CleanupEvent {
  stage: "close" | "SIGTERM" | "SIGKILL" | "resource" | "profile";
  status:
    "queued" | "started" | "completed" | "failed" | "timed-out" | "cancelled";
  at: number;
  durationMs?: number;
  pid?: number;
  resourceIndex?: number;
  reason?:
    "operation-rejected" | "deadline" | "process-running" | "invalid-pid";
}

export interface PackagedCleanupReceipt {
  stopped: boolean;
  successful: boolean;
  events: CleanupEvent[];
}

const defaultTimeouts: ShutdownTimeouts = {
  gracefulMs: 3_000,
  terminateMs: 1_000,
  killMs: 1_000,
};
const cleanupTimeoutMs = 3_000;

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function attempt(
  receipt: PackagedCleanupReceipt,
  context: Pick<CleanupEvent, "stage" | "pid" | "resourceIndex">,
  action: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  for (const status of ["queued", "started"] as const)
    receipt.events.push({ ...context, status, at: startedAt });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      Promise.resolve()
        .then(action)
        .then(
          () => "completed" as const,
          () => "failed" as const,
        ),
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), timeoutMs);
      }),
    ]);
    receipt.events.push({
      ...context,
      status,
      at: Date.now(),
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(status === "failed" ? { reason: "operation-rejected" as const } : {}),
      ...(status === "timed-out" ? { reason: "deadline" as const } : {}),
    });
    if (status !== "completed") receipt.successful = false;
  } finally {
    clearTimeout(timer);
  }
}

async function shutdownAttempt(
  receipt: PackagedCleanupReceipt,
  child: ChildProcess,
  stage: "close" | "SIGTERM" | "SIGKILL",
  action: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let onExit = () => {};
  const exit = new Promise<void>((resolve) => {
    onExit = resolve;
    child.once("exit", onExit);
    if (exited(child)) resolve();
  });
  try {
    await attempt(
      receipt,
      { stage, ...(child.pid === undefined ? {} : { pid: child.pid }) },
      async () => {
        await action();
        if (!exited(child)) await exit;
      },
      timeoutMs,
    );
  } finally {
    child.removeListener("exit", onExit);
  }
}

export async function closeOwnedPackagedApplication(
  application: OwnedPackagedApplication,
  timeouts: ShutdownTimeouts = defaultTimeouts,
): Promise<PackagedCleanupReceipt> {
  const child = application.process();
  const receipt: PackagedCleanupReceipt = {
    stopped: false,
    successful: true,
    events: [],
  };
  await shutdownAttempt(
    receipt,
    child,
    "close",
    () => application.close(),
    timeouts.gracefulMs,
  );
  for (const [signal, timeoutMs] of [
    ["SIGTERM", timeouts.terminateMs],
    ["SIGKILL", timeouts.killMs],
  ] as const) {
    if (exited(child)) break;
    if (
      child.pid === undefined ||
      !Number.isSafeInteger(child.pid) ||
      child.pid <= 0 ||
      child.pid === process.pid
    ) {
      receipt.successful = false;
      receipt.events.push({
        stage: signal,
        status: "cancelled",
        at: Date.now(),
        reason: "invalid-pid",
      });
      break;
    }
    // Retain the launched ChildProcess: never discover by executable name or
    // signal a process group that might include an unrelated user process.
    await shutdownAttempt(
      receipt,
      child,
      signal,
      async () => {
        if (!exited(child) && !child.kill(signal))
          throw new Error("Owned child signal was not delivered");
      },
      timeoutMs,
    );
  }
  receipt.stopped = exited(child);
  if (!receipt.stopped) receipt.successful = false;
  return receipt;
}

export async function withPackagedFixtureCleanup<T>(options: {
  run(): Promise<T>;
  getApplication(): OwnedPackagedApplication | undefined;
  resources: readonly (() => Promise<void>)[];
  removeProfile(): Promise<void>;
  report(receipt: PackagedCleanupReceipt): Promise<void>;
  timeouts?: ShutdownTimeouts;
}): Promise<T> {
  let primaryFailed = false;
  let primary: unknown;
  let result!: T;
  try {
    result = await options.run();
  } catch (error) {
    primaryFailed = true;
    primary = error;
  }
  let receipt: PackagedCleanupReceipt;
  try {
    const application = options.getApplication();
    receipt =
      application === undefined
        ? { stopped: true, successful: true, events: [] }
        : await closeOwnedPackagedApplication(application, options.timeouts);
  } catch {
    receipt = {
      stopped: false,
      successful: false,
      events: [
        {
          stage: "close",
          status: "failed",
          at: Date.now(),
          reason: "operation-rejected",
        },
      ],
    };
  }
  for (const [resourceIndex, cleanup] of options.resources.entries())
    await attempt(
      receipt,
      { stage: "resource", resourceIndex },
      cleanup,
      cleanupTimeoutMs,
    );
  if (receipt.stopped) {
    await attempt(
      receipt,
      { stage: "profile" },
      () => options.removeProfile(),
      cleanupTimeoutMs,
    );
  } else {
    receipt.events.push({
      stage: "profile",
      status: "cancelled",
      at: Date.now(),
      reason: "process-running",
    });
  }
  try {
    await options.report(receipt);
  } catch {
    receipt.successful = false;
  }
  // A teardown or attachment error must not replace the original firstWindow
  // error; the bounded receipt separately records teardown failures.
  if (primaryFailed) throw primary;
  if (!receipt.successful)
    throw new Error(
      "Packaged fixture teardown failed; inspect its cleanup receipt",
    );
  return result;
}
