import { describe, expect, it } from "vitest";
import { createDefaultAssertions } from "./assertions.js";
import type {
  AssertionInput,
  CaptureEvidence,
  ContextEvidence,
  TurnEvidence,
} from "./contracts.js";

function capture(index: number, sourceIndex = 0): CaptureEvidence {
  return {
    passId: `pass-${index}`,
    operationId: `operation-${index}`,
    source: {
      trackId: `track-${sourceIndex}`,
      clipId: `clip-${sourceIndex}`,
      slotIndex: sourceIndex,
      mediaSha256: String(sourceIndex).repeat(64),
    },
    listenerId: `listener-${sourceIndex}`,
    complete: true,
    nonSilent: true,
    truncated: false,
    missingRecords: 0,
    metricFamilies: ["level", "spectral-centroid", "attacks"],
    sampleRate: 48_000,
    startSample: index * 100_000,
    endSample: index * 100_000 + 90_000,
    cleanupComplete: true,
    failure: null,
    native: {
      generation: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      nativeEpoch: index + 1,
      connectionId: `00000000-0000-4000-9000-${String(sourceIndex).padStart(12, "0")}`,
      connectionEpoch: `00000000-0000-4000-a000-${String(sourceIndex).padStart(12, "0")}`,
    },
    spectralCentroidHz: sourceIndex === 0 ? 700 : 15_000,
  };
}

function context(entry: CaptureEvidence, index: number): ContextEvidence {
  return {
    contextId: `context-${index}`,
    passId: entry.passId,
    source: entry.source,
    contentSha256: String(index).repeat(64),
    readable: true,
    afterOwnedRestart: false,
  };
}

function scenario(sources = [0, 0, 0]): AssertionInput {
  const contexts: ContextEvidence[] = [];
  const turns: TurnEvidence[] = sources.map((sourceIndex, index) => {
    const observed = capture(index, sourceIndex);
    contexts.push(context(observed, index));
    return {
      schemaVersion: 1,
      appSessionId: "app",
      conversationId: "conversation",
      agentId: "default",
      userMessageId: `user-${index}`,
      operationId: observed.operationId,
      assistantMessageId: `assistant-${index}`,
      terminal: true,
      status: "completed",
      assistantText: "Completed.",
      captures: [observed],
      contexts: [...contexts],
      facts: {},
    };
  });
  return {
    fixture: {
      schemaVersion: 1,
      id: "controlled",
      qualification: "synthetic-only",
      provenance: { ownership: "authored", description: "Controlled evidence" },
      resources: [],
      dependencies: [],
      baseline: {},
    },
    baseline: {
      schemaVersion: 1,
      facts: {},
      dependencyHashes: {},
      sources: Object.fromEntries(
        [0, 1].map((index) => [
          String(index),
          {
            source: {
              ...capture(0, index).source,
              mediaSha256: String(index).repeat(64),
            },
            listenerId: `listener-${index}`,
            loadedMediaPath: `/owned/resource-${index}.wav`,
            facts: {},
          },
        ]),
      ),
    },
    turns,
    turn: turns.at(-1)!,
    evidence: {
      schemaVersion: 1,
      capturePassIds: turns.flatMap((turn) =>
        turn.captures.map(({ passId }) => passId),
      ),
      facts: {},
      contexts: contexts.map((entry) => ({
        ...entry,
        afterOwnedRestart: true,
      })),
      unchanged: [],
    },
  };
}

function checkContext(input: AssertionInput, afterRestart = false) {
  return createDefaultAssertions().evaluate(
    { name: "context", parameters: { afterRestart } },
    input,
  );
}

function withCurrentContexts(
  input: AssertionInput,
  contexts: readonly ContextEvidence[],
): AssertionInput {
  const turn = { ...input.turn!, contexts };
  return { ...input, turn, turns: [...input.turns.slice(0, -1), turn] };
}

