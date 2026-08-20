import {
  InvalidSkillInvocationError,
  parseSkillInvocation,
  type SkillInvocation,
} from "@ableton-agent/agent-config/skill-invocation";
import {
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
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopOutputAssignment,
  DesktopOutputConnection,
  DesktopProjectSnapshot,
  LatestAcceptedOutput,
  DesktopTrack,
  PlanSection,
} from "../contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  contextForSelection,
  boundRefreshMessage,
  desktopReducer,
  initialState,
  selectedAgentInstance,
  selectedAgentSkills,
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
    name: "yolo",
    description: "Configure automatic approval for agent actions.",
    source: "built-in",
    usage: yoloCommandUsage,
  },
];

const reservedSlashCompletionNames = new Set(
  builtInSlashCompletions.map(({ name }) => name),
);

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
      : selectedAgentSkills(state),
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
      sessions: await desktop.agent.getSessions(),
    },
    {
      type: "agents.catalog_changed",
      catalog: await desktop.agents.getCatalog(),
    },
    {
      type: "outputs.changed",
      outputs: await desktop.outputs.list(),
    },
  ];
}

type DesktopDispatch = React.Dispatch<Parameters<typeof desktopReducer>[1]>;

export async function sendComposerMessage(
  desktop: DesktopApi,
  state: DesktopState,
  message: string,
  dispatch: DesktopDispatch,
): Promise<void> {
  const yolo = parseYoloCommand(message);
  if (yolo !== undefined) {
    const session = state.sessions[0];
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
      if (agent.config.skills.includes(invocation.skillName)) {
        throw new Error(
          `Skill '/${invocation.skillName}' is assigned to ${agent.label} but its definition is unavailable. Refresh definitions or edit the agent.`,
        );
      }
      throw new Error(`Unknown skill '/${invocation.skillName}'.`);
    }
    if (!agent.config.skills.includes(invocation.skillName)) {
      throw new Error(
        `Skill '/${invocation.skillName}' is not assigned to ${agent.label}.`,
      );
    }
    await desktop.project.setContext(contextForSelection(state));
    await desktop.agents.invokeSkill(
      agent.id,
      invocation.skillName,
      invocation.request,
    );
    dispatch({
      type: "user-message",
      id: crypto.randomUUID(),
      content: message,
      agentInstanceId: agent.id,
    });
    return;
  }
  dispatch({
    type: "user-message",
    id: crypto.randomUUID(),
    content: message,
    agentInstanceId: agent.id,
  });
  await desktop.project.setContext(contextForSelection(state));
  await desktop.agents.send(agent.id, message);
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const hydratedAgents = useRef(new Set<string>());
  const timelineScrollPositions = useRef(new Map<string, number>());

  useEffect(() => {
    const pendingDeltas = new Map<
      string,
      Extract<DesktopAppEvent, { type: "agent.message_delta" }>
    >();
    let frame: number | undefined;
    const flush = (): void => {
      frame = undefined;
      for (const event of pendingDeltas.values())
        dispatch({ type: "event", event });
      pendingDeltas.clear();
    };
    const unsubscribe = window.desktop.events.subscribe((event) => {
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
    };
  }, []);
  useEffect(() => {
    const load = async (): Promise<void> => {
      for (const event of await loadInitialDesktopState(window.desktop))
        dispatch({ type: "event", event });
    };
    void load();
  }, []);
  const selectedInstanceId = selectedAgentInstance(state)?.id;
  const activeSessionId = state.sessions[0]?.id;
  useEffect(() => {
    if (selectedInstanceId === undefined || activeSessionId === undefined)
      return;
    const key = `${activeSessionId}:${selectedInstanceId}`;
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
  }, [activeSessionId, selectedInstanceId]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
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
    <div className="app-shell">
      <ConnectionHeader state={state} dispatch={dispatch} />
      <nav className="view-tabs" aria-label="Application views">
        {(
          [
            "workspace",
            "agents",
            "outputs",
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
          />
        ) : state.activeView === "agents" ? (
          <AgentsView state={state} dispatch={dispatch} />
        ) : state.activeView === "outputs" ? (
          <OutputsView state={state} dispatch={dispatch} />
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
      <DesktopComposer
        state={state}
        composerRef={composerRef}
        dispatch={dispatch}
      />
    </div>
  );
}

export function OutputsView({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
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
  const unavailable = state.outputs.status.state !== "listening";
  const outputGroups = groupOutputsByTrack(
    [
      ...state.outputs.connections,
      ...state.outputs.assignments
        .filter(
          (assignment, index, assignments) =>
            assignments.findIndex(
              ({ producerId }) => producerId === assignment.producerId,
            ) === index &&
            !state.outputs.connections.some(
              ({ producerId }) => producerId === assignment.producerId,
            ),
        )
        .map((assignment): DesktopOutputConnection => ({
          connectionId: `missing:${assignment.producerId}`,
          producerId: assignment.producerId,
          instanceId: "missing",
          displayName: assignment.producerId,
          signalKind: "midi",
          state: "disconnected",
          receiving: false,
          lastHeartbeatAt: 0,
        })),
    ],
    state.snapshot,
  );
  const activeSession = state.sessions.find(
    ({ id }) => id === state.outputs.activeSessionId,
  );
  const activeAgents = activeSession?.activeAgents ?? [];
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
        <strong>
          Signal service:{" "}
          {state.outputs.status.state === "listening"
            ? `listening on ${state.outputs.status.host}:${state.outputs.status.port}`
            : state.outputs.status.state}
        </strong>
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
    </section>
  );
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

export function ConnectionHeader({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const session = state.sessions[0];
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
    <header className="connection-header">
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
          Agent Mode
          <select
            className="agent-instance-selector"
            aria-label="Agent Mode"
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
          {state.preferences.model} · {state.preferences.reasoning}
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
      </div>
    </header>
  );
}

export function Workspace({
  state,
  dispatch,
  timelineScrollPositions,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
  timelineScrollPositions?: Map<string, number> | undefined;
}): React.JSX.Element {
  const activeAgent = selectedAgentInstance(state);
  return (
    <div className="workspace">
      <ProjectOutline state={state} dispatch={dispatch} />
      <section
        className="conversation"
        aria-label="Conversation and operation timeline"
      >
        <div className="panel-heading">
          <h2>Conversation</h2>
          <span>
            {activeAgent === undefined
              ? "No active agent"
              : `${activeAgent.label} · ${activeAgent.lifecycle}`}
            {activeAgent?.autoApprove && (
              <span className="agent-badge yolo-badge">YOLO</span>
            )}
          </span>
        </div>
        <Timeline state={state} scrollPositions={timelineScrollPositions} />
      </section>
      <Inspector state={state} dispatch={dispatch} />
    </div>
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
  const session = state.sessions[0];
  const [activeAgents, setActiveAgents] = useState(session?.activeAgents ?? []);
  const [selectedAgentId, setSelectedAgentId] = useState(
    session?.selectedAgentInstanceId,
  );
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [creatingDefinition, setCreatingDefinition] = useState<string>();
  const [confirmResetId, setConfirmResetId] = useState<string>();

  useEffect(() => {
    setActiveAgents(session?.activeAgents ?? []);
    setSelectedAgentId(session?.selectedAgentInstanceId);
  }, [session]);

  const reportError = (error: unknown, fallback: string): void => {
    dispatch({
      type: "event",
      event: {
        type: "diagnostic",
        level: "error",
        message: error instanceof Error ? error.message : fallback,
      },
    });
  };
  const replaceAgent = (updated: DesktopActiveAgent): void => {
    setActiveAgents((agents) =>
      agents.map((agent) => (agent.id === updated.id ? updated : agent)),
    );
  };
  const runAgentAction = async (
    instanceId: string,
    action: () => Promise<DesktopActiveAgent>,
    fallback: string,
  ): Promise<DesktopActiveAgent | undefined> => {
    setBusyAgentId(instanceId);
    try {
      const updated = await action();
      replaceAgent(updated);
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
    setCreatingDefinition(definitionName);
    try {
      const created = await window.desktop.agents.create(definitionName);
      setActiveAgents((agents) => [...agents, created]);
      setSelectedAgentId(created.id);
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
    );
    if (selected !== undefined) {
      setSelectedAgentId(instanceId);
      if (open) dispatch({ type: "view", view: "workspace" });
    }
  };
  const deactivateAgent = async (instanceId: string): Promise<void> => {
    setBusyAgentId(instanceId);
    try {
      await window.desktop.agents.deactivate(instanceId);
      const remaining = activeAgents.filter((agent) => agent.id !== instanceId);
      setActiveAgents(remaining);
      if (selectedAgentId === instanceId) {
        setSelectedAgentId(remaining[0]?.id);
      }
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
                busy={busyAgentId === agent.id}
                confirmingReset={confirmResetId === agent.id}
                onRename={(label) =>
                  runAgentAction(
                    agent.id,
                    () => window.desktop.agents.rename(agent.id, label),
                    "Could not rename agent",
                  )
                }
                onConfigure={(overrides) =>
                  runAgentAction(
                    agent.id,
                    () => window.desktop.agents.configure(agent.id, overrides),
                    "Could not update agent configuration",
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
                  ).then(() => undefined);
                }}
                onCancelReset={() => setConfirmResetId(undefined)}
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
                disabled={creatingDefinition === definition.name}
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

function ActiveAgentCard({
  agent,
  availableSkills,
  definitionSource,
  definitionUpdated,
  selected,
  busy,
  confirmingReset,
  onRename,
  onConfigure,
  onReset,
  onCancelReset,
  onSelect,
  onOpen,
  onDeactivate,
}: {
  agent: DesktopActiveAgent;
  availableSkills: DesktopState["agentCatalog"]["skills"];
  definitionSource?: string | undefined;
  definitionUpdated: boolean;
  selected: boolean;
  busy: boolean;
  confirmingReset: boolean;
  onRename: (label: string) => Promise<DesktopActiveAgent | undefined>;
  onConfigure: (
    overrides: AgentOverrides,
  ) => Promise<DesktopActiveAgent | undefined>;
  onReset: () => Promise<void>;
  onCancelReset: () => void;
  onSelect: () => Promise<void>;
  onOpen: () => Promise<void>;
  onDeactivate: () => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
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

  useEffect(() => {
    const validNames = new Set(availableSkills.map(({ name }) => name));
    setSkills(agent.config.skills.filter((name) => validNames.has(name)));
  }, [agent.config.skills, availableSkillNames]);

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
      </dl>
      {editing && (
        <div className="agent-editor">
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
            <button disabled={busy} onClick={() => setEditing(false)}>
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
        <button disabled={busy} onClick={() => setEditing((value) => !value)}>
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
    <aside className="project-outline" aria-label="Project outline">
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
      ]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-200),
    [workspace.messages, workspace.operations],
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
          >
            <header>
              {item.role === "user" ? "You" : "Assistant"}{" "}
              {item.streaming && <span>Streaming…</span>}
            </header>
            {item.role === "assistant" ? (
              <AssistantMarkdown content={item.content} />
            ) : (
              <p className="message-plain-text">{item.content}</p>
            )}
          </article>
        ) : (
          <OperationCard key={`operation-${item.id}`} operation={item} />
        ),
      )}
    </div>
  );
}

export function OperationCard({
  operation,
}: {
  operation: DesktopState["operations"][number];
}): React.JSX.Element {
  const icon = {
    running: "◌",
    completed: "✓",
    partial: "!",
    failed: "×",
    cancelled: "■",
  }[operation.status];
  return (
    <details
      className={`operation operation-${operation.status}`}
      open={operation.status !== "completed"}
    >
      <summary>
        <span aria-hidden="true">{icon}</span> {operation.label}
        <small>{operation.status}</small>
      </summary>
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
    </details>
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
    <aside className="inspector" aria-label="Selection inspector">
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
      <ApprovalPanel state={state} dispatch={dispatch} />
    </aside>
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
              </div>
              <button
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
  const autoApprovalOverrideCount =
    state.sessions[0]?.activeAgents.filter(({ autoApprove }) => autoApprove)
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
        <label>
          Model
          <input
            value={draft.model}
            onChange={(event) =>
              setDraft({ ...draft, model: event.target.value })
            }
          />
        </label>
        <label>
          Reasoning
          <select
            value={draft.reasoning}
            onChange={(event) =>
              setDraft({
                ...draft,
                reasoning: event.target.value as typeof draft.reasoning,
              })
            }
          >
            <option>auto</option>
            <option>low</option>
            <option>medium</option>
            <option>high</option>
          </select>
        </label>
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
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.telemetryEnabled}
            onChange={(event) =>
              setDraft({ ...draft, telemetryEnabled: event.target.checked })
            }
          />{" "}
          Anonymous operational telemetry
        </label>
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
}: {
  state: DesktopState;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const selectedInstanceId = selectedAgentInstance(state)?.id;

  useEffect(() => {
    setError("");
  }, [selectedInstanceId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const message = value.trim();
    if (!message) return;
    setError("");
    setValue("");
    try {
      await sendComposerMessage(window.desktop, state, message, dispatch);
    } catch (submitError) {
      const messageText =
        submitError instanceof Error
          ? submitError.message
          : "Agent message failed";
      if (message.startsWith("/")) setValue(message);
      setError(messageText);
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
        setValue(nextValue);
        setError("");
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
