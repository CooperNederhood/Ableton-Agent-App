import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { packagedExecutable } from "../../tests/electron/packaged-paths.js";
import {
  acceptanceCatalog,
  acceptanceCli,
  acceptanceDefinition,
  allocateAcceptanceRun,
} from "./acceptance-cli.js";
import {
  readSuiteAttempt,
  verifyAcceptanceSuite,
} from "./acceptance-suite-evidence.js";
import {
  evidenceHash,
  runAcceptanceSuite,
  type SuiteDependencies,
  type SuiteInputs,
} from "./acceptance-suite.js";
import {
  describeScenarioError,
  serializeScenarioReceipt,
} from "./scenario-receipts.mjs";
import type { LiveHostLease } from "./live-host-lease.mjs";

export async function acceptanceDefinitionsHash(
  root: string,
  selected: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const records: unknown[] = [];
  for (const id of selected) {
    signal.throwIfAborted();
    const { scenario, fixture, fixtureRoot } = await acceptanceDefinition(
      root,
      id,
    );
    for (const resource of fixture.resources) {
      const path = join(fixtureRoot, resource.path);
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size !== resource.bytes ||
        (await realpath(path)) !== path
      )
        throw new Error(
          `Fixture asset is missing, changed or not owned: ${id}/${resource.path}`,
        );
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(path, { signal })) {
        if (!Buffer.isBuffer(bytes))
          throw new Error("Unexpected fixture stream data");
        digest.update(bytes);
      }
      const after = await lstat(path);
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        digest.digest("hex") !== resource.sha256
      )
        throw new Error(`Fixture hash mismatch: ${id}/${resource.path}`);
    }
    records.push({ scenario, fixture });
  }
  return evidenceHash({ selected, records });
}

function parse(argv: readonly string[]) {
  const [command, ...args] = argv;
  if (command !== "suite" && command !== "verify")
    throw new Error("Expected suite or verify");
  const allowed =
    command === "suite"
      ? ["--executable", "--live-app"]
      : ["--executable", "--receipt"];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!,
      value = args[index + 1];
    if (
      !allowed.includes(key) ||
      options.has(key) ||
      !value ||
      value.startsWith("-") ||
      value.trim() !== value ||
      value.includes("\0") ||
      value.length > 4096
    )
      throw new Error(`Invalid suite option: ${key}`);
    options.set(key, value);
  }
  if (command === "verify" && !options.has("--receipt"))
    throw new Error("Verification requires --receipt <terminal-suite.json>");
  return { command, options };
}

export interface AcceptanceSuiteEnvironment {
  root?: string;
  signal?: AbortSignal;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Controlled offline seams; not command-line options. */
  dependencies?: {
    executable?: () => Promise<string>;
    inspect?: (signal: AbortSignal) => Promise<SuiteInputs>;
    acquire?: SuiteDependencies["acquire"];
    execute?: SuiteDependencies["execute"];
  };
}

