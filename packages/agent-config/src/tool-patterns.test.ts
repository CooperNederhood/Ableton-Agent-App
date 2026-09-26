import { describe, expect, it } from "vitest";

import { resolveToolPatterns } from "./tool-patterns.js";

describe("tool pattern resolution", () => {
  it("expands exact and wildcard patterns deterministically", () => {
    expect(
      resolveToolPatterns(
        ["devices.inspect_*", "transport.set_tempo"],
        ["ableton_devices", "ableton_transport", "ableton_tracks"],
        {
          operations: [
            {
              operationId: "devices.inspect_parameters",
              toolName: "ableton_devices",
            },
            {
              operationId: "devices.inspect_rack_chains",
              toolName: "ableton_devices",
            },
            {
              operationId: "transport.set_tempo",
              toolName: "ableton_transport",
            },
          ],
        },
      ),
    ).toEqual({
      tools: ["ableton_devices", "ableton_transport"],
      operationIds: [
        "devices.inspect_parameters",
        "devices.inspect_rack_chains",
        "transport.set_tempo",
      ],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });

  it("reports patterns that grant no tools", () => {
    expect(resolveToolPatterns(["missing-*"], ["ableton_session"])).toEqual({
      tools: [],
      operationIds: [],
      explicitAliases: [],
      unmatchedPatterns: ["missing-*"],
    });
  });

  it("resolves operation patterns to pruned canonical domain tools", () => {
    expect(
      resolveToolPatterns(
        ["recording.inspect", "recording.set_*"],
        ["ableton_recording", "ableton_tracks"],
        {
          operations: [
            {
              operationId: "recording.inspect",
              toolName: "ableton_recording",
            },
            {
              operationId: "recording.set_arrangement_record",
              toolName: "ableton_recording",
            },
            {
              operationId: "recording.record_session_slot",
              toolName: "ableton_recording",
            },
          ],
        },
      ),
    ).toEqual({
      tools: ["ableton_recording"],
      operationIds: ["recording.inspect", "recording.set_arrangement_record"],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });

  it("keeps compatibility aliases exact-only during wildcard resolution", () => {
    const options = {
      operations: [
        { operationId: "tracks.delete", toolName: "ableton_tracks" },
      ],
      compatibilityAliases: {
        legacy_tracks_delete: "tracks.delete",
      },
    };
    expect(
      resolveToolPatterns(
        ["ableton_tracks*"],
        ["ableton_tracks", "legacy_tracks_delete"],
        options,
      ),
    ).toEqual({
      tools: ["ableton_tracks"],
      operationIds: ["tracks.delete"],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
    expect(
      resolveToolPatterns(
        ["legacy_tracks_delete"],
        ["ableton_tracks", "legacy_tracks_delete"],
        options,
      ),
    ).toEqual({
      tools: ["legacy_tracks_delete"],
      operationIds: ["tracks.delete"],
      explicitAliases: ["legacy_tracks_delete"],
      unmatchedPatterns: [],
    });
    expect(
      resolveToolPatterns(
        ["legacy_tracks_delete*"],
        ["ableton_tracks", "legacy_tracks_delete"],
        options,
      ),
    ).toEqual({
      tools: ["ableton_tracks"],
      operationIds: ["tracks.delete"],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });

  it("rejects removed direct names when no compatibility alias is configured", () => {
    expect(
      resolveToolPatterns(
        ["ableton_session_inspect", "ableton_tracks_create"],
        ["ableton_session", "ableton_tracks"],
        {
          operations: [
            { operationId: "session.inspect", toolName: "ableton_session" },
            { operationId: "tracks.create", toolName: "ableton_tracks" },
          ],
        },
      ),
    ).toEqual({
      tools: [],
      operationIds: [],
      explicitAliases: [],
      unmatchedPatterns: ["ableton_session_inspect", "ableton_tracks_create"],
    });
  });

  it("excludes explicit-only tools from wildcard patterns", () => {
    expect(
      resolveToolPatterns(
        ["*"],
        ["ableton_session", "read_plan", "write_plan", "ask_user", "task"],
        { wildcardExcludedTools: ["task"] },
      ),
    ).toEqual({
      tools: ["ableton_session", "ask_user", "read_plan", "write_plan"],
      operationIds: [],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });

  it("still resolves an explicit orchestration tool", () => {
    expect(
      resolveToolPatterns(["*", "task"], ["ableton_session", "task"], {
        wildcardExcludedTools: ["task"],
      }),
    ).toEqual({
      tools: ["ableton_session", "task"],
      operationIds: [],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });
});
