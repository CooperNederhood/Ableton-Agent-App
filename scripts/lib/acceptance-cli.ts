import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createDefaultAssertions,
  runAcceptance,
  stageFixture,
  validateFixture,
  validateResult,
  validateScenario,
  type FixtureManifest,
  type AcceptanceDriver,
  type DependencyInventory,
  type DriverContext,
  type LifecycleEvent,
  type RunResult,
  type ScenarioManifest,
  type StagedFixture,
} from "../../packages/test-support/src/integration/index.js";
import {
  describeScenarioError,
  serializeScenarioReceipt,
  writeScenarioReceipt,
} from "./scenario-receipts.mjs";

function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an acceptance manifest object");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value))
    throw new Error("Invalid acceptance catalog ID");
}
const retention = Object.freeze({
  directories: 16,
  entries: 8192,
  totalBytes: 2 * 1024 * 1024 * 1024,
  reservedRunBytes: 256 * 1024 * 1024,
});
const receiptOwnership = Object.freeze({
  completionOwner: "acceptance-cli",
  eventsScope: "coordinator",
  coordinatorEventsDoNotDetermineVerdict: true,
});
interface ArtifactOmission {
  path: string;
  kind: "file" | "empty-directory";
}
async function noSymlinks(path: string): Promise<void> {
  let current: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symlink paths and ancestors are forbidden");
  }
}
async function ownedDirectory(path: string): Promise<void> {
  try {
    await noSymlinks(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await ownedDirectory(dirname(path));
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (creationError) {
      if ((creationError as NodeJS.ErrnoException).code !== "EEXIST")
        throw creationError;
    }
    await noSymlinks(path);
  }
  if (!(await lstat(path)).isDirectory())
    throw new Error("Artifact root must be a directory");
}
async function json(path: string): Promise<unknown> {
  await noSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size === 0 ||
      info.size > 1_048_576
    )
      throw new Error("Manifest must be a bounded singly-owned regular file");
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (
      length !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    )
      throw new Error("Manifest changed during admission");
    return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}
async function catalog(root: string): Promise<readonly string[]> {
  const value = await json(
    join(root, "integration/acceptance-scenarios/suite.json"),
  );
  object(value);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.length > 256 ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "scenarios"].includes(key),
    )
  )
    throw new Error("Invalid acceptance catalog");
  const entries: string[] = [];
  for (const entry of value.scenarios) {
    id(entry);
    entries.push(entry);
  }
  if (new Set(entries).size !== entries.length)
    throw new Error("Duplicate scenario registration");
  return entries;
}
async function definition(
  root: string,
  selected: string,
): Promise<{
  scenario: ScenarioManifest;
  fixture: FixtureManifest;
  fixtureRoot: string;
}> {
  id(selected);
  if (!(await catalog(root)).includes(selected))
    throw new Error(`Scenario is not registered: ${selected}`);
  const scenario = await json(
    join(root, "integration/acceptance-scenarios", `${selected}.json`),
  );
  object(scenario);
  id(scenario.fixtureId);
  const fixtureRoot = join(root, "integration/fixtures", scenario.fixtureId);
  const fixture = await json(join(fixtureRoot, "fixture.json"));
  validateFixture(fixture);
  const assertions = createDefaultAssertions();
  validateScenario(scenario, fixture, assertions.names, [
    "automation",
    "session-audio",
    "session-midi",
    "persistence",
  ]);
  if (scenario.id !== selected || fixture.id !== scenario.fixtureId)
    throw new Error("Catalog identities do not match manifests");
  for (const reference of [
    ...scenario.assertions,
    ...scenario.steps.flatMap((step) => step.assertions),
  ])
    assertions.validate(reference);
  if (fixture.qualification !== "reviewed-live")
    throw new Error(`Registered fixture is not reviewed: ${fixture.id}`);
  return { scenario, fixture, fixtureRoot };
}
function argumentsFor(argv: readonly string[]) {
  const [command, ...args] = argv;
  if (!["list", "validate", "run"].includes(command ?? ""))
    throw new Error(
      "Usage: acceptance.mjs list | validate [--scenario ID | --template PATH] | run --scenario ID [--executable PATH] [--live-app PATH] [--bridge-read-min-ms 1..1000]",
    );
  const options = new Map<string, string>();
  const allowed =
    command === "run"
      ? ["--scenario", "--executable", "--live-app", "--bridge-read-min-ms"]
      : command === "validate"
        ? ["--scenario", "--template"]
        : [];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (
      !allowed.includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith("-") ||
      value.trim() !== value ||
      value.includes("\0") ||
      value.length > 4096
    )
      throw new Error(`Invalid acceptance option: ${key}`);
    options.set(key, value);
  }
  if (options.has("--scenario") && options.has("--template"))
    throw new Error("Select a registered scenario or a template, not both");
  if (command === "run" && !options.has("--scenario"))
    throw new Error(
      "Real acceptance requires an explicitly selected registered scenario",
    );
  if (options.has("--scenario")) id(options.get("--scenario"));
  const minimum = options.get("--bridge-read-min-ms");
  if (
    minimum !== undefined &&
    (!/^[1-9][0-9]{0,3}$/.test(minimum) || Number(minimum) > 1000)
  )
    throw new Error("Bridge read minimum must be an integer from 1 to 1000 ms");
  return { command, options };
}

