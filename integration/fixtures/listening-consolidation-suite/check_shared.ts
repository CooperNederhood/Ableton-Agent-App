import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  inspectAcceptanceProject,
  readAcceptanceProjectReferences,
  readSavedFollowAction,
} from "../../../tests/electron/acceptance-project.js";
import { bindFixtureProject } from "../../../packages/test-support/src/integration/project-binding.js";
import {
  validateFixture,
  validatePermission,
  validateScenario,
} from "../../../packages/test-support/src/integration/validation.js";
import type { ScenarioManifest } from "../../../packages/test-support/src/integration/contracts.js";

const root = new URL("./", import.meta.url);
const fixture: unknown = JSON.parse(
  readFileSync(new URL("fixture.json", root), "utf8"),
);
validateFixture(fixture);
assert.equal(fixture.qualification, "reviewed-live");
assert.equal(fixture.sources?.length, 4);
assert.deepEqual(
  fixture.arrangementSources?.map(({ id }) => id),
  ["arrangement-short-midi", "arrangement-long-midi", "arrangement-audio"],
);
const bytes = readFileSync(new URL("project.als", root));
const refs = readAcceptanceProjectReferences(bytes, true);
assert.deepEqual(
  Object.fromEntries(
    ["3", "5", "6", "7"].map((type) => [
      type,
      refs.filter((ref) => ref.relativePathType === type).length,
    ]),
  ),
  { "3": 10, "5": 69, "6": 2, "7": 2 },
);
for (const [type, resources] of [
  ["5", fixture.coreLibraryResources],
  ["7", fixture.builtinResources],
] as const)
  assert.deepEqual(
    [
      ...new Set(
        refs
          .filter((ref) => ref.relativePathType === type)
          .map((ref) => ref.relativePath),
      ),
    ].sort(),
    resources!.map((resource) => resource.path).sort(),
  );
for (const track of [0, 1])
  for (const slot of [0, 4])
    assert.equal(readSavedFollowAction(bytes, track, slot), false);

// Synthetic in-memory target tests slot compatibility, not candidate admission.
const target = "dependencies/machine-listening/frozen/fixture-check.amxd";
const device = {
  id: "machine-listening",
  sourceTarget: "fixture-check.amxd",
  target,
  sha256: "0".repeat(64),
  bytes: 1,
};
const bindings = fixture.listenerBindings!;
const bound = bindFixtureProject(
  bytes,
  bindings,
  [device],
  "/offline-check-only",
);
assert.equal(
  inspectAcceptanceProject(
    bound,
    new Set([...fixture.resources.map((resource) => resource.target), target]),
    true,
    fixture.builtinResources,
    fixture.coreLibraryResources,
  ).length,
  12,
);
assert.throws(() =>
  bindFixtureProject(bytes, bindings.slice(1), [device], "/offline-check-only"),
);
assert.throws(() =>
  bindFixtureProject(
    bytes,
    [{ ...bindings[0]!, deviceIndex: 0 }, bindings[1]!],
    [device],
    "/offline-check-only",
  ),
);
assert.throws(() =>
  inspectAcceptanceProject(
    bound,
    new Set(fixture.resources.map((resource) => resource.target)),
    true,
    fixture.builtinResources,
    fixture.coreLibraryResources,
  ),
);
let admitted = 0;
let blocked = 0;
for (const length of ["short", "long"])
  for (const kind of ["midi", "audio"]) {
    const suffix = `${length}-${kind}`;
    const scenario = JSON.parse(
      readFileSync(
        new URL(
          `../../acceptance-scenarios/listening-consolidation-${suffix}.json`,
          root,
        ),
        "utf8",
      ),
    ) as ScenarioManifest;
    assert.equal(scenario.id, `listening-consolidation-${suffix}`);
    assert.equal(scenario.fixtureId, fixture.id);
    assert(!scenario.requiredCapabilities.includes("direct-operations"));
    scenario.permissions.forEach(validatePermission);
    for (const step of scenario.steps) {
      assert.equal(typeof step.message, "string");
      assert(step.message.length > 0);
      assert(!("operation" in step));
      assert(!step.message.includes("$capture."));
    }
    const captures = scenario.steps.filter((step) =>
      ["listen-session", "listen-arrangement"].includes(step.id),
    );
    assert.deepEqual(
      captures.map((step) => step.id),
      ["listen-session", "listen-arrangement"],
    );
    const session = scenario.permissions.find(
      (permission) => permission.action === "play-session-and-listen",
    );
    const arrangement = scenario.permissions.find(
      (permission) => permission.action === "play-arrangement-and-listen",
    );
    assert(session && arrangement);
    const beats = length === "long" ? 80 : 4;
    assert.equal(session.arguments?.durationBeats, beats);
    assert.equal(
      session.arguments?.["target.track.index"],
      kind === "midi" ? 0 : 1,
    );
    assert.equal(session.arguments?.["target.sceneIndex"], "$source.slotIndex");
    assert.equal(arrangement.arguments?.startBeat, 0);
    assert.equal(arrangement.arguments?.endBeat, beats);
    assert.deepEqual(captures[1]!.setupActions, [
      "stop-transport",
      "back-to-arrangement",
    ]);
    const restarts = scenario.steps.filter((step) =>
      step.setupActions?.includes("restart-owned-desktop"),
    );
    assert.equal(restarts.length, 1);
    assert.deepEqual(restarts[0]!.setupActions, [
      "stop-transport",
      "restart-owned-desktop",
    ]);
    assert.deepEqual(
      scenario.assertions.find(({ name }) => name === "storage-shape")
        ?.parameters,
      { expectedMeasures: length === "long" ? 20 : 1 },
    );
    assert(
      !scenario.assertions.some(({ name }) => name === "feature-equivalence"),
    );
    const sourceIds = new Set([
      ...(fixture.sources ?? []).map(({ id }) => id),
      ...(fixture.arrangementSources ?? []).map(({ id }) => id),
    ]);
    if (captures.some((step) => !sourceIds.has(step.sourceId!))) {
      assert.throws(
        () => validateScenario(scenario, fixture),
        scenario.requiredCapabilities.includes("arrangement-audio")
          ? /Unknown step source/u
          : /Arrangement source requires explicit Arrangement capability/u,
        "Missing source/capability admission must remain blocked",
      );
      blocked++;
    } else {
      validateScenario(scenario, fixture);
      admitted++;
    }
  }
console.log(
  JSON.stringify({
    status: "verified-message-contracts-offline",
    savedListenersBindable: true,
    activeFactoryInventoryExact: true,
    savedTargetFollowActionsDisabled: true,
    negativeBindingAndResourceChecks: 3,
    messageCasesChecked: 4,
    admittedCases: admitted,
    blockedCases: blocked,
    captureQualification: false,
  }),
);
