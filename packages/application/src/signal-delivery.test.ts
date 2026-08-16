import { describe, expect, it, vi } from "vitest";

import { InMemoryEventPublisher, type AppEvent } from "@ableton-agent/shared";
import type { SessionConfig } from "@github/copilot-sdk";

import { createAgentPolicy } from "./agent-policy.js";
import {
  CopilotAgentService,
  type CopilotAgentServiceOptions,
} from "./index.js";
import {
  constructNextPromptSignalContext,
  formatAutomaticSignalPrompt,
  type PendingSignalContext,
  type SignalContextProvider,
  type SignalTurnRequest,
} from "./signal-delivery.js";

function pending(
  deliveryId: string,
  assignmentId: string,
  sequence: number,
  deliveryMode: PendingSignalContext["context"]["deliveryMode"] = "next-prompt",
  content = `Notes: C4 sequence ${sequence}`,
): PendingSignalContext {
  return {
    deliveryId,
    context: {
      assignmentId,
      producerId: "keyboard",
      consumer: { kind: "agent-session", id: "active" },
      deliveryMode,
      sequence,
      capturedAt: 1_750_000_000_000 + sequence,
      sourceIdentity: "Studio Keyboard [producer=keyboard, instance=one]",
      content,
    },
  };
}

const disconnected = { state: "disconnected" } as const;
const emptySnapshot = {
  tempo: 120,
  timeSignature: { numerator: 4, denominator: 4 },
  isPlaying: false,
  trackCount: 0,
  tracks: [],
};

describe("next-prompt signal context", () => {
  it("selects the latest window per assignment and remains bounded", () => {
    const result = constructNextPromptSignalContext(
      [
        pending("old", "keys", 1),
        pending("new", "keys", 2, "next-prompt", "x".repeat(500)),
        pending("bass", "bass", 1),
      ],
      { maximumContexts: 1, maximumContextCharacters: 260 },
    );

    expect(result.deliveryIds).toEqual(["bass"]);
    expect(result.additionalContext?.length).toBeLessThanOrEqual(360);
    expect(result.additionalContext).toContain("source observation");
    expect(result.additionalContext).not.toContain("key is");
  });

  it("is one-shot, session-isolated, and acknowledges only included entries", async () => {
    const delivered = new Map<string, Set<string>>();
    const entries = {
      one: [pending("one-entry", "keys", 1)],
      two: [pending("two-entry", "keys", 2)],
    } as const;
    const provider: SignalContextProvider = {
      getPendingContexts: async (sessionId) =>
        entries[sessionId as keyof typeof entries].filter(
          ({ deliveryId }) => !delivered.get(sessionId)?.has(deliveryId),
        ),
      markDelivered: async (sessionId, ids) => {
        const sessionDelivered = delivered.get(sessionId) ?? new Set<string>();
        ids.forEach((id) => sessionDelivered.add(id));
        delivered.set(sessionId, sessionDelivered);
      },
    };
    const policy = createAgentPolicy({
      getAbletonStatus: async () => disconnected,
      inspectSession: async () => emptySnapshot,
      signalContext: { provider },
    });
    const input = (sessionId: "one" | "two") => ({
      sessionId,
      timestamp: new Date(),
      workingDirectory: ".",
      prompt: "What is happening?",
    });

    const first = await policy.hooks.onUserPromptSubmitted?.(input("one"), {
      sessionId: "one",
    });
    const repeated = await policy.hooks.onUserPromptSubmitted?.(input("one"), {
      sessionId: "one",
    });
    const other = await policy.hooks.onUserPromptSubmitted?.(input("two"), {
      sessionId: "two",
    });

    expect(first?.additionalContext).toContain("sequence 1");
    expect(repeated?.additionalContext).not.toContain("<signal-context");
    expect(other?.additionalContext).toContain("sequence 2");
    expect([...delivered.get("one")!]).toEqual(["one-entry"]);
  });

  it("does not acknowledge when delivery acknowledgement fails", async () => {
    const markDelivered = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const policy = createAgentPolicy({
      getAbletonStatus: async () => disconnected,
      inspectSession: async () => emptySnapshot,
      signalContext: {
        provider: {
          getPendingContexts: async () => [pending("entry", "keys", 1)],
          markDelivered,
        },
      },
    });

    await expect(
      policy.hooks.onUserPromptSubmitted?.(
        {
          sessionId: "one",
          timestamp: new Date(),
          workingDirectory: ".",
          prompt: "Continue",
        },
        { sessionId: "one" },
      ),
    ).rejects.toThrow("storage unavailable");
    expect(markDelivered).toHaveBeenCalledWith("one", ["entry"]);
  });
});

