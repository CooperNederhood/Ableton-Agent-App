// @vitest-environment jsdom

import { act, useReducer, useState } from "react";
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
  EventsView,
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
    expect(container.textContent).toContain("model-b · xhigh");
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
      container.querySelector('[aria-label="Selection inspector"]'),
    ).toBeNull();

    await act(async () => {
      publish({
        type: "agent.plan_approval_requested",
        agentInstanceId: agentId,
        sdkSessionId: "sdk-1",
        request: {
          requestId: "plan-1",
          summary: "Arrangement plan",
          planContent: "# Plan\n\nBuild an intro.",
          recommendedAction: "interactive",
          actions: ["interactive", "exit_only"],
        },
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[aria-label="Selection inspector"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Arrangement plan");
    expect(container.textContent).toContain("Build an intro.");
    expect(button(container, "Approve and continue").disabled).toBe(false);
    expect(button(container, "Exit plan mode").disabled).toBe(false);

    const feedback = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="Describe what the plan should change"]',
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
    expect(container.textContent).toContain("Pending plan");
    expect(button(container, "Approve and continue").disabled).toBe(false);
    await click(container, "Approve and continue");
    expect(resolvePlan).toHaveBeenCalledTimes(2);
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
