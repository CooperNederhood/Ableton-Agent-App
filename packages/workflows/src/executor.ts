import {
  currentCorrelationId,
  withCorrelation,
} from "@ableton-agent/correlation";

import type { MutationLeaseManager } from "./lease.js";
import {
  workflowLimits,
  WorkflowValidationError,
  type ApprovalDecision,
  type WorkflowAudit,
  type WorkflowAuditSession,
  type WorkflowOutcome,
  type WorkflowRuntime,
  type WorkflowStep,
  type WorkflowStepOutcome,
  type WorkflowTransaction,
} from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WorkflowDeadlineError extends Error {
  public constructor(phase: string) {
    super(`Workflow duration budget exceeded during ${phase}`);
    this.name = "WorkflowDeadlineError";
  }
}

const auditTimeoutMs = 1_000;
const entityKinds = new Set([
  "track",
  "return-track",
  "master-track",
  "scene",
  "session-clip",
  "arrangement-clip",
  "device",
  "cue-point",
]);

function payloadProjectIds(value: unknown): string[] {
  const projectIds: string[] = [];
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null) return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const object = candidate as Record<string, unknown>;
    if (
      typeof object.projectId === "string" &&
      typeof object.kind === "string" &&
      entityKinds.has(object.kind) &&
      typeof object.id === "string" &&
      typeof object.revision === "number"
    ) {
      projectIds.push(object.projectId);
    }
    Object.values(object).forEach(visit);
  };
  visit(value);
  return projectIds;
}

function validateTransaction(transaction: WorkflowTransaction): string | null {
  const { budget, steps } = transaction;
  if (
    !Number.isInteger(budget.maxSteps) ||
    budget.maxSteps < 1 ||
    budget.maxSteps > workflowLimits.maximumSteps
  ) {
    throw new WorkflowValidationError("Invalid workflow step budget");
  }
  if (
    !Number.isInteger(budget.maxMutations) ||
    budget.maxMutations < 0 ||
    budget.maxMutations > workflowLimits.maximumMutations
  ) {
    throw new WorkflowValidationError("Invalid workflow mutation budget");
  }
  if (
    !Number.isFinite(budget.maxDurationMs) ||
    budget.maxDurationMs <= 0 ||
    budget.maxDurationMs > workflowLimits.maximumDurationMs
  ) {
    throw new WorkflowValidationError("Invalid workflow duration budget");
  }
  const ids = new Set<string>();
  for (const step of steps) {
    if (step.id.trim() === "" || ids.has(step.id)) {
      throw new WorkflowValidationError("Workflow step ids must be unique");
    }
    if (!Number.isInteger(step.mutationCount) || step.mutationCount < 0) {
      throw new WorkflowValidationError(
        "Step mutation counts must be integers",
      );
    }
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) {
        throw new WorkflowValidationError(
          `Step '${step.id}' has an unordered or missing dependency`,
        );
      }
    }
    if (
      step.target !== undefined &&
      step.target.projectId !== transaction.projectId
    ) {
      throw new WorkflowValidationError(
        `Step '${step.id}' target belongs to a different project`,
      );
    }
    if (
      payloadProjectIds(step.payload).some(
        (projectId) => projectId !== transaction.projectId,
      )
    ) {
      throw new WorkflowValidationError(
        `Step '${step.id}' payload references a different project`,
      );
    }
    ids.add(step.id);
  }
  if (steps.length > budget.maxSteps) return "Workflow step budget exceeded";
  const mutations = steps.reduce(
    (total, step) => total + step.mutationCount,
    0,
  );
  return mutations > budget.maxMutations
    ? "Workflow mutation budget exceeded"
    : null;
}

export class DeterministicWorkflowExecutor<
  Step extends WorkflowStep = WorkflowStep,
