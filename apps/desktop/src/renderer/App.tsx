import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import type {
  DesktopApi,
  DesktopAppEvent,
  DesktopConnectionStatus,
  DesktopOutputAssignment,
  DesktopOutputConnection,
  LatestAcceptedOutput,
  DesktopTrack,
  PlanSection,
  ProductMode,
} from "../contracts";
import { AssistantMarkdown } from "./AssistantMarkdown";
import {
  contextForSelection,
  boundRefreshMessage,
  desktopReducer,
  initialState,
  type DesktopState,
  type WorkspaceView,
} from "./state";

const modeLabels: Record<ProductMode, string> = {
  explore: "Explore",
  compose: "Compose",
  arrange: "Arrange",
  sound: "Sound",
  mix: "Mix",
};

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
      type: "outputs.changed",
      outputs: await desktop.outputs.list(),
    },
  ];
}

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(desktopReducer, initialState);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const pendingDeltas = new Map<string, string>();
    let frame: number | undefined;
    const flush = (): void => {
      frame = undefined;
      for (const [messageId, content] of pendingDeltas) {
        dispatch({
          type: "event",
          event: { type: "agent.message_delta", messageId, content },
        });
      }
      pendingDeltas.clear();
    };
    const unsubscribe = window.desktop.events.subscribe((event) => {
      if (event.type !== "agent.message_delta") {
        if (frame !== undefined) cancelAnimationFrame(frame);
        if (pendingDeltas.size > 0) flush();
        dispatch({ type: "event", event });
        return;
      }
      pendingDeltas.set(
        event.messageId,
        (pendingDeltas.get(event.messageId) ?? "") + event.content,
      );
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
      if (event.key === "Escape" && state.approval) {
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.approval]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const message = composer.trim();
    if (!message || busy) return;
    setComposer("");
    setBusy(true);
    dispatch({
      type: "user-message",
      id: crypto.randomUUID(),
      content: message,
    });
    try {
      await window.desktop.agent.send(
        message,
        contextForSelection(state),
        state.mode,
      );
    } finally {
      setBusy(false);
      composerRef.current?.focus();
    }
  };

  return (
    <div className="app-shell">
      <ConnectionHeader state={state} dispatch={dispatch} />
      <nav className="view-tabs" aria-label="Application views">
        {(
          [
            "workspace",
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
          <Workspace state={state} dispatch={dispatch} />
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
      <Composer
        state={state}
        value={composer}
        busy={busy}
        composerRef={composerRef}
        onChange={setComposer}
        onSubmit={submit}
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
  return (
    <section className="outputs-view" aria-labelledby="outputs-heading">
      <div className="panel-heading">
        <div>
          <h2 id="outputs-heading">Outputs</h2>
          <p>
            Discovered MIDI and audio observations routed to the active
            conversation.
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
      {!state.outputs.activeSessionId && (
        <div className="notice" role="status">
          No active conversation. Start or resume a session before assigning
          outputs.
        </div>
      )}
      {state.outputs.connections.length === 0 ? (
        <EmptyState
          title="No outputs discovered"
          detail="Open a compatible MIDI or audio producer in Ableton Live."
        />
      ) : (
        <div className="output-grid">
          {state.outputs.connections.map((connection) => {
            const assignment = state.outputs.assignments.find(
              (item) => item.producerId === connection.producerId,
            );
            const latest = state.outputs.latest
              .filter((item) => item.producerId === connection.producerId)
              .sort((left, right) => right.sequence - left.sequence)[0];
            return (
              <OutputConnectionCard
                key={connection.producerId}
                connection={connection}
                assignment={assignment}
                latest={latest}
                unavailable={unavailable}
                hasActiveSession={state.outputs.activeSessionId !== undefined}
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
      )}
    </section>
  );
}

export async function setOutputQuickEnabled(
  outputs: Pick<DesktopApi["outputs"], "assign" | "setEnabled">,
  producerId: string,
  assignment: DesktopOutputAssignment | undefined,
  enabled: boolean,
): Promise<void> {
  if (assignment === undefined) {
    if (enabled) await outputs.assign(producerId);
    return;
  }
  await outputs.setEnabled(producerId, enabled);
}

export function OutputConnectionCard({
  connection,
  assignment,
  latest,
  unavailable,
  hasActiveSession,
  expanded,
  onToggleDisclosure,
  onError,
}: {
  connection: DesktopOutputConnection;
  assignment: DesktopOutputAssignment | undefined;
  latest: LatestAcceptedOutput | undefined;
  unavailable: boolean;
  hasActiveSession: boolean;
  expanded: boolean;
  onToggleDisclosure: () => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [updating, setUpdating] = useState(false);
  const detailsId = `output-details-${connection.producerId}`;
  const quickToggleDisabled =
    updating || unavailable || (assignment === undefined && !hasActiveSession);
  const updateEnabled = async (enabled: boolean): Promise<void> => {
    setUpdating(true);
    try {
      await setOutputQuickEnabled(
        window.desktop.outputs,
        connection.producerId,
        assignment,
        enabled,
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
            {connection.signalKind.toUpperCase()} ·{" "}
            {connection.track?.name ?? "Unknown track"}
            {connection.device?.name ? ` · ${connection.device.name}` : ""}
          </span>
        </div>
        <div className="output-card-header-actions">
          <strong aria-label={`Connection state: ${connection.state}`}>
            {connection.state}
            {connection.receiving ? " · receiving" : ""}
          </strong>
          <label className="output-quick-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label={`${
                assignment?.enabled ? "Disable" : "Enable"
              } ${connection.displayName} delivery`}
              checked={assignment?.enabled ?? false}
              disabled={quickToggleDisabled}
              onChange={(event) => void updateEnabled(event.target.checked)}
            />
            <span>{assignment?.enabled ? "On" : "Off"}</span>
          </label>
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
      {expanded && (
        <div id={detailsId} className="output-card-details">
          <div className="latest-output">
            <strong>Latest accepted window</strong>
            <p>
              {latest?.summary ?? "No accepted sample has been received yet."}
            </p>
          </div>
          {assignment === undefined ? (
            <button
              disabled={unavailable || !hasActiveSession}
              onClick={() =>
                void window.desktop.outputs
                  .assign(connection.producerId)
                  .catch(onError)
              }
            >
              Assign to active conversation
            </button>
          ) : (
            <OutputAssignmentControls
              assignment={assignment}
              onError={onError}
            />
          )}
        </div>
      )}
    </article>
  );
}

function OutputAssignmentControls({
  assignment,
  onError,
}: {
  assignment: DesktopOutputAssignment;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [instruction, setInstruction] = useState(assignment.usageInstruction);
  return (
    <div className="output-controls">
      <label>
        <input
          type="checkbox"
          checked={assignment.enabled}
          onChange={(event) =>
            void window.desktop.outputs
              .setEnabled(assignment.producerId, event.target.checked)
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
      <div className="output-actions">
        <button
          disabled={instruction.trim().length === 0}
          onClick={() =>
            void window.desktop.outputs
              .setUsageInstruction(assignment.producerId, instruction)
              .catch(onError)
          }
        >
          Save instruction
        </button>
        <button
          onClick={() =>
            void window.desktop.outputs
              .unassign(assignment.producerId)
              .catch(onError)
          }
        >
          Unassign
        </button>
      </div>
    </div>
  );
}

function ConnectionHeader({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
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
          Mode
          <select
            value={state.mode}
            onChange={(event) =>
              dispatch({
                type: "mode",
                mode: event.target.value as ProductMode,
              })
            }
          >
            {Object.entries(modeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
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

function Workspace({
  state,
  dispatch,
}: {
  state: DesktopState;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  return (
    <div className={`workspace mode-${state.mode}`}>
      <ProjectOutline state={state} dispatch={dispatch} />
      <section
        className="conversation"
        aria-label="Conversation and operation timeline"
      >
        <div className="panel-heading">
          <h2>Conversation</h2>
          <span>{modeLabels[state.mode]} workflow</span>
        </div>
        <Timeline state={state} />
        {state.mode === "arrange" && (
          <Arrangement state={state} dispatch={dispatch} />
        )}
        {state.mode === "compose" && (
          <ModeCard
            title="Composition controls"
            items={[
              "Rhythm density",
              "Harmonic palette",
              "Motif variation",
              "Humanize notes",
            ]}
          />
        )}
        {state.mode === "sound" && (
          <ModeCard
            title="Sound workflow"
            items={[
              "Instrument selection",
              "Device chain",
              "Macro targets",
              "A/B preview",
            ]}
          />
        )}
        {state.mode === "mix" && (
          <ModeCard
            title="Mix workflow"
            items={[
              "Comparative balance",
              "Pan field",
              "Headroom",
              "Device gain staging",
            ]}
          />
        )}
      </section>
      <Inspector state={state} dispatch={dispatch} />
    </div>
  );
}

type DesktopDispatch = React.Dispatch<Parameters<typeof desktopReducer>[1]>;

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
}: {
  state: DesktopState;
}): React.JSX.Element {
  const items = useMemo(
    () =>
      [
        ...state.messages.map((item) => ({
          ...item,
          itemType: "message" as const,
        })),
        ...state.operations.map((item) => ({
          ...item,
          itemType: "operation" as const,
        })),
      ]
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-200),
    [state.messages, state.operations],
  );
  return (
    <div className="timeline" aria-live="polite" aria-label="Recent activity">
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
  const approval = state.approval;
  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    if (!approval) return;
    await window.desktop.approvals.resolve(approval.id, decision);
    dispatch({ type: "dismiss-approval" });
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

export function Composer({
  state,
  value,
  busy,
  composerRef,
  onChange,
  onSubmit,
  dispatch,
}: {
  state: DesktopState;
  value: string;
  busy: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  dispatch: React.Dispatch<Parameters<typeof desktopReducer>[1]>;
}): React.JSX.Element {
  const context = contextForSelection(state);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
        <label className="sr-only" htmlFor="prompt">
          Message the Ableton agent
        </label>
        <textarea
          id="prompt"
          ref={composerRef}
          value={value}
          disabled={state.lifecycle === "stopping"}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            state.connection.state === "connected"
              ? `Ask in ${modeLabels[state.mode]} mode…`
              : "Ask using the demo adapter, or connect to Ableton…"
          }
          rows={2}
        />
        {busy ||
        state.operations.some((operation) => operation.status === "running") ? (
          <button
            type="button"
            onClick={() => void window.desktop.agent.cancel()}
          >
            Cancel
          </button>
        ) : (
          <button className="primary" type="submit" disabled={!value.trim()}>
            Send <kbd>↵</kbd>
          </button>
        )}
      </form>
    </footer>
  );
}

function ModeCard({
  title,
  items,
}: {
  title: string;
  items: string[];
}): React.JSX.Element {
  return (
    <section className="mode-card">
      <h2>{title}</h2>
      <div>
        {items.map((item) => (
          <button key={item}>{item}</button>
        ))}
      </div>
    </section>
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
