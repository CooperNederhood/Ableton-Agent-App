import { describe, expect, it, vi } from "vitest";

import {
  contextOperationParamsSchema,
  createListeningTools,
  listeningOperationParamsSchema,
} from "./listening-tools.js";
import {
  createAbletonMutationAuthorizer,
  resolveAbletonOperation,
} from "./index.js";

const reference = "00000000-0000-4000-8000-000000000001";
const sessionInput = {
  action: "play-session-and-listen",
  target: {
    view: "session",
    track: {
      kind: "regular",
      index: 0,
      expectedReference: reference,
      expectedName: "Audio",
    },
    sceneIndex: 0,
    expectedClipReference: "00000000-0000-4000-8000-000000000002",
    expectedClipName: "Sample",
  },
  listenerIds: ["tap-after"],
};

describe("optional listening tool contracts", () => {
  it("explains exact action arguments, queued status and known-context retrieval before a call", () => {
    const [listening, context] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({ action: "list", entries: [] }),
    });
    expect(listening.description).toContain(
      "play-arrangement-and-listen requires listenerIds, startBeat and endBeat",
    );
    expect(listening.description).toContain("durationBeats is Session-only");
    expect(listening.description).toContain(
      "Queued or arming is not completion or failure",
    );
    expect(listening.description).toContain(
      "Use get-pass with the returned passId",
    );
    expect(listening.description).toContain("Never use bash or sleep to wait");
    expect(listening.description).toContain(
      "Arrangement capture is not read-only",
    );
    expect(listening.description).toContain(
      "Back to Arrangement restores the playback source, not the view",
    );
    expect(listening.description).toContain(
      "Switching views, stopping playback or deselecting a clip does not clear this override",
    );
    expect(listening.description).toContain(
      "never repair source selection or retry automatically",
    );
    expect(context.description).toContain(
      "When a contextId is already known, use get",
    );
    expect(context.description).toContain("list does not accept contextId");
    expect(context.description).not.toContain(
      "List compact summaries before requesting observation detail",
    );
  });

  it("describes guarded Session launch and uncertainty without promising isolation or cancellation rollback", () => {
    const [tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({
        action: "list",
        entries: [],
      }),
    });
    expect(tool.description).toContain(
      "Playback continues after completion, cancellation, failure, or timeout",
    );
    expect(tool.description).toContain("cancel stops capture, not transport");
    expect(tool.description).toContain(
      "Session requires a matching native v3 listener",
    );
    expect(tool.description).toContain("stopped beat zero and global None");
    expect(listeningOperationParamsSchema.options[1].description).toContain(
      "stopped beat zero and global None",
    );
    expect(tool.description).toContain(
      "unknown follow-action settings remain explicit",
    );
    expect(tool.description).toContain(
      "does not retract an accepted or queued launch",
    );
    expect(tool.description).toContain("otherwise no context is published");
    expect(tool.description).toContain("native_per_pass_validation_required");
    expect(tool.description).toContain("nonzero/fractional Arrangement starts");
    expect(tool.description).toContain("through 30 seconds");
    expect(tool.description).toContain(
      "Tempo stability is assumed, not independently verified",
    );
    expect(tool.description).toContain("tempo automation is unsupported");
    expect(tool.description).toContain("not absolute accuracy");
    expect(tool.description).toContain("There is no automatic legacy fallback");
    expect(tool.description).toContain("trusted Settings once per pass");
    expect(tool.description).toContain("even while ready=false");
    expect(tool.description).toContain(
      "genuine per-pass arm proof is required before playback",
    );
    expect(tool.description).toContain("complete coverage before publication");
    expect(tool.description).toContain(
      "Other uncommissioned listeners remain denied",
    );
  });

  it("requires exact Session identity and defaults bounded capture", () => {
    expect(listeningOperationParamsSchema.parse(sessionInput)).toMatchObject({
      durationBeats: 4,
      maximumDurationMs: 300_000,
    });
    expect(
      listeningOperationParamsSchema.safeParse({
        ...sessionInput,
        target: { ...sessionInput.target, expectedClipReference: undefined },
      }).success,
    ).toBe(false);
  });

  it.each([
    { listenerIds: [] },
    { listenerIds: ["tap", "tap"] },
    { listenerIds: Array.from({ length: 9 }, (_, index) => `tap-${index}`) },
    { maximumDurationMs: 300_001 },
    { durationBeats: 4.01 },
    { listenerIds: ["tap-before", "tap-after"] },
    { durationBeats: Infinity },
    { rawAudio: [1, 2] },
  ])("rejects unsafe capture parameters %j", (patch) => {
    expect(
      listeningOperationParamsSchema.safeParse({
        ...sessionInput,
        ...patch,
      }).success,
    ).toBe(false);
  });

  it("rejects reversed Arrangement ranges without reaching a service", () => {
    expect(
      listeningOperationParamsSchema.safeParse({
        action: "play-arrangement-and-listen",
        listenerIds: ["tap"],
        startBeat: 16,
        endBeat: 8,
      }).success,
    ).toBe(false);
  });

  it("requires bounded explicit pruning and refuses arbitrary context writes", () => {
    expect(
      contextOperationParamsSchema.safeParse({
        action: "prune",
        contextIds: ["context-1"],
        confirm: "prune-session-context",
      }).success,
    ).toBe(true);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "prune",
        contextIds: ["context-1"],
      }).success,
    ).toBe(false);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "write",
        subjectId: "clip",
        value: { notes: "arbitrary" },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded opaque repository cursors independently of entity ID limits", () => {
    expect(
      contextOperationParamsSchema.safeParse({
        action: "list",
        cursor: "a".repeat(2048),
      }).success,
    ).toBe(true);
    expect(
      contextOperationParamsSchema.safeParse({
        action: "list",
        cursor: "a".repeat(2049),
      }).success,
    ).toBe(false);
    expect(
      listeningOperationParamsSchema.safeParse({
        action: "list-passes",
        cursor: "a".repeat(2048),
      }).success,
    ).toBe(true);
  });

  it("preserves bounded repository continuation cursors in typed results", async () => {
    const nextCursor = "a".repeat(2048);
    const [, tool] = createListeningTools({
      executeListeningOperation: async () => ({
        action: "inspect-listeners",
        listeners: [],
        truncated: false,
      }),
      executeContextOperation: async () => ({
        action: "list",
        entries: [],
        nextCursor,
      }),
    });
    const params = contextOperationParamsSchema.parse({ action: "list" });
    expect(
      await tool.handler?.(params, {
        sessionId: "sdk",
        toolCallId: "call",
        toolName: "ableton_context",
        arguments: params,
      }),
    ).toMatchObject({ action: "list", nextCursor });
  });

  it("classifies playback as session mutation and context pruning as destructive", () => {
    expect(
      resolveAbletonOperation("ableton_listening", sessionInput)?.descriptor,
    ).toMatchObject({
      risk: "reversible",
      mutationTarget: "session",
      editScope: "session",
      duration: "long",
    });
    expect(
      resolveAbletonOperation("ableton_context", {
        action: "prune",
        contextIds: ["context-1"],
        confirm: "prune-session-context",
      })?.descriptor,
    ).toMatchObject({ risk: "destructive", mutationTarget: "session" });
    const authorizer = createAbletonMutationAuthorizer([
      { name: "ableton_listening", mutationTarget: "session" },
    ]);
    expect(
      authorizer.authorize(
        {
          activeAgentConfig: {
            resolvedTools: ["ableton_listening"],
            editScope: [],
          },
          editScopeBindings: [],
        },
        { toolName: "ableton_listening", args: sessionInput },
      ),
    ).toMatchObject({ kind: "deny", code: "session_scope_required" });
  });

  it("uses the service only through bounded typed results and rejects action mismatch", async () => {
    const executeListeningOperation = vi.fn(async () => ({
      action: "inspect-listeners" as const,
      listeners: [],
      truncated: false,
    }));
    const [tool] = createListeningTools({
      executeListeningOperation,
      executeContextOperation: async () => ({
        action: "list",
        entries: [],
      }),
    });
    expect(
      await tool.handler?.(
        { action: "inspect-listeners" },
        {
          sessionId: "sdk",
          toolCallId: "call",
          toolName: "ableton_listening",
          arguments: { action: "inspect-listeners" },
        },
      ),
    ).toMatchObject({ action: "inspect-listeners", listeners: [] });
    expect(executeListeningOperation).toHaveBeenCalledOnce();
    expect(executeListeningOperation).toHaveBeenCalledWith(
      { action: "inspect-listeners" },
      expect.objectContaining({ sessionId: "sdk", toolCallId: "call" }),
    );
    await expect(
      tool.handler?.(
        { action: "get-pass", passId: "owned-pass" },
        {
          sessionId: "sdk",
          toolCallId: "call",
          toolName: "ableton_listening",
          arguments: { action: "get-pass", passId: "owned-pass" },
        },
      ),
    ).rejects.toThrow("action mismatch");
  });
});
