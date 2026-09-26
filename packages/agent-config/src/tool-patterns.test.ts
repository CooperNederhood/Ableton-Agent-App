import { describe, expect, it } from "vitest";

import { resolveToolPatterns } from "./tool-patterns.js";

describe("tool pattern resolution", () => {
  it("expands exact and wildcard patterns deterministically", () => {
    expect(
      resolveToolPatterns(
        ["ableton_devices_*", "ableton_transport_set_tempo"],
        [
          "ableton_transport_set_tempo",
          "ableton_devices_inspect",
          "ableton_devices_set_enabled",
          "ableton_tracks_create",
        ],
      ),
    ).toEqual({
      tools: [
        "ableton_devices_inspect",
        "ableton_devices_set_enabled",
        "ableton_transport_set_tempo",
      ],
      unmatchedPatterns: [],
    });
  });

  it("reports patterns that grant no tools", () => {
    expect(
      resolveToolPatterns(["missing-*"], ["ableton_session_inspect"]),
    ).toEqual({
      tools: [],
      unmatchedPatterns: ["missing-*"],
    });
  });

  it("excludes explicit-only tools from wildcard patterns", () => {
    expect(
      resolveToolPatterns(
        ["*"],
        [
          "ableton_session_inspect",
          "read_plan",
          "write_plan",
          "ask_user",
          "task",
        ],
        { wildcardExcludedTools: ["task"] },
      ),
    ).toEqual({
      tools: ["ableton_session_inspect", "ask_user", "read_plan", "write_plan"],
      unmatchedPatterns: [],
    });
  });

  it("still resolves an explicit orchestration tool", () => {
    expect(
      resolveToolPatterns(["*", "task"], ["ableton_session_inspect", "task"], {
        wildcardExcludedTools: ["task"],
      }),
    ).toEqual({
      tools: ["ableton_session_inspect", "task"],
      unmatchedPatterns: [],
    });
  });
});
