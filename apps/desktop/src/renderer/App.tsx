import {
  InvalidSkillInvocationError,
  parseSkillInvocation,
  type SkillInvocation,
} from "@ableton-agent/agent-config/skill-invocation";
import { DEFAULT_LISTENING_TIMING_POLICY } from "@ableton-agent/protocol";
import {
  type CurrentAgentDefinition,
  AGENT_COLOR_PALETTE,
  defaultAgentColor,
} from "@ableton-agent/agent-config/schemas";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  ContextChip,
  DesktopApi,
  DesktopActiveAgent,
  DesktopAgentArtifactReviewRequest,
  DesktopAgentArtifactScope,
  DesktopAgentDefinition,
  DesktopAgentModel,
  DesktopArtifactScope,
  DesktopCopilotAuthStatus,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopOutputAssignment,
  DesktopOutputConnection,
  DesktopLiveSetSnapshot,
  DesktopProfileStatus,
  DesktopSkillDocument,
  DesktopLiveEventState,
  LatestAcceptedOutput,
  DesktopTrack,
  ConfigurationSnapshotPage,
  RootTracePage,
  RootTraceQuery,
  TelemetryEventPage,
  LiveEventDefinitionDraft,
  PlanSection,
} from "../contracts";
import { Icon, type IconName } from "./Icon";
import {
  AssistantMarkdown,
  formatPlanMarkdownForDisplay,
} from "./AssistantMarkdown";
import {
  contextForSelection,
  activeSession,
  boundRefreshMessage,
  desktopReducer,
  initialState,
  selectedAgentInstance,
  selectedAgentWorkspace,
  type AgentWorkspaceState,
  type DesktopState,
  type WorkingView,
  type WorkspaceView,
} from "./state";
import {
  createInspectorLayout,
  inspectorLayoutReducer,
  openInspectorModules,
  type InspectorModuleId,
} from "./inspector-layout";
import { parseYoloCommand, yoloCommandUsage } from "./yolo-command";
import {
  artifactFileChange,
  artifactFileDiff,
  artifactFileTarget,
  artifactReviewBlocker,
  artifactReviewTargets,
  artifactScopeGlyph,
  artifactScopeOrder,
  artifactSkillShadow,
  artifactTopicBudget,
} from "./artifact-review";
import { MemoryView } from "./MemoryView";
import { ProfileManagerView } from "./ProfileManagerView";
import {
  findContextArtifact,
  libraryScopeOf,
  ScopeActions,
  ScopeChip,
  ScopeFilterBar,
  useProfileSnapshot,
} from "./scope-library";
import { EntityContextPanel } from "./EntityContextPanel";
import { ListeningPassPanel } from "./ListeningPassPanel";
import {
  defaultParameterPolicy,
  eventKindLabels,
  latestStateLabel,
} from "./live-event-drafts";
import {
  MonitorArmMenu,
  WiringBar,
  WiringView,
  type WiringMode,
} from "./WiringView";
import type { DesktopListeningJob } from "../listening-contracts";

type CatalogSkill = DesktopState["agentCatalog"]["skills"][number];

export type SlashCompletionEntry = {
  name: string;
  description: string;
  source: "built-in" | "skill";
  usage?: string;
};

const builtInSlashCompletions: readonly SlashCompletionEntry[] = [
  {
    name: "plan",
    description: "Enter plan mode for the selected agent.",
    source: "built-in",
    usage: "/plan",
  },
  {
    name: "yolo",
    description: "Configure automatic approval for agent actions.",
    source: "built-in",
    usage: yoloCommandUsage,
  },
];

const reservedSlashCompletionNames = new Set(
  builtInSlashCompletions.map(({ name }) => name),
);

export const PROJECT_SIDEBAR_MIN_WIDTH = 180;
export const PROJECT_SIDEBAR_MAX_WIDTH = 480;
export const INSPECTOR_SIDEBAR_MIN_WIDTH = 220;
export const WORKSPACE_MIN_CONVERSATION_WIDTH = 320;

export interface WorkspaceSidebarWidths {
  left: number;
  right: number;
}

const ADVANCED_VIEWS: ReadonlySet<WorkspaceView> = new Set([
  "browser",
  "diagnostics",
]);

export function initialWorkspaceSidebarWidths(
  viewportWidth: number,
): WorkspaceSidebarWidths {
  return viewportWidth <= 1_180
    ? { left: 220, right: 250 }
    : { left: 250, right: 290 };
}

export function resizedSidebarWidth({
  side,
  startWidth,
  startClientX,
  clientX,
  workspaceWidth,
  otherSidebarWidth,
  otherSidebarVisible,
}: {
  side: "left" | "right";
  startWidth: number;
  startClientX: number;
  clientX: number;
  workspaceWidth: number;
  otherSidebarWidth: number;
  otherSidebarVisible: boolean;
}): number {
  const minimum =
    side === "left" ? PROJECT_SIDEBAR_MIN_WIDTH : INSPECTOR_SIDEBAR_MIN_WIDTH;
  const availableMaximum =
    workspaceWidth -
    WORKSPACE_MIN_CONVERSATION_WIDTH -
    (otherSidebarVisible ? otherSidebarWidth : 0);
  const maximum = Math.max(
    minimum,
    side === "left"
      ? Math.min(PROJECT_SIDEBAR_MAX_WIDTH, availableMaximum)
      : availableMaximum,
  );
  const delta = clientX - startClientX;
  const requested = startWidth + (side === "left" ? delta : -delta);
  return Math.min(maximum, Math.max(minimum, requested));
}

type AgentReasoningEffort = NonNullable<DesktopActiveAgent["reasoningEffort"]>;
const writableReasoningEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly AgentReasoningEffort[];

export function matchingSlashCompletions(
  input: string,
  skills: readonly CatalogSkill[] | undefined,
): SlashCompletionEntry[] {
  if (!input.startsWith("/") || /\s/u.test(input)) return [];
  const prefix = input.slice(1);
  const entries = [
    ...builtInSlashCompletions,
    ...(skills ?? [])
      .filter(({ name }) => !reservedSlashCompletionNames.has(name))
      .map(({ name, description, argumentHint }) => ({
        name,
        description,
        source: "skill" as const,
        ...(argumentHint === undefined
          ? {}
          : { usage: `/${name} ${argumentHint}` }),
      })),
  ];
  return entries
    .filter(({ name }) => name.startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function slashCompletionsForState(
  input: string,
  state: DesktopState,
): SlashCompletionEntry[] {
  const session = activeSession(state);
  const catalogMatchesSession =
    state.agentCatalog.sessionId === undefined ||
    state.agentCatalog.sessionId === session?.id;
  return matchingSlashCompletions(
    input,
    selectedAgentInstance(state) === undefined || !catalogMatchesSession
      ? undefined
      : state.agentCatalog.skills,
  );
}

export function slashCompletionKey(
  key: string,
  selected: number,
  count: number,
  inputMatchesSelection = false,
): number | "complete" | undefined {
  if (count === 0) return undefined;
  if (key === "ArrowDown") return (selected + 1) % count;
  if (key === "ArrowUp") return (selected - 1 + count) % count;
  if (key === "Tab") return "complete";
  // Enter runs a fully typed command instead of re-completing it.
  if (key === "Enter" && !inputMatchesSelection) return "complete";
  return undefined;
}

export function slashCompletionText(entry: SlashCompletionEntry): string {
  return `/${entry.name} `;
}

const browserItems = [
  ["Wavetable", "Instrument", "Ableton"],
  ["Drift", "Instrument", "Ableton"],
  ["Operator", "Instrument", "Ableton"],
  ["Drum Rack", "Instrument rack", "Ableton"],
  ["FabFilter Pro-Q 3", "Audio effect", "VST3"],
  ["Valhalla VintageVerb", "Audio effect", "VST3"],
  ["Hybrid Reverb", "Audio effect", "Ableton"],
  ["Roar", "Audio effect", "Ableton"],
] as const;

const unknownOutputTrackColor = "#8a8f98";

export interface OutputTrackGroup {
  id: string;
  label: string;
  color: string;
  track?: DesktopTrack | undefined;
  connections: DesktopOutputConnection[];
}

function resolvedOutputTrack(
  connection: DesktopOutputConnection,
  snapshot: DesktopLiveSetSnapshot | undefined,
): { track: DesktopTrack; index: number } | undefined {
  const name = connection.track?.name;
  if (snapshot === undefined || name === undefined) return undefined;
  const regularTracks = snapshot.tracks.filter(
    (track) => track.kind === "midi" || track.kind === "audio",
  );
  const registeredIndex = connection.track?.index;
  if (registeredIndex !== undefined) {
    const indexedTrack = regularTracks[registeredIndex];
    if (indexedTrack?.name === name) {
      return { track: indexedTrack, index: registeredIndex };
    }
  }
  const nameMatches = regularTracks
    .map((track, index) => ({ track, index }))
    .filter((candidate) => candidate.track.name === name);
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
}

export function groupOutputsByTrack(
  connections: DesktopOutputConnection[],
  snapshot: DesktopLiveSetSnapshot | undefined,
): OutputTrackGroup[] {
  const groups = new Map<
    string,
    OutputTrackGroup & { index: number | undefined }
  >();
  const unknownConnections: DesktopOutputConnection[] = [];

  for (const connection of connections) {
    const resolved = resolvedOutputTrack(connection, snapshot);
    if (resolved === undefined) {
      unknownConnections.push(connection);
      continue;
    }
    const group = groups.get(resolved.track.id);
    if (group === undefined) {
      groups.set(resolved.track.id, {
        id: resolved.track.id,
        label: resolved.track.name,
        color: resolved.track.color,
        track: resolved.track,
        connections: [connection],
        index: resolved.index,
      });
    } else {
      group.connections.push(connection);
    }
  }

  const sortedGroups = [...groups.values()].sort(
    (left, right) => (left.index ?? Infinity) - (right.index ?? Infinity),
  );
  for (const group of sortedGroups) {
    group.connections.sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.producerId.localeCompare(right.producerId),
    );
  }
  if (unknownConnections.length > 0) {
    sortedGroups.push({
      id: "unknown",
      label: "Unknown / ungrouped",
      color: unknownOutputTrackColor,
      connections: unknownConnections.sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.producerId.localeCompare(right.producerId),
      ),
      index: undefined,
    });
  }
  return sortedGroups;
}

export async function loadInitialDesktopState(
  desktop: DesktopApi,
): Promise<DesktopAppEvent[]> {
  const sessions = await desktop.agent.getSessions();
  const outputs = await desktop.outputs.list();
  return [
    {
      type: "lifecycle.changed",
      state: await desktop.lifecycle.get(),
    },
    {
      type: "ableton.connection_changed",
      status: await desktop.ableton.getStatus(),
    },
    {
      type: "preferences.changed",
      preferences: await desktop.preferences.get(),
    },
    {
      type: "sessions.changed",
      sessions,
      ...(outputs.activeSessionId === undefined
        ? {}
        : { activeSessionId: outputs.activeSessionId }),
    },
    {
      type: "agents.catalog_changed",
      catalog: await desktop.agents.getCatalog(),
    },
    {
      type: "outputs.changed",
      outputs,
    },
  ];
}

export async function loadLiveEvents(
  dispatch: DesktopDispatch,
  requestEvents: DesktopApi["events"]["list"],
): Promise<boolean> {
  dispatch({ type: "events-load-started" });
  try {
    const events = await requestEvents();
    dispatch({ type: "event", event: { type: "events.changed", events } });
    return true;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Live Events could not be loaded";
    dispatch({ type: "events-load-failed", message });
    dispatch({
      type: "event",
      event: { type: "diagnostic", level: "error", message },
    });
    return false;
  }
}

export async function loadEventHistory(
  dispatch: DesktopDispatch,
  request: DesktopApi["eventHistory"]["search"],
  query: RootTraceQuery,
  append = false,
): Promise<boolean> {
  dispatch({ type: "event-history-load-started", append });
  try {
    const page = await request(query);
    dispatch({ type: "event-history-loaded", page, append });
    return true;
  } catch (error) {
    dispatch({
      type: "event-history-load-failed",
      message:
        error instanceof Error
          ? error.message
          : "Detailed event history could not be loaded",
    });
    return false;
  }
}

type DesktopDispatch = React.Dispatch<Parameters<typeof desktopReducer>[1]>;

export async function sendComposerMessage(
  desktop: DesktopApi,
  state: DesktopState,
  message: string,
  dispatch: DesktopDispatch,
): Promise<void> {
  if (message === "/plan") {
    const agent = selectedAgentInstance(state);
    if (agent === undefined) throw new Error("No active agent is selected");
    const updated = await desktop.agents.setMode(agent.id, "plan");
    dispatch({
      type: "event",
      event: {
        type: "agent.instance_changed",
        instance: updated,
        change: "mode-changed",
      },
    });
    return;
  }
  const yolo = parseYoloCommand(message);
  if (yolo !== undefined) {
    const session = activeSession(state);
    if (session === undefined) throw new Error("No active production session");
    const selected = selectedAgentInstance(state);
    if (!yolo.all && selected === undefined) {
      throw new Error("No active agent is selected");
    }
    const update = await desktop.agents.setAutoApproval(
      yolo.all ? "all" : selected!.id,
      yolo.enabled,
    );
    dispatch({
      type: "event",
      event: { type: "session.context_restored", session: update.session },
    });
    return;
  }
  const agent = selectedAgentInstance(state);
  if (agent === undefined) throw new Error("No active agent is selected");
  const agentMode = agent.mode ?? "interactive";
  if (agent.lifecycle !== "ready") {
    throw new Error(
      agent.lifecycle === "busy"
        ? `${agent.label} is already working`
        : `${agent.label} is ${agent.lifecycle}`,
    );
  }
  const submittedAt = Date.now();
  let invocation: SkillInvocation | undefined;
  try {
    invocation = parseSkillInvocation(message);
  } catch (error) {
    if (error instanceof InvalidSkillInvocationError) {
      throw new Error(
        "Invalid skill command. Use /skill-name followed by an optional request.",
      );
    }
    throw error;
  }
  if (invocation !== undefined) {
    const catalogSkill = state.agentCatalog.skills.find(
      ({ name }) => name === invocation.skillName,
    );
    if (catalogSkill === undefined) {
      throw new Error(`Unknown skill '/${invocation.skillName}'.`);
    }
    const context = contextForSelection(state);
    const accepted = await desktop.agents.invokeSkill(
      agent.id,
      invocation.skillName,
      invocation.request,
      context,
      agentMode,
    );
    dispatch({
      type: "user-message",
      id: accepted.messageId,
      content: message,
      submittedAt,
      agentInstanceId: agent.id,
      agentMode,
    });
    return;
  }
  const accepted = await desktop.agents.send(
    agent.id,
    message,
    contextForSelection(state),
    agentMode,
  );
  dispatch({
    type: "user-message",
    id: accepted.messageId,
    content: message,
    submittedAt,
    agentInstanceId: agent.id,
    agentMode,
  });
}

export async function setSelectedAgentMode(
  desktop: DesktopApi,
  state: DesktopState,
  mode: "interactive" | "plan",
  dispatch: DesktopDispatch,
): Promise<void> {
  const agent = selectedAgentInstance(state);
  if (agent === undefined) throw new Error("No active agent is selected");
  if (agent.mode === mode) return;
  const updated = await desktop.agents.setMode(agent.id, mode);
  dispatch({
    type: "event",
    event: {
      type: "agent.instance_changed",
      instance: updated,
      change: "mode-changed",
    },
  });
}

export async function selectWorkspaceAgent(
  desktop: DesktopApi,
  instanceId: string,
  dispatch: DesktopDispatch,
): Promise<void> {
  const instance = await desktop.agents.select(instanceId);
  dispatch({
    type: "event",
    event: { type: "agent.instance_changed", instance, change: "selected" },
  });
}

export async function cancelWorkspaceAgent(
  desktop: DesktopApi,
  state: DesktopState,
): Promise<boolean> {
  const agent = selectedAgentInstance(state);
  if (agent === undefined) return false;
  return (await desktop.agents.cancel(agent.id)).cancelled;
}

function focusWorkspaceInteraction(
  composerRef: React.RefObject<HTMLTextAreaElement | null>,
): void {
  const interaction = document.querySelector<HTMLElement>(
    "[data-workspace-interaction-focus]",
  );
  (interaction ?? composerRef.current)?.focus();
}

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(desktopReducer, initialState);
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const [sidebarWidths, setSidebarWidths] = useState(() =>
    initialWorkspaceSidebarWidths(window.innerWidth),
  );
  const [topChromeVisible, setTopChromeVisible] = useState(true);
  const [profileRefreshToken, setProfileRefreshToken] = useState(0);
  const [composerValue, setComposerValue] = useState("");
  const [composerError, setComposerError] = useState("");
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stateRef = useRef(state);
  const hydratedAgents = useRef(new Set<string>());
  const timelineScrollPositions = useRef(new Map<string, number>());
  stateRef.current = state;

  useEffect(() => {
    const pendingDeltas = new Map<
      string,
      Extract<DesktopAppEvent, { type: "agent.message_delta" }>
    >();
    type WorkingDeltaEvent = Extract<
      DesktopAppEvent,
      { type: "agent.working_update" }
    > & {
      update: Extract<
        Extract<DesktopAppEvent, { type: "agent.working_update" }>["update"],
        { kind: "reasoning_delta" }
      >;
    };
    const pendingWorkingDeltas = new Map<string, WorkingDeltaEvent>();
    let frame: number | undefined;
    let eventsFrame: number | undefined;
    let pendingEvents:
      Extract<DesktopAppEvent, { type: "events.changed" }> | undefined;
    const flush = (): void => {
      frame = undefined;
      for (const event of pendingDeltas.values())
        dispatch({ type: "event", event });
      pendingDeltas.clear();
      for (const event of pendingWorkingDeltas.values())
        dispatch({ type: "event", event });
      pendingWorkingDeltas.clear();
    };
    const unsubscribe = window.desktop.events.subscribe((event) => {
      if (event.type === "events.changed") {
        pendingEvents = event;
        eventsFrame ??= requestAnimationFrame(() => {
          eventsFrame = undefined;
          if (pendingEvents !== undefined)
            dispatch({ type: "event", event: pendingEvents });
          pendingEvents = undefined;
        });
        return;
      }
      if (event.type === "agent.message_delta") {
        const key = `${event.agentInstanceId ?? "legacy"}:${event.messageId}`;
        const pending = pendingDeltas.get(key);
        pendingDeltas.set(key, {
          ...event,
          content: (pending?.content ?? "") + event.content,
        });
        frame ??= requestAnimationFrame(flush);
        return;
      }
      if (
        event.type === "agent.working_update" &&
        event.update.kind === "reasoning_delta"
      ) {
        const key = `${event.agentInstanceId ?? "legacy"}:${event.messageId}`;
        const pending = pendingWorkingDeltas.get(key);
        const combined: WorkingDeltaEvent = {
          ...event,
          update: {
            ...event.update,
            content: (pending?.update.content ?? "") + event.update.content,
          },
        };
        pendingWorkingDeltas.set(key, combined);
        frame ??= requestAnimationFrame(flush);
        return;
      }
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (pendingDeltas.size > 0 || pendingWorkingDeltas.size > 0) flush();
      const blockingInteraction =
        event.type === "agent.plan_approval_requested" ||
        event.type === "agent.elicitation_requested" ||
        event.type === "approval.requested";
      const currentState = stateRef.current;
      const selectedId = activeSession(currentState)?.selectedAgentInstanceId;
      const eventAgentInstanceId = blockingInteraction
        ? event.agentInstanceId
        : undefined;
      const belongsToSelectedAgent =
        eventAgentInstanceId === undefined ||
        eventAgentInstanceId === selectedId;
      if (
        blockingInteraction &&
        belongsToSelectedAgent &&
        currentState.activeView !== "agents"
      ) {
        setRightSidebarVisible(true);
        dispatch({ type: "view", view: "workspace" });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => focusWorkspaceInteraction(composerRef)),
        );
      }
      dispatch({ type: "event", event });
    });
    return () => {
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (eventsFrame !== undefined) cancelAnimationFrame(eventsFrame);
    };
  }, []);
  useEffect(() => {
    const load = async (): Promise<void> => {
      for (const event of await loadInitialDesktopState(window.desktop))
        dispatch({ type: "event", event });
    };
    void load();
  }, []);
  const selectedInstance = selectedAgentInstance(state);
  const selectedInstanceId = selectedInstance?.id;
  const selectedSdkSessionId = selectedInstance?.sdkSessionId;
  const activeSessionId = activeSession(state)?.id;
  const selectedWorkspace = selectedAgentWorkspace(state);
  const selectedPlanApproval = selectedWorkspace.planApproval;
  const selectedPlanArtifact = selectedWorkspace.planArtifact;
  const selectedElicitation = selectedWorkspace.elicitation;
  useEffect(() => {
    if (activeSessionId === undefined) return;
    void loadLiveEvents(dispatch, () => window.desktop.events.list());
  }, [activeSessionId]);
  useEffect(() => {
    if (state.lifecycle !== "ready" && state.lifecycle !== "degraded") return;
    if (selectedInstanceId === undefined || activeSessionId === undefined)
      return;
    const key = `${activeSessionId}:${selectedInstanceId}:${selectedSdkSessionId ?? "none"}`;
    if (hydratedAgents.current.has(key)) return;
    hydratedAgents.current.add(key);
    void window.desktop.agents
      .hydrateHistory(selectedInstanceId)
      .then((history) =>
        dispatch({
          type: "event",
          event: {
            type: "agent.history_hydrated",
            agentInstanceId: selectedInstanceId,
            ...(selectedSdkSessionId === undefined
              ? {}
              : { sdkSessionId: selectedSdkSessionId }),
            history,
          },
        }),
      )
      .catch((error: unknown) => {
        hydratedAgents.current.delete(key);
        dispatch({
          type: "event",
          event: {
            type: "diagnostic",
            level: "error",
            message:
              error instanceof Error
                ? error.message
                : "Agent history could not be loaded",
          },
        });
      });
  }, [
    activeSessionId,
    selectedInstanceId,
    selectedSdkSessionId,
    state.lifecycle,
  ]);
  useEffect(() => {
    if (state.lifecycle !== "ready" && state.lifecycle !== "degraded") return;
    if (selectedInstanceId === undefined || activeSessionId === undefined)
      return;
    if (selectedPlanArtifact !== undefined) return;
    void window.desktop.agents
      .readPlan(selectedInstanceId)
      .then((artifact) =>
        dispatch({
          type: "event",
          event: {
            type: "agent.plan_artifact_changed",
            agentInstanceId: selectedInstanceId,
            artifact,
          },
        }),
      )
      .catch((error: unknown) => {
        dispatch({
          type: "event",
          event: {
            type: "diagnostic",
            level: "error",
            message:
              error instanceof Error
                ? error.message
                : "The session plan could not be loaded",
          },
        });
      });
  }, [
    activeSessionId,
    selectedInstanceId,
    selectedPlanArtifact,
    state.lifecycle,
  ]);
  useEffect(() => {
    setPlanEditorOpen(false);
  }, [activeSessionId, selectedInstanceId]);
  useEffect(() => {
    if (
      selectedPlanApproval !== undefined ||
      selectedElicitation !== undefined
    ) {
      setRightSidebarVisible(true);
    }
  }, [selectedElicitation, selectedPlanApproval]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (
        event.key === "Tab" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        selectedInstance !== undefined
      ) {
        event.preventDefault();
        void setSelectedAgentMode(
          window.desktop,
          state,
          selectedInstance.mode === "plan" ? "interactive" : "plan",
          dispatch,
        ).catch((error: unknown) =>
          dispatch({
            type: "event",
            event: {
              type: "diagnostic",
              level: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Agent mode could not be changed",
            },
          }),
        );
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        if (state.activeView !== "workspace") {
          dispatch({ type: "view", view: "workspace" });
        }
        requestAnimationFrame(() => focusWorkspaceInteraction(composerRef));
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        dispatch({ type: "view", view: "settings" });
      }
      if (event.key === "Escape" && selectedAgentWorkspace(state).approval) {
        if (state.activeView !== "workspace") {
          dispatch({ type: "view", view: "workspace" });
        }
        requestAnimationFrame(() => focusWorkspaceInteraction(composerRef));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state]);

  return (
    <AgentDefinitionsContext.Provider value={state.agentCatalog.definitions}>
      <div
        className={`app-shell ${topChromeVisible ? "" : "top-chrome-hidden"}`}
      >
        {topChromeVisible && (
          <ConnectionHeader
            state={state}
            dispatch={dispatch}
            profileRefreshToken={profileRefreshToken}
            onHideChrome={() => setTopChromeVisible(false)}
          />
        )}
        <LiveSetTransitionModal state={state} dispatch={dispatch} />
        <NavigationRail
          activeView={state.activeView}
          showAdvancedViews={state.preferences.showAdvancedViews}
          onNavigate={(view) => dispatch({ type: "view", view })}
        />
        {!topChromeVisible && (
          <button
            type="button"
            className="restore-top-chrome"
            aria-label="Show application toolbar"
            title="Show toolbar"
            aria-expanded="false"
            aria-controls="application-toolbar"
            onClick={() => setTopChromeVisible(true)}
          >
            <Icon name="down" />
          </button>
        )}
        <main id="main-content">
          {state.lifecycle === "starting" ? (
            <PresentationState
              title="Starting desktop services…"
              detail="Loading preferences, sessions, and project state."
            />
          ) : state.lifecycle === "crashed" ? (
            <PresentationState
              title="Renderer recovery mode"
              detail="Reload the window; main-process services remain isolated."
            />
          ) : state.activeView === "workspace" ? (
            <Workspace
              state={state}
              dispatch={dispatch}
              timelineScrollPositions={timelineScrollPositions.current}
              composer={
                <DesktopComposer
                  state={state}
                  composerRef={composerRef}
                  dispatch={dispatch}
                  value={composerValue}
                  error={composerError}
                  onValueChange={setComposerValue}
                  onErrorChange={setComposerError}
                  planEditorOpen={planEditorOpen}
                  onPlanEditorClose={() => setPlanEditorOpen(false)}
                />
              }
              leftSidebarVisible={leftSidebarVisible}
              rightSidebarVisible={rightSidebarVisible}
              sidebarWidths={sidebarWidths}
              onSidebarWidthChange={(side, width) =>
                setSidebarWidths((current) => ({
                  ...current,
                  [side]: width,
                }))
              }
              onToggleLeftSidebar={() =>
                setLeftSidebarVisible((visible) => !visible)
              }
              onToggleRightSidebar={() =>
                setRightSidebarVisible((visible) => !visible)
              }
              onEditPlan={() => setPlanEditorOpen(true)}
            />
          ) : state.activeView === "agents" ? (
            <AgentsView
              state={state}
              dispatch={dispatch}
              profileRefreshToken={profileRefreshToken}
              onProfilesChanged={() =>
                setProfileRefreshToken((current) => current + 1)
              }
            />
          ) : state.activeView === "memory" ? (
            <MemoryView
              libraryScope={state.libraryScope}
              onLibraryScope={(scope) =>
                dispatch({ type: "library-scope", scope })
              }
              profileRefreshToken={profileRefreshToken}
              onProfilesChanged={() =>
                setProfileRefreshToken((current) => current + 1)
              }
              onAskAgent={(command) => {
                setComposerValue(command);
                dispatch({ type: "view", view: "workspace" });
              }}
            />
          ) : state.activeView === "skills" ? (
            <SkillsView
              state={state}
              dispatch={dispatch}
              profileRefreshToken={profileRefreshToken}
              onUseInChat={(command) => {
                setComposerValue(command);
                dispatch({ type: "view", view: "workspace" });
              }}
              onProfilesChanged={() =>
                setProfileRefreshToken((current) => current + 1)
              }
            />
          ) : state.activeView === "outputs" ? (
            <OutputsView
              state={state}
              dispatch={dispatch}
              contextEpoch={profileRefreshToken}
            />
          ) : state.activeView === "events" ? (
            <EventsView state={state} dispatch={dispatch} />
          ) : state.activeView === "browser" ? (
            <BrowserView state={state} dispatch={dispatch} />
          ) : state.activeView === "profiles" ? (
            <ProfileManagerView
              {...(activeSessionId === undefined ? {} : { activeSessionId })}
              refreshToken={profileRefreshToken}
              onProfilesChanged={() =>
                setProfileRefreshToken((current) => current + 1)
              }
              onOpenLibrary={(kind, scope) =>
                dispatch({
                  type: "view",
                  view:
                    kind === "agent"
                      ? "agents"
                      : kind === "skill"
                        ? "skills"
                        : "memory",
                  libraryScope: scope,
                })
              }
            />
          ) : state.activeView === "diagnostics" ? (
            <DiagnosticsView state={state} dispatch={dispatch} />
          ) : state.activeView === "sessions" ? (
            <SessionsView state={state} />
          ) : (
            <SettingsView state={state} dispatch={dispatch} />
          )}
        </main>
      </div>
    </AgentDefinitionsContext.Provider>
  );
}

/**
 * An agent's own color. Sub-agent events carry only the definition label, so
 * match on name first and then on label.
 */
export function agentColor(
  definitions: readonly Pick<
    DesktopAgentDefinition,
    "name" | "label" | "color"
  >[],
  nameOrLabel: string,
): string {
  const definition =
    definitions.find(({ name }) => name === nameOrLabel) ??
    definitions.find(({ label }) => label === nameOrLabel);
  return definition?.color ?? defaultAgentColor(nameOrLabel.toLowerCase());
}

const AgentDefinitionsContext = createContext<
  readonly DesktopAgentDefinition[]
>([]);

/** Inline style that gives a sub-agent lane, chip, or approval its color. */
function useAgentColorStyle(
  nameOrLabel: string | undefined,
): CSSProperties | undefined {
  const definitions = useContext(AgentDefinitionsContext);
  return nameOrLabel === undefined
    ? undefined
    : ({
        "--subagent-color": agentColor(definitions, nameOrLabel),
      } as CSSProperties);
}

