import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { projectRolloffSmoke, validateRolloffSmoke } from "./rolloff-smoke.js";
import {
  flatnessHistory,
  flatnessOwner,
} from "./flatness-smoke-test-support.js";
import { spreadHistory } from "./spread-smoke-test-support.js";
import { rolloffHistory } from "./rolloff-smoke-test-support.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateScenario } from "./validation.js";
import type { FixtureManifest, ScenarioManifest } from "./contracts.js";

describe("unqualified rolloff smoke evidence", () => {
  it("requires the fixed nineteen-fact rolloff contract", () => {
    const projected = projectRolloffSmoke(rolloffHistory(), flatnessOwner);
    expect(projected.events).toHaveLength(7);
    expect(Object.keys(projected.events.at(-1)!.facts)).toHaveLength(19);
    expect(projected.events.at(-1)!.facts).toMatchObject({
      "rolloff.leftHz": { state: "observed", value: 6000 },
      "rolloff.rightHz": { state: "observed", value: 8000 },
      "rolloff.rolloffpercent": { state: "observed", value: 95 },
      "rolloff.support": { state: "observed", value: "unqualified" },
      "rolloff.valueValidity": { state: "observed", value: "unqualified" },
      "rolloff.cleanup": { state: "observed", value: "completed" },
    });
  });
  it("adds only the approved rolloff requirements to the unchanged spread scenario and fixture", async () => {
    const read = async (path: string): Promise<unknown> =>
      JSON.parse(
        await readFile(
          new URL(`../../../../integration/${path}`, import.meta.url),
          "utf8",
        ),
      );
    const original = (await read(
      "acceptance-scenarios/session-flucoma-spread-smoke.json",
    )) as ScenarioManifest;
    const smoke = (await read(
      "acceptance-scenarios/session-flucoma-rolloff-smoke.json",
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
    expect(smoke.fixtureId).toBe("session-clip-identify");
    expect(smoke.permissions).toEqual(original.permissions);
    expect(smoke.budget).toEqual(original.budget);
    expect(smoke.requiredCapabilities).toEqual(original.requiredCapabilities);
    expect(smoke.steps).toHaveLength(1);
    expect(smoke.steps[0]!.message).toBe(
      "Listen to the first Session clip on track audio-track, including spectral rolloff.",
    );
    expect(
      smoke.steps[0]!.assertions.filter(
        (entry) => entry.name !== "rolloff-smoke",
      ),
    ).toEqual(original.steps[0]!.assertions);
    expect(
      smoke.assertions.filter((entry) => entry.name !== "rolloff-smoke"),
    ).toEqual(original.assertions);
    expect(smoke.steps[0]!.assertions).toContainEqual({
      name: "rolloff-smoke",
      parameters: { sourceId: "a", afterRestart: false },
    });
    expect(smoke.assertions).toContainEqual({
      name: "rolloff-smoke",
      parameters: { sourceId: "a", afterRestart: true },
    });
  });
  it("does not substitute healthy native, spread or flatness evidence for rolloff", () => {
    expect(() =>
      projectRolloffSmoke(
        [...flatnessHistory(), ...spreadHistory().slice(1)],
        flatnessOwner,
      ),
    ).toThrow();
    expect(() => projectRolloffSmoke([], flatnessOwner)).toThrow();
  });
  it.each(["traceId", "correlationId", "passId", "listenerId"] as const)(
    "rejects foreign %s despite healthy sibling metrics",
    (key) => {
      expect(() =>
        projectRolloffSmoke(
          [
            ...flatnessHistory(),
            ...spreadHistory().slice(1),
            ...rolloffHistory({ ...flatnessOwner, [key]: "foreign" }).slice(1),
          ],
          flatnessOwner,
        ),
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
      projectRolloffSmoke(rolloffHistory(), {
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
    ["metric", "spectral-spread"],
    ["generation", "foreign"],
    ["nativeEpoch", 2],
    ["eventId", "foreign"],
    ["causationId", "foreign"],
    ["durationMs", -1],
    ["phase", "launch"],
  ])("rejects malformed lifecycle %s", (key, value) => {
    const history = rolloffHistory();
    Object.assign(history[3]!.attributes.lifecycle!, { [key]: value });
    expect(() => projectRolloffSmoke(history, flatnessOwner)).toThrow();
  });
  it.each(["source", "outcome", "causationId"] as const)(
    "requires the production envelope %s",
    (key) => {
      const history = rolloffHistory();
      Object.assign(history[3]!, { [key]: "foreign" });
      expect(() => projectRolloffSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it.each([
    ["rolloff.leftHz", { state: "observed", value: -1 }],
    ["rolloff.rightHz", { state: "observed", value: NaN }],
    ["rolloff.leftHz", { state: "observed", value: Infinity }],
    ["rolloff.rightHz", { state: "observed", value: "8000" }],
    ["rolloff.leftHz", { state: "unavailable", reason: "not-reported" }],
    ["rolloff.rightHz", { state: "unavailable", reason: "not-reported" }],
    ["rolloff.schema", { state: "observed", value: "flucoma-spread-smoke/v1" }],
    ["rolloff.units", { state: "observed", value: "dB" }],
    ["rolloff.channelPolicy", { state: "observed", value: "mono" }],
    ["rolloff.windowSamples", { state: "observed", value: 1024 }],
    ["rolloff.hopSamples", { state: "observed", value: 1024 }],
    ["rolloff.power", { state: "observed", value: 1 }],
    ["rolloff.unit", { state: "observed", value: 1 }],
    ["rolloff.minfreq", { state: "observed", value: 20 }],
    ["rolloff.maxfreq", { state: "observed", value: 20000 }],
    ["rolloff.rolloffpercent", { state: "observed", value: 85 }],
    ["rolloff.rolloffpercent", { state: "observed", value: "95" }],
    [
      "rolloff.rolloffpercent",
      { state: "unavailable", reason: "not-reported" },
    ],
    ["rolloff.support", { state: "observed", value: "qualified" }],
    ["rolloff.valueValidity", { state: "observed", value: "valid" }],
    ["rolloff.rightClass", { state: "observed", value: "jbogus" }],
    ["rolloff.leftDeliveries", { state: "observed", value: 0 }],
    ["rolloff.rightDeliveries", { state: "observed", value: 401 }],
    ["rolloff.rightDeliveries", { state: "observed", value: 1.5 }],
    ["rolloff.cleanup", { state: "observed", value: "pending" }],
  ])("rejects malformed or missing %s: %j", (field, actual) => {
    const evidence = structuredClone(
      projectRolloffSmoke(rolloffHistory(), flatnessOwner),
    );
    Object.assign(evidence.events.at(-1)!.facts, { [field]: actual });
    expect(() => validateRolloffSmoke(evidence)).toThrow();
  });
  it.each(["failed", "cancelled"])(
    "rejects %s even with healthy siblings and terminal cleanup",
    (stage) => {
      const history = rolloffHistory();
      const event = history[3]!;
      Object.assign(event.attributes.lifecycle!, {
        stage,
        reason: "rolloff_no_output",
      });
      event.name = `output.listener.native.metric.spectral-rolloff.${stage}`;
      event.outcome = stage === "failed" ? "failure" : "cancelled";
      expect(() =>
        projectRolloffSmoke(
          [
            ...history,
            ...flatnessHistory().slice(1),
            ...spreadHistory().slice(1),
          ],
          flatnessOwner,
        ),
      ).toThrow();
    },
  );
  it("accepts actual zero without a numerical, silence or FFT qualification claim", () => {
    const evidence = structuredClone(
      projectRolloffSmoke(rolloffHistory(), flatnessOwner),
    );
    for (const event of evidence.events)
      for (const channel of ["left", "right"]) {
        const fact = event.facts[`rolloff.${channel}Hz`];
        if (fact?.state === "observed") Object.assign(fact, { value: 0 });
      }
    expect(() => validateRolloffSmoke(evidence)).not.toThrow();
  });
  it("rejects absent, duplicate, reordered, truncated and excessive events", () => {
    const history = rolloffHistory();
    for (const events of [
      history.slice(1),
      history.slice(0, -1),
      [...history, history[3]!],
      [history[0]!, history[2]!, history[1]!, ...history.slice(3)],
      [...history, ...Array.from({ length: 1024 }, () => history[3]!)],
    ])
      expect(() => projectRolloffSmoke(events, flatnessOwner)).toThrow();
  });
  it.each(["unknown", "duplicate", "missing", "truncated"])(
    "rejects %s diagnostic facts",
    (mutation) => {
      const history = rolloffHistory();
      const lifecycle = history[3]!.attributes.lifecycle as {
        facts: { field: string; actual: object }[];
      };
      if (mutation === "unknown") lifecycle.facts[0]!.field = "secret";
      if (mutation === "duplicate")
        lifecycle.facts[0]!.field = lifecycle.facts[1]!.field;
      if (mutation === "missing") lifecycle.facts.pop();
      if (mutation === "truncated")
        Object.assign(lifecycle.facts[0]!.actual, { truncated: true });
      expect(() => projectRolloffSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it.each([
    ["sequence", 0],
    ["elapsedMs", -1],
    ["durationMs", Infinity],
    ["eventId", "foreign"],
    ["causationId", "foreign"],
  ])("rejects broken ordering, causation or timing: %s", (key, value) => {
    const evidence = structuredClone(
      projectRolloffSmoke(rolloffHistory(), flatnessOwner),
    );
    Object.assign(evidence.events[2]!, { [key]: value });
    expect(() => validateRolloffSmoke(evidence)).toThrow();
  });
});
