import { describe, expect, it, vi } from "vitest";

import type { SessionSnapshot } from "@ableton-agent/protocol";

import {
  AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE,
  browserIntentGuidance,
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
  clips: [
    {
      reference: "00000000-0000-4000-8000-000000000003",
      trackReference: "00000000-0000-4000-8000-000000000002",
      trackIndex: 1,
      sceneIndex: 2,
      name: "Bass Verse",
      kind: "midi",
      length: 4,
      noteCount: 4,
      muted: false,
      looping: true,
      isPlaying: false,
      isTriggered: false,
    },
  ],
};

const connected = {
  state: "connected",
  liveVersion: "12.1",
  remoteScriptVersion: "0.4.0",
  projectId: "project-1",
} as const;

describe("agent policy", () => {
  it("builds fresh action context with exact identities but no musical detail", () => {
    const context = compactProjectContext(connected, snapshot);

    expect(context).toContain("Fresh Ableton project context for this prompt");
    expect(context).toContain("use these exact identities directly");
    expect(context).toContain('"projectId":"project-1"');
    expect(context).toContain('"name":"Drums"');
    expect(context).toContain('"sessionClipCount":1');
    expect(context).toContain('"sessionClips":[{');
    expect(context).toContain(
      '"reference":"00000000-0000-4000-8000-000000000003"',
    );
    expect(context).toContain(
      '"trackReference":"00000000-0000-4000-8000-000000000002"',
    );
    expect(context).toContain('"trackIndex":1');
    expect(context).toContain('"sceneIndex":2');
    expect(context).toContain('"name":"Bass Verse"');
    expect(context).toContain('"sessionClipsTruncated":false');
    expect(context).not.toContain('"noteCount"');
    expect(context).not.toContain('"length"');
    expect(context).not.toContain('"volume"');
    expect(context).not.toContain('"pan"');
  });

  it("bounds project action identities and reports truncation", () => {
    const tracks = Array.from({ length: 17 }, (_, index) => ({
      ...snapshot.tracks[0]!,
      index,
      reference: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `Track ${index}`,
    }));
    const clips = Array.from({ length: 129 }, (_, index) => ({
      ...snapshot.clips![0]!,
      reference: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sceneIndex: index,
      name: `Clip ${index}`,
    }));

    const context = compactProjectContext(connected, {
      ...snapshot,
      trackCount: tracks.length,
      tracks,
      clips,
    });
    const serialized = context.slice(context.indexOf("{"));
    const parsed = JSON.parse(serialized) as {
      tracks: unknown[];
      tracksTruncated: boolean;
      sessionClips: unknown[];
      sessionClipsTruncated: boolean;
    };

    expect(parsed.tracks).toHaveLength(16);
    expect(parsed.tracksTruncated).toBe(true);
    expect(parsed.sessionClips).toHaveLength(128);
    expect(parsed.sessionClipsTruncated).toBe(true);
  });

  it("classifies non-retryable failures and returns targeted guidance", () => {
    expect(structuredErrorCode("stale_reference: track changed")).toBe(
      "stale_reference",
    );
    expect(retryGuidance("unsupported capability")).toContain("Do not retry");
    expect(
      structuredErrorCode('lom_error: {"outcome":"applied_indeterminate"}'),
    ).toBe("applied_indeterminate");
    expect(retryGuidance("postcondition verification failed")).toContain(
      "may already have changed Ableton",
    );
    expect(retryGuidance("connection reset")).toContain("at most once");
  });

  it("injects cached context without prompt-bound session inspection", async () => {
    const getAbletonStatus = vi.fn(async () => connected);
    const inspectSession = vi.fn(async () => snapshot);
    const getPreparedContext = vi.fn(() =>
      compactProjectContext(connected, snapshot),
    );
    const hooks = createAgentHooks({
      getAbletonStatus,
      inspectSession,
      preparedContext: { getPreparedContext },
    });

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

    expect(started?.additionalContext).toContain(
      "supplied per prompt from the prepared context store",
    );
    expect(prompted?.additionalContext).toContain('"tempo":124');
    expect(prompted?.additionalContext).toContain('"name":"Bass Verse"');
    expect(getPreparedContext).toHaveBeenCalledOnce();
    expect(inspectSession).not.toHaveBeenCalled();
    expect(getAbletonStatus).not.toHaveBeenCalled();
  });

  it("directs automatic Listening Events to use guarded cached identities", async () => {
    const listener = {
      id: "event-listener.00000000-0000-4000-8000-000000000001",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      enabled: true,
      responseMode: "automatic" as const,
    };
    const getPreparedContext = vi.fn(
      () =>
        'Prepared context\n{"freshness":"stale","identityPolicy":"guarded-exact-reference"}',
    );
    const hooks = createAgentHooks({
      getAbletonStatus: async () => connected,
      preparedContext: {
        getPreparedContext,
        activeListener: () => listener,
      },
    });

    const prompted = await hooks.onUserPromptSubmitted?.(
      {
        sessionId: "session-1",
        timestamp: new Date(),
        workingDirectory: "/tmp",
        prompt:
          "<live-event-trigger>Launch the corresponding clip.</live-event-trigger>",
      },
      { sessionId: "session-1" },
    );

    expect(prompted?.additionalContext).toContain(
      AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE,
    );
    expect(prompted?.additionalContext).toContain(
      "Do not inspect solely because freshness is stale",
    );
    expect(prompted?.additionalContext).toContain(
      "missing, ambiguous, unresolved, or truncated",
    );
    expect(getPreparedContext).toHaveBeenCalledWith(listener);
  });

  it("injects separate Browser guidance for piano and string bass requests", async () => {
    const guidance = browserIntentGuidance(
      "create two new tracks: a piano and a string bass",
    );

    expect(guidance).toContain('"piano"');
    expect(guidance).toContain('"upright bass"');
    expect(guidance).toContain(
      '["sounds","instruments","packs","user_library"]',
    );
    expect(guidance).toContain("every distinct requested sound");
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

  it("blocks an unchanged retry after an indeterminate mutation", async () => {
    const hooks = createAgentHooks({
      getAbletonStatus: async () => connected,
      inspectSession: async () => snapshot,
    });
    const hookInput = {
      sessionId: "session-1",
      timestamp: new Date(),
      workingDirectory: "/tmp",
      toolName: "ableton_tracks_create",
      toolArgs: { kind: "midi", name: "808 Drums" },
    };

    const failure = await hooks.onPostToolUseFailure?.(
      {
        ...hookInput,
        error: 'lom_error: mutation failed {"outcome":"applied_indeterminate"}',
      },
      { sessionId: "session-1" },
    );
    const retry = await hooks.onPreToolUse?.(hookInput, {
      sessionId: "session-1",
    });

    expect(failure?.additionalContext).toContain("Re-inspect");
    expect(retry).toMatchObject({ permissionDecision: "deny" });
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