const RAIL_VIEWS: readonly {
  view: WorkspaceView;
  icon: IconName;
  label: string;
}[] = [
  { view: "workspace", icon: "chat", label: "Workspace" },
  { view: "agents", icon: "agent", label: "Agents" },
  { view: "skills", icon: "skill", label: "Skills" },
  { view: "memory", icon: "memory", label: "Memory" },
  { view: "events", icon: "wiring", label: "Wiring" },
  { view: "sessions", icon: "sessions", label: "Sessions" },
];

const MORE_VIEWS: readonly { view: WorkspaceView; label: string }[] = [
  { view: "outputs", label: "Outputs" },
  { view: "settings", label: "Settings" },
  { view: "browser", label: "Browser" },
  { view: "diagnostics", label: "Diagnostics" },
];

export function NavigationRail({
  activeView,
  showAdvancedViews,
  onNavigate,
}: {
  activeView: WorkspaceView;
  showAdvancedViews: boolean;
  onNavigate: (view: WorkspaceView) => void;
}): React.JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent | globalThis.KeyboardEvent): void => {
      if (event instanceof MouseEvent) {
        if (moreRef.current?.contains(event.target as Node)) return;
      } else if (event.key !== "Escape") {
        return;
      }
      setMoreOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [moreOpen]);
  const moreViews = MORE_VIEWS.filter(
    ({ view }) =>
      showAdvancedViews || !ADVANCED_VIEWS.has(view) || activeView === view,
  );
  const moreActive = moreViews.some(({ view }) => view === activeView);
  const item = (
    view: WorkspaceView,
    icon: IconName,
    label: string,
  ): React.JSX.Element => (
    <button
      key={view}
      type="button"
      className={`rail-item ${activeView === view ? "selected" : ""}`}
      aria-current={activeView === view ? "page" : undefined}
      onClick={() => onNavigate(view)}
    >
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  return (
    <nav
      id="application-views"
      className="navigation-rail"
      aria-label="Application views"
    >
      {RAIL_VIEWS.map(({ view, icon, label }) => item(view, icon, label))}
      <div className="rail-bottom" ref={moreRef}>
        <button
          type="button"
          className={`rail-item ${moreActive ? "selected" : ""}`}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-controls="rail-more-menu"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <Icon name="more" />
          <span>More</span>
        </button>
        {moreOpen && (
          <div id="rail-more-menu" className="rail-menu" role="menu">
            {moreViews.map(({ view, label }) => (
              <button
                key={view}
                type="button"
                role="menuitem"
                className={activeView === view ? "selected" : ""}
                aria-current={activeView === view ? "page" : undefined}
                onClick={() => {
                  setMoreOpen(false);
                  onNavigate(view);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {item("profiles", "profile", "Profile")}
      </div>
    </nav>
  );
}

function eventError(
  dispatch: DesktopDispatch,
  error: unknown,
  fallback = "Live Event update failed",
): void {
  dispatch({
    type: "event",
    event: {
      type: "diagnostic",
      level: "error",
      message: error instanceof Error ? error.message : fallback,
    },
  });
}

function eventActivityLabel(
  occurrence: DesktopLiveEventState["history"][number],
): string {
  if (
    occurrence.kind === "track.triggered_clip_changed" &&
    occurrence.current.state === "session-clip"
  ) {
    const clip =
      occurrence.current.clipName ??
      `Session clip ${occurrence.current.slotIndex + 1}`;
    return `Queued ${clip} in scene ${occurrence.current.slotIndex + 1}`;
  }
  if (
    occurrence.kind === "track.triggered_clip_changed" &&
    occurrence.current.state === "stop"
  ) {
    return "Queued track stop";
  }
  return occurrence.summary;
}

function isActionableEventActivity(
  occurrence: DesktopLiveEventState["history"][number],
): boolean {
  return !(
    occurrence.kind === "track.triggered_clip_changed" &&
    occurrence.current.state === "none"
  );
}

function editableDraft(
  event: DesktopLiveEventState,
  name: string,
  minimumNormalizedDelta: number,
  throttleMs: number,
): LiveEventDefinitionDraft {
  const definition = event.definition;
  if (definition.kind === "parameter.value_changed") {
    return {
      kind: definition.kind,
      classification: definition.classification,
      name,
      enabled: definition.enabled,
      target: definition.target,
      observationPolicy: { minimumNormalizedDelta, throttleMs },
    };
  }
  return {
    kind: definition.kind,
    classification: definition.classification,
    name,
    enabled: definition.enabled,
    target: definition.target,
  };
}

export function EventsView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
}): React.JSX.Element {
  const historyMode = state.preferences.eventsViewMode === "history";
  const sessionActive = activeSession(state) !== undefined;

  const setMode = (eventsViewMode: "live" | "history"): void => {
    if (eventsViewMode === state.preferences.eventsViewMode) return;
    const next = { ...state.preferences, eventsViewMode };
    dispatch({
      type: "event",
      event: { type: "preferences.changed", preferences: next },
    });
    void window.desktop.preferences
      .set(next)
      .then((preferences) =>
        dispatch({
          type: "event",
          event: { type: "preferences.changed", preferences },
        }),
      )
      .catch((error: unknown) =>
        eventError(dispatch, error, "View mode not saved"),
      );
  };

  if (historyMode) {
    return (
      <section
        className="events-view wiring-mode"
        aria-labelledby="events-heading"
      >
        <EventHistoryView
          state={state}
          dispatch={dispatch}
          onModeChange={setMode}
        />
      </section>
    );
  }

  if (state.eventsLoad.status !== "loaded") {
    return (
      <section
        className="events-view wiring-mode"
        aria-labelledby="events-heading"
      >
        <WiringBar mode="live" onModeChange={setMode} />
        <div className="wiring-pane">
          {state.eventsLoad.status === "failed" ? (
            <div className="event-load-error" role="alert">
              <strong>Events could not be loaded</strong>
              <p>{state.eventsLoad.message}</p>
              <button
                type="button"
                onClick={() =>
                  void loadLiveEvents(dispatch, () =>
                    window.desktop.events.list(),
                  )
                }
              >
                Retry
              </button>
            </div>
          ) : (
            <PresentationState
              title="Loading Events…"
              detail="Reading event definitions and current Live state."
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className="events-view wiring-mode"
      aria-labelledby="events-heading"
    >
      <WiringView
        state={state}
        dispatch={dispatch}
        onModeChange={setMode}
        agentColor={(definitionName) =>
          agentColor(state.agentCatalog.definitions, definitionName)
        }
        renderEventDetails={(event) => (
          <EventCard
            key={event.definition.id}
            event={event}
            activityExpanded={state.expandedEventActivityIds.includes(
              event.definition.id,
            )}
            onToggleActivity={() =>
              dispatch({
                type: "toggle-event-activity",
                eventId: event.definition.id,
              })
            }
            mutationsEnabled={sessionActive}
            onError={(error) => eventError(dispatch, error)}
          />
        )}
        onError={(error, fallback) => eventError(dispatch, error, fallback)}
      />
    </section>
  );
}

type JournalEvent = TelemetryEventPage["items"][number];
type ConfigurationSnapshot = ConfigurationSnapshotPage["items"][number];
type RootTrace = RootTracePage["items"][number];

function attributeText(
  event: JournalEvent,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = event.attributes[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Root traces started by app polling rather than by Live or the agent. */
const BACKGROUND_ROOT_NAMES = [
  "bridge.request.queued",
  "listening.runtime.discovery.queued",
];

const HISTORY_RANGES = {
  "": { label: "Any time", ms: undefined },
  hour: { label: "Last hour", ms: 3_600_000 },
  day: { label: "Last 24 hours", ms: 86_400_000 },
  week: { label: "Last 7 days", ms: 604_800_000 },
} as const;

interface EventHistoryFilters {
  search: string;
  level: string;
  outcome: string;
  range: keyof typeof HISTORY_RANGES;
  hideBackground: boolean;
}

function eventHistoryQuery(
  filters: EventHistoryFilters,
  cursor?: string,
  now = Date.now(),
): RootTraceQuery {
  const search = filters.search.trim();
  const rangeMs = HISTORY_RANGES[filters.range].ms;
  return {
    limit: 100,
    order: "desc",
    ...(search === "" ? {} : { search }),
    ...(filters.hideBackground
      ? { excludeRootNames: BACKGROUND_ROOT_NAMES }
      : {}),
    ...(filters.level === ""
      ? {}
      : { levels: [filters.level as "debug" | "info" | "warn" | "error"] }),
    ...(filters.outcome === ""
      ? {}
      : {
          outcomes: [
            filters.outcome as "success" | "failure" | "cancelled" | "unknown",
          ],
        }),
    ...(rangeMs === undefined
      ? {}
      : { from: new Date(now - rangeMs).toISOString() }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export async function openListeningFailureHistory(
  state: DesktopState,
  dispatch: DesktopDispatch,
  job: DesktopListeningJob,
  api: Pick<DesktopApi, "eventHistory" | "preferences"> = window.desktop,
): Promise<void> {
  const session = activeSession(state);
  if (
    session?.id !== job.sessionId ||
    session.liveSetId !== job.liveSetId ||
    selectedAgentInstance(state)?.id !== job.agentId
  ) {
    eventError(
      dispatch,
      new Error("Listening owner changed. Refresh listening passes."),
      "Listening History unavailable",
    );
    return;
  }
  const traceId = job.trace.traceId;
  const preferences = {
    ...state.preferences,
    eventsViewMode: "history" as const,
  };
  dispatch({
    type: "event",
    event: { type: "preferences.changed", preferences },
  });
  dispatch({ type: "view", view: "events" });
  dispatch({ type: "event-history-select-trace", traceId });
  await Promise.all([
    api.eventHistory
      .trace(traceId, { limit: 100, order: "asc" })
      .then((page) =>
        dispatch({
          type: "event-history-trace-loaded",
          traceId,
          page,
          append: false,
        }),
      )
      .catch((error: unknown) =>
        eventError(dispatch, error, "Trace detail could not be loaded"),
      ),
    api.preferences
      .set(preferences)
      .catch((error: unknown) =>
        eventError(dispatch, error, "History view mode not saved"),
      ),
  ]);
}

export function EventHistoryView({
  state,
  dispatch,
  onModeChange,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
  onModeChange: (mode: WiringMode) => void;
}): React.JSX.Element {
  const [filters, setFilters] = useState<EventHistoryFilters>({
    search: "",
    level: "",
    outcome: "",
    range: "",
    hideBackground: true,
  });
  const historyMode = state.preferences.eventsViewMode === "history";

  useEffect(() => {
    if (!historyMode) return;
    void window.desktop.eventHistory
      .configurations({ limit: 100, order: "desc" })
      .then((page) =>
        dispatch({ type: "event-history-configurations-loaded", page }),
      )
      .catch((error: unknown) =>
        eventError(dispatch, error, "History metadata could not be loaded"),
      );
  }, [historyMode]);

  const refresh = (): void =>
    void loadEventHistory(
      dispatch,
      (value) => window.desktop.eventHistory.search(value),
      eventHistoryQuery(filters),
    );

  // Filters apply as they change; typing waits for a short pause.
  useEffect(() => {
    if (!historyMode) return;
    const timer = setTimeout(refresh, 250);
    return () => clearTimeout(timer);
  }, [historyMode, filters]);

  const selectTrace = (trace: RootTrace): void => {
    const traceId = trace.rootTraceId;
    dispatch({
      type: "event-history-select-trace",
      traceId,
    });
    void window.desktop.eventHistory
      .trace(traceId, { limit: 100, order: "asc" })
      .then((page) =>
        dispatch({
          type: "event-history-trace-loaded",
          traceId,
          page,
          append: false,
        }),
      )
      .catch((error: unknown) =>
        eventError(dispatch, error, "Trace detail could not be loaded"),
      );
  };

  return (
    <>
      <WiringBar mode="history" onModeChange={onModeChange}>
        <input
          type="search"
          className="history-search"
          aria-label="Search events or sources"
          placeholder="Search events or sources"
          value={filters.search}
          onChange={(event) =>
            setFilters({ ...filters, search: event.target.value })
          }
        />
        <select
          aria-label="Level"
          value={filters.level}
          onChange={(event) =>
            setFilters({ ...filters, level: event.target.value })
          }
        >
          <option value="">Any level</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
        </select>
        <select
          aria-label="Outcome"
          value={filters.outcome}
          onChange={(event) =>
            setFilters({ ...filters, outcome: event.target.value })
          }
        >
          <option value="">Any outcome</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="cancelled">Cancelled</option>
          <option value="unknown">Unknown</option>
        </select>
        <select
          aria-label="Time range"
          value={filters.range}
          onChange={(event) =>
            setFilters({
              ...filters,
              range: event.target.value as EventHistoryFilters["range"],
            })
          }
        >
          {Object.entries(HISTORY_RANGES).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="wiring-check">
          <input
            type="checkbox"
            checked={filters.hideBackground}
            onChange={(event) =>
              setFilters({ ...filters, hideBackground: event.target.checked })
            }
          />
          Hide background polling
        </label>
        <span className="wiring-spacer" />
        {state.eventHistory.totalItems !== undefined && (
          <span className="wiring-muted tabular">
            {state.eventHistory.totalItems}{" "}
            {state.eventHistory.totalItems === 1 ? "occurrence" : "occurrences"}
          </span>
        )}
      </WiringBar>
      <div className="event-history-layout">
        {state.eventHistory.status === "failed" && (
          <div role="alert" className="event-load-error">
            {state.eventHistory.message}
          </div>
        )}
        {state.eventHistory.status === "loading" &&
        state.eventHistory.items.length === 0 &&
        state.eventHistory.selectedTraceId === undefined ? (
          <PresentationState
            title="Loading event history…"
            detail="Querying the local journal."
          />
        ) : state.eventHistory.items.length === 0 &&
          state.eventHistory.selectedTraceId === undefined ? (
          <EmptyState
            title="No detailed history"
            detail="Local detailed history is enabled by default. New instrumented events will appear here."
          />
        ) : (
          <div className="history-workspace">
            <div className="history-root-list" aria-label="Root occurrences">
              {state.eventHistory.items.map((trace) => (
                <button
                  type="button"
                  className={
                    state.eventHistory.selectedTraceId === trace.rootTraceId
                      ? "history-root selected"
                      : "history-root"
                  }
                  key={trace.rootTraceId}
                  onClick={() => selectTrace(trace)}
                >
                  <strong>{trace.firstEventName}</strong>
                  <span>
                    {trace.eventCount}{" "}
                    {trace.eventCount === 1 ? "event" : "events"}
                    {trace.hasErrors ? " · errors" : ""}
                  </span>
                  <time>
                    {new Date(trace.firstOccurredAt).toLocaleString()}
                  </time>
                </button>
              ))}
              {state.eventHistory.nextCursor && (
                <button
                  type="button"
                  onClick={() =>
                    void loadEventHistory(
                      dispatch,
                      (value) => window.desktop.eventHistory.search(value),
                      eventHistoryQuery(filters, state.eventHistory.nextCursor),
                      true,
                    )
                  }
                >
                  Load more
                </button>
              )}
            </div>
            <EventTraceInspector
              state={state}
              events={state.eventHistory.trace}
              configurations={state.eventHistory.configurations}
              traceId={state.eventHistory.selectedTraceId}
              traceNextCursor={state.eventHistory.traceNextCursor}
              traceTotalEvents={state.eventHistory.traceTotalEvents}
              onLoadMore={(traceId, cursor) => {
                void window.desktop.eventHistory
                  .trace(traceId, {
                    cursor,
                    limit: 100,
                    order: "asc",
                  })
                  .then((page) =>
                    dispatch({
                      type: "event-history-trace-loaded",
                      traceId,
                      page,
                      append: true,
                    }),
                  )
                  .catch((error: unknown) =>
                    eventError(
                      dispatch,
                      error,
                      "More trace detail could not be loaded",
                    ),
                  );
              }}
              onDelete={(traceId) => {
                if (!window.confirm("Delete this trace from local history?"))
                  return;
                void window.desktop.eventHistory
                  .deleteTrace(traceId)
                  .then(() => {
                    dispatch({ type: "event-history-select-trace" });
                    refresh();
                  })
                  .catch((error: unknown) =>
                    eventError(dispatch, error, "Trace could not be deleted"),
                  );
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}

function EventTraceInspector({
  state,
  events,
  configurations,
  traceId,
  traceNextCursor,
  traceTotalEvents,
  onLoadMore,
  onDelete,
}: {
  state: DesktopState;
  events: JournalEvent[];
  configurations: ConfigurationSnapshot[];
  traceId?: string | undefined;
  traceNextCursor?: string | undefined;
  traceTotalEvents?: number | undefined;
  onLoadMore: (traceId: string, cursor: string) => void;
  onDelete: (traceId: string) => void;
}): React.JSX.Element {
  if (events.length === 0 && traceId === undefined) {
    return (
      <aside className="trace-inspector">
        <EmptyState
          title="Select an occurrence"
          detail="Trace stages, agent delivery lanes, and sanitized payloads appear here."
        />
      </aside>
    );
  }
  const startedAt = Date.parse(events[0]?.occurredAt ?? "");
  const lanes = new Map<string, JournalEvent[]>();
  for (const event of events) {
    const lane =
      event.activeAgentId ??
      attributeText(
        event,
        "agent_instance_id",
        "agent_id",
        "agent",
        "agent_label",
      ) ??
      "System";
    lanes.set(lane, [...(lanes.get(lane) ?? []), event]);
  }
  const agentEvents = events.filter(
    (event) =>
      event.name.includes("agent") ||
      event.name.includes("message") ||
      event.name.includes("tool"),
  );
  const activeAgentIds = new Set(
    events
      .map(
        (event) =>
          event.activeAgentId ??
          attributeText(event, "agent_instance_id", "agent_id"),
      )
      .filter((value): value is string => value !== undefined),
  );
  const relevantConfigurations =
    events.length === 0
      ? []
      : activeAgentIds.size === 0
        ? configurations
        : configurations.filter(
            (snapshot) =>
              snapshot.activeAgentId !== undefined &&
              activeAgentIds.has(snapshot.activeAgentId),
          );
  const currentAgent = state.sessions
    .flatMap((session) => session.activeAgents)
    .find((agent) => activeAgentIds.has(agent.id));
  const currentWorkspace =
    currentAgent === undefined
      ? undefined
      : state.agentWorkspaces[currentAgent.id];
  return (
    <aside className="trace-inspector">
      <div className="trace-inspector-heading">
        <h3>Trace detail</h3>
        {traceId && (
          <button
            type="button"
            className="danger"
            onClick={() => onDelete(traceId)}
          >
            Delete trace
          </button>
        )}
      </div>
      {traceId !== undefined && (
        <p>
          Diagnostic trace: {traceId}.
          {events.length === 0 &&
            " No persisted events loaded yet for this trace; evidence may be unavailable or pending."}
        </p>
      )}
      {traceTotalEvents !== undefined && (
        <p className="muted">
          Showing {events.length} of {traceTotalEvents} events
        </p>
      )}
      <div className="latency-stages" aria-label="Latency stages">
        {events.map((event) => (
          <div className="latency-stage" key={event.id}>
            <span>{event.name}</span>
            <span>
              +{Math.max(0, Date.parse(event.occurredAt) - startedAt)} ms
              {event.durationMs === undefined
                ? ""
                : ` · ${event.durationMs} ms`}
            </span>
          </div>
        ))}
      </div>
      {traceId && traceNextCursor && (
        <button
          type="button"
          onClick={() => onLoadMore(traceId, traceNextCursor)}
        >
          Load more trace events
        </button>
      )}
      <h3>Agent delivery lanes</h3>
      {[...lanes].map(([lane, laneEvents]) => (
        <section className="agent-lane" key={lane}>
          <h4>{lane}</h4>
          {laneEvents.map((event) => (
            <details key={event.id}>
              <summary>
                {event.name} · {event.outcome ?? event.level}
              </summary>
              <pre>{JSON.stringify(event.attributes, undefined, 2)}</pre>
            </details>
          ))}
        </section>
      ))}
      <h3>Agent inspector</h3>
      {currentAgent && (
        <section className="agent-current-config">
          <h4>{currentAgent.label} · current effective configuration</h4>
          <dl className="event-metadata">
            <dt>Instructions</dt>
            <dd>
              <pre>{currentAgent.config.systemPrompt}</pre>
            </dd>
            <dt>Tools</dt>
            <dd>{currentAgent.config.resolvedTools.join(", ") || "None"}</dd>
            <dt>Operations</dt>
            <dd>
              {currentAgent.config.resolvedOperations?.join(", ") || "All"}
            </dd>
            <dt>Messages</dt>
            <dd>
              <pre>
                {JSON.stringify(currentWorkspace?.messages ?? [], undefined, 2)}
              </pre>
            </dd>
            <dt>Tool activity</dt>
            <dd>
              <pre>
                {JSON.stringify(
                  currentWorkspace?.operations ?? [],
                  undefined,
                  2,
                )}
              </pre>
            </dd>
          </dl>
        </section>
      )}
      {relevantConfigurations.length === 0 && agentEvents.length === 0 ? (
        <p className="muted">
          No agent configuration or activity was captured.
        </p>
      ) : (
        <>
          {relevantConfigurations.map((snapshot) => (
            <details className="agent-config-snapshot" key={snapshot.id}>
              <summary>
                {snapshot.component} · configuration{" "}
                {snapshot.configurationVersion}
              </summary>
              <h4>Effective instructions and tools</h4>
              <pre>{JSON.stringify(snapshot.values, undefined, 2)}</pre>
            </details>
          ))}
          {agentEvents.length > 0 && (
            <details open>
              <summary>Messages and tool activity</summary>
              <pre>
                {JSON.stringify(
                  agentEvents.map(({ occurredAt, name, attributes }) => ({
                    occurredAt,
                    name,
                    attributes,
                  })),
                  undefined,
                  2,
                )}
              </pre>
            </details>
          )}
        </>
      )}
    </aside>
  );
}

export function EventCard({
  event,
  activityExpanded,
  onToggleActivity,
  mutationsEnabled = true,
  onError,
}: {
  event: DesktopLiveEventState;
  activityExpanded: boolean;
  onToggleActivity: () => void;
  mutationsEnabled?: boolean;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const definition = event.definition;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(definition.name);
  const [minimumDelta, setMinimumDelta] = useState(
    definition.kind === "parameter.value_changed"
      ? definition.observationPolicy.minimumNormalizedDelta
      : defaultParameterPolicy.minimumNormalizedDelta,
  );
  const [throttleMs, setThrottleMs] = useState(
    definition.kind === "parameter.value_changed"
      ? definition.observationPolicy.throttleMs
      : defaultParameterPolicy.throttleMs,
  );
  const [updating, setUpdating] = useState(false);
  const detailsId = `event-activity-${definition.id}`;
  const listeners = event.listeners.filter(({ listener }) => listener.enabled);
  const update = async (operation: () => Promise<unknown>): Promise<void> => {
    if (!mutationsEnabled) return;
    setUpdating(true);
    try {
      await operation();
    } catch (error) {
      onError(error);
    } finally {
      setUpdating(false);
    }
  };
  const resolutionDetail =
    event.resolution.status === "resolved"
      ? `Resolved to ${event.resolution.track.name}`
      : `${event.resolution.status}: ${event.resolution.reason}${
          event.resolution.detail ? ` — ${event.resolution.detail}` : ""
        }`;
  const history = event.history
    .filter(isActionableEventActivity)
    .sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        right.sequence - left.sequence,
    )
    .slice(0, 50);

  return (
    <article className="event-card">
      <header>
        <div>
          <h4>{definition.name}</h4>
          <span>{eventKindLabels[definition.kind]}</span>
        </div>
        <strong>{definition.enabled ? "Enabled" : "Disabled"}</strong>
      </header>
      <dl className="event-metadata">
        <dt>Current</dt>
        <dd>{latestStateLabel(event)}</dd>
        <dt>Resolution</dt>
        <dd>{resolutionDetail}</dd>
        <dt>Listening agents</dt>
        <dd>
          {listeners.length
            ? listeners.map(({ agentLabel }) => agentLabel).join(", ")
            : "None"}
        </dd>
      </dl>
      <div className="event-actions">
        <button
          type="button"
          disabled={!mutationsEnabled || updating}
          onClick={() =>
            void update(() =>
              definition.enabled
                ? window.desktop.events.disable(definition.id)
                : window.desktop.events.enable(definition.id),
            )
          }
        >
          {definition.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          aria-expanded={editing}
          disabled={!mutationsEnabled}
          onClick={() => setEditing((value) => !value)}
        >
          Edit
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={!mutationsEnabled || updating}
          onClick={() => {
            if (
              window.confirm(
                `Delete “${definition.name}”? Listening agent assignments will also be removed.`,
              )
            )
              void update(() => window.desktop.events.delete(definition.id));
          }}
        >
          Delete
        </button>
      </div>
      {editing && (
        <form
          className="event-editor"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            void update(async () => {
              await window.desktop.events.update(
                definition.id,
                editableDraft(event, name, minimumDelta, throttleMs),
              );
              setEditing(false);
            });
          }}
        >
          <label>
            Event name
            <input
              value={name}
              maxLength={160}
              required
              onChange={(changeEvent) => setName(changeEvent.target.value)}
            />
          </label>
          {definition.kind === "parameter.value_changed" && (
            <>
              <label>
                Minimum normalized change
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.001"
                  value={minimumDelta}
                  onChange={(changeEvent) =>
                    setMinimumDelta(Number(changeEvent.target.value))
                  }
                />
              </label>
              <label>
                Update throttle (milliseconds)
                <input
                  type="number"
                  min="0"
                  max="60000"
                  step="10"
                  value={throttleMs}
                  onChange={(changeEvent) =>
                    setThrottleMs(Number(changeEvent.target.value))
                  }
                />
              </label>
            </>
          )}
          <button
            type="submit"
            disabled={!mutationsEnabled || updating || name.trim().length === 0}
          >
            Save event
          </button>
        </form>
      )}
      <div className="event-activity-heading">
        <button
          type="button"
          aria-expanded={activityExpanded}
          aria-controls={detailsId}
          onClick={onToggleActivity}
        >
          Recent activity ({history.length})
        </button>
      </div>
      {activityExpanded && (
        <div id={detailsId} className="event-activity">
          {history.length === 0 ? (
            <p>No activity recorded yet.</p>
          ) : (
            <ol>
              {history.map((occurrence) => (
                <li key={occurrence.occurrenceId}>
                  <time dateTime={occurrence.observedAt}>
                    {new Date(occurrence.observedAt).toLocaleTimeString()}
                  </time>
                  <span>{eventActivityLabel(occurrence)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </article>
  );
}

export function OutputsView({
  state,
  dispatch,
  contextEpoch = 0,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  contextEpoch?: number;
}): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const [removingAssignmentId, setRemovingAssignmentId] = useState<string>();
  const report = (error: unknown): void =>
    dispatch({
      type: "event",
      event: {
        type: "diagnostic",
        level: "error",
        message:
          error instanceof Error ? error.message : "Output update failed",
      },
    });
  useEffect(() => {
    void refreshOutputs(dispatch, () => window.desktop.outputs.list());
  }, [dispatch]);
  const unavailable = state.outputs.status.state !== "listening";
  const outputGroups = groupOutputsByTrack(
    state.outputs.connections,
    state.snapshot,
  );
  const activeSession = state.sessions.find(
    ({ id }) => id === state.outputs.activeSessionId,
  );
  const activeAgents = activeSession?.activeAgents ?? [];
  const activeAgentById = new Map(
    activeAgents.map((agent) => [agent.id, agent] as const),
  );
  const connectedProducerIds = new Set(
    state.outputs.connections.map(({ producerId }) => producerId),
  );
  const unmatchedAssignments = state.outputs.assignments.filter(
    (
      assignment,
    ): assignment is DesktopOutputAssignment & { agentInstanceId: string } =>
      assignment.agentInstanceId !== undefined &&
      activeAgentById.has(assignment.agentInstanceId) &&
      !connectedProducerIds.has(assignment.producerId),
  );
  const removeUnmatched = async (
    assignment: DesktopOutputAssignment & { agentInstanceId: string },
  ): Promise<void> => {
    setRemovingAssignmentId(assignment.assignmentId);
    try {
      await window.desktop.outputs.unassign(
        assignment.agentInstanceId,
        assignment.producerId,
      );
    } catch (error) {
      report(error);
    } finally {
      setRemovingAssignmentId(undefined);
    }
  };
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshOutputs(dispatch, () => window.desktop.outputs.list());
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="outputs-view" aria-labelledby="outputs-heading">
      <div className="panel-heading">
        <div>
          <h2 id="outputs-heading">Outputs</h2>
          <p>
            Route each discovered MIDI or audio observation independently to
            active agents.
          </p>
        </div>
        <div className="output-refresh-actions">
          <strong>
            Signal service:{" "}
            {state.outputs.status.state === "listening"
              ? `listening on ${state.outputs.status.host}:${state.outputs.status.port}`
              : state.outputs.status.state}
          </strong>
          <button disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh Outputs"}
          </button>
        </div>
      </div>
      <EntityContextPanel
        sessionId={state.activeSessionId}
        api={
          typeof window === "undefined"
            ? undefined
            : window.desktop?.entityContext
        }
        contextEpoch={contextEpoch}
      />
      <ListeningPassPanel
        sessionId={state.activeSessionId}
        agentId={selectedAgentInstance(state)?.id}
        api={typeof window === "undefined" ? undefined : window.desktop}
        contextEpoch={contextEpoch}
        onOpenFailureHistory={(job) =>
          void openListeningFailureHistory(state, dispatch, job)
        }
      />
      {unavailable && (
        <div className="notice" role="status">
          {state.outputs.status.state === "disabled" ||
          state.outputs.status.state === "error"
            ? state.outputs.status.detail
            : "Signal ingress is not running."}
        </div>
      )}
      {activeAgents.length === 0 && (
        <div className="notice" role="status">
          No active agents. Activate an agent before subscribing to outputs.
        </div>
      )}
      {outputGroups.length === 0 ? (
        <EmptyState
          title="No outputs discovered"
          detail="Open a compatible MIDI or audio producer in Ableton Live."
        />
      ) : (
        <div className="output-track-groups">
          {outputGroups.map((group) => (
            <section
              key={group.id}
              className="output-track-group"
              aria-labelledby={`output-track-${group.id}`}
              style={
                {
                  "--output-track-color": group.color,
                } as CSSProperties
              }
            >
              <header className="output-track-heading">
                <span className="output-track-swatch" aria-hidden="true" />
                <div>
                  <h3 id={`output-track-${group.id}`}>{group.label}</h3>
                  <span>
                    {group.connections.length}{" "}
                    {group.connections.length === 1 ? "output" : "outputs"}
                  </span>
                </div>
              </header>
              <div className="output-grid">
                {group.connections.map((connection) => {
                  return (
                    <OutputConnectionCard
                      key={connection.producerId}
                      connection={connection}
                      activeAgents={activeAgents}
                      assignments={state.outputs.assignments.filter(
                        (item) => item.producerId === connection.producerId,
                      )}
                      latest={state.outputs.latest.filter(
                        (item) => item.producerId === connection.producerId,
                      )}
                      unavailable={unavailable}
                      expanded={
                        !state.collapsedOutputProducerIds.includes(
                          connection.producerId,
                        )
                      }
                      onToggleDisclosure={() =>
                        dispatch({
                          type: "toggle-output-disclosure",
                          producerId: connection.producerId,
                        })
                      }
                      onError={report}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {unmatchedAssignments.length > 0 && (
        <section
          className="unmatched-output-subscriptions"
          aria-labelledby="unmatched-output-heading"
        >
          <header>
            <div>
              <h3 id="unmatched-output-heading">Unmatched subscriptions</h3>
              <p>
                These active-agent inputs are waiting for a producer with the
                same stable ID to reconnect.
              </p>
            </div>
            <span>{unmatchedAssignments.length}</span>
          </header>
          <div className="unmatched-output-list">
            {unmatchedAssignments.map((assignment) => {
              const agent = activeAgentById.get(assignment.agentInstanceId);
              if (agent === undefined) return null;
              return (
                <article key={assignment.assignmentId}>
                  <div>
                    <strong>{agent.label}</strong>
                    <span>Producer unavailable</span>
                    <code>{assignment.producerId}</code>
                  </div>
                  <button
                    disabled={removingAssignmentId === assignment.assignmentId}
                    onClick={() => void removeUnmatched(assignment)}
                  >
                    {removingAssignmentId === assignment.assignmentId
                      ? "Removing…"
                      : "Remove subscription"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}

export async function refreshOutputs(
  dispatch: DesktopDispatch,
  requestOutputs: DesktopApi["outputs"]["list"],
): Promise<boolean> {
  try {
    const outputs = await requestOutputs();
    dispatch({
      type: "event",
      event: { type: "outputs.changed", outputs },
    });
    return true;
  } catch (error) {
    dispatch({
      type: "event",
      event: {
        type: "diagnostic",
        level: "error",
        message:
          error instanceof Error
            ? error.message
            : "Outputs could not be refreshed",
      },
    });
    return false;
  }
}

export async function setOutputSubscription(
  outputs: Pick<DesktopApi["outputs"], "assign" | "unassign">,
  agentInstanceId: string,
  producerId: string,
  assignment: DesktopOutputAssignment | undefined,
  subscribed: boolean,
): Promise<void> {
  if (subscribed && assignment === undefined)
    await outputs.assign(agentInstanceId, producerId);
  if (!subscribed && assignment !== undefined)
    await outputs.unassign(agentInstanceId, producerId);
}

export function OutputConnectionCard({
  connection,
  activeAgents,
  assignments,
  latest,
  unavailable,
  expanded,
  onToggleDisclosure,
  onError,
}: {
  connection: DesktopOutputConnection;
  activeAgents: DesktopState["sessions"][number]["activeAgents"];
  assignments: DesktopOutputAssignment[];
  latest: LatestAcceptedOutput[];
  unavailable: boolean;
  expanded: boolean;
  onToggleDisclosure: () => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [updating, setUpdating] = useState(false);
  const detailsId = `output-details-${connection.producerId}`;
  const missing = connection.connectionId.startsWith("missing:");
  const updateSubscription = async (
    agentInstanceId: string,
    assignment: DesktopOutputAssignment | undefined,
    subscribed: boolean,
  ): Promise<void> => {
    setUpdating(true);
    try {
      await setOutputSubscription(
        window.desktop.outputs,
        agentInstanceId,
        connection.producerId,
        assignment,
        subscribed,
      );
    } catch (error) {
      onError(error);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <article
      className={`output-card${expanded ? "" : " output-card-collapsed"}`}
    >
      <header>
        <div className="output-card-identity">
          <h3>{connection.displayName}</h3>
          <span>
            {missing
              ? "Producer unavailable"
              : `${connection.signalKind.toUpperCase()} · ${
                  connection.track?.name ?? "Unknown track"
                }`}
            {connection.device?.name ? ` · ${connection.device.name}` : ""}
          </span>
        </div>
        <div className="output-card-header-actions">
          <strong aria-label={`Connection state: ${connection.state}`}>
            {connection.state}
            {connection.receiving ? " · receiving" : ""}
          </strong>
          <button
            type="button"
            className="output-disclosure"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={onToggleDisclosure}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </header>
      <div className="output-agent-subscriptions">
        {activeAgents.map((agent) => {
          const assignment = assignments.find(
            ({ agentInstanceId }) => agentInstanceId === agent.id,
          );
          return (
            <label key={agent.id}>
              <input
                type="checkbox"
                aria-label={`${agent.label} subscription to ${connection.displayName}`}
                checked={assignment !== undefined}
                disabled={updating}
                onChange={(event) =>
                  void updateSubscription(
                    agent.id,
                    assignment,
                    event.target.checked,
                  )
                }
              />
              <span>{agent.label}</span>
            </label>
          );
        })}
      </div>
      {expanded && (
        <div id={detailsId} className="output-card-details">
          {missing && (
            <div className="notice" role="status">
              This producer is disconnected. Desired subscriptions are retained
              and will resume when it reconnects.
            </div>
          )}
          {activeAgents.map((agent) => {
            const assignment = assignments.find(
              ({ agentInstanceId }) => agentInstanceId === agent.id,
            );
            if (assignment === undefined) return null;
            return (
              <OutputAssignmentControls
                key={agent.id}
                agentLabel={agent.label}
                agentInstanceId={agent.id}
                assignment={assignment}
                latest={
                  latest
                    .filter(
                      ({ assignmentId }) =>
                        assignmentId === assignment.assignmentId,
                    )
                    .sort((left, right) => right.sequence - left.sequence)[0]
                }
                unavailable={unavailable}
                onError={onError}
              />
            );
          })}
        </div>
      )}
    </article>
  );
}

function OutputAssignmentControls({
  agentLabel,
  agentInstanceId,
  assignment,
  latest,
  unavailable,
  onError,
}: {
  agentLabel: string;
  agentInstanceId: string;
  assignment: DesktopOutputAssignment;
  latest: LatestAcceptedOutput | undefined;
  unavailable: boolean;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [instruction, setInstruction] = useState(assignment.usageInstruction);
  const [policies, setPolicies] = useState(
    assignment.processingPolicyIds.join(", "),
  );
  return (
    <section className="output-controls">
      <h4>{agentLabel}</h4>
      <div className="latest-output">
        <strong>Latest accepted window</strong>
        <p>
          {latest?.summary ??
            (unavailable
              ? "Producer disconnected; waiting to reconnect."
              : "No accepted sample has been received yet.")}
        </p>
      </div>
      <label>
        <input
          type="checkbox"
          checked={assignment.enabled}
          onChange={(event) =>
            void window.desktop.outputs
              .setEnabled(
                agentInstanceId,
                assignment.producerId,
                event.target.checked,
              )
              .catch(onError)
          }
        />{" "}
        Delivery enabled
      </label>
      <label>
        Delivery mode
        <select
          value={assignment.deliveryMode}
          onChange={(event) =>
            void window.desktop.outputs
              .setDeliveryMode(
                agentInstanceId,
                assignment.producerId,
                event.target.value as DesktopOutputAssignment["deliveryMode"],
              )
              .catch(onError)
          }
        >
          <option value="next-prompt">Next prompt</option>
          <option value="automatic-analysis">Automatic analysis</option>
          <option value="automatic-action">Automatic action</option>
        </select>
      </label>
      <label>
        Usage instruction
        <textarea
          aria-label={`Usage instruction for ${assignment.producerId}`}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <label>
        Processing policies
        <input
          aria-label={`Processing policies for ${agentLabel}`}
          value={policies}
          onChange={(event) => setPolicies(event.target.value)}
          placeholder="latest-window"
        />
      </label>
      <div className="output-actions">
        <button
          disabled={instruction.trim().length === 0}
          onClick={() =>
            void window.desktop.outputs
              .setUsageInstruction(
                agentInstanceId,
                assignment.producerId,
                instruction,
              )
              .catch(onError)
          }
        >
          Save instruction
        </button>
        <button
          onClick={() =>
            void window.desktop.outputs
              .setProcessingPolicies(
                agentInstanceId,
                assignment.producerId,
                policies
                  .split(",")
                  .map((policy) => policy.trim())
                  .filter(Boolean),
              )
              .catch(onError)
          }
        >
          Save policies
        </button>
        <button
          onClick={() =>
            void window.desktop.outputs
              .unassign(agentInstanceId, assignment.producerId)
              .catch(onError)
          }
        >
          Unassign
        </button>
      </div>
    </section>
  );
}

export function LiveSetTransitionModal({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element | null {
  const transition = state.pendingLiveSetTransition;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  if (transition === undefined) return null;

  const resolve = async (
    decision: Parameters<DesktopApi["liveSet"]["resolveTransition"]>[1],
  ): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      const session = await window.desktop.liveSet.resolveTransition(
        transition.token,
        decision,
      );
      dispatch({
        type: "event",
        event: { type: "session.context_restored", session },
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Live Set transition could not be completed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="project-transition-backdrop">
      <section
        className="project-transition-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-transition-title"
      >
        <h1 id="project-transition-title">Live Set changed</h1>
        <p>
          Ableton is now using <strong>{transition.liveSet.liveSetName}</strong>
          .
        </p>
        {transition.kind === "first-save-conflict" ? (
          <p>
            This saved Live Set already has a canonical App session. Both
            sessions will be kept, and your current work will remain active.
            Choose which session should be canonical.
          </p>
        ) : transition.kind === "associated" ? (
          <p>
            This Live Set has a saved App session
            {transition.associatedSession === undefined
              ? "."
              : ` from ${new Date(
                  transition.associatedSession.updatedAt,
                ).toLocaleString()}.`}
          </p>
        ) : (
          <p>
            No saved App session exists for this Live Set. Continue by forking
            the current setup, or start with one clean Default agent.
          </p>
        )}
        {error !== undefined && <p className="error">{error}</p>}
        <div className="project-transition-actions">
          {transition.decisions.includes("resume-associated") && (
            <button
              className="primary"
              autoFocus
              disabled={submitting}
              onClick={() => void resolve("resume-associated")}
            >
              Resume saved session
            </button>
          )}
          {transition.decisions.includes("fork-current") && (
            <button
              className="primary"
              autoFocus
              disabled={submitting}
              onClick={() => void resolve("fork-current")}
            >
              Continue current session
            </button>
          )}
          {transition.decisions.includes("make-current-canonical") && (
            <button
              className="primary"
              autoFocus
              disabled={submitting}
              onClick={() => void resolve("make-current-canonical")}
            >
              Make current session canonical
            </button>
          )}
          {transition.decisions.includes("keep-existing-canonical") && (
            <button
              disabled={submitting}
              onClick={() => void resolve("keep-existing-canonical")}
            >
              Keep existing session canonical
            </button>
          )}
          {transition.decisions.includes("start-fresh") && (
            <button
              disabled={submitting}
              onClick={() => void resolve("start-fresh")}
            >
              Start fresh
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

export function ConnectionHeader({
  state,
  dispatch,
  onHideChrome,
  profileRefreshToken = 0,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onHideChrome?: (() => void) | undefined;
  profileRefreshToken?: number;
}): React.JSX.Element {
  const session = activeSession(state);
  const activeAgent = selectedAgentInstance(state);
  const [profileStatus, setProfileStatus] = useState<DesktopProfileStatus>();
  const [pendingProfile, setPendingProfile] = useState<string>();
  const [profileError, setProfileError] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  useEffect(() => {
    if (state.lifecycle !== "ready" && state.lifecycle !== "degraded") return;
    if (window.desktop.profiles?.status === undefined) return;
    void window.desktop.profiles
      .status()
      .then(setProfileStatus)
      .catch((error: unknown) =>
        setProfileError(
          error instanceof Error
            ? error.message
            : "Profiles could not be loaded",
        ),
      );
  }, [profileRefreshToken, state.activeSessionId, state.lifecycle]);
  const requestProfileSwitch = (profile: string): void => {
    if (
      profileStatus === undefined ||
      profile === profileStatus.activeProfile ||
      profileBusy
    ) {
      return;
    }
    if (profileStatus.activeSessionId !== undefined) {
      setPendingProfile(profile);
      return;
    }
    setProfileBusy(true);
    setProfileError("");
    void window.desktop.profiles
      .switch(profile, profileStatus.revision, false)
      .catch((error: unknown) => {
        setProfileError(
          error instanceof Error ? error.message : "Profile switch failed",
        );
        setProfileBusy(false);
      });
  };
  const confirmProfileSwitch = async (): Promise<void> => {
    if (profileStatus === undefined || pendingProfile === undefined) return;
    setProfileBusy(true);
    setProfileError("");
    try {
      await window.desktop.profiles.switch(
        pendingProfile,
        profileStatus.revision,
        profileStatus.activeSessionId !== undefined,
      );
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "Profile switch failed",
      );
      setPendingProfile(undefined);
      setProfileBusy(false);
    }
  };
  const selectAgent = async (instanceId: string): Promise<void> => {
    try {
      await selectWorkspaceAgent(window.desktop, instanceId, dispatch);
    } catch (error) {
      dispatch({
        type: "event",
        event: {
          type: "diagnostic",
          level: "error",
          message:
            error instanceof Error
              ? error.message
              : "Agent selection could not be saved",
        },
      });
    }
  };
  const connectionText =
    state.connection.state === "connected"
      ? `Connected · Live ${state.connection.liveVersion}`
      : state.connection.state === "error"
        ? `Error · ${state.connection.message}`
        : state.connection.state[0]?.toUpperCase() +
          state.connection.state.slice(1);
  const connected = state.connection.state === "connected";
  const activeAgentColor =
    activeAgent === undefined
      ? undefined
      : agentColor(state.agentCatalog.definitions, activeAgent.definitionName);
  return (
    <header
      id="application-toolbar"
      className="connection-header"
      aria-label="Application toolbar"
    >
      <div className="live-status">
        <span
          className={`led ${connected ? "on" : state.connection.state === "error" ? "error" : "off"}`}
          aria-hidden="true"
        />
        <span
          className={`status status-${state.connection.state}`}
          aria-label={`Ableton status: ${connectionText}`}
          title={connectionText}
        >
          {state.connection.state === "connected"
            ? `Live ${state.connection.liveVersion}`
            : connectionText}
        </span>
        {!connected && (
          <button
            type="button"
            onClick={() =>
              void window.desktop.ableton.connect().catch((error: unknown) =>
                dispatch({
                  type: "event",
                  event: {
                    type: "diagnostic",
                    level: "error",
                    message:
                      error instanceof Error
                        ? error.message
                        : "Connection attempt failed",
                  },
                }),
              )
            }
          >
            Connect
          </button>
        )}
      </div>
      <div className="live-set-title">
        <strong title={state.snapshot?.liveSetName ?? "No Live Set"}>
          {state.snapshot?.liveSetName ?? "No Live Set"}
        </strong>
        <small className="tabular">
          {state.snapshot
            ? `${state.snapshot.tempo} BPM · ${state.snapshot.timeSignature}`
            : "Waiting for snapshot"}
        </small>
      </div>
      <MonitorArmMenu
        state={state}
        dispatch={dispatch}
        onError={(error, fallback) => eventError(dispatch, error, fallback)}
      />
      <div className="header-controls">
        <select
          className="profile-selector scope-chip"
          data-scope="profile"
          aria-label="Active Profile"
          value={profileStatus?.activeProfile ?? ""}
          disabled={
            profileBusy ||
            profileStatus === undefined ||
            profileStatus.switchingDisabledReason !== undefined
          }
          title={
            profileStatus?.switchingDisabledReason ??
            (profileError || "Active profile")
          }
          onChange={(event) => requestProfileSwitch(event.target.value)}
        >
          {profileStatus?.profiles
            .filter(({ reserved, active }) => !reserved || active)
            .map((profile) => (
              <option key={profile.name} value={profile.name}>
                {profile.name}
              </option>
            ))}
        </select>
        <label
          className="agent-picker"
          style={
            activeAgentColor === undefined
              ? undefined
              : ({ "--agent-color": activeAgentColor } as CSSProperties)
          }
        >
          <Icon name="agent" />
          <select
            className="agent-instance-selector"
            aria-label="Active Agent"
            value={activeAgent?.id ?? ""}
            disabled={(session?.activeAgents.length ?? 0) === 0}
            onChange={(event) => void selectAgent(event.target.value)}
          >
            {session?.activeAgents.length ? null : (
              <option value="">No active agents</option>
            )}
            {session?.activeAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        {activeAgent?.autoApprove && (
          <span className="agent-badge yolo-badge">YOLO</span>
        )}
        {onHideChrome !== undefined && (
          <button
            type="button"
            className="icon-button"
            aria-label="Hide application toolbar"
            title="Hide toolbar"
            aria-expanded="true"
            aria-controls="application-toolbar"
            onClick={onHideChrome}
          >
            <Icon name="up" />
          </button>
        )}
      </div>
      {pendingProfile !== undefined && (
        <div className="profile-conflict-backdrop" role="presentation">
          <section
            className="profile-conflict-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="header-profile-switch-title"
          >
            <h2 id="header-profile-switch-title">Switch profile?</h2>
            <p>
              {profileStatus?.activeSessionId === undefined
                ? `Switch to ${pendingProfile}?`
                : "The active session will be saved and closed. You can resume it later from its current profile."}
            </p>
            <div className="profile-conflict-actions">
              <button
                type="button"
                disabled={profileBusy}
                onClick={() => setPendingProfile(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={profileBusy}
                onClick={() => void confirmProfileSwitch()}
              >
                Switch
              </button>
            </div>
          </section>
        </div>
      )}
    </header>
  );
}

export function Workspace({
  state,
  dispatch,
  timelineScrollPositions,
  composer,
  leftSidebarVisible = true,
  rightSidebarVisible = true,
  sidebarWidths,
  onSidebarWidthChange,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onEditPlan,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  timelineScrollPositions?: Map<string, number> | undefined;
  composer?: React.ReactNode;
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  sidebarWidths?: WorkspaceSidebarWidths | undefined;
  onSidebarWidthChange?:
    ((side: keyof WorkspaceSidebarWidths, width: number) => void) | undefined;
  onToggleLeftSidebar?: (() => void) | undefined;
  onToggleRightSidebar?: (() => void) | undefined;
  onEditPlan?: (() => void) | undefined;
}): React.JSX.Element {
  const drag = useRef<
    | {
        side: keyof WorkspaceSidebarWidths;
        pointerId: number;
        startWidth: number;
        startClientX: number;
        workspaceWidth: number;
      }
    | undefined
  >(undefined);
  const widths =
    sidebarWidths ?? initialWorkspaceSidebarWidths(Number.POSITIVE_INFINITY);
  const resize = (
    event: ReactPointerEvent<HTMLDivElement>,
    side: keyof WorkspaceSidebarWidths,
  ): void => {
    if (onSidebarWidthChange === undefined) return;
    const workspace = event.currentTarget.parentElement;
    if (workspace === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      side,
      pointerId: event.pointerId,
      startWidth: widths[side],
      startClientX: event.clientX,
      workspaceWidth: workspace.getBoundingClientRect().width,
    };
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (
      active === undefined ||
      active.pointerId !== event.pointerId ||
      onSidebarWidthChange === undefined
    ) {
      return;
    }
    event.preventDefault();
    const otherSide = active.side === "left" ? "right" : "left";
    onSidebarWidthChange(
      active.side,
      resizedSidebarWidth({
        side: active.side,
        startWidth: active.startWidth,
        startClientX: active.startClientX,
        clientX: event.clientX,
        workspaceWidth: active.workspaceWidth,
        otherSidebarWidth: widths[otherSide],
        otherSidebarVisible:
          otherSide === "left" ? leftSidebarVisible : rightSidebarVisible,
      }),
    );
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    drag.current = undefined;
  };
  const keyResize = (
    event: KeyboardEvent<HTMLDivElement>,
    side: keyof WorkspaceSidebarWidths,
  ): void => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
    const workspace = event.currentTarget.parentElement;
    if (
      step === undefined ||
      workspace === null ||
      onSidebarWidthChange === undefined
    ) {
      return;
    }
    event.preventDefault();
    const otherSide = side === "left" ? "right" : "left";
    onSidebarWidthChange(
      side,
      resizedSidebarWidth({
        side,
        startWidth: widths[side],
        startClientX: 0,
        clientX: step,
        workspaceWidth: workspace.getBoundingClientRect().width,
        otherSidebarWidth: widths[otherSide],
        otherSidebarVisible:
          otherSide === "left" ? leftSidebarVisible : rightSidebarVisible,
      }),
    );
  };
  const resizeHandle = (side: keyof WorkspaceSidebarWidths) => (
    <div
      className={`sidebar-resize-handle sidebar-resize-handle-${side}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={
        side === "left" ? "Resize project sidebar" : "Resize inspector sidebar"
      }
      aria-controls={side === "left" ? "project-sidebar" : "inspector-sidebar"}
      aria-valuenow={Math.round(widths[side])}
      aria-valuemin={
        side === "left"
          ? PROJECT_SIDEBAR_MIN_WIDTH
          : INSPECTOR_SIDEBAR_MIN_WIDTH
      }
      onPointerDown={(event) => resize(event, side)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onKeyDown={(event) => keyResize(event, side)}
    />
  );
  const planMode = selectedAgentInstance(state)?.mode === "plan";
  const workspaceStyle = {
    "--project-sidebar-width": `${widths.left}px`,
    "--inspector-sidebar-width": `${widths.right}px`,
  } as CSSProperties;
  return (
    <div
      className={`workspace ${leftSidebarVisible ? "" : "left-sidebar-hidden"} ${rightSidebarVisible ? "" : "right-sidebar-hidden"}`}
      style={workspaceStyle}
    >
      {onToggleLeftSidebar !== undefined && (
        <button
          type="button"
          className={`workspace-edge-control workspace-edge-control-left ${leftSidebarVisible ? "expanded" : ""}`}
          aria-label={
            leftSidebarVisible ? "Hide project sidebar" : "Show project sidebar"
          }
          aria-expanded={leftSidebarVisible}
          aria-controls="project-sidebar"
          onClick={onToggleLeftSidebar}
        >
          <SidebarIcon side="left" expanded={leftSidebarVisible} />
        </button>
      )}
      {onToggleRightSidebar !== undefined && (
        <button
          type="button"
          className={`workspace-edge-control workspace-edge-control-right ${rightSidebarVisible ? "expanded" : ""}`}
          aria-label={
            rightSidebarVisible
              ? "Hide inspector sidebar"
              : "Show inspector sidebar"
          }
          aria-expanded={rightSidebarVisible}
          aria-controls="inspector-sidebar"
          onClick={onToggleRightSidebar}
        >
          <SidebarIcon side="right" expanded={rightSidebarVisible} />
        </button>
      )}
      {leftSidebarVisible && (
        <ProjectOutline state={state} dispatch={dispatch} />
      )}
      {leftSidebarVisible &&
        onSidebarWidthChange !== undefined &&
        resizeHandle("left")}
      <section
        className="conversation"
        data-mode={planMode ? "plan" : "interactive"}
        aria-label="Conversation and operation timeline"
      >
        {planMode && (
          <div className="plan-mode-banner" role="status">
            <Icon name="plan" />
            <strong>Plan mode</strong>
            <span>· the agent will propose, not change Live</span>
          </div>
        )}
        <Timeline state={state} scrollPositions={timelineScrollPositions} />
        {composer}
      </section>
      {rightSidebarVisible &&
        onSidebarWidthChange !== undefined &&
        resizeHandle("right")}
      <Inspector
        state={state}
        dispatch={dispatch}
        onEditPlan={onEditPlan}
        hidden={!rightSidebarVisible}
      />
    </div>
  );
}

function SidebarIcon({
  side,
  expanded,
}: {
  side: "left" | "right";
  expanded: boolean;
}): React.JSX.Element {
  const panelX = side === "left" ? 3 : 13;
  const arrow = expanded
    ? side === "left"
      ? "M10 6 7 9l3 3"
      : "M8 6l3 3-3 3"
    : side === "left"
      ? "M7 6l3 3-3 3"
      : "M11 6l-3 3 3 3";
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="2" />
      <path d={`M${panelX} 3v12`} />
      <path d={arrow} />
    </svg>
  );
}

type AgentDetailSection = "general" | "capabilities";

function agentDetailSectionLabel(section: AgentDetailSection): string {
  if (section === "general") return "General";
  return "Capabilities";
}

function AgentDetailSectionIcon({
  section,
}: {
  section: AgentDetailSection;
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {section === "general" ? (
        <>
          <circle cx="9" cy="6" r="3" />
          <path d="M3.5 15c.7-3 2.5-4.5 5.5-4.5s4.8 1.5 5.5 4.5" />
        </>
      ) : (
        <>
          <path d="M9 2.5v3M9 12.5v3M2.5 9h3M12.5 9h3" />
          <circle cx="9" cy="9" r="3.5" />
        </>
      )}
    </svg>
  );
}

function AgentDetailTabs({
  section,
  panelIdPrefix,
  onChange,
}: {
  section: AgentDetailSection;
  panelIdPrefix: string;
  onChange: (section: AgentDetailSection) => void;
}): React.JSX.Element {
  const sections = [
    "general",
    "capabilities",
  ] as const satisfies readonly AgentDetailSection[];
  return (
    <div
      className="agent-detail-tabs"
      role="tablist"
      aria-label="Agent definition views"
    >
      {sections.map((candidate) => (
        <button
          type="button"
          className={`agent-detail-tab ${section === candidate ? "active" : ""}`}
          role="tab"
          aria-selected={section === candidate}
          aria-controls={`${panelIdPrefix}-${candidate}`}
          aria-label={agentDetailSectionLabel(candidate)}
          title={agentDetailSectionLabel(candidate)}
          onClick={() => onChange(candidate)}
          key={candidate}
        >
          <AgentDetailSectionIcon section={candidate} />
        </button>
      ))}
    </div>
  );
}

interface SkillEditorDraft {
  readonly key: string;
  readonly published: boolean;
  readonly fingerprint?: string;
  readonly origin?: DesktopSkillDocument["origin"];
  name: string;
  description: string;
  body: string;
  dirty: boolean;
  loading: boolean;
  error?: string;
}

export function SkillsView({
  state,
  dispatch,
  onProfilesChanged,
  onUseInChat,
  profileRefreshToken = 0,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onProfilesChanged?: (() => void) | undefined;
  onUseInChat?: ((command: string) => void) | undefined;
  profileRefreshToken?: number;
}): React.JSX.Element {
  const session = activeSession(state);
  const profiles = useProfileSnapshot(profileRefreshToken);
  const [selectedKey, setSelectedKey] = useState<string | undefined>(
    state.agentCatalog.skills[0]?.name,
  );
  const [drafts, setDrafts] = useState<Record<string, SkillEditorDraft>>({});
  const [activePanel, setActivePanel] = useState<"overview" | "instructions">(
    "instructions",
  );
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const catalogSkills = useMemo(
    () =>
      state.agentCatalog.sessionId === undefined ||
      state.agentCatalog.sessionId === session?.id
        ? state.agentCatalog.skills
        : [],
    [session?.id, state.agentCatalog],
  );
  const selectedCatalogSkill = catalogSkills.find(
    ({ name }) => name === selectedKey,
  );
  const visibleSkills = catalogSkills.filter(
    ({ origin }) =>
      state.libraryScope === "all" ||
      libraryScopeOf(origin) === state.libraryScope,
  );
  const skillScopeCounts = countByScope(
    catalogSkills.map(({ origin }) => libraryScopeOf(origin)),
  );
  const selectedDraft =
    selectedKey === undefined ? undefined : drafts[selectedKey];

  const reportError = useCallback(
    (error: unknown, fallback: string): void => {
      dispatch({
        type: "event",
        event: {
          type: "diagnostic",
          level: "error",
          message: error instanceof Error ? error.message : fallback,
        },
      });
    },
    [dispatch],
  );

  useEffect(() => {
    if (
      selectedKey === undefined ||
      selectedKey.startsWith("new:") ||
      drafts[selectedKey] !== undefined ||
      selectedCatalogSkill === undefined
    ) {
      return;
    }
    const placeholder: SkillEditorDraft = {
      key: selectedKey,
      published: true,
      fingerprint: selectedCatalogSkill.fingerprint,
      origin: selectedCatalogSkill.origin ?? "bundled",
      name: selectedCatalogSkill.name,
      description: selectedCatalogSkill.description,
      body: "",
      dirty: false,
      loading: true,
    };
    setDrafts((current) => ({ ...current, [selectedKey]: placeholder }));
    let cancelled = false;
    void window.desktop.skills
      .read(selectedCatalogSkill.name)
      .then((document) => {
        if (cancelled) return;
        setDrafts((current) => ({
          ...current,
          [selectedKey]: {
            key: selectedKey,
            published: true,
            fingerprint: document.fingerprint,
            origin: document.origin,
            name: document.name,
            description: document.description,
            body: document.body,
            dirty: false,
            loading: false,
          },
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Skill could not be loaded";
        setDrafts((current) => ({
          ...current,
          [selectedKey]: { ...placeholder, loading: false, error: message },
        }));
        reportError(error, "Skill could not be loaded");
      });
    return () => {
      cancelled = true;
    };
  }, [reportError, selectedCatalogSkill, selectedKey]);

  useEffect(() => {
    if (selectedKey?.startsWith("new:")) return;
    if (
      selectedKey !== undefined &&
      catalogSkills.some(({ name }) => name === selectedKey)
    ) {
      return;
    }
    setSelectedKey(catalogSkills[0]?.name);
  }, [catalogSkills, selectedKey]);

  const updateDraft = (
    key: string,
    update: Partial<Pick<SkillEditorDraft, "name" | "description" | "body">>,
  ): void => {
    setDrafts((current) => {
      const draft = current[key];
      return draft === undefined
        ? current
        : { ...current, [key]: { ...draft, ...update, dirty: true } };
    });
  };

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const catalog = await window.desktop.agents.refreshCatalog();
      dispatch({
        type: "event",
        event: { type: "agents.catalog_changed", catalog },
      });
      if (selectedKey !== undefined && !selectedKey.startsWith("new:")) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[selectedKey];
          return next;
        });
      }
    } catch (error) {
      reportError(error, "Skills could not be refreshed");
    } finally {
      setRefreshing(false);
    }
  };

  const createDraft = (): void => {
    const key = `new:${Date.now()}`;
    setDrafts((current) => ({
      ...current,
      [key]: {
        key,
        published: false,
        name: "",
        description: "",
        body: "# New skill\n\nDescribe the workflow and constraints here.",
        dirty: true,
        loading: false,
      },
    }));
    setSelectedKey(key);
    setActivePanel("overview");
  };

  const save = async (): Promise<void> => {
    if (selectedDraft === undefined || session === undefined) return;
    setSaving(true);
    try {
      const profileStatus = await window.desktop.profiles.status();
      const profileSnapshot = await window.desktop.profiles.get(
        profileStatus.activeProfile,
      );
      const result = selectedDraft.published
        ? await window.desktop.skills.save(
            selectedDraft.name,
            selectedDraft.body,
            profileSnapshot.revision,
            selectedDraft.fingerprint!,
          )
        : await window.desktop.skills.create(
            selectedDraft.name,
            selectedDraft.description,
            selectedDraft.body,
            profileSnapshot.revision,
          );
      dispatch({
        type: "event",
        event: { type: "agents.catalog_changed", catalog: result.catalog },
      });
      const savedKey = result.document.name;
      setDrafts((current) => {
        const next = { ...current };
        delete next[selectedDraft.key];
        next[savedKey] = {
          key: savedKey,
          published: true,
          fingerprint: result.document.fingerprint,
          origin: result.document.origin,
          name: result.document.name,
          description: result.document.description,
          body: result.document.body,
          dirty: false,
          loading: false,
        };
        return next;
      });
      setSelectedKey(savedKey);
      onProfilesChanged?.();
    } catch (error) {
      reportError(error, "Skill could not be saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="agents-view skills-view"
      aria-labelledby="skills-heading"
    >
      <div className="library-bar">
        <h2 className="library-title" id="skills-heading">
          Skills
        </h2>
        <ScopeFilterBar
          value={state.libraryScope}
          counts={skillScopeCounts}
          onChange={(scope) => dispatch({ type: "library-scope", scope })}
        />
        <span className="spacer" />
        <button disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh skills"}
        </button>
        <button type="button" className="primary" onClick={createDraft}>
          New skill
        </button>
      </div>
      {session === undefined && (
        <div className="notice" role="status">
          Skill saves will be available after the production session is
          restored.
        </div>
      )}
      {catalogSkills.length === 0 && !selectedKey?.startsWith("new:") ? (
        <EmptyState
          title="No skills yet"
          detail="Skills are reusable instructions you can call with /name in chat. Create one with New skill."
        />
      ) : (
        <div className="agents-workspace">
          <nav className="agent-navigation" aria-label="Skills">
            <div className="agent-navigation-list">
              {visibleSkills.map((skill) => (
                <button
                  type="button"
                  className={`agent-navigation-item skill-row ${selectedKey === skill.name ? "active" : ""}`}
                  aria-current={selectedKey === skill.name ? "page" : undefined}
                  title={skill.description}
                  data-scope={libraryScopeOf(skill.origin)}
                  onClick={() => setSelectedKey(skill.name)}
                  key={skill.name}
                >
                  <span className="row-strip" aria-hidden="true" />
                  <span className="agent-navigation-label">
                    <strong>/{skill.name}</strong>
                  </span>
                  <span className="row-marks">
                    {libraryScopeOf(skill.origin) === "system" && (
                      <span
                        role="img"
                        aria-label="Bundled"
                        title="Bundled with the app"
                      >
                        <Icon name="lock" />
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {Object.values(drafts)
                .filter(({ published }) => !published)
                .map((draft) => (
                  <button
                    type="button"
                    className={`agent-navigation-item skill-row ${selectedKey === draft.key ? "active" : ""}`}
                    aria-current={
                      selectedKey === draft.key ? "page" : undefined
                    }
                    data-scope="session"
                    onClick={() => setSelectedKey(draft.key)}
                    key={draft.key}
                  >
                    <span className="row-strip" aria-hidden="true" />
                    <span className="agent-navigation-label">
                      <strong>{draft.name || "Untitled skill"}</strong>
                    </span>
                    <span className="row-marks">New</span>
                  </button>
                ))}
            </div>
          </nav>
          <div className="agent-detail-workspace">
            {selectedDraft === undefined ? (
              <EmptyState
                title="Select a skill"
                detail="Choose a skill from the navigator or create a new one."
              />
            ) : (
              <article className="agent-detail">
                <header className="agent-detail-header">
                  <div>
                    <div className="agent-title-line">
                      <h3>/{selectedDraft.name || "new-skill"}</h3>
                      {selectedDraft.published ? (
                        <ArtifactScopeActions
                          profiles={profiles}
                          kind="skill"
                          name={selectedDraft.name}
                          origin={selectedDraft.origin}
                          onProfilesChanged={onProfilesChanged}
                        />
                      ) : (
                        <ScopeChip origin="session" />
                      )}
                      {selectedDraft.dirty && (
                        <span className="scope-badge">Unsaved</span>
                      )}
                    </div>
                    <p>{selectedDraft.description || "Add skill metadata."}</p>
                    {selectedDraft.published && (
                      <SkillUsedBy
                        skillName={selectedDraft.name}
                        definitions={state.agentCatalog.definitions}
                      />
                    )}
                  </div>
                  <div className="agent-header-actions">
                    {selectedDraft.published && onUseInChat !== undefined && (
                      <button
                        type="button"
                        onClick={() => onUseInChat(`/${selectedDraft.name} `)}
                      >
                        Use in chat
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!selectedDraft.dirty || saving}
                      onClick={() => {
                        if (selectedDraft.published) {
                          setDrafts((current) => {
                            const next = { ...current };
                            delete next[selectedDraft.key];
                            return next;
                          });
                        } else {
                          setDrafts((current) => {
                            const next = { ...current };
                            delete next[selectedDraft.key];
                            return next;
                          });
                          setSelectedKey(state.agentCatalog.skills[0]?.name);
                        }
                      }}
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      disabled={
                        saving ||
                        session === undefined ||
                        selectedDraft.loading ||
                        !selectedDraft.dirty ||
                        selectedDraft.name.trim().length === 0 ||
                        selectedDraft.description.trim().length === 0 ||
                        selectedDraft.body.trim().length === 0
                      }
                      onClick={() => void save()}
                    >
                      {saving ? "Saving…" : "Save to Session"}
                    </button>
                  </div>
                </header>
                <div className="agent-detail-tabs" role="tablist">
                  <button
                    type="button"
                    className={`agent-detail-tab ${activePanel === "overview" ? "active" : ""}`}
                    role="tab"
                    aria-selected={activePanel === "overview"}
                    aria-label="Skill overview"
                    title="Overview"
                    onClick={() => setActivePanel("overview")}
                  >
                    About
                  </button>
                  <button
                    type="button"
                    className={`agent-detail-tab ${activePanel === "instructions" ? "active" : ""}`}
                    role="tab"
                    aria-selected={activePanel === "instructions"}
                    aria-label="Skill instructions"
                    title="Instructions"
                    onClick={() => setActivePanel("instructions")}
                  >
                    Instructions
                  </button>
                </div>
                <div className="agent-detail-body">
                  {selectedDraft.loading ? (
                    <p role="status">Loading skill…</p>
                  ) : selectedDraft.error !== undefined ? (
                    <div className="notice" role="alert">
                      <span>{selectedDraft.error}</span>
                      <button type="button" onClick={() => void refresh()}>
                        Reload
                      </button>
                    </div>
                  ) : activePanel === "overview" ? (
                    <div className="skill-overview-grid">
                      <label>
                        Name
                        <input
                          value={selectedDraft.name}
                          readOnly={selectedDraft.published}
                          disabled={selectedDraft.published}
                          onChange={(event) =>
                            updateDraft(selectedDraft.key, {
                              name: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Description
                        <textarea
                          value={selectedDraft.description}
                          readOnly={selectedDraft.published}
                          disabled={selectedDraft.published}
                          rows={4}
                          onChange={(event) =>
                            updateDraft(selectedDraft.key, {
                              description: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                      {selectedDraft.published && (
                        <p className="field-help">
                          Published skill metadata is immutable. Create a new
                          skill to use a different name or description.
                        </p>
                      )}
                    </div>
                  ) : (
                    <label className="skill-markdown-editor">
                      Markdown instructions
                      <textarea
                        value={selectedDraft.body}
                        rows={24}
                        spellCheck
                        onChange={(event) =>
                          updateDraft(selectedDraft.key, {
                            body: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                  )}
                </div>
              </article>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function AgentsView({
  state,
  dispatch,
  onProfilesChanged,
  profileRefreshToken = 0,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onProfilesChanged?: (() => void) | undefined;
  profileRefreshToken?: number;
}): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const session = activeSession(state);
  const profiles = useProfileSnapshot(profileRefreshToken);
  const definitionScope = (definitionName: string): DesktopArtifactScope =>
    libraryScopeOf(
      state.agentCatalog.definitions.find(({ name }) => name === definitionName)
        ?.origin ?? "session",
    );
  const inScope = (definitionName: string): boolean =>
    state.libraryScope === "all" ||
    definitionScope(definitionName) === state.libraryScope;
  const scopeCounts = countByScope(
    state.agentCatalog.definitions.map(({ origin }) => libraryScopeOf(origin)),
  );
  const activeAgents = session?.activeAgents ?? [];
  const selectedAgentId = session?.selectedAgentInstanceId;
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [savingDefinitionName, setSavingDefinitionName] = useState<string>();
  const [creatingDefinition, setCreatingDefinition] = useState<string>();
  const [newAgent, setNewAgent] = useState<NewAgentDraft>();
  const [confirmResetId, setConfirmResetId] = useState<string>();
  const [modelsState, setModelsState] = useState<
    | { status: "loading"; models: DesktopAgentModel[] }
    | { status: "loaded"; models: DesktopAgentModel[] }
    | {
        status: "failed";
        models: DesktopAgentModel[];
        message: string;
        auth?: DesktopCopilotAuthStatus;
      }
  >({ status: "loading", models: [] });
  const inactiveDefinitions = useMemo(() => {
    const activeDefinitionNames = new Set(
      activeAgents.map(({ definitionName }) => definitionName),
    );
    return state.agentCatalog.definitions.filter(
      ({ name }) => !activeDefinitionNames.has(name),
    );
  }, [activeAgents, state.agentCatalog.definitions]);
  const defaultInspectedKey =
    (selectedAgentId === undefined ? undefined : `active:${selectedAgentId}`) ??
    (activeAgents[0] === undefined
      ? undefined
      : `active:${activeAgents[0].id}`) ??
    (inactiveDefinitions[0] === undefined
      ? undefined
      : `definition:${inactiveDefinitions[0].name}`);
  const [inspectedKey, setInspectedKey] = useState<string | undefined>(
    defaultInspectedKey,
  );

  useEffect(() => {
    const keys = new Set([
      ...activeAgents.map(({ id }) => `active:${id}`),
      ...inactiveDefinitions.map(({ name }) => `definition:${name}`),
      ...(newAgent === undefined ? [] : [NEW_AGENT_KEY]),
    ]);
    if (inspectedKey !== undefined && keys.has(inspectedKey)) return;
    setInspectedKey(defaultInspectedKey);
  }, [
    activeAgents,
    defaultInspectedKey,
    inactiveDefinitions,
    inspectedKey,
    newAgent,
  ]);

  const reportError = useCallback(
    (error: unknown, fallback: string): void => {
      dispatch({
        type: "event",
        event: {
          type: "diagnostic",
          level: "error",
          message: error instanceof Error ? error.message : fallback,
        },
      });
    },
    [dispatch],
  );
  const loadModels = useCallback(async (): Promise<void> => {
    setModelsState((current) => ({
      status: "loading",
      models: current.models,
    }));
    try {
      const auth = await window.desktop.agents.getAuthStatus();
      if (auth.state !== "authenticated") {
        setModelsState((current) => ({
          status: "failed",
          models: current.models,
          message: auth.message,
          auth,
        }));
        return;
      }
      setModelsState({
        status: "loaded",
        models: await window.desktop.agents.listModels(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Models could not be loaded";
      setModelsState((current) => ({
        status: "failed",
        models: current.models,
        message,
      }));
      reportError(error, "Models could not be loaded");
    }
  }, [reportError]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);
  const reconcileAgent = (
    instance: DesktopActiveAgent,
    change: Extract<
      DesktopAppEvent,
      { type: "agent.instance_changed" }
    >["change"],
  ): void => {
    dispatch({
      type: "event",
      event: { type: "agent.instance_changed", instance, change },
    });
  };
  const runAgentAction = async (
    instanceId: string,
    action: () => Promise<DesktopActiveAgent>,
    fallback: string,
    change: Extract<
      DesktopAppEvent,
      { type: "agent.instance_changed" }
    >["change"],
  ): Promise<DesktopActiveAgent | undefined> => {
    if (session === undefined) return undefined;
    setBusyAgentId(instanceId);
    try {
      const updated = await action();
      reconcileAgent(updated, change);
      return updated;
    } catch (error) {
      reportError(error, fallback);
      return undefined;
    } finally {
      setBusyAgentId(undefined);
    }
  };
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const catalog = await window.desktop.agents.refreshCatalog();
      dispatch({
        type: "event",
        event: { type: "agents.catalog_changed", catalog },
      });
    } catch (error) {
      reportError(error, "Agent definitions could not be refreshed");
    } finally {
      setRefreshing(false);
    }
  };
  const createAgent = async (definitionName: string): Promise<void> => {
    if (session === undefined) return;
    setCreatingDefinition(definitionName);
    try {
      const created = await window.desktop.agents.create(definitionName);
      reconcileAgent(created, "created");
      setInspectedKey(`active:${created.id}`);
    } catch (error) {
      reportError(error, `Could not create ${definitionName}`);
    } finally {
      setCreatingDefinition(undefined);
    }
  };
  const saveDefinition = async (
    definition: DesktopAgentDefinition,
    draft: CurrentAgentDefinition,
  ): Promise<boolean> => {
    if (session === undefined) {
      reportError(
        new Error("Restore a production session before saving an agent."),
        "Could not save agent definition",
      );
      return false;
    }
    setSavingDefinitionName(definition.name);
    try {
      const profileStatus = await window.desktop.profiles.status();
      const profileSnapshot = await window.desktop.profiles.get(
        profileStatus.activeProfile,
      );
      const saved = await window.desktop.agents.saveDefinition(
        draft,
        profileSnapshot.revision,
        definition.fingerprint,
      );
      dispatch({
        type: "event",
        event: { type: "agents.catalog_changed", catalog: saved.catalog },
      });
      onProfilesChanged?.();
      return true;
    } catch (error) {
      reportError(error, `Could not save ${definition.name}`);
      return false;
    } finally {
      setSavingDefinitionName(undefined);
    }
  };
  const startNewAgent = (): void => {
    setNewAgent((current) => current ?? emptyNewAgentDraft());
    setInspectedKey(NEW_AGENT_KEY);
  };
  const discardNewAgent = (): void => {
    setNewAgent(undefined);
    setInspectedKey(defaultInspectedKey);
  };
  const createDefinition = async (draft: NewAgentDraft): Promise<void> => {
    if (session === undefined) return;
    const definition = newAgentDefinition(
      draft,
      state.agentCatalog.definitions,
    );
    setSavingDefinitionName(definition.name);
    try {
      const profileStatus = await window.desktop.profiles.status();
      const profileSnapshot = await window.desktop.profiles.get(
        profileStatus.activeProfile,
      );
      const created = await window.desktop.agents.createDefinition(
        definition,
        profileSnapshot.revision,
      );
      dispatch({
        type: "event",
        event: { type: "agents.catalog_changed", catalog: created.catalog },
      });
      setNewAgent(undefined);
      setInspectedKey(`definition:${definition.name}`);
      onProfilesChanged?.();
    } catch (error) {
      reportError(error, `Could not create ${definition.label}`);
    } finally {
      setSavingDefinitionName(undefined);
    }
  };
  const selectAgent = async (
    instanceId: string,
    open: boolean,
  ): Promise<void> => {
    const selected = await runAgentAction(
      instanceId,
      () => window.desktop.agents.select(instanceId),
      "Could not select agent",
      "selected",
    );
    if (selected !== undefined) {
      if (open) dispatch({ type: "view", view: "workspace" });
    }
  };
  const deactivateAgent = async (instanceId: string): Promise<void> => {
    const deactivated = activeAgents.find(({ id }) => id === instanceId);
    if (session === undefined || deactivated === undefined) return;
    setBusyAgentId(instanceId);
    try {
      await window.desktop.agents.deactivate(instanceId);
      reconcileAgent(deactivated, "deactivated");
    } catch (error) {
      reportError(error, "Could not deactivate agent");
    } finally {
      setBusyAgentId(undefined);
    }
  };
  return (
    <section className="agents-view" aria-labelledby="agents-heading">
      <div className="library-bar">
        <h2 className="library-title" id="agents-heading">
          Agents
        </h2>
        <ScopeFilterBar
          value={state.libraryScope}
          counts={scopeCounts}
          onChange={(scope) => dispatch({ type: "library-scope", scope })}
        />
        <span className="spacer" />
        <button disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh definitions"}
        </button>
        <button
          type="button"
          className="primary"
          disabled={session === undefined}
          onClick={startNewAgent}
        >
          New agent
        </button>
      </div>
      {state.agentCatalog.diagnostics.length > 0 && (
        <div className="agent-diagnostics" role="status">
          <strong>Definition diagnostics</strong>
          {state.agentCatalog.diagnostics.map((diagnostic) => (
            <p key={`${diagnostic.sourceFile}:${diagnostic.code}`}>
              {diagnostic.sourceFile}: {diagnostic.message}
            </p>
          ))}
        </div>
      )}
      {modelsState.status === "loading" && (
        <p role="status">Loading Copilot models…</p>
      )}
      {modelsState.status === "failed" && (
        <div className="notice" role="alert">
          {modelsState.auth?.state === "authentication-required" ||
          modelsState.auth?.state === "cli-unavailable" ||
          modelsState.auth?.state === "credential-invalid-or-expired" ? (
            <>
              <strong>GitHub authentication required.</strong>
              <span>{modelsState.message}</span>
              <span>
                Run <code>gh auth login</code> in Terminal, then check again.
              </span>
              <button
                onClick={() =>
                  void navigator.clipboard.writeText("gh auth login")
                }
              >
                Copy sign-in command
              </button>
              <button
                onClick={() =>
                  void window.desktop.agents
                    .refreshAuthentication()
                    .then(() => loadModels())
                    .catch((error: unknown) => {
                      const message =
                        error instanceof Error
                          ? error.message
                          : "Authentication could not be refreshed";
                      setModelsState((current) => ({
                        status: "failed",
                        models: current.models,
                        message,
                        auth: {
                          state: "transient-failure",
                          message,
                        },
                      }));
                      reportError(error, message);
                    })
                }
              >
                Check again
              </button>
            </>
          ) : (
            <>
              <span>
                Copilot models could not be loaded: {modelsState.message}
              </span>
              <button onClick={() => void loadModels()}>Retry models</button>
            </>
          )}
        </div>
      )}
      {modelsState.status === "loaded" && modelsState.models.length === 0 && (
        <div className="notice" role="status">
          No explicit Copilot models are available. Agents can still use SDK
          default.
        </div>
      )}
      {session === undefined && (
        <div className="notice" role="status">
          Agent controls will be available after the production session is
          restored.
        </div>
      )}
      {state.lifecycle === "starting" && session === undefined ? (
        <p role="status">Loading active agents…</p>
      ) : state.agentCatalog.definitions.length === 0 &&
        activeAgents.length === 0 &&
        newAgent === undefined ? (
        <EmptyState
          title="No valid agents found"
          detail="Add YAML definitions to the configured agents directory."
        />
      ) : (
        <div className="agents-workspace">
          <nav className="agent-navigation" aria-label="Agents">
            <div className="agent-navigation-list">
              {activeAgents.length > 0 && (
                <div className="agent-navigation-divider">In this session</div>
              )}
              {activeAgents
                .filter(({ definitionName }) => inScope(definitionName))
                .map((agent) => {
                  const key = `active:${agent.id}`;
                  const definition = state.agentCatalog.definitions.find(
                    ({ name }) => name === agent.definitionName,
                  );
                  return (
                    <AgentListRow
                      key={key}
                      label={agent.label}
                      description={
                        definition?.description ?? agent.definitionName
                      }
                      color={agentColor(
                        state.agentCatalog.definitions,
                        agent.definitionName,
                      )}
                      active
                      origin={definition?.origin}
                      delegatable={definition?.delegatable === true}
                      selected={inspectedKey === key}
                      onSelect={() => setInspectedKey(key)}
                    />
                  );
                })}
              {inactiveDefinitions.length > 0 && (
                <div className="agent-navigation-divider">Available</div>
              )}
              {inactiveDefinitions
                .filter(({ name }) => inScope(name))
                .map((definition) => {
                  const key = `definition:${definition.name}`;
                  return (
                    <AgentListRow
                      key={key}
                      label={definition.label ?? definition.name}
                      description={definition.description}
                      color={
                        definition.color ?? defaultAgentColor(definition.name)
                      }
                      active={false}
                      origin={definition.origin}
                      delegatable={definition.delegatable === true}
                      selected={inspectedKey === key}
                      onSelect={() => setInspectedKey(key)}
                    />
                  );
                })}
              {newAgent !== undefined && (
                <button
                  type="button"
                  className={`agent-navigation-item ${inspectedKey === NEW_AGENT_KEY ? "active" : ""}`}
                  aria-current={
                    inspectedKey === NEW_AGENT_KEY ? "page" : undefined
                  }
                  data-scope="session"
                  onClick={() => setInspectedKey(NEW_AGENT_KEY)}
                >
                  <span className="row-strip" aria-hidden="true" />
                  <span className="agent-navigation-label">
                    <strong>{newAgent.label.trim() || "Untitled agent"}</strong>
                  </span>
                  <span className="row-marks">New</span>
                </button>
              )}
            </div>
          </nav>
          <div className="agent-detail-workspace">
            {activeAgents.map((agent) => {
              const resolvedDefinition =
                state.agentCatalog.definitions.find(
                  (candidate) => candidate.name === agent.definitionName,
                ) ?? desktopDefinitionFromActiveAgent(agent);
              const definition: DesktopAgentDefinition = {
                ...resolvedDefinition,
                label: resolvedDefinition.label ?? agent.label,
                model:
                  resolvedDefinition.model === undefined
                    ? (agent.model ?? null)
                    : resolvedDefinition.model,
                reasoningEffort:
                  resolvedDefinition.reasoningEffort === undefined
                    ? (agent.reasoningEffort ?? null)
                    : resolvedDefinition.reasoningEffort,
                autoApprove:
                  resolvedDefinition.autoApprove ?? agent.autoApprove,
              };
              return (
                <ActiveAgentCard
                  definition={definition}
                  scopeActions={
                    <ArtifactScopeActions
                      profiles={profiles}
                      kind="agent"
                      name={definition.name}
                      origin={definition.origin}
                      onProfilesChanged={onProfilesChanged}
                    />
                  }
                  agent={agent}
                  availableSkills={state.agentCatalog.skills}
                  liveTracks={state.snapshot?.tracks}
                  liveSelectedTrackId={state.selectedTrackId}
                  models={modelsState.models}
                  modelsStatus={modelsState.status}
                  definitionUpdated={state.agentCatalog.definitions.some(
                    (candidate) =>
                      candidate.name === agent.definitionName &&
                      candidate.fingerprint !== agent.definitionFingerprint,
                  )}
                  selected={selectedAgentId === agent.id}
                  hidden={inspectedKey !== `active:${agent.id}`}
                  creating={creatingDefinition === agent.definitionName}
                  busy={
                    busyAgentId === agent.id ||
                    savingDefinitionName === definition.name ||
                    agent.lifecycle === "busy"
                  }
                  canPersist={session !== undefined}
                  canCreate={session !== undefined}
                  confirmingReset={confirmResetId === agent.id}
                  onSaveDefinition={(draft) =>
                    saveDefinition(definition, draft)
                  }
                  onReset={() => {
                    if (confirmResetId !== agent.id) {
                      setConfirmResetId(agent.id);
                      return Promise.resolve(undefined);
                    }
                    setConfirmResetId(undefined);
                    return runAgentAction(
                      agent.id,
                      () => window.desktop.agents.reset(agent.id),
                      "Could not reset agent",
                      "reset",
                    );
                  }}
                  onCancelReset={() => setConfirmResetId(undefined)}
                  onSelect={() => selectAgent(agent.id, false)}
                  onOpen={() => selectAgent(agent.id, true)}
                  onCreateAnother={() => createAgent(agent.definitionName)}
                  onDeactivate={() => deactivateAgent(agent.id)}
                  key={agent.id}
                />
              );
            })}
            {inactiveDefinitions.map((definition) => (
              <ActiveAgentCard
                definition={definition}
                scopeActions={
                  <ArtifactScopeActions
                    profiles={profiles}
                    kind="agent"
                    name={definition.name}
                    origin={definition.origin}
                    onProfilesChanged={onProfilesChanged}
                  />
                }
                hidden={inspectedKey !== `definition:${definition.name}`}
                busy={
                  creatingDefinition === definition.name ||
                  savingDefinitionName === definition.name
                }
                canPersist={session !== undefined}
                canCreate={session !== undefined}
                creating={creatingDefinition === definition.name}
                confirmingReset={false}
                selected={false}
                availableSkills={state.agentCatalog.skills}
                liveTracks={state.snapshot?.tracks}
                liveSelectedTrackId={state.selectedTrackId}
                models={modelsState.models}
                modelsStatus={modelsState.status}
                definitionUpdated={false}
                onSaveDefinition={(draft) => saveDefinition(definition, draft)}
                onCreateAnother={() => createAgent(definition.name)}
                key={definition.name}
              />
            ))}
            {newAgent !== undefined && (
              <NewAgentCard
                draft={newAgent}
                hidden={inspectedKey !== NEW_AGENT_KEY}
                saving={savingDefinitionName !== undefined}
                canCreate={session !== undefined}
                fileName={`${uniqueAgentName(newAgent.label, state.agentCatalog.definitions)}.yaml`}
                onChange={setNewAgent}
                onDiscard={discardNewAgent}
                onCreate={() => void createDefinition(newAgent)}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const NEW_AGENT_KEY = "new-agent";

interface NewAgentDraft {
  readonly label: string;
  readonly description: string;
  readonly systemPrompt: string;
}

function emptyNewAgentDraft(): NewAgentDraft {
  return {
    label: "",
    description: "",
    systemPrompt:
      "You help the user with their Ableton Live set. Describe this agent's focus here.",
  };
}

function uniqueAgentName(
  label: string,
  definitions: readonly DesktopAgentDefinition[],
): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^[^a-z]+/u, "")
      .replace(/-+$/u, "")
      .slice(0, 56) || "agent";
  const taken = new Set(definitions.map(({ name }) => name));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function newAgentDefinition(
  draft: NewAgentDraft,
  definitions: readonly DesktopAgentDefinition[],
): CurrentAgentDefinition {
  const name = uniqueAgentName(draft.label, definitions);
  const used = new Set(definitions.map(({ color }) => color));
  return {
    version: 2,
    name,
    label: draft.label.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    tools: ["*"],
    editScope: ["session"],
    skills: [],
    model: null,
    reasoningEffort: null,
    autoApprove: false,
    delegatable: false,
    hideResultFromParent: false,
    color:
      AGENT_COLOR_PALETTE.find((color) => !used.has(color)) ??
      defaultAgentColor(name),
  };
}

function NewAgentCard({
  draft,
  hidden,
  saving,
  canCreate,
  fileName,
  onChange,
  onDiscard,
  onCreate,
}: {
  draft: NewAgentDraft;
  hidden: boolean;
  saving: boolean;
  canCreate: boolean;
  fileName: string;
  onChange: (draft: NewAgentDraft) => void;
  onDiscard: () => void;
  onCreate: () => void;
}): React.JSX.Element {
  const ready =
    draft.label.trim().length > 0 &&
    draft.description.trim().length > 0 &&
    draft.systemPrompt.trim().length > 0;
  return (
    <article className="agent-detail" hidden={hidden} aria-label="New agent">
      <header className="agent-detail-header">
        <div>
          <div className="agent-title-line">
            <h3>{draft.label.trim() || "New agent"}</h3>
            <ScopeChip origin="session" />
            <span className="scope-badge">Unsaved</span>
          </div>
          <p>
            Starts with every tool and the whole set in scope. You can change
            that after it is created.
          </p>
        </div>
        <div className="agent-header-actions">
          <button type="button" disabled={saving} onClick={onDiscard}>
            Discard
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canCreate || saving || !ready}
            onClick={onCreate}
          >
            {saving ? "Creating…" : "Create in Session"}
          </button>
        </div>
      </header>
      <div className="agent-detail-body">
        <div className="skill-overview-grid">
          <label>
            Display name
            <input
              value={draft.label}
              maxLength={128}
              placeholder="Drum coach"
              onChange={(event) =>
                onChange({ ...draft, label: event.currentTarget.value })
              }
            />
            <small className="field-help">Saved as {fileName}</small>
          </label>
          <label>
            Description
            <textarea
              value={draft.description}
              rows={3}
              maxLength={512}
              placeholder="What this agent is for, in one or two sentences."
              onChange={(event) =>
                onChange({ ...draft, description: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Instructions
            <textarea
              value={draft.systemPrompt}
              rows={10}
              onChange={(event) =>
                onChange({ ...draft, systemPrompt: event.currentTarget.value })
              }
            />
          </label>
        </div>
      </div>
    </article>
  );
}

function countByScope(
  scopes: readonly DesktopArtifactScope[],
): Partial<Record<DesktopArtifactScope, number>> {
  const counts: Partial<Record<DesktopArtifactScope, number>> = {};
  for (const scope of scopes) counts[scope] = (counts[scope] ?? 0) + 1;
  return counts;
}

function AgentListRow({
  label,
  description,
  color,
  active,
  origin,
  delegatable,
  selected,
  onSelect,
}: {
  label: string;
  description?: string | undefined;
  color: string;
  active: boolean;
  origin: DesktopAgentDefinition["origin"];
  delegatable: boolean;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`agent-navigation-item ${selected ? "active" : ""}`}
      aria-current={selected ? "page" : undefined}
      title={description}
      style={{ "--row-color": color } as CSSProperties}
      onClick={onSelect}
    >
      <span className="row-strip" aria-hidden="true" />
      <span
        className={`agent-activity-light ${active ? "is-active" : ""}`}
        role="img"
        aria-label={active ? "Active agent" : "Inactive agent"}
      />
      <span className="agent-navigation-label">
        <strong>{label}</strong>
      </span>
      <span className="row-marks">
        {(origin === undefined || origin === "bundled") && (
          <span role="img" aria-label="Bundled" title="Bundled with the app">
            <Icon name="lock" />
          </span>
        )}
        {delegatable && (
          <span
            role="img"
            aria-label="Can be a sub-agent"
            title="Can be a sub-agent"
          >
            ⇉
          </span>
        )}
      </span>
    </button>
  );
}

function SkillUsedBy({
  skillName,
  definitions,
}: {
  skillName: string;
  definitions: readonly DesktopAgentDefinition[];
}): React.JSX.Element {
  const users = definitions.filter(({ skills }) => skills.includes(skillName));
  return (
    <div className="tag-list" aria-label="Used by">
      <span className="behavior-label">Used by</span>
      {users.length === 0 ? (
        <span className="behavior-label">No agent preloads it yet</span>
      ) : (
        users.map((definition) => (
          <span
            key={definition.name}
            className="tag"
            style={
              {
                "--tag-color":
                  definition.color ?? defaultAgentColor(definition.name),
              } as CSSProperties
            }
          >
            {definition.label ?? definition.name}
          </span>
        ))
      )}
    </div>
  );
}

function ArtifactScopeActions({
  profiles,
  kind,
  name,
  origin,
  onProfilesChanged,
}: {
  profiles: ReturnType<typeof useProfileSnapshot>;
  kind: "agent" | "skill";
  name: string;
  origin: DesktopAgentDefinition["origin"];
  onProfilesChanged?: (() => void) | undefined;
}): React.JSX.Element {
  const artifact = findContextArtifact(profiles.snapshot, kind, name, origin);
  return (
    <>
      <ScopeChip origin={origin} />
      {profiles.snapshot !== undefined && artifact !== undefined && (
        <ScopeActions
          snapshot={profiles.snapshot}
          artifact={artifact}
          onSnapshot={profiles.setSnapshot}
          onChanged={onProfilesChanged}
        />
      )}
    </>
  );
}

function desktopDefinitionFromActiveAgent(
  agent: DesktopActiveAgent,
): DesktopAgentDefinition {
  return {
    version: 2,
    name: agent.definitionName,
    label: agent.label,
    color: defaultAgentColor(agent.definitionName),
    description: agent.config.description,
    systemPrompt: agent.config.systemPrompt,
    tools: agent.config.tools,
    resolvedTools: agent.config.resolvedTools,
    editScope: agent.config.editScope,
    skills: agent.config.skills,
    model: agent.model ?? null,
    reasoningEffort: agent.reasoningEffort ?? null,
    autoApprove: agent.autoApprove,
    origin: "session",
    inherited: false,
    overrides: [],
    sourceFile: `${agent.definitionName}.yaml`,
    fingerprint: agent.definitionFingerprint,
  };
}

export function reasoningOptionsForModel(
  modelId: string,
  models: readonly DesktopAgentModel[],
): AgentReasoningEffort[] {
  if (modelId === "") return [];
  const model = models.find(({ id }) => id === modelId);
  if (
    model === undefined ||
    model.policyState !== "enabled" ||
    !model.capabilities.reasoningEffort
  ) {
    return [];
  }
  return writableReasoningEfforts.filter((effort) =>
    model.supportedReasoningEfforts.includes(effort),
  );
}

export function reasoningEffortForDraftModel(
  modelId: string,
  reasoningEffort: string,
  models: readonly DesktopAgentModel[],
): string {
  return reasoningEffort === "" ||
    reasoningOptionsForModel(modelId, models).includes(
      reasoningEffort as AgentReasoningEffort,
    )
    ? reasoningEffort
    : "";
}

function modelReasoningLabel(model: DesktopAgentModel): string {
  if (!model.capabilities.reasoningEffort) {
    return "Reasoning effort is fixed by this model.";
  }
  const efforts = model.supportedReasoningEfforts.join(", ") || "not reported";
  return `Reasoning efforts: ${efforts}${
    model.defaultReasoningEffort === undefined
      ? ""
      : ` · default ${model.defaultReasoningEffort}`
  }`;
}

const TOOL_GROUPS: readonly { label: string; tools: readonly string[] }[] = [
  {
    label: "Transport",
    tools: [
      "ableton_transport",
      "ableton_session",
      "ableton_context",
      "ableton_selection_view",
      "ableton_live_history",
    ],
  },
  {
    label: "Tracks",
    tools: [
      "ableton_tracks",
      "ableton_mixer_routing",
      "ableton_scenes",
      "ableton_arrangement",
    ],
  },
  {
    label: "Clips & notes",
    tools: [
      "ableton_session_clips",
      "ableton_audio_clips",
      "ableton_midi_notes",
      "ableton_clip_automation",
      "ableton_warp_markers",
      "ableton_grooves",
    ],
  },
  {
    label: "Devices",
    tools: [
      "ableton_devices",
      "ableton_special_devices",
      "ableton_browser",
      "ableton_browser_adapters",
    ],
  },
  { label: "Listen", tools: ["ableton_listening"] },
  { label: "Record", tools: ["ableton_recording"] },
  {
    label: "Ask & plan",
    tools: ["ask_user", "exit_plan_mode", "read_plan", "write_plan"],
  },
  { label: "Skills", tools: ["skill"] },
  { label: "Shell", tools: ["bash"] },
];

/** Tools that "*" never grants; they must be listed by name. */
const SUB_AGENT_TOOL_GROUP = {
  label: "Sub-agents",
  tools: ["task", "read_agent", "write_agent", "list_agents"],
} as const;

const PICKER_TOOL_GROUPS = [...TOOL_GROUPS, SUB_AGENT_TOOL_GROUP];
const WILDCARD_TOOLS = TOOL_GROUPS.flatMap(({ tools }) => tools);
const EXPLICIT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  ...SUB_AGENT_TOOL_GROUP.tools,
  "task_complete",
  "send_inbox",
  "context_board",
]);

function toolPatternMatches(pattern: string, tool: string): boolean {
  if (!pattern.includes("*")) return pattern === tool;
  if (EXPLICIT_ONLY_TOOLS.has(tool)) return false;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(tool);
}

export interface ToolPickerState {
  /** Patterns the picker can't show as checkboxes (operation ids and the like). */
  custom: string[];
  selected: Set<string>;
  all: boolean;
}

export function toolPickerState(patterns: readonly string[]): ToolPickerState {
  const known = PICKER_TOOL_GROUPS.flatMap(({ tools }) => tools);
  const selected = new Set(
    known.filter((tool) =>
      patterns.some((pattern) => toolPatternMatches(pattern, tool)),
    ),
  );
  return {
    custom: patterns.filter(
      (pattern) => !known.some((tool) => toolPatternMatches(pattern, tool)),
    ),
    selected,
    all: WILDCARD_TOOLS.every((tool) => selected.has(tool)),
  };
}

/** Writes a picker selection back as patterns: "*" when every wildcard tool is on. */
export function toolPatternsFromSelection(
  selected: ReadonlySet<string>,
): string[] {
  const ordered = PICKER_TOOL_GROUPS.flatMap(({ tools }) => tools).filter(
    (tool) => selected.has(tool),
  );
  return WILDCARD_TOOLS.every((tool) => selected.has(tool))
    ? ["*", ...ordered.filter((tool) => EXPLICIT_ONLY_TOOLS.has(tool))]
    : ordered;
}

function toolLabel(tool: string): string {
  const words = tool.replace(/^ableton_/u, "").replace(/_/gu, " ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return label.replace(/\bmidi\b/giu, "MIDI");
}

export function ToolPicker({
  agentTitle,
  patterns,
  onChange,
}: {
  agentTitle: string;
  patterns: readonly string[];
  onChange: (patterns: string[]) => void;
}): React.JSX.Element {
  const state = toolPickerState(patterns);
  const locked = state.custom.length > 0;
  const update = (tools: readonly string[], on: boolean): void => {
    const next = new Set(state.selected);
    for (const tool of tools) {
      if (on) next.add(tool);
      else next.delete(tool);
    }
    onChange(toolPatternsFromSelection(next));
  };
  return (
    <div className="tool-picker">
      {locked && (
        <small className="tool-picker-note">
          Uses custom tool patterns ({state.custom.join(", ")}). Edit them under
          Advanced.
        </small>
      )}
      <label className="tool-picker-all">
        <input
          type="checkbox"
          checked={state.all}
          disabled={locked}
          onChange={(event) => update(WILDCARD_TOOLS, event.target.checked)}
        />
        <strong>All tools</strong>
        <small>Everything except sub-agents, which you add by hand.</small>
      </label>
      <ul className="tool-picker-groups" aria-label={`Tools for ${agentTitle}`}>
        {PICKER_TOOL_GROUPS.map((group) => {
          const on = group.tools.filter((tool) => state.selected.has(tool));
          const checked = on.length === group.tools.length;
          const partial = on.length > 0 && !checked;
          return (
            <li key={group.label}>
              <details>
                <summary>
                  <input
                    type="checkbox"
                    aria-label={`Allow ${group.label} tools`}
                    checked={checked}
                    disabled={locked}
                    ref={(input) => {
                      if (input !== null) input.indeterminate = partial;
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      update(group.tools, event.target.checked)
                    }
                  />
                  <span className="tool-picker-group-name">{group.label}</span>
                  <small className="tool-picker-count">
                    {on.length} of {group.tools.length}
                  </small>
                </summary>
                <div className="tool-picker-tools">
                  {group.tools.map((tool) => (
                    <label key={tool} title={tool}>
                      <input
                        type="checkbox"
                        checked={state.selected.has(tool)}
                        disabled={locked}
                        onChange={(event) =>
                          update([tool], event.target.checked)
                        }
                      />
                      {toolLabel(tool)}
                    </label>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      {patterns.length === 0 && (
        <small className="tool-picker-note">Pick at least one tool.</small>
      )}
    </div>
  );
}

export function ResolvedToolsDisclosure({
  patterns,
  resolvedTools,
  resolvedOperations = [],
}: {
  patterns: readonly string[];
  resolvedTools: readonly string[];
  resolvedOperations?: readonly string[];
}): React.JSX.Element {
  const resolvedLabel =
    resolvedTools.length > 0 ? resolvedTools.join(", ") : "no available tools";
  const operationLabel =
    resolvedOperations.length > 0
      ? resolvedOperations.join(", ")
      : "all actions for resolved tools";
  if (patterns.some((pattern) => pattern.includes("*"))) {
    return (
      <details className="resolved-tools-disclosure">
        <summary>Resolved tools ({resolvedTools.length})</summary>
        <small>Tools: {resolvedLabel}</small>
        <small>Operations: {operationLabel}</small>
      </details>
    );
  }
  return (
    <small>
      Resolves to: {resolvedLabel} · {operationLabel}
    </small>
  );
}

function listValue(values: string[]): string {
  return values.join("\n");
}

function parseList(value: string): string[] {
  return value
    .split(/\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTrackScope(
  value: string,
): DesktopActiveAgent["config"]["editScope"] {
  const tracks = parseList(value).map((entry) => {
    const match = /^(.*?)(?:\s+#(\d+))?$/u.exec(entry);
    const occurrence = Math.max(0, Number(match?.[2] ?? "1") - 1);
    return {
      track: { name: match?.[1]?.trim() || entry, occurrence },
    };
  });
  return tracks.length > 0 ? tracks : ["session"];
}

type TrackScopeSelector = { track: { name: string; occurrence: number } };

function trackSelectorKey({ track }: TrackScopeSelector): string {
  return `${track.occurrence}:${track.name}`;
}

/** Regular Live tracks keyed the way edit scope names them: name plus nth duplicate. */
export function scopeTrackOptions(
  tracks: readonly DesktopTrack[],
): { selector: TrackScopeSelector; track: DesktopTrack }[] {
  const seen = new Map<string, number>();
  return tracks
    .filter(({ kind }) => kind === "midi" || kind === "audio")
    .map((track) => {
      const occurrence = seen.get(track.name) ?? 0;
      seen.set(track.name, occurrence + 1);
      return { selector: { track: { name: track.name, occurrence } }, track };
    });
}

export function TrackScopePicker({
  agentTitle,
  tracks,
  selectors,
  onChange,
}: {
  agentTitle: string;
  tracks: readonly DesktopTrack[] | undefined;
  selectors: readonly TrackScopeSelector[];
  onChange: (selectors: TrackScopeSelector[]) => void;
}): React.JSX.Element {
  const options = scopeTrackOptions(tracks ?? []);
  const selectedKeys = new Set(selectors.map(trackSelectorKey));
  const optionKeys = new Set(
    options.map(({ selector }) => trackSelectorKey(selector)),
  );
  const missing = selectors.filter(
    (selector) => !optionKeys.has(trackSelectorKey(selector)),
  );
  const toggle = (selector: TrackScopeSelector, on: boolean): void => {
    const key = trackSelectorKey(selector);
    onChange(
      on
        ? [...selectors, selector]
        : selectors.filter((entry) => trackSelectorKey(entry) !== key),
    );
  };
  const duplicateNames = new Set(
    options
      .filter(({ selector }) => selector.track.occurrence > 0)
      .map(({ selector }) => selector.track.name),
  );
  const label = ({ track }: TrackScopeSelector): string =>
    duplicateNames.has(track.name) || track.occurrence > 0
      ? `${track.name} #${track.occurrence + 1}`
      : track.name;
  return (
    <div
      className="track-scope-picker"
      role="group"
      aria-label={`Tracks ${agentTitle} can edit`}
    >
      {tracks === undefined && (
        <small>Connect to Live to pick from your tracks.</small>
      )}
      {tracks !== undefined && options.length === 0 && (
        <small>This set has no audio or MIDI tracks yet.</small>
      )}
      {options.map(({ selector, track }) => (
        <label
          key={track.id}
          className="track-scope-option"
          style={{ "--track-color": track.color } as CSSProperties}
          title={label(selector)}
        >
          <input
            type="checkbox"
            checked={selectedKeys.has(trackSelectorKey(selector))}
            onChange={(event) => toggle(selector, event.target.checked)}
          />
          <span className="track-color" aria-hidden="true" />
          <span className="track-scope-name">{label(selector)}</span>
        </label>
      ))}
      {missing.map((selector) => (
        <label
          key={trackSelectorKey(selector)}
          className="track-scope-option missing"
          title={`${label(selector)} isn't in the current set`}
        >
          <input
            type="checkbox"
            checked
            onChange={() => toggle(selector, false)}
          />
          <span className="track-color" aria-hidden="true" />
          <span className="track-scope-name">
            {label(selector)}
            {tracks !== undefined && <small> · not in this set</small>}
          </span>
        </label>
      ))}
      {selectors.length === 0 && (
        <small className="tool-picker-note">Pick at least one track.</small>
      )}
    </div>
  );
}

export function AgentModelEditor({
  agentLabel,
  currentModelId,
  currentReasoningEffort,
  model,
  reasoningEffort,
  models,
  modelsStatus,
  busy,
  confirming,
  onModelChange,
  onReasoningEffortChange,
  onRequestConfirmation,
  onConfirm,
  onCancel,
}: {
  agentLabel: string;
  currentModelId?: string | undefined;
  currentReasoningEffort?: AgentReasoningEffort | undefined;
  model: string;
  reasoningEffort: string;
  models: readonly DesktopAgentModel[];
  modelsStatus: "loading" | "loaded" | "failed";
  busy: boolean;
  confirming: boolean;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (reasoningEffort: string) => void;
  onRequestConfirmation: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const selectedModel = models.find(({ id }) => id === model);
  const currentModel = models.find(({ id }) => id === currentModelId);
  const reasoningOptions = reasoningOptionsForModel(model, models);
  const currentModelUnavailable =
    currentModelId !== undefined &&
    (currentModel === undefined || currentModel.policyState !== "enabled");
  const currentReasoningUnavailable =
    currentReasoningEffort !== undefined &&
    reasoningEffort === currentReasoningEffort &&
    !reasoningOptions.includes(currentReasoningEffort);
  const modelChanged = model !== (currentModelId ?? "");
  const reasoningChanged = reasoningEffort !== (currentReasoningEffort ?? "");
  const modelSelectable =
    model === "" || selectedModel?.policyState === "enabled";
  const reasoningSelectable =
    reasoningEffort === "" ||
    reasoningOptions.includes(reasoningEffort as AgentReasoningEffort);
  return (
    <fieldset>
      <legend>Conversation settings</legend>
      <label>
        Model
        <select
          aria-label={`Model for ${agentLabel}`}
          disabled={busy || modelsStatus !== "loaded"}
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
        >
          <option value="">SDK default</option>
          {currentModelUnavailable && (
            <option disabled value={currentModelId}>
              {currentModelId} (unavailable)
            </option>
          )}
          {models
            .filter(({ policyState }) => policyState === "enabled")
            .map((availableModel) => {
              return (
                <option key={availableModel.id} value={availableModel.id}>
                  {availableModel.displayName} ({availableModel.id})
                </option>
              );
            })}
        </select>
      </label>
      {selectedModel !== undefined && (
        <small>{modelReasoningLabel(selectedModel)}</small>
      )}
      <label>
        Reasoning
        <select
          aria-label={`Reasoning for ${agentLabel}`}
          disabled={
            busy ||
            modelsStatus !== "loaded" ||
            (reasoningOptions.length === 0 && !currentReasoningUnavailable)
          }
          value={reasoningEffort}
          onChange={(event) => onReasoningEffortChange(event.target.value)}
        >
          <option value="">Model default</option>
          {currentReasoningUnavailable && (
            <option disabled value={currentReasoningEffort}>
              {currentReasoningEffort} (unavailable)
            </option>
          )}
          {reasoningOptions.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
      {modelsStatus === "loading" && <small>Loading models…</small>}
      {modelsStatus === "failed" && (
        <small>
          Model catalog unavailable. SDK default remains selectable.
        </small>
      )}
      {confirming ? (
        <div className="notice" role="alert">
          <p>
            Changing the model or reasoning starts a fresh Conversation. Live
            track bindings, listening events, outputs, and this Agent instance
            will remain.
          </p>
          <button disabled={busy} onClick={onConfirm}>
            {busy ? "Changing settings…" : "Start fresh Conversation"}
          </button>
          <button disabled={busy} onClick={onCancel}>
            Cancel settings change
          </button>
        </div>
      ) : (
        <button
          disabled={
            busy ||
            (!modelChanged && !reasoningChanged) ||
            !modelSelectable ||
            !reasoningSelectable
          }
          onClick={onRequestConfirmation}
        >
          Apply conversation settings
        </button>
      )}
    </fieldset>
  );
}

function normalizedDefinition(
  definition: DesktopAgentDefinition,
): CurrentAgentDefinition {
  return {
    version: 2,
    name: definition.name,
    label: definition.label ?? definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: [...definition.tools],
    editScope: [...definition.editScope],
    skills: [...definition.skills],
    model: definition.model ?? null,
    reasoningEffort: definition.reasoningEffort ?? null,
    autoApprove: definition.autoApprove ?? false,
    delegatable: definition.delegatable ?? false,
    hideResultFromParent: definition.hideResultFromParent ?? false,
    color: definition.color,
  };
}

function ActiveAgentCard({
  definition,
  scopeActions,
  agent,
  availableSkills,
  liveTracks,
  liveSelectedTrackId,
  models,
  modelsStatus,
  definitionUpdated,
  selected,
  hidden,
  creating,
  busy,
  canPersist,
  canCreate,
  confirmingReset,
  onSaveDefinition,
  onReset,
  onCancelReset,
  onSelect,
  onOpen,
  onCreateAnother,
  onDeactivate,
}: {
  definition: DesktopAgentDefinition;
  scopeActions?: React.ReactNode;
  agent?: DesktopActiveAgent | undefined;
  availableSkills: DesktopState["agentCatalog"]["skills"];
  liveTracks?: readonly DesktopTrack[] | undefined;
  liveSelectedTrackId?: string | undefined;
  models: readonly DesktopAgentModel[];
  modelsStatus: "loading" | "loaded" | "failed";
  definitionUpdated: boolean;
  selected: boolean;
  hidden: boolean;
  creating: boolean;
  busy: boolean;
  canPersist: boolean;
  canCreate: boolean;
  confirmingReset: boolean;
  onSaveDefinition: (draft: CurrentAgentDefinition) => Promise<boolean>;
  onReset?: (() => Promise<DesktopActiveAgent | undefined>) | undefined;
  onCancelReset?: (() => void) | undefined;
  onSelect?: (() => Promise<void>) | undefined;
  onOpen?: (() => Promise<void>) | undefined;
  onCreateAnother: () => Promise<void>;
  onDeactivate?: (() => Promise<void>) | undefined;
}): React.JSX.Element {
  const [section, setSection] = useState<AgentDetailSection>("general");
  const initialDefinition = normalizedDefinition(definition);
  const [draft, setDraft] = useState(initialDefinition);
  const baselineRef = useRef(initialDefinition);
  const loadedRevisionRef = useRef(
    `${definition.fingerprint}:${definition.origin ?? "bundled"}`,
  );
  const [definitionChanged, setDefinitionChanged] = useState(false);
  const definitionRevision = `${definition.fingerprint}:${definition.origin ?? "bundled"}`;
  useEffect(() => {
    if (loadedRevisionRef.current === definitionRevision) return;
    const nextDefinition = normalizedDefinition(definition);
    setDraft((current) => {
      const hasLocalChanges =
        JSON.stringify(current) !== JSON.stringify(baselineRef.current);
      if (hasLocalChanges) {
        setDefinitionChanged(true);
        return current;
      }
      baselineRef.current = nextDefinition;
      loadedRevisionRef.current = definitionRevision;
      setDefinitionChanged(false);
      return nextDefinition;
    });
  }, [definitionRevision]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baselineRef.current);
  const scopeMode = draft.editScope.includes("session") ? "session" : "tracks";
  const trackSelectors = draft.editScope.filter(
    (entry): entry is TrackScopeSelector => entry !== "session",
  );
  const trackScope = trackSelectors
    .map((entry) => `${entry.track.name} #${entry.track.occurrence + 1}`)
    .join("\n");
  const firstScopeTrack = (): TrackScopeSelector => {
    const options = scopeTrackOptions(liveTracks ?? []);
    return (
      options.find(({ track }) => track.id === liveSelectedTrackId)?.selector ??
      options[0]?.selector ?? {
        track: { name: "Selected track", occurrence: 0 },
      }
    );
  };
  const model = draft.model ?? "";
  const reasoningEffort = draft.reasoningEffort ?? "";
  const reasoningOptions = reasoningOptionsForModel(model, models);
  const selectedModel = models.find(({ id }) => id === model);
  const modelUnavailable =
    model !== "" &&
    (selectedModel === undefined || selectedModel.policyState !== "enabled");
  const reasoningUnavailable =
    reasoningEffort !== "" && !reasoningOptions.includes(reasoningEffort);
  const save = async (): Promise<void> => {
    if (await onSaveDefinition(draft)) {
      baselineRef.current = draft;
      setDefinitionChanged(false);
      setDraft(draft);
    }
  };
  const reloadLatestDefinition = (): void => {
    const latest = normalizedDefinition(definition);
    baselineRef.current = latest;
    loadedRevisionRef.current = definitionRevision;
    setDefinitionChanged(false);
    setDraft(latest);
  };
  const resetActiveInstance = async (): Promise<void> => {
    await onReset?.();
  };
  const panelPrefix =
    agent === undefined
      ? `agent-definition-${definition.name}`
      : `active-agent-${agent.id}`;
  const title = draft.label;
  const active = agent !== undefined;
  const modified =
    dirty || definition.origin === "session" || agent?.modified === true;

  return (
    <article
      className={`agent-detail${active ? " active-agent-detail" : ""}${selected ? " is-selected" : ""}`}
      hidden={hidden}
    >
      <header className="agent-detail-header">
        <div>
          <div className="agent-title-line">
            <span
              className={`agent-activity-light ${active ? "is-active" : ""}`}
              role="img"
              aria-label={active ? "Active agent" : "Inactive agent"}
            />
            <h3
              style={
                {
                  "--agent-color": draft.color ?? defaultAgentColor(draft.name),
                } as CSSProperties
              }
              className="agent-detail-name"
            >
              {title}
            </h3>
            {scopeActions}
            {selected && <span className="agent-badge">Selected</span>}
            {draft.autoApprove && (
              <span className="agent-badge yolo-badge">YOLO</span>
            )}
            {modified && <span className="agent-badge">Modified</span>}
          </div>
          <p>{draft.description}</p>
        </div>
        <div className="agent-header-actions">
          {agent !== undefined && (
            <span className={`agent-lifecycle lifecycle-${agent.lifecycle}`}>
              {agent.lifecycle}
            </span>
          )}
          {agent !== undefined && !selected && (
            <button disabled={busy} onClick={() => void onSelect?.()}>
              Select
            </button>
          )}
          {agent !== undefined && (
            <button disabled={busy} onClick={() => void onOpen?.()}>
              Open
            </button>
          )}
          <button
            disabled={busy || creating || !canCreate}
            onClick={() => void onCreateAnother()}
          >
            {creating
              ? "Starting…"
              : agent === undefined
                ? "Start agent"
                : "Start another"}
          </button>
        </div>
      </header>
      <AgentDetailTabs
        section={section}
        panelIdPrefix={panelPrefix}
        onChange={setSection}
      />
      <div
        id={`${panelPrefix}-${section}`}
        className="agent-detail-content"
        role="tabpanel"
        aria-label={agentDetailSectionLabel(section)}
      >
        {definitionChanged && (
          <div className="notice" role="alert">
            <span>
              This definition changed outside the editor. Reload it before
              saving.
            </span>
            <button disabled={busy} onClick={reloadLatestDefinition}>
              Reload latest definition
            </button>
          </div>
        )}
        {section === "general" && (
          <div className="agent-editor-section">
            <label>
              Display name
              <input
                aria-label={`Display name for ${title}`}
                maxLength={128}
                required
                value={draft.label}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    label: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Description
              <textarea
                aria-label={`Description for ${title}`}
                maxLength={512}
                rows={3}
                required
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
              />
            </label>
            <h4 className="section-label">Behavior</h4>
            <div className="behavior-grid">
              <span className="behavior-label">Model</span>
              <select
                aria-label={`Model for ${title}`}
                disabled={busy || modelsStatus !== "loaded"}
                value={model}
                onChange={(event) => {
                  const nextModel = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    model: nextModel === "" ? null : nextModel,
                    reasoningEffort:
                      reasoningEffortForDraftModel(
                        nextModel,
                        current.reasoningEffort ?? "",
                        models,
                      ) === ""
                        ? null
                        : current.reasoningEffort,
                  }));
                }}
              >
                <option value="">SDK default</option>
                {modelUnavailable && (
                  <option disabled value={model}>
                    {model} (unavailable)
                  </option>
                )}
                {models
                  .filter(({ policyState }) => policyState === "enabled")
                  .map((availableModel) => (
                    <option key={availableModel.id} value={availableModel.id}>
                      {availableModel.displayName} ({availableModel.id})
                    </option>
                  ))}
              </select>
              <span className="behavior-label">Thinking</span>
              <select
                aria-label={`Reasoning for ${title}`}
                disabled={
                  busy ||
                  modelsStatus !== "loaded" ||
                  (reasoningOptions.length === 0 && !reasoningUnavailable)
                }
                value={reasoningEffort}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    reasoningEffort:
                      event.target.value === ""
                        ? null
                        : (event.target.value as AgentReasoningEffort),
                  }))
                }
              >
                <option value="">Model default</option>
                {reasoningUnavailable && (
                  <option disabled value={reasoningEffort}>
                    {reasoningEffort} (unavailable)
                  </option>
                )}
                {reasoningOptions.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <span className="behavior-label">Ask before edits</span>
              <label>
                <input
                  type="checkbox"
                  checked={!draft.autoApprove}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      autoApprove: !event.target.checked,
                    }))
                  }
                />
                Ask me before it changes Live
              </label>
              <span className="behavior-label">Sub-agent</span>
              <div className="behavior-stack">
                <label>
                  <input
                    type="checkbox"
                    checked={draft.delegatable}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        delegatable: event.target.checked,
                      }))
                    }
                  />
                  Can be a sub-agent: other agents can hand it tasks
                </label>
                <label className="behavior-sub-option">
                  <input
                    type="checkbox"
                    checked={draft.hideResultFromParent}
                    disabled={!draft.delegatable}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        hideResultFromParent: event.target.checked,
                      }))
                    }
                  />
                  As a sub-agent, hide its replies from the delegating agent
                </label>
              </div>
              <span className="behavior-label">Color</span>
              <div
                className="agent-color-picker"
                role="radiogroup"
                aria-label={`Color for ${title}`}
              >
                {AGENT_COLOR_PALETTE.map((color) => {
                  const selected =
                    (draft.color ?? defaultAgentColor(draft.name)) === color;
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`swatch ${selected ? "selected" : ""}`}
                      style={{ "--swatch": color } as CSSProperties}
                      role="radio"
                      aria-label={`Use color ${color} for ${title}`}
                      aria-checked={selected}
                      title={color}
                      onClick={() =>
                        setDraft((current) => ({ ...current, color }))
                      }
                    />
                  );
                })}
              </div>
            </div>
            <small>
              Changes become the Session definition default. Active
              conversations adopt them only after Reset.
            </small>
            <details className="advanced-disclosure">
              <summary>Advanced: source file and definition hash</summary>
              <dl className="agent-metadata">
                <dt>Definition</dt>
                <dd>
                  {definition.name} ·{" "}
                  <code title={definition.fingerprint}>
                    {definition.fingerprint.slice(0, 12)}
                  </code>
                  <small>
                    {definition.origin ?? "bundled"} · {definition.sourceFile}
                    {definitionUpdated
                      ? " · newer definition available; reset to adopt it"
                      : ""}
                  </small>
                </dd>
                <dt>Runtime</dt>
                <dd>
                  {active
                    ? "Active conversation using a definition snapshot"
                    : "Available to create in this production session"}
                </dd>
              </dl>
            </details>
          </div>
        )}
        {section === "capabilities" && (
          <div className="agent-editor-section agent-capabilities-editor">
            <label className="agent-prompt-editor">
              System prompt
              <textarea
                aria-label={`Session prompt for ${title}`}
                rows={12}
                value={draft.systemPrompt}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    systemPrompt: event.target.value,
                  }))
                }
              />
            </label>
            <h4 className="section-label">Can edit</h4>
            <div className="agent-scope-editor">
              <div
                className="segmented"
                role="radiogroup"
                aria-label={`What ${title} can edit`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={scopeMode === "session"}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      editScope: ["session"],
                    }))
                  }
                >
                  Whole set
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={scopeMode === "tracks"}
                  onClick={() =>
                    scopeMode === "tracks" ||
                    setDraft((current) => ({
                      ...current,
                      editScope: [firstScopeTrack()],
                    }))
                  }
                >
                  Selected tracks
                </button>
              </div>
              {scopeMode === "tracks" && (
                <TrackScopePicker
                  agentTitle={title}
                  tracks={liveTracks}
                  selectors={trackSelectors}
                  onChange={(selectors) =>
                    setDraft((current) => ({
                      ...current,
                      editScope: selectors,
                    }))
                  }
                />
              )}
            </div>
            <h4 className="section-label">Tools it can use</h4>
            <ToolPicker
              agentTitle={title}
              patterns={draft.tools}
              onChange={(tools) =>
                setDraft((current) => ({ ...current, tools }))
              }
            />
            <fieldset className="agent-skill-list">
              <legend>Skills</legend>
              {availableSkills.length === 0 ? (
                <small>No valid skills are available in the catalog.</small>
              ) : (
                availableSkills.map((skill) => (
                  <label key={skill.name}>
                    <input
                      type="checkbox"
                      checked={draft.skills.includes(skill.name)}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          skills: event.target.checked
                            ? [...current.skills, skill.name]
                            : current.skills.filter(
                                (name) => name !== skill.name,
                              ),
                        }))
                      }
                    />
                    <span className="agent-skill-text">
                      <span className="agent-skill-name">/{skill.name}</span>
                      <small>{skill.description}</small>
                    </span>
                  </label>
                ))
              )}
            </fieldset>
            <details className="advanced-disclosure">
              <summary>Advanced: tool patterns and track names</summary>
              {scopeMode === "tracks" && (
                <label>
                  Track names{" "}
                  <small>
                    One per line; add #2, #3… for tracks that share a name.
                  </small>
                  <textarea
                    aria-label={`Track scope for ${title}`}
                    placeholder={"Drums #1\nBass #1"}
                    rows={4}
                    value={trackScope}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        editScope: parseTrackScope(event.target.value),
                      }))
                    }
                  />
                </label>
              )}
              <label>
                Tool patterns{" "}
                <small>One per line; wildcards are supported.</small>
                <textarea
                  aria-label={`Tool patterns for ${title}`}
                  rows={6}
                  value={listValue(draft.tools)}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      tools: parseList(event.target.value),
                    }))
                  }
                />
              </label>
              <ResolvedToolsDisclosure
                patterns={draft.tools}
                resolvedTools={definition.resolvedTools}
                resolvedOperations={definition.resolvedOperations ?? []}
              />
            </details>
          </div>
        )}
      </div>
      <footer className="agent-detail-actions">
        <button
          disabled={
            busy ||
            !canPersist ||
            definitionChanged ||
            !dirty ||
            draft.label.trim() === "" ||
            draft.description.trim() === "" ||
            draft.systemPrompt.trim() === "" ||
            draft.tools.length === 0 ||
            (scopeMode === "tracks" &&
              draft.editScope.filter((entry) => entry !== "session").length ===
                0)
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save Session definition"}
        </button>
        <button disabled={busy || !dirty} onClick={reloadLatestDefinition}>
          Discard changes
        </button>
        {agent !== undefined &&
          (confirmingReset ? (
            <>
              <button
                className="danger-button"
                disabled={busy}
                onClick={() => void resetActiveInstance()}
              >
                Confirm reset
              </button>
              <button disabled={busy} onClick={onCancelReset}>
                Keep current conversation
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => void resetActiveInstance()}>
              Reset to current definition
            </button>
          ))}
        {agent !== undefined && (
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => void onDeactivate?.()}
          >
            Deactivate
          </button>
        )}
      </footer>
    </article>
  );
}

export async function refreshProjectSnapshot(
  connection: DesktopConnectionStatus,
  dispatch: DesktopDispatch,
  requestSnapshot: DesktopApi["ableton"]["requestSnapshot"],
): Promise<void> {
  if (connection.state !== "connected") {
    const message = "Connect to Ableton before refreshing the project.";
    dispatch({ type: "project-refresh-failed", message });
    dispatch({
      type: "event",
      event: { type: "diagnostic", level: "warning", message },
    });
    return;
  }

  dispatch({ type: "project-refresh-started" });
  try {
    const snapshot = await requestSnapshot();
    dispatch({
      type: "event",
      event: { type: "live_set.snapshot_changed", snapshot },
    });
    dispatch({ type: "project-refresh-succeeded" });
  } catch (error) {
    const message = boundRefreshMessage(
      error instanceof Error ? error.message : "Project refresh failed",
    );
    dispatch({ type: "project-refresh-failed", message });
    dispatch({
      type: "event",
      event: { type: "diagnostic", level: "warning", message },
    });
  }
}

export function ProjectOutline({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
}): React.JSX.Element {
  useEffect(() => {
    if (state.projectRefresh.status !== "succeeded") return;
    const timeout = globalThis.setTimeout(
      () => dispatch({ type: "project-refresh-reset" }),
      2_500,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [dispatch, state.projectRefresh.status]);

  const refreshLabel =
    state.projectRefresh.status === "refreshing"
      ? "Refreshing…"
      : state.projectRefresh.status === "succeeded"
        ? "Updated"
        : state.projectRefresh.status === "failed"
          ? "Retry"
          : "Refresh";
  const refreshStatus =
    state.projectRefresh.status === "refreshing"
      ? "Refreshing Live Set snapshot."
      : state.projectRefresh.status === "succeeded"
        ? "Live Set snapshot updated."
        : state.projectRefresh.status === "failed"
          ? state.projectRefresh.message
          : undefined;

  return (
    <aside
      id="project-sidebar"
      className="project-outline"
      aria-label="Project outline"
    >
      <div className="project-context-toggle">
        <div className="project-context-controls">
          <label>
            <input
              type="checkbox"
              role="switch"
              checked={state.projectSelectionContextEnabled}
              onChange={(event) =>
                dispatch({
                  type: "project-selection-context",
                  enabled: event.target.checked,
                })
              }
            />
            Use project selection as context
          </label>
          <button
            className="project-refresh-button"
            aria-label={`${refreshLabel} Live Set snapshot`}
            aria-describedby={
              refreshStatus === undefined ? undefined : "project-refresh-status"
            }
            disabled={state.projectRefresh.status === "refreshing"}
            onClick={() =>
              void refreshProjectSnapshot(state.connection, dispatch, () =>
                window.desktop.ableton.requestSnapshot(),
              )
            }
          >
            {refreshLabel}
          </button>
        </div>
        <small>
          {state.projectSelectionContextEnabled
            ? "Selected tracks, clips, and devices are included in prompts."
            : "Selections only control the Project and Inspector views."}
        </small>
        {refreshStatus !== undefined && (
          <span
            id="project-refresh-status"
            className={
              state.projectRefresh.status === "failed"
                ? "status status-error"
                : "status"
            }
            role={state.projectRefresh.status === "failed" ? "alert" : "status"}
          >
            {refreshStatus}
          </span>
        )}
      </div>
      {!state.snapshot ? (
        <EmptyState
          title="No snapshot"
          detail="Connect to Ableton to inspect tracks."
        />
      ) : (
        <ul className="tree" role="tree">
          {state.snapshot.tracks.map((track) => (
            <li
              key={track.id}
              role="treeitem"
              aria-selected={state.selectedTrackId === track.id}
            >
              <button
                className={`track-row ${state.selectedTrackId === track.id ? "active" : ""}`}
                style={{ "--track-color": track.color } as CSSProperties}
                title={track.name}
                onClick={() => dispatch({ type: "select-track", id: track.id })}
              >
                <span className="track-color" aria-hidden="true" />{" "}
                <strong>{track.name}</strong>
                <small>{track.kind}</small>
              </button>
              <ul>
                {track.clips.map((clip) => (
                  <li key={clip.id}>
                    <button
                      className={
                        state.selectedClipId === clip.id ? "active" : ""
                      }
                      onClick={() =>
                        dispatch({
                          type: "select-clip",
                          id: clip.id,
                          trackId: track.id,
                        })
                      }
                    >
                      ▤ {clip.name}
                    </button>
                  </li>
                ))}
                {track.devices.map((device) => (
                  <li key={device.id}>
                    <button
                      className={
                        state.selectedDeviceId === device.id ? "active" : ""
                      }
                      onClick={() =>
                        dispatch({
                          type: "select-device",
                          id: device.id,
                          trackId: track.id,
                        })
                      }
                    >
                      ◇ {device.name}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export function Timeline({
  state,
  scrollPositions,
}: {
  state: DesktopState;
  scrollPositions?: Map<string, number> | undefined;
}): React.JSX.Element {
  const workspace = selectedAgentWorkspace(state);
  const timelineRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const scrollKey = selectedAgentInstance(state)?.id ?? "no-agent";
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    const saved = scrollPositions?.get(scrollKey);
    timeline.scrollTop = saved ?? timeline.scrollHeight;
    followLatest.current = saved === undefined || isScrolledToEnd(timeline);
  }, [scrollKey, scrollPositions]);
  const items = useMemo(
    () =>
      [
        ...workspace.messages.map((item) => ({
          ...item,
          itemType: "message" as const,
        })),
        ...workspace.operations.map((item) => ({
          ...item,
          itemType: "operation" as const,
        })),
        ...workspace.triggers.map((item) => ({
          ...item,
          timestamp: Date.parse(item.observedAt) || 0,
          itemType: "trigger" as const,
        })),
      ]
        .sort(
          (left, right) =>
            Number(isActiveTimelineMessage(left)) -
              Number(isActiveTimelineMessage(right)) ||
            left.timestamp - right.timestamp,
        )
        .slice(-200),
    [workspace.messages, workspace.operations, workspace.triggers],
  );
  const latestUserMessageId = [...workspace.messages]
    .reverse()
    .find(({ role }) => role === "user")?.id;
  const followedUserMessageId = useRef(latestUserMessageId);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    if (followedUserMessageId.current !== latestUserMessageId) {
      followedUserMessageId.current = latestUserMessageId;
      followLatest.current = true;
    }
    if (followLatest.current) timeline.scrollTop = timeline.scrollHeight;
  }, [items, latestUserMessageId]);
  return (
    <div
      ref={timelineRef}
      className="timeline"
      aria-live="polite"
      aria-label="Recent activity"
      onScroll={(event) => {
        scrollPositions?.set(scrollKey, event.currentTarget.scrollTop);
        followLatest.current = isScrolledToEnd(event.currentTarget);
      }}
    >
      {items.length === 0 && (
        <EmptyState
          title="Ready to create"
          detail="Ask about the project, select context, or describe a production goal."
        />
      )}
      {items.map((item) =>
        item.itemType === "message" ? (
          <article
            key={`message-${item.id}`}
            className={`message ${item.role}`}
            data-agent-mode={item.agentMode ?? "interactive"}
          >
            <span className="sr-only">
              {item.role === "user" ? "You" : "Assistant"}:
            </span>
            {item.working !== undefined && (
              <WorkingDisclosure working={item.working} />
            )}
            {item.streaming && item.working === undefined && (
              <span className="streaming-status" role="status">
                Streaming…
              </span>
            )}
            {item.role === "assistant" ? (
              <AssistantMarkdown content={item.content} />
            ) : (
              <>
                {item.agentMode === "plan" && (
                  <small className="message-mode">plan</small>
                )}
                <p className="message-plain-text">{item.content}</p>
              </>
            )}
          </article>
        ) : item.itemType === "operation" ? (
          <OperationCard
            key={`operation-${item.id}`}
            operation={item}
            track={
              item.trackReference === undefined
                ? undefined
                : state.snapshot?.tracks.find(
                    ({ id }) => id === item.trackReference,
                  )
            }
          />
        ) : (
          <TriggerCard key={`trigger-${item.deliveryId}`} trigger={item} />
        ),
      )}
    </div>
  );
}

function isActiveTimelineMessage(item: {
  itemType: string;
  streaming?: boolean;
  working?: WorkingView | undefined;
}): boolean {
  return (
    item.itemType === "message" &&
    (item.streaming === true || item.working?.status === "running")
  );
}

function isScrolledToEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48;
}

export function WorkingDisclosure({
  working,
}: {
  working: WorkingView;
}): React.JSX.Element {
  const running = working.status === "running";
  const [expanded, setExpanded] = useState(running);
  const previousStatus = useRef(working.status);
  useEffect(() => {
    if (running) {
      setExpanded(true);
    } else if (previousStatus.current === "running") {
      setExpanded(false);
    }
    previousStatus.current = working.status;
  }, [running, working.status]);
  const statusLabel = {
    running: "Working",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }[working.status];
  const fallback = working.responseStarted
    ? "Receiving response..."
    : "Preparing the next step...";
  return (
    <details
      className={`working-disclosure working-${working.status}`}
      open={running || expanded}
      onToggle={(event) => {
        if (!running) setExpanded(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="working-indicator" aria-hidden="true" />
        <span>{working.intent ?? "Working"}</span>
        <small role="status">{statusLabel}</small>
      </summary>
      <div className="working-details">
        {working.summary ? (
          <AssistantMarkdown content={working.summary} />
        ) : (
          <p>{fallback}</p>
        )}
        {working.detail && <p className="warning">{working.detail}</p>}
        {working.subagents !== undefined && working.subagents.length > 0 && (
          <ul className="working-subagents" aria-label="Sub-agents">
            {working.subagents.map((subagent) => (
              <AgentColoredItem
                key={subagent.id}
                agent={subagent.label}
                className={`working-subagent working-${subagent.status}`}
              >
                <strong>{subagent.label}</strong>
                {subagent.executionMode === "background" && (
                  <small> · background</small>
                )}
                <small role="status">
                  {" "}
                  ·{" "}
                  {
                    {
                      running: "Working",
                      completed: "Completed",
                      failed: "Failed",
                    }[subagent.status]
                  }
                </small>
                {subagent.intent && <p>{subagent.intent}</p>}
                {subagent.detail && (
                  <p className="warning">{subagent.detail}</p>
                )}
              </AgentColoredItem>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

export function TriggerCard({
  trigger,
}: {
  trigger: DesktopState["agentWorkspaces"][string]["triggers"][number];
}): React.JSX.Element {
  const icon = {
    queued: "◌",
    completed: "✓",
    failed: "×",
  }[trigger.status];
  return (
    <details className={`trigger trigger-${trigger.status}`}>
      <summary>
        <span aria-hidden="true">{icon}</span> Listening Event ·{" "}
        {trigger.sourceTrack}
        <small>{trigger.status}</small>
      </summary>
      <p>{trigger.summary}</p>
      {trigger.messagePrefix && (
        <p>
          <strong>Message prefix:</strong> {trigger.messagePrefix}
        </p>
      )}
      <pre>{trigger.occurrence}</pre>
      {trigger.error && <p className="warning">Warning: {trigger.error}</p>}
    </details>
  );
}

function AgentColoredItem({
  agent,
  className,
  children,
}: {
  agent: string;
  className: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className={className} style={useAgentColorStyle(agent)}>
      {children}
    </li>
  );
}

function ApprovalSubagent({ label }: { label: string }): React.JSX.Element {
  return (
    <small className="approval-subagent" style={useAgentColorStyle(label)}>
      Requested via sub-agent {label}
    </small>
  );
}

export function OperationCard({
  operation,
  track,
}: {
  operation: DesktopState["operations"][number];
  track?: Pick<DesktopTrack, "name" | "color"> | undefined;
}): React.JSX.Element {
  const agentStyle = useAgentColorStyle(operation.subagentLabel);
  const presentation = operationPresentation(
    operation.toolName,
    operation.label,
  );
  const subagentPrefix =
    operation.subagentLabel === undefined
      ? undefined
      : `${operation.subagentLabel}: `;
  const label =
    subagentPrefix !== undefined && operation.label.startsWith(subagentPrefix)
      ? operation.label.slice(subagentPrefix.length)
      : operation.label;
  const subagentClass =
    operation.subagentLabel !== undefined
      ? " operation-subagent"
      : operation.toolName === "task"
        ? " operation-subagent-launch"
        : "";
  return (
    <details
      className={`operation operation-${operation.status}${subagentClass}`}
      style={agentStyle}
    >
      <summary>
        <ActivityIcon type={presentation.type} />
        {operation.subagentLabel !== undefined && (
          <span
            className="operation-subagent-label"
            title={`Run by sub-agent ${operation.subagentLabel}`}
          >
            {operation.subagentLabel}
          </span>
        )}
        <span className="operation-label">{label}</span>
        {track !== undefined && (
          <span
            className="track-chip operation-track"
            style={{ "--track-color": track.color } as CSSProperties}
            title={`Track ${track.name}`}
          >
            {track.name}
          </span>
        )}
        {operation.toolName !== undefined && (
          <code className="operation-tool-name">
            {operation.toolName}
            {operation.action === undefined ? "" : ` · ${operation.action}`}
          </code>
        )}
        <small>
          <span className="operation-status">{operation.status}</span>
          {operation.durationMs === undefined
            ? ""
            : ` · ${formatOperationDuration(operation.durationMs)}`}
        </small>
      </summary>
      <div className="operation-details">
        {operation.detail && <p>{operation.detail}</p>}
        {operation.request && (
          <OperationDisclosureSection
            title="Requested"
            disclosure={operation.request}
          />
        )}
        {operation.outcome && (
          <OperationDisclosureSection
            title={
              operation.outcome.kind === "observed" ? "Observed" : "Result"
            }
            disclosure={operation.outcome}
          />
        )}
        {operation.changed.length > 0 && (
          <p>
            <strong>Changed:</strong> {operation.changed.join(", ")}
          </p>
        )}
        {operation.unchanged.length > 0 && (
          <p>
            <strong>Not changed:</strong> {operation.unchanged.join(", ")}
          </p>
        )}
        {operation.failure && (
          <section className="operation-disclosure operation-failure-details">
            <h4>Failure</h4>
            <p>
              <strong>
                {operationFailureSourceLabel(operation.failure.source)}
              </strong>
              {" · "}
              <code>{operation.failure.code}</code>
            </p>
            <p>{operation.failure.message}</p>
            {operation.failure.details.length > 0 && (
              <OperationDetailList details={operation.failure.details} />
            )}
            {operation.failure.recovery && (
              <>
                <h4>How to correct it</h4>
                <p>{operation.failure.recovery}</p>
              </>
            )}
          </section>
        )}
        {operation.warnings.map((warning) => (
          <p className="warning" key={warning}>
            Warning: {warning}
          </p>
        ))}
        <div className="inline-actions">
          {operation.retryable && (
            <button
              onClick={() => void window.desktop.operations.retry(operation.id)}
            >
              Retry safely
            </button>
          )}
          {operation.undoable && (
            <button
              onClick={() => void window.desktop.operations.undo(operation.id)}
            >
              Undo change
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

function formatOperationDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${Math.round(durationMs)} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function operationFailureSourceLabel(
  source: NonNullable<DesktopState["operations"][number]["failure"]>["source"],
): string {
  return {
    application_policy: "Blocked by application policy",
    runtime: "Runtime failure",
    tool: "Tool failure",
    user: "Denied by user",
  }[source];
}

function OperationDetailList({
  details,
}: {
  details: NonNullable<
    DesktopState["operations"][number]["request"]
  >["details"];
}): React.JSX.Element {
  return (
    <dl className="operation-detail-list">
      {details.map((detail, index) => (
        <div key={`${detail.label}-${index}`}>
          <dt>{detail.label}</dt>
          <dd>
            {detail.format === "code" ? (
              <pre>{detail.value}</pre>
            ) : (
              detail.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function OperationDisclosureSection({
  title,
  disclosure,
}: {
  title: string;
  disclosure: NonNullable<DesktopState["operations"][number]["request"]>;
}): React.JSX.Element {
  return (
    <section className="operation-disclosure">
      <h4>{title}</h4>
      {disclosure.summary && <p>{disclosure.summary}</p>}
      {disclosure.details.length > 0 && (
        <OperationDetailList details={disclosure.details} />
      )}
    </section>
  );
}

export type OperationPresentationType =
  "search" | "terminal" | "edit" | "agent" | "ableton" | "activity";

export function operationPresentation(
  toolName: string | undefined,
  label: string,
): { type: OperationPresentationType } {
  const value = `${toolName ?? ""} ${label}`
    .toLowerCase()
    .replace(/[._-]+/gu, " ");
  if (/\b(ableton|live|max4live|max[_-])/u.test(value))
    return { type: "ableton" };
  if (/\b(agent|delegate|review)/u.test(value)) return { type: "agent" };
  if (
    /\b(shell|terminal|bash|command|exec|test|build|typecheck|lint)\b/u.test(
      value,
    )
  )
    return { type: "terminal" };
  if (/\b(search|find|grep|inspect|read|view|list)\b/u.test(value))
    return { type: "search" };
  if (/\b(edit|write|create|delete|remove|set|add|connect|fire)\b/u.test(value))
    return { type: "edit" };
  return { type: "activity" };
}

function ActivityIcon({
  type,
}: {
  type: OperationPresentationType;
}): React.JSX.Element {
  const paths: Record<OperationPresentationType, React.ReactNode> = {
    search: (
      <>
        <circle cx="7.5" cy="7.5" r="4.5" />
        <path d="m11 11 4 4" />
      </>
    ),
    terminal: (
      <>
        <rect x="2.5" y="3.5" width="13" height="11" rx="2" />
        <path d="m5 7 2 2-2 2M9 11h3" />
      </>
    ),
    edit: (
      <>
        <path d="m3 15 1-4L12 3l3 3-8 8-4 1Z" />
        <path d="m10.5 4.5 3 3" />
      </>
    ),
    agent: (
      <>
        <circle cx="9" cy="9" r="2.5" />
        <path d="M9 2.5v2M9 13.5v2M2.5 9h2M13.5 9h2M4.4 4.4l1.4 1.4M12.2 12.2l1.4 1.4" />
      </>
    ),
    ableton: (
      <>
        <path d="M3 4v10M6 6v8M9 3v11M12 7v7M15 5v9" />
      </>
    ),
    activity: <path d="M2.5 9h3l2-4 3 8 2-4h3" />,
  };
  return (
    <svg
      className={`activity-icon activity-icon-${type}`}
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      {paths[type]}
    </svg>
  );
}

export function Inspector({
  state,
  dispatch,
  onEditPlan,
  hidden = false,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onEditPlan?: (() => void) | undefined;
  hidden?: boolean;
}): React.JSX.Element {
  const track = state.snapshot?.tracks.find(
    (candidate) => candidate.id === state.selectedTrackId,
  );
  const clip = track?.clips.find(
    (candidate) => candidate.id === state.selectedClipId,
  );
  const device = track?.devices.find(
    (candidate) => candidate.id === state.selectedDeviceId,
  );
  const workspace = selectedAgentWorkspace(state);
  const agent = selectedAgentInstance(state);
  const contextUsage = workspace.contextUsage?.find(
    ({ sdkSessionId }) => sdkSessionId === agent?.sdkSessionId,
  )?.usage;
  const hasAgent = agent !== undefined;
  const available = useMemo<InspectorModuleId[]>(() => {
    const modules: InspectorModuleId[] = [];
    if (track !== undefined) modules.push("selection");
    if (workspace.planArtifact?.exists === true) modules.push("plan");
    if (workspace.approval !== undefined) modules.push("approval");
    if (workspace.artifactReview !== undefined) modules.push("artifact");
    if (hasAgent) modules.push("context");
    return modules;
  }, [
    hasAgent,
    track,
    workspace.approval,
    workspace.artifactReview,
    workspace.planArtifact,
  ]);
  const [layout, updateLayout] = useReducer(
    inspectorLayoutReducer,
    available,
    createInspectorLayout,
  );
  const [addMenuPaneId, setAddMenuPaneId] = useState<string>();
  const [draggingModule, setDraggingModule] = useState<InspectorModuleId>();
  const dividerDrag = useRef<
    | {
        pointerId: number;
        dividerIndex: number;
        previousClientY: number;
        height: number;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    updateLayout({ type: "reconcile", available });
  }, [available]);

  const openModules = openInspectorModules(layout);
  const addableModules = available.filter(
    (moduleId) => !openModules.includes(moduleId),
  );
  const moduleContent = (
    moduleId: InspectorModuleId,
  ): React.JSX.Element | null => {
    if (moduleId === "selection" && track !== undefined) {
      return device ? (
        <DeviceInspector device={device} track={track} dispatch={dispatch} />
      ) : clip ? (
        <ClipInspector clip={clip} track={track} dispatch={dispatch} />
      ) : (
        <TrackInspector track={track} dispatch={dispatch} />
      );
    }
    if (moduleId === "plan") {
      return (
        <PlanArtifactPreview state={state} onEditPlan={onEditPlan} embedded />
      );
    }
    if (moduleId === "approval") {
      return <ApprovalPanel state={state} dispatch={dispatch} embedded />;
    }
    if (moduleId === "artifact") {
      return <ArtifactReviewPanel state={state} dispatch={dispatch} />;
    }
    if (moduleId === "context") return <ContextBudget usage={contextUsage} />;
    return null;
  };
  const handleTabDragStart = (
    event: ReactDragEvent<HTMLElement>,
    moduleId: InspectorModuleId,
  ): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/inspector-module", moduleId);
    event.currentTarget.closest(".inspector-panes")?.classList.add("dragging");
    setDraggingModule(moduleId);
  };
  const draggedModule = (
    event: ReactDragEvent<HTMLElement>,
  ): InspectorModuleId | undefined => {
    const moduleId = event.dataTransfer.getData("text/inspector-module");
    return moduleId === "selection" ||
      moduleId === "plan" ||
      moduleId === "approval" ||
      moduleId === "artifact" ||
      moduleId === "context"
      ? moduleId
      : undefined;
  };
  const startDividerResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    dividerIndex: number,
  ): void => {
    const container = event.currentTarget.parentElement?.parentElement;
    if (container === null || container === undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dividerDrag.current = {
      pointerId: event.pointerId,
      dividerIndex,
      previousClientY: event.clientY,
      height: Math.max(container.getBoundingClientRect().height, 1),
    };
  };
  const moveDivider = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = dividerDrag.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const delta = (event.clientY - active.previousClientY) / active.height;
    active.previousClientY = event.clientY;
    updateLayout({
      type: "resize",
      dividerIndex: active.dividerIndex,
      delta,
      minimumWeight: Math.min(0.45, 120 / active.height),
    });
  };
  const endDividerResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dividerDrag.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dividerDrag.current = undefined;
  };
  return (
    <aside
      id="inspector-sidebar"
      className="inspector inspector-workspace"
      aria-label="Inspector workspace"
      hidden={hidden}
    >
      {layout.panes.length === 0 ? (
        <div className="inspector-empty">
          <EmptyState
            title="Nothing to inspect"
            detail="Select a project item or wait for a plan or approval."
          />
          {addableModules.length > 0 && (
            <InspectorAddMenu
              modules={addableModules}
              open={addMenuPaneId === "empty"}
              onToggle={() =>
                setAddMenuPaneId((current) =>
                  current === "empty" ? undefined : "empty",
                )
              }
              onAdd={(moduleId) => {
                updateLayout({ type: "add", moduleId });
                setAddMenuPaneId(undefined);
              }}
            />
          )}
        </div>
      ) : (
        <div
          className={`inspector-panes ${draggingModule === undefined ? "" : "dragging"}`}
        >
          {layout.panes.map((pane, paneIndex) => (
            <div
              className="inspector-pane-group"
              key={pane.id}
              style={{ flexGrow: pane.weight }}
            >
              <section
                className="inspector-pane"
                aria-label={`${inspectorModuleLabel(pane.activeTab)} inspector`}
                onPointerDown={() =>
                  updateLayout({ type: "focus", paneId: pane.id })
                }
              >
                <div
                  className="inspector-tablist"
                  role="tablist"
                  aria-label="Inspector views"
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const moduleId = draggedModule(event);
                    if (moduleId !== undefined) {
                      updateLayout({
                        type: "move",
                        moduleId,
                        paneId: pane.id,
                      });
                    }
                  }}
                >
                  {pane.tabs.map((moduleId, tabIndex) => (
                    <div
                      className="inspector-tab-item"
                      data-module={moduleId}
                      key={moduleId}
                    >
                      <button
                        type="button"
                        className={`inspector-tab ${pane.activeTab === moduleId ? "active" : ""}`}
                        role="tab"
                        aria-selected={pane.activeTab === moduleId}
                        aria-controls={`${pane.id}-${moduleId}-panel`}
                        aria-label={inspectorModuleLabel(moduleId)}
                        title={inspectorModuleLabel(moduleId)}
                        draggable
                        onDragStart={(event) =>
                          handleTabDragStart(event, moduleId)
                        }
                        onDragEnd={(event) => {
                          event.currentTarget
                            .closest(".inspector-panes")
                            ?.classList.remove("dragging");
                          setDraggingModule(undefined);
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const dragged = draggedModule(event);
                          if (dragged !== undefined) {
                            updateLayout({
                              type: "move",
                              moduleId: dragged,
                              paneId: pane.id,
                              index: tabIndex,
                            });
                          }
                        }}
                        onClick={() =>
                          updateLayout({
                            type: "activate",
                            paneId: pane.id,
                            moduleId,
                          })
                        }
                      >
                        <InspectorModuleIcon moduleId={moduleId} />
                        {pane.activeTab === moduleId && (
                          <span className="inspector-tab-label">
                            {inspectorModuleLabel(moduleId)}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="inspector-tab-close"
                        aria-label={`Close ${inspectorModuleLabel(moduleId)} tab`}
                        title={`Close ${inspectorModuleLabel(moduleId)} tab`}
                        onClick={() =>
                          updateLayout({ type: "close", moduleId })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {addableModules.length > 0 && (
                    <InspectorAddMenu
                      modules={addableModules}
                      open={addMenuPaneId === pane.id}
                      onToggle={() =>
                        setAddMenuPaneId((current) =>
                          current === pane.id ? undefined : pane.id,
                        )
                      }
                      onAdd={(moduleId) => {
                        updateLayout({
                          type: "add",
                          moduleId,
                          paneId: pane.id,
                        });
                        setAddMenuPaneId(undefined);
                      }}
                    />
                  )}
                </div>
                <div
                  className="inspector-split-drop inspector-split-drop-before"
                  aria-hidden="true"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const moduleId = draggedModule(event);
                    if (moduleId !== undefined) {
                      updateLayout({
                        type: "split",
                        moduleId,
                        paneId: pane.id,
                        edge: "before",
                      });
                    }
                  }}
                />
                <div
                  id={`${pane.id}-${pane.activeTab}-panel`}
                  className="inspector-pane-content"
                  role="tabpanel"
                >
                  {moduleContent(pane.activeTab)}
                </div>
                <div
                  className="inspector-split-drop inspector-split-drop-after"
                  aria-hidden="true"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const moduleId = draggedModule(event);
                    if (moduleId !== undefined) {
                      updateLayout({
                        type: "split",
                        moduleId,
                        paneId: pane.id,
                        edge: "after",
                      });
                    }
                  }}
                />
              </section>
              {paneIndex < layout.panes.length - 1 && (
                <div
                  className="inspector-pane-divider"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={`Resize ${inspectorModuleLabel(pane.activeTab)} inspector`}
                  tabIndex={0}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(
                    (pane.weight /
                      layout.panes.reduce(
                        (total, { weight }) => total + weight,
                        0,
                      )) *
                      100,
                  )}
                  onKeyDown={(event) => {
                    const delta = { ArrowUp: -0.05, ArrowDown: 0.05 }[
                      event.key
                    ];
                    if (delta === undefined) return;
                    event.preventDefault();
                    updateLayout({
                      type: "resize",
                      dividerIndex: paneIndex,
                      delta,
                      minimumWeight: 0.15,
                    });
                  }}
                  onPointerDown={(event) =>
                    startDividerResize(event, paneIndex)
                  }
                  onPointerMove={moveDivider}
                  onPointerUp={endDividerResize}
                  onPointerCancel={endDividerResize}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function inspectorModuleLabel(moduleId: InspectorModuleId): string {
  if (moduleId === "selection") return "Selection";
  if (moduleId === "plan") return "Plan";
  if (moduleId === "artifact") return "Review draft";
  if (moduleId === "context") return "Context";
  return "Approval";
}

function ContextBudget({
  usage,
}: {
  usage:
    | NonNullable<AgentWorkspaceState["contextUsage"]>[number]["usage"]
    | undefined;
}): React.JSX.Element {
  const format = (count: number | undefined): string =>
    count?.toLocaleString() ?? "Not reported";
  const used = usage?.currentTokens;
  const limit = usage?.tokenLimit;
  const rows = [
    { key: "system", label: "System messages", count: usage?.systemTokens },
    {
      key: "tools",
      label: "Tool definitions",
      count: usage?.toolDefinitionsTokens,
    },
    {
      key: "conversation",
      label: "Conversation",
      count: usage?.conversationTokens,
    },
  ] as const;
  const known = rows.reduce((total, { count }) => total + (count ?? 0), 0);
  const segments =
    used !== undefined && known <= used
      ? [...rows, { key: "unclassified", count: used - known }]
      : [{ key: "unclassified", count: used }];
  return (
    <section className="context-budget" aria-label="Context budget">
      <h3>Context budget</h3>
      <p className="context-budget-total">
        {used === undefined && limit === undefined ? (
          "Waiting for token usage from Copilot."
        ) : (
          <>
            <strong>{format(used)}</strong>
            {" / "}
            {format(limit)} tokens used
          </>
        )}
      </p>
      {used !== undefined && limit !== undefined && (
        <div
          className="context-budget-meter"
          role="meter"
          aria-label="Context window usage"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
          aria-valuetext={`${format(used)} of ${format(limit)} tokens used`}
          data-over-budget={used > limit || undefined}
        >
          {segments.map(
            ({ key, count }) =>
              count !== undefined &&
              count > 0 && (
                <span
                  key={key}
                  aria-hidden="true"
                  data-token-kind={key}
                  style={{ width: `${(count / Math.max(limit, used)) * 100}%` }}
                />
              ),
          )}
        </div>
      )}
      <dl>
        {rows.map(({ key, label, count }) => (
          <div key={label}>
            <dt>
              <span
                className="context-budget-swatch"
                data-token-kind={key}
                aria-hidden="true"
              />
              {label}
            </dt>
            <dd>{format(count)}</dd>
          </div>
        ))}
      </dl>
      <dl
        className="context-budget-compactions"
        aria-label="Compactions observed since connecting to this conversation"
      >
        <div>
          <dt>Compactions</dt>
          <dd>{format(usage?.compactions)}</dd>
        </div>
        {usage?.failedCompactions ? (
          <div className="context-budget-failed">
            <dt>Failed compactions</dt>
            <dd>{format(usage.failedCompactions)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function InspectorModuleIcon({
  moduleId,
}: {
  moduleId: InspectorModuleId;
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {moduleId === "selection" ? (
        <>
          <circle cx="9" cy="9" r="5" />
          <circle cx="9" cy="9" r="1.5" />
        </>
      ) : moduleId === "plan" ? (
        <>
          <path d="M5 4h9M5 9h9M5 14h9" />
          <path d="m2.5 4 .7.7 1.3-1.4M2.5 9l.7.7 1.3-1.4M2.5 14l.7.7 1.3-1.4" />
        </>
      ) : moduleId === "artifact" ? (
        <>
          <path d="M4 2.5h6.5L14 6v9.5H4Z" />
          <path d="M10.5 2.5V6H14M6.5 9.5h5M6.5 12h3.5" />
        </>
      ) : moduleId === "context" ? (
        <path d="M3 14h12M5 11V8m4 3V4m4 7V6" />
      ) : (
        <>
          <path d="M9 2.5 14 4v4.2c0 3-2 5.7-5 7.3-3-1.6-5-4.3-5-7.3V4l5-1.5Z" />
          <path d="m6.5 8.8 1.6 1.6 3.4-3.4" />
        </>
      )}
    </svg>
  );
}

function InspectorAddMenu({
  modules,
  open,
  onToggle,
  onAdd,
}: {
  modules: readonly InspectorModuleId[];
  open: boolean;
  onToggle: () => void;
  onAdd: (moduleId: InspectorModuleId) => void;
}): React.JSX.Element {
  return (
    <div className="inspector-add">
      <button
        type="button"
        className="inspector-add-button"
        aria-label="Add inspector view"
        aria-expanded={open}
        title="Add inspector view"
        onClick={onToggle}
      >
        +
      </button>
      {open && (
        <div className="inspector-add-menu" role="menu">
          {modules.map((moduleId) => (
            <button
              type="button"
              role="menuitem"
              key={moduleId}
              onClick={() => onAdd(moduleId)}
            >
              <InspectorModuleIcon moduleId={moduleId} />
              {inspectorModuleLabel(moduleId)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PlanArtifactPreview({
  state,
  onEditPlan,
  embedded = false,
}: {
  state: DesktopState;
  onEditPlan?: (() => void) | undefined;
  embedded?: boolean;
}): React.JSX.Element {
  const agent = selectedAgentInstance(state);
  const artifact = selectedAgentWorkspace(state).planArtifact;

  return (
    <section
      className={`plan-artifact-preview ${embedded ? "embedded" : ""}`}
      aria-label="Session plan"
    >
      <div className="plan-approval-heading">
        {!embedded && <h3>Plan</h3>}
        {agent !== undefined && onEditPlan !== undefined && (
          <button type="button" onClick={onEditPlan}>
            Edit Markdown
          </button>
        )}
      </div>
      {artifact?.exists ? (
        <>
          <div className="plan-approval-content">
            <AssistantMarkdown
              content={formatPlanMarkdownForDisplay(artifact.content)}
            />
          </div>
          <small>Updated {new Date(artifact.updatedAt).toLocaleString()}</small>
        </>
      ) : (
        <p className="muted">
          No plan.md has been created for this production session.
        </p>
      )}
    </section>
  );
}

type ArtifactReviewView = "diff" | "preview" | "source";

function artifactScopeLabel(
  review: DesktopAgentArtifactReviewRequest,
  scope: DesktopAgentArtifactScope,
): string {
  return (
    review.scopes.find((candidate) => candidate.scope === scope)?.label ?? scope
  );
}

function ArtifactScopeChip({
  review,
  scope,
}: {
  review: DesktopAgentArtifactReviewRequest;
  scope: DesktopAgentArtifactScope;
}): React.JSX.Element {
  return (
    <span className={`artifact-scope-chip scope-${scope}`}>
      <span aria-hidden="true">{artifactScopeGlyph[scope]}</span>
      {artifactScopeLabel(review, scope)}
    </span>
  );
}

export function ArtifactReviewPanel({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const agent = selectedAgentInstance(state);
  const workspace = selectedAgentWorkspace(state);
  const review = workspace.artifactReview;
  const targets = workspace.artifactReviewTargets;
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [view, setView] = useState<ArtifactReviewView>("diff");
  if (review === undefined || agent === undefined) {
    return <p className="muted">No draft is waiting for review.</p>;
  }
  const selected =
    review.files.find(({ id }) => id === selectedFileId) ?? review.files[0];
  const budget = artifactTopicBudget(review, targets);
  const movable = review.files.filter(({ movable }) => movable);
  const scopes = artifactScopeOrder.flatMap((scope) => {
    const entry = review.scopes.find((candidate) => candidate.scope === scope);
    return entry === undefined ? [] : [entry];
  });
  const moveFile = (fileId: string, scope: DesktopAgentArtifactScope): void =>
    dispatch({
      type: "artifact-review-target",
      agentInstanceId: agent.id,
      requestId: review.requestId,
      fileId,
      scope,
    });
  const allTarget =
    movable.length > 0 &&
    movable.every(
      (file) =>
        artifactFileTarget(file, targets) ===
        artifactFileTarget(movable[0]!, targets),
    )
      ? artifactFileTarget(movable[0]!, targets)
      : undefined;
  const selectedScope =
    selected === undefined ? undefined : artifactFileTarget(selected, targets);

  return (
    <section className="artifact-review" aria-label="Draft review">
      <header className="artifact-review-heading">
        <span className={`agent-mode-badge artifact-${review.kind}`}>
          {review.kind === "memory" ? "memory" : "skill"}
        </span>
        <p>{review.summary}</p>
        {review.revision > 1 && <small>Revision {review.revision}</small>}
      </header>

      <div
        className="artifact-scope-ladder"
        role="radiogroup"
        aria-label={
          movable.length > 1 ? "Move every movable file to" : "Publish to"
        }
      >
        {scopes.map((entry) => {
          const count = budget.get(entry.scope);
          const checked = allTarget === entry.scope;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              key={entry.scope}
              className={`artifact-scope-rung scope-${entry.scope} ${checked ? "selected" : ""}`}
              disabled={!entry.available || movable.length === 0}
              title={
                entry.available
                  ? entry.meaning
                  : `${entry.label} is locked: ${entry.unavailableReason ?? "unavailable"}`
              }
              onClick={() => {
                for (const file of movable) moveFile(file.id, entry.scope);
              }}
            >
              <span className="artifact-scope-glyph" aria-hidden="true">
                {entry.available ? artifactScopeGlyph[entry.scope] : "🔒"}
              </span>
              <span className="artifact-scope-text">
                <strong>{entry.label}</strong>
                <small>
                  {entry.available
                    ? entry.meaning
                    : (entry.unavailableReason ?? "Unavailable")}
                </small>
              </span>
              {review.kind === "memory" && count !== undefined && (
                <meter
                  className="artifact-topic-meter"
                  min={0}
                  max={review.maxTopicsPerScope}
                  high={review.maxTopicsPerScope - 2}
                  value={Math.min(count, review.maxTopicsPerScope)}
                  aria-label={`${entry.label} topics`}
                  title={`${count} of ${review.maxTopicsPerScope} topics after publish`}
                />
              )}
            </button>
          );
        })}
      </div>

      <ul className="artifact-file-list" aria-label="Draft files">
        {review.files.map((file) => {
          const scope = artifactFileTarget(file, targets);
          const change = artifactFileChange(file, scope);
          const diff = artifactFileDiff(file, scope);
          return (
            <li
              key={file.id}
              className={file.id === selected?.id ? "selected" : ""}
            >
              <button
                type="button"
                className="artifact-file-open"
                aria-pressed={file.id === selected?.id}
                onClick={() => setSelectedFileId(file.id)}
              >
                <span className={`artifact-change-badge ${change}`}>
                  {change}
                </span>
                <span className="artifact-file-name">
                  {file.kind === "skill"
                    ? `${file.name}/SKILL.md`
                    : `${file.name}.md`}
                </span>
                <span className="artifact-file-counts">
                  <span className="add">+{diff.added}</span>{" "}
                  <span className="del">−{diff.removed}</span>
                </span>
              </button>
              {file.movable ? (
                <select
                  aria-label={`Scope for ${file.name}`}
                  className={`scope-${scope}`}
                  value={scope}
                  onChange={(event) =>
                    moveFile(
                      file.id,
                      event.target.value as DesktopAgentArtifactScope,
                    )
                  }
                >
                  {scopes.map((entry) => (
                    <option
                      key={entry.scope}
                      value={entry.scope}
                      disabled={!entry.available}
                    >
                      {artifactScopeGlyph[entry.scope]} {entry.label}
                    </option>
                  ))}
                </select>
              ) : (
                <ArtifactScopeChip review={review} scope={scope} />
              )}
            </li>
          );
        })}
      </ul>

      {selected !== undefined && selectedScope !== undefined && (
        <div className="artifact-file-view">
          <div className="artifact-file-view-heading">
            <ArtifactScopeChip review={review} scope={selectedScope} />
            <div
              className="artifact-view-toggle"
              role="tablist"
              aria-label="Draft view"
            >
              {(["diff", "preview", "source"] as const).map((option) => (
                <button
                  type="button"
                  role="tab"
                  key={option}
                  aria-selected={view === option}
                  onClick={() => setView(option)}
                >
                  {option === "diff"
                    ? "Diff"
                    : option === "preview"
                      ? "Preview"
                      : "Source"}
                </button>
              ))}
            </div>
          </div>
          {selected.kind === "skill" &&
            selected.existingOrigin !== undefined && (
              <p className="artifact-review-note">
                {artifactSkillShadowNote(review, selected, selectedScope)}
              </p>
            )}
          {view === "diff" ? (
            <ArtifactDiffView
              diff={artifactFileDiff(selected, selectedScope)}
            />
          ) : selected.after === null ? (
            <p className="muted">This topic is deleted.</p>
          ) : view === "preview" ? (
            <div className="artifact-preview">
              <AssistantMarkdown content={selected.after} />
            </div>
          ) : (
            <pre className="artifact-source">{selected.after}</pre>
          )}
        </div>
      )}
    </section>
  );
}

function artifactSkillShadowNote(
  review: DesktopAgentArtifactReviewRequest,
  file: DesktopAgentArtifactReviewRequest["files"][number],
  scope: DesktopAgentArtifactScope,
): string {
  const shadow = artifactSkillShadow(file, scope);
  if (shadow !== undefined) return shadow;
  if (file.existingOrigin === "bundled") {
    return `Overrides the bundled '${file.name}' skill.`;
  }
  return file.existingOrigin === scope
    ? `Updates the existing ${artifactScopeLabel(review, scope)} skill.`
    : `Overrides the ${artifactScopeLabel(review, file.existingOrigin!)} skill of the same name.`;
}

function ArtifactDiffView({
  diff,
}: {
  diff: ReturnType<typeof artifactFileDiff>;
}): React.JSX.Element {
  if (diff.lines.length === 0) return <p className="muted">Empty file.</p>;
  return (
    <div className="artifact-diff" role="table" aria-label="Draft diff">
      {diff.coarse && (
        <p className="muted">Large change: showing a whole-file replace.</p>
      )}
      {diff.lines.map((line, index) => (
        <div
          role="row"
          key={index}
          className={`artifact-diff-line ${line.kind}`}
        >
          <span aria-hidden="true">
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
          </span>
          <code>{line.text || " "}</code>
        </div>
      ))}
    </div>
  );
}

function TrackInspector({
  track,
  dispatch,
}: {
  track: DesktopTrack;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const chip = {
    id: `track:${track.id}`,
    kind: "track" as const,
    label: track.name,
  };
  return (
    <div
      className="inspection track-card"
      style={{ "--track-color": track.color } as CSSProperties}
    >
      <h3>{track.name}</h3>
      <p>
        {track.kind} track · {track.clips.length} clips · {track.devices.length}{" "}
        devices
      </p>
      <Meter label="Volume" value={track.volume} />
      <Meter label="Pan" value={(track.pan + 1) / 2} />
      <button onClick={() => dispatch({ type: "toggle-context", chip })}>
        Toggle prompt context
      </button>
    </div>
  );
}

function ClipInspector({
  clip,
  track,
  dispatch,
}: {
  clip: DesktopTrack["clips"][number];
  track: DesktopTrack;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  return (
    <div
      className="inspection track-card"
      style={{ "--track-color": track.color } as CSSProperties}
    >
      <h3>{clip.name}</h3>
      <dl>
        <dt>Track</dt>
        <dd>{track.name}</dd>
        <dt>Position</dt>
        <dd>
          Scene {clip.sceneIndex + 1} · {clip.lengthBeats} beats
        </dd>
        <dt>State</dt>
        <dd>{clip.status}</dd>
      </dl>
      <button
        onClick={() =>
          dispatch({
            type: "toggle-context",
            chip: { id: `clip:${clip.id}`, kind: "clip", label: clip.name },
          })
        }
      >
        Toggle prompt context
      </button>
    </div>
  );
}

function DeviceInspector({
  device,
  track,
  dispatch,
}: {
  device: DesktopTrack["devices"][number];
  track: DesktopTrack;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  return (
    <div
      className="inspection track-card"
      style={{ "--track-color": track.color } as CSSProperties}
    >
      <h3>{device.name}</h3>
      <p>
        {device.type} on {track.name} ·{" "}
        {device.enabled ? "Enabled" : "Bypassed"}
      </p>
      {device.parameters.map((parameter) => (
        <Meter
          key={parameter.id}
          label={`${parameter.name} · ${parameter.displayValue}`}
          value={parameter.value}
        />
      ))}
      <button
        onClick={() =>
          dispatch({
            type: "toggle-context",
            chip: {
              id: `device:${device.id}`,
              kind: "device",
              label: device.name,
            },
          })
        }
      >
        Toggle prompt context
      </button>
    </div>
  );
}

function Meter({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <label className="meter">
      {label}
      <progress max="1" value={value}>
        {Math.round(value * 100)}%
      </progress>
    </label>
  );
}

export function ApprovalPanel({
  state,
  dispatch,
  embedded = false,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  embedded?: boolean;
}): React.JSX.Element {
  const approval = selectedAgentWorkspace(state).approval;
  const approvalAgentInstanceId = selectedAgentInstance(state)?.id;
  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    if (!approval) return;
    await window.desktop.approvals.resolve(approval.id, decision);
    dispatch({
      type: "dismiss-approval",
      ...(approvalAgentInstanceId === undefined
        ? {}
        : { agentInstanceId: approvalAgentInstanceId }),
    });
  };
  return (
    <section
      className={`approval-panel ${embedded ? "embedded" : ""}`}
      aria-label="Approval and change preview"
    >
      {!embedded && <h3>Approval</h3>}
      {!approval ? (
        <p className="muted">No change is waiting for approval.</p>
      ) : (
        <>
          <strong>{approval.title}</strong>
          <span className={`risk risk-${approval.risk}`}>
            {approval.risk} risk
          </span>
          {approval.subagentLabel !== undefined && (
            <ApprovalSubagent label={approval.subagentLabel} />
          )}
          <p>{approval.summary}</p>
          <ul>
            {approval.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          {approval.destructive && (
            <p className="warning">This contains destructive changes.</p>
          )}
          <div className="approval-actions">
            <button
              className="primary"
              data-workspace-interaction-focus
              onClick={() => void decide("approve")}
            >
              Approve
            </button>
            <button onClick={() => void decide("deny")}>Deny</button>
          </div>
        </>
      )}
    </section>
  );
}

export function Arrangement({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const updateName = (section: PlanSection, name: string): void =>
    dispatch({ type: "update-plan", section: { ...section, name } });
  return (
    <section className="arrangement" aria-label="Structured production plan">
      <div className="panel-heading">
        <h2>Production plan</h2>
        <button onClick={() => void window.desktop.plan.update(state.plan)}>
          Save plan
        </button>
      </div>
      <div className="ruler">
        {Array.from({ length: 8 }, (_, index) => (
          <span key={index}>{index * 4 + 1}</span>
        ))}
      </div>
      <div className="section-track">
        {state.plan.map((section) => (
          <button
            key={section.id}
            className={`plan-section section-${section.status}`}
            style={{
              gridColumn: `${section.startBar} / ${section.endBar + 1}`,
            }}
            onClick={() =>
              dispatch({
                type: "toggle-context",
                chip: {
                  id: `section:${section.id}`,
                  kind: "section",
                  label: section.name,
                },
              })
            }
          >
            {section.name}
            <small>
              {section.startBar}–{section.endBar}
            </small>
          </button>
        ))}
      </div>
      <div className="plan-editor">
        {state.plan.map((section) => (
          <label key={section.id}>
            {section.startBar}–{section.endBar}
            <input
              aria-label={`Name for section at bar ${section.startBar}`}
              value={section.name}
              onChange={(event) => updateName(section, event.target.value)}
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function BrowserView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const filtered = browserItems
    .filter((item) =>
      item.join(" ").toLowerCase().includes(state.browserQuery.toLowerCase()),
    )
    .slice(0, 100);
  return (
    <section className="page-panel">
      <div className="panel-heading">
        <h1>Browser & plug-ins</h1>
        <span>{filtered.length} visible results</span>
      </div>
      <label className="search">
        Search instruments, effects, samples, and plug-ins
        <input
          value={state.browserQuery}
          onChange={(event) =>
            dispatch({ type: "browser-query", value: event.target.value })
          }
        />
      </label>
      <div className="browser-layout">
        <aside>
          <button className="active">All results</button>
          {[
            "Instruments",
            "Audio effects",
            "MIDI effects",
            "Plug-ins",
            "Packs",
            "Samples",
          ].map((item) => (
            <button key={item}>{item}</button>
          ))}
        </aside>
        <div className="browser-list" role="list">
          {filtered.length === 0 ? (
            <EmptyState
              title="No browser results"
              detail="Try a broader search."
            />
          ) : (
            filtered.map(([name, type, source]) => (
              <button
                role="listitem"
                key={name}
                onClick={() =>
                  dispatch({
                    type: "toggle-context",
                    chip: { id: `device:${name}`, kind: "device", label: name },
                  })
                }
              >
                <strong>{name}</strong>
                <span>{type}</span>
                <small>{source}</small>
              </button>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function DiagnosticsView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const [actionStatus, setActionStatus] = useState("");
  const refresh = async (): Promise<void> => {
    const report = await window.desktop.diagnostics.get();
    dispatch({ type: "diagnostics-loaded", report });
  };
  const perform = async (action: () => Promise<string>): Promise<void> => {
    try {
      setActionStatus(await action());
    } catch (error) {
      setActionStatus(
        `Diagnostics action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  useEffect(() => {
    void refresh().catch((error: unknown) =>
      setActionStatus(
        `Diagnostics could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }, [dispatch]);
  const report = state.diagnosticsReport;
  return (
    <section className="page-panel">
      <div className="panel-heading">
        <h1>Diagnostics</h1>
        <div className="inline-actions">
          <button
            onClick={() =>
              void perform(async () => {
                await refresh();
                return "Diagnostics checks updated.";
              })
            }
          >
            Run checks
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                await window.desktop.diagnostics.revealLog();
                return "Revealed the active log.";
              })
            }
          >
            Reveal log
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                const result =
                  await window.desktop.diagnostics.exportSupportBundle();
                return result.status === "saved"
                  ? `Support bundle saved to ${result.filePath}`
                  : "Support bundle export cancelled.";
              })
            }
          >
            Export support bundle
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                await window.desktop.diagnostics.copySummary();
                return "Diagnostics summary copied.";
              })
            }
          >
            Copy summary
          </button>
        </div>
      </div>
      {report && (
        <>
          <div className="diagnostics-log">
            <strong>Local storage profile: {report.storage.profile}</strong>
            <span>
              Storage version {report.storage.version}; migration{" "}
              {report.storage.migrationStatus}
            </span>
            <code title={report.storage.profileRoot}>
              {report.storage.profileRoot}
            </code>
          </div>
          <div className="diagnostics-log">
            <strong>Active logging level: {report.logging.level}</strong>
            {report.logging.environmentOverride && (
              <span>Controlled by ABLETON_AGENT_LOG_LEVEL</span>
            )}
            <span>{report.logging.fileName}</span>
            <code title={report.logging.filePath}>
              {report.logging.filePath}
            </code>
          </div>
        </>
      )}
      <p className="diagnostics-action-status" aria-live="polite">
        {actionStatus}
      </p>
      <div className="diagnostics">
        {(report?.checks ?? []).map((check) => (
          <article key={check.label}>
            <span className={`check check-${check.status}`}>
              {check.status === "pass"
                ? "✓ Pass"
                : check.status === "warn"
                  ? "! Warning"
                  : "× Failed"}
            </span>
            <h2>{check.label}</h2>
            <p>{check.detail}</p>
          </article>
        ))}
      </div>
      {state.diagnostics.map((item, index) => (
        <p key={`${item.message}-${index}`} className={item.level}>
          {item.level}: {item.message}
        </p>
      ))}
    </section>
  );
}

function SessionsView({ state }: { state: DesktopState }): React.JSX.Element {
  const currentSession = activeSession(state);
  return (
    <section className="page-panel">
      <div className="panel-heading">
        <h1>Sessions</h1>
        <button onClick={() => void window.desktop.agent.createSession()}>
          New session
        </button>
      </div>
      {state.sessions.length === 0 ? (
        <EmptyState
          title="No saved sessions"
          detail="Start a new session to preserve production context."
        />
      ) : (
        <div className="session-list">
          {state.sessions.slice(0, 100).map((session) => (
            <article key={session.id}>
              <div>
                <h2>{session.title}</h2>
                <p>
                  {session.liveSetName} ·{" "}
                  {new Date(session.updatedAt).toLocaleString()}
                </p>
                {session.id === currentSession?.id && <strong>Current</strong>}
              </div>
              <button
                disabled={session.id === currentSession?.id}
                onClick={() =>
                  void window.desktop.agent.resumeSession(session.id)
                }
              >
                Resume
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function SettingsView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(state.preferences);
  const [historyAction, setHistoryAction] = useState("");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "failed"
  >("idle");
  const [saveError, setSaveError] = useState("");
  const editRevision = useRef(0);
  const autoApprovalOverrideCount =
    activeSession(state)?.activeAgents.filter(({ autoApprove }) => autoApprove)
      .length ?? 0;
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const submittedRevision = editRevision.current;
    setSaveState("saving");
    setSaveError("");
    try {
      const preferences = await window.desktop.preferences.set(draft);
      dispatch({
        type: "event",
        event: { type: "preferences.changed", preferences },
      });
      setSaveState(
        editRevision.current === submittedRevision ? "saved" : "idle",
      );
    } catch {
      setSaveState("failed");
      setSaveError(
        "Settings could not be fully saved. Check active preferences before retrying.",
      );
    }
  };
  return (
    <section className="page-panel">
      <div className="panel-heading">
        <h1>Settings</h1>
        <span>Non-secret preferences</span>
      </div>
      <form
        className="settings-form"
        onSubmit={(event) => void save(event)}
        onChangeCapture={() => {
          editRevision.current += 1;
          if (saveState === "saved") setSaveState("idle");
        }}
      >
        <fieldset className="window-settings">
          <legend>Window</legend>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.alwaysOnTop}
              onChange={(event) =>
                setDraft({ ...draft, alwaysOnTop: event.target.checked })
              }
            />{" "}
            Always on top
          </label>
          <small>
            Keep Ableton Agent visible above other apps, including across macOS
            Spaces and over full-screen windows.
          </small>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.showAdvancedViews}
              onChange={(event) =>
                setDraft({ ...draft, showAdvancedViews: event.target.checked })
              }
            />{" "}
            Show advanced views
          </label>
          <small>
            Show the Events, Browser, and Diagnostics tabs in the toolbar.
          </small>
        </fieldset>
        <fieldset className="listening-settings">
          <legend>Listening timing</legend>
          <label>
            Listening timing mode
            <select
              value={draft.listening.mode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  listening:
                    event.target.value === "strict"
                      ? { mode: "strict", maxClockDisagreementSamples: 0 }
                      : { ...DEFAULT_LISTENING_TIMING_POLICY },
                })
              }
            >
              <option value="descriptive">Descriptive (default)</option>
              <option value="strict">
                Strict (zero observed disagreement)
              </option>
            </select>
          </label>
          <label>
            Timing target (samples)
            <input
              type="number"
              min="0"
              max="480"
              step="1"
              required
              disabled={draft.listening.mode === "strict"}
              value={
                Number.isNaN(draft.listening.maxClockDisagreementSamples)
                  ? ""
                  : draft.listening.maxClockDisagreementSamples
              }
              onChange={(event) => {
                if (draft.listening.mode !== "descriptive") return;
                setDraft({
                  ...draft,
                  listening: {
                    mode: "descriptive",
                    maxClockDisagreementSamples: event.target.valueAsNumber,
                  },
                });
              }}
            />
          </label>
          <small>
            Advanced: 0–480 whole samples; descriptive default 64. The
            descriptive target is advisory, not a capture limit. Actual
            clock/beat disagreement is retained without claiming physical timing
            accuracy or a verified absolute error bound. Strict requires zero
            observed disagreement with no fallback. All new observations remain
            approximate and descriptive-only, including at zero disagreement.
            Milliseconds are shown with measurements at the actual observation
            sample rate. Saved changes apply only to new passes; an active pass
            keeps its starting policy.
          </small>
        </fieldset>
        <label>
          Approval policy
          <select
            value={draft.approvalPolicy}
            onChange={(event) =>
              setDraft({
                ...draft,
                approvalPolicy: event.target
                  .value as typeof draft.approvalPolicy,
              })
            }
          >
            <option value="always">Always ask</option>
            <option value="risky">Risky changes</option>
            <option value="approve-all">Approve all (no prompts)</option>
            <option value="never">Deny all changes</option>
          </select>
        </label>
        <div className="approval-policy-explanation">
          <strong>
            Current session: {autoApprovalOverrideCount} YOLO override
            {autoApprovalOverrideCount === 1 ? "" : "s"}
          </strong>
          <span>
            Per-agent YOLO applies only with Always ask or Risky changes. Deny
            all overrides YOLO and always denies; Approve all globally approves
            every request. Tool allowlists, edit scopes, and safety checks
            remain enforced.
          </span>
        </div>
        <fieldset className="agent-settings">
          <legend>Agent runtime</legend>
          <label>
            Active-work timeout (minutes)
            <input
              type="number"
              min="1"
              max="120"
              step="1"
              value={draft.agentTurnTimeoutMinutes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  agentTurnTimeoutMinutes: Number(event.target.value),
                })
              }
            />
          </label>
          <small>
            Limits cumulative model and tool work for one request. Time waiting
            for questions, approvals, or plan review does not count.
          </small>
          <label>
            Agent reasoning visibility
            <select
              value={draft.agentReasoningVisibility}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  agentReasoningVisibility: event.target
                    .value as typeof draft.agentReasoningVisibility,
                })
              }
            >
              <option value="none">Off</option>
              <option value="concise">Concise</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
          <small>
            Shows model-provided reasoning summaries when supported. Changes
            apply before each agent&apos;s next turn without clearing its
            conversation.
          </small>
        </fieldset>
        {draft.approvalPolicy === "approve-all" && (
          <div className="approval-policy-warning" role="alert">
            <strong>
              Warning: all changes will be approved automatically.
            </strong>
            <span>
              You will not be prompted before Ableton changes are applied.
            </span>
          </div>
        )}
        <label>
          Ableton port
          <input
            type="number"
            min="1"
            max="65535"
            value={draft.abletonPort}
            onChange={(event) =>
              setDraft({ ...draft, abletonPort: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Signal ingress port
          <input
            type="number"
            min="1"
            max="65535"
            value={draft.signalPort}
            onChange={(event) =>
              setDraft({ ...draft, signalPort: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Remote Script location
          <input
            value={draft.remoteScriptLocation}
            onChange={(event) =>
              setDraft({ ...draft, remoteScriptLocation: event.target.value })
            }
          />
        </label>
        <label>
          Logging
          <select
            value={draft.loggingLevel}
            onChange={(event) =>
              setDraft({
                ...draft,
                loggingLevel: event.target.value as typeof draft.loggingLevel,
              })
            }
          >
            <option>error</option>
            <option>warn</option>
            <option>info</option>
            <option>debug</option>
          </select>
        </label>
        <fieldset className="history-settings">
          <legend>Local detailed history</legend>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.eventHistoryEnabled}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  eventHistoryEnabled: event.target.checked,
                })
              }
            />{" "}
            Store detailed event history on this device
          </label>
          <label>
            Retention (days)
            <input
              type="number"
              min="1"
              step="1"
              value={draft.eventHistoryRetentionDays}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  eventHistoryRetentionDays: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            Maximum database size (MiB)
            <input
              type="number"
              min="1"
              step="1"
              value={Math.round(draft.eventHistoryMaxBytes / (1024 * 1024))}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  eventHistoryMaxBytes:
                    Number(event.target.value) * 1024 * 1024,
                })
              }
            />
          </label>
          <div className="history-data-actions">
            <button
              type="button"
              onClick={() => {
                setHistoryAction("Pruning…");
                void window.desktop.eventHistory
                  .prune()
                  .then((result) =>
                    setHistoryAction(
                      `Removed ${result.deletedEvents} events and ${result.deletedConfigurationSnapshots} snapshots.`,
                    ),
                  )
                  .catch((error: unknown) =>
                    setHistoryAction(
                      error instanceof Error ? error.message : "Prune failed",
                    ),
                  );
              }}
            >
              Prune now
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!window.confirm("Clear all local detailed history?"))
                  return;
                setHistoryAction("Clearing…");
                void window.desktop.eventHistory
                  .clear()
                  .then((result) =>
                    setHistoryAction(
                      `Cleared ${result.deletedEvents} events and ${result.deletedConfigurationSnapshots} snapshots.`,
                    ),
                  )
                  .catch((error: unknown) =>
                    setHistoryAction(
                      error instanceof Error ? error.message : "Clear failed",
                    ),
                  );
              }}
            >
              Clear all history
            </button>
          </div>
          {historyAction && <small role="status">{historyAction}</small>}
        </fieldset>
        <button
          className="primary"
          type="submit"
          disabled={saveState === "saving"}
        >
          Save settings
        </button>
        {saveState === "saving" && <p role="status">Saving settings…</p>}
        {saveState === "saved" && <p role="status">Settings saved.</p>}
        {saveState === "failed" && <p role="alert">{saveError}</p>}
      </form>
      <p className="muted">
        Credentials are never exposed to this renderer and are stored separately
        through OS-backed encryption.
      </p>
    </section>
  );
}

export function DesktopComposer({
  state,
  composerRef,
  dispatch,
  value,
  error,
  onValueChange,
  onErrorChange,
  planEditorOpen,
  onPlanEditorClose,
}: {
  state: DesktopState;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  value: string;
  error: string;
  onValueChange: (value: string) => void;
  onErrorChange: (error: string) => void;
  planEditorOpen?: boolean;
  onPlanEditorClose?: (() => void) | undefined;
}): React.JSX.Element {
  const selectedInstanceId = selectedAgentInstance(state)?.id;
  const workspace = selectedAgentWorkspace(state);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    onErrorChange("");
  }, [onErrorChange, selectedInstanceId]);

  if (workspace.elicitation !== undefined) {
    return (
      <ElicitationComposer
        key={workspace.elicitation.requestId}
        state={state}
        request={workspace.elicitation}
      />
    );
  }
  if (workspace.artifactReview !== undefined) {
    return (
      <ArtifactReviewComposer
        key={`${workspace.artifactReview.requestId}:${workspace.artifactReview.revision}`}
        state={state}
        request={workspace.artifactReview}
      />
    );
  }
  if (workspace.planApproval !== undefined) {
    return (
      <PlanApprovalComposer
        key={workspace.planApproval.requestId}
        state={state}
        request={workspace.planApproval}
      />
    );
  }
  if (planEditorOpen && onPlanEditorClose !== undefined) {
    return (
      <PlanEditorComposer
        key={selectedInstanceId ?? "none"}
        state={state}
        onClose={onPlanEditorClose}
      />
    );
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const message = value.trim();
    if (!message) return;
    onErrorChange("");
    setSubmitting(true);
    try {
      await sendComposerMessage(window.desktop, state, message, dispatch);
      onValueChange("");
    } catch (submitError) {
      const messageText =
        submitError instanceof Error
          ? submitError.message
          : "Agent message failed";
      onErrorChange(messageText);
      dispatch({
        type: "event",
        event: {
          type: "diagnostic",
          level: "error",
          message: messageText,
        },
      });
    } finally {
      setSubmitting(false);
      composerRef.current?.focus();
    }
  };

  return (
    <Composer
      state={state}
      value={value}
      busy={submitting}
      submitting={submitting}
      composerRef={composerRef}
      error={error}
      onChange={(nextValue) => {
        onValueChange(nextValue);
        onErrorChange("");
      }}
      onSubmit={submit}
      dispatch={dispatch}
    />
  );
}

function ArtifactReviewComposer({
  state,
  request,
}: {
  state: DesktopState;
  request: DesktopAgentArtifactReviewRequest;
}): React.JSX.Element {
  const agent = selectedAgentInstance(state);
  const targets = selectedAgentWorkspace(state).artifactReviewTargets;
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  const blocker = artifactReviewBlocker(request, targets);
  const scopes = [
    ...new Set(request.files.map((file) => artifactFileTarget(file, targets))),
  ];
  const tint = scopes.length === 1 ? `scope-${scopes[0]}` : "scope-mixed";

  const resolve = async (
    decision: "approve" | "request_changes" | "discard",
  ): Promise<void> => {
    if (agent === undefined || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const result = await window.desktop.agents.resolveArtifactReview(
        agent.id,
        {
          requestId: request.requestId,
          revision: request.revision,
          decision,
          ...(decision === "request_changes"
            ? { feedback: feedback.trim() }
            : {}),
          ...(decision === "approve"
            ? { targets: artifactReviewTargets(request, targets) }
            : {}),
        },
      );
      if (result.error !== undefined) setError(result.error);
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "The review response could not be submitted.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <footer className="composer interaction-deck">
      <section aria-label="Draft review decision">
        <div className="interaction-deck-heading">
          <div>
            <span className={`agent-mode-badge artifact-${request.kind}`}>
              {request.kind}
            </span>
            <h3>
              {request.kind === "memory"
                ? `Review ${request.files.length} memory ${request.files.length === 1 ? "change" : "changes"}`
                : `Review skill '${request.files[0]?.name ?? ""}'`}
            </h3>
          </div>
          <small>
            Publishing to{" "}
            {scopes.map((scope, index) => (
              <Fragment key={scope}>
                {index > 0 && ", "}
                <ArtifactScopeChip review={request} scope={scope} />
              </Fragment>
            ))}
            . Change scopes in the Inspector.
          </small>
        </div>
        <label>
          Request changes
          <textarea
            autoFocus
            data-workspace-interaction-focus
            rows={3}
            maxLength={8_192}
            value={feedback}
            disabled={submitting}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Describe what the agent should change in this draft…"
          />
        </label>
        {blocker !== undefined && <p className="composer-error">{blocker}</p>}
        {error && <p className="composer-error">{error}</p>}
        <div className="interaction-actions">
          <button
            className={`primary artifact-publish ${tint}`}
            disabled={submitting || blocker !== undefined}
            onClick={() => void resolve("approve")}
          >
            Approve &amp; publish
          </button>
          <button
            disabled={submitting || feedback.trim().length === 0}
            onClick={() => void resolve("request_changes")}
          >
            Request changes
          </button>
          <button disabled={submitting} onClick={() => void resolve("discard")}>
            Discard
          </button>
        </div>
      </section>
    </footer>
  );
}

function PlanApprovalComposer({
  state,
  request,
}: {
  state: DesktopState;
  request: NonNullable<AgentWorkspaceState["planApproval"]>;
}): React.JSX.Element {
  const agent = selectedAgentInstance(state);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submittingRef = useRef(false);

  const resolve = async (response: {
    approved: boolean;
    selectedAction?: "exit_only" | "interactive";
    feedback?: string;
  }): Promise<void> => {
    if (agent === undefined || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      const resolved = await window.desktop.agents.resolvePlan(agent.id, {
        requestId: request.requestId,
        planRevision: request.planRevision,
        ...response,
      });
      if (!resolved) throw new Error("This plan request is no longer pending.");
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "The plan response could not be submitted.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <footer className="composer interaction-deck">
      <section aria-label="Plan approval">
        <div className="interaction-deck-heading">
          <div>
            <span className="agent-mode-badge plan">plan</span>
            <h3>Review plan.md</h3>
          </div>
          <small>The full plan is visible in the Inspector.</small>
        </div>
        <label>
          Request changes
          <textarea
            autoFocus
            data-workspace-interaction-focus
            rows={3}
            maxLength={8_192}
            value={feedback}
            disabled={submitting}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Describe what should change in plan.md…"
          />
        </label>
        {error && <p className="composer-error">{error}</p>}
        <div className="interaction-actions">
          {request.actions.includes("interactive") && (
            <button
              className="primary"
              disabled={submitting}
              onClick={() =>
                void resolve({
                  approved: true,
                  selectedAction: "interactive",
                })
              }
            >
              Approve and continue
            </button>
          )}
          <button
            disabled={submitting || feedback.trim().length === 0}
            onClick={() =>
              void resolve({
                approved: false,
                feedback: feedback.trim(),
              })
            }
          >
            Request changes
          </button>
          {request.actions.includes("exit_only") && (
            <button
              disabled={submitting}
              onClick={() =>
                void resolve({
                  approved: true,
                  selectedAction: "exit_only",
                })
              }
            >
              Exit plan mode
            </button>
          )}
        </div>
      </section>
    </footer>
  );
}

function PlanEditorComposer({
  state,
  onClose,
}: {
  state: DesktopState;
  onClose: () => void;
}): React.JSX.Element {
  const agent = selectedAgentInstance(state);
  const artifact = selectedAgentWorkspace(state).planArtifact;
  const [content, setContent] = useState(
    artifact?.exists ? artifact.content : "# Plan\n",
  );
  const [expectedRevision] = useState(
    artifact?.exists ? artifact.revision : undefined,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (agent === undefined || content.trim().length === 0 || submitting)
      return;
    setSubmitting(true);
    setError("");
    try {
      await window.desktop.agents.writePlan(agent.id, {
        content,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The plan could not be saved.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <footer className="composer interaction-deck plan-editor-deck">
      <form onSubmit={(event) => void save(event)}>
        <div className="interaction-deck-heading">
          <div>
            <span className="agent-mode-badge plan">plan.md</span>
            <h3>Edit session plan</h3>
          </div>
          <small>Markdown · saved to this production session</small>
        </div>
        <label className="sr-only" htmlFor="plan-markdown-editor">
          Plan Markdown
        </label>
        <textarea
          id="plan-markdown-editor"
          autoFocus
          value={content}
          disabled={submitting}
          onChange={(event) => setContent(event.target.value)}
          rows={14}
          spellCheck
        />
        {error && <p className="composer-error">{error}</p>}
        <div className="interaction-actions">
          <button
            className="primary"
            type="submit"
            disabled={submitting || content.trim().length === 0}
          >
            Save plan.md
          </button>
          <button type="button" disabled={submitting} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </footer>
  );
}

function ElicitationComposer({
  state,
  request,
}: {
  state: DesktopState;
  request: NonNullable<AgentWorkspaceState["elicitation"]>;
}): React.JSX.Element {
  const agent = selectedAgentInstance(state);
  const initialValues = (): Record<
    string,
    string | number | boolean | string[]
  > =>
    Object.fromEntries(
      Object.entries(request.properties).flatMap(([name, field]) => {
        if (field.default !== undefined) return [[name, field.default]];
        if (field.type === "boolean" && request.required.includes(name)) {
          return [[name, false]];
        }
        return [];
      }),
    );
  const [values, setValues] = useState(initialValues);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [manualHeight, setManualHeight] = useState<number>();
  const resizeDrag = useRef<
    | {
        pointerId: number;
        startClientY: number;
        startHeight: number;
      }
    | undefined
  >(undefined);
  const deckRef = useRef<HTMLElement>(null);
  const requiredComplete = request.required.every((name) => {
    const value = values[name];
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    return Array.isArray(value) && value.length > 0;
  });
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (deckRef.current === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeDrag.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startHeight: deckRef.current.getBoundingClientRect().height,
    };
  };
  const resize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const active = resizeDrag.current;
    if (active === undefined || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    setManualHeight(
      Math.max(
        180,
        Math.min(
          Math.round(globalThis.innerHeight * 0.72),
          active.startHeight + active.startClientY - event.clientY,
        ),
      ),
    );
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resizeDrag.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    resizeDrag.current = undefined;
  };
  const resolve = async (
    action: "accept" | "decline" | "cancel",
  ): Promise<void> => {
    if (agent === undefined || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const resolved = await window.desktop.agents.resolveElicitation(
        agent.id,
        {
          requestId: request.requestId,
          action,
          ...(action === "accept" ? { content: values } : {}),
        },
      );
      if (!resolved) {
        throw new Error("This question is no longer waiting for a response.");
      }
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "The response could not be submitted.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <footer
      ref={deckRef}
      className="composer interaction-deck elicitation-deck"
      data-workspace-interaction-focus
      tabIndex={-1}
      style={manualHeight === undefined ? undefined : { height: manualHeight }}
    >
      <div
        className="interaction-resize-handle"
        role="separator"
        aria-label="Resize question panel"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void resolve("accept");
        }}
      >
        <div className="interaction-deck-heading">
          <div>
            <span className="agent-mode-badge plan">question</span>
            <h3>{request.message}</h3>
          </div>
        </div>
        <div className="elicitation-fields">
          {Object.entries(request.properties).map(([name, field]) => {
            const label = field.title ?? name;
            const required = request.required.includes(name);
            if (field.type === "boolean") {
              return (
                <label className="elicitation-checkbox" key={name}>
                  <input
                    type="checkbox"
                    checked={values[name] === true}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [name]: event.target.checked,
                      }))
                    }
                  />
                  <span>
                    {label}
                    {field.description && <small>{field.description}</small>}
                  </span>
                </label>
              );
            }
            if (field.type === "array") {
              const choices =
                "enum" in field.items
                  ? field.items.enum.map((value) => ({
                      value,
                      title: value,
                    }))
                  : field.items.anyOf.map((choice) => ({
                      value: choice.const,
                      title: choice.title,
                    }));
              const selectedValue = values[name];
              const selected = Array.isArray(selectedValue)
                ? selectedValue
                : [];
              return (
                <fieldset key={name}>
                  <legend>
                    {label}
                    {required ? " *" : ""}
                  </legend>
                  {field.description && <small>{field.description}</small>}
                  {choices.map((choice) => (
                    <label className="elicitation-checkbox" key={choice.value}>
                      <input
                        type="checkbox"
                        checked={selected.includes(choice.value)}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [name]: event.target.checked
                              ? [...selected, choice.value]
                              : selected.filter(
                                  (value) => value !== choice.value,
                                ),
                          }))
                        }
                      />
                      {choice.title}
                    </label>
                  ))}
                </fieldset>
              );
            }
            if (field.type === "string") {
              const choices =
                field.oneOf ??
                field.enum?.map((value, index) => ({
                  const: value,
                  title: field.enumNames?.[index] ?? value,
                }));
              if (choices === undefined) {
                return (
                  <label key={name}>
                    {label}
                    {required ? " *" : ""}
                    {field.description && <small>{field.description}</small>}
                    <textarea
                      required={required}
                      minLength={field.minLength}
                      maxLength={field.maxLength}
                      value={
                        typeof values[name] === "string" ? values[name] : ""
                      }
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [name]: event.target.value,
                        }))
                      }
                      rows={3}
                    />
                  </label>
                );
              }
              const selectedValue =
                typeof values[name] === "string" ? values[name] : "";
              const namedValues = choices.map((choice) => choice.const);
              const customValue =
                customValues[name] ??
                (selectedValue !== "" && !namedValues.includes(selectedValue)
                  ? selectedValue
                  : "");
              return (
                <fieldset className="elicitation-choice-group" key={name}>
                  <legend>
                    {label}
                    {required ? " *" : ""}
                  </legend>
                  {field.description && <small>{field.description}</small>}
                  {choices.map((choice) => (
                    <label className="elicitation-radio" key={choice.const}>
                      <input
                        type="radio"
                        name={`elicitation-${request.requestId}-${name}`}
                        value={choice.const}
                        checked={selectedValue === choice.const}
                        onChange={() =>
                          setValues((current) => ({
                            ...current,
                            [name]: choice.const,
                          }))
                        }
                      />
                      <span>{choice.title}</span>
                    </label>
                  ))}
                  {field.allowFreeform === true && (
                    <input
                      className="elicitation-freeform"
                      aria-label={`Custom answer for ${label}`}
                      placeholder="Type another answer"
                      minLength={field.minLength}
                      maxLength={field.maxLength}
                      value={customValue}
                      onFocus={() => {
                        if (customValue.length > 0) {
                          setValues((current) => ({
                            ...current,
                            [name]: customValue,
                          }));
                        }
                      }}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setCustomValues((current) => ({
                          ...current,
                          [name]: nextValue,
                        }));
                        setValues((current) => ({
                          ...current,
                          [name]: nextValue,
                        }));
                      }}
                    />
                  )}
                </fieldset>
              );
            }
            return (
              <label key={name}>
                {label}
                {required ? " *" : ""}
                {field.description && <small>{field.description}</small>}
                <input
                  type="number"
                  required={required}
                  step={field.type === "integer" ? 1 : "any"}
                  min={field.minimum}
                  max={field.maximum}
                  value={typeof values[name] === "number" ? values[name] : ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [name]: Number(event.target.value),
                    }))
                  }
                />
              </label>
            );
          })}
        </div>
        {error && <p className="composer-error">{error}</p>}
        <div className="interaction-actions">
          <button
            className="primary"
            type="submit"
            disabled={submitting || !requiredComplete}
          >
            Submit response
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void resolve("decline")}
          >
            Decline
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void resolve("cancel")}
          >
            Cancel
          </button>
        </div>
      </form>
    </footer>
  );
}

/** The Live color of the track a context chip belongs to. */
function contextChipTrackColor(
  state: DesktopState,
  chip: ContextChip,
): string | undefined {
  const [kind, id] = [
    chip.id.slice(0, chip.id.indexOf(":")),
    chip.id.slice(chip.id.indexOf(":") + 1),
  ];
  return state.snapshot?.tracks.find((track) =>
    kind === "track"
      ? track.id === id
      : kind === "clip"
        ? track.clips.some((clip) => clip.id === id)
        : kind === "device"
          ? track.devices.some((device) => device.id === id)
          : false,
  )?.color;
}

export function Composer({
  state,
  value,
  busy,
  submitting = false,
  error,
  composerRef,
  onChange,
  onSubmit,
  dispatch,
}: {
  state: DesktopState;
  value: string;
  busy: boolean;
  submitting?: boolean;
  error?: string | undefined;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const context = contextForSelection(state);
  const activeAgent = selectedAgentInstance(state);
  const agentMode = activeAgent?.mode ?? "interactive";
  const workspace = selectedAgentWorkspace(state);
  const activeBusy =
    busy ||
    activeAgent?.lifecycle === "busy" ||
    workspace.operations.some((operation) => operation.status === "running");
  const unavailable =
    activeAgent === undefined ||
    activeAgent.lifecycle === "starting" ||
    activeAgent.lifecycle === "blocked" ||
    activeAgent.lifecycle === "failed" ||
    state.lifecycle === "stopping" ||
    state.lifecycle === "crashed";
  const slashSuggestions = slashCompletionsForState(value, state);
  const suggestionKey = slashSuggestions
    .map(({ name, source }) => `${source}:${name}`)
    .join("\n");
  useEffect(() => {
    setSelectedSuggestion(0);
  }, [suggestionKey, activeAgent?.id]);
  const completeSuggestion = (entry: SlashCompletionEntry): void => {
    onChange(slashCompletionText(entry));
    composerRef.current?.focus();
  };
  const changeMode = (mode: "plan" | "interactive"): void => {
    if (mode === agentMode) return;
    void setSelectedAgentMode(window.desktop, state, mode, dispatch).catch(
      (modeError: unknown) =>
        dispatch({
          type: "event",
          event: {
            type: "diagnostic",
            level: "error",
            message:
              modeError instanceof Error
                ? modeError.message
                : "Agent mode could not be changed",
          },
        }),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashSuggestions.length > 0) {
      const selectedEntry =
        slashSuggestions[selectedSuggestion] ?? slashSuggestions[0]!;
      const completion = slashCompletionKey(
        event.key,
        selectedSuggestion,
        slashSuggestions.length,
        value === `/${selectedEntry.name}`,
      );
      if (typeof completion === "number") {
        event.preventDefault();
        setSelectedSuggestion(completion);
        return;
      }
      if (completion === "complete" && !event.shiftKey) {
        event.preventDefault();
        completeSuggestion(selectedEntry);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <footer className="composer" data-mode={agentMode}>
      <div className="context-chips" aria-label="Prompt context">
        <span>Context</span>
        {context.length === 0 ? (
          <em>None — agent will inspect as needed</em>
        ) : (
          context.map((chip) => (
            <button
              type="button"
              key={chip.id}
              className="track-chip"
              style={
                {
                  "--track-color":
                    contextChipTrackColor(state, chip) ?? "var(--track-none)",
                } as CSSProperties
              }
              title="Remove context"
              aria-label={`Remove ${chip.kind} ${chip.label} from context`}
              onClick={() => dispatch({ type: "remove-context", chip })}
            >
              {chip.kind}: {chip.label} ×
            </button>
          ))
        )}
      </div>
      <form onSubmit={(event) => void onSubmit(event)}>
        {activeAgent !== undefined && (
          <div
            className="mode-switch"
            role="radiogroup"
            aria-label="Agent mode"
            title="Press Shift+Tab to switch mode"
          >
            {(["plan", "interactive"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={agentMode === mode}
                className={`composer-mode-button ${mode} ${agentMode === mode ? "selected" : ""}`}
                disabled={unavailable || activeBusy}
                onClick={() => changeMode(mode)}
              >
                <Icon name={mode === "plan" ? "plan" : "bolt"} />
                {mode === "plan" ? "Plan" : "Interactive"}
              </button>
            ))}
          </div>
        )}
        <SlashCompletionSuggestions
          entries={slashSuggestions}
          selected={selectedSuggestion}
          onComplete={completeSuggestion}
        />
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
        {submitting && (
          <p className="composer-status" role="status">
            Waiting for message acceptance…
          </p>
        )}
        <label className="sr-only" htmlFor="prompt">
          Message the Ableton agent
        </label>
        <textarea
          id="prompt"
          ref={composerRef}
          value={value}
          disabled={unavailable}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            activeAgent === undefined
              ? "Select or create an active agent to begin…"
              : agentMode === "plan"
                ? `Plan with ${activeAgent.label}… (nothing in Live will change)`
                : state.connection.state === "connected"
                  ? `Ask ${activeAgent.label}… (/ for skills)`
                  : "Ask using the demo adapter, or connect to Ableton…"
          }
          rows={2}
        />
        <div className="composer-actions">
          {activeAgent !== undefined ? (
            <small className="composer-mode-hint">
              {agentMode === "plan"
                ? "Plan · the agent writes a plan you can review in the Inspector. ⇧Tab to switch."
                : "Interactive · the agent can edit your Live set. ⇧Tab to switch."}
            </small>
          ) : (
            <span />
          )}
          {submitting ? (
            <button
              className="composer-action-button primary"
              type="submit"
              aria-label="Waiting for message acceptance"
              title="Waiting for message acceptance"
              disabled
            >
              <ComposerActionIcon type="send" />
            </button>
          ) : activeBusy ? (
            <button
              type="button"
              className="composer-action-button stop"
              aria-label="Stop agent"
              title="Stop agent"
              onClick={() => void cancelWorkspaceAgent(window.desktop, state)}
            >
              <ComposerActionIcon type="stop" />
            </button>
          ) : (
            <button
              className="composer-action-button primary"
              type="submit"
              aria-label="Send message"
              title="Send message"
              disabled={unavailable || !value.trim()}
            >
              <ComposerActionIcon type="send" />
            </button>
          )}
        </div>
      </form>
    </footer>
  );
}

function ComposerActionIcon({
  type,
}: {
  type: "send" | "stop";
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      {type === "send" ? (
        <>
          <path d="M9 14V4" />
          <path d="m5 8 4-4 4 4" />
        </>
      ) : (
        <rect x="5" y="5" width="8" height="8" rx="1" />
      )}
    </svg>
  );
}

export function SlashCompletionSuggestions({
  entries,
  selected,
  onComplete,
}: {
  entries: readonly SlashCompletionEntry[];
  selected: number;
  onComplete: (entry: SlashCompletionEntry) => void;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="slash-suggestions" aria-label="Slash command suggestions">
      {entries.map((entry, index) => (
        <button
          type="button"
          key={entry.name}
          aria-current={index === selected}
          aria-label={`/${entry.name}. ${entry.source === "built-in" ? "Built-in command" : "Skill"}. ${entry.description}${entry.usage === undefined ? "" : ` Usage: ${entry.usage}`}`}
          onClick={() => onComplete(entry)}
        >
          <strong>/{entry.name}</strong>
          <span className="slash-suggestion-source">
            {entry.source === "built-in" ? "Built-in" : "Skill"}
          </span>
          <span>{entry.description}</span>
          {entry.usage !== undefined && (
            <span>
              Usage: <code>{entry.usage}</code>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function PresentationState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.JSX.Element {
  return (
    <section className="presentation-state" role="status">
      <span className="spinner" aria-hidden="true" />
      <h1>{title}</h1>
      <p>{detail}</p>
    </section>
  );
}
