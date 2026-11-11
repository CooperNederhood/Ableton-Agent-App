import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AUDIO_OMITTED_VALUE,
  BINARY_OMITTED_VALUE,
  REDACTED_VALUE,
  sanitizePersistedText,
  sanitizeTelemetryAttributes,
} from "@ableton-agent/observability";
import { createDefaultAssertions } from "./assertions.js";
import type { AgentListeningEvidence } from "./agent-listening-result.js";
import {
  validateFixtureSourceEvidence,
  validateMidiSourcePreconditions,
} from "./sources.js";
import {
  dependencyInventoryHashes,
  verifyDependencyInventory,
  verifyStagedFixture,
  verifyStagedMedia,
} from "./staging.js";
import type { AssertionRegistry } from "./assertions.js";
import type {
  AcceptanceDriver,
  AssertionResult,
  BaselineEvidence,
  DependencyInventory,
  DriverContext,
  FixtureManifest,
  LifecycleEvent,
  RunEvidence,
  RunFailure,
  RunResult,
  RunStatus,
  ScenarioManifest,
  SessionIdentity,
  StagedFixture,
  Submission,
  TurnEvidence,
  TurnSubscription,
  SetupEvidence,
} from "./contracts.js";
import {
  identifier,
  immutableCopy,
  requireCondition,
  validateBaseline,
  validateAssertionResult,
  validateDependencyInventory,
  validateDriver,
  validateEvidence,
  validateIdentity,
  validateResult,
  validateScenario,
  validateSubmission,
  validateTurn,
} from "./validation.js";

