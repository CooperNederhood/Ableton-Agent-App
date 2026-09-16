import type {
  ApprovalRequest,
  ContextChip,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopDiagnosticsReport,
  DesktopEventsState,
  DesktopAgentCatalog,
  DesktopAgentMode,
  DesktopAgentPlanApproval,
  DesktopActiveAgent,
  DesktopAgentHistoryMessage,
  DesktopPreferences,
  DesktopOutputsState,
  DesktopProjectSnapshot,
  DesktopSession,
  ConfigurationSnapshotPage,
  JournalHealth,
  LiveEventTrigger,
  PendingProjectTransition,
  OperationView,
  PlanSection,
  RootTracePage,
  TelemetryEventPage,
} from "../contracts";
import { preferencesSchema } from "../contracts";

export type WorkspaceView =
  | "workspace"
  | "agents"
  | "outputs"
  | "events"
  | "browser"
  | "diagnostics"
  | "sessions"
  | "settings";
export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  timestamp: number;
  agentMode?: DesktopAgentMode;
}

export interface AgentWorkspaceState {
  messages: MessageView[];
  operations: OperationView[];
  triggers: LiveEventTrigger[];
  approval?: ApprovalRequest | undefined;
  planApproval?: DesktopAgentPlanApproval | undefined;
}

export type ProjectRefreshState =
  | { status: "idle" }
  | { status: "refreshing" }
  | { status: "succeeded" }
  | { status: "failed"; message: string };

export type EventsLoadState =
  | { status: "loading" }
  | { status: "loaded" }
  | { status: "failed"; message: string };

export interface DesktopState {
  lifecycle:
    "stopped" | "starting" | "ready" | "degraded" | "stopping" | "crashed";
  connection: DesktopConnectionStatus;
  activeView: WorkspaceView;
  messages: MessageView[];
  operations: OperationView[];
  agentWorkspaces: Record<string, AgentWorkspaceState>;
  context: ContextChip[];
  dismissedContextIds: string[];
  projectSelectionContextEnabled: boolean;
  approval?: ApprovalRequest | undefined;
  snapshot?: DesktopProjectSnapshot | undefined;
  selectedTrackId?: string | undefined;
  selectedClipId?: string | undefined;
  selectedDeviceId?: string | undefined;
  sessions: DesktopSession[];
  activeSessionId?: string | undefined;
  pendingProjectTransition?: PendingProjectTransition | undefined;
  agentCatalog: DesktopAgentCatalog;
  preferences: DesktopPreferences;
  diagnostics: Array<{ level: "info" | "warning" | "error"; message: string }>;
  diagnosticsReport?: DesktopDiagnosticsReport | undefined;
  plan: PlanSection[];
  browserQuery: string;
  outputs: DesktopOutputsState;
  events: DesktopEventsState;
  eventsLoad: EventsLoadState;
  eventHistory: {
    status: "idle" | "loading" | "loaded" | "failed";
    items: RootTracePage["items"];
    nextCursor?: string | undefined;
    message?: string | undefined;
    selectedTraceId?: string | undefined;
    trace: TelemetryEventPage["items"];
    traceNextCursor?: string | undefined;
    traceTotalEvents?: number | undefined;
    configurations: ConfigurationSnapshotPage["items"];
    health?: JournalHealth | undefined;
  };
  collapsedOutputProducerIds: string[];
  expandedEventActivityIds: string[];
  projectRefresh: ProjectRefreshState;
}

