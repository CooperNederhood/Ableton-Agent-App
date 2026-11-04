import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runAcceptanceSuite,
  type SuiteDependencies,
  type SuiteInputs,
  type SuiteReceipt,
} from "./acceptance-suite.js";
import { writeScenarioReceipt } from "./scenario-receipts.mjs";

const inputs: SuiteInputs = {
  candidateSha256: "a".repeat(64),
  appAsarSha256: "b".repeat(64),
  sourceSha256: "c".repeat(64),
  sourceRevision: "d".repeat(40),
  dirty: false,
  definitionsSha256: "e".repeat(64),
  selected: ["first", "second"],
};

async function fixture(test: (directory: string) => Promise<void>) {
  const parent = resolve(".test-artifacts/acceptance-suite-unit");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const passedAttempt: SuiteDependencies["execute"] = async ({
  scenarioId,
  runId,
}) => ({
  scenarioId,
  runId,
  status: "passed",
  executed: true,
  cleanupComplete: true,
  persisted: true,
  receiptPath: `${scenarioId}/receipt.json`,
  receiptSha256: "f".repeat(64),
  assertions: [],
  liveVersion: "11.3.43",
});

async function readReceipt(
  directory: string,
  name = "suite.json",
): Promise<SuiteReceipt> {
  return JSON.parse(
    await readFile(join(directory, name), "utf8"),
  ) as SuiteReceipt;
}

describe("discovered acceptance suite", () => {
  it("retains an unknown thrown execution, leaves later cases unrun, and does not release an unsafe lease", async () => {
    await fixture(async (directory) => {
      const release = vi.fn(async () => {});
      const retain = vi.fn();
      const execute = vi.fn<SuiteDependencies["execute"]>(async () => {
        throw new Error("worker disappeared before its cleanup receipt");
      });
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release, retain }),
          execute,
        },
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(retain).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "failed",
        executed: [],
        unknown: ["first"],
        unrun: ["second"],
        cleanupComplete: false,
        attempts: [
          {
            scenarioId: "first",
            runId: execute.mock.calls[0]![0].runId,
            status: "finalization-failed",
            executed: null,
            cleanupComplete: false,
            persisted: false,
            receiptPath: "case-1/receipt.json",
            receiptSha256: "",
            failure: "worker disappeared before its cleanup receipt",
          },
        ],
      });
      const stored = await readReceipt(directory);
      expect(stored.attempts).toEqual(result.attempts);
      expect(stored.unknown).toEqual(["first"]);
      expect(
        result.events
          .filter((event) => event.stage === "suite.case")
          .map((event) => event.phase),
      ).toEqual(["queued", "started", "failed"]);
    });
  });

  it("persists cancellation before launch without acquiring a host or inspecting inputs", async () => {
    await fixture(async (directory) => {
      const abort = new AbortController();
      abort.abort(new Error("cancelled before launch"));
      const acquire = vi.fn<SuiteDependencies["acquire"]>();
      const inspect = vi.fn<SuiteDependencies["inspect"]>();
      const execute = vi.fn<SuiteDependencies["execute"]>();
      const result = await runAcceptanceSuite(
        { directory, signal: abort.signal, selected: inputs.selected },
        {
          inspect,
          acquire,
          execute,
        },
      );
      expect(acquire).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "cancelled",
        cleanupComplete: true,
        attempts: [],
        executed: [],
        unknown: [],
        unrun: inputs.selected,
        firstFailure: { message: "cancelled before launch" },
      });
      expect((await readReceipt(directory)).status).toBe("cancelled");
    });
  });

  it("blocks rejected host acquisition without inspecting inputs or executing cases", async () => {
    await fixture(async (directory) => {
      const inspect = vi.fn<SuiteDependencies["inspect"]>();
      const execute = vi.fn<SuiteDependencies["execute"]>();
      const acquire = vi.fn<SuiteDependencies["acquire"]>(async () => {
        throw new Error("host already leased");
      });
      const result = await runAcceptanceSuite(
        { directory, selected: inputs.selected },
        { inspect, acquire, execute },
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(inspect).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "blocked",
        cleanupComplete: false,
        attempts: [],
        unrun: inputs.selected,
        firstFailure: { message: "host already leased" },
      });
      expect(
        result.events
          .filter((event) => event.stage === "suite.host-lease")
          .map((event) => event.phase),
      ).toEqual(["queued", "started", "failed"]);
      expect((await readReceipt(directory)).status).toBe("blocked");
    });
  });

  it("fails qualification when host release fails even though every case passed", async () => {
    await fixture(async (directory) => {
      const execute = vi.fn(passedAttempt);
      const release = vi.fn(async () => {
        throw new Error("host release failed");
      });
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release }),
          execute,
        },
      );
      expect(execute).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "failed",
        cleanupComplete: false,
        executed: inputs.selected,
        unrun: [],
        firstFailure: { message: "host release failed" },
      });
      expect(
        result.attempts.every((attempt) => attempt.status === "passed"),
      ).toBe(true);
      expect(
        result.events
          .filter((event) => event.stage === "suite.host-release")
          .map((event) => event.phase),
      ).toEqual(["queued", "started", "failed"]);
      expect((await readReceipt(directory)).status).toBe("failed");
    });
  });

  it.each([
    {
      label: "dirty source",
      changed: { dirty: true },
      message: "clean committed source checkout",
    },
    {
      label: "duplicate selection",
      changed: { selected: ["first", "first"] },
      message: "nonempty unique registered selection",
    },
  ])(
    "blocks $label before execution and releases the acquired lease",
    async ({ changed, message }) => {
      await fixture(async (directory) => {
        const execute = vi.fn(passedAttempt);
        const release = vi.fn(async () => {});
        const selectedInputs = { ...inputs, ...changed };
        const result = await runAcceptanceSuite(
          { directory },
          {
            inspect: async () => selectedInputs,
            acquire: async () => ({ release }),
            execute,
          },
        );
        expect(execute).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
          status: "blocked",
          cleanupComplete: true,
          attempts: [],
          unrun: selectedInputs.selected,
        });
        expect(result.firstFailure?.message).toContain(message);
        expect((await readReceipt(directory)).status).toBe("blocked");
      });
    },
  );

  it.each([
    "candidateSha256",
    "appAsarSha256",
    "sourceSha256",
    "sourceRevision",
    "definitionsSha256",
    "dirty",
    "selected",
  ] as const)(
    "blocks changed %s inputs before the first execute",
    async (field) => {
      await fixture(async (directory) => {
        const changed = {
          ...inputs,
          [field]:
            field === "dirty"
              ? true
              : field === "selected"
                ? ["first"]
                : "0".repeat(field === "sourceRevision" ? 40 : 64),
        };
        const inspect = vi
          .fn<SuiteDependencies["inspect"]>()
          .mockResolvedValueOnce(inputs)
          .mockResolvedValue(changed);
        const execute = vi.fn(passedAttempt);
        const release = vi.fn(async () => {});
        const result = await runAcceptanceSuite(
          { directory },
          {
            inspect,
            acquire: async () => ({ release }),
            execute,
          },
        );
        expect(inspect).toHaveBeenCalledTimes(2);
        expect(execute).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
          status: "blocked",
          cleanupComplete: true,
          attempts: [],
          unrun: inputs.selected,
          firstFailure: {
            message:
              "Candidate, source, registry or fixture inputs changed; qualification is stale",
          },
        });
        expect((await readReceipt(directory)).inputs).toEqual(inputs);
      });
    },
  );

  it("bounds and redacts thrown failure text before returning or persisting evidence", async () => {
    await fixture(async (directory) => {
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release: async () => {} }),
          execute: async () => {
            throw new Error(
              `password=suite-secret Bearer suite-access-secret ${"detail ".repeat(1000)}`,
            );
          },
        },
      );
      for (const message of [
        result.firstFailure!.message,
        ...result.failures,
        result.attempts[0]!.failure!,
      ]) {
        expect(message).not.toContain("suite-secret");
        expect(message).not.toContain("suite-access-secret");
        expect(message).toContain("[REDACTED]");
        expect(message.length).toBeLessThanOrEqual(2048);
      }
      const text = await readFile(join(directory, "suite.json"), "utf8");
      expect(text).not.toContain("suite-secret");
      expect(text).not.toContain("suite-access-secret");
      expect((await readReceipt(directory)).failures).toEqual(result.failures);
    });
  });

  it("links ordered lifecycle events to the suite and individual case runs, with durable finalization-start evidence", async () => {
    await fixture(async (directory) => {
      const execute = vi.fn(passedAttempt);
      const release = vi.fn(async () => {});
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release }),
          execute,
        },
      );
      const lifecycle = (stage: string) =>
        ["queued", "started", "completed"].map((phase) => `${stage}:${phase}`);
      expect(
        result.events.map((event) => `${event.stage}:${event.phase}`),
      ).toEqual([
        ...lifecycle("suite.checkpoint"),
        ...lifecycle("suite.host-lease"),
        ...lifecycle("suite.admission"),
        ...lifecycle("suite.checkpoint"),
        ...inputs.selected.flatMap(() => [
          ...lifecycle("suite.verify-inputs"),
          ...lifecycle("suite.case"),
          "suite.execution:progress",
          ...lifecycle("suite.checkpoint"),
          ...lifecycle("suite.verify-inputs"),
        ]),
        ...lifecycle("suite.host-release"),
        ...lifecycle("suite.finalization"),
      ]);
      expect(result.status).toBe("passed");
      expect(
        new Set(result.attempts.map((attempt) => attempt.runId)).size,
      ).toBe(2);
      for (const [index, [call]] of execute.mock.calls.entries()) {
        expect(call).toMatchObject({
          scenarioId: inputs.selected[index],
          traceId: result.traceId,
          directory: join(directory, `case-${index + 1}`),
          inputs,
          lease: { release },
        });
        expect(call.runId).not.toBe(result.runId);
        expect(
          result.events
            .filter((event) => event.causationId === call.runId)
            .map((event) => `${event.stage}:${event.phase}`),
        ).toEqual([...lifecycle("suite.case"), "suite.execution:progress"]);
      }
      for (const [index, event] of result.events.entries()) {
        expect(event).toMatchObject({
          schemaVersion: 1,
          runId: result.runId,
          traceId: result.traceId,
          correlationId: result.runId,
        });
        if (event.stage !== "suite.case" && event.stage !== "suite.execution")
          expect(event.causationId).toBe(result.runId);
        expect(event.timestamp).toBeGreaterThanOrEqual(result.startedAt);
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
        if (index > 0)
          expect(event.timestamp).toBeGreaterThanOrEqual(
            result.events[index - 1]!.timestamp,
          );
      }
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt);
      expect(result.durationMs).toBe(result.completedAt - result.startedAt);
      const stored = await readReceipt(directory);
      expect(stored).toEqual({ ...result, events: result.events.slice(0, -1) });
      expect(stored.events.at(-1)).toMatchObject({
        stage: "suite.finalization",
        phase: "started",
      });
      expect(result.events.at(-1)).toMatchObject({
        stage: "suite.finalization",
        phase: "completed",
      });
    });
  });

  it.each(["throw", "readback mismatch"] as const)(
    "cannot return green when final persistence fails by %s",
    async (failure) => {
      await fixture(async (directory) => {
        const execute = vi.fn(passedAttempt);
        const release = vi.fn(async () => {});
        const write = vi.fn<NonNullable<SuiteDependencies["write"]>>(
          async (path, value) => {
            if (path === join(directory, "suite.json")) {
              if (failure === "throw") throw new Error("final disk full");
              await writeScenarioReceipt(path, {
                ...(value as SuiteReceipt),
                runId: "corrupted-run",
              });
              return;
            }
            await writeScenarioReceipt(path, value);
          },
        );
        await expect(
          runAcceptanceSuite(
            { directory },
            {
              inspect: async () => inputs,
              acquire: async () => ({ release }),
              execute,
              write,
            },
          ),
        ).rejects.toThrow(
          failure === "throw" ? "final disk full" : "durable readback mismatch",
        );
        expect(execute).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledOnce();
        expect(
          write.mock.calls.filter(
            ([path]) => path === join(directory, "suite.json"),
          ),
        ).toHaveLength(1);
        expect(
          (await readReceipt(directory, "suite.checkpoint.json")).finalization,
        ).toBe("checkpoint");
        if (failure === "throw")
          await expect(
            readFile(join(directory, "suite.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.each(["succeeds", "fails"] as const)(
    "revokes provisional qualification when cancellation arrives during final persistence and cancellation persistence %s",
    async (cancellationWrite) => {
      await fixture(async (directory) => {
        const abort = new AbortController();
        const execute = vi.fn(passedAttempt);
        const release = vi.fn(async () => {});
        const retain = vi.fn();
        const writtenStatuses: SuiteReceipt["status"][] = [];
        const write = vi.fn<NonNullable<SuiteDependencies["write"]>>(
          async (path, value) => {
            if (path === join(directory, "suite.json")) {
              writtenStatuses.push((value as SuiteReceipt).status);
              if (writtenStatuses.length === 2) {
                await expect(readFile(path)).rejects.toMatchObject({
                  code: "ENOENT",
                });
                if (cancellationWrite === "fails")
                  throw new Error("cancelled receipt disk full");
              }
              await writeScenarioReceipt(path, value);
              if (writtenStatuses.length === 1) {
                expect((await readReceipt(directory)).status).toBe("passed");
                abort.abort(new Error("cancelled during final write"));
              }
              return;
            }
            await writeScenarioReceipt(path, value);
          },
        );
        const running = runAcceptanceSuite(
          { directory, signal: abort.signal },
          {
            inspect: async () => inputs,
            acquire: async () => ({ release, retain }),
            execute,
            write,
          },
        );
        if (cancellationWrite === "fails") {
          await expect(running).rejects.toThrow("cancelled receipt disk full");
          await expect(
            readFile(join(directory, "suite.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const result = await running;
          expect(result).toMatchObject({
            status: "cancelled",
            cleanupComplete: true,
            executed: inputs.selected,
            unrun: [],
            firstFailure: {
              message: "Acceptance suite cancelled during receipt finalization",
            },
          });
          const stored = await readReceipt(directory);
          expect(stored).toEqual({
            ...result,
            events: result.events.slice(0, -1),
          });
          expect(
            result.events
              .filter(
                (event) => event.stage === "suite.cancellation-finalization",
              )
              .map((event) => event.phase),
          ).toEqual(["queued", "started", "completed"]);
          expect(stored.events.at(-1)).toMatchObject({
            stage: "suite.cancellation-finalization",
            phase: "started",
          });
        }
        expect(writtenStatuses).toEqual(["passed", "cancelled"]);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledOnce();
        expect(retain).not.toHaveBeenCalled();
      });
    },
  );

  it("retains the lease when a returned attempt reports unsafe cleanup", async () => {
    await fixture(async (directory) => {
      const release = vi.fn(async () => {});
      const retain = vi.fn();
      const execute = vi.fn<SuiteDependencies["execute"]>(async (options) => ({
        ...(await passedAttempt(options)),
        status: "failed",
        cleanupComplete: false,
      }));
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release, retain }),
          execute,
        },
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      expect(retain).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: "failed",
        cleanupComplete: false,
        executed: ["first"],
        unrun: ["second"],
      });
      expect((await readReceipt(directory)).cleanupComplete).toBe(false);
    });
  });

  it("executes each discovered case once, continues after a safely finalized failure, and never retries", async () => {
    await fixture(async (directory) => {
      const execute = vi.fn(
        async ({
          scenarioId,
          runId,
        }: {
          scenarioId: string;
          runId: string;
        }) => ({
          scenarioId,
          runId,
          status:
            scenarioId === "first" ? ("failed" as const) : ("passed" as const),
          executed: true,
          cleanupComplete: true,
          persisted: true,
          receiptPath: `${scenarioId}/receipt.json`,
          receiptSha256: "f".repeat(64),
          assertions: [],
          liveVersion: "11.3.43",
        }),
      );
      const release = vi.fn(async () => {});
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => inputs,
          acquire: async () => ({ release }),
          execute,
        },
      );
      expect(execute.mock.calls.map(([call]) => call.scenarioId)).toEqual(
        inputs.selected,
      );
      expect(result.status).toBe("failed");
      expect(result.firstFailure?.scenarioId).toBe("first");
      expect(result.unrun).toEqual([]);
      expect(release).toHaveBeenCalledOnce();
      expect((await readReceipt(directory)).finalization).toBe("final");
    });
  });

  it("automatically executes new registrations without changing runner code", async () => {
    await fixture(async (directory) => {
      const selected = [...inputs.selected, "newly-registered"];
      const execute = vi.fn(
        async ({
          scenarioId,
          runId,
        }: {
          scenarioId: string;
          runId: string;
        }) => ({
          scenarioId,
          runId,
          status: "passed" as const,
          executed: true,
          cleanupComplete: true,
          persisted: true,
          receiptPath: `${scenarioId}/receipt.json`,
          receiptSha256: "f".repeat(64),
          assertions: [],
          liveVersion: "11.3.43",
        }),
      );
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => ({ ...inputs, selected }),
          acquire: async () => ({ release: async () => {} }),
          execute,
        },
      );
      expect(execute.mock.calls.map(([call]) => call.scenarioId)).toEqual(
        selected,
      );
      expect(result.status).toBe("passed");
    });
  });

  it.each(["cleanup", "persistence", "cancellation", "candidate"])(
    "leaves remaining selection unrun after %s failure",
    async (failure) => {
      await fixture(async (directory) => {
        const abort = new AbortController();
        let reads = 0;
        const execute = vi.fn(
          async ({
            scenarioId,
            runId,
          }: {
            scenarioId: string;
            runId: string;
          }) => {
            if (failure === "cancellation") abort.abort();
            return {
              scenarioId,
              runId,
              status: "failed" as const,
              executed: true,
              cleanupComplete: failure !== "cleanup",
              persisted: failure !== "persistence",
              receiptPath: `${scenarioId}/receipt.json`,
              receiptSha256: "f".repeat(64),
              assertions: [],
              liveVersion: "11.3.43",
            };
          },
        );
        const result = await runAcceptanceSuite(
          { directory, signal: abort.signal },
          {
            inspect: async () => ({
              ...inputs,
              candidateSha256:
                failure === "candidate" && ++reads > 2
                  ? "0".repeat(64)
                  : inputs.candidateSha256,
            }),
            acquire: async () => ({ release: async () => {} }),
            execute,
          },
        );
        expect(execute).toHaveBeenCalledOnce();
        expect(result.status).not.toBe("passed");
        expect(result.unrun).toEqual(["second"]);
      });
    },
  );

  it("cannot pass an empty selection or a failed durable write", async () => {
    await fixture(async (directory) => {
      const execute = vi.fn();
      const result = await runAcceptanceSuite(
        { directory },
        {
          inspect: async () => ({ ...inputs, selected: [] }),
          acquire: async () => ({ release: async () => {} }),
          execute,
        },
      );
      expect(result.status).toBe("blocked");
      expect(execute).not.toHaveBeenCalled();
      await expect(
        runAcceptanceSuite(
          { directory },
          {
            inspect: async () => inputs,
            acquire: async () => ({ release: async () => {} }),
            execute,
            write: async () => {
              throw new Error("disk full");
            },
          },
        ),
      ).rejects.toThrow("disk full");
    });
  });
});
