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
      operationIds: [],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });

  it("reports patterns that grant no tools", () => {
    expect(
      resolveToolPatterns(["missing-*"], ["ableton_session_inspect"]),
    ).toEqual({
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
        ["ableton_recording", "ableton_tracks_delete"],
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
        ableton_tracks_delete: "tracks.delete",
      },
    };
    expect(
      resolveToolPatterns(
        ["ableton_tracks*"],
        ["ableton_tracks", "ableton_tracks_delete"],
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
        ["ableton_tracks_delete"],
        ["ableton_tracks", "ableton_tracks_delete"],
        options,
      ),
    ).toEqual({
      tools: ["ableton_tracks_delete"],
      operationIds: ["tracks.delete"],
      explicitAliases: ["ableton_tracks_delete"],
      unmatchedPatterns: [],
    });
    expect(
      resolveToolPatterns(
        ["ableton_tracks_delete*"],
        ["ableton_tracks", "ableton_tracks_delete"],
        options,
      ),
    ).toEqual({
      tools: ["ableton_tracks"],
      operationIds: ["tracks.delete"],
      explicitAliases: [],
      unmatchedPatterns: [],
    });
  });
});
