import { Worker } from "node:worker_threads";

import {
  agentHistoryPageSchema,
  agentHistoryQuerySchema,
  agentHistoryRecordSchema,
  configurationSnapshotDeleteFilterSchema,
  configurationSnapshotPageSchema,
  configurationSnapshotQuerySchema,
  configurationSnapshotSchema,
  DEFAULT_MAX_PENDING_WRITES,
  journalHealthSchema,
  MAX_PUBLIC_HISTORY_CELL_CHARACTERS,
  MAX_PUBLIC_HISTORY_PARAMETERS,
  MAX_PUBLIC_HISTORY_ROWS,
  MAX_PUBLIC_HISTORY_SQL_CHARACTERS,
  OBSERVABILITY_CONTRACT_VERSION,
  publicHistoryQueryResultSchema,
  retentionPolicySchema,
  retentionResultSchema,
  rootTracePageSchema,
  rootTraceQuerySchema,
  setHistoryPageSchema,
  setHistoryQuerySchema,
  setHistoryRecordSchema,
  telemetryDeleteFilterSchema,
  telemetryEventEnvelopeSchema,
  telemetryEventPageSchema,
  telemetryIdSchema,
  telemetryQuerySchema,
  type AgentHistoryPage,
  type AgentHistoryQuery,
  type AgentHistoryRecord,
  type ConfigurationSnapshot,
  type ConfigurationSnapshotPage,
  type ConfigurationSnapshotQuery,
  type JournalHealth,
  type PublicHistoryQueryResult,
  type PublicHistorySqlValue,
  type RootTracePage,
  type RootTraceQuery,
  type SetHistoryPage,
  type SetHistoryQuery,
  type SetHistoryRecord,
  type RetentionPolicy,
  type RetentionPolicyInput,
  type RetentionResult,
  type TelemetryDeleteFilter,
  type TelemetryEventEnvelope,
  type TelemetryEventPage,
  type TelemetryQuery,
} from "./contracts.js";
import {
  JournalClosedError,
  JournalConflictError,
  JournalCursorError,
  JournalDuplicateError,
  JournalQueryError,
  JournalQueueFullError,
  JournalSchemaVersionError,
  ObservabilityJournalError,
} from "./errors.js";
import {
  observabilityMigrations,
  observabilitySchemaVersion,
} from "./migrations.js";
import type { ObservabilitySink } from "./recorder.js";
import { sanitizeTelemetryAttributes } from "./sanitizer.js";

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_BATCH_DELAY_MS = 20;

