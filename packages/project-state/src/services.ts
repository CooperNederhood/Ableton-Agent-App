import {
  approvalDecisionSchema,
  changeSetSchema,
  productionPlanSchema,
  type AppSession,
  type ChangeSet,
  type EntityReference,
  type MetadataValue,
  type MutationRecord,
  type ProductionPlan,
  type ProductionPlanStatus,
  type ProjectIdentity,
} from "./schemas.js";
import type {
  ProjectStateRepositories,
  ProjectStateStore,
} from "./repository.js";
import { SnapshotCache, type EntitySummary } from "./snapshot.js";

export interface ServiceRuntime {
  readonly createId: () => string;
  readonly now: () => string;
}

export interface CreatePlanInput {
  readonly projectId: string;
  readonly goal: string;
  readonly tempo?: number;
  readonly key?: string;
  readonly sections?: ProductionPlan["sections"];
  readonly trackRoles?: ProductionPlan["trackRoles"];
  readonly constraints?: readonly string[];
}

export interface UpdatePlanInput {
  readonly goal?: string;
  readonly tempo?: number | null;
  readonly key?: string | null;
  readonly sections?: ProductionPlan["sections"];
  readonly trackRoles?: ProductionPlan["trackRoles"];
  readonly constraints?: readonly string[];
}

const planTransitions: Readonly<
  Record<ProductionPlanStatus, readonly ProductionPlanStatus[]>
> = {
  draft: ["approved"],
  approved: ["in-progress"],
  "in-progress": ["complete"],
  complete: [],
};

