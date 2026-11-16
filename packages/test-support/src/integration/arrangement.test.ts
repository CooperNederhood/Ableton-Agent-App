import { describe, expect, it } from "vitest";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import {
  arrangementExpectedFrames,
  verifyArrangementCapture,
  verifyArrangementSource,
} from "./arrangement.js";
import { createDefaultAssertions } from "./assertions.js";
import {
  resolvePermissionArguments,
  validateFixture,
  validateScenario,
} from "./validation.js";
import type {
  AssertionInput,
  ScenarioManifest,
  TurnEvidence,
} from "./contracts.js";

describe("fixed-tempo single-track Arrangement evidence", () => {
  it("admits only the independently declared initial Arrangement override", () => {
    const { fixture, definition, baseline } = arrangementTestEvidence();
    const overridden = {
      ...baseline,
      before: { ...baseline.before, backToArrangement: true },
      after: { ...baseline.after, backToArrangement: true },
    };
    expect(() =>
      verifyArrangementSource(
        {
          ...fixture,
          baseline: { ...fixture.baseline, backToArrangement: true },
        },
        definition,
        overridden,
      ),
    ).not.toThrow();
    expect(() =>
      verifyArrangementSource(fixture, definition, overridden),
    ).toThrow("no repair");
  });

  it.each([
    [512, 4219],
    [2048, 4218],
  ])(
    "derives exactly %i-phase centroid frames without trusting result totals",
    (phase, count) => {
      const { capture, baseline, expected } = arrangementTestEvidence();
      const startSample = 2_363_392;
      const metric = {
        ...capture.metrics[0]!,
        name: "spectral-centroid",
        expectedRecords: count,
        receivedRecords: count,
        startSample,
        endSample: startSample + 8_640_000,
      };
      const actual = {
        ...capture,
        startSample,
        endSample: metric.endSample,
        spectralCentroidFirstFrameEndSample: startSample + phase,
        metrics: [metric],
      };
      const expectation = {
        ...expected,
        metricRecords: { "spectral-centroid": "verified-fft-phase" as const },
      };
      verifyArrangementCapture(actual, baseline, expectation);
      for (const delta of [-1, 1])
        expect(() =>
          verifyArrangementCapture(
            {
              ...actual,
              metrics: [
                {
                  ...metric,
                  expectedRecords: count + delta,
                  receivedRecords: count + delta,
                },
              ],
            },
            baseline,
            expectation,
          ),
        ).toThrow("per-metric");
      for (const invalid of [undefined, 0, 2049, 0.5, Number.NaN]) {
        const invalidCapture = { ...actual };
        if (invalid === undefined)
          Reflect.deleteProperty(
            invalidCapture,
            "spectralCentroidFirstFrameEndSample",
          );
        else
          invalidCapture.spectralCentroidFirstFrameEndSample =
            startSample + invalid;
        expect(() =>
          verifyArrangementCapture(invalidCapture, baseline, expectation),
        ).toThrow();
      }
    },
  );
  it("allows phase-derived counts only for spectral centroid", () => {
    const registry = createDefaultAssertions();
    const parameters = {
      sourceId: "arrangement-source",
      hostSampleRate: 48_000,
      playbackAfterCapture: "playing",
      "records.spectral-centroid": "verified-fft-phase",
    };
    registry.validate({ name: "arrangement-listening", parameters });
    expect(() =>
      registry.validate({
        name: "arrangement-listening",
        parameters: { ...parameters, "records.pitch": "verified-fft-phase" },
      }),
    ).toThrow("metric count");
  });
  it("verifies the exact duration on an absolute host sample clock", () => {
    const { capture, baseline, expected } = arrangementTestEvidence();
    const startSample = 2_363_392;
    Object.assign(capture, {
      startSample,
      endSample: startSample + 8_640_000,
    });
    for (const metric of capture.metrics)
      Object.assign(metric, {
        startSample: capture.startSample,
        endSample: capture.endSample,
      });
    verifyArrangementCapture(capture, baseline, expected);
    for (const invalidStart of [-1, 0.5, Number.NaN]) {
      expect(() =>
        verifyArrangementCapture(
          { ...capture, startSample: invalidStart },
          baseline,
          expected,
        ),
      ).toThrow();
    }
    const shifted = structuredClone(capture);
    Object.assign(shifted.metrics[0]!, {
      startSample: startSample + 1,
      endSample: capture.endSample + 1,
    });
    expect(() => verifyArrangementCapture(shifted, baseline, expected)).toThrow(
      "per-metric",
    );
  });
  it("supports the reviewed leave-playing contract without equating release to transport stop", () => {
    const { capture, baseline, expected } = arrangementTestEvidence();
    Object.assign(capture.cleanup, { transportPlaying: true });
    verifyArrangementCapture(capture, baseline, {
      ...expected,
      playbackAfterCapture: "playing",
    });
    expect(() => verifyArrangementCapture(capture, baseline, expected)).toThrow(
      "cleanup",
    );
    Object.assign(capture.cleanup, { transportPlaying: false });
    expect(() =>
      verifyArrangementCapture(capture, baseline, {
        ...expected,
        playbackAfterCapture: "playing",
      }),
    ).toThrow("cleanup");
  });
  it("derives 180-second host coverage independently of AIFF source rate", () => {
    const { definition, fixture, baseline, capture, expected } =
      arrangementTestEvidence();
    expect(arrangementExpectedFrames(definition, 128, 48_000)).toBe(8_640_000);
    expect(arrangementExpectedFrames(definition, 128, 44_100)).toBe(7_938_000);
    validateFixture(fixture);
    verifyArrangementSource(fixture, definition, baseline);
    verifyArrangementCapture(capture, baseline, expected);
    const alternate = structuredClone(capture);
    Object.assign(alternate, { sampleRate: 44_100, endSample: 7_938_000 });
    alternate.metrics.forEach((metric) =>
      Object.assign(metric, { endSample: 7_938_000 }),
    );
    verifyArrangementCapture(alternate, baseline, {
      ...expected,
      hostSampleRate: 44_100,
    });
  });
  it.each([
    [
      "saved range",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.savedClips[0]!, { endBeat: 15 }),
    ],
    [
      "loaded range",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.source.clips[0]!, { endBeat: 15 }),
    ],
    [
      "loaded media",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.media[0]!, { sha256: "c".repeat(64) }),
    ],
    [
      "loaded path",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.media[0]!, {
          loadedPath: "/external/source.aif",
        }),
    ],
    [
      "loaded project",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline, { loadedProjectSha256: "c".repeat(64) }),
    ],
    [
      "global record",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.after, { arrangementRecord: true }),
    ],
    [
      "missing global record",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Reflect.deleteProperty(x.baseline.before, "sessionRecord"),
    ],
    [
      "armed",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.after, { targetArmed: false }),
    ],
    [
      "monitoring",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.after, { targetMonitoring: "auto" }),
    ],
    [
      "current beat",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.before, { currentBeat: 0 }),
    ],
    [
      "tempo automation",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.after, { tempoAutomation: true }),
    ],
    [
      "Session override",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.baseline.after, { backToArrangement: true }),
    ],
  ])("rejects independent %s mismatches without repair", (_, change) => {
    const inputs = structuredClone(arrangementTestEvidence());
    change(inputs);
    const before = structuredClone(inputs);
    expect(() =>
      verifyArrangementSource(
        inputs.fixture,
        inputs.definition,
        inputs.baseline,
      ),
    ).toThrow();
    expect(inputs).toEqual(before);
  });
  it.each([
    [
      "metric pass",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.metrics[0]!, { passId: "other-pass" }),
    ],
    [
      "metric listener",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.metrics[0]!, { listenerId: "other-listener" }),
    ],
    [
      "metric count",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.metrics[0]!, { receivedRecords: 1799 }),
    ],
    [
      "self-consistent wrong totals",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.metrics[0]!, {
          expectedRecords: 1799,
          receivedRecords: 1799,
        }),
    ],
    [
      "metric range",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.metrics[0]!, { endSample: 1 }),
    ],
    [
      "missing metric",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture, { metrics: [x.capture.metrics[0]] }),
    ],
    [
      "metric source",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.metrics[0]!, {
          source: { ...x.baseline.source, trackId: "other-track" },
        }),
    ],
    [
      "capture owner",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture, { operationId: "other-operation" }),
    ],
    [
      "causation",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture, { causationId: "other-message" }),
    ],
    [
      "capture range",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture, { endSample: 90_000 }),
    ],
    [
      "cleanup release",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.cleanup, { captureReleased: false }),
    ],
    [
      "source restoration",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.cleanup, { sourceRestored: false }),
    ],
    [
      "cleanup failure",
      (x: ReturnType<typeof arrangementTestEvidence>) =>
        Object.assign(x.capture.cleanup, { failure: "not released" }),
    ],
  ])("does not trust completed flag for %s", (_, change) => {
    const inputs = structuredClone(arrangementTestEvidence());
    change(inputs);
    expect(inputs.capture.complete).toBe(true);
    expect(() =>
      verifyArrangementCapture(
        inputs.capture,
        inputs.baseline,
        inputs.expected,
      ),
    ).toThrow();
  });
  it("resolves exact Arrangement permission placeholders, never a Session slot", () => {
    const { baseline } = arrangementTestEvidence();
    const rule = {
      tool: "listen",
      action: "start",
      risk: "medium",
      maxUses: 1,
      arguments: {
        track: "$source.trackId",
        index: "$source.trackIndex",
        start: "$source.startBeat",
        end: "$source.endBeat",
        listener: "$source.listenerId",
      },
    } as const;
    expect(resolvePermissionArguments(rule, baseline)).toEqual({
      track: "track-1",
      index: 1,
      start: 0,
      end: 384,
      listener: "listener-1",
    });
    for (const placeholder of [
      "$source.clipId",
      "$source.slotIndex",
      "$source.contextId",
    ])
      expect(() =>
        resolvePermissionArguments(
          { ...rule, arguments: { target: placeholder } },
          baseline,
        ),
      ).toThrow();
  });
  it("requires explicit unavailable execution capability and independent metric assertions", () => {
    const { fixture } = arrangementTestEvidence();
    const registry = createDefaultAssertions();
    const assertion = {
      name: "arrangement-listening",
      parameters: {
        sourceId: "arrangement-source",
        hostSampleRate: 48_000,
        playbackAfterCapture: "stopped",
        "records.level": 1800,
        "records.spectral": 9000,
      },
    };
    registry.validate(assertion);
    expect(() =>
      registry.validate({
        ...assertion,
        parameters: { sourceId: "arrangement-source", hostSampleRate: 48_000 },
      }),
    ).toThrow();
    const scenario: ScenarioManifest = {
      schemaVersion: 1,
      id: "synthetic",
      fixtureId: fixture.id,
      requiredCapabilities: ["arrangement-audio"],
      permissions: [],
      budget: { runMs: 300_000, cleanupMs: 1000, persistenceMs: 1000 },
      steps: [
        {
          id: "listen",
          message: "Listen",
          sourceId: "arrangement-source",
          timeoutMs: 200_000,
          assertions: [assertion],
        },
      ],
      assertions: [],
    };
    validateScenario(scenario, fixture, registry.names, ["arrangement-audio"]);
    expect(() =>
      validateScenario(scenario, fixture, registry.names, ["session-audio"]),
    ).toThrow("Unsupported capability");
    expect(() =>
      validateScenario({ ...scenario, requiredCapabilities: [] }, fixture),
    ).toThrow("explicit Arrangement");
  });
  it("asserts attributable success and rejects absent source, hidden captures and cleanup failure", () => {
    const { fixture, baseline, capture } = arrangementTestEvidence();
    const turn: TurnEvidence = {
      schemaVersion: 1,
      appSessionId: "app-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      userMessageId: "message-1",
      assistantMessageId: "assistant-1",
      operationId: "operation-1",
      terminal: true,
      status: "completed",
      assistantText: "Completed",
      captures: [],
      contexts: [],
      arrangementCaptures: [capture],
      facts: {
        sdkTurnId: "trace-1",
        "arrangement.captureCausationId": "capture-tool-1",
      },
    };
    const input: AssertionInput = {
      fixture,
      baseline: {
        schemaVersion: 1,
        facts: {},
        dependencyHashes: {},
        arrangementSources: { "arrangement-source": baseline },
      },
      turns: [turn],
      evidence: {
        schemaVersion: 1,
        facts: {},
        contexts: [],
        unchanged: [],
        capturePassIds: ["pass-1"],
      },
    };
    const assertion = {
      name: "arrangement-listening",
      parameters: {
        sourceId: "arrangement-source",
        hostSampleRate: 48_000,
        playbackAfterCapture: "stopped",
        "records.level": 1800,
        "records.spectral": 9000,
      },
    };
    const registry = createDefaultAssertions();
    Object.assign(capture, { causationId: "capture-tool-1" });
    expect(registry.evaluate(assertion, input).passed).toBe(true);
    for (const change of [
      (x: AssertionInput) =>
        Reflect.deleteProperty(x.baseline, "arrangementSources"),
      (x: AssertionInput) =>
        Object.assign(x.evidence!, {
          capturePassIds: ["pass-1", "hidden-pass"],
        }),
      (x: AssertionInput) =>
        Reflect.deleteProperty(x.evidence!, "capturePassIds"),
      (x: AssertionInput) =>
        Object.assign(x.turns[0]!, { arrangementCaptures: [] }),
      (x: AssertionInput) =>
        Object.assign(x.turns[0]!, { status: "cancelled" }),
      (x: AssertionInput) =>
        Reflect.deleteProperty(
          x.turns[0]!.facts,
          "arrangement.captureCausationId",
        ),
      (x: AssertionInput) =>
        Object.assign(x.turns[0]!.facts, {
          "arrangement.captureCausationId": "unrelated-tool",
        }),
      (x: AssertionInput) =>
        Object.assign(x.turns[0]!.arrangementCaptures![0]!.cleanup, {
          transportPlaying: true,
        }),
    ]) {
      const changed = structuredClone(input);
      change(changed);
      expect(registry.evaluate(assertion, changed).passed).toBe(false);
    }
  });
});
