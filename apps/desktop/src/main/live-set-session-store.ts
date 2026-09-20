import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { DesktopSession } from "../contracts.js";

const liveSetSessionAssociationSchema = z.object({
  liveSetId: z.string().min(1),
  liveSetName: z.string().min(1),
  sessionId: z.string().min(1),
  updatedAt: z.string().min(1),
});

const liveSetSessionManifestSchema = z
  .object({
    version: z.literal(1),
    associations: z.array(liveSetSessionAssociationSchema),
  })
  .superRefine(({ associations }, context) => {
    const seen = new Set<string>();
    for (const [index, association] of associations.entries()) {
      if (seen.has(association.liveSetId)) {
        context.addIssue({
          code: "custom",
          path: ["associations", index, "liveSetId"],
          message: "Each Live Set must have one canonical App session",
        });
      }
      seen.add(association.liveSetId);
    }
  });

export type LiveSetSessionAssociation = z.infer<
  typeof liveSetSessionAssociationSchema
>;

export interface LiveSetSessionStore {
  load(
    sessions: readonly DesktopSession[],
  ): Promise<LiveSetSessionAssociation[]>;
  save(associations: readonly LiveSetSessionAssociation[]): Promise<void>;
}

export class JsonLiveSetSessionStore implements LiveSetSessionStore {
  public constructor(private readonly path: string) {}

  public async load(
    sessions: readonly DesktopSession[],
  ): Promise<LiveSetSessionAssociation[]> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const manifest = liveSetSessionManifestSchema.parse(stored);
      const sessionIds = new Set(sessions.map(({ id }) => id));
      return manifest.associations.filter(({ sessionId }) =>
        sessionIds.has(sessionId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Live Set session associations could not be loaded", {
          cause: error,
        });
      }
      return [];
    }
  }

  public async save(
    associations: readonly LiveSetSessionAssociation[],
  ): Promise<void> {
    const manifest = liveSetSessionManifestSchema.parse({
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