describe("repeated capture context evidence", () => {
  it.each([
    { sources: [0, 0, 0] },
    { sources: [0, 1, 0] },
    { sources: [0, 0, 0, 0, 1, 0] },
  ])("retains every source/pass in sequence $sources", ({ sources }) => {
    const input = scenario(sources);
    expect(checkContext(input).passed).toBe(true);
    expect(checkContext(input, true).passed).toBe(true);
  });

  it("does not let the first context substitute for the latest capture", () => {
    const input = scenario();
    expect(
      checkContext(withCurrentContexts(input, [input.turn!.contexts[0]!]))
        .passed,
    ).toBe(false);
  });

  it("requires the latest context even on a follow-up that does not listen", () => {
    const input = scenario();
    const followup: TurnEvidence = {
      ...input.turn!,
      operationId: "followup",
      userMessageId: "user-followup",
      assistantMessageId: "assistant-followup",
      captures: [],
      contexts: [input.turn!.contexts[0]!],
    };
    expect(
      checkContext({
        ...input,
        turn: followup,
        turns: [...input.turns, followup],
      }).passed,
    ).toBe(false);
  });

  it.each(["source", "identity", "content", "unreadable"] as const)(
    "rejects a prior context whose %s changes during later captures",
    (field) => {
      const input = scenario([0, 1, 0]);
      const contexts = [...input.turn!.contexts];
      const prior = contexts[1]!;
      contexts[1] =
        field === "source"
          ? { ...prior, source: capture(0).source }
          : field === "identity"
            ? { ...prior, contextId: "replacement-context" }
            : field === "content"
              ? { ...prior, contentSha256: "f".repeat(64) }
              : { ...prior, readable: false };
      expect(checkContext(withCurrentContexts(input, contexts)).passed).toBe(
        false,
      );
    },
  );

  it("rejects a missing middle context after an owned restart", () => {
    const input = scenario([0, 1, 0]);
    expect(
      checkContext(
        {
          ...input,
          evidence: {
            ...input.evidence!,
            contexts: input.evidence!.contexts.filter(
              (_, index) => index !== 1,
            ),
          },
        },
        true,
      ).passed,
    ).toBe(false);
  });

  it("requires original context evidence from the capture's own turn", () => {
    const input = scenario([0, 1, 0]);
    expect(
      checkContext({
        ...input,
        turns: input.turns.map((turn, index) =>
          index === 1 ? { ...turn, contexts: [] } : turn,
        ),
      }).passed,
    ).toBe(false);
  });

  it("rejects duplicate contexts for the same pass", () => {
    const input = scenario();
    expect(
      checkContext(
        withCurrentContexts(input, [
          ...input.turn!.contexts,
          input.turn!.contexts[2]!,
        ]),
      ).passed,
    ).toBe(false);
  });

  it("rejects one context identity reused for two captures", () => {
    const input = scenario();
    const turns = input.turns.map((turn) => ({
      ...turn,
      contexts: turn.contexts.map((entry, index) =>
        index === 1 ? { ...entry, contextId: "context-0" } : entry,
      ),
    }));
    expect(checkContext({ ...input, turns, turn: turns.at(-1)! }).passed).toBe(
      false,
    );
  });

  it("rejects an incomplete latest capture rather than falling back", () => {
    const input = scenario();
    const turn = {
      ...input.turn!,
      captures: [{ ...input.turn!.captures[0]!, complete: false }],
    };
    expect(
      checkContext({
        ...input,
        turn,
        turns: [...input.turns.slice(0, -1), turn],
      }).passed,
    ).toBe(false);
  });
});

