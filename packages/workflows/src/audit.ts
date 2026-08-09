import type {
  ChangeSetService,
  MutationRecord,
} from "@ableton-agent/project-state";

import type {
  WorkflowAudit,
  WorkflowAuditSession,
  WorkflowStep,
  WorkflowTransaction,
} from "./types.js";

export interface WorkflowAuditRuntime {
  readonly createId: () => string;
  readonly now: () => string;
}

export class ProjectStateWorkflowAudit<
  Step extends WorkflowStep = WorkflowStep,
> implements WorkflowAudit<Step> {
  public constructor(
    private readonly changeSets: ChangeSetService,
    private readonly runtime: WorkflowAuditRuntime,
  ) {}

  public async prepare(
    transaction: WorkflowTransaction<Step>,
    beforeStates: ReadonlyMap<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkflowAuditSession<Step>> {
    signal.throwIfAborted();
    const recordsByStep = new Map<string, readonly MutationRecord[]>();
    const records = transaction.steps
      .filter((step) => step.mutationCount > 0)
      .flatMap((step) => {
        const stepRecords = Array.from(
          { length: step.mutationCount },
          (_, index) => this.#createRecord(step, index),
        );
        recordsByStep.set(step.id, stepRecords);
        return stepRecords;
      });
    const changeSet = await this.changeSets.create({
      projectId: transaction.projectId,
      sessionId: transaction.sessionId,
      correlationId: transaction.correlationId,
      userIntent: transaction.intent,
      workflow: transaction.workflow,
      targets: transaction.steps.flatMap((step) =>
        step.target === undefined ? [] : [step.target],
      ),
      beforeState: { capturedStepCount: beforeStates.size },
      requestedMutations: records,
    });
    signal.throwIfAborted();
    await this.changeSets.begin(changeSet.id);
    signal.throwIfAborted();
    const recordsFor = (step: Step): readonly MutationRecord[] => {
      const stepRecords = recordsByStep.get(step.id);
      if (stepRecords === undefined) {
        throw new Error(`No audit record exists for step '${step.id}'`);
      }
      return stepRecords;
    };
    return {
      denied: (reason) =>
        this.changeSets
          .fail(changeSet.id, `Approval denied: ${reason}`)
          .then(() => undefined),
      completed: (step) => {
        if (step.mutationCount === 0) return Promise.resolve();
        return recordsFor(step).reduce<Promise<void>>(
          (pending, record) =>
            pending.then(() =>
              this.changeSets
                .recordCompletedMutation(changeSet.id, record)
                .then(() => undefined),
            ),
          Promise.resolve(),
        );
      },
      failed: (message) =>
        this.changeSets.fail(changeSet.id, message).then(() => undefined),
      verified: (summary) =>
        this.changeSets.verify(changeSet.id, summary).then(() => undefined),
      recovered: (summary) =>
        this.changeSets.recover(changeSet.id, summary).then(() => undefined),
      warning: (message) =>
        this.changeSets.addWarning(changeSet.id, message).then(() => undefined),
    };
  }

  #createRecord(step: Step, mutationIndex: number): MutationRecord {
    const target = step.target;
    return {
      id: this.runtime.createId(),
      operation: step.operation,
      ...(target === undefined ? {} : { target }),
      data: {
        ...step.auditData,
        ...(step.mutationCount > 1 ? { mutationIndex } : {}),
      },
      recordedAt: this.runtime.now(),
    };
  }
}