> {
  public constructor(
    private readonly leases: MutationLeaseManager,
    private readonly runtime: WorkflowRuntime<Step>,
    private readonly audit?: WorkflowAudit<Step>,
  ) {}

  public async execute(
    transaction: WorkflowTransaction<Step>,
  ): Promise<WorkflowOutcome> {
    return withCorrelation(
      currentCorrelationId() ?? transaction.correlationId,
      () => this.#executeCorrelated(transaction),
    );
  }

  async #executeCorrelated(
    transaction: WorkflowTransaction<Step>,
  ): Promise<WorkflowOutcome> {
    const budgetError = validateTransaction(transaction);
    if (budgetError !== null) {
      return {
        transactionId: transaction.id,
        status: "budget-exceeded",
        atomicRollback: false,
        steps: transaction.steps.map((step) => ({
          stepId: step.id,
          status: "skipped",
          message: budgetError,
        })),
        refreshAttempted: false,
        message: budgetError,
      };
    }

    const lease = await this.leases.acquire(
      transaction.resource,
      transaction.id,
    );
    try {
      return await this.#executeLeased(transaction);
    } finally {
      lease.release();
    }
  }

  async #executeLeased(
    transaction: WorkflowTransaction<Step>,
  ): Promise<WorkflowOutcome> {
    const startedAt = this.runtime.nowMs();
    const beforeStates = new Map<string, unknown>();
    const outcomes = new Map<string, WorkflowStepOutcome>();
    const results = new Map<string, unknown>();
    const attempted: Step[] = [];
    const auditFailures: string[] = [];
    let failureMessage: string | undefined;

    for (const step of transaction.steps) {
      try {
        beforeStates.set(
          step.id,
          await this.#runWithinDeadline(
            transaction,
            startedAt,
            "capture",
            (signal) => this.runtime.captureBefore(step, signal),
          ),
        );
      } catch (error) {
        failureMessage = `Before-state capture failed for '${step.id}': ${errorMessage(error)}`;
        outcomes.set(step.id, {
          stepId: step.id,
          status: "failed",
          phase: "capture",
          message: failureMessage,
        });
        break;
      }
    }

    let audit: WorkflowAuditSession<Step> | undefined;
    try {
      audit =
        this.audit === undefined
          ? undefined
          : await this.#runWithinDeadline(
              transaction,
              startedAt,
              "audit preparation",
              (signal) =>
                this.audit!.prepare(transaction, beforeStates, signal),
            );
    } catch (error) {
      failureMessage = `Audit preparation failed: ${errorMessage(error)}`;
      return this.#finalizeEarly(transaction, outcomes, failureMessage);
    }
    if (failureMessage !== undefined) {
      const recordedFailure = failureMessage;
      await this.#auditSafely(auditFailures, "record workflow failure", () =>
        audit?.failed(recordedFailure),
      );
      return this.#finalizeEarly(transaction, outcomes, failureMessage);
    }

    let approval: ApprovalDecision;
    try {
      approval = await this.#runWithinDeadline(
        transaction,
        startedAt,
        "approval",
        (signal) => this.runtime.approve({ transaction, beforeStates }, signal),
      );
    } catch (error) {
      failureMessage = `Approval failed: ${errorMessage(error)}`;
      await this.#auditSafely(auditFailures, "record approval failure", () =>
        audit?.failed(failureMessage!),
      );
      return this.#finalizeEarly(transaction, outcomes, failureMessage);
    }
    if (approval.decision === "denied") {
      await this.#auditSafely(auditFailures, "record approval denial", () =>
        audit?.denied(approval.reason),
      );
      return {
        transactionId: transaction.id,
        status: "denied",
        atomicRollback: false,
        approval,
        steps: transaction.steps.map((step) => ({
          stepId: step.id,
          status: "skipped",
          message: this.#messageWithAuditFailures(
            approval.reason,
            auditFailures,
          ),
        })),
        refreshAttempted: false,
        message: approval.reason,
      };
    }

    for (const step of transaction.steps) {
      if (outcomes.has(step.id)) continue;
      const failedDependency = step.dependencies.find((dependency) => {
        const status = outcomes.get(dependency)?.status;
        return status !== "verified";
      });
      if (failedDependency !== undefined) {
        outcomes.set(step.id, {
          stepId: step.id,
          status: "skipped",
          message: `Dependency '${failedDependency}' did not verify`,
        });
        continue;
      }
      attempted.push(step);
      try {
        const beforeState = beforeStates.get(step.id);
        const result = await this.#runWithinDeadline(
          transaction,
          startedAt,
          "execution",
          (signal) => this.runtime.execute(step, beforeState, signal),
        );
        results.set(step.id, result);
        outcomes.set(step.id, { stepId: step.id, status: "executed" });
        const auditError = await this.#auditSafely(
          auditFailures,
          `record completed step '${step.id}'`,
          () => audit?.completed(step),
        );
        if (auditError !== undefined) {
          throw new Error(auditError);
        }
        const verified = await this.#runWithinDeadline(
          transaction,
          startedAt,
          "verification",
          (signal) => this.runtime.verify(step, result, beforeState, signal),
        );
        if (!verified) {
          failureMessage ??= `Verification failed for '${step.id}'`;
          outcomes.set(step.id, {
            stepId: step.id,
            status: "failed",
            phase: "verification",
            message: `Verification failed for '${step.id}'`,
          });
          continue;
        }
        outcomes.set(step.id, { stepId: step.id, status: "verified" });
      } catch (error) {
        failureMessage ??= `Execution failed for '${step.id}': ${errorMessage(error)}`;
        outcomes.set(step.id, {
          stepId: step.id,
          status: "failed",
          phase: "execution",
          message: `Execution failed for '${step.id}': ${errorMessage(error)}`,
        });
      }
    }

    if (failureMessage === undefined) {
      const auditError = await this.#auditSafely(
        auditFailures,
        "record workflow verification",
        () => audit?.verified("All workflow steps verified"),
      );
      if (auditError === undefined) {
        return {
          transactionId: transaction.id,
          status: "succeeded",
          atomicRollback: false,
          approval,
          steps: transaction.steps.map((step) => outcomes.get(step.id)!),
          refreshAttempted: false,
          message: "All workflow steps verified",
        };
      }
      failureMessage = auditError;
    }

    await this.#auditSafely(auditFailures, "record workflow failure", () =>
      audit?.failed(failureMessage),
    );
    let compensationFailed = false;
    let nonReversibleApplied = false;
    for (const step of [...attempted].reverse()) {
      if (step.reversibility.kind === "non-reversible") {
        nonReversibleApplied = true;
        const reason = step.reversibility.reason;
        await this.#auditSafely(
          auditFailures,
          `record non-reversible step '${step.id}'`,
          () =>
            audit?.warning(`Step '${step.id}' is non-reversible: ${reason}`),
        );
        continue;
      }
      try {
        await this.#runRecoveryPhase(transaction, "compensation", (signal) =>
          this.runtime.compensate(
            step,
            results.get(step.id),
            beforeStates.get(step.id),
            signal,
          ),
        );
        outcomes.set(step.id, { stepId: step.id, status: "compensated" });
      } catch (error) {
        compensationFailed = true;
        const message = `Compensation failed for '${step.id}': ${errorMessage(error)}`;
        outcomes.set(step.id, {
          stepId: step.id,
          status: "compensation-failed",
          phase: "compensation",
          message,
        });
        await this.#auditSafely(
          auditFailures,
          `record compensation failure for '${step.id}'`,
          () => audit?.warning(message),
        );
      }
    }

    let refreshError: string | undefined;
    try {
      await this.#runRecoveryPhase(transaction, "refresh", (signal) =>
        this.runtime.refresh(transaction, attempted, signal),
      );
    } catch (error) {
      refreshError = errorMessage(error);
      await this.#auditSafely(
        auditFailures,
        "record state refresh failure",
        () => audit?.warning(`State refresh failed: ${refreshError}`),
      );
    }

    const recoveryStatus =
      compensationFailed ||
      refreshError !== undefined ||
      auditFailures.length > 0
        ? "compensation-failed"
        : nonReversibleApplied
          ? "partially-applied"
          : attempted.length > 0
            ? "compensated"
            : "failed";
    if (recoveryStatus === "compensated") {
      await this.#auditSafely(auditFailures, "record workflow recovery", () =>
        audit?.recovered(
          "Compensating operations completed; atomic rollback is not claimed",
        ),
      );
    }
    const status =
      auditFailures.length > 0 ? "compensation-failed" : recoveryStatus;
    return {
      transactionId: transaction.id,
      status,
      atomicRollback: false,
      approval,
      steps: transaction.steps.map(
        (step) =>
          outcomes.get(step.id) ?? {
            stepId: step.id,
            status: "skipped",
            message: "Workflow stopped",
          },
      ),
      refreshAttempted: true,
      ...(refreshError === undefined ? {} : { refreshError }),
      message: this.#messageWithAuditFailures(
        `${failureMessage}; atomic rollback is not claimed`,
        auditFailures,
      ),
    };
  }

  async #runWithinDeadline<T>(
    transaction: WorkflowTransaction<Step>,
    startedAt: number,
    phase: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remaining =
      transaction.budget.maxDurationMs - (this.runtime.nowMs() - startedAt);
    if (remaining <= 0) {
      throw new WorkflowDeadlineError(phase);
    }
    return this.#runAbortable(remaining, phase, operation);
  }

  #runRecoveryPhase<T>(
    transaction: WorkflowTransaction<Step>,
    phase: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.#runAbortable(
      Math.min(transaction.budget.maxDurationMs, 30_000),
      phase,
      operation,
    );
  }

  async #runAbortable<T>(
    timeoutMs: number,
    phase: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new WorkflowDeadlineError(phase));
    }, timeoutMs);
    try {
      const result = await operation(controller.signal);
      if (timedOut) {
        throw new WorkflowDeadlineError(phase);
      }
      return result;
    } catch (error) {
      if (timedOut) {
        throw new WorkflowDeadlineError(phase);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #auditSafely(
    failures: string[],
    action: string,
    operation: () => Promise<void> | undefined,
  ): Promise<string | undefined> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const auditOperation = operation();
      if (auditOperation !== undefined) {
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("audit persistence timed out")),
            auditTimeoutMs,
          );
        });
        await Promise.race([auditOperation, deadline]);
      }
      return undefined;
    } catch (error) {
      const message = `Audit failed to ${action}: ${errorMessage(error)}`;
      failures.push(message);
      return message;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  #messageWithAuditFailures(message: string, failures: string[]): string {
    return failures.length === 0
      ? message
      : `${message}; ${failures.join("; ")}`;
  }

  #finalizeEarly(
    transaction: WorkflowTransaction<Step>,
    outcomes: ReadonlyMap<string, WorkflowStepOutcome>,
    message: string,
  ): WorkflowOutcome {
    return {
      transactionId: transaction.id,
      status: "failed",
      atomicRollback: false,
      steps: transaction.steps.map(
        (step) =>
          outcomes.get(step.id) ?? {
            stepId: step.id,
            status: "skipped",
            message: "Workflow stopped before approval",
          },
      ),
      refreshAttempted: false,
      message,
    };
  }
}
