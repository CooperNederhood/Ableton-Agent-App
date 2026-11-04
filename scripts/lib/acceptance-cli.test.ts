import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_AUDIO_BASELINE,
  validateFixture,
  type DriverContext,
  type DependencyInventory,
  type LifecycleEvent,
  type RunResult,
} from "../../packages/test-support/src/integration/index.js";
import {
  acceptanceCli,
  type AcceptanceCliDriver,
  type AcceptanceCliEnvironment,
} from "./acceptance-cli.js";
import { writeScenarioReceipt } from "./scenario-receipts.mjs";

async function fixture(
  test: (root: string, output: string[], errors: string[]) => Promise<void>,
) {
  const parent = resolve(".test-artifacts/acceptance-cli-unit");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  try {
    await mkdir(join(root, "integration/acceptance-scenarios"), {
      recursive: true,
    });
    await writeFile(
      join(root, "integration/acceptance-scenarios/suite.json"),
      JSON.stringify({ schemaVersion: 1, scenarios: [] }),
    );
    await test(root, [], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function register(
  root: string,
  qualification = "reviewed-live",
  dependencies = ["machine-listening"],
) {
  await writeFile(
    join(root, "integration/acceptance-scenarios/suite.json"),
    JSON.stringify({ schemaVersion: 1, scenarios: ["example"] }),
  );
  await writeFile(
    join(root, "integration/acceptance-scenarios/example.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "example",
      fixtureId: "example",
      requiredCapabilities: [],
      permissions: [],
      budget: { runMs: 1000, cleanupMs: 1000, persistenceMs: 1000 },
      steps: [
        {
          id: "first",
          message: "Identify the clip",
          timeoutMs: 1000,
          assertions: [],
        },
        {
          id: "second",
          message: "Recall the clip",
          timeoutMs: 1000,
          assertions: [],
        },
      ],
      assertions: [{ name: "capture-count", parameters: { expected: 0 } }],
    }),
  );
  await mkdir(join(root, "integration/fixtures/example"), { recursive: true });
  await writeFile(
    join(root, "integration/fixtures/example/fixture.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "example",
      qualification,
      provenance: {
        ownership: "authored",
        description: "Offline manifest; no playable assets are created.",
      },
      resources: [
        {
          path: "project.als",
          target: "project.als",
          sha256: "a".repeat(64),
          bytes: 1,
        },
      ],
      dependencies,
      baseline: SUPPORTED_AUDIO_BASELINE,
    }),
  );
}
function environment(
  root: string,
  output: string[],
  errors: string[],
): AcceptanceCliEnvironment {
  return { root, output: (s) => output.push(s), error: (s) => errors.push(s) };
}
async function receipt(root: string, name = "receipt.json") {
  const [run] = await readdir(join(root, ".test-artifacts/acceptance"));
  const directory = join(root, ".test-artifacts/acceptance", run!);
  return {
    directory,
    value: JSON.parse(
      await readFile(join(directory, name), "utf8"),
    ) as RecordedReceipt,
  };
}
interface RecordedReceipt {
  result: RunResult;
  events: LifecycleEvent[];
  finalizationEvents: LifecycleEvent[];
  retention: { pruned: boolean };
  finalization: string;
  droppedEvents: number;
}
interface RecordedDiagnostic {
  evidenceDirectory: string;
  recoveryEvidence: RecordedReceipt;
  finalizationEvent: LifecycleEvent;
}
type Mode =
  "passed" | "failed" | "cancelled" | "cleanup-failed" | "profile-left";
function fakeBoundary(mode: Mode = "passed") {
  let directory = "";
  const unexpected = vi.fn(async () => {
    throw new Error("Real driver boundary must never execute");
  });
  const driver = {
    schemaVersion: 1 as const,
    capabilities: [],
    launch: unexpected,
    ready: unexpected,
    subscribe: unexpected,
    readBaseline: unexpected,
    submit: unexpected,
    collect: unexpected,
    provision: vi.fn<NonNullable<AcceptanceCliDriver["provision"]>>(
      async () => {
        throw new Error(
          "Controlled run must explicitly model dependency provisioning",
        );
      },
    ),
    cleanup: vi.fn(async () => {
      if (mode === "cleanup-failed")
        throw new Error("Owned process has not exited");
      if (mode !== "profile-left")
        await rm(join(directory, "profile"), { recursive: true });
    }),
    preservationPaths: () =>
      new Set(["dependencies/machine-listening/device.amxd"]),
  } satisfies AcceptanceCliDriver;
  const createDriver = vi.fn((options: { runDirectory: string }) => {
    directory = options.runDirectory;
    return driver;
  });
  const stage = vi.fn<
    NonNullable<NonNullable<AcceptanceCliEnvironment["dependencies"]>["stage"]>
  >(async (options) => {
    const workingDirectory = join(options.workingRoot, "case-offline");
    await mkdir(join(workingDirectory, "dependencies/machine-listening"), {
      recursive: true,
    });
    await writeFile(
      join(workingDirectory, "dependencies/machine-listening/device.amxd"),
      "inert dependency marker",
    );
    await writeFile(
      join(workingDirectory, "unreviewed.txt"),
      "not retained after confirmed cleanup",
    );
    return {
      workingDirectory,
      projectPath: join(workingDirectory, "project.als"),
      resources: options.fixture.resources,
      verifySourceUnchanged: async () => {},
    };
  });
  const run = vi.fn<
    NonNullable<NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]>
  >(async (options) => {
    const context: DriverContext = {
      runId: "offline-run",
      traceId: "offline-trace",
      correlationId: "offline-run",
      causationId: "offline-stage",
      signal: options.signal!,
      deadlineAt: Date.now() + 1000,
      scenario: options.scenario,
      fixture: options.fixture,
    };
    await options.stage(context);
    await mkdir(join(directory, "profile"));
    await writeFile(
      join(directory, "profile/credential.txt"),
      "isolated fake credential",
    );
    options.event?.({
      schemaVersion: 1,
      runId: context.runId,
      traceId: context.traceId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      stage: "run",
      phase: "started",
      timestamp: 100,
      durationMs: 0,
    });
    const cancelled = mode === "cancelled" || options.signal?.aborted;
    const result: RunResult = {
      schemaVersion: 1,
      runId: context.runId,
      traceId: context.traceId,
      scenarioId: "example",
      fixtureId: "example",
      status: cancelled ? "cancelled" : mode === "failed" ? "failed" : "passed",
      startedAt: 100,
      completedAt: 110,
      durationMs: 10,
      selected: ["first", "second"],
      executed: cancelled
        ? []
        : mode === "failed"
          ? ["first"]
          : ["first", "second"],
      unrun: cancelled
        ? ["first", "second"]
        : mode === "failed"
          ? ["second"]
          : [],
      assertions:
        cancelled || mode === "failed"
          ? []
          : [
              {
                name: "capture-count",
                passed: true,
                code: "count-matched",
                detail: "No captures expected",
              },
            ],
      turns: [],
      finalizationFailures: [],
      cleanupComplete: true,
      persisted: true,
      ...(cancelled || mode === "failed"
        ? {
            primaryFailure: {
              stage: "submit.first",
              message: cancelled ? "Cancelled" : "Denied",
            },
          }
        : {}),
    };
    let candidate = result;
    try {
      await options.driver.cleanup(context);
    } catch {
      candidate = {
        ...candidate,
        status: "finalization-failed",
        cleanupComplete: false,
        finalizationFailures: [
          { stage: "cleanup", message: "Owned process has not exited" },
        ],
      };
    }
    try {
      await options.persist(candidate, context);
    } catch {
      candidate = {
        ...candidate,
        status: "finalization-failed",
        persisted: false,
        finalizationFailures: [
          ...candidate.finalizationFailures,
          { stage: "persistence", message: "Checkpoint write failed" },
        ],
      };
    }
    return candidate;
  });
  return { driver, dependencies: { createDriver, run, stage } };
}

