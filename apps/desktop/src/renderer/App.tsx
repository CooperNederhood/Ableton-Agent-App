import {
  InvalidSkillInvocationError,
  parseSkillInvocation,
  type SkillInvocation,
} from "@ableton-agent/agent-config/skill-invocation";
import {
  MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH,
  resolvePreparedContextConfiguration,
  type AgentEventListener,
  type PreparedContextConfiguration,
} from "@ableton-agent/agent-config/schemas";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import type {
  DesktopApi,
  DesktopActiveAgent,
  DesktopAgentConversationSettings,
  DesktopAgentModel,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopOutputAssignment,
  DesktopOutputConnection,
  DesktopProjectSnapshot,
  DesktopLiveEventState,
  LatestAcceptedOutput,
  DesktopTrack,
  ConfigurationSnapshotPage,
  RootTracePage,
  RootTraceQuery,
  TelemetryEventPage,
  LiveEventDefinitionDraft,
  LiveEventSelection,
  PlanSection,
} from "../contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  contextForSelection,
  activeSession,
  boundRefreshMessage,
  desktopReducer,
  initialState,
  selectedAgentInstance,
  selectedAgentWorkspace,
  type DesktopState,
  type WorkspaceView,
} from "./state";
import { parseYoloCommand, yoloCommandUsage } from "./yolo-command";

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
      .map(({ name, description }) => ({
        name,
        description,
        source: "skill" as const,
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
  return matchingSlashCompletions(
    input,
    selectedAgentInstance(state) === undefined
      ? undefined
      : state.agentCatalog.skills,
  );
}

export function slashCompletionKey(
  key: string,
  selected: number,
  count: number,
): number | "complete" | undefined {
  if (count === 0) return undefined;
  if (key === "ArrowDown") return (selected + 1) % count;
  if (key === "ArrowUp") return (selected - 1 + count) % count;
  if (key === "Tab" || key === "Enter") return "complete";
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
const eventPickerLimit = 128;
const defaultParameterPolicy = {
  minimumNormalizedDelta: 0.01,
  throttleMs: 100,
} as const;
const trackEventKinds = [
  "track.playing_clip_changed",
  "track.triggered_clip_changed",
  "track.recording_state_changed",
] as const;

type TrackEventKind = (typeof trackEventKinds)[number];

const eventKindLabels: Record<LiveEventDefinitionDraft["kind"], string> = {
  "parameter.value_changed": "Parameter value",
  "track.playing_clip_changed": "Playing clip",
  "track.triggered_clip_changed": "Triggered clip",
  "track.recording_state_changed": "Recording state",
};

function namedOccurrence<T extends { name: string }>(
  items: readonly T[],
  index: number,
): number {
  const name = items[index]?.name;
  if (name === undefined) return 0;
  return items.slice(0, index).filter((item) => item.name === name).length;
}

function trackDraft(
  track: DesktopTrack,
  snapshot: DesktopProjectSnapshot,
  kind: TrackEventKind,
): LiveEventDefinitionDraft {
  const index = snapshot.tracks.findIndex(({ id }) => id === track.id);
  return {
    kind,
    classification: "discrete",
    name: `${track.name}: ${eventKindLabels[kind]}`,
    enabled: true,
    target: {
      track: {
        name: track.name,
        occurrence: namedOccurrence(snapshot.tracks, index),
      },
    },
  };
}

export function parameterDraftFromSnapshot(
  snapshot: DesktopProjectSnapshot,
  trackId: string,
  deviceId: string,
  parameterId: string,
): LiveEventDefinitionDraft | undefined {
  const trackIndex = snapshot.tracks.findIndex(({ id }) => id === trackId);
  const track = snapshot.tracks[trackIndex];
  const deviceIndex =
    track?.devices.findIndex(({ id }) => id === deviceId) ?? -1;
  const device = track?.devices[deviceIndex];
  const parameterIndex =
    device?.parameters.findIndex(({ id }) => id === parameterId) ?? -1;
  const parameter = device?.parameters[parameterIndex];
  if (!track || !device || !parameter) return undefined;
  return {
    kind: "parameter.value_changed",
    classification: "continuous",
    name: `${track.name}: ${device.name} ${parameter.name}`,
    enabled: true,
    target: {
      track: {
        name: track.name,
        occurrence: namedOccurrence(snapshot.tracks, trackIndex),
      },
      device: {
        name: device.name,
        occurrence: namedOccurrence(track.devices, deviceIndex),
      },
      parameter: {
        name: parameter.name,
        occurrence: namedOccurrence(device.parameters, parameterIndex),
      },
    },
    observationPolicy: defaultParameterPolicy,
  };
}

export function parameterDraftFromSelection(
  selection: LiveEventSelection,
  snapshot?: DesktopProjectSnapshot,
): LiveEventDefinitionDraft | undefined {
  const identity = selection.parameter;
  if (identity === null || snapshot === undefined) return undefined;
  return parameterDraftFromSnapshot(
    snapshot,
    identity.expectedReference,
    identity.expectedDeviceReference,
    identity.expectedParameterReference,
  );
}

export interface EventTrackGroup {
  id: string;
  label: string;
  color: string;
  events: DesktopLiveEventState[];
}

export function groupEventsByTrack(
  events: DesktopLiveEventState[],
  snapshot: DesktopProjectSnapshot | undefined,
): EventTrackGroup[] {
  const tracks = new Map(
    (snapshot?.tracks ?? []).map((track, index) => [
      track.id,
      { track, index },
    ]),
  );
  const grouped = new Map<string, EventTrackGroup & { index: number }>();
  const unresolved: DesktopLiveEventState[] = [];
  const global: DesktopLiveEventState[] = [];
  for (const event of events) {
    if (!("track" in event.definition.target)) {
      global.push(event);
      continue;
    }
    if (event.resolution.status !== "resolved") {
      unresolved.push(event);
      continue;
    }
    const resolved = tracks.get(event.resolution.trackReference);
    if (resolved === undefined) {
      unresolved.push(event);
      continue;
    }
    const existing = grouped.get(resolved.track.id);
    if (existing) existing.events.push(event);
    else
      grouped.set(resolved.track.id, {
        id: resolved.track.id,
        label: resolved.track.name,
        color: resolved.track.color,
        events: [event],
        index: resolved.index,
      });
  }
  const result = [...grouped.values()].sort(
    (left, right) => left.index - right.index,
  );
  if (global.length)
    result.push({
      id: "global",
      label: "Global",
      color: unknownOutputTrackColor,
      events: global,
      index: Infinity,
    });
  if (unresolved.length)
    result.push({
      id: "unresolved",
      label: "Unresolved",
      color: "#d69b54",
      events: unresolved,
      index: Infinity,
    });
  return result;
}

export interface OutputTrackGroup {
  id: string;
  label: string;
  color: string;
  track?: DesktopTrack | undefined;
  connections: DesktopOutputConnection[];
}

function resolvedOutputTrack(
  connection: DesktopOutputConnection,
  snapshot: DesktopProjectSnapshot | undefined,
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
  snapshot: DesktopProjectSnapshot | undefined,
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
    await desktop.agents.invokeSkill(
      agent.id,
      invocation.skillName,
      invocation.request,
      context,
      agentMode,
    );
    dispatch({
      type: "user-message",
      id: crypto.randomUUID(),
      content: message,
      agentInstanceId: agent.id,
      agentMode,
    });
    return;
  }
  dispatch({
    type: "user-message",
    id: crypto.randomUUID(),
    content: message,
    agentInstanceId: agent.id,
    agentMode,
  });
  await desktop.agents.send(
    agent.id,
    message,
    contextForSelection(state),
    agentMode,
  );
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

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(desktopReducer, initialState);
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const [topChromeVisible, setTopChromeVisible] = useState(true);
  const [composerValue, setComposerValue] = useState("");
  const [composerError, setComposerError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const hydratedAgents = useRef(new Set<string>());
  const timelineScrollPositions = useRef(new Map<string, number>());

  useEffect(() => {
    const pendingDeltas = new Map<
      string,
      Extract<DesktopAppEvent, { type: "agent.message_delta" }>
    >();
    let frame: number | undefined;
    let eventsFrame: number | undefined;
    let pendingEvents:
      Extract<DesktopAppEvent, { type: "events.changed" }> | undefined;
    const flush = (): void => {
      frame = undefined;
      for (const event of pendingDeltas.values())
        dispatch({ type: "event", event });
      pendingDeltas.clear();
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
      if (event.type !== "agent.message_delta") {
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (pendingDeltas.size > 0) flush();
        dispatch({ type: "event", event });
        return;
      }
      const key = `${event.agentInstanceId ?? "legacy"}:${event.messageId}`;
      const pending = pendingDeltas.get(key);
      pendingDeltas.set(key, {
        ...event,
        content: (pending?.content ?? "") + event.content,
      });
      frame ??= requestAnimationFrame(flush);
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
  const selectedPlanApproval = selectedAgentWorkspace(state).planApproval;
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
    if (selectedPlanApproval !== undefined) setRightSidebarVisible(true);
  }, [selectedPlanApproval]);
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
        composerRef.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        dispatch({ type: "view", view: "settings" });
      }
      if (event.key === "Escape" && selectedAgentWorkspace(state).approval) {
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state]);

  return (
    <div
      className={`app-shell ${state.activeView === "workspace" ? "workspace-active" : ""} ${topChromeVisible ? "" : "top-chrome-hidden"}`}
    >
      {topChromeVisible && (
        <ConnectionHeader
          state={state}
          dispatch={dispatch}
          onHideChrome={() => setTopChromeVisible(false)}
        />
      )}
      <ProjectTransitionModal state={state} dispatch={dispatch} />
      {topChromeVisible && (
        <nav
          id="application-views"
          className="view-tabs"
          aria-label="Application views"
        >
          {(
            [
              "workspace",
              "agents",
              "outputs",
              "events",
              "browser",
              "diagnostics",
              "sessions",
              "settings",
            ] as WorkspaceView[]
          ).map((view) => (
            <button
              key={view}
              className={state.activeView === view ? "selected" : ""}
              onClick={() => dispatch({ type: "view", view })}
            >
              {view[0]?.toUpperCase()}
              {view.slice(1)}
            </button>
          ))}
        </nav>
      )}
      {!topChromeVisible && (
        <button
          type="button"
          className="restore-top-chrome"
          aria-label="Show application toolbar"
          aria-expanded="false"
          aria-controls="application-toolbar application-views"
          onClick={() => setTopChromeVisible(true)}
        >
          <ChromeIcon expanded={false} />
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
              />
            }
            leftSidebarVisible={leftSidebarVisible}
            rightSidebarVisible={rightSidebarVisible}
            onToggleLeftSidebar={() =>
              setLeftSidebarVisible((visible) => !visible)
            }
            onToggleRightSidebar={() =>
              setRightSidebarVisible((visible) => !visible)
            }
          />
        ) : state.activeView === "agents" ? (
          <AgentsView state={state} dispatch={dispatch} />
        ) : state.activeView === "outputs" ? (
          <OutputsView state={state} dispatch={dispatch} />
        ) : state.activeView === "events" ? (
          <EventsView state={state} dispatch={dispatch} />
        ) : state.activeView === "browser" ? (
          <BrowserView state={state} dispatch={dispatch} />
        ) : state.activeView === "diagnostics" ? (
          <DiagnosticsView state={state} dispatch={dispatch} />
        ) : state.activeView === "sessions" ? (
          <SessionsView state={state} />
        ) : (
          <SettingsView state={state} dispatch={dispatch} />
        )}
      </main>
      {state.activeView !== "workspace" && (
        <DesktopComposer
          state={state}
          composerRef={composerRef}
          dispatch={dispatch}
          value={composerValue}
          error={composerError}
          onValueChange={setComposerValue}
          onErrorChange={setComposerError}
        />
      )}
    </div>
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

function selectionTrack(
  selection: LiveEventSelection | undefined,
  snapshot: DesktopProjectSnapshot | undefined,
): DesktopTrack | undefined {
  if (!selection?.track || !snapshot) return undefined;
  return (
    snapshot.tracks.find(
      ({ id }) => id === selection.track?.expectedReference,
    ) ??
    snapshot.tracks[selection.track.index] ??
    snapshot.tracks.find(({ name }) => name === selection.track?.expectedName)
  );
}

function latestStateLabel(event: DesktopLiveEventState): string {
  const latest = event.latestState;
  if (latest === undefined) return "Waiting for initial state";
  switch (latest.kind) {
    case "parameter.value_changed":
      return latest.state.displayValue;
    case "track.playing_clip_changed":
    case "track.triggered_clip_changed":
      return latest.state.state === "session-clip"
        ? (latest.state.clipName ??
            `Session clip ${latest.state.slotIndex + 1}`)
        : latest.state.state;
    case "track.recording_state_changed":
      return `${latest.state.recording ? "Recording" : "Not recording"} (${latest.state.source})`;
  }
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
  const [adding, setAdding] = useState(false);
  const groups = groupEventsByTrack(state.events.events, state.snapshot);
  const historyMode = state.preferences.eventsViewMode === "history";
  const sessionActive = activeSession(state) !== undefined;

  useEffect(() => {
    if (!sessionActive) setAdding(false);
  }, [sessionActive]);

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
      <section className="events-view" aria-labelledby="events-heading">
        <EventsModeHeading mode="history" onChange={setMode} />
        <EventHistoryView state={state} dispatch={dispatch} />
      </section>
    );
  }

  return (
    <section className="events-view" aria-labelledby="events-heading">
      <div className="panel-heading">
        <div>
          <h2 id="events-heading">Events</h2>
          <p>
            Watch bounded Ableton state changes without adding a Max for Live
            device.
          </p>
          <EventsModeTabs mode="live" onChange={setMode} />
        </div>
        <button
          type="button"
          aria-expanded={adding}
          aria-controls="add-event-panel"
          disabled={!sessionActive}
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? "Close" : "Add event"}
        </button>
      </div>
      {!sessionActive && (
        <div className="notice" role="status">
          Event controls will be available after the production session is
          restored.
        </div>
      )}
      {adding && (
        <AddEventPanel
          state={state}
          dispatch={dispatch}
          sessionActive={sessionActive}
          onCreated={() => setAdding(false)}
        />
      )}
      {state.eventsLoad.status === "loading" ? (
        <PresentationState
          title="Loading Events…"
          detail="Reading event definitions and current Live state."
        />
      ) : state.eventsLoad.status === "failed" ? (
        <div className="event-load-error" role="alert">
          <strong>Events could not be loaded</strong>
          <p>{state.eventsLoad.message}</p>
          <button
            type="button"
            onClick={() =>
              void loadLiveEvents(dispatch, () => window.desktop.events.list())
            }
          >
            Retry
          </button>
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          title="No Live Events"
          detail="Add an event to watch a selected parameter or track state."
        />
      ) : (
        <div className="event-track-groups">
          {groups.map((group) => (
            <section
              key={group.id}
              className="event-track-group"
              aria-labelledby={`event-track-${group.id}`}
              style={{ "--event-track-color": group.color } as CSSProperties}
            >
              <header className="event-track-heading">
                <span className="event-track-swatch" aria-hidden="true" />
                <div>
                  <h3 id={`event-track-${group.id}`}>{group.label}</h3>
                  <span>
                    {group.events.length}{" "}
                    {group.events.length === 1 ? "event" : "events"}
                  </span>
                </div>
              </header>
              <div className="event-grid">
                {group.events.map((event) => (
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
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function EventsModeHeading({
  mode,
  onChange,
}: {
  mode: "live" | "history";
  onChange: (mode: "live" | "history") => void;
}): React.JSX.Element {
  return (
    <div className="panel-heading">
      <div>
        <h2 id="events-heading">Events</h2>
        <p>Inspect live definitions or detailed local execution history.</p>
        <EventsModeTabs mode={mode} onChange={onChange} />
      </div>
    </div>
  );
}

function EventsModeTabs({
  mode,
  onChange,
}: {
  mode: "live" | "history";
  onChange: (mode: "live" | "history") => void;
}): React.JSX.Element {
  return (
    <div className="events-mode-tabs" role="tablist" aria-label="Events mode">
      {(["live", "history"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          className={mode === value ? "selected" : ""}
          onClick={() => onChange(value)}
        >
          {value === "live" ? "Live Events" : "History"}
        </button>
      ))}
    </div>
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

function eventHistoryQuery(
  filters: {
    names: string;
    sources: string;
    level: string;
    outcome: string;
    from: string;
    to: string;
  },
  cursor?: string,
): RootTraceQuery {
  const split = (value: string): string[] | undefined => {
    const values = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length === 0 ? undefined : [...new Set(values)];
  };
  return {
    limit: 100,
    order: "desc",
    ...(split(filters.names) === undefined
      ? {}
      : { names: split(filters.names) }),
    ...(split(filters.sources) === undefined
      ? {}
      : { sources: split(filters.sources) }),
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
    ...(filters.from === ""
      ? {}
      : { from: new Date(filters.from).toISOString() }),
    ...(filters.to === "" ? {} : { to: new Date(filters.to).toISOString() }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function EventHistoryView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
}): React.JSX.Element {
  const [filters, setFilters] = useState({
    names: "",
    sources: "",
    level: "",
    outcome: "",
    from: "",
    to: "",
  });
  const refresh = (): void => {
    let query: RootTraceQuery;
    try {
      query = eventHistoryQuery(filters);
    } catch {
      dispatch({
        type: "event-history-load-failed",
        message: "History dates must be valid.",
      });
      return;
    }
    void loadEventHistory(
      dispatch,
      (value) => window.desktop.eventHistory.search(value),
      query,
    );
    void Promise.all([
      window.desktop.eventHistory.configurations({ limit: 100, order: "desc" }),
      window.desktop.eventHistory.health(),
    ])
      .then(([page, health]) => {
        dispatch({ type: "event-history-configurations-loaded", page });
        dispatch({ type: "event-history-health-loaded", health });
      })
      .catch((error: unknown) =>
        eventError(dispatch, error, "History metadata could not be loaded"),
      );
  };

  useEffect(() => {
    if (state.preferences.eventsViewMode === "history") refresh();
  }, [state.preferences.eventsViewMode]);

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
    <div className="event-history-layout">
      <form
        className="history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          refresh();
        }}
      >
        <label>
          Event names
          <input
            value={filters.names}
            placeholder="agent.turn, tool.completed"
            onChange={(event) =>
              setFilters({ ...filters, names: event.target.value })
            }
          />
        </label>
        <label>
          Sources
          <input
            value={filters.sources}
            placeholder="runtime, desktop"
            onChange={(event) =>
              setFilters({ ...filters, sources: event.target.value })
            }
          />
        </label>
        <label>
          Level
          <select
            value={filters.level}
            onChange={(event) =>
              setFilters({ ...filters, level: event.target.value })
            }
          >
            <option value="">All</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          Outcome
          <select
            value={filters.outcome}
            onChange={(event) =>
              setFilters({ ...filters, outcome: event.target.value })
            }
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="cancelled">Cancelled</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          From
          <input
            type="datetime-local"
            value={filters.from}
            onChange={(event) =>
              setFilters({ ...filters, from: event.target.value })
            }
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={filters.to}
            onChange={(event) =>
              setFilters({ ...filters, to: event.target.value })
            }
          />
        </label>
        <button type="submit">Apply filters</button>
      </form>
      {state.eventHistory.health && (
        <p className="history-health">
          Journal {state.eventHistory.health.status} ·{" "}
          {state.eventHistory.health.persistedEvents} events ·{" "}
          {formatBytes(state.eventHistory.health.databaseBytes)}
        </p>
      )}
      {state.eventHistory.status === "failed" ? (
        <div role="alert" className="event-load-error">
          {state.eventHistory.message}
        </div>
      ) : state.eventHistory.status === "loading" &&
        state.eventHistory.items.length === 0 ? (
        <PresentationState
          title="Loading event history…"
          detail="Querying the local journal."
        />
      ) : state.eventHistory.items.length === 0 ? (
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
                <time>{new Date(trace.firstOccurredAt).toLocaleString()}</time>
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
  if (events.length === 0) {
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
    activeAgentIds.size === 0
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function AddEventPanel({
  state,
  dispatch,
  sessionActive,
  onCreated,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
  sessionActive: boolean;
  onCreated: () => void;
}): React.JSX.Element {
  const snapshot = state.snapshot;
  const appTrack = snapshot?.tracks.find(
    ({ id }) => id === state.selectedTrackId,
  );
  const [selection, setSelection] = useState<LiveEventSelection>();
  const [selectionError, setSelectionError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<"parameter" | "track">("parameter");
  const [trackId, setTrackId] = useState(appTrack?.id ?? "");
  const tracks = (snapshot?.tracks ?? []).slice(0, eventPickerLimit);
  const pickerTrack = tracks.find(({ id }) => id === trackId) ?? tracks[0];
  const [deviceId, setDeviceId] = useState(pickerTrack?.devices[0]?.id ?? "");
  const device =
    pickerTrack?.devices.find(({ id }) => id === deviceId) ??
    pickerTrack?.devices[0];
  const [parameterId, setParameterId] = useState(
    device?.parameters[0]?.id ?? "",
  );
  const liveTrack = selectionTrack(selection, snapshot);
  const selectedTrack = appTrack ?? liveTrack;
  const selectedParameterDraft =
    selection === undefined
      ? undefined
      : parameterDraftFromSelection(selection, snapshot);

  useEffect(() => {
    if (!sessionActive) return;
    void window.desktop.events
      .inspectSelection()
      .then(setSelection)
      .catch((error: unknown) =>
        setSelectionError(
          error instanceof Error
            ? error.message
            : "Live selection could not be inspected",
        ),
      );
  }, [sessionActive]);

  const create = async (draft: LiveEventDefinitionDraft | undefined) => {
    if (!sessionActive || draft === undefined) return;
    setCreating(true);
    try {
      await window.desktop.events.create(draft);
      onCreated();
    } catch (error) {
      eventError(dispatch, error, "Event could not be created");
    } finally {
      setCreating(false);
    }
  };
  const chooseTrack = (id: string): void => {
    setTrackId(id);
    const next = tracks.find((track) => track.id === id);
    setDeviceId(next?.devices[0]?.id ?? "");
    setParameterId(next?.devices[0]?.parameters[0]?.id ?? "");
  };
  const chooseDevice = (id: string): void => {
    setDeviceId(id);
    setParameterId(
      pickerTrack?.devices.find((candidate) => candidate.id === id)
        ?.parameters[0]?.id ?? "",
    );
  };

  return (
    <section id="add-event-panel" className="add-event-panel">
      <h3>Quick add</h3>
      <div className="event-quick-actions">
        <button
          type="button"
          disabled={
            !sessionActive || creating || selectedParameterDraft === undefined
          }
          onClick={() => void create(selectedParameterDraft)}
        >
          Watch selected parameter
        </button>
        {selectionError ? (
          <span role="status">{selectionError}</span>
        ) : selection === undefined ? (
          <span role="status">Inspecting Live selection…</span>
        ) : selection.parameter === null ? (
          <span>No parameter is selected in Live.</span>
        ) : selectedParameterDraft === undefined ? (
          <span>
            Refresh the project snapshot to safely match the selected parameter.
          </span>
        ) : null}
      </div>
      <div className="selected-track-events">
        <strong>
          Selected track: {selectedTrack?.name ?? "No track selected"}
        </strong>
        <div className="event-quick-actions">
          {trackEventKinds.map((kind) => (
            <button
              type="button"
              key={kind}
              disabled={
                !sessionActive || creating || !selectedTrack || !snapshot
              }
              onClick={() =>
                void create(trackDraft(selectedTrack!, snapshot!, kind))
              }
            >
              {eventKindLabels[kind]}
            </button>
          ))}
        </div>
      </div>
      <details className="event-picker">
        <summary>Browse all</summary>
        {!snapshot ? (
          <p>Refresh the project snapshot to browse tracks and parameters.</p>
        ) : (
          <div className="event-picker-fields">
            <label>
              Source
              <select
                value={source}
                onChange={(event) =>
                  setSource(event.target.value as "parameter" | "track")
                }
              >
                <option value="parameter">Parameter</option>
                <option value="track">Track event</option>
              </select>
            </label>
            <label>
              Track
              <select
                value={pickerTrack?.id ?? ""}
                onChange={(event) => chooseTrack(event.target.value)}
              >
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
            </label>
            {source === "parameter" ? (
              <>
                <label>
                  Device
                  <select
                    value={device?.id ?? ""}
                    onChange={(event) => chooseDevice(event.target.value)}
                  >
                    {(pickerTrack?.devices ?? [])
                      .slice(0, eventPickerLimit)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Parameter
                  <select
                    value={parameterId}
                    onChange={(event) => setParameterId(event.target.value)}
                  >
                    {(device?.parameters ?? [])
                      .slice(0, eventPickerLimit)
                      .map((parameter) => (
                        <option key={parameter.id} value={parameter.id}>
                          {parameter.name} — {parameter.displayValue}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={
                    !sessionActive ||
                    creating ||
                    !pickerTrack ||
                    !device ||
                    !parameterId
                  }
                  onClick={() =>
                    void create(
                      parameterDraftFromSnapshot(
                        snapshot,
                        pickerTrack!.id,
                        device!.id,
                        parameterId,
                      ),
                    )
                  }
                >
                  Add parameter event
                </button>
              </>
            ) : (
              <div className="event-quick-actions">
                {trackEventKinds.map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    disabled={!sessionActive || creating || !pickerTrack}
                    onClick={() =>
                      void create(trackDraft(pickerTrack!, snapshot, kind))
                    }
                  >
                    {eventKindLabels[kind]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </details>
    </section>
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
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
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

export function ProjectTransitionModal({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element | null {
  const transition = state.pendingProjectTransition;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  if (transition === undefined) return null;

  const resolve = async (
    decision: Parameters<DesktopApi["project"]["resolveTransition"]>[1],
  ): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      const session = await window.desktop.project.resolveTransition(
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
          Ableton is now using <strong>{transition.project.projectName}</strong>
          .
        </p>
        {transition.kind === "associated" ? (
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
          <button
            disabled={submitting}
            onClick={() => void resolve("start-fresh")}
          >
            Start fresh
          </button>
        </div>
      </section>
    </div>
  );
}

export function ConnectionHeader({
  state,
  dispatch,
  onHideChrome,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onHideChrome?: (() => void) | undefined;
}): React.JSX.Element {
  const session = activeSession(state);
  const activeAgent = selectedAgentInstance(state);
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
  return (
    <header
      id="application-toolbar"
      className="connection-header"
      aria-label="Application toolbar"
    >
      <div>
        <strong>Ableton Agent</strong>
        <span
          className={`status status-${state.connection.state}`}
          aria-label={`Ableton status: ${connectionText}`}
        >
          ● {connectionText}
        </span>
      </div>
      <div className="project-title">
        {state.snapshot?.name ?? "No project"}{" "}
        <small>
          {state.snapshot
            ? `${state.snapshot.tempo} BPM · ${state.snapshot.timeSignature}`
            : "Waiting for snapshot"}
        </small>
      </div>
      <div className="header-controls">
        <label>
          Active Agent
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
        <span className="model">
          {activeAgent?.model ?? "SDK default"} ·{" "}
          {activeAgent?.reasoningEffort ?? "Model default"}
        </span>
        {state.connection.state !== "connected" && (
          <button
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
        {onHideChrome !== undefined && (
          <button
            type="button"
            className="icon-button"
            aria-label="Hide application toolbar"
            aria-expanded="true"
            aria-controls="application-toolbar application-views"
            onClick={onHideChrome}
          >
            <ChromeIcon expanded />
          </button>
        )}
      </div>
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
  onToggleLeftSidebar,
  onToggleRightSidebar,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  timelineScrollPositions?: Map<string, number> | undefined;
  composer?: React.ReactNode;
  leftSidebarVisible?: boolean;
  rightSidebarVisible?: boolean;
  onToggleLeftSidebar?: (() => void) | undefined;
  onToggleRightSidebar?: (() => void) | undefined;
}): React.JSX.Element {
  const activeAgent = selectedAgentInstance(state);
  return (
    <div
      className={`workspace ${leftSidebarVisible ? "" : "left-sidebar-hidden"} ${rightSidebarVisible ? "" : "right-sidebar-hidden"}`}
    >
      {leftSidebarVisible && (
        <ProjectOutline state={state} dispatch={dispatch} />
      )}
      <section
        className="conversation"
        aria-label="Conversation and operation timeline"
      >
        <div className="panel-heading">
          <div className="conversation-heading-start">
            {onToggleLeftSidebar !== undefined && (
              <button
                type="button"
                className="icon-button"
                aria-label={
                  leftSidebarVisible
                    ? "Hide project sidebar"
                    : "Show project sidebar"
                }
                aria-expanded={leftSidebarVisible}
                aria-controls="project-sidebar"
                onClick={onToggleLeftSidebar}
              >
                <SidebarIcon side="left" expanded={leftSidebarVisible} />
              </button>
            )}
            <h2>Conversation</h2>
          </div>
          <span>
            {activeAgent === undefined
              ? "No active agent"
              : `${activeAgent.label} · ${activeAgent.lifecycle}`}
            {activeAgent?.autoApprove && (
              <span className="agent-badge yolo-badge">YOLO</span>
            )}
          </span>
          {onToggleRightSidebar !== undefined && (
            <button
              type="button"
              className="icon-button"
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
        </div>
        <Timeline state={state} scrollPositions={timelineScrollPositions} />
        {composer}
      </section>
      {rightSidebarVisible && <Inspector state={state} dispatch={dispatch} />}
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

function ChromeIcon({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="2" />
      <path d="M3 6h12" />
      <path d={expanded ? "M7 10l2 2 2-2" : "M7 12l2-2 2 2"} />
    </svg>
  );
}

export function AgentsView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const session = activeSession(state);
  const activeAgents = session?.activeAgents ?? [];
  const selectedAgentId = session?.selectedAgentInstanceId;
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [creatingDefinition, setCreatingDefinition] = useState<string>();
  const [confirmResetId, setConfirmResetId] = useState<string>();
  const [modelsState, setModelsState] = useState<
    | { status: "loading"; models: DesktopAgentModel[] }
    | { status: "loaded"; models: DesktopAgentModel[] }
    | { status: "failed"; models: DesktopAgentModel[]; message: string }
  >({ status: "loading", models: [] });

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
    } catch (error) {
      reportError(error, `Could not create ${definitionName}`);
    } finally {
      setCreatingDefinition(undefined);
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
      <div className="panel-heading">
        <div>
          <h2 id="agents-heading">Agents</h2>
          <p>YAML-defined Ableton agents available to production sessions.</p>
        </div>
        <button disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh definitions"}
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
          <span>Copilot models could not be loaded: {modelsState.message}</span>
          <button onClick={() => void loadModels()}>Retry models</button>
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
      <section
        className="active-agents"
        aria-labelledby="active-agents-heading"
      >
        <div className="panel-heading">
          <div>
            <h3 id="active-agents-heading">Active agents</h3>
            <p>Independent conversations in the current production session.</p>
          </div>
        </div>
        {activeAgents.length === 0 ? (
          state.lifecycle === "starting" && session === undefined ? (
            <p role="status">Loading active agents…</p>
          ) : (
            <EmptyState
              title="No active agents"
              detail="Create an instance from a definition below."
            />
          )
        ) : (
          <div className="active-agent-list">
            {activeAgents.map((agent) => (
              <ActiveAgentCard
                agent={agent}
                availableSkills={state.agentCatalog.skills}
                liveEvents={state.events.events}
                models={modelsState.models}
                modelsStatus={modelsState.status}
                definitionSource={
                  state.agentCatalog.definitions.find(
                    (definition) => definition.name === agent.definitionName,
                  )?.sourceFile
                }
                definitionUpdated={state.agentCatalog.definitions.some(
                  (definition) =>
                    definition.name === agent.definitionName &&
                    definition.fingerprint !== agent.definitionFingerprint,
                )}
                selected={selectedAgentId === agent.id}
                busy={busyAgentId === agent.id || agent.lifecycle === "busy"}
                confirmingReset={confirmResetId === agent.id}
                onRename={(label) =>
                  runAgentAction(
                    agent.id,
                    () => window.desktop.agents.rename(agent.id, label),
                    "Could not rename agent",
                    "renamed",
                  )
                }
                onConfigure={(overrides) =>
                  runAgentAction(
                    agent.id,
                    () => window.desktop.agents.configure(agent.id, overrides),
                    "Could not update agent configuration",
                    "configured",
                  )
                }
                onSetConversationSettings={(settings) =>
                  runAgentAction(
                    agent.id,
                    () =>
                      window.desktop.agents.setConversationSettings(
                        agent.id,
                        settings,
                      ),
                    "Could not change agent conversation settings",
                    "conversation-settings-changed",
                  )
                }
                onReset={() => {
                  if (confirmResetId !== agent.id) {
                    setConfirmResetId(agent.id);
                    return Promise.resolve();
                  }
                  setConfirmResetId(undefined);
                  return runAgentAction(
                    agent.id,
                    () => window.desktop.agents.reset(agent.id),
                    "Could not reset agent",
                    "reset",
                  ).then(() => undefined);
                }}
                onCancelReset={() => setConfirmResetId(undefined)}
                onEventError={(error) =>
                  reportError(error, "Could not update listening events")
                }
                onSelect={() => selectAgent(agent.id, false)}
                onOpen={() => selectAgent(agent.id, true)}
                onDeactivate={() => deactivateAgent(agent.id)}
                key={agent.id}
              />
            ))}
          </div>
        )}
      </section>
      <div className="panel-heading agent-definitions-heading">
        <div>
          <h3>Defined agents</h3>
          <p>Templates for creating independent active instances.</p>
        </div>
      </div>
      {state.agentCatalog.definitions.length === 0 ? (
        <EmptyState
          title="No valid agents found"
          detail="Add YAML definitions to the configured agents directory."
        />
      ) : (
        <div className="agent-definition-grid">
          {state.agentCatalog.definitions.map((definition) => (
            <article className="agent-definition-card" key={definition.name}>
              <header>
                <div>
                  <h3>{definition.name}</h3>
                  <p>{definition.description}</p>
                </div>
                <span>Defined</span>
              </header>
              <dl>
                <dt>Source</dt>
                <dd>{definition.sourceFile}</dd>
                <dt>Fingerprint</dt>
                <dd>
                  <code title={definition.fingerprint}>
                    {definition.fingerprint.slice(0, 12)}
                  </code>
                </dd>
                <dt>Tools</dt>
                <dd>
                  {definition.tools.join(", ")}
                  <ResolvedToolsDisclosure
                    patterns={definition.tools}
                    resolvedTools={definition.resolvedTools}
                  />
                </dd>
                <dt>Edit scope</dt>
                <dd>
                  {definition.editScope
                    .map((entry) =>
                      entry === "session"
                        ? "Full session"
                        : `${entry.track.name} #${entry.track.occurrence + 1}`,
                    )
                    .join(", ")}
                </dd>
                <dt>Skills</dt>
                <dd>
                  {definition.skills.length > 0
                    ? definition.skills.join(", ")
                    : "None"}
                </dd>
                <dt>Inputs</dt>
                <dd>
                  {definition.inputChannels.length > 0
                    ? definition.inputChannels.join(", ")
                    : "Prompt only"}
                </dd>
              </dl>
              <button
                disabled={
                  session === undefined ||
                  creatingDefinition === definition.name
                }
                onClick={() => void createAgent(definition.name)}
              >
                {creatingDefinition === definition.name
                  ? "Creating…"
                  : "Create agent"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

type AgentOverrides = Parameters<DesktopApi["agents"]["configure"]>[1];

function scopeLabel(scope: DesktopActiveAgent["config"]["editScope"]): string {
  return scope
    .map((entry) =>
      entry === "session"
        ? "Full session"
        : `${entry.track.name} #${entry.track.occurrence + 1}`,
    )
    .join(", ");
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

function agentModelLabel(
  modelId: string | undefined,
  models: readonly DesktopAgentModel[],
): string {
  if (modelId === undefined) return "SDK default";
  const model = models.find(({ id }) => id === modelId);
  if (model === undefined) return `${modelId} · unavailable`;
  return `${model.displayName} · ${model.id}${
    model.policyState === "enabled" ? "" : ` · ${model.policyState}`
  }`;
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

function agentReasoningLabel(
  reasoningEffort: DesktopActiveAgent["reasoningEffort"],
): string {
  return reasoningEffort ?? "Model default";
}

export function ResolvedToolsDisclosure({
  patterns,
  resolvedTools,
}: {
  patterns: readonly string[];
  resolvedTools: readonly string[];
}): React.JSX.Element {
  const resolvedLabel =
    resolvedTools.length > 0 ? resolvedTools.join(", ") : "no available tools";
  if (patterns.some((pattern) => pattern.includes("*"))) {
    return (
      <details className="resolved-tools-disclosure">
        <summary>Resolved tools ({resolvedTools.length})</summary>
        <small>{resolvedLabel}</small>
      </details>
    );
  }
  return <small>Resolves to: {resolvedLabel}</small>;
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

export type EventListenerDraft = Pick<
  AgentEventListener,
  "enabled" | "responseMode"
> & {
  selected: boolean;
  messagePrefix: string;
  preparedContextScope: PreparedContextConfiguration["scope"];
  preparedContextTracks: string;
  includeSessionClips: boolean;
};

function preparedContextTrackValue(
  configuration: PreparedContextConfiguration,
): string {
  if (configuration.scope === "whole-session") return "";
  return configuration.tracks
    .map(
      ({ track }) =>
        `${track.name}${track.occurrence === 0 ? "" : ` #${track.occurrence + 1}`}`,
    )
    .join("\n");
}

function preparedContextFromDraft(
  draft: EventListenerDraft,
): PreparedContextConfiguration {
  if (draft.preparedContextScope === "whole-session") {
    return {
      scope: "whole-session",
      includeSessionClips: draft.includeSessionClips,
    };
  }
  const parsed = parseTrackScope(draft.preparedContextTracks);
  const tracks = parsed.filter((entry) => entry !== "session");
  if (tracks.length === 0) {
    throw new Error(
      "Prepared context requires at least one selected track locator.",
    );
  }
  return {
    scope: "selected-tracks",
    includeSessionClips: draft.includeSessionClips,
    tracks,
  };
}

function listenerForAgent(
  event: DesktopLiveEventState,
  agentInstanceId: string,
): AgentEventListener | undefined {
  return event.listeners.find(
    (entry) => entry.agentInstanceId === agentInstanceId,
  )?.listener;
}

function preparedContextStatusForAgent(
  event: DesktopLiveEventState,
  agentInstanceId: string,
): NonNullable<
  DesktopLiveEventState["listeners"][number]["preparedContextStatus"]
> {
  return (
    event.listeners.find((entry) => entry.agentInstanceId === agentInstanceId)
      ?.preparedContextStatus ?? { state: "unavailable" }
  );
}

function eventListenerDraft(
  event: DesktopLiveEventState,
  agentInstanceId: string,
): EventListenerDraft {
  const listener = listenerForAgent(event, agentInstanceId);
  const preparedContext = resolvePreparedContextConfiguration(
    listener?.preparedContext,
  );
  return {
    selected: listener !== undefined,
    enabled: listener?.enabled ?? true,
    responseMode: listener?.responseMode ?? "next-prompt",
    messagePrefix: listener?.messagePrefix ?? "",
    preparedContextScope: preparedContext.scope,
    preparedContextTracks: preparedContextTrackValue(preparedContext),
    includeSessionClips: preparedContext.includeSessionClips,
  };
}

export async function saveAgentEventListeners(
  api: DesktopApi["events"],
  agentInstanceId: string,
  events: readonly DesktopLiveEventState[],
  drafts: Readonly<Record<string, EventListenerDraft>>,
): Promise<void> {
  for (const event of events) {
    const draft = drafts[event.definition.id];
    if (draft === undefined) continue;
    const listener = listenerForAgent(event, agentInstanceId);
    if (!draft.selected) {
      if (listener !== undefined) {
        await api.unassignListener(agentInstanceId, event.definition.id);
      }
      continue;
    }
    const messagePrefix = draft.messagePrefix.trim();
    const preparedContext = preparedContextFromDraft(draft);
    if (listener === undefined) {
      await api.assignListener(agentInstanceId, event.definition.id, {
        enabled: draft.enabled,
        responseMode: draft.responseMode,
        ...(messagePrefix === "" ? {} : { messagePrefix }),
        preparedContext,
      });
      continue;
    }
    const normalizedCurrentPrefix = listener.messagePrefix ?? "";
    const currentPreparedContext = resolvePreparedContextConfiguration(
      listener.preparedContext,
    );
    const preparedContextChanged =
      JSON.stringify(currentPreparedContext) !==
      JSON.stringify(preparedContext);
    if (
      listener.enabled !== draft.enabled ||
      listener.responseMode !== draft.responseMode ||
      normalizedCurrentPrefix !== messagePrefix ||
      preparedContextChanged
    ) {
      await api.updateListener(agentInstanceId, event.definition.id, {
        enabled: draft.enabled,
        responseMode: draft.responseMode,
        messagePrefix: messagePrefix === "" ? null : messagePrefix,
        ...(preparedContextChanged ? { preparedContext } : {}),
      });
    }
  }
}

export function ListeningEventsEditor({
  agentInstanceId,
  events,
  busy,
  onError,
}: {
  agentInstanceId: string;
  events: readonly DesktopLiveEventState[];
  busy: boolean;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, EventListenerDraft>>(() =>
    Object.fromEntries(
      events.map((event) => [
        event.definition.id,
        eventListenerDraft(event, agentInstanceId),
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const eventIds = events.map(({ definition }) => definition.id).join("\n");

  useEffect(() => {
    setDrafts((current) =>
      Object.fromEntries(
        events.map((event) => [
          event.definition.id,
          current[event.definition.id] ??
            eventListenerDraft(event, agentInstanceId),
        ]),
      ),
    );
  }, [agentInstanceId, eventIds, events]);

  const updateDraft = (
    eventId: string,
    update: Partial<EventListenerDraft>,
  ): void => {
    setDrafts((current) => ({
      ...current,
      [eventId]: {
        ...(current[eventId] ?? {
          selected: false,
          enabled: true,
          responseMode: "next-prompt",
          messagePrefix: "",
          preparedContextScope: "whole-session",
          preparedContextTracks: "",
          includeSessionClips: true,
        }),
        ...update,
      },
    }));
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await saveAgentEventListeners(
        window.desktop.events,
        agentInstanceId,
        events,
        drafts,
      );
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="listening-events-editor">
      <legend>Listening Events</legend>
      {events.length === 0 ? (
        <small>No Live events are available in this production session.</small>
      ) : (
        events.map((event) => {
          const draft =
            drafts[event.definition.id] ??
            eventListenerDraft(event, agentInstanceId);
          const unavailable = !event.definition.enabled;
          const unresolved = event.resolution.status !== "resolved";
          const preparedContextStatus = preparedContextStatusForAgent(
            event,
            agentInstanceId,
          );
          return (
            <div className="listening-event-row" key={event.definition.id}>
              <label>
                <input
                  type="checkbox"
                  checked={draft.selected}
                  onChange={(change) =>
                    updateDraft(event.definition.id, {
                      selected: change.target.checked,
                    })
                  }
                />
                <span>
                  {event.definition.name}
                  <small>
                    {unavailable ? "Event disabled" : "Event enabled"}
                    {" · "}
                    {unresolved ? "Unresolved target" : "Resolved target"}
                  </small>
                </span>
              </label>
              {draft.selected && (
                <div className="listening-event-settings">
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(change) =>
                        updateDraft(event.definition.id, {
                          enabled: change.target.checked,
                        })
                      }
                    />
                    Listener enabled
                  </label>
                  <label>
                    Delivery
                    <select
                      value={draft.responseMode}
                      onChange={(change) =>
                        updateDraft(event.definition.id, {
                          responseMode: change.target.value as
                            "automatic" | "next-prompt",
                        })
                      }
                    >
                      <option value="automatic">Automatic</option>
                      <option value="next-prompt">Next prompt</option>
                    </select>
                  </label>
                  <label>
                    Message prefix <small>Optional.</small>
                    <textarea
                      maxLength={MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH}
                      rows={3}
                      value={draft.messagePrefix}
                      onChange={(change) =>
                        updateDraft(event.definition.id, {
                          messagePrefix: change.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Prepared context
                    <select
                      value={draft.preparedContextScope}
                      onChange={(change) =>
                        updateDraft(event.definition.id, {
                          preparedContextScope: change.target
                            .value as PreparedContextConfiguration["scope"],
                        })
                      }
                    >
                      <option value="whole-session">
                        Whole session (bounded)
                      </option>
                      <option value="selected-tracks">Selected tracks</option>
                    </select>
                  </label>
                  {draft.preparedContextScope === "selected-tracks" && (
                    <label>
                      Tracks{" "}
                      <small>
                        One locator per line: track name, optionally #2 for a
                        duplicate name.
                      </small>
                      <textarea
                        rows={3}
                        required
                        value={draft.preparedContextTracks}
                        onChange={(change) =>
                          updateDraft(event.definition.id, {
                            preparedContextTracks: change.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={draft.includeSessionClips}
                      onChange={(change) =>
                        updateDraft(event.definition.id, {
                          includeSessionClips: change.target.checked,
                        })
                      }
                    />
                    Include Session clips
                  </label>
                  <small>
                    Cache: {preparedContextStatus.state}
                    {preparedContextStatus.state === "unavailable"
                      ? ""
                      : ` · captured ${new Date(
                          preparedContextStatus.capturedAt,
                        ).toLocaleTimeString()}${
                          preparedContextStatus.unresolvedTrackLocators ===
                          undefined
                            ? ""
                            : ` · ${preparedContextStatus.unresolvedTrackLocators} unresolved track locator(s)`
                        }`}
                  </small>
                </div>
              )}
            </div>
          );
        })
      )}
      <button disabled={busy || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save listening events"}
      </button>
    </fieldset>
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
          disabled={busy || modelsStatus === "loading"}
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
            modelsStatus === "loading" ||
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

function ActiveAgentCard({
  agent,
  availableSkills,
  liveEvents,
  models,
  modelsStatus,
  definitionSource,
  definitionUpdated,
  selected,
  busy,
  confirmingReset,
  onRename,
  onConfigure,
  onSetConversationSettings,
  onReset,
  onCancelReset,
  onEventError,
  onSelect,
  onOpen,
  onDeactivate,
}: {
  agent: DesktopActiveAgent;
  availableSkills: DesktopState["agentCatalog"]["skills"];
  liveEvents: readonly DesktopLiveEventState[];
  models: readonly DesktopAgentModel[];
  modelsStatus: "loading" | "loaded" | "failed";
  definitionSource?: string | undefined;
  definitionUpdated: boolean;
  selected: boolean;
  busy: boolean;
  confirmingReset: boolean;
  onRename: (label: string) => Promise<DesktopActiveAgent | undefined>;
  onConfigure: (
    overrides: AgentOverrides,
  ) => Promise<DesktopActiveAgent | undefined>;
  onSetConversationSettings: (
    settings: DesktopAgentConversationSettings,
  ) => Promise<DesktopActiveAgent | undefined>;
  onReset: () => Promise<void>;
  onCancelReset: () => void;
  onEventError: (error: unknown) => void;
  onSelect: () => Promise<void>;
  onOpen: () => Promise<void>;
  onDeactivate: () => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState(agent.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState(
    agent.reasoningEffort ?? "",
  );
  const [confirmingConversationSettings, setConfirmingConversationSettings] =
    useState(false);
  const [label, setLabel] = useState(agent.label);
  const [systemPrompt, setSystemPrompt] = useState(agent.config.systemPrompt);
  const [tools, setTools] = useState(listValue(agent.config.tools));
  const [scopeMode, setScopeMode] = useState<"session" | "tracks">(
    agent.config.editScope.includes("session") ? "session" : "tracks",
  );
  const [trackScope, setTrackScope] = useState(
    agent.config.editScope
      .filter((entry) => entry !== "session")
      .map((entry) => `${entry.track.name} #${entry.track.occurrence + 1}`)
      .join("\n"),
  );
  const [skills, setSkills] = useState<string[]>(() => {
    const validNames = new Set(availableSkills.map(({ name }) => name));
    return agent.config.skills.filter((name) => validNames.has(name));
  });
  const [inputChannels, setInputChannels] = useState(
    listValue(agent.config.inputChannels),
  );
  const availableSkillNames = availableSkills
    .map(({ name }) => name)
    .join("\n");
  const listeningEvents = liveEvents.filter(
    (event) => listenerForAgent(event, agent.id) !== undefined,
  );

  useEffect(() => {
    const validNames = new Set(availableSkills.map(({ name }) => name));
    setSkills(agent.config.skills.filter((name) => validNames.has(name)));
  }, [agent.config.skills, availableSkillNames]);

  useEffect(() => {
    setModel(agent.model ?? "");
    setReasoningEffort(agent.reasoningEffort ?? "");
    setConfirmingConversationSettings(false);
  }, [agent.model, agent.reasoningEffort]);

  const applyConversationSettings = async (): Promise<void> => {
    const updated = await onSetConversationSettings({
      ...(model === "" ? {} : { model }),
      ...(reasoningEffort === ""
        ? {}
        : { reasoningEffort: reasoningEffort as AgentReasoningEffort }),
    });
    if (updated !== undefined) {
      setConfirmingConversationSettings(false);
      setEditing(false);
    }
  };
  const closeEditor = (): void => {
    setModel(agent.model ?? "");
    setReasoningEffort(agent.reasoningEffort ?? "");
    setConfirmingConversationSettings(false);
    setEditing(false);
  };

  const save = async (): Promise<void> => {
    const normalizedLabel = label.trim();
    if (
      normalizedLabel !== agent.label &&
      (await onRename(normalizedLabel)) === undefined
    ) {
      return;
    }
    const configured = await onConfigure({
      systemPrompt,
      tools: parseList(tools),
      editScope:
        scopeMode === "session" ? ["session"] : parseTrackScope(trackScope),
      skills,
      inputChannels: parseList(inputChannels),
    });
    if (configured !== undefined) setEditing(false);
  };

  return (
    <article className={`active-agent-card${selected ? " is-selected" : ""}`}>
      <header>
        <div>
          <div className="agent-title-line">
            <h4>{agent.label}</h4>
            {selected && <span className="agent-badge">Selected</span>}
            {agent.autoApprove && (
              <span className="agent-badge yolo-badge">YOLO</span>
            )}
            {agent.modified && <span className="agent-badge">Modified</span>}
          </div>
          <p>{agent.config.description}</p>
        </div>
        <span className={`agent-lifecycle lifecycle-${agent.lifecycle}`}>
          {agent.lifecycle}
        </span>
      </header>
      <dl className="agent-metadata">
        <dt>Definition</dt>
        <dd>
          {agent.definitionName} ·{" "}
          <code title={agent.definitionFingerprint}>
            {agent.definitionFingerprint.slice(0, 12)}
          </code>
          {definitionSource !== undefined && (
            <small>
              {definitionSource}
              {definitionUpdated
                ? " · newer definition available; reset to adopt it"
                : ""}
            </small>
          )}
        </dd>
        <dt>Model</dt>
        <dd>{agentModelLabel(agent.model, models)}</dd>
        <dt>Reasoning</dt>
        <dd>{agentReasoningLabel(agent.reasoningEffort)}</dd>
        <dt>Tools</dt>
        <dd>
          {agent.config.tools.join(", ")}
          <ResolvedToolsDisclosure
            patterns={agent.config.tools}
            resolvedTools={agent.config.resolvedTools}
          />
        </dd>
        <dt>Scope</dt>
        <dd>{scopeLabel(agent.config.editScope)}</dd>
        <dt>Skills</dt>
        <dd>
          {agent.config.skills.length > 0
            ? agent.config.skills.join(", ")
            : "None"}
        </dd>
        <dt>Inputs</dt>
        <dd>
          {agent.config.inputChannels.length > 0
            ? agent.config.inputChannels.join(", ")
            : "Prompt only"}
        </dd>
        <dt>Listening Events</dt>
        <dd>
          {listeningEvents.length === 0
            ? "None"
            : listeningEvents
                .map((event) => {
                  const listener = listenerForAgent(event, agent.id)!;
                  const status = [
                    listener.enabled ? undefined : "listener disabled",
                    event.definition.enabled ? undefined : "event disabled",
                    event.resolution.status === "resolved"
                      ? undefined
                      : "unresolved",
                  ].filter(Boolean);
                  return `${event.definition.name} · ${
                    listener.responseMode === "automatic"
                      ? "Automatic"
                      : "Next prompt"
                  }${status.length === 0 ? "" : ` (${status.join(", ")})`}`;
                })
                .join("; ")}
        </dd>
      </dl>
      {editing && (
        <div className="agent-editor">
          <AgentModelEditor
            agentLabel={agent.label}
            currentModelId={agent.model}
            currentReasoningEffort={agent.reasoningEffort}
            model={model}
            reasoningEffort={reasoningEffort}
            models={models}
            modelsStatus={modelsStatus}
            busy={busy}
            confirming={confirmingConversationSettings}
            onModelChange={(value) => {
              setModel(value);
              setReasoningEffort(
                reasoningEffortForDraftModel(value, reasoningEffort, models),
              );
              setConfirmingConversationSettings(false);
            }}
            onReasoningEffortChange={(value) => {
              setReasoningEffort(value);
              setConfirmingConversationSettings(false);
            }}
            onRequestConfirmation={() =>
              setConfirmingConversationSettings(true)
            }
            onConfirm={() => void applyConversationSettings()}
            onCancel={() => setConfirmingConversationSettings(false)}
          />
          <label>
            Instance name
            <input
              maxLength={128}
              required
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            Session prompt
            <textarea
              rows={6}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
          </label>
          <label>
            Tool patterns <small>One per line; wildcards are supported.</small>
            <textarea
              rows={4}
              value={tools}
              onChange={(event) => setTools(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Edit scope</legend>
            <label>
              <input
                checked={scopeMode === "session"}
                name={`scope-${agent.id}`}
                type="radio"
                onChange={() => setScopeMode("session")}
              />
              Full session
            </label>
            <label>
              <input
                checked={scopeMode === "tracks"}
                name={`scope-${agent.id}`}
                type="radio"
                onChange={() => setScopeMode("tracks")}
              />
              Specific tracks
            </label>
            {scopeMode === "tracks" && (
              <textarea
                aria-label="Track scope"
                placeholder={"Drums #1\nBass #1"}
                rows={3}
                value={trackScope}
                onChange={(event) => setTrackScope(event.target.value)}
              />
            )}
          </fieldset>
          <fieldset>
            <legend>Skills</legend>
            {availableSkills.length === 0 ? (
              <small>No valid skills are available in the catalog.</small>
            ) : (
              availableSkills.map((skill) => (
                <label key={skill.name}>
                  <input
                    type="checkbox"
                    checked={skills.includes(skill.name)}
                    onChange={(event) =>
                      setSkills((selected) =>
                        event.target.checked
                          ? [...selected, skill.name]
                          : selected.filter((name) => name !== skill.name),
                      )
                    }
                  />
                  <span>
                    /{skill.name}
                    <small>{skill.description}</small>
                  </span>
                </label>
              ))
            )}
          </fieldset>
          <ListeningEventsEditor
            agentInstanceId={agent.id}
            events={liveEvents}
            busy={busy}
            onError={onEventError}
          />
          <label>
            Input channels <small>One per line.</small>
            <textarea
              rows={3}
              value={inputChannels}
              onChange={(event) => setInputChannels(event.target.value)}
            />
          </label>
          <div className="agent-actions">
            <button
              disabled={
                busy ||
                label.trim() === "" ||
                systemPrompt.trim() === "" ||
                parseList(tools).length === 0
              }
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save overrides"}
            </button>
            <button disabled={busy} onClick={closeEditor}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="agent-actions">
        {!selected && (
          <button disabled={busy} onClick={() => void onSelect()}>
            Select
          </button>
        )}
        <button disabled={busy} onClick={() => void onOpen()}>
          Open
        </button>
        <button
          disabled={busy}
          onClick={() => (editing ? closeEditor() : setEditing(true))}
        >
          {editing ? "Close editor" : "Edit overrides"}
        </button>
        {confirmingReset ? (
          <>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void onReset()}
            >
              Confirm reset
            </button>
            <button disabled={busy} onClick={onCancelReset}>
              Keep overrides
            </button>
          </>
        ) : (
          <button disabled={busy} onClick={() => void onReset()}>
            Reset to current definition
          </button>
        )}
        <button
          className="danger-button"
          disabled={busy}
          onClick={() => void onDeactivate()}
        >
          Deactivate
        </button>
      </div>
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
      event: { type: "project.snapshot_changed", snapshot },
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
      ? "Refreshing project snapshot."
      : state.projectRefresh.status === "succeeded"
        ? "Project snapshot updated."
        : state.projectRefresh.status === "failed"
          ? state.projectRefresh.message
          : undefined;

  return (
    <aside
      id="project-sidebar"
      className="project-outline"
      aria-label="Project outline"
    >
      <div className="panel-heading">
        <h2>Project</h2>
        <div className="project-refresh">
          <button
            aria-label={`${refreshLabel} project snapshot`}
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
          {refreshStatus !== undefined && (
            <span
              id="project-refresh-status"
              className={
                state.projectRefresh.status === "failed"
                  ? "status status-error"
                  : "status"
              }
              role={
                state.projectRefresh.status === "failed" ? "alert" : "status"
              }
            >
              {refreshStatus}
            </span>
          )}
        </div>
      </div>
      <div className="project-context-toggle">
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
        <small>
          {state.projectSelectionContextEnabled
            ? "Selected tracks, clips, and devices are included in prompts."
            : "Selections only control the Project and Inspector views."}
        </small>
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
                className={state.selectedTrackId === track.id ? "active" : ""}
                onClick={() => dispatch({ type: "select-track", id: track.id })}
              >
                <span
                  className="track-color"
                  style={{ background: track.color }}
                />{" "}
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
  const scrollKey = selectedAgentInstance(state)?.id ?? "no-agent";
  useLayoutEffect(() => {
    if (timelineRef.current !== null) {
      timelineRef.current.scrollTop = scrollPositions?.get(scrollKey) ?? 0;
    }
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
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-200),
    [workspace.messages, workspace.operations, workspace.triggers],
  );
  return (
    <div
      ref={timelineRef}
      className="timeline"
      aria-live="polite"
      aria-label="Recent activity"
      onScroll={(event) =>
        scrollPositions?.set(scrollKey, event.currentTarget.scrollTop)
      }
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
            data-agent-mode={item.agentMode}
          >
            <span className="sr-only">
              {item.role === "user" ? "You" : "Assistant"}:
            </span>
            {item.streaming && (
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
          <OperationCard key={`operation-${item.id}`} operation={item} />
        ) : (
          <TriggerCard key={`trigger-${item.deliveryId}`} trigger={item} />
        ),
      )}
    </div>
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

export function OperationCard({
  operation,
}: {
  operation: DesktopState["operations"][number];
}): React.JSX.Element {
  const presentation = operationPresentation(
    operation.toolName,
    operation.label,
  );
  return (
    <details className={`operation operation-${operation.status}`}>
      <summary
        className={operation.toolName === undefined ? "" : "has-tool-name"}
      >
        <ActivityIcon type={presentation.type} />
        <span className="operation-label">{operation.label}</span>
        {operation.toolName !== undefined && (
          <code className="operation-tool-name">{operation.toolName}</code>
        )}
        <small>{operation.status}</small>
      </summary>
      <div className="operation-details">
        {operation.detail && <p>{operation.detail}</p>}
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
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
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
  return (
    <aside
      id="inspector-sidebar"
      className="inspector"
      aria-label="Selection inspector"
    >
      <div className="panel-heading">
        <h2>Inspector</h2>
        <span>
          {device ? "Device" : clip ? "Clip" : track ? "Track" : "Selection"}
        </span>
      </div>
      {!track ? (
        <EmptyState
          title="Nothing selected"
          detail="Choose a track, clip, device, or plan section."
        />
      ) : device ? (
        <DeviceInspector device={device} track={track} dispatch={dispatch} />
      ) : clip ? (
        <ClipInspector clip={clip} track={track} dispatch={dispatch} />
      ) : (
        <TrackInspector track={track} dispatch={dispatch} />
      )}
      <PlanApprovalPanel state={state} dispatch={dispatch} />
      <ApprovalPanel state={state} dispatch={dispatch} />
    </aside>
  );
}

export function PlanApprovalPanel({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element | null {
  const agent = selectedAgentInstance(state);
  const request = selectedAgentWorkspace(state).planApproval;
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setFeedback("");
    setError("");
    setSubmitting(false);
  }, [request?.requestId]);

  if (agent === undefined || request === undefined) return null;

  const resolve = async (response: {
    approved: boolean;
    selectedAction?: "exit_only" | "interactive";
    feedback?: string;
  }): Promise<void> => {
    setSubmitting(true);
    setError("");
    try {
      const resolved = await window.desktop.agents.resolvePlan(agent.id, {
        requestId: request.requestId,
        ...response,
      });
      if (!resolved) {
        dispatch({
          type: "event",
          event: {
            type: "agent.plan_approval_completed",
            requestId: request.requestId,
            approved: false,
            agentInstanceId: agent.id,
            ...(agent.sdkSessionId === undefined
              ? {}
              : { sdkSessionId: agent.sdkSessionId }),
          },
        });
        throw new Error("This plan request is no longer pending.");
      }
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "The plan response could not be submitted.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="plan-approval-panel" aria-label="Plan approval">
      <div className="plan-approval-heading">
        <h3>Plan ready</h3>
        <span className="agent-mode-badge plan">plan</span>
      </div>
      {request.summary && <p>{request.summary}</p>}
      <div className="plan-approval-content">
        <AssistantMarkdown content={request.planContent} />
      </div>
      <label>
        Request changes
        <textarea
          rows={3}
          maxLength={8_192}
          value={feedback}
          disabled={submitting}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="Describe what the plan should change…"
        />
      </label>
      {error && <p className="composer-error">{error}</p>}
      <div className="approval-actions">
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
      </div>
    </section>
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
    <div className="inspection">
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
    <div className="inspection">
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
    <div className="inspection">
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
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
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
      className="approval-panel"
      aria-label="Approval and change preview"
    >
      <h3>Approval</h3>
      {!approval ? (
        <p className="muted">No change is waiting for approval.</p>
      ) : (
        <>
          <strong>{approval.title}</strong>
          <span className={`risk risk-${approval.risk}`}>
            {approval.risk} risk
          </span>
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
            <button className="primary" onClick={() => void decide("approve")}>
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
        <div className="diagnostics-log">
          <strong>Active logging level: {report.logging.level}</strong>
          {report.logging.environmentOverride && (
            <span>Controlled by ABLETON_AGENT_LOG_LEVEL</span>
          )}
          <span>{report.logging.fileName}</span>
          <code title={report.logging.filePath}>{report.logging.filePath}</code>
        </div>
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
                  {session.projectName} ·{" "}
                  {new Date(session.updatedAt).toLocaleString()}
                </p>
                {session.id === currentSession?.id && <strong>Current</strong>}
                {session.projectId === undefined && (
                  <span className="muted"> Ephemeral</span>
                )}
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
  const autoApprovalOverrideCount =
    activeSession(state)?.activeAgents.filter(({ autoApprove }) => autoApprove)
      .length ?? 0;
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const preferences = await window.desktop.preferences.set(draft);
    dispatch({
      type: "event",
      event: { type: "preferences.changed", preferences },
    });
  };
  return (
    <section className="page-panel">
      <div className="panel-heading">
        <h1>Settings</h1>
        <span>Non-secret preferences</span>
      </div>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
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
        <button className="primary" type="submit">
          Save settings
        </button>
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
}: {
  state: DesktopState;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  value: string;
  error: string;
  onValueChange: (value: string) => void;
  onErrorChange: (error: string) => void;
}): React.JSX.Element {
  const selectedInstanceId = selectedAgentInstance(state)?.id;

  useEffect(() => {
    onErrorChange("");
  }, [onErrorChange, selectedInstanceId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const message = value.trim();
    if (!message) return;
    onErrorChange("");
    onValueChange("");
    try {
      await sendComposerMessage(window.desktop, state, message, dispatch);
    } catch (submitError) {
      const messageText =
        submitError instanceof Error
          ? submitError.message
          : "Agent message failed";
      if (message.startsWith("/")) onValueChange(message);
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
      composerRef.current?.focus();
    }
  };

  return (
    <Composer
      state={state}
      value={value}
      busy={false}
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

export function Composer({
  state,
  value,
  busy,
  error,
  composerRef,
  onChange,
  onSubmit,
  dispatch,
}: {
  state: DesktopState;
  value: string;
  busy: boolean;
  error?: string | undefined;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const context = contextForSelection(state);
  const activeAgent = selectedAgentInstance(state);
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
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashSuggestions.length > 0) {
      const completion = slashCompletionKey(
        event.key,
        selectedSuggestion,
        slashSuggestions.length,
      );
      if (typeof completion === "number") {
        event.preventDefault();
        setSelectedSuggestion(completion);
        return;
      }
      if (completion === "complete" && !event.shiftKey) {
        event.preventDefault();
        completeSuggestion(
          slashSuggestions[selectedSuggestion] ?? slashSuggestions[0]!,
        );
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <footer className="composer">
      <div className="context-chips" aria-label="Prompt context">
        <span>Context</span>
        {context.length === 0 ? (
          <em>None — agent will inspect as needed</em>
        ) : (
          context.map((chip) => (
            <button
              type="button"
              key={chip.id}
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
          <div className="composer-mode" aria-live="polite">
            <span className={`agent-mode-badge ${activeAgent.mode}`}>
              {activeAgent.mode}
            </span>
            <small>Shift+Tab toggles mode</small>
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
              : state.connection.state === "connected"
                ? `Ask ${activeAgent.label}…`
                : "Ask using the demo adapter, or connect to Ableton…"
          }
          rows={2}
        />
        {activeBusy ? (
          <button
            type="button"
            onClick={() => void cancelWorkspaceAgent(window.desktop, state)}
          >
            Cancel
          </button>
        ) : (
          <button
            className="primary"
            type="submit"
            disabled={unavailable || !value.trim()}
          >
            Send <kbd>↵</kbd>
          </button>
        )}
      </form>
    </footer>
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
