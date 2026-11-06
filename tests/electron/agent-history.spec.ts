import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  LocalObservabilityJournal,
  agentHistoryRecordSchema,
} from "../../packages/observability/src/index.js";
import {
  collectAgentListeningEvidence,
  verifyAgentListeningResult,
} from "../../packages/test-support/src/integration/agent-listening-result.js";
import { agentListeningFixture } from "../../packages/test-support/src/integration/agent-listening-test-support.js";
import { nativeMetricLifecycleSchema } from "../../packages/signal-routing/src/listener-metric-contracts.js";
import {
  createDesktopTestEnvironment,
  writeDesktopTestPreferences,
} from "./desktop-test-environment.js";

test("reads sanitized SDK results and reopens pitch diagnostics through typed History IPC", async () => {
  const profile = await mkdtemp(join(process.cwd(), "ableton-agent-history-"));
  const bridge = createServer((socket) => socket.destroy());
  const signalReservation = createServer();
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let journal: LocalObservabilityJournal | undefined;
  try {
    await new Promise<void>((done) => bridge.listen(0, "127.0.0.1", done));
    await new Promise<void>((done) =>
      signalReservation.listen(0, "127.0.0.1", done),
    );
    const bridgeAddress = bridge.address(),
      signalAddress = signalReservation.address();
    if (
      !bridgeAddress ||
      typeof bridgeAddress === "string" ||
      !signalAddress ||
      typeof signalAddress === "string"
    )
      throw new Error("Missing isolated test ports");
    const environment = createDesktopTestEnvironment({
      profile,
      bridgePort: bridgeAddress.port,
    });
    await mkdir(environment.HOME!, { recursive: true });
    await mkdir(environment.TMPDIR!, { recursive: true });
    const storage = await writeDesktopTestPreferences(
      environment,
      signalAddress.port,
    );
    await new Promise<void>((done, reject) =>
      signalReservation.close((error) => (error ? reject(error) : done())),
    );
    const f = agentListeningFixture();
    f.records.find((record) => record.kind === "tool_call")!.metadata.note =
      "Bearer synthetic-private";
    journal = await LocalObservabilityJournal.open({
      path: storage.eventJournalPath,
    });
    const pitchId = "ad167ace-1d3f-4f6b-b730-005eafc00500";
    const pitchTrace = "ad167ace-1d3f-4f6b-b730-005eafc00501";
    const pitchLifecycle = nativeMetricLifecycleSchema.parse({
      scope: "independent-metric-timelines/v1",
      metric: "monophonic-pitch",
      eventId: pitchId,
      causationId: "ad167ace-1d3f-4f6b-b730-005eafc00502",
      generation: "ad167ace-1d3f-4f6b-b730-005eafc00503",
      nativeEpoch: 1,
      stage: "progress",
      phase: "capture",
      elapsedMs: 200,
      durationMs: 100,
      frames: 0,
      reason: "pitch_smoke_output",
      facts: [
        { field: "pitch.leftHz", actual: { state: "observed", value: 110 } },
        { field: "pitch.rightHz", actual: { state: "observed", value: 0 } },
        {
          field: "pitch.leftConfidence",
          actual: { state: "observed", value: 0.8 },
        },
        {
          field: "pitch.rightConfidence",
          actual: { state: "observed", value: 0.1 },
        },
        {
          field: "pitch.support",
          actual: { state: "observed", value: "unqualified" },
        },
      ],
    });
    await journal.enqueue({
      version: 2,
      id: pitchId,
      occurredAt: new Date().toISOString(),
      name: "output.listener.native.metric.monophonic-pitch.progress",
      source: "output-ingress",
      level: "info",
      outcome: "unknown",
      durationMs: 100,
      trace: { traceId: pitchTrace, spanId: pitchId },
      correlationId: "pitch-ipc",
      causationId: pitchLifecycle.causationId,
      attributes: {
        lifecycle: pitchLifecycle,
        diagnostic: "token=pitch-private-secret",
      },
    });
    for (const record of f.records)
      await journal.appendAgentHistory(
        agentHistoryRecordSchema.parse(
          Object.fromEntries(
            Object.entries(record).filter(([key]) => key !== "recordedAt"),
          ),
        ),
      );
    await journal.shutdown();
    journal = undefined;
    application = await electron.launch({
      args: [
        resolve("apps/desktop"),
        `--user-data-dir=${join(profile, "electron")}`,
      ],
      cwd: process.cwd(),
      env: environment,
    });
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const evidence = await collectAgentListeningEvidence(
      f.owner,
      false,
      (query) =>
        page.evaluate(
          (query) => window.desktop.eventHistory.agent(query),
          query,
        ),
    );
    expect(JSON.stringify(evidence)).not.toContain("synthetic-private");
    expect(JSON.stringify(evidence)).toContain("[REDACTED]");
    const turn = { ...f.turn, agentListening: evidence };
    verifyAgentListeningResult({ ...f.input, turn, turns: [turn] }, "a");
    const foreign = await page.evaluate(() =>
      window.desktop.eventHistory.agent({ appSessionId: "foreign" }),
    );
    expect(foreign.items).toEqual([]);
    await expect(
      page.evaluate(() => window.desktop.eventHistory.agent({ limit: 10000 })),
    ).rejects.toThrow();
    const readPitch = () =>
      page.evaluate(
        (traceId) => window.desktop.eventHistory.trace(traceId),
        pitchTrace,
      );
    const firstPitch = (await readPitch()).items;
    expect(firstPitch).toHaveLength(1);
    expect(firstPitch[0]).toMatchObject({
      id: pitchId,
      durationMs: 100,
      correlationId: "pitch-ipc",
      trace: { traceId: pitchTrace, spanId: pitchId },
      attributes: {
        lifecycle: pitchLifecycle,
        diagnostic: "token=[REDACTED]",
      },
    });
    expect(JSON.stringify(firstPitch)).not.toContain("pitch-private-secret");
    await application.close();
    application = await electron.launch({
      args: [
        resolve("apps/desktop"),
        `--user-data-dir=${join(profile, "electron")}`,
      ],
      cwd: process.cwd(),
      env: environment,
    });
    const reopened = await application.firstWindow();
    await reopened.waitForLoadState("domcontentloaded");
    const persistedPitch = await reopened.evaluate(
      (traceId) => window.desktop.eventHistory.trace(traceId),
      pitchTrace,
    );
    expect(persistedPitch.items).toEqual(firstPitch);
    await expect(
      reopened.evaluate(() =>
        window.desktop.eventHistory.agent({
          limit: 10,
          ...{ sql: "SELECT * FROM agent_tool_results" },
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await journal?.shutdown();
    await application?.close();
    if (bridge.listening)
      await new Promise<void>((done, reject) =>
        bridge.close((error) => (error ? reject(error) : done())),
      );
    if (signalReservation.listening)
      await new Promise<void>((done, reject) =>
        signalReservation.close((error) => (error ? reject(error) : done())),
      );
    await rm(profile, { recursive: true, force: true });
  }
});
