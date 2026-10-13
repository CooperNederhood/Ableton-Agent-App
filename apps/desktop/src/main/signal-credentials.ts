import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  sanitizeTelemetryAttributes,
  type NonBlockingObservabilityRecorder,
} from "@ableton-agent/observability";
import { recordSignalTelemetry } from "@ableton-agent/signal-routing";

export const signalDirectory = join(homedir(), ".ableton-agent");
export const signalDescriptorPath = join(
  signalDirectory,
  "signal-ingress.json",
);
export const signalSecretPath = join(signalDirectory, "signal-ingress.secret");

interface SignalSecretPaths {
  readonly directory: string;
  readonly secretPath: string;
}

export async function publishSignalSecrets(
  secret: string,
  options: {
    readonly canonical: SignalSecretPaths;
    readonly legacy?: SignalSecretPaths;
    readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
    readonly signal?: AbortSignal;
  },
): Promise<() => Promise<void>> {
  const traceId = randomUUID();
  const spanId = randomUUID();
  const startedAt = Date.now();
  const cleanups: (() => Promise<void>)[] = [];
  const record = (
    stage:
      "queued" | "started" | "progress" | "completed" | "failed" | "cancelled",
    operation: "publish" | "cleanup" = "publish",
    operationStartedAt = startedAt,
    processedCount = 0,
  ) =>
    recordSignalTelemetry(options.telemetry, {
      name: `signal.credentials.${operation}.${stage}`,
      source: "desktop-signal-credentials",
      trace: { traceId, spanId },
      correlationId: traceId,
      causationId: traceId,
      durationMs: Date.now() - operationStartedAt,
      ...(stage === "completed" ? { outcome: "success" as const } : {}),
      ...(stage === "failed"
        ? { outcome: "failure" as const, level: "error" as const }
        : {}),
      ...(stage === "cancelled" ? { outcome: "cancelled" as const } : {}),
      attributes: sanitizeTelemetryAttributes({
        canonicalPath: options.canonical.secretPath,
        legacyEnabled: options.legacy !== undefined,
        publishedCount: cleanups.length,
        processedCount,
      }),
    });
  const cleanup = async () => {
    const cleanupStartedAt = Date.now();
    let processedCount = 0;
    record("queued", "cleanup", cleanupStartedAt);
    record("started", "cleanup", cleanupStartedAt);
    const results = await Promise.allSettled(
      cleanups.map(async (remove) => {
        await remove();
        processedCount += 1;
        record("progress", "cleanup", cleanupStartedAt, processedCount);
      }),
    );
    const errors: unknown[] = [];
    for (const result of results)
      if (result.status === "rejected") {
        const error: unknown = result.reason;
        errors.push(error);
      }
    if (errors.length > 0) {
      record("failed", "cleanup", cleanupStartedAt, processedCount);
      throw new AggregateError(errors, "Signal credential cleanup failed");
    }
    record("completed", "cleanup", cleanupStartedAt, processedCount);
  };
  record("queued");
  record("started");
  try {
    for (const paths of [
      options.canonical,
      ...(options.legacy === undefined ? [] : [options.legacy]),
    ]) {
      options.signal?.throwIfAborted();
      cleanups.push(await writeSignalSecret(secret, paths));
      record("progress");
    }
    options.signal?.throwIfAborted();
    record("completed");
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      record("failed");
      throw new AggregateError(
        [error, cleanupError],
        "Signal credential publication and cleanup failed",
      );
    }
    record(options.signal?.aborted === true ? "cancelled" : "failed");
    throw error;
  }
}

export async function writeSignalSecret(
  secret: string,
  paths: SignalSecretPaths = {
    directory: signalDirectory,
    secretPath: signalSecretPath,
  },
): Promise<() => Promise<void>> {
  if (secret.length < 32 || secret.length > 4096) {
    throw new Error("Signal ingress secret must contain 32 to 4096 characters");
  }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const temporaryPath = `${paths.secretPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${secret}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, paths.secretPath);
    await chmod(paths.secretPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return async () => {
    try {
      if ((await readFile(paths.secretPath, "utf8")) === `${secret}\n`) {
        await rm(paths.secretPath);
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  };
}
