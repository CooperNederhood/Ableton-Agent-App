import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sanitizeTraceValue } from "./scenario.js";

export class RunTraceWriter {
  #pending: string | undefined;
  #writing: Promise<void> | undefined;
  #failure: unknown;
  #failed = false;
  #sealed = false;

  constructor(private readonly path: string) {}

  checkpoint(payload: unknown): void {
    if (this.#failed || this.#sealed) return;
    this.#pending = `${JSON.stringify(sanitizeTraceValue(payload), undefined, 2)}\n`;
    if (Buffer.byteLength(this.#pending, "utf8") > 2 * 1024 * 1024) {
      this.#pending = undefined;
      this.#failed = true;
      this.#failure = new RangeError(
        "Run trace exceeds the 2 MiB evidence limit",
      );
      return;
    }
    this.#writing ??= this.#drain().catch((error: unknown) => {
      this.#failed = true;
      this.#failure = error;
    });
  }

  async flush(): Promise<void> {
    await this.#writing;
    if (this.#failed) throw this.#failure;
  }

  async write(payload: unknown): Promise<void> {
    this.checkpoint(payload);
    await this.flush();
  }

  async finish(payload: unknown): Promise<void> {
    this.checkpoint(payload);
    this.#sealed = true;
    await this.flush();
  }

  async #drain(): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      while (this.#pending !== undefined) {
        const pending = this.#pending;
        this.#pending = undefined;
        await writeFile(temporaryPath, pending, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, this.path);
      }
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (
          !(cleanupError instanceof Error) ||
          !("code" in cleanupError) ||
          cleanupError.code !== "ENOENT"
        ) {
          throw new AggregateError(
            [error, cleanupError],
            "Run trace write and temporary-file cleanup failed",
          );
        }
      }
      throw error;
    } finally {
      this.#writing = undefined;
    }
  }
}