async function inventory(directory: string, maximumBytes: number) {
  await noSymlinks(directory);
  const files: string[] = [],
    directories: string[] = [];
  let bytes = 0,
    count = 0;
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > retention.entries)
        throw new Error(
          "Artifact entry retention limit reached; review retained evidence manually",
        );
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
      )
        throw new Error(
          "Artifact contains a symlink or non-owned regular file",
        );
      if (info.isDirectory()) {
        await visit(child);
        directories.push(child);
      } else {
        bytes += info.size;
        if (bytes > maximumBytes)
          throw new Error(
            "Artifact byte retention limit reached; review retained evidence manually",
          );
        files.push(child);
      }
    }
  }
  await visit(directory);
  return { files, directories, bytes };
}
async function allocateRun(root: string, prefix: string): Promise<string> {
  const parent = join(root, ".test-artifacts", "acceptance");
  await ownedDirectory(parent);
  const lock = join(parent, ".admission-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      `Artifact admission is locked; inspect ${parent} before retrying`,
    );
  }
  try {
    const entries = (await readdir(parent)).filter(
      (entry) => entry !== ".admission-lock",
    );
    if (entries.length >= retention.directories)
      throw new Error(
        "Artifact directory retention limit reached; review retained evidence manually",
      );
    await inventory(parent, retention.totalBytes - retention.reservedRunBytes);
    return await mkdtemp(join(parent, prefix));
  } finally {
    await rm(lock, { recursive: true });
  }
}
async function retainReviewedFiles(
  staged: StagedFixture,
  fixture: FixtureManifest,
  driver: AcceptanceCliDriver,
  runDirectory: string,
  omissions: ArtifactOmission[],
): Promise<void> {
  const suffix = relative(runDirectory, staged.workingDirectory);
  if (
    !suffix ||
    isAbsolute(suffix) ||
    suffix.startsWith(`..${sep}`) ||
    suffix === ".."
  )
    throw new Error("Staged copy escapes run ownership");
  const allowed = new Set(fixture.resources.map(({ target }) => target));
  for (const path of driver.preservationPaths()) {
    if (allowed.has(path)) continue;
    if (path === "prepared.als" && fixture.listenerBindings?.length) {
      // Retain failed preparations too; preservation is not admission.
      allowed.add(path);
      continue;
    }
    const parts = path.split("/");
    if (
      path.length > 240 ||
      parts.length < 3 ||
      parts[0] !== "dependencies" ||
      !fixture.dependencies.includes(parts[1]!) ||
      parts.some(
        (part) =>
          !/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/u.test(part) ||
          part === "." ||
          part === "..",
      )
    )
      throw new Error("Driver preservation path is not a declared dependency");
    allowed.add(path);
  }
  if (allowed.size > 256)
    throw new Error("Driver preservation inventory exceeded its bound");
  const snapshot = await inventory(
    staged.workingDirectory,
    retention.reservedRunBytes,
  );
  // The checkpoint is already durable and all processes have settled before this plan is applied.
  for (const path of snapshot.files) {
    if (
      !allowed.has(relative(staged.workingDirectory, path).split(sep).join("/"))
    ) {
      await noSymlinks(path);
      await rm(path);
      omissions.push({
        path: relative(staged.workingDirectory, path).split(sep).join("/"),
        kind: "file",
      });
    }
  }
  for (const path of snapshot.directories) {
    if ((await readdir(path)).length === 0) {
      await rm(path, { recursive: true });
      omissions.push({
        path: relative(staged.workingDirectory, path).split(sep).join("/"),
        kind: "empty-directory",
      });
    }
  }
}

