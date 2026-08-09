import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class DesktopFileLogger {
  public constructor(private readonly path: string) {}

  public async write(
    level: "info" | "warn" | "error",
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(
      this.path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}
