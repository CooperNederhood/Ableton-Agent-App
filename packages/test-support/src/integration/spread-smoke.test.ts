import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { projectSpreadSmoke, validateSpreadSmoke } from "./spread-smoke.js";
import {
  flatnessOwner,
  flatnessHistory,
} from "./flatness-smoke-test-support.js";
import { spreadHistory } from "./spread-smoke-test-support.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateScenario } from "./validation.js";
import type { FixtureManifest, ScenarioManifest } from "./contracts.js";

describe("unqualified spread smoke evidence", () => {
  it("requires distinct spread output even when native and flatness evidence exists", () => {
    expect(() =>
      projectSpreadSmoke(flatnessHistory(), flatnessOwner),
    ).toThrow();
    const projected = projectSpreadSmoke(spreadHistory(), flatnessOwner);
    expect(projected.events).toHaveLength(7);
    expect(projected.events.at(-1)?.facts).toMatchObject({
      "spread.leftHz": { state: "observed", value: 1200 },
      "spread.rightHz": { state: "observed", value: 1700 },
      "spread.support": { state: "observed", value: "unqualified" },
      "spread.valueValidity": { state: "observed", value: "unqualified" },
      "spread.cleanup": { state: "observed", value: "completed" },
    });
  });
  it("registers the reviewed single turn on the unchanged existing fixture", async () => {
    const read = async (path: string): Promise<unknown> =>
      JSON.parse(
        await readFile(
          new URL(`../../../../integration/${path}`, import.meta.url),
          "utf8",
        ),
      );
    const original = (await read(
      "acceptance-scenarios/session-flucoma-flatness-smoke.json",
    )) as ScenarioManifest;
    const smoke = (await read(
      "acceptance-scenarios/session-flucoma-spread-smoke.json",
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
      "Listen to the first Session clip on track audio-track, including spectral spread.",
    );
    expect(
      smoke.steps[0]!.assertions.filter(
        (entry) => entry.name !== "spread-smoke",
      ),
    ).toEqual(original.steps[0]!.assertions);
    expect(
      smoke.assertions.filter((entry) => entry.name !== "spread-smoke"),
    ).toEqual(original.assertions);
  });
  it.each(["traceId", "correlationId", "passId", "listenerId"] as const)(
    "rejects foreign %s",
    (key) => {
      expect(() =>
        projectSpreadSmoke(spreadHistory(), {
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
      projectSpreadSmoke(spreadHistory(), {
        ...flatnessOwner,
        native: {
          ...flatnessOwner.native,
          [key]: key === "nativeEpoch" ? 2 : "foreign",
        },
      }),
    ).toThrow();
  });
  it.each([
    ["spread.leftHz", { state: "observed", value: -12 }],
    ["spread.rightHz", { state: "observed", value: NaN }],
    ["spread.leftHz", { state: "observed", value: Infinity }],
    ["spread.rightHz", { state: "observed", value: "1700" }],
    ["spread.leftHz", { state: "unavailable", reason: "not-reported" }],
    ["spread.rightHz", { state: "unavailable", reason: "not-reported" }],
    ["spread.units", { state: "observed", value: "dB" }],
    ["spread.unit", { state: "observed", value: 1 }],
    ["spread.minfreq", { state: "observed", value: 20 }],
    ["spread.maxfreq", { state: "observed", value: 20000 }],
    ["spread.support", { state: "observed", value: "qualified" }],
    ["spread.valueValidity", { state: "observed", value: "valid" }],
    ["spread.rightClass", { state: "observed", value: "jbogus" }],
    ["spread.leftDeliveries", { state: "observed", value: 0 }],
    ["spread.rightDeliveries", { state: "observed", value: 401 }],
    ["spread.rightDeliveries", { state: "observed", value: 1.5 }],
    ["spread.cleanup", { state: "observed", value: "pending" }],
  ])("rejects malformed or missing %s: %j", (field, actual) => {
    const evidence = structuredClone(
      projectSpreadSmoke(spreadHistory(), flatnessOwner),
    );
    Object.assign(evidence.events.at(-1)!.facts, { [field]: actual });
    expect(() => validateSpreadSmoke(evidence)).toThrow();
  });
  it.each(["failed", "cancelled"])(
    "rejects %s even with terminal gate cleanup",
    (stage) => {
      const evidence = structuredClone(
        projectSpreadSmoke(spreadHistory(), flatnessOwner),
      );
      Object.assign(evidence.events[2]!, { stage, reason: "spread_no_output" });
      expect(() => validateSpreadSmoke(evidence)).toThrow();
    },
  );
  it("never substitutes zero for absence, and accepts actual zero without a silence claim", () => {
    const evidence = structuredClone(
      projectSpreadSmoke(spreadHistory(), flatnessOwner),
    );
    for (const event of evidence.events)
      for (const channel of ["left", "right"]) {
        const fact = event.facts[`spread.${channel}Hz`];
        if (fact?.state === "observed") Object.assign(fact, { value: 0 });
      }
    expect(() => validateSpreadSmoke(evidence)).not.toThrow();
    expect(() => projectSpreadSmoke([], flatnessOwner)).toThrow();
  });
  it("rejects absent, duplicate, reordered, truncated and excessive events", () => {
    const history = spreadHistory();
    for (const events of [
      history.slice(1),
      history.slice(0, -1),
      [...history, history[3]!],
      [history[0]!, history[2]!, history[1]!, ...history.slice(3)],
      [...history, ...Array.from({ length: 1024 }, () => history[3]!)],
    ])
      expect(() => projectSpreadSmoke(events, flatnessOwner)).toThrow();
  });
  it.each(["unknown", "duplicate", "missing", "truncated"])(
    "rejects %s diagnostic facts",
    (mutation) => {
      const history = spreadHistory();
      const lifecycle = history[3]!.attributes.lifecycle as {
        facts: { field: string; actual: object }[];
      };
      if (mutation === "unknown") lifecycle.facts[0]!.field = "secret";
      if (mutation === "duplicate")
        lifecycle.facts[0]!.field = lifecycle.facts[1]!.field;
      if (mutation === "missing") lifecycle.facts.pop();
      if (mutation === "truncated")
        Object.assign(lifecycle.facts[0]!.actual, { truncated: true });
      expect(() => projectSpreadSmoke(history, flatnessOwner)).toThrow();
    },
  );
});
