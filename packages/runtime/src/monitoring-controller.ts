import { randomUUID } from "node:crypto";
import type {
  ListeningExecutionContext,
  ListeningMonitoringPort,
} from "@ableton-agent/application";
import type { NonBlockingObservabilityRecorder } from "@ableton-agent/observability";
import {
  MonitoringObserver,
  type ListeningFeature,
  type ListeningMusicalAlignment,
  type MonitoringEpisode,
} from "@ableton-agent/protocol";
import { recordSignalTelemetry } from "@ableton-agent/signal-routing";
import type { MetricRecordStagedSink } from "./metric-record-ingestion.js";
import {
  createMonitoringStreamSink,
  MONITORING_MATCH_THRESHOLD,
  monitoringFeatureDistance,
} from "./monitoring-stream.js";

export type MonitoringView = Awaited<
  ReturnType<ListeningMonitoringPort["read"]>
>;
type ViewEpisode = MonitoringView["episodes"][number]["episode"];
type MonitoringStatus = MonitoringView["status"];

export interface MonitoringPassPlan {
  readonly startBeat: number;
  readonly endBeat: number;
  readonly alignment: ListeningMusicalAlignment;
  readonly tracks: readonly {
    readonly listenerId: string;
    readonly trackReference: string;
  }[];
}

export interface MonitoringPassHandle {
  readonly result: Promise<unknown>;
  readonly nativeLaunch: Promise<void>;
  disarm(): Promise<void>;
}

/** One new episode on one monitored track, pushed to subscribers as it seals. */
export interface MonitoringUpdate {
  readonly sequence: number;
  readonly listenerId: string;
  readonly trackReference: string | null;
  readonly episode: ViewEpisode;
  readonly track: MonitoringView["tracks"][number];
}

export interface MonitoringControllerDependencies {
  /** Inspect a stopped transport and plan one pass from the playhead. */
  plan(input: {
    readonly listenerIds: readonly string[];
    readonly context: ListeningExecutionContext;
  }): Promise<MonitoringPassPlan>;
  arm(input: {
    readonly plan: MonitoringPassPlan;
    readonly passId: string;
    readonly sink: MetricRecordStagedSink;
    readonly context: ListeningExecutionContext;
  }): Promise<MonitoringPassHandle>;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly pollMs?: number;
}

export interface MonitoringRegistry extends ListeningMonitoringPort {
  /** Current state without waiting. */
  snapshot(): MonitoringView;
  /** Receives every new episode and every status change. */
  subscribe(
    listener: (update: MonitoringUpdate | undefined) => void,
  ): () => void;
  shutdown(): Promise<void>;
}

const WAITING_FOR_STOP = new Set([
  "transport_not_safe_to_start",
  "transport_not_stopped",
  "listener_not_idle",
]);
const WAIT_STEP_MS = 100;
const MAX_EPISODES = 1024;
const PAGE_EPISODES = 256;

interface Monitor {
  readonly listenerId: string;
  readonly observer: MonitoringObserver<ListeningFeature>;
  trackReference: string | null;
  /** Armed while a pass was already playing; joins at the next stop. */
  pending: boolean;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function viewEpisode(episode: MonitoringEpisode): ViewEpisode {
  switch (episode.kind) {
    case "pattern-established":
    case "fill":
      return { ...episode, maxDistance: finite(episode.maxDistance) };
    case "pattern-changed":
      return { ...episode, distances: episode.distances.map(finite) };
    default:
      return { ...episode };
  }
}

function codeOf(cause: unknown): string {
  return cause instanceof Error && "code" in cause
    ? String((cause as { code: unknown }).code)
    : cause instanceof Error
      ? cause.name
      : "unknown";
}

function messageOf(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 512);
}

/**
 * Shared monitors for the whole app. Agents and the GUI arm or disarm tracks;
 * one loop arms a pass for every armed track and re-arms after each stop.
 */
