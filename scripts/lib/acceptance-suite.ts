import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssertionResult,
  LifecycleEvent,
  RunStatus,
} from "../../packages/test-support/src/integration/index.js";
import { readAcceptanceJson } from "./acceptance-cli.js";
import type { IdentityEntry } from "./acceptance-identity.js";
import {
  describeScenarioError,
  serializeScenarioReceipt,
  writeScenarioReceipt,
} from "./scenario-receipts.mjs";

export interface SuiteInputs {
  candidateSha256: string;
  appAsarSha256: string;
  sourceSha256: string;
  sourceRevision: string;
  dirty: boolean;
  definitionsSha256: string;
  selected: readonly string[];
  provenance?: {
    platform: string;
    architecture: string;
    candidateInventory: readonly IdentityEntry[];
    sourceInventory: readonly IdentityEntry[];
    lockfile: IdentityEntry;
  };
}
export interface SuiteAttempt {
  scenarioId: string;
  runId: string;
  status: RunStatus;
  executed: boolean | null;
  cleanupComplete: boolean;
  persisted: boolean;
  receiptPath: string;
  receiptSha256: string;
  assertions: readonly AssertionResult[];
  checkpointSha256?: string;
  productEvidenceSha256?: string;
  liveVersion?: string;
  failure?: string;
}
export interface SuiteReceipt {
  schema: "acceptance-suite/v1";
  finalization: "checkpoint" | "final";
  runId: string;
  traceId: string;
  policy: {
    attemptsPerScenario: 1;
    automaticRetries: 0;
    selection: "all-registered";
  };
  inputs?: SuiteInputs;
  selected: readonly string[];
  executed: readonly string[];
  unrun: readonly string[];
  unknown: readonly string[];
  attempts: SuiteAttempt[];
  status: "passed" | "failed" | "blocked" | "cancelled";
  firstFailure?: { scenarioId?: string; message: string };
  failures: string[];
  cleanupComplete: boolean;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  events: LifecycleEvent[];
}
export interface SuiteLease {
  release(): Promise<void>;
  retain?(): void;
}
export interface SuiteDependencies {
  inspect(signal: AbortSignal): Promise<SuiteInputs>;
  acquire(
    signal: AbortSignal,
    owner: { runId: string; traceId: string },
  ): Promise<SuiteLease>;
  execute(options: {
    scenarioId: string;
    runId: string;
    traceId: string;
    directory: string;
    inputs: SuiteInputs;
    signal: AbortSignal;
    lease: SuiteLease;
  }): Promise<SuiteAttempt>;
  write?: typeof writeScenarioReceipt;
}
export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function assertSuiteInputs(value: SuiteInputs): void {
  for (const name of [
    "candidateSha256",
    "appAsarSha256",
    "sourceSha256",
    "definitionsSha256",
  ] as const)
    if (!/^[a-f0-9]{64}$/u.test(value[name]))
      throw new Error(`Invalid suite input: ${name}`);
  if (
    !/^[a-f0-9]{40,64}$/u.test(value.sourceRevision) ||
    typeof value.dirty !== "boolean"
  )
    throw new Error("Missing source provenance");
  if (
    value.selected.length === 0 ||
    value.selected.length > 256 ||
    new Set(value.selected).size !== value.selected.length ||
    value.selected.some((id) => !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(id))
  )
    throw new Error("Suite requires a nonempty unique registered selection");
}
export function sameSuiteInputs(
  expected: SuiteInputs,
  actual: SuiteInputs,
): void {
  assertSuiteInputs(actual);
  if (evidenceHash(expected) !== evidenceHash(actual))
    throw new Error(
      "Candidate, source, registry or fixture inputs changed; qualification is stale",
    );
}

