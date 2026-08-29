import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sessionSchema, type DesktopSession } from "../contracts.js";
import { JsonProjectSessionStore } from "./project-session-store.js";

const directories: string[] = [];

function session(
  id: string,
  projectId: string | undefined,
  updatedAt: string,
): DesktopSession {
  return sessionSchema.parse({
    version: 3,
    id,
    title: id,
    updatedAt,
    projectName: projectId ?? "Unsaved Live Set",
    ...(projectId === undefined ? {} : { projectId }),
    activeAgents: [],
    mode: "explore",
    productionPlan: [],
    outputAssignments: [],
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonProjectSessionStore", () => {
  it("migrates the newest saved session per project and ignores unsaved work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-sessions-"));
    directories.push(directory);
    const path = join(directory, "project-sessions.json");
    const store = new JsonProjectSessionStore(path);
    const sessions = [
      session("old", "project-1", "2026-01-01T00:00:00.000Z"),
      session("new", "project-1", "2026-01-02T00:00:00.000Z"),
      session("other", "project-2", "2026-01-01T00:00:00.000Z"),
      session("ephemeral", undefined, "2026-01-03T00:00:00.000Z"),
    ];

    await expect(store.load(sessions)).resolves.toEqual([
      expect.objectContaining({ projectId: "project-1", sessionId: "new" }),
      expect.objectContaining({ projectId: "project-2", sessionId: "other" }),
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  it("drops associations whose session record no longer exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-sessions-"));
    directories.push(directory);
    const store = new JsonProjectSessionStore(
      join(directory, "project-sessions.json"),
    );
    await store.save([
      {
        projectId: "project-1",
        projectName: "Set",
        sessionId: "missing",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await expect(store.load([])).resolves.toEqual([]);
  });
});