export const initialState: DesktopState = {
  lifecycle: "starting",
  connection: { state: "disconnected" },
  activeView: "workspace",
  messages: [],
  operations: [],
  agentWorkspaces: {},
  context: [],
  dismissedContextIds: [],
  projectSelectionContextEnabled: false,
  sessions: [],
  agentCatalog: { definitions: [], skills: [], diagnostics: [] },
  preferences: preferencesSchema.parse({}),
  diagnostics: [],
  plan: [
    {
      id: "intro",
      name: "Intro",
      startBar: 1,
      endBar: 8,
      tracks: ["Drums", "Atmosphere"],
      status: "proposed",
    },
    {
      id: "verse",
      name: "Verse",
      startBar: 9,
      endBar: 24,
      tracks: ["Drums", "Bass"],
      status: "proposed",
    },
    {
      id: "lift",
      name: "Lift",
      startBar: 25,
      endBar: 32,
      tracks: ["Drums", "Bass", "Atmosphere"],
      status: "partial",
    },
  ],
  browserQuery: "",
  outputs: {
    status: {
      state: "disabled",
      detail: "Signal ingress status has not loaded yet.",
    },
    connections: [],
    assignments: [],
    latest: [],
  },
  events: { events: [] },
  eventsLoad: { status: "loading" },
  eventHistory: {
    status: "idle",
    items: [],
    trace: [],
    configurations: [],
  },
  collapsedOutputProducerIds: [],
  expandedEventActivityIds: [],
  projectRefresh: { status: "idle" },
};

export type DesktopAction =
  | { type: "event"; event: DesktopAppEvent }
  | { type: "view"; view: WorkspaceView }
  | {
      type: "user-message";
      id: string;
      content: string;
      agentInstanceId?: string;
      agentMode?: DesktopAgentMode;
    }
  | { type: "toggle-context"; chip: ContextChip }
  | { type: "remove-context"; chip: ContextChip }
  | { type: "project-selection-context"; enabled: boolean }
  | { type: "select-track"; id: string }
  | { type: "select-clip"; id: string; trackId: string }
  | { type: "select-device"; id: string; trackId: string }
  | { type: "dismiss-approval"; agentInstanceId?: string }
  | { type: "update-plan"; section: PlanSection }
  | { type: "browser-query"; value: string }
  | { type: "diagnostics-loaded"; report: DesktopDiagnosticsReport }
  | { type: "toggle-output-disclosure"; producerId: string }
  | { type: "toggle-event-activity"; eventId: string }
  | { type: "events-load-started" }
  | { type: "events-load-failed"; message: string }
  | { type: "event-history-load-started"; append: boolean }
  | {
      type: "event-history-loaded";
      page: RootTracePage;
      append: boolean;
    }
  | { type: "event-history-load-failed"; message: string }
  | { type: "event-history-select-trace"; traceId?: string }
  | {
      type: "event-history-trace-loaded";
      traceId: string;
      page: TelemetryEventPage;
      append: boolean;
    }
  | {
      type: "event-history-configurations-loaded";
      page: ConfigurationSnapshotPage;
    }
  | { type: "event-history-health-loaded"; health: JournalHealth }
  | { type: "project-refresh-started" }
  | { type: "project-refresh-succeeded" }
  | { type: "project-refresh-failed"; message: string }
  | { type: "project-refresh-reset" };

const maxMessages = 500;
const maxOperations = 500;
const maxTriggers = 200;
const maxDismissedContextIds = 500;
const maxCollapsedOutputProducerIds = 500;
const maxExpandedEventActivityIds = 500;
const maxHistoryEvents = 2_000;
const maxRefreshMessageLength = 200;