export async function runAcceptanceSuite(
  options: {
    directory: string;
    signal?: AbortSignal;
    selected?: readonly string[];
  },
  dependencies: SuiteDependencies,
): Promise<SuiteReceipt> {
  const signal = options.signal ?? new AbortController().signal;
  const began = Date.now();
  const receipt: SuiteReceipt = {
    schema: "acceptance-suite/v1",
    finalization: "checkpoint",
    runId: randomUUID(),
    traceId: randomUUID(),
    policy: {
      attemptsPerScenario: 1,
      automaticRetries: 0,
      selection: "all-registered",
    },
    selected: options.selected ?? [],
    executed: [],
    unrun: options.selected ?? [],
    unknown: [],
    attempts: [],
    status: "blocked",
    failures: [],
    cleanupComplete: false,
    startedAt: began,
    completedAt: began,
    durationMs: 0,
    events: [],
  };
  const event = (
    stage: string,
    phase: LifecycleEvent["phase"],
    start: number,
    causationId = receipt.runId,
  ) => {
    if (receipt.events.length >= 4096)
      throw new Error("Suite lifecycle evidence capacity exceeded");
    receipt.events.push({
      schemaVersion: 1,
      runId: receipt.runId,
      traceId: receipt.traceId,
      correlationId: receipt.runId,
      causationId,
      stage,
      phase,
      timestamp: Date.now(),
      durationMs: Math.max(0, Date.now() - start),
    });
  };
  const stage = async <T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const start = Date.now();
    event(name, "queued", start);
    event(name, "started", start);
    try {
      const result = await operation();
      event(name, "completed", start);
      return result;
    } catch (error) {
      event(name, signal.aborted ? "cancelled" : "failed", start);
      throw error;
    }
  };
  const update = () => {
    receipt.executed = receipt.attempts
      .filter((attempt) => attempt.executed)
      .map((attempt) => attempt.scenarioId);
    receipt.unknown = receipt.attempts
      .filter((attempt) => attempt.executed === null)
      .map((attempt) => attempt.scenarioId);
    receipt.unrun = receipt.selected.filter(
      (id) => !receipt.executed.includes(id) && !receipt.unknown.includes(id),
    );
    receipt.completedAt = Date.now();
    receipt.durationMs = Math.max(0, receipt.completedAt - receipt.startedAt);
  };
  const persist = async (name: string) => {
    update();
    const sanitized = JSON.parse(serializeScenarioReceipt(receipt)) as unknown;
    if (evidenceHash(sanitized) !== evidenceHash(receipt))
      throw new Error(
        "Suite evidence lost structure or content during sanitation",
      );
    await (dependencies.write ?? writeScenarioReceipt)(
      join(options.directory, name),
      receipt,
    );
    const stored = await readAcceptanceJson(
      join(options.directory, name),
      64 * 1024 * 1024,
    );
    if (evidenceHash(stored) !== evidenceHash(sanitized))
      throw new Error("Suite receipt durable readback mismatch");
  };
  const fail = (error: unknown, scenarioId?: string) => {
    const message = describeScenarioError(error);
    receipt.firstFailure ??= { ...(scenarioId ? { scenarioId } : {}), message };
    receipt.failures.push(message);
  };
  let lease: SuiteLease | undefined;
  let safeToRelease = true;
  let acquisitionUncertain = false;
  try {
    await stage("suite.checkpoint", () => persist("suite.checkpoint.json"));
    signal.throwIfAborted();
    acquisitionUncertain = true;
    lease = await stage("suite.host-lease", () =>
      dependencies.acquire(signal, {
        runId: receipt.runId,
        traceId: receipt.traceId,
      }),
    );
    acquisitionUncertain = false;
    receipt.inputs = await stage("suite.admission", () =>
      dependencies.inspect(signal),
    );
    receipt.selected = receipt.inputs.selected;
    assertSuiteInputs(receipt.inputs);
    if (receipt.inputs.dirty)
      throw new Error(
        "Qualification requires a clean committed source checkout",
      );
    await stage("suite.checkpoint", () => persist("suite.checkpoint.json"));
    for (const [index, scenarioId] of receipt.selected.entries()) {
      signal.throwIfAborted();
      await stage("suite.verify-inputs", async () =>
        sameSuiteInputs(receipt.inputs!, await dependencies.inspect(signal)),
      );
      const runId = randomUUID();
      const start = Date.now();
      event("suite.case", "queued", start, runId);
      event("suite.case", "started", start, runId);
      // An exception may mean acquisition or cleanup never reached a terminal receipt.
      safeToRelease = false;
      let attempt: SuiteAttempt;
      try {
        attempt = await dependencies.execute({
          scenarioId,
          runId,
          traceId: receipt.traceId,
          directory: join(options.directory, `case-${index + 1}`),
          inputs: receipt.inputs,
          signal,
          lease,
        });
      } catch (error) {
        receipt.attempts.push({
          scenarioId,
          runId,
          status: "finalization-failed",
          executed: null,
          cleanupComplete: false,
          persisted: false,
          receiptPath: `case-${index + 1}/receipt.json`,
          receiptSha256: "",
          assertions: [],
          failure: describeScenarioError(error),
        });
        event(
          "suite.case",
          signal.aborted ? "cancelled" : "failed",
          start,
          runId,
        );
        throw error;
      }
      if (attempt.scenarioId !== scenarioId || attempt.runId !== runId)
        throw new Error("Case returned foreign execution identity");
      receipt.attempts.push(attempt);
      safeToRelease = attempt.cleanupComplete;
      event(
        "suite.case",
        attempt.status === "passed"
          ? "completed"
          : attempt.status === "cancelled"
            ? "cancelled"
            : "failed",
        start,
        runId,
      );
      if (
        attempt.status !== "passed" ||
        !attempt.executed ||
        !attempt.cleanupComplete ||
        !attempt.persisted
      )
        fail(
          attempt.failure ?? `Scenario ${scenarioId}: ${attempt.status}`,
          scenarioId,
        );
      event("suite.execution", "progress", began, runId);
      await stage("suite.checkpoint", () => persist("suite.checkpoint.json"));
      if (!attempt.cleanupComplete || !attempt.persisted)
        throw new Error(
          "Unsafe cleanup or incomplete evidence; remaining tests were not launched",
        );
      signal.throwIfAborted();
      await stage("suite.verify-inputs", async () =>
        sameSuiteInputs(receipt.inputs!, await dependencies.inspect(signal)),
      );
    }
  } catch (error) {
    fail(error);
  } finally {
    if (lease && safeToRelease) {
      try {
        await stage("suite.host-release", () => lease!.release());
        receipt.cleanupComplete = true;
      } catch (error) {
        fail(error);
      }
    } else if (!lease) receipt.cleanupComplete = !acquisitionUncertain;
    else lease.retain?.();
  }
  update();
  receipt.status = signal.aborted
    ? "cancelled"
    : receipt.selected.length > 0 &&
        receipt.attempts.length === receipt.selected.length &&
        receipt.unrun.length === 0 &&
        receipt.unknown.length === 0 &&
        receipt.failures.length === 0 &&
        receipt.cleanupComplete &&
        receipt.attempts.every(
          (attempt) =>
            attempt.status === "passed" &&
            attempt.persisted &&
            attempt.assertions.every((assertion) => assertion.passed),
        )
      ? "passed"
      : receipt.executed.length || receipt.unknown.length
        ? "failed"
        : "blocked";
  receipt.finalization = "final";
  await stage("suite.finalization", () => persist("suite.json"));
  if (signal.aborted && receipt.status !== "cancelled") {
    // Revoke the provisional success before another write can fail.
    await rm(join(options.directory, "suite.json"), { force: true });
    receipt.status = "cancelled";
    fail(new Error("Acceptance suite cancelled during receipt finalization"));
    await stage("suite.cancellation-finalization", () => persist("suite.json"));
  }
  return receipt;
}
