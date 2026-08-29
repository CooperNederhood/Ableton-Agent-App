import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { DesktopSession } from "../contracts.js";

const projectSessionAssociationSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  sessionId: z.string().min(1),
  updatedAt: z.string().min(1),
});

const projectSessionManifestSchema = z.object({
  version: z.literal(1),
  associations: z.array(projectSessionAssociationSchema),
});

export type ProjectSessionAssociation = z.infer<
  typeof projectSessionAssociationSchema
>;

export interface ProjectSessionStore {
  load(
    sessions: readonly DesktopSession[],
  ): Promise<ProjectSessionAssociation[]>;
  save(associations: readonly ProjectSessionAssociation[]): Promise<void>;
}

function inferredAssociations(
  sessions: readonly DesktopSession[],
): ProjectSessionAssociation[] {
  const associations = new Map<string, ProjectSessionAssociation>();
  for (const session of sessions) {
    if (session.projectId === undefined) continue;
    const current = associations.get(session.projectId);
    if (
      current !== undefined &&
      Date.parse(current.updatedAt) >= Date.parse(session.updatedAt)
    ) {
      continue;
    }
    associations.set(session.projectId, {
      projectId: session.projectId,
      projectName: session.projectName,
      sessionId: session.id,
      updatedAt: session.updatedAt,
    });
  }
  return [...associations.values()];
}

export class JsonProjectSessionStore implements ProjectSessionStore {
  public constructor(private readonly path: string) {}

  public async load(
    sessions: readonly DesktopSession[],
  ): Promise<ProjectSessionAssociation[]> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const manifest = projectSessionManifestSchema.parse(stored);
      const sessionIds = new Set(sessions.map(({ id }) => id));
      return manifest.associations.filter(({ sessionId }) =>
        sessionIds.has(sessionId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Project session associations could not be loaded", {
          cause: error,
        });
      }
      const associations = inferredAssociations(sessions);
      if (associations.length > 0) await this.save(associations);
      return associations;
    }
  }

  public async save(
    associations: readonly ProjectSessionAssociation[],
  ): Promise<void> {
    const manifest = projectSessionManifestSchema.parse({
      version: 1,
      associations,
    });
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(manifest, undefined, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