export function desktopReducer(
  state: DesktopState,
  action: DesktopAction,
): DesktopState {
  switch (action.type) {
    case "event":
      return reduceEvent(state, action.event);
    case "view":
      return { ...state, activeView: action.view };
    case "user-message": {
      const message = {
        id: action.id,
        role: "user" as const,
        content: action.content,
        streaming: false,
        timestamp: Date.now(),
        ...(action.agentMode === undefined
          ? {}
          : { agentMode: action.agentMode }),
      };
      if (action.agentInstanceId !== undefined) {
        return updateAgentWorkspace(
          state,
          action.agentInstanceId,
          (workspace) => ({
            ...workspace,
            messages: bounded([...workspace.messages, message], maxMessages),
          }),
        );
      }
      return {
        ...state,
        messages: bounded([...state.messages, message], maxMessages),
      };
    }
    case "toggle-context": {
      const exists = state.context.some((item) => item.id === action.chip.id);
      return {
        ...state,
        context: exists
          ? state.context.filter((item) => item.id !== action.chip.id)
          : [...state.context, action.chip],
        dismissedContextIds: exists
          ? addDismissedContextId(state.dismissedContextIds, action.chip.id)
          : state.dismissedContextIds.filter((id) => id !== action.chip.id),
      };
    }
    case "remove-context":
      return {
        ...state,
        context: state.context.filter((item) => item.id !== action.chip.id),
        dismissedContextIds: addDismissedContextId(
          state.dismissedContextIds,
          action.chip.id,
        ),
      };
    case "project-selection-context":
      return { ...state, projectSelectionContextEnabled: action.enabled };
    case "select-track":
      return {
        ...state,
        selectedTrackId: action.id,
        selectedClipId: undefined,
        selectedDeviceId: undefined,
        dismissedContextIds: state.dismissedContextIds.filter(
          (id) => id !== `track:${action.id}`,
        ),
      };
    case "select-clip":
      return {
        ...state,
        selectedTrackId: action.trackId,
        selectedClipId: action.id,
        selectedDeviceId: undefined,
        dismissedContextIds: state.dismissedContextIds.filter(
          (id) =>
            id !== `track:${action.trackId}` && id !== `clip:${action.id}`,
        ),
      };
    case "select-device":
      return {
        ...state,
        selectedTrackId: action.trackId,
        selectedDeviceId: action.id,
        selectedClipId: undefined,
        dismissedContextIds: state.dismissedContextIds.filter(
          (id) =>
            id !== `track:${action.trackId}` && id !== `device:${action.id}`,
        ),
      };
    case "dismiss-approval": {
      const instanceId =
        action.agentInstanceId ?? selectedAgentInstance(state)?.id;
      return instanceId === undefined
        ? { ...state, approval: undefined }
        : updateAgentWorkspace(state, instanceId, (workspace) => ({
            ...workspace,
            approval: undefined,
          }));
    }
    case "update-plan":
      return {
        ...state,
        plan: state.plan.map((section) =>
          section.id === action.section.id ? action.section : section,
        ),
      };
    case "browser-query":
      return { ...state, browserQuery: action.value };
    case "diagnostics-loaded":
      return { ...state, diagnosticsReport: action.report };
    case "toggle-output-disclosure": {
      const collapsed = state.collapsedOutputProducerIds.includes(
        action.producerId,
      );
      return {
        ...state,
        collapsedOutputProducerIds: collapsed
          ? state.collapsedOutputProducerIds.filter(
              (producerId) => producerId !== action.producerId,
            )
          : bounded(
              [...state.collapsedOutputProducerIds, action.producerId],
              maxCollapsedOutputProducerIds,
            ),
      };
    }
    case "toggle-event-activity": {
      const expanded = state.expandedEventActivityIds.includes(action.eventId);
      return {
        ...state,
        expandedEventActivityIds: expanded
          ? state.expandedEventActivityIds.filter(
              (eventId) => eventId !== action.eventId,
            )
          : bounded(
              [...state.expandedEventActivityIds, action.eventId],
              maxExpandedEventActivityIds,
            ),
      };
    }
    case "events-load-started":
      return { ...state, eventsLoad: { status: "loading" } };
    case "events-load-failed":
      return {
        ...state,
        eventsLoad: {
          status: "failed",
          message: boundRefreshMessage(action.message),
        },
      };
    case "event-history-load-started":
      return {
        ...state,
        eventHistory: {
          ...state.eventHistory,
          status: "loading",
          message: undefined,
          ...(action.append ? {} : { items: [], nextCursor: undefined }),
        },
      };
    case "event-history-loaded":
      return {
        ...state,
        eventHistory: {
          ...state.eventHistory,
          status: "loaded",
          items: action.append
            ? bounded(
                [...state.eventHistory.items, ...action.page.items],
                maxHistoryEvents,
              )
            : action.page.items,
          nextCursor: action.page.nextCursor,
          message: undefined,
        },
      };
    case "event-history-load-failed":
      return {
        ...state,
        eventHistory: {
          ...state.eventHistory,
          status: "failed",
          message: boundRefreshMessage(action.message),
        },
      };
    case "event-history-select-trace":
      return {
        ...state,
        eventHistory: {
          ...state.eventHistory,
          selectedTraceId: action.traceId,
          trace: [],
          traceNextCursor: undefined,
          traceTotalEvents: undefined,
        },
      };
    case "event-history-trace-loaded":
      if (state.eventHistory.selectedTraceId !== action.traceId) return state;
      return {
        ...state,
        eventHistory: {
          ...state.eventHistory,
          trace: action.append
            ? [...state.eventHistory.trace, ...action.page.items]
            : action.page.items,
          traceNextCursor: action.page.nextCursor,
          traceTotalEvents:
            action.page.trace?.totalEvents ?? action.page.page.totalItems,
        },
      };
    case "event-history-configurations-loaded":
      return {
        ...state,
        eventHistory: {
          ...state.eventHistory,
          configurations: action.page.items,
        },
      };
    case "event-history-health-loaded":
      return {
        ...state,
        eventHistory: { ...state.eventHistory, health: action.health },
      };
    case "project-refresh-started":
      return { ...state, projectRefresh: { status: "refreshing" } };
    case "project-refresh-succeeded":
      return { ...state, projectRefresh: { status: "succeeded" } };
    case "project-refresh-failed":
      return {
        ...state,
        projectRefresh: {
          status: "failed",
          message: boundRefreshMessage(action.message),
        },
      };
    case "project-refresh-reset":
      return { ...state, projectRefresh: { status: "idle" } };
  }
}