export async function acceptanceSuiteCli(
  argv: readonly string[],
  environment: AcceptanceSuiteEnvironment = {},
): Promise<number> {
  const root = resolve(environment.root ?? process.cwd());
  const output =
    environment.output ?? ((text) => process.stdout.write(`${text}\n`));
  const error =
    environment.error ?? ((text) => process.stderr.write(`${text}\n`));
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Acceptance suite cancelled"));
  const externalAbort = () => abort.abort(environment.signal?.reason);
  environment.signal?.addEventListener("abort", externalAbort, { once: true });
  if (environment.signal?.aborted) externalAbort();
  let directory: string | undefined;
  let hostLease: LiveHostLease | undefined;
  try {
    const { command, options } = parse(argv);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const selected = await acceptanceCatalog(root);
    // Reserve capacity before starting any licensed host or case.
    if (command === "suite")
      directory = await allocateAcceptanceRun(
        root,
        "suite-",
        Math.max(1, selected.length) * 256 * 1024 * 1024,
      );
    let executable: string | undefined;
    const getExecutable = async () =>
      (executable ??= await (environment.dependencies?.executable?.() ??
        packagedExecutable({
          ...(options.has("--executable")
            ? { explicit: options.get("--executable")! }
            : {}),
          releaseRoot: join(root, "release"),
        })));
    const inspect =
      environment.dependencies?.inspect ??
      (async (signal: AbortSignal): Promise<SuiteInputs> => {
        const { inspectPackagedCandidate, inspectAcceptanceSource } =
          await import("./acceptance-identity.js");
        const candidate = await inspectPackagedCandidate(
          await getExecutable(),
          signal,
        );
        const source = await inspectAcceptanceSource(root, signal);
        const current = await acceptanceCatalog(root);
        return {
          candidateSha256: candidate.sha256,
          appAsarSha256: candidate.appAsarSha256,
          sourceSha256: source.sha256,
          sourceRevision: source.revision,
          dirty: source.dirty,
          definitionsSha256: await acceptanceDefinitionsHash(
            root,
            current,
            signal,
          ),
          selected: current,
          provenance: {
            platform: process.platform,
            architecture: process.arch,
            candidateInventory: candidate.inventory,
            sourceInventory: source.inventory,
            lockfile: source.lockfile,
          },
        };
      });
    if (command === "verify") {
      const inputs = await inspect(abort.signal);
      await verifyAcceptanceSuite({
        root,
        receiptPath: resolve(options.get("--receipt")!),
        inputs,
      });
      output(
        JSON.stringify({
          status: "qualified",
          candidateSha256: inputs.candidateSha256,
          selected: inputs.selected,
        }),
      );
      return 0;
    }
    const result = await runAcceptanceSuite(
      { directory: directory!, signal: abort.signal, selected },
      {
        inspect,
        acquire:
          environment.dependencies?.acquire ??
          (async (signal, owner) => {
            const { acquireLiveHostLease } =
              await import("./live-host-lease.mjs");
            hostLease = await acquireLiveHostLease({
              signal,
              traceId: owner.traceId,
              correlationId: owner.runId,
              causationId: owner.runId,
              onEvent: (event) =>
                output(
                  serializeScenarioReceipt({
                    kind: "suite-host-lifecycle",
                    event,
                  }).trimEnd(),
                ),
            });
            return hostLease;
          }),
        execute:
          environment.dependencies?.execute ??
          (async (context) => {
            if (!hostLease)
              throw new Error(
                "Packaged suite execution requires its acquired host lease",
              );
            const exitCode = await acceptanceCli(
              [
                "run",
                "--scenario",
                context.scenarioId,
                "--executable",
                await getExecutable(),
                ...(options.has("--live-app")
                  ? ["--live-app", options.get("--live-app")!]
                  : []),
              ],
              {
                root,
                signal: context.signal,
                output,
                error,
                execution: {
                  runDirectory: context.directory,
                  runId: context.runId,
                  traceId: context.traceId,
                  hostLease,
                },
              },
            );
            return readSuiteAttempt({
              ...context,
              root,
              suiteDirectory: directory!,
              exitCode,
            });
          }),
      },
    );
    output(
      JSON.stringify({
        status: result.status,
        receiptPath: join(directory!, "suite.json"),
        selected: result.selected,
        executed: result.executed,
        unrun: result.unrun,
        unknown: result.unknown,
        firstFailure: result.firstFailure,
        cleanupComplete: result.cleanupComplete,
        finalizationEvent: result.events.at(-1),
      }),
    );
    return result.status === "passed" ? 0 : 1;
  } catch (cause) {
    error(
      JSON.stringify({
        status: "failed",
        message: describeScenarioError(cause),
        ...(directory
          ? { evidenceDirectory: directory, finalReceiptRequired: true }
          : {}),
      }),
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    environment.signal?.removeEventListener("abort", externalAbort);
  }
}
