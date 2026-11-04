import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunResult } from "../../packages/test-support/src/integration/index.js";
import { acceptanceDefinition } from "./acceptance-cli.js";
import {
  readSuiteAttempt,
  verifyAcceptanceSuite,
} from "./acceptance-suite-evidence.js";
import { runAcceptanceSuite, type SuiteInputs } from "./acceptance-suite.js";
import { writeScenarioReceipt } from "./scenario-receipts.mjs";

const inputs: SuiteInputs = {
  candidateSha256: "a".repeat(64),
  appAsarSha256: "b".repeat(64),
  sourceSha256: "c".repeat(64),
  sourceRevision: "d".repeat(40),
  dirty: false,
  definitionsSha256: "e".repeat(64),
  selected: ["session-clip-identify"],
};
async function fixture(test: (directory: string) => Promise<void>) {
  const parent = resolve(".test-artifacts/acceptance-suite-evidence-unit");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function writeCase(
  directory: string,
  runId: string,
  traceId: string,
  mutation?: (receipt: Record<string, unknown>, result: RunResult) => void,
) {
  const { scenario, fixture } = await acceptanceDefinition(
    process.cwd(),
    "session-clip-identify",
  );
  const result: RunResult = {
    schemaVersion: 1,
    runId,
    traceId,
    scenarioId: scenario.id,
    fixtureId: fixture.id,
    status: "passed",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    selected: scenario.steps.map(({ id }) => id),
    executed: scenario.steps.map(({ id }) => id),
    unrun: [],
    assertions: [
      ...scenario.steps.flatMap((step) => step.assertions),
      ...scenario.assertions,
    ].map(({ name }) => ({
      name,
      passed: true,
      code: "matched",
      detail: "controlled evidence",
    })),
    turns: scenario.steps.map((_, index) => ({
      schemaVersion: 1,
      terminal: true,
      status: "completed",
      assistantMessageId: `assistant-${index}`,
      appSessionId: "session",
      conversationId: "conversation",
      agentId: "agent",
      userMessageId: `user-${index}`,
      operationId: `operation-${index}`,
      assistantText: "controlled",
      captures: [],
      contexts: [],
      facts: {},
    })),
    baseline: {
      schemaVersion: 1,
      facts: fixture.baseline,
      dependencyHashes: { "machine-listening": "f".repeat(64) },
    },
    dependencyInventory: {
      schemaVersion: 1,
      candidateRoot: "/controlled",
      resources: [
        {
          id: "machine-listening",
          path: "device.amxd",
          target: "dependencies/machine-listening/device.amxd",
          sha256: "f".repeat(64),
          bytes: 24,
        },
      ],
    },
    finalizationFailures: [],
    cleanupComplete: true,
    persisted: true,
    evidence: {
      schemaVersion: 1,
      facts: { candidateSha256: inputs.appAsarSha256, liveVersion: "11.3.43" },
      contexts: [],
      unchanged: [],
    },
  };
  const receipt: Record<string, unknown> = {
    schema: "acceptance-run/v1",
    finalization: "final",
    completionOwner: "acceptance-cli",
    droppedEvents: 0,
    result,
  };
  mutation?.(receipt, result);
  await writeScenarioReceipt(join(directory, "receipt.json"), receipt);
  await writeScenarioReceipt(join(directory, "checkpoint.json"), {
    finalization: "checkpoint",
    result,
  });
  await writeScenarioReceipt(join(directory, "product-evidence.json"), {
    schema: "acceptance-product-evidence/v1",
    runId,
    scenarioId: scenario.id,
    traceId,
    provenance: {
      candidateSha256: inputs.appAsarSha256,
      liveVersion: "11.3.43",
    },
  });
  await writeScenarioReceipt(join(directory, "cleanup-evidence.json"), {
    schema: "acceptance-cleanup/v1",
    runId,
    scenarioId: scenario.id,
    traceId,
    failures: [],
    resources: {
      desktopStopped: true,
      liveStopped: true,
      hostReservationClosed: true,
      profileRemoved: true,
    },
  });
}

describe("local acceptance qualification verifier", () => {
  it.each([true, false])(
    "checks profile absence before accepting resource reclamation after failed cleanup (profile exists: %s)",
    async (profileExists) => {
      await fixture(async (directory) => {
        const runId = randomUUID(),
          traceId = randomUUID();
        await writeCase(directory, runId, traceId, (receipt, result) => {
          receipt.result = {
            ...result,
            status: "failed",
            cleanupComplete: false,
            finalizationFailures: [
              { stage: "cleanup", message: "History collection failed" },
            ],
          };
        });
        if (profileExists) await mkdir(join(directory, "profile"));
        const attempt = readSuiteAttempt({
          root: process.cwd(),
          suiteDirectory: directory,
          directory,
          runId,
          traceId,
          scenarioId: inputs.selected[0]!,
          inputs,
          exitCode: 1,
        });
        if (profileExists)
          await expect(attempt).rejects.toThrow(
            "Case left its isolated credential profile behind",
          );
        else
          await expect(attempt).resolves.toMatchObject({
            status: "failed",
            cleanupComplete: false,
            resourcesReclaimed: true,
          });
      });
    },
  );
  it.each(["missing", "foreign", "unsafe"])(
    "rejects %s cleanup proof despite a passing scenario receipt",
    async (kind) => {
      await fixture(async (directory) => {
        const runId = randomUUID(),
          traceId = randomUUID();
        await writeCase(directory, runId, traceId);
        const path = join(directory, "cleanup-evidence.json");
        if (kind === "missing") await rm(path);
        else
          await writeScenarioReceipt(path, {
            schema: "acceptance-cleanup/v1",
            runId: kind === "foreign" ? randomUUID() : runId,
            scenarioId: inputs.selected[0],
            traceId,
            failures: [],
            resources: {
              desktopStopped: true,
              liveStopped: kind !== "unsafe",
              hostReservationClosed: true,
              profileRemoved: true,
            },
          });
        await expect(
          readSuiteAttempt({
            root: process.cwd(),
            suiteDirectory: directory,
            directory,
            runId,
            traceId,
            scenarioId: inputs.selected[0]!,
            inputs,
            exitCode: 0,
          }),
        ).rejects.toThrow();
      });
    },
  );
  it("rejects product evidence belonging to another case on the same suite trace", async () => {
    await fixture(async (directory) => {
      const runId = randomUUID(),
        traceId = randomUUID();
      await writeCase(directory, runId, traceId);
      await writeScenarioReceipt(join(directory, "product-evidence.json"), {
        schema: "acceptance-product-evidence/v1",
        runId: randomUUID(),
        scenarioId: "session-listening-continuity",
        traceId,
        provenance: {
          candidateSha256: inputs.appAsarSha256,
          liveVersion: "11.3.43",
        },
      });
      await expect(
        readSuiteAttempt({
          root: process.cwd(),
          suiteDirectory: directory,
          directory,
          runId,
          traceId,
          scenarioId: inputs.selected[0]!,
          inputs,
          exitCode: 0,
        }),
      ).rejects.toThrow("attribution mismatch");
    });
  });
  it("cross-checks terminal receipts and rejects subsequently changed evidence or candidate", async () => {
    await fixture(async (directory) => {
      await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release: async () => {} }),
          execute: async (options) => {
            await writeCase(options.directory, options.runId, options.traceId);
            return readSuiteAttempt({
              ...options,
              root: process.cwd(),
              suiteDirectory: directory,
            });
          },
        },
      );
      const options = {
        root: process.cwd(),
        receiptPath: join(directory, "suite.json"),
        inputs,
      };
      await expect(verifyAcceptanceSuite(options)).resolves.toBeUndefined();
      await expect(
        verifyAcceptanceSuite({
          ...options,
          inputs: { ...inputs, candidateSha256: "0".repeat(64) },
        }),
      ).rejects.toThrow("stale");
      await expect(
        verifyAcceptanceSuite({
          ...options,
          inputs: { ...inputs, selected: [...inputs.selected, "new-test"] },
        }),
      ).rejects.toThrow("stale");
      await writeScenarioReceipt(
        join(directory, "case-1/product-evidence.json"),
        { replaced: true },
      );
      await expect(verifyAcceptanceSuite(options)).rejects.toThrow();
    });
  });

  it.each([
    "checkpoint",
    "foreign-run",
    "candidate",
    "cleanup",
    "skipped",
    "persistence",
    "assertion",
    "missing-assertions",
    "missing-turns",
  ])("rejects %s evidence rather than trusting exit zero", async (kind) => {
    await fixture(async (directory) => {
      const runId = randomUUID(),
        traceId = randomUUID();
      await writeCase(directory, runId, traceId, (receipt, result) => {
        if (kind === "checkpoint") receipt.finalization = "checkpoint";
        if (kind === "foreign-run")
          receipt.result = { ...result, runId: randomUUID() };
        if (kind === "candidate")
          receipt.result = {
            ...result,
            evidence: {
              ...result.evidence,
              facts: {
                candidateSha256: "0".repeat(64),
                liveVersion: "11.3.43",
              },
            },
          };
        if (kind === "cleanup")
          receipt.result = { ...result, cleanupComplete: false };
        if (kind === "skipped")
          receipt.result = { ...result, executed: [], unrun: result.selected };
        if (kind === "persistence")
          receipt.result = { ...result, persisted: false };
        if (kind === "missing-assertions")
          receipt.result = { ...result, assertions: [] };
        if (kind === "missing-turns") receipt.result = { ...result, turns: [] };
        if (kind === "assertion")
          receipt.result = {
            ...result,
            assertions: [
              {
                name: "capture-count",
                passed: false,
                code: "wrong",
                detail: "failure",
              },
            ],
          };
      });
      await expect(
        readSuiteAttempt({
          root: process.cwd(),
          suiteDirectory: directory,
          directory,
          runId,
          traceId,
          scenarioId: inputs.selected[0]!,
          inputs,
          exitCode: 0,
        }),
      ).rejects.toThrow();
    });
  });
});