export function boundRefreshMessage(message: string): string {
  const normalized = message.trim() || "Project refresh failed";
  return normalized.length > maxRefreshMessageLength
    ? `${normalized.slice(0, maxRefreshMessageLength - 1)}…`
    : normalized;
}

function reduceEvent(
  state: DesktopState,
  event: DesktopAppEvent,
): DesktopState {
  switch (event.type) {
    case "lifecycle.changed":
      return { ...state, lifecycle: event.state };
    case "ableton.connection_changed":
      return { ...state, connection: event.status };
    case "project.snapshot_changed":
      return {
        ...state,
        snapshot: event.snapshot,
        selectedTrackId: state.selectedTrackId ?? event.snapshot.tracks[0]?.id,
      };
    case "sessions.changed":
      return {
        ...state,
        sessions: event.sessions,
        activeSessionId: event.activeSessionId,
      };
    case "agents.catalog_changed":
      return { ...state, agentCatalog: event.catalog };
    case "agent.instance_changed":
      return reduceAgentInstanceChanged(state, event.instance, event.change);
    case "agent.mode_changed":
      if (event.agentInstanceId === undefined) return state;
      return {
        ...state,
        sessions: state.sessions.map((session) => ({
          ...session,
          activeAgents: session.activeAgents.map((agent) =>
            agent.id === event.agentInstanceId
              ? { ...agent, mode: event.mode }
              : agent,
          ),
        })),
      };
    case "agent.plan_changed":
      return state;
    case "agent.plan_approval_requested":
      if (event.agentInstanceId === undefined) return state;
      return updateAgentWorkspace(
        state,
        event.agentInstanceId,
        (workspace) => ({
          ...workspace,
          planApproval: event.request,
        }),
      );
    case "agent.plan_approval_completed":
      if (event.agentInstanceId === undefined) return state;
      return updateAgentWorkspace(state, event.agentInstanceId, (workspace) =>
        workspace.planApproval?.requestId === event.requestId
          ? { ...workspace, planApproval: undefined }
          : workspace,
      );
    case "agent.history_hydrated":
      if (
        activeSession(state)?.activeAgents.find(
          ({ id }) => id === event.agentInstanceId,
        )?.sdkSessionId !== event.sdkSessionId
      ) {
        return state;
      }
      return updateAgentWorkspace(
        state,
        event.agentInstanceId,
        (workspace) => ({
          ...workspace,
          messages: mergeHydratedMessages(workspace.messages, event.history),
        }),
      );
    case "agent.live_event_trigger_changed":
      if (
        state.agentWorkspaces[event.trigger.agentInstanceId]?.triggers.some(
          (trigger) =>
            trigger.deliveryId === event.trigger.deliveryId &&
            trigger.status !== "queued" &&
            event.trigger.status === "queued",
        )
      ) {
        return state;
      }
      return updateAgentWorkspace(
        state,
        event.trigger.agentInstanceId,
        (workspace) => ({
          ...workspace,
          triggers: upsertTrigger(workspace.triggers, event.trigger),
        }),
      );
    case "session.context_restored":
      return {
        ...state,
        sessions: [
          event.session,
          ...state.sessions.filter(
            (session) => session.id !== event.session.id,
          ),
        ],
        activeSessionId: event.session.id,
        agentWorkspaces: Object.fromEntries(
          event.session.activeAgents.map((instance) => [
            instance.id,
            {
              ...(state.activeSessionId === event.session.id
                ? (state.agentWorkspaces[instance.id] ?? emptyAgentWorkspace())
                : emptyAgentWorkspace()),
              triggers: [...(instance.triggerHistory ?? [])],
            },
          ]),
        ),
        plan: event.session.productionPlan,
      };
    case "project.transition_requested":
      return { ...state, pendingProjectTransition: event.transition };
    case "project.transition_cleared":
      return state.pendingProjectTransition?.token === event.token
        ? { ...state, pendingProjectTransition: undefined }
        : state;
    case "preferences.changed":
      return { ...state, preferences: event.preferences };
    case "outputs.changed":
      return { ...state, outputs: event.outputs };
    case "events.changed":
      if (event.events.activeSessionId !== state.activeSessionId) return state;
      return {
        ...state,
        events: event.events,
        eventsLoad: { status: "loaded" },
      };
    case "approval.requested":
      return event.agentInstanceId === undefined
        ? { ...state, approval: event.approval }
        : updateAgentWorkspace(state, event.agentInstanceId, (workspace) => ({
            ...workspace,
            approval: event.approval,
          }));
    case "diagnostic":
      return {
        ...state,
        diagnostics: bounded(
          [
            ...state.diagnostics,
            { level: event.level, message: event.message },
          ],
          100,
        ),
      };
    case "operation.changed": {
      if (event.agentInstanceId !== undefined) {
        return updateAgentWorkspace(
          state,
          event.agentInstanceId,
          (workspace) => ({
            ...workspace,
            operations: upsertOperation(workspace.operations, event.operation),
          }),
        );
      }
      return {
        ...state,
        operations: upsertOperation(state.operations, event.operation),
      };
    }
    case "agent.message_delta": {
      if (event.agentInstanceId !== undefined) {
        return updateAgentWorkspace(
          state,
          event.agentInstanceId,
          (workspace) => ({
            ...workspace,
            messages: applyMessageDelta(
              workspace.messages,
              event.messageId,
              event.content,
            ),
          }),
        );
      }
      return {
        ...state,
        messages: applyMessageDelta(
          state.messages,
          event.messageId,
          event.content,
        ),
      };
    }
    case "agent.message_complete": {
      if (event.agentInstanceId !== undefined) {
        return updateAgentWorkspace(
          state,
          event.agentInstanceId,
          (workspace) => ({
            ...workspace,
            messages: applyMessageComplete(
              workspace.messages,
              event.messageId,
              event.content,
            ),
          }),
        );
      }
      return {
        ...state,
        messages: applyMessageComplete(
          state.messages,
          event.messageId,
          event.content,
        ),
      };
    }
  }
}

