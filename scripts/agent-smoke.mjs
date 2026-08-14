import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  LiveProcessController,
  runProcess,
} from "./lib/live-process-controller.mjs";
import {
  loadScenarioSuite,
  selectScenarioGroups,
} from "./lib/scenario-suite.mjs";
import {
  classifyScenario,
  collectToolNames,
} from "./lib/scenario-evidence.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const applicationPath =
  option("live-app") ?? "/Applications/Ableton Live 11 Suite.app";
const remoteScriptTarget = resolve(
  option("remote-script-target") ??
    `${process.env.HOME}/Music/Ableton/User Library/Remote Scripts/AbletonAgent`,
);
const output = resolve(
  option("output") ??
    `.test-artifacts/agent-smoke/run-${new Date().toISOString().replaceAll(":", "-")}.json`,
);
const requestedScenarios = (option("scenarios") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const controller = new LiveProcessController();
const evidence = {
  formatVersion: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  applicationPath,
  selection: {
    group: option("group"),
    scenario: option("scenario"),
    scenarios: requestedScenarios,
    resumeFrom: option("resume-from"),
  },
  groups: [],
  scenarios: [],
};
const coveredTools = new Set();

let failed = false;
try {
  await controller.assertNoPreExistingLive();
  if (!hasFlag("skip-build")) {
    const build = await runProcess("pnpm", ["build"], { timeoutMs: 600_000 });
    if (build.status !== 0) {
      throw new Error(`Build failed:\n${build.stderr || build.stdout}`);
    }
  }
  if (!hasFlag("skip-install")) {
    await installRemoteScript(remoteScriptTarget);
  }
  const token = (
    await readFile(resolve(remoteScriptTarget, ".ableton-agent-token"), "utf8")
  ).trim();
  if (token.length < 32) {
    throw new Error("Installed Remote Script token is missing or invalid");
  }
  const environment = { ...process.env, ABLETON_AGENT_TOKEN: token };
  const suite = await loadScenarioSuite();
  const selectedGroups = selectScenarioGroups(suite, evidence.selection);
  let sessionId;

  for (const selectedGroup of selectedGroups) {
    const group = selectedGroup.id;
    const scenarios = await Promise.all(
      selectedGroup.scenarios.map(loadManifest),
    );
    for (const manifest of scenarios) {
      if (manifest.group !== group) {
        throw new Error(
          `Scenario '${manifest.id}' declares group '${manifest.group}', expected '${group}'`,
        );
      }
    }
    const groupEvidence = {
      id: group,
      scenarioIds: selectedGroup.scenarios,
      startedAt: new Date().toISOString(),
      passed: false,
    };
    evidence.groups.push(groupEvidence);
    await controller.launch(applicationPath);
    evidence.liveProcess = controller.publicRecord();
    await waitForBridge(environment, controller, evidence);
    if (sessionId === undefined) {
      const session = await runCli(
        ["session-new", "--json", "--quiet"],
        environment,
      );
      if (session.status !== 0 || typeof session.json?.sessionId !== "string") {
        throw new Error(`Unable to create Copilot session: ${session.stderr}`);
      }
      sessionId = session.json.sessionId;
      evidence.sessionId = sessionId;
    }

    let groupPassed = true;
    for (const manifest of scenarios) {
      const tracePath = resolve(
        dirname(output),
        "traces",
        `${manifest.id}.json`,
      );
      const result = await runCli(
        [
          "run",
          manifest.prompt,
          "--scenario",
          manifest.id,
          "--session",
          sessionId,
          "--trace",
          tracePath,
          "--timeout-ms",
          String(manifest.timeoutMs),
          "--json",
          "--quiet",
        ],
        environment,
        manifest.timeoutMs + 30_000,
      );
      const classification = classifyScenario(manifest, result);
      const toolNames = collectToolNames(result);
      for (const toolName of toolNames) coveredTools.add(toolName);
      evidence.scenarios.push({
        id: manifest.id,
        group,
        status: result.status,
        classification,
        passed: classification !== "fail",
        toolNames,
        tracePath,
        result: result.json,
        stderr: bounded(result.stderr),
      });
      if (classification === "fail") {
        groupPassed = false;
        failed = true;
        break;
      }
    }

    if (groupPassed) {
      await controller.gracefulStop();
      groupEvidence.passed = true;
      groupEvidence.finishedAt = new Date().toISOString();
    } else {
      await controller.discardAfterFailure();
      groupEvidence.finishedAt = new Date().toISOString();
      break;
    }
  }
} catch (error) {
  failed = true;
  evidence.error = error instanceof Error ? error.message : String(error);
  if (controller.publicRecord() !== undefined) {
    try {
      await controller.discardAfterFailure();
    } catch (cleanupError) {
      evidence.cleanupError =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
    }
  }
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = !failed;
  evidence.coverage = {
    scenarioCount: evidence.scenarios.length,
    passed: evidence.scenarios.filter((scenario) => scenario.passed).length,
    toolCount: coveredTools.size,
    tools: [...coveredTools].sort(),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`Wrote agent smoke evidence to ${output}`);
}

if (failed) process.exitCode = 1;

async function installRemoteScript(target) {
  await mkdir(target, { recursive: true });
  await cp(resolve("remote-script", "AbletonAgent"), target, {
    recursive: true,
    force: true,
  });
}

async function loadManifest(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`Invalid scenario ID: ${id}`);
  }
  const manifest = JSON.parse(
    await readFile(
      resolve("integration", "live-scenarios", `${id}.json`),
      "utf8",
    ),
  );
  if (manifest.id !== id || typeof manifest.group !== "string") {
    throw new Error(`Invalid scenario manifest: ${id}`);
  }
  return manifest;
}

async function waitForBridge(
  environment,
  liveController,
  runEvidence,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const dismissed = await liveController.dismissKnownStartupDialogs({
      discardRecovery: hasFlag("discard-recovery"),
    });
    if (dismissed !== "none") {
      runEvidence.dismissedDialogs ??= [];
      if (
        !runEvidence.dismissedDialogs.some(
          (dialog) => dialog.type === dismissed,
        )
      ) {
        runEvidence.dismissedDialogs.push({
          type: dismissed,
          dismissedAt: new Date().toISOString(),
        });
      }
    }
    const status = await runCli(
      ["status", "--json", "--quiet"],
      environment,
      10_000,
    );
    if (status.status === 0 && status.json?.healthy === true) return;
    lastError = status.stderr || status.stdout;
    await new Promise((resolve_) => setTimeout(resolve_, 1_000));
  }
  throw new Error(
    `Runner-owned Live did not reach bridge readiness. Manual dialog or Control Surface intervention may be required. ${bounded(lastError)}`,
  );
}

async function runCli(args, environment, timeoutMs = 30_000) {
  const result = await runProcess(
    process.execPath,
    [resolve("apps", "cli", "dist", "main.js"), ...args],
    { env: environment, timeoutMs },
  );
  let json;
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  try {
    json = JSON.parse(lines.at(-1) ?? "");
  } catch {
    json = undefined;
  }
  return { ...result, json };
}

function bounded(value) {
  return String(value ?? "").slice(0, 8_000);
}
