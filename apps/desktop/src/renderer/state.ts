import type {
  ApprovalRequest,
  ContextChip,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopPreferences,
  DesktopProjectSnapshot,
  DesktopSession,
  OperationView,
  PlanSection,
  ProductMode,
} from "../contracts";
import { preferencesSchema } from "../contracts";

export type WorkspaceView =
  "workspace" | "browser" | "diagnostics" | "sessions" | "settings";
export interface MessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  timestamp: number;
}

export interface DesktopState {
  lifecycle:
    "stopped" | "starting" | "ready" | "degraded" | "stopping" | "crashed";
  connection: DesktopConnectionStatus;
  mode: ProductMode;
  activeView: WorkspaceView;
  messages: MessageView[];
  operations: OperationView[];
  context: ContextChip[];
  approval?: ApprovalRequest | undefined;
  snapshot?: DesktopProjectSnapshot | undefined;
  selectedTrackId?: string | undefined;
  selectedClipId?: string | undefined;
  selectedDeviceId?: string | undefined;
  sessions: DesktopSession[];
  preferences: DesktopPreferences;
  diagnostics: Array<{ level: "info" | "warning" | "error"; message: string }>;
  plan: PlanSection[];
  browserQuery: string;
}

export const initialState: DesktopState = {
  lifecycle: "starting",
  connection: { state: "disconnected" },
  mode: "explore",
  activeView: "workspace",
  messages: [],
  operations: [],
  context: [],
  sessions: [],
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
};

export type DesktopAction =
  | { type: "event"; event: DesktopAppEvent }
  | { type: "mode"; mode: ProductMode }
  | { type: "view"; view: WorkspaceView }
  | { type: "user-message"; id: string; content: string }
  | { type: "toggle-context"; chip: ContextChip }
  | { type: "select-track"; id: string }
  | { type: "select-clip"; id: string; trackId: string }
  | { type: "select-device"; id: string; trackId: string }
  | { type: "dismiss-approval" }
  | { type: "update-plan"; section: PlanSection }
  | { type: "browser-query"; value: string };

const maxMessages = 500;
const maxOperations = 500;

export function desktopReducer(
  state: DesktopState,
  action: DesktopAction,
): DesktopState {
  switch (action.type) {
    case "event":
      return reduceEvent(state, action.event);
    case "mode":
      return { ...state, mode: action.mode };
    case "view":
      return { ...state, activeView: action.view };
    case "user-message":
      return {
        ...state,
        messages: bounded(
          [
            ...state.messages,
            {
              id: action.id,
              role: "user",
              content: action.content,
              streaming: false,
              timestamp: Date.now(),
            },
          ],
          maxMessages,
        ),
      };
    case "toggle-context": {
      const exists = state.context.some((item) => item.id === action.chip.id);
      return {
        ...state,
        context: exists
          ? state.context.filter((item) => item.id !== action.chip.id)
          : [...state.context, action.chip],
      };
    }
    case "select-track":
      return {
        ...state,
        selectedTrackId: action.id,
        selectedClipId: undefined,
        selectedDeviceId: undefined,
      };
    case "select-clip":
      return {
        ...state,
        selectedTrackId: action.trackId,
        selectedClipId: action.id,
        selectedDeviceId: undefined,
      };
    case "select-device":
      return {
        ...state,
        selectedTrackId: action.trackId,
        selectedDeviceId: action.id,
        selectedClipId: undefined,
      };
    case "dismiss-approval":
      return { ...state, approval: undefined };
    case "update-plan":
      return {
        ...state,
        plan: state.plan.map((section) =>
          section.id === action.section.id ? action.section : section,
        ),
      };
    case "browser-query":
      return { ...state, browserQuery: action.value };
  }
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
    case "preferences.changed":
      return { ...state, preferences: event.preferences };
    case "approval.requested":
      return { ...state, approval: event.approval };
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
      const exists = state.operations.some(
        (operation) => operation.id === event.operation.id,
      );
      const operations = exists
        ? state.operations.map((operation) =>
            operation.id === event.operation.id ? event.operation : operation,
          )
        : [...state.operations, event.operation];
      return { ...state, operations: bounded(operations, maxOperations) };
    }
    case "agent.message_delta": {
      const index = state.messages.findIndex(
        (message) => message.id === event.messageId,
      );
      if (index < 0) {
        return {
          ...state,
          messages: bounded(
            [
              ...state.messages,
              {
                id: event.messageId,
                role: "assistant",
                content: event.content,
                streaming: true,
                timestamp: Date.now(),
              },
            ],
            maxMessages,
          ),
        };
      }
      return {
        ...state,
        messages: state.messages.map((message, messageIndex) =>
          messageIndex === index
            ? { ...message, content: message.content + event.content }
            : message,
        ),
      };
    }
    case "agent.message_complete":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === event.messageId
            ? { ...message, content: event.content, streaming: false }
            : message,
        ),
      };
  }
}

function bounded<T>(items: T[], maximum: number): T[] {
  return items.length > maximum ? items.slice(items.length - maximum) : items;
}

export function contextForSelection(state: DesktopState): ContextChip[] {
  const track = state.snapshot?.tracks.find(
    (candidate) => candidate.id === state.selectedTrackId,
  );
  if (!track) return state.context;
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
    ...state.context,
    ...generated.filter(
      (chip) => !state.context.some((item) => item.id === chip.id),
    ),
  ];
}
