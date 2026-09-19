// @vitest-environment jsdom

import { act, createRef, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopActiveAgent,
  DesktopAgentModel,
  DesktopApi,
  DesktopAppEvent,
} from "../contracts";
import {
  App,
  AgentsView,
  ConnectionHeader,
  DesktopComposer,
  EventsView,
  Inspector,
  WorkingDisclosure,
  Workspace,
  type WorkspaceSidebarWidths,
} from "./App";
import { desktopReducer, initialState, type DesktopState } from "./state";

const agentId = "00000000-0000-4000-8000-000000000001";
const sessionId = "production-session";
const models: DesktopAgentModel[] = [
  {
    id: "model-a",
    displayName: "Model A",
    policyState: "enabled",
    capabilities: { vision: false, reasoningEffort: true },
    supportedReasoningEfforts: ["high"],
  },
  {
    id: "model-b",
    displayName: "Model B",
    policyState: "enabled",
    capabilities: { vision: false, reasoningEffort: true },
    supportedReasoningEfforts: ["xhigh"],
  },
];

function activeAgent(
  update: Partial<DesktopActiveAgent> = {},
): DesktopActiveAgent {
  return {
    id: agentId,
    definitionName: "default",
    definitionFingerprint: "a".repeat(64),
    label: "Default",
    model: "model-a",
    reasoningEffort: "high",
    autoApprove: false,
    lifecycle: "ready",
    config: {
      description: "General agent.",
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
    ...update,
  };
}

function rendererState(active = true): DesktopState {
  return {
    ...initialState,
    lifecycle: "ready",
    ...(active ? { activeSessionId: sessionId } : {}),
    sessions: [
      {
        version: 3,
        id: sessionId,
        title: "Session",
        updatedAt: new Date(0).toISOString(),
        projectName: "Project",
        activeAgents: [activeAgent()],
        selectedAgentInstanceId: agentId,
        productionPlan: [],
        outputAssignments: [],
        liveEvents: [],
      },
    ],
    agentCatalog: {
      definitions: [
        {
          name: "default",
          description: "General agent.",
          systemPrompt: "Help.",
          tools: ["*"],
          resolvedTools: [],
          editScope: ["session"],
          skills: [],
          inputChannels: [],
          sourceFile: "default.yaml",
          fingerprint: "a".repeat(64),
        },
      ],
      skills: [],
      diagnostics: [],
    },
    eventsLoad: { status: "loaded" },
  };
}

function desktopApi(overrides: Partial<DesktopApi["agents"]> = {}): DesktopApi {
  return {
    agents: {
      listModels: vi.fn().mockResolvedValue(models),
      readPlan: vi.fn().mockResolvedValue({
        exists: false,
        productionSessionId: sessionId,
      }),
      writePlan: vi.fn(),
      resolveElicitation: vi.fn(),
      ...overrides,
    },
  } as unknown as DesktopApi;
}

function AgentHarness({ state }: { state: DesktopState }): React.JSX.Element {
  const [current, dispatch] = useReducer(desktopReducer, state);
  return (
    <>
      <ConnectionHeader state={current} dispatch={dispatch} />
      <AgentsView state={current} dispatch={dispatch} />
    </>
  );
}

function ResizeHarness(): React.JSX.Element {
  const [widths, setWidths] = useState<WorkspaceSidebarWidths>({
    left: 250,
    right: 290,
  });
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);
  return (
    <Workspace
      state={rendererState()}
      dispatch={vi.fn()}
      leftSidebarVisible={leftVisible}
      rightSidebarVisible={rightVisible}
      sidebarWidths={widths}
      onSidebarWidthChange={(side, width) =>
        setWidths((current) => ({ ...current, [side]: width }))
      }
      onToggleLeftSidebar={() => setLeftVisible((visible) => !visible)}
      onToggleRightSidebar={() => setRightVisible((visible) => !visible)}
    />
  );
}

function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientX: number,
  pointerId = 1,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: pointerId },
  });
  return event;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (match === undefined) throw new Error(`Button '${label}' not found`);
  return match;
}

async function click(container: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    button(container, label).click();
    await Promise.resolve();
  });
}

