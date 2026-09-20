import { describe, expect, it, vi } from "vitest";

import { createDesktopApi, type PreloadTransport } from "./api.js";

describe("preload API", () => {
  it("exposes named domains without a generic invoke or Node primitive", () => {
    const api = createDesktopApi(transportFor({}));
    expect(Object.keys(api)).toEqual([
      "lifecycle",
      "agent",
      "agents",
      "skills",
      "profiles",
      "ableton",
      "approvals",
      "diagnostics",
      "preferences",
      "project",
      "liveSet",
      "plan",
      "operations",
      "outputs",
      "events",
      "eventHistory",
    ]);
    expect("invoke" in api).toBe(false);
    expect("require" in api).toBe(false);
  });

  it("validates responses and filters malformed events", async () => {
    const listeners: Array<(event: never, value: unknown) => void> = [];
    const transport = transportFor(
      {
        "ableton:status": {
          state: "connected",
          liveVersion: "12",
          remoteScriptVersion: "1",
          liveSetId: "p",
          liveSetName: "Test Set",
          saved: true,
        },
      },
      listeners,
    );
    const api = createDesktopApi(transport);
    await expect(api.ableton.getStatus()).resolves.toMatchObject({
      state: "connected",
    });
    const handler = vi.fn();
    api.events.subscribe(handler);
    listeners[0]?.({} as never, { type: "node.execute", command: "bad" });
    listeners[0]?.({} as never, {
      type: "diagnostic",
      level: "info",
      message: "ok",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed main-process responses", async () => {
    const api = createDesktopApi(
      transportFor({ "ableton:status": { state: "connected" } }),
    );
    await expect(api.ableton.getStatus()).rejects.toThrow();
  });

  it("closes the active production session through typed IPC", async () => {
    const transport = transportFor({
      "agent:close-session": { closed: true },
    });
    const api = createDesktopApi(transport);

    await api.agent.closeSession();

    expect(vi.mocked(transport).invoke).toHaveBeenCalledWith(
      "agent:close-session",
      {},
    );
  });

  it("saves a complete agent definition with optimistic concurrency", async () => {
    const revision = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const definition = {
      version: 2 as const,
      name: "default",
      label: "Default",
      description: "General agent.",
      systemPrompt: "Help with Ableton.",
      tools: ["*"],
      editScope: ["session"] as "session"[],
      skills: [],
      inputChannels: [],
      model: null,
      reasoningEffort: null,
      autoApprove: false,
      eventListeners: [],
    };
    const profileSnapshot = {
      revision,
      activeProfile: "default",
      selectedProfile: "default",
      profiles: [],
      artifacts: [],
    };
    const transport = transportFor({
      "agents:save-definition": {
        catalog: { revision, definitions: [], skills: [], diagnostics: [] },
        profileSnapshot,
      },
    });
    const api = createDesktopApi(transport);

    await api.agents.saveDefinition(definition, revision, fingerprint);

    expect(vi.mocked(transport).invoke).toHaveBeenCalledWith(
      "agents:save-definition",
      {
        definition,
        expectedRevision: revision,
        expectedFingerprint: fingerprint,
      },
    );
  });

  it("exposes typed skill document operations", async () => {
    const revision = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const document = {
      name: "mix-review",
      description: "Review the mix.",
      body: "# Mix review",
      origin: "session" as const,
      fingerprint,
    };
    const profileSnapshot = {
      revision,
      activeProfile: "default",
      selectedProfile: "default",
      profiles: [],
      artifacts: [],
    };
    const result = {
      document,
      catalog: { revision, definitions: [], skills: [], diagnostics: [] },
      profileSnapshot,
    };
    const transport = transportFor({
      "skills:read": document,
      "skills:create": result,
      "skills:save": result,
    });
    const api = createDesktopApi(transport);

    await api.skills.read("mix-review");
    await api.skills.create(
      "session-groove",
      "Shape a groove.",
      "# Groove",
      revision,
    );
    await api.skills.save("mix-review", "# Updated", revision, fingerprint);

    expect(vi.mocked(transport).invoke).toHaveBeenCalledWith("skills:read", {
      name: "mix-review",
    });
    expect(vi.mocked(transport).invoke).toHaveBeenCalledWith("skills:create", {
      name: "session-groove",
      description: "Shape a groove.",
      body: "# Groove",
      expectedRevision: revision,
    });
    expect(vi.mocked(transport).invoke).toHaveBeenCalledWith("skills:save", {
      name: "mix-review",
      body: "# Updated",
      expectedRevision: revision,
      expectedFingerprint: fingerprint,
    });
  });

  it("exposes typed profile and artifact operations", async () => {
    const revision = "a".repeat(64);
    const snapshot = {
      revision,
      activeProfile: "default",
      selectedProfile: "ambient",
      profiles: [
        {
          name: "default",
          active: true,
          reserved: false,
          sessionCount: 1,
          liveProjects: [],
          unassignedLiveSets: [],
          sessions: [
            {
              id: "session-1",
              title: "Untitled",
              active: true,
              liveSetId: "set-1",
              liveSetName: "Untitled",
              createdAt: "2026-09-20T12:00:00.000Z",
            },
          ],
        },
        {
          name: "ambient",
          active: false,
          reserved: false,
          sessionCount: 0,
          liveProjects: [],
          unassignedLiveSets: [],
          sessions: [],
        },
      ],
      artifacts: [],
    };
    const transport = transportFor({
      "profiles:get": snapshot,
      "profiles:status": {
        revision,
        activeProfile: "default",
        activeSessionId: "session-1",
        profiles: [
          { name: "default", active: true, reserved: false },
          { name: "ambient", active: false, reserved: false },
        ],
      },
      "profiles:create": snapshot,
      "profiles:switch": { switching: true },
      "profiles:copy-artifact": {
        status: "completed",
        snapshot,
      },
    });
    const api = createDesktopApi(transport);

    await api.profiles.get("ambient");
    await api.profiles.status();
    await api.profiles.create("ambient", revision);
    await api.profiles.switch("ambient", revision, true);
    await api.profiles.copyArtifact({
      kind: "skill",
      name: "mix-review",
      source: { scope: "bundled" },
      destination: { scope: "profile", profile: "ambient" },
      expectedRevision: revision,
    });

    expect(vi.mocked(transport).invoke.mock.calls).toEqual([
      ["profiles:get", { selectedProfile: "ambient" }],
      ["profiles:status", {}],
      ["profiles:create", { name: "ambient", expectedRevision: revision }],
      [
        "profiles:switch",
        {
          name: "ambient",
          expectedRevision: revision,
          closeActiveSession: true,
        },
      ],
      [
        "profiles:copy-artifact",
        {
          kind: "skill",
          name: "mix-review",
          source: { scope: "bundled" },
          destination: { scope: "profile", profile: "ambient" },
          expectedRevision: revision,
        },
      ],
    ]);
  });

  it("validates output routing requests and responses", async () => {
    const assignment = {
      assignmentId: "assignment-1",
      producerId: "producer-1",
      enabled: true,
      deliveryMode: "next-prompt",
      usageInstruction: "Use safely.",
      processingPolicyIds: ["latest-window"],
    };
    const transport = transportFor({
      "outputs:assign": assignment,
      "outputs:set-processing-policies": assignment,
    });

    const api = createDesktopApi(transport);
    const agentInstanceId = "00000000-0000-4000-8000-000000000001";
    await expect(
      api.outputs.assign(agentInstanceId, "producer-1"),
    ).resolves.toEqual(assignment);
    await expect(api.outputs.assign(agentInstanceId, "")).rejects.toThrow();
    expect(vi.mocked(transport).invoke.mock.calls).toContainEqual([
      "outputs:assign",
      { agentInstanceId, producerId: "producer-1" },
    ]);
    await api.outputs.setProcessingPolicies(agentInstanceId, "producer-1", [
      "latest-window",
      "deduplicate",
    ]);
    expect(vi.mocked(transport).invoke.mock.calls.at(-1)).toEqual([
      "outputs:set-processing-policies",
      {
        agentInstanceId,
        producerId: "producer-1",
        processingPolicyIds: ["latest-window", "deduplicate"],
      },
    ]);
  });

  it("validates Live event operations and explicit agent attribution", async () => {
    const eventId = "live-event.00000000-0000-4000-8000-000000000001";
    const agentInstanceId = "00000000-0000-4000-8000-000000000002";
    const definition = {
      id: eventId,
      projectId: "project-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      kind: "track.playing_clip_changed",
      classification: "discrete",
      name: "Keys clip",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    };
    const attributedListener = {
      agentInstanceId,
      agentLabel: "Keys agent",
      listener: {
        id: "event-listener.00000000-0000-4000-8000-000000000003",
        eventId,
        enabled: true,
        responseMode: "automatic",
      },
    };
    const transport = transportFor({
      "events:list": {
        activeSessionId: "session-1",
        events: [
          {
            definition,
            resolution: {
              status: "unresolved",
              reason: "not-connected",
            },
            history: [],
            listeners: [attributedListener],
          },
        ],
      },
      "events:create": definition,
      "events:assign-listener": attributedListener,
    });
    const api = createDesktopApi(transport);
    const draft = {
      kind: "track.playing_clip_changed" as const,
      classification: "discrete" as const,
      name: "Keys clip",
      enabled: true,
      target: { track: { name: "Keys", occurrence: 0 } },
    };

    await expect(api.events.list()).resolves.toMatchObject({
      activeSessionId: "session-1",
    });
    await expect(api.events.create(draft)).resolves.toEqual(definition);
    await expect(
      api.events.assignListener(agentInstanceId, eventId, {
        enabled: true,
        responseMode: "automatic",
      }),
    ).resolves.toEqual(attributedListener);
    await expect(
      api.events.assignListener("selected-agent", eventId, {
        enabled: true,
        responseMode: "automatic",
      }),
    ).rejects.toThrow();
    await expect(
      api.events.updateListener(agentInstanceId, eventId, {}),
    ).rejects.toThrow();

    expect(vi.mocked(transport).invoke.mock.calls).toContainEqual([
      "events:assign-listener",
      {
        agentInstanceId,
        eventId,
        enabled: true,
        responseMode: "automatic",
      },
    ]);
  });

  it("exposes fixed diagnostics actions without renderer-provided paths", async () => {
    const transport = transportFor({
      "diagnostics:reveal-log": { revealed: true },
      "diagnostics:export-support-bundle": { status: "cancelled" },
      "diagnostics:copy-summary": { copied: true },
    });
    const api = createDesktopApi(transport);

    await api.diagnostics.revealLog();
    await expect(api.diagnostics.exportSupportBundle()).resolves.toEqual({
      status: "cancelled",
    });
    await api.diagnostics.copySummary();

    expect(vi.mocked(transport).invoke.mock.calls).toEqual([
      ["diagnostics:reveal-log", {}],
      ["diagnostics:export-support-bundle", {}],
      ["diagnostics:copy-summary", {}],
    ]);
  });

  it("exposes typed targeted managed-agent calls", async () => {
    const instanceId = "00000000-0000-4000-8000-000000000001";
    const transport = transportFor({
      "agents:send": { accepted: true, messageId: "message-1" },
      "agents:invoke-skill": { accepted: true, messageId: "message-2" },
      "agents:set-mode": {
        id: instanceId,
        definitionName: "default",
        definitionFingerprint: "a".repeat(64),
        label: "Default",
        lifecycle: "ready",
        mode: "plan",
        autoApprove: false,
        config: {
          description: "General agent",
          systemPrompt: "Help.",
          tools: ["*"],
          resolvedTools: [],
          editScope: ["session"],
          skills: [],
          inputChannels: [],
        },
        boundTracks: [],
        outputSubscriptions: [],
        eventListeners: [],
        modified: false,
      },
      "agents:resolve-plan": { resolved: true },
      "agents:cancel": { cancelled: true },
    });

    const api = createDesktopApi(transport);

    const context = [{ id: "track:1", kind: "track" as const, label: "Drums" }];
    await api.agents.send(instanceId, "hello", context);
    await api.agents.invokeSkill(
      instanceId,
      "analyze",
      "the drums",
      context,
      "plan",
    );
    await api.agents.setMode(instanceId, "plan");
    await expect(
      api.agents.resolvePlan(instanceId, {
        requestId: "plan-request",
        approved: true,
        selectedAction: "interactive",
      }),
    ).resolves.toBe(true);
    await expect(api.agents.cancel(instanceId)).resolves.toEqual({
      cancelled: true,
    });
    await expect(api.agents.send("invalid", "hello", [])).rejects.toThrow();

    expect(vi.mocked(transport).invoke.mock.calls).toEqual([
      [
        "agents:send",
        { instanceId, message: "hello", context, agentMode: "interactive" },
      ],
      [
        "agents:invoke-skill",
        {
          instanceId,
          skillName: "analyze",
          request: "the drums",
          context,
          agentMode: "plan",
        },
      ],
      ["agents:set-mode", { instanceId, mode: "plan" }],
      [
        "agents:resolve-plan",
        {
          instanceId,
          requestId: "plan-request",
          approved: true,
          selectedAction: "interactive",
        },
      ],
      ["agents:cancel", { instanceId }],
    ]);
  });

  it("exposes model discovery and atomic per-agent conversation settings", async () => {
    const instanceId = "00000000-0000-4000-8000-000000000001";
    const activeAgent = {
      id: instanceId,
      definitionName: "default",
      definitionFingerprint: "a".repeat(64),
      label: "Default",
      model: "model-a",
      reasoningEffort: "high",
      autoApprove: false,
      sdkSessionId: "sdk-2",
      lifecycle: "ready",
      config: {
        description: "General agent",
        systemPrompt: "Help.",
        tools: ["*"],
        resolvedTools: [],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
      },
      boundTracks: [],
      outputSubscriptions: [],
      eventListeners: [],
      modified: false,
    };
    const models = [
      {
        id: "model-a",
        displayName: "Model A",
        policyState: "enabled",
        capabilities: {
          vision: true,
          reasoningEffort: true,
          maxContextWindowTokens: 64_000,
        },
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
    ];
    const transport = transportFor({
      "agents:models": models,
      "agents:set-conversation-settings": activeAgent,
    });
    const api = createDesktopApi(transport);

    await expect(api.agents.listModels()).resolves.toEqual(models);
    await api.agents.setConversationSettings(instanceId, {
      model: "model-a",
      reasoningEffort: "high",
    });
    await api.agents.setConversationSettings(instanceId, {});

    expect(vi.mocked(transport).invoke.mock.calls).toEqual([
      ["agents:models", {}],
      [
        "agents:set-conversation-settings",
        {
          instanceId,
          settings: { model: "model-a", reasoningEffort: "high" },
        },
      ],
      ["agents:set-conversation-settings", { instanceId, settings: {} }],
    ]);
  });

  it("exposes atomic current-session auto approval", async () => {
    const response = {
      instances: [],
      session: {
        version: 4,
        id: "production-session",
        title: "Production session",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        liveSetId: "live-set-1",
        liveSetName: "Set",
        activeAgents: [],
        productionPlan: [],
        outputAssignments: [],
        liveEvents: [],
      },
    };
    const transport = transportFor({
      "agents:set-auto-approval": response,
    });
    const api = createDesktopApi(transport);

    await expect(api.agents.setAutoApproval("all", true)).resolves.toEqual(
      response,
    );
    const invoke = vi.mocked(transport.invoke);
    expect(invoke).toHaveBeenCalledWith("agents:set-auto-approval", {
      target: "all",
      enabled: true,
    });
    await expect(
      api.agents.setAutoApproval("not-an-instance", true),
    ).rejects.toThrow();
  });

  it("validates and exposes main-process-only event journal operations", async () => {
    const traceId = "00000000-0000-4000-8000-000000000010";
    const transport = transportFor({
      "event-history:search": {
        version: 2,
        items: [],
        page: {
          limit: 20,
          returnedItems: 0,
          totalItems: 0,
          hasMore: false,
          order: "desc",
        },
      },
      "event-history:trace": {
        version: 2,
        items: [],
        page: {
          limit: 20,
          returnedItems: 0,
          totalItems: 0,
          hasMore: false,
          order: "asc",
        },
        trace: {
          rootTraceId: traceId,
          totalEvents: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      "event-history:delete-trace": { deletedEvents: 2 },
      "event-history:clear": {
        deletedEvents: 2,
        deletedConfigurationSnapshots: 1,
      },
    });
    const api = createDesktopApi(transport);

    await expect(
      api.eventHistory.search({ sources: ["desktop"], limit: 20 }),
    ).resolves.toMatchObject({ version: 2, items: [] });
    await expect(
      api.eventHistory.trace(traceId, { limit: 20 }),
    ).resolves.toMatchObject({
      trace: { rootTraceId: traceId, totalEvents: 0 },
    });
    await expect(api.eventHistory.deleteTrace(traceId)).resolves.toBe(2);
    await expect(api.eventHistory.clear()).resolves.toEqual({
      deletedEvents: 2,
      deletedConfigurationSnapshots: 1,
    });
    await expect(api.eventHistory.deleteTrace("invalid")).rejects.toThrow();

    expect(vi.mocked(transport).invoke.mock.calls).toContainEqual([
      "event-history:search",
      { sources: ["desktop"], limit: 20, order: "desc" },
    ]);
  });
});

function transportFor(
  responses: Record<string, unknown>,
  listeners: Array<(event: never, value: unknown) => void> = [],
): PreloadTransport {
  return {
    invoke: vi.fn(async (channel: string) => responses[channel]),
    on: vi.fn((_channel, listener) =>
      listeners.push(listener as (event: never, value: unknown) => void),
    ),
    removeListener: vi.fn(),
  };
}
