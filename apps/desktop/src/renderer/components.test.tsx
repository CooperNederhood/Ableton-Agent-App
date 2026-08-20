import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ApprovalPanel,
  AgentsView,
  Arrangement,
  cancelWorkspaceAgent,
  Composer,
  ConnectionHeader,
  DiagnosticsView,
  groupOutputsByTrack,
  Inspector,
  loadInitialDesktopState,
  OperationCard,
  OutputConnectionCard,
  OutputsView,
  ProjectOutline,
  ResolvedToolsDisclosure,
  refreshOutputs,
  refreshProjectSnapshot,
  selectWorkspaceAgent,
  sendComposerMessage,
  SettingsView,
  setOutputSubscription,
  matchingSlashCompletions,
  slashCompletionKey,
  slashCompletionsForState,
  slashCompletionText,
  SlashCompletionSuggestions,
  Timeline,
  Workspace,
} from "./App";
import type { DesktopApi } from "../contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { desktopReducer, initialState, type DesktopState } from "./state";

describe("desktop components", () => {
  const firstAgentId = "00000000-0000-4000-8000-000000000001";
  const secondAgentId = "00000000-0000-4000-8000-000000000002";
  const workspaceState = (
    selectedAgentInstanceId = firstAgentId,
  ): DesktopState => ({
    ...initialState,
    lifecycle: "ready" as const,
    sessions: [
      {
        version: 2 as const,
        id: "session",
        title: "Session",
        updatedAt: new Date(0).toISOString(),
        projectName: "Project",
        mode: "explore" as const,
        productionPlan: [],
        outputAssignments: [],
        selectedAgentInstanceId,
        activeAgents: [firstAgentId, secondAgentId].map((id, index) => ({
          id,
          definitionName: "default",
          definitionFingerprint: "a".repeat(64),
          label: index === 0 ? "Default" : "Default 2",
          autoApprove: false,
          lifecycle: "ready" as const,
          config: {
            description: "General agent.",
            systemPrompt: "Help.",
            tools: ["*"],
            resolvedTools: [],
            editScope: ["session" as const],
            skills: [],
            inputChannels: [],
          },
          boundTracks: [],
          outputSubscriptions: [],
          modified: false,
        })),
      },
    ],
  });

  it("renders safe GitHub-flavored assistant Markdown", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        content={[
          "## Live Set Summary",
          "",
          "**Transport:** `128 BPM`",
          "",
          "- Drums",
          "- Bass",
          "",
          "| Track | Type |",
          "|---|---|",
          "| DRUMS | Audio |",
          "",
          "[Docs](https://example.com/guide)",
          "[Unsafe](javascript:alert(1))",
          "<script>alert('no')</script>",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<h2>Live Set Summary</h2>");
    expect(html).toContain("<strong>Transport:</strong>");
    expect(html).toContain("<code>128 BPM</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
  });

  it("keeps user messages as literal plain text", () => {
    const html = renderToStaticMarkup(
      <Timeline
        state={{
          ...initialState,
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "**do not format this**",
              streaming: false,
              timestamp: 1,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("**do not format this**");
    expect(html).not.toContain("<strong>do not format this</strong>");
  });

  it("renders partial streaming assistant Markdown incrementally", () => {
    const html = renderToStaticMarkup(
      <Timeline
        state={{
          ...initialState,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "## Current Set\n\n**Tempo:** 128",
              streaming: true,
              timestamp: 1,
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Streaming…");
    expect(html).toContain("<h2>Current Set</h2>");
    expect(html).toContain("<strong>Tempo:</strong>");
  });

  it("renders context chips as explicit removal controls", () => {
    const html = renderToStaticMarkup(
      <Composer
        state={{
          ...initialState,
          context: [{ id: "section:chorus", kind: "section", label: "Chorus" }],
        }}
        value=""
        busy={false}
        composerRef={{ current: null }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Remove section Chorus from context"');
  });

  it("suggests configured skills for the selected active agent", () => {
    const activeAgentId = "89a535fe-7f2d-4a58-972c-d33d40ca254d";
    const html = renderToStaticMarkup(
      <Composer
        state={{
          ...initialState,
          lifecycle: "ready",
          sessions: [
            {
              version: 2,
              id: "production-session",
              title: "Session",
              updatedAt: new Date(0).toISOString(),
              projectName: "Project",
              mode: "explore",
              productionPlan: [],
              outputAssignments: [],
              selectedAgentInstanceId: activeAgentId,
              activeAgents: [
                {
                  id: activeAgentId,
                  definitionName: "default",
                  definitionFingerprint: "a".repeat(64),
                  label: "Default",
                  autoApprove: false,
                  lifecycle: "ready",
                  config: {
                    description: "General agent.",
                    systemPrompt: "Help.",
                    tools: ["*"],
                    resolvedTools: ["ableton_session_inspect"],
                    editScope: ["session"],
                    skills: ["mix-review"],
                    inputChannels: [],
                  },
                  boundTracks: [],
                  outputSubscriptions: [],
                  modified: false,
                },
              ],
            },
          ],
          agentCatalog: {
            definitions: [],
            diagnostics: [],
            skills: [
              {
                name: "mix-review",
                description: "Review balance, dynamics, and tone.",
                sourceFile: "mix-review/SKILL.md",
                fingerprint: "b".repeat(64),
              },
              {
                name: "sound-design",
                description: "Create a sound.",
                sourceFile: "sound-design/SKILL.md",
                fingerprint: "c".repeat(64),
              },
            ],
          },
        }}
        value="/m"
        busy={false}
        composerRef={{ current: null }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain("Slash command suggestions");
    expect(html).toContain("/mix-review");
    expect(html).toContain("Skill");
    expect(html).toContain("Review balance, dynamics, and tone.");
    expect(html).not.toContain("/sound-design");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('type="button"');
  });

  it("filters unified slash completions by the token prefix", () => {
    const skills = [
      {
        name: "mix-review",
        description: "Review a mix.",
        sourceFile: "mix-review/SKILL.md",
        fingerprint: "b".repeat(64),
      },
      {
        name: "sound-design",
        description: "Create a sound.",
        sourceFile: "sound-design/SKILL.md",
        fingerprint: "c".repeat(64),
      },
    ];

    expect(
      matchingSlashCompletions("/m", skills).map(({ name }) => name),
    ).toEqual(["mix-review"]);
    expect(
      matchingSlashCompletions("/y", skills).map(({ name }) => name),
    ).toEqual(["yolo"]);
    expect(matchingSlashCompletions("plain", skills)).toEqual([]);
    expect(matchingSlashCompletions("/mix request", skills)).toEqual([]);
    expect(matchingSlashCompletions(" /mix", skills)).toEqual([]);
  });

  it("uses only catalog skills assigned to the selected agent", () => {
    const state = workspaceState(firstAgentId);
    state.sessions[0]!.activeAgents[0]!.config.skills = ["mix-review"];
    state.sessions[0]!.activeAgents[1]!.config.skills = ["sound-design"];
    state.agentCatalog = {
      definitions: [],
      diagnostics: [],
      skills: [
        {
          name: "mix-review",
          description: "Review a mix.",
          sourceFile: "mix-review/SKILL.md",
          fingerprint: "b".repeat(64),
        },
        {
          name: "sound-design",
          description: "Create a sound.",
          sourceFile: "sound-design/SKILL.md",
          fingerprint: "c".repeat(64),
        },
      ],
    };

    expect(
      slashCompletionsForState("/", state).map(({ name }) => name),
    ).toEqual(["mix-review", "yolo"]);
    state.sessions[0]!.selectedAgentInstanceId = secondAgentId;
    expect(
      slashCompletionsForState("/", state).map(({ name }) => name),
    ).toEqual(["sound-design", "yolo"]);
  });

  it("keeps built-ins without an agent and reserves their names", () => {
    expect(
      slashCompletionsForState("/", initialState).map(({ name }) => name),
    ).toEqual(["yolo"]);

    const entries = matchingSlashCompletions("/", [
      {
        name: "yolo",
        description: "Colliding skill.",
        sourceFile: "yolo/SKILL.md",
        fingerprint: "d".repeat(64),
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "yolo", source: "built-in" });
  });

  it("renders mouse-compatible completion buttons with accessible usage", () => {
    const entry = matchingSlashCompletions("/y", undefined)[0]!;
    const onComplete = vi.fn();
    const suggestions = SlashCompletionSuggestions({
      entries: [entry],
      selected: 0,
      onComplete,
    });
    const buttons = (
      suggestions as ReactElement<{
        children: ReactElement<{ onClick: () => void }>[];
      }>
    ).props.children;

    buttons[0]!.props.onClick();
    expect(onComplete).toHaveBeenCalledWith(entry);

    const html = renderToStaticMarkup(suggestions);

    expect(html).toContain('type="button"');
    expect(html).toContain("Built-in");
    expect(html).toContain("Configure automatic approval");
    expect(html).toContain("Usage: /yolo [on|off] [all]");
    expect(html).toContain(
      'aria-label="/yolo. Built-in command. Configure automatic approval',
    );
    expect(slashCompletionText(entry)).toBe("/yolo ");
  });

  it("renders composer skill errors inline", () => {
    const html = renderToStaticMarkup(
      <Composer
        state={initialState}
        value="/unknown"
        busy={false}
        error="Unknown skill &#x27;/unknown&#x27;."
        composerRef={{ current: null }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain('class="composer-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Unknown skill");
  });

  it("supports keyboard completion navigation and selection", () => {
    expect(slashCompletionKey("ArrowDown", 0, 2)).toBe(1);
    expect(slashCompletionKey("ArrowDown", 1, 2)).toBe(0);
    expect(slashCompletionKey("ArrowUp", 0, 2)).toBe(1);
    expect(slashCompletionKey("Tab", 1, 2)).toBe("complete");
    expect(slashCompletionKey("Enter", 0, 2)).toBe("complete");
    expect(slashCompletionKey("Enter", 0, 0)).toBeUndefined();
  });

  it("replaces product modes with labeled active-agent instances", () => {
    const state = workspaceState();
    const header = renderToStaticMarkup(
      <ConnectionHeader state={state} dispatch={vi.fn()} />,
    );
    const workspace = renderToStaticMarkup(
      <Workspace state={state} dispatch={vi.fn()} />,
    );

    expect(header).toContain('aria-label="Agent Mode"');
    expect(header).toContain("Default");
    expect(header).toContain("Default 2");
    expect(header).not.toContain("Compose");
    expect(header).not.toContain("Explore");
    expect(workspace).toContain("Default · ready");
  });

  it("renders only the selected agent conversation", () => {
    const state = {
      ...workspaceState(secondAgentId),
      agentWorkspaces: {
        [firstAgentId]: {
          messages: [
            {
              id: "first",
              role: "assistant" as const,
              content: "First conversation",
              streaming: false,
              timestamp: 1,
            },
          ],
          operations: [],
        },
        [secondAgentId]: {
          messages: [
            {
              id: "second",
              role: "assistant" as const,
              content: "Second conversation",
              streaming: false,
              timestamp: 2,
            },
          ],
          operations: [],
        },
      },
    };
    const html = renderToStaticMarkup(<Timeline state={state} />);
    expect(html).toContain("Second conversation");
    expect(html).not.toContain("First conversation");
  });

  it("targets composer send and cancel to the selected instance", async () => {
    const state = workspaceState(secondAgentId);
    const send = vi.fn().mockResolvedValue({
      accepted: true,
      messageId: "message",
    });

    const cancel = vi.fn().mockResolvedValue({ cancelled: true });
    const setContext = vi.fn().mockResolvedValue(undefined);
    const desktop = {
      agents: { send, cancel },
      project: { setContext },
    } as unknown as DesktopApi;
    const dispatch = vi.fn();

    await sendComposerMessage(desktop, state, "Inspect the drums", dispatch);
    await expect(cancelWorkspaceAgent(desktop, state)).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith(secondAgentId, "Inspect the drums");
    expect(cancel).toHaveBeenCalledWith(secondAgentId);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user-message",
        agentInstanceId: secondAgentId,
      }),
    );
  });

  it("invokes an assigned catalog skill and preserves its request", async () => {
    const state = workspaceState(secondAgentId);
    state.sessions[0]!.activeAgents[1]!.config.skills = ["mix-review"];
    state.agentCatalog = {
      definitions: [],
      diagnostics: [],
      skills: [
        {
          name: "mix-review",
          description: "Review a mix.",
          sourceFile: "mix-review/SKILL.md",
          fingerprint: "a".repeat(64),
        },
      ],
    };
    const invokeSkill = vi.fn().mockResolvedValue({
      accepted: true,
      messageId: "message",
    });
    const send = vi.fn();
    const desktop = {
      agents: { invokeSkill, send },
      project: { setContext: vi.fn().mockResolvedValue(undefined) },
    } as unknown as DesktopApi;
    const dispatch = vi.fn();

    await sendComposerMessage(
      desktop,
      state,
      "/mix-review preserve the vocal dynamics",
      dispatch,
    );

    expect(invokeSkill).toHaveBeenCalledWith(
      secondAgentId,
      "mix-review",
      "preserve the vocal dynamics",
    );
    expect(send).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user-message",
        content: "/mix-review preserve the vocal dynamics",
      }),
    );
  });

  it.each([
    ["/yolo", secondAgentId, true],
    ["/yolo off", secondAgentId, false],
    ["/yolo on all", "all", true],
    ["/yolo off all", "all", false],
  ] as const)(
    "handles %s locally and updates the returned session immediately",
    async (input, target, enabled) => {
      const state = workspaceState(secondAgentId);
      const session = {
        ...state.sessions[0]!,
        activeAgents: state.sessions[0]!.activeAgents.map((agent) => ({
          ...agent,
          autoApprove: enabled,
        })),
      };
      const setAutoApproval = vi.fn().mockResolvedValue({
        instances: session.activeAgents,
        session,
      });
      const invokeSkill = vi.fn();
      const send = vi.fn();
      const desktop = {
        agents: { setAutoApproval, invokeSkill, send },
        project: { setContext: vi.fn() },
      } as unknown as DesktopApi;
      const dispatch = vi.fn();

      await sendComposerMessage(desktop, state, input, dispatch);

      expect(setAutoApproval).toHaveBeenCalledWith(target, enabled);
      expect(invokeSkill).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith({
        type: "event",
        event: { type: "session.context_restored", session },
      });
      expect(dispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "user-message" }),
      );
    },
  );

  it("rejects malformed YOLO before skill parsing or SDK prompting", async () => {
    const state = workspaceState(secondAgentId);
    const desktop = {
      agents: {
        setAutoApproval: vi.fn(),
        invokeSkill: vi.fn(),
        send: vi.fn(),
      },
      project: { setContext: vi.fn() },
    } as unknown as DesktopApi;
    const dispatch = vi.fn();

    await expect(
      sendComposerMessage(desktop, state, "/YOLO on", dispatch),
    ).rejects.toThrow("Usage: /yolo [on|off] [all]");
    expect(desktop.agents.setAutoApproval).not.toHaveBeenCalled();
    expect(desktop.agents.invokeSkill).not.toHaveBeenCalled();
    expect(desktop.agents.send).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["/yolo on", "/yolo off"] as const)(
    "propagates %s persistence failures without dispatching success",
    async (input) => {
      const state = workspaceState(secondAgentId);
      const failure = new Error("strict save exploded");
      const desktop = {
        agents: {
          setAutoApproval: vi.fn().mockRejectedValue(failure),
          invokeSkill: vi.fn(),
          send: vi.fn(),
        },
        project: { setContext: vi.fn() },
      } as unknown as DesktopApi;
      const dispatch = vi.fn();

      await expect(
        sendComposerMessage(desktop, state, input, dispatch),
      ).rejects.toBe(failure);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/", "Invalid skill command"],
    ["/unknown request", "Unknown skill '/unknown'"],
    ["/mix-review request", "is not assigned to Default 2"],
  ])(
    "rejects invalid skill command %s without a user turn",
    async (input, error) => {
      const state = workspaceState(secondAgentId);
      state.agentCatalog = {
        definitions: [],
        diagnostics: [],
        skills: [
          {
            name: "mix-review",
            description: "Review a mix.",
            sourceFile: "mix-review/SKILL.md",
            fingerprint: "a".repeat(64),
          },
        ],
      };
      const invokeSkill = vi.fn();
      const send = vi.fn();
      const desktop = {
        agents: { invokeSkill, send },
        project: { setContext: vi.fn() },
      } as unknown as DesktopApi;
      const dispatch = vi.fn();

      await expect(
        sendComposerMessage(desktop, state, input, dispatch),
      ).rejects.toThrow(error);
      expect(invokeSkill).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects stale skills and invocation failures without a user turn", async () => {
    const state = workspaceState(secondAgentId);
    state.sessions[0]!.activeAgents[1]!.config.skills = ["mix-review"];
    const dispatch = vi.fn();
    const staleDesktop = {
      agents: { invokeSkill: vi.fn(), send: vi.fn() },
      project: { setContext: vi.fn() },
    } as unknown as DesktopApi;

    await expect(
      sendComposerMessage(staleDesktop, state, "/mix-review request", dispatch),
    ).rejects.toThrow("definition is unavailable");
    expect(dispatch).not.toHaveBeenCalled();

    state.agentCatalog.skills = [
      {
        name: "mix-review",
        description: "Review a mix.",
        sourceFile: "mix-review/SKILL.md",
        fingerprint: "a".repeat(64),
      },
    ];
    const failingDesktop = {
      agents: {
        invokeSkill: vi
          .fn()
          .mockRejectedValue(new Error("Skill runtime failed")),
      },
      project: { setContext: vi.fn().mockResolvedValue(undefined) },
    } as unknown as DesktopApi;

    await expect(
      sendComposerMessage(
        failingDesktop,
        state,
        "/mix-review request",
        dispatch,
      ),
    ).rejects.toThrow("Skill runtime failed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects composer sends when no active agent is selected", async () => {
    const dispatch = vi.fn();
    await expect(
      sendComposerMessage(
        {} as DesktopApi,
        { ...initialState, lifecycle: "ready" },
        "/mix-review request",
        dispatch,
      ),
    ).rejects.toThrow("No active agent is selected");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists workspace agent selection through the Desktop API", async () => {
    const instance =
      workspaceState(secondAgentId).sessions[0]!.activeAgents[1]!;
    const select = vi.fn().mockResolvedValue(instance);
    const desktop = { agents: { select } } as unknown as DesktopApi;
    const dispatch = vi.fn();

    await selectWorkspaceAgent(desktop, secondAgentId, dispatch);

    expect(select).toHaveBeenCalledWith(secondAgentId);
    expect(dispatch).toHaveBeenCalledWith({
      type: "event",
      event: { type: "agent.instance_changed", instance, change: "selected" },
    });
  });

  it("renders diagnostics log metadata and safe actions", () => {
    const html = renderToStaticMarkup(
      <DiagnosticsView
        state={{
          ...initialState,
          diagnosticsReport: {
            checks: [
              { label: "Bridge", status: "warn", detail: "Not connected" },
            ],
            logging: {
              level: "debug",
              fileName: "desktop-development.log",
              filePath: "/logs/desktop-development.log",
            },
          },
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain("Active logging level: debug");
    expect(html).toContain("desktop-development.log");
    expect(html).toContain("Reveal log");
    expect(html).toContain("Export support bundle");
    expect(html).toContain("Copy summary");
  });

  it("renders defined and active agents with production controls", () => {
    const activeAgentId = "89a535fe-7f2d-4a58-972c-d33d40ca254d";
    const html = renderToStaticMarkup(
      <AgentsView
        state={{
          ...initialState,
          lifecycle: "ready",
          sessions: [
            {
              version: 2,
              id: "production-session",
              title: "Session",
              updatedAt: new Date(0).toISOString(),
              projectName: "Project",
              mode: "explore",
              productionPlan: [],
              outputAssignments: [],
              selectedAgentInstanceId: activeAgentId,
              activeAgents: [
                {
                  id: activeAgentId,
                  definitionName: "default",
                  definitionFingerprint: "a".repeat(64),
                  label: "Default",
                  autoApprove: false,
                  lifecycle: "ready",
                  config: {
                    description: "General-purpose Ableton agent.",
                    systemPrompt: "Help with Ableton.",
                    tools: ["ableton_*"],
                    resolvedTools: [
                      "ableton_session_inspect",
                      "ableton_transport_get",
                    ],
                    editScope: ["session"],
                    skills: ["mix-review"],
                    inputChannels: ["midi:drums"],
                  },
                  boundTracks: [],
                  outputSubscriptions: [],
                  modified: true,
                },
              ],
            },
          ],
          agentCatalog: {
            definitions: [
              {
                name: "default",
                description: "General-purpose Ableton agent.",
                systemPrompt: "Help with Ableton.",
                tools: ["*"],
                resolvedTools: ["ableton_session_inspect"],
                editScope: ["session"],
                skills: [],
                inputChannels: [],
                sourceFile: "default.yaml",
                fingerprint: "b".repeat(64),
              },
            ],
            skills: [],
            diagnostics: [
              {
                sourceFile: "broken.yaml",
                code: "invalid_definition",
                message: "Missing system prompt",
              },
            ],
          },
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain("General-purpose Ableton agent.");
    expect(html).toContain("Defined");
    expect(html).toContain("Active agents");
    expect(html).toContain("Selected");
    expect(html).toContain("Modified");
    expect(html).toContain("ableton_transport_get");
    expect(html).toContain("mix-review");
    expect(html).toContain("midi:drums");
    expect(html).toContain("Full session");
    expect(html).toContain("default.yaml");
    expect(html).toContain("newer definition available");
    expect(html).toContain("Definition diagnostics");
    expect(html).toContain("broken.yaml: Missing system prompt");
    expect(html).toContain("Edit overrides");
    expect(html).toContain("Reset to current definition");
    expect(html).toContain("Deactivate");
    expect(html).toContain("Open");
    expect(html).toContain("Create agent");
  });

  it("collapses resolved tools for wildcard selections", () => {
    const html = renderToStaticMarkup(
      <ResolvedToolsDisclosure
        patterns={["ableton_devices_*"]}
        resolvedTools={[
          "ableton_devices_inspect",
          "ableton_device_set_parameter",
        ]}
      />,
    );

    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Resolved tools (2)");
    expect(html).toContain("ableton_devices_inspect");
  });

  it("shows exact tool resolutions without a disclosure", () => {
    const html = renderToStaticMarkup(
      <ResolvedToolsDisclosure
        patterns={["ableton_session_inspect"]}
        resolvedTools={["ableton_session_inspect"]}
      />,
    );

    expect(html).not.toContain("<details");
    expect(html).toContain("Resolves to: ableton_session_inspect");
  });

  it("shows an empty wildcard resolution inside the disclosure", () => {
    const html = renderToStaticMarkup(
      <ResolvedToolsDisclosure patterns={["*"]} resolvedTools={[]} />,
    );

    expect(html).toContain("Resolved tools (0)");
    expect(html).toContain("no available tools");
  });

  it("renders the active-agent loading and empty states", () => {
    const loading = renderToStaticMarkup(
      <AgentsView state={initialState} dispatch={vi.fn()} />,
    );
    const empty = renderToStaticMarkup(
      <AgentsView
        state={{ ...initialState, lifecycle: "ready" }}
        dispatch={vi.fn()}
      />,
    );

    expect(loading).toContain("Loading active agents");
    expect(empty).toContain("No active agents");
    expect(empty).toContain("No valid agents found");
  });

  it("renders operation recovery details without color-only status", () => {
    const html = renderToStaticMarkup(
      <OperationCard
        operation={{
          id: "1",
          label: "Place clips",
          status: "partial",
          detail: "2 of 3",
          warnings: ["Track locked"],
          changed: ["Intro"],
          unchanged: ["Verse"],
          retryable: true,
          undoable: true,
          timestamp: 1,
        }}
      />,
    );
    expect(html).toContain("partial");
    expect(html).toContain("Retry safely");
    expect(html).toContain("Not changed:");
  });

  it("renders approval preview and semantic actions", () => {
    const state = {
      ...initialState,
      approval: {
        id: "a",
        title: "Place arrangement",
        risk: "medium" as const,
        summary: "Place clips",
        changes: ["Add eight clips"],
        destructive: false,
      },
    };
    const html = renderToStaticMarkup(
      <ApprovalPanel state={state} dispatch={vi.fn()} />,
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Add eight clips");
  });

  it("warns when settings draft approves all changes without prompts", () => {
    const html = renderToStaticMarkup(
      <SettingsView
        state={{
          ...initialState,
          preferences: {
            ...initialState.preferences,
            approvalPolicy: "approve-all",
          } as unknown as DesktopState["preferences"],
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain(
      '<option value="approve-all" selected="">Approve all (no prompts)</option>',
    );
    expect(html).toContain('class="approval-policy-warning" role="alert"');
    expect(html).toContain(
      "Warning: all changes will be approved automatically.",
    );
    expect(html).toContain(
      "You will not be prompted before Ableton changes are applied.",
    );
  });

  it("shows YOLO status without occupying composer space", () => {
    const state = workspaceState();
    state.sessions[0]!.activeAgents[0]!.autoApprove = true;
    const header = renderToStaticMarkup(
      <ConnectionHeader state={state} dispatch={vi.fn()} />,
    );
    const workspace = renderToStaticMarkup(
      <Workspace state={state} dispatch={vi.fn()} />,
    );
    const agents = renderToStaticMarkup(
      <AgentsView state={state} dispatch={vi.fn()} />,
    );
    const composer = renderToStaticMarkup(
      <Composer
        state={state}
        value=""
        busy={false}
        composerRef={{ current: null }}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        dispatch={vi.fn()}
      />,
    );
    const settings = renderToStaticMarkup(
      <SettingsView state={state} dispatch={vi.fn()} />,
    );

    expect(header).toContain("YOLO");
    expect(workspace).toContain("YOLO");
    expect(agents).toContain("YOLO");
    expect(composer).not.toContain("Approvals are automatic");
    expect(settings).toContain("Current session: 1 YOLO override");
    expect(settings).toContain("Deny all overrides YOLO");
    expect(settings).toContain("Approve all globally approves every request");
  });

  it("renders plan and empty inspector states", () => {
    expect(
      renderToStaticMarkup(
        <Arrangement state={initialState} dispatch={vi.fn()} />,
      ),
    ).toContain("Production plan");
    expect(
      renderToStaticMarkup(
        <Inspector state={initialState} dispatch={vi.fn()} />,
      ),
    ).toContain("Nothing selected");
  });

  it("renders output state and accessible routing controls", () => {
    const agentInstanceId = "00000000-0000-4000-8000-000000000001";
    const secondAgentInstanceId = "00000000-0000-4000-8000-000000000002";
    const agent = (id: string, label: string) => ({
      id,
      definitionName: "default",
      definitionFingerprint: "a".repeat(64),
      label,
      autoApprove: false,
      lifecycle: "ready" as const,
      config: {
        description: "Groove",
        systemPrompt: "Groove",
        tools: ["*"],
        resolvedTools: [],
        editScope: ["session" as const],
        skills: [],
        inputChannels: [],
      },
      boundTracks: [],
      outputSubscriptions: [],
      modified: false,
    });
    const state = {
      ...initialState,
      sessions: [
        {
          version: 2 as const,
          id: "session-1",
          title: "Session",
          updatedAt: new Date(0).toISOString(),
          projectName: "Test Set",
          activeAgents: [
            agent(agentInstanceId, "Groove agent"),
            agent(secondAgentInstanceId, "Mix agent"),
          ],
          selectedAgentInstanceId: agentInstanceId,
          mode: "explore" as const,
          productionPlan: [],
          outputAssignments: [],
        },
      ],
      snapshot: {
        id: "project-1",
        name: "Test Set",
        tempo: 120,
        timeSignature: "4/4",
        tracks: [
          {
            id: "track-keys",
            name: "Keys",
            kind: "midi" as const,
            color: "#79c2ff",
            volume: 0.8,
            pan: 0,
            muted: false,
            clips: [],
            devices: [],
          },
        ],
      },
      outputs: {
        status: {
          state: "listening" as const,
          host: "127.0.0.1",
          port: 45832,
        },
        activeSessionId: "session-1",
        connections: [
          {
            connectionId: "connection-1",
            producerId: "producer-1",
            instanceId: "instance-1",
            displayName: "MIDI Capture",
            signalKind: "midi" as const,
            state: "connected" as const,
            receiving: true,
            lastHeartbeatAt: 1,
            track: { index: 0, name: "Keys" },
          },
        ],
        assignments: [
          {
            assignmentId: "assignment-1",
            agentInstanceId,
            producerId: "producer-1",
            enabled: true,
            deliveryMode: "next-prompt" as const,
            usageInstruction: "Use as observation.",
            processingPolicyIds: ["latest-window"],
          },
          {
            assignmentId: "assignment-2",
            agentInstanceId: secondAgentInstanceId,
            producerId: "producer-1",
            enabled: true,
            deliveryMode: "automatic-action" as const,
            usageInstruction: "React only for the mix agent.",
            processingPolicyIds: ["deduplicate"],
          },
        ],
        latest: [
          {
            assignmentId: "assignment-1",
            producerId: "producer-1",
            sequence: 2,
            capturedAt: 3,
            summary: "No notes in this window.",
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <OutputsView state={state} dispatch={vi.fn()} />,
    );
    expect(html).toContain("Connection state: connected");
    expect(html).toContain("Delivery mode");
    expect(html).toContain("Save instruction");
    expect(html).toContain("No notes in this window.");
    expect(html).toContain("Keys");
    expect(html).toContain("1 output");
    expect(html).toContain("--output-track-color:#79c2ff");
    expect(html).toContain(
      'aria-label="Groove agent subscription to MIDI Capture"',
    );
    expect(html).toContain(
      'aria-label="Mix agent subscription to MIDI Capture"',
    );
    expect(html).toContain(
      '<option value="automatic-action" selected="">Automatic action</option>',
    );
    expect(html).toContain("React only for the mix agent.");
    expect(html).toContain("Save policies");
    const missingHtml = renderToStaticMarkup(
      <OutputsView
        state={{
          ...state,
          outputs: { ...state.outputs, connections: [] },
        }}
        dispatch={vi.fn()}
      />,
    );
    expect(missingHtml).toContain("Producer unavailable");
    expect(missingHtml).toContain(
      "These active-agent inputs are waiting for a producer with the same stable ID to reconnect.",
    );
    expect(missingHtml).toContain("Unmatched subscriptions");
    expect(missingHtml).toContain("No outputs discovered");
    expect(missingHtml).not.toContain("Unknown / ungrouped");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Collapse");
  });

  it("groups outputs by regular Live track order with guarded color matching", () => {
    const snapshot = {
      id: "project-1",
      name: "Test Set",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [
        {
          id: "track-return",
          name: "Return A",
          kind: "return" as const,
          color: "#ffffff",
          volume: 0.8,
          pan: 0,
          muted: false,
          clips: [],
          devices: [],
        },
        {
          id: "track-drums",
          name: "Drums",
          kind: "midi" as const,
          color: "#ff8a80",
          volume: 0.8,
          pan: 0,
          muted: false,
          clips: [],
          devices: [],
        },
        {
          id: "track-bass",
          name: "Bass",
          kind: "audio" as const,
          color: "#80cbc4",
          volume: 0.8,
          pan: 0,
          muted: false,
          clips: [],
          devices: [],
        },
      ],
    };
    const connections = [
      {
        connectionId: "connection-bass",
        producerId: "producer-bass",
        instanceId: "instance-bass",
        displayName: "Bass Envelope",
        signalKind: "audio" as const,
        state: "connected" as const,
        receiving: false,
        lastHeartbeatAt: 1,
        track: { index: 1, name: "Bass" },
      },
      {
        connectionId: "connection-drums-b",
        producerId: "producer-drums-b",
        instanceId: "instance-drums-b",
        displayName: "Drum Notes",
        signalKind: "midi" as const,
        state: "connected" as const,
        receiving: false,
        lastHeartbeatAt: 1,
        track: { index: 0, name: "Drums" },
      },
      {
        connectionId: "connection-drums-a",
        producerId: "producer-drums-a",
        instanceId: "instance-drums-a",
        displayName: "Drum Activity",
        signalKind: "midi" as const,
        state: "connected" as const,
        receiving: false,
        lastHeartbeatAt: 1,
        track: { index: 0, name: "Drums" },
      },
    ];

    const groups = groupOutputsByTrack(connections, snapshot);

    expect(groups.map((group) => [group.label, group.color])).toEqual([
      ["Drums", "#ff8a80"],
      ["Bass", "#80cbc4"],
    ]);
    expect(
      groups[0]?.connections.map((connection) => connection.displayName),
    ).toEqual(["Drum Activity", "Drum Notes"]);
  });

  it("uses unique names as a stale-index fallback and leaves ambiguity ungrouped", () => {
    const track = (id: string, name: string, color: string) => ({
      id,
      name,
      kind: "midi" as const,
      color,
      volume: 0.8,
      pan: 0,
      muted: false,
      clips: [],
      devices: [],
    });
    const snapshot = {
      id: "project-1",
      name: "Test Set",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [
        track("track-keys", "Keys", "#79c2ff"),
        track("track-pad-a", "Pad", "#ffcc80"),
        track("track-pad-b", "Pad", "#ce93d8"),
      ],
    };
    const connection = (producerId: string, name: string, index: number) => ({
      connectionId: `connection-${producerId}`,
      producerId,
      instanceId: `instance-${producerId}`,
      displayName: producerId,
      signalKind: "midi" as const,
      state: "connected" as const,
      receiving: false,
      lastHeartbeatAt: 1,
      track: { index, name },
    });

    const groups = groupOutputsByTrack(
      [
        connection("keys", "Keys", 2),
        connection("ambiguous", "Pad", 0),
        {
          ...connection("missing", "Missing", 0),
          track: undefined,
        },
      ],
      snapshot,
    );

    expect(groups.map((group) => [group.label, group.color])).toEqual([
      ["Keys", "#79c2ff"],
      ["Unknown / ungrouped", "#8a8f98"],
    ]);
    expect(groups[1]?.connections.map((item) => item.producerId)).toEqual([
      "ambiguous",
      "missing",
    ]);
  });

  it("renders an active-agent subscription checkbox", () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const html = renderToStaticMarkup(
      <OutputConnectionCard
        connection={{
          connectionId: "connection-1",
          producerId: "producer-1",
          instanceId: "instance-1",
          displayName: "MIDI Capture",
          signalKind: "midi",
          state: "connected",
          receiving: false,
          lastHeartbeatAt: 1,
        }}
        activeAgents={[
          {
            id: agentId,
            definitionName: "default",
            definitionFingerprint: "a".repeat(64),
            label: "Mix agent",
            autoApprove: false,
            lifecycle: "ready",
            config: {
              description: "Mix",
              systemPrompt: "Mix",
              tools: ["*"],
              resolvedTools: [],
              editScope: ["session"],
              skills: [],
              inputChannels: [],
            },
            boundTracks: [],
            outputSubscriptions: [],
            modified: false,
          },
        ]}
        assignments={[]}
        latest={[]}
        unavailable={false}
        expanded={true}
        onToggleDisclosure={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(html).toContain(
      'aria-label="Mix agent subscription to MIDI Capture"',
    );
    expect(html).toContain("Mix agent");
  });

  it("creates and removes only the requested agent subscription", async () => {
    const outputs = {
      assign: vi.fn().mockResolvedValue({}),
      unassign: vi.fn().mockResolvedValue(true),
    };
    const agentId = "00000000-0000-4000-8000-000000000001";

    await setOutputSubscription(
      outputs,
      agentId,
      "producer-1",
      undefined,
      true,
    );
    expect(outputs.assign).toHaveBeenCalledWith(agentId, "producer-1");
    expect(outputs.unassign).not.toHaveBeenCalled();

    const assignment = {
      assignmentId: "assignment-1",
      producerId: "producer-1",
      enabled: true,
      deliveryMode: "next-prompt" as const,
      usageInstruction: "Observe this.",
      processingPolicyIds: [],
    };
    await setOutputSubscription(
      outputs,
      agentId,
      "producer-1",
      assignment,
      false,
    );
    expect(outputs.unassign).toHaveBeenCalledWith(agentId, "producer-1");
  });

  it.each([
    ["refreshing", "Refreshing…", "disabled", "Refreshing project snapshot."],
    ["succeeded", "Updated", undefined, "Project snapshot updated."],
    ["failed", "Retry", undefined, "Refresh failed locally"],
  ] as const)(
    "renders an accessible %s project refresh control",
    (status, label, disabledAttribute, message) => {
      const projectRefresh =
        status === "failed"
          ? { status, message }
          : {
              status,
            };
      const html = renderToStaticMarkup(
        <ProjectOutline
          state={{
            ...initialState,
            connection: {
              state: "connected",
              liveVersion: "12.1",
              remoteScriptVersion: "1",
              projectId: "project",
            },
            projectRefresh,
          }}
          dispatch={vi.fn()}
        />,
      );

      expect(html).toContain(`aria-label="${label} project snapshot"`);
      expect(html).toContain(`>${label}</button>`);
      expect(html).toContain(message);
      if (disabledAttribute) expect(html).toContain(disabledAttribute);
      else expect(html).not.toContain("<button disabled");
    },
  );

  it("keeps refresh available without a snapshot when connected", () => {
    const html = renderToStaticMarkup(
      <ProjectOutline
        state={{
          ...initialState,
          connection: {
            state: "connected",
            liveVersion: "12.1",
            remoteScriptVersion: "1",
            projectId: "project",
          },
        }}
        dispatch={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Refresh project snapshot"');
    expect(html).toContain("No snapshot");
    expect(html).not.toContain("<button disabled");
  });

  it("renders project selection context disabled by default", () => {
    const off = renderToStaticMarkup(
      <ProjectOutline state={initialState} dispatch={vi.fn()} />,
    );
    expect(off).toContain('role="switch"');
    expect(off).not.toContain('role="switch" checked=""');
    expect(off).toContain(
      "Selections only control the Project and Inspector views.",
    );

    const on = renderToStaticMarkup(
      <ProjectOutline
        state={{ ...initialState, projectSelectionContextEnabled: true }}
        dispatch={vi.fn()}
      />,
    );
    expect(on).toContain('role="switch" checked=""');
    expect(on).toContain(
      "Selected tracks, clips, and devices are included in prompts.",
    );
  });

  it("loads initial renderer state without StrictMode snapshot requests", async () => {
    const requestSnapshot = vi.fn();
    const desktop = {
      lifecycle: { get: vi.fn().mockResolvedValue("ready") },
      ableton: {
        getStatus: vi.fn().mockResolvedValue({ state: "disconnected" }),
        requestSnapshot,
      },
      preferences: {
        get: vi.fn().mockResolvedValue(initialState.preferences),
      },
      agent: { getSessions: vi.fn().mockResolvedValue([]) },
      outputs: { list: vi.fn().mockResolvedValue(initialState.outputs) },
      agents: {
        getCatalog: vi.fn().mockResolvedValue(initialState.agentCatalog),
      },
    } as unknown as Parameters<typeof loadInitialDesktopState>[0];

    const [events] = await Promise.all([
      loadInitialDesktopState(desktop),
      loadInitialDesktopState(desktop),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "lifecycle.changed",
      "ableton.connection_changed",
      "preferences.changed",
      "sessions.changed",
      "agents.catalog_changed",
      "outputs.changed",
    ]);
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it("refreshes outputs through the output API and reports failures", async () => {
    const dispatch = vi.fn<Parameters<typeof refreshOutputs>[0]>();
    const outputs = {
      ...initialState.outputs,
      status: {
        state: "listening" as const,
        host: "127.0.0.1",
        port: 45832,
      },
    };

    await expect(
      refreshOutputs(dispatch, vi.fn().mockResolvedValue(outputs)),
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: "event",
      event: { type: "outputs.changed", outputs },
    });

    dispatch.mockClear();
    await expect(
      refreshOutputs(
        dispatch,
        vi.fn().mockRejectedValue(new Error("Signal state unavailable")),
      ),
    ).resolves.toBe(false);
    expect(dispatch).toHaveBeenCalledWith({
      type: "event",
      event: {
        type: "diagnostic",
        level: "error",
        message: "Signal state unavailable",
      },
    });
  });

  it("does not call refresh while disconnected and reports a failure", async () => {
    const requestSnapshot = vi.fn();
    const dispatch = vi.fn<Parameters<typeof refreshProjectSnapshot>[1]>();

    await refreshProjectSnapshot(
      { state: "disconnected" },
      dispatch,
      requestSnapshot,
    );

    expect(requestSnapshot).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "project-refresh-failed",
      message: "Connect to Ableton before refreshing the project.",
    });
    expect(
      dispatch.mock.calls.some(
        ([action]) =>
          action.type === "event" && action.event.type === "diagnostic",
      ),
    ).toBe(true);
  });

  it("reports refresh success after applying the returned snapshot", async () => {
    const snapshot = {
      id: "project",
      name: "Project",
      tempo: 120,
      timeSignature: "4/4",
      tracks: [],
    };
    let state: DesktopState = {
      ...initialState,
      connection: {
        state: "connected",
        liveVersion: "12.1",
        remoteScriptVersion: "1",
        projectId: "project",
      },
    };
    const dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]> = (
      action,
    ) => {
      state = desktopReducer(state, action);
    };

    await refreshProjectSnapshot(
      state.connection,
      dispatch,
      vi.fn().mockResolvedValue(snapshot),
    );

    expect(state.snapshot).toEqual(snapshot);
    expect(state.projectRefresh).toEqual({ status: "succeeded" });
  });
});