export interface RunAcceptanceOptions {
  readonly scenario: ScenarioManifest;
  readonly fixture: FixtureManifest;
  readonly driver: AcceptanceDriver;
  readonly registry?: AssertionRegistry;
  readonly runId?: string;
  readonly traceId?: string;
  readonly signal?: AbortSignal;
  readonly stage: (context: DriverContext) => Promise<StagedFixture>;
  /** Required for declared dependencies; provision only supported candidate resources/configuration. */
  readonly provision?: (context: DriverContext) => Promise<DependencyInventory>;
  /** Adapt to the existing receipt owner; resolve only after durable finalization. */
  readonly persist: (
    candidate: RunResult,
    context: DriverContext,
  ) => Promise<void>;
  readonly event?: (event: LifecycleEvent) => void;
}
class DeadlineError extends Error {}
function failure(stage: string, error: unknown): RunFailure {
  return {
    stage,
    message:
      sanitizePersistedText(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 8192) || "Unspecified failure",
  };
}
function sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.appSessionId === right.appSessionId &&
    left.conversationId === right.conversationId &&
    left.agentId === right.agentId
  );
}
function assertSanitizedStructure(original: unknown, sanitized: unknown): void {
  if (
    [REDACTED_VALUE, AUDIO_OMITTED_VALUE, BINARY_OMITTED_VALUE].some(
      (marker) => sanitized === marker,
    )
  )
    return;
  if (typeof original === "string") {
    requireCondition(
      original.length <= 262_144 &&
        sanitized === sanitizePersistedText(original),
      "Evidence sanitization truncated text",
    );
    return;
  }
  if (original === null || typeof original !== "object") {
    requireCondition(
      original === sanitized,
      "Evidence sanitization changed a scalar",
    );
    return;
  }
  if (Array.isArray(original)) {
    requireCondition(
      Array.isArray(sanitized) && sanitized.length === original.length,
      "Evidence sanitization truncated an array",
    );
    original.forEach((value, index) =>
      assertSanitizedStructure(value, sanitized[index]),
    );
    return;
  }
  requireCondition(
    sanitized !== null &&
      typeof sanitized === "object" &&
      !Array.isArray(sanitized),
    "Evidence sanitization removed structured evidence",
  );
  const expected = Object.keys(original);
  const actual = Object.keys(sanitized);
  requireCondition(
    expected.length === actual.length &&
      expected.every((key) => Object.hasOwn(sanitized, key)),
    "Evidence sanitization removed or renamed fields",
  );
  for (const key of expected)
    assertSanitizedStructure(
      (original as Record<string, unknown>)[key],
      (sanitized as Record<string, unknown>)[key],
    );
}
function safeCopy<T extends object>(
  value: T,
  validate: (value: unknown) => asserts value is T,
  budget = 524_288,
  sanitize: (value: T) => Record<string, unknown> = (input) =>
    sanitizeTelemetryAttributes(input as Record<string, unknown>),
): T {
  const sanitized = sanitize(value);
  assertSanitizedStructure(value, sanitized);
  requireCondition(
    Buffer.byteLength(JSON.stringify(sanitized)) <= budget,
    "Evidence exceeds report budget",
  );
  validate(sanitized);
  return immutableCopy(sanitized);
}
// Apply payload limits at typed record boundaries, not at receipt-wrapper depth.
// The complete assembled evidence still passes structural, schema and byte guards.
function sanitizeAgentListening(value: AgentListeningEvidence) {
  const { records, ...metadata } = value;
  return {
    ...sanitizeTelemetryAttributes(metadata),
    records: records.map((record) => sanitizeTelemetryAttributes(record)),
  };
}
function sanitizeTurn(value: TurnEvidence) {
  const { agentListening, ...body } = value;
  return {
    ...sanitizeTelemetryAttributes(body),
    ...(agentListening
      ? { agentListening: sanitizeAgentListening(agentListening) }
      : {}),
  };
}
function sanitizeRunEvidence(value: RunEvidence) {
  const { agentListening, ...body } = value;
  return {
    ...sanitizeTelemetryAttributes(body),
    ...(agentListening
      ? { agentListening: agentListening.map(sanitizeAgentListening) }
      : {}),
  };
}
function sanitizeResult(value: RunResult) {
  const { turns, evidence, ...body } = value;
  return {
    ...sanitizeTelemetryAttributes(body),
    turns: turns.map(sanitizeTurn),
    ...(evidence ? { evidence: sanitizeRunEvidence(evidence) } : {}),
  };
}
function instrumentTreeBytes(baseline?: BaselineEvidence): number {
  let bytes = 0;
  for (const source of Object.values(baseline?.sources ?? {})) {
    if (!("midi" in source)) continue;
    for (const inventory of [
      source.midi.instrumentChain.before,
      source.midi.instrumentChain.after,
    ])
      if (inventory.instrumentTree)
        bytes += Buffer.byteLength(JSON.stringify(inventory.instrumentTree));
  }
  requireCondition(
    bytes <= 4 * 1024 * 1024,
    "Instrument tree evidence exceeds report budget",
  );
  return bytes;
}
export async function runAcceptance(
  options: RunAcceptanceOptions,
): Promise<RunResult> {
  const registry = options.registry ?? createDefaultAssertions();
  // Admission has no side effects; invalid definitions never create a run or launch a driver.
  validateDriver(options.driver);
  validateScenario(
    options.scenario,
    options.fixture,
    registry.names,
    options.driver.capabilities,
  );
  requireCondition(
    !options.scenario.steps.some((step) => step.setupActions?.length) ||
      typeof options.driver.setup === "function",
    "Declared setup actions require a setup-capable driver",
  );
  requireCondition(
    options.fixture.dependencies.length === 0 || options.provision,
    "Declared dependencies require explicit candidate provisioning",
  );
  for (const reference of [
    ...options.scenario.assertions,
    ...options.scenario.steps.flatMap((step) => step.assertions),
  ])
    registry.validate(reference);
  const scenario = immutableCopy(options.scenario);
  const fixture = immutableCopy(options.fixture);
  const runId = options.runId ?? randomUUID();
  const traceId = options.traceId ?? randomUUID();
  identifier(runId);
  identifier(traceId);
  const startedAt = Date.now();
  const runDeadline = startedAt + scenario.budget.runMs;
  const executed: string[] = [];
  const turns: TurnEvidence[] = [];
  const setupActions: SetupEvidence[] = [];
  const assertions: AssertionResult[] = [];
  const finalizationFailures: RunFailure[] = [];
  const pendingOwnership = new Set<Promise<unknown>>();
  let stagedFixture: StagedFixture | undefined;
  let dependencyInventory: DependencyInventory | undefined;
  let identity: SessionIdentity | undefined;
  let baseline: BaselineEvidence | undefined;
  let evidence: RunEvidence | undefined;
  let subscription: TurnSubscription | undefined;
  let primaryFailure: RunFailure | undefined;
  let status: RunStatus = "passed";
  let cleanupComplete = false;
  let currentStage = "stage";
  const ensureReportBudget = (
    replacement: Partial<
      Pick<
        RunResult,
        "baseline" | "dependencyInventory" | "turns" | "assertions" | "evidence"
      >
    >,
  ) => {
    requireCondition(
      Buffer.byteLength(
        JSON.stringify({
          baseline,
          dependencyInventory,
          turns,
          assertions,
          evidence,
          ...replacement,
        }),
      ) <=
        1_500_000 + instrumentTreeBytes(replacement.baseline ?? baseline),
      "Combined evidence exceeds report budget",
    );
  };
  const context = (
    signal: AbortSignal,
    deadlineAt: number,
    causationId: string,
  ): DriverContext => ({
    runId,
    traceId,
    correlationId: runId,
    causationId,
    signal,
    deadlineAt,
    scenario,
    fixture,
    ...(stagedFixture ? { stagedFixture } : {}),
    ...(dependencyInventory ? { dependencyInventory } : {}),
    ...(identity ? { identity } : {}),
  });
  const emit = (
    stage: string,
    phase: LifecycleEvent["phase"],
    began: number,
    causationId: string,
  ) => {
    options.event?.({
      schemaVersion: 1,
      runId,
      traceId,
      correlationId: runId,
      causationId,
      stage,
      phase,
      timestamp: Date.now(),
      durationMs: Math.max(0, Date.now() - began),
    });
  };
  async function bounded<T>(
    stage: string,
    deadline: number,
    action: (ctx: DriverContext) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    currentStage = stage;
    const began = Date.now();
    const causationId = randomUUID();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation: (reason: unknown) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const onAbort = () => {
      controller.abort(parentSignal?.reason ?? new Error("Run cancelled"));
      rejectCancellation(controller.signal.reason);
    };
    emit(stage, "queued", began, causationId);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (parentSignal?.aborted) onAbort();
      if (deadline <= Date.now()) {
        controller.abort(new DeadlineError(`Deadline exceeded: ${stage}`));
        throw controller.signal.reason;
      }
      controller.signal.throwIfAborted();
      timer = setTimeout(
        () => {
          const error = new DeadlineError(`Deadline exceeded: ${stage}`);
          controller.abort(error);
          rejectCancellation(error);
        },
        Math.max(1, deadline - Date.now()),
      );
      emit(stage, "started", began, causationId);
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return action(context(controller.signal, deadline, causationId));
      });
      if (
        ["stage", "provision", "launch", "subscribe", "collect"].includes(stage)
      ) {
        pendingOwnership.add(operation);
        const settled = () => {
          pendingOwnership.delete(operation);
        };
        void operation.then(settled, settled);
      }
      const value = await Promise.race([operation, cancelled]);
      controller.signal.throwIfAborted();
      emit(stage, "completed", began, causationId);
      return value;
    } catch (error) {
      emit(
        stage,
        parentSignal?.aborted ? "cancelled" : "failed",
        began,
        causationId,
      );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
      void cancelled.catch(() => {});
    }
  }
  try {
    emit("run", "queued", startedAt, runId);
    emit("run", "started", startedAt, runId);
    stagedFixture = await bounded(
      "stage",
      runDeadline,
      async (ctx) => {
        const staged = await options.stage(ctx);
        requireCondition(
          staged.projectPath &&
            staged.workingDirectory &&
            typeof staged.verifySourceUnchanged === "function",
          "Invalid staged fixture",
        );
        stagedFixture = staged;
        return staged;
      },
      options.signal,
    );
    if (options.provision) {
      dependencyInventory = await bounded(
        "provision",
        runDeadline,
        async (ctx) => {
          const inventory = await options.provision!(ctx);
          await verifyDependencyInventory(
            stagedFixture!,
            fixture,
            inventory,
            ctx.signal,
          );
          const retained = safeCopy(inventory, validateDependencyInventory);
          ensureReportBudget({ dependencyInventory: retained });
          return retained;
        },
        options.signal,
      );
    }
    await bounded(
      "fixture-admission",
      runDeadline,
      (ctx) => verifyStagedFixture(stagedFixture!, fixture, ctx.signal),
      options.signal,
    );
    await bounded(
      "launch",
      runDeadline,
      (ctx) => options.driver.launch(ctx),
      options.signal,
    );
    identity = await bounded(
      "readiness",
      runDeadline,
      async (ctx) => {
        const ready = await options.driver.ready(ctx);
        validateIdentity(ready);
        return immutableCopy(ready);
      },
      options.signal,
    );
    subscription = await bounded(
      "subscribe",
      runDeadline,
      async (ctx) => {
        const observed = await options.driver.subscribe(ctx);
        requireCondition(
          observed &&
            typeof observed.waitForTurn === "function" &&
            typeof observed.close === "function",
          "Invalid event subscription",
        );
        subscription = observed;
        return observed;
      },
      options.signal,
    );
    baseline = await bounded(
      "preconditions",
      runDeadline,
      async (ctx) => {
        const read = await options.driver.readBaseline(ctx);
        validateBaseline(read);
        const admitted = safeCopy(
          read,
          validateBaseline,
          524_288 + instrumentTreeBytes(read),
        );
        ensureReportBudget({ baseline: admitted });
        baseline = admitted;
        for (const source of Object.values(baseline.sources ?? {})) {
          if (!("loadedMediaPath" in source)) continue;
          await verifyStagedMedia(
            stagedFixture!,
            source.loadedMediaPath,
            source.source.mediaSha256,
            ctx.signal,
          );
        }
        requireCondition(
          (fixture.sources ?? []).every((source) =>
            Object.hasOwn(admitted.sources ?? {}, source.id),
          ) &&
            Object.keys(baseline.sources ?? {}).length ===
              (fixture.sources?.length ?? 0),
          "Observed source inventory differs from fixture",
        );
        for (const definition of fixture.sources ?? []) {
          const observed = admitted.sources![definition.id]!;
          validateFixtureSourceEvidence(fixture, definition, observed);
          validateMidiSourcePreconditions(fixture, observed);
          if ("mediaTarget" in definition && "loadedMediaPath" in observed)
            requireCondition(
              resolve(observed.loadedMediaPath) ===
                resolve(
                  stagedFixture!.workingDirectory,
                  definition.mediaTarget,
                ),
              "Observed media path differs from source declaration",
            );
        }
        for (const [key, expected] of Object.entries(fixture.baseline))
          requireCondition(
            Object.hasOwn(baseline.facts, key) &&
              baseline.facts[key] ===
                (key === "clipLaunchQuantization"
                  ? (fixture.sources?.[0]?.clipLaunchQuantization ?? expected)
                  : expected),
            `Blocked precondition: ${key}`,
          );
        const bundleHashes: Readonly<Record<string, string>> =
          dependencyInventory
            ? dependencyInventoryHashes(dependencyInventory)
            : {};
        for (const dependency of fixture.dependencies)
          requireCondition(
            Object.hasOwn(baseline.dependencyHashes, dependency) &&
              baseline.dependencyHashes[dependency] ===
                bundleHashes[dependency],
            `Missing production dependency: ${dependency}`,
          );
        return baseline;
      },
      options.signal,
    );
    const messages = new Set<string>();
    const operations = new Set<string>();
    const assistants = new Set<string>();
    for (const step of scenario.steps) {
      const deadline = Math.min(runDeadline, Date.now() + step.timeoutMs);
      for (const action of step.setupActions ?? []) {
        await bounded(
          `setup.${step.id}.${action}`,
          deadline,
          async (ctx) => {
            const observed = await options.driver.setup!(action, step, ctx);
            validateEvidence({
              schemaVersion: 1,
              facts: {},
              contexts: [],
              unchanged: [],
              setupActions: [observed],
            });
            requireCondition(
              observed.completed === true &&
                observed.action === action &&
                observed.stepId === step.id &&
                observed.traceId === ctx.traceId &&
                observed.correlationId === ctx.correlationId &&
                observed.causationId === ctx.causationId &&
                sameIdentity(identity!, observed),
              "Setup action evidence does not match its declared ownership",
            );
            setupActions.push(immutableCopy(observed));
          },
          options.signal,
        );
      }
      const submission: Submission = await bounded(
        `submit.${step.id}`,
        deadline,
        async (ctx) => {
          executed.push(step.id);
          const accepted = await options.driver.submit(step, ctx);
          validateSubmission(accepted);
          requireCondition(
            sameIdentity(identity!, accepted),
            "Submission belongs to another session, conversation or agent",
          );
          requireCondition(
            !messages.has(accepted.userMessageId) &&
              !operations.has(accepted.operationId),
            "Duplicate submission identity",
          );
          messages.add(accepted.userMessageId);
          operations.add(accepted.operationId);
          return immutableCopy(accepted);
        },
        options.signal,
      );
      const turn = await bounded(
        `turn.${step.id}`,
        deadline,
        async (ctx) => {
          const observed = await subscription!.waitForTurn(submission, ctx);
          validateTurn(observed);
          requireCondition(
            sameIdentity(identity!, observed) &&
              observed.userMessageId === submission.userMessageId &&
              observed.operationId === submission.operationId &&
              !assistants.has(observed.assistantMessageId),
            "Turn attribution mismatch",
          );
          assistants.add(observed.assistantMessageId);
          const retained = safeCopy(
            observed,
            validateTurn,
            524_288,
            sanitizeTurn,
          );
          requireCondition(
            Buffer.byteLength(JSON.stringify([...turns, retained])) <= 524_288,
            "Turn history exceeds report budget",
          );
          ensureReportBudget({ turns: [...turns, retained] });
          turns.push(retained);
          requireCondition(
            retained.status === (step.expectedStatus ?? "completed"),
            `Turn terminal status: ${retained.status}`,
          );
          return retained;
        },
        options.signal,
      );
      if (turn.status === "refused") status = "expected-refusal";
      for (const reference of step.assertions) {
        await bounded(
          `assert.${step.id}.${reference.name}`,
          deadline,
          async () => {
            const checked = registry.evaluate(reference, {
              fixture,
              baseline: baseline!,
              turn,
              turns,
            });
            requireCondition(
              Buffer.byteLength(JSON.stringify([...assertions, checked])) <=
                131_072,
              "Assertion history exceeds report budget",
            );
            const retained = safeCopy(checked, validateAssertionResult);
            ensureReportBudget({ assertions: [...assertions, retained] });
            assertions.push(retained);
            requireCondition(
              checked.passed,
              `Assertion ${checked.name}: ${checked.code}`,
            );
          },
          options.signal,
        );
      }
      emit("run", "progress", startedAt, submission.operationId);
    }
    evidence = await bounded(
      "collect",
      runDeadline,
      async (ctx) => {
        const collected = {
          ...(await options.driver.collect(ctx)),
          ...(setupActions.length ? { setupActions } : {}),
        };
        validateEvidence(collected);
        const retained = safeCopy(
          collected,
          validateEvidence,
          524_288,
          sanitizeRunEvidence,
        );
        ensureReportBudget({ evidence: retained });
        return retained;
      },
      options.signal,
    );
    if (evidence.recoveries?.length) status = "recovered";
    for (const reference of scenario.assertions) {
      await bounded(
        `assert.run.${reference.name}`,
        runDeadline,
        async () => {
          const checked = registry.evaluate(reference, {
            fixture,
            baseline: baseline!,
            turns,
            evidence: evidence!,
          });
          requireCondition(
            Buffer.byteLength(JSON.stringify([...assertions, checked])) <=
              131_072,
            "Assertion history exceeds report budget",
          );
          const retained = safeCopy(checked, validateAssertionResult);
          ensureReportBudget({ assertions: [...assertions, retained] });
          assertions.push(retained);
          requireCondition(
            checked.passed,
            `Assertion ${checked.name}: ${checked.code}`,
          );
        },
        options.signal,
      );
    }
  } catch (error) {
    primaryFailure = failure(currentStage, error);
    status = options.signal?.aborted
      ? "cancelled"
      : currentStage === "preconditions"
        ? "blocked"
        : "failed";
  }
  // Cancellation cannot revoke a noncooperative acquisition promise. Wait for it before
  // shutdown; if it exceeds the cleanup budget, retain failure and defer owned shutdown.
  let ownershipSettled = true;
  if (pendingOwnership.size > 0) {
    try {
      await bounded(
        "quiescence",
        Date.now() + scenario.budget.cleanupMs,
        async () => {
          await Promise.allSettled([...pendingOwnership]);
        },
      );
    } catch (error) {
      ownershipSettled = false;
      finalizationFailures.push(failure("quiescence", error));
    }
  }
  // Cleanup receives a fresh cancellation scope, never an already-aborted run signal.
  const cleanupActions = [
    [
      "unsubscribe",
      async (ctx: DriverContext) => {
        await subscription?.close(ctx);
      },
    ],
    ["cleanup", (ctx: DriverContext) => options.driver.cleanup(ctx)],
    [
      "source-integrity",
      async () => {
        await stagedFixture?.verifySourceUnchanged();
      },
    ],
    [
      "dependency-integrity",
      async (ctx: DriverContext) => {
        if (stagedFixture && dependencyInventory)
          await verifyDependencyInventory(
            stagedFixture,
            fixture,
            dependencyInventory,
            ctx.signal,
          );
      },
    ],
  ] as const;
  const cleanupOwned = async (prefix = "") => {
    for (const [stage, action] of cleanupActions) {
      try {
        await bounded(
          `${prefix}${stage}`,
          Date.now() + scenario.budget.cleanupMs,
          action,
        );
      } catch (error) {
        finalizationFailures.push(failure(`${prefix}${stage}`, error));
      }
    }
  };
  if (ownershipSettled) {
    await cleanupOwned();
  } else {
    finalizationFailures.push({
      stage: "cleanup",
      message:
        "Owned shutdown deferred until noncooperative resource acquisition settles; cleanup is incomplete",
    });
    // The failed receipt remains conservative. Later completion is observable but cannot
    // retroactively turn this run into a pass or introduce a second receipt writer.
    void Promise.allSettled([...pendingOwnership]).then(() =>
      cleanupOwned("late."),
    );
  }
  cleanupComplete = ownershipSettled && finalizationFailures.length === 0;
  if (!cleanupComplete && !primaryFailure) status = "finalization-failed";
  const makeResult = (persisted: boolean): RunResult => {
    const result: RunResult = safeCopy(
      {
        schemaVersion: 1,
        runId,
        traceId,
        scenarioId: scenario.id,
        fixtureId: fixture.id,
        status,
        startedAt,
        completedAt: Date.now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        selected: scenario.steps.map((step) => step.id),
        executed,
        unrun: scenario.steps
          .filter((step) => !executed.includes(step.id))
          .map((step) => step.id),
        assertions,
        turns,
        ...(baseline ? { baseline } : {}),
        ...(dependencyInventory ? { dependencyInventory } : {}),
        ...(evidence ? { evidence } : {}),
        ...(primaryFailure ? { primaryFailure } : {}),
        finalizationFailures,
        cleanupComplete,
        persisted,
      },
      validateResult,
      1_900_000 + instrumentTreeBytes(baseline),
      sanitizeResult,
    );
    validateResult(result);
    return result;
  };
  try {
    await bounded(
      "persistence",
      Date.now() + scenario.budget.persistenceMs,
      (ctx) => options.persist(makeResult(true), ctx),
    );
  } catch (error) {
    finalizationFailures.push(failure("persistence", error));
    if (!primaryFailure) status = "finalization-failed";
    emit(
      "run",
      status === "cancelled" ? "cancelled" : "failed",
      startedAt,
      runId,
    );
    return makeResult(false);
  }
  emit(
    "run",
    status === "passed" ||
      status === "expected-refusal" ||
      status === "recovered"
      ? "completed"
      : status === "cancelled"
        ? "cancelled"
        : "failed",
    startedAt,
    runId,
  );
  return makeResult(true);
}
