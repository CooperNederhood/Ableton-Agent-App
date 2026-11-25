import { describe, expect, it } from "vitest";
import type { AssertionInput } from "./contracts.js";
import { verifyMonitoringEpisodes } from "./monitoring-episodes.js";

const established = (bar: number, patternVersion: number) => ({
  kind: "pattern-established",
  bar,
  songBeat: (bar - 1) * 4,
  periodBars: 1,
  patternVersion,
  maxDistance: 0.1,
});

function input(
  episodes: readonly [string, Record<string, unknown>][],
): AssertionInput {
  const view = (from: number) => ({
    action: "get-monitoring",
    monitoring: {
      monitoringId: "m1",
      status: "completed",
      tracks: [{ trackReference: "op" }, { trackReference: "dr" }],
      episodes: episodes
        .map(([trackReference, episode], sequence) => ({
          sequence,
          trackReference,
          episode,
        }))
        .slice(from),
    },
  });
  const result = (content: unknown) => ({
    kind: "tool_result",
    metadata: { toolName: "ableton_listening" },
    result: { result: { content } },
  });
  return {
    turns: [],
    turn: {
      agentListening: {
        // Overlapping pages, one as SDK JSON text, must de-duplicate by sequence.
        records: [result(JSON.stringify(view(0))), result(view(2))],
      },
    },
  } as unknown as AssertionInput;
}

const parameters = { changeBars: "25,17", slackBars: 2, establishBars: 2 };

describe("monitoring-episodes assertion", () => {
  it("pairs each track's single change with an expected bar", () => {
    expect(() =>
      verifyMonitoringEpisodes(
        input([
          ["op", established(2, 1)],
          ["dr", established(2, 1)],
          ["dr", { kind: "pattern-changed", bar: 17 }],
          ["dr", established(18, 2)],
          ["op", { kind: "pattern-changed", bar: 25 }],
          ["op", established(26, 2)],
        ]),
        parameters,
      ),
    ).not.toThrow();
  });

  it("fails a late change or an extra change", () => {
    expect(() =>
      verifyMonitoringEpisodes(
        input([
          ["op", established(2, 1)],
          ["dr", established(2, 1)],
          ["dr", { kind: "pattern-changed", bar: 20 }],
          ["dr", established(21, 2)],
          ["op", { kind: "pattern-changed", bar: 25 }],
          ["op", established(26, 2)],
        ]),
        parameters,
      ),
    ).toThrow(/Change at bar 20/);
    expect(() =>
      verifyMonitoringEpisodes(
        input([
          ["op", established(2, 1)],
          ["dr", established(2, 1)],
          ["dr", { kind: "pattern-changed", bar: 9 }],
          ["dr", { kind: "pattern-changed", bar: 17 }],
          ["op", { kind: "pattern-changed", bar: 25 }],
        ]),
        parameters,
      ),
    ).toThrow(/change exactly once/);
  });
});
