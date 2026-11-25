import {
  MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH,
  resolvePreparedContextConfiguration,
  type AgentEventListener,
  type PreparedContextConfiguration,
} from "@ableton-agent/agent-config/schemas";
import type { MonitoringEpisodeKind } from "@ableton-agent/protocol";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  DesktopActiveAgent,
  DesktopAgentDefinition,
  DesktopLiveEventState,
  DesktopLiveSetSnapshot,
  DesktopMonitor,
  DesktopTrack,
  LiveEventDefinitionDraft,
  LiveEventSelection,
} from "../contracts";
import { Icon } from "./Icon";
import {
  clipEventKinds,
  eventKindLabels,
  latestStateLabel,
  parameterDraftFromSnapshot,
  searchParameters,
  selectionTrack,
  trackDraft,
  trackLocator,
  type ParameterMatch,
} from "./live-event-drafts";
import { ScopeChip } from "./scope-library";
import { activeSession, type desktopReducer, type DesktopState } from "./state";

type DesktopDispatch = React.Dispatch<Parameters<typeof desktopReducer>[1]>;
type ReportError = (error: unknown, fallback: string) => void;

const ALL_EPISODES: readonly MonitoringEpisodeKind[] = [
  "pattern-established",
  "fill",
  "pattern-changed",
  "uncertain",
  "closed",
];
const EPISODE_LABELS: Record<MonitoringEpisodeKind, string> = {
  "pattern-established": "It finds a pattern",
  fill: "A fill or one-off",
  "pattern-changed": "The pattern changes",
  uncertain: "It loses the pattern",
  closed: "Listening stops",
};
const CLIP_KIND_HELP: Record<(typeof clipEventKinds)[number], string> = {
  "track.playing_clip_changed": "A different clip starts or stops playing",
  "track.triggered_clip_changed": "A clip is launched and waiting to start",
  "track.recording_state_changed": "The track starts or stops recording",
};
const PARAMETER_RESULT_LIMIT = 200;

// ── Monitor helpers shared with the toolbar ──────────────────────────────

export function monitorStateLabel(monitor: DesktopMonitor): string {
  if (!monitor.ready) return "Device not ready";
  if (monitor.pending) return "Armed · waiting for play";
  switch (monitor.state) {
    case "tracking":
      return "Established";
    case "deviating":
      return "Changing…";
    case "acquiring":
      return "Finding pattern…";
    case "uncertain":
      return "Uncertain";
    case "armed":
      return "Armed · waiting for play";
    default:
      return monitor.armed ? "Armed · waiting for play" : "Not listening";
  }
}

function monitorListening(monitor: DesktopMonitor): boolean {
  return monitor.armed || monitor.pending;
}

function armSummary(monitors: readonly DesktopMonitor[]): {
  ready: number;
  armed: number;
  led: "on" | "warn" | "";
} {
  const ready = monitors.filter(({ ready }) => ready);
  const armed = ready.filter(monitorListening).length;
  return {
    ready: ready.length,
    armed,
    led: armed === 0 ? "" : armed === ready.length && armed > 0 ? "on" : "warn",
  };
}

function useMonitorActions(onError: ReportError): {
  busy: boolean;
  setArmed: (armed: boolean, listenerIds?: string[]) => void;
} {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    setArmed: (armed, listenerIds) => {
      setBusy(true);
      const api = window.desktop.monitors;
      void (armed ? api.arm(listenerIds) : api.disarm(listenerIds))
        .catch((error: unknown) =>
          onError(error, armed ? "Could not arm" : "Could not disarm"),
        )
        .finally(() => setBusy(false));
    },
  };
}

/** One button for every Machine Listening device: arm them all, or disarm. */
export function ArmAllButton({
  monitors,
  disabled,
  onError,
}: {
  monitors: readonly DesktopMonitor[];
  disabled?: boolean;
  onError: ReportError;
}): React.JSX.Element {
  const { busy, setArmed } = useMonitorActions(onError);
  const summary = armSummary(monitors);
  const disarm = summary.ready > 0 && summary.armed === summary.ready;
  return (
    <button
      type="button"
      className="wiring-arm-all"
      aria-label={`${disarm ? "Disarm" : "Arm"} all monitors, ${summary.armed} of ${summary.ready} armed`}
      disabled={disabled || busy || summary.ready === 0}
      onClick={() => setArmed(!disarm)}
    >
      <span className={`led ${summary.led}`} aria-hidden="true" />
      {disarm ? "Disarm all" : "Arm all"}
      <span className="tabular">
        {summary.armed}/{summary.ready}
      </span>
    </button>
  );
}

/** Toolbar split button: arm everything, or open the list to arm one. */
export function MonitorArmMenu({
  state,
  dispatch,
  onError,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
  onError: ReportError;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { busy, setArmed } = useMonitorActions(onError);
  const monitors = state.events.monitors.listeners;
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (
        event instanceof MouseEvent &&
        ref.current?.contains(event.target as Node)
      )
        return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!state.events.monitors.available || monitors.length === 0) return null;
  const sessionActive = activeSession(state) !== undefined;
  return (
    <div className="wiring-arm-menu" ref={ref}>
      <ArmAllButton
        monitors={monitors}
        disabled={!sessionActive}
        onError={onError}
      />
      <button
        type="button"
        className="wiring-arm-menu-toggle"
        aria-label="Show monitors"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ▾
      </button>
      {open && (
        <div className="wiring-arm-popover" role="dialog" aria-label="Monitors">
          <ul>
            {monitors.map((monitor) => {
              const track = state.snapshot?.tracks.find(
                ({ id }) => id === monitor.trackReference,
              );
              const listening = monitorListening(monitor);
              return (
                <li
                  key={monitor.listenerId}
                  style={trackColorStyle(track?.color)}
                >
                  <span className="wiring-grow">
                    <strong>{track?.name ?? monitor.displayName}</strong>
                    <span className="wiring-muted">
                      {monitorStateLabel(monitor)}
                    </span>
                  </span>
                  <ArmToggle
                    listening={listening}
                    label={track?.name ?? monitor.displayName}
                    disabled={!sessionActive || busy || !monitor.ready}
                    onToggle={() => setArmed(!listening, [monitor.listenerId])}
                  />
                </li>
              );
            })}
          </ul>
          <p className="wiring-muted">Agents can arm them too.</p>
          <button
            type="button"
            className="wiring-link"
            onClick={() => {
              setOpen(false);
              dispatch({ type: "view", view: "events" });
            }}
          >
            Open Wiring
          </button>
        </div>
      )}
    </div>
  );
}

function ArmToggle({
  listening,
  label,
  disabled,
  onToggle,
}: {
  listening: boolean;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="wiring-arm"
      aria-pressed={listening}
      aria-label={`Armed: ${label}`}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className={`led ${listening ? "on" : ""}`} aria-hidden="true" />
      {listening ? "Armed" : "Off"}
    </button>
  );
}

// ── Graph model ──────────────────────────────────────────────────────────

type Source =
  | {
      kind: "monitor";
      id: string;
      name: string;
      monitor: DesktopMonitor;
      event: DesktopLiveEventState | undefined;
      track: DesktopTrack | undefined;
    }
  | {
      kind: "event";
      id: string;
      name: string;
      event: DesktopLiveEventState;
      track: DesktopTrack | undefined;
    };

