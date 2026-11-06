import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { projectPitchSmoke, validatePitchSmoke } from "./pitch-smoke.js";
import { pitchHistory } from "./pitch-smoke-test-support.js";
import {
  flatnessHistory,
  flatnessOwner,
} from "./flatness-smoke-test-support.js";
import { rolloffHistory } from "./rolloff-smoke-test-support.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateScenario } from "./validation.js";
import type { FixtureManifest, ScenarioManifest } from "./contracts.js";

describe("unqualified paired pitch smoke", () => {
  it("requires exactly 24 typed facts, paired stereo snapshots and physical cleanup", () => {
    const evidence = projectPitchSmoke(pitchHistory(), flatnessOwner);
    expect(evidence.events).toHaveLength(7);
    expect(Object.keys(evidence.events.at(-1)!.facts)).toHaveLength(24);
    expect(evidence.events.at(-1)!.facts).toMatchObject({
      "pitch.leftHz": { state: "observed", value: 110 },
      "pitch.rightHz": { state: "observed", value: 220 },
      "pitch.leftConfidence": { state: "observed", value: 0.6 },
      "pitch.rightConfidence": { state: "observed", value: 0.3 },
      "pitch.cleanup": { state: "observed", value: "completed" },
    });
  });
  it("adds only pitch diagnostics to the unchanged mel smoke fixture and permission", async () => {
    const read = async (path: string) =>
      JSON.parse(
        await readFile(
          new URL(`../../../../integration/${path}`, import.meta.url),
          "utf8",
        ),
      ) as unknown;
    const original = (await read(
      "acceptance-scenarios/session-flucoma-melbands-smoke.json",
    )) as ScenarioManifest;
    const smoke = (await read(
      "acceptance-scenarios/session-flucoma-pitch-smoke.json",
    )) as ScenarioManifest;
    const fixture = (await read(
      "fixtures/session-clip-identify/fixture.json",
    )) as FixtureManifest;
    const suite = (await read("acceptance-scenarios/suite.json")) as {
      scenarios: string[];
    };
    const registry = createDefaultAssertions();
    validateScenario(smoke, fixture, registry.names);
    [
      ...smoke.assertions,
      ...smoke.steps.flatMap((step) => step.assertions),
    ].forEach((entry) => registry.validate(entry));
    expect(suite.scenarios.filter((id) => id === smoke.id)).toHaveLength(1);
    expect(smoke.fixtureId).toBe("session-clip-identify");
    expect(smoke.permissions).toEqual(original.permissions);
    expect(smoke.budget).toEqual(original.budget);
    expect(smoke.requiredCapabilities).toEqual(original.requiredCapabilities);
    expect(smoke.steps).toHaveLength(1);
    expect(smoke.steps[0]!.timeoutMs).toBe(120000);
    expect(smoke.steps[0]!.message).toBe(
      "Listen to the first Session clip on track audio-track, including pitch and confidence.",
    );
    expect(
      smoke.steps[0]!.assertions.filter(
        (entry) => entry.name !== "pitch-smoke",
      ),
    ).toEqual(original.steps[0]!.assertions);
    expect(
      smoke.assertions.filter((entry) => entry.name !== "pitch-smoke"),
    ).toEqual(original.assertions);
    expect(smoke.steps[0]!.assertions).toContainEqual({
      name: "pitch-smoke",
      parameters: { sourceId: "a", afterRestart: false },
    });
    expect(smoke.assertions).toContainEqual({
      name: "pitch-smoke",
      parameters: { sourceId: "a", afterRestart: true },
    });
  });
  it("never substitutes healthy baseline or sibling diagnostics for pitch", () => {
    expect(() =>
      projectPitchSmoke(
        [...flatnessHistory(), ...rolloffHistory().slice(1)],
        flatnessOwner,
      ),
    ).toThrow();
    expect(() => projectPitchSmoke([], flatnessOwner)).toThrow();
  });
  it.each(["traceId", "correlationId", "passId", "listenerId"] as const)(
    "rejects foreign %s",
    (key) => {
      expect(() =>
        projectPitchSmoke(
          pitchHistory({ ...flatnessOwner, [key]: "foreign" }),
          flatnessOwner,
        ),
      ).toThrow();
    },
  );
  it.each([
    "generation",
    "nativeEpoch",
    "connectionId",
    "connectionEpoch",
  ] as const)("rejects foreign native %s", (key) => {
    expect(() =>
      projectPitchSmoke(pitchHistory(), {
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
    ["metric", "spectral-rolloff"],
    ["generation", "foreign"],
    ["nativeEpoch", 2],
    ["eventId", "foreign"],
    ["causationId", "foreign"],
    ["durationMs", -1],
    ["phase", "launch"],
  ])("rejects malformed lifecycle %s", (key, value) => {
    const history = pitchHistory();
    Object.assign(history[3]!.attributes.lifecycle!, { [key]: value });
    expect(() => projectPitchSmoke(history, flatnessOwner)).toThrow();
  });
  it.each(["source", "outcome", "causationId"] as const)(
    "requires production envelope %s",
    (key) => {
      const history = pitchHistory();
      Object.assign(history[3]!, { [key]: "foreign" });
      expect(() => projectPitchSmoke(history, flatnessOwner)).toThrow();
    },
  );
  it.each([
    ["leftHz", -1],
    ["rightHz", NaN],
    ["leftHz", Infinity],
    ["rightHz", "220"],
    ["leftHz", 49.9],
    ["rightHz", 2000.1],
    ["leftConfidence", -0.01],
    ["rightConfidence", 1.01],
    ["leftConfidence", NaN],
    ["rightConfidence", "0.5"],
    ["leftCandidates", 0],
    ["rightCandidates", 2],
    ["leftDeliveries", 0],
    ["rightDeliveries", 401],
    ["leftCandidates", 0.5],
    ["schema", "flucoma-rolloff-smoke/v1"],
    ["support", "qualified"],
    ["valueValidity", "valid"],
    ["algorithm", "YIN"],
    ["units", "MIDI"],
    ["minfreq", 20],
    ["maxfreq", 20000],
    ["channelPolicy", "mono"],
    ["windowSamples", 1024],
    ["hopSamples", 1024],
    ["fftSamples", 1024],
    ["confidenceSemantics", "probability"],
    ["undefinedHz", -999],
    ["leftClass", "fluid.spectralshape~"],
    ["cleanup", "pending"],
  ])("rejects invalid %s: %j", (field, value) => {
    const evidence = structuredClone(
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    Object.assign(evidence.events.at(-1)!.facts, {
      [`pitch.${field}`]: { state: "observed", value },
    });
    expect(() => validatePitchSmoke(evidence)).toThrow();
  });
  it.each([
    "leftHz",
    "rightHz",
    "leftConfidence",
    "rightConfidence",
    "leftClass",
  ])("distinguishes missing %s from a delivered sentinel", (field) => {
    const evidence = structuredClone(
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    Object.assign(evidence.events.at(-1)!.facts, {
      [`pitch.${field}`]: { state: "unavailable", reason: "not-reported" },
    });
    expect(() => validatePitchSmoke(evidence)).toThrow();
  });
  it("allows a final undefined pair after earlier candidates without exact pitch or confidence truth", () => {
    const evidence = structuredClone(
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    for (const event of evidence.events.slice(2)) {
      Object.assign(event.facts, {
        "pitch.leftHz": { state: "observed", value: 0 },
        "pitch.leftConfidence": { state: "observed", value: 0 },
        "pitch.rightHz": { state: "observed", value: 2000 },
        "pitch.rightConfidence": { state: "observed", value: 1 },
      });
    }
    expect(() => validatePitchSmoke(evidence)).not.toThrow();
  });
  it("rejects all-sentinel output and impossible candidate accounting", () => {
    for (const count of [0, 3]) {
      const evidence = structuredClone(
        projectPitchSmoke(pitchHistory(), flatnessOwner),
      );
      for (const event of evidence.events.slice(2))
        Object.assign(event.facts, {
          "pitch.leftHz": { state: "observed", value: 0 },
          "pitch.leftCandidates": { state: "observed", value: count },
        });
      expect(() => validatePitchSmoke(evidence)).toThrow();
    }
  });
  it("accepts bounded differing delivery counts without fixing callback counts or confidence truth", () => {
    const evidence = structuredClone(
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    for (const event of evidence.events.slice(2))
      Object.assign(event.facts, {
        "pitch.leftDeliveries": { state: "observed", value: 399 },
        "pitch.rightDeliveries": { state: "observed", value: 400 },
        "pitch.leftConfidence": { state: "observed", value: 0 },
        "pitch.rightConfidence": { state: "observed", value: 1 },
      });
    expect(() => validatePitchSmoke(evidence)).not.toThrow();
  });
  it("allows sentinel-only early progress followed by independent positive candidates", () => {
    const evidence = structuredClone(
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    Object.assign(evidence.events[2]!.facts, {
      "pitch.leftDeliveries": { state: "observed", value: 1 },
      "pitch.leftCandidates": { state: "observed", value: 0 },
      "pitch.leftHz": { state: "observed", value: 0 },
      "pitch.leftConfidence": { state: "observed", value: 0 },
    });
    expect(() => validatePitchSmoke(evidence)).not.toThrow();
  });
  it("does not mistake an impossible sentinel with all deliveries counted as candidates for valid output", () => {
    const evidence = structuredClone(
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    for (const event of evidence.events.slice(2))
      Object.assign(event.facts, {
        "pitch.rightHz": { state: "observed", value: 0 },
      });
    expect(() => validatePitchSmoke(evidence)).toThrow();
  });
  it("rejects oversized lifecycle payloads before projecting bounded evidence", () => {
    const history = pitchHistory();
    Object.assign(history[3]!.attributes.lifecycle!, {
      extra: "x".repeat(8192),
    });
    expect(() => projectPitchSmoke(history, flatnessOwner)).toThrow();
  });
  it.each(["Hz", "Confidence", "Candidates"])(
    "rejects changed %s without a new pair delivery",
    (suffix) => {
      const evidence = structuredClone(
        projectPitchSmoke(pitchHistory(), flatnessOwner),
      );
      Object.assign(evidence.events.at(-1)!.facts, {
        [`pitch.left${suffix}`]: {
          state: "observed",
          value: suffix === "Hz" ? 120 : suffix === "Confidence" ? 0.7 : 2,
        },
      });
      expect(() => validatePitchSmoke(evidence)).toThrow();
    },
  );
  it.each(["failed", "cancelled"])(
    "rejects %s even with healthy siblings",
    (stage) => {
      const history = pitchHistory();
      Object.assign(history[3]!.attributes.lifecycle!, { stage });
      history[3]!.name = `output.listener.native.metric.monophonic-pitch.${stage}`;
      history[3]!.outcome = stage === "failed" ? "failure" : "cancelled";
      expect(() =>
        projectPitchSmoke(
          [...history, ...flatnessHistory().slice(1)],
          flatnessOwner,
        ),
      ).toThrow();
    },
  );
  it("rejects absent, duplicate, reordered, truncated and excessive lifecycle streams", () => {
    const history = pitchHistory();
    for (const events of [
      history.slice(1),
      history.slice(0, -1),
      [...history, history[3]!],
      [history[0]!, history[2]!, history[1]!, ...history.slice(3)],
      [...history, ...Array.from({ length: 96 }, () => history[3]!)],
    ])
      expect(() => projectPitchSmoke(events, flatnessOwner)).toThrow();
  });
  it.each(["unknown", "duplicate", "missing", "truncated"])(
    "rejects %s facts",
    (mutation) => {
      const history = pitchHistory();
      const lifecycle = history[3]!.attributes.lifecycle as {
        facts: { field: string; actual: object }[];
      };
      if (mutation === "unknown") lifecycle.facts[0]!.field = "secret";
      if (mutation === "duplicate")
        lifecycle.facts[0]!.field = lifecycle.facts[1]!.field;
      if (mutation === "missing") lifecycle.facts.pop();
      if (mutation === "truncated")
        Object.assign(lifecycle.facts[0]!.actual, { truncated: true });
      expect(() => projectPitchSmoke(history, flatnessOwner)).toThrow();
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
      projectPitchSmoke(pitchHistory(), flatnessOwner),
    );
    Object.assign(evidence.events[2]!, { [key]: value });
    expect(() => validatePitchSmoke(evidence)).toThrow();
  });
});
