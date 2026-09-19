import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import { sanitizePersistedText } from "@ableton-agent/observability";
import type { PlanArtifactSnapshot } from "@ableton-agent/shared";
import { resolveProductionSessionStorage } from "@ableton-agent/storage";

export const MAX_PLAN_ARTIFACT_CHARACTERS = 100_000;
export const MAX_PLAN_ARTIFACT_BYTES = 256 * 1024;

export class PlanArtifactConflictError extends Error {
  public readonly code = "plan_artifact_conflict";

  public constructor(message: string) {
    super(message);
    this.name = "PlanArtifactConflictError";
  }
}

export interface PlanArtifactWrite {
  readonly content: string;
  readonly expectedRevision?: string;
}

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function rejectSymbolicLink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(
        `Plan artifact path '${path}' must not be a symbolic link`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class FilePlanArtifactStore {
  readonly #writeTails = new Map<string, Promise<void>>();

  public constructor(private readonly sessionStateDirectory: string) {}

  public async read(
    productionSessionId: string,
  ): Promise<PlanArtifactSnapshot> {
    const paths = resolveProductionSessionStorage(
      this.sessionStateDirectory,
      productionSessionId,
    );
    await rejectSymbolicLink(paths.sessionDirectory);
    await rejectSymbolicLink(paths.artifactsDirectory);
    await rejectSymbolicLink(paths.planPath);
    try {
      const content = await readFile(paths.planPath, "utf8");
      const details = await stat(paths.planPath);
      const bytes = Buffer.byteLength(content, "utf8");
      if (
        content.length > MAX_PLAN_ARTIFACT_CHARACTERS ||
        bytes > MAX_PLAN_ARTIFACT_BYTES
      ) {
        throw new Error("Stored plan.md exceeds the supported size limit");
      }
      return {
        exists: true,
        productionSessionId,
        content,
        revision: revision(content),
        bytes,
        updatedAt: details.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, productionSessionId };
      }
      throw error;
    }
  }

  public write(
    productionSessionId: string,
    input: PlanArtifactWrite,
  ): Promise<PlanArtifactSnapshot> {
    const previous =
      this.#writeTails.get(productionSessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#writeTails.set(productionSessionId, tail);
    return previous
      .catch(() => undefined)
      .then(() => this.#writeNow(productionSessionId, input))
      .finally(() => {
        release();
        if (this.#writeTails.get(productionSessionId) === tail) {
          this.#writeTails.delete(productionSessionId);
        }
      });
  }

  async #writeNow(
    productionSessionId: string,
    input: PlanArtifactWrite,
  ): Promise<PlanArtifactSnapshot> {
    const normalized = input.content.replace(/\r\n?/gu, "\n");
    if (normalized.trim().length === 0) {
      throw new Error("plan.md must not be empty");
    }
    if (normalized.length > MAX_PLAN_ARTIFACT_CHARACTERS) {
      throw new Error(
        `plan.md exceeds ${MAX_PLAN_ARTIFACT_CHARACTERS} characters`,
      );
    }
    const content = sanitizePersistedText(normalized);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_PLAN_ARTIFACT_BYTES) {
      throw new Error(`plan.md exceeds ${MAX_PLAN_ARTIFACT_BYTES} bytes`);
    }

    const existing = await this.read(productionSessionId);
    if (existing.exists && input.expectedRevision === undefined) {
      throw new PlanArtifactConflictError(
        "An expected revision is required to replace the existing plan.md",
      );
    }
    if (
      input.expectedRevision !== undefined &&
      (!existing.exists || existing.revision !== input.expectedRevision)
    ) {
      throw new PlanArtifactConflictError(
        "plan.md changed after it was read; read the latest revision before writing",
      );
    }

    const paths = resolveProductionSessionStorage(
      this.sessionStateDirectory,
      productionSessionId,
    );
    await rejectSymbolicLink(paths.sessionDirectory);
    await rejectSymbolicLink(paths.artifactsDirectory);
    await mkdir(paths.artifactsDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.sessionDirectory, 0o700);
    await chmod(paths.artifactsDirectory, 0o700);
    await rejectSymbolicLink(paths.planPath);
    const temporaryPath = `${paths.planPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, paths.planPath);
      await chmod(paths.planPath, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return await this.read(productionSessionId);
  }
}