async function choose(
  container: HTMLElement,
  label: string,
  value: string,
): Promise<void> {
  const select = container.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  );
  if (select === null) throw new Error(`Select '${label}' not found`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("desktop component interactions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  it("keeps Working open while running and allows reopening after completion", async () => {
    const running = {
      activityId: "00000000-0000-4000-8000-000000000021",
      status: "running" as const,
      intent: "Inspecting the arrangement",
      summary: "Checking available clips.",
      responseStarted: true,
      startedAt: 1,
      updatedAt: 2,
    };
    await act(async () => root.render(<WorkingDisclosure working={running} />));
    const disclosure = container.querySelector("details");
    expect(disclosure?.open).toBe(true);

    await act(async () =>
      root.render(
        <WorkingDisclosure
          working={{ ...running, status: "completed", updatedAt: 3 }}
        />,
      ),
    );
    expect(disclosure?.open).toBe(false);

    await act(async () => {
      if (disclosure === null) throw new Error("Expected Working disclosure");
      disclosure.open = true;
      disclosure.dispatchEvent(new Event("toggle"));
    });
    expect(disclosure?.open).toBe(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("commits conversation settings, closes the editor, and updates both summaries", async () => {
    const updated = activeAgent({
      model: "model-b",
      reasoningEffort: "xhigh",
      sdkSessionId: "replacement-sdk",
    });
    const setConversationSettings = vi.fn().mockResolvedValue(updated);
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ setConversationSettings }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await click(container, "Edit overrides");
    await choose(container, "Model for Default", "model-b");
    await choose(container, "Reasoning for Default", "xhigh");
    await click(container, "Apply conversation settings");
    await click(container, "Start fresh Conversation");

    expect(setConversationSettings).toHaveBeenCalledWith(agentId, {
      model: "model-b",
      reasoningEffort: "xhigh",
    });
    expect(
      container.querySelector('select[aria-label="Model for Default"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Model B · model-b");
    expect(container.textContent).not.toContain("model-b · xhigh");
  });

  it("keeps the editor and draft open when conversation settings fail", async () => {
    const setConversationSettings = vi
      .fn()
      .mockRejectedValue(new Error("persistence failed"));
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ setConversationSettings }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await click(container, "Edit overrides");
    await choose(container, "Model for Default", "model-b");
    await choose(container, "Reasoning for Default", "xhigh");
    await click(container, "Apply conversation settings");
    await click(container, "Start fresh Conversation");

    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Model for Default"]',
      )?.value,
    ).toBe("model-b");
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Reasoning for Default"]',
      )?.value,
    ).toBe("xhigh");
    expect(button(container, "Start fresh Conversation").disabled).toBe(false);
  });

  it("discards unapplied conversation drafts when the editor closes", async () => {
    const setConversationSettings = vi.fn();
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ setConversationSettings }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await click(container, "Edit overrides");
    await choose(container, "Model for Default", "model-b");
    await choose(container, "Reasoning for Default", "xhigh");
    await click(container, "Close editor");
    await click(container, "Edit overrides");

    expect(setConversationSettings).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Model for Default"]',
      )?.value,
    ).toBe("model-a");
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Reasoning for Default"]',
      )?.value,
    ).toBe("high");
  });

  it("does not invoke Agent or Event mutations for stored inactive state", async () => {
    const create = vi.fn();
    const disable = vi.fn();
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        ...desktopApi({ create }),
        events: { disable },
      },
    });
    const state = rendererState(false);
    state.events = {
      events: [
        {
          definition: {
            id: "live-event.00000000-0000-4000-8000-000000000011",
            kind: "track.playing_clip_changed",
            classification: "discrete",
            name: "Keys clip",
            projectId: "project",
            enabled: true,
            target: { track: { name: "Keys", occurrence: 0 } },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
          resolution: { status: "unresolved", reason: "missing" },
          history: [],
          listeners: [],
        },
      ],
    };

    await act(async () => {
      root.render(
        <>
          <AgentsView state={state} dispatch={vi.fn()} />
          <EventsView state={state} dispatch={vi.fn()} />
        </>,
      );
      await Promise.resolve();
    });
    expect(button(container, "Create agent").disabled).toBe(true);
    expect(button(container, "Add event").disabled).toBe(true);
    expect(button(container, "Disable").disabled).toBe(true);
    await click(container, "Create agent");
    await click(container, "Add event");
    await click(container, "Disable");

    expect(create).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  it("waits for context restoration before hydrating Agent history", async () => {
    let publish!: (event: DesktopAppEvent) => void;
    const hydrateHistory = vi.fn().mockResolvedValue([]);
    const state = rendererState(false);
    const desktop = {
      lifecycle: { get: vi.fn().mockResolvedValue("ready") },
      ableton: {
        getStatus: vi.fn().mockResolvedValue({ state: "disconnected" }),
      },
      preferences: {
        get: vi.fn().mockResolvedValue(initialState.preferences),
      },
      agent: { getSessions: vi.fn().mockResolvedValue(state.sessions) },
      agents: {
        getCatalog: vi.fn().mockResolvedValue(state.agentCatalog),
        hydrateHistory,
        readPlan: vi.fn().mockResolvedValue({
          exists: false,
          productionSessionId: sessionId,
        }),
      },
      outputs: { list: vi.fn().mockResolvedValue(initialState.outputs) },
      events: {
        list: vi.fn().mockResolvedValue(initialState.events),
        subscribe: vi.fn((listener: (event: DesktopAppEvent) => void) => {
          publish = listener;
          return vi.fn();
        }),
      },
    } as unknown as DesktopApi;
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktop,
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hydrateHistory).not.toHaveBeenCalled();

    await act(async () => {
      publish({
        type: "session.context_restored",
        session: state.sessions[0]!,
      });
      await Promise.resolve();
    });
    expect(hydrateHistory).toHaveBeenCalledOnce();
    expect(hydrateHistory).toHaveBeenCalledWith(agentId);
  });

  it("reloads the shared plan when returning to a production session", async () => {
    let publish!: (event: DesktopAppEvent) => void;
    const secondAgentId = "00000000-0000-4000-8000-000000000002";
    const state = rendererState(false);
    const secondSession = {
      ...state.sessions[0]!,
      id: "second-production-session",
      title: "Second session",
      activeAgents: [activeAgent({ id: secondAgentId, label: "Second" })],
      selectedAgentInstanceId: secondAgentId,
    };
    state.sessions.push(secondSession);
    const readPlan = vi.fn().mockImplementation((instanceId: string) =>
      Promise.resolve({
        exists: true,
        productionSessionId:
          instanceId === agentId ? sessionId : secondSession.id,
        content: instanceId === agentId ? "# First plan" : "# Second plan",
        revision: instanceId === agentId ? "a".repeat(64) : "b".repeat(64),
        updatedAt: "2026-01-01T00:00:00.000Z",
        bytes: 12,
      }),
    );
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        lifecycle: { get: vi.fn().mockResolvedValue("ready") },
        ableton: {
          getStatus: vi.fn().mockResolvedValue({ state: "disconnected" }),
        },
        preferences: {
          get: vi.fn().mockResolvedValue(initialState.preferences),
        },
        agent: { getSessions: vi.fn().mockResolvedValue(state.sessions) },
        agents: {
          getCatalog: vi.fn().mockResolvedValue(state.agentCatalog),
          hydrateHistory: vi.fn().mockResolvedValue([]),
          readPlan,
        },
        outputs: { list: vi.fn().mockResolvedValue(initialState.outputs) },
        events: {
          list: vi.fn().mockResolvedValue(initialState.events),
          subscribe: vi.fn((listener: (event: DesktopAppEvent) => void) => {
            publish = listener;
            return vi.fn();
          }),
        },
      },
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      publish({
        type: "session.context_restored",
        session: state.sessions[0]!,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      publish({ type: "session.context_restored", session: secondSession });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      publish({
        type: "session.context_restored",
        session: state.sessions[0]!,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readPlan).toHaveBeenNthCalledWith(1, agentId);
    expect(readPlan).toHaveBeenNthCalledWith(2, secondAgentId);
    expect(readPlan).toHaveBeenNthCalledWith(3, agentId);
    expect(container.textContent).toContain("First plan");
  });

  it("opens the selected Agent Inspector for a plan event and submits feedback", async () => {
    let publish!: (event: DesktopAppEvent) => void;
    const resolvePlan = vi.fn().mockResolvedValue(true);
    const state = rendererState();
    const desktop = {
      lifecycle: { get: vi.fn().mockResolvedValue("ready") },
      ableton: {
        getStatus: vi.fn().mockResolvedValue({ state: "disconnected" }),
      },
      preferences: {
        get: vi.fn().mockResolvedValue(initialState.preferences),
      },
      agent: { getSessions: vi.fn().mockResolvedValue(state.sessions) },
      agents: {
        getCatalog: vi.fn().mockResolvedValue(state.agentCatalog),
        hydrateHistory: vi.fn().mockResolvedValue([]),
        resolvePlan,
        readPlan: vi.fn().mockResolvedValue({
          exists: false,
          productionSessionId: sessionId,
        }),
      },
      outputs: {
        list: vi.fn().mockResolvedValue({
          ...initialState.outputs,
          activeSessionId: sessionId,
        }),
      },
      events: {
        list: vi.fn().mockResolvedValue(initialState.events),
        subscribe: vi.fn((listener: (event: DesktopAppEvent) => void) => {
          publish = listener;
          return vi.fn();
        }),
      },
    } as unknown as DesktopApi;
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktop,
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const hideInspector = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide inspector sidebar"]',
    );
    if (hideInspector === null) throw new Error("Inspector toggle not found");
    await act(async () => hideInspector.click());
    expect(
      container.querySelector<HTMLElement>('[aria-label="Inspector workspace"]')
        ?.hidden,
    ).toBe(true);

    await act(async () => {
      publish({
        type: "agent.plan_artifact_changed",
        agentInstanceId: agentId,
        sdkSessionId: "sdk-1",
        artifact: {
          exists: true,
          productionSessionId: sessionId,
          content: "# Plan\n\nBuild an intro.",
          revision: "a".repeat(64),
          updatedAt: "2026-01-01T00:00:00.000Z",
          bytes: 31,
        },
      });
      publish({
        type: "agent.plan_approval_requested",
        agentInstanceId: agentId,
        sdkSessionId: "sdk-1",
        request: {
          requestId: "plan-1",
          summary: "Arrangement plan",
          planContent: "# Plan\n\nBuild an intro.",
          planRevision: "a".repeat(64),
          planUpdatedAt: "2026-01-01T00:00:00.000Z",
          recommendedAction: "interactive",
          actions: ["interactive", "exit_only"],
        },
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLElement>('[aria-label="Inspector workspace"]')
        ?.hidden,
    ).toBe(false);
    expect(container.textContent).not.toContain("Arrangement plan");
    expect(container.textContent).toContain("Review plan.md");
    expect(container.textContent).toContain("Build an intro.");
    expect(button(container, "Approve and continue").disabled).toBe(false);
    expect(button(container, "Exit plan mode").disabled).toBe(false);

    const feedback = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="Describe what should change"]',
    );
    if (feedback === null) throw new Error("Plan feedback field not found");
    await act(async () => {
      feedback.setRangeText(
        "Use fewer tracks",
        0,
        feedback.value.length,
        "end",
      );
      feedback.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(button(container, "Request changes").disabled).toBe(false);
    await click(container, "Request changes");
    expect(resolvePlan).toHaveBeenCalledWith(agentId, {
      requestId: "plan-1",
      approved: false,
      planRevision: "a".repeat(64),
      feedback: "Use fewer tracks",
    });

    await act(async () => {
      publish({
        type: "agent.plan_approval_completed",
        agentInstanceId: agentId,
        sdkSessionId: "sdk-1",
        requestId: "plan-1",
        approved: false,
        feedback: "Use fewer tracks",
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Arrangement plan");
  });

  it("keeps a stale plan visible after resolution failure and prevents double submission", async () => {
    let publish!: (event: DesktopAppEvent) => void;
    let finishFirst!: (resolved: boolean) => void;
    const firstResolution = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });

    const resolvePlan = vi
      .fn()
      .mockImplementationOnce(() => firstResolution)
      .mockResolvedValueOnce(true);
    const state = rendererState();
    const desktop = {
      lifecycle: { get: vi.fn().mockResolvedValue("ready") },
      ableton: {
        getStatus: vi.fn().mockResolvedValue({ state: "disconnected" }),
      },
      preferences: {
        get: vi.fn().mockResolvedValue(initialState.preferences),
      },
      agent: { getSessions: vi.fn().mockResolvedValue(state.sessions) },
      agents: {
        getCatalog: vi.fn().mockResolvedValue(state.agentCatalog),
        hydrateHistory: vi.fn().mockResolvedValue([]),
        resolvePlan,
        readPlan: vi.fn().mockResolvedValue({
          exists: false,
          productionSessionId: sessionId,
        }),
      },
      outputs: {
        list: vi.fn().mockResolvedValue({
          ...initialState.outputs,
          activeSessionId: sessionId,
        }),
      },
      events: {
        list: vi.fn().mockResolvedValue(initialState.events),
        subscribe: vi.fn((listener: (event: DesktopAppEvent) => void) => {
          publish = listener;
          return vi.fn();
        }),
      },
    } as unknown as DesktopApi;
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktop,
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      publish({
        type: "agent.plan_approval_requested",
        agentInstanceId: agentId,
        sdkSessionId: "sdk-1",
        request: {
          requestId: "plan-stale",
          summary: "Pending plan",
          planContent: "Wait for approval.",
          planRevision: "a".repeat(64),
          planUpdatedAt: "2026-01-01T00:00:00.000Z",
          recommendedAction: "interactive",
          actions: ["interactive"],
        },
      });
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Exit plan mode");
    const approve = button(container, "Approve and continue");
    await act(async () => {
      approve.click();
      approve.click();
      await Promise.resolve();
    });
    expect(resolvePlan).toHaveBeenCalledTimes(1);
    expect(approve.disabled).toBe(true);

    await act(async () => {
      finishFirst(false);
      await firstResolution;
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      "This plan request is no longer pending.",
    );
    expect(container.textContent).not.toContain("Pending plan");
    expect(container.textContent).toContain("Review plan.md");
    expect(button(container, "Approve and continue").disabled).toBe(false);
    await click(container, "Approve and continue");
    expect(resolvePlan).toHaveBeenCalledTimes(2);
  });

  it("prioritizes structured questions and preserves the ordinary composer draft", async () => {
    const resolveElicitation = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ resolveElicitation }),
    });
    const state = rendererState();
    state.agentWorkspaces[agentId] = {
      messages: [],
      operations: [],
      triggers: [],
      planApproval: {
        requestId: "plan-1",
        summary: "Plan ready",
        planContent: "# Plan",
        planRevision: "a".repeat(64),
        planUpdatedAt: "2026-01-01T00:00:00.000Z",
        recommendedAction: "interactive",
        actions: ["interactive"],
      },
      elicitation: {
        requestId: "question-1",
        message: "Choose the arrangement style.",
        properties: {
          style: {
            type: "string",
            title: "Style",
            enum: ["compact", "extended"],
            allowFreeform: true,
            minLength: 1,
            maxLength: 8_192,
          },
          normalize: {
            type: "boolean",
            title: "Normalize",
          },
        },
        required: ["style", "normalize"],
      },
    };
    const composerRef = createRef<HTMLTextAreaElement>();
    await act(async () => {
      root.render(
        <DesktopComposer
          state={state}
          composerRef={composerRef}
          dispatch={vi.fn()}
          value="preserve this draft"
          error=""
          onValueChange={vi.fn()}
          onErrorChange={vi.fn()}
          planEditorOpen
          onPlanEditorClose={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("Choose the arrangement style.");
    expect(container.textContent).not.toContain("Review plan.md");
    const compact = container.querySelector<HTMLInputElement>(
      'input[type="radio"][value="compact"]',
    );
    if (compact === null) throw new Error("Style option not found");
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Custom answer for Style"]',
      ),
    ).not.toBeNull();
    await act(async () => {
      compact.click();
    });
    await click(container, "Submit response");
    expect(resolveElicitation).toHaveBeenCalledWith(agentId, {
      requestId: "question-1",
      action: "accept",
      content: { style: "compact", normalize: false },
    });

    const completed = desktopReducer(state, {
      type: "event",
      event: {
        type: "agent.elicitation_completed",
        requestId: "question-1",
        action: "accept",
        agentInstanceId: agentId,
        sdkSessionId: "sdk-1",
      },
    });
    completed.agentWorkspaces[agentId] = {
      ...completed.agentWorkspaces[agentId]!,
      planApproval: undefined,
    };
    await act(async () => {
      root.render(
        <DesktopComposer
          state={completed}
          composerRef={composerRef}
          dispatch={vi.fn()}
          value="preserve this draft"
          error=""
          onValueChange={vi.fn()}
          onErrorChange={vi.fn()}
        />,
      );
    });
    expect(container.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe(
      "preserve this draft",
    );
  });

  it("submits a custom radio answer and resizes the question panel upward", async () => {
    const resolveElicitation = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ resolveElicitation }),
    });
    const state = rendererState();
    state.agentWorkspaces[agentId] = {
      messages: [],
      operations: [],
      triggers: [],
      elicitation: {
        requestId: "question-custom",
        message: "Choose the groove.",
        properties: {
          groove: {
            type: "string",
            title: "Groove",
            enum: ["straight", "swung"],
            allowFreeform: true,
            minLength: 1,
            maxLength: 8_192,
          },
        },
        required: ["groove"],
      },
    };
    await act(async () => {
      root.render(
        <DesktopComposer
          state={state}
          composerRef={createRef<HTMLTextAreaElement>()}
          dispatch={vi.fn()}
          value="ordinary draft"
          error=""
          onValueChange={vi.fn()}
          onErrorChange={vi.fn()}
        />,
      );
    });
    const custom = container.querySelector<HTMLInputElement>(
      'input[aria-label="Custom answer for Groove"]',
    );
    if (custom === null) throw new Error("Custom answer not found");
    await act(async () => {
      custom.setRangeText("Loose pocket", 0, custom.value.length, "end");
      custom.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container, "Submit response");
    expect(resolveElicitation).toHaveBeenCalledWith(agentId, {
      requestId: "question-custom",
      action: "accept",
      content: { groove: "Loose pocket" },
    });

    const deck = container.querySelector<HTMLElement>(".elicitation-deck");
    const handle = container.querySelector<HTMLElement>(
      ".interaction-resize-handle",
    );
    if (deck === null || handle === null) {
      throw new Error("Resizable question panel not found");
    }
    vi.spyOn(deck, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 240,
      top: 460,
      right: 800,
      bottom: 700,
      left: 0,
      x: 0,
      y: 460,
      toJSON: () => ({}),
    });
    await act(async () => {
      const down = pointerEvent("pointerdown", 0, 9);
      Object.defineProperty(down, "clientY", { value: 460 });
      handle.dispatchEvent(down);
      const move = pointerEvent("pointermove", 0, 9);
      Object.defineProperty(move, "clientY", { value: 400 });
      handle.dispatchEvent(move);
      handle.dispatchEvent(pointerEvent("pointerup", 0, 9));
    });
    expect(deck.style.height).toBe("300px");
  });

  it("edits plan Markdown with optimistic revision checks in the composer", async () => {
    const writePlan = vi.fn().mockResolvedValue({
      exists: true,
      productionSessionId: sessionId,
      content: "# Revised plan",
      revision: "b".repeat(64),
      updatedAt: "2026-01-01T00:01:00.000Z",
      bytes: 14,
    });
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ writePlan }),
    });
    const state = rendererState();
    state.agentWorkspaces[agentId] = {
      messages: [],
      operations: [],
      triggers: [],
      planArtifact: {
        exists: true,
        productionSessionId: sessionId,
        content: "# Original plan",
        revision: "a".repeat(64),
        updatedAt: "2026-01-01T00:00:00.000Z",
        bytes: 15,
      },
    };
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <DesktopComposer
          state={state}
          composerRef={createRef<HTMLTextAreaElement>()}
          dispatch={vi.fn()}
          value="ordinary draft"
          error=""
          onValueChange={vi.fn()}
          onErrorChange={vi.fn()}
          planEditorOpen
          onPlanEditorClose={onClose}
        />,
      );
    });
    const editor = container.querySelector<HTMLTextAreaElement>(
      "#plan-markdown-editor",
    );
    if (editor === null) throw new Error("Plan editor not found");
    await act(async () => {
      editor.setRangeText("# Revised plan", 0, editor.value.length, "end");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const remotelyUpdatedState: DesktopState = {
      ...state,
      agentWorkspaces: {
        ...state.agentWorkspaces,
        [agentId]: {
          ...state.agentWorkspaces[agentId],
          planArtifact: {
            exists: true,
            productionSessionId: sessionId,
            content: "# Remote plan",
            revision: "b".repeat(64),
            updatedAt: "2026-01-01T00:01:00.000Z",
            bytes: 13,
          },
        },
      },
    };
    await act(async () => {
      root.render(
        <DesktopComposer
          state={remotelyUpdatedState}
          composerRef={createRef<HTMLTextAreaElement>()}
          dispatch={vi.fn()}
          value="ordinary draft"
          error=""
          onValueChange={vi.fn()}
          onErrorChange={vi.fn()}
          planEditorOpen
          onPlanEditorClose={onClose}
        />,
      );
    });
    expect(
      container.querySelector<HTMLTextAreaElement>("#plan-markdown-editor")
        ?.value,
    ).toBe("# Revised plan");
    await click(container, "Save plan.md");
    expect(writePlan).toHaveBeenCalledWith(agentId, {
      content: "# Revised plan",
      expectedRevision: "a".repeat(64),
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("switches, closes, and re-adds modular inspector views", async () => {
    const state = rendererState();
    state.agentWorkspaces[agentId] = {
      messages: [],
      operations: [],
      triggers: [],
      planArtifact: {
        exists: true,
        productionSessionId: sessionId,
        content: "# Plan\n\nArrange the chorus.",
        revision: "a".repeat(64),
        updatedAt: "2026-01-01T00:00:00.000Z",
        bytes: 28,
      },
      approval: {
        id: "approval-1",
        title: "Create clips",
        risk: "medium",
        summary: "Create two arrangement clips.",
        changes: ["Create clips"],
        destructive: false,
      },
    };
    await act(async () => {
      root.render(<Inspector state={state} dispatch={vi.fn()} />);
    });
    expect(container.textContent).toContain("Arrange the chorus.");
    const approvalTab = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Approval"]',
    );
    if (approvalTab === null) throw new Error("Approval tab not found");
    await act(async () => approvalTab.click());
    expect(container.textContent).toContain("Create two arrangement clips.");

    const closeApproval = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close Approval"]',
    );
    if (closeApproval === null) throw new Error("Approval close not found");
    await act(async () => closeApproval.click());
    expect(container.querySelector('button[aria-label="Approval"]')).toBeNull();
    const add = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add inspector view"]',
    );
    if (add === null) throw new Error("Inspector add button not found");
    await act(async () => add.click());
    await click(container, "Approval");
    expect(
      container.querySelector('button[aria-label="Approval"]'),
    ).not.toBeNull();
  });

  it("drags each sidebar independently and restores the session width after hiding", async () => {
    await act(async () => {
      root.render(<ResizeHarness />);
      await Promise.resolve();
    });
    const workspace = container.querySelector<HTMLElement>(".workspace");
    if (workspace === null) throw new Error("Workspace not found");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      width: 1_200,
      height: 700,
      top: 0,
      right: 1_200,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const leftHandle = container.querySelector<HTMLElement>(
      ".sidebar-resize-handle-left",
    );
    const rightHandle = container.querySelector<HTMLElement>(
      ".sidebar-resize-handle-right",
    );
    if (leftHandle === null || rightHandle === null) {
      throw new Error("Resize handles not found");
    }

    await act(async () => {
      leftHandle.dispatchEvent(pointerEvent("pointerdown", 250));
      leftHandle.dispatchEvent(pointerEvent("pointermove", 330));
      leftHandle.dispatchEvent(pointerEvent("pointerup", 330));
      await Promise.resolve();
    });
    expect(workspace.style.getPropertyValue("--project-sidebar-width")).toBe(
      "330px",
    );
    expect(workspace.style.getPropertyValue("--inspector-sidebar-width")).toBe(
      "290px",
    );

    await act(async () => {
      rightHandle.dispatchEvent(pointerEvent("pointerdown", 910, 2));
      rightHandle.dispatchEvent(pointerEvent("pointermove", 830, 2));
      rightHandle.dispatchEvent(pointerEvent("pointercancel", 830, 2));
      rightHandle.dispatchEvent(pointerEvent("pointermove", 700, 2));
      await Promise.resolve();
    });
    expect(workspace.style.getPropertyValue("--inspector-sidebar-width")).toBe(
      "370px",
    );

    const hideProject = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide project sidebar"]',
    );
    if (hideProject === null) throw new Error("Project toggle not found");
    await act(async () => hideProject.click());
    expect(container.querySelector(".sidebar-resize-handle-left")).toBeNull();
    const showProject = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show project sidebar"]',
    );
    if (showProject === null)
      throw new Error("Project restore toggle not found");
    await act(async () => showProject.click());
    expect(workspace.style.getPropertyValue("--project-sidebar-width")).toBe(
      "330px",
    );
  });
});
