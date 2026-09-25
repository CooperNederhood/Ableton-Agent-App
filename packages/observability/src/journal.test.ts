import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import initSqlJs from "sql.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  JournalClosedError,
  JournalCursorError,
  JournalDuplicateError,
  JournalQueryError,
  JournalQueueFullError,
  JournalSchemaVersionError,
  LocalObservabilityJournal,
  REDACTED_VALUE,
  createNonBlockingObservabilityRecorder,
  observabilityMigrations,
  observabilitySchemaVersion,
  type ConfigurationSnapshot,
  type AgentHistoryRecord,
  type SetHistoryRecord,
  type TelemetryEventEnvelope,
} from "./index.js";

const temporaryRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
const openJournals: LocalObservabilityJournal[] = [];

const id = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

function event(
  value: number,
  options: {
    at?: string;
    traceId?: string;
    source?: string;
    level?: "debug" | "info" | "warn" | "error";
    padding?: string;
    liveSetId?: string;
    liveProjectId?: string;
  } = {},
): TelemetryEventEnvelope {
  return {
    version: 2,
    id: id(value),
    occurredAt: options.at ?? `2026-08-29T22:00:0${value}.000Z`,
    name: value % 2 === 0 ? "bridge.connected" : "tool.completed",
    source: options.source ?? "agent.runtime",
    level: options.level ?? "info",
    outcome: "success",
    ...(options.liveSetId === undefined
      ? {}
      : { liveSetId: options.liveSetId }),
    ...(options.liveProjectId === undefined
      ? {}
      : { liveProjectId: options.liveProjectId }),
    ...(options.traceId === undefined
      ? {}
      : {
          trace: {
            traceId: options.traceId,
            spanId: id(100 + value),
          },
        }),
    attributes: {
      feature: "set_tempo",
      ...(options.padding === undefined ? {} : { padding: options.padding }),
    },
  };
}

function snapshot(
  value: number,
  component = "agent.runtime",
  attribution: {
    liveSetId?: string;
    liveProjectId?: string;
  } = {},
): ConfigurationSnapshot {
  return {
    version: 2,
    id: id(500 + value),
    capturedAt: `2026-08-29T22:01:0${value}.000Z`,
    component,
    configurationVersion: String(value),
    ...(attribution.liveSetId === undefined
      ? {}
      : { liveSetId: attribution.liveSetId }),
    ...(attribution.liveProjectId === undefined
      ? {}
      : { liveProjectId: attribution.liveProjectId }),
    values: { telemetry_enabled: true, batch_size: 64 + value },
  };
}

function agentHistoryRecords(): AgentHistoryRecord[] {
  const base = {
    version: 1 as const,
    appSessionId: "app-session-1",
    liveSetId: "live-set-1",
    liveProjectId: "live-project-1",
    agentSessionId: "agent-session-1",
    activeAgentId: "active-agent-1",
  };
  return [
    {
      ...base,
      kind: "agent_session",
      id: id(1_001),
      occurredAt: "2026-08-29T22:10:00.000Z",
      status: "active",
      metadata: { model: "test-model" },
    },
    {
      ...base,
      kind: "turn",
      id: id(1_002),
      turnId: "turn-1",
      occurredAt: "2026-08-29T22:10:01.000Z",
      status: "completed",
      prompt: "Use token=secret-value to set tempo",
      durationMs: 12,
      metadata: {},
    },
    {
      ...base,
      kind: "message",
      id: id(1_003),
      turnId: "turn-1",
      occurredAt: "2026-08-29T22:10:02.000Z",
      role: "assistant",
      content: "Tempo updated",
      messageIndex: 0,
      metadata: {},
    },
    {
      ...base,
      kind: "tool_call",
      id: id(1_004),
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      occurredAt: "2026-08-29T22:10:03.000Z",
      toolName: "ableton.set_tempo",
      status: "completed",
      arguments: { authorization: "secret-value", tempo: 120 },
      metadata: {},
    },
    {
      ...base,
      kind: "tool_result",
      id: id(1_005),
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      occurredAt: "2026-08-29T22:10:04.000Z",
      outcome: "success",
      result: { tempo: 120 },
      metadata: {},
    },
    {
      ...base,
      kind: "approval",
      id: id(1_006),
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      occurredAt: "2026-08-29T22:10:05.000Z",
      status: "approved",
      summary: "Approve tempo change",
      details: {},
    },
  ];
}