function requireRecord<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} not found`);
  }
  return value;
}

export class ProductionPlanService {
  public constructor(
    private readonly store: ProjectStateStore,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async create(input: CreatePlanInput): Promise<ProductionPlan> {
    const now = this.runtime.now();
    const candidate = {
      id: this.runtime.createId(),
      projectId: input.projectId,
      goal: input.goal,
      sections: input.sections ?? [],
      trackRoles: input.trackRoles ?? [],
      constraints: [...(input.constraints ?? [])],
      status: "draft" as const,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.tempo === undefined ? {} : { tempo: input.tempo }),
      ...(input.key === undefined ? {} : { key: input.key }),
    };
    const plan = productionPlanSchema.parse(candidate);
    await this.store.plans.save(plan);
    return plan;
  }

  public async update(
    planId: string,
    input: UpdatePlanInput,
  ): Promise<ProductionPlan> {
    const current = requireRecord(
      await this.store.plans.get(planId),
      "Production plan",
    );
    if (current.status !== "draft") {
      throw new Error("Only draft production plans can be edited");
    }
    const next = productionPlanSchema.parse({
      ...current,
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.sections === undefined ? {} : { sections: input.sections }),
      ...(input.trackRoles === undefined
        ? {}
        : { trackRoles: input.trackRoles }),
      ...(input.constraints === undefined
        ? {}
        : { constraints: [...input.constraints] }),
      ...(input.tempo === undefined
        ? {}
        : input.tempo === null
          ? { tempo: undefined }
          : { tempo: input.tempo }),
      ...(input.key === undefined
        ? {}
        : input.key === null
          ? { key: undefined }
          : { key: input.key }),
      version: current.version + 1,
      updatedAt: this.runtime.now(),
    });
    await this.store.plans.save(next, current.version);
    return next;
  }

  public async approve(
    planId: string,
    sessionId: string,
    reason = "",
  ): Promise<ProductionPlan> {
    return this.store.transaction(async (repositories) => {
      const plan = await this.transitionWith(repositories, planId, "approved");
      const decision = approvalDecisionSchema.parse({
        id: this.runtime.createId(),
        projectId: plan.projectId,
        sessionId,
        subjectType: "plan",
        subjectId: plan.id,
        decision: "approved",
        reason,
        decidedAt: this.runtime.now(),
      });
      await repositories.approvals.save(decision);
      return plan;
    });
  }

  public async transition(
    planId: string,
    status: ProductionPlanStatus,
  ): Promise<ProductionPlan> {
    return this.store.transaction((repositories) =>
      this.transitionWith(repositories, planId, status),
    );
  }

  private async transitionWith(
    repositories: ProjectStateRepositories,
    planId: string,
    status: ProductionPlanStatus,
  ): Promise<ProductionPlan> {
    const current = requireRecord(
      await repositories.plans.get(planId),
      "Production plan",
    );
    const allowedTransitions = planTransitions[current.status];
    if (!allowedTransitions.includes(status)) {
      throw new Error(
        `Invalid production plan transition: ${current.status} -> ${status}`,
      );
    }
    const next = productionPlanSchema.parse({
      ...current,
      status,
      version: current.version + 1,
      updatedAt: this.runtime.now(),
    });
    await repositories.plans.save(next, current.version);
    return next;
  }
}

export interface CreateChangeSetInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly userIntent: string;
  readonly workflow: string;
  readonly targets?: readonly EntityReference[];
  readonly beforeState?: Readonly<Record<string, MetadataValue>>;
  readonly requestedMutations?: readonly MutationRecord[];
}

export class ChangeSetService {
  public constructor(
    private readonly store: ProjectStateStore,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async create(input: CreateChangeSetInput): Promise<ChangeSet> {
    if (
      (await this.store.changeSets.findByCorrelationId(input.correlationId)) !==
      undefined
    ) {
      throw new Error(`Correlation '${input.correlationId}' already exists`);
    }
    const now = this.runtime.now();
    const changeSet = changeSetSchema.parse({
      id: this.runtime.createId(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      userIntent: input.userIntent,
      workflow: input.workflow,
      targets: input.targets ?? [],
      beforeState: input.beforeState ?? {},
      requestedMutations: input.requestedMutations ?? [],
      completedMutations: [],
      verification: { status: "pending", summary: "" },
      warnings: [],
      errors: [],
      recovery: [],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    await this.store.changeSets.save(changeSet);
    return changeSet;
  }

  public begin(id: string): Promise<ChangeSet> {
    return this.mutate(id, (current) => {
      this.assertStatus(current, ["pending"]);
      return { ...current, status: "in-progress" };
    });
  }

  public recordCompletedMutation(
    id: string,
    mutation: MutationRecord,
  ): Promise<ChangeSet> {
    return this.mutate(id, (current) => {
      this.assertStatus(current, ["in-progress"]);
      if (
        !current.requestedMutations.some(
          (requested) => requested.id === mutation.id,
        )
      ) {
        throw new Error("Completed mutation was not requested");
      }
      if (
        current.completedMutations.some(
          (completed) => completed.id === mutation.id,
        )
      ) {
        throw new Error("Completed mutation was already recorded");
      }
      return {
        ...current,
        completedMutations: [...current.completedMutations, mutation],
      };
    });
  }

  public addWarning(id: string, warning: string): Promise<ChangeSet> {
    return this.mutate(id, (current) => ({
      ...current,
      warnings: [...current.warnings, warning],
    }));
  }

  public fail(id: string, error: string): Promise<ChangeSet> {
    return this.mutate(id, (current) => {
      this.assertStatus(current, ["pending", "in-progress"]);
      return {
        ...current,
        status: "failed",
        errors: [...current.errors, error],
        verification: {
          status: "failed",
          summary: error,
          checkedAt: this.runtime.now(),
        },
      };
    });
  }

  public verify(id: string, summary: string): Promise<ChangeSet> {
    return this.mutate(id, (current) => {
      this.assertStatus(current, ["in-progress"]);
      if (
        current.completedMutations.length !== current.requestedMutations.length
      ) {
        throw new Error("Cannot verify an incomplete change set");
      }
      return {
        ...current,
        status: "verified",
        verification: {
          status: "passed",
          summary,
          checkedAt: this.runtime.now(),
        },
      };
    });
  }

  public recover(id: string, recovery: string): Promise<ChangeSet> {
    return this.mutate(id, (current) => {
      this.assertStatus(current, ["failed"]);
      return {
        ...current,
        status: "recovered",
        recovery: [...current.recovery, recovery],
      };
    });
  }

  private async mutate(
    id: string,
    update: (current: ChangeSet) => ChangeSet,
  ): Promise<ChangeSet> {
    return this.store.transaction(async (repositories) => {
      const current = requireRecord(
        await repositories.changeSets.get(id),
        "Change set",
      );
      const next = changeSetSchema.parse({
        ...update(current),
        updatedAt: this.runtime.now(),
      });
      await repositories.changeSets.save(next);
      return next;
    });
  }

  private assertStatus(
    changeSet: ChangeSet,
    allowed: readonly ChangeSet["status"][],
  ): void {
    if (!allowed.includes(changeSet.status)) {
      throw new Error(`Invalid change-set transition from ${changeSet.status}`);
    }
  }
}

export class ProjectStateService {
  readonly cache = new SnapshotCache();
  #session: AppSession | undefined;
  #project: ProjectIdentity | undefined;

  public constructor(
    private readonly store: ProjectStateStore,
    private readonly runtime: ServiceRuntime,
  ) {}

  public activeSession(): AppSession | undefined {
    return this.#session;
  }

  public activeProject(): ProjectIdentity | undefined {
    return this.#project;
  }

  public async resumeSession(sessionId: string): Promise<AppSession> {
    const session = requireRecord(
      await this.store.sessions.get(sessionId),
      "Session",
    );
    this.cache.clear();
    this.#session = session;
    this.#project =
      session.activeProjectId === undefined
        ? undefined
        : await this.store.projects.get(session.activeProjectId);
    return session;
  }

  public async startSession(): Promise<AppSession> {
    const now = this.runtime.now();
    const session: AppSession = {
      id: this.runtime.createId(),
      startedAt: now,
      updatedAt: now,
    };
    await this.store.sessions.save(session);
    this.cache.clear();
    this.#session = session;
    this.#project = undefined;
    return session;
  }

  public async switchProject(project: ProjectIdentity): Promise<void> {
    const session = requireRecord(this.#session, "Active session");
    const updatedSession: AppSession = {
      ...session,
      activeProjectId: project.id,
      updatedAt: this.runtime.now(),
    };
    await this.store.transaction(async (repositories) => {
      await repositories.projects.save(project);
      await repositories.sessions.save(updatedSession);
    });
    this.cache.clear();
    this.#project = project;
    this.#session = updatedSession;
  }

  public async activePlans(): Promise<readonly ProductionPlan[]> {
    const project = requireRecord(this.#project, "Active project");
    return this.store.plans.listByProject(project.id);
  }

  public assertMutable(reference: EntityReference): EntitySummary {
    const project = requireRecord(this.#project, "Active project");
    if (reference.projectId !== project.id) {
      throw new Error("Reference is isolated to a different project");
    }
    return this.cache.assertMutable(reference);
  }
}

export class GuardedMutationService {
  public constructor(private readonly state: ProjectStateService) {}

  public async execute<T>(
    reference: EntityReference,
    mutateBridge: (entity: EntitySummary) => Promise<T>,
  ): Promise<T> {
    const entity = this.state.assertMutable(reference);
    return mutateBridge(entity);
  }
}
