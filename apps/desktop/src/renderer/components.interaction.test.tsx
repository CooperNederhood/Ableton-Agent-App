// @vitest-environment jsdom

import { act, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopActiveAgent,
  DesktopAgentModel,
  DesktopApi,
  DesktopAppEvent,
} from "../contracts";
import { App, AgentsView, ConnectionHeader, EventsView } from "./App";
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
        mode: "explore",
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
});