const emptyAgentWorkspace = (): AgentWorkspaceState => ({
  messages: [],
  operations: [],
  triggers: [],
  planApproval: undefined,
});

function updateAgentWorkspace(
  state: DesktopState,
  instanceId: string,
  update: (workspace: AgentWorkspaceState) => AgentWorkspaceState,
): DesktopState {
  return {
    ...state,
    agentWorkspaces: {
      ...state.agentWorkspaces,
      [instanceId]: update(
        state.agentWorkspaces[instanceId] ?? emptyAgentWorkspace(),
      ),
    },
  };
}

function upsertOperation(
  operations: OperationView[],
  operation: OperationView,
): OperationView[] {
  const exists = operations.some(({ id }) => id === operation.id);
  return bounded(
    exists
      ? operations.map((candidate) =>
          candidate.id === operation.id ? operation : candidate,
        )
      : [...operations, operation],
    maxOperations,
  );
}

function upsertTrigger(
  triggers: LiveEventTrigger[],
  trigger: LiveEventTrigger,
): LiveEventTrigger[] {
  const existing = triggers.find(
    ({ deliveryId }) => deliveryId === trigger.deliveryId,
  );
  if (
    existing !== undefined &&
    existing.status !== "queued" &&
    trigger.status === "queued"
  ) {
    return triggers;
  }
  return bounded(
    (existing === undefined
      ? [...triggers, trigger]
      : triggers.map((candidate) =>
          candidate.deliveryId === trigger.deliveryId ? trigger : candidate,
        )
    ).sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt),
    ),
    maxTriggers,
  );
}

