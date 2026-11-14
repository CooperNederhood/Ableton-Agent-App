import { randomUUID } from "node:crypto";
import type { BindParams, Database } from "sql.js";
import { sanitizePersistedText } from "@ableton-agent/observability";
import {
  acceptMetricRecordChunk,
  createMetricRecordStreamState,
  verifyMetricRecordStreamManifest,
  metricRecordChunkSchema,
  metricRecordChunkDigest,
  metricRecordStreamManifestSchema,
  metricRecordStreamDescriptorSchema,
  createContinuousMetricListeningGeometry,
  canonicalMetricRecordJson,
  type MetricRecordChunk,
  type MetricRecordStreamManifest,
  type MetricRecordStreamDescriptor,
} from "@ableton-agent/protocol";
import type { ContextOperationOptions } from "./context-repository.js";
import { RepositoryConflictError } from "./repository.js";
import {
  metricCaptureMetadataSchema,
  metricCaptureRecordSchema,
  metricCaptureQuerySchema,
  metricCaptureStartSchema,
  metricCaptureOwnerSchema,
  metricChunkQuerySchema,
  METRIC_CAPTURE_STORAGE_LIMITS,
  METRIC_CAPTURE_CONTEXT_KIND,
  type MetricCaptureMetadata,
  type MetricCaptureOwner,
  type MetricCaptureRecord,
  type MetricCaptureStatus,
  type MetricCaptureStart,
  type MetricCaptureQuery,
  type MetricCapturePage,
  type MetricCapturePublication,
  type MetricChunkPage,
  type MetricChunkQuery,
} from "./metric-capture-schemas.js";
import {
  listeningPassSchema,
  type ListeningPass,
  type ContextTrace,
} from "./context-schemas.js";

type InternalMetricCaptureRecord = Omit<MetricCaptureRecord, "descriptor"> & {
  descriptor: MetricRecordStreamDescriptor;
};

export interface MetricCaptureBackend {
  readonly database: () => Database;
  readonly sessionId: string;
  readonly liveSetId: () => string;
  readonly now: () => string;
  readonly maxPassBytes: number;
  readonly passAllowance: (passId: string) => number;
  readonly releaseReservation: (passId: string) => void;
  readonly quotaError: (message: string) => Error;
  readonly sanitize: (value: unknown) => unknown;
  readonly transaction: (
    operation: () => void,
    signal?: AbortSignal,
    compact?: boolean,
    reservationId?: string,
  ) => Promise<void>;
  readonly operation: <T>(
    action: string,
    options: ContextOperationOptions,
    operation: (
      progress: (attributes: Record<string, unknown>) => void,
    ) => Promise<T>,
    onFailure?: (error: unknown) => Promise<void>,
  ) => Promise<T>;
  readonly publishSession: (
    pass: ListeningPass,
    options: ContextOperationOptions,
  ) => Promise<void>;
}