describe("complete capture inventory", () => {
  function check(input: AssertionInput, expected = 3) {
    return createDefaultAssertions().evaluate(
      { name: "capture-count", parameters: { expected } },
      input,
    );
  }

  it("accepts distinct attributable passes regardless of inventory order", () => {
    const input = scenario();
    expect(
      check({
        ...input,
        evidence: {
          ...input.evidence!,
          capturePassIds: ["pass-2", "pass-0", "pass-1"],
        },
      }).passed,
    ).toBe(true);
  });

  describe("native capture freshness and measured source distinction", () => {
    function fresh(input: AssertionInput) {
      return createDefaultAssertions().evaluate(
        { name: "native-freshness", parameters: {} },
        input,
      );
    }
    it("uses per-listener rather than global epoch ordering", () => {
      const input = scenario([0, 0, 0, 0, 1, 0]);
      const turns = input.turns.map((turn, index) => ({
        ...turn,
        captures: turn.captures.map((entry) => ({
          ...entry,
          native: {
            ...entry.native!,
            nativeEpoch: index === 4 ? 1 : index + 1,
          },
        })),
      }));
      expect(fresh({ ...input, turns }).passed).toBe(true);
    });
    it.each([
      "generation",
      "nativeEpoch",
      "connectionId",
      "connectionEpoch",
      "missing",
      "release",
    ] as const)(
      "rejects stale/replaced/incomplete native evidence: %s",
      (field) => {
        const input = scenario();
        const turns = input.turns.map((turn, index) => ({
          ...turn,
          captures: turn.captures.map((entry): CaptureEvidence => {
            if (index !== 2) return entry;
            if (field === "missing") {
              const { native: omitted, ...withoutNative } = entry;
              expect(omitted).toBeDefined();
              return withoutNative;
            }
            return {
              ...entry,
              ...(field === "release" ? { cleanupComplete: false } : {}),
              native: {
                ...entry.native!,
                ...(field === "generation"
                  ? {
                      generation:
                        input.turns[0]!.captures[0]!.native!.generation,
                    }
                  : {}),
                ...(field === "nativeEpoch" ? { nativeEpoch: 1 } : {}),
                ...(field === "connectionId"
                  ? { connectionId: "replacement" }
                  : {}),
                ...(field === "connectionEpoch"
                  ? { connectionEpoch: "replacement" }
                  : {}),
              },
            };
          }),
        }));
        expect(fresh({ ...input, turns }).passed).toBe(false);
      },
    );
    it.each([
      { source: 0, minHz: 100, maxHz: 3000, passed: true },
      { source: 1, minHz: 6000, maxHz: 22000, passed: true },
      { source: 0, minHz: 6000, maxHz: 22000, passed: false },
      { source: 1, minHz: 100, maxHz: 3000, passed: false },
    ])(
      "checks measured content independently of clip names: $source/$minHz",
      ({ source, minHz, maxHz, passed }) => {
        expect(
          createDefaultAssertions().evaluate(
            { name: "spectral-range", parameters: { minHz, maxHz } },
            scenario([source]),
          ).passed,
        ).toBe(passed);
      },
    );
    it("binds the selected source's clip, track, listener and media hash", () => {
      const input = scenario([0, 1]);
      const registry = createDefaultAssertions();
      const parameters = {
        metricFamilies: "level,spectral-centroid,attacks",
        sampleRate: 48_000,
        expectedFrames: 90_000,
        sourceId: "1",
      };
      expect(
        registry.evaluate({ name: "capture", parameters }, input).passed,
      ).toBe(true);
      expect(
        registry.evaluate(
          {
            name: "capture",
            parameters: { ...parameters, sourceId: "0" },
          },
          input,
        ).passed,
      ).toBe(false);
      for (const change of [
        { listenerId: "listener-0" },
        {
          source: {
            ...input.turn!.captures[0]!.source,
            mediaSha256: "f".repeat(64),
          },
        },
        {
          source: {
            ...input.turn!.captures[0]!.source,
            clipId: "changed-clip",
          },
        },
      ])
        expect(
          registry.evaluate(
            { name: "capture", parameters },
            {
              ...input,
              turn: {
                ...input.turn!,
                captures: [{ ...input.turn!.captures[0]!, ...change }],
              },
            },
          ).passed,
        ).toBe(false);
    });
  });

  it("rejects a reused pass even if the run inventory contains another pass", () => {
    const input = scenario();
    expect(
      check({
        ...input,
        turns: input.turns.map((turn) => ({
          ...turn,
          captures: [{ ...turn.captures[0]!, passId: "pass-0" }],
        })),
      }).passed,
    ).toBe(false);
  });

  it("rejects duplicate identities in both inventories", () => {
    const input = scenario();
    expect(
      check({
        ...input,
        turns: input.turns.map((turn) => ({
          ...turn,
          captures: [{ ...turn.captures[0]!, passId: "pass-0" }],
        })),
        evidence: {
          ...input.evidence!,
          capturePassIds: ["pass-0", "pass-0", "pass-0"],
        },
      }).passed,
    ).toBe(false);
  });

  it.each([
    { capturePassIds: undefined },
    { capturePassIds: ["pass-0", "pass-1"] },
    { capturePassIds: ["pass-0", "pass-1", "extra"] },
  ])(
    "rejects absent, missing, or foreign run inventory $capturePassIds",
    ({ capturePassIds }) => {
      const input = scenario();
      expect(
        check({
          ...input,
          evidence: {
            schemaVersion: 1,
            facts: {},
            contexts: input.evidence!.contexts,
            unchanged: [],
            ...(capturePassIds === undefined ? {} : { capturePassIds }),
          },
        }).passed,
      ).toBe(false);
    },
  );
});