function applyMessageDelta(
  messages: MessageView[],
  messageId: string,
  content: string,
): MessageView[] {
  const index = messages.findIndex(({ id }) => id === messageId);
  if (index < 0) {
    return bounded(
      [
        ...messages,
        {
          id: messageId,
          role: "assistant",
          content,
          streaming: true,
          timestamp: Date.now(),
        },
      ],
      maxMessages,
    );
  }
  return messages.map((message, messageIndex) =>
    messageIndex === index
      ? { ...message, content: message.content + content, streaming: true }
      : message,
  );
}

function applyMessageComplete(
  messages: MessageView[],
  messageId: string,
  content: string,
): MessageView[] {
  const exists = messages.some(({ id }) => id === messageId);
  return exists
    ? messages.map((message) =>
        message.id === messageId
          ? { ...message, content, streaming: false }
          : message,
      )
    : bounded(
        [
          ...messages,
          {
            id: messageId,
            role: "assistant",
            content,
            streaming: false,
            timestamp: Date.now(),
          },
        ],
        maxMessages,
      );
}

function mergeHydratedMessages(
  current: MessageView[],
  history: DesktopAgentHistoryMessage[],
): MessageView[] {
  const hydrated = history.map((message) => ({
    id: message.eventId,
    role: message.role,
    content: message.content,
    streaming: false,
    timestamp: Date.parse(message.timestamp) || 0,
    ...(message.agentMode === undefined
      ? {}
      : { agentMode: message.agentMode }),
  }));
  const hydratedIds = new Set(hydrated.map(({ id }) => id));
  const latestHydratedTimestamp = Math.max(
    0,
    ...hydrated.map(({ timestamp }) => timestamp),
  );
  return bounded(
    [
      ...hydrated,
      ...current.filter(
        (message) =>
          !hydratedIds.has(message.id) &&
          (message.streaming || message.timestamp > latestHydratedTimestamp),
      ),
    ].sort((left, right) => left.timestamp - right.timestamp),
    maxMessages,
  );
}