export function createMonitoringController(
  dependencies: MonitoringControllerDependencies,
): MonitoringRegistry {
  const pollMs = dependencies.pollMs ?? 500;
  const monitors = new Map<string, Monitor>();
  const episodes: {
    sequence: number;
    listenerId: string;
    trackReference: string | null;
    episode: ViewEpisode;
  }[] = [];
  const subscribers = new Set<(update: MonitoringUpdate | undefined) => void>();
  let status: MonitoringStatus = "off";
  let startBeat: number | null = null;
  let nextSequence = 0;
  let error: string | undefined;
  let context: ListeningExecutionContext | undefined;
  let abort: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let handle: MonitoringPassHandle | undefined;
  let launched = false;
  let replan = false;
  let settled: (() => void)[] = [];

  const record = (
    name: string,
    attributes: Record<string, unknown>,
    outcome?: "success" | "failure" | "cancelled",
  ) =>
    recordSignalTelemetry(dependencies.telemetry, {
      name: `listening.monitoring.${name}`,
      source: "monitoring-controller",
      ...(context === undefined
        ? {}
        : {
            sessionId: context.sessionId,
            activeAgentId: context.agentId,
            correlationId: context.trace.correlationId,
            causationId: context.trace.causationId,
            trace: { traceId: context.trace.traceId, spanId: randomUUID() },
          }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(outcome === "failure" ? { level: "error" as const } : {}),
      attributes,
    });

  const trackView = (monitor: Monitor) => {
    const snapshot = monitor.observer.snapshot();
    return {
      trackReference: monitor.trackReference,
      listenerId: monitor.listenerId,
      pending: monitor.pending,
      state: snapshot.state,
      periodBars: snapshot.periodBars,
      patternVersion: snapshot.patternVersion,
      lastBar: snapshot.lastBar,
      lastDistance:
        snapshot.lastDistance === null ? null : finite(snapshot.lastDistance),
    };
  };

  const notify = (update?: MonitoringUpdate) => {
    for (const subscriber of subscribers) {
      try {
        subscriber(update);
      } catch (cause) {
        record("subscriber-failed", { error: messageOf(cause) }, "failure");
      }
    }
  };

  const setStatus = (next: MonitoringStatus) => {
    if (status === next) return;
    status = next;
    if (next !== "rearming") {
      const waiters = settled;
      settled = [];
      for (const resolve of waiters) resolve();
    }
    notify();
  };

  const append = (monitor: Monitor, items: readonly MonitoringEpisode[]) => {
    for (const episode of items) {
      const item = {
        sequence: nextSequence++,
        listenerId: monitor.listenerId,
        trackReference: monitor.trackReference,
        episode: viewEpisode(episode),
      };
      episodes.push(item);
      record("episode", item);
      notify({ ...item, track: trackView(monitor) });
    }
    if (episodes.length > MAX_EPISODES)
      episodes.splice(0, episodes.length - MAX_EPISODES);
  };

  const close = (monitor: Monitor, reason: string) => {
    if (monitor.observer.snapshot().state !== "closed")
      append(monitor, monitor.observer.close(reason));
  };

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  const run = async (signal: AbortSignal) => {
    while (!signal.aborted && monitors.size > 0) {
      const passContext = { ...context!, signal };
      for (const monitor of monitors.values()) monitor.pending = false;
      replan = false;
      let pass: MonitoringPassPlan;
      try {
        pass = await dependencies.plan({
          listenerIds: [...monitors.keys()],
          context: passContext,
        });
      } catch (cause) {
        if (signal.aborted) break;
        if (!WAITING_FOR_STOP.has(codeOf(cause))) throw cause;
        setStatus("waiting");
        await sleep(pollMs, signal);
        continue;
      }
      if (signal.aborted) break;
      if (replan) continue;
      for (const track of pass.tracks) {
        const monitor = monitors.get(track.listenerId);
        if (monitor !== undefined)
          monitor.trackReference = track.trackReference;
      }
      const barBeats =
        (pass.alignment.meter.numerator * 4) / pass.alignment.meter.denominator;
      const sealed = new Map<string, number>();
      const sink = createMonitoringStreamSink({
        alignment: pass.alignment,
        observer: (listenerId) => monitors.get(listenerId)?.observer,
        onBar: (report) => {
          sealed.set(
            report.listenerId,
            (sealed.get(report.listenerId) ?? 0) + 1,
          );
          const monitor = monitors.get(report.listenerId);
          if (monitor !== undefined) append(monitor, report.episodes);
        },
      });
      const passId = randomUUID();
      startBeat = pass.startBeat;
      launched = false;
      handle = await dependencies.arm({
        plan: pass,
        passId,
        sink,
        context: passContext,
      });
      record("armed", {
        passId,
        startBeat: pass.startBeat,
        endBeat: pass.endBeat,
        listenerIds: pass.tracks.map(({ listenerId }) => listenerId),
      });
      if (replan) {
        // Tracks changed while this pass was being armed.
        await handle.disarm().catch(() => {});
      } else {
        setStatus("armed");
      }
      void handle.nativeLaunch.then(
        () => {
          launched = true;
          if (status === "armed") setStatus("monitoring");
        },
        () => {},
      );
      let failure: unknown;
      try {
        await handle.result;
      } catch (cause) {
        failure = cause;
      }
      handle = undefined;
      if (signal.aborted) break;
      const bars = Math.max(0, ...sealed.values());
      record(
        "pass-ended",
        {
          passId,
          launched,
          barsSealed: bars,
          passBars: Math.round((pass.endBeat - pass.startBeat) / barBeats),
          replan,
          ...(failure === undefined
            ? {}
            : { code: codeOf(failure), error: messageOf(failure) }),
        },
        failure === undefined || replan ? "success" : "failure",
      );
      if (launched || bars > 0)
        for (const monitor of monitors.values())
          append(
            monitor,
            monitor.observer.interrupt("transport-stopped", null),
          );
      setStatus("rearming");
    }
  };

  const start = () => {
    error = undefined;
    abort = new AbortController();
    const signal = abort.signal;
    setStatus("rearming");
    const current = run(signal).then(
      () => {
        if (signal.aborted) return;
        startBeat = null;
        setStatus("off");
      },
      (cause: unknown) => {
        if (signal.aborted) return;
        error = messageOf(cause);
        for (const monitor of monitors.values()) close(monitor, "failed");
        monitors.clear();
        startBeat = null;
        record("failed", { code: codeOf(cause), error }, "failure");
        setStatus("failed");
      },
    );
    loop = current;
  };

  /** Resolves once the loop leaves "rearming" (armed, waiting, off or failed). */
  const untilSettled = () =>
    status === "rearming"
      ? new Promise<void>((resolve) => settled.push(resolve))
      : Promise.resolve();

  const stopLoop = async () => {
    abort?.abort();
    await handle?.disarm().catch(() => {});
    await loop;
    abort = undefined;
    loop = undefined;
    handle = undefined;
    startBeat = null;
  };

  const view = (afterSequence = -1): MonitoringView => {
    const page = episodes
      .filter((item) => item.sequence > afterSequence)
      .slice(0, PAGE_EPISODES);
    return {
      status,
      startBeat,
      tracks: [...monitors.values()].map(trackView),
      episodes: structuredClone(page),
      // The cursor to pass back as afterSequence: the last delivered episode.
      nextSequence: page.length === 0 ? afterSequence : page.at(-1)!.sequence,
      ...(error === undefined ? {} : { error }),
    };
  };

  return {
    async arm(request, armingContext) {
      context = {
        sessionId: armingContext.sessionId,
        agentId: armingContext.agentId,
        trace: armingContext.trace,
        ...(armingContext.actorKind
          ? { actorKind: armingContext.actorKind }
          : {}),
      };
      const added = request.listenerIds.filter((id) => !monitors.has(id));
      const playing = handle !== undefined && launched;
      for (const listenerId of added)
        monitors.set(listenerId, {
          listenerId,
          trackReference: null,
          pending: playing,
          observer: new MonitoringObserver<ListeningFeature>({
            distance: monitoringFeatureDistance,
            maxWindowBars: request.maxWindowBars ?? 8,
            matchThreshold: MONITORING_MATCH_THRESHOLD,
          }),
        });
      record("arm-requested", {
        listenerIds: request.listenerIds,
        added,
        playing,
        actorKind: armingContext.actorKind ?? "agent",
      });
      if (added.length === 0) return view();
      if (loop === undefined || status === "failed" || status === "off") {
        start();
      } else if (handle !== undefined && !launched) {
        // Not playing yet: re-plan now so the new tracks join this pass.
        replan = true;
        setStatus("rearming");
        await handle.disarm().catch(() => {});
      } else if (!playing) {
        replan = true;
      }
      if (!playing) await untilSettled();
      return view();
    },
    async read({ afterSequence, waitMs = 0, signal } = {}) {
      const deadline = Date.now() + waitMs;
      while (
        Date.now() < deadline &&
        signal?.aborted !== true &&
        monitors.size > 0 &&
        !episodes.some(({ sequence }) => sequence > (afterSequence ?? -1))
      )
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(WAIT_STEP_MS, deadline - Date.now())),
        );
      return view(afterSequence);
    },
    async disarm(listenerIds, disarmingContext) {
      const removed = (listenerIds ?? [...monitors.keys()]).filter((id) =>
        monitors.has(id),
      );
      record("disarm-requested", {
        listenerIds: listenerIds ?? null,
        removed,
        actorKind: disarmingContext.actorKind ?? "agent",
      });
      for (const listenerId of removed) {
        close(monitors.get(listenerId)!, "stopped");
        monitors.delete(listenerId);
      }
      if (monitors.size === 0) {
        if (loop !== undefined) {
          await stopLoop();
          record("stopped", { removed }, "cancelled");
        }
        setStatus("off");
      } else if (removed.length > 0 && handle !== undefined && !launched) {
        replan = true;
        setStatus("rearming");
        await handle.disarm().catch(() => {});
        await untilSettled();
      }
      return view();
    },
    snapshot: () => view(),
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async shutdown() {
      await stopLoop();
      monitors.clear();
      status = "off";
      subscribers.clear();
    },
  };
}
