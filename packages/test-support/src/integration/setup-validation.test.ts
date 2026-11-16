import { describe, expect, it } from "vitest";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import { createDefaultAssertions } from "./assertions.js";
import { validateEvidence, validateScenario } from "./validation.js";
import type { ScenarioManifest, SetupEvidence } from "./contracts.js";

function setupCase() {
  const { fixture, definition } = arrangementTestEvidence();
  const assertion = {
    name: "arrangement-listening",
    parameters: {
      sourceId: definition.id,
      hostSampleRate: 48_000,
      playbackAfterCapture: "playing",
      "records.level": 1,
    },
  };
  const scenario: ScenarioManifest = {
    schemaVersion: 1,
    id: "back-to-arrangement",
    fixtureId: fixture.id,
    requiredCapabilities: ["arrangement-audio"],
    permissions: [],
    budget: { runMs: 5000, cleanupMs: 1000, persistenceMs: 1000 },
    steps: [
      {
        id: "listen",
        message: "Listen once",
        sourceId: definition.id,
        timeoutMs: 1000,
        setupActions: ["back-to-arrangement"],
        assertions: [assertion],
      },
    ],
    assertions: [assertion],
  };
  return { fixture, scenario };
}
function setupEvidence(): SetupEvidence {
  return {
    action: "back-to-arrangement",
    stepId: "listen",
    traceId: "trace-1",
    correlationId: "run-1",
    causationId: "cause-1",
    appSessionId: "session-1",
    conversationId: "conversation-1",
    agentId: "agent-1",
    completed: true,
    arrangementSource: {
      command: "transport.back_to_arrangement",
      dispatchedCount: 1,
      beforeBackToArrangement: true,
      afterBackToArrangement: false,
      transportStopped: true,
      verified: true,
    },
  };
}
function checkEvidence(value: unknown) {
  validateEvidence({
    schemaVersion: 1,
    facts: {},
    contexts: [],
    unchanged: [],
    setupActions: [value],
  });
}
describe("explicit first-step Back to Arrangement contract", () => {
  it("requires normal messages and rejects operation steps and the removed capability", () => {
    const { fixture, scenario } = setupCase();
    const step = {
      ...scenario.steps[0]!,
      operation: { kind: "transport", action: "stop" },
    };
    Reflect.deleteProperty(step, "message");
    expect(() =>
      validateScenario({ ...scenario, steps: [step] }, fixture),
    ).toThrow();
    expect(() =>
      validateScenario(
        {
          ...scenario,
          requiredCapabilities: ["arrangement-audio", "direct-operations"],
        },
        fixture,
        createDefaultAssertions().names,
        ["arrangement-audio"],
      ),
    ).toThrow();
  });
  it("admits a declared ordered Session handoff and a separate stopped owned restart", () => {
    const { fixture, scenario } = setupCase();
    const session = {
      id: "session",
      message: "Listen once to Session",
      timeoutMs: 1000,
      assertions: [
        {
          name: "capture",
          parameters: {
            sourceId: "session",
            metricFamilies: "level",
            sampleRate: 48000,
            expectedFrames: 90000,
          },
        },
      ],
    };
    const selected = {
      ...scenario,
      requiredCapabilities: [
        "session-audio",
        "arrangement-audio",
        "persistence",
      ],
      steps: [
        session,
        {
          ...scenario.steps[0]!,
          setupActions: ["stop-transport", "back-to-arrangement"],
        },
        {
          id: "restored",
          message: "Read originals",
          timeoutMs: 1000,
          setupActions: ["stop-transport", "restart-owned-desktop"],
          assertions: [],
        },
      ],
    };
    expect(() =>
      validateScenario(selected, fixture, createDefaultAssertions().names),
    ).not.toThrow();
    for (const actions of [
      ["back-to-arrangement", "stop-transport"],
      ["back-to-arrangement"],
      ["stop-transport", "stop-transport"],
    ])
      expect(() =>
        validateScenario(
          {
            ...selected,
            steps: [session, { ...selected.steps[1], setupActions: actions }],
          },
          fixture,
          createDefaultAssertions().names,
        ),
      ).toThrow();
    const stop = {
      ...setupEvidence(),
      action: "stop-transport",
      stepId: "listen",
      transport: {
        command: "transport.set_playing",
        dispatchedCount: 1,
        beforePlaying: true,
        afterPlaying: false,
        verified: true,
      },
    };
    Reflect.deleteProperty(stop, "arrangementSource");
    const evidence = {
      schemaVersion: 1,
      facts: {},
      contexts: [],
      unchanged: [],
      setupActions: [
        stop,
        setupEvidence(),
        { ...stop, stepId: "restored" },
        {
          ...setupEvidence(),
          action: "restart-owned-desktop",
          stepId: "restored",
        },
      ],
    };
    Reflect.deleteProperty(evidence.setupActions[3]!, "arrangementSource");
    expect(() => validateEvidence(evidence)).not.toThrow();
    expect(() =>
      validateEvidence({ ...evidence, setupActions: [stop, stop] }),
    ).toThrow();
  });
  it("admits exactly one declared Arrangement handoff and either independently read prior flag", () => {
    const { fixture, scenario } = setupCase();
    validateScenario(scenario, fixture, createDefaultAssertions().names, [
      "arrangement-audio",
    ]);
    const evidence = setupEvidence();
    checkEvidence(evidence);
    checkEvidence({
      ...evidence,
      arrangementSource: {
        ...evidence.arrangementSource,
        beforeBackToArrangement: false,
      },
    });
  });
  it.each(["late", "duplicate", "missing-capability", "no-source"] as const)(
    "denies %s declaration",
    (mode) => {
      const { fixture, scenario } = setupCase();
      const first = scenario.steps[0]!;
      const input = {
        ...scenario,
        ...(mode === "late"
          ? {
              steps: [
                { ...first, id: "prior", setupActions: undefined },
                first,
              ],
            }
          : {}),
        ...(mode === "duplicate"
          ? {
              steps: [
                {
                  ...first,
                  setupActions: ["back-to-arrangement", "back-to-arrangement"],
                },
              ],
            }
          : {}),
        ...(mode === "missing-capability"
          ? { requiredCapabilities: ["session-audio"] }
          : {}),
      };
      const selectedFixture = {
        ...fixture,
        ...(mode === "no-source" ? { arrangementSources: [] } : {}),
      };
      expect(() =>
        validateScenario(
          input,
          selectedFixture,
          createDefaultAssertions().names,
          ["arrangement-audio", "session-audio"],
        ),
      ).toThrow();
    },
  );
  it("admits a declared source without inspecting unrelated sources in the same fixture", () => {
    const { fixture, scenario } = setupCase();
    const sources = fixture.arrangementSources!;
    expect(() =>
      validateScenario(
        scenario,
        {
          ...fixture,
          arrangementSources: [sources[0]!, { ...sources[0]!, id: "second" }],
        },
        createDefaultAssertions().names,
        ["arrangement-audio"],
      ),
    ).not.toThrow();
  });
  it.each(["stop-transport", "restart-owned-desktop"] as const)(
    "still requires a preceding turn for %s",
    (action) => {
      const { fixture, scenario } = setupCase();
      expect(() =>
        validateScenario(
          {
            ...scenario,
            steps: [{ ...scenario.steps[0]!, setupActions: [action] }],
          },
          fixture,
          createDefaultAssertions().names,
          ["arrangement-audio"],
        ),
      ).toThrow(/preceding turn/);
    },
  );
  it.each([
    { command: "transport.set_playing" },
    { dispatchedCount: 2 },
    { beforeBackToArrangement: undefined },
    { afterBackToArrangement: true },
    { transportStopped: false },
    { verified: false },
    { extra: true },
  ])("rejects incomplete or unverified handoff operands %j", (patch) => {
    const evidence = setupEvidence();
    expect(() =>
      checkEvidence({
        ...evidence,
        arrangementSource: { ...evidence.arrangementSource, ...patch },
      }),
    ).toThrow();
  });
  it("forbids transport on a handoff, missing source evidence, and source evidence on other actions", () => {
    const evidence = setupEvidence();
    expect(() =>
      checkEvidence({
        ...evidence,
        transport: {
          command: "transport.set_playing",
          dispatchedCount: 1,
          beforePlaying: true,
          afterPlaying: false,
          verified: true,
        },
      }),
    ).toThrow();
    const missing = { ...evidence };
    delete missing.arrangementSource;
    expect(() => checkEvidence(missing)).toThrow();
    for (const action of ["stop-transport", "restart-owned-desktop"])
      expect(() => checkEvidence({ ...evidence, action })).toThrow();
  });
});
