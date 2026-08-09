import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { preferencesSchema, type DesktopAppEvent } from "../contracts.js";
import {
  DemoDesktopService,
  JsonPreferencesStore,
  JsonSessionStore,
} from "./desktop-service.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ableton-desktop-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop service persistence and operation safety", () => {
  it("uses defaults only for a missing preference file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "preferences.json");
    const store = new JsonPreferencesStore(path);

    await expect(store.load()).resolves.toEqual(preferencesSchema.parse({}));
    await writeFile(path, "{not-json", "utf8");
    await expect(store.load()).rejects.toThrow(
      "Preferences could not be loaded",
    );
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  it("saves preferences atomically without leaving temporary files", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "preferences.json");
    const store = new JsonPreferencesStore(path);
    const preferences = preferencesSchema.parse({ model: "gpt-5.6" });

    await store.save(preferences);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(preferences);
    expect(await readdir(directory)).toEqual(["preferences.json"]);
  });

  it("rejects overlapping sends and reports unsupported demo recovery", async () => {
    const directory = await temporaryDirectory();
    const service = new DemoDesktopService(
      new JsonPreferencesStore(join(directory, "preferences.json")),
      new JsonSessionStore(join(directory, "sessions.json")),
    );
    const events: DesktopAppEvent[] = [];
    service.subscribe((event) => events.push(event));
    await service.start();

    await service.send("First", [], "explore");
    await expect(service.send("Second", [], "explore")).rejects.toThrow(
      "already in progress",
    );
    await expect(service.retryOperation("operation")).resolves.toBe(false);
    await expect(service.undoOperation("operation")).resolves.toBe(false);
    expect(await service.getLifecycleState()).toBe("degraded");

    await service.stop();
    expect(events.some((event) => event.type === "diagnostic")).toBe(true);
  });

  it("stores context and plan updates before reporting success", async () => {
    const directory = await temporaryDirectory();
    const service = new DemoDesktopService(
      new JsonPreferencesStore(join(directory, "preferences.json")),
      new JsonSessionStore(join(directory, "sessions.json")),
    );
    const messages: string[] = [];
    service.subscribe((event) => {
      if (event.type === "diagnostic") messages.push(event.message);
    });
    await service.start();

    await service.setContext([{ id: "track-1", kind: "track", label: "Bass" }]);
    await service.updatePlan([
      {
        id: "section-1",
        name: "Intro",
        startBar: 1,
        endBar: 8,
        tracks: ["track-1"],
        status: "proposed",
      },
    ]);

    expect(messages).toContain("Context updated with 1 selection(s).");
    expect(messages).toContain("Production plan saved with 1 section(s).");
    await service.stop();
  });

  it("persists sessions so cold-start deep links can resume them", async () => {
    const directory = await temporaryDirectory();
    const preferencesPath = join(directory, "preferences.json");
    const sessionsPath = join(directory, "sessions.json");
    const first = new DemoDesktopService(
      new JsonPreferencesStore(preferencesPath),
      new JsonSessionStore(sessionsPath),
    );
    await first.start();
    const sessionId = await first.createSession();
    await first.stop();

    const restarted = new DemoDesktopService(
      new JsonPreferencesStore(preferencesPath),
      new JsonSessionStore(sessionsPath),
    );
    await restarted.start();

    await expect(restarted.getSessions()).resolves.toEqual([
      expect.objectContaining({ id: sessionId }),
    ]);
    await expect(restarted.resumeSession(sessionId)).resolves.toBeUndefined();
    await restarted.stop();
  });

  it("serializes preference writes so the newest value persists", async () => {
    const directory = await temporaryDirectory();
    const preferenceStore = new JsonPreferencesStore(
      join(directory, "preferences.json"),
    );
    const sessionStore = new JsonSessionStore(join(directory, "sessions.json"));
    const service = new DemoDesktopService(preferenceStore, sessionStore);
    await service.start();
    const originalSave = preferenceStore.save.bind(preferenceStore);
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi
      .spyOn(preferenceStore, "save")
      .mockImplementationOnce(async (value) => {
        await firstPaused;
        await originalSave(value);
      })
      .mockImplementation((value) => originalSave(value));

    const first = service.setPreferences(
      preferencesSchema.parse({ model: "first" }),
    );
    const second = service.setPreferences(
      preferencesSchema.parse({ model: "second" }),
    );
    releaseFirst();
    await Promise.all([first, second]);

    expect(save.mock.calls.map(([value]) => value.model)).toEqual([
      "first",
      "second",
    ]);
    expect((await preferenceStore.load()).model).toBe("second");
    expect((await service.getPreferences()).model).toBe("second");
    await service.stop();
  });

  it("waits for queued preference writes before shutdown persistence", async () => {
    const directory = await temporaryDirectory();
    const preferenceStore = new JsonPreferencesStore(
      join(directory, "preferences.json"),
    );
    const service = new DemoDesktopService(
      preferenceStore,
      new JsonSessionStore(join(directory, "sessions.json")),
    );
    await service.start();
    const originalSave = preferenceStore.save.bind(preferenceStore);
    let releaseSave!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.spyOn(preferenceStore, "save").mockImplementationOnce(async (value) => {
      await paused;
      await originalSave(value);
    });

    const update = service.setPreferences(
      preferencesSchema.parse({ model: "latest" }),
    );
    const stop = service.stop();
    releaseSave();
    await Promise.all([update, stop]);

    expect((await preferenceStore.load()).model).toBe("latest");
  });
});