function setHistoryRecords(): SetHistoryRecord[] {
  const base = {
    version: 1 as const,
    appSessionId: "app-session-1",
    liveSetId: "live-set-1",
    liveProjectId: "live-project-1",
  };
  return [
    {
      ...base,
      kind: "set_save",
      id: id(1_101),
      occurredAt: "2026-08-29T22:11:00.000Z",
      path: "/Users/example/My Set.als",
      trigger: "agent",
      outcome: "success",
      details: {},
    },
    {
      ...base,
      kind: "set_snapshot",
      id: id(1_102),
      occurredAt: "2026-08-29T22:11:01.000Z",
      snapshotKind: "checkpoint",
      revision: "revision-1",
      snapshot: {
        liveSetId: "live-set-1",
        liveSetName: "History Test",
        tempo: 120,
        timeSignature: "4/4",
        source: "manual",
        tracks: [
          {
            id: "track-1",
            index: 0,
            name: "Lead",
            kind: "midi",
            color: "#ff0000",
            volume: 0.8,
            pan: 0,
            muted: false,
            clips: [],
            devices: [
              {
                id: "device-1",
                name: "Operator",
                type: "instrument",
                enabled: true,
                parameters: [],
              },
            ],
          },
        ],
        scenes: [{ id: "scene-1", index: 0, name: "Verse", derived: false }],
        sessionClips: [],
        arrangementClips: [],
        cuePoints: [{ id: "cue-1", name: "Drop", time: 16 }],
        devices: [],
      },
    },
    {
      ...base,
      kind: "set_trajectory",
      id: id(1_103),
      occurredAt: "2026-08-29T22:11:02.000Z",
      trajectoryType: "tool.mutation",
      agentSessionId: "agent-session-1",
      turnId: "turn-1",
      toolCallId: "tool-call-1",
      activeAgentId: "active-agent-1",
      summary: "Changed tempo",
      data: { before: 110, after: 120 },
    },
  ];
}

async function databasePath(name = "observability.sqlite"): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  return join(await mkdtemp(join(temporaryRoot, "journal-")), name);
}

async function openJournal(
  options: Parameters<typeof LocalObservabilityJournal.open>[0] = {},
): Promise<LocalObservabilityJournal> {
  const journal = await LocalObservabilityJournal.open(options);
  openJournals.push(journal);
  return journal;
}