interface PendingEvent {
  readonly kind: "event";
  readonly value: TelemetryEventEnvelope;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingSnapshot {
  readonly kind: "snapshot";
  readonly value: ConfigurationSnapshot;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingAgentHistory {
  readonly kind: "agent_history";
  readonly value: AgentHistoryRecord;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingSetHistory {
  readonly kind: "set_history";
  readonly value: SetHistoryRecord;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

type PendingWrite =
  PendingEvent | PendingSnapshot | PendingAgentHistory | PendingSetHistory;

interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
}

interface WorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly name?: string;
    readonly stack?: string;
  };
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

interface WorkerBatchResult {
  readonly failures: readonly {
    readonly index: number;
    readonly code: string;
    readonly message: string;
  }[];
}

interface WorkerHealth {
  readonly version: 2;
  readonly status: "healthy" | "degraded";
  readonly schemaVersion: number;
  readonly persistedEvents: number;
  readonly persistedConfigurationSnapshots: number;
  readonly databaseBytes: number;
  readonly oldestEventAt: string | null;
  readonly newestEventAt: string | null;
  readonly lastFlushAt: string | null;
  readonly lastError: JournalHealth["lastError"];
  readonly retention: RetentionPolicy;
}

interface ClosedHealth {
  readonly persistedEvents: number;
  readonly persistedConfigurationSnapshots: number;
  readonly databaseBytes: number;
  readonly lastFlushAt: string | null;
}

export interface ObservabilityJournalOptions {
  /** Database path. Omit or pass `:memory:` for a non-durable journal. */
  readonly path?: string;
  /** Maximum records sent to the worker in one transaction. Defaults to 64. */
  readonly batchSize?: number;
  /** Time used to collect a write batch. Defaults to 20 milliseconds. */
  readonly batchDelayMs?: number;
  /** Maximum accepted writes waiting for worker persistence. Defaults to 10,000. */
  readonly maxPendingWrites?: number;
  readonly retention?: RetentionPolicyInput;
  /** Injectable clock for deterministic hosts and tests. */
  readonly now?: () => Date;
  /** Worker construction override for host integration and failure testing. */
  readonly workerFactory?: (workerUrl: URL) => Worker;
}

export interface TraceReadOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

export interface DeleteResult {
  readonly deletedEvents: number;
  readonly deletedConfigurationSnapshots: number;
}

/**
 * Proxy for the worker-owned SQLite journal. The caller thread only validates,
 * sanitizes, queues, and exchanges structured-clone messages; SQL.js export,
 * queries, retention, VACUUM, locking, and filesystem work stay in the worker.
 */
export class LocalObservabilityJournal implements ObservabilitySink {
  readonly #worker: Worker;
  readonly #path: string | undefined;
  readonly #batchSize: number;
  readonly #batchDelayMs: number;
  readonly #maxPendingWrites: number;
  readonly #retention: RetentionPolicy;
  readonly #now: () => Date;
  readonly #pending: PendingWrite[] = [];
  readonly #pendingIds = new Set<string>();
  readonly #requests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  #nextRequestId = 1;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #accepting = true;
  #closed = false;
  #terminating = false;
  #terminalFailure: ObservabilityJournalError | undefined;
  #inFlightWrites = 0;
  #rejectedWrites = 0;
  #closedHealth: ClosedHealth | undefined;

  private constructor(
    worker: Worker,
    path: string | undefined,
    options: {
      readonly batchSize: number;
      readonly batchDelayMs: number;
      readonly maxPendingWrites: number;
      readonly retention: RetentionPolicy;
      readonly now: () => Date;
    },
  ) {
    this.#worker = worker;
    this.#path = path;
    this.#batchSize = options.batchSize;
    this.#batchDelayMs = options.batchDelayMs;
    this.#maxPendingWrites = options.maxPendingWrites;
    this.#retention = options.retention;
    this.#now = options.now;
    worker.on("message", (message: WorkerResponse) => {
      this.#handleWorkerMessage(message);
    });
    worker.on("error", (error) => {
      this.#failWorker(error);
    });
    worker.on("exit", (code) => {
      if (!this.#terminating) {
        this.#failWorker(
          new ObservabilityJournalError(
            "io",
            `The observability journal worker exited with code ${code}`,
          ),
        );
      }
    });
  }

  public static async open(
    options: ObservabilityJournalOptions = {},
  ): Promise<LocalObservabilityJournal> {
    const batchSize = positiveInteger(
      options.batchSize,
      DEFAULT_BATCH_SIZE,
      "batchSize",
    );
    const batchDelayMs = integerRange(
      options.batchDelayMs,
      DEFAULT_BATCH_DELAY_MS,
      0,
      60_000,
      "batchDelayMs",
    );
    const maxPendingWrites = positiveInteger(
      options.maxPendingWrites,
      DEFAULT_MAX_PENDING_WRITES,
      "maxPendingWrites",
    );
    const retention = retentionPolicySchema.parse(options.retention ?? {});
    const now = options.now ?? (() => new Date());
    const workerUrl = new URL("./journal-worker.mjs", import.meta.url);
    const worker =
      options.workerFactory?.(workerUrl) ??
      new Worker(workerUrl, {
        name: "ableton-observability-journal",
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith("--input-type"),
        ),
      });
    const journal = new LocalObservabilityJournal(worker, options.path, {
      batchSize,
      batchDelayMs,
      maxPendingWrites,
      retention,
      now,
    });
    try {
      await journal.#call("open", {
        path: options.path,
        retention,
        migrations: observabilityMigrations,
        schemaVersion: observabilitySchemaVersion,
        nowIso: now().toISOString(),
      });
      return journal;
    } catch (error) {
      journal.#terminating = true;
      await worker.terminate();
      throw error;
    }
  }

  public get databasePath(): string | undefined {
    return this.#path;
  }

  public get schemaVersion(): number {
    return observabilitySchemaVersion;
  }

  public get isOpen(): boolean {
    return !this.#closed && this.#terminalFailure === undefined;
  }

  /** Nonzero Node worker thread identifier while the journal is open. */
  public get workerThreadId(): number {
    return this.#worker.threadId;
  }

  public enqueue(event: TelemetryEventEnvelope): Promise<void> {
    if (this.#terminalFailure !== undefined)
      return Promise.reject(this.#terminalFailure);
    if (!this.#accepting || this.#closed)
      return Promise.reject(new JournalClosedError());
    const parsed = telemetryEventEnvelopeSchema.parse({
      ...event,
      attributes: sanitizeTelemetryAttributes(event.attributes),
    });
    return this.#enqueueWrite("event", parsed);
  }

  public enqueueConfigurationSnapshot(
    snapshot: ConfigurationSnapshot,
  ): Promise<void> {
    if (this.#terminalFailure !== undefined)
      return Promise.reject(this.#terminalFailure);
    if (!this.#accepting || this.#closed)
      return Promise.reject(new JournalClosedError());
    const parsed = configurationSnapshotSchema.parse({
      ...snapshot,
      values: sanitizeTelemetryAttributes(snapshot.values),
    });
    return this.#enqueueWrite("snapshot", parsed);
  }

  public appendAgentHistory(record: AgentHistoryRecord): Promise<void> {
    if (this.#terminalFailure !== undefined)
      return Promise.reject(this.#terminalFailure);
    if (!this.#accepting || this.#closed)
      return Promise.reject(new JournalClosedError());
    const parsed = agentHistoryRecordSchema.parse(
      sanitizeTelemetryAttributes(record),
    );
    return this.#enqueueWrite("agent_history", parsed);
  }

  public appendSetHistory(record: SetHistoryRecord): Promise<void> {
    if (this.#terminalFailure !== undefined)
      return Promise.reject(this.#terminalFailure);
    if (!this.#accepting || this.#closed)
      return Promise.reject(new JournalClosedError());
    const parsed = setHistoryRecordSchema.parse(
      sanitizeTelemetryAttributes(record),
    );
    return this.#enqueueWrite("set_history", parsed);
  }

  public async read(query: TelemetryQuery = {}): Promise<TelemetryEventPage> {
    return this.readEvents(query);
  }

  /** Paginates root traces, never individual child events. */
  public async readRootTraces(
    query: RootTraceQuery = {},
  ): Promise<RootTracePage> {
    this.#assertOpen();
    const parsed = rootTraceQuerySchema.parse(query);
    await this.#flushPending();
    return rootTracePageSchema.parse(
      await this.#call("readRootTraces", { query: parsed }),
    );
  }

  /** Reads one complete root trace with child-event pagination metadata. */
  public async readTrace(
    rootTraceId: string,
    options: TraceReadOptions = {},
  ): Promise<TelemetryEventPage> {
    this.#assertOpen();
    const parsedRootTraceId = telemetryIdSchema.parse(rootTraceId);
    const query = telemetryQuerySchema.parse(options);
    await this.#flushPending();
    return telemetryEventPageSchema.parse(
      await this.#call("readTrace", {
        rootTraceId: parsedRootTraceId,
        query,
      }),
    );
  }

  /**
   * Explicit child-event query retained for diagnostics that need event-level
   * pagination. History callers should use {@link readRootTraces}.
   */
  public async readEvents(
    query: TelemetryQuery = {},
  ): Promise<TelemetryEventPage> {
    this.#assertOpen();
    const parsed = telemetryQuerySchema.parse(query);
    await this.#flushPending();
    return telemetryEventPageSchema.parse(
      await this.#call("readEvents", { query: parsed }),
    );
  }

  public async readConfigurationSnapshots(
    query: ConfigurationSnapshotQuery = {},
  ): Promise<ConfigurationSnapshotPage> {
    this.#assertOpen();
    const parsed = configurationSnapshotQuerySchema.parse(query);
    await this.#flushPending();
    return configurationSnapshotPageSchema.parse(
      await this.#call("readSnapshots", { query: parsed }),
    );
  }

  public async readAgentHistory(
    query: AgentHistoryQuery = {},
  ): Promise<AgentHistoryPage> {
    this.#assertOpen();
    const parsed = agentHistoryQuerySchema.parse(query);
    await this.#flushPending();
    return agentHistoryPageSchema.parse(
      await this.#call("readAgentHistory", { query: parsed }),
    );
  }

  public async readSetHistory(
    query: SetHistoryQuery = {},
  ): Promise<SetHistoryPage> {
    this.#assertOpen();
    const parsed = setHistoryQuerySchema.parse(query);
    await this.#flushPending();
    return setHistoryPageSchema.parse(
      await this.#call("readSetHistory", { query: parsed }),
    );
  }

  public async queryPublicHistory(
    sql: string,
    parameters: readonly PublicHistorySqlValue[],
    maxRows: number,
  ): Promise<PublicHistoryQueryResult> {
    this.#assertOpen();
    if (
      typeof sql !== "string" ||
      sql.length === 0 ||
      sql.length > MAX_PUBLIC_HISTORY_SQL_CHARACTERS
    ) {
      throw new JournalQueryError(
        `Public history SQL must contain 1-${MAX_PUBLIC_HISTORY_SQL_CHARACTERS} characters`,
      );
    }
    if (
      !Array.isArray(parameters) ||
      parameters.length > MAX_PUBLIC_HISTORY_PARAMETERS
    ) {
      throw new JournalQueryError(
        `Public history SQL accepts at most ${MAX_PUBLIC_HISTORY_PARAMETERS} parameters`,
      );
    }
    for (const value of parameters) {
      if (
        value !== null &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value)) &&
        !(
          typeof value === "string" &&
          value.length <= MAX_PUBLIC_HISTORY_CELL_CHARACTERS
        )
      ) {
        throw new JournalQueryError(
          "Public history SQL parameters must be bounded scalar values",
        );
      }
    }
    if (
      !Number.isSafeInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > MAX_PUBLIC_HISTORY_ROWS
    ) {
      throw new JournalQueryError(
        `Public history maxRows must be between 1 and ${MAX_PUBLIC_HISTORY_ROWS}`,
      );
    }
    await this.#flushPending();
    return publicHistoryQueryResultSchema.parse(
      await this.#call("queryPublicHistory", {
        sql,
        parameters,
        maxRows,
      }),
    );
  }

  public async readLatestConfigurationSnapshot(
    component: string,
  ): Promise<ConfigurationSnapshotPage["items"][number] | undefined> {
    const page = await this.readConfigurationSnapshots({
      components: [component],
      limit: 1,
      order: "desc",
    });
    return page.items[0];
  }

  public async deleteEvents(
    filter: TelemetryDeleteFilter = {},
  ): Promise<number> {
    this.#assertOpen();
    const parsed = telemetryDeleteFilterSchema.parse(filter);
    await this.#flushPending();
    return this.#call<number>("deleteEvents", { filter: parsed });
  }

  public async deleteTrace(rootTraceId: string): Promise<number> {
    this.#assertOpen();
    const parsed = telemetryIdSchema.parse(rootTraceId);
    await this.#flushPending();
    return this.#call<number>("deleteTrace", { rootTraceId: parsed });
  }

  public async deleteConfigurationSnapshots(
    query: Pick<
      ConfigurationSnapshotQuery,
      | "components"
      | "liveSetId"
      | "liveProjectId"
      | "sessionId"
      | "activeAgentId"
      | "from"
      | "to"
    > = {},
  ): Promise<number> {
    this.#assertOpen();
    const parsed = configurationSnapshotDeleteFilterSchema.parse(query);
    await this.#flushPending();
    return this.#call<number>("deleteSnapshots", { filter: parsed });
  }

  public async clear(): Promise<DeleteResult> {
    this.#assertOpen();
    await this.#flushPending();
    return this.#call<DeleteResult>("clear", {});
  }

  public async runRetention(): Promise<RetentionResult> {
    this.#assertOpen();
    await this.#flushPending();
    return retentionResultSchema.parse(
      await this.#call("retention", { nowIso: this.#now().toISOString() }),
    );
  }

  /** Waits until the worker has durably published all previously accepted data. */
  public async flush(): Promise<void> {
    this.#assertOpen();
    await this.#flushPending();
    await this.#call("flush", { nowIso: this.#now().toISOString() });
  }

  public async getHealth(): Promise<JournalHealth> {
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
    if (this.#closed) {
      const health = this.#closedHealth;
      return journalHealthSchema.parse({
        version: OBSERVABILITY_CONTRACT_VERSION,
        status: "closed",
        schemaVersion: observabilitySchemaVersion,
        pendingWrites: 0,
        persistedEvents: health?.persistedEvents ?? 0,
        persistedConfigurationSnapshots:
          health?.persistedConfigurationSnapshots ?? 0,
        rejectedWrites: this.#rejectedWrites,
        maxPendingWrites: this.#maxPendingWrites,
        databaseBytes: health?.databaseBytes ?? 0,
        oldestEventAt: null,
        newestEventAt: null,
        lastFlushAt: health?.lastFlushAt ?? null,
        lastError: null,
        retention: this.#retention,
      });
    }
    const workerHealth = await this.#call<WorkerHealth>("health", {});
    return journalHealthSchema.parse({
      ...workerHealth,
      pendingWrites: this.#pending.length + this.#inFlightWrites,
      rejectedWrites: this.#rejectedWrites,
      maxPendingWrites: this.#maxPendingWrites,
    });
  }

  public async shutdown(): Promise<void> {
    if (this.#closed) return;
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
    await Promise.resolve();
    this.#accepting = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#flushPending();
    try {
      this.#closedHealth = await this.#call<ClosedHealth>("shutdown", {
        nowIso: this.#now().toISOString(),
      });
    } finally {
      this.#terminating = true;
      this.#closed = true;
      await this.#worker.terminate();
    }
  }

  public close(): Promise<void> {
    return this.shutdown();
  }

  #enqueueWrite(
    kind: PendingWrite["kind"],
    value:
      | TelemetryEventEnvelope
      | ConfigurationSnapshot
      | AgentHistoryRecord
      | SetHistoryRecord,
  ): Promise<void> {
    if (this.#pending.length + this.#inFlightWrites >= this.#maxPendingWrites) {
      this.#rejectedWrites += 1;
      return Promise.reject(new JournalQueueFullError(this.#maxPendingWrites));
    }
    if (this.#pendingIds.has(value.id)) {
      this.#rejectedWrites += 1;
      return Promise.reject(
        new JournalDuplicateError(
          kind === "event" ? "event" : "configuration snapshot",
          value.id,
        ),
      );
    }
    const result = new Promise<void>((resolve, reject) => {
      if (kind === "event") {
        this.#pending.push({
          kind,
          value: value as TelemetryEventEnvelope,
          resolve,
          reject,
        });
      } else if (kind === "snapshot") {
        this.#pending.push({
          kind,
          value: value as ConfigurationSnapshot,
          resolve,
          reject,
        });
      } else if (kind === "agent_history") {
        this.#pending.push({
          kind,
          value: value as AgentHistoryRecord,
          resolve,
          reject,
        });
      } else {
        this.#pending.push({
          kind,
          value: value as SetHistoryRecord,
          resolve,
          reject,
        });
      }
    });
    this.#pendingIds.add(value.id);
    this.#scheduleDrain();
    return result;
  }

  #scheduleDrain(): void {
    if (this.#terminalFailure !== undefined) return;
    if (this.#pending.length >= this.#batchSize) {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#startDrain();
      return;
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      this.#startDrain();
    }, this.#batchDelayMs);
  }

  #startDrain(): void {
    const batch = this.#pending.splice(0, this.#batchSize);
    if (batch.length === 0) return;
    this.#inFlightWrites += batch.length;
    void this.#call<WorkerBatchResult>("batch", {
      writes: batch.map(({ kind, value }) => ({ kind, value })),
      nowIso: this.#now().toISOString(),
    })
      .then(
        ({ failures }) => {
          const byIndex = new Map(
            failures.map((failure) => [failure.index, failure]),
          );
          batch.forEach((item, index) => {
            const workerFailure = byIndex.get(index);
            if (workerFailure === undefined) {
              item.resolve();
            } else {
              this.#rejectedWrites += 1;
              item.reject(
                new JournalDuplicateError(
                  item.kind === "event"
                    ? "event"
                    : item.kind === "snapshot"
                      ? "configuration snapshot"
                      : item.kind === "agent_history"
                        ? "agent history"
                        : "set history",
                  item.value.id,
                ),
              );
            }
          });
        },
        (error: unknown) => {
          for (const item of batch) {
            this.#rejectedWrites += 1;
            item.reject(error);
          }
        },
      )
      .finally(() => {
        for (const item of batch) this.#pendingIds.delete(item.value.id);
        this.#inFlightWrites -= batch.length;
        if (this.#pending.length > 0) this.#scheduleDrain();
      });
  }

  async #flushPending(): Promise<void> {
    // Producer adapters enqueue on a microtask so their public methods remain
    // strictly void/non-blocking. Include those same-turn writes in barriers.
    await Promise.resolve();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    while (this.#pending.length > 0) this.#startDrain();
    while (this.#inFlightWrites > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  #call<T = unknown>(method: string, args: unknown): Promise<T> {
    if (this.#terminalFailure !== undefined)
      return Promise.reject(this.#terminalFailure);
    if (this.#closed) return Promise.reject(new JournalClosedError());
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      this.#requests.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
      this.#worker.postMessage({ id, method, args });
    });
  }

  #handleWorkerMessage(message: WorkerResponse): void {
    const request = this.#requests.get(message.id);
    if (request === undefined) return;
    this.#requests.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(workerError(message.error));
  }

  #failWorker(error: unknown): void {
    if (this.#terminalFailure !== undefined) return;
    const failure =
      error instanceof ObservabilityJournalError
        ? error
        : new ObservabilityJournalError(
            "io",
            "The observability journal worker failed",
            { cause: error },
          );
    this.#terminalFailure = failure;
    this.#accepting = false;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    for (const item of this.#pending.splice(0)) {
      this.#pendingIds.delete(item.value.id);
      this.#rejectedWrites += 1;
      item.reject(failure);
    }
    for (const request of this.#requests.values()) request.reject(failure);
    this.#requests.clear();
  }

  #assertOpen(): void {
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
    if (this.#closed) throw new JournalClosedError();
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function integerRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function workerError(error: WorkerFailure["error"]): Error {
  switch (error.code) {
    case "closed":
      return new JournalClosedError();
    case "conflict":
      return new JournalConflictError(error.message);
    case "invalid_cursor":
      return new JournalCursorError(error.message);
    case "invalid_query":
      return new JournalQueryError(error.message);
    case "schema_version":
      return new JournalSchemaVersionError(error.message);
    default:
      return new ObservabilityJournalError(
        error.code === "corrupt_database" ? "corrupt_database" : "io",
        error.message,
      );
  }
}
