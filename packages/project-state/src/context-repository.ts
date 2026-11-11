import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { BindParams, Database, SqlJsStatic } from "sql.js";
import {
  storedObservationCoordinates,
  storedObservationIdentity,
  extractListeningFeatures,
  segmentListeningObservation,
  LISTENING_FEATURE_LIMITS,
  LISTENING_FEATURE_DEFINITION_SET,
  listeningFeatureDefinition,
  compareListeningFeatures,
} from "@ableton-agent/protocol";
import {
  contextSegmentSchema,
  contextFeatureSchema,
  contextFeatureDerivationSchema,
  contextFeatureQuerySchema,
  contextFeatureSearchSchema,
  type ContextSegment,
  type ContextFeature,
  type ContextFeatureDerivation,
  type ContextFeatureQuery,
  type ContextFeatureSearch,
  type ContextFeatureSearchResult,
} from "./context-feature-schemas.js";
import {
  createNonBlockingObservabilityRecorder,
  OBSERVABILITY_CONTRACT_VERSION,
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
  type NonBlockingObservabilityRecorder,
  type TelemetryEventRecorder,
} from "@ableton-agent/observability";
import {
  appendContextPassSchema,
  CONTEXT_LIMITS,
  SESSION_CONTEXT_STORE_REFERENCE,
  contextEntrySchema,
  contextFreshnessAssessmentSchema,
  contextLinkSchema,
  contextPruneSchema,
  contextQuerySchema,
  contextSubjectSchema,
  contextTraceSchema,
  listeningPassSchema,
  type AppendContextPass,
  type ContextEntry,
  type ContextFreshnessAssessment,
  type ContextLink,
  type ContextPrune,
  type ContextQuery,
  type ContextSubject,
  type ContextTrace,
  type ListeningPass,
  type SessionContextStoreReference,
} from "./context-schemas.js";
import { RepositoryConflictError } from "./repository.js";
import {
  acquireDatabaseLock,
  loadSqlJs,
  releaseDatabaseLock,
  syncDirectory,
} from "./sqlite.js";

export class ContextQuotaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextQuotaError";
  }
}

export interface ContextOperationOptions {
  readonly signal?: AbortSignal;
  readonly trace?: ContextTrace;
  readonly activeAgentId?: string;
}

interface FeatureReadBudget {
  remaining: number;
  assessments?: Map<string, Promise<ContextFreshnessAssessment>>;
  primaryLinks?: Map<string, ContextLink>;
}

type ObservationSummary<T> = T extends unknown
  ? T extends {
      schema: "metric-audio-observation/v1";
      geometry: infer G;
      metrics: infer M;
    }
    ? Omit<T, "geometry" | "metrics" | "rows"> & {
        readonly geometry: Omit<G, "rows">;
        readonly metrics: {
          readonly [K in keyof M]: Omit<M[K], "records"> & {
            readonly retainedRecords: number;
          };
        };
      }
    : Omit<T, "samples" | "attacks">
  : never;
export type ContextEntrySummary = Omit<ContextEntry, "payload"> & {
  readonly payload: ObservationSummary<ContextEntry["payload"]>;
};

export interface ContextPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface ContextPruneResult {
  readonly deletedPasses: number;
  readonly deletedEntries: number;
  readonly deletedLinks: number;
  readonly deletedSubjects: number;
}

export interface EntityContextRepository {
  readonly sessionId: string;
  readonly liveSetId: string;
  /** Process-local opened-store identity shared by caller wrappers, never across reopen/ownership changes.
   * Without an explicit token, publication uses the repository object's identity. */
  readonly publicationIdentity?: object;
  deriveFeatures(
    entryId: string,
    options?: ContextOperationOptions,
  ): Promise<ContextFeatureDerivation>;
  getFeatureDerivation(
    entryId: string,
    options?: ContextOperationOptions,
  ): Promise<ContextFeatureDerivation | undefined>;
  getFeature(
    id: string,
    options?: ContextOperationOptions,
  ): Promise<ContextFeature | undefined>;
  getSegment(
    id: string,
    options?: ContextOperationOptions,
  ): Promise<ContextSegment | undefined>;
  listFeatures(
    query?: ContextFeatureQuery,
    options?: ContextOperationOptions,
  ): Promise<ContextPage<ContextFeature>>;
  searchFeatures(
    query: ContextFeatureSearch,
    options?: ContextOperationOptions,
  ): Promise<ContextFeatureSearchResult>;
  appendPass(
    input: AppendContextPass,
    options?: ContextOperationOptions,
  ): Promise<void>;
  getPass(
    id: string,
    options?: ContextOperationOptions,
  ): Promise<ListeningPass | undefined>;
  listPasses(
    query?: ContextQuery,
    options?: ContextOperationOptions,
  ): Promise<ContextPage<ListeningPass>>;
  getEntry(
    id: string,
    options?: ContextOperationOptions,
  ): Promise<ContextEntry | undefined>;
  listEntries(
    query?: ContextQuery,
    options?: ContextOperationOptions,
  ): Promise<ContextPage<ContextEntrySummary>>;
  getSubject(
    id: string,
    options?: ContextOperationOptions,
  ): Promise<ContextSubject | undefined>;
  getLink(
    id: string,
    options?: ContextOperationOptions,
  ): Promise<ContextLink | undefined>;
  listLinks(
    query?: ContextQuery,
    options?: ContextOperationOptions,
  ): Promise<ContextPage<ContextLink>>;
  assessLink(
    id: string,
    assessment: ContextFreshnessAssessment,
    options: ContextOperationOptions,
  ): Promise<void>;
  reservePass(
    passId: string,
    bytes: number,
    options?: ContextOperationOptions,
  ): Promise<void>;
  releaseReservation(
    passId: string,
    options?: ContextOperationOptions,
  ): Promise<void>;
  transitionLiveSetOwnership(
    toLiveSetId: string,
    options?: ContextOperationOptions,
  ): Promise<void>;
  prune(
    selection: ContextPrune,
    options?: ContextOperationOptions,
  ): Promise<ContextPruneResult>;
  close(): Promise<void>;
}

export interface SessionContextStoreOptions {
  readonly path?: string;
  readonly sessionId: string;
  readonly liveSetId: string;
  readonly recorder?: TelemetryEventRecorder;
  readonly maxStoreBytes?: number;
  readonly maxPassBytes?: number;
  readonly maxPendingOperations?: number;
  readonly maxFeatureSearchBytes?: number;
  readonly maxFeatureSearchMs?: number;
  readonly maxFeatureBytes?: number;
  readonly maxFeatureBatchBytes?: number;
  readonly clock?: () => Date;
  readonly trace?: ContextTrace;
  readonly signal?: AbortSignal;
  /** Idempotently publish the existing application registry and ownership manifest, not observations. */
  readonly publishSessionContext?: (
    request: SessionContextPublicationRequest,
  ) => Promise<void>;
  /** Current reads may claim fresh only after this privileged application check. */
  readonly revalidate?: (
    subject: ContextSubject,
    link: ContextLink,
    options: ContextOperationOptions,
  ) => Promise<ContextFreshnessAssessment>;
}

export interface SessionContextPublicationRequest {
  readonly sessionId: string;
  readonly liveSetId: string;
  readonly contextStore: SessionContextStoreReference;
  readonly trace: ContextTrace;
  readonly activeAgentId: string;
  readonly signal?: AbortSignal;
}

function sanitizeStrings(value: unknown, field?: string): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizePersistedText(value);
    // Redaction can expand Session target names beyond their 128-character contract.
    return field === "expectedName" || field === "expectedClipName"
      ? sanitized.slice(0, 128)
      : sanitized;
  }
  if (Array.isArray(value)) return value.map((child) => sanitizeStrings(child));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        sanitizePersistedText(key),
        sanitizeStrings(child, key),
      ]),
    );
  }
  return value;
}

function rows(
  database: Database,
  sql: string,
  parameters: BindParams = [],
): Record<string, unknown>[] {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const result: Record<string, unknown>[] = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function decode<T>(value: unknown, parse: (value: unknown) => T): T {
  if (typeof value !== "string")
    throw new TypeError("Context store contains invalid payload text");
  return parse(sanitizeStrings(parse(JSON.parse(value) as unknown)));
}

const parseSubject = (value: unknown): ContextSubject =>
  contextSubjectSchema.parse(value);
const parseEntry = (value: unknown): ContextEntry =>
  contextEntrySchema.parse(value);
const parseLink = (value: unknown): ContextLink =>
  contextLinkSchema.parse(value);
const parsePass = (value: unknown): ListeningPass =>
  listeningPassSchema.parse(value);

function omitFields<T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy;
}

function summarizeObservation(
  observation: ContextEntry["payload"],
): ContextEntrySummary["payload"] {
  if (observation.schema === "metric-audio-observation/v1") {
    const { geometry, metrics } = observation;
    const summarizeMetric = <T extends { records: readonly unknown[] }>(
      metric: T,
    ): Omit<T, "records"> & { retainedRecords: number } => {
      const { records, ...summary } = metric;
      return { ...summary, retainedRecords: records.length };
    };
    return {
      ...omitFields(observation, "rows", "geometry", "metrics"),
      geometry: omitFields(geometry, "rows"),
      metrics: {
        level: summarizeMetric(metrics.level),
        "spectral-centroid": summarizeMetric(metrics["spectral-centroid"]),
        attacks: summarizeMetric(metrics.attacks),
      },
    };
  }
  switch (observation.schema) {
    case "session-audio-observation/v1":
      return omitFields(observation, "samples", "attacks");
    case "audio-observation/v2":
      return omitFields(observation, "samples", "attacks");
    case "audio-observation/v1":
      return omitFields(observation, "samples", "attacks");
  }
}

