import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  projectFlatnessSmoke,
  validateFlatnessSmoke,
} from "./flatness-smoke.js";
import {
  flatnessHistory,
  flatnessOwner,
} from "./flatness-smoke-test-support.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateScenario } from "./validation.js";
import type { FixtureManifest, ScenarioManifest } from "./contracts.js";

describe("bounded unqualified flatness diagnostic evidence", () => {
  it("binds launch causation even when its callback journals queued first", () => {
    const history = flatnessHistory();
    history[0]!.sequence = 2;
    history[1]!.sequence = 1;
    const ordered = [history[1]!, history[0]!, ...history.slice(2)];
    expect(
      projectFlatnessSmoke(ordered, flatnessOwner).events[0]!.causationId,
    ).toBe(history[0]!.id);
  });
  it("registers one exact smoke turn without changing the original fixture, permissions or baseline oracle", async () => {
    const read = async (path: string) =>
      JSON.parse(
        await readFile(
          new URL(`../../../../integration/${path}`, import.meta.url),
          "utf8",
        ),
      ) as unknown;
    const original = (await read(
      "acceptance-scenarios/session-clip-identify.json",
    )) as ScenarioManifest;
    const smoke = (await read(
      "acceptance-scenarios/session-flucoma-flatness-smoke.json",
    )) as ScenarioManifest;
    const fixture = (await read(
      "fixtures/session-clip-identify/fixture.json",
    )) as FixtureManifest;
    const suite = (await read("acceptance-scenarios/suite.json")) as {
      scenarios: string[];
    };
    const registry = createDefaultAssertions();
    validateScenario(smoke, fixture, registry.names);
    for (const assertion of [
      ...smoke.assertions,
      ...smoke.steps.flatMap((step) => step.assertions),
    ])
      registry.validate(assertion);
    expect(suite.scenarios.filter((id) => id === smoke.id)).toHaveLength(1);
    expect(smoke.fixtureId).toBe(original.fixtureId);
    expect(smoke.permissions).toEqual(original.permissions);
    expect(smoke.budget).toEqual(original.budget);
    expect(smoke.steps).toHaveLength(1);
    expect(smoke.steps[0]!.message).toBe(
      "Listen to the first Session clip on track audio-track, including spectral flatness.",
    );
    expect(
      smoke.steps[0]!.assertions.filter(
        (entry) => entry.name !== "flatness-smoke",
      ),
    ).toEqual(original.steps[0]!.assertions);
    expect(
      smoke.assertions.filter((entry) => entry.name !== "flatness-smoke"),
    ).toEqual(original.assertions);
    expect(original.steps).toHaveLength(2);
  });
  it("projects actual typed History lifecycle facts, not measurement support", () => {
    const projected = projectFlatnessSmoke(flatnessHistory(), flatnessOwner);
    expect(projected.events).toHaveLength(7);
    expect(projected.events.at(-1)?.facts).toMatchObject({
      "flatness.leftDb": { state: "observed", value: -12 },
      "flatness.rightDb": { state: "observed", value: -17 },
      "flatness.support": { state: "observed", value: "unqualified" },
      "flatness.leftDeliveries": { state: "observed", value: 2 },
      "flatness.cleanup": { state: "observed", value: "completed" },
    });
    expect(
      projectFlatnessSmoke(flatnessHistory(), flatnessOwner, true),
    ).toEqual({ ...projected, afterOwnedRestart: true });
  });
  it.each(["traceId", "correlationId", "passId", "listenerId"] as const)(
    "rejects foreign %s",
    (key) => {
      expect(() =>
        projectFlatnessSmoke(flatnessHistory(), {
          ...flatnessOwner,
          [key]: "foreign",
        }),
      ).toThrow();
    },
  );
  it.each([
    "generation",
    "connectionId",
    "connectionEpoch",
    "nativeEpoch",
  ] as const)("rejects foreign native %s", (key) => {
    expect(() =>
      projectFlatnessSmoke(flatnessHistory(), {
        ...flatnessOwner,
        native: {
          ...flatnessOwner.native,
          [key]: key === "nativeEpoch" ? 2 : "foreign",
        },
      }),
    ).toThrow();
  });
  it.each([
    ["scope", "frame-qualified/v1"],
    ["frames", 1],
    ["metric", "spectral-centroid"],
    ["generation", "foreign"],
    ["nativeEpoch", 2],
    ["eventId", "foreign"],
    ["causationId", "foreign"],
    ["durationMs", -1],
    ["phase", "launch"],
  ])("rejects malformed native lifecycle %s", (key, value) => {
    const history = flatnessHistory();
    Object.assign(history[3]!.attributes.lifecycle!, {
      [key]: value,
    });
    expect(() => projectFlatnessSmoke(history, flatnessOwner)).toThrow();
  });
  it.each(["source", "outcome", "causationId"] as const)(
    "requires production envelope %s",
    (key) => {
      const history = flatnessHistory();
      Object.assign(history[3]!, { [key]: "foreign" });
      expect(() => projectFlatnessSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it.each([
    ["flatness.leftDb", { state: "unavailable", reason: "not-reported" }],
    ["flatness.rightDb", { state: "unavailable", reason: "not-reported" }],
    ["flatness.leftClass", { state: "unavailable", reason: "not-reported" }],
    ["flatness.rightClass", { state: "observed", value: "jbogus" }],
    ["flatness.leftDb", { state: "observed", value: -321 }],
    ["flatness.rightDb", { state: "observed", value: 0.1 }],
    ["flatness.leftDb", { state: "observed", value: Number.NaN }],
    ["flatness.rightDb", { state: "observed", value: Infinity }],
    ["flatness.leftDb", { state: "observed", value: "-12" }],
    ["flatness.support", { state: "observed", value: "qualified" }],
    ["flatness.valueValidity", { state: "observed", value: "valid" }],
    ["flatness.channelPolicy", { state: "observed", value: "mono" }],
    ["flatness.leftDeliveries", { state: "observed", value: 0 }],
    ["flatness.rightDeliveries", { state: "observed", value: 401 }],
    ["flatness.rightDeliveries", { state: "observed", value: 1.5 }],
    ["flatness.cleanup", { state: "observed", value: "pending" }],
  ])("rejects invalid snapshot %s %j", (field, actual) => {
    const evidence = structuredClone(
      projectFlatnessSmoke(flatnessHistory(), flatnessOwner),
    );
    Object.assign(evidence.events.at(-1)!.facts, { [field]: actual });
    expect(() => validateFlatnessSmoke(evidence)).toThrow();
  });
  it.each(["failed", "cancelled"])(
    "rejects local %s even with cleanup completion",
    (stage) => {
      const evidence = structuredClone(
        projectFlatnessSmoke(flatnessHistory(), flatnessOwner),
      );
      Object.assign(evidence.events[2]!, {
        stage,
        reason: "flatness_no_output",
      });
      expect(() => validateFlatnessSmoke(evidence)).toThrow();
    },
  );
  it("rejects absent, duplicate, reordered, stale, truncated and excessive events", () => {
    const history = flatnessHistory();
    for (const events of [
      [],
      history.slice(1),
      history.slice(0, -1),
      [...history, history[3]!],
      [history[0]!, history[2]!, history[1]!, ...history.slice(3)],
      [...history, ...Array.from({ length: 1024 }, () => history[3]!)],
    ])
      expect(() => projectFlatnessSmoke(events, flatnessOwner)).toThrow();
    const evidence = structuredClone(
      projectFlatnessSmoke(history, flatnessOwner),
    );
    Object.assign(evidence.events[2]!, { elapsedMs: -1 });
    expect(() => validateFlatnessSmoke(evidence)).toThrow();
  });
  it("rejects unknown, duplicated, missing and truncated facts rather than persisting them", () => {
    for (const mutation of ["unknown", "duplicate", "missing", "truncated"]) {
      const history = flatnessHistory();
      const lifecycle = history[3]!.attributes.lifecycle as {
        facts: { field: string; actual: object }[];
      };
      if (mutation === "unknown") lifecycle.facts[0]!.field = "secret";
      if (mutation === "duplicate")
        lifecycle.facts[0]!.field = lifecycle.facts[1]!.field;
      if (mutation === "missing") lifecycle.facts.pop();
      if (mutation === "truncated")
        Object.assign(lifecycle.facts[0]!.actual, { truncated: true });
      expect(() => projectFlatnessSmoke(history, flatnessOwner)).toThrow();
    }
  });
});
