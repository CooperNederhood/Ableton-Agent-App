import {
  compareOrderedRecords,
  comparePreferenceKeys,
  type OrderedField,
} from "./ordering.js";
import {
  appSessionSchema,
  approvalDecisionSchema,
  changeSetSchema,
  preferenceSchema,
  productionPlanSchema,
  projectIdentitySchema,
  type AppSession,
  type ApprovalDecision,
  type ChangeSet,
  type Preference,
  type ProductionPlan,
  type ProjectIdentity,
} from "./schemas.js";

export class RepositoryConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export interface SessionRepository {
  get(id: string): Promise<AppSession | undefined>;
  save(session: AppSession): Promise<void>;
}

export interface ProjectRepository {
  get(id: string): Promise<ProjectIdentity | undefined>;
  findByAbletonId(
    abletonProjectId: string,
  ): Promise<ProjectIdentity | undefined>;
  save(project: ProjectIdentity): Promise<void>;
}

export interface PlanRepository {
  get(id: string): Promise<ProductionPlan | undefined>;
  listByProject(projectId: string): Promise<readonly ProductionPlan[]>;
  save(plan: ProductionPlan, expectedVersion?: number): Promise<void>;
}

export interface ChangeSetRepository {
  get(id: string): Promise<ChangeSet | undefined>;
  findByCorrelationId(correlationId: string): Promise<ChangeSet | undefined>;
  listByProject(projectId: string): Promise<readonly ChangeSet[]>;
  save(changeSet: ChangeSet): Promise<void>;
}

export interface PreferenceRepository {
  get(sessionId: string, key: string): Promise<Preference | undefined>;
  listBySession(sessionId: string): Promise<readonly Preference[]>;
  save(preference: Preference): Promise<void>;
}

export interface ApprovalRepository {
  get(id: string): Promise<ApprovalDecision | undefined>;
  listBySubject(
    subjectType: ApprovalDecision["subjectType"],
    subjectId: string,
  ): Promise<readonly ApprovalDecision[]>;
  save(decision: ApprovalDecision): Promise<void>;
}

export interface ProjectStateRepositories {
  readonly sessions: SessionRepository;
  readonly projects: ProjectRepository;
  readonly plans: PlanRepository;
  readonly changeSets: ChangeSetRepository;
  readonly preferences: PreferenceRepository;
  readonly approvals: ApprovalRepository;
}

export interface ProjectStateStore extends ProjectStateRepositories {
  transaction<T>(
    operation: (repositories: ProjectStateRepositories) => Promise<T>,
  ): Promise<T>;
}

interface StoreData {
  sessions: Map<string, AppSession>;
  projects: Map<string, ProjectIdentity>;
  plans: Map<string, ProductionPlan>;
  changeSets: Map<string, ChangeSet>;
  preferences: Map<string, Preference>;
  approvals: Map<string, ApprovalDecision>;
}