function queryFingerprint(
  query: ReturnType<typeof contextQuerySchema.parse>,
): string {
  const filters = { ...query };
  delete filters.cursor;
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

function count(database: Database, table: string): number {
  return Number(
    rows(database, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0,
  );
}

function recorderFor(
  recorder: TelemetryEventRecorder | undefined,
): NonBlockingObservabilityRecorder | undefined {
  return recorder === undefined
    ? undefined
    : createNonBlockingObservabilityRecorder({
        enqueue: (event) => recorder.enqueue(event),
        enqueueConfigurationSnapshot: () => undefined,
      });
}

function lifecycleEmitter(
  recorder: NonBlockingObservabilityRecorder | undefined,
  owner: { sessionId: string; liveSetId: string },
  action: string,
  trace: ContextTrace,
  now: () => string,
  activeAgentId?: string,
): (
  stage: string,
  durationMs?: number,
  attributes?: Record<string, unknown>,
) => void {
  let cause = trace.causationId;
  return (stage, durationMs, attributes = {}) => {
    const eventId = randomUUID();
    recorder?.enqueue({
      version: OBSERVABILITY_CONTRACT_VERSION,
      id: eventId,
      occurredAt: now(),
      name: `context.${action}.${stage}`,
      category: "context",
      source: "project-state",
      stage,
      level: stage === "failed" ? "error" : "info",
      outcome:
        stage === "completed"
          ? "success"
          : stage === "failed"
            ? "failure"
            : stage === "cancelled"
              ? "cancelled"
              : "unknown",
      ...(durationMs === undefined ? {} : { durationMs }),
      correlationId: trace.correlationId,
      causationId: cause,
      sessionId: owner.sessionId,
      liveSetId: owner.liveSetId,
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      trace: { traceId: trace.traceId, spanId: eventId },
      attributes: sanitizeTelemetryAttributes(attributes),
    });
    cause = eventId;
  };
}

function newTrace(): ContextTrace {
  return {
    traceId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
  };
}

const TABLES = ["subjects", "passes", "entries", "links"] as const;
type Table = (typeof TABLES)[number];
const DERIVATION_STATUS_BYTES = 2048;
const FEATURE_DEFINITION_SET = LISTENING_FEATURE_DEFINITION_SET;
const hashIdentity = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function derivationState(
  entryId: string,
  status: ContextFeatureDerivation["status"],
  reason: string | null = null,
  featureIds: string[] = [],
): ContextFeatureDerivation {
  return contextFeatureDerivationSchema.parse({
    entryId,
    status,
    reason,
    featureIds,
    definitionSet: FEATURE_DEFINITION_SET,
  });
}

function migrate(
  database: Database,
  sessionId: string,
  liveSetId: string,
): void {
  const version = Number(
    rows(database, "PRAGMA user_version")[0]?.user_version ?? 0,
  );
  if (version > 3)
    throw new Error("Context store schema version is unsupported");
  database.run("PRAGMA foreign_keys = ON");
  if (version === 0) {
    const existing = rows(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    if (existing.length > 0)
      throw new Error("Unrecognized context store cannot be migrated");
    database.run(`
      BEGIN IMMEDIATE;
      CREATE TABLE context_owner (session_id TEXT PRIMARY KEY, live_set_id TEXT NOT NULL);
      CREATE TABLE context_subjects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE context_passes (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE context_entries (
        id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES context_passes(id) ON DELETE CASCADE,
        listener_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE context_links (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL REFERENCES context_subjects(id), freshness TEXT NOT NULL,
        start_beat REAL NOT NULL, end_beat REAL NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX context_pass_time ON context_passes(created_at, id);
      CREATE INDEX context_entry_pass ON context_entries(pass_id, created_at, id);
      CREATE INDEX context_entry_listener ON context_entries(listener_id, created_at, id);
      CREATE INDEX context_link_subject ON context_links(subject_id, entry_id);
      CREATE INDEX context_link_freshness ON context_links(freshness, start_beat, end_beat);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    database.run("INSERT INTO context_owner VALUES (?, ?)", [
      sessionId,
      liveSetId,
    ]);
  }
  if (version < 2) {
    database.run(`
      BEGIN IMMEDIATE;
      CREATE TABLE context_live_set_ownership (live_set_id TEXT PRIMARY KEY);
      INSERT INTO context_live_set_ownership SELECT live_set_id FROM context_owner;
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (version < 3) {
    database.run(`
      BEGIN IMMEDIATE;
      CREATE TABLE context_segments (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, live_set_id TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX context_segment_source ON context_segments(session_id, live_set_id, entry_id, id);
      CREATE TABLE context_features (
        id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES context_segments(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, live_set_id TEXT NOT NULL,
        feature_type TEXT NOT NULL, distance_definition TEXT NOT NULL,
        config_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, dimensions INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE(entry_id, segment_id, feature_type, config_id, source_fingerprint)
      );
      CREATE INDEX context_feature_search ON context_features(session_id, live_set_id, feature_type, status, id);
      CREATE INDEX context_feature_source ON context_features(entry_id, id);
      CREATE TABLE context_feature_derivations (
        entry_id TEXT PRIMARY KEY REFERENCES context_entries(id) ON DELETE CASCADE,
        status TEXT NOT NULL, payload TEXT NOT NULL
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
  const owner = rows(
    database,
    "SELECT session_id, live_set_id FROM context_owner",
  );
  if (
    owner.length !== 1 ||
    owner[0]?.session_id !== sessionId ||
    owner[0]?.live_set_id !== liveSetId
  ) {
    throw new RepositoryConflictError(
      "Context store belongs to another App session or Live Set",
    );
  }
  if (rows(database, "PRAGMA integrity_check")[0]?.integrity_check !== "ok") {
    throw new Error("Context store integrity check failed");
  }
  if (rows(database, "PRAGMA foreign_key_check").length > 0) {
    throw new Error("Context store link integrity check failed");
  }
}

/** Independent of journal enablement/retention, using the same SQL/lock/publication infrastructure. */
export class SessionContextStore implements EntityContextRepository {
  public readonly sessionId: string;
  #liveSetId: string;
  readonly #sql: SqlJsStatic;
  #database: Database;
  readonly #path: string | undefined;
  readonly #lock: FileHandle | undefined;
  readonly #options: SessionContextStoreOptions;
  readonly #recorder: NonBlockingObservabilityRecorder | undefined;
  readonly #maxStoreBytes: number;
  readonly #maxPassBytes: number;
  readonly #maxPending: number;
  readonly #reservations = new Map<string, number>();
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #sessionPublicationReady = false;
  readonly #featureJobs = new Map<AbortController, string>();

  private constructor(
    sql: SqlJsStatic,
    database: Database,
    path: string | undefined,
    lock: FileHandle | undefined,
    options: SessionContextStoreOptions,
  ) {
    this.#sql = sql;
    this.#database = database;
    this.#path = path;
    this.#lock = lock;
    this.#options = options;
    this.sessionId = options.sessionId;
    this.#liveSetId = options.liveSetId;
    this.#recorder = recorderFor(options.recorder);
    this.#maxStoreBytes = options.maxStoreBytes ?? CONTEXT_LIMITS.storeBytes;
    this.#maxPassBytes = options.maxPassBytes ?? CONTEXT_LIMITS.passBytes;
    this.#maxPending =
      options.maxPendingOperations ?? CONTEXT_LIMITS.pendingOperations;
  }

  public static async open(
    options: SessionContextStoreOptions,
  ): Promise<SessionContextStore> {
    // Validate before touching disk and redact every persisted ownership string.
    const ownership = contextSubjectSchema.shape.sessionId.parse(
      options.sessionId,
    );
    const liveSetId = contextSubjectSchema.shape.liveSetId.parse(
      options.liveSetId,
    );
    if (
      ownership !== sanitizePersistedText(ownership) ||
      liveSetId !== sanitizePersistedText(liveSetId)
    ) {
      throw new TypeError(
        "Context ownership identifiers must not contain credentials",
      );
    }
    for (const [value, ceiling] of [
      [options.maxStoreBytes, CONTEXT_LIMITS.storeBytes],
      [options.maxPassBytes, CONTEXT_LIMITS.passBytes],
      [options.maxPendingOperations, CONTEXT_LIMITS.pendingOperations],
      [options.maxFeatureSearchBytes, LISTENING_FEATURE_LIMITS.candidateBytes],
      [options.maxFeatureSearchMs, LISTENING_FEATURE_LIMITS.searchMs],
      [options.maxFeatureBytes, LISTENING_FEATURE_LIMITS.featureBytes],
      [options.maxFeatureBatchBytes, LISTENING_FEATURE_LIMITS.batchBytes],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value <= 0 || value > ceiling)
      ) {
        throw new TypeError(
          "Context bounds must be positive integers within canonical limits",
        );
      }
    }
    const path =
      options.path === undefined || options.path === ":memory:"
        ? undefined
        : resolve(options.path);
    const startedAt = performance.now();
    const emit = lifecycleEmitter(
      recorderFor(options.recorder),
      options,
      "open",
      contextTraceSchema.parse(options.trace ?? newTrace()),
      () => (options.clock?.() ?? new Date()).toISOString(),
    );
    emit("queued");
    emit("started", 0);
    let lock: FileHandle | undefined;
    let database: Database | undefined;
    try {
      options.signal?.throwIfAborted();
      const sql = await loadSqlJs();
      let bytes: Uint8Array | undefined;
      if (path !== undefined) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        lock = await acquireDatabaseLock(`${path}.lock`);
        try {
          const stored = await readFile(path);
          if (stored.byteLength === 0)
            throw new Error("Context store is empty/corrupt");
          if (
            stored.byteLength >
            (options.maxStoreBytes ?? CONTEXT_LIMITS.storeBytes)
          ) {
            throw new ContextQuotaError("Existing context store exceeds quota");
          }
          bytes = stored;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      database =
        bytes === undefined ? new sql.Database() : new sql.Database(bytes);
      emit("progress", performance.now() - startedAt, {
        phase: "validating-and-migrating",
        existingStore: bytes !== undefined,
      });
      migrate(database, ownership, liveSetId);
      const store = new SessionContextStore(sql, database, path, lock, options);
      options.signal?.throwIfAborted();
      const interrupted = rows(
        database,
        "SELECT entry_id FROM context_feature_derivations WHERE status = 'pending'",
      );
      if (interrupted.length > 0) {
        await store.#operation(
          "derive-recovery",
          options.trace,
          options.signal,
          async () => {
            await store.#transaction(() => {
              for (const row of interrupted) {
                store.#putDerivation(
                  derivationState(
                    String(row.entry_id),
                    "failed",
                    "interrupted-before-publication",
                  ),
                );
              }
            }, options.signal);
          },
        );
      }
      await store.#publish();
      emit("completed", performance.now() - startedAt, {
        schemaVersion: store.schemaVersion,
      });
      return store;
    } catch (error) {
      database?.close();
      await releaseDatabaseLock(
        lock,
        path === undefined ? undefined : `${path}.lock`,
      );
      emit(
        options.signal?.aborted === true ? "cancelled" : "failed",
        performance.now() - startedAt,
        { error },
      );
      throw error;
    }
  }

  public get databasePath(): string | undefined {
    return this.#path;
  }
  public get schemaVersion(): number {
    return 3;
  }
  public get liveSetId(): string {
    return this.#liveSetId;
  }

  public appendPass(
    input: AppendContextPass,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    const trace = options.trace ?? input.pass.trace;
    return this.#operation(
      "publish",
      trace,
      options.signal,
      async () => {
        const parsed = appendContextPassSchema.parse(
          sanitizeStrings(appendContextPassSchema.parse(input)),
        );
        this.#validatePublication(parsed);
        const encodedBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
        if (
          encodedBytes > this.#maxPassBytes ||
          encodedBytes >
            (this.#reservations.get(parsed.pass.id) ?? this.#maxPassBytes)
        ) {
          throw new ContextQuotaError(
            "Listening pass exceeds encoded publication quota",
          );
        }
        await this.#publishSessionBeforeContext(parsed.pass, options);
        await this.#transaction(
          () => {
            const { pass } = parsed;
            this.#database.run("INSERT INTO context_passes VALUES (?, ?, ?)", [
              pass.id,
              pass.createdAt,
              JSON.stringify(pass),
            ]);
            for (const subject of parsed.subjects) {
              const previous = this.#get("subjects", subject.id, parseSubject);
              if (
                previous !== undefined &&
                JSON.stringify(previous) !== JSON.stringify(subject)
              ) {
                throw new RepositoryConflictError(
                  "Immutable subject binding evidence cannot be overwritten",
                );
              }
              if (previous === undefined)
                this.#database.run(
                  "INSERT INTO context_subjects VALUES (?, ?)",
                  [subject.id, JSON.stringify(subject)],
                );
            }
            for (const entry of parsed.entries) {
              this.#database.run(
                "INSERT INTO context_entries VALUES (?, ?, ?, ?, ?, ?)",
                [
                  entry.id,
                  entry.passId,
                  entry.producer.listenerId,
                  entry.kind,
                  entry.createdAt,
                  JSON.stringify(entry),
                ],
              );
              if (entry.kind === "metric-audio-observation/v1") {
                this.#putDerivation(derivationState(entry.id, "pending"));
              }
            }
            for (const link of parsed.links)
              this.#database.run(
                "INSERT INTO context_links VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                  link.id,
                  link.entryId,
                  link.subjectId,
                  link.freshness.status,
                  link.coverage.startBeat,
                  link.coverage.endBeat,
                  JSON.stringify(link),
                ],
              );
          },
          options.signal,
          parsed.pass.id,
        );
        this.#reservations.delete(parsed.pass.id);
        for (const entry of parsed.entries) {
          if (entry.kind === "metric-audio-observation/v1") {
            // Publication is already durable. Derivation has independent lifecycle/failure.
            const denied = this.#closing || this.#pending >= this.#maxPending;
            void this.deriveFeatures(entry.id, {
              trace: entry.trace,
              activeAgentId: entry.producer.agentId,
            }).catch(() => undefined);
            if (denied) {
              // Already inside the serialized publication: do not create an overflow cleanup queue.
              const startedAt = performance.now();
              const emit = lifecycleEmitter(
                this.#recorder,
                this,
                "derive-status",
                entry.trace,
                () => this.#now(),
                entry.producer.agentId,
              );
              emit("queued");
              emit("started", 0);
              try {
                emit("progress", 0, { phase: "persisting-admission-failure" });
                await this.#transaction(() =>
                  this.#putDerivation(
                    derivationState(
                      entry.id,
                      this.#closing ? "cancelled" : "failed",
                      this.#closing
                        ? "derivation-cancelled"
                        : "derivation-queue-full",
                    ),
                  ),
                );
                emit("completed", performance.now() - startedAt);
              } catch (error) {
                emit("failed", performance.now() - startedAt, { error });
              }
            }
          }
        }
      },
      false,
      input.pass.initiatorAgentId,
    );
  }

  public getPass(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<ListeningPass | undefined> {
    return this.#read("get-pass", options, () =>
      this.#get("passes", id, parsePass),
    );
  }

  public deriveFeatures(
    entryId: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextFeatureDerivation> {
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const owner = this.liveSetId;
    const admitted =
      !this.#closed && !this.#closing && this.#pending < this.#maxPending;
    const result = this.#operation(
      "derive-features",
      options.trace,
      signal,
      async (progress) => {
        const entry = this.#featureSource(entryId);
        if (entry === undefined || owner !== this.liveSetId)
          throw new RepositoryConflictError(
            "Feature source is outside current ownership or no longer exists",
          );
        const prior = this.#getDerivation(entryId);
        if (
          prior?.definitionSet === FEATURE_DEFINITION_SET &&
          (prior.status === "ready" || prior.status === "unavailable")
        )
          return prior;
        await this.#transaction(
          () => this.#putDerivation(derivationState(entryId, "pending")),
          signal,
        );
        await yieldTurn();
        signal.throwIfAborted();
        if (entry.payload.schema !== "metric-audio-observation/v1") {
          const unavailable = derivationState(
            entryId,
            "unavailable",
            "unsupported-source-kind",
          );
          await this.#transaction(
            () => this.#putDerivation(unavailable),
            signal,
          );
          return unavailable;
        }
        const observation = entry.payload;
        // Fingerprint the immutable persisted measurement, never a derived or summarized view.
        const stored = rows(
          this.#database,
          "SELECT payload FROM context_entries WHERE id = ?",
          [entryId],
        )[0];
        const sourceFingerprint = hashIdentity(
          (JSON.parse(String(stored?.payload)) as ContextEntry).payload,
        );
        const segments: ContextSegment[] = [];
        const features: ContextFeature[] = [];
        let batchBytes = 0;
        const ranges = segmentListeningObservation(
          observation,
          entry.musicalAlignment,
        );
        for (const range of ranges) {
          signal.throwIfAborted();
          const segmentData = {
            entryId,
            sessionId: this.sessionId,
            liveSetId: owner,
            ...omitFields(range, "grid"),
          };
          const segment = contextSegmentSchema.parse({
            ...segmentData,
            id: `segment:${hashIdentity([sourceFingerprint, segmentData])}`,
          });
          segments.push(segment);
          batchBytes += Buffer.byteLength(JSON.stringify(segment));
          for (const value of extractListeningFeatures(observation, range)) {
            const feature = contextFeatureSchema.parse({
              id: `feature:${hashIdentity([entryId, sourceFingerprint, segment.id, value.type, value.profileKey, value.normalization])}`,
              entryId,
              segmentId: segment.id,
              sessionId: this.sessionId,
              liveSetId: owner,
              sourceFingerprint,
              createdAt: this.#now(),
              trace: options.trace ?? entry.trace,
              feature: value,
            });
            const bytes = Buffer.byteLength(JSON.stringify(feature));
            batchBytes += bytes;
            if (
              bytes >
                (this.#options.maxFeatureBytes ??
                  LISTENING_FEATURE_LIMITS.featureBytes) ||
              batchBytes >
                (this.#options.maxFeatureBatchBytes ??
                  LISTENING_FEATURE_LIMITS.batchBytes)
            )
              throw new ContextQuotaError(
                "Derived feature batch exceeds encoded quota",
              );
            features.push(feature);
          }
          if (
            ranges.length > 1 &&
            (segments.length % 8 === 0 || segments.length === ranges.length)
          )
            progress({
              phase: "extracting-segments",
              completedSegments: segments.length,
              totalSegments: ranges.length,
              encodedBytes: batchBytes,
            });
          await yieldTurn();
        }
        const anyReady = features.some(
          (feature) => feature.feature.status === "ready",
        );
        const state = derivationState(
          entryId,
          anyReady ? "ready" : "unavailable",
          anyReady ? null : "no-supported-measurements",
          features.map((feature) => feature.id),
        );
        if (
          batchBytes + Buffer.byteLength(JSON.stringify(state)) >
          (this.#options.maxFeatureBatchBytes ??
            LISTENING_FEATURE_LIMITS.batchBytes)
        )
          throw new ContextQuotaError(
            "Derived feature batch exceeds encoded quota",
          );
        await this.#transaction(() => {
          if (
            this.#featureSource(entryId) === undefined ||
            this.liveSetId !== owner
          )
            throw new RepositoryConflictError(
              "Feature source was removed or ownership changed",
            );
          this.#database.run(
            "DELETE FROM context_segments WHERE entry_id = ?",
            [entryId],
          );
          for (const segment of segments)
            this.#database.run(
              "INSERT INTO context_segments VALUES (?, ?, ?, ?, ?)",
              [
                segment.id,
                entryId,
                this.sessionId,
                owner,
                JSON.stringify(segment),
              ],
            );
          for (const feature of features)
            this.#database.run(
              "INSERT INTO context_features VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [
                feature.id,
                entryId,
                feature.segmentId,
                this.sessionId,
                owner,
                feature.feature.type,
                feature.feature.distanceDefinition,
                hashIdentity([
                  feature.feature.profileKey,
                  feature.feature.normalization,
                  feature.feature.supportPolicy,
                ]),
                sourceFingerprint,
                feature.feature.status,
                listeningFeatureDefinition(feature.feature.type).dimensions *
                  (listeningFeatureDefinition(feature.feature.type).grid
                    ? (feature.feature.grid?.cells.length ?? 0)
                    : 1),
                JSON.stringify(feature),
              ],
            );
          this.#putDerivation(state);
        }, signal);
        return state;
      },
      false,
      options.activeAgentId,
      "extracting-and-publishing",
      async (error) => {
        if (
          this.#featureSource(entryId) === undefined ||
          this.liveSetId !== owner
        )
          return;
        const prior = this.#getDerivation(entryId);
        if (prior?.status === "ready" || prior?.status === "unavailable")
          return;
        const reason =
          error instanceof ContextQuotaError
            ? "derived-store-quota-exceeded"
            : signal.aborted
              ? "derivation-cancelled"
              : error instanceof RangeError &&
                  error.message.startsWith("feature_")
                ? `unsupported-geometry:${error.message}`
                : "derivation-failed";
        await this.#transaction(() =>
          this.#putDerivation(
            derivationState(
              entryId,
              signal.aborted ? "cancelled" : "failed",
              reason,
            ),
          ),
        );
      },
    );
    if (admitted) this.#featureJobs.set(controller, entryId);
    return result.finally(() => this.#featureJobs.delete(controller));
  }

  public getFeatureDerivation(
    entryId: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextFeatureDerivation | undefined> {
    return this.#read("get-feature-derivation", options, () =>
      this.#featureSource(entryId) === undefined
        ? undefined
        : this.#getDerivation(entryId),
    );
  }

  public getSegment(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextSegment | undefined> {
    return this.#read("get-segment", options, () => {
      contextSubjectSchema.shape.id.parse(id);
      const row = rows(
        this.#database,
        "SELECT payload FROM context_segments WHERE id = ? AND session_id = ? AND live_set_id = ?",
        [id, this.sessionId, this.liveSetId],
      )[0];
      return row === undefined
        ? undefined
        : decode(row.payload, (value) => contextSegmentSchema.parse(value));
    });
  }

  public getFeature(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextFeature | undefined> {
    return this.#read("get-feature", options, async (readOptions) => {
      const feature = this.#getFeature(id);
      if (feature === undefined) return undefined;
      const budget = { remaining: CONTEXT_LIMITS.revalidationsPerQuery };
      return {
        ...feature,
        primarySubjectId: this.#featurePrimaryLink(feature.entryId, budget)
          .subjectId,
        freshness: await this.#featureFreshness(
          feature.entryId,
          budget,
          readOptions,
        ),
      };
    });
  }

  public listFeatures(
    input: ContextFeatureQuery = {},
    options: ContextOperationOptions = {},
  ): Promise<ContextPage<ContextFeature>> {
    return this.#read("list-features", options, async (readOptions) => {
      const query = contextFeatureQuerySchema.parse(input);
      const filters = hashIdentity([
        query.entryId ?? null,
        query.featureType ?? null,
        query.includeHistorical,
      ]);
      let after = "";
      if (query.cursor !== undefined) {
        try {
          const cursor = JSON.parse(
            Buffer.from(query.cursor, "base64url").toString("utf8"),
          ) as Record<string, unknown>;
          if (
            cursor.sessionId !== this.sessionId ||
            cursor.liveSetId !== this.liveSetId ||
            cursor.filters !== filters
          )
            throw new Error("Cursor scope mismatch");
          after = contextSubjectSchema.shape.id.parse(cursor.after);
        } catch {
          throw new TypeError(
            "Feature cursor does not match ownership or query",
          );
        }
      }
      const parameters: (string | number)[] = [
        this.sessionId,
        this.liveSetId,
        after,
      ];
      const clauses = ["f.session_id = ?", "f.live_set_id = ?", "f.id > ?"];
      if (query.entryId !== undefined) {
        clauses.push("f.entry_id = ?");
        parameters.push(query.entryId);
      }
      if (query.featureType !== undefined) {
        clauses.push("f.feature_type = ?");
        parameters.push(query.featureType);
      }
      if (!query.includeHistorical) clauses.push(this.#featureCurrentClause());
      const records = rows(
        this.#database,
        `SELECT f.id, f.payload FROM context_features f WHERE ${clauses.join(" AND ")} ORDER BY f.id LIMIT ?`,
        [...parameters, query.limit + 1],
      );
      const selected = records.slice(0, query.limit);
      const budget = { remaining: CONTEXT_LIMITS.revalidationsPerQuery };
      const items: ContextFeature[] = [];
      for (const row of selected) {
        const feature = decode(row.payload, (value) =>
          contextFeatureSchema.parse(value),
        );
        const freshness = await this.#featureFreshness(
          feature.entryId,
          budget,
          readOptions,
        );
        if (
          !query.includeHistorical &&
          ["historical", "stale"].includes(freshness.status)
        )
          continue;
        items.push({
          ...feature,
          freshness,
          primarySubjectId: this.#featurePrimaryLink(feature.entryId, budget)
            .subjectId,
        });
      }
      return {
        items,
        ...(records.length > query.limit
          ? {
              nextCursor: Buffer.from(
                JSON.stringify({
                  sessionId: this.sessionId,
                  liveSetId: this.liveSetId,
                  filters,
                  after: selected.at(-1)?.id,
                }),
              ).toString("base64url"),
            }
          : {}),
      };
    });
  }

  public searchFeatures(
    input: ContextFeatureSearch,
    options: ContextOperationOptions = {},
  ): Promise<ContextFeatureSearchResult> {
    return this.#read("search-features", options, async (readOptions) => {
      const searchMs =
        this.#options.maxFeatureSearchMs ?? LISTENING_FEATURE_LIMITS.searchMs;
      const deadline = performance.now() + searchMs;
      const timeout = AbortSignal.timeout(searchMs);
      const query = contextFeatureSearchSchema.parse(input);
      const source = this.#getFeature(query.featureId);
      if (source === undefined)
        throw new RepositoryConflictError(
          "Query feature is outside current ownership or does not exist",
        );
      if (
        query.featureType !== undefined &&
        query.featureType !== source.feature.type
      )
        throw new TypeError("Search feature type must match the query feature");
      const parameters: (string | number)[] = [
        this.sessionId,
        this.liveSetId,
        source.feature.type,
        source.id,
      ];
      const clauses = [
        "f.session_id = ?",
        "f.live_set_id = ?",
        "f.feature_type = ?",
        "f.id <> ?",
      ];
      if (query.excludeEntryIds.length > 0) {
        clauses.push(
          `f.entry_id NOT IN (${query.excludeEntryIds.map(() => "?").join(",")})`,
        );
        parameters.push(...query.excludeEntryIds);
      }
      if (!query.includeHistorical) clauses.push(this.#featureCurrentClause());
      const where = clauses.join(" AND ");
      const eligibleCount = Number(
        rows(
          this.#database,
          `SELECT COUNT(*) AS n FROM context_features f WHERE ${where}`,
          parameters,
        )[0]?.n ?? 0,
      );
      const records = rows(
        this.#database,
        `SELECT f.payload FROM context_features f WHERE ${where} ORDER BY f.entry_id, f.segment_id, f.id LIMIT ?`,
        [...parameters, query.candidateLimit],
      );
      const limitsHit: ("candidates" | "bytes" | "time")[] =
        eligibleCount > query.candidateLimit ? ["candidates"] : [];
      const matches: { feature: ContextFeature; distance: number }[] = [];
      const exclusionReasons: Record<string, number> = {};
      let scannedCount = 0;
      let comparableCount = 0;
      let bytes = 0;
      const budget = { remaining: CONTEXT_LIMITS.revalidationsPerQuery };
      const signal =
        readOptions.signal === undefined
          ? timeout
          : AbortSignal.any([timeout, readOptions.signal]);
      const searchOptions = { ...readOptions, signal };
      const exclude = (reason: string): void => {
        exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
      };
      try {
        const sourceFreshness = await this.#featureFreshness(
          source.entryId,
          budget,
          searchOptions,
        );
        if (
          !query.includeHistorical &&
          ["historical", "stale"].includes(sourceFreshness.status)
        )
          throw new RepositoryConflictError(
            "Query feature is historical or stale",
          );
        for (const row of records) {
          readOptions.signal?.throwIfAborted();
          if (timeout.aborted || performance.now() >= deadline) {
            limitsHit.push("time");
            break;
          }
          bytes += Buffer.byteLength(String(row.payload), "utf8");
          if (
            bytes >
            (this.#options.maxFeatureSearchBytes ??
              LISTENING_FEATURE_LIMITS.candidateBytes)
          ) {
            limitsHit.push("bytes");
            break;
          }
          const feature = decode(row.payload, (value) =>
            contextFeatureSchema.parse(value),
          );
          const freshness = await this.#featureFreshness(
            feature.entryId,
            budget,
            searchOptions,
          );
          scannedCount++;
          if (
            !query.includeHistorical &&
            ["historical", "stale"].includes(freshness.status)
          ) {
            exclude(freshness.status);
          } else {
            const comparison = compareListeningFeatures(
              source.feature,
              feature.feature,
            );
            if (comparison.status === "comparable") {
              comparableCount++;
              matches.push({
                feature: {
                  ...feature,
                  freshness,
                  primarySubjectId: this.#featurePrimaryLink(
                    feature.entryId,
                    budget,
                  ).subjectId,
                },
                distance: comparison.distance,
              });
            } else exclude(comparison.reason);
          }
          if (scannedCount % 32 === 0) await yieldTurn();
        }
      } catch (error) {
        readOptions.signal?.throwIfAborted();
        if (!timeout.aborted) throw error;
        limitsHit.push("time");
      }
      matches.sort(
        (a, b) =>
          a.distance - b.distance ||
          (a.feature.id < b.feature.id
            ? -1
            : a.feature.id > b.feature.id
              ? 1
              : 0),
      );
      return {
        matches: matches.slice(0, query.limit),
        scannedCount,
        comparableCount,
        eligibleCount,
        excludedCount: scannedCount - comparableCount,
        exhaustive: scannedCount === eligibleCount && limitsHit.length === 0,
        limitsHit,
        exclusionReasons,
      };
    });
  }

  #featureCurrentClause(): string {
    return "EXISTS (SELECT 1 FROM context_links l WHERE l.entry_id = f.entry_id AND l.freshness NOT IN ('historical', 'stale'))";
  }

  #featureSource(entryId: string): ContextEntry | undefined {
    const entry = this.#get("entries", entryId, parseEntry);
    return entry?.sessionId === this.sessionId &&
      entry.liveSetId === this.liveSetId
      ? entry
      : undefined;
  }

  #getFeature(id: string): ContextFeature | undefined {
    contextSubjectSchema.shape.id.parse(id);
    const row = rows(
      this.#database,
      "SELECT payload FROM context_features WHERE id = ? AND session_id = ? AND live_set_id = ?",
      [id, this.sessionId, this.liveSetId],
    )[0];
    return row === undefined
      ? undefined
      : decode(row.payload, (value) => contextFeatureSchema.parse(value));
  }

  #getDerivation(entryId: string): ContextFeatureDerivation | undefined {
    const row = rows(
      this.#database,
      "SELECT payload FROM context_feature_derivations WHERE entry_id = ?",
      [entryId],
    )[0];
    return row === undefined
      ? undefined
      : decode(row.payload, (value) =>
          contextFeatureDerivationSchema.parse(value),
        );
  }

  #putDerivation(state: ContextFeatureDerivation): void {
    const text = JSON.stringify(
      contextFeatureDerivationSchema.parse(sanitizeStrings(state)),
    );
    if (Buffer.byteLength(text, "utf8") > LISTENING_FEATURE_LIMITS.batchBytes)
      throw new ContextQuotaError(
        "Derivation status exceeds reserved metadata",
      );
    // Reserve fixed bytes at source admission, including room for terminal failure reasons.
    const payload =
      text +
      " ".repeat(
        Math.max(
          0,
          DERIVATION_STATUS_BYTES -
            Buffer.byteLength(text, "utf8") -
            state.status.length,
        ),
      );
    this.#database.run(
      "INSERT INTO context_feature_derivations VALUES (?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET status = excluded.status, payload = excluded.payload",
      [state.entryId, state.status, payload],
    );
  }

  async #featureFreshness(
    entryId: string,
    budget: FeatureReadBudget,
    options: ContextOperationOptions,
  ): Promise<ContextFreshnessAssessment> {
    budget.assessments ??= new Map();
    const previous = budget.assessments.get(entryId);
    if (previous !== undefined) return previous;
    const pending = this.#assessFeatureFreshness(entryId, budget, options);
    budget.assessments.set(entryId, pending);
    return pending;
  }

  async #assessFeatureFreshness(
    entryId: string,
    budget: FeatureReadBudget,
    options: ContextOperationOptions,
  ): Promise<ContextFreshnessAssessment> {
    options.signal?.throwIfAborted();
    const link = this.#featurePrimaryLink(entryId, budget);
    // Historical primary evidence is never upgraded through a current contributor.
    if (["historical", "stale"].includes(link.freshness.status))
      return link.freshness;
    const pending = this.#currentLink(link, budget, options);
    const signal = options.signal;
    let onAbort: (() => void) | undefined;
    try {
      const current =
        signal === undefined
          ? await pending
          : await new Promise<ContextLink>((resolve, reject) => {
              onAbort = () =>
                reject(new Error("Feature freshness read cancelled"));
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
              void pending.then(resolve, reject);
            });
      return current.freshness;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  #featurePrimaryLink(entryId: string, budget: FeatureReadBudget): ContextLink {
    budget.primaryLinks ??= new Map();
    const existing = budget.primaryLinks.get(entryId);
    if (existing !== undefined) return existing;
    const links = rows(
      this.#database,
      "SELECT payload FROM context_links WHERE entry_id = ? ORDER BY id LIMIT 513",
      [entryId],
    )
      .map((row) => decode(row.payload, parseLink))
      .filter((link) => link.relationship === "primary");
    const primary = links[0];
    if (
      links.length !== 1 ||
      primary === undefined ||
      primary.sessionId !== this.sessionId ||
      primary.liveSetId !== this.liveSetId
    )
      throw new RepositoryConflictError(
        "Feature source primary association is missing, ambiguous, or outside current ownership",
      );
    budget.primaryLinks.set(entryId, primary);
    return primary;
  }

  public getEntry(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextEntry | undefined> {
    return this.#read("get-entry", options, () =>
      this.#get("entries", id, parseEntry),
    );
  }

  public getSubject(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextSubject | undefined> {
    return this.#read("get-subject", options, () =>
      this.#get("subjects", id, parseSubject),
    );
  }

  public getLink(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<ContextLink | undefined> {
    return this.#read("get-link", options, async (readOptions) => {
      const link = this.#get("links", id, parseLink);
      return link === undefined
        ? undefined
        : this.#currentLink(link, { remaining: 1 }, readOptions);
    });
  }

  public listPasses(
    input: ContextQuery = {},
    options: ContextOperationOptions = {},
  ): Promise<ContextPage<ListeningPass>> {
    return this.#read("list-passes", options, async (readOptions) => {
      const query = contextQuerySchema.parse(input);
      const parameters: (string | number)[] = [];
      const where = this.#filters(query, parameters);
      const records = rows(
        this.#database,
        `
        SELECT p.payload, p.id FROM context_passes p
        WHERE ${where} ORDER BY p.id LIMIT ?
      `,
        [...parameters, query.limit + 1],
      );
      const page = this.#page(records, query, parsePass, "passes");
      if (query.freshness === undefined) return page;
      const budget = { remaining: CONTEXT_LIMITS.revalidationsPerQuery };
      const items: ListeningPass[] = [];
      for (const pass of page.items) {
        const links = rows(
          this.#database,
          `
          SELECT l.payload FROM context_links l
          JOIN context_entries e ON e.id = l.entry_id
          WHERE e.pass_id = ? LIMIT 513
        `,
          [pass.id],
        ).map((row) => decode(row.payload, parseLink));
        for (const link of links) {
          if (!this.#matchesLink(link, query)) continue;
          const assessed = await this.#currentLink(link, budget, readOptions);
          if (
            assessed.freshness.status === query.freshness &&
            (query.includeHistorical ||
              !["stale", "historical"].includes(assessed.freshness.status))
          ) {
            items.push(pass);
            break;
          }
        }
      }
      return { ...page, items };
    });
  }

  public listEntries(
    input: ContextQuery = {},
    options: ContextOperationOptions = {},
  ): Promise<ContextPage<ContextEntrySummary>> {
    return this.#read("list-entries", options, async (readOptions) => {
      const query = contextQuerySchema.parse(input);
      const parameters: (string | number)[] = [];
      const where = this.#filters(query, parameters, true);
      const records = rows(
        this.#database,
        `
        SELECT e.payload, e.id FROM context_entries e
        JOIN context_passes p ON p.id = e.pass_id
        WHERE ${where} ORDER BY e.id LIMIT ?
      `,
        [...parameters, query.limit + 1],
      );
      const page = this.#page(records, query, parseEntry, "entries");
      const items: ContextEntrySummary[] = [];
      const budget = { remaining: CONTEXT_LIMITS.revalidationsPerQuery };
      for (const entry of page.items) {
        if (query.freshness !== undefined || !query.includeHistorical) {
          const links = rows(
            this.#database,
            "SELECT payload FROM context_links WHERE entry_id = ? LIMIT 513",
            [entry.id],
          ).map((row) => decode(row.payload, parseLink));
          let applicable = false;
          for (const link of links) {
            if (!this.#matchesLink(link, query)) continue;
            const assessment = await this.#currentLink(
              link,
              budget,
              readOptions,
            );
            if (
              (query.freshness === undefined ||
                assessment.freshness.status === query.freshness) &&
              (query.includeHistorical ||
                !["stale", "historical"].includes(assessment.freshness.status))
            ) {
              applicable = true;
              break;
            }
          }
          if (!applicable) continue;
        }
        items.push({
          ...entry,
          payload: summarizeObservation(entry.payload),
        });
      }
      return { ...page, items };
    });
  }

  public listLinks(
    input: ContextQuery = {},
    options: ContextOperationOptions = {},
  ): Promise<ContextPage<ContextLink>> {
    return this.#read("list-links", options, async (readOptions) => {
      const query = contextQuerySchema.parse(input);
      const parameters: (string | number)[] = [];
      const clauses = ["1 = 1"];
      if (query.entryId !== undefined) {
        clauses.push("l.entry_id = ?");
        parameters.push(query.entryId);
      }
      if (query.subjectId !== undefined) {
        clauses.push("l.subject_id = ?");
        parameters.push(query.subjectId);
      }
      if (query.passId !== undefined) {
        clauses.push("e.pass_id = ?");
        parameters.push(query.passId);
      }
      if (query.listenerId !== undefined) {
        clauses.push("e.listener_id = ?");
        parameters.push(query.listenerId);
      }
      if (query.kind !== undefined) {
        clauses.push("e.kind = ?");
        parameters.push(query.kind);
      }
      if (query.range !== undefined) {
        clauses.push("l.end_beat >= ? AND l.start_beat <= ?");
        parameters.push(query.range.startBeat, query.range.endBeat);
      }
      const after = this.#cursor(query, "links");
      if (after !== undefined) {
        clauses.push("l.id > ?");
        parameters.push(after);
      }
      const records = rows(
        this.#database,
        `
        SELECT l.payload, l.id FROM context_links l JOIN context_entries e ON e.id = l.entry_id
        WHERE ${clauses.join(" AND ")} ORDER BY l.id LIMIT ?
      `,
        [...parameters, query.limit + 1],
      );
      const page = this.#page(records, query, parseLink, "links");
      const budget = { remaining: CONTEXT_LIMITS.revalidationsPerQuery };
      const items = await Promise.all(
        page.items.map((link) => this.#currentLink(link, budget, readOptions)),
      );
      return {
        ...page,
        items: items.filter(
          (link) =>
            (query.freshness === undefined ||
              link.freshness.status === query.freshness) &&
            (query.includeHistorical ||
              !["stale", "historical"].includes(link.freshness.status)),
        ),
      };
    });
  }

  /** Updates applicability only; original subjects, pass and observation evidence remain immutable. */
  public assessLink(
    id: string,
    assessment: ContextFreshnessAssessment,
    options: ContextOperationOptions,
  ): Promise<void> {
    return this.#operation(
      "freshness",
      options.trace,
      options.signal,
      async () => {
        const parsed = contextFreshnessAssessmentSchema.parse(
          sanitizeStrings(contextFreshnessAssessmentSchema.parse(assessment)),
        );
        await this.#transaction(() => {
          const previous = this.#get("links", id, parseLink);
          if (previous === undefined)
            throw new Error("Context link does not exist");
          const link = { ...previous, freshness: parsed };
          this.#database.run(
            "UPDATE context_links SET freshness = ?, payload = ? WHERE id = ?",
            [parsed.status, JSON.stringify(link), id],
          );
        }, options.signal);
      },
      false,
      options.activeAgentId,
    );
  }

  public reservePass(
    passId: string,
    bytes: number,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    return this.#operation(
      "reserve",
      options.trace,
      options.signal,
      async () => {
        contextSubjectSchema.shape.id.parse(passId);
        if (
          !Number.isSafeInteger(bytes) ||
          bytes <= 0 ||
          bytes > this.#maxPassBytes
        ) {
          throw new ContextQuotaError("Invalid pass reservation");
        }
        if (
          this.#reservations.has(passId) ||
          this.#get("passes", passId, parsePass) !== undefined
        ) {
          throw new RepositoryConflictError(
            "Pass is already reserved or published",
          );
        }
        if (this.#reservations.size >= CONTEXT_LIMITS.pendingOperations) {
          throw new ContextQuotaError(
            "Too many outstanding context reservations",
          );
        }
        if (
          this.#database.export().byteLength + this.#reservedBytes() + bytes >
          this.#maxStoreBytes
        ) {
          throw new ContextQuotaError(
            "Context store cannot reserve requested pass quota",
          );
        }
        this.#reservations.set(passId, bytes);
      },
      false,
      options.activeAgentId,
    );
  }

  public releaseReservation(
    passId: string,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    return this.#operation(
      "release",
      options.trace,
      options.signal,
      async () => {
        this.#reservations.delete(passId);
      },
      false,
      options.activeAgentId,
    );
  }

  /** First-save ownership transition; never rewrites earlier subjects or observation provenance. */
  public transitionLiveSetOwnership(
    toLiveSetId: string,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    for (const controller of this.#featureJobs.keys())
      controller.abort(new Error("Context ownership transition"));
    return this.#operation(
      "ownership",
      options.trace,
      options.signal,
      async () => {
        const next = contextSubjectSchema.shape.liveSetId.parse(
          sanitizePersistedText(toLiveSetId),
        );
        if (this.#reservations.size > 0) {
          throw new RepositoryConflictError(
            "Cannot transition ownership during reserved listening work",
          );
        }
        await this.#transaction(() => {
          this.#database.run(
            "INSERT OR IGNORE INTO context_live_set_ownership VALUES (?)",
            [next],
          );
          this.#database.run(
            "UPDATE context_owner SET live_set_id = ? WHERE session_id = ?",
            [next, this.sessionId],
          );
        }, options.signal);
        this.#liveSetId = next;
        this.#sessionPublicationReady = false;
      },
      false,
      options.activeAgentId,
    );
  }

  public prune(
    selection: ContextPrune,
    options: ContextOperationOptions = {},
  ): Promise<ContextPruneResult> {
    const input = contextPruneSchema.safeParse(selection);
    const parsed = input.success
      ? contextPruneSchema.safeParse(sanitizeStrings(input.data))
      : input;
    const admitted =
      !this.#closed && !this.#closing && this.#pending < this.#maxPending;
    const result = this.#operation(
      "prune",
      options.trace ?? selection.trace,
      options.signal,
      async () => {
        if (!parsed.success) throw parsed.error;
        const before = TABLES.map((table) =>
          count(this.#database, `context_${table}`),
        );
        await this.#transaction(
          () => {
            for (const id of parsed.data.passIds)
              this.#database.run("DELETE FROM context_passes WHERE id = ?", [
                id,
              ]);
            for (const id of parsed.data.entryIds)
              this.#database.run("DELETE FROM context_entries WHERE id = ?", [
                id,
              ]);
            this.#database.run(
              "DELETE FROM context_subjects WHERE id NOT IN (SELECT subject_id FROM context_links)",
            );
            // Partial entry pruning intentionally retains the immutable pass manifest.
          },
          options.signal,
          undefined,
          true,
        );
        const after = TABLES.map((table) =>
          count(this.#database, `context_${table}`),
        );
        return {
          deletedSubjects: (before[0] ?? 0) - (after[0] ?? 0),
          deletedPasses: (before[1] ?? 0) - (after[1] ?? 0),
          deletedEntries: (before[2] ?? 0) - (after[2] ?? 0),
          deletedLinks: (before[3] ?? 0) - (after[3] ?? 0),
        };
      },
      false,
      options.activeAgentId,
    );
    if (admitted && parsed.success && options.signal?.aborted !== true) {
      const entries = new Set(parsed.data.entryIds);
      const passes = new Set(parsed.data.passIds);
      for (const [controller, entryId] of this.#featureJobs) {
        const source = this.#featureSource(entryId);
        if (
          entries.has(entryId) ||
          (source !== undefined && passes.has(source.passId))
        )
          controller.abort(new Error("Context source pruning"));
      }
    }
    return result;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    for (const controller of this.#featureJobs.keys())
      controller.abort(new Error("Context store closing"));
    const result = this.#operation(
      "close",
      undefined,
      undefined,
      async () => {
        this.#database.close();
        this.#closed = true;
        this.#reservations.clear();
        await releaseDatabaseLock(
          this.#lock,
          this.#path === undefined ? undefined : `${this.#path}.lock`,
        );
      },
      true,
    );
    this.#closing = true;
    this.#closePromise = result;
    return result;
  }

  #validatePublication(publication: AppendContextPass): void {
    const { pass, subjects, entries, links } = publication;
    if (this.#get("passes", pass.id, parsePass) !== undefined) {
      throw new RepositoryConflictError("Listening passes are immutable");
    }
    for (const collection of [subjects, entries, links]) {
      if (
        new Set(collection.map((record) => record.id)).size !==
        collection.length
      ) {
        throw new RepositoryConflictError(
          "Duplicate context IDs in publication",
        );
      }
    }
    for (const record of [pass, ...subjects, ...entries, ...links]) {
      if (
        record.sessionId !== this.sessionId ||
        record.liveSetId !== this.liveSetId
      ) {
        throw new RepositoryConflictError(
          "Context publication crosses App-session or Live Set ownership",
        );
      }
    }
    for (const entry of entries) {
      const identity = storedObservationIdentity(entry.payload);
      const coordinates = storedObservationCoordinates(entry.payload);
      const complete =
        entry.payload.schema === "metric-audio-observation/v1"
          ? entry.payload.outcome === "complete"
          : entry.payload.complete;
      if (
        entry.payload.schema === "metric-audio-observation/v1" &&
        (entry.payload.ownership.traceId !== entry.trace.traceId ||
          entry.payload.ownership.correlationId !== entry.trace.correlationId ||
          entry.payload.ownership.causationId !== entry.trace.causationId ||
          entry.payload.ownership.connectionEpoch !==
            entry.producer.connectionEpoch ||
          pass.requestedMode !== entry.payload.source.view ||
          pass.actualMode !== entry.payload.source.view ||
          pass.actualRange === null ||
          coordinates.startBeat < pass.actualRange.startBeat ||
          coordinates.endBeat > pass.actualRange.endBeat ||
          !["completed", "partial"].includes(pass.status))
      ) {
        throw new TypeError(
          "Metric observation requires successful shared acquisition and exact producer provenance",
        );
      }
      const source =
        entry.payload.schema === "session-audio-observation/v1" ||
        entry.payload.schema === "metric-audio-observation/v1"
          ? entry.payload.source
          : undefined;
      if (source?.view === "session") {
        const entryLinks = links.filter((link) => link.entryId === entry.id);
        const primaryLinks = entryLinks.filter(
          (link) => link.relationship === "primary",
        );
        const resolve = (subjectId: string) =>
          subjects.find((subject) => subject.id === subjectId) ??
          this.#get("subjects", subjectId, parseSubject);
        const primary =
          primaryLinks.length === 1
            ? resolve(primaryLinks[0]!.subjectId)
            : undefined;
        const contributors = entryLinks.filter(
          (link) => link.relationship === "contributor",
        );
        const track = contributors.some((link) => {
          const subject = resolve(link.subjectId);
          return (
            subject?.kind === "track" &&
            subject.id === primary?.trackId &&
            subject.trackId === primary?.trackId &&
            subject.binding.previousRuntimeBindings.includes(
              source.target.track.expectedReference,
            )
          );
        });
        if (
          pass.requestedMode !== "session" ||
          pass.actualMode !== "session" ||
          pass.requestedRange.startBeat !== 0 ||
          pass.requestedRange.endBeat > 499.5 ||
          pass.actualRange?.startBeat !== 0 ||
          pass.actualRange.endBeat < coordinates.endBeat ||
          Math.abs(pass.actualRange.endBeat - pass.requestedRange.endBeat) >
            0.001 + 1e-8 ||
          primary?.kind !== "clip" ||
          primary.location !== "session" ||
          primary.binding.semanticLocator.sceneIndex !==
            source.target.sceneIndex ||
          !primary.binding.previousRuntimeBindings.includes(
            source.target.expectedClipReference,
          ) ||
          !track ||
          contributors.some(
            (link) => resolve(link.subjectId)?.kind !== "track",
          ) ||
          entryLinks.some((link) => link.freshness.status === "fresh")
        ) {
          throw new TypeError(
            "Session observations require local coverage and exact historical clip/track associations",
          );
        }
      }
      if (
        entry.passId !== pass.id ||
        identity.passId !== pass.id ||
        entry.producer.agentId !== pass.initiatorAgentId ||
        entry.trace.traceId !== pass.trace.traceId ||
        entry.trace.correlationId !== pass.trace.correlationId ||
        identity.listenerId !== entry.producer.listenerId ||
        !pass.listenerIds.includes(entry.producer.listenerId) ||
        (pass.complete && !complete)
      )
        throw new TypeError(
          "Observation pass/listener/completeness attribution is inconsistent",
        );
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      const metric = entry.kind === "metric-audio-observation/v1";
      if (
        entryBytes >
          (metric
            ? CONTEXT_LIMITS.metricEntryBytes
            : CONTEXT_LIMITS.entryBytes) ||
        (metric &&
          entryBytes -
            Buffer.byteLength(JSON.stringify(entry.payload), "utf8") >
            CONTEXT_LIMITS.metricEntryMetadataBytes)
      ) {
        throw new ContextQuotaError("Encoded context entry exceeds quota");
      }
    }
    if (
      new Set(entries.map((entry) => entry.producer.listenerId)).size !==
        entries.length ||
      (pass.complete && entries.length !== pass.listenerIds.length)
    )
      throw new TypeError(
        "Completed publication requires one observation per listener",
      );
    for (const link of links) {
      const entry = entries.find((candidate) => candidate.id === link.entryId);
      if (entry === undefined) {
        throw new TypeError(
          "Context link must reference an entry in the same publication",
        );
      }
      if (
        entry.payload.schema !== "audio-observation/v1" &&
        link.attribution === "exclusive"
      ) {
        throw new TypeError(
          "Approximate descriptive observations cannot certify exclusive attribution",
        );
      }
      const session =
        entry.payload.schema === "session-audio-observation/v1" ||
        (entry.payload.schema === "metric-audio-observation/v1" &&
          entry.payload.source.view === "session");
      const measured =
        (entry.payload.schema === "session-audio-observation/v1" ||
          (entry.payload.schema === "metric-audio-observation/v1" &&
            entry.payload.source.view === "session")) &&
        link.relationship === "contributor"
          ? entry.payload.source.transport
          : storedObservationCoordinates(entry.payload);
      if (
        link.coverage.startBeat < measured.startBeat ||
        link.coverage.endBeat > measured.endBeat ||
        (session &&
          (link.coverage.startBeat !== measured.startBeat ||
            link.coverage.endBeat !== measured.endBeat)) ||
        (session &&
          (!("coordinate" in link.coverage) ||
            link.coverage.coordinate !==
              (link.relationship === "primary"
                ? "clip-local-beats"
                : "transport-beats"))) ||
        (!session && "coordinate" in link.coverage)
      ) {
        throw new TypeError(
          "Link coverage exceeds measured observation coordinates",
        );
      }
      if (
        !subjects.some((subject) => subject.id === link.subjectId) &&
        this.#get("subjects", link.subjectId, parseSubject) === undefined
      ) {
        throw new TypeError("Context link must reference a validated subject");
      }
    }
  }

  #get<T>(
    table: Table,
    id: string,
    parse: (value: unknown) => T,
  ): T | undefined {
    contextSubjectSchema.shape.id.parse(id);
    const row = rows(
      this.#database,
      `SELECT payload FROM context_${table} WHERE id = ?`,
      [id],
    )[0];
    return row === undefined ? undefined : decode(row.payload, parse);
  }

  async #currentLink(
    link: ContextLink,
    budget: { remaining: number },
    options: ContextOperationOptions,
  ): Promise<ContextLink> {
    options.signal?.throwIfAborted();
    const subject = this.#get("subjects", link.subjectId, parseSubject);
    if (this.#options.revalidate !== undefined && subject !== undefined) {
      if (budget.remaining <= 0) {
        return {
          ...link,
          freshness: {
            status: "unknown",
            assessedAt: this.#now(),
            reason: "Current-query revalidation budget exhausted",
          },
        };
      }
      budget.remaining--;
      try {
        const assessment = await this.#options.revalidate(
          structuredClone(subject),
          structuredClone(link),
          options,
        );
        options.signal?.throwIfAborted();
        return {
          ...link,
          freshness: contextFreshnessAssessmentSchema.parse(
            sanitizeStrings(assessment),
          ),
        };
      } catch {
        options.signal?.throwIfAborted();
        return {
          ...link,
          freshness: {
            status: "unknown",
            assessedAt: this.#now(),
            reason: "Current binding revalidation failed",
          },
        };
      }
    }
    if (link.freshness.status === "fresh") {
      return {
        ...link,
        freshness: {
          status: "unknown",
          assessedAt: this.#now(),
          reason: "Current entity binding has not been revalidated",
        },
      };
    }
    return link;
  }

  #matchesLink(
    link: ContextLink,
    query: ReturnType<typeof contextQuerySchema.parse>,
  ): boolean {
    if (query.entryId !== undefined && query.entryId !== link.entryId)
      return false;
    if (
      query.listenerId !== undefined &&
      this.#get("entries", link.entryId, parseEntry)?.producer.listenerId !==
        query.listenerId
    )
      return false;
    return (
      (query.subjectId === undefined || link.subjectId === query.subjectId) &&
      (query.range === undefined ||
        (link.coverage.endBeat >= query.range.startBeat &&
          link.coverage.startBeat <= query.range.endBeat))
    );
  }

  #filters(
    query: ReturnType<typeof contextQuerySchema.parse>,
    parameters: (string | number)[],
    entries = false,
  ): string {
    const clauses = ["1 = 1"];
    if (query.passId !== undefined) {
      clauses.push("p.id = ?");
      parameters.push(query.passId);
    }
    const after = this.#cursor(query, entries ? "entries" : "passes");
    if (after !== undefined) {
      clauses.push(`${entries ? "e" : "p"}.id > ?`);
      parameters.push(after);
    }
    const entryClauses = ["e2.pass_id = p.id"];
    if (entries) entryClauses.push("e2.id = e.id");
    if (query.entryId !== undefined) {
      entryClauses.push("e2.id = ?");
      parameters.push(query.entryId);
    }
    if (query.listenerId !== undefined) {
      entryClauses.push("e2.listener_id = ?");
      parameters.push(query.listenerId);
    }
    if (query.kind !== undefined) {
      entryClauses.push("e2.kind = ?");
      parameters.push(query.kind);
    }
    const linkClauses = ["l2.entry_id = e2.id"];
    if (query.subjectId !== undefined) {
      linkClauses.push("l2.subject_id = ?");
      parameters.push(query.subjectId);
    }
    if (query.range !== undefined) {
      linkClauses.push("l2.end_beat >= ? AND l2.start_beat <= ?");
      parameters.push(query.range.startBeat, query.range.endBeat);
    }
    if (query.subjectId !== undefined || query.range !== undefined) {
      entryClauses.push(
        `EXISTS (SELECT 1 FROM context_links l2 WHERE ${linkClauses.join(" AND ")})`,
      );
    }
    if (
      entries ||
      query.entryId !== undefined ||
      query.listenerId !== undefined ||
      query.kind !== undefined ||
      query.subjectId !== undefined ||
      query.range !== undefined
    ) {
      clauses.push(
        `EXISTS (SELECT 1 FROM context_entries e2 WHERE ${entryClauses.join(" AND ")})`,
      );
    }
    return clauses.join(" AND ");
  }

  #cursor(
    query: ReturnType<typeof contextQuerySchema.parse>,
    table: Table,
  ): string | undefined {
    if (query.cursor === undefined) return undefined;
    try {
      const cursor = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (
        cursor.sessionId !== this.sessionId ||
        cursor.liveSetId !== this.liveSetId ||
        cursor.table !== table ||
        cursor.filters !== queryFingerprint(query) ||
        typeof cursor.after !== "string"
      )
        throw new Error("Invalid cursor");
      return contextSubjectSchema.shape.id.parse(cursor.after);
    } catch {
      throw new TypeError("Context cursor does not match ownership or query");
    }
  }

  #page<T>(
    records: Record<string, unknown>[],
    query: ReturnType<typeof contextQuerySchema.parse>,
    parse: (value: unknown) => T,
    table: Table,
  ): ContextPage<T> {
    const selected = records.slice(0, query.limit);
    const items = selected.map((row) => decode(row.payload, parse));
    if (records.length <= query.limit) return { items };
    const nextCursor = Buffer.from(
      JSON.stringify({
        sessionId: this.sessionId,
        liveSetId: this.liveSetId,
        table,
        filters: queryFingerprint(query),
        after: selected.at(-1)?.id,
      }),
    ).toString("base64url");
    return { items, nextCursor };
  }

  #reservedBytes(except?: string): number {
    let total = 0;
    for (const [id, bytes] of this.#reservations)
      if (id !== except) total += bytes;
    return total;
  }

  async #publishSessionBeforeContext(
    pass: ListeningPass,
    options: ContextOperationOptions,
  ): Promise<void> {
    const publish = this.#options.publishSessionContext;
    if (this.#sessionPublicationReady || publish === undefined) return;
    const trace = contextTraceSchema.parse(options.trace ?? pass.trace);
    const emit = lifecycleEmitter(
      this.#recorder,
      this,
      "session-publication",
      trace,
      () => this.#now(),
      pass.initiatorAgentId,
    );
    const startedAt = performance.now();
    emit("queued");
    emit("started", 0);
    try {
      options.signal?.throwIfAborted();
      emit("progress", 0, { phase: "publishing-registry-and-manifest" });
      await publish({
        sessionId: this.sessionId,
        liveSetId: this.liveSetId,
        contextStore: SESSION_CONTEXT_STORE_REFERENCE,
        trace,
        activeAgentId: pass.initiatorAgentId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      options.signal?.throwIfAborted();
      this.#sessionPublicationReady = true;
      emit("completed", performance.now() - startedAt);
    } catch (error) {
      emit(
        options.signal?.aborted === true ? "cancelled" : "failed",
        performance.now() - startedAt,
        { error },
      );
      throw error;
    }
  }

  async #transaction(
    operation: () => void,
    signal?: AbortSignal,
    reservationId?: string,
    compact = false,
  ): Promise<void> {
    const snapshot = this.#database.export();
    // sql.js export resets connection pragmas, including foreign-key enforcement.
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run("BEGIN IMMEDIATE");
    let committed = false;
    try {
      operation();
      signal?.throwIfAborted();
      this.#database.run("COMMIT");
      committed = true;
      if (compact) this.#database.run("VACUUM");
      if (
        this.#database.export().byteLength +
          this.#reservedBytes(reservationId) >
        this.#maxStoreBytes
      ) {
        throw new ContextQuotaError(
          "Context store exceeds quota including SQLite overhead/reservations",
        );
      }
      signal?.throwIfAborted();
      await this.#publish();
    } catch (error) {
      if (committed) {
        this.#database.close();
        this.#database = new this.#sql.Database(snapshot);
        this.#database.run("PRAGMA foreign_keys = ON");
      } else this.#database.run("ROLLBACK");
      throw error;
    }
  }

  async #publish(): Promise<void> {
    const bytes = this.#database.export();
    if (bytes.byteLength > this.#maxStoreBytes)
      throw new ContextQuotaError("Context database exceeds physical quota");
    if (this.#path === undefined) return;
    const staging = `${this.#path}.${randomUUID()}.staging`;
    try {
      const handle = await open(staging, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, this.#path);
      await syncDirectory(dirname(this.#path));
    } finally {
      await rm(staging, { force: true });
    }
  }

  #read<T>(
    action: string,
    options: ContextOperationOptions,
    operation: (options: ContextOperationOptions) => T | Promise<T>,
  ): Promise<T> {
    const readOptions = {
      ...options,
      trace: contextTraceSchema.parse(options.trace ?? newTrace()),
    };
    return this.#operation(
      action,
      readOptions.trace,
      readOptions.signal,
      async () => {
        const signal = readOptions.signal;
        let onAbort: (() => void) | undefined;
        try {
          // Legacy revalidators may ignore the signal; abort releases the queue and discards late results.
          const pending = Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return operation(readOptions);
          });
          const value =
            signal === undefined
              ? await pending
              : await new Promise<T>((resolve, reject) => {
                  onAbort = () => {
                    const reason: unknown = signal.reason;
                    reject(
                      reason instanceof Error
                        ? reason
                        : new Error("Context read cancelled", {
                            cause: reason,
                          }),
                    );
                  };
                  signal.addEventListener("abort", onAbort, { once: true });
                  if (signal.aborted) onAbort();
                  void pending.then(resolve, reject);
                });
          signal?.throwIfAborted();
          return value;
        } finally {
          if (onAbort !== undefined)
            signal?.removeEventListener("abort", onAbort);
        }
      },
      false,
      readOptions.activeAgentId,
      "querying-and-revalidating",
    );
  }

  #queue<T>(operation: () => Promise<T>, allowOverflow = false): Promise<T> {
    if (this.#closed || this.#closing)
      return Promise.reject(new Error("Session context store is closed"));
    if (!allowOverflow && this.#pending >= this.#maxPending)
      return Promise.reject(
        new ContextQuotaError("Context persistence queue is full"),
      );
    this.#pending++;
    const result = this.#tail.then(operation);
    this.#tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#pending--;
      });
    return result;
  }

  #operation<T>(
    action: string,
    inputTrace: ContextTrace | undefined,
    signal: AbortSignal | undefined,
    operation: (
      progress: (attributes: Record<string, unknown>) => void,
    ) => Promise<T>,
    allowOverflow = false,
    activeAgentId?: string,
    phase = "validating-and-persisting",
    onFailure?: (error: unknown) => Promise<void>,
  ): Promise<T> {
    const trace = contextTraceSchema.parse(inputTrace ?? newTrace());
    const queuedAt = performance.now();
    const emit = lifecycleEmitter(
      this.#recorder,
      this,
      action,
      trace,
      () => this.#now(),
      activeAgentId === undefined
        ? undefined
        : contextSubjectSchema.shape.id.parse(
            sanitizePersistedText(activeAgentId),
          ),
    );
    emit("queued");
    let started = false;
    const result = this.#queue(async () => {
      started = true;
      const startedAt = performance.now();
      emit("started", startedAt - queuedAt, {
        queueWaitMs: startedAt - queuedAt,
      });
      try {
        signal?.throwIfAborted();
        emit("progress", 0, { phase });
        const value = await operation((attributes) =>
          emit("progress", performance.now() - startedAt, attributes),
        );
        emit("completed", performance.now() - startedAt);
        return value;
      } catch (error) {
        let recoveryError: unknown;
        try {
          await onFailure?.(error);
        } catch (failure) {
          recoveryError = failure;
        }
        emit(
          signal?.aborted === true ? "cancelled" : "failed",
          performance.now() - startedAt,
          { error, ...(recoveryError === undefined ? {} : { recoveryError }) },
        );
        throw error;
      }
    }, allowOverflow);
    // Queue denial happens before the instrumented operation starts.
    return result.catch((error: unknown) => {
      if (!started) {
        emit("failed", performance.now() - queuedAt, { error });
      }
      throw error;
    });
  }

  #now(): string {
    return (this.#options.clock?.() ?? new Date()).toISOString();
  }
}

export function openSessionContextStore(
  options: SessionContextStoreOptions,
): Promise<SessionContextStore> {
  return SessionContextStore.open(options);
}

export function createInMemorySessionContextStore(
  options: Omit<SessionContextStoreOptions, "path">,
): Promise<SessionContextStore> {
  return SessionContextStore.open({ ...options, path: ":memory:" });
}
