import type {
  AgentEventListener,
  PreparedContextConfiguration,
} from "@ableton-agent/agent-config";
import { resolvePreparedContextConfiguration } from "@ableton-agent/agent-config";
import type { PreparedContextProvider } from "@ableton-agent/application";
import type {
  NonBlockingObservabilityRecorder,
  SanitizedAttributes,
} from "@ableton-agent/observability";
import type { SessionSnapshot } from "@ableton-agent/protocol";
import {
  recordSignalTelemetry,
  stableTelemetryId,
} from "@ableton-agent/signal-routing";
import type {
  AppEvent,
  ConnectionStatus,
  EventPublisher,
  Logger,
} from "@ableton-agent/shared";
import { noopLogger } from "@ableton-agent/shared";

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_REFRESH_DEBOUNCE_MS = 100;
const WHOLE_SESSION_TRACK_LIMIT = 16;
const SESSION_CLIP_LIMIT = 128;
const TRACK_DEVICE_LIMIT = 32;

interface PreparedProjectFacts {
  readonly status: Extract<ConnectionStatus, { state: "connected" }>;
  readonly snapshot: SessionSnapshot;
  readonly capturedAt: string;
  readonly projectRevision?: number;
}

export interface PreparedProjectContextStoreOptions {
  readonly events: EventPublisher;
  readonly getAbletonStatus: () => Promise<ConnectionStatus>;
  readonly inspectSession: () => Promise<SessionSnapshot>;
  readonly getProjectRevision?: () => number | undefined;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly refreshDebounceMs?: number;
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
}

export type PreparedContextCacheStatus =
  | { readonly state: "unavailable" }
  | {
      readonly state: "fresh" | "stale";
      readonly capturedAt: string;
      readonly liveSetId: string;
      readonly projectRevision?: number;
      readonly unresolvedTrackLocators?: number;
    };

function configurationKey(configuration: PreparedContextConfiguration): string {
  return JSON.stringify(configuration);
}

export class PreparedProjectContextStore implements PreparedContextProvider {
  readonly #events: EventPublisher;
  readonly #getAbletonStatus: () => Promise<ConnectionStatus>;
  readonly #inspectSession: () => Promise<SessionSnapshot>;
  readonly #getProjectRevision: (() => number | undefined) | undefined;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #refreshDebounceMs: number;
  readonly #telemetry:
    Pick<NonBlockingObservabilityRecorder, "enqueue"> | undefined;
  readonly #materialized = new Map<string, string>();
  #status: ConnectionStatus = { state: "disconnected" };
  #facts: PreparedProjectFacts | undefined;
  #stale = true;
  #refreshPromise: Promise<void> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshAgain = false;
  #unsubscribe: (() => void) | undefined;
  #invalidationVersion = 0;
  #lifecycleVersion = 0;

