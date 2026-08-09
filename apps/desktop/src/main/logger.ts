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

const sensitiveKey =
  /token|secret|credential|authorization|prompt|content|notes?|track|device|file|path/iu;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const longSecret = /\b[A-Fa-f0-9]{32,}\b/gu;

export function redactDiagnosticValue(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(bearerToken, "Bearer [REDACTED]")
      .replace(longSecret, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactDiagnosticValue(child, childKey),
      ]),
    );
  }
  return value;
}

export class DesktopFileLogger {
  public constructor(private readonly path: string) {}

  public get filePath(): string {
    return this.path;
  }

  public async write(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(
      this.path,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: redactDiagnosticValue(message),
        context: redactDiagnosticValue(context),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
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
