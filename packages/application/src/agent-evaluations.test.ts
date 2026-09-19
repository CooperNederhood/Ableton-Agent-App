import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compactProjectContext,
  createAgentPolicy,
  retryGuidance,
} from "./agent-policy.js";
import {
  BASE_SYSTEM_MESSAGE,
  BASE_SYSTEM_MESSAGE_VERSION,
  composeAgentTurnPrompt,
  loadBaseSystemMessage,
  loadPlanReminder,
  PLAN_REMINDER,
  PLAN_REMINDER_VERSION,
} from "./index.js";

describe("agent safety evaluations", () => {
  it("prefers sufficient guarded prepared identities over age-based inspection", () => {
    expect(BASE_SYSTEM_MESSAGE).toContain(
      "Use supplied prepared project context and its exact identities directly",
    );
    expect(BASE_SYSTEM_MESSAGE).toContain(
      "do not inspect solely because cached mutable state is age-expired",
    );
  });

  it("loads separate canonical base and plan reminder prompts", () => {
    expect(BASE_SYSTEM_MESSAGE_VERSION).toBe(7);
    expect(BASE_SYSTEM_MESSAGE).toContain("<ableton-workflow>");
    expect(BASE_SYSTEM_MESSAGE).not.toContain("Active plan-mode reminder");
    expect(PLAN_REMINDER_VERSION).toBe(2);
    expect(PLAN_REMINDER).toContain("# Active plan-mode reminder");
    expect(PLAN_REMINDER).toContain("call `exit_plan_mode`");
    expect(PLAN_REMINDER).toContain("real line breaks");
    expect(PLAN_REMINDER).toContain("call `ask_user` with a structured schema");
    expect(PLAN_REMINDER).toContain(
      "The shared `plan.md` is the only plan source of truth",
    );
  });

  it("appends the plan reminder only to plan-mode turns", () => {
    expect(composeAgentTurnPrompt("Draft a plan", "plan")).toBe(
      `Draft a plan\n\n${PLAN_REMINDER}`,
    );
    expect(composeAgentTurnPrompt("Make the change", "interactive")).toBe(
      "Make the change",
    );
    expect(composeAgentTurnPrompt("Inspect", undefined)).toBe("Inspect");
  });

  it("normalizes prompt trailing newlines and rejects missing or empty prompt files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "base-system-message-"));
    try {
      const promptPath = join(directory, "prompt.md");
      const emptyPath = join(directory, "empty.md");
      const missingPath = join(directory, "missing.md");
      await writeFile(promptPath, "Shared prompt.\n");
      await writeFile(emptyPath, " \n");

      expect(loadBaseSystemMessage([pathToFileURL(promptPath)])).toBe(
        "Shared prompt.",
      );
      expect(loadPlanReminder([pathToFileURL(promptPath)])).toBe(
        "Shared prompt.",
      );
      expect(() =>
        loadBaseSystemMessage([
          pathToFileURL(emptyPath),
          pathToFileURL(missingPath),
        ]),
      ).toThrow(/prompt is empty[\s\S]*ENOENT/u);
      expect(() =>
        loadPlanReminder([
          pathToFileURL(emptyPath),
          pathToFileURL(missingPath),
        ]),
      ).toThrow(/Plan reminder could not be loaded[\s\S]*prompt is empty/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