  public constructor(options: PreparedProjectContextStoreOptions) {
    this.#events = options.events;
    this.#getAbletonStatus = options.getAbletonStatus;
    this.#inspectSession = options.inspectSession;
    this.#getProjectRevision = options.getProjectRevision;
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
    this.#refreshDebounceMs = Math.max(
      0,
      options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS,
    );
    this.#telemetry = options.telemetry;
  }

  public start(): void {
    this.#unsubscribe ??= this.#events.subscribe((event) =>
      this.#handleEvent(event),
    );
  }

  public stop(): void {
    this.#lifecycleVersion += 1;
    this.#refreshAgain = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#refreshTimer !== undefined) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    this.#clear();
  }

  public warm(): Promise<void> {
    return this.refresh();
  }

  public refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) {
      this.#record("project-context.refresh.coalesced", {
        invalidationVersion: this.#invalidationVersion,
      });
      return this.#refreshPromise;
    }
    this.#refreshPromise = this.#refresh().finally(() => {
      this.#refreshPromise = undefined;
      if (this.#refreshAgain) {
        this.#refreshAgain = false;
        this.#scheduleRefresh();
      }
    });
    return this.#refreshPromise;
  }

  public getPreparedContext(
    agentInstanceId: string,
    listener?: AgentEventListener,
  ): string {
    if (this.#isExpired()) {
      this.#stale = true;
      this.#materialized.clear();
      void this.refresh();
    }
    const configuration = resolvePreparedContextConfiguration(
      listener?.preparedContext,
    );
    const key = `${agentInstanceId}\u0000${listener?.id ?? "default"}\u0000${configurationKey(configuration)}`;
    const cached = this.#materialized.get(key);
    if (cached !== undefined) {
      this.#record("project-context.cache.hit", {
        state: this.#stale ? "stale" : "fresh",
        scope: configuration.scope,
        ...this.#diagnostics(configuration),
      });
      return cached;
    }
    const materialized = this.#materialize(configuration);
    this.#materialized.set(key, materialized);
    this.#record(
      this.#facts === undefined
        ? "project-context.cache.miss"
        : this.#stale
          ? "project-context.cache.served-stale"
          : "project-context.cache.materialized",
      {
        scope: configuration.scope,
        ...this.#diagnostics(configuration),
      },
    );
    return materialized;
  }

  public getStatus(listener?: AgentEventListener): PreparedContextCacheStatus {
    const facts = this.#facts;
    if (facts === undefined) return { state: "unavailable" };
    const configuration = resolvePreparedContextConfiguration(
      listener?.preparedContext,
    );
    const unresolvedTrackLocators =
      configuration.scope === "selected-tracks"
        ? configuration.tracks.filter(({ track: locator }) => {
            const matches = facts.snapshot.tracks.filter(
              ({ name }) => name === locator.name,
            );
            return matches[locator.occurrence] === undefined;
          }).length
        : 0;
    return {
      state: this.#stale || this.#isExpired() ? "stale" : "fresh",
      capturedAt: facts.capturedAt,
      liveSetId: facts.status.liveSetId,
      ...(facts.projectRevision === undefined
        ? {}
        : { projectRevision: facts.projectRevision }),
      ...(unresolvedTrackLocators === 0 ? {} : { unresolvedTrackLocators }),
    };
  }

  async #refresh(): Promise<void> {
    const startedAt = Date.now();
    const lifecycleVersion = this.#lifecycleVersion;
    this.#record("project-context.refresh.started", {
      invalidationVersion: this.#invalidationVersion,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const invalidationVersion = this.#invalidationVersion;
        const status = await this.#getAbletonStatus();
        if (lifecycleVersion !== this.#lifecycleVersion) return;
        this.#status = status;
        if (status.state !== "connected") {
          this.#clear();
          return;
        }
        const snapshot = await this.#inspectSession();
        if (lifecycleVersion !== this.#lifecycleVersion) return;
        const latestStatus = await this.#getAbletonStatus();
        if (
          latestStatus.state !== "connected" ||
          latestStatus.liveSetId !== status.liveSetId
        ) {
          this.#status = latestStatus;
          this.#clear();
          return;
        }
        if (
          invalidationVersion !== this.#invalidationVersion &&
          attempt === 0
        ) {
          continue;
        }
        const projectRevision = this.#getProjectRevision?.();
        this.#facts = {
          status,
          snapshot,
          capturedAt: this.#now().toISOString(),
          ...(projectRevision === undefined ? {} : { projectRevision }),
        };
        this.#stale = invalidationVersion !== this.#invalidationVersion;
        this.#materialized.clear();
        this.#record(
          "project-context.refresh.completed",
          {
            projectId: status.liveSetId,
            invalidationVersion: this.#invalidationVersion,
            stale: this.#stale,
          },
          Date.now() - startedAt,
        );
        return;
      }
    } catch (error) {
      this.#stale = true;
      this.#record(
        "project-context.refresh.failed",
        {
          error: error instanceof Error ? error.message : String(error),
          invalidationVersion: this.#invalidationVersion,
        },
        Date.now() - startedAt,
        "failure",
      );
      this.#logger.warn("Prepared Ableton context refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleEvent(event: AppEvent): void {
    if (event.type === "ableton.connection_changed") {
      const previousLiveSetId =
        this.#status.state === "connected" ? this.#status.liveSetId : undefined;
      this.#status = event.status;
      if (event.status.state !== "connected") {
        this.#invalidationVersion += 1;
        this.#clear();
        return;
      }
      if (
        previousLiveSetId !== undefined &&
        previousLiveSetId !== event.status.liveSetId
      ) {
        this.#clear();
      }
      this.#invalidationVersion += 1;
      this.#stale = true;
      this.#materialized.clear();
      this.#scheduleRefresh();
      return;
    }
    if (event.type === "ableton.event_gap") {
      this.#invalidationVersion += 1;
      this.#stale = true;
      this.#materialized.clear();
      this.#scheduleRefresh();
      return;
    }
    if (event.type === "ableton.project_mutated") {
      this.#invalidationVersion += 1;
      this.#stale = true;
      this.#materialized.clear();
      this.#scheduleRefresh();
      return;
    }
    if (event.type !== "ableton.event_received") return;
    const cachedRevision = this.#facts?.projectRevision;
    if (
      event.event === "live_set.changed" ||
      (event.projectRevision !== undefined &&
        (cachedRevision === undefined ||
          event.projectRevision > cachedRevision))
    ) {
      this.#invalidationVersion += 1;
      this.#stale = true;
      this.#materialized.clear();
      this.#scheduleRefresh();
    }
  }

  #scheduleRefresh(): void {
    if (this.#refreshPromise !== undefined) {
      this.#refreshAgain = true;
      return;
    }
    if (this.#refreshTimer !== undefined) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.refresh();
    }, this.#refreshDebounceMs);
    this.#refreshTimer.unref?.();
  }

  #record(
    name: string,
    attributes: SanitizedAttributes,
    durationMs?: number,
    outcome: "success" | "failure" = "success",
  ): void {
    if (this.#telemetry === undefined) return;
    const traceId = stableTelemetryId(
      `live-set-context:${this.#status.state === "connected" ? this.#status.liveSetId : "disconnected"}:${this.#invalidationVersion}`,
    );
    recordSignalTelemetry(this.#telemetry, {
      name,
      source: "project-context-store",
      level: outcome === "failure" ? "warn" : "debug",
      outcome,
      ...(durationMs === undefined ? {} : { durationMs }),
      trace: {
        traceId,
        spanId: stableTelemetryId(`${traceId}:${name}:${Date.now()}`),
      },
      attributes,
    });
  }

  #clear(): void {
    this.#facts = undefined;
    this.#stale = true;
    this.#materialized.clear();
  }

  #isExpired(): boolean {
    if (this.#facts === undefined) return false;
    return (
      this.#now().getTime() - Date.parse(this.#facts.capturedAt) >= this.#ttlMs
    );
  }

  #diagnostics(
    configuration: PreparedContextConfiguration,
  ): SanitizedAttributes {
    const facts = this.#facts;
    if (facts === undefined) {
      return {
        stateAgeExpired: false,
        selectedTrackCount: 0,
        sessionClipCount: 0,
        hasExactTrackReferences: false,
        hasExactSessionClipReferences: false,
        tracksTruncated: false,
        sessionClipsTruncated: false,
        unresolvedTrackLocatorCount: 0,
      };
    }
    const snapshot = facts.snapshot;
    const selectedTracks =
      configuration.scope === "whole-session"
        ? snapshot.tracks.slice(0, WHOLE_SESSION_TRACK_LIMIT)
        : configuration.tracks.flatMap(({ track: locator }) => {
            const matches = snapshot.tracks.filter(
              ({ name }) => name === locator.name,
            );
            const track = matches[locator.occurrence];
            return track === undefined ? [] : [track];
          });
    const selectedReferences = new Set(
      selectedTracks.map(({ reference }) => reference),
    );
    const matchingClips = configuration.includeSessionClips
      ? (snapshot.clips ?? []).filter(
          ({ trackReference }) =>
            configuration.scope === "whole-session" ||
            selectedReferences.has(trackReference),
        )
      : [];
    const unresolvedTrackLocatorCount =
      configuration.scope === "selected-tracks"
        ? configuration.tracks.length - selectedTracks.length
        : 0;
    const selectedDevices = selectedTracks.flatMap(({ devices }) =>
      (devices ?? []).slice(0, TRACK_DEVICE_LIMIT),
    );
    return {
      contextAgeMs: Math.max(
        0,
        this.#now().getTime() - Date.parse(facts.capturedAt),
      ),
      ...(facts.projectRevision === undefined
        ? {}
        : { projectRevision: facts.projectRevision }),
      stateAgeExpired: this.#isExpired(),
      selectedTrackCount: selectedTracks.length,
      deviceCount: selectedDevices.length,
      deviceListsTruncated: selectedTracks.some(
        (track) =>
          track.devicesTruncated === true ||
          (track.devices?.length ?? 0) > TRACK_DEVICE_LIMIT,
      ),
      sessionClipCount: Math.min(matchingClips.length, SESSION_CLIP_LIMIT),
      hasExactTrackReferences: selectedTracks.length > 0,
      hasExactSessionClipReferences: matchingClips.length > 0,
      tracksTruncated:
        configuration.scope === "whole-session" &&
        snapshot.tracks.length > selectedTracks.length,
      sessionClipsTruncated: matchingClips.length > SESSION_CLIP_LIMIT,
      unresolvedTrackLocatorCount,
    };
  }

  #materialize(configuration: PreparedContextConfiguration): string {
    const facts = this.#facts;
    if (facts === undefined) {
      if (this.#status.state !== "connected") {
        return `Ableton connection: ${this.#status.state}. Prepared project context is unavailable.`;
      }
      return `Ableton connection: connected to Live Set ${this.#status.liveSetId}. Prepared Live Set context is warming; entity identities are not available in this snapshot.`;
    }
    const selectedTracks =
      configuration.scope === "whole-session"
        ? facts.snapshot.tracks.slice(0, WHOLE_SESSION_TRACK_LIMIT)
        : configuration.tracks.flatMap(({ track: locator }) => {
            const matches = facts.snapshot.tracks.filter(
              ({ name }) => name === locator.name,
            );
            const track = matches[locator.occurrence];
            return track === undefined ? [] : [track];
          });
    const selectedReferences = new Set(
      selectedTracks.map(({ reference }) => reference),
    );
    const clips = configuration.includeSessionClips
      ? (facts.snapshot.clips ?? [])
          .filter(
            ({ trackReference }) =>
              configuration.scope === "whole-session" ||
              selectedReferences.has(trackReference),
          )
          .slice(0, SESSION_CLIP_LIMIT)
      : [];
    const unresolvedTrackLocators =
      configuration.scope === "selected-tracks"
        ? configuration.tracks
            .filter(({ track: locator }) => {
              const matches = facts.snapshot.tracks.filter(
                ({ name }) => name === locator.name,
              );
              return matches[locator.occurrence] === undefined;
            })
            .map(({ track }) => track)
        : [];
    const ageMs = Math.max(
      0,
      this.#now().getTime() - Date.parse(facts.capturedAt),
    );
    const tracks = selectedTracks.map((track) => ({
      index: track.index,
      reference: track.reference,
      name: track.name,
      kind: track.kind,
      muted: track.isMuted,
      soloed: track.isSoloed,
      armed: track.isArmed,
      devices: (track.devices ?? [])
        .slice(0, TRACK_DEVICE_LIMIT)
        .map((device) => ({
          index: device.index,
          reference: device.reference,
          name: device.name,
          className: device.className,
          classDisplayName: device.classDisplayName,
          enabled: device.enabled,
          parameterCount: device.parameterCount,
        })),
      devicesTruncated:
        track.devicesTruncated === true ||
        (track.devices?.length ?? 0) > TRACK_DEVICE_LIMIT,
    }));
    const sessionClips = clips.map((clip) => ({
      reference: clip.reference,
      trackReference: clip.trackReference,
      trackIndex: clip.trackIndex,
      sceneIndex: clip.sceneIndex,
      name: clip.name,
      kind: clip.kind,
    }));
    return [
      "Prepared Ableton Live Set context (cached; freshness describes mutable state age, not exact identity validity. Use complete exact identities directly with identity guards when sufficient):",
      JSON.stringify({
        liveSetId: facts.status.liveSetId,
        ...(facts.projectRevision === undefined
          ? {}
          : { projectRevision: facts.projectRevision }),
        capturedAt: facts.capturedAt,
        freshness: this.#stale || this.#isExpired() ? "stale" : "fresh",
        identityPolicy: "guarded-exact-reference",
        ageMs,
        tempo: facts.snapshot.tempo,
        timeSignature: `${facts.snapshot.timeSignature.numerator}/${facts.snapshot.timeSignature.denominator}`,
        isPlaying: facts.snapshot.isPlaying,
        scope: configuration.scope,
        tracks,
        tracksTruncated:
          configuration.scope === "whole-session" &&
          facts.snapshot.tracks.length > selectedTracks.length,
        unresolvedTrackLocators,
        includeSessionClips: configuration.includeSessionClips,
        sessionClips,
        sessionClipsTruncated:
          configuration.includeSessionClips &&
          (facts.snapshot.clips ?? []).filter(
            ({ trackReference }) =>
              configuration.scope === "whole-session" ||
              selectedReferences.has(trackReference),
          ).length > clips.length,
      }),
    ].join("\n");
  }
}
