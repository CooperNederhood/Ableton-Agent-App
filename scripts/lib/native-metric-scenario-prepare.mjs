import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createNativeRunnerLifecycle } from "./native-listening-lifecycle.mjs";

export async function prepareNativeMetricLongFixture({
  sourceInput,
  candidateInput,
  directory,
  signal,
  execute = promisify(execFile),
  services,
}) {
  const root = resolve(directory);
  const suffix = relative(resolve(".test-artifacts"), root);
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    suffix.startsWith(sep) ||
    (await realpath(dirname(root))) !== dirname(root)
  )
    throw new Error(
      "Fresh nonsymlink .test-artifacts preparation namespace required",
    );
  await mkdir(root, { mode: 0o700 });
  const storageServices =
    services ?? (await import("../../packages/storage/dist/index.js"));
  const observability =
    services ?? (await import("../../packages/observability/dist/index.js"));
  const storage = storageServices.resolveLiveAgentStorage({
    environment: {
      LIVE_AGENT_HOME: join(root, "live-agent"),
      LIVE_AGENT_PROFILE: "automation",
    },
  });
  const journal = await observability.LocalObservabilityJournal.open({
    path: storage.eventJournalPath,
  });
  const trace = {
    traceId: randomUUID(),
    correlationId: randomUUID(),
    causationId: randomUUID(),
  };
  const lifecycle = createNativeRunnerLifecycle({
    telemetry: journal,
    sanitize: observability.sanitizeTelemetryAttributes,
    trace,
    signal,
  });
  const fixture = join(root, "fixture");
  const attributes = {
    sourceInput,
    candidateInput,
    destination: fixture,
    binaryBody: "[omitted: Set/device/audio bodies]",
  };
  try {
    const output = await lifecycle.stage(
      "long-metric-fixture-preparation",
      async () => {
        const result = await execute(
          "python3",
          [
            "-B",
            fileURLToPath(
              new URL("./native-metric-scenario-fixture.py", import.meta.url),
            ),
            "--source-input",
            sourceInput,
            "--candidate-input",
            candidateInput,
            "--out",
            fixture,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            maxBuffer: 64 * 1024,
            signal,
          },
        );
        const prepared = JSON.parse(result.stdout);
        if (
          prepared.inputPath !== join(fixture, "input.json") ||
          prepared.physicalQualification !== false
        )
          throw new Error("Offline copied-fixture preparation output mismatch");
        attributes.prepared = prepared;
        return prepared;
      },
      attributes,
    );
    return { ...output, eventJournalPath: storage.eventJournalPath, trace };
  } catch (error) {
    const cleanup = createNativeRunnerLifecycle({
      telemetry: journal,
      sanitize: observability.sanitizeTelemetryAttributes,
      trace: {
        ...trace,
        causationId: lifecycle.events.at(-1)?.id ?? trace.causationId,
      },
    });
    try {
      await cleanup.stage("long-metric-fixture-preparation-cleanup", () =>
        rm(fixture, { recursive: true, force: true }),
      );
    } catch {
      // Cleanup failure is journaled; the original preparation error remains primary.
    }
    throw error;
  } finally {
    try {
      await journal.flush();
    } finally {
      await journal.close();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--source-input" ||
    args[2] !== "--candidate-input" ||
    args[4] !== "--out"
  )
    throw new Error(
      "Usage: native-metric-scenario-prepare.mjs --source-input <pinned-cohort-input> --candidate-input <checked-native5-input> --out <fresh-artifact-directory>",
    );
  try {
    console.log(
      JSON.stringify(
        await prepareNativeMetricLongFixture({
          sourceInput: args[1],
          candidateInput: args[3],
          directory: args[5],
        }),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      "Long metric preparation failed; inspect the isolated typed event journal.",
    );
    process.exitCode = 1;
  }
}
