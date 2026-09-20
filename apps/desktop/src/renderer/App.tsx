import {
  InvalidSkillInvocationError,
  parseSkillInvocation,
  type SkillInvocation,
} from "@ableton-agent/agent-config/skill-invocation";
import { createAgentEventListenerId } from "@ableton-agent/agent-config/live-event-id";
import {
  MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH,
  resolvePreparedContextConfiguration,
  type AgentEventListener,
  type CurrentAgentDefinition,
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
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  DesktopApi,
  DesktopActiveAgent,
  DesktopAgentDefinition,
  DesktopAgentModel,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopOutputAssignment,
  DesktopOutputConnection,
  DesktopProjectSnapshot,
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
  LiveEventSelection,
  PlanSection,
} from "../contracts";
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
import { ProfileManagerView } from "./ProfileManagerView";

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
    <div className={`app-shell ${topChromeVisible ? "" : "top-chrome-hidden"}`}>
      {topChromeVisible && (
        <ConnectionHeader
          state={state}
          dispatch={dispatch}
          profileRefreshToken={profileRefreshToken}
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
              "skills",
              "outputs",
              "events",
              "browser",
              "profiles",
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
            onProfilesChanged={() =>
              setProfileRefreshToken((current) => current + 1)
            }
          />
        ) : state.activeView === "skills" ? (
          <SkillsView
            state={state}
            dispatch={dispatch}
            onProfilesChanged={() =>
              setProfileRefreshToken((current) => current + 1)
            }
          />
        ) : state.activeView === "outputs" ? (
          <OutputsView state={state} dispatch={dispatch} />
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
        <span className="header-divider" aria-hidden="true">
          |
        </span>
        <label className="header-selector">
          <span>Profile:</span>
          <select
            className="profile-selector"
            aria-label="Active Profile"
            value={profileStatus?.activeProfile ?? ""}
            disabled={
              profileBusy ||
              profileStatus === undefined ||
              profileStatus.switchingDisabledReason !== undefined
            }
            title={
              profileStatus?.switchingDisabledReason ??
              (profileError || undefined)
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
        </label>
        <span className="header-divider" aria-hidden="true">
          |
        </span>
        <label className="header-selector">
          <span>Agent:</span>
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
        <span className="header-divider" aria-hidden="true">
          |
        </span>
        {activeAgent?.autoApprove && (
          <span className="agent-badge yolo-badge">YOLO</span>
        )}
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
      {leftSidebarVisible && onSidebarWidthChange !== undefined && (
        <div
          className="sidebar-resize-handle sidebar-resize-handle-left"
          aria-hidden="true"
          onPointerDown={(event) => resize(event, "left")}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      )}
      <section
        className="conversation"
        aria-label="Conversation and operation timeline"
      >
        <Timeline state={state} scrollPositions={timelineScrollPositions} />
        {composer}
      </section>
      {rightSidebarVisible && onSidebarWidthChange !== undefined && (
        <div
          className="sidebar-resize-handle sidebar-resize-handle-right"
          aria-hidden="true"
          onPointerDown={(event) => resize(event, "right")}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      )}
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

function ChromeIcon({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2.5" y="2.5" width="13" height="13" rx="2" />
      <path d="M3 6h12" />
      <path d={expanded ? "M7 10l2 2 2-2" : "M7 12l2-2 2 2"} />
    </svg>
  );
}

type AgentDetailSection = "general" | "capabilities" | "connections";

function agentDetailSectionLabel(section: AgentDetailSection): string {
  if (section === "general") return "General";
  if (section === "capabilities") return "Capabilities";
  return "Connections";
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
      ) : section === "capabilities" ? (
        <>
          <path d="M9 2.5v3M9 12.5v3M2.5 9h3M12.5 9h3" />
          <circle cx="9" cy="9" r="3.5" />
        </>
      ) : (
        <>
          <circle cx="9" cy="9" r="2" />
          <path d="M5.5 5.5a5 5 0 0 0 0 7M12.5 5.5a5 5 0 0 1 0 7" />
          <path d="M3 3a8.5 8.5 0 0 0 0 12M15 3a8.5 8.5 0 0 1 0 12" />
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
    "connections",
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
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onProfilesChanged?: (() => void) | undefined;
}): React.JSX.Element {
  const session = activeSession(state);
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
      <div className="panel-heading">
        <div>
          <h2 id="skills-heading">Skills</h2>
          <p>
            Scoped Markdown instructions available to agents and Workspace slash
            commands.
          </p>
        </div>
        <div className="agent-header-actions">
          <button type="button" onClick={createDraft}>
            New skill
          </button>
          <button disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "Refreshing…" : "Refresh skills"}
          </button>
        </div>
      </div>
      {session === undefined && (
        <div className="notice" role="status">
          Skill saves will be available after the production session is
          restored.
        </div>
      )}
      {catalogSkills.length === 0 && !selectedKey?.startsWith("new:") ? (
        <EmptyState
          title="No valid skills found"
          detail="Create a Session-defined Skill to add reusable instructions."
        />
      ) : (
        <div className="agents-workspace">
          <nav className="agent-navigation" aria-label="Skills">
            <div className="agent-navigation-list">
              {catalogSkills.map((skill) => (
                <button
                  type="button"
                  className={`agent-navigation-item ${selectedKey === skill.name ? "active" : ""}`}
                  aria-current={selectedKey === skill.name ? "page" : undefined}
                  onClick={() => setSelectedKey(skill.name)}
                  key={skill.name}
                >
                  <span
                    className={`skill-scope-light is-${skill.origin ?? "bundled"}`}
                    aria-hidden="true"
                  />
                  <span className="agent-navigation-label">
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </span>
                </button>
              ))}
              {Object.values(drafts)
                .filter(({ published }) => !published)
                .map((draft) => (
                  <button
                    type="button"
                    className={`agent-navigation-item ${selectedKey === draft.key ? "active" : ""}`}
                    aria-current={
                      selectedKey === draft.key ? "page" : undefined
                    }
                    onClick={() => setSelectedKey(draft.key)}
                    key={draft.key}
                  >
                    <span
                      className="skill-scope-light is-new"
                      aria-hidden="true"
                    />
                    <span className="agent-navigation-label">
                      <strong>{draft.name || "Untitled skill"}</strong>
                      <small>New Session skill</small>
                    </span>
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
                      <h3>{selectedDraft.name || "New skill"}</h3>
                      <span className="scope-badge">
                        {selectedDraft.published
                          ? selectedDraft.origin
                          : "new session"}
                      </span>
                      {selectedDraft.dirty && (
                        <span className="scope-badge">Unsaved</span>
                      )}
                    </div>
                    <p>{selectedDraft.description || "Add skill metadata."}</p>
                  </div>
                  <div className="agent-header-actions">
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
                    i
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
                    &lt;/&gt;
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
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  onProfilesChanged?: (() => void) | undefined;
}): React.JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const session = activeSession(state);
  const activeAgents = session?.activeAgents ?? [];
  const selectedAgentId = session?.selectedAgentInstanceId;
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [savingDefinitionName, setSavingDefinitionName] = useState<string>();
  const [creatingDefinition, setCreatingDefinition] = useState<string>();
  const [confirmResetId, setConfirmResetId] = useState<string>();
  const [modelsState, setModelsState] = useState<
    | { status: "loading"; models: DesktopAgentModel[] }
    | { status: "loaded"; models: DesktopAgentModel[] }
    | { status: "failed"; models: DesktopAgentModel[]; message: string }
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
    ]);
    if (inspectedKey !== undefined && keys.has(inspectedKey)) return;
    setInspectedKey(defaultInspectedKey);
  }, [activeAgents, defaultInspectedKey, inactiveDefinitions, inspectedKey]);

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
      {state.lifecycle === "starting" && session === undefined ? (
        <p role="status">Loading active agents…</p>
      ) : state.agentCatalog.definitions.length === 0 &&
        activeAgents.length === 0 ? (
        <EmptyState
          title="No valid agents found"
          detail="Add YAML definitions to the configured agents directory."
        />
      ) : (
        <div className="agents-workspace">
          <nav className="agent-navigation" aria-label="Agents">
            <div className="agent-navigation-list">
              {activeAgents.map((agent) => {
                const key = `active:${agent.id}`;
                return (
                  <button
                    type="button"
                    className={`agent-navigation-item ${inspectedKey === key ? "active" : ""}`}
                    aria-current={inspectedKey === key ? "page" : undefined}
                    onClick={() => setInspectedKey(key)}
                    key={key}
                  >
                    <span
                      className="agent-activity-light is-active"
                      aria-label="Active agent"
                    />
                    <span className="agent-navigation-label">
                      <strong>{agent.label}</strong>
                      <small>{agent.definitionName}</small>
                    </span>
                  </button>
                );
              })}
              {activeAgents.length > 0 && inactiveDefinitions.length > 0 && (
                <div className="agent-navigation-divider" aria-hidden="true" />
              )}
              {inactiveDefinitions.map((definition) => {
                const key = `definition:${definition.name}`;
                return (
                  <button
                    type="button"
                    className={`agent-navigation-item ${inspectedKey === key ? "active" : ""}`}
                    aria-current={inspectedKey === key ? "page" : undefined}
                    onClick={() => setInspectedKey(key)}
                    key={key}
                  >
                    <span
                      className="agent-activity-light"
                      aria-label="Inactive agent"
                    />
                    <span className="agent-navigation-label">
                      <strong>{definition.label}</strong>
                      <small>{definition.description}</small>
                    </span>
                  </button>
                );
              })}
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
                eventListeners:
                  resolvedDefinition.eventListeners ?? agent.eventListeners,
              };
              return (
                <ActiveAgentCard
                  definition={definition}
                  agent={agent}
                  availableSkills={state.agentCatalog.skills}
                  liveEvents={state.events.events}
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
                liveEvents={state.events.events}
                models={modelsState.models}
                modelsStatus={modelsState.status}
                definitionUpdated={false}
                onSaveDefinition={(draft) => saveDefinition(definition, draft)}
                onCreateAnother={() => createAgent(definition.name)}
                key={definition.name}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function desktopDefinitionFromActiveAgent(
  agent: DesktopActiveAgent,
): DesktopAgentDefinition {
  return {
    version: 2,
    name: agent.definitionName,
    label: agent.label,
    description: agent.config.description,
    systemPrompt: agent.config.systemPrompt,
    tools: agent.config.tools,
    resolvedTools: agent.config.resolvedTools,
    editScope: agent.config.editScope,
    skills: agent.config.skills,
    inputChannels: agent.config.inputChannels,
    model: agent.model ?? null,
    reasoningEffort: agent.reasoningEffort ?? null,
    autoApprove: agent.autoApprove,
    eventListeners: agent.eventListeners,
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
    inputChannels: [...definition.inputChannels],
    model: definition.model ?? null,
    reasoningEffort: definition.reasoningEffort ?? null,
    autoApprove: definition.autoApprove ?? false,
    eventListeners: [...(definition.eventListeners ?? [])],
  };
}

function DefinitionListeningEventsEditor({
  events,
  listeners,
  disabled,
  onChange,
}: {
  events: readonly DesktopLiveEventState[];
  listeners: readonly AgentEventListener[];
  disabled: boolean;
  onChange: (listeners: AgentEventListener[]) => void;
}): React.JSX.Element {
  const update = (
    eventId: string,
    change: (listener: AgentEventListener) => AgentEventListener,
  ): void => {
    onChange(
      listeners.map((listener) =>
        listener.eventId === eventId ? change(listener) : listener,
      ),
    );
  };
  return (
    <fieldset className="listening-events-editor">
      <legend>Listening Events</legend>
      {events.length === 0 ? (
        <small>No Live events are available in this production session.</small>
      ) : (
        events.map((event) => {
          const listener = listeners.find(
            (candidate) => candidate.eventId === event.definition.id,
          );
          const preparedContext = resolvePreparedContextConfiguration(
            listener?.preparedContext,
          );
          return (
            <div className="listening-event-row" key={event.definition.id}>
              <label>
                <input
                  type="checkbox"
                  checked={listener !== undefined}
                  disabled={disabled}
                  onChange={(change) => {
                    if (!change.target.checked) {
                      onChange(
                        listeners.filter(
                          (candidate) =>
                            candidate.eventId !== event.definition.id,
                        ),
                      );
                      return;
                    }
                    onChange([
                      ...listeners,
                      {
                        id: createAgentEventListenerId(crypto.randomUUID()),
                        eventId: event.definition.id,
                        enabled: true,
                        responseMode: "next-prompt",
                        preparedContext: {
                          scope: "whole-session",
                          includeSessionClips: true,
                        },
                      },
                    ]);
                  }}
                />
                <span>
                  {event.definition.name}
                  <small>
                    {event.definition.enabled
                      ? "Event enabled"
                      : "Event disabled"}
                    {" · "}
                    {event.resolution.status === "resolved"
                      ? "Resolved target"
                      : "Unresolved target"}
                  </small>
                </span>
              </label>
              {listener !== undefined && (
                <div className="listening-event-settings">
                  <label>
                    <input
                      type="checkbox"
                      checked={listener.enabled}
                      disabled={disabled}
                      onChange={(change) =>
                        update(event.definition.id, (current) => ({
                          ...current,
                          enabled: change.target.checked,
                        }))
                      }
                    />
                    Listener enabled
                  </label>
                  <label>
                    Delivery
                    <select
                      value={listener.responseMode}
                      disabled={disabled}
                      onChange={(change) =>
                        update(event.definition.id, (current) => ({
                          ...current,
                          responseMode: change.target.value as
                            "automatic" | "next-prompt",
                        }))
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
                      disabled={disabled}
                      value={listener.messagePrefix ?? ""}
                      onChange={(change) =>
                        update(event.definition.id, (current) => {
                          const updated = { ...current };
                          if (change.target.value.trim() === "") {
                            delete updated.messagePrefix;
                          } else {
                            updated.messagePrefix = change.target.value;
                          }
                          return updated;
                        })
                      }
                    />
                  </label>
                  <label>
                    Prepared context
                    <select
                      value={preparedContext.scope}
                      disabled={disabled}
                      onChange={(change) =>
                        update(event.definition.id, (current) => ({
                          ...current,
                          preparedContext:
                            change.target.value === "selected-tracks"
                              ? {
                                  scope: "selected-tracks",
                                  tracks: [
                                    {
                                      track: {
                                        name: "Selected track",
                                        occurrence: 0,
                                      },
                                    },
                                  ],
                                  includeSessionClips:
                                    preparedContext.includeSessionClips,
                                }
                              : {
                                  scope: "whole-session",
                                  includeSessionClips:
                                    preparedContext.includeSessionClips,
                                },
                        }))
                      }
                    >
                      <option value="whole-session">
                        Whole session (bounded)
                      </option>
                      <option value="selected-tracks">Selected tracks</option>
                    </select>
                  </label>
                  {preparedContext.scope === "selected-tracks" && (
                    <label>
                      Tracks{" "}
                      <small>
                        One locator per line: track name, optionally #2 for a
                        duplicate name.
                      </small>
                      <textarea
                        rows={3}
                        required
                        disabled={disabled}
                        value={preparedContextTrackValue(preparedContext)}
                        onChange={(change) => {
                          const parsed = parseTrackScope(change.target.value);
                          const tracks = parsed.filter(
                            (entry) => entry !== "session",
                          );
                          update(event.definition.id, (current) => ({
                            ...current,
                            preparedContext: {
                              scope: "selected-tracks",
                              tracks,
                              includeSessionClips:
                                preparedContext.includeSessionClips,
                            },
                          }));
                        }}
                      />
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={preparedContext.includeSessionClips}
                      disabled={disabled}
                      onChange={(change) =>
                        update(event.definition.id, (current) => ({
                          ...current,
                          preparedContext:
                            preparedContext.scope === "selected-tracks"
                              ? {
                                  ...preparedContext,
                                  includeSessionClips: change.target.checked,
                                }
                              : {
                                  scope: "whole-session",
                                  includeSessionClips: change.target.checked,
                                },
                        }))
                      }
                    />
                    Include Session clips
                  </label>
                </div>
              )}
            </div>
          );
        })
      )}
    </fieldset>
  );
}

function ActiveAgentCard({
  definition,
  agent,
  availableSkills,
  liveEvents,
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
  agent?: DesktopActiveAgent | undefined;
  availableSkills: DesktopState["agentCatalog"]["skills"];
  liveEvents: readonly DesktopLiveEventState[];
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
  const trackScope = draft.editScope
    .filter((entry) => entry !== "session")
    .map((entry) => `${entry.track.name} #${entry.track.occurrence + 1}`)
    .join("\n");
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
            <h3>{title}</h3>
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
              ? "Creating…"
              : agent === undefined
                ? "Create agent"
                : "Create another"}
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
            <fieldset>
              <legend>Conversation defaults</legend>
              <label>
                Model
                <select
                  aria-label={`Model for ${title}`}
                  disabled={busy || modelsStatus === "loading"}
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
              </label>
              <label>
                Reasoning
                <select
                  aria-label={`Reasoning for ${title}`}
                  disabled={
                    busy ||
                    modelsStatus === "loading" ||
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
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.autoApprove}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      autoApprove: event.target.checked,
                    }))
                  }
                />
                Automatically approve eligible tool requests
              </label>
              <small>
                Changes become the Session definition default. Active
                conversations adopt them only after Reset.
              </small>
            </fieldset>
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
              <ResolvedToolsDisclosure
                patterns={draft.tools}
                resolvedTools={definition.resolvedTools}
              />
            </label>
            <fieldset>
              <legend>Edit scope</legend>
              <label>
                <input
                  checked={scopeMode === "session"}
                  name={`scope-${panelPrefix}`}
                  type="radio"
                  onChange={() =>
                    setDraft((current) => ({
                      ...current,
                      editScope: ["session"],
                    }))
                  }
                />
                Full session
              </label>
              <label>
                <input
                  checked={scopeMode === "tracks"}
                  name={`scope-${panelPrefix}`}
                  type="radio"
                  onChange={() =>
                    setDraft((current) => ({
                      ...current,
                      editScope: [
                        { track: { name: "Selected track", occurrence: 0 } },
                      ],
                    }))
                  }
                />
                Specific tracks
              </label>
              {scopeMode === "tracks" && (
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
                    <span>
                      /{skill.name}
                      <small>{skill.description}</small>
                    </span>
                  </label>
                ))
              )}
            </fieldset>
          </div>
        )}
        {section === "connections" && (
          <div className="agent-editor-section agent-connections-editor">
            <label>
              Input channels <small>One per line.</small>
              <textarea
                aria-label={`Input channels for ${title}`}
                rows={4}
                value={listValue(draft.inputChannels)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    inputChannels: parseList(event.target.value),
                  }))
                }
              />
            </label>
            <DefinitionListeningEventsEditor
              events={liveEvents}
              listeners={draft.eventListeners}
              disabled={busy}
              onChange={(eventListeners) =>
                setDraft((current) => ({ ...current, eventListeners }))
              }
            />
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
          <OperationCard key={`operation-${item.id}`} operation={item} />
        ) : (
          <TriggerCard key={`trigger-${item.deliveryId}`} trigger={item} />
        ),
      )}
    </div>
  );
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
  const available = useMemo<InspectorModuleId[]>(() => {
    const modules: InspectorModuleId[] = [];
    if (track !== undefined) modules.push("selection");
    if (workspace.planArtifact?.exists === true) modules.push("plan");
    if (workspace.approval !== undefined) modules.push("approval");
    return modules;
  }, [track, workspace.approval, workspace.planArtifact]);
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
      moduleId === "approval"
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
                    <div className="inspector-tab-item" key={moduleId}>
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
                      </button>
                      <button
                        type="button"
                        className="inspector-tab-close"
                        aria-label={`Close ${inspectorModuleLabel(moduleId)}`}
                        title={`Close ${inspectorModuleLabel(moduleId)}`}
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
  return "Approval";
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
        <div className="composer-actions">
          {activeAgent !== undefined ? (
            <button
              type="button"
              className={`composer-mode-button ${agentMode}`}
              aria-label={`Switch to ${agentMode === "plan" ? "interactive" : "plan"} mode`}
              title="Click or press Shift+Tab to switch mode"
              disabled={unavailable || activeBusy}
              onClick={() =>
                void setSelectedAgentMode(
                  window.desktop,
                  state,
                  agentMode === "plan" ? "interactive" : "plan",
                  dispatch,
                ).catch((modeError: unknown) =>
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
                )
              }
            >
              {agentMode}
            </button>
          ) : (
            <span />
          )}
          {activeBusy ? (
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
