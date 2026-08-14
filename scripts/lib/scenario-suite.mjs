import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const idPattern = /^[a-z0-9][a-z0-9-]*$/;

export async function loadScenarioSuite(baseDirectory = process.cwd()) {
  const path = resolve(
    baseDirectory,
    "integration",
    "live-scenarios",
    "suite.json",
  );
  const suite = JSON.parse(await readFile(path, "utf8"));
  validateSuite(suite);
  return suite;
}

export function selectScenarioGroups(
  suite,
  { group, scenario, scenarios = [], resumeFrom } = {},
) {
  const knownGroups = new Set(suite.groups.map((entry) => entry.id));
  const allScenarios = suite.groups.flatMap((entry) => entry.scenarios);
  const knownScenarios = new Set(allScenarios);
  if (group !== undefined && !knownGroups.has(group)) {
    throw new Error(`Unknown scenario group: ${group}`);
  }
  const requested = new Set(
    [scenario, ...scenarios].filter((value) => value !== undefined),
  );
  for (const id of requested) {
    if (!knownScenarios.has(id)) throw new Error(`Unknown scenario: ${id}`);
  }
  if (resumeFrom !== undefined && !knownScenarios.has(resumeFrom)) {
    throw new Error(`Unknown resume scenario: ${resumeFrom}`);
  }

  let resumeReached = resumeFrom === undefined;
  const selected = [];
  for (const entry of suite.groups) {
    if (group !== undefined && entry.id !== group) continue;
    const groupScenarios = [];
    for (const id of entry.scenarios) {
      if (!resumeReached) {
        resumeReached = id === resumeFrom;
        if (!resumeReached) continue;
      }
      if (requested.size > 0 && !requested.has(id)) continue;
      groupScenarios.push(id);
    }
    if (groupScenarios.length > 0) {
      selected.push({ id: entry.id, scenarios: groupScenarios });
    }
  }
  if (resumeFrom !== undefined && !resumeReached) {
    throw new Error(
      `Resume scenario '${resumeFrom}' is outside the selected group`,
    );
  }
  if (selected.length === 0) {
    throw new Error("Scenario selection is empty");
  }
  return selected;
}

function validateSuite(suite) {
  if (
    suite === null ||
    typeof suite !== "object" ||
    suite.formatVersion !== 1 ||
    !Array.isArray(suite.groups) ||
    suite.groups.length === 0
  ) {
    throw new Error("Invalid live scenario suite manifest");
  }
  const groups = new Set();
  const scenarios = new Set();
  for (const entry of suite.groups) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !idPattern.test(entry.id) ||
      !Array.isArray(entry.scenarios) ||
      entry.scenarios.length === 0
    ) {
      throw new Error("Invalid live scenario suite group");
    }
    if (groups.has(entry.id)) {
      throw new Error(`Duplicate scenario group: ${entry.id}`);
    }
    groups.add(entry.id);
    for (const id of entry.scenarios) {
      if (typeof id !== "string" || !idPattern.test(id)) {
        throw new Error(`Invalid scenario ID in group '${entry.id}'`);
      }
      if (scenarios.has(id)) throw new Error(`Duplicate scenario: ${id}`);
      scenarios.add(id);
    }
  }
}