export interface AcceptanceCliDriver extends AcceptanceDriver {
  provision?(context: DriverContext): Promise<DependencyInventory>;
  preservationPaths(): ReadonlySet<string>;
}
export interface AcceptanceCliEnvironment {
  root?: string;
  output?: (value: string) => void;
  error?: (value: string) => void;
  signal?: AbortSignal;
  /** Offline test seams; never exposed as command-line options. */
  dependencies?: {
    createDriver?: (options: {
      runDirectory: string;
      executablePath?: string;
      liveApplicationPath?: string;
      bridgeReadMinimumMs?: number;
    }) => AcceptanceCliDriver | Promise<AcceptanceCliDriver>;
    run?: typeof runAcceptance;
    stage?: typeof stageFixture;
    writeReceipt?: typeof writeScenarioReceipt;
  };
}
export async function acceptanceCli(
  argv: readonly string[],
  environment: AcceptanceCliEnvironment = {},
): Promise<number> {
  const root = resolve(environment.root ?? process.cwd());
  const output =
    environment.output ?? ((value) => process.stdout.write(`${value}\n`));
  const errorOutput =
    environment.error ?? ((value) => process.stderr.write(`${value}\n`));
  let receiptPath: string | undefined;
  let staged: StagedFixture | undefined;
  let selected: string | undefined;
  let result: RunResult | undefined;
  let checkpointWritten = false;
  let pruned = false;
  const omissions: ArtifactOmission[] = [];
  const retentionEvidence = () => ({
    ...retention,
    policy: "reviewed-allowlist-no-automatic-expiry",
    omissionReason: "Outside reviewed file allowlist or empty after pruning",
    pruned,
    omissions,
  });
  let runInvoked = false;
  let droppedEvents = 0;
  let receiptEventsOpen = true;
  let lateEventCount = 0;
  let failureStage = "admission";
  const events: LifecycleEvent[] = [];
  const finalizationEvents: LifecycleEvent[] = [];
  const reportLateEvent = (event: LifecycleEvent): void => {
    if (lateEventCount > 64) return;
    const truncated = lateEventCount++ === 64;
    try {
      const diagnostic = serializeScenarioReceipt(
        {
          kind: truncated
            ? "acceptance-late-events-truncated"
            : "acceptance-late-lifecycle",
          receiptPath,
          receiptUnchanged: true,
          runId: event.runId,
          traceId: event.traceId,
          correlationId: event.correlationId,
          ...(truncated
            ? { maximumEvents: 64 }
            : {
                event: {
                  schemaVersion: event.schemaVersion,
                  runId: event.runId,
                  traceId: event.traceId,
                  correlationId: event.correlationId,
                  causationId: event.causationId,
                  stage: event.stage,
                  phase: event.phase,
                  timestamp: event.timestamp,
                  durationMs: event.durationMs,
                },
              }),
        },
        16_384,
      ).trimEnd();
      output(diagnostic);
    } catch (error) {
      // Observability must not reject the coordinator's late ownership-reclamation promise.
      try {
        errorOutput(
          serializeScenarioReceipt(
            {
              kind: "acceptance-late-diagnostic-failed",
              receiptUnchanged: true,
              message: describeScenarioError(error),
            },
            4096,
          ).trimEnd(),
        );
      } catch {
        // Both diagnostic sinks are unavailable; never interfere with owned cleanup.
      }
    }
  };
  const finalizationEvent = (
    stage: string,
    phase: LifecycleEvent["phase"],
    began: number,
  ) => {
    if (!result) return;
    const event: LifecycleEvent = {
      schemaVersion: 1,
      runId: result.runId,
      traceId: result.traceId,
      correlationId: result.runId,
      causationId: `${result.runId}.cli.${stage}`,
      stage,
      phase,
      timestamp: Date.now(),
      durationMs: Math.max(0, Date.now() - began),
    };
    finalizationEvents.push(event);
    return event;
  };
  const writeReceipt =
    environment.dependencies?.writeReceipt ?? writeScenarioReceipt;
  const stage = environment.dependencies?.stage ?? stageFixture;
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Acceptance cancelled"));
  const externalAbort = () => abort.abort(environment.signal?.reason);
  environment.signal?.addEventListener("abort", externalAbort, { once: true });
  if (environment.signal?.aborted) externalAbort();
  try {
    const { command, options } = argumentsFor(argv);
    if (command === "list") {
      const entries = await catalog(root);
      output(
        JSON.stringify({
          kind: "acceptance-catalog",
          scenarios: entries,
          count: entries.length,
          ...(entries.length === 0
            ? { state: "awaiting-joint-fixture-onboarding" }
            : {}),
        }),
      );
      return 0;
    }
    if (options.has("--template")) {
      const path = resolve(root, options.get("--template")!);
      const prefix =
        join(root, "integration/acceptance-scenarios/templates") + sep;
      if (
        !path.startsWith(prefix) ||
        options.get("--template")!.split(/[\\/]/u).includes("..")
      )
        throw new Error(
          "Template must be inside the acceptance template directory without traversal",
        );
      const template = await json(path);
      object(template);
      if (
        Object.keys(template).some(
          (key) => !["fixture", "scenario"].includes(key),
        )
      )
        throw new Error("Unexpected authoring template fields");
      validateFixture(template.fixture);
      const assertions = createDefaultAssertions();
      validateScenario(template.scenario, template.fixture, assertions.names, [
        "automation",
        "session-audio",
        "session-midi",
        "persistence",
      ]);
      for (const reference of [
        ...template.scenario.assertions,
        ...template.scenario.steps.flatMap((step) => step.assertions),
      ])
        assertions.validate(reference);
      output(
        JSON.stringify({
          kind: "template-validation",
          schemaValid: true,
          runnable: false,
          detail:
            "Schema only; fixture assets, review and real-host qualification are not established.",
        }),
      );
      return 0;
    }
    if (command === "validate") {
      const entries = options.has("--scenario")
        ? [options.get("--scenario")!]
        : await catalog(root);
      for (const selected of entries) {
        const { scenario, fixture, fixtureRoot } = await definition(
          root,
          selected,
        );
        const workingRoot = await allocateRun(root, "validation-");
        try {
          const copy = await stage({
            fixture,
            catalogRoot: fixtureRoot,
            workingRoot,
            runId: randomUUID(),
            signal: abort.signal,
          });
          await copy.verifySourceUnchanged();
        } finally {
          await rm(workingRoot, { recursive: true, force: true });
        }
        output(
          JSON.stringify({
            kind: "fixture-validation",
            scenario: scenario.id,
            admitted: true,
            executed: false,
          }),
        );
      }
      if (entries.length === 0)
        output(
          JSON.stringify({
            kind: "catalog-validation",
            count: 0,
            state: "awaiting-joint-fixture-onboarding",
            executed: false,
          }),
        );
      return 0;
    }
    selected = options.get("--scenario")!;
    const runDirectory = await allocateRun(root, "run-");
    receiptPath = join(runDirectory, "receipt.json");
    const { scenario, fixture, fixtureRoot } = await definition(root, selected);
    const createDriver =
      environment.dependencies?.createDriver ??
      (async (options) => {
        const { PackagedAcceptanceDriver } =
          await import("../../tests/electron/acceptance-driver.js");
        return new PackagedAcceptanceDriver(options);
      });
    const driver = await createDriver({
      runDirectory,
      ...(options.has("--executable")
        ? { executablePath: resolve(options.get("--executable")!) }
        : {}),
      ...(options.has("--live-app")
        ? { liveApplicationPath: resolve(options.get("--live-app")!) }
        : {}),
      ...(options.has("--bridge-read-min-ms")
        ? { bridgeReadMinimumMs: Number(options.get("--bridge-read-min-ms")) }
        : {}),
    });
    const diagnostic = options.has("--bridge-read-min-ms")
      ? {
          diagnostic: {
            kind: "real-bridge-read-pacing",
            minimumReadMs: Number(options.get("--bridge-read-min-ms")),
          },
        }
      : {};
    if (fixture.dependencies.length && typeof driver.provision !== "function")
      throw new Error(
        "Declared dependencies require explicit candidate provisioning",
      );
    if (
      driver.provision !== undefined &&
      typeof driver.provision !== "function"
    )
      throw new Error("Driver provisioning hook must be a function");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    runInvoked = true;
    failureStage = "coordinator";
    result = await (environment.dependencies?.run ?? runAcceptance)({
      scenario,
      fixture,
      driver,
      signal: abort.signal,
      ...(driver.provision
        ? { provision: (context: DriverContext) => driver.provision!(context) }
        : {}),
      stage: async (context) => {
        staged = await stage({
          fixture,
          catalogRoot: fixtureRoot,
          workingRoot: runDirectory,
          runId: context.runId,
          signal: context.signal,
        });
        return staged;
      },
      event: (event) => {
        if (!receiptEventsOpen || event.stage.startsWith("late."))
          reportLateEvent(event);
        if (!receiptEventsOpen) return;
        if (events.length >= 2048) {
          droppedEvents++;
          abort.abort(
            new Error("Acceptance lifecycle evidence exceeded its bound"),
          );
          return;
        }
        events.push(event);
      },
      persist: async (candidate) => {
        result = candidate;
        await writeReceipt(join(runDirectory, "checkpoint.json"), {
          schema: "acceptance-run/v1",
          ...receiptOwnership,
          ...diagnostic,
          finalization: "checkpoint",
          finalReceiptRequired: true,
          result: { ...candidate, persisted: false },
          events,
          droppedEvents,
        });
        checkpointWritten = true;
      },
    });
    failureStage = "result-validation";
    validateResult(result);
    if (
      result.status === "passed" &&
      (!result.cleanupComplete || !result.persisted || !checkpointWritten)
    )
      result = {
        ...result,
        status: "finalization-failed",
        persisted: result.persisted && checkpointWritten,
      };
    if (droppedEvents)
      result = {
        ...result,
        status: "finalization-failed",
        finalizationFailures: [
          ...result.finalizationFailures,
          {
            stage: "event-retention",
            message: "Acceptance lifecycle evidence exceeded its bound",
          },
        ],
      };
    failureStage = "profile-verification";
    if (result.cleanupComplete) {
      try {
        await lstat(join(runDirectory, "profile"));
        result = {
          ...result,
          status: "finalization-failed",
          cleanupComplete: false,
          finalizationFailures: [
            ...result.finalizationFailures,
            {
              stage: "profile-cleanup",
              message: "Driver left its isolated credential profile behind",
            },
          ],
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (result.cleanupComplete && checkpointWritten && staged) {
      const began = Date.now();
      finalizationEvent("artifact-retention", "queued", began);
      finalizationEvent("artifact-retention", "started", began);
      try {
        await retainReviewedFiles(
          staged,
          fixture,
          driver,
          runDirectory,
          omissions,
        );
        pruned = true;
        finalizationEvent("artifact-retention", "completed", began);
      } catch (error) {
        finalizationEvent("artifact-retention", "failed", began);
        result = {
          ...result,
          status: "finalization-failed",
          finalizationFailures: [
            ...result.finalizationFailures,
            {
              stage: "artifact-retention",
              message: describeScenarioError(error),
            },
          ],
        };
      }
    }
    const receiptStartedAt = Date.now();
    failureStage = "receipt-finalization";
    finalizationEvent("receipt-finalization", "queued", receiptStartedAt);
    finalizationEvent("receipt-finalization", "started", receiptStartedAt);
    receiptEventsOpen = false;
    await writeReceipt(receiptPath, {
      schema: "acceptance-run/v1",
      ...receiptOwnership,
      ...diagnostic,
      finalization: "final",
      result,
      events,
      droppedEvents,
      finalizationEvents,
      preservedProject: staged?.workingDirectory,
      retention: retentionEvidence(),
    });
    const completion = finalizationEvent(
      "receipt-finalization",
      "completed",
      receiptStartedAt,
    );
    failureStage = "output";
    output(
      JSON.stringify({
        status: result.status,
        ...diagnostic,
        receiptPath,
        cleanupComplete: result.cleanupComplete,
        selected: result.selected,
        executed: result.executed,
        unrun: result.unrun,
        preservedProject: staged?.workingDirectory,
        finalizationEvent: completion,
      }),
    );
    return result.status === "passed" &&
      result.persisted &&
      result.cleanupComplete &&
      checkpointWritten
      ? 0
      : 1;
  } catch (error) {
    receiptEventsOpen = false;
    const message = describeScenarioError(error);
    const receiptStarted = finalizationEvents.find(
      (event) =>
        event.stage === "receipt-finalization" && event.phase === "started",
    );
    if (receiptStarted && failureStage === "receipt-finalization")
      finalizationEvent(
        "receipt-finalization",
        "failed",
        receiptStarted.timestamp,
      );
    const failedResult = result
      ? {
          ...result,
          status: "finalization-failed",
          persisted: false,
          finalizationFailures: [
            ...result.finalizationFailures,
            { stage: failureStage, message },
          ],
        }
      : undefined;
    let recoveryPath: string | undefined;
    if (receiptPath) {
      try {
        recoveryPath = result
          ? join(dirname(receiptPath), "recovery.json")
          : receiptPath;
        await writeReceipt(recoveryPath, {
          schema: "acceptance-run/v1",
          ...receiptOwnership,
          finalization: "final",
          status: "failed",
          message,
          preservedProject: staged?.workingDirectory,
          events,
          droppedEvents,
          ...(finalizationEvents.length ? { finalizationEvents } : {}),
          ...(staged ? { retention: retentionEvidence() } : {}),
          ...(failedResult
            ? { result: failedResult }
            : {
                admitted: runInvoked,
                selectionScope: "scenarios",
                selected: [selected],
                executed: runInvoked ? null : [],
                unrun: runInvoked ? null : [selected],
                ...(runInvoked
                  ? {
                      executionAccounting:
                        "unavailable-after-coordinator-failure",
                      cleanupComplete: false,
                    }
                  : {}),
              }),
        });
      } catch (persistenceError) {
        recoveryPath = undefined;
        errorOutput(
          `Receipt persistence failed: ${describeScenarioError(persistenceError)}`,
        );
      }
    }
    if (selected)
      errorOutput(
        serializeScenarioReceipt({
          status: failedResult?.status ?? "failed",
          receiptPath,
          evidenceDirectory: receiptPath
            ? dirname(receiptPath)
            : join(root, ".test-artifacts/acceptance"),
          recoveryPath,
          checkpointPath:
            checkpointWritten && receiptPath
              ? join(dirname(receiptPath), "checkpoint.json")
              : undefined,
          selectionScope: failedResult ? "steps" : "scenarios",
          selected: failedResult?.selected ?? [selected],
          executed: failedResult?.executed ?? (runInvoked ? null : []),
          unrun: failedResult?.unrun ?? (runInvoked ? null : [selected]),
          cleanupComplete: failedResult?.cleanupComplete ?? !runInvoked,
          primaryFailure: failedResult?.primaryFailure,
          finalizationFailures: failedResult?.finalizationFailures,
          ...(staged ? { retention: retentionEvidence() } : {}),
          ...(!recoveryPath && !checkpointWritten && failedResult
            ? {
                recoveryEvidence: {
                  result: failedResult,
                  events,
                  finalizationEvents,
                  droppedEvents,
                },
              }
            : {}),
          message,
        }).trimEnd(),
      );
    errorOutput(message);
    return 1;
  } finally {
    receiptEventsOpen = false;
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    environment.signal?.removeEventListener("abort", externalAbort);
  }
}
