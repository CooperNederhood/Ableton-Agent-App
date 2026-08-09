import { describe, expect, it, vi } from "vitest";

import type { SessionSnapshot } from "@ableton-agent/protocol";

import {
  compactProjectContext,
  createAgentHooks,
  createAgentPolicy,
  retryGuidance,
  structuredErrorCode,
} from "./agent-policy.js";

const snapshot: SessionSnapshot = {
  tempo: 124,
  timeSignature: { numerator: 4, denominator: 4 },
  isPlaying: false,
  trackCount: 2,
  tracks: [
    {
      index: 0,
      reference: "00000000-0000-4000-8000-000000000001",
      name: "Drums",
      kind: "midi",
      color: 10,
      isMuted: false,
      isSoloed: false,
      isArmed: true,
      volume: 0.8,
      pan: 0,
    },
    {
      index: 1,
      reference: "00000000-0000-4000-8000-000000000002",
      name: "Bass",
      kind: "midi",
      color: null,
      isMuted: false,
      isSoloed: false,
      isArmed: false,
      volume: 0.7,
      pan: 0,
    },
  ],
  clips: [],
};

const connected = {
  state: "connected",
  liveVersion: "12.1",
  remoteScriptVersion: "0.4.0",
  projectId: "project-1",
} as const;

describe("agent policy", () => {
  it("builds bounded project context without detailed musical content", () => {
    const context = compactProjectContext(connected, snapshot);

    expect(context).toContain('"projectId":"project-1"');
    expect(context).toContain('"name":"Drums"');
    expect(context).toContain('"sessionClipCount":0');
    expect(context).not.toContain('"volume"');
    expect(context).not.toContain('"pan"');
  });

  it("classifies non-retryable failures and returns targeted guidance", () => {
    expect(structuredErrorCode("stale_reference: track changed")).toBe(
      "stale_reference",
    );
    expect(retryGuidance("unsupported capability")).toContain("Do not retry");
    expect(retryGuidance("connection reset")).toContain("at most once");
  });

  it("injects fresh context at session and prompt boundaries", async () => {
    const getAbletonStatus = vi.fn(async () => connected);
    const inspectSession = vi.fn(async () => snapshot);
    const hooks = createAgentHooks({ getAbletonStatus, inspectSession });

    const started = await hooks.onSessionStart?.(
      {
        sessionId: "session-1",
        timestamp: new Date(),
        workingDirectory: "/tmp",
        source: "new",
      },
      { sessionId: "session-1" },
    );
    const prompted = await hooks.onUserPromptSubmitted?.(
      {
        sessionId: "session-1",
        timestamp: new Date(),
        workingDirectory: "/tmp",
        prompt: "Mute the bass",
      },
      { sessionId: "session-1" },
    );

    expect(started?.additionalContext).toContain("Current Ableton project");
    expect(prompted?.additionalContext).toContain('"tempo":124');
    expect(inspectSession).toHaveBeenCalledTimes(2);
  });

  it("blocks an unchanged retry after a stale or denied tool failure", async () => {
    const hooks = createAgentHooks({
      getAbletonStatus: async () => connected,
      inspectSession: async () => snapshot,
    });
    const hookInput = {
      sessionId: "session-1",
      timestamp: new Date(),
      workingDirectory: "/tmp",
      toolName: "ableton_tracks_rename",
      toolArgs: { index: 1, expectedReference: "old" },
    };

    const failure = await hooks.onPostToolUseFailure?.(
      { ...hookInput, error: "stale_reference: target changed" },
      { sessionId: "session-1" },
    );
    const retry = await hooks.onPreToolUse?.(hookInput, {
      sessionId: "session-1",
    });

    expect(failure?.additionalContext).toContain("Re-inspect");
    expect(retry).toMatchObject({
      permissionDecision: "deny",
    });
  });

  it("allows permission denial to block the same tool attempt", async () => {
    const policy = createAgentPolicy({
      getAbletonStatus: async () => connected,
      inspectSession: async () => snapshot,
    });
    policy.blockAttempt(
      "ableton_tracks_delete",
      { index: 1 },
      "User denied this operation",
    );

    const retry = await policy.hooks.onPreToolUse?.(
      {
        sessionId: "session-1",
        timestamp: new Date(),
        workingDirectory: "/tmp",
        toolName: "ableton_tracks_delete",
        toolArgs: { index: 1 },
      },
      { sessionId: "session-1" },
    );

    expect(retry).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: "User denied this operation",
    });
  });
});
