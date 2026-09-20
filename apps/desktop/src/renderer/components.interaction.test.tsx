// @vitest-environment jsdom

import { act, createRef, useReducer, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentAgentDefinition } from "@ableton-agent/agent-config/schemas";

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
      revision: "1".repeat(64),
      definitions: [
        {
          version: 2,
          name: "default",
          label: "Default",
          description: "General agent.",
          systemPrompt: "Help.",
          tools: ["*"],
          resolvedTools: [],
          editScope: ["session"],
          skills: [],
          inputChannels: [],
          model: "model-a",
          reasoningEffort: "high",
          autoApprove: false,
          eventListeners: [],
          origin: "bundled",
          inherited: true,
          overrides: [],
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

function desktopApi(
  overrides: Partial<DesktopApi["agents"]> = {},
  profileOverrides: Partial<DesktopApi["profiles"]> = {},
): DesktopApi {
  return {
    agents: {
      listModels: vi.fn().mockResolvedValue(models),
      saveDefinition: vi.fn(),
      readPlan: vi.fn().mockResolvedValue({
        exists: false,
        productionSessionId: sessionId,
      }),
      writePlan: vi.fn(),
      resolveElicitation: vi.fn(),
      ...overrides,
    },
    profiles: {
      get: vi.fn().mockResolvedValue({ revision: "a".repeat(64) }),
      status: vi.fn().mockResolvedValue({
        revision: "a".repeat(64),
        activeProfile: "default",
        profiles: [
          {
            name: "default",
            active: true,
            reserved: false,
          },
        ],
      }),
      ...profileOverrides,
    },
  } as unknown as DesktopApi;
}

function AgentHarness({
  state,
  onProfilesChanged,
}: {
  state: DesktopState;
  onProfilesChanged?: (() => void) | undefined;
}): React.JSX.Element {
  const [current, dispatch] = useReducer(desktopReducer, state);
  return (
    <>
      <ConnectionHeader state={current} dispatch={dispatch} />
      <AgentsView
        state={current}
        dispatch={dispatch}
        onProfilesChanged={onProfilesChanged}
      />
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

async function clickAria(container: HTMLElement, label: string): Promise<void> {
  const control = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (control === null) throw new Error(`Button '${label}' not found`);
  await act(async () => {
    control.click();
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

async function replaceText(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    control.setRangeText(value, 0, control.value.length, "end");
    control.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("saves conversation defaults into the Session definition", async () => {
    const state = rendererState();
    const savedDefinition = {
      ...state.agentCatalog.definitions[0]!,
      model: "model-b",
      reasoningEffort: "xhigh" as const,
      origin: "session" as const,
      inherited: false,
      overrides: ["bundled" as const],
      fingerprint: "b".repeat(64),
    };
    const saveDefinition = vi.fn().mockResolvedValue({
      catalog: {
        ...state.agentCatalog,
        revision: "2".repeat(64),
        definitions: [savedDefinition],
      },
      profileSnapshot: {},
    });
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(<AgentHarness state={state} />);
      await Promise.resolve();
    });
    await choose(container, "Model for Default", "model-b");
    await choose(container, "Reasoning for Default", "xhigh");
    const save = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".agent-detail:not([hidden]) .agent-detail-actions button",
      ),
    ].find(
      (candidate) =>
        candidate.textContent?.trim() === "Save Session definition",
    );
    if (save === undefined) throw new Error("Definition save not found");
    await act(async () => save.click());

    expect(saveDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        name: "default",
        model: "model-b",
        reasoningEffort: "xhigh",
      }),
      "a".repeat(64),
      "a".repeat(64),
    );
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Model for Default"]',
      )?.value,
    ).toBe("model-b");
    expect(container.textContent).toContain("session · default.yaml");
  });

  it("keeps the editor and draft open when definition saving fails", async () => {
    const saveDefinition = vi
      .fn()
      .mockRejectedValue(new Error("persistence failed"));
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await choose(container, "Model for Default", "model-b");
    await choose(container, "Reasoning for Default", "xhigh");
    await click(container, "Save Session definition");

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
    expect(button(container, "Save Session definition").disabled).toBe(false);
  });

  it("discards unapplied conversation drafts", async () => {
    const saveDefinition = vi.fn();
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await choose(container, "Model for Default", "model-b");
    await choose(container, "Reasoning for Default", "xhigh");
    await click(container, "Discard changes");

    expect(saveDefinition).not.toHaveBeenCalled();
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

  it("switches semantic detail tabs and preserves per-agent drafts", async () => {
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi(),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await clickAria(container, "Capabilities");
    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Session prompt for Default"]',
    );
    if (prompt === null) throw new Error("Expected session prompt editor");
    await act(async () => {
      prompt.setRangeText("Keep this draft", 0, prompt.value.length, "end");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickAria(container, "Connections");
    expect(
      container.querySelector(
        'textarea[aria-label="Input channels for Default"]',
      ),
    ).not.toBeNull();
    await clickAria(container, "Capabilities");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Session prompt for Default"]',
      )?.value,
    ).toBe("Keep this draft");
  });

  it("lists active instances first and creates from an inactive definition", async () => {
    const state = rendererState();
    state.sessions[0]!.activeAgents.push(
      activeAgent({
        id: "00000000-0000-4000-8000-000000000002",
        label: "Default 2",
      }),
    );
    state.agentCatalog.definitions.push({
      version: 2,
      name: "compose",
      label: "Compose",
      description: "Composition agent.",
      systemPrompt: "Compose.",
      tools: ["*"],
      resolvedTools: [],
      editScope: ["session"],
      skills: [],
      inputChannels: [],
      model: null,
      reasoningEffort: null,
      autoApprove: false,
      eventListeners: [],
      origin: "bundled",
      inherited: true,
      overrides: [],
      sourceFile: "compose.yaml",
      fingerprint: "b".repeat(64),
    });
    const created = activeAgent({
      id: "00000000-0000-4000-8000-000000000003",
      definitionName: "compose",
      definitionFingerprint: "b".repeat(64),
      label: "Compose",
      config: {
        ...activeAgent().config,
        description: "Composition agent.",
        systemPrompt: "Compose.",
      },
    });
    const create = vi.fn().mockResolvedValue(created);
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ create }),
    });

    await act(async () => {
      root.render(<AgentHarness state={state} />);
      await Promise.resolve();
    });
    const navigationItems = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".agent-navigation-item",
      ),
    ];
    expect(navigationItems.map((item) => item.textContent)).toEqual([
      "Defaultdefault",
      "Default 2default",
      "composeComposition agent.",
    ]);
    expect(
      navigationItems.map((item) =>
        item
          .querySelector(".agent-activity-light")
          ?.classList.contains("is-active"),
      ),
    ).toEqual([true, true, false]);

    await act(async () => {
      navigationItems[2]!.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector(".agent-detail:not([hidden]) h3")?.textContent,
    ).toBe("Compose");
    await click(container, "Create agent");
    expect(create).toHaveBeenCalledWith("compose");
    expect(
      container.querySelector(".agent-detail:not([hidden]) h3")?.textContent,
    ).toBe("Compose");
  });

  it("saves a complete inactive definition and refreshes Profiles", async () => {
    const state = rendererState();
    const eventId = "live-event.00000000-0000-4000-8000-000000000011";
    state.sessions[0]!.liveEvents = [
      {
        id: eventId,
        kind: "track.playing_clip_changed",
        classification: "discrete",
        name: "Keys clip",
        projectId: "project",
        enabled: true,
        target: { track: { name: "Keys", occurrence: 0 } },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ];
    state.events.events = [
      {
        definition: state.sessions[0]!.liveEvents[0]!,
        resolution: { status: "unresolved", reason: "missing" },
        history: [],
        listeners: [],
      },
    ];
    state.agentCatalog.definitions.push({
      version: 2,
      name: "compose",
      label: "Compose",
      description: "Composition agent.",
      systemPrompt: "Compose.",
      tools: ["*"],
      resolvedTools: [],
      editScope: ["session"],
      skills: [],
      inputChannels: [],
      model: null,
      reasoningEffort: null,
      autoApprove: false,
      eventListeners: [],
      origin: "profile",
      inherited: true,
      overrides: ["bundled"],
      sourceFile: "compose.yaml",
      fingerprint: "b".repeat(64),
    });
    const saveDefinition = vi.fn().mockResolvedValue({
      catalog: {
        ...state.agentCatalog,
        revision: "2".repeat(64),
        definitions: state.agentCatalog.definitions.map((definition) =>
          definition.name === "compose"
            ? {
                ...definition,
                origin: "session" as const,
                fingerprint: "c".repeat(64),
              }
            : definition,
        ),
      },
      profileSnapshot: {},
    });
    const onProfilesChanged = vi.fn();
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(
        <AgentHarness state={state} onProfilesChanged={onProfilesChanged} />,
      );
      await Promise.resolve();
    });
    const inactive = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".agent-navigation-item",
      ),
    ].find((candidate) => candidate.textContent?.includes("compose"));
    if (inactive === undefined) throw new Error("Inactive agent not found");
    await act(async () => inactive.click());
    await choose(container, "Model for Compose", "model-b");
    await choose(container, "Reasoning for Compose", "xhigh");
    const visibleDetail = container.querySelector<HTMLElement>(
      ".agent-detail:not([hidden])",
    );
    if (visibleDetail === null) throw new Error("Definition detail not found");
    const automaticApproval = [
      ...visibleDetail.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ].find((input) =>
      input.parentElement?.textContent?.includes(
        "Automatically approve eligible tool requests",
      ),
    );
    if (automaticApproval === undefined) {
      throw new Error("Automatic approval control not found");
    }
    await act(async () => automaticApproval.click());
    const connectionsTab = visibleDetail.querySelector<HTMLButtonElement>(
      'button[aria-label="Connections"]',
    );
    if (connectionsTab === null) throw new Error("Connections tab not found");
    await act(async () => connectionsTab.click());
    const visibleConnections = container.querySelector<HTMLElement>(
      ".agent-detail:not([hidden])",
    );
    if (visibleConnections === null) {
      throw new Error("Definition connections not found");
    }
    const listen = [
      ...visibleConnections.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ),
    ].find((input) => input.parentElement?.textContent?.includes("Keys clip"));
    if (listen === undefined) throw new Error("Listening event not found");
    await act(async () => listen.click());
    const inactiveSave = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".agent-detail:not([hidden]) .agent-detail-actions button",
      ),
    ].find(
      (candidate) =>
        candidate.textContent?.trim() === "Save Session definition",
    );
    if (inactiveSave === undefined)
      throw new Error("Definition save not found");
    await act(async () => inactiveSave.click());

    expect(saveDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        name: "compose",
        label: "Compose",
        model: "model-b",
        reasoningEffort: "xhigh",
        autoApprove: true,
        eventListeners: [
          expect.objectContaining({
            eventId,
            enabled: true,
            responseMode: "next-prompt",
          }),
        ],
      }),
      "a".repeat(64),
      "b".repeat(64),
    );
    expect(onProfilesChanged).toHaveBeenCalledOnce();
  });

  it("omits a cleared listener prefix from the saved definition", async () => {
    const state = rendererState();
    const eventId = "live-event.00000000-0000-4000-8000-000000000011";
    const listener = {
      id: "event-listener.00000000-0000-4000-8000-000000000012",
      eventId,
      enabled: true,
      responseMode: "automatic" as const,
      messagePrefix: "Old prefix",
    };
    state.sessions[0]!.liveEvents = [
      {
        id: eventId,
        kind: "track.playing_clip_changed",
        classification: "discrete",
        name: "Keys clip",
        projectId: "project",
        enabled: true,
        target: { track: { name: "Keys", occurrence: 0 } },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ];
    state.events.events = [
      {
        definition: state.sessions[0]!.liveEvents[0]!,
        resolution: { status: "unresolved", reason: "missing" },
        history: [],
        listeners: [],
      },
    ];
    state.agentCatalog.definitions[0]!.eventListeners = [listener];
    const saveDefinition = vi.fn().mockResolvedValue({
      catalog: {
        ...state.agentCatalog,
        revision: "2".repeat(64),
        definitions: [
          {
            ...state.agentCatalog.definitions[0]!,
            fingerprint: "b".repeat(64),
          },
        ],
      },
      profileSnapshot: {},
    });
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(<AgentHarness state={state} />);
      await Promise.resolve();
    });
    await clickAria(container, "Connections");
    const prefix = container.querySelector<HTMLTextAreaElement>(
      ".agent-detail:not([hidden]) .listening-event-settings textarea",
    );
    if (prefix === null) throw new Error("Listener prefix not found");
    await replaceText(prefix, "");
    await click(container, "Save Session definition");

    const saved = saveDefinition.mock.calls[0]?.[0] as CurrentAgentDefinition;
    expect(saved.eventListeners[0]).not.toHaveProperty("messagePrefix");
  });

  it("saves editable capability and connection fields from one detail workspace", async () => {
    const state = rendererState();
    const saveDefinition = vi.fn().mockResolvedValue({
      catalog: {
        ...state.agentCatalog,
        revision: "2".repeat(64),
        definitions: [
          {
            ...state.agentCatalog.definitions[0]!,
            systemPrompt: "Arrange carefully.",
            tools: ["ableton_session_inspect"],
            inputChannels: ["midi:keys"],
            origin: "session" as const,
            fingerprint: "b".repeat(64),
          },
        ],
      },
      profileSnapshot: {},
    });
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(<AgentHarness state={state} />);
      await Promise.resolve();
    });
    await clickAria(container, "Capabilities");
    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Session prompt for Default"]',
    );
    const tools = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Tool patterns for Default"]',
    );
    if (prompt === null || tools === null) {
      throw new Error("Expected capability editors");
    }
    await replaceText(prompt, "Arrange carefully.");
    await replaceText(tools, "ableton_session_inspect");
    await clickAria(container, "Connections");
    const inputs = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Input channels for Default"]',
    );
    if (inputs === null) throw new Error("Expected input channel editor");
    await replaceText(inputs, "midi:keys");
    await click(container, "Save Session definition");

    expect(saveDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "Arrange carefully.",
        tools: ["ableton_session_inspect"],
        editScope: ["session"],
        skills: [],
        inputChannels: ["midi:keys"],
      }),
      "a".repeat(64),
      "a".repeat(64),
    );
  });

  it("keeps capability drafts available when definition saving fails", async () => {
    const saveDefinition = vi
      .fn()
      .mockRejectedValue(new Error("configuration persistence failed"));
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ saveDefinition }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await clickAria(container, "Capabilities");
    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Session prompt for Default"]',
    );
    if (prompt === null) throw new Error("Expected capability editor");
    await replaceText(prompt, "Keep failed draft");
    await click(container, "Save Session definition");

    expect(saveDefinition).toHaveBeenCalledOnce();
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Session prompt for Default"]',
      )?.value,
    ).toBe("Keep failed draft");
    expect(button(container, "Save Session definition").disabled).toBe(false);
  });

  it("keeps reset confirmation and deactivation scoped to the inspected instance", async () => {
    const reset = vi.fn().mockResolvedValue(
      activeAgent({
        config: {
          ...activeAgent().config,
          systemPrompt: "Reset prompt.",
        },
      }),
    );
    const deactivate = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi({ reset, deactivate }),
    });

    await act(async () => {
      root.render(<AgentHarness state={rendererState()} />);
      await Promise.resolve();
    });
    await click(container, "Reset to current definition");
    expect(reset).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Confirm reset");
    await click(container, "Keep current conversation");
    expect(container.textContent).not.toContain("Confirm reset");
    await click(container, "Reset to current definition");
    await click(container, "Confirm reset");
    expect(reset).toHaveBeenCalledWith(agentId);
    await clickAria(container, "Capabilities");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Session prompt for Default"]',
      )?.value,
    ).toBe("Help.");

    await click(container, "Deactivate");
    expect(deactivate).toHaveBeenCalledWith(agentId);
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

  it("renders the composer only in Workspace and preserves its draft", async () => {
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
        readPlan: vi.fn().mockResolvedValue({
          exists: false,
          productionSessionId: sessionId,
        }),
        listModels: vi.fn().mockResolvedValue(models),
      },
      outputs: {
        list: vi.fn().mockResolvedValue({
          ...initialState.outputs,
          activeSessionId: sessionId,
        }),
      },
      events: {
        list: vi.fn().mockResolvedValue(initialState.events),
        subscribe: vi.fn(() => vi.fn()),
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
    const prompt = container.querySelector<HTMLTextAreaElement>("#prompt");
    if (prompt === null) throw new Error("Expected Workspace composer");
    await replaceText(prompt, "Preserve this workspace draft");

    for (const view of ["Agents", "Outputs", "Events", "Settings"]) {
      await click(container, view);
      expect(container.querySelector("#prompt")).toBeNull();
    }

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(container.querySelector<HTMLTextAreaElement>("#prompt")?.value).toBe(
      "Preserve this workspace draft",
    );
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>("#prompt"),
    );
  });

  it("routes only selected-agent interactions and focuses the structured deck", async () => {
    let publish!: (event: DesktopAppEvent) => void;
    const state = rendererState();
    const backgroundAgentId = "00000000-0000-4000-8000-000000000002";
    state.sessions[0]!.activeAgents.push(
      activeAgent({ id: backgroundAgentId, label: "Background" }),
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
          readPlan: vi.fn().mockResolvedValue({
            exists: false,
            productionSessionId: sessionId,
          }),
          listModels: vi.fn().mockResolvedValue(models),
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
      },
    });

    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await click(container, "Outputs");
    const request = {
      requestId: "plan-routing",
      summary: "Review routing",
      planContent: "# Plan",
      planRevision: "a".repeat(64),
      planUpdatedAt: "2026-01-01T00:00:00.000Z",
      recommendedAction: "interactive" as const,
      actions: ["interactive" as const],
    };
    await act(async () => {
      publish({
        type: "agent.plan_approval_requested",
        agentInstanceId: backgroundAgentId,
        request,
      });
      await Promise.resolve();
    });
    expect(button(container, "Outputs").classList.contains("selected")).toBe(
      true,
    );

    await act(async () => {
      publish({
        type: "agent.plan_approval_requested",
        agentInstanceId: agentId,
        request: { ...request, requestId: "plan-selected" },
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(button(container, "Workspace").classList.contains("selected")).toBe(
      true,
    );
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>(
        "textarea[data-workspace-interaction-focus]",
      ),
    );
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

  it("waits for an actionable lifecycle before loading the shared plan", async () => {
    let publish!: (event: DesktopAppEvent) => void;
    const state = rendererState();
    const readPlan = vi.fn().mockResolvedValue({
      exists: false,
      productionSessionId: sessionId,
    });
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: {
        lifecycle: { get: vi.fn().mockResolvedValue("starting") },
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
    expect(readPlan).not.toHaveBeenCalled();

    await act(async () => {
      publish({ type: "lifecycle.changed", state: "ready" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(readPlan).toHaveBeenCalledOnce();
    expect(readPlan).toHaveBeenCalledWith(agentId);
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
    await click(container, "Agents");
    expect(container.querySelector("#prompt")).toBeNull();

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
    expect(button(container, "Agents").classList.contains("selected")).toBe(
      true,
    );
    expect(container.querySelector("#prompt")).toBeNull();
    await click(container, "Workspace");
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
  it("confirms and closes the active session when switching profiles", async () => {
    const switchProfile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: desktopApi(
        {},
        {
          status: vi.fn().mockResolvedValue({
            revision: "b".repeat(64),
            activeProfile: "default",
            activeSessionId: sessionId,
            profiles: [
              { name: "default", active: true, reserved: false },
              { name: "ambient", active: false, reserved: false },
            ],
          }),
          switch: switchProfile,
        },
      ),
    });
    const state = rendererState();
    await act(async () => {
      root.render(<AgentHarness state={state} />);
    });

    await choose(container, "Active Profile", "ambient");
    expect(container.textContent).toContain(
      "The active session will be saved and closed",
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Switch")
        ?.click(),
    );

    expect(switchProfile).toHaveBeenCalledWith("ambient", "b".repeat(64), true);
  });
});