interface Wire {
  source: Source;
  event: DesktopLiveEventState;
  agent: DesktopActiveAgent;
  listener: AgentEventListener;
}

type Selection =
  | { kind: "add-agent" }
  | { kind: "add-listener" }
  | { kind: "add-event" }
  | { kind: "source"; sourceId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "wire"; sourceId: string; agentId: string };

type Filter = "all" | "monitors" | "events" | "unwired";
const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  monitors: "Monitors",
  events: "Live events",
  unwired: "Unwired",
};

function resolvedTrack(
  event: DesktopLiveEventState,
  snapshot: DesktopLiveSetSnapshot | undefined,
): DesktopTrack | undefined {
  if (event.resolution.status !== "resolved") return undefined;
  const reference = event.resolution.trackReference;
  return snapshot?.tracks.find(({ id }) => id === reference);
}

function buildSources(state: DesktopState): Source[] {
  const events = state.events.events;
  const claimed = new Set<string>();
  const monitors: Source[] = state.events.monitors.listeners.map((monitor) => {
    const event = events.find(
      (candidate) =>
        candidate.definition.kind === "track.pattern_changed" &&
        candidate.resolution.status === "resolved" &&
        candidate.resolution.trackReference === monitor.trackReference,
    );
    if (event) claimed.add(event.definition.id);
    const track = state.snapshot?.tracks.find(
      ({ id }) => id === monitor.trackReference,
    );
    return {
      kind: "monitor",
      id: `monitor:${monitor.listenerId}`,
      name: track?.name ?? monitor.displayName,
      monitor,
      event,
      track,
    };
  });
  const liveEvents: Source[] = events
    .filter(({ definition }) => !claimed.has(definition.id))
    .map((event) => ({
      kind: "event",
      id: `event:${event.definition.id}`,
      name: event.definition.name,
      event,
      track: resolvedTrack(event, state.snapshot),
    }));
  return [...monitors, ...liveEvents];
}

function buildWires(
  sources: readonly Source[],
  agents: readonly DesktopActiveAgent[],
): Wire[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return sources.flatMap((source) => {
    const event = source.event;
    if (!event) return [];
    return event.listeners.flatMap(({ agentInstanceId, listener }) => {
      const agent =
        agentInstanceId === undefined ? undefined : byId.get(agentInstanceId);
      return agent ? [{ source, event, agent, listener }] : [];
    });
  });
}

function trackColorStyle(color: string | undefined): CSSProperties {
  return { "--node-color": color ?? "var(--track-none)" } as CSSProperties;
}

function agentLedClass(lifecycle: DesktopActiveAgent["lifecycle"]): string {
  if (lifecycle === "ready") return "on";
  if (lifecycle === "failed") return "error";
  if (lifecycle === "busy" || lifecycle === "blocked") return "waiting";
  return "";
}

interface Point {
  x: number;
  y: number;
}