describe("acceptance catalog admission", () => {
  it("passes bounded timing diagnostics explicitly to the shared real driver", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      expect(
        await acceptanceCli(
          ["run", "--scenario", "example", "--bridge-read-min-ms", "550"],
          {
            ...environment(root, output, errors),
            dependencies: fake.dependencies,
          },
        ),
      ).toBe(0);
      expect(fake.dependencies.createDriver).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeReadMinimumMs: 550 }),
      );
      expect((await receipt(root)).value).toMatchObject({
        diagnostic: { kind: "real-bridge-read-pacing", minimumReadMs: 550 },
      });
    });
  });
  it("resolves the actual Node entrypoint's dynamic driver aliases before rejecting absent assets", async () => {
    await fixture(async (root) => {
      await register(root, "reviewed-live", []);
      await mkdir(join(root, "scripts"));
      await writeFile(
        join(root, "scripts/acceptance.mjs"),
        await readFile(resolve("scripts/acceptance.mjs")),
      );
      await symlink(resolve("scripts/lib"), join(root, "scripts/lib"));
      await writeFile(
        join(root, "tsconfig.test-runtime.json"),
        JSON.stringify({ extends: resolve("tsconfig.test-runtime.json") }),
      );
      // No project/media exists: the real coordinator must stop at staging, before launch.
      const child = spawnSync(
        process.execPath,
        [join(root, "scripts/acceptance.mjs"), "run", "--scenario", "example"],
        { encoding: "utf8", timeout: 15_000, cwd: root },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(1);
      const { directory, value } = await receipt(root);
      expect(value.result, JSON.stringify(value)).toMatchObject({
        status: "failed",
        primaryFailure: { stage: "stage" },
        selected: ["first", "second"],
        executed: [],
        unrun: ["first", "second"],
        cleanupComplete: true,
        persisted: true,
      });
      expect(value.events.filter((event) => event.stage === "launch")).toEqual(
        [],
      );
      expect(await readdir(directory)).toEqual([
        "checkpoint.json",
        "product-evidence.json",
        "receipt.json",
      ]);
    });
  });

  it("reports an empty catalog without implying that tests ran", async () => {
    await fixture(async (root, output, errors) => {
      const env = environment(root, output, errors);
      expect(await acceptanceCli(["list"], env)).toBe(0);
      expect(await acceptanceCli(["validate"], env)).toBe(0);
      expect(output.map((s) => JSON.parse(s) as unknown)).toEqual([
        {
          kind: "acceptance-catalog",
          scenarios: [],
          count: 0,
          state: "awaiting-joint-fixture-onboarding",
        },
        {
          kind: "catalog-validation",
          count: 0,
          state: "awaiting-joint-fixture-onboarding",
          executed: false,
        },
      ]);
      expect(errors).toEqual([]);
      expect(await readdir(root)).toEqual(["integration"]);
    });
  });

  it("writes exact unregistered admission evidence and reports its path", async () => {
    await fixture(async (root, output, errors) => {
      const fake = fakeBoundary();
      expect(
        await acceptanceCli(["run", "--scenario", "not-registered"], {
          ...environment(root, output, errors),
          dependencies: fake.dependencies,
        }),
      ).toBe(1);
      const { directory, value } = await receipt(root);
      expect(value).toEqual({
        schema: "acceptance-run/v1",
        completionOwner: "acceptance-cli",
        eventsScope: "coordinator",
        coordinatorEventsDoNotDetermineVerdict: true,
        finalization: "final",
        status: "failed",
        message: "Scenario is not registered: not-registered",
        events: [],
        droppedEvents: 0,
        admitted: false,
        selectionScope: "scenarios",
        selected: ["not-registered"],
        executed: [],
        unrun: ["not-registered"],
      });
      expect(JSON.parse(errors[0]!)).toMatchObject({
        receiptPath: join(directory, "receipt.json"),
        selected: ["not-registered"],
        executed: [],
        unrun: ["not-registered"],
      });
      expect(fake.dependencies.createDriver).not.toHaveBeenCalled();
      expect(fake.dependencies.run).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["run"],
    ["list", "--scenario", "x"],
    ["list", "extra"],
    ["validate", "--template", "../../bad.json"],
    ["run", "--scenario", "x", "--scenario", "x"],
    ["run", "--approve-all"],
    ["run", "--scenario"],
    ["run", "--scenario", "--live-app"],
    ["run", "--scenario", "-x"],
    ["run", "--scenario", "../x"],
    ["run", "--scenario", " x"],
    ["run", "--scenario", "x", "--executable", ""],
    ["run", "--scenario=x"],
    ["run", "--scenario", "x", "--live-app", "-bad"],
    ["validate", "--scenario", "x", "--template", "x"],
    ["validate", "--executable", "x"],
    [
      "validate",
      "--template",
      "integration/acceptance-scenarios/templates/../templates/x.json",
    ],
    ["run", "--scenario", "x", "--executable", "x\0y"],
    ...["0", "1001", "0.5", "NaN", "0500"].map((minimum) => [
      "run",
      "--scenario",
      "x",
      "--bridge-read-min-ms",
      minimum,
    ]),
  ])("rejects unsafe or ambiguous arguments %j", async (...args) => {
    await fixture(async (root, output, errors) => {
      expect(await acceptanceCli(args, environment(root, output, errors))).toBe(
        1,
      );
      expect(errors).toHaveLength(1);
      expect(await readdir(root)).toEqual(["integration"]);
    });
  });

  it("denies synthetic registration before constructing a host driver", async () => {
    await fixture(async (root, output, errors) => {
      await register(root, "synthetic-only");
      const fake = fakeBoundary();
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: fake.dependencies,
        }),
      ).toBe(1);
      expect(fake.dependencies.createDriver).not.toHaveBeenCalled();
      expect((await receipt(root)).value).toMatchObject({
        admitted: false,
        executed: [],
        unrun: ["example"],
      });
    });
  });

  it.each([
    { schemaVersion: 1, scenarios: ["example", "example"] },
    { schemaVersion: 1, scenarios: ["../example"] },
    { schemaVersion: 2, scenarios: [] },
    { schemaVersion: 1, scenarios: [], unexpected: true },
    {
      schemaVersion: 1,
      scenarios: Array.from({ length: 257 }, (_, i) => `example-${i}`),
    },
  ])("rejects malformed or oversized catalogs", async (catalog) => {
    await fixture(async (root, output, errors) => {
      await writeFile(
        join(root, "integration/acceptance-scenarios/suite.json"),
        JSON.stringify(catalog),
      );
      expect(
        await acceptanceCli(["list"], environment(root, output, errors)),
      ).toBe(1);
      expect(output).toEqual([]);
      expect(await readdir(root)).toEqual(["integration"]);
    });
  });

  it("rejects hard-linked manifest ownership", async () => {
    await fixture(async (root, output, errors) => {
      await link(
        join(root, "integration/acceptance-scenarios/suite.json"),
        join(root, "other.json"),
      );
      expect(
        await acceptanceCli(["list"], environment(root, output, errors)),
      ).toBe(1);
      expect(errors[0]).toContain("singly-owned");
    });
  });

  it.each([
    "suite.json",
    "scenario-directory",
    "fixture-directory",
    "root",
    "artifact-ancestor",
  ])(
    "rejects symlinks at %s without launching or writing through them",
    async (location) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        let runRoot = root;
        const path =
          location === "suite.json"
            ? join(root, "integration/acceptance-scenarios/suite.json")
            : location === "scenario-directory"
              ? join(root, "integration/acceptance-scenarios")
              : location === "fixture-directory"
                ? join(root, "integration/fixtures")
                : location === "artifact-ancestor"
                  ? join(root, ".test-artifacts")
                  : join(root, "alias");
        if (location === "root") {
          await symlink(root, path);
          runRoot = path;
        } else if (location === "artifact-ancestor") {
          await mkdir(join(root, "untouched"));
          await symlink(join(root, "untouched"), path);
        } else {
          await rename(path, `${path}.original`);
          await symlink(`${path}.original`, path);
        }
        const fake = fakeBoundary();
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            ...environment(runRoot, output, errors),
            dependencies: fake.dependencies,
          }),
        ).toBe(1);
        expect(errors.join("\n")).toContain("Symlink");
        expect(fake.dependencies.createDriver).not.toHaveBeenCalled();
        if (location === "artifact-ancestor")
          expect(await readdir(join(root, "untouched"))).toEqual([]);
      });
    },
  );

  it("rejects a template reached through a symlink ancestor", async () => {
    await fixture(async (root, output, errors) => {
      await mkdir(join(root, "untrusted"));
      await writeFile(join(root, "untrusted/example.json"), "{}");
      await symlink(
        join(root, "untrusted"),
        join(root, "integration/acceptance-scenarios/templates"),
      );
      expect(
        await acceptanceCli(
          [
            "validate",
            "--template",
            "integration/acceptance-scenarios/templates/example.json",
          ],
          environment(root, output, errors),
        ),
      ).toBe(1);
      expect(errors[0]).toContain("Symlink");
    });
  });

  it("validates the checked-in template without admitting it as runnable", async () => {
    const template: unknown = JSON.parse(
      await readFile(
        "integration/acceptance-scenarios/templates/session-clip-identify.json",
        "utf8",
      ),
    );
    expect(template).toMatchObject({
      fixture: {
        qualification: "synthetic-only",
        baseline: { tempo: 128 },
        sources: [{ id: "a", trackName: "audio-track", clipName: "clip-1" }],
      },
      scenario: {
        steps: [
          {
            message: "Listen to the first Session clip on track audio-track.",
            assertions: [
              {
                name: "capture",
                parameters: { sampleRate: 48000, expectedFrames: 90000 },
              },
              { name: "context" },
            ],
          },
          {
            assertions: [
              { name: "choice", parameters: { expected: "B" } },
              { name: "no-capture" },
              { name: "context" },
            ],
          },
        ],
      },
    });
    const output: string[] = [],
      errors: string[] = [];
    expect(
      await acceptanceCli(
        [
          "validate",
          "--template",
          "integration/acceptance-scenarios/templates/session-clip-identify.json",
        ],
        environment(process.cwd(), output, errors),
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schemaValid: true,
      runnable: false,
    });
  });

  it("validates reviewed resources offline and removes only its validation copy", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const path = join(root, "integration/acceptance-scenarios/example.json");
      const scenario = JSON.parse(await readFile(path, "utf8")) as {
        requiredCapabilities: string[];
      };
      scenario.requiredCapabilities = ["session-audio", "session-midi"];
      await writeFile(path, JSON.stringify(scenario));
      const fake = fakeBoundary();
      expect(
        await acceptanceCli(["validate", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: fake.dependencies,
        }),
      ).toBe(0);
      expect(fake.dependencies.createDriver).not.toHaveBeenCalled();
      expect(await readdir(join(root, ".test-artifacts/acceptance"))).toEqual(
        [],
      );
      expect(JSON.parse(output[0]!)).toEqual({
        kind: "fixture-validation",
        scenario: "example",
        admitted: true,
        executed: false,
      });
    });
  });

  it("bounds retained artifacts without deleting old or unrelated evidence", async () => {
    await fixture(async (root, output, errors) => {
      const parent = join(root, ".test-artifacts/acceptance");
      await mkdir(parent, { recursive: true });
      for (let i = 0; i < 16; i++)
        await writeFile(join(parent, `unrelated-${i}.txt`), "keep");
      const fake = fakeBoundary();
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: fake.dependencies,
        }),
      ).toBe(1);
      expect(await readdir(parent)).toHaveLength(16);
      expect(errors.join("\n")).toContain("retention limit");
      expect(fake.dependencies.run).not.toHaveBeenCalled();
    });
  });

  it("rejects byte-budget exhaustion without deleting retained artifacts", async () => {
    await fixture(async (root, output, errors) => {
      const parent = join(root, ".test-artifacts/acceptance");
      await mkdir(parent, { recursive: true });
      const retained = await open(join(parent, "retained.txt"), "wx");
      try {
        await retained.truncate(2 * 1024 * 1024 * 1024);
      } finally {
        await retained.close();
      }
      expect(
        await acceptanceCli(
          ["run", "--scenario", "example"],
          environment(root, output, errors),
        ),
      ).toBe(1);
      expect(await readdir(parent)).toEqual(["retained.txt"]);
      expect(errors.join("\n")).toContain("byte retention limit");
    });
  });

  it("never removes or bypasses another allocator's admission lock", async () => {
    await fixture(async (root, output, errors) => {
      const lock = join(root, ".test-artifacts/acceptance/.admission-lock");
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, "owner.txt"), "another allocator");
      expect(
        await acceptanceCli(
          ["run", "--scenario", "example"],
          environment(root, output, errors),
        ),
      ).toBe(1);
      expect(await readFile(join(lock, "owner.txt"), "utf8")).toBe(
        "another allocator",
      );
      expect(errors.join("\n")).toContain("admission is locked");
    });
  });
});

