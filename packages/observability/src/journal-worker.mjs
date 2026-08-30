import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parentPort } from "node:worker_threads";

import initSqlJs from "sql.js";

const RETENTION_PRUNE_BATCH_SIZE = 128;

let sql;
let database;
let databasePath;
let lockPath;
let lockHandle;
let schemaVersion = 0;
let minimumDatabaseBytes = 0;
let retention;
let lastFlushAt = null;
let lastError = null;
let closed = false;

function rows(statementText, parameters = []) {
  const statement = database.prepare(statementText);
  try {
    statement.bind(parameters);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
}

function row(statementText, parameters = []) {
  return rows(statementText, parameters)[0];
}

function number(rowValue, key) {
  const value = rowValue?.[key];
  if (typeof value !== "number") {
    throw failure(
      "corrupt_database",
      `The observability database contains an invalid '${key}' value`,
    );
  }
  return value;
}

function textOrNull(rowValue, key) {
  const value = rowValue?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw failure(
      "corrupt_database",
      `The observability database contains an invalid '${key}' value`,
    );
  }
  return value;
}

function failure(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ObservabilityJournalError";
  error.code = code;
  return error;
}

function isMissing(error) {
  return error instanceof Error && error.code === "ENOENT";
}

async function readDatabase(path) {
  try {
    const bytes = await readFile(path);
    return bytes.byteLength === 0 ? undefined : new Uint8Array(bytes);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function createLock(path) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(String(process.pid), "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
}

async function readLockOwner(path) {
  try {
    const owner = Number.parseInt(await readFile(path, "utf8"), 10);
    return Number.isInteger(owner) && owner > 0 ? owner : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function releaseLock(handle, path) {
  if (handle === undefined || path === undefined) return;
  await handle.close();
  await rm(path, { force: true });
}

async function reclaimLock(path) {
  const recoveryPath = `${path}.recovery`;
  let recovery;
  try {
    recovery = await createLock(recoveryPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw failure(
        "conflict",
        `Observability journal lock recovery is already in progress: ${path.slice(0, -5)}`,
      );
    }
    throw error;
  }
  try {
    const owner = await readLockOwner(path);
    if (owner !== undefined && isProcessAlive(owner)) {
      throw failure(
        "conflict",
        `The observability journal is already open: ${path.slice(0, -5)}`,
      );
    }
    await rm(path, { force: true });
    return await createLock(path);
  } finally {
    await releaseLock(recovery, recoveryPath);
  }
}

async function acquireLock(path) {
  try {
    return await createLock(path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return reclaimLock(path);
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch {
    // Not every supported filesystem permits directory synchronization.
  } finally {
    await handle?.close();
  }
}

async function writeDatabase() {
  if (databasePath === undefined) return;
  const temporary = `${databasePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(database.export());
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, databasePath);
    await syncDirectory(dirname(databasePath));
  } catch (error) {
    await rm(temporary, { force: true });
    throw failure(
      "io",
      "The observability database file could not be written",
      error,
    );
  }
}

function appliedVersions() {
  return new Set(
    rows("SELECT version FROM observability_schema_migrations")
      .map((value) => value.version)
      .filter((value) => typeof value === "number"),
  );
}

function migrate(migrations, supportedVersion, nowIso) {
  database.run(`CREATE TABLE IF NOT EXISTS observability_schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = appliedVersions();
  const current = [...applied].reduce(
    (highest, version) => Math.max(highest, version),
    0,
  );
  if (current > supportedVersion) {
    throw failure(
      "schema_version",
      `Observability database schema version ${current} is newer than supported version ${supportedVersion}`,
    );
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.run("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) database.run(statement);
      database.run(
        `INSERT INTO observability_schema_migrations
          (version, description, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.description, nowIso],
      );
      database.run("COMMIT");
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  }
  database.run(`PRAGMA user_version = ${supportedVersion}`);
  schemaVersion = supportedVersion;
}

function measureMinimumDatabase(migrations, supportedVersion) {
  const empty = new sql.Database();
  try {
    for (const migration of migrations) {
      for (const statement of migration.statements) empty.run(statement);
      empty.run(
        `INSERT INTO observability_schema_migrations
          (version, description, applied_at) VALUES (?, ?, ?)`,
        [migration.version, migration.description, "1970-01-01T00:00:00.000Z"],
      );
    }
    empty.run(`PRAGMA user_version = ${supportedVersion}`);
    empty.run("VACUUM");
    return empty.export().byteLength;
  } finally {
    empty.close();
  }
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function appendListFilter(column, values, clauses, parameters) {
  if (values === undefined) return;
  clauses.push(`${column} IN (${placeholders(values)})`);
  parameters.push(...values);
}

function eventWhere(query) {
  const clauses = [];
  const parameters = [];
  appendListFilter("name", query.names, clauses, parameters);
  appendListFilter("category", query.categories, clauses, parameters);
  appendListFilter("source", query.sources, clauses, parameters);
  appendListFilter("stage", query.stages, clauses, parameters);
  appendListFilter("level", query.levels, clauses, parameters);
  appendListFilter("outcome", query.outcomes, clauses, parameters);
  const scalar = [
    ["trace_id", "traceId"],
    ["correlation_id", "correlationId"],
    ["project_id", "projectId"],
    ["session_id", "sessionId"],
    ["active_agent_id", "activeAgentId"],
    ["live_event_id", "liveEventId"],
    ["output_id", "outputId"],
    ["tool_name", "toolName"],
  ];
  for (const [column, property] of scalar) {
    if (query[property] !== undefined) {
      clauses.push(`${column} = ?`);
      parameters.push(query[property]);
    }
  }
  if (query.from !== undefined) {
    clauses.push("occurred_at >= ?");
    parameters.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("occurred_at <= ?");
    parameters.push(query.to);
  }
  return { clauses, parameters };
}

function snapshotWhere(query) {
  const clauses = [];
  const parameters = [];
  appendListFilter("component", query.components, clauses, parameters);
  for (const [column, property] of [
    ["project_id", "projectId"],
    ["session_id", "sessionId"],
    ["active_agent_id", "activeAgentId"],
  ]) {
    if (query[property] !== undefined) {
      clauses.push(`${column} = ?`);
      parameters.push(query[property]);
    }
  }
  if (query.from !== undefined) {
    clauses.push("captured_at >= ?");
    parameters.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("captured_at <= ?");
    parameters.push(query.to);
  }
  return { clauses, parameters };
}

function whereSql(clauses) {
  return clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
}

function cursor(value, table, order) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed?.version !== 1 ||
      parsed.table !== table ||
      parsed.order !== order ||
      !Number.isSafeInteger(parsed.sequence) ||
      parsed.sequence < 1
    ) {
      throw new Error("Invalid cursor");
    }
    return parsed;
  } catch {
    throw failure(
      "invalid_cursor",
      "The observability query cursor is invalid or belongs to another query type/order",
    );
  }
}

function encodeCursor(table, sequence, order) {
  return Buffer.from(
    JSON.stringify({ version: 1, table, sequence, order }),
    "utf8",
  ).toString("base64url");
}

function decodePayload(value, sequence, recordedAt) {
  if (typeof value !== "string") {
    throw failure("corrupt_database", "A journal payload is not text");
  }
  try {
    return { ...JSON.parse(value), sequence, recordedAt };
  } catch (error) {
    throw failure(
      "corrupt_database",
      "A journal payload is not valid JSON",
      error,
    );
  }
}

function pageMetadata(limit, items, totalItems, hasMore, order) {
  return {
    limit,
    returnedItems: items.length,
    totalItems,
    hasMore,
    order,
  };
}

function readEvents(query, rootTraceId) {
  const { cursor: encoded, limit, order, ...filter } = query;
  const { clauses, parameters } = eventWhere(filter);
  if (rootTraceId !== undefined) {
    clauses.push("root_trace_id = ?");
    parameters.push(rootTraceId);
  }
  const totalItems = number(
    row(
      `SELECT count(*) AS count FROM telemetry_events${whereSql(clauses)}`,
      parameters,
    ),
    "count",
  );
  if (encoded !== undefined) {
    const decoded = cursor(encoded, "events", order);
    clauses.push(`sequence ${order === "asc" ? ">" : "<"} ?`);
    parameters.push(decoded.sequence);
  }
  const queryParameters = [...parameters, limit + 1];
  const selected = rows(
    `SELECT sequence, recorded_at, payload FROM telemetry_events
     ${whereSql(clauses)}
     ORDER BY sequence ${order === "asc" ? "ASC" : "DESC"}
     LIMIT ?`,
    queryParameters,
  );
  const hasMore = selected.length > limit;
  const items = selected
    .slice(0, limit)
    .map((value) =>
      decodePayload(value.payload, value.sequence, value.recorded_at),
    );
  const last = items.at(-1);
  const result = {
    version: 1,
    items,
    ...(hasMore && last !== undefined
      ? { nextCursor: encodeCursor("events", last.sequence, order) }
      : {}),
    page: pageMetadata(limit, items, totalItems, hasMore, order),
  };
  if (rootTraceId === undefined) return result;
  const traceRange = row(
    `SELECT min(sequence) AS first_sequence, max(sequence) AS last_sequence
     FROM telemetry_events WHERE root_trace_id = ?`,
    [rootTraceId],
  );
  return {
    ...result,
    trace: {
      rootTraceId,
      totalEvents: totalItems,
      firstSequence: traceRange?.first_sequence ?? null,
      lastSequence: traceRange?.last_sequence ?? null,
    },
  };
}

function readSnapshots(query) {
  const { cursor: encoded, limit, order, ...filter } = query;
  const { clauses, parameters } = snapshotWhere(filter);
  const totalItems = number(
    row(
      `SELECT count(*) AS count FROM configuration_snapshots${whereSql(clauses)}`,
      parameters,
    ),
    "count",
  );
  if (encoded !== undefined) {
    const decoded = cursor(encoded, "snapshots", order);
    clauses.push(`sequence ${order === "asc" ? ">" : "<"} ?`);
    parameters.push(decoded.sequence);
  }
  const selected = rows(
    `SELECT sequence, recorded_at, payload FROM configuration_snapshots
     ${whereSql(clauses)}
     ORDER BY sequence ${order === "asc" ? "ASC" : "DESC"}
     LIMIT ?`,
    [...parameters, limit + 1],
  );
  const hasMore = selected.length > limit;
  const items = selected
    .slice(0, limit)
    .map((value) =>
      decodePayload(value.payload, value.sequence, value.recorded_at),
    );
  const last = items.at(-1);
  return {
    version: 1,
    items,
    ...(hasMore && last !== undefined
      ? { nextCursor: encodeCursor("snapshots", last.sequence, order) }
      : {}),
    page: pageMetadata(limit, items, totalItems, hasMore, order),
  };
}

function rootSummaries(query) {
  const { cursor: encoded, limit, order, ...filter } = query;
  const { clauses, parameters } = eventWhere(filter);
  const matchingWhere = whereSql(clauses);
  const cte = `WITH matching_roots AS (
      SELECT DISTINCT root_trace_id FROM telemetry_events${matchingWhere}
    ), summaries AS (
      SELECT
        events.root_trace_id,
        count(*) AS event_count,
        min(events.sequence) AS first_sequence,
        max(events.sequence) AS last_sequence,
        min(events.occurred_at) AS first_occurred_at,
        max(events.occurred_at) AS last_occurred_at,
        (
          SELECT first.name FROM telemetry_events AS first
          WHERE first.root_trace_id = events.root_trace_id
          ORDER BY first.sequence ASC LIMIT 1
        ) AS first_event_name,
        (
          SELECT last.name FROM telemetry_events AS last
          WHERE last.root_trace_id = events.root_trace_id
          ORDER BY last.sequence DESC LIMIT 1
        ) AS last_event_name,
        max(CASE
          WHEN events.level = 'error' OR events.outcome = 'failure' THEN 1
          ELSE 0
        END) AS has_errors
      FROM telemetry_events AS events
      INNER JOIN matching_roots
        ON matching_roots.root_trace_id = events.root_trace_id
      GROUP BY events.root_trace_id
    )`;
  const totalItems = number(
    row(`${cte} SELECT count(*) AS count FROM summaries`, parameters),
    "count",
  );
  const pageClauses = [];
  const pageParameters = [...parameters];
  if (encoded !== undefined) {
    const decoded = cursor(encoded, "roots", order);
    pageClauses.push(`first_sequence ${order === "asc" ? ">" : "<"} ?`);
    pageParameters.push(decoded.sequence);
  }
  const selected = rows(
    `${cte}
     SELECT * FROM summaries${whereSql(pageClauses)}
     ORDER BY first_sequence ${order === "asc" ? "ASC" : "DESC"}
     LIMIT ?`,
    [...pageParameters, limit + 1],
  );
  const hasMore = selected.length > limit;
  const items = selected.slice(0, limit).map((value) => ({
    rootTraceId: value.root_trace_id,
    eventCount: value.event_count,
    firstSequence: value.first_sequence,
    lastSequence: value.last_sequence,
    firstOccurredAt: value.first_occurred_at,
    lastOccurredAt: value.last_occurred_at,
    firstEventName: value.first_event_name,
    lastEventName: value.last_event_name,
    hasErrors: value.has_errors === 1,
  }));
  const last = items.at(-1);
  return {
    version: 1,
    items,
    ...(hasMore && last !== undefined
      ? { nextCursor: encodeCursor("roots", last.firstSequence, order) }
      : {}),
    page: pageMetadata(limit, items, totalItems, hasMore, order),
  };
}

function insertBatch(writes, recordedAt) {
  const failures = [];
  database.run("BEGIN IMMEDIATE");
  try {
    writes.forEach((item, index) => {
      if (item.kind === "event") {
        const event = item.value;
        database.run(
          `INSERT OR IGNORE INTO telemetry_events (
            event_id, contract_version, occurred_at, recorded_at, name,
            category, source, stage, level, outcome, correlation_id,
            causation_id, trace_id, span_id, parent_span_id, root_trace_id,
            project_id, session_id, active_agent_id, live_event_id, output_id,
            tool_name, duration_ms, payload
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?
          )`,
          [
            event.id,
            event.version,
            event.occurredAt,
            recordedAt,
            event.name,
            event.category ?? null,
            event.source,
            event.stage ?? null,
            event.level,
            event.outcome ?? null,
            event.correlationId ?? null,
            event.causationId ?? null,
            event.trace?.traceId ?? null,
            event.trace?.spanId ?? null,
            event.trace?.parentSpanId ?? null,
            event.trace?.traceId ?? event.id,
            event.projectId ?? null,
            event.sessionId ?? null,
            event.activeAgentId ?? null,
            event.liveEventId ?? null,
            event.outputId ?? null,
            event.toolName ?? null,
            event.durationMs ?? null,
            JSON.stringify(event),
          ],
        );
      } else {
        const snapshot = item.value;
        database.run(
          `INSERT OR IGNORE INTO configuration_snapshots (
            snapshot_id, contract_version, captured_at, recorded_at,
            component, configuration_version, project_id, session_id,
            active_agent_id, payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshot.id,
            snapshot.version,
            snapshot.capturedAt,
            recordedAt,
            snapshot.component,
            snapshot.configurationVersion,
            snapshot.projectId ?? null,
            snapshot.sessionId ?? null,
            snapshot.activeAgentId ?? null,
            JSON.stringify(snapshot),
          ],
        );
      }
      if (database.getRowsModified() === 0) {
        failures.push({
          index,
          code: "duplicate",
          message: `A ${
            item.kind === "event" ? "event" : "configuration snapshot"
          } with id '${item.value.id}' is already journaled`,
        });
      }
    });
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
  return failures;
}

function chunks(values, size = 500) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function deleteRoots(rootIds) {
  let deleted = 0;
  for (const batch of chunks(rootIds)) {
    database.run(
      `DELETE FROM telemetry_events
       WHERE root_trace_id IN (${placeholders(batch)})`,
      batch,
    );
    deleted += database.getRowsModified();
  }
  return deleted;
}

function retentionCandidates(limit = RETENTION_PRUNE_BATCH_SIZE) {
  const candidates = rows(
    `SELECT
       'trace' AS kind,
       root_trace_id AS id,
       min(occurred_at) AS oldest_at,
       min(sequence) AS oldest_sequence,
       sum(length(payload)) + count(*) * 2048 AS estimated_bytes
     FROM telemetry_events
     GROUP BY root_trace_id
     UNION ALL
     SELECT
       'snapshot' AS kind,
       snapshot_id AS id,
       captured_at AS oldest_at,
       sequence AS oldest_sequence,
       length(payload) + 2048 AS estimated_bytes
     FROM configuration_snapshots
     ORDER BY oldest_at, oldest_sequence, kind, id
     LIMIT ?`,
    [limit],
  );
  return candidates.filter(
    (candidate) =>
      (candidate.kind === "trace" || candidate.kind === "snapshot") &&
      typeof candidate.id === "string" &&
      typeof candidate.estimated_bytes === "number",
  );
}

function deleteSnapshots(snapshotIds) {
  let deleted = 0;
  for (const batch of chunks(snapshotIds)) {
    database.run(
      `DELETE FROM configuration_snapshots
       WHERE snapshot_id IN (${placeholders(batch)})`,
      batch,
    );
    deleted += database.getRowsModified();
  }
  return deleted;
}

function applyRetention(nowIso) {
  const cutoff = new Date(
    new Date(nowIso).getTime() - retention.maxAgeDays * 86_400_000,
  ).toISOString();
  const expiredRoots = rows(
    `SELECT root_trace_id FROM telemetry_events
     GROUP BY root_trace_id
     HAVING max(occurred_at) < ?
     ORDER BY min(sequence)`,
    [cutoff],
  )
    .map((value) => value.root_trace_id)
    .filter((value) => typeof value === "string");
  let deletedEvents = deleteRoots(expiredRoots);
  database.run("DELETE FROM configuration_snapshots WHERE captured_at < ?", [
    cutoff,
  ]);
  let deletedConfigurationSnapshots = database.getRowsModified();
  let deletedTraces = expiredRoots.length;

  const needsAgeCompaction =
    deletedEvents > 0 || deletedConfigurationSnapshots > 0;
  if (needsAgeCompaction) database.run("VACUUM");
  let databaseBytes = database.export().byteLength;
  let exhaustedCandidates = false;

  while (databaseBytes > retention.maxBytes) {
    const candidates = retentionCandidates();
    if (candidates.length === 0) {
      exhaustedCandidates = true;
      break;
    }
    const excessBytes = databaseBytes - retention.maxBytes;
    let selectedBytes = 0;
    const selectedRoots = [];
    const selectedSnapshots = [];
    for (const candidate of candidates) {
      if (selectedBytes >= excessBytes) break;
      selectedBytes += candidate.estimated_bytes;
      if (candidate.kind === "trace") selectedRoots.push(candidate.id);
      else selectedSnapshots.push(candidate.id);
    }
    deletedEvents += deleteRoots(selectedRoots);
    deletedTraces += selectedRoots.length;
    deletedConfigurationSnapshots += deleteSnapshots(selectedSnapshots);
    database.run("VACUUM");
    databaseBytes = database.export().byteLength;
  }

  return {
    version: 1,
    deletedEvents,
    deletedTraces,
    deletedConfigurationSnapshots,
    databaseBytes,
    minimumDatabaseBytes,
    withinMaxBytes: databaseBytes <= retention.maxBytes,
    sizeLimitReason:
      databaseBytes > retention.maxBytes && exhaustedCandidates
        ? "schema-minimum"
        : null,
  };
}

async function mutate(operation, message) {
  const before = database.export();
  database.run("BEGIN IMMEDIATE");
  let committed = false;
  try {
    const result = operation();
    database.run("COMMIT");
    committed = true;
    await writeDatabase();
    lastFlushAt = new Date().toISOString();
    lastError = null;
    return result;
  } catch (error) {
    if (!committed) {
      try {
        database.run("ROLLBACK");
      } catch {
        // Restoring the pre-operation image below is authoritative.
      }
    }
    database.close();
    database = new sql.Database(before);
    throw error?.code === undefined ? failure("io", message, error) : error;
  }
}

async function openJournal(options) {
  sql = await initSqlJs();
  databasePath =
    options.path === undefined || options.path === ":memory:"
      ? undefined
      : resolve(options.path);
  lockPath = databasePath === undefined ? undefined : `${databasePath}.lock`;
  if (databasePath !== undefined) {
    await mkdir(dirname(databasePath), { recursive: true });
    lockHandle = await acquireLock(lockPath);
  }
  try {
    const bytes =
      databasePath === undefined ? undefined : await readDatabase(databasePath);
    database =
      bytes === undefined ? new sql.Database() : new sql.Database(bytes);
    retention = options.retention;
    migrate(options.migrations, options.schemaVersion, options.nowIso);
    minimumDatabaseBytes = measureMinimumDatabase(
      options.migrations,
      options.schemaVersion,
    );
    const result = applyRetention(options.nowIso);
    await writeDatabase();
    lastFlushAt = options.nowIso;
    return { schemaVersion, retentionResult: result };
  } catch (error) {
    database?.close();
    await releaseLock(lockHandle, lockPath);
    throw error;
  }
}

async function dispatch(method, args) {
  if (method !== "open" && (closed || database === undefined)) {
    throw failure("closed", "The observability journal is closed");
  }
  switch (method) {
    case "open":
      return openJournal(args);
    case "batch": {
      const before = database.export();
      try {
        const failures = insertBatch(args.writes, args.nowIso);
        const retentionResult = applyRetention(args.nowIso);
        await writeDatabase();
        lastFlushAt = args.nowIso;
        lastError = null;
        return { failures, retentionResult };
      } catch (error) {
        database.close();
        database = new sql.Database(before);
        lastError = {
          code: error?.code ?? "io",
          message: error?.message ?? "A telemetry batch could not be persisted",
          at: args.nowIso,
        };
        throw error?.code === undefined
          ? failure("io", "A telemetry batch could not be persisted", error)
          : error;
      }
    }
    case "readEvents":
      return readEvents(args.query);
    case "readTrace":
      return readEvents(args.query, args.rootTraceId);
    case "readSnapshots":
      return readSnapshots(args.query);
    case "readRootTraces":
      return rootSummaries(args.query);
    case "deleteEvents": {
      const { clauses, parameters } = eventWhere(args.filter);
      return mutate(() => {
        database.run(
          `DELETE FROM telemetry_events${whereSql(clauses)}`,
          parameters,
        );
        return database.getRowsModified();
      }, "Event deletion failed");
    }
    case "deleteTrace":
      return mutate(() => {
        database.run("DELETE FROM telemetry_events WHERE root_trace_id = ?", [
          args.rootTraceId,
        ]);
        return database.getRowsModified();
      }, "Trace deletion failed");
    case "deleteSnapshots": {
      const { clauses, parameters } = snapshotWhere(args.filter);
      return mutate(() => {
        database.run(
          `DELETE FROM configuration_snapshots${whereSql(clauses)}`,
          parameters,
        );
        return database.getRowsModified();
      }, "Configuration snapshot deletion failed");
    }
    case "clear":
      return mutate(() => {
        const deletedEvents = number(
          row("SELECT count(*) AS count FROM telemetry_events"),
          "count",
        );
        const deletedConfigurationSnapshots = number(
          row("SELECT count(*) AS count FROM configuration_snapshots"),
          "count",
        );
        database.run("DELETE FROM telemetry_events");
        database.run("DELETE FROM configuration_snapshots");
        return { deletedEvents, deletedConfigurationSnapshots };
      }, "Journal clearing failed");
    case "retention": {
      const before = database.export();
      try {
        const result = applyRetention(args.nowIso);
        await writeDatabase();
        lastFlushAt = args.nowIso;
        lastError = null;
        return result;
      } catch (error) {
        database.close();
        database = new sql.Database(before);
        lastError = {
          code: error?.code ?? "io",
          message: error?.message ?? "Retention pruning failed",
          at: args.nowIso,
        };
        throw error?.code === undefined
          ? failure("io", "Retention pruning failed", error)
          : error;
      }
    }
    case "flush":
      await writeDatabase();
      lastFlushAt = args.nowIso;
      return undefined;
    case "health": {
      const range = row(
        `SELECT min(occurred_at) AS oldest, max(occurred_at) AS newest
         FROM telemetry_events`,
      );
      return {
        version: 1,
        status: lastError === null ? "healthy" : "degraded",
        schemaVersion,
        persistedEvents: number(
          row("SELECT count(*) AS count FROM telemetry_events"),
          "count",
        ),
        persistedConfigurationSnapshots: number(
          row("SELECT count(*) AS count FROM configuration_snapshots"),
          "count",
        ),
        databaseBytes: database.export().byteLength,
        oldestEventAt: textOrNull(range, "oldest"),
        newestEventAt: textOrNull(range, "newest"),
        lastFlushAt,
        lastError,
        retention,
      };
    }
    case "shutdown": {
      const counts = {
        persistedEvents: number(
          row("SELECT count(*) AS count FROM telemetry_events"),
          "count",
        ),
        persistedConfigurationSnapshots: number(
          row("SELECT count(*) AS count FROM configuration_snapshots"),
          "count",
        ),
        databaseBytes: database.export().byteLength,
        lastFlushAt: args.nowIso,
      };
      let writeError;
      try {
        await writeDatabase();
        lastFlushAt = args.nowIso;
      } catch (error) {
        writeError = error;
      } finally {
        database.close();
        closed = true;
        await releaseLock(lockHandle, lockPath);
      }
      if (writeError !== undefined) throw writeError;
      return counts;
    }
    default:
      throw failure(
        "corrupt_database",
        `Unknown journal worker method: ${method}`,
      );
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: error?.code ?? "io",
    stack: error instanceof Error ? error.stack : undefined,
  };
}

let operationTail = Promise.resolve();
parentPort.on("message", (message) => {
  const operation = operationTail.then(() =>
    dispatch(message.method, message.args),
  );
  operationTail = operation.then(
    () => undefined,
    () => undefined,
  );
  void operation.then(
    (value) => parentPort.postMessage({ id: message.id, ok: true, value }),
    (error) =>
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: serializeError(error),
      }),
  );
});