function reduceAgentInstanceChanged(
  state: DesktopState,
  instance: DesktopActiveAgent,
  change:
    | "created"
    | "renamed"
    | "configured"
    | "reset"
    | "selected"
    | "deactivated"
    | "lifecycle"
    | "session-rotated"
    | "conversation-settings-changed"
    | "mode-changed",
): DesktopState {
  const session = activeSession(state);
  if (session === undefined) return state;
  const activeAgents =
    change === "deactivated"
      ? session.activeAgents.filter(({ id }) => id !== instance.id)
      : session.activeAgents.some(({ id }) => id === instance.id)
        ? session.activeAgents.map((candidate) =>
            candidate.id === instance.id ? instance : candidate,
          )
        : [...session.activeAgents, instance];
  const selectedAgentInstanceId =
    change === "selected" || change === "created"
      ? instance.id
      : change === "deactivated" &&
          session.selectedAgentInstanceId === instance.id
        ? activeAgents[0]?.id
        : session.selectedAgentInstanceId;
  return {
    ...state,
    ...(change === "conversation-settings-changed"
      ? {
          agentWorkspaces: {
            ...state.agentWorkspaces,
            [instance.id]: emptyAgentWorkspace(),
          },
        }
      : {}),
    sessions: state.sessions.map((candidate) =>
      candidate.id === session.id
        ? {
            ...session,
            activeAgents,
            ...(selectedAgentInstanceId === undefined
              ? { selectedAgentInstanceId: undefined }
              : { selectedAgentInstanceId }),
          }
        : candidate,
    ),
  };
}

export function activeSession(state: DesktopState): DesktopSession | undefined {
  if (state.activeSessionId === undefined) return undefined;
  return state.sessions.find(({ id }) => id === state.activeSessionId);
}

export function selectedAgentInstance(
  state: DesktopState,
): DesktopActiveAgent | undefined {
  const session = activeSession(state);
  return session?.activeAgents.find(
    ({ id }) => id === session.selectedAgentInstanceId,
  );
}

export function selectedAgentWorkspace(
  state: DesktopState,
): AgentWorkspaceState {
  const instanceId = selectedAgentInstance(state)?.id;
  if (instanceId === undefined) {
    return {
      messages: state.messages,
      operations: state.operations,
      triggers: [],
      approval: state.approval,
    };
  }
  return state.agentWorkspaces[instanceId] ?? emptyAgentWorkspace();
}

export function selectedAgentSkills(
  state: DesktopState,
): DesktopAgentCatalog["skills"] {
  const configured = new Set(selectedAgentInstance(state)?.config.skills ?? []);
  return state.agentCatalog.skills.filter(({ name }) => configured.has(name));
}

function bounded<T>(items: T[], maximum: number): T[] {
  return items.length > maximum ? items.slice(items.length - maximum) : items;
}

function addDismissedContextId(ids: string[], id: string): string[] {
  return bounded(
    [...ids.filter((candidate) => candidate !== id), id],
    maxDismissedContextIds,
  );
}

export function contextForSelection(state: DesktopState): ContextChip[] {
  const explicitContext = state.context.filter(
    (chip) => !state.dismissedContextIds.includes(chip.id),
  );
  if (!state.projectSelectionContextEnabled) return explicitContext;
  const track = state.snapshot?.tracks.find(
    (candidate) => candidate.id === state.selectedTrackId,
  );
  if (!track) return explicitContext;
  const generated: ContextChip[] = [
    { id: `track:${track.id}`, kind: "track", label: track.name },
  ];
  const clip = track.clips.find(
    (candidate) => candidate.id === state.selectedClipId,
  );
  if (clip)
    generated.push({ id: `clip:${clip.id}`, kind: "clip", label: clip.name });
  const device = track.devices.find(
    (candidate) => candidate.id === state.selectedDeviceId,
  );
  if (device)
    generated.push({
      id: `device:${device.id}`,
      kind: "device",
      label: device.name,
    });
  return [
    ...explicitContext,
    ...generated.filter(
      (chip) => !explicitContext.some((item) => item.id === chip.id),
    ),
  ].filter((chip) => !state.dismissedContextIds.includes(chip.id));
}