describe("automatic signal delivery", () => {
  it("formats an explicit source event without claiming inferred intent", () => {
    const prompt = formatAutomaticSignalPrompt(
      pending("entry", "keys", 4, "automatic-action") as SignalTurnRequest,
    );

    expect(prompt).toContain("Internal signal event");
    expect(prompt).toContain("not a user-authored request");
    expect(prompt).toContain("Do not infer key, harmony, or intent");
    expect(prompt).toContain("normal mutation permissions");
  });

  it("blocks mutations during analysis while retaining reads and action approvals", async () => {
    let blocked = true;
    const policy = createAgentPolicy({
      getAbletonStatus: async () => disconnected,
      inspectSession: async () => emptySnapshot,
      mutationBlocked: () => blocked,
    });
    const hookInput = (toolName: string) => ({
      sessionId: "session",
      timestamp: new Date(),
      workingDirectory: ".",
      toolName,
      toolArgs: {},
    });

    expect(
      await policy.hooks.onPreToolUse?.(hookInput("ableton_tracks_create"), {
        sessionId: "session",
      }),
    ).toMatchObject({ permissionDecision: "deny" });
    expect(
      await policy.hooks.onPreToolUse?.(hookInput("ableton_session_inspect"), {
        sessionId: "session",
      }),
    ).toBeUndefined();
    blocked = false;
    expect(
      await policy.hooks.onPreToolUse?.(hookInput("ableton_tracks_create"), {
        sessionId: "session",
      }),
    ).toBeUndefined();
  });

  it("serializes user and automatic turns and coalesces newer assignment windows", async () => {
    let config: SessionConfig | undefined;
    let releaseUser: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const prompts: string[] = [];
    const marked: string[][] = [];
    const policyDecisions: unknown[] = [];
    const requestToolApproval = vi.fn(async () => true);
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const sendAndWait = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (prompt === "user turn") {
        await new Promise<void>((resolve) => {
          releaseUser = resolve;
        });
      } else if (prompt.includes("automatic analysis")) {
        policyDecisions.push(
          await config?.hooks?.onPreToolUse?.(
            {
              sessionId: "session",
              timestamp: new Date(),
              workingDirectory: ".",
              toolName: "ableton_tracks_create",
              toolArgs: {},
            },
            { sessionId: "session" },
          ),
          await config?.hooks?.onPreToolUse?.(
            {
              sessionId: "session",
              timestamp: new Date(),
              workingDirectory: ".",
              toolName: "ableton_session_inspect",
              toolArgs: {},
            },
            { sessionId: "session" },
          ),
        );
      } else if (prompt.includes("automatic action")) {
        policyDecisions.push(
          await config?.hooks?.onPreToolUse?.(
            {
              sessionId: "session",
              timestamp: new Date(),
              workingDirectory: ".",
              toolName: "ableton_tracks_create",
              toolArgs: {},
            },
            { sessionId: "session" },
          ),
          await config?.onPermissionRequest?.(
            {
              kind: "custom-tool",
              toolName: "ableton_tracks_create",
              toolDescription: "Create track",
              args: {},
            },
            { sessionId: "session" },
          ),
        );
      }
      active -= 1;
      return { data: { content: "complete" } };
    });
    const options = {
      events,
      getAbletonStatus: async () => disconnected,
      inspectSession: async () => emptySnapshot,
      signalContext: {
        provider: {
          getPendingContexts: async () => [],
          markDelivered: async (_sessionId: string, ids: readonly string[]) => {
            marked.push([...ids]);
          },
        },
      },
      requestToolApproval,
      clientFactory: () => ({
        createSession: async (received: SessionConfig) => {
          config = received;
          return {
            sessionId: "session",
            sendAndWait,
            abort: async () => undefined,
            disconnect: async () => undefined,
            on: () => () => undefined,
          };
        },
        resumeSession: async () => {
          throw new Error("unused");
        },
        stop: async () => undefined,
      }),
    } as unknown as CopilotAgentServiceOptions;
    const service = new CopilotAgentService(options);
    await service.start();

    const user = service.send("user turn");
    await vi.waitFor(() => expect(releaseUser).toBeDefined());
    const first = service.enqueueSignalTurn(
      pending("old", "keys", 1, "automatic-analysis") as SignalTurnRequest,
    );
    const second = service.enqueueSignalTurn(
      pending("new", "keys", 2, "automatic-analysis") as SignalTurnRequest,
    );
    releaseUser!();
    await Promise.all([user, first, second]);
    await service.enqueueSignalTurn(
      pending("action", "drums", 3, "automatic-action") as SignalTurnRequest,
    );

    expect(maximumActive).toBe(1);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("sequence 2");
    expect(prompts[1]).not.toContain("sequence 1");
    expect(prompts[2]).toContain("automatic action");
    expect(marked).toEqual([["old", "new"], ["action"]]);
    expect(policyDecisions).toEqual([
      expect.objectContaining({ permissionDecision: "deny" }),
      undefined,
      undefined,
      { kind: "approve-once" },
    ]);
    expect(requestToolApproval).toHaveBeenCalledOnce();
    expect(
      received.filter(({ type }) => type === "agent.message_complete"),
    ).toHaveLength(3);
    expect(config).toBeDefined();
    await service.stop();
  });
});
