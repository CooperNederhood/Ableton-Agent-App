import { describe, expect, it } from "vitest";

import {
  compactProjectContext,
  createAgentPolicy,
  retryGuidance,
} from "./agent-policy.js";

describe("agent safety evaluations", () => {
  it("requires inspection before project-specific edits", () => {
    expect(
      compactProjectContext({
        state: "connected",
        liveVersion: "12.1",
        remoteScriptVersion: "0.4.0",
        projectId: "project-1",
      }),
    ).toContain("Inspect the session before making project-specific claims");
  });

  it.each([
    [
      "stale_reference",
      "Re-inspect the target, obtain a fresh exact reference",
    ],
    ["approval_denied", "Do not retry or rephrase the same operation"],
    ["unsupported_capability", "offer a supported alternative"],
    ["invalid_params", "Correct them from inspected state"],
  ])("gives safe recovery guidance for %s", (code, expected) => {
    expect(retryGuidance(code)).toContain(expected);
  });

  it("blocks an unchanged failed mutation attempt", () => {
    const policy = createAgentPolicy({
      getAbletonStatus: async () => ({ state: "disconnected" }),
      inspectSession: async () => {
        throw new Error("not connected");
      },
    });
    policy.blockAttempt(
      "ableton_tracks_delete",
      { index: 1 },
      "Re-inspect before editing",
    );

    expect(
      policy.hooks.onPreToolUse?.(
        {
          sessionId: "session-1",
          timestamp: new Date(),
          workingDirectory: "/tmp",
          toolName: "ableton_tracks_delete",
          toolArgs: { index: 1 },
        },
        { sessionId: "session-1" },
      ),
    ).toMatchObject({
      permissionDecision: "deny",
      additionalContext: "Re-inspect before editing",
    });
  });
});