function select(
  database: Database,
  sql: string,
  parameters: BindParams,
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

export class MetricCaptureRepository {
  readonly #ownerTraces = new Map<
    string,
    { trace: ContextTrace; activeAgentId: string }
  >();
  public constructor(private readonly backend: MetricCaptureBackend) {}

  public begin(
    input: MetricCaptureStart,
    options: ContextOperationOptions = {},
  ): Promise<MetricCaptureOwner> {
    return this.backend.operation(
      "metric-stage",
      {
        ...options,
        trace: options.trace ?? input.metadata.trace,
        activeAgentId:
          options.activeAgentId ?? input.metadata.pass.initiatorAgentId,
      },
      async () => {
        const { descriptor } = metricCaptureStartSchema.parse(input);
        this.assertSanitized(descriptor);
        const metadata = this.validateMetadata(input.metadata);
        if (
          descriptor.ownership.passId !== metadata.pass.id ||
          descriptor.ownership.listenerId !== metadata.producer.listenerId ||
          descriptor.ownership.connectionEpoch !==
            metadata.producer.connectionEpoch ||
          descriptor.ownership.traceId !== metadata.trace.traceId ||
          descriptor.ownership.correlationId !== metadata.trace.correlationId ||
          descriptor.ownership.causationId !== metadata.trace.causationId ||
          canonicalMetricRecordJson(metadata.trace) !==
            canonicalMetricRecordJson(metadata.pass.trace) ||
          metadata.pass.listenerIds.length !== 1 ||
          canonicalMetricRecordJson(metadata.pass.requestedRange) !==
            canonicalMetricRecordJson({
              startBeat: descriptor.geometry.startBeat,
              endBeat: descriptor.geometry.endBeat,
            }) ||
          canonicalMetricRecordJson(
            metadata.subject.binding.semanticLocator.arrangementRange,
          ) !== canonicalMetricRecordJson(metadata.pass.requestedRange)
        )
          throw new RepositoryConflictError(
            "Capture descriptor disagrees with frozen context identity or range",
          );
        const state = await createMetricRecordStreamState(descriptor);
        const owner = { captureId: metadata.id, ownerToken: randomUUID() };
        const record: InternalMetricCaptureRecord = {
          kind: METRIC_CAPTURE_CONTEXT_KIND,
          metadata,
          descriptor,
          state,
          status: "staging",
          chunkCount: 0,
          storedBytes: 0,
          updatedAt: this.backend.now(),
          reason: null,
          manifest: null,
        };
        const payload = this.encode(record);
        if (
          Buffer.byteLength(payload) >
          METRIC_CAPTURE_STORAGE_LIMITS.metadataBytes
        )
          throw this.backend.quotaError(
            "Metric capture descriptor exceeds bounded metadata allowance",
          );
        if (
          select(
            this.backend.database(),
            "SELECT id FROM context_passes WHERE id = ?",
            [metadata.pass.id],
          ).length > 0
        )
          throw new RepositoryConflictError(
            "Capture pass is already published",
          );
        if (
          select(
            this.backend.database(),
            "SELECT id FROM context_metric_captures WHERE id = ? OR pass_id = ?",
            [metadata.id, metadata.pass.id],
          ).length > 0
        )
          throw new RepositoryConflictError(
            "Capture identity is already staged or retained",
          );
        if (
          select(
            this.backend.database(),
            "SELECT id FROM context_entries WHERE id = ?",
            [metadata.id],
          ).length > 0
        )
          throw new RepositoryConflictError(
            "Context ID already belongs to a whole-observation entry",
          );
        if (
          select(
            this.backend.database(),
            "SELECT id FROM context_metric_captures WHERE status IN ('staging', 'sealed') LIMIT 32",
            [],
          ).length >= 32
        )
          throw this.backend.quotaError("Too many staged metric captures");
        await this.backend.publishSession(metadata.pass, options);
        await this.backend.transaction(
          () => {
            this.backend
              .database()
              .run(
                "INSERT INTO context_metric_captures (id, pass_id, subject_id, listener_id, status, owner_token, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                  metadata.id,
                  metadata.pass.id,
                  metadata.subject.id,
                  metadata.producer.listenerId,
                  "staging",
                  owner.ownerToken,
                  payload,
                ],
              );
          },
          options.signal,
          false,
          metadata.pass.id,
        );
        this.#ownerTraces.set(owner.captureId, {
          trace: metadata.trace,
          activeAgentId: metadata.pass.initiatorAgentId,
        });
        if (this.#ownerTraces.size > 128)
          this.#ownerTraces.delete(this.#ownerTraces.keys().next().value!);
        return owner;
      },
    );
  }

  public append(
    input: MetricCaptureOwner,
    rawChunk: MetricRecordChunk,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    return this.backend.operation(
      "metric-chunk",
      this.ownerOptions(input, options),
      async (progress) => {
        const owner = metricCaptureOwnerSchema.parse(input);
        const row = this.owned(owner);
        const record = this.decode(row.payload);
        const chunk = metricRecordChunkSchema.parse(rawChunk);
        this.assertSanitized(chunk);
        const state = await acceptMetricRecordChunk(
          record.descriptor,
          record.state,
          chunk,
        );
        const payload = JSON.stringify(chunk);
        const storedBytes = record.storedBytes + Buffer.byteLength(payload);
        if (
          storedBytes >
          Math.min(
            this.backend.maxPassBytes,
            this.backend.passAllowance(record.metadata.pass.id),
          )
        )
          throw this.backend.quotaError(
            "Incremental metric pass exceeds configured allowance",
          );
        const supports = [
          ...chunk.records.map((item) => item.support),
          ...chunk.gaps.map((item) => item.support),
        ];
        await this.backend.transaction(
          () => {
            this.backend
              .database()
              .run(
                "INSERT INTO context_metric_chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                  owner.captureId,
                  record.chunkCount,
                  chunk.metric,
                  chunk.chunkSequence,
                  Math.min(...supports.map((item) => item.startSample)),
                  Math.max(...supports.map((item) => item.endSample)),
                  chunk.digest,
                  payload,
                ],
              );
            this.backend
              .database()
              .run(
                "UPDATE context_metric_captures SET stored_bytes = ?, payload = ? WHERE id = ?",
                [
                  storedBytes,
                  this.encode({
                    ...record,
                    state,
                    storedBytes,
                    chunkCount: record.chunkCount + 1,
                    updatedAt: this.backend.now(),
                  }),
                  owner.captureId,
                ],
              );
          },
          options.signal,
          false,
          record.metadata.pass.id,
        );
        progress({
          captureId: owner.captureId,
          metric: chunk.metric,
          durableChunks: record.chunkCount + 1,
          durableBytes: storedBytes,
        });
      },
      (error) => this.classifyFailure(input, options, error),
    );
  }

  public finalize(
    input: MetricCaptureOwner,
    rawManifest: MetricRecordStreamManifest,
    rawPass: ListeningPass,
    options: ContextOperationOptions = {},
  ): Promise<MetricCapturePublication> {
    return this.backend.operation(
      "metric-finalize",
      {
        ...options,
        trace: options.trace ?? rawPass.trace,
        activeAgentId: options.activeAgentId ?? rawPass.initiatorAgentId,
      },
      async (progress) => {
        const owner = metricCaptureOwnerSchema.parse(input);
        const record = this.decode(this.owned(owner, true).payload);
        const manifest = metricRecordStreamManifestSchema.parse(rawManifest);
        this.assertSanitized(manifest);
        const pass = listeningPassSchema.parse(
          this.backend.sanitize(listeningPassSchema.parse(rawPass)),
        );
        const provisional = record.metadata.pass;
        if (
          !pass.complete ||
          pass.status !== "completed" ||
          pass.actualMode !== "arrangement" ||
          pass.requestedMode !== provisional.requestedMode ||
          pass.interruptionReason !== null ||
          manifest.outcome !== "complete" ||
          pass.id !== provisional.id ||
          pass.sessionId !== provisional.sessionId ||
          pass.liveSetId !== provisional.liveSetId ||
          pass.initiatorAgentId !== provisional.initiatorAgentId ||
          pass.createdAt !== provisional.createdAt ||
          (provisional.startedAt !== null &&
            pass.startedAt !== provisional.startedAt) ||
          canonicalMetricRecordJson(pass.trace) !==
            canonicalMetricRecordJson(provisional.trace) ||
          canonicalMetricRecordJson(pass.listenerIds) !==
            canonicalMetricRecordJson(provisional.listenerIds) ||
          canonicalMetricRecordJson(pass.requestedRange) !==
            canonicalMetricRecordJson(provisional.requestedRange) ||
          canonicalMetricRecordJson(pass.actualRange) !==
            canonicalMetricRecordJson(provisional.requestedRange)
        )
          throw new RepositoryConflictError(
            "Only independently complete captures may publish the frozen pass",
          );
        const verified = await this.verifyDurable(
          record,
          manifest,
          options,
          progress,
        );
        await this.backend.publishSession(pass, options);
        await this.backend.transaction(
          () => {
            const previousSubject = select(
              this.backend.database(),
              "SELECT payload FROM context_subjects WHERE id = ?",
              [record.metadata.subject.id],
            )[0];
            const subjectPayload = JSON.stringify(record.metadata.subject);
            if (
              previousSubject !== undefined &&
              previousSubject.payload !== subjectPayload
            )
              throw new RepositoryConflictError(
                "Immutable metric subject cannot be overwritten",
              );
            this.backend
              .database()
              .run("INSERT OR IGNORE INTO context_subjects VALUES (?, ?)", [
                record.metadata.subject.id,
                subjectPayload,
              ]);
            this.backend
              .database()
              .run("INSERT INTO context_passes VALUES (?, ?, ?)", [
                pass.id,
                pass.createdAt,
                JSON.stringify(pass),
              ]);
            this.backend
              .database()
              .run(
                "UPDATE context_metric_captures SET status = 'completed', owner_token = '', payload = ? WHERE id = ?",
                [
                  this.encode({
                    ...record,
                    metadata: { ...record.metadata, pass },
                    status: "completed",
                    manifest,
                    updatedAt: this.backend.now(),
                  }),
                  owner.captureId,
                ],
              );
          },
          options.signal,
          false,
          pass.id,
        );
        progress({
          captureId: owner.captureId,
          ...verified,
          published: true,
        });
        return {
          contextId: record.metadata.id,
          kind: METRIC_CAPTURE_CONTEXT_KIND,
          passId: pass.id,
          subjectId: record.metadata.subject.id,
          listenerId: record.metadata.producer.listenerId,
        };
      },
      (error) => this.classifyFailure(input, options, error),
    );
  }

  public seal(
    input: MetricCaptureOwner,
    rawManifest: MetricRecordStreamManifest,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    return this.backend.operation(
      "metric-seal",
      this.ownerOptions(input, options),
      async (progress) => {
        const owner = metricCaptureOwnerSchema.parse(input);
        const record = this.decode(this.owned(owner).payload);
        const manifest = metricRecordStreamManifestSchema.parse(rawManifest);
        this.assertSanitized(manifest);
        const verified = await this.verifyDurable(
          record,
          manifest,
          options,
          progress,
        );
        await this.backend.transaction(
          () => {
            this.backend
              .database()
              .run(
                "UPDATE context_metric_captures SET status = 'sealed', payload = ? WHERE id = ?",
                [
                  this.encode({
                    ...record,
                    status: "sealed",
                    manifest,
                    updatedAt: this.backend.now(),
                  }),
                  owner.captureId,
                ],
              );
          },
          options.signal,
          false,
          record.metadata.pass.id,
        );
        progress({
          captureId: owner.captureId,
          ...verified,
          sealed: true,
          published: false,
        });
      },
      (error) => this.classifyFailure(input, options, error),
    );
  }

  private async verifyDurable(
    record: InternalMetricCaptureRecord,
    manifest: MetricRecordStreamManifest,
    options: ContextOperationOptions,
    progress: (attributes: Record<string, unknown>) => void,
  ): Promise<{ verifiedChunks: number; verifiedBytes: number }> {
    if (
      manifest.outcome !== "complete" ||
      (record.status === "sealed" &&
        canonicalMetricRecordJson(record.manifest) !==
          canonicalMetricRecordJson(manifest))
    )
      throw new RepositoryConflictError(
        "Metric seal requires the identical complete terminal manifest",
      );
    let state = await createMetricRecordStreamState(record.descriptor);
    let verifiedChunks = 0;
    let verifiedBytes = 0;
    // Keyset iteration holds one bounded chunk, never all rows or a terminal timeline.
    while (verifiedChunks < record.chunkCount) {
      options.signal?.throwIfAborted();
      const row = select(
        this.backend.database(),
        "SELECT * FROM context_metric_chunks WHERE capture_id = ? AND sequence = ?",
        [record.metadata.id, verifiedChunks],
      )[0];
      if (row === undefined)
        throw new Error("Durable metric chunk sequence is incomplete");
      const chunk = metricRecordChunkSchema.parse(
        JSON.parse(String(row.payload)),
      );
      this.assertChunkIndex(row, chunk);
      state = await acceptMetricRecordChunk(record.descriptor, state, chunk);
      verifiedBytes += Buffer.byteLength(String(row.payload));
      verifiedChunks++;
      if (verifiedChunks % 64 === 0)
        progress({
          captureId: record.metadata.id,
          verifiedChunks,
          verifiedBytes,
        });
    }
    const total = select(
      this.backend.database(),
      "SELECT COUNT(*) AS count FROM context_metric_chunks WHERE capture_id = ?",
      [record.metadata.id],
    )[0];
    if (
      Number(total?.count) !== verifiedChunks ||
      verifiedBytes !== record.storedBytes ||
      canonicalMetricRecordJson(state) !==
        canonicalMetricRecordJson(record.state)
    )
      throw new Error("Durable metric counts or state mismatch");
    await verifyMetricRecordStreamManifest(record.descriptor, state, manifest);
    return { verifiedChunks, verifiedBytes };
  }

  public get(
    id: string,
    options: ContextOperationOptions = {},
  ): Promise<MetricCaptureRecord | undefined> {
    return this.backend.operation("metric-overview", options, async () => {
      metricCaptureMetadataSchema.shape.id.parse(id);
      const row = select(
        this.backend.database(),
        "SELECT payload FROM context_metric_captures WHERE id = ?",
        [id],
      )[0];
      if (row === undefined) return undefined;
      return metricCaptureRecordSchema.parse(
        JSON.parse(this.encode(this.decode(row.payload))),
      );
    });
  }

  public list(
    rawQuery: MetricChunkQuery,
    options: ContextOperationOptions = {},
  ): Promise<MetricChunkPage> {
    return this.backend.operation("metric-page", options, async () => {
      const query = metricChunkQuerySchema.parse(rawQuery);
      const parameters: (string | number)[] = [
        query.captureId,
        query.afterSequence,
      ];
      let where = "capture_id = ? AND sequence > ?";
      if (query.metric !== undefined) {
        where += " AND metric = ?";
        parameters.push(query.metric);
      }
      if (query.range !== undefined) {
        where += " AND start_sample < ? AND end_sample > ?";
        parameters.push(query.range.endSample, query.range.startSample);
      }
      const items: MetricRecordChunk[] = [];
      let encodedBytes = 2;
      let lastSequence = query.afterSequence;
      // Fetch one row at a time: the byte budget applies before decoding.
      while (items.length < query.limit) {
        options.signal?.throwIfAborted();
        parameters[1] = lastSequence;
        const row = select(
          this.backend.database(),
          `SELECT * FROM context_metric_chunks WHERE ${where} ORDER BY sequence LIMIT 1`,
          parameters,
        )[0];
        if (row === undefined) return { items, encodedBytes };
        const bytes =
          Buffer.byteLength(String(row.payload)) + (items.length > 0 ? 1 : 0);
        if (encodedBytes + bytes > query.maxBytes) {
          if (items.length === 0)
            throw this.backend.quotaError(
              "Metric page budget cannot fit the next immutable chunk",
            );
          return { items, encodedBytes, nextSequence: lastSequence };
        }
        const chunk = metricRecordChunkSchema.parse(
          JSON.parse(String(row.payload)),
        );
        this.assertChunkIndex(row, chunk);
        this.assertSanitized(chunk);
        if ((await metricRecordChunkDigest(chunk)) !== chunk.digest)
          throw new Error("Stored metric chunk integrity check failed");
        options.signal?.throwIfAborted();
        items.push(chunk);
        encodedBytes += bytes;
        lastSequence = Number(row.sequence);
      }
      parameters[1] = lastSequence;
      const more =
        select(
          this.backend.database(),
          `SELECT sequence FROM context_metric_chunks WHERE ${where} ORDER BY sequence LIMIT 1`,
          parameters,
        ).length > 0;
      return {
        items,
        encodedBytes,
        ...(more ? { nextSequence: lastSequence } : {}),
      };
    });
  }

  public listCaptures(
    rawQuery: MetricCaptureQuery = {},
    options: ContextOperationOptions = {},
  ): Promise<MetricCapturePage> {
    return this.backend.operation("metric-inventory", options, async () => {
      const query = metricCaptureQuerySchema.parse(rawQuery);
      let where = "id > ? AND status = ?";
      const parameters: (string | number)[] = [
        query.afterId ?? "",
        query.status,
      ];
      for (const [field, value] of [
        ["pass_id", query.passId],
        ["subject_id", query.subjectId],
        ["listener_id", query.listenerId],
      ] as const) {
        if (value !== undefined) {
          where += ` AND ${field} = ?`;
          parameters.push(value);
        }
      }
      const items: MetricCaptureRecord[] = [];
      let encodedBytes = 2;
      let lastId = query.afterId ?? "";
      while (items.length < query.limit) {
        options.signal?.throwIfAborted();
        parameters[0] = lastId;
        const row = select(
          this.backend.database(),
          `SELECT id, payload FROM context_metric_captures WHERE ${where} ORDER BY id LIMIT 1`,
          parameters,
        )[0];
        if (row === undefined) return { items, encodedBytes };
        const bytes =
          Buffer.byteLength(String(row.payload)) + (items.length > 0 ? 1 : 0);
        if (encodedBytes + bytes > query.maxBytes) {
          if (items.length === 0)
            throw this.backend.quotaError(
              "Metric inventory budget cannot fit the next overview",
            );
          return { items, encodedBytes, nextId: lastId };
        }
        items.push(
          metricCaptureRecordSchema.parse(
            JSON.parse(this.encode(this.decode(row.payload))),
          ),
        );
        encodedBytes += bytes;
        lastId = String(row.id);
      }
      parameters[0] = lastId;
      const more =
        select(
          this.backend.database(),
          `SELECT id FROM context_metric_captures WHERE ${where} ORDER BY id LIMIT 1`,
          parameters,
        ).length > 0;
      return { items, encodedBytes, ...(more ? { nextId: lastId } : {}) };
    });
  }

  public recover(options: ContextOperationOptions = {}): Promise<void> {
    return this.backend.operation(
      "metric-recovery",
      options,
      async (progress) => {
        progress({
          interruptedCaptures: await this.interruptStaging(
            options.signal,
            progress,
          ),
        });
      },
    );
  }

  public async interruptStaging(
    signal?: AbortSignal,
    progress?: (attributes: Record<string, unknown>) => void,
  ): Promise<number> {
    const pending = select(
      this.backend.database(),
      "SELECT id, payload FROM context_metric_captures WHERE status IN ('staging', 'sealed')",
      [],
    );
    if (pending.length === 0) return 0;
    await this.backend.transaction(() => {
      for (const row of pending)
        this.setTerminal(
          String(row.id),
          "interrupted",
          "capture-owner-lost-before-publication",
        );
    }, signal);
    for (const row of pending) {
      const { metadata } = this.decode(row.payload);
      progress?.({
        captureId: metadata.id,
        passId: metadata.pass.id,
        status: "interrupted",
        originTraceId: metadata.trace.traceId,
        originCorrelationId: metadata.trace.correlationId,
        originCausationId: metadata.trace.causationId,
      });
    }
    this.#ownerTraces.clear();
    return pending.length;
  }

  public hasStaging(): boolean {
    return (
      select(
        this.backend.database(),
        "SELECT id FROM context_metric_captures WHERE status IN ('staging', 'sealed') LIMIT 1",
        [],
      ).length > 0
    );
  }

  public prunePasses(passIds: readonly string[]): void {
    for (const passId of passIds)
      this.backend
        .database()
        .run("DELETE FROM context_metric_captures WHERE pass_id = ?", [passId]);
  }

  public terminate(
    input: MetricCaptureOwner,
    status: Exclude<MetricCaptureStatus, "staging" | "sealed" | "completed">,
    reason: string,
    options: ContextOperationOptions = {},
  ): Promise<void> {
    return this.backend.operation(
      `metric-${status}`,
      this.ownerOptions(input, options),
      async () => {
        const owner = metricCaptureOwnerSchema.parse(input);
        if (!["failed", "cancelled", "interrupted"].includes(status))
          throw new TypeError("Only incomplete captures may be terminated");
        const record = this.decode(this.owned(owner, true).payload);
        await this.backend.transaction(
          () => this.setTerminal(owner.captureId, status, reason),
          options.signal,
          false,
          record.metadata.pass.id,
        );
        this.backend.releaseReservation(record.metadata.pass.id);
      },
    );
  }

  private validateMetadata(
    input: MetricCaptureMetadata,
  ): MetricCaptureMetadata {
    const metadata = metricCaptureMetadataSchema.parse(
      this.backend.sanitize(metricCaptureMetadataSchema.parse(input)),
    );
    if (
      Buffer.byteLength(JSON.stringify(metadata)) >
      METRIC_CAPTURE_STORAGE_LIMITS.metadataBytes
    )
      throw this.backend.quotaError(
        "Metric capture metadata exceeds bounded allowance",
      );
    for (const record of [metadata.pass, metadata.subject])
      if (
        record.sessionId !== this.backend.sessionId ||
        record.liveSetId !== this.backend.liveSetId()
      )
        throw new RepositoryConflictError(
          "Metric capture crosses session or Live Set ownership",
        );
    if (
      metadata.pass.complete ||
      metadata.pass.status === "completed" ||
      metadata.pass.requestedMode !== "arrangement" ||
      metadata.subject.kind !== "arrangement-range" ||
      !metadata.pass.listenerIds.includes(metadata.producer.listenerId)
    )
      throw new TypeError(
        "Staging requires an incomplete Arrangement pass and exact subject",
      );
    return metadata;
  }

  private assertSanitized(value: unknown): void {
    if (
      canonicalMetricRecordJson(this.backend.sanitize(value)) !==
      canonicalMetricRecordJson(value)
    )
      throw new TypeError(
        "Credential-bearing metric integrity payload is not persistable",
      );
  }

  private assertChunkIndex(
    row: Record<string, unknown>,
    chunk: MetricRecordChunk,
  ): void {
    const supports = [
      ...chunk.records.map((item) => item.support),
      ...chunk.gaps.map((item) => item.support),
    ];
    if (
      row.digest !== chunk.digest ||
      row.metric !== chunk.metric ||
      Number(row.metric_sequence) !== chunk.chunkSequence ||
      Number(row.start_sample) !==
        Math.min(...supports.map((item) => item.startSample)) ||
      Number(row.end_sample) !==
        Math.max(...supports.map((item) => item.endSample))
    )
      throw new Error("Stored metric chunk index or digest mismatch");
  }

  private decode(value: unknown): InternalMetricCaptureRecord {
    if (typeof value !== "string")
      throw new TypeError("Invalid metric capture metadata");
    if (Buffer.byteLength(value) > METRIC_CAPTURE_STORAGE_LIMITS.overviewBytes)
      throw this.backend.quotaError(
        "Stored metric overview exceeds bounded allowance",
      );
    const record = metricCaptureRecordSchema.parse(JSON.parse(value));
    if (record.metadata.pass.sessionId !== this.backend.sessionId)
      throw new RepositoryConflictError(
        "Metric context belongs to a different session",
      );
    const geometry = record.descriptor.geometry;
    const completeGeometry = createContinuousMetricListeningGeometry({
      captureMode: geometry.captureMode,
      sampleRate: geometry.sampleRate,
      vectorSize: geometry.vectorSize,
      tempoBpm: geometry.tempoBpm,
      startBeat: geometry.startBeat,
      endBeat: geometry.endBeat,
      startSample: geometry.startSample,
    });
    const { rows: _rows, ...expectedGeometry } = completeGeometry;
    void _rows;
    if (
      canonicalMetricRecordJson(expectedGeometry) !==
      canonicalMetricRecordJson(geometry)
    )
      throw new Error(
        "Stored metric geometry differs from independent admission",
      );
    return {
      ...record,
      descriptor: metricRecordStreamDescriptorSchema.parse({
        ...record.descriptor,
        geometry: completeGeometry,
      }),
    };
  }

  private encode(record: InternalMetricCaptureRecord): string {
    const { rows: _rows, ...geometry } = record.descriptor.geometry;
    void _rows;
    const payload = JSON.stringify({
      ...record,
      descriptor: { ...record.descriptor, geometry },
    });
    if (
      Buffer.byteLength(payload) > METRIC_CAPTURE_STORAGE_LIMITS.overviewBytes
    )
      throw this.backend.quotaError(
        "Metric overview exceeds bounded allowance",
      );
    return payload;
  }

  private ownerOptions(
    owner: MetricCaptureOwner,
    options: ContextOperationOptions,
  ): ContextOperationOptions {
    const identity = this.#ownerTraces.get(owner.captureId);
    return identity === undefined
      ? options
      : {
          ...options,
          trace: options.trace ?? identity.trace,
          activeAgentId: options.activeAgentId ?? identity.activeAgentId,
        };
  }

  private async classifyFailure(
    input: MetricCaptureOwner,
    options: ContextOperationOptions,
    error: unknown,
  ): Promise<void> {
    const result = metricCaptureOwnerSchema.safeParse(input);
    if (!result.success) return;
    const owner = result.data;
    let passId: string;
    try {
      passId = this.decode(this.owned(owner, true).payload).metadata.pass.id;
    } catch {
      return;
    }
    try {
      await this.backend.transaction(
        () =>
          this.setTerminal(
            owner.captureId,
            options.signal?.aborted === true ? "cancelled" : "failed",
            error instanceof Error ? error.message : "metric-storage-failure",
          ),
        undefined,
        false,
        passId,
      );
      this.backend.releaseReservation(passId);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Metric failure classification could not be persisted",
      );
    }
  }

  private owned(
    owner: MetricCaptureOwner,
    allowSealed = false,
  ): Record<string, unknown> {
    const row = select(
      this.backend.database(),
      "SELECT * FROM context_metric_captures WHERE id = ?",
      [owner.captureId],
    )[0];
    if (
      row === undefined ||
      row.owner_token !== owner.ownerToken ||
      (row.status !== "staging" && !(allowSealed && row.status === "sealed"))
    )
      throw new RepositoryConflictError(
        "Metric capture owner is stale or terminal",
      );
    const payload = JSON.parse(String(row.payload)) as {
      metadata: MetricCaptureMetadata;
    };
    if (payload.metadata.pass.liveSetId !== this.backend.liveSetId())
      throw new RepositoryConflictError(
        "Metric capture belongs to a different Live Set",
      );
    return row;
  }

  private setTerminal(
    id: string,
    status: MetricCaptureStatus,
    reason: string,
  ): void {
    const row = select(
      this.backend.database(),
      "SELECT payload FROM context_metric_captures WHERE id = ?",
      [id],
    )[0];
    if (row === undefined)
      throw new RepositoryConflictError("Metric capture does not exist");
    const value = JSON.parse(String(row.payload)) as Record<string, unknown>;
    this.backend
      .database()
      .run(
        "UPDATE context_metric_captures SET status = ?, owner_token = '', payload = ? WHERE id = ?",
        [
          status,
          JSON.stringify({
            ...value,
            status,
            manifest: null,
            updatedAt: this.backend.now(),
            reason: sanitizePersistedText(reason).slice(0, 500),
          }),
          id,
        ],
      );
  }
}
