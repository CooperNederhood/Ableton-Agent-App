import { lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  validateResult,
  createDefaultAssertions,
  verifyRestoredAgentListeningEvidence,
  validateAgentListeningEvidence,
} from "../../packages/test-support/src/integration/index.js";
import { acceptanceDefinition, readAcceptanceJson } from "./acceptance-cli.js";
import {
  evidenceHash,
  sameSuiteInputs,
  type SuiteAttempt,
  type SuiteInputs,
} from "./acceptance-suite.js";

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed acceptance receipt");
}
export async function readSuiteAttempt(options: {
  root: string;
  suiteDirectory: string;
  directory: string;
  scenarioId: string;
  runId: string;
  traceId: string;
  inputs: SuiteInputs;
  exitCode?: number;
}): Promise<SuiteAttempt> {
  const path = join(options.directory, "receipt.json");
  const value = await readAcceptanceJson(path, 64 * 1024 * 1024);
  record(value);
  if (
    value.schema !== "acceptance-run/v1" ||
    value.finalization !== "final" ||
    value.completionOwner !== "acceptance-cli"
  )
    throw new Error(
      "Case evidence is not an acceptance-owned terminal receipt",
    );
  if (value.result === undefined) {
    if (
      value.status !== "failed" ||
      value.admitted !== false ||
      evidenceHash(value.selected) !== evidenceHash([options.scenarioId]) ||
      evidenceHash(value.executed) !== evidenceHash([]) ||
      evidenceHash(value.unrun) !== evidenceHash([options.scenarioId])
    )
      throw new Error(
        "Case admission failed with unknown execution or cleanup",
      );
    return {
      scenarioId: options.scenarioId,
      runId: options.runId,
      status: "blocked",
      executed: false,
      cleanupComplete: true,
      persisted: true,
      receiptPath: relative(options.suiteDirectory, path),
      receiptSha256: evidenceHash(value),
      assertions: [],
      failure:
        typeof value.message === "string"
          ? value.message
          : "Case admission failed",
    };
  }
  validateResult(value.result);
  const result = value.result;
  if (
    result.runId !== options.runId ||
    result.traceId !== options.traceId ||
    result.scenarioId !== options.scenarioId
  )
    throw new Error("Case receipt has stale or foreign run identity");
  const { scenario, fixture } = await acceptanceDefinition(
    options.root,
    options.scenarioId,
  );
  if (
    result.fixtureId !== fixture.id ||
    evidenceHash(result.selected) !==
      evidenceHash(scenario.steps.map(({ id }) => id))
  )
    throw new Error("Case receipt does not match the frozen scenario contract");
  let checkpointSha256: string | undefined;
  let productEvidenceSha256: string | undefined;
  let cleanupEvidenceSha256: string | undefined;
  let resourcesReclaimed: boolean | undefined;
  let cleanupFailureCount: number | undefined;
  try {
    const cleanup = await readAcceptanceJson(
      join(options.directory, "cleanup-evidence.json"),
    );
    record(cleanup);
    record(cleanup.resources);
    const resources = cleanup.resources;
    const resourceKeys = [
      "desktopStopped",
      "liveStopped",
      "hostReservationClosed",
      "profileRemoved",
    ];
    if (
      cleanup.schema !== "acceptance-cleanup/v1" ||
      cleanup.runId !== result.runId ||
      cleanup.scenarioId !== result.scenarioId ||
      cleanup.traceId !== result.traceId ||
      !Array.isArray(cleanup.failures) ||
      resourceKeys.some((key) => typeof resources[key] !== "boolean")
    )
      throw new Error(
        "Case cleanup evidence is incomplete or belongs to another execution",
      );
    resourcesReclaimed = resourceKeys.every((key) => resources[key] === true);
    cleanupFailureCount = cleanup.failures.length;
    cleanupEvidenceSha256 = evidenceHash(cleanup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (result.cleanupComplete || resourcesReclaimed) {
    try {
      await lstat(join(options.directory, "profile"));
      throw new Error("Case left its isolated credential profile behind");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (result.status === "passed") {
    if (options.exitCode !== undefined && options.exitCode !== 0)
      throw new Error("Case exit status disagrees with its passing receipt");
    if (
      !result.cleanupComplete ||
      !result.persisted ||
      value.droppedEvents !== 0 ||
      result.primaryFailure ||
      result.finalizationFailures.length ||
      result.unrun.length ||
      evidenceHash(result.executed) !== evidenceHash(result.selected) ||
      result.assertions.some(({ passed }) => !passed)
    )
      throw new Error(
        "Passing case lacks complete execution, assertion or finalization evidence",
      );
    const requiredAssertions = [
      ...scenario.steps.flatMap((step) =>
        step.assertions.map(({ name }) => name),
      ),
      ...scenario.assertions.map(({ name }) => name),
    ];
    if (
      evidenceHash(result.assertions.map(({ name }) => name)) !==
        evidenceHash(requiredAssertions) ||
      result.turns.length !== scenario.steps.length ||
      result.turns.some((turn) => turn.status !== "completed") ||
      !result.baseline ||
      (fixture.dependencies.length > 0 && !result.dependencyInventory)
    )
      throw new Error(
        "Passing case omits required assertions, turns, baseline or dependency provenance",
      );
    if (
      result.evidence?.facts.candidateSha256 !== options.inputs.appAsarSha256 ||
      typeof result.evidence.facts.liveVersion !== "string" ||
      !/^11\.\d+\.\d+/u.test(result.evidence.facts.liveVersion)
    )
      throw new Error(
        "Case does not identify the expected candidate and full Live 11 version",
      );
    const checkpoint = await readAcceptanceJson(
      join(options.directory, "checkpoint.json"),
      64 * 1024 * 1024,
    );
    record(checkpoint);
    record(checkpoint.result);
    if (
      checkpoint.finalization !== "checkpoint" ||
      checkpoint.result.runId !== result.runId ||
      checkpoint.result.traceId !== result.traceId
    )
      throw new Error("Missing or mismatched case persistence checkpoint");
    checkpointSha256 = evidenceHash(checkpoint);
    const product = await readAcceptanceJson(
      join(options.directory, "product-evidence.json"),
      64 * 1024 * 1024,
    );
    record(product);
    record(product.provenance);
    if (
      product.schema !== "acceptance-product-evidence/v1" ||
      product.runId !== result.runId ||
      product.scenarioId !== result.scenarioId ||
      product.traceId !== result.traceId ||
      product.provenance.candidateSha256 !== options.inputs.appAsarSha256 ||
      product.provenance.liveVersion !== result.evidence.facts.liveVersion
    )
      throw new Error(
        "Product evidence candidate/version attribution mismatch",
      );
    productEvidenceSha256 = evidenceHash(product);
    for (const [index, step] of scenario.steps.entries()) {
      const contract = step.assertions.find(
        ({ name }) => name === "agent-listening-result",
      );
      if (!contract) continue;
      const turn = result.turns[index]!;
      const assertion = createDefaultAssertions().evaluate(contract, {
        fixture,
        baseline: result.baseline,
        turns: result.turns,
        turn,
        evidence: result.evidence,
      });
      if (!assertion.passed) throw new Error(assertion.detail);
      if (
        !Array.isArray(product.agentListening) ||
        !Array.isArray(product.restoredAgentListening)
      )
        throw new Error("Missing persisted typed agent consumption evidence");
      product.agentListening.forEach(validateAgentListeningEvidence);
      product.restoredAgentListening.forEach(validateAgentListeningEvidence);
      if (
        evidenceHash(product.agentListening) !==
          evidenceHash(
            result.turns.flatMap((entry) =>
              entry.agentListening ? [entry.agentListening] : [],
            ),
          ) ||
        evidenceHash(product.restoredAgentListening) !==
          evidenceHash(result.evidence.agentListening)
      )
        throw new Error("Receipt/product agent consumption evidence mismatch");
      verifyRestoredAgentListeningEvidence(
        result.turns,
        result.evidence.agentListening ?? [],
      );
    }
    if (!resourcesReclaimed || cleanupFailureCount !== 0)
      throw new Error(
        "Passing case lacks complete clean resource reclamation evidence",
      );
  }
  return {
    scenarioId: result.scenarioId,
    runId: result.runId,
    status: result.status,
    executed: result.executed.length > 0,
    cleanupComplete: result.cleanupComplete,
    ...(resourcesReclaimed !== undefined ? { resourcesReclaimed } : {}),
    persisted: result.persisted,
    receiptPath: relative(options.suiteDirectory, path),
    receiptSha256: evidenceHash(value),
    assertions: result.assertions,
    ...(typeof result.evidence?.facts.liveVersion === "string"
      ? { liveVersion: result.evidence.facts.liveVersion }
      : {}),
    ...(result.primaryFailure
      ? {
          failure: `${result.primaryFailure.stage}: ${result.primaryFailure.message}`,
        }
      : {}),
    ...(checkpointSha256 ? { checkpointSha256 } : {}),
    ...(productEvidenceSha256 ? { productEvidenceSha256 } : {}),
    ...(cleanupEvidenceSha256 ? { cleanupEvidenceSha256 } : {}),
  };
}

export async function verifyAcceptanceSuite(options: {
  root: string;
  receiptPath: string;
  inputs: SuiteInputs;
}): Promise<void> {
  const value = await readAcceptanceJson(options.receiptPath, 64 * 1024 * 1024);
  record(value);
  if (
    value.schema !== "acceptance-suite/v1" ||
    value.finalization !== "final" ||
    value.status !== "passed" ||
    value.cleanupComplete !== true ||
    value.resourcesReclaimed !== true ||
    options.inputs.dirty ||
    !Array.isArray(value.failures) ||
    value.failures.length ||
    value.firstFailure !== undefined ||
    evidenceHash(value.policy) !==
      evidenceHash({
        attemptsPerScenario: 1,
        automaticRetries: 0,
        selection: "all-registered",
      })
  )
    throw new Error("Suite is not a completed successful qualification");
  record(value.inputs);
  if (evidenceHash(value.inputs) !== evidenceHash(options.inputs))
    throw new Error("Candidate, source, registry or fixture evidence is stale");
  sameSuiteInputs(options.inputs, options.inputs);
  for (const key of ["selected", "executed"])
    if (evidenceHash(value[key]) !== evidenceHash(options.inputs.selected))
      throw new Error(`Incomplete suite ${key} accounting`);
  if (
    evidenceHash(value.unrun) !== evidenceHash([]) ||
    evidenceHash(value.unknown) !== evidenceHash([]) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length !== options.inputs.selected.length ||
    typeof value.traceId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.traceId)
  )
    throw new Error("Incomplete suite attempt identities");
  const runIds = new Set<string>();
  for (const [index, scenarioId] of options.inputs.selected.entries()) {
    const attempt: unknown = value.attempts[index];
    record(attempt);
    if (
      typeof attempt.runId !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(attempt.runId) ||
      runIds.has(attempt.runId)
    )
      throw new Error("Missing or duplicate case run identity");
    runIds.add(attempt.runId);
    const expectedPath = `case-${index + 1}/receipt.json`;
    if (attempt.receiptPath !== expectedPath)
      throw new Error("Case receipt path escapes suite ownership or order");
    const actual = await readSuiteAttempt({
      root: options.root,
      suiteDirectory: dirname(options.receiptPath),
      directory: join(dirname(options.receiptPath), `case-${index + 1}`),
      scenarioId,
      runId: attempt.runId,
      traceId: value.traceId,
      inputs: options.inputs,
    });
    if (
      actual.status !== "passed" ||
      evidenceHash(actual) !== evidenceHash(attempt)
    )
      throw new Error("Case terminal evidence was changed or does not qualify");
  }
}