function emptyData(): StoreData {
  return {
    sessions: new Map(),
    projects: new Map(),
    plans: new Map(),
    changeSets: new Map(),
    preferences: new Map(),
    approvals: new Map(),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneData(data: StoreData): StoreData {
  return {
    sessions: new Map(
      [...data.sessions].map(([key, value]) => [key, clone(value)]),
    ),
    projects: new Map(
      [...data.projects].map(([key, value]) => [key, clone(value)]),
    ),
    plans: new Map([...data.plans].map(([key, value]) => [key, clone(value)])),
    changeSets: new Map(
      [...data.changeSets].map(([key, value]) => [key, clone(value)]),
    ),
    preferences: new Map(
      [...data.preferences].map(([key, value]) => [key, clone(value)]),
    ),
    approvals: new Map(
      [...data.approvals].map(([key, value]) => [key, clone(value)]),
    ),
  };
}

function replaceData(target: StoreData, source: StoreData): void {
  target.sessions = source.sessions;
  target.projects = source.projects;
  target.plans = source.plans;
  target.changeSets = source.changeSets;
  target.preferences = source.preferences;
  target.approvals = source.approvals;
}

function preferenceKey(sessionId: string, key: string): string {
  return `${sessionId}\u0000${key}`;
}

class Repositories implements ProjectStateRepositories {
  public readonly sessions: SessionRepository;
  public readonly projects: ProjectRepository;
  public readonly plans: PlanRepository;
  public readonly changeSets: ChangeSetRepository;
  public readonly preferences: PreferenceRepository;
  public readonly approvals: ApprovalRepository;

  public constructor(
    private readonly data: StoreData,
    private readonly didWrite: () => void = () => undefined,
  ) {
    this.sessions = {
      get: async (id) => cloneOrUndefined(this.data.sessions.get(id)),
      save: async (session) => {
        const parsed = appSessionSchema.parse(session);
        this.data.sessions.set(parsed.id, clone(parsed));
        this.didWrite();
      },
    };
    this.projects = {
      get: async (id) => cloneOrUndefined(this.data.projects.get(id)),
      findByAbletonId: async (abletonProjectId) =>
        cloneOrUndefined(
          [...this.data.projects.values()].find(
            (project) => project.abletonProjectId === abletonProjectId,
          ),
        ),
      save: async (project) => {
        const parsed = projectIdentitySchema.parse(project);
        const conflicting = [...this.data.projects.values()].find(
          (existing) =>
            existing.abletonProjectId === parsed.abletonProjectId &&
            existing.id !== parsed.id,
        );
        if (conflicting !== undefined) {
          throw new RepositoryConflictError(
            `Ableton project '${parsed.abletonProjectId}' already exists`,
          );
        }
        this.data.projects.set(parsed.id, clone(parsed));
        this.didWrite();
      },
    };
    this.plans = {
      get: async (id) => cloneOrUndefined(this.data.plans.get(id)),
      listByProject: async (projectId) =>
        sorted(
          [...this.data.plans.values()].filter(
            (plan) => plan.projectId === projectId,
          ),
        ),
      save: async (plan, expectedVersion) => {
        const parsed = productionPlanSchema.parse(plan);
        const existing = this.data.plans.get(parsed.id);
        if (
          expectedVersion !== undefined &&
          existing?.version !== expectedVersion
        ) {
          throw new RepositoryConflictError(
            `Plan '${parsed.id}' version changed`,
          );
        }
        this.data.plans.set(parsed.id, clone(parsed));
        this.didWrite();
      },
    };
    this.changeSets = {
      get: async (id) => cloneOrUndefined(this.data.changeSets.get(id)),
      findByCorrelationId: async (correlationId) =>
        cloneOrUndefined(
          [...this.data.changeSets.values()].find(
            (changeSet) => changeSet.correlationId === correlationId,
          ),
        ),
      listByProject: async (projectId) =>
        sorted(
          [...this.data.changeSets.values()].filter(
            (changeSet) => changeSet.projectId === projectId,
          ),
        ),
      save: async (changeSet) => {
        const parsed = changeSetSchema.parse(changeSet);
        const conflicting = [...this.data.changeSets.values()].find(
          (existing) =>
            existing.correlationId === parsed.correlationId &&
            existing.id !== parsed.id,
        );
        if (conflicting !== undefined) {
          throw new RepositoryConflictError(
            `Correlation '${parsed.correlationId}' already exists`,
          );
        }
        this.data.changeSets.set(parsed.id, clone(parsed));
        this.didWrite();
      },
    };
    this.preferences = {
      get: async (sessionId, key) =>
        cloneOrUndefined(
          this.data.preferences.get(preferenceKey(sessionId, key)),
        ),
      listBySession: async (sessionId) =>
        [...this.data.preferences.values()]
          .filter((preference) => preference.sessionId === sessionId)
          .sort(comparePreferenceKeys)
          .map(clone),
      save: async (preference) => {
        const parsed = preferenceSchema.parse(preference);
        this.data.preferences.set(
          preferenceKey(parsed.sessionId, parsed.key),
          clone(parsed),
        );
        this.didWrite();
      },
    };
    this.approvals = {
      get: async (id) => cloneOrUndefined(this.data.approvals.get(id)),
      listBySubject: async (subjectType, subjectId) =>
        sorted(
          [...this.data.approvals.values()].filter(
            (decision) =>
              decision.subjectType === subjectType &&
              decision.subjectId === subjectId,
          ),
          "decidedAt",
        ),
      save: async (decision) => {
        const parsed = approvalDecisionSchema.parse(decision);
        this.data.approvals.set(parsed.id, clone(parsed));
        this.didWrite();
      },
    };
  }
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

function sorted<
  T extends {
    readonly id: string;
    readonly createdAt?: string;
    readonly decidedAt?: string;
  },
>(values: readonly T[], field: OrderedField = "createdAt"): T[] {
  return [...values].sort(compareOrderedRecords(field)).map(clone);
}

export class InMemoryProjectStateStore implements ProjectStateStore {
  #data = emptyData();
  #tail: Promise<void> = Promise.resolve();
  #version = 0;

  public get sessions(): SessionRepository {
    return new Repositories(this.#data, () => this.#version++).sessions;
  }

  public get projects(): ProjectRepository {
    return new Repositories(this.#data, () => this.#version++).projects;
  }

  public get plans(): PlanRepository {
    return new Repositories(this.#data, () => this.#version++).plans;
  }

  public get changeSets(): ChangeSetRepository {
    return new Repositories(this.#data, () => this.#version++).changeSets;
  }

  public get preferences(): PreferenceRepository {
    return new Repositories(this.#data, () => this.#version++).preferences;
  }

  public get approvals(): ApprovalRepository {
    return new Repositories(this.#data, () => this.#version++).approvals;
  }

  public transaction<T>(
    operation: (repositories: ProjectStateRepositories) => Promise<T>,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      const baseVersion = this.#version;
      const working = cloneData(this.#data);
      const value = await operation(new Repositories(working));
      if (this.#version !== baseVersion) {
        throw new RepositoryConflictError(
          "Project state changed while the transaction was running",
        );
      }
      replaceData(this.#data, cloneData(working));
      this.#version++;
      return value;
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
