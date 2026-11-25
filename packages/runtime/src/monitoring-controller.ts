import { randomUUID } from "node:crypto";
import {
  ListeningFailure,
  type ListeningExecutionContext,
  type ListeningMonitoringPort,
  type ListeningOwner,
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

type MonitoringView = Awaited<ReturnType<ListeningMonitoringPort["get"]>>;
type ViewEpisode = MonitoringView["episodes"][number]["episode"];

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

export interface MonitoringControllerDependencies {
  /** Inspect a stopped transport and plan one pass of at most maxBars from the playhead. */
  plan(input: {
    readonly listenerIds: readonly string[];
    readonly maxBars: number;
    readonly owner: ListeningOwner;
    readonly context: ListeningExecutionContext;
  }): Promise<MonitoringPassPlan>;
  arm(input: {
    readonly plan: MonitoringPassPlan;
    readonly passId: string;
    readonly sink: MetricRecordStagedSink;
    readonly owner: ListeningOwner;
    readonly context: ListeningExecutionContext;
  }): Promise<MonitoringPassHandle>;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly pollMs?: number;
  /** Consecutive passes that never launched before monitoring gives up. */
  readonly maxIdlePasses?: number;
}

const WAITING_FOR_STOP = new Set([
  "transport_not_safe_to_start",
  "transport_not_stopped",
  "listener_not_idle",
]);
const ACTIVE = new Set(["armed", "monitoring", "rearming"]);
const WAIT_STEP_MS = 100;
const MAX_EPISODES = 1024;
const PAGE_EPISODES = 256;

interface Monitoring {
  readonly id: string;
  readonly owner: ListeningOwner;
  readonly context: ListeningExecutionContext;
  readonly maxBars: number;
  readonly observers: Map<string, MonitoringObserver<ListeningFeature>>;
  readonly trackReferences: Map<string, string>;
  readonly abort: AbortController;
  readonly episodes: {
    sequence: number;
    trackReference: string;
    episode: ViewEpisode;
  }[];
  status: MonitoringView["status"];
  startBeat: number;
  barsRemaining: number;
  nextSequence: number;
  handle?: MonitoringPassHandle;
  error?: string;
  loop?: Promise<void>;
  onArmed?: () => void;
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

/** One open-ended monitoring at a time; re-arms after stops until maxBars or stop. */
export function createMonitoringController(
  dependencies: MonitoringControllerDependencies,
): ListeningMonitoringPort & { shutdown(): Promise<void> } {
  const all = new Map<string, Monitoring>();
  const pollMs = dependencies.pollMs ?? 500;
  const maxIdlePasses = dependencies.maxIdlePasses ?? 5;

  const record = (
    monitoring: Monitoring,
    name: string,
    attributes: Record<string, unknown>,
    outcome?: "success" | "failure" | "cancelled",
  ) =>
    recordSignalTelemetry(dependencies.telemetry, {
      name: `listening.monitoring.${name}`,
      source: "monitoring-controller",
      sessionId: monitoring.owner.sessionId,
      activeAgentId: monitoring.owner.agentId,
      liveSetId: monitoring.owner.liveSetId,
      correlationId: monitoring.context.trace.correlationId,
      causationId: monitoring.context.trace.causationId,
      trace: {
        traceId: monitoring.context.trace.traceId,
        spanId: randomUUID(),
      },
      ...(outcome === undefined ? {} : { outcome }),
      ...(outcome === "failure" ? { level: "error" as const } : {}),
      attributes: { monitoringId: monitoring.id, ...attributes },
    });

  const append = (
    monitoring: Monitoring,
    listenerId: string,
    episodes: readonly MonitoringEpisode[],
  ) => {
    const trackReference = monitoring.trackReferences.get(listenerId)!;
    for (const episode of episodes) {
      const item = {
        sequence: monitoring.nextSequence++,
        trackReference,
        episode: viewEpisode(episode),
      };
      monitoring.episodes.push(item);
      record(monitoring, "episode", { listenerId, ...item });
    }
    if (monitoring.episodes.length > MAX_EPISODES)
      monitoring.episodes.splice(0, monitoring.episodes.length - MAX_EPISODES);
  };

  const interruptAll = (
    monitoring: Monitoring,
    reason: "transport-stopped",
  ) => {
    for (const [listenerId, observer] of monitoring.observers)
      append(monitoring, listenerId, observer.interrupt(reason, null));
  };

  const closeAll = (monitoring: Monitoring, reason: string) => {
    for (const [listenerId, observer] of monitoring.observers)
      if (observer.snapshot().state !== "closed")
        append(monitoring, listenerId, observer.close(reason));
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

  const run = async (monitoring: Monitoring, first: MonitoringPassPlan) => {
    const signal = monitoring.abort.signal;
    const context = { ...monitoring.context, signal };
    let plan: MonitoringPassPlan | undefined = first;
    let idlePasses = 0;
    while (!signal.aborted && monitoring.barsRemaining > 0) {
      if (plan === undefined) {
        try {
          plan = await dependencies.plan({
            listenerIds: [...monitoring.observers.keys()],
            maxBars: monitoring.barsRemaining,
            owner: monitoring.owner,
            context,
          });
        } catch (cause) {
          if (signal.aborted) break;
          if (!WAITING_FOR_STOP.has(codeOf(cause))) throw cause;
          await sleep(pollMs, signal);
          continue;
        }
      }
      const pass = plan;
      plan = undefined;
      const barBeats =
        (pass.alignment.meter.numerator * 4) / pass.alignment.meter.denominator;
      const sealed = new Map<string, number>();
      const sink = createMonitoringStreamSink({
        alignment: pass.alignment,
        observer: (listenerId) => monitoring.observers.get(listenerId)!,
        onBar: (report) => {
          sealed.set(
            report.listenerId,
            (sealed.get(report.listenerId) ?? 0) + 1,
          );
          append(monitoring, report.listenerId, report.episodes);
        },
      });
      const passId = randomUUID();
      monitoring.startBeat = pass.startBeat;
      monitoring.handle = await dependencies.arm({
        plan: pass,
        passId,
        sink,
        owner: monitoring.owner,
        context,
      });
      monitoring.status = "armed";
      monitoring.onArmed?.();
      record(monitoring, "armed", {
        passId,
        startBeat: pass.startBeat,
        endBeat: pass.endBeat,
        barsRemaining: monitoring.barsRemaining,
      });
      let launched = false;
      void monitoring.handle.nativeLaunch.then(
        () => {
          launched = true;
          if (monitoring.status === "armed") monitoring.status = "monitoring";
        },
        () => {},
      );
      let failure: unknown;
      try {
        await monitoring.handle.result;
      } catch (cause) {
        failure = cause;
      }
      delete monitoring.handle;
      const bars = Math.max(0, ...sealed.values());
      const passBars = Math.round((pass.endBeat - pass.startBeat) / barBeats);
      monitoring.barsRemaining = Math.max(
        0,
        monitoring.barsRemaining - (failure === undefined ? passBars : bars),
      );
      if (signal.aborted) break;
      record(
        monitoring,
        "pass-ended",
        {
          passId,
          launched,
          barsSealed: bars,
          barsRemaining: monitoring.barsRemaining,
          ...(failure === undefined
            ? {}
            : { code: codeOf(failure), error: messageOf(failure) }),
        },
        failure === undefined ? "success" : "failure",
      );
      if (monitoring.barsRemaining === 0) break;
      idlePasses = launched || bars > 0 ? 0 : idlePasses + 1;
      if (idlePasses >= maxIdlePasses)
        throw new ListeningFailure(
          "monitoring_idle",
          `Playback did not start during ${idlePasses} consecutive armed passes`,
        );
      monitoring.status = "rearming";
      if (launched || bars > 0) interruptAll(monitoring, "transport-stopped");
    }
  };

  const owned = (monitoringId: string, owner: ListeningOwner) => {
    const monitoring = all.get(monitoringId);
    if (
      monitoring === undefined ||
      monitoring.owner.sessionId !== owner.sessionId ||
      monitoring.owner.agentId !== owner.agentId
    )
      throw new ListeningFailure(
        "permission_denied",
        "No monitoring belongs to the invoking App session and agent",
      );
    return monitoring;
  };

  const view = (monitoring: Monitoring, afterSequence = -1): MonitoringView => {
    const episodes = monitoring.episodes
      .filter((item) => item.sequence > afterSequence)
      .slice(0, PAGE_EPISODES);
    return {
      monitoringId: monitoring.id,
      status: monitoring.status,
      startBeat: monitoring.startBeat,
      maxBars: monitoring.maxBars,
      barsRemaining: monitoring.barsRemaining,
      tracks: [...monitoring.observers].map(([listenerId, observer]) => {
        const snapshot = observer.snapshot();
        return {
          trackReference: monitoring.trackReferences.get(listenerId)!,
          listenerId,
          state: snapshot.state,
          periodBars: snapshot.periodBars,
          patternVersion: snapshot.patternVersion,
          lastBar: snapshot.lastBar,
          lastDistance:
            snapshot.lastDistance === null
              ? null
              : finite(snapshot.lastDistance),
        };
      }),
      episodes: structuredClone(episodes),
      // The cursor to pass back as afterSequence: the last delivered episode.
      nextSequence:
        episodes.length === 0 ? afterSequence : episodes.at(-1)!.sequence,
      ...(monitoring.error === undefined ? {} : { error: monitoring.error }),
    };
  };

  const finish = async (monitoring: Monitoring) => {
    await monitoring.handle?.disarm().catch(() => {});
    await monitoring.loop;
  };

  return {
    async start(request, owner, context) {
      const active = [...all.values()].find((item) =>
        ["armed", "monitoring", "rearming"].includes(item.status),
      );
      if (active !== undefined)
        throw new ListeningFailure(
          "monitoring_active",
          `Monitoring ${active.id} is still active; stop it first`,
        );
      const first = await dependencies.plan({
        listenerIds: request.listenerIds,
        maxBars: request.maxBars,
        owner,
        context,
      });
      const monitoring: Monitoring = {
        id: randomUUID(),
        owner: { ...owner },
        context: {
          sessionId: context.sessionId,
          agentId: context.agentId,
          trace: context.trace,
          ...(context.actorKind ? { actorKind: context.actorKind } : {}),
        },
        maxBars: request.maxBars,
        observers: new Map(
          request.listenerIds.map((listenerId) => [
            listenerId,
            new MonitoringObserver<ListeningFeature>({
              distance: monitoringFeatureDistance,
              maxWindowBars: request.maxWindowBars,
              matchThreshold: MONITORING_MATCH_THRESHOLD,
            }),
          ]),
        ),
        trackReferences: new Map(
          first.tracks.map((track) => [track.listenerId, track.trackReference]),
        ),
        abort: new AbortController(),
        episodes: [],
        status: "rearming",
        startBeat: first.startBeat,
        barsRemaining: request.maxBars,
        nextSequence: 0,
      };
      all.set(monitoring.id, monitoring);
      record(monitoring, "started", {
        listenerIds: request.listenerIds,
        maxBars: request.maxBars,
        maxWindowBars: request.maxWindowBars,
        startBeat: first.startBeat,
      });
      const armed = new Promise<void>((resolve) => {
        monitoring.onArmed = resolve;
      });
      monitoring.loop = run(monitoring, first).then(
        () => {
          if (monitoring.status === "stopped") return;
          monitoring.status = "completed";
          closeAll(monitoring, "max-bars");
          record(monitoring, "completed", { barsRemaining: 0 }, "success");
        },
        (cause: unknown) => {
          if (monitoring.status === "stopped") return;
          monitoring.status = "failed";
          monitoring.error = messageOf(cause);
          closeAll(monitoring, "failed");
          record(
            monitoring,
            "failed",
            { code: codeOf(cause), error: monitoring.error },
            "failure",
          );
        },
      );
      void monitoring.loop.finally(() => monitoring.onArmed?.());
      await armed;
      return view(monitoring);
    },
    async get(monitoringId, owner, { afterSequence, waitMs = 0, signal } = {}) {
      const monitoring = owned(monitoringId, owner);
      const deadline = Date.now() + waitMs;
      while (
        Date.now() < deadline &&
        signal?.aborted !== true &&
        ACTIVE.has(monitoring.status) &&
        !monitoring.episodes.some(
          ({ sequence }) => sequence > (afterSequence ?? -1),
        )
      )
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(WAIT_STEP_MS, deadline - Date.now())),
        );
      return view(monitoring, afterSequence);
    },
    async stop(monitoringId, owner) {
      const monitoring = owned(monitoringId, owner);
      if (ACTIVE.has(monitoring.status)) {
        monitoring.status = "stopped";
        monitoring.abort.abort();
        await finish(monitoring);
        closeAll(monitoring, "stopped");
        record(
          monitoring,
          "stopped",
          {
            barsRemaining: monitoring.barsRemaining,
          },
          "cancelled",
        );
      }
      return view(monitoring);
    },
    async shutdown() {
      for (const monitoring of all.values()) {
        if (ACTIVE.has(monitoring.status)) monitoring.status = "stopped";
        monitoring.abort.abort();
        await finish(monitoring);
      }
    },
  };
}