describe("acceptance CLI finalization (injected offline boundary)", () => {
  it("forwards the driver's receiver, context, and complete multi-resource dependency inventory", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const inventory: DependencyInventory = {
        schemaVersion: 1,
        candidateRoot: join(root, "candidate"),
        resources: [
          {
            id: "machine-listening",
            path: "machine-listening/device.amxd",
            target: "dependencies/machine-listening/device.amxd",
            sha256: "a".repeat(64),
            bytes: 24,
          },
          {
            id: "machine-listening",
            path: "machine-listening/helper.js",
            target: "dependencies/machine-listening/helper.js",
            sha256: "b".repeat(64),
            bytes: 32,
          },
        ],
      };
      let received: DriverContext | undefined;
      fake.driver.provision.mockImplementation(function (
        this: AcceptanceCliDriver,
        context,
      ) {
        expect(this).toBe(fake.driver);
        received = context;
        return Promise.resolve(inventory);
      });
      const run: NonNullable<
        NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
      > = async (options) => {
        const context: DriverContext = {
          runId: "offline-run",
          traceId: "offline-trace",
          correlationId: "offline-run",
          causationId: "offline-provision",
          signal: options.signal!,
          deadlineAt: 12345,
          scenario: options.scenario,
          fixture: options.fixture,
        };
        expect(options.provision).toBeTypeOf("function");
        expect(await options.provision!(context)).toBe(inventory);
        expect(received).toBe(context);
        return fake.dependencies.run(options);
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, run },
        }),
      ).toBe(0);
      expect(fake.driver.provision).toHaveBeenCalledOnce();
      expect(fake.driver.launch).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });
  });

  it("denies declared dependencies without a provisioning hook before invoking the coordinator", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const driver: AcceptanceCliDriver = { ...fake.driver };
      delete driver.provision;
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, createDriver: () => driver },
        }),
      ).toBe(1);
      expect((await receipt(root)).value).toMatchObject({
        admitted: false,
        selected: ["example"],
        executed: [],
        unrun: ["example"],
        message:
          "Declared dependencies require explicit candidate provisioning",
      });
      expect(fake.dependencies.run).not.toHaveBeenCalled();
      expect(fake.driver.launch).not.toHaveBeenCalled();
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "forwards provisioning %s without masking the cause or cancellation signal",
    async (mode) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        const fake = fakeBoundary(mode);
        const abort = new AbortController();
        const reason = new Error(
          mode === "cancelled" ? "Provision cancelled" : "Provision denied",
        );
        fake.driver.provision.mockRejectedValue(reason);
        const failed = (candidate: RunResult): RunResult => ({
          ...candidate,
          executed: [],
          unrun: ["first", "second"],
          primaryFailure: { stage: "provision", message: reason.message },
        });
        const run: NonNullable<
          NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
        > = async (options) => {
          if (mode === "cancelled") abort.abort(reason);
          const context: DriverContext = {
            runId: "offline-run",
            traceId: "offline-trace",
            correlationId: "offline-run",
            causationId: "offline-provision",
            signal: options.signal!,
            deadlineAt: 12345,
            scenario: options.scenario,
            fixture: options.fixture,
          };
          await expect(options.provision!(context)).rejects.toBe(reason);
          expect(context.signal.aborted).toBe(mode === "cancelled");
          if (mode === "cancelled") expect(context.signal.reason).toBe(reason);
          return failed(
            await fake.dependencies.run({
              ...options,
              persist: (candidate, persistenceContext) =>
                options.persist(failed(candidate), persistenceContext),
            }),
          );
        };
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            ...environment(root, output, errors),
            signal: abort.signal,
            dependencies: { ...fake.dependencies, run },
          }),
        ).toBe(1);
        const { directory, value } = await receipt(root);
        expect(value.result).toMatchObject({
          status: mode,
          primaryFailure: { stage: "provision", message: reason.message },
          cleanupComplete: true,
          selected: ["first", "second"],
          executed: [],
          unrun: ["first", "second"],
        });
        expect(fake.driver.provision).toHaveBeenCalledOnce();
        expect(fake.driver.cleanup).toHaveBeenCalledOnce();
        expect(fake.driver.launch).not.toHaveBeenCalled();
        expect(await readdir(directory)).not.toContain("profile");
      });
    },
  );

  it("keeps bounded redacted late callbacks observable without changing finalized failure evidence", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary("cleanup-failed");
      let emit: ((event: LifecycleEvent) => void) | undefined;
      const run: NonNullable<
        NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
      > = async (options) => {
        emit = options.event;
        return fake.dependencies.run(options);
      };
      const secret = `ghp_${"a".repeat(36)}`;
      const late: LifecycleEvent = {
        schemaVersion: 1,
        runId: "offline-run",
        traceId: "offline-trace",
        correlationId: "offline-run",
        causationId: secret,
        stage: "late.cleanup",
        phase: "completed",
        timestamp: 200,
        durationMs: 90,
      };
      const writeReceipt = async (path: string, value: unknown) => {
        await writeScenarioReceipt(path, value);
        if (path.endsWith("/receipt.json"))
          emit?.({ ...late, phase: "started" });
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, run, writeReceipt },
        }),
      ).toBe(1);
      const { directory, value } = await receipt(root);
      const before = await readFile(join(directory, "receipt.json"), "utf8");
      expect(value.result).toMatchObject({
        status: "finalization-failed",
        cleanupComplete: false,
      });
      expect(value.retention.pruned).toBe(false);
      expect(value.events).toHaveLength(1);
      for (let i = 0; i < 80; i++)
        await expect(
          Promise.resolve().then(() => emit?.(late)),
        ).resolves.toBeUndefined();
      const diagnostics = output
        .map(
          (line) =>
            JSON.parse(line) as {
              kind?: string;
              receiptUnchanged?: boolean;
              maximumEvents?: number;
              event?: LifecycleEvent;
            },
        )
        .filter((line) => line.kind?.startsWith("acceptance-late-"));
      expect(diagnostics).toHaveLength(65);
      expect(diagnostics[0]).toMatchObject({
        kind: "acceptance-late-lifecycle",
        receiptUnchanged: true,
        event: {
          stage: "late.cleanup",
          phase: "started",
          traceId: "offline-trace",
        },
      });
      expect(diagnostics[1]).toMatchObject({
        kind: "acceptance-late-lifecycle",
        receiptUnchanged: true,
        event: { stage: "late.cleanup", phase: "completed", durationMs: 90 },
      });
      expect(diagnostics.at(-1)).toMatchObject({
        kind: "acceptance-late-events-truncated",
        maximumEvents: 64,
      });
      expect(output.join("\n")).not.toContain(secret);
      expect(await readFile(join(directory, "receipt.json"), "utf8")).toBe(
        before,
      );
      expect(
        await readFile(join(directory, "case-offline/unreviewed.txt"), "utf8"),
      ).toContain("not retained");
      expect(await readdir(join(directory, "profile"))).toEqual([
        "credential.txt",
      ]);
      expect(fake.driver.cleanup).toHaveBeenCalledOnce();
      expect(errors).toEqual([]);
    });
  });

  it.each([false, true])(
    "never rejects late cleanup when stdout fails (stderr also fails: %s)",
    async (stderrFails) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        const fake = fakeBoundary("cleanup-failed");
        let emit: ((event: LifecycleEvent) => void) | undefined;
        const run: NonNullable<
          NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
        > = async (options) => {
          emit = options.event;
          return fake.dependencies.run(options);
        };
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            root,
            output: (line) => {
              if (line.includes("acceptance-late-"))
                throw new Error("Late stdout unavailable");
              output.push(line);
            },
            error: (line) => {
              if (stderrFails) throw new Error("Late stderr unavailable");
              errors.push(line);
            },
            dependencies: { ...fake.dependencies, run },
          }),
        ).toBe(1);
        await expect(
          Promise.resolve().then(() =>
            emit?.({
              schemaVersion: 1,
              runId: "offline-run",
              traceId: "offline-trace",
              correlationId: "offline-run",
              causationId: "late-cleanup",
              stage: "late.cleanup",
              phase: "completed",
              timestamp: 200,
              durationMs: 90,
            }),
          ),
        ).resolves.toBeUndefined();
        expect(output).toHaveLength(1);
        if (stderrFails) expect(errors).toEqual([]);
        else
          expect(JSON.parse(errors[0]!) as unknown).toMatchObject({
            kind: "acceptance-late-diagnostic-failed",
            receiptUnchanged: true,
            message: "Late stdout unavailable",
          });
        expect((await receipt(root)).value.result).toMatchObject({
          status: "finalization-failed",
          cleanupComplete: false,
        });
      });
    },
  );

  it("reports bounded causal evidence to stderr when every receipt write fails", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary("failed");
      const writeReceipt = async () => {
        throw new Error("Storage unavailable");
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, writeReceipt },
        }),
      ).toBe(1);
      const diagnostic = JSON.parse(errors[1]!) as RecordedDiagnostic;
      expect(diagnostic).toMatchObject({
        primaryFailure: { stage: "submit.first", message: "Denied" },
        selected: ["first", "second"],
        executed: ["first"],
        unrun: ["second"],
        recoveryEvidence: {
          result: {
            status: "finalization-failed",
            persisted: false,
            primaryFailure: { message: "Denied" },
            finalizationFailures: [
              { stage: "persistence", message: "Checkpoint write failed" },
              { stage: "receipt-finalization", message: "Storage unavailable" },
            ],
          },
        },
      });
      expect(diagnostic.recoveryEvidence.events).toHaveLength(1);
      expect(
        await readFile(
          join(diagnostic.evidenceDirectory, "case-offline/unreviewed.txt"),
          "utf8",
        ),
      ).toContain("not retained");
      expect(output).toEqual([]);
    });
  });

  it.each([
    { cleanupComplete: false },
    { persisted: false },
    { executed: ["first"], unrun: ["second"] },
    { assertions: [] },
  ])("rejects inconsistent passed results before pruning", async (changes) => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const run: NonNullable<
        NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
      > = async (options) => ({
        ...(await fake.dependencies.run(options)),
        ...changes,
      });
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, run },
        }),
      ).toBe(1);
      const { directory, value } = await receipt(root, "recovery.json");
      expect(value.result).toMatchObject({
        status: "finalization-failed",
        persisted: false,
      });
      expect(
        await readFile(join(directory, "case-offline/unreviewed.txt"), "utf8"),
      ).toContain("not retained");
      expect(output).toEqual([]);
    });
  });

  it("uses the real coordinator to deny missing assets before any host launch", async () => {
    await fixture(async (root, output, errors) => {
      await register(root, "reviewed-live", []);
      const fake = fakeBoundary();
      fake.driver.cleanup = vi.fn(async () => {});
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: {
            createDriver: (options) => {
              const driver: AcceptanceCliDriver = {
                ...fake.dependencies.createDriver(options),
              };
              delete driver.provision;
              return driver;
            },
          },
        }),
      ).toBe(1);
      const { value } = await receipt(root);
      expect(value.result, JSON.stringify(value)).toMatchObject({
        status: "failed",
        selected: ["first", "second"],
        executed: [],
        unrun: ["first", "second"],
        primaryFailure: { stage: "stage" },
        cleanupComplete: true,
        persisted: true,
      });
      expect(fake.driver.launch).not.toHaveBeenCalled();
      expect(fake.driver.cleanup).toHaveBeenCalledOnce();
    });
  });

  it.each(["passed", "failed", "cancelled"] as const)(
    "retains only reviewed files after %s and records exact outcome",
    async (mode) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        const fake = fakeBoundary(mode);
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            ...environment(root, output, errors),
            dependencies: fake.dependencies,
          }),
        ).toBe(mode === "passed" ? 0 : 1);
        const { directory, value } = await receipt(root);
        expect(value.result).toEqual({
          schemaVersion: 1,
          runId: "offline-run",
          traceId: "offline-trace",
          scenarioId: "example",
          fixtureId: "example",
          status: mode,
          startedAt: 100,
          completedAt: 110,
          durationMs: 10,
          selected: ["first", "second"],
          executed:
            mode === "cancelled"
              ? []
              : mode === "failed"
                ? ["first"]
                : ["first", "second"],
          unrun:
            mode === "cancelled"
              ? ["first", "second"]
              : mode === "failed"
                ? ["second"]
                : [],
          assertions:
            mode !== "passed"
              ? []
              : [
                  {
                    name: "capture-count",
                    passed: true,
                    code: "count-matched",
                    detail: "No captures expected",
                  },
                ],
          turns: [],
          finalizationFailures: [],
          cleanupComplete: true,
          persisted: true,
          ...(mode === "passed"
            ? {}
            : {
                primaryFailure: {
                  stage: "submit.first",
                  message: mode === "cancelled" ? "Cancelled" : "Denied",
                },
              }),
        });
        expect(value.events).toHaveLength(1);
        expect(value.retention.pruned).toBe(true);
        expect(value.retention).toMatchObject({
          policy: "reviewed-allowlist-no-automatic-expiry",
          omissions: [{ path: "unreviewed.txt", kind: "file" }],
        });
        expect(
          value.finalizationEvents.map(
            (event: { stage: string; phase: string }) =>
              `${event.stage}:${event.phase}`,
          ),
        ).toEqual([
          "artifact-retention:queued",
          "artifact-retention:started",
          "artifact-retention:completed",
          "receipt-finalization:queued",
          "receipt-finalization:started",
        ]);
        for (const event of value.finalizationEvents) {
          expect(event).toMatchObject({
            runId: "offline-run",
            traceId: "offline-trace",
            correlationId: "offline-run",
          });
          expect(event.durationMs).toBeGreaterThanOrEqual(0);
        }
        expect(
          (JSON.parse(output[0]!) as RecordedDiagnostic).finalizationEvent,
        ).toMatchObject({
          stage: "receipt-finalization",
          phase: "completed",
          runId: "offline-run",
        });
        expect(await readdir(directory)).toEqual([
          "case-offline",
          "checkpoint.json",
          "receipt.json",
        ]);
        expect(await readdir(join(directory, "case-offline"))).toEqual([
          "dependencies",
        ]);
        expect(
          await readFile(
            join(
              directory,
              "case-offline/dependencies/machine-listening/device.amxd",
            ),
            "utf8",
          ),
        ).toBe("inert dependency marker");
        expect((await receipt(root, "checkpoint.json")).value).toMatchObject({
          finalization: "checkpoint",
          finalReceiptRequired: true,
          result: { persisted: false },
        });
        expect(fake.driver.launch).not.toHaveBeenCalled();
        expect(errors).toEqual([]);
      });
    },
  );

  it.each(["cleanup-failed", "profile-left"] as const)(
    "does not prune any files when %s",
    async (mode) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        const fake = fakeBoundary(mode);
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            ...environment(root, output, errors),
            dependencies: fake.dependencies,
          }),
        ).toBe(1);
        const { directory, value } = await receipt(root);
        expect(value.result).toMatchObject({
          status: "finalization-failed",
          cleanupComplete: false,
        });
        expect(value.retention.pruned).toBe(false);
        expect(value.retention).toMatchObject({ omissions: [] });
        expect(
          await readFile(
            join(directory, "case-offline/unreviewed.txt"),
            "utf8",
          ),
        ).toContain("not retained");
        expect(await readdir(join(directory, "profile"))).toEqual([
          "credential.txt",
        ]);
      });
    },
  );

  it("preserves causal evidence when final persistence fails, without reporting a pass", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const run: NonNullable<
        NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
      > = async (options) => {
        const result = await fake.dependencies.run(options);
        options.event?.({
          schemaVersion: 1,
          runId: result.runId,
          traceId: result.traceId,
          correlationId: result.runId,
          causationId: "coordinator-completed",
          stage: "run",
          phase: "completed",
          timestamp: 110,
          durationMs: 10,
        });
        return result;
      };
      const writeReceipt = vi.fn(async (path: string, value: unknown) => {
        if (path.endsWith("/receipt.json"))
          throw new Error("Final receipt unavailable");
        await writeScenarioReceipt(path, value);
      });
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, run, writeReceipt },
        }),
      ).toBe(1);
      const { directory, value } = await receipt(root, "recovery.json");
      expect(value.result).toMatchObject({
        status: "finalization-failed",
        persisted: false,
        cleanupComplete: true,
        selected: ["first", "second"],
        executed: ["first", "second"],
        unrun: [],
        finalizationFailures: [
          {
            stage: "receipt-finalization",
            message: "Final receipt unavailable",
          },
        ],
      });
      expect(value).toMatchObject({
        completionOwner: "acceptance-cli",
        eventsScope: "coordinator",
        coordinatorEventsDoNotDetermineVerdict: true,
        retention: { omissions: [{ path: "unreviewed.txt", kind: "file" }] },
      });
      expect(value.events).toHaveLength(2);
      expect(value.events.at(-1)).toMatchObject({
        stage: "run",
        phase: "completed",
      });
      expect(value.finalizationEvents.at(-1)).toMatchObject({
        stage: "receipt-finalization",
        phase: "failed",
      });
      expect(
        await readFile(
          join(
            directory,
            "case-offline/dependencies/machine-listening/device.amxd",
          ),
          "utf8",
        ),
      ).toContain("inert");
      expect((await receipt(root, "checkpoint.json")).value.finalization).toBe(
        "checkpoint",
      );
      expect(output).toEqual([]);
      expect(JSON.parse(errors[0]!)).toMatchObject({
        status: "finalization-failed",
        recoveryPath: join(directory, "recovery.json"),
        checkpointPath: join(directory, "checkpoint.json"),
        executed: ["first", "second"],
        unrun: [],
      });
    });
  });

  it("preserves the working tree when checkpoint persistence fails", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary("failed");
      const writeReceipt = async (path: string, value: unknown) => {
        if (path.endsWith("/checkpoint.json"))
          throw new Error("Checkpoint unavailable");
        await writeScenarioReceipt(path, value);
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, writeReceipt },
        }),
      ).toBe(1);
      const { directory, value } = await receipt(root);
      expect(value.result).toMatchObject({
        status: "finalization-failed",
        persisted: false,
        primaryFailure: { message: "Denied" },
        finalizationFailures: [
          { stage: "persistence", message: "Checkpoint write failed" },
        ],
      });
      expect(value.retention.pruned).toBe(false);
      expect(
        await readFile(join(directory, "case-offline/unreviewed.txt"), "utf8"),
      ).toContain("not retained");
      expect(await readdir(directory)).not.toContain("profile");
    });
  });

  it("reports checkpoint and exact execution truth even when both final writes fail", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary("failed");
      const writeReceipt = async (path: string, value: unknown) => {
        if (!path.endsWith("/checkpoint.json"))
          throw new Error("All final persistence unavailable");
        await writeScenarioReceipt(path, value);
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, writeReceipt },
        }),
      ).toBe(1);
      const { directory, value } = await receipt(root, "checkpoint.json");
      expect(value.result.primaryFailure).toEqual({
        stage: "submit.first",
        message: "Denied",
      });
      expect(JSON.parse(errors[1]!)).toMatchObject({
        checkpointPath: join(directory, "checkpoint.json"),
        status: "finalization-failed",
        executed: ["first"],
        unrun: ["second"],
      });
      expect(output).toEqual([]);
    });
  });

  it.each(["passed", "failed", "cancelled"] as const)(
    "retains the declared prepared Set after %s without retaining the profile",
    async (mode) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        const path = join(root, "integration/fixtures/example/fixture.json");
        const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
        validateFixture(manifest);
        await writeFile(
          path,
          JSON.stringify({
            ...manifest,
            listenerBindings: [
              {
                slot: "AudioTrack:175/DeviceChain/DeviceChain/Devices/MxDeviceAudioEffect:0",
                sourcePath: "Presets/Listener.amxd",
                dependency: "machine-listening",
                trackIndex: 0,
                deviceIndex: 0,
              },
            ],
          }),
        );
        const fake = fakeBoundary(mode);
        const stage = fake.dependencies.stage;
        fake.driver.preservationPaths = () =>
          new Set([
            "prepared.als",
            "dependencies/machine-listening/device.amxd",
          ]);
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            ...environment(root, output, errors),
            dependencies: {
              ...fake.dependencies,
              stage: async (options) => {
                const staged = await stage(options);
                await writeFile(
                  join(staged.workingDirectory, "prepared.als"),
                  "inert derived Set; not real host evidence",
                );
                return staged;
              },
            },
          }),
        ).toBe(mode === "passed" ? 0 : 1);
        const { directory, value } = await receipt(root);
        expect(value.result.status).toBe(mode);
        expect(value.retention.pruned).toBe(true);
        expect(
          await readFile(join(directory, "case-offline/prepared.als"), "utf8"),
        ).toContain("inert derived Set");
        expect(await readdir(directory)).not.toContain("profile");
        const events = value.finalizationEvents.filter(
          (event) => event.stage === "artifact-retention",
        );
        expect(events.map((event) => event.phase)).toEqual([
          "queued",
          "started",
          "completed",
        ]);
        expect(
          events.every((event) => event.traceId === value.result.traceId),
        ).toBe(true);
      });
    },
  );

  it.each(["../profile/credential.txt", "prepared.als"])(
    "rejects undeclared preservation of %s without pruning the working copy",
    async (path) => {
      await fixture(async (root, output, errors) => {
        await register(root);
        const fake = fakeBoundary();
        fake.driver.preservationPaths = () => new Set([path]);
        expect(
          await acceptanceCli(["run", "--scenario", "example"], {
            ...environment(root, output, errors),
            dependencies: fake.dependencies,
          }),
        ).toBe(1);
        const { directory, value } = await receipt(root);
        expect(value.result).toMatchObject({
          status: "finalization-failed",
          finalizationFailures: [
            {
              stage: "artifact-retention",
              message: "Driver preservation path is not a declared dependency",
            },
          ],
        });
        expect(value.retention.pruned).toBe(false);
        expect(await readdir(join(directory, "case-offline"))).toContain(
          "unreviewed.txt",
        );
      });
    },
  );

  it("propagates cancellation and removes only the listeners it owns", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const abort = new AbortController();
      abort.abort(new Error("User cancelled"));
      const before = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          signal: abort.signal,
          dependencies: fake.dependencies,
        }),
      ).toBe(1);
      expect((await receipt(root)).value.result).toMatchObject({
        status: "cancelled",
        executed: [],
        unrun: ["first", "second"],
      });
      expect([
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ]).toEqual(before);
      expect(fake.driver.cleanup).toHaveBeenCalledOnce();
    });
  });

  it("reports accounting as unknown rather than inventing unrun steps after an unexpected coordinator failure", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const run = vi.fn(async () => {
        throw new Error("Unexpected coordinator failure");
      });
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, run },
        }),
      ).toBe(1);
      const { value } = await receipt(root);
      expect(value).toMatchObject({
        status: "failed",
        admitted: true,
        executed: null,
        unrun: null,
        cleanupComplete: false,
        executionAccounting: "unavailable-after-coordinator-failure",
      });
      expect(output).toEqual([]);
    });
  });

  it("bounds event collection without throwing past coordinator cleanup", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const run: NonNullable<
        NonNullable<AcceptanceCliEnvironment["dependencies"]>["run"]
      > = async (options) => {
        for (let i = 0; i < 2050; i++)
          options.event?.({
            schemaVersion: 1,
            runId: "offline-run",
            traceId: "offline-trace",
            correlationId: "offline-run",
            causationId: "overflow",
            stage: "run",
            phase: "progress",
            timestamp: i,
            durationMs: i,
          });
        return fake.dependencies.run(options);
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, run },
        }),
      ).toBe(1);
      const { value } = await receipt(root);
      expect(value.result).toMatchObject({
        status: "finalization-failed",
        cleanupComplete: true,
        finalizationFailures: [
          {
            stage: "event-retention",
            message: "Acceptance lifecycle evidence exceeded its bound",
          },
        ],
      });
      expect(value.events).toHaveLength(2048);
      expect(value.droppedEvents).toBe(3);
      expect(fake.driver.cleanup).toHaveBeenCalledOnce();
    });
  });

  it("uses shared redaction for injected persistence failures", async () => {
    await fixture(async (root, output, errors) => {
      await register(root);
      const fake = fakeBoundary();
      const secret = "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
      const writeReceipt = async (path: string, value: unknown) => {
        if (path.endsWith("/receipt.json"))
          throw new Error(`Persistence token=${secret}`);
        await writeScenarioReceipt(path, value);
      };
      expect(
        await acceptanceCli(["run", "--scenario", "example"], {
          ...environment(root, output, errors),
          dependencies: { ...fake.dependencies, writeReceipt },
        }),
      ).toBe(1);
      expect(errors.join("\n")).not.toContain(secret);
      expect(
        JSON.stringify((await receipt(root, "recovery.json")).value),
      ).not.toContain(secret);
    });
  });
});
