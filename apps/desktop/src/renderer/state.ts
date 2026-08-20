import type {
  ApprovalRequest,
  ContextChip,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopDiagnosticsReport,
  DesktopAgentCatalog,
  DesktopActiveAgent,
  DesktopAgentHistoryMessage,
  DesktopPreferences,
  DesktopOutputsState,
  DesktopProjectSnapshot,
  DesktopSession,
  OperationView,
  PlanSection,
  ProductMode,
} from "../contracts";
import { preferencesSchema } from "../contracts";

export type WorkspaceView =
  | "workspace"
  | "agents"
  | "outputs"
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
}

export interface AgentWorkspaceState {
  messages: MessageView[];
  operations: OperationView[];
  approval?: ApprovalRequest | undefined;
}

export type ProjectRefreshState =
  | { status: "idle" }
  | { status: "refreshing" }
  | { status: "succeeded" }
  | { status: "failed"; message: string };

export interface DesktopState {
  lifecycle:
    "stopped" | "starting" | "ready" | "degraded" | "stopping" | "crashed";
  connection: DesktopConnectionStatus;
  mode: ProductMode;
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
  agentCatalog: DesktopAgentCatalog;
  preferences: DesktopPreferences;
  diagnostics: Array<{ level: "info" | "warning" | "error"; message: string }>;
  diagnosticsReport?: DesktopDiagnosticsReport | undefined;
  plan: PlanSection[];
  browserQuery: string;
  outputs: DesktopOutputsState;
  collapsedOutputProducerIds: string[];
  projectRefresh: ProjectRefreshState;
}

export const initialState: DesktopState = {
  lifecycle: "starting",
  connection: { state: "disconnected" },
  mode: "explore",
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
  collapsedOutputProducerIds: [],
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
  | { type: "project-refresh-started" }
  | { type: "project-refresh-succeeded" }
  | { type: "project-refresh-failed"; message: string }
  | { type: "project-refresh-reset" };

const maxMessages = 500;
const maxOperations = 500;
const maxDismissedContextIds = 500;
const maxCollapsedOutputProducerIds = 500;
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
      return { ...state, sessions: event.sessions };
    case "agents.catalog_changed":
      return { ...state, agentCatalog: event.catalog };
    case "agent.instance_changed":
      return reduceAgentInstanceChanged(state, event.instance, event.change);
    case "agent.history_hydrated":
      return updateAgentWorkspace(
        state,
        event.agentInstanceId,
        (workspace) => ({
          ...workspace,
          messages: mergeHydratedMessages(workspace.messages, event.history),
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
        mode: event.session.mode,
        plan: event.session.productionPlan,
      };
    case "preferences.changed":
      return { ...state, preferences: event.preferences };
    case "outputs.changed":
      return { ...state, outputs: event.outputs };
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
    | "lifecycle",
): DesktopState {
  const session = state.sessions[0];
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
    sessions: [
      {
        ...session,
        activeAgents,
        ...(selectedAgentInstanceId === undefined
          ? { selectedAgentInstanceId: undefined }
          : { selectedAgentInstanceId }),
      },
      ...state.sessions.slice(1),
    ],
  };
}

export function selectedAgentInstance(
  state: DesktopState,
): DesktopActiveAgent | undefined {
  const session = state.sessions[0];
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
