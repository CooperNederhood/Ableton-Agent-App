import { describe, expect, it } from "vitest";

import {
  ChangeSetService,
  InMemoryProjectStateStore,
  type EntityReference,
} from "@ableton-agent/project-state";

import {
  ProjectStateWorkflowAudit,
  type WorkflowStep,
  type WorkflowTransaction,
} from "./index.js";

const ids = {
  project: "00000000-0000-4000-8000-000000000001",
  session: "00000000-0000-4000-8000-000000000002",
  correlation: "00000000-0000-4000-8000-000000000003",
  changeSet: "00000000-0000-4000-8000-000000000004",
  mutationOne: "00000000-0000-4000-8000-000000000005",
  mutationTwo: "00000000-0000-4000-8000-000000000006",
} as const;

const now = "2026-08-09T15:32:31.242Z";

function workflowStep(target: EntityReference): WorkflowStep {
  return {
    id: "step-1",
    operation: "test.multi-mutation",
    description: "Test two mutations",
    dependencies: [],
    mutationCount: 2,
    reversibility: { kind: "reversible", compensation: "restore-test-state" },
    target,
    payload: {},
    auditData: { valueCount: 2 },
  };
}

describe("project-state workflow audit", () => {
  it("persists stable requested/completed mutation records and verification", async () => {
    const store = new InMemoryProjectStateStore();
    const changeSets = new ChangeSetService(store, {
      createId: () => ids.changeSet,
      now: () => now,
    });
    const mutationIds = [ids.mutationOne, ids.mutationTwo];
    let mutationIndex = 0;
    const audit = new ProjectStateWorkflowAudit(changeSets, {
      createId: () => mutationIds[mutationIndex++] ?? ids.mutationTwo,
      now: () => now,
    });
    const target: EntityReference = {
      projectId: ids.project,
      kind: "track",
      id: "track-1",
      revision: 1,
    };
    const item = workflowStep(target);
    const workflow: WorkflowTransaction = {
      id: "workflow-1",
      projectId: ids.project,
      sessionId: ids.session,
      correlationId: ids.correlation,
      resource: ids.project,
      intent: "Test audit",
      workflow: "audit-test",
      budget: { maxSteps: 1, maxMutations: 2, maxDurationMs: 1_000 },
      steps: [item],
    };

    const session = await audit.prepare(
      workflow,
      new Map([["step-1", { value: 1 }]]),
      new AbortController().signal,
    );
    await session.completed(item);
    await session.verified("verified");

    const stored = await store.changeSets.get(ids.changeSet);
    expect(stored?.status).toBe("verified");
    expect(stored?.requestedMutations).toHaveLength(2);
    expect(stored?.completedMutations).toEqual(stored?.requestedMutations);
    expect(stored?.beforeState).toEqual({ capturedStepCount: 1 });
  });
});