afterEach(async () => {
  while (openJournals.length > 0) await openJournals.pop()?.shutdown();
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("local observability journal", () => {
  it("queues writes without disk work on the caller path and persists batches in order", async () => {
    const journal = await openJournal({ batchDelayMs: 5_000 });
    const writes = [journal.enqueue(event(1)), journal.enqueue(event(2))];

    expect((await journal.getHealth()).pendingWrites).toBe(2);
    await journal.flush();
    await Promise.all(writes);

    const page = await journal.read({ order: "asc" });
    expect(page.items.map((item) => item.id)).toEqual([id(1), id(2)]);
    expect(page.items.map((item) => item.sequence)).toEqual([1, 2]);
    expect((await journal.getHealth()).persistedEvents).toBe(2);
  });

  it("filters and paginates reads with opaque order-specific cursors", async () => {
    const journal = await openJournal({ batchSize: 4, batchDelayMs: 5_000 });
    await Promise.all([
      journal.enqueue(event(1)),
      journal.enqueue(event(2, { source: "bridge.protocol" })),
      journal.enqueue(event(3, { level: "error" })),
      journal.enqueue(event(4)),
    ]);

    const first = await journal.read({ order: "asc", limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([id(1), id(2)]);
    expect(first.nextCursor).toBeDefined();
    const second = await journal.read({
      order: "asc",
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(second.items.map((item) => item.id)).toEqual([id(3), id(4)]);
    expect(second.nextCursor).toBeUndefined();

    expect(
      (
        await journal.read({
          sources: ["bridge.protocol"],
          names: ["bridge.connected"],
        })
      ).items.map((item) => item.id),
    ).toEqual([id(2)]);
    await expect(
      journal.read({ order: "desc", cursor: first.nextCursor }),
    ).rejects.toThrow(JournalCursorError);
  });

  it("filters Live Set and optional Live Project attribution independently", async () => {
    const journal = await openJournal({ batchDelayMs: 0 });
    await Promise.all([
      journal.enqueue(
        event(1, {
          liveSetId: "live-set-a",
          liveProjectId: "live-project-a",
        }),
      ),
      journal.enqueue(event(2, { liveSetId: "live-set-b" })),
    ]);

    expect(
      (await journal.read({ liveSetId: "live-set-a" })).items,
    ).toMatchObject([
      { liveSetId: "live-set-a", liveProjectId: "live-project-a" },
    ]);
    expect(
      (await journal.read({ liveProjectId: "live-project-a" })).items,
    ).toMatchObject([
      { liveSetId: "live-set-a", liveProjectId: "live-project-a" },
    ]);
  });

  it("paginates root traces server-side and reports complete trace metadata", async () => {
    const journal = await openJournal({ batchSize: 5, batchDelayMs: 5_000 });
    const traces = [id(900), id(901), id(902)] as const;
    await Promise.all([
      journal.enqueue(event(1, { traceId: traces[0] })),
      journal.enqueue(event(2, { traceId: traces[0] })),
      journal.enqueue(event(3, { traceId: traces[1] })),
      journal.enqueue(event(4, { traceId: traces[2] })),
      journal.enqueue(event(5, { traceId: traces[2], level: "error" })),
    ]);

    const first = await journal.readRootTraces({ order: "asc", limit: 2 });
    expect(first.items.map((trace) => trace.rootTraceId)).toEqual(
      traces.slice(0, 2),
    );
    expect(first.items.map((trace) => trace.eventCount)).toEqual([2, 1]);
    expect(first.page).toEqual({
      limit: 2,
      returnedItems: 2,
      totalItems: 3,
      hasMore: true,
      order: "asc",
    });

    const second = await journal.readRootTraces({
      order: "asc",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toMatchObject([
      { rootTraceId: traces[2], eventCount: 2, hasErrors: true },
    ]);
    expect(second.page).toMatchObject({
      returnedItems: 1,
      totalItems: 3,
      hasMore: false,
    });

    const traceFirst = await journal.readTrace(traces[0] ?? "", {
      order: "asc",
      limit: 1,
    });
    expect(traceFirst.page).toEqual({
      limit: 1,
      returnedItems: 1,
      totalItems: 2,
      hasMore: true,
      order: "asc",
    });
    expect(traceFirst.trace).toEqual({
      rootTraceId: traces[0],
      totalEvents: 2,
      firstSequence: 1,
      lastSequence: 2,
    });
    const traceSecond = await journal.readTrace(traces[0] ?? "", {
      order: "asc",
      limit: 1,
      cursor: traceFirst.nextCursor!,
    });
    expect(traceSecond.page).toMatchObject({
      returnedItems: 1,
      totalItems: 2,
      hasMore: false,
    });
  });

  it("reads complete traces and stores versioned configuration snapshots", async () => {
    const journal = await openJournal({ batchSize: 5, batchDelayMs: 5_000 });
    const traceId = id(900);
    await Promise.all([
      journal.enqueue(event(1, { traceId })),
      journal.enqueue(event(2, { traceId })),
      journal.enqueue(event(3)),
      journal.enqueueConfigurationSnapshot(
        snapshot(1, "agent.runtime", {
          liveSetId: "live-set-a",
          liveProjectId: "live-project-a",
        }),
      ),
      journal.enqueueConfigurationSnapshot(snapshot(2)),
    ]);

    expect(
      (await journal.readTrace(traceId, { order: "asc" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([id(1), id(2)]);
    expect(
      (await journal.readLatestConfigurationSnapshot("agent.runtime"))
        ?.configurationVersion,
    ).toBe("2");
    expect((await journal.readConfigurationSnapshots()).items).toHaveLength(2);
    expect(
      (
        await journal.readConfigurationSnapshots({
          liveSetId: "live-set-a",
          liveProjectId: "live-project-a",
        })
      ).items,
    ).toMatchObject([
      { liveSetId: "live-set-a", liveProjectId: "live-project-a" },
    ]);
  });

  it("writes and queries separate typed agent and Set history views", async () => {
    const path = await databasePath();
    const journal = await openJournal({ path, batchDelayMs: 0 });
    await Promise.all([
      ...agentHistoryRecords().map((record) =>
        journal.appendAgentHistory(record),
      ),
      ...setHistoryRecords().map((record) => journal.appendSetHistory(record)),
    ]);

    const firstAgentPage = await journal.readAgentHistory({
      appSessionId: "app-session-1",
      order: "asc",
      limit: 3,
    });
    expect(firstAgentPage.items.map((record) => record.kind)).toEqual([
      "agent_session",
      "turn",
      "message",
    ]);
    expect(firstAgentPage.nextCursor).toBeDefined();
    expect(
      (
        await journal.readAgentHistory({
          appSessionId: "app-session-1",
          order: "asc",
          limit: 3,
          cursor: firstAgentPage.nextCursor,
        })
      ).items.map((record) => record.kind),
    ).toEqual(["tool_call", "tool_result", "approval"]);
    expect(
      (
        await journal.readAgentHistory({
          kinds: ["tool_call"],
          toolCallId: "tool-call-1",
        })
      ).items[0],
    ).toMatchObject({
      kind: "tool_call",
      arguments: { authorization: REDACTED_VALUE, tempo: 120 },
    });
    expect(
      (await journal.readSetHistory({ liveSetId: "live-set-1" })).items.map(
        (record) => record.kind,
      ),
    ).toEqual(["set_trajectory", "set_snapshot", "set_save"]);
    expect(firstAgentPage.page.totalItems).toBe(6);
    expect(
      (await journal.readSetHistory({ liveSetId: "live-set-1" })).page
        .totalItems,
    ).toBe(3);

    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);
    const sql = await initSqlJs();
    const database = new sql.Database(new Uint8Array(await readFile(path)));
    const objects = database.exec(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'app_events', 'app_configuration_snapshots', 'agent_sessions',
         'agent_turns', 'agent_messages', 'agent_tool_calls',
         'agent_tool_results', 'agent_approvals', 'set_saves',
         'set_snapshots', 'set_trajectory_records', 'agent_history',
         'set_history', 'telemetry_events', 'configuration_snapshots',
         'agent_messages_live_set', 'set_snapshots_project',
         'set_trajectory_agent_session', 'set_trajectory_turn',
         'set_trajectory_tool_call'
       ) ORDER BY name`,
    )[0]?.values;
    expect(objects).toEqual([
      ["table", "agent_approvals"],
      ["view", "agent_history"],
      ["table", "agent_messages"],
      ["index", "agent_messages_live_set"],
      ["table", "agent_sessions"],
      ["table", "agent_tool_calls"],
      ["table", "agent_tool_results"],
      ["table", "agent_turns"],
      ["table", "app_configuration_snapshots"],
      ["table", "app_events"],
      ["view", "set_history"],
      ["table", "set_saves"],
      ["table", "set_snapshots"],
      ["index", "set_snapshots_project"],
      ["index", "set_trajectory_agent_session"],
      ["table", "set_trajectory_records"],
      ["index", "set_trajectory_tool_call"],
      ["index", "set_trajectory_turn"],
    ]);
    const persisted = String(
      database.exec(
        "SELECT payload FROM agent_turns WHERE turn_id = 'turn-1'",
      )[0]?.values[0]?.[0],
    );
    expect(persisted).toContain(REDACTED_VALUE);
    expect(persisted).not.toContain("secret-value");
    database.close();
  });

  it("queries only bounded scalar rows from granular public history views", async () => {
    const journal = await openJournal({ batchDelayMs: 0 });
    await Promise.all([
      ...agentHistoryRecords().map((record) =>
        journal.appendAgentHistory(record),
      ),
      ...setHistoryRecords().map((record) => journal.appendSetHistory(record)),
    ]);
    const publicViews = [
      "set_history_saves",
      "set_history_snapshots",
      "set_history_tracks",
      "set_history_devices",
      "set_history_session_clips",
      "set_history_arrangement_clips",
      "set_history_scenes",
      "set_history_cue_points",
      "set_history_trajectories",
      "set_history_agent_links",
      "agent_history_sessions",
      "agent_history_turns",
      "agent_history_messages",
      "agent_history_tool_calls",
      "agent_history_tool_results",
      "agent_history_approvals",
    ] as const;
    for (const view of publicViews) {
      await expect(
        journal.queryPublicHistory(`SELECT * FROM ${view} LIMIT 0`, [], 1),
      ).resolves.toMatchObject({ rows: [], rowCount: 0, truncated: false });
    }

    const tracks = await journal.queryPublicHistory(
      `SELECT track_id, name, volume
       FROM set_history_tracks
       WHERE live_set_id = ?
       ORDER BY track_index`,
      ["live-set-1"],
      10,
    );
    expect(tracks).toMatchObject({
      version: 1,
      schemaVersion: observabilitySchemaVersion,
      columns: ["track_id", "name", "volume"],
      rows: [{ track_id: "track-1", name: "Lead", volume: 0.8 }],
      rowCount: 1,
      truncated: false,
    });
    expect(tracks.elapsedMs).toBeGreaterThanOrEqual(0);

    const agent = await journal.queryPublicHistory(
      `WITH completed AS (
         SELECT turn_id, prompt FROM agent_history_turns
         WHERE status = ?
       )
       SELECT turn_id, prompt FROM completed`,
      ["completed"],
      10,
    );
    expect(agent.rows).toEqual([
      { turn_id: "turn-1", prompt: "Use token=[REDACTED] to set tempo" },
    ]);

    const truncated = await journal.queryPublicHistory(
      "SELECT record_id FROM agent_history_messages UNION ALL SELECT record_id FROM agent_history_tool_calls",
      [],
      1,
    );
    expect(truncated).toMatchObject({ rowCount: 1, truncated: true });

    await expect(
      journal.queryPublicHistory("SELECT * FROM set_snapshots", [], 10),
    ).rejects.toThrow(JournalQueryError);
    await expect(
      journal.queryPublicHistory("SELECT * FROM app_events", [], 10),
    ).rejects.toThrow(JournalQueryError);
    await expect(
      journal.queryPublicHistory("DELETE FROM agent_history_messages", [], 10),
    ).rejects.toThrow(JournalQueryError);
    await expect(
      journal.queryPublicHistory(
        "SELECT randomblob(4) AS value FROM agent_history_sessions",
        [],
        10,
      ),
    ).rejects.toThrow(JournalQueryError);
    await expect(
      journal.queryPublicHistory(
        "WITH values_only AS (SELECT 1 AS value) SELECT value FROM values_only",
        [],
        10,
      ),
    ).rejects.toThrow(JournalQueryError);
    await expect(
      journal.queryPublicHistory(
        "SELECT record_id FROM agent_history_sessions",
        [],
        201,
      ),
    ).rejects.toThrow(JournalQueryError);

    await journal.appendSetHistory({
      ...setHistoryRecords()[0]!,
      id: id(1_104),
    });
    expect((await journal.readSetHistory()).items).toHaveLength(4);
  });

  it("reports duplicate writes explicitly without poisoning later batches", async () => {
    const journal = await openJournal({ batchDelayMs: 0 });
    await journal.enqueue(event(1));
    await expect(journal.enqueue(event(1))).rejects.toThrow(
      JournalDuplicateError,
    );
    await journal.enqueue(event(2));

    expect((await journal.read()).items).toHaveLength(2);
    expect((await journal.getHealth()).rejectedWrites).toBe(1);
  });

  it("sanitizes credentials before persistence without dropping detailed payloads", async () => {
    const journal = await openJournal({ batchDelayMs: 0 });
    await journal.enqueue({
      ...event(1),
      attributes: {
        prompt: "Create these MIDI notes at /tracks/Lead",
        toolArguments: { notes: [{ pitch: 60, velocity: 100 }] },
        accessToken: "never-persist-this",
        response: "Bearer also-never-persist-this",
      },
    });

    const stored = (await journal.read()).items[0]?.attributes;
    expect(stored).toMatchObject({
      prompt: "Create these MIDI notes at /tracks/Lead",
      toolArguments: { notes: [{ pitch: 60, velocity: 100 }] },
      accessToken: "[REDACTED]",
      response: "Bearer [REDACTED]",
    });
    expect(JSON.stringify(stored)).not.toContain("never-persist-this");
  });

  it("persists detailed local content without retaining embedded secrets", async () => {
    const path = await databasePath();
    const journal = await openJournal({ path, batchDelayMs: 0 });
    const secrets = [
      "journal-bearer-secret",
      "journal-assignment-secret",
      "journal-url-secret",
      "journal-private-key-secret",
      "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    ];
    const detailedContent = {
      prompt:
        "Create two syncopated MIDI notes in /Users/cooper/Sets/Journal.als",
      assistantContent:
        "I will preserve the clip loop and update only the requested notes.",
      toolDefinition: {
        name: "replace_midi_notes",
        description: "Replace selected note events in a clip.",
      },
      toolArguments: {
        clipPath: "/tracks/Lead/clips/Verse",
        notes: [{ pitch: 60, start: 0.5, duration: 0.25, velocity: 91 }],
      },
      toolResult: { changedNotes: 1, clipName: "Verse" },
      eventPayload: {
        kind: "midi.note_changed",
        note: { pitch: 60, velocity: 91 },
      },
    };
    await journal.enqueue({
      ...event(1),
      attributes: {
        ...detailedContent,
        authorizationText: `Authorization: Bearer ${secrets[0]}`,
        assignmentText: `password="${secrets[1]}"`,
        serviceUrl: `https://agent:${secrets[2]}@localhost:4711/session`,
        privateKeyText: [
          "-----BEGIN PRIVATE KEY-----",
          secrets[3],
          "-----END PRIVATE KEY-----",
        ].join("\n"),
        providerTokenText: secrets[4],
      },
    });
    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const sql = await initSqlJs();
    const database = new sql.Database(new Uint8Array(await readFile(path)));
    const persistedPayload = database.exec("SELECT payload FROM app_events")[0]
      ?.values[0]?.[0];
    database.close();

    expect(persistedPayload).toBeTypeOf("string");
    const serialized = String(persistedPayload);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    const persisted = JSON.parse(serialized) as { attributes?: unknown };
    expect(persisted.attributes).toMatchObject(detailedContent);
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts provider-prefixed credentials before journal persistence", async () => {
    const path = await databasePath();
    const journal = await openJournal({ path, batchDelayMs: 0 });
    const secrets = {
      ableton: "journal-ableton-prefixed-secret",
      openai: "journal-openai-prefixed-secret",
      aws: "journal-aws-prefixed-secret",
    };
    const prompt =
      "Keep the detailed MIDI note payload and token budget description.";
    await journal.enqueue({
      ...event(1),
      attributes: {
        prompt,
        tokenBudget: 8_192,
        ABLETON_AGENT_TOKEN: secrets.ableton,
        OPENAI_API_KEY: secrets.openai,
        AWS_SECRET_ACCESS_KEY: secrets.aws,
        text: [
          `ABLETON_AGENT_TOKEN=${secrets.ableton}`,
          `OPENAI_API_KEY="${secrets.openai}"`,
          `AWS_SECRET_ACCESS_KEY='${secrets.aws}'`,
          "token_budget=8192",
        ].join("\n"),
      },
    });
    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const sql = await initSqlJs();
    const database = new sql.Database(new Uint8Array(await readFile(path)));
    const persistedPayload = database.exec("SELECT payload FROM app_events")[0]
      ?.values[0]?.[0];
    database.close();

    expect(persistedPayload).toBeTypeOf("string");
    const serialized = String(persistedPayload);
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    const persisted = JSON.parse(serialized) as { attributes?: unknown };
    const attributes = persisted.attributes as Record<string, unknown>;
    expect(attributes).toMatchObject({
      prompt,
      tokenBudget: 8_192,
      ABLETON_AGENT_TOKEN: REDACTED_VALUE,
      OPENAI_API_KEY: REDACTED_VALUE,
      AWS_SECRET_ACCESS_KEY: REDACTED_VALUE,
    });
    expect(String(attributes.text)).toContain("token_budget=8192");
  });

  it("bounds the pending queue and reports saturation", async () => {
    const journal = await openJournal({
      batchSize: 10,
      batchDelayMs: 5_000,
      maxPendingWrites: 1,
    });
    const accepted = journal.enqueue(event(1));
    await expect(journal.enqueue(event(2))).rejects.toThrow(
      JournalQueueFullError,
    );
    expect((await journal.getHealth()).maxPendingWrites).toBe(1);
    await journal.flush();
    await accepted;
  });

  it("prunes expired traces as roots and expires configuration snapshots", async () => {
    const journal = await openJournal({
      now: () => new Date("2026-08-29T22:00:00.000Z"),
      retention: { maxAgeDays: 30 },
      batchSize: 4,
      batchDelayMs: 5_000,
    });
    const oldTrace = id(901);
    const mixedTrace = id(902);
    await Promise.all([
      journal.enqueue(
        event(1, { at: "2026-07-01T00:00:00.000Z", traceId: oldTrace }),
      ),
      journal.enqueue(
        event(2, { at: "2026-07-01T00:00:00.000Z", traceId: mixedTrace }),
      ),
      journal.enqueue(
        event(3, { at: "2026-08-29T00:00:00.000Z", traceId: mixedTrace }),
      ),
      journal.enqueueConfigurationSnapshot({
        ...snapshot(1),
        capturedAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);

    expect((await journal.readTrace(oldTrace)).items).toHaveLength(0);
    expect((await journal.readTrace(mixedTrace)).items).toHaveLength(2);
    expect((await journal.readConfigurationSnapshots()).items).toHaveLength(0);
  });

  it("keeps agent and Set history outside App age retention", async () => {
    let now = new Date("2026-08-29T22:12:00.000Z");
    const journal = await openJournal({
      batchDelayMs: 0,
      now: () => now,
      retention: { maxAgeDays: 1, maxBytes: 10 * 1024 * 1024 },
    });
    await Promise.all([
      journal.appendAgentHistory(agentHistoryRecords()[0]!),
      journal.appendSetHistory(setHistoryRecords()[0]!),
    ]);
    expect((await journal.readAgentHistory()).items).toHaveLength(1);
    expect((await journal.readSetHistory()).items).toHaveLength(1);

    now = new Date("2026-09-01T22:12:00.000Z");
    await journal.runRetention();
    expect((await journal.readAgentHistory()).items).toHaveLength(1);
    expect((await journal.readSetHistory()).items).toHaveLength(1);
  });

  it("keeps agent and Set history outside App size retention", async () => {
    const path = await databasePath();
    const journal = await openJournal({ path, batchDelayMs: 0 });
    await Promise.all([
      journal.enqueue(event(1, { padding: "x".repeat(10_000) })),
      journal.appendAgentHistory(agentHistoryRecords()[0]!),
      journal.appendSetHistory(setHistoryRecords()[0]!),
    ]);
    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const constrained = await openJournal({
      path,
      retention: { maxAgeDays: 30, maxBytes: 1 },
    });
    expect((await constrained.read()).items).toHaveLength(0);
    expect((await constrained.readAgentHistory()).items).toHaveLength(1);
    expect((await constrained.readSetHistory()).items).toHaveLength(1);
  });

  it("enforces max bytes by deleting the oldest whole root trace", async () => {
    const path = await databasePath();
    const first = await openJournal({
      path,
      batchSize: 3,
      batchDelayMs: 5_000,
    });
    const oldestTrace = id(903);
    const newestTrace = id(904);
    await Promise.all([
      first.enqueue(
        event(1, { traceId: oldestTrace, padding: "a".repeat(2_000) }),
      ),
      first.enqueue(
        event(2, { traceId: oldestTrace, padding: "b".repeat(2_000) }),
      ),
      first.enqueue(
        event(3, { traceId: newestTrace, padding: "c".repeat(2_000) }),
      ),
    ]);
    const bytes = (await first.getHealth()).databaseBytes;
    await first.shutdown();
    openJournals.splice(openJournals.indexOf(first), 1);

    const constrained = await openJournal({
      path,
      retention: { maxBytes: bytes - 1 },
    });
    expect((await constrained.readTrace(oldestTrace)).items).toHaveLength(0);
    expect((await constrained.getHealth()).databaseBytes).toBeLessThanOrEqual(
      bytes - 1,
    );
  });

  it("iteratively enforces a 1 MiB cap while retaining the newest roots", async () => {
    const maxBytes = 1024 * 1024;
    const journal = await openJournal({
      retention: { maxBytes },
      batchSize: 48,
      batchDelayMs: 5_000,
    });
    const writes = Array.from({ length: 48 }, (_, index) => {
      const value = index + 1;
      return journal.enqueue(
        event(value, {
          at: new Date(
            Date.parse("2026-08-29T22:00:00.000Z") + index,
          ).toISOString(),
          traceId: id(3_000 + index),
          padding: String(index % 10).repeat(40_000),
        }),
      );
    });
    await Promise.all(writes);

    const health = await journal.getHealth();
    expect(health.databaseBytes).toBeLessThanOrEqual(maxBytes);
    expect((await journal.readTrace(id(3_000))).items).toHaveLength(0);
    expect((await journal.readTrace(id(3_047))).items).toHaveLength(1);
    expect(await journal.runRetention()).toMatchObject({
      withinMaxBytes: true,
      sizeLimitReason: null,
    });
  });

  it("keeps small-event history close to a 1 MiB cap", async () => {
    const maxBytes = 1024 * 1024;
    const eventCount = 3_000;
    const journal = await openJournal({
      retention: { maxBytes },
      batchSize: eventCount,
      batchDelayMs: 5_000,
    });
    const startedAt = Date.parse("2026-08-29T22:00:00.000Z");
    await Promise.all(
      Array.from({ length: eventCount }, (_, index) =>
        journal.enqueue(
          event(10_000 + index, {
            at: new Date(startedAt + index).toISOString(),
          }),
        ),
      ),
    );

    const health = await journal.getHealth();
    const retained = await journal.readEvents({ limit: 1 });
    expect(health.databaseBytes).toBeLessThanOrEqual(maxBytes);
    expect(health.databaseBytes).toBeGreaterThan(maxBytes * 0.75);
    expect(retained.page.totalItems).toBeGreaterThan(500);
    expect((await journal.readTrace(id(10_000))).items).toHaveLength(0);
    expect((await journal.readTrace(id(12_999))).items).toHaveLength(1);
  });

  it("reports an unavoidable schema minimum only with no removable data", async () => {
    const journal = await openJournal({
      retention: { maxBytes: 1 },
    });

    const result = await journal.runRetention();
    expect(result.withinMaxBytes).toBe(false);
    expect(result.sizeLimitReason).toBe("schema-minimum");
    expect(result.databaseBytes).toBe(result.minimumDatabaseBytes);
    expect((await journal.getHealth()).persistedEvents).toBe(0);
  });

  it("deletes filtered events, traces, snapshots, and all remaining records", async () => {
    const journal = await openJournal({ batchSize: 5, batchDelayMs: 5_000 });
    const traceId = id(905);
    await Promise.all([
      journal.enqueue(event(1, { traceId })),
      journal.enqueue(event(2, { traceId })),
      journal.enqueue(event(3, { level: "error" })),
      journal.enqueueConfigurationSnapshot(snapshot(1)),
      journal.enqueueConfigurationSnapshot(snapshot(2, "bridge.protocol")),
    ]);

    expect(await journal.deleteTrace(traceId)).toBe(2);
    expect(await journal.deleteEvents({ levels: ["error"] })).toBe(1);
    expect(
      await journal.deleteConfigurationSnapshots({
        components: ["bridge.protocol"],
      }),
    ).toBe(1);
    expect(await journal.clear()).toEqual({
      deletedEvents: 0,
      deletedConfigurationSnapshots: 1,
    });
  });

  it("persists atomically, migrates, locks, reopens, and shuts down safely", async () => {
    const path = await databasePath();
    const journal = await openJournal({ path, batchDelayMs: 0 });
    await journal.enqueue(event(1));
    await journal.flush();

    expect(await readdir(dirname(path))).toEqual(
      expect.arrayContaining([
        "observability.sqlite",
        "observability.sqlite.lock",
      ]),
    );
    expect(
      (await readdir(dirname(path))).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
    await expect(LocalObservabilityJournal.open({ path })).rejects.toThrow(
      "already open",
    );
    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const reopened = await openJournal({ path });
    expect((await reopened.read()).items[0]?.id).toBe(id(1));

    const sql = await initSqlJs();
    const database = new sql.Database(new Uint8Array(await readFile(path)));
    expect(database.exec("PRAGMA user_version")[0]?.values).toEqual([
      [observabilitySchemaVersion],
    ]);
    expect(
      database.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'app_events_trace'",
      )[0]?.values,
    ).toEqual([["app_events_trace"]]);
    database.close();

    await reopened.shutdown();
    expect((await reopened.getHealth()).status).toBe("closed");
    await expect(reopened.enqueue(event(2))).rejects.toThrow(
      JournalClosedError,
    );
    await expect(reopened.read()).rejects.toThrow(JournalClosedError);
  });

  it("migrates legacy project attribution to Live Set attribution", async () => {
    const path = await databasePath();
    const sql = await initSqlJs();
    const database = new sql.Database();
    const legacyMigration = observabilityMigrations[0];
    if (legacyMigration === undefined) throw new Error("Missing v1 migration");
    for (const statement of legacyMigration.statements) database.run(statement);
    database.run(
      `INSERT INTO observability_schema_migrations
        (version, description, applied_at) VALUES (1, ?, ?)`,
      [legacyMigration.description, "2026-08-29T22:00:00.000Z"],
    );
    database.run(
      `INSERT INTO telemetry_events (
        event_id, contract_version, occurred_at, recorded_at, name, source,
        level, root_trace_id, project_id, payload
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id(1),
        "2026-08-29T22:00:01.000Z",
        "2026-08-29T22:00:02.000Z",
        "tool.completed",
        "agent.runtime",
        "info",
        id(1),
        "legacy-live-set",
        JSON.stringify({
          ...event(1),
          version: 1,
          projectId: "legacy-live-set",
        }),
      ],
    );
    await writeFile(path, database.export());
    database.close();

    const journal = await openJournal({ path });
    const page = await journal.read({ liveSetId: "legacy-live-set" });

    expect((await journal.getHealth()).schemaVersion).toBe(
      observabilitySchemaVersion,
    );
    expect(page.items).toMatchObject([
      {
        version: 2,
        liveSetId: "legacy-live-set",
      },
    ]);
    expect(page.items[0]).not.toHaveProperty("projectId");
  });

  it("refuses a database created by a newer journal schema", async () => {
    const path = await databasePath();
    const journal = await openJournal({ path });
    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const sql = await initSqlJs();
    const database = new sql.Database(new Uint8Array(await readFile(path)));
    database.run(
      `INSERT INTO observability_schema_migrations
        (version, description, applied_at) VALUES (?, 'future', ?)`,
      [observabilitySchemaVersion + 1, "2026-08-29T22:00:00.000Z"],
    );
    await writeFile(path, database.export());
    database.close();

    await expect(LocalObservabilityJournal.open({ path })).rejects.toThrow(
      JournalSchemaVersionError,
    );
  });

  it("keeps stress writes off-thread and durable across worker restart", async () => {
    const path = await databasePath("stress.sqlite");
    const journal = await openJournal({
      path,
      batchSize: 32,
      batchDelayMs: 5_000,
    });
    expect(journal.workerThreadId).toBeGreaterThan(0);
    const recorder = createNonBlockingObservabilityRecorder(journal);
    const startedAt = Date.parse("2026-08-29T22:00:00.000Z");
    const eventCount = 240;
    for (let index = 0; index < eventCount; index += 1) {
      recorder.enqueue(
        event(1_000 + index, {
          at: new Date(startedAt + index).toISOString(),
          traceId: id(2_000 + Math.floor(index / 8)),
          padding: "x".repeat(1_024),
        }),
      );
    }
    await journal.flush();
    expect((await journal.getHealth()).persistedEvents).toBe(eventCount);
    await journal.shutdown();
    openJournals.splice(openJournals.indexOf(journal), 1);

    const reopened = await openJournal({ path });
    const roots = await reopened.readRootTraces({ limit: 100 });
    expect(roots.page.totalItems).toBe(eventCount / 8);
    expect(roots.items).toHaveLength(eventCount / 8);
    expect((await reopened.readEvents({ limit: 1 })).page.totalItems).toBe(
      eventCount,
    );
  });

  it("makes worker death terminal for current, queued, and future operations", async () => {
    let worker: Worker | undefined;
    const journal = await openJournal({
      batchDelayMs: 5_000,
      workerFactory: () => {
        worker = new Worker(
          new URL("./journal-hanging-worker.mjs", import.meta.url),
        );
        return worker;
      },
    });
    const queuedWrite = journal.enqueue(event(1));
    const currentRequest = journal.getHealth();
    await worker?.terminate();

    await expect(currentRequest).rejects.toMatchObject({ code: "io" });
    await expect(queuedWrite).rejects.toMatchObject({ code: "io" });
    expect(journal.isOpen).toBe(false);
    await expect(journal.enqueue(event(2))).rejects.toMatchObject({
      code: "io",
    });
    await expect(journal.read()).rejects.toMatchObject({ code: "io" });
    await expect(journal.flush()).rejects.toMatchObject({ code: "io" });
    await expect(journal.shutdown()).rejects.toMatchObject({ code: "io" });
    openJournals.splice(openJournals.indexOf(journal), 1);
  });
});
