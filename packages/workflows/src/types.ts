import type {
  EntityReference,
  MetadataValue,
} from "@ableton-agent/project-state";

export const workflowLimits = {
  maximumSteps: 128,
  maximumMutations: 512,
  maximumDurationMs: 300_000,
  maximumMidiNotes: 2048,
} as const;

export interface MidiNote {
  readonly pitch: number;
  readonly startTime: number;
  readonly duration: number;
  readonly velocity: number;
  readonly mute: boolean;
}

export type Reversibility =
  | {
      readonly kind: "reversible";
      readonly compensation: string;
    }
  | {
      readonly kind: "non-reversible";
      readonly reason: string;
    };

export interface WorkflowStep<
  Operation extends string = string,
  Payload = unknown,
> {
  readonly id: string;
  readonly operation: Operation;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly mutationCount: number;
  readonly reversibility: Reversibility;
  readonly target?: EntityReference;
  readonly payload: Payload;
  readonly auditData: Readonly<Record<string, MetadataValue>>;
}

export interface WorkflowBudget {
  readonly maxSteps: number;
  readonly maxMutations: number;
  readonly maxDurationMs: number;
}

export interface WorkflowTransaction<Step extends WorkflowStep = WorkflowStep> {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly resource: string;
  readonly intent: string;
  readonly workflow: string;
  readonly budget: WorkflowBudget;
  readonly steps: readonly Step[];
}

export interface ApprovalRequest<Step extends WorkflowStep = WorkflowStep> {
  readonly transaction: WorkflowTransaction<Step>;
  readonly beforeStates: ReadonlyMap<string, unknown>;
}

export type ApprovalDecision =
  | { readonly decision: "approved"; readonly reason?: string }
  | { readonly decision: "denied"; readonly reason: string };

export interface WorkflowRuntime<Step extends WorkflowStep = WorkflowStep> {
  readonly nowMs: () => number;
  captureBefore(step: Step, signal: AbortSignal): Promise<unknown>;
  approve(
    request: ApprovalRequest<Step>,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>;
  execute(
    step: Step,
    beforeState: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  verify(
    step: Step,
    result: unknown,
    beforeState: unknown,
    signal: AbortSignal,
  ): Promise<boolean>;
  compensate(
    step: Step,
    result: unknown,
    beforeState: unknown,
    signal: AbortSignal,
  ): Promise<void>;
  refresh(
    transaction: WorkflowTransaction<Step>,
    affectedSteps: readonly Step[],
    signal: AbortSignal,
  ): Promise<void>;
}

export type WorkflowStepStatus =
  | "skipped"
  | "executed"
  | "verified"
  | "failed"
  | "compensated"
  | "compensation-failed";

export interface WorkflowStepOutcome {
  readonly stepId: string;
  readonly status: WorkflowStepStatus;
  readonly phase?: "capture" | "execution" | "verification" | "compensation";
  readonly message?: string;
}

export type WorkflowOutcomeStatus =
  | "succeeded"
  | "denied"
  | "budget-exceeded"
  | "failed"
  | "compensated"
  | "partially-applied"
  | "compensation-failed";

export interface WorkflowOutcome {
  readonly transactionId: string;
  readonly status: WorkflowOutcomeStatus;
  readonly atomicRollback: false;
  readonly approval?: ApprovalDecision;
  readonly steps: readonly WorkflowStepOutcome[];
  readonly refreshAttempted: boolean;
  readonly refreshError?: string;
  readonly message: string;
}

export interface WorkflowAuditSession<
  Step extends WorkflowStep = WorkflowStep,
> {
  denied(reason: string): Promise<void>;
  completed(step: Step): Promise<void>;
  failed(message: string): Promise<void>;
  verified(summary: string): Promise<void>;
  recovered(summary: string): Promise<void>;
  warning(message: string): Promise<void>;
}

export interface WorkflowAudit<Step extends WorkflowStep = WorkflowStep> {
  prepare(
    transaction: WorkflowTransaction<Step>,
    beforeStates: ReadonlyMap<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkflowAuditSession<Step>>;
}

export class WorkflowValidationError extends Error {
  public override readonly name = "WorkflowValidationError";
}
