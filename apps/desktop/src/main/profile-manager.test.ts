import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureLiveAgentStorage,
  resolveArtifactScopePaths,
  resolveLiveAgentStorage,
} from "@ableton-agent/storage";
import { desktopAgentCatalogSchema, sessionSchema } from "../contracts.js";

import { DesktopProfileManager } from "./profile-manager.js";

const roots: string[] = [];

async function fixture(
  options: {
    activeSessionId?: string;
    activeProfile?: string;
    switchFailure?: Error;
    closeFailure?: Error;
    refreshFailure?: Error;
    getActiveSessionId?: () => Promise<string | undefined>;
    getActiveSession?: () => Promise<
      ReturnType<typeof sessionSchema.parse> | undefined
    >;
  } = {},
) {
  const root = await mkdtemp(join(process.cwd(), ".test-profile-manager-"));
  roots.push(root);
  const bundledAgentsDirectory = join(root, "bundled", "agents");
  const bundledSkillsDirectory = join(root, "bundled", "skills");
  await mkdir(bundledAgentsDirectory, { recursive: true });
  await mkdir(join(bundledSkillsDirectory, "mix-review"), { recursive: true });
  await writeFile(
    join(bundledAgentsDirectory, "default.yaml"),
    [
      "version: 1",
      "name: default",
      "description: General agent.",
      "systemPrompt: Help with Ableton.",
      "tools:",
      '  - "*"',
      "editScope:",
      "  - session",
      "skills: []",
      "inputChannels: []",
    ].join("\n"),
  );
  await writeFile(
    join(bundledSkillsDirectory, "mix-review", "SKILL.md"),
    [
      "---",
      "name: mix-review",
      "description: Review the mix.",
      "---",
      "Review the current mix.",
    ].join("\n"),
  );
  const layout = resolveLiveAgentStorage({
    environment: { LIVE_AGENT_HOME: join(root, "live-agent") },
    ...(options.activeProfile === undefined
      ? {}
      : { profile: options.activeProfile }),
  });
  await ensureLiveAgentStorage(layout);
  if (options.activeSessionId !== undefined) {
    await writeFile(
      layout.sessionsPath,
      JSON.stringify([
        {
          version: 4,
          id: options.activeSessionId,
          title: "Production session",
          createdAt: "2026-09-19T00:00:00.000Z",
          updatedAt: "2026-09-19T00:00:00.000Z",
          liveSetId: "test-set",
          liveSetName: "Test Set",
          activeAgents: [],
          productionPlan: [],
          outputAssignments: [],
          liveEvents: [],
        },
      ]),
    );
  }
  const events: Array<{
    name: string;
    correlationId: string;
    causationId?: string;
    trace: { traceId: string };
    attributes: Readonly<Record<string, string | number | boolean>>;
  }> = [];
  let activeProfile = options.activeProfile ?? "default";
  let activeSessionId = options.activeSessionId;
  const closeActiveSession = vi.fn(async () => {
    if (options.closeFailure !== undefined) throw options.closeFailure;
    activeSessionId = undefined;
  });
  const switchProfile = vi.fn(async (profile: string) => {
    if (options.switchFailure !== undefined) throw options.switchFailure;
    activeProfile = profile;
  });
  const refreshActiveCatalog = vi.fn(async () => {
    if (options.refreshFailure !== undefined) throw options.refreshFailure;
    return desktopAgentCatalogSchema.parse({});
  });
  const persistActiveSession = vi.fn(async () => {
    if (activeSessionId === undefined) {
      throw new Error("No active production session");
    }
    const session = sessionSchema.parse({
      version: 4,
      id: activeSessionId,
      title: "Production session",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
      liveSetId: "test-set",
      liveSetName: "Test Set",
      activeAgents: [],
      productionPlan: [],
      outputAssignments: [],
      liveEvents: [],
    });
    await writeFile(layout.sessionsPath, JSON.stringify([session]));
    return session;
  });
  const manager = new DesktopProfileManager({
    rootLayout: layout,
    bundledAgentsDirectory,
    bundledSkillsDirectory,
    getActiveProfile: () => activeProfile,
    getActiveSessionId:
      options.getActiveSessionId ?? (() => Promise.resolve(activeSessionId)),
    getActiveSession:
      options.getActiveSession ??
      (() =>
        Promise.resolve(
          activeSessionId === undefined
            ? undefined
            : sessionSchema.parse({
                version: 4,
                id: activeSessionId,
                title: "Production session",
                createdAt: "2026-09-19T00:00:00.000Z",
                updatedAt: "2026-09-19T00:00:00.000Z",
                liveSetId: "test-set",
                liveSetName: "Test Set",
                activeAgents: [],
                productionPlan: [],
                outputAssignments: [],
                liveEvents: [],
              }),
        )),
    persistActiveSession,
    closeActiveSession,
    refreshActiveCatalog,
    switchProfile,
    ...(options.activeProfile === undefined
      ? {}
      : { environmentProfileOverride: options.activeProfile }),
    telemetry: (event) => events.push(event),
  });
  return {
    manager,
    events,
    switchProfile,
    closeActiveSession,
    refreshActiveCatalog,
    layout,
    persistActiveSession,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("DesktopProfileManager", () => {
  it("creates and edits Session skills while preserving published metadata", async () => {
    const { manager, layout } = await fixture({
      activeSessionId: "session-skills",
    });
    const initial = await manager.get();

    const created = await manager.createSkill({
      name: "session-groove",
      description: "Shape a session groove.",
      body: "# Groove\n\nUse syncopation.",
      expectedRevision: initial.revision,
    });

    expect(created.document).toMatchObject({
      name: "session-groove",
      description: "Shape a session groove.",
      body: "# Groove\n\nUse syncopation.",
      origin: "session",
    });
    expect(
      created.profileSnapshot.artifacts.find(
        ({ kind, name, scope }) =>
          kind === "skill" && name === "session-groove" && scope === "session",
      ),
    ).toBeDefined();

    const edited = await manager.saveSkill({
      name: "session-groove",
      body: "# Groove\n\nUse a straighter pulse.",
      expectedRevision: created.profileSnapshot.revision,
      expectedFingerprint: created.document.fingerprint,
    });

    expect(edited.document.description).toBe("Shape a session groove.");
    expect(edited.document.body).toContain("straighter pulse");
    expect(
      await readFile(
        join(
          resolveArtifactScopePaths(layout, "session", {
            liveSetId: "test-set",
            sessionId: "session-skills",
          }).skillsDirectory,
          "session-groove",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("description: Shape a session groove.");
  });

  it("copies an inherited skill into Session Scope when its body is saved", async () => {
    const { manager } = await fixture({ activeSessionId: "session-skills" });
    const initial = await manager.get();
    const inherited = await manager.readSkill({ name: "mix-review" });

    const saved = await manager.saveSkill({
      name: "mix-review",
      body: "Review the newly balanced mix.",
      expectedRevision: initial.revision,
      expectedFingerprint: inherited.fingerprint,
    });

    expect(saved.document).toMatchObject({
      name: "mix-review",
      description: "Review the mix.",
      body: "Review the newly balanced mix.",
      origin: "session",
    });
  });

  it("shows the System baseline without repeating it in lower scopes", async () => {
    const { manager, events } = await fixture({
      activeSessionId: "session-1",
    });
    const initial = await manager.get();

    expect(initial.activeProfile).toBe("default");
    expect(initial.profiles.map(({ name }) => name)).toEqual(["default"]);
    expect(
      initial.artifacts.map(({ scope, kind, name }) => ({
        scope,
        kind,
        name,
      })),
    ).toEqual([
      { scope: "system", kind: "agent", name: "default" },
      { scope: "system", kind: "skill", name: "mix-review" },
    ]);
    expect(initial.profiles[0]?.sessions).toMatchObject([
      {
        id: "session-1",
        title: "Test Set",
        active: true,
        persisted: true,
      },
    ]);

    const created = await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    expect(created.selectedProfile).toBe("ambient");
    expect(created.profiles.map(({ name }) => name)).toEqual([
      "default",
      "ambient",
    ]);
    expect(events.map(({ name }) => name)).toEqual([
      "profile.create.queued",
      "profile.create.started",
      "profile.create.progress",
      "profile.create.completed",
    ]);
  });

  it("copies a bundled artifact into profile scope and uses tombstones", async () => {
    const { manager } = await fixture({ activeSessionId: "session-1" });
    const initial = await manager.get();

    const copied = await manager.copyArtifact({
      kind: "skill",
      name: "mix-review",
      source: { scope: "bundled" },
      destination: { scope: "profile", profile: "default" },
      expectedRevision: initial.revision,
    });

    expect(copied.status).toBe("completed");
    if (copied.status !== "completed") throw new Error("Expected completion");
    expect(
      copied.snapshot.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "profile" && kind === "skill" && name === "mix-review",
      ),
    ).toMatchObject({ origin: "profile", state: "overridden" });

    const disabled = await manager.setArtifactDisabled({
      kind: "agent",
      name: "default",
      location: { scope: "profile", profile: "default" },
      disabled: true,
      expectedRevision: copied.snapshot.revision,
    });
    expect(
      disabled.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "profile" && kind === "agent" && name === "default",
      ),
    ).toMatchObject({ state: "disabled", origin: "bundled" });
  });

  it("moves skills and copies agents into an inactive persisted session", async () => {
    const { manager, layout, refreshActiveCatalog } = await fixture({
      activeSessionId: "session-active",
    });
    const sourceSession = sessionSchema.parse({
      version: 4,
      id: "session-source",
      title: "Older session",
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
      liveSetId: "older-set",
      liveSetName: "Older Set",
      activeAgents: [],
      productionPlan: [],
      outputAssignments: [],
      liveEvents: [],
    });
    const targetSession = sessionSchema.parse({
      version: 4,
      id: "session-target",
      title: "Target session",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
      liveSetId: "target-set",
      liveSetName: "Target Set",
      activeAgents: [],
      productionPlan: [],
      outputAssignments: [],
      liveEvents: [],
    });
    const activeSession = sessionSchema.parse({
      version: 4,
      id: "session-active",
      title: "Production session",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
      liveSetId: "current-set",
      liveSetName: "Current Set",
      activeAgents: [],
      productionPlan: [],
      outputAssignments: [],
      liveEvents: [],
    });
    await writeFile(
      layout.sessionsPath,
      JSON.stringify([activeSession, sourceSession, targetSession]),
    );
    const sourcePaths = resolveArtifactScopePaths(layout, "session", {
      liveSetId: sourceSession.liveSetId,
      sessionId: sourceSession.id,
    });
    await mkdir(join(sourcePaths.skillsDirectory, "interview-me"), {
      recursive: true,
    });
    await writeFile(
      join(sourcePaths.skillsDirectory, "interview-me", "SKILL.md"),
      [
        "---",
        "name: interview-me",
        "description: Interview the user.",
        "---",
        "Ask focused questions.",
      ].join("\n"),
    );
    const initial = await manager.get();

    const moved = await manager.moveArtifact({
      kind: "skill",
      name: "interview-me",
      source: {
        scope: "session",
        profile: "default",
        sessionId: sourceSession.id,
      },
      destination: {
        scope: "session",
        profile: "default",
        sessionId: targetSession.id,
      },
      expectedRevision: initial.revision,
    });

    expect(moved.status).toBe("completed");
    if (moved.status !== "completed") throw new Error("Expected completion");
    expect(
      moved.snapshot.artifacts.find(
        ({ scope, kind, name, sessionId }) =>
          scope === "session" &&
          kind === "skill" &&
          name === "interview-me" &&
          sessionId === targetSession.id,
      ),
    ).toMatchObject({ origin: "session" });
    expect(
      moved.snapshot.artifacts.some(
        ({ scope, kind, name, sessionId }) =>
          scope === "session" &&
          kind === "skill" &&
          name === "interview-me" &&
          sessionId === sourceSession.id,
      ),
    ).toBe(false);

    const copiedAgent = await manager.copyArtifact({
      kind: "agent",
      name: "default",
      source: { scope: "bundled" },
      destination: {
        scope: "session",
        profile: "default",
        sessionId: targetSession.id,
      },
      expectedRevision: moved.snapshot.revision,
    });
    expect(copiedAgent.status).toBe("completed");
    if (copiedAgent.status !== "completed") {
      throw new Error("Expected completion");
    }
    expect(
      copiedAgent.snapshot.artifacts.find(
        ({ scope, kind, name, sessionId }) =>
          scope === "session" &&
          kind === "agent" &&
          name === "default" &&
          sessionId === targetSession.id,
      ),
    ).toMatchObject({ origin: "session" });
    expect(refreshActiveCatalog).not.toHaveBeenCalled();
  });

  it("groups App sessions by Project and Live Set and publishes Project artifacts", async () => {
    const activeProjectSession = sessionSchema.parse({
      version: 4,
      id: "session-1",
      title: "First conversation",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-20T00:00:00.000Z",
      liveSetId: "live-set-1",
      liveSetName: "Writing",
      liveProjectId: "live-project-1",
      liveProjectName: "Album",
      activeAgents: [],
      productionPlan: [],
      outputAssignments: [],
      liveEvents: [],
    });
    const { manager, layout, refreshActiveCatalog } = await fixture({
      activeSessionId: "session-1",
      getActiveSession: () => Promise.resolve(activeProjectSession),
    });
    const sessions = [
      activeProjectSession,
      sessionSchema.parse({
        version: 4,
        id: "session-2",
        title: "Second conversation",
        createdAt: "2026-09-18T00:00:00.000Z",
        updatedAt: "2026-09-18T00:00:00.000Z",
        liveSetId: "live-set-1",
        liveSetName: "Writing",
        liveProjectId: "live-project-1",
        liveProjectName: "Album",
        activeAgents: [],
        productionPlan: [],
        outputAssignments: [],
        liveEvents: [],
      }),
    ];
    await writeFile(layout.sessionsPath, JSON.stringify(sessions));
    await mkdir(join(layout.liveSetSessionsPath, ".."), { recursive: true });
    await writeFile(
      layout.liveSetSessionsPath,
      JSON.stringify({
        version: 1,
        associations: [
          {
            liveSetId: "live-set-1",
            liveSetName: "Writing",
            sessionId: "session-2",
            updatedAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      }),
    );

    const initial = await manager.get();
    const project = initial.profiles[0]?.liveProjects[0];
    expect(project).toMatchObject({
      id: "live-project-1",
      name: "Album",
      active: true,
    });
    expect(project?.liveSets[0]?.sessions).toMatchObject([
      { id: "session-1", title: "Writing-1", canonical: false },
      { id: "session-2", title: "Writing-2", canonical: true },
    ]);

    const copied = await manager.copyArtifact({
      kind: "skill",
      name: "mix-review",
      source: { scope: "bundled" },
      destination: {
        scope: "project",
        profile: "default",
        liveProjectId: "live-project-1",
      },
      expectedRevision: initial.revision,
    });

    expect(copied.status).toBe("completed");
    if (copied.status !== "completed") throw new Error("Expected completion");
    expect(
      copied.snapshot.artifacts.find(
        ({ scope, kind, name, liveProjectId }) =>
          scope === "project" &&
          kind === "skill" &&
          name === "mix-review" &&
          liveProjectId === "live-project-1",
      ),
    ).toMatchObject({ origin: "project", state: "overridden" });
    expect(refreshActiveCatalog).toHaveBeenCalledOnce();
  });

  it("shows and promotes an active ephemeral session on first transfer", async () => {
    const {
      manager,
      layout,
      persistActiveSession,
      refreshActiveCatalog,
      events,
    } = await fixture({
      activeSessionId: "session-ephemeral",
    });
    await rm(layout.sessionsPath);
    const initial = await manager.get();

    expect(initial.profiles[0]?.sessions).toMatchObject([
      {
        id: "session-ephemeral",
        title: "Test Set",
        active: true,
        persisted: false,
      },
    ]);

    const copied = await manager.copyArtifact({
      kind: "skill",
      name: "mix-review",
      source: { scope: "bundled" },
      destination: {
        scope: "session",
        profile: "default",
        sessionId: "session-ephemeral",
      },
      expectedRevision: initial.revision,
    });

    expect(copied.status).toBe("completed");
    if (copied.status !== "completed") throw new Error("Expected completion");
    expect(persistActiveSession).toHaveBeenCalledOnce();
    expect(refreshActiveCatalog).toHaveBeenCalledOnce();
    expect(
      events
        .filter(({ name }) => name === "profile.artifact-copy.progress")
        .map(({ attributes }) => attributes.phase),
    ).toEqual(["validating", "persisting-active-session"]);
    expect(copied.snapshot.profiles[0]?.sessions[0]).toMatchObject({
      id: "session-ephemeral",
      active: true,
      persisted: true,
    });
    expect(
      copied.snapshot.artifacts.find(
        ({ scope, kind, name, sessionId }) =>
          scope === "session" &&
          kind === "skill" &&
          name === "mix-review" &&
          sessionId === "session-ephemeral",
      ),
    ).toMatchObject({ origin: "session" });
  });

  it("rejects transfers into sessions that are not listed", async () => {
    const { manager } = await fixture({ activeSessionId: "session-active" });
    const initial = await manager.get();

    await expect(
      manager.copyArtifact({
        kind: "skill",
        name: "mix-review",
        source: { scope: "bundled" },
        destination: {
          scope: "session",
          profile: "default",
          sessionId: "session-missing",
        },
        expectedRevision: initial.revision,
      }),
    ).rejects.toThrow("not a listed session");
  });

  it("saves a same-name Session-scope definition and refreshes both views", async () => {
    const { manager, events, refreshActiveCatalog, layout } = await fixture({
      activeSessionId: "session-1",
    });
    const initial = await manager.get();
    const inherited = initial.artifacts.find(
      ({ kind, name }) => kind === "agent" && name === "default",
    )!;

    const result = await manager.saveAgentDefinition({
      definition: {
        version: 2,
        name: "default",
        label: "Session default",
        description: "Session-specific agent.",
        systemPrompt: "Help with this session.",
        tools: ["*"],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
        model: null,
        reasoningEffort: null,
        autoApprove: true,
        eventListeners: [],
      },
      expectedRevision: initial.revision,
      expectedFingerprint: inherited.fingerprint!,
    });

    expect(refreshActiveCatalog).toHaveBeenCalledOnce();
    expect(
      result.profileSnapshot.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "session" && kind === "agent" && name === "default",
      ),
    ).toMatchObject({
      origin: "session",
      state: "overridden",
      sessionId: "session-1",
    });
    const sessionPaths = resolveArtifactScopePaths(layout, "session", {
      liveSetId: "test-set",
      sessionId: "session-1",
    });
    expect(
      await readFile(
        join(sessionPaths.agentsDirectory, "default.yaml"),
        "utf8",
      ),
    ).toContain("version: 2");
    expect(events.map(({ name }) => name)).toEqual([
      "profile.artifact-save-definition.queued",
      "profile.artifact-save-definition.started",
      "profile.artifact-save-definition.progress",
      "profile.artifact-save-definition.completed",
    ]);
    expect(new Set(events.map(({ correlationId }) => correlationId)).size).toBe(
      1,
    );
    expect(new Set(events.map(({ trace }) => trace.traceId)).size).toBe(1);
    expect(
      events.slice(1).every(({ causationId }) => causationId !== undefined),
    ).toBe(true);
  });

  it("persists an ephemeral active session before saving its definition", async () => {
    const { manager, layout, persistActiveSession } = await fixture({
      activeSessionId: "session-1",
    });
    await rm(layout.sessionsPath);
    const initial = await manager.get();
    expect(initial.profiles[0]?.sessions[0]).toMatchObject({
      id: "session-1",
      active: true,
      persisted: false,
    });
    const inherited = initial.artifacts.find(
      ({ kind, name }) => kind === "agent" && name === "default",
    )!;

    const result = await manager.saveAgentDefinition({
      definition: {
        version: 2,
        name: "default",
        label: "Persisted session default",
        description: "Saved from an unsaved Live Set.",
        systemPrompt: "Help with this session.",
        tools: ["*"],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
        model: null,
        reasoningEffort: null,
        autoApprove: false,
        eventListeners: [],
      },
      expectedRevision: initial.revision,
      expectedFingerprint: inherited.fingerprint!,
    });

    expect(persistActiveSession).toHaveBeenCalledOnce();
    expect(
      result.profileSnapshot.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "session" && kind === "agent" && name === "default",
      ),
    ).toMatchObject({ origin: "session", sessionId: "session-1" });
  });

  it("moves a Session agent whose skills are inherited from an upstream scope", async () => {
    const { manager } = await fixture({
      activeSessionId: "session-1",
    });
    const initial = await manager.get();
    const inherited = initial.artifacts.find(
      ({ kind, name }) => kind === "agent" && name === "default",
    )!;
    const saved = await manager.saveAgentDefinition({
      definition: {
        version: 2,
        name: "default",
        label: "Session default",
        description: "Uses an inherited skill.",
        systemPrompt: "Help with this session.",
        tools: ["*"],
        editScope: ["session"],
        skills: ["mix-review"],
        inputChannels: [],
        model: null,
        reasoningEffort: null,
        autoApprove: false,
        eventListeners: [],
      },
      expectedRevision: initial.revision,
      expectedFingerprint: inherited.fingerprint!,
    });

    const moved = await manager.moveArtifact({
      kind: "agent",
      name: "default",
      source: {
        scope: "session",
        profile: "default",
        sessionId: "session-1",
      },
      destination: { scope: "profile", profile: "default" },
      expectedRevision: saved.profileSnapshot.revision,
    });

    expect(moved.status).toBe("completed");
    if (moved.status !== "completed") throw new Error("Expected completion");
    expect(
      moved.snapshot.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "profile" && kind === "agent" && name === "default",
      ),
    ).toMatchObject({ origin: "profile" });
  });

  it("saves definitions for an environment-selected reserved profile", async () => {
    const { manager } = await fixture({
      activeProfile: "development",
      activeSessionId: "session-1",
    });
    const initial = await manager.get("development");
    const inherited = initial.artifacts.find(
      ({ kind, name }) => kind === "agent" && name === "default",
    )!;

    const result = await manager.saveAgentDefinition({
      definition: {
        version: 2,
        name: "default",
        label: "Development default",
        description: "Development session agent.",
        systemPrompt: "Help with this development session.",
        tools: ["*"],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
        model: null,
        reasoningEffort: null,
        autoApprove: false,
        eventListeners: [],
      },
      expectedRevision: initial.revision,
      expectedFingerprint: inherited.fingerprint!,
    });

    expect(result.profileSnapshot).toMatchObject({
      selectedProfile: "development",
      activeProfile: "development",
      activeSessionId: "session-1",
    });
    expect(
      result.profileSnapshot.artifacts.find(
        ({ scope, kind, name }) =>
          scope === "session" && kind === "agent" && name === "default",
      ),
    ).toMatchObject({ origin: "session", sessionId: "session-1" });
  });

  it("rejects stale and unknown-listener definition edits", async () => {
    const { manager, events } = await fixture({
      activeSessionId: "session-1",
    });
    const initial = await manager.get();
    const definition = {
      version: 2 as const,
      name: "default",
      label: "Session default",
      description: "Session-specific agent.",
      systemPrompt: "Help with this session.",
      tools: ["*"],
      editScope: ["session"] as "session"[],
      skills: [],
      inputChannels: [],
      model: null,
      reasoningEffort: null,
      autoApprove: false,
      eventListeners: [],
    };

    await expect(
      manager.saveAgentDefinition({
        definition,
        expectedRevision: "c".repeat(64),
        expectedFingerprint: initial.artifacts.find(
          ({ kind, name }) => kind === "agent" && name === "default",
        )!.fingerprint!,
      }),
    ).rejects.toThrow("Profile Manager changed");
    expect(events.at(-1)?.name).toBe(
      "profile.artifact-save-definition.cancelled",
    );

    const afterRevisionConflict = await manager.get();
    await expect(
      manager.saveAgentDefinition({
        definition,
        expectedRevision: afterRevisionConflict.revision,
        expectedFingerprint: "f".repeat(64),
      }),
    ).rejects.toThrow("changed; refresh");
    expect(events.at(-1)?.name).toBe(
      "profile.artifact-save-definition.cancelled",
    );

    const refreshed = await manager.get();
    await expect(
      manager.saveAgentDefinition({
        definition: {
          ...definition,
          eventListeners: [
            {
              id: "event-listener.00000000-0000-4000-8000-000000000001",
              eventId: "live-event.00000000-0000-4000-8000-000000000002",
              enabled: true,
              responseMode: "automatic",
            },
          ],
        },
        expectedRevision: refreshed.revision,
        expectedFingerprint: refreshed.artifacts.find(
          ({ kind, name }) => kind === "agent" && name === "default",
        )!.fingerprint!,
      }),
    ).rejects.toThrow("unknown events");
    expect(events.at(-1)?.name).toBe("profile.artifact-save-definition.failed");
  });

  it("rolls back the Session-scope artifact when catalog refresh fails", async () => {
    const { manager, layout } = await fixture({
      activeSessionId: "session-1",
      refreshFailure: new Error("refresh failed"),
    });
    const initial = await manager.get();
    const inherited = initial.artifacts.find(
      ({ kind, name }) => kind === "agent" && name === "default",
    )!;

    await expect(
      manager.saveAgentDefinition({
        definition: {
          version: 2,
          name: "default",
          label: "Session default",
          description: "Session-specific agent.",
          systemPrompt: "Help with this session.",
          tools: ["*"],
          editScope: ["session"],
          skills: [],
          inputChannels: [],
          model: null,
          reasoningEffort: null,
          autoApprove: false,
          eventListeners: [],
        },
        expectedRevision: initial.revision,
        expectedFingerprint: inherited.fingerprint!,
      }),
    ).rejects.toThrow("refresh failed");

    const sessionPaths = resolveArtifactScopePaths(layout, "session", {
      liveSetId: "test-set",
      sessionId: "session-1",
    });
    await expect(
      readFile(join(sessionPaths.agentsDirectory, "default.yaml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires confirmation before closing an active session to switch", async () => {
    const { manager } = await fixture({ activeSessionId: "session-1" });
    const initial = await manager.get();
    await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await expect(
      manager.switch({
        name: "ambient",
        expectedRevision: (await manager.status()).revision,
        closeActiveSession: false,
      }),
    ).rejects.toThrow("Confirm closing the active production session");
  });

  it("reports profile status without loading artifact details", async () => {
    const { manager } = await fixture({ activeSessionId: "session-1" });

    await expect(manager.status()).resolves.toMatchObject({
      activeProfile: "default",
      activeSessionId: "session-1",
      profiles: [{ name: "default", active: true, reserved: false }],
    });
  });

  it("closes the active session when confirmed and switches profiles", async () => {
    const { manager, switchProfile, closeActiveSession } = await fixture({
      activeSessionId: "session-1",
    });
    const initial = await manager.get();
    await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await manager.switch({
      name: "ambient",
      expectedRevision: (await manager.status()).revision,
      closeActiveSession: true,
    });

    expect(closeActiveSession).toHaveBeenCalledTimes(1);
    expect(switchProfile).toHaveBeenCalledWith("ambient");
    expect((await manager.get()).activeProfile).toBe("ambient");
  });

  it("rolls back profile selection when composition switching fails", async () => {
    const { manager } = await fixture({
      switchFailure: new Error("replacement failed"),
    });
    const initial = await manager.get();
    await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await expect(
      manager.switch({
        name: "ambient",
        expectedRevision: (await manager.status()).revision,
        closeActiveSession: false,
      }),
    ).rejects.toThrow("replacement failed");

    expect((await manager.get()).selectedProfile).toBe("default");
  });

  it("does not switch when the confirmed session close fails", async () => {
    const { manager, switchProfile } = await fixture({
      activeSessionId: "session-1",
      closeFailure: new Error("session busy"),
    });
    const initial = await manager.get();
    await manager.create({
      name: "ambient",
      expectedRevision: initial.revision,
    });

    await expect(
      manager.switch({
        name: "ambient",
        expectedRevision: (await manager.status()).revision,
        closeActiveSession: true,
      }),
    ).rejects.toThrow("session busy");
    expect(switchProfile).not.toHaveBeenCalled();
  });
});
