import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sessionSchema, type DesktopSession } from "../contracts.js";
import { JsonLiveSetSessionStore } from "./live-set-session-store.js";

const directories: string[] = [];

function session(
  id: string,
  liveSetId: string,
  updatedAt: string,
): DesktopSession {
  return sessionSchema.parse({
    version: 4,
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    liveSetId,
    liveSetName: liveSetId,
    activeAgents: [],
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

describe("JsonLiveSetSessionStore", () => {
  it("does not infer canonical associations from session history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-set-sessions-"));
    directories.push(directory);
    const path = join(directory, "live-set-sessions.json");
    const store = new JsonLiveSetSessionStore(path);
    const sessions = [
      session("old", "project-1", "2026-01-01T00:00:00.000Z"),
      session("new", "project-1", "2026-01-02T00:00:00.000Z"),
      session("other", "project-2", "2026-01-01T00:00:00.000Z"),
    ];

    await expect(store.load(sessions)).resolves.toEqual([]);
  });

  it("persists canonical associations and drops missing sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-set-sessions-"));
    directories.push(directory);
    const store = new JsonLiveSetSessionStore(
      join(directory, "live-set-sessions.json"),
    );
    await store.save([
      {
        liveSetId: "project-1",
        liveSetName: "Set",
        sessionId: "current",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        liveSetId: "project-2",
        liveSetName: "Missing",
        sessionId: "missing",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await expect(
      store.load([session("current", "project-1", "2026-01-01T00:00:00.000Z")]),
    ).resolves.toEqual([
      expect.objectContaining({ liveSetId: "project-1", sessionId: "current" }),
    ]);
    expect(
      JSON.parse(
        await readFile(join(directory, "live-set-sessions.json"), "utf8"),
      ),
    ).toMatchObject({ version: 1 });
  });

  it("rejects multiple canonical associations for one Live Set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-set-sessions-"));
    directories.push(directory);
    const store = new JsonLiveSetSessionStore(
      join(directory, "live-set-sessions.json"),
    );

    await expect(
      store.save([
        {
          liveSetId: "set-1",
          liveSetName: "Set",
          sessionId: "first",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          liveSetId: "set-1",
          liveSetName: "Set",
          sessionId: "second",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ]),
    ).rejects.toThrow("one canonical App session");
  });
});
