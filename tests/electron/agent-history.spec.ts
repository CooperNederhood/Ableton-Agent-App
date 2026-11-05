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
import {
  createDesktopTestEnvironment,
  writeDesktopTestPreferences,
} from "./desktop-test-environment.js";

test("reads complete sanitized SDK result evidence through typed main/preload History IPC", async () => {
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
    await expect(
      page.evaluate(() =>
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
