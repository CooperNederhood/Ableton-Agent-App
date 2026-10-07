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
  shouldRetryAgentScenario,
} from "./lib/scenario-evidence.mjs";
import { createIsolatedScenarioSession } from "./lib/scenario-session.mjs";

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
    let groupPassed = true;
    for (const manifest of scenarios) {
      const tracePath = resolve(
        dirname(output),
        "traces",
        `${manifest.id}.json`,
      );
      if (
        manifest.execution === "live-event-runtime" ||
        manifest.execution === "capability-surface" ||
        manifest.execution === "cue-point-runtime" ||
        manifest.execution === "routing-runtime"
      ) {
        const result =
          manifest.execution === "live-event-runtime"
            ? await runLiveEventRuntimeScenario(manifest, environment)
            : manifest.execution === "capability-surface"
              ? await runCapabilitySurfaceScenario(manifest, environment)
              : manifest.execution === "cue-point-runtime"
                ? await runCuePointRuntimeScenario(manifest, environment)
                : await runRoutingRuntimeScenario(manifest, environment);
        await mkdir(dirname(tracePath), { recursive: true });
        await writeFile(
          tracePath,
          `${JSON.stringify(result, undefined, 2)}\n`,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        const classification = result.ok ? "pass" : "fail";
        evidence.scenarios.push({
          id: manifest.id,
          group,
          status: result.ok ? 0 : 5,
          classification,
          passed: result.ok,
          toolNames: [],
          tracePath,
          result,
          stderr: "",
        });
        if (!result.ok) {
          groupPassed = false;
          failed = true;
          break;
        }
        continue;
      }
      const attempts = [];
      let sessionId;
      let result;
      let classification;
      let finalTracePath = tracePath;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        sessionId = await createIsolatedScenarioSession((args) =>
          runCli(args, environment),
        );
        finalTracePath =
          attempt === 1
            ? tracePath
            : resolve(
                dirname(output),
                "traces",
                `${manifest.id}.attempt-2.json`,
              );
        result = await runCli(
          [
            "run",
            manifest.prompt,
            "--scenario",
            manifest.id,
            "--session",
            sessionId,
            "--trace",
            finalTracePath,
            "--timeout-ms",
            String(manifest.timeoutMs),
            "--json",
            "--quiet",
          ],
          environment,
          manifest.timeoutMs + 30_000,
        );
        classification = classifyScenario(manifest, result);
        attempts.push({
          attempt,
          sessionId,
          status: result.status,
          classification,
          tracePath: finalTracePath,
        });
        if (
          classification !== "fail" ||
          attempt === 2 ||
          !shouldRetryAgentScenario(result)
        ) {
          break;
        }
      }
      if (
        sessionId === undefined ||
        result === undefined ||
        classification === undefined
      ) {
        throw new Error(`Scenario '${manifest.id}' did not execute`);
      }
      const toolNames = collectToolNames(result);
      for (const toolName of toolNames) coveredTools.add(toolName);
      evidence.scenarios.push({
        id: manifest.id,
        group,
        status: result.status,
        classification,
        passed: classification !== "fail",
        sessionId,
        attempts,
        toolNames,
        tracePath: finalTracePath,
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
  if (
    manifest.execution !== undefined &&
    manifest.execution !== "live-event-runtime" &&
    manifest.execution !== "capability-surface" &&
    manifest.execution !== "cue-point-runtime" &&
    manifest.execution !== "routing-runtime"
  ) {
    throw new Error(`Invalid scenario execution mode: ${manifest.execution}`);
  }
  if (
    (manifest.execution === "live-event-runtime" ||
      manifest.execution === "capability-surface" ||
      manifest.execution === "cue-point-runtime" ||
      manifest.execution === "routing-runtime") &&
    (!Number.isInteger(manifest.timeoutMs) ||
      manifest.timeoutMs < 10_000 ||
      manifest.timeoutMs > 60_000)
  ) {
    throw new Error(`Invalid direct scenario timeout: ${manifest.timeoutMs}`);
  }
  return manifest;
}

async function runRoutingRuntimeScenario(manifest, environment) {
  const { createAgentRuntime, resolveAbletonSettingsFromEnvironment } =
    await import("../packages/runtime/dist/index.js");
  const runtime = createAgentRuntime({
    ableton: resolveAbletonSettingsFromEnvironment(environment),
  });
  const assertions = [];
  const artifactPrefix = `${manifest.artifactPrefix}${randomUUID().slice(0, 8)}_`;
  const sourceName = `${artifactPrefix}Source`;
  const destinationName = `${artifactPrefix}Destination`;
  let baseline;
  let observed;
  let cleanupError;
  try {
    await runtime.application.start({ startAgent: false });
    baseline = await runtime.application.inspectSession();
    const source = await runtime.application.createTrack({
      kind: "midi",
      name: sourceName,
    });
    const destination = await runtime.application.createTrack({
      kind: "audio",
      name: destinationName,
    });
    const target = {
      kind: "regular",
      index: destination.track.index,
      expectedReference: destination.track.reference,
      expectedName: destination.track.name,
    };
    const beforeType = await runtime.application.executeMixerRoutingOperation({
      action: "routing-options",
      target,
      direction: "input-type",
    });
    if (beforeType.action !== "routing-options") {
      throw new Error("Expected input-type routing options");
    }
    const beforeCurrent = beforeType.options.find(
      ({ token }) => token === beforeType.currentOptionToken,
    );
    const sourceOption = beforeType.options.find(
      ({ displayName }) => displayName === sourceName,
    );
    if (beforeCurrent === undefined || sourceOption === undefined) {
      throw new Error(
        "Fresh audio input type did not resolve its current or source routing option",
      );
    }
    const assignedType = await runtime.application.executeMixerRoutingOperation(
      {
        action: "set-routing",
        target,
        direction: "input-type",
        snapshotId: beforeType.snapshotId,
        optionToken: sourceOption.token,
        expectedDisplayName: sourceOption.displayName,
      },
    );
    const afterType = await runtime.application.executeMixerRoutingOperation({
      action: "routing-options",
      target,
      direction: "input-type",
    });
    if (afterType.action !== "routing-options") {
      throw new Error("Expected refreshed input-type routing options");
    }
    const currentType = afterType.options.find(
      ({ token }) => token === afterType.currentOptionToken,
    );
    const beforeChannel =
      await runtime.application.executeMixerRoutingOperation({
        action: "routing-options",
        target,
        direction: "input-channel",
      });
    if (beforeChannel.action !== "routing-options") {
      throw new Error("Expected input-channel routing options");
    }
    const beforeCurrentChannel = beforeChannel.options.find(
      ({ token }) => token === beforeChannel.currentOptionToken,
    );
    const postFx = beforeChannel.options.find(
      ({ displayName }) => displayName === "Post FX",
    );
    if (beforeCurrentChannel === undefined || postFx === undefined) {
      throw new Error(
        "Source-track input channels did not resolve the current channel and Post FX",
      );
    }
    const assignedChannel =
      await runtime.application.executeMixerRoutingOperation({
        action: "set-routing",
        target,
        direction: "input-channel",
        snapshotId: beforeChannel.snapshotId,
        optionToken: postFx.token,
        expectedDisplayName: postFx.displayName,
      });
    const afterChannel = await runtime.application.executeMixerRoutingOperation(
      {
        action: "routing-options",
        target,
        direction: "input-channel",
      },
    );
    if (afterChannel.action !== "routing-options") {
      throw new Error("Expected refreshed input-channel routing options");
    }
    const currentChannel = afterChannel.options.find(
      ({ token }) => token === afterChannel.currentOptionToken,
    );
    observed = {
      source,
      destination,
      beforeCurrent,
      assignedType,
      currentType,
      beforeCurrentChannel,
      assignedChannel,
      currentChannel,
    };
    assertions.push({
      assertion: "audio-input-routing",
      passed:
        source.verified === true &&
        destination.verified === true &&
        assignedType.action === "set-routing" &&
        assignedType.verified === true &&
        currentType?.displayName === sourceName &&
        assignedChannel.action === "set-routing" &&
        assignedChannel.verified === true &&
        currentChannel?.displayName === "Post FX",
      evidence: observed,
    });
  } catch (error) {
    assertions.push({
      assertion: "scenario-execution",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      evidence: observed,
    });
  } finally {
    if (baseline !== undefined) {
      try {
        const current = await runtime.application.inspectSession();
        const generated = current.tracks
          .filter(
            (track) =>
              track.kind !== "master" &&
              track.kind !== "return" &&
              track.name.startsWith(artifactPrefix),
          )
          .sort((left, right) => right.index - left.index);
        for (const track of generated) {
          await runtime.application.deleteTrack({
            index: track.index,
            expectedReference: track.reference,
            expectedName: track.name,
            expectedKind: track.kind,
          });
        }
        const after = await runtime.application.inspectSession();
        assertions.push({
          assertion: "routing-cleanup",
          passed: JSON.stringify(after) === JSON.stringify(baseline),
          evidence: { baseline, after },
        });
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      await runtime.application.stop();
    } catch (error) {
      cleanupError ??= error instanceof Error ? error.message : String(error);
    }
  }
  if (cleanupError !== undefined) {
    assertions.push({
      assertion: "runtime-cleanup",
      passed: false,
      message: cleanupError,
    });
  }
  return {
    ok: assertions.every(({ passed }) => passed),
    scenarioId: manifest.id,
    assertions,
  };
}

async function runCuePointRuntimeScenario(manifest, environment) {
  const { createAgentRuntime, resolveAbletonSettingsFromEnvironment } =
    await import("../packages/runtime/dist/index.js");
  const runtime = createAgentRuntime({
    ableton: resolveAbletonSettingsFromEnvironment(environment),
  });
  const assertions = [];
  let stopError;
  try {
    await runtime.application.start({ startAgent: false });
    const baseline = await runtime.application.inspectArrangementTransport({
      offset: 0,
      limit: 100,
    });
    const created = await runtime.application.createCuePoint({ time: 32 });
    const inspected = await runtime.application.inspectArrangementTransport({
      offset: 0,
      limit: 100,
    });
    const observed = inspected.cuePoints.find(
      ({ reference }) => reference === created.cuePoint.reference,
    );
    await runtime.application.deleteCuePoint({
      expectedReference: created.cuePoint.reference,
      expectedName: created.cuePoint.name,
      expectedTime: created.cuePoint.time,
    });
    const after = await runtime.application.inspectArrangementTransport({
      offset: 0,
      limit: 100,
    });
    assertions.push({
      assertion: "cue-point-lifecycle",
      passed:
        created.verified === true &&
        observed?.time === 32 &&
        observed.name === created.cuePoint.name &&
        JSON.stringify(after) === JSON.stringify(baseline),
      evidence: { baseline, created, observed, after },
    });
  } catch (error) {
    assertions.push({
      assertion: "scenario-execution",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await runtime.application.stop();
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
    }
  }
  if (stopError !== undefined) {
    assertions.push({
      assertion: "runtime-cleanup",
      passed: false,
      message: stopError,
    });
  }
  return {
    ok: assertions.every(({ passed }) => passed),
    scenarioId: manifest.id,
    assertions,
  };
}

async function runCapabilitySurfaceScenario(manifest, environment) {
  const { createAgentRuntime, resolveAbletonSettingsFromEnvironment } =
    await import("../packages/runtime/dist/index.js");
  const runtime = createAgentRuntime({
    ableton: resolveAbletonSettingsFromEnvironment(environment),
  });
  const assertions = [];
  let stopError;
  try {
    await runtime.application.start({ startAgent: false });
    const status = await runtime.application.getStatus();
    const capabilities = await runtime.ableton.getCapabilities();
    const requirement = manifest.assertions.find(
      ({ type }) => type === "connection-capabilities",
    );
    const requiredCapabilities = requirement?.requiredCapabilities ?? [];
    const missing = requiredCapabilities.filter(
      (capability) => capabilities.capabilities[capability] !== true,
    );
    assertions.push({
      assertion: "connection-capabilities",
      passed: status.state === "connected" && missing.length === 0,
      evidence: {
        status,
        selectedProtocolVersion: capabilities.selectedProtocolVersion,
        requiredCapabilities,
        missing,
      },
    });
  } catch (error) {
    assertions.push({
      assertion: "scenario-execution",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await runtime.application.stop();
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
    }
  }
  if (stopError !== undefined) {
    assertions.push({
      assertion: "runtime-cleanup",
      passed: false,
      message: stopError,
    });
  }
  return {
    ok: assertions.every(({ passed }) => passed),
    scenarioId: manifest.id,
    assertions,
  };
}

async function runLiveEventRuntimeScenario(manifest, environment) {
  const { createAgentRuntime, resolveAbletonSettingsFromEnvironment } =
    await import("../packages/runtime/dist/index.js");
  const transitions = [];
  const runtime = createAgentRuntime({
    ableton: resolveAbletonSettingsFromEnvironment(environment),
  });
  const unsubscribe = runtime.liveEvents.subscribe((event) => {
    if (event.type === "diagnostic") {
      transitions.push({
        diagnostic: event.level,
        message: event.message,
      });
      return;
    }
    transitions.push({
      eventId: event.state.definition.id,
      status: event.state.resolution.status,
      resolution: event.state.resolution,
      latestState: event.state.latestState,
    });
  });
  const assertions = [];
  let baseline;
  let stopError;
  try {
    await runtime.application.start({ startAgent: false });
    const status = await runtime.application.getStatus();
    baseline = await runtime.application.inspectSession();
    const track = await firstEventCapableTrack(runtime.application, baseline);
    if (status.state !== "connected" || track === undefined) {
      throw new Error(
        "Live Event smoke requires one connected non-Group Live track",
      );
    }
    const occurrence = baseline.tracks
      .slice(0, track.index)
      .filter(({ name }) => name === track.name).length;
    const definitionTime = Date.now();
    const now = new Date(definitionTime).toISOString();
    const eventId = `live-event.${randomUUID()}`;
    const definition = {
      id: eventId,
      name: "Runner triggered clip",
      projectId: status.liveSetId,
      kind: "track.triggered_clip_changed",
      classification: "discrete",
      enabled: true,
      target: { track: { name: track.name, occurrence } },
      createdAt: now,
      updatedAt: now,
    };

    runtime.liveEvents.setConfiguration([definition], []);
    const resolved = await waitForLiveEventState(
      runtime.liveEvents,
      eventId,
      (state) =>
        state.resolution.status === "resolved" &&
        state.latestState?.kind === "track.triggered_clip_changed",
      manifest.timeoutMs,
    );
    assertions.push({
      assertion: "event-resolved-with-initial-state",
      passed:
        resolved.resolution.status === "resolved" &&
        resolved.resolution.trackReference === track.reference,
      evidence: resolved,
    });

    const disabled = {
      ...definition,
      enabled: false,
      updatedAt: new Date(definitionTime + 1).toISOString(),
    };
    runtime.liveEvents.setConfiguration([disabled], []);
    await waitForSubscriptionCount(runtime.ableton, 0, manifest.timeoutMs);
    assertions.push({
      assertion: "disable-unsubscribes",
      passed: true,
    });

    const reenabled = {
      ...disabled,
      enabled: true,
      updatedAt: new Date(definitionTime + 2).toISOString(),
    };
    runtime.liveEvents.setConfiguration([reenabled], []);
    await waitForSubscriptionCount(runtime.ableton, 1, manifest.timeoutMs);
    assertions.push({
      assertion: "reenable-resubscribes-once",
      passed: true,
    });

    const missing = {
      ...reenabled,
      target: {
        track: {
          name: `AA_EVENT_MISSING_${randomUUID()}`,
          occurrence: 0,
        },
      },
      updatedAt: new Date(definitionTime + 3).toISOString(),
    };
    runtime.liveEvents.setConfiguration([missing], []);
    const unresolved = await waitForLiveEventState(
      runtime.liveEvents,
      eventId,
      (state) => state.resolution.status === "unresolved",
      manifest.timeoutMs,
    );
    await waitForSubscriptionCount(runtime.ableton, 0, manifest.timeoutMs);
    assertions.push({
      assertion: "missing-target-is-bounded-and-unsubscribed",
      passed:
        unresolved.resolution.status === "unresolved" &&
        unresolved.resolution.detail?.includes("was not found") === true,
      evidence: unresolved.resolution,
    });

    const corrected = {
      ...reenabled,
      updatedAt: new Date(definitionTime + 4).toISOString(),
    };
    runtime.liveEvents.setConfiguration([corrected], []);
    await waitForLiveEventState(
      runtime.liveEvents,
      eventId,
      (state) => state.resolution.status === "resolved",
      manifest.timeoutMs,
    );
    await waitForSubscriptionCount(runtime.ableton, 1, manifest.timeoutMs);
    assertions.push({
      assertion: "corrected-target-recovers",
      passed: true,
    });

    runtime.liveEvents.setConfiguration([], []);
    await waitForSubscriptionCount(runtime.ableton, 0, manifest.timeoutMs);
    const after = await runtime.application.inspectSession();
    assertions.push({
      assertion: "cleanup-and-session-unchanged",
      passed: JSON.stringify(after) === JSON.stringify(baseline),
      evidence:
        JSON.stringify(after) === JSON.stringify(baseline)
          ? undefined
          : { baseline, after },
    });
  } catch (error) {
    assertions.push({
      assertion: "scenario-execution",
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    unsubscribe();
    try {
      await runtime.application.stop();
    } catch (error) {
      stopError = error instanceof Error ? error.message : String(error);
    }
  }
  if (stopError !== undefined) {
    assertions.push({
      assertion: "runtime-cleanup",
      passed: false,
      message: stopError,
    });
  }
  return {
    ok: assertions.every(({ passed }) => passed),
    scenarioId: manifest.id,
    assertions,
    transitions,
  };
}

async function firstEventCapableTrack(application, snapshot) {
  for (const track of snapshot.tracks) {
    try {
      await application.inspectDevices({
        index: track.index,
        expectedReference: track.reference,
        expectedName: track.name,
        offset: 0,
        limit: 1,
      });
      return track;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "conflict"
      ) {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

async function waitForLiveEventState(
  liveEvents,
  eventId,
  predicate,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = liveEvents.getState(eventId);
    if (state !== undefined && predicate(state)) return state;
    await new Promise((resolve_) => setTimeout(resolve_, 25));
  }
  throw new Error(
    `Timed out waiting for Live Event state '${eventId}': ${JSON.stringify(liveEvents.getState(eventId)?.resolution)}`,
  );
}

async function waitForSubscriptionCount(ableton, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await ableton.listLiveEventSubscriptions();
    if (result.subscriptions.length === expected) return;
    await new Promise((resolve_) => setTimeout(resolve_, 25));
  }
  throw new Error(`Timed out waiting for ${expected} Live Event subscriptions`);
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
