import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";
const logLevels = new Set<LogLevel>(["error", "warn", "info", "debug"]);

const logLevelPriority: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const maximumStringLength = 8_192;
const maximumArrayLength = 100;
const maximumObjectEntries = 100;
const maximumDepth = 12;
const truncated = "[TRUNCATED]";
const omittedBinary = "[OMITTED BINARY DATA]";

function isCredentialKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return [
    "token",
    "secret",
    "credential",
    "credentials",
    "authorization",
    "password",
    "passphrase",
    "apikey",
    "privatekey",
  ].some((suffix) => normalized.endsWith(suffix));
}

function reportLoggingFailure(error: unknown): void {
  try {
    process.stderr.write(
      `[desktop-logger] Failed to write log: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  } catch {
    // Logging failures must not re-enter the logger or crash the process.
  }
}

function sanitizeDiagnosticValue(
  value: unknown,
  key: string,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (isCredentialKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const redacted = value.replace(bearerToken, "******");
    return redacted.length <= maximumStringLength
      ? redacted
      : `${redacted.slice(0, maximumStringLength)}${truncated}`;
  }
  if (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return omittedBinary;
  }
  if (depth >= maximumDepth && value !== null && typeof value === "object") {
    return truncated;
  }
  if (Array.isArray(value)) {
    const values = value
      .slice(0, maximumArrayLength)
      .map((item) => sanitizeDiagnosticValue(item, "", depth + 1, ancestors));
    if (value.length > maximumArrayLength) values.push(truncated);
    return values;
  }
  if (value !== null && typeof value === "object") {
    if (ancestors.has(value)) return "[CIRCULAR]";
    ancestors.add(value);
    const entries = Object.entries(value);
    const sanitized = Object.fromEntries(
      entries
        .slice(0, maximumObjectEntries)
        .map(([childKey, child]) => [
          childKey,
          sanitizeDiagnosticValue(child, childKey, depth + 1, ancestors),
        ]),
    );
    if (entries.length > maximumObjectEntries) {
      sanitized.__truncated__ = `${entries.length - maximumObjectEntries} entries`;
    }
    ancestors.delete(value);
    return sanitized;
  }
  return value;
}

export function redactDiagnosticValue(value: unknown, key = ""): unknown {
  return sanitizeDiagnosticValue(value, key, 0, new WeakSet());
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  return logLevels.has(value as LogLevel) ? (value as LogLevel) : undefined;
}

export class DesktopFileLogger {
  private pendingWrite: Promise<void> = Promise.resolve();

  public constructor(
    private readonly path: string,
    private level: LogLevel = "info",
  ) {}

  public get filePath(): string {
    return this.path;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public async write(
    level: LogLevel,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    if (logLevelPriority[level] > logLevelPriority[this.level]) return;

    let line: string;
    try {
      line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: redactDiagnosticValue(message),
        context: redactDiagnosticValue(context),
      })}\n`;
    } catch (error) {
      reportLoggingFailure(error);
      return;
    }
    this.pendingWrite = this.pendingWrite.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        reportLoggingFailure(error);
      }
    });
    await this.pendingWrite;
  }

  public async prune(
    options: {
      readonly maximumBytes?: number;
      readonly maximumAgeDays?: number;
    } = {},
  ): Promise<void> {
    const maximumBytes = options.maximumBytes ?? 5 * 1024 * 1024;
    const maximumAgeDays = options.maximumAgeDays ?? 14;
    let details;
    try {
      details = await stat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const expired =
      Date.now() - details.mtimeMs > maximumAgeDays * 24 * 60 * 60 * 1000;
    if (expired) {
      await rm(this.path, { force: true });
      return;
    }
    if (details.size <= maximumBytes) return;
    const content = await readFile(this.path);
    const retained = content.subarray(
      Math.max(0, content.byteLength - Math.floor(maximumBytes / 2)),
    );
    const firstNewline = retained.indexOf(0x0a);
    await writeFile(
      this.path,
      firstNewline < 0 ? retained : retained.subarray(firstNewline + 1),
      { mode: 0o600 },
    );
  }
}

export async function exportSupportBundle(options: {
  readonly destination: string;
  readonly logsDirectory: string;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}): Promise<string> {
  const logs: Array<{ file: string; lines: unknown[] }> = [];
  try {
    for (const name of await readdir(options.logsDirectory)) {
      if (!name.endsWith(".log")) continue;
      const content = await readFile(join(options.logsDirectory, name), "utf8");
      logs.push({
        file: basename(name),
        lines: content
          .trim()
          .split("\n")
          .slice(-500)
          .filter(Boolean)
          .map((line) => {
            try {
              return redactDiagnosticValue(JSON.parse(line));
            } catch {
              return redactDiagnosticValue(line);
            }
          }),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(options.destination), { recursive: true });
  await writeFile(
    options.destination,
    `${JSON.stringify(
      {
        formatVersion: 1,
        generatedAt: new Date().toISOString(),
        diagnostics: redactDiagnosticValue(options.diagnostics),
        logs,
      },
      undefined,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return options.destination;
}