function wirePath(from: Point, to: Point): string {
  const dx = Math.max(40, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

// ── Wiring view ──────────────────────────────────────────────────────────

export type WiringMode = "live" | "history";

/** One bar for both Wiring modes so switching never moves the tabs or content. */
export function WiringBar({
  mode,
  onModeChange,
  children,
}: {
  mode: WiringMode;
  onModeChange: (mode: WiringMode) => void;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="wiring-bar">
      <h2 id="events-heading">Wiring</h2>
      <div className="events-mode-tabs" role="tablist" aria-label="Wiring mode">
        {(["live", "history"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => onModeChange(value)}
          >
            {value === "live" ? "Connections" : "History"}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

export function WiringView({
  state,
  dispatch,
  onModeChange,
  agentColor,
  renderEventDetails,
  onError,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
  onModeChange: (mode: WiringMode) => void;
  agentColor: (definitionName: string) => string;
  renderEventDetails: (event: DesktopLiveEventState) => ReactNode;
  onError: ReportError;
}): React.JSX.Element {
  const session = activeSession(state);
  const sessionActive = session !== undefined;
  const agents = session?.activeAgents ?? [];
  const sources = useMemo(() => buildSources(state), [state]);
  const wires = useMemo(() => buildWires(sources, agents), [sources, agents]);
  const inactiveDefinitions = state.agentCatalog.definitions.filter(
    ({ name }) => !agents.some(({ definitionName }) => definitionName === name),
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [selection, setSelection] = useState<Selection | undefined>();
  const [connecting, setConnecting] = useState<
    { sourceId: string; pointer?: Point } | undefined
  >();
  const dragStart = useRef<
    { sourceId: string; x: number; y: number } | undefined
  >(undefined);
  const dragged = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{
    outs: Record<string, Point>;
    ins: Record<string, Point>;
  }>({ outs: {}, ins: {} });

  const monitorsAvailable = state.events.monitors.available;
  useEffect(() => {
    if (!monitorsAvailable) return;
    void window.desktop.monitors
      .refresh()
      .catch((error: unknown) => onError(error, "Monitors not refreshed"));
    // Refresh once when the view opens.
  }, [monitorsAvailable]);

  useEffect(() => {
    if (!sessionActive) setSelection(undefined);
  }, [sessionActive]);

  const wiredSourceIds = new Set(wires.map(({ source }) => source.id));
  const visibleSources = sources.filter((source) =>
    filter === "monitors"
      ? source.kind === "monitor"
      : filter === "events"
        ? source.kind === "event"
        : filter === "unwired"
          ? !wiredSourceIds.has(source.id)
          : true,
  );
  const monitorSources = visibleSources.filter(
    (source) => source.kind === "monitor",
  );
  const eventSources = visibleSources.filter(
    (source) => source.kind === "event",
  );
  const visibleWires = wires.filter(({ source }) =>
    visibleSources.includes(source),
  );

  const layoutKey = [
    filter,
    selection?.kind ?? "",
    ...visibleSources.map(
      ({ id, event }) => `${id}:${event?.listeners.length}`,
    ),
    ...agents.map(({ id }) => id),
  ].join("|");
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = (): void => {
      const box = stage.getBoundingClientRect();
      const read = (attribute: string): Record<string, Point> =>
        Object.fromEntries(
          [...stage.querySelectorAll<HTMLElement>(`[${attribute}]`)].map(
            (element) => {
              const rect = element.getBoundingClientRect();
              return [
                element.getAttribute(attribute) ?? "",
                {
                  x: rect.left + rect.width / 2 - box.left,
                  y: rect.top + rect.height / 2 - box.top,
                },
              ];
            },
          ),
        );
      setGeometry({ outs: read("data-port-out"), ins: read("data-port-in") });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [layoutKey]);

  useEffect(() => {
    if (!connecting) return;
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setConnecting(undefined);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [connecting]);

  const connect = async (sourceId: string, agentId: string): Promise<void> => {
    setConnecting(undefined);
    const source = sources.find(({ id }) => id === sourceId);
    if (!source || !sessionActive) return;
    if (
      wires.some(
        (wire) => wire.source.id === sourceId && wire.agent.id === agentId,
      )
    ) {
      setSelection({ kind: "wire", sourceId, agentId });
      return;
    }
    try {
      let eventId = source.event?.definition.id;
      if (eventId === undefined && source.kind === "monitor") {
        if (!source.track || !state.snapshot)
          throw new Error(
            "The monitor's track is not in the current Live set.",
          );
        eventId = (
          await window.desktop.events.create(
            trackDraft(source.track, state.snapshot, "track.pattern_changed"),
          )
        ).id;
      }
      if (eventId === undefined) return;
      await window.desktop.events.assignListener(agentId, eventId, {
        enabled: true,
        responseMode: "next-prompt",
      });
      setSelection({ kind: "wire", sourceId, agentId });
    } catch (error) {
      onError(error, "Could not connect");
    }
  };

  const pointerAt = (event: React.PointerEvent): Point | undefined => {
    const box = stageRef.current?.getBoundingClientRect();
    return box
      ? { x: event.clientX - box.left, y: event.clientY - box.top }
      : undefined;
  };

  const onStagePointerMove = (event: React.PointerEvent): void => {
    const start = dragStart.current;
    if (!start) return;
    if (
      !dragged.current &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4
    )
      return;
    dragged.current = true;
    const pointer = pointerAt(event);
    setConnecting(
      pointer
        ? { sourceId: start.sourceId, pointer }
        : { sourceId: start.sourceId },
    );
  };

  useEffect(() => {
    const release = (event: PointerEvent): void => {
      const start = dragStart.current;
      dragStart.current = undefined;
      if (!start || !dragged.current) return;
      const target = (event.target as Element | null)?.closest?.(
        "[data-agent-id]",
      );
      const agentId = target?.getAttribute("data-agent-id");
      if (agentId) void connect(start.sourceId, agentId);
      else setConnecting(undefined);
    };
    window.addEventListener("pointerup", release);
    return () => window.removeEventListener("pointerup", release);
  });

  const outPort = (source: Source): React.JSX.Element => (
    <button
      type="button"
      className={`wiring-port out ${connecting?.sourceId === source.id ? "hot" : ""}`}
      data-port-out={source.id}
      aria-label={`Connect ${source.name} to an agent`}
      aria-pressed={connecting?.sourceId === source.id}
      disabled={!sessionActive}
      onPointerDown={(event) => {
        dragged.current = false;
        dragStart.current = {
          sourceId: source.id,
          x: event.clientX,
          y: event.clientY,
        };
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        setConnecting((current) =>
          current?.sourceId === source.id ? undefined : { sourceId: source.id },
        );
      }}
    />
  );

  const togglePanel = (kind: "add-agent" | "add-listener" | "add-event") =>
    setSelection((current) => (current?.kind === kind ? undefined : { kind }));

  const selectedWire =
    selection?.kind === "wire"
      ? wires.find(
          (wire) =>
            wire.source.id === selection.sourceId &&
            wire.agent.id === selection.agentId,
        )
      : undefined;
  const isSelectedWire = (wire: Wire): boolean => wire === selectedWire;

  const draftFrom = connecting && geometry.outs[connecting.sourceId];

  return (
    <div className="wiring-view">
      <WiringBar mode="live" onModeChange={onModeChange}>
        <div className="wiring-chips" role="group" aria-label="Show">
          {(Object.keys(FILTER_LABELS) as Filter[]).map((value) => (
            <button
              key={value}
              type="button"
              className="wiring-chip"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {FILTER_LABELS[value]}
            </button>
          ))}
        </div>
        {monitorsAvailable && state.events.monitors.listeners.length > 0 && (
          <ArmAllButton
            monitors={state.events.monitors.listeners}
            disabled={!sessionActive}
            onError={onError}
          />
        )}
        <span className="wiring-spacer" />
        {state.connection.state === "connected" &&
          !state.connection.saved && (
            <span
              className="wiring-muted"
              title="Wiring is kept with a saved Live Set. Untitled sets start fresh."
            >
              Save your Live Set to keep this Wiring
            </span>
          )}
        {inactiveDefinitions.length > 0 && (
          <span className="wiring-muted tabular">
            {inactiveDefinitions.length} inactive{" "}
            {inactiveDefinitions.length === 1 ? "agent" : "agents"} hidden
          </span>
        )}
        <button
          type="button"
          aria-expanded={selection?.kind === "add-agent"}
          disabled={!sessionActive}
          onClick={() => togglePanel("add-agent")}
        >
          Add agent…
        </button>
        {monitorsAvailable && (
          <button
            type="button"
            aria-expanded={selection?.kind === "add-listener"}
            disabled={!sessionActive}
            onClick={() => togglePanel("add-listener")}
          >
            Add listener…
          </button>
        )}
        <button
          type="button"
          aria-expanded={selection?.kind === "add-event"}
          disabled={!sessionActive}
          onClick={() => togglePanel("add-event")}
        >
          Add event…
        </button>
      </WiringBar>
      {!sessionActive && (
        <div className="notice" role="status">
          Wiring controls will be available after the production session is
          restored.
        </div>
      )}
      <div className="wiring-body">
        <div
          className={`wiring-canvas ${connecting ? "connecting" : ""}`}
          onClick={() => {
            if (connecting) setConnecting(undefined);
          }}
        >
          <div
            className="wiring-stage"
            ref={stageRef}
            onPointerMove={onStagePointerMove}
          >
            <svg className="wiring-wires" aria-hidden="true">
              {visibleWires.map((wire) => {
                const from = geometry.outs[wire.source.id];
                const to = geometry.ins[wire.agent.id];
                if (!from || !to) return null;
                const path = wirePath(from, to);
                const className = `line ${wire.listener.responseMode === "next-prompt" ? "next" : ""} ${isSelectedWire(wire) ? "selected" : ""} ${wire.listener.enabled ? "" : "paused"}`;
                return (
                  <g key={wire.listener.id}>
                    <path className={className} d={path} />
                    <path
                      className="hit"
                      d={path}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelection({
                          kind: "wire",
                          sourceId: wire.source.id,
                          agentId: wire.agent.id,
                        });
                      }}
                    />
                  </g>
                );
              })}
              {draftFrom && connecting.pointer && (
                <path
                  className="line draft"
                  d={wirePath(draftFrom, connecting.pointer)}
                />
              )}
            </svg>
            <div className="wiring-column sources">
              <h3 className="wiring-colhead">Monitors</h3>
              {monitorSources.length === 0 ? (
                <p className="wiring-empty">
                  {monitorsAvailable
                    ? "No Machine Listening devices yet. Add a listener to a track to hear its pattern."
                    : "Machine Listening is not available."}
                </p>
              ) : (
                monitorSources.map((source) =>
                  source.kind === "monitor" ? (
                    <MonitorNode
                      key={source.id}
                      source={source}
                      selected={
                        selection?.kind === "source" &&
                        selection.sourceId === source.id
                      }
                      sessionActive={sessionActive}
                      onSelect={() =>
                        setSelection({ kind: "source", sourceId: source.id })
                      }
                      port={outPort(source)}
                      onError={onError}
                    />
                  ) : null,
                )
              )}
              <h3 className="wiring-colhead">Live events</h3>
              {eventSources.length === 0 ? (
                <p className="wiring-empty">
                  No Live Events. Add one to watch a clip or knob.
                </p>
              ) : (
                eventSources.map((source) => (
                  <EventNode
                    key={source.id}
                    source={source}
                    selected={
                      selection?.kind === "source" &&
                      selection.sourceId === source.id
                    }
                    onSelect={() =>
                      setSelection({ kind: "source", sourceId: source.id })
                    }
                    port={outPort(source)}
                  />
                ))
              )}
            </div>
            <div className="wiring-column agents">
              <h3 className="wiring-colhead">Active agents</h3>
              {agents.length === 0 ? (
                <p className="wiring-empty">
                  No agents are running. Add one to give it something to hear.
                </p>
              ) : (
                agents.map((agent) => (
                  <AgentNode
                    key={agent.id}
                    agent={agent}
                    color={agentColor(agent.definitionName)}
                    connectionCount={
                      wires.filter((wire) => wire.agent.id === agent.id).length
                    }
                    connecting={connecting !== undefined}
                    selected={
                      selection?.kind === "agent" &&
                      selection.agentId === agent.id
                    }
                    onClick={() => {
                      if (connecting)
                        void connect(connecting.sourceId, agent.id);
                      else setSelection({ kind: "agent", agentId: agent.id });
                    }}
                  />
                ))
              )}
            </div>
            {visibleWires.map((wire) => {
              const from = geometry.outs[wire.source.id];
              const to = geometry.ins[wire.agent.id];
              if (!from || !to) return null;
              return (
                <WireBadge
                  key={wire.listener.id}
                  wire={wire}
                  at={{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }}
                  selected={isSelectedWire(wire)}
                  onSelect={() =>
                    setSelection({
                      kind: "wire",
                      sourceId: wire.source.id,
                      agentId: wire.agent.id,
                    })
                  }
                />
              );
            })}
          </div>
          <div className="wiring-legend" aria-hidden="true">
            <span>
              <svg viewBox="0 0 28 8">
                <path d="M0 4 H28" className="line" />
              </svg>
              Starts a turn now
            </span>
            <span>
              <svg viewBox="0 0 28 8">
                <path d="M0 4 H28" className="line next" />
              </svg>
              Waits for my next message
            </span>
          </div>
          <p className="wiring-hint" role="status">
            {connecting
              ? "Click an agent to connect · Esc to cancel"
              : "Drag from a source's ● to an agent to connect · Click a wire to edit it"}
          </p>
        </div>
        <aside className="wiring-inspector" aria-label="Wiring details">
          <Inspector
            state={state}
            dispatch={dispatch}
            selection={selection}
            sources={sources}
            wires={wires}
            agents={agents}
            inactiveDefinitions={inactiveDefinitions}
            selectedWire={selectedWire}
            sessionActive={sessionActive}
            agentColor={agentColor}
            renderEventDetails={renderEventDetails}
            onSelect={setSelection}
            onError={onError}
          />
        </aside>
      </div>
    </div>
  );
}

// ── Nodes ────────────────────────────────────────────────────────────────

function MonitorNode({
  source,
  selected,
  sessionActive,
  onSelect,
  port,
  onError,
}: {
  source: Extract<Source, { kind: "monitor" }>;
  selected: boolean;
  sessionActive: boolean;
  onSelect: () => void;
  port: ReactNode;
  onError: ReportError;
}): React.JSX.Element {
  const { busy, setArmed } = useMonitorActions(onError);
  const { monitor } = source;
  const listening = monitorListening(monitor);
  return (
    <div
      className={`wiring-node monitor ${listening ? "" : "off"} ${selected ? "selected" : ""}`}
      style={trackColorStyle(source.track?.color)}
    >
      <div className="wiring-type">
        <Icon name="wave" /> Monitor
        <ArmToggle
          listening={listening}
          label={source.name}
          disabled={!sessionActive || busy || !monitor.ready}
          onToggle={() => setArmed(!listening, [monitor.listenerId])}
        />
      </div>
      <button
        type="button"
        className="wiring-node-main"
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <span className="wiring-node-name" title={source.name}>
          {source.name}
        </span>
        <span className="wiring-node-state">{monitorStateLabel(monitor)}</span>
        <span className="wiring-barcap tabular">
          <span>
            {monitor.lastBar === null ? "" : `bar ${monitor.lastBar}`}
          </span>
          <span>
            {monitor.periodBars === null
              ? ""
              : `${monitor.periodBars}-bar pattern`}
          </span>
        </span>
      </button>
      {port}
    </div>
  );
}

function EventNode({
  source,
  selected,
  onSelect,
  port,
}: {
  source: Extract<Source, { kind: "event" }>;
  selected: boolean;
  onSelect: () => void;
  port: ReactNode;
}): React.JSX.Element {
  const { definition } = source.event;
  const value = latestStateLabel(source.event);
  return (
    <div
      className={`wiring-node event ${definition.enabled ? "" : "off"} ${selected ? "selected" : ""}`}
      style={trackColorStyle(source.track?.color)}
    >
      <button
        type="button"
        className="wiring-node-main"
        aria-pressed={selected}
        title={`${eventKindLabels[definition.kind]}: ${definition.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
      >
        <Icon
          name={definition.kind === "parameter.value_changed" ? "knob" : "bolt"}
        />
        <span className="wiring-node-name">{source.name}</span>
        <span className="wiring-node-value" title={value}>
          {definition.enabled ? value : "Off"}
        </span>
      </button>
      {port}
    </div>
  );
}

function AgentNode({
  agent,
  color,
  connectionCount,
  connecting,
  selected,
  onClick,
}: {
  agent: DesktopActiveAgent;
  color: string;
  connectionCount: number;
  connecting: boolean;
  selected: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`wiring-node agent ${selected ? "selected" : ""} ${connecting ? "target" : ""}`}
      style={{ "--node-color": color } as CSSProperties}
      data-agent-id={agent.id}
    >
      <span className="wiring-port in" data-port-in={agent.id} />
      <div className="wiring-type">
        <Icon name="agent" /> Agent
      </div>
      <button
        type="button"
        className="wiring-node-main"
        aria-pressed={selected}
        aria-label={connecting ? `Connect to ${agent.label}` : undefined}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        <span className="wiring-agent-head">
          <span className="wiring-node-name" title={agent.label}>
            {agent.label}
          </span>
        </span>
        <span className="wiring-row">
          <span
            className={`led ${agentLedClass(agent.lifecycle)}`}
            aria-hidden="true"
          />
          <span>{agent.lifecycle}</span>
          <span className="wiring-muted tabular">
            {connectionCount} {connectionCount === 1 ? "source" : "sources"}
          </span>
        </span>
      </button>
    </div>
  );
}

function WireBadge({
  wire,
  at,
  selected,
  onSelect,
}: {
  wire: Wire;
  at: Point;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { listener } = wire;
  return (
    <button
      type="button"
      className={`wiring-badge ${selected ? "selected" : ""} ${listener.enabled ? "" : "paused"}`}
      style={{ left: at.x, top: at.y }}
      aria-label={`Edit connection ${wire.source.name} to ${wire.agent.label}`}
      aria-pressed={selected}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {listener.responseMode === "automatic" ? (
        <Icon name="bolt" />
      ) : (
        <span aria-hidden="true">↩</span>
      )}
      {listener.messagePrefix && <span aria-hidden="true">✎</span>}
      {listener.when && (
        <span className="tabular" aria-hidden="true">
          {listener.when.length}/{ALL_EPISODES.length}
        </span>
      )}
      {!listener.enabled && <span aria-hidden="true">Paused</span>}
    </button>
  );
}

// ── Inspector ────────────────────────────────────────────────────────────

function Inspector({
  state,
  dispatch,
  selection,
  sources,
  wires,
  agents,
  inactiveDefinitions,
  selectedWire,
  sessionActive,
  agentColor,
  renderEventDetails,
  onSelect,
  onError,
}: {
  state: DesktopState;
  dispatch: DesktopDispatch;
  selection: Selection | undefined;
  sources: readonly Source[];
  wires: readonly Wire[];
  agents: readonly DesktopActiveAgent[];
  inactiveDefinitions: readonly DesktopAgentDefinition[];
  selectedWire: Wire | undefined;
  sessionActive: boolean;
  agentColor: (definitionName: string) => string;
  renderEventDetails: (event: DesktopLiveEventState) => ReactNode;
  onSelect: (selection: Selection | undefined) => void;
  onError: ReportError;
}): React.JSX.Element {
  const close = (): void => onSelect(undefined);
  switch (selection?.kind) {
    case "add-agent":
      return (
        <AddAgentPanel
          definitions={inactiveDefinitions}
          onClose={close}
          onManage={() => dispatch({ type: "view", view: "agents" })}
          onStarted={(agent) => {
            dispatch({
              type: "event",
              event: {
                type: "agent.instance_changed",
                instance: agent,
                change: "created",
              },
            });
            onSelect({ kind: "agent", agentId: agent.id });
          }}
          onError={onError}
        />
      );
    case "add-listener":
      return (
        <AddListenerPanel
          snapshot={state.snapshot}
          monitors={state.events.monitors.listeners}
          onClose={close}
          onError={onError}
        />
      );
    case "add-event":
      return (
        <AddEventPanel
          snapshot={state.snapshot}
          agents={agents}
          agentColor={agentColor}
          onClose={close}
          onCreated={(eventId) =>
            onSelect({ kind: "source", sourceId: `event:${eventId}` })
          }
          onError={onError}
        />
      );
    case "wire":
      if (selectedWire)
        return (
          <WirePanel
            key={selectedWire.listener.id}
            wire={selectedWire}
            snapshot={state.snapshot}
            agentColor={agentColor}
            sessionActive={sessionActive}
            onClose={close}
            onRemoved={() =>
              onSelect({ kind: "source", sourceId: selectedWire.source.id })
            }
            onError={onError}
          />
        );
      break;
    case "source": {
      const source = sources.find(({ id }) => id === selection.sourceId);
      if (source)
        return (
          <SourcePanel
            source={source}
            wires={wires.filter((wire) => wire.source === source)}
            agentColor={agentColor}
            renderEventDetails={renderEventDetails}
            onSelect={onSelect}
            onClose={close}
          />
        );
      break;
    }
    case "agent": {
      const agent = agents.find(({ id }) => id === selection.agentId);
      if (agent)
        return (
          <AgentPanel
            agent={agent}
            color={agentColor(agent.definitionName)}
            wires={wires.filter((wire) => wire.agent === agent)}
            onOpen={() => dispatch({ type: "view", view: "agents" })}
            onSelect={onSelect}
            onClose={close}
          />
        );
      break;
    }
    case undefined:
      break;
  }
  return (
    <div className="wiring-panel">
      <h3>How wiring works</h3>
      <p className="wiring-help">
        Sources on the left notice changes in Live. Wire one to an agent and the
        agent hears about each change.
      </p>
      <p className="wiring-help">
        A <strong>monitor</strong> listens to a track's audio and reports when
        its pattern settles or changes. A <strong>Live event</strong> watches a
        clip or knob.
      </p>
    </div>
  );
}

function PanelHead({
  title,
  onClose,
}: {
  title: ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="wiring-panel-head">
      <h3>{title}</h3>
      <button
        type="button"
        className="wiring-close"
        aria-label="Close panel"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

function Endpoint({
  label,
  icon,
  color,
  name,
}: {
  label: string;
  icon: "wave" | "bolt" | "knob" | "agent";
  color: string | undefined;
  name: string;
}): React.JSX.Element {
  return (
    <div>
      <div className="wiring-sub">{label}</div>
      <div className="wiring-endpoint" style={trackColorStyle(color)}>
        <Icon name={icon} />
        <span className="wiring-node-name" title={name}>
          {name}
        </span>
      </div>
    </div>
  );
}

function sourceIcon(source: Source): "wave" | "bolt" | "knob" {
  if (source.kind === "monitor") return "wave";
  return source.event.definition.kind === "parameter.value_changed"
    ? "knob"
    : "bolt";
}

function ConnectionList({
  wires,
  describe,
  onSelect,
}: {
  wires: readonly Wire[];
  describe: (wire: Wire) => { name: string; color: string | undefined };
  onSelect: (wire: Wire) => void;
}): React.JSX.Element {
  if (wires.length === 0)
    return <p className="wiring-help">Not connected yet.</p>;
  return (
    <div className="wiring-list">
      {wires.map((wire) => {
        const { name, color } = describe(wire);
        return (
          <button
            key={wire.listener.id}
            type="button"
            className="wiring-item"
            style={{ "--c": color } as CSSProperties}
            onClick={() => onSelect(wire)}
          >
            <span className="wiring-grow">{name}</span>
            <span className="wiring-muted">
              {!wire.listener.enabled
                ? "Paused"
                : wire.listener.responseMode === "automatic"
                  ? "Starts a turn"
                  : "Next message"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SourcePanel({
  source,
  wires,
  agentColor,
  renderEventDetails,
  onSelect,
  onClose,
}: {
  source: Source;
  wires: readonly Wire[];
  agentColor: (definitionName: string) => string;
  renderEventDetails: (event: DesktopLiveEventState) => ReactNode;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="wiring-panel">
      <PanelHead
        title={
          <>
            <Icon name={sourceIcon(source)} /> {source.name}
          </>
        }
        onClose={onClose}
      />
      {source.kind === "monitor" && (
        <p className="wiring-help">
          {monitorStateLabel(source.monitor)}
          {source.monitor.periodBars !== null &&
            ` · ${source.monitor.periodBars}-bar pattern`}
        </p>
      )}
      <div>
        <div className="wiring-sub">Connected to</div>
        <ConnectionList
          wires={wires}
          describe={(wire) => ({
            name: wire.agent.label,
            color: agentColor(wire.agent.definitionName),
          })}
          onSelect={(wire) =>
            onSelect({
              kind: "wire",
              sourceId: source.id,
              agentId: wire.agent.id,
            })
          }
        />
      </div>
      {source.event && renderEventDetails(source.event)}
    </div>
  );
}

function AgentPanel({
  agent,
  color,
  wires,
  onOpen,
  onSelect,
  onClose,
}: {
  agent: DesktopActiveAgent;
  color: string;
  wires: readonly Wire[];
  onOpen: () => void;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="wiring-panel">
      <PanelHead
        title={
          <>
            <span
              className="wiring-swatch"
              style={{ "--node-color": color } as CSSProperties}
              aria-hidden="true"
            />{" "}
            {agent.label}
          </>
        }
        onClose={onClose}
      />
      <div>
        <div className="wiring-sub">Hears from</div>
        <ConnectionList
          wires={wires}
          describe={(wire) => ({
            name: wire.source.name,
            color: wire.source.track?.color,
          })}
          onSelect={(wire) =>
            onSelect({
              kind: "wire",
              sourceId: wire.source.id,
              agentId: agent.id,
            })
          }
        />
      </div>
      <div className="wiring-footer">
        <button type="button" onClick={onOpen}>
          Open in Agents
        </button>
      </div>
    </div>
  );
}

function WirePanel({
  wire,
  snapshot,
  agentColor,
  sessionActive,
  onClose,
  onRemoved,
  onError,
}: {
  wire: Wire;
  snapshot: DesktopLiveSetSnapshot | undefined;
  agentColor: (definitionName: string) => string;
  sessionActive: boolean;
  onClose: () => void;
  onRemoved: () => void;
  onError: ReportError;
}): React.JSX.Element {
  const { listener, agent, event, source } = wire;
  const [prompt, setPrompt] = useState(listener.messagePrefix ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(
    () => setPrompt(listener.messagePrefix ?? ""),
    [listener.messagePrefix],
  );
  const update = (
    settings: Parameters<typeof window.desktop.events.updateListener>[2],
  ): void => {
    setBusy(true);
    void window.desktop.events
      .updateListener(agent.id, event.definition.id, settings)
      .catch((error: unknown) => onError(error, "Connection not saved"))
      .finally(() => setBusy(false));
  };
  const disabled = !sessionActive || busy;
  const when = listener.when ?? ALL_EPISODES;
  const isPattern = event.definition.kind === "track.pattern_changed";
  const context = resolvePreparedContextConfiguration(listener.preparedContext);
  const contextTracks =
    context.scope === "selected-tracks" ? context.tracks : [];
  const setContext = (next: PreparedContextConfiguration): void =>
    update({ preparedContext: next });
  const locatorFor = (track: DesktopTrack) =>
    snapshot ? trackLocator(snapshot, track) : undefined;
  const sameLocator = (
    left: { name: string; occurrence: number },
    right: { name: string; occurrence: number } | undefined,
  ): boolean =>
    right !== undefined &&
    left.name === right.name &&
    left.occurrence === right.occurrence;

  return (
    <div className="wiring-panel">
      <PanelHead title={`${source.name} → ${agent.label}`} onClose={onClose} />
      <Endpoint
        label="From"
        icon={sourceIcon(source)}
        color={source.track?.color}
        name={source.name}
      />
      <Endpoint
        label="To"
        icon="agent"
        color={agentColor(agent.definitionName)}
        name={agent.label}
      />
      <div>
        <div className="wiring-sub" id="wire-mode-label">
          How to tell the agent
        </div>
        <div
          className="wiring-seg"
          role="group"
          aria-labelledby="wire-mode-label"
        >
          <button
            type="button"
            aria-pressed={listener.responseMode === "automatic"}
            disabled={disabled}
            onClick={() => update({ responseMode: "automatic" })}
          >
            <Icon name="bolt" /> Start a turn now
          </button>
          <button
            type="button"
            aria-pressed={listener.responseMode === "next-prompt"}
            disabled={disabled}
            onClick={() => update({ responseMode: "next-prompt" })}
          >
            ↩ With my next message
          </button>
        </div>
      </div>
      {isPattern && (
        <fieldset className="wiring-fieldset">
          <legend className="wiring-sub">Tell it when</legend>
          {ALL_EPISODES.map((episode) => {
            const checked = when.includes(episode);
            return (
              <label key={episode} className="wiring-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || (checked && when.length === 1)}
                  onChange={() => {
                    const next = checked
                      ? when.filter((value) => value !== episode)
                      : ALL_EPISODES.filter(
                          (value) => value === episode || when.includes(value),
                        );
                    update({
                      when: next.length === ALL_EPISODES.length ? null : next,
                    });
                  }}
                />
                {EPISODE_LABELS[episode]}
              </label>
            );
          })}
        </fieldset>
      )}
      <label className="wiring-field">
        <span className="wiring-sub">Appended prompt</span>
        <textarea
          value={prompt}
          maxLength={MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH}
          placeholder="Optional. For example: Suggest a matching bassline."
          disabled={disabled}
          onChange={(change) => setPrompt(change.target.value)}
          onBlur={() => {
            const next = prompt.trim();
            if (next === (listener.messagePrefix ?? "")) return;
            update({ messagePrefix: next === "" ? null : next });
          }}
        />
        <span className="wiring-help">
          Added to what the agent receives each time this fires.
        </span>
      </label>
      <details className="wiring-advanced">
        <summary>Advanced</summary>
        <fieldset className="wiring-fieldset">
          <legend className="wiring-sub">Set details sent along</legend>
          <label className="wiring-check">
            <input
              type="radio"
              name={`context-${listener.id}`}
              checked={context.scope === "whole-session"}
              disabled={disabled}
              onChange={() =>
                setContext({
                  scope: "whole-session",
                  includeSessionClips: context.includeSessionClips,
                })
              }
            />
            The whole set
          </label>
          <label className="wiring-check">
            <input
              type="radio"
              name={`context-${listener.id}`}
              checked={context.scope === "selected-tracks"}
              disabled={disabled || !snapshot || snapshot.tracks.length === 0}
              onChange={() => {
                const first = source.track ?? snapshot?.tracks[0];
                const locator = first && locatorFor(first);
                if (!locator) return;
                setContext({
                  scope: "selected-tracks",
                  includeSessionClips: context.includeSessionClips,
                  tracks: [{ track: locator }],
                });
              }}
            />
            Only these tracks
          </label>
          {context.scope === "selected-tracks" && snapshot && (
            <div className="wiring-tracks">
              {snapshot.tracks.map((track) => {
                const locator = trackLocator(snapshot, track);
                const chosen = contextTracks.some(({ track: entry }) =>
                  sameLocator(entry, locator),
                );
                return (
                  <button
                    key={track.id}
                    type="button"
                    className="wiring-track"
                    style={{ "--c": track.color } as CSSProperties}
                    aria-pressed={chosen}
                    disabled={
                      disabled || (chosen && contextTracks.length === 1)
                    }
                    onClick={() =>
                      setContext({
                        scope: "selected-tracks",
                        includeSessionClips: context.includeSessionClips,
                        tracks: chosen
                          ? contextTracks.filter(
                              ({ track: entry }) =>
                                !sameLocator(entry, locator),
                            )
                          : [...contextTracks, { track: locator }],
                      })
                    }
                  >
                    {track.name}
                  </button>
                );
              })}
            </div>
          )}
          <label className="wiring-check">
            <input
              type="checkbox"
              checked={context.includeSessionClips}
              disabled={disabled}
              onChange={(change) =>
                setContext({
                  ...context,
                  includeSessionClips: change.target.checked,
                })
              }
            />
            Include Session clips
          </label>
        </fieldset>
        <p className="wiring-help">
          Listener <code>{listener.id}</code>
        </p>
      </details>
      <div className="wiring-footer">
        <button
          type="button"
          className="danger"
          disabled={disabled}
          onClick={() => {
            setBusy(true);
            void window.desktop.events
              .unassignListener(agent.id, event.definition.id)
              .then(onRemoved)
              .catch((error: unknown) =>
                onError(error, "Connection not removed"),
              )
              .finally(() => setBusy(false));
          }}
        >
          Remove connection
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => update({ enabled: !listener.enabled })}
        >
          {listener.enabled ? "Pause" : "Resume"}
        </button>
      </div>
    </div>
  );
}

// ── Add panels ───────────────────────────────────────────────────────────

function AddAgentPanel({
  definitions,
  onClose,
  onManage,
  onStarted,
  onError,
}: {
  definitions: readonly DesktopAgentDefinition[];
  onClose: () => void;
  onManage: () => void;
  onStarted: (agent: DesktopActiveAgent) => void;
  onError: ReportError;
}): React.JSX.Element {
  const [chosen, setChosen] = useState(definitions[0]?.name);
  const [busy, setBusy] = useState(false);
  return (
    <div className="wiring-panel">
      <PanelHead title="Add agent" onClose={onClose} />
      <p className="wiring-help">
        Start a configured agent so you can wire sources to it.
      </p>
      {definitions.length === 0 ? (
        <p className="wiring-help">
          Every configured agent is already running.
        </p>
      ) : (
        <div className="wiring-list">
          {definitions.map((definition) => (
            <button
              key={definition.name}
              type="button"
              className="wiring-item"
              style={{ "--c": definition.color } as CSSProperties}
              aria-pressed={chosen === definition.name}
              onClick={() => setChosen(definition.name)}
            >
              <span className="wiring-grow">
                <span className="wiring-item-title">
                  {definition.label ?? definition.name}
                </span>
                <span className="wiring-item-detail">
                  {definition.description}
                </span>
              </span>
              <ScopeChip origin={definition.origin} />
            </button>
          ))}
        </div>
      )}
      <div className="wiring-footer">
        <button
          type="button"
          className="primary"
          disabled={busy || chosen === undefined}
          onClick={() => {
            if (chosen === undefined) return;
            setBusy(true);
            void window.desktop.agents
              .create(chosen)
              .then(onStarted)
              .catch((error: unknown) =>
                onError(error, `Could not start ${chosen}`),
              )
              .finally(() => setBusy(false));
          }}
        >
          Start and add
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="wiring-link" onClick={onManage}>
          Manage agents…
        </button>
      </div>
    </div>
  );
}

function useLiveSelection(
  onError: ReportError,
): LiveEventSelection | undefined {
  const [selection, setSelection] = useState<LiveEventSelection>();
  useEffect(() => {
    let current = true;
    void window.desktop.events
      .inspectSelection()
      .then((result) => {
        if (current) setSelection(result);
      })
      .catch((error: unknown) => onError(error, "Live selection not read"));
    return () => {
      current = false;
    };
    // Read the Live selection once when the panel opens.
  }, []);
  return selection;
}

function TrackChips({
  tracks,
  chosen,
  liveTrackId,
  disabledReason,
  onChoose,
}: {
  tracks: readonly DesktopTrack[];
  chosen: string | undefined;
  liveTrackId: string | undefined;
  disabledReason?: (track: DesktopTrack) => string | undefined;
  onChoose: (track: DesktopTrack) => void;
}): React.JSX.Element {
  if (tracks.length === 0)
    return <p className="wiring-help">Open a Live set to see its tracks.</p>;
  return (
    <div className="wiring-tracks" role="group" aria-label="Track">
      {tracks.map((track) => {
        const reason = disabledReason?.(track);
        return (
          <button
            key={track.id}
            type="button"
            className="wiring-track"
            style={{ "--c": track.color } as CSSProperties}
            aria-pressed={chosen === track.id}
            disabled={reason !== undefined}
            onClick={() => onChoose(track)}
          >
            {track.name}
            {reason && <span className="wiring-muted"> · {reason}</span>}
            {track.id === liveTrackId && (
              <span className="wiring-muted"> · ● in Live</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function AddListenerPanel({
  snapshot,
  monitors,
  onClose,
  onError,
}: {
  snapshot: DesktopLiveSetSnapshot | undefined;
  monitors: readonly DesktopMonitor[];
  onClose: () => void;
  onError: ReportError;
}): React.JSX.Element {
  const liveSelection = useLiveSelection(onError);
  const liveTrack = selectionTrack(liveSelection, snapshot);
  const taken = (track: DesktopTrack): string | undefined =>
    monitors.some(({ trackReference }) => trackReference === track.id)
      ? "has one"
      : undefined;
  const [chosen, setChosen] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (chosen === undefined && liveTrack && !taken(liveTrack))
      setChosen(liveTrack.id);
    // Preselect the Live track once it is known.
  }, [liveTrack?.id]);
  return (
    <div className="wiring-panel">
      <PanelHead title="Add listener" onClose={onClose} />
      <p className="wiring-help">
        Adds a Machine Listening device to the end of the track's device chain.
        It hears the track's audio and tells wired agents when its pattern
        settles or changes.
      </p>
      <TrackChips
        tracks={snapshot?.tracks ?? []}
        chosen={chosen}
        liveTrackId={liveTrack?.id}
        disabledReason={taken}
        onChoose={(track) => setChosen(track.id)}
      />
      <details className="wiring-advanced">
        <summary>Advanced</summary>
        <p className="wiring-help">
          Loads the bundled Machine Listening Max for Live device. It starts
          disarmed; arm it here or let an agent arm it.
        </p>
      </details>
      <div className="wiring-footer">
        <button
          type="button"
          className="primary"
          disabled={busy || chosen === undefined}
          onClick={() => {
            if (chosen === undefined) return;
            setBusy(true);
            void window.desktop.monitors
              .add(chosen)
              .then(onClose)
              .catch((error: unknown) => onError(error, "Listener not added"))
              .finally(() => setBusy(false));
          }}
        >
          Add listener
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function highlight(text: string, words: readonly string[]): ReactNode {
  if (words.length === 0) return text;
  const escaped = words.map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  );
  const pattern = new RegExp(`(${escaped.join("|")})`, "giu");
  return text
    .split(pattern)
    .map((part, index) =>
      index % 2 === 1 ? <mark key={index}>{part}</mark> : part,
    );
}

interface ParameterChoice {
  trackId: string;
  deviceId: string;
  parameterId: string;
}

function ParameterSearch({
  snapshot,
  chosen,
  onChoose,
}: {
  snapshot: DesktopLiveSetSnapshot | undefined;
  chosen: ParameterChoice | undefined;
  onChoose: (choice: ParameterChoice) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [macrosOnly, setMacrosOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const { matches, hidden } = useMemo(
    () => searchParameters(snapshot, query, { macrosOnly, showHidden }),
    [snapshot, query, macrosOnly, showHidden],
  );
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const shown = matches.slice(0, PARAMETER_RESULT_LIMIT);
  const rows: ReactNode[] = [];
  let lastTrack: string | undefined;
  let lastDevice: string | undefined;
  shown.forEach((match: ParameterMatch) => {
    if (match.track.id !== lastTrack) {
      lastTrack = match.track.id;
      lastDevice = undefined;
      rows.push(
        <div
          key={`t:${match.track.id}`}
          className="wiring-ptrack"
          style={{ "--c": match.track.color } as CSSProperties}
        >
          {highlight(match.track.name, words)}
        </div>,
      );
    }
    if (match.device.id !== lastDevice) {
      lastDevice = match.device.id;
      rows.push(
        <div key={`d:${match.device.id}`} className="wiring-pdev">
          {match.macro && "Rack macros · "}
          {highlight(match.device.name, words)}
        </div>,
      );
    }
    const selected =
      chosen?.parameterId === match.parameter.id &&
      chosen.deviceId === match.device.id;
    rows.push(
      <button
        key={`p:${match.device.id}:${match.parameter.id}`}
        type="button"
        className="wiring-prow"
        aria-pressed={selected}
        aria-label={`${match.track.name} ${match.device.name} ${match.parameter.name}, ${match.parameter.displayValue}`}
        onClick={() =>
          onChoose({
            trackId: match.track.id,
            deviceId: match.device.id,
            parameterId: match.parameter.id,
          })
        }
      >
        {match.macro ? (
          <span className="wiring-mtag" aria-hidden="true">
            M
          </span>
        ) : (
          <Icon name="knob" />
        )}
        <span className="wiring-pn">
          {highlight(match.parameter.name, words)}
        </span>
        <span className="wiring-meter" aria-hidden="true">
          <i style={{ width: `${Math.round(match.parameter.value * 100)}%` }} />
        </span>
        <span className="wiring-pvalue tabular">
          {match.parameter.displayValue}
        </span>
      </button>,
    );
  });
  return (
    <div className="wiring-psearch">
      <input
        type="search"
        aria-label="Search track, device or knob"
        placeholder="Search track, device or knob…"
        value={query}
        onChange={(change) => setQuery(change.target.value)}
      />
      <div className="wiring-chips" role="group" aria-label="Knob filter">
        <button
          type="button"
          className="wiring-chip"
          aria-pressed={!macrosOnly}
          onClick={() => setMacrosOnly(false)}
        >
          All
        </button>
        <button
          type="button"
          className="wiring-chip"
          aria-pressed={macrosOnly}
          onClick={() => setMacrosOnly(true)}
        >
          Macros
        </button>
      </div>
      <div className="wiring-presults" role="group" aria-label="Knobs">
        {rows.length === 0 ? (
          <p className="wiring-empty">No knobs match.</p>
        ) : (
          rows
        )}
      </div>
      <p className="wiring-pfoot tabular">
        {shown.length < matches.length
          ? `First ${shown.length} of ${matches.length} shown`
          : `${matches.length} shown`}
        {(hidden > 0 || showHidden) && (
          <>
            {" · "}
            {showHidden
              ? "unnamed macros and on/off switches shown "
              : `${hidden} unnamed macros and on/off switches hidden `}
            <button
              type="button"
              className="wiring-link"
              onClick={() => setShowHidden((value) => !value)}
            >
              {showHidden ? "Hide" : "Show"}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function AddEventPanel({
  snapshot,
  agents,
  agentColor,
  onClose,
  onCreated,
  onError,
}: {
  snapshot: DesktopLiveSetSnapshot | undefined;
  agents: readonly DesktopActiveAgent[];
  agentColor: (definitionName: string) => string;
  onClose: () => void;
  onCreated: (eventId: string) => void;
  onError: ReportError;
}): React.JSX.Element {
  const liveSelection = useLiveSelection(onError);
  const liveTrack = selectionTrack(liveSelection, snapshot);
  const [mode, setMode] = useState<"clip" | "knob">("clip");
  const [trackId, setTrackId] = useState<string>();
  const [clipKind, setClipKind] = useState<(typeof clipEventKinds)[number]>(
    "track.playing_clip_changed",
  );
  const [parameter, setParameter] = useState<ParameterChoice>();
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const chosenTrackId = trackId ?? liveTrack?.id;
  const liveParameter = liveSelection?.parameter ?? null;
  const liveParameterChoice: ParameterChoice | undefined = liveParameter
    ? {
        trackId: liveParameter.expectedReference,
        deviceId: liveParameter.expectedDeviceReference,
        parameterId: liveParameter.expectedParameterReference,
      }
    : undefined;
  const liveParameterDraft =
    liveParameterChoice && snapshot
      ? parameterDraftFromSnapshot(
          snapshot,
          liveParameterChoice.trackId,
          liveParameterChoice.deviceId,
          liveParameterChoice.parameterId,
        )
      : undefined;

  const draft: LiveEventDefinitionDraft | undefined = !snapshot
    ? undefined
    : mode === "clip"
      ? (() => {
          const track = snapshot.tracks.find(({ id }) => id === chosenTrackId);
          return track ? trackDraft(track, snapshot, clipKind) : undefined;
        })()
      : parameter
        ? parameterDraftFromSnapshot(
            snapshot,
            parameter.trackId,
            parameter.deviceId,
            parameter.parameterId,
          )
        : undefined;

  const create = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      const created = await window.desktop.events.create(draft);
      for (const agentId of agentIds)
        await window.desktop.events.assignListener(agentId, created.id, {
          enabled: true,
          responseMode: "next-prompt",
        });
      onCreated(created.id);
    } catch (error) {
      onError(error, "Event not added");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wiring-panel">
      <PanelHead title="Add event" onClose={onClose} />
      <div className="wiring-seg" role="group" aria-label="Watch">
        <button
          type="button"
          aria-pressed={mode === "clip"}
          onClick={() => setMode("clip")}
        >
          <Icon name="bolt" /> Clip
        </button>
        <button
          type="button"
          aria-pressed={mode === "knob"}
          onClick={() => setMode("knob")}
        >
          <Icon name="knob" /> Knob or macro
        </button>
      </div>
      {mode === "clip" ? (
        <>
          <TrackChips
            tracks={snapshot?.tracks ?? []}
            chosen={chosenTrackId}
            liveTrackId={liveTrack?.id}
            onChoose={(track) => setTrackId(track.id)}
          />
          <div className="wiring-list" role="group" aria-label="Clip event">
            {clipEventKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                className="wiring-item"
                aria-pressed={clipKind === kind}
                onClick={() => setClipKind(kind)}
              >
                <Icon name="bolt" />
                <span className="wiring-grow">
                  <span className="wiring-item-title">
                    {eventKindLabels[kind]}
                  </span>
                  <span className="wiring-item-detail">
                    {CLIP_KIND_HELP[kind]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {liveParameterDraft && liveParameterChoice && (
            <div className="wiring-shortcut">
              <span className="wiring-grow">
                <span className="wiring-sub">Selected in Live</span>
                <span className="wiring-item-title">
                  {liveParameterDraft.name}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setParameter(liveParameterChoice)}
              >
                Use it
              </button>
            </div>
          )}
          <p className="wiring-help">
            Click any knob in Live and it shows up here.
          </p>
          <ParameterSearch
            snapshot={snapshot}
            chosen={parameter}
            onChoose={setParameter}
          />
        </>
      )}
      {agents.length > 0 && (
        <fieldset className="wiring-fieldset">
          <legend className="wiring-sub">Connect to (optional)</legend>
          <div className="wiring-connect">
            {agents.map((agent) => (
              <label
                key={agent.id}
                style={
                  { "--c": agentColor(agent.definitionName) } as CSSProperties
                }
              >
                <input
                  type="checkbox"
                  checked={agentIds.includes(agent.id)}
                  onChange={(change) =>
                    setAgentIds((current) =>
                      change.target.checked
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id),
                    )
                  }
                />
                {agent.label}
              </label>
            ))}
          </div>
          <p className="wiring-help">
            New connections wait for your next message. Click the wire to change
            that.
          </p>
        </fieldset>
      )}
      <div className="wiring-footer">
        <button
          type="button"
          className="primary"
          disabled={busy || draft === undefined}
          onClick={() => void create()}
        >
          Add event
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
