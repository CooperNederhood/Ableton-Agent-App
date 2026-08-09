import { describe, expect, it, vi } from "vitest";

import {
  DeterministicWorkflowExecutor,
  InMemoryMutationLeaseManager,
  type ApprovalDecision,
  type WorkflowAudit,
  type WorkflowRuntime,
  type WorkflowStep,
  type WorkflowTransaction,
} from "./index.js";

function step(
  id: string,
  dependencies: readonly string[] = [],
  reversible = true,
): WorkflowStep {
  return {
    id,
    operation: `test.${id}`,
    description: id,
    dependencies,
    mutationCount: 1,
    reversibility: reversible
      ? { kind: "reversible", compensation: "restore-test-state" }
      : { kind: "non-reversible", reason: "test state cannot be restored" },
    payload: {},
    auditData: {},
  };
}

function transaction(
  steps: readonly WorkflowStep[],
  overrides: Partial<WorkflowTransaction["budget"]> = {},
): WorkflowTransaction {
  return {
    id: "transaction-1",
    projectId: "project-1",
    sessionId: "session-1",
    correlationId: "correlation-1",
    resource: "project-1",
    intent: "test workflow",
    workflow: "test",
    budget: {
      maxSteps: 16,
      maxMutations: 16,
      maxDurationMs: 1_000,
      ...overrides,
    },
    steps,
  };
}

interface RuntimeOptions {
  readonly approval?: ApprovalDecision;
  readonly executeFailure?: string;
  readonly verifyFailure?: string;
  readonly compensationFailure?: string;
  readonly refreshFailure?: boolean;
  readonly nowMs?: () => number;
  readonly executeUntilAborted?: string;
}

function runtime(
  events: string[],
  options: RuntimeOptions = {},
): WorkflowRuntime {
  return {
    nowMs: options.nowMs ?? (() => 0),
    captureBefore: (item) => {
      events.push(`capture:${item.id}`);
      return Promise.resolve(`before:${item.id}`);
    },
    approve: () => {
      events.push("approve");
      return Promise.resolve(
        options.approval ?? { decision: "approved" as const },
      );
    },
    execute: (item, _beforeState, signal) => {
      events.push(`execute:${item.id}`);
      if (item.id === options.executeUntilAborted) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Execution aborted"),
              ),
            { once: true },
          );
        });
      }
      if (item.id === options.executeFailure) {
        return Promise.reject(new Error("execution broke"));
      }
      return Promise.resolve(`result:${item.id}`);
    },
    verify: (item) => {
      events.push(`verify:${item.id}`);
      return Promise.resolve(item.id !== options.verifyFailure);
    },
    compensate: (item) => {
      events.push(`compensate:${item.id}`);
      if (item.id === options.compensationFailure) {
        return Promise.reject(new Error("compensation broke"));
      }
      return Promise.resolve();
    },
    refresh: (_workflow, affected) => {
      events.push(`refresh:${affected.map((item) => item.id).join(",")}`);
      return options.refreshFailure
        ? Promise.reject(new Error("refresh broke"))
        : Promise.resolve();
    },
  };
}

describe("in-memory mutation leases", () => {
  it("grants each resource in FIFO order and supports idempotent release", async () => {
    const manager = new InMemoryMutationLeaseManager();
    const first = await manager.acquire("project", "first");
    const order: string[] = [];
    const secondPromise = manager.acquire("project", "second").then((lease) => {
      order.push(lease.owner);
      return lease;
    });
    const thirdPromise = manager.acquire("project", "third").then((lease) => {
      order.push(lease.owner);
      return lease;
    });

    first.release();
    first.release();
    const second = await secondPromise;
    expect(order).toEqual(["second"]);
    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);
    third.release();
  });

  it("allows different resources concurrently", async () => {
    const manager = new InMemoryMutationLeaseManager();
    const [left, right] = await Promise.all([
      manager.acquire("left", "a"),
      manager.acquire("right", "b"),
    ]);
    expect([left.owner, right.owner]).toEqual(["a", "b"]);
    left.release();
    right.release();
  });
});

describe("deterministic workflow executor", () => {
  it("captures, approves, executes, and verifies in order", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events),
    );
    const result = await executor.execute(
      transaction([step("one"), step("two", ["one"])]),
    );

    expect(result.status).toBe("succeeded");
    expect(result.atomicRollback).toBe(false);
    expect(events).toEqual([
      "capture:one",
      "capture:two",
      "approve",
      "execute:one",
      "verify:one",
      "execute:two",
      "verify:two",
    ]);
  });

  it("does not execute after approval denial", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, {
        approval: { decision: "denied", reason: "user declined" },
      }),
    );
    const result = await executor.execute(transaction([step("one")]));

    expect(result.status).toBe("denied");
    expect(result.steps[0]?.status).toBe("skipped");
    expect(events).toEqual(["capture:one", "approve"]);
  });

  it("rejects step, mutation, and duration budget overruns", async () => {
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime([]),
    );
    await expect(
      executor.execute(
        transaction([step("one"), step("two")], { maxSteps: 1 }),
      ),
    ).resolves.toMatchObject({ status: "budget-exceeded" });
    await expect(
      executor.execute(
        transaction([step("one"), step("two")], { maxMutations: 1 }),
      ),
    ).resolves.toMatchObject({ status: "budget-exceeded" });

    let time = 0;
    const durationEvents: string[] = [];
    const durationExecutor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(durationEvents, {
        nowMs: () => {
          time += 6;
          return time;
        },
      }),
    );
    const durationResult = await durationExecutor.execute(
      transaction([step("one"), step("two")], { maxDurationMs: 10 }),
    );
    expect(durationResult.status).toBe("failed");
    expect(durationResult.message).toContain("duration budget");
  });

  it("stops dependent steps but can finish an independent step", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, { executeFailure: "one" }),
    );
    const result = await executor.execute(
      transaction([
        step("one"),
        step("dependent", ["one"]),
        step("independent"),
      ]),
    );

    expect(events).not.toContain("execute:dependent");
    expect(events).toContain("execute:independent");
    expect(
      result.steps.find((item) => item.stepId === "dependent")?.status,
    ).toBe("skipped");
    expect(result.status).toBe("compensated");
  });

  it("compensates verified and verification-failed steps in reverse order", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, { verifyFailure: "three" }),
    );
    const result = await executor.execute(
      transaction([step("one"), step("two", ["one"]), step("three", ["two"])]),
    );

    expect(result.status).toBe("compensated");
    expect(events.filter((event) => event.startsWith("compensate:"))).toEqual([
      "compensate:three",
      "compensate:two",
      "compensate:one",
    ]);
    expect(events.at(-1)).toBe("refresh:one,two,three");
    expect(result.message).toContain("atomic rollback is not claimed");
  });

  it("reports non-reversible partial application and refreshes state", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, { executeFailure: "two" }),
    );
    const result = await executor.execute(
      transaction([step("one", [], false), step("two", ["one"])]),
    );

    expect(result.status).toBe("partially-applied");
    expect(result.refreshAttempted).toBe(true);
    expect(events).toContain("refresh:one,two");
    expect(events).toContain("compensate:two");
  });

  it("reports compensation and refresh failures explicitly", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, {
        executeFailure: "two",
        compensationFailure: "one",
        refreshFailure: true,
      }),
    );
    const result = await executor.execute(
      transaction([step("one"), step("two", ["one"])]),
    );

    expect(result.status).toBe("compensation-failed");
    expect(result.refreshError).toBe("refresh broke");
    expect(result.steps[0]?.status).toBe("compensation-failed");
  });

  it("aborts a runtime phase when the duration budget expires", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, { executeUntilAborted: "one" }),
    );

    const result = await executor.execute(
      transaction([step("one")], { maxDurationMs: 10 }),
    );

    expect(result.status).toBe("compensated");
    expect(result.message).toContain("duration budget");
    expect(events).toContain("compensate:one");
    expect(events).toContain("refresh:one");
  });

  it("audits successful execution before failed verification", async () => {
    const events: string[] = [];
    const auditEvents: string[] = [];
    const audit: WorkflowAudit = {
      prepare: () =>
        Promise.resolve({
          denied: () => Promise.resolve(),
          completed: (item) => {
            auditEvents.push(`completed:${item.id}`);
            return Promise.resolve();
          },
          failed: (message) => {
            auditEvents.push(`failed:${message}`);
            return Promise.resolve();
          },
          verified: () => Promise.resolve(),
          recovered: () => Promise.resolve(),
          warning: () => Promise.resolve(),
        }),
    };
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, { verifyFailure: "one" }),
      audit,
    );

    await executor.execute(transaction([step("one")]));

    expect(auditEvents[0]).toBe("completed:one");
    expect(auditEvents[1]).toContain("failed:Verification failed");
  });

  it("continues compensation and refresh when audit persistence fails", async () => {
    const events: string[] = [];
    const audit: WorkflowAudit = {
      prepare: () =>
        Promise.resolve({
          denied: () => Promise.reject(new Error("audit unavailable")),
          completed: () => Promise.resolve(),
          failed: () => Promise.reject(new Error("audit unavailable")),
          verified: () => Promise.resolve(),
          recovered: () => Promise.reject(new Error("audit unavailable")),
          warning: () => Promise.reject(new Error("audit unavailable")),
        }),
    };
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events, { executeFailure: "two" }),
      audit,
    );

    const result = await executor.execute(
      transaction([step("one"), step("two", ["one"])]),
    );

    expect(events).toContain("compensate:two");
    expect(events).toContain("compensate:one");
    expect(events).toContain("refresh:one,two");
    expect(result.status).toBe("compensation-failed");
    expect(result.message).toContain("Audit failed");
  });

  it("rejects cross-project targets at the executor boundary", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events),
    );
    const crossProject = {
      ...step("one"),
      target: {
        projectId: "project-2",
        kind: "track" as const,
        id: "track-1",
        revision: 1,
      },
    };

    await expect(executor.execute(transaction([crossProject]))).rejects.toThrow(
      "different project",
    );
    expect(events).toEqual([]);
  });

  it("rejects cross-project references nested in step payloads", async () => {
    const events: string[] = [];
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events),
    );
    const hiddenCrossProject = {
      ...step("one"),
      target: {
        projectId: "project-1",
        kind: "track" as const,
        id: "track-1",
        revision: 1,
      },
      payload: {
        track: {
          projectId: "project-2",
          kind: "track" as const,
          id: "track-2",
          revision: 1,
        },
      },
    };

    await expect(
      executor.execute(transaction([hiddenCrossProject])),
    ).rejects.toThrow("payload references a different project");
    expect(events).toEqual([]);
  });

  it("bounds stalled audit writes so recovery can continue", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const never = new Promise<void>(() => undefined);
      const audit: WorkflowAudit = {
        prepare: () =>
          Promise.resolve({
            denied: () => never,
            completed: () => Promise.resolve(),
            failed: () => never,
            verified: () => Promise.resolve(),
            recovered: () => never,
            warning: () => never,
          }),
      };
      const executor = new DeterministicWorkflowExecutor(
        new InMemoryMutationLeaseManager(),
        runtime(events, { executeFailure: "two" }),
        audit,
      );

      const pending = executor.execute(
        transaction([step("one"), step("two", ["one"])]),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(events).toContain("compensate:two");
      expect(events).toContain("compensate:one");
      expect(events).toContain("refresh:one,two");
      expect(result.status).toBe("compensation-failed");
      expect(result.message).toContain("audit persistence timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts stalled audit preparation before releasing the lease", async () => {
    const events: string[] = [];
    let preparationAborted = false;
    const audit: WorkflowAudit = {
      prepare: (_workflow, _beforeStates, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              preparationAborted = true;
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Audit preparation aborted"),
              );
            },
            { once: true },
          );
        }),
    };
    const executor = new DeterministicWorkflowExecutor(
      new InMemoryMutationLeaseManager(),
      runtime(events),
      audit,
    );

    const result = await executor.execute(
      transaction([step("one")], { maxDurationMs: 10 }),
    );

    expect(preparationAborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("audit preparation");
    expect(events).toEqual(["capture:one"]);
  });
});
