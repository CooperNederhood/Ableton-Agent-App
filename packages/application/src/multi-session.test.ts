import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readSkillDocument,
  type AgentEventListener,
} from "@ableton-agent/agent-config";
import { describe, expect, it, vi } from "vitest";
import type {
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";

import { InMemoryEventPublisher, type AppEvent } from "@ableton-agent/shared";

import {
  CopilotAgentService,
  isMissingCopilotSessionError,
  MissingCopilotSessionError,
  PLAN_REMINDER,
  PLAN_REMINDER_VERSION,
  type AgentRuntimeEvent,
  type AgentSkillDescriptor,
  type AgentSessionConfiguration,
  type CopilotAgentServiceOptions,
} from "./index.js";
import { AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE } from "./agent-policy.js";
import type { SignalTurnRequest } from "./signal-delivery.js";
import type { LiveEventTurnRequest } from "./live-event-delivery.js";

const disconnected = { state: "disconnected" } as const;
const trackAReference = "00000000-0000-4000-8000-000000000001";
const trackBReference = "00000000-0000-4000-8000-000000000002";
const emptySnapshot = {
  tempo: 120,
  timeSignature: { numerator: 4, denominator: 4 },
  isPlaying: false,
  trackCount: 0,
  tracks: [],
};

function skillDescriptor(name: string): AgentSkillDescriptor {
  return {
    name,
    description: `Description for ${name}`,
    sourcePath: `/repo/skills/${name}/SKILL.md`,
    fingerprint: "a".repeat(64),
  };
}

async function createSkillDescriptor(
  root: string,
  name: string,
  body: string,
): Promise<AgentSkillDescriptor> {
  const directory = join(root, name);
  const sourcePath = join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });
  await writeFile(
    sourcePath,
    [
      "---",
      `name: ${name}`,
      `description: Description for ${name}`,
      "---",
      "",
      body,
    ].join("\n"),
  );
  const document = await readSkillDocument(sourcePath, name);
  return {
    ...document.metadata,
    sourcePath,
    fingerprint: document.fingerprint,
  };
}

function configuration(
  instanceId: string,
  overrides: Partial<Omit<AgentSessionConfiguration, "instanceId">> = {},
): AgentSessionConfiguration {
  return {
    instanceId,
    productionSessionId: `production-${instanceId}`,
    definitionName: `${instanceId}-definition`,
    label: `Agent ${instanceId}`,
    description: `Description for ${instanceId}`,
    systemPrompt: `System prompt for ${instanceId}`,
    resolvedTools: ["ableton_session_inspect", "ableton_tracks_create"],
    editScope: ["session"],
    boundTracks: [],
    skills: [],
    availableSkills: [],
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<CopilotAgentServiceOptions>,
): CopilotAgentServiceOptions {
  const sessionStateDirectory = join(
    tmpdir(),
    `ableton-agent-test-session-state-${randomUUID()}`,
  );
  return {
    events: new InMemoryEventPublisher(),
    resolvePlanArtifactPaths: (productionSessionId: string) => {
      const sessionDirectory = join(sessionStateDirectory, productionSessionId);
      const artifactsDirectory = join(sessionDirectory, "artifacts");
      return {
        sessionDirectory,
        artifactsDirectory,
        planPath: join(artifactsDirectory, "plan.md"),
      };
    },
    getAbletonStatus: async () => disconnected,
    inspectSession: async () => emptySnapshot,
    signalContext: {
      provider: {
        getPendingContexts: async () => [],
        markDelivered: async () => undefined,
      },
    },
    ...overrides,
  } as unknown as CopilotAgentServiceOptions;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function userMessage(
  eventId: string,
  content: string,
  timestamp: string,
): SessionEvent {
  return {
    type: "user.message",
    id: eventId,
    parentId: null,
    timestamp,
    data: { content },
  };
}

function assistantMessage(
  eventId: string,
  messageId: string,
  content: string,
  timestamp: string,
): SessionEvent {
  return {
    type: "assistant.message",
    id: eventId,
    parentId: null,
    timestamp,
    data: { messageId, content },
  };
}

function assistantDelta(content: string): SessionEvent {
  return {
    type: "assistant.message_delta",
    id: `delta-${content}`,
    parentId: null,
    timestamp: "2026-08-08T00:00:01.000Z",
    ephemeral: true,
    data: { messageId: `message-${content}`, deltaContent: content },
  };
}

function toolStart(toolCallId: string, toolName: string): SessionEvent {
  return {
    type: "tool.execution_start",
    id: `start-${toolCallId}`,
    parentId: null,
    timestamp: "2026-08-08T00:00:02.000Z",
    data: { toolCallId, toolName },
  };
}

function toolComplete(toolCallId: string): SessionEvent {
  return {
    type: "tool.execution_complete",
    id: `complete-${toolCallId}`,
    parentId: null,
    timestamp: "2026-08-08T00:00:03.000Z",
    data: { toolCallId, success: true },
  };
}

function createFakeSession(
  sessionId: string,
  options: {
    onSend?: (
      prompt: string,
      emit: (event: SessionEvent) => void,
    ) => Promise<{ data: { content: string } } | undefined>;
    history?: readonly SessionEvent[];
    getEvents?: () => Promise<readonly SessionEvent[]>;
    abort?: () => Promise<void>;
    rpc?: {
      ui: {
        handlePendingExitPlanMode: (request: {
          requestId: string;
          response: {
            approved: boolean;
            selectedAction?: "interactive" | "exit_only";
            feedback?: string;
          };
        }) => Promise<{ success: boolean }>;
      };
    };
  } = {},
) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const prompts: string[] = [];
  const messages: Array<{
    prompt: string;
    agentMode?: "interactive" | "plan";
  }> = [];
  const disconnect = vi.fn(async () => undefined);
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const emit = (event: SessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const send = vi.fn(
    async (message: { prompt: string; agentMode?: "interactive" | "plan" }) => {
      const prompt = message.prompt;
      prompts.push(prompt);
      messages.push(message);
      const response =
        options.onSend === undefined
          ? { data: { content: `reply:${sessionId}:${prompt}` } }
          : await options.onSend(prompt, emit);
      if (response !== undefined) {
        emit(
          assistantMessage(
            `assistant-${messages.length}`,
            `message-${messages.length}`,
            response.data.content,
            new Date().toISOString(),
          ),
        );
      }
      emit({
        type: "session.idle",
        id: `idle-${messages.length}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        ephemeral: true,
        data: { mode: "interactive" },
      });
      return `message-${messages.length}`;
    },
  );
  return {
    sessionId,
    prompts,
    messages,
    emit,
    send,
    abort,
    disconnect,
    on: (receivedListener: (event: SessionEvent) => void) => {
      listeners.add(receivedListener);
      return () => {
        listeners.delete(receivedListener);
      };
    },
    ...(options.rpc === undefined ? {} : { rpc: options.rpc }),
    ...(options.getEvents === undefined && options.history === undefined
      ? {}
      : {
          getEvents: vi.fn(
            options.getEvents ?? (async () => options.history ?? []),
          ),
        }),
  };
}

function modelInfo(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: `Model ${id}`,
    capabilities: {
      supports: { vision: true, reasoningEffort: true },
      limits: {
        max_prompt_tokens: 32_000,
        max_context_window_tokens: 64_000,
      },
    },
    policy: { state: "enabled", terms: "" },
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    ...overrides,
  };
}

describe("CopilotAgentService managed sessions", () => {
  it("uses plan.md as the approval source and rejects stale approvals", async () => {
    const sessionStateDirectory = await mkdtemp(
      join(tmpdir(), "ableton-plan-session-"),
    );
    const configs: SessionConfig[] = [];
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const service = new CopilotAgentService(
      baseOptions({
        events,
        resolvePlanArtifactPaths: (productionSessionId: string) => {
          const sessionDirectory = join(
            sessionStateDirectory,
            productionSessionId,
          );
          const artifactsDirectory = join(sessionDirectory, "artifacts");
          return {
            sessionDirectory,
            artifactsDirectory,
            planPath: join(artifactsDirectory, "plan.md"),
          };
        },
        clientFactory: () => ({
          createSession: vi.fn(async (config: SessionConfig) => {
            configs.push(config);
            return createFakeSession(`session-${configs.length}`);
          }),
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    try {
      await service.start();
      await service.createManagedAgent(
        configuration("planner", {
          productionSessionId: "production-session",
        }),
      );
      const config = configs[1];
      if (config?.onExitPlanModeRequest === undefined) {
        throw new Error("Expected exit-plan handler");
      }

      await expect(
        config.onExitPlanModeRequest(
          {
            summary: "Ready for review",
            planContent: "# Ignored SDK payload",
            actions: ["interactive"],
            recommendedAction: "interactive",
          },
          { sessionId: "session-2" },
        ),
      ).resolves.toMatchObject({ approved: false });

      const first = await service.writeManagedAgentPlan("planner", {
        content: "# Canonical plan\n\n1. Inspect the Live Set.\n",
      });
      if (!first.exists) throw new Error("Expected plan artifact");
      const approval = config.onExitPlanModeRequest(
        {
          summary: "Ready for review",
          planContent: "# Ignored SDK payload",
          actions: ["interactive"],
          recommendedAction: "interactive",
        },
        { sessionId: "session-2" },
      );
      await vi.waitFor(() =>
        expect(
          received.some(
            (event) => event.type === "agent.plan_approval_requested",
          ),
        ).toBe(true),
      );
      const requested = [...received]
        .reverse()
        .find((event) => event.type === "agent.plan_approval_requested");
      expect(requested).toMatchObject({
        type: "agent.plan_approval_requested",
        agentInstanceId: "planner",
        request: {
          planContent: first.content,
          planRevision: first.revision,
        },
      });
      if (requested?.type !== "agent.plan_approval_requested") {
        throw new Error("Expected plan approval request");
      }

      const updated = await service.writeManagedAgentPlan("planner", {
        content: "# Revised plan\n\n1. Inspect.\n2. Verify.\n",
        expectedRevision: first.revision,
      });
      if (!updated.exists) throw new Error("Expected revised plan artifact");
      await expect(
        service.resolveManagedAgentPlan("planner", {
          requestId: requested.request.requestId,
          approved: true,
          planRevision: first.revision,
          selectedAction: "interactive",
        }),
      ).rejects.toThrow("changed while it was being reviewed");
      await expect(
        service.resolveManagedAgentPlan("planner", {
          requestId: requested.request.requestId,
          approved: true,
          planRevision: updated.revision,
          selectedAction: "interactive",
        }),
      ).resolves.toBe(true);
      await expect(approval).resolves.toMatchObject({
        approved: true,
        selectedAction: "interactive",
      });
    } finally {
      await service.stop();
      await rm(sessionStateDirectory, { recursive: true, force: true });
    }
  });

  it("publishes and resolves structured elicitation requests", async () => {
    const configs: SessionConfig[] = [];
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const service = new CopilotAgentService(
      baseOptions({
        events,
        clientFactory: () => ({
          createSession: vi.fn(async (config: SessionConfig) => {
            configs.push(config);
            return createFakeSession(`session-${configs.length}`);
          }),
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(
      configuration("planner", {
        resolvedTools: ["task", "skill"],
        skills: [],
      }),
    );
    const handler = configs[1]?.onElicitationRequest;
    if (handler === undefined) throw new Error("Expected elicitation handler");
    const legacyHandler = configs[1]?.onUserInputRequest;
    if (legacyHandler === undefined) {
      throw new Error("Expected user-input compatibility handler");
    }
    expect(configs[1]?.availableTools).toContain("builtin:task");
    expect(configs[1]?.availableTools).toContain("builtin:ask_user");
    expect(configs[1]?.availableTools).not.toContain("builtin:skill");
    expect(configs[1]?.availableTools).not.toContain("custom:skill");
    expect(configs[1]?.toolSearch).toEqual({ enabled: false });

    const result = handler({
      sessionId: "session-2",
      mode: "form",
      message: "Choose the arrangement length.",
      requestedSchema: {
        type: "object",
        properties: {
          bars: {
            type: "integer",
            title: "Bars",
            minimum: 8,
            maximum: 128,
          },
          style: {
            type: "string",
            title: "Style",
            enum: ["compact", "extended"],
          },
        },
        required: ["bars", "style"],
      },
    });
    await flushMicrotasks();
    const requested = [...received]
      .reverse()
      .find((event) => event.type === "agent.elicitation_requested");
    expect(requested).toMatchObject({
      type: "agent.elicitation_requested",
      agentInstanceId: "planner",
      request: {
        message: "Choose the arrangement length.",
        required: ["bars", "style"],
      },
    });
    if (requested?.type !== "agent.elicitation_requested") {
      throw new Error("Expected elicitation request");
    }
    await expect(
      service.resolveManagedAgentElicitation("planner", {
        requestId: requested.request.requestId,
        action: "accept",
        content: { bars: 32, style: "custom" },
      }),
    ).rejects.toThrow("Elicitation field 'style' has an invalid choice");
    await expect(
      service.resolveManagedAgentElicitation("planner", {
        requestId: requested.request.requestId,
        action: "accept",
        content: { bars: 32, style: "compact" },
      }),
    ).resolves.toBe(true);
    await expect(result).resolves.toEqual({
      action: "accept",
      content: { bars: 32, style: "compact" },
    });
    expect(received.at(-1)).toMatchObject({
      type: "agent.elicitation_completed",
      action: "accept",
    });

    const legacyResult = legacyHandler(
      {
        question: "Choose the bass style.",
        choices: ["Minimal", "Syncopated", "Melodic"],
        allowFreeform: false,
      },
      { sessionId: "session-2" },
    );
    await flushMicrotasks();
    const legacyRequested = [...received]
      .reverse()
      .find((event) => event.type === "agent.elicitation_requested");
    expect(legacyRequested).toMatchObject({
      type: "agent.elicitation_requested",
      request: {
        message: "Choose the bass style.",
        properties: {
          answer: {
            type: "string",
            enum: ["Minimal", "Syncopated", "Melodic"],
            allowFreeform: true,
            minLength: 1,
            maxLength: 8_192,
          },
        },
        required: ["answer"],
      },
    });
    if (legacyRequested?.type !== "agent.elicitation_requested") {
      throw new Error("Expected compatibility elicitation request");
    }
    await expect(
      service.resolveManagedAgentElicitation("planner", {
        requestId: legacyRequested.request.requestId,
        action: "accept",
        content: { answer: "Syncopated" },
      }),
    ).resolves.toBe(true);
    await expect(legacyResult).resolves.toEqual({
      answer: "Syncopated",
      wasFreeform: false,
    });

    const freeformResult = legacyHandler(
      {
        question: "Choose another bass style.",
        choices: ["Minimal", "Syncopated", "Melodic"],
        allowFreeform: false,
      },
      { sessionId: "session-2" },
    );
    await flushMicrotasks();
    const freeformRequested = [...received]
      .reverse()
      .find((event) => event.type === "agent.elicitation_requested");
    if (freeformRequested?.type !== "agent.elicitation_requested") {
      throw new Error("Expected freeform compatibility request");
    }
    await expect(
      service.resolveManagedAgentElicitation("planner", {
        requestId: freeformRequested.request.requestId,
        action: "accept",
        content: { answer: "Sparse with octave jumps" },
      }),
    ).resolves.toBe(true);
    await expect(freeformResult).resolves.toEqual({
      answer: "Sparse with octave jumps",
      wasFreeform: true,
    });
    await service.stop();
  });

  it("pauses the active-work timeout until every human gate settles", async () => {
    vi.useFakeTimers();
    const sessionStateDirectory = await mkdtemp(
      join(tmpdir(), "ableton-human-gate-timeout-"),
    );
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    const runtimeEvents: AgentRuntimeEvent[] = [];
    const toolApproval = deferred<boolean>();
    let config: SessionConfig | undefined;
    events.subscribe((event) => received.push(event));
    const managedSession = createFakeSession("managed-session", {
      onSend: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (
          config?.onElicitationRequest === undefined ||
          config.onExitPlanModeRequest === undefined ||
          config.onPermissionRequest === undefined
        ) {
          throw new Error("Expected human-interaction handlers");
        }
        const [question, plan, permission] = await Promise.all([
          config.onElicitationRequest({
            sessionId: "managed-session",
            mode: "form",
            message: "Choose a direction.",
            requestedSchema: {
              type: "object",
              properties: {
                direction: {
                  type: "string",
                  enum: ["A", "B"],
                },
              },
              required: ["direction"],
            },
          }),
          config.onExitPlanModeRequest(
            {
              summary: "Ready",
              planContent: "Ignored",
              actions: ["interactive"],
              recommendedAction: "interactive",
            },
            { sessionId: "managed-session" },
          ),
          config.onPermissionRequest(
            {
              kind: "custom-tool",
              toolName: "ableton_tracks_create",
              toolDescription: "Create a track",
              args: {},
            },
            { sessionId: "managed-session" },
          ),
        ]);
        return {
          data: {
            content: `${question.action}:${plan.approved}:${permission.kind}`,
          },
        };
      },
    });
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(createFakeSession("default-session"))
      .mockImplementationOnce(async (receivedConfig: SessionConfig) => {
        config = receivedConfig;
        return managedSession;
      });
    const service = new CopilotAgentService(
      baseOptions({
        events,
        resolvePlanArtifactPaths: (productionSessionId: string) => {
          const sessionDirectory = join(
            sessionStateDirectory,
            productionSessionId,
          );
          const artifactsDirectory = join(sessionDirectory, "artifacts");
          return {
            sessionDirectory,
            artifactsDirectory,
            planPath: join(artifactsDirectory, "plan.md"),
          };
        },
        turnTimeoutMs: 50,
        requestToolApproval: async () => await toolApproval.promise,
        runtimeObserver: { enqueue: (event) => runtimeEvents.push(event) },
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    try {
      await service.start();
      await service.createManagedAgent(configuration("planner"));
      await service.writeManagedAgentPlan("planner", {
        content: "# Plan\n\nReview the arrangement.",
      });
      const turn = service.sendToManagedAgent("planner", "Prepare the plan");
      await vi.advanceTimersByTimeAsync(20);
      await vi.waitFor(() =>
        expect(
          received.some(
            (event) => event.type === "agent.plan_approval_requested",
          ),
        ).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(
        runtimeEvents.some((event) => event.type === "agent.turn.timeout"),
      ).toBe(false);
      const question = received.find(
        (event) => event.type === "agent.elicitation_requested",
      );
      const plan = received.find(
        (event) => event.type === "agent.plan_approval_requested",
      );
      if (question?.type !== "agent.elicitation_requested") {
        throw new Error("Expected elicitation request");
      }
      if (plan?.type !== "agent.plan_approval_requested") {
        throw new Error("Expected plan request");
      }

      await service.resolveManagedAgentElicitation("planner", {
        requestId: question.request.requestId,
        action: "accept",
        content: { direction: "A" },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        runtimeEvents.some((event) => event.type === "agent.turn.timeout"),
      ).toBe(false);

      toolApproval.resolve(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        runtimeEvents.some((event) => event.type === "agent.turn.timeout"),
      ).toBe(false);

      await service.resolveManagedAgentPlan("planner", {
        requestId: plan.request.requestId,
        approved: true,
        planRevision: plan.request.planRevision,
        selectedAction: "interactive",
      });
      await expect(turn).resolves.toBe("accept:true:approve-once");

      const pauseEvents = runtimeEvents.filter(
        (event) => event.type === "agent.turn.timeout.paused",
      );
      const resumeEvents = runtimeEvents.filter(
        (event) => event.type === "agent.turn.timeout.resumed",
      );
      expect(pauseEvents.map((event) => event.data.reason).sort()).toEqual([
        "elicitation",
        "plan_approval",
        "tool_approval",
      ]);
      expect(
        pauseEvents.map((event) => event.data.pendingHumanGateCount).sort(),
      ).toEqual([1, 2, 3]);
      expect(
        resumeEvents.map((event) => event.data.pendingHumanGateCount).sort(),
      ).toEqual([0, 1, 2]);
      expect(resumeEvents.at(-1)?.data).toMatchObject({
        pendingHumanGateCount: 0,
        timerResumed: true,
        remainingMs: 30,
      });
      expect(
        runtimeEvents.some((event) => event.type === "agent.turn.completed"),
      ).toBe(true);
    } finally {
      await service.stop();
      await rm(sessionStateDirectory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("validates resumed adapters and narrowly classifies missing SDK sessions", async () => {
    const defaultSession = createFakeSession("default");
    const missing = createFakeSession("missing", {
      getEvents: async () => {
        throw new Error(
          "Request session.getMessages failed with message: Session not found for sessionId: missing",
        );
      },
    });

    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession: vi.fn(async () => defaultSession),
          resumeSession: vi.fn(async () => missing),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();

    const error = await service
      .resumeManagedAgent(configuration("managed"), "missing")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MissingCopilotSessionError);
    expect(isMissingCopilotSessionError(error)).toBe(true);
    expect(missing.disconnect).toHaveBeenCalledOnce();
    expect(
      isMissingCopilotSessionError(
        new Error("Request timed out while finding a session"),
      ),
    ).toBe(false);
    expect(
      isMissingCopilotSessionError(
        new Error("Session not found for sessionId: missing"),
      ),
    ).toBe(false);
    await service.stop();
  });

  it("validates a real resumed adapter before committing it", async () => {
    const defaultSession = createFakeSession("default");
    const resumed = createFakeSession("resumed", { history: [] });
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession: vi.fn(async () => defaultSession),
          resumeSession: vi.fn(async () => resumed),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.resumeManagedAgent(configuration("managed"), "resumed");
    expect(resumed.getEvents).toHaveBeenCalledOnce();
    expect(service.getManagedAgentSessionId("managed")).toBe("resumed");
    await service.stop();
  });

  it("keeps the prior managed session usable when validation or SDK creation fails", async () => {
    const history = [
      userMessage("old-user", "Original prompt", "2026-08-08T00:00:00.000Z"),
    ];
    const defaultSession = createFakeSession("default-session");
    const oldSession = createFakeSession("old-sdk", { history });
    let rejectCreate = false;
    const createSession = vi.fn(async () => {
      if (rejectCreate) throw new Error("create failed");
      return createSession.mock.calls.length === 1
        ? defaultSession
        : oldSession;
    });
    const resumeSession = vi.fn(async () => {
      throw new Error("resume not expected");
    });
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession,
          resumeSession,
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(configuration("managed"));

    await expect(
      service.reconfigureManagedAgent(
        configuration("managed", {
          skills: ["missing-skill"],
          availableSkills: [],
        }),
      ),
    ).rejects.toThrow("missing-skill");
    expect(resumeSession).not.toHaveBeenCalled();

    rejectCreate = true;
    await expect(
      service.createManagedAgent(
        configuration("managed", { definitionName: "replacement" }),
      ),
    ).rejects.toThrow("create failed");

    expect(service.getManagedAgentSessionId("managed")).toBe("old-sdk");
    await expect(
      service.getManagedAgentHistory("managed"),
    ).resolves.toMatchObject([
      {
        content: "Original prompt",
        agentInstanceId: "managed",
        sdkSessionId: "old-sdk",
      },
    ]);
    await expect(
      service.sendToManagedAgent("managed", "after failures"),
    ).resolves.toBe("reply:old-sdk:after failures");
    expect(oldSession.disconnect).not.toHaveBeenCalled();
    await service.stop();
  });

  it("keeps prior mapping, history, attribution, and prompts when SDK resume fails", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const defaultSession = createFakeSession("default-session");
    const oldSession = createFakeSession("old-sdk", {
      history: [
        assistantMessage(
          "old-assistant",
          "old-message",
          "Original answer",
          "2026-08-08T00:00:00.000Z",
        ),
      ],
    });
    const createSession = vi.fn(async () =>
      createSession.mock.calls.length === 1 ? defaultSession : oldSession,
    );
    const service = new CopilotAgentService(
      baseOptions({
        events,
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("resume failed");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(configuration("managed"));
    await expect(
      service.reconfigureManagedAgent(
        configuration("managed", { definitionName: "replacement" }),
      ),
    ).rejects.toThrow("resume failed");

    oldSession.emit(assistantDelta("still-old"));
    expect(received).toContainEqual({
      type: "agent.message_delta",
      content: "still-old",
      agentInstanceId: "managed",
      sdkSessionId: "old-sdk",
    });
    await expect(
      service.getManagedAgentHistory("managed"),
    ).resolves.toMatchObject([
      {
        content: "Original answer",
        agentInstanceId: "managed",
        sdkSessionId: "old-sdk",
      },
    ]);
    await expect(
      service.sendToManagedAgent("managed", "after resume failure"),
    ).resolves.toBe("reply:old-sdk:after resume failure");
    expect(oldSession.disconnect).not.toHaveBeenCalled();
    await service.stop();
  });

  it("cleans up a replacement whose event hookup fails and restores the old agent", async () => {
    const defaultSession = createFakeSession("default-session");
    const oldSession = createFakeSession("old-sdk");
    const replacement = {
      ...createFakeSession("old-sdk"),
      on: vi.fn(() => {
        throw new Error("event hookup failed");
      }),
    };
    const createSession = vi.fn(async () =>
      createSession.mock.calls.length === 1 ? defaultSession : oldSession,
    );
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => replacement),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(configuration("managed"));
    await expect(
      service.reconfigureManagedAgent(
        configuration("managed", { definitionName: "replacement" }),
      ),
    ).rejects.toThrow("event hookup failed");

    expect(replacement.disconnect).toHaveBeenCalledOnce();
    expect(oldSession.disconnect).not.toHaveBeenCalled();
    expect(service.getManagedAgentSessionId("managed")).toBe("old-sdk");
    await expect(
      service.sendToManagedAgent("managed", "after hookup failure"),
    ).resolves.toBe("reply:old-sdk:after hookup failure");
    await service.stop();
  });

  it("serializes concurrent reconfigurations and leaves only the final replacement owning the instance", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const defaultSession = createFakeSession("default-session");
    const originalSession = createFakeSession("managed-sdk");
    const firstReplacement = createFakeSession("managed-sdk");
    const hold = deferred<void>();
    const secondReplacement = createFakeSession("managed-sdk", {
      history: [
        assistantMessage(
          "final-history",
          "final-message",
          "Final history",
          "2026-08-08T00:00:00.000Z",
        ),
      ],
      onSend: async (prompt) => {
        if (prompt === "hold") await hold.promise;
        return { data: { content: `final:${prompt}` } };
      },
      abort: async () => hold.resolve(),
    });
    const firstResume = deferred<void>();
    const secondResume = deferred<void>();
    const resumeConfigs: ResumeSessionConfig[] = [];
    const createSession = vi.fn(async () =>
      createSession.mock.calls.length === 1 ? defaultSession : originalSession,
    );
    const resumeSession = vi.fn(
      async (_sessionId: string, config: ResumeSessionConfig) => {
        resumeConfigs.push(config);
        const call = resumeSession.mock.calls.length;
        if (call === 1) {
          await firstResume.promise;
          return firstReplacement;
        }
        await secondResume.promise;
        return secondReplacement;
      },
    );
    const service = new CopilotAgentService(
      baseOptions({
        events,
        clientFactory: () => ({
          createSession,
          resumeSession,
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(configuration("managed"));
    const first = service.reconfigureManagedAgent(
      configuration("managed", {
        definitionName: "first",
        systemPrompt: "First prompt",
      }),
    );
    const second = service.reconfigureManagedAgent(
      configuration("managed", {
        definitionName: "second",
        systemPrompt: "Second prompt",
      }),
    );

    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledOnce();
    firstResume.resolve();
    await flushMicrotasks();
    expect(resumeSession).toHaveBeenCalledTimes(2);
    expect(originalSession.disconnect).toHaveBeenCalledOnce();
    secondResume.resolve();
    await Promise.all([first, second]);

    expect(resumeConfigs.map(({ agent }) => agent)).toEqual([
      "first",
      "second",
    ]);
    expect(firstReplacement.disconnect).toHaveBeenCalledOnce();
    expect(secondReplacement.disconnect).not.toHaveBeenCalled();
    expect(service.getManagedAgentSessionId("managed")).toBe("managed-sdk");

    received.length = 0;
    firstReplacement.emit(assistantDelta("stale"));
    secondReplacement.emit(assistantDelta("current"));
    expect(received).toEqual([
      {
        type: "agent.message_delta",
        content: "current",
        agentInstanceId: "managed",
        sdkSessionId: "managed-sdk",
      },
    ]);

    const automatic = {
      deliveryId: "final-delivery",
      context: {
        assignmentId: "final-assignment",
        producerId: "producer",
        consumer: { kind: "agent-instance", id: "managed" },
        deliveryMode: "automatic-analysis",
        sequence: 1,
        capturedAt: 1_750_000_000_000,
        sourceIdentity: "Producer",
        content: "Final signal",
      },
      usageInstruction: "Analyze it.",
    } satisfies SignalTurnRequest;
    await expect(service.enqueueSignalTurn(automatic)).resolves.toContain(
      "final:[Internal signal event",
    );
    expect(firstReplacement.prompts).toHaveLength(0);
    expect(secondReplacement.prompts.at(-1)).toContain("Internal signal event");

    await expect(
      service.sendToManagedAgent("managed", "after race"),
    ).resolves.toBe("final:after race");
    await expect(service.getManagedAgentHistory("managed")).resolves.toEqual([
      {
        role: "assistant",
        content: "Final history",
        timestamp: "2026-08-08T00:00:00.000Z",
        eventId: "final-history",
        messageId: "final-message",
        agentInstanceId: "managed",
        sdkSessionId: "managed-sdk",
      },
    ]);
    const pending = service.sendToManagedAgent("managed", "hold");
    await flushMicrotasks();
    await expect(service.cancelManagedAgent("managed")).resolves.toBe(true);
    await expect(pending).resolves.toBe("final:hold");
    await service.stop();
  });

  it("orders deactivation after an in-progress reconfiguration", async () => {
    const defaultSession = createFakeSession("default-session");
    const originalSession = createFakeSession("managed-sdk");
    const replacement = createFakeSession("managed-sdk");
    const resume = deferred<void>();
    const createSession = vi.fn(async () =>
      createSession.mock.calls.length === 1 ? defaultSession : originalSession,
    );
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            await resume.promise;
            return replacement;
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(configuration("managed"));
    const reconfigure = service.reconfigureManagedAgent(
      configuration("managed", { definitionName: "replacement" }),
    );
    const deactivate = service.deactivateManagedAgent("managed");
    await flushMicrotasks();
    expect(originalSession.disconnect).not.toHaveBeenCalled();

    resume.resolve();
    await Promise.all([reconfigure, deactivate]);
    expect(originalSession.disconnect).toHaveBeenCalledOnce();
    expect(replacement.disconnect).toHaveBeenCalledOnce();
    expect(service.getManagedAgentSessionId("managed")).toBeUndefined();
    expect(() =>
      service.sendToManagedAgent("managed", "after deactivate"),
    ).toThrow("not active");
    await service.stop();
  });

  it("enforces each managed agent's edit scope at the SDK tool execution boundary", async () => {
    let projectId = "project-1";
    let snapshot = {
      ...emptySnapshot,
      trackCount: 2,
      tracks: [
        {
          index: 0,
          reference: trackAReference,
          name: "Track A",
          kind: "midi" as const,
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.8,
          pan: 0,
        },
        {
          index: 1,
          reference: trackBReference,
          name: "Track B",
          kind: "midi" as const,
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.8,
          pan: 0,
        },
      ],
    };
    const renameTrack = vi.fn(
      async (params: {
        expectedReference: string;
        index: number;
        expectedName: string;
        name: string;
      }) => ({
        reference: params.expectedReference,
        index: params.index,
        beforeName: params.expectedName,
        afterName: params.name,
        verified: true as const,
      }),
    );
    const createTrack = vi.fn(async () => {
      throw new Error("global mutation should not reach Ableton");
    });
    const configs: SessionConfig[] = [];
    const requestToolApproval = vi.fn(async () => true);
    const createSession = vi.fn(async (config: SessionConfig) => {
      configs.push(config);
      return createFakeSession(`session-${configs.length}`);
    });
    const service = new CopilotAgentService(
      baseOptions({
        getAbletonStatus: async () =>
          ({
            state: "connected",
            liveSetId: projectId,
            liveSetName: "Test Set",
            saved: true,
          }) as never,
        inspectSession: async () => snapshot,
        renameTrack,
        createTrack,
        requestToolApproval,
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(
      configuration("track-a", {
        resolvedTools: [
          "ableton_session_inspect",
          "ableton_tracks_rename",
          "ableton_tracks_create",
        ],
        editScope: [{ track: { name: "Track A", occurrence: 0 } }],
        boundTracks: [
          {
            selector: { track: { name: "Track A", occurrence: 0 } },
            projectId: "project-1",
            trackReference: trackAReference,
            trackIndex: 0,
            expectedName: "Track A",
          },
        ],
      }),
    );
    const scopedTools = configs[1]?.tools ?? [];
    const inspect = scopedTools.find(
      ({ name }) => name === "ableton_session_inspect",
    )!;
    const rename = scopedTools.find(
      ({ name }) => name === "ableton_tracks_rename",
    )!;
    const create = scopedTools.find(
      ({ name }) => name === "ableton_tracks_create",
    )!;
    const invocation = {
      sessionId: "session-2",
      toolCallId: "tool-1",
      toolName: "",
      arguments: {},
    };

    await expect(inspect.handler?.({}, invocation)).resolves.toEqual(snapshot);
    await expect(
      configs[1]?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolName: "ableton_tracks_rename",
          toolDescription: "Rename track",
          args: {
            index: 0,
            expectedReference: trackAReference,
            expectedName: "Track A",
            name: "Track A renamed",
          },
        },
        { sessionId: "session-2" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    expect(requestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({ agentInstanceId: "track-a" }),
    );
    requestToolApproval.mockClear();
    await expect(
      rename.handler?.(
        {
          index: 0,
          expectedReference: trackAReference,
          expectedName: "Track A",
          name: "Track A renamed",
        },
        invocation,
      ),
    ).resolves.toMatchObject({ reference: trackAReference, verified: true });
    await expect(
      rename.handler?.(
        {
          index: 1,
          expectedReference: trackBReference,
          expectedName: "Track B",
          name: "Forbidden",
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "track_scope_required" });
    expect(requestToolApproval).not.toHaveBeenCalled();
    await expect(
      create.handler?.({ kind: "midi", name: "Forbidden" }, invocation),
    ).rejects.toMatchObject({ code: "session_scope_required" });

    projectId = "project-2";
    await expect(
      rename.handler?.(
        {
          index: 0,
          expectedReference: trackAReference,
          expectedName: "Track A",
          name: "Cross-project",
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "binding_cross_project" });
    projectId = "project-1";
    snapshot = {
      ...snapshot,
      tracks: snapshot.tracks.map((track) =>
        track.index === 0 ? { ...track, name: "Externally renamed" } : track,
      ),
    };
    await expect(
      rename.handler?.(
        {
          index: 0,
          expectedReference: trackAReference,
          expectedName: "Track A",
          name: "Stale",
        },
        invocation,
      ),
    ).rejects.toMatchObject({ code: "binding_stale" });
    expect(renameTrack).toHaveBeenCalledOnce();
    expect(createTrack).not.toHaveBeenCalled();
    await service.stop();
  });

  it("shares overlap-aware mutation locks across active agent instances", async () => {
    const snapshot = {
      ...emptySnapshot,
      trackCount: 2,
      tracks: [
        {
          index: 0,
          reference: trackAReference,
          name: "Track A",
          kind: "midi" as const,
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.8,
          pan: 0,
        },
        {
          index: 1,
          reference: trackBReference,
          name: "Track B",
          kind: "midi" as const,
          color: null,
          isMuted: false,
          isSoloed: false,
          isArmed: false,
          volume: 0.8,
          pan: 0,
        },
      ],
    };
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const renameTrack = vi.fn(
      async (params: {
        expectedReference: string;
        index: number;
        expectedName: string;
        name: string;
      }) => {
        started.push(params.expectedReference);
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          reference: params.expectedReference,
          index: params.index,
          beforeName: params.expectedName,
          afterName: params.name,
          verified: true as const,
        };
      },
    );
    let releaseGlobal!: () => void;
    const createTrack = vi.fn(async () => {
      started.push("session");
      await new Promise<void>((resolve) => {
        releaseGlobal = resolve;
      });
      return {
        beforeTrackCount: 2,
        afterTrackCount: 3,
        track: {
          index: 2,
          reference: "00000000-0000-4000-8000-000000000003",
          name: "New",
          kind: "midi" as const,
        },
        verified: true,
      };
    });
    const configs: SessionConfig[] = [];
    const service = new CopilotAgentService(
      baseOptions({
        getAbletonStatus: async () =>
          ({
            state: "connected",
            liveSetId: "project-1",
            liveSetName: "Test Set",
            saved: true,
          }) as never,
        inspectSession: async () => snapshot,
        renameTrack,
        createTrack,
        clientFactory: () => ({
          createSession: vi.fn(async (config: SessionConfig) => {
            configs.push(config);
            return createFakeSession(`session-${configs.length}`);
          }),
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    const scopedConfiguration = (
      instanceId: string,
      name: string,
      trackReference: string,
      trackIndex: number,
    ) =>
      configuration(instanceId, {
        resolvedTools: ["ableton_tracks_rename"],
        editScope: [{ track: { name, occurrence: 0 } }],
        boundTracks: [
          {
            selector: { track: { name, occurrence: 0 } },
            projectId: "project-1",
            trackReference,
            trackIndex,
            expectedName: name,
          },
        ],
      });

    await service.start();
    await service.createManagedAgent(
      scopedConfiguration("agent-a", "Track A", trackAReference, 0),
    );
    await service.createManagedAgent(
      scopedConfiguration("agent-b", "Track B", trackBReference, 1),
    );
    const renameA = configs[1]?.tools?.find(
      ({ name }) => name === "ableton_tracks_rename",
    )?.handler;
    const renameB = configs[2]?.tools?.find(
      ({ name }) => name === "ableton_tracks_rename",
    )?.handler;
    const create = configs[0]?.tools?.find(
      ({ name }) => name === "ableton_tracks_create",
    )?.handler;
    const invocation = {
      sessionId: "session",
      toolCallId: "tool",
      toolName: "",
      arguments: {},
    };
    const renameArgs = (
      index: number,
      expectedReference: string,
      expectedName: string,
    ) => ({
      index,
      expectedReference,
      expectedName,
      name: `${expectedName} renamed`,
    });

    const firstA = renameA?.(
      renameArgs(0, trackAReference, "Track A"),
      invocation,
    );
    const firstB = renameB?.(
      renameArgs(1, trackBReference, "Track B"),
      invocation,
    );
    await vi.waitFor(() =>
      expect(started).toEqual([trackAReference, trackBReference]),
    );

    const secondA = renameA?.(
      renameArgs(0, trackAReference, "Track A"),
      invocation,
    );
    const global = create?.({ kind: "midi", name: "New" }, invocation);
    await flushMicrotasks();
    expect(started).toEqual([trackAReference, trackBReference]);

    releases[1]?.();
    await firstB;
    expect(started).toEqual([trackAReference, trackBReference]);
    releases[0]?.();
    await firstA;
    await vi.waitFor(() =>
      expect(started).toEqual([trackAReference, trackBReference, "session"]),
    );
    releaseGlobal();
    await global;
    await vi.waitFor(() =>
      expect(started).toEqual([
        trackAReference,
        trackBReference,
        "session",
        trackAReference,
      ]),
    );
    releases[2]?.();
    await secondA;
    await service.stop();
  });

  it("isolates model-selected skills while allowing catalog-wide direct invocation", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const root = await mkdtemp(join(tmpdir(), "ableton-agent-skills-"));
    const midiSkill = await createSkillDescriptor(
      root,
      "midi-compose",
      "# MIDI compose\n\nKeep phrases playable.",
    );
    const mixSkill = await createSkillDescriptor(
      root,
      "mix-review",
      "# Mix review\n\nPreserve dynamics.",
    );
    const availableSkills = [midiSkill, mixSkill];
    const resolveSkill = async (_productionSessionId: string, name: string) => {
      const descriptor = availableSkills.find((skill) => skill.name === name);
      if (descriptor === undefined) return undefined;
      const document = await readSkillDocument(
        descriptor.sourcePath,
        descriptor.name,
      );
      return { ...descriptor, fingerprint: document.fingerprint };
    };
    const defaultSession = createFakeSession("default-session");
    const midiHistory: SessionEvent[] = [];
    const midiSession = createFakeSession("midi-session", {
      history: midiHistory,
    });
    const mixSession = createFakeSession("mix-session");
    const createSession = vi.fn(async (config: SessionConfig) => {
      void config;
      const next = [defaultSession, midiSession, mixSession][
        createSession.mock.calls.length - 1
      ];
      if (next === undefined) throw new Error("unexpected createSession call");
      return next;
    });
    const service = new CopilotAgentService(
      baseOptions({
        events,
        resolveSkill,
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(
      configuration("midi-agent", {
        skills: ["midi-compose"],
        availableSkills,
      }),
    );
    await service.createManagedAgent(
      configuration("mix-agent", {
        skills: ["mix-review"],
        availableSkills,
      }),
    );

    const midiConfig = createSession.mock.calls[1]?.[0];
    const mixConfig = createSession.mock.calls[2]?.[0];
    expect(midiConfig?.customAgents?.[0]).not.toHaveProperty("skills");
    expect(midiConfig).not.toHaveProperty("skillDirectories");
    expect(mixConfig?.customAgents?.[0]).not.toHaveProperty("skills");
    expect(mixConfig).not.toHaveProperty("skillDirectories");
    expect(midiConfig?.systemMessage?.content).toContain("name: midi-compose");
    expect(midiConfig?.systemMessage?.content).not.toContain(
      "Active plan-mode reminder",
    );
    expect(midiConfig?.systemMessage?.content).not.toContain(
      "Keep phrases playable.",
    );
    expect(mixConfig?.systemMessage?.content).toContain("name: mix-review");
    expect(mixConfig?.systemMessage?.content).not.toContain(
      "Active plan-mode reminder",
    );
    expect(mixConfig?.systemMessage?.content).not.toContain(
      "Preserve dynamics.",
    );
    expect(midiConfig?.availableTools).toContain("custom:skill");
    const midiSkillTool = midiConfig?.tools?.find(
      (tool) => tool.name === "skill",
    );
    await expect(
      midiSkillTool?.handler?.(
        { skill_name: "midi-compose" },
        {
          sessionId: "midi-session",
          toolCallId: "skill-call-1",
          toolName: "skill",
          arguments: { skill_name: "midi-compose" },
        },
      ),
    ).resolves.toContain("Keep phrases playable.");
    await expect(
      midiSkillTool?.handler?.(
        { skill_name: "mix-review" },
        {
          sessionId: "midi-session",
          toolCallId: "skill-call-2",
          toolName: "skill",
          arguments: { skill_name: "mix-review" },
        },
      ),
    ).rejects.toThrow("not enabled");
    await expect(
      midiConfig?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolName: "skill",
          toolDescription: "Load a skill",
          args: { skill_name: "midi-compose" },
        },
        { sessionId: "midi-session" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    midiSession.emit(toolStart("skill-load", "skill"));
    midiSession.emit({
      type: "tool.execution_complete",
      id: "complete-skill-load",
      parentId: null,
      timestamp: "2026-08-08T00:00:03.000Z",
      data: {
        toolCallId: "skill-load",
        success: true,
        result: { content: "Keep phrases playable." },
      },
    });
    const completedSkillLoad = received.find(
      (event) =>
        event.type === "operation.completed" &&
        event.operationId === "skill-load",
    );
    expect(completedSkillLoad).toMatchObject({
      type: "operation.completed",
      operationId: "skill-load",
    });
    expect(completedSkillLoad).not.toHaveProperty("result");

    await expect(
      service.invokeManagedAgentSkill(
        "midi-agent",
        "/midi-compose keep the pickup notes and syncopation",
      ),
    ).resolves.toContain("keep the pickup notes and syncopation");
    await expect(
      service.sendToManagedAgent("mix-agent", "/mix-review preserve dynamics"),
    ).resolves.toContain("preserve dynamics");
    await expect(
      service.invokeManagedAgentSkill("mix-agent", "/mix-review"),
    ).resolves.toContain("Follow these skill instructions for this turn.");
    await expect(
      service.sendToManagedAgent("midi-agent", "Write a legacy prompt"),
    ).resolves.toBe("reply:midi-session:Write a legacy prompt");

    expect(midiSession.prompts[0]).toContain("Keep phrases playable.");
    expect(midiSession.prompts[0]).toContain(
      "keep the pickup notes and syncopation",
    );
    expect(midiSession.prompts[1]).toBe("Write a legacy prompt");
    expect(mixSession.prompts[0]).toContain("Preserve dynamics.");
    expect(mixSession.prompts[0]).toContain("preserve dynamics");
    expect(mixSession.prompts[1]).toContain(
      "Follow these skill instructions for this turn.",
    );
    await expect(
      service.invokeManagedAgentSkill("midi-agent", "/mix-review rebalance"),
    ).resolves.toContain("rebalance");
    expect(midiSession.prompts[2]).toContain("Preserve dynamics.");
    await expect(
      service.invokeManagedAgentSkill(
        "midi-agent",
        "/midi-compose draft the arrangement",
        "plan",
      ),
    ).resolves.toContain("draft the arrangement");
    const planSkillPrompt = midiSession.prompts[3]!;
    expect(planSkillPrompt.indexOf("Keep phrases playable.")).toBeLessThan(
      planSkillPrompt.indexOf("draft the arrangement"),
    );
    expect(planSkillPrompt.indexOf("draft the arrangement")).toBeLessThan(
      planSkillPrompt.indexOf(PLAN_REMINDER),
    );
    expect(planSkillPrompt.endsWith(PLAN_REMINDER)).toBe(true);
    expect(midiSession.messages[3]).toMatchObject({ agentMode: "plan" });
    await expect(
      service.invokeManagedAgentSkill("midi-agent", "/unknown-skill request"),
    ).rejects.toThrow("Unknown skill '/unknown-skill'.");
    await expect(
      service.sendToManagedAgent("midi-agent", "/Not-A-Skill request"),
    ).rejects.toThrow("Invalid skill invocation");
    expect(midiSession.prompts).toHaveLength(4);
    midiHistory.push(
      userMessage(
        "direct-skill-user",
        midiSession.prompts[0]!,
        "2026-08-08T00:00:00.000Z",
      ),
    );
    await expect(service.getManagedAgentHistory("midi-agent")).resolves.toEqual(
      [
        expect.objectContaining({
          role: "user",
          content: "/midi-compose keep the pickup notes and syncopation",
        }),
      ],
    );

    await writeFile(
      midiSkill.sourcePath,
      "---\nname: midi-compose\ndescription: Changed.\n---\n\n# Changed",
    );
    await expect(
      midiSkillTool?.handler?.(
        { skill_name: "midi-compose" },
        {
          sessionId: "midi-session",
          toolCallId: "skill-call-3",
          toolName: "skill",
          arguments: { skill_name: "midi-compose" },
        },
      ),
    ).resolves.toContain("# Changed");
    await expect(
      service.invokeManagedAgentSkill(
        "midi-agent",
        "/midi-compose use the revised instructions",
      ),
    ).resolves.toContain("use the revised instructions");
    expect(midiSession.prompts.at(-1)).toContain("# Changed");

    await service.stop();
  });

  it("attributes managed-agent approval requests to the originating instance and SDK session", async () => {
    const configs: SessionConfig[] = [];
    const requestToolApproval = vi.fn(async () => true);
    const service = new CopilotAgentService(
      baseOptions({
        requestToolApproval,
        clientFactory: () => ({
          createSession: vi.fn(async (config: SessionConfig) => {
            configs.push(config);
            return createFakeSession(`session-${configs.length}`);
          }),
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(configuration("managed-agent"));

    await expect(
      configs[1]?.onPermissionRequest?.(
        {
          kind: "custom-tool",
          toolName: "ableton_tracks_create",
          toolDescription: "Create track",
          args: { kind: "midi" },
        },
        { sessionId: "session-2" },
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    expect(requestToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: "managed-agent",
        sdkSessionId: "session-2",
      }),
    );
    await service.stop();
  });

  it("serializes turns per agent instance while allowing cross-session concurrency", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));

    let releaseFirstA: (() => void) | undefined;
    let activeA = 0;
    let activeB = 0;
    let maxActiveA = 0;
    let maxActiveB = 0;
    let activeTotal = 0;
    let maxActiveTotal = 0;

    const defaultSession = createFakeSession("default-session");
    const sessionA = createFakeSession("session-a", {
      history: [
        userMessage("user-1", "Shape the bass", "2026-08-08T00:00:00.000Z"),
        userMessage(
          "automatic-1",
          '<live-event-trigger delivery-id="delivery-1" occurrence-id="occurrence-1">\nQueued pattern1\n</live-event-trigger>',
          "2026-08-08T00:00:02.000Z",
        ),
        assistantMessage(
          "assistant-1",
          "message-1",
          "Done shaping the bass",
          "2026-08-08T00:00:04.000Z",
        ),
      ],
      onSend: async (prompt, emit) => {
        activeA += 1;
        activeTotal += 1;
        maxActiveA = Math.max(maxActiveA, activeA);
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
        try {
          emit(assistantDelta(`delta:${prompt}`));
          emit(toolStart(`tool-${prompt}`, "ableton_session_inspect"));
          emit(toolComplete(`tool-${prompt}`));
          if (prompt === "A1") {
            await new Promise<void>((resolve) => {
              releaseFirstA = resolve;
            });
          }
          return { data: { content: `A:${prompt}` } };
        } finally {
          activeA -= 1;
          activeTotal -= 1;
        }
      },
    });
    const sessionB = createFakeSession("session-b", {
      onSend: async (prompt) => {
        activeB += 1;
        activeTotal += 1;
        maxActiveB = Math.max(maxActiveB, activeB);
        maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          return { data: { content: `B:${prompt}` } };
        } finally {
          activeB -= 1;
          activeTotal -= 1;
        }
      },
    });

    const createSession = vi.fn(async (config: SessionConfig) => {
      void config;
      const next = [defaultSession, sessionA, sessionB][
        createSession.mock.calls.length - 1
      ];
      if (next === undefined) throw new Error("unexpected createSession call");
      return next;
    });
    const service = new CopilotAgentService(
      baseOptions({
        events,
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("resume not expected");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );

    await service.start();
    await service.createManagedAgent(configuration("agent-a"));
    await service.createManagedAgent(configuration("agent-b"));

    const firstA = service.sendToManagedAgent("agent-a", "A1");
    const secondA = service.sendToManagedAgent("agent-a", "A2");
    await vi.waitFor(() => expect(releaseFirstA).toBeDefined());
    const firstB = service.sendToManagedAgent("agent-b", "B1");
    await vi.waitFor(() => expect(maxActiveTotal).toBe(2));
    releaseFirstA!();

    await expect(Promise.all([firstA, secondA, firstB])).resolves.toEqual([
      "A:A1",
      "A:A2",
      "B:B1",
    ]);

    expect(maxActiveA).toBe(1);
    expect(maxActiveB).toBe(1);
    expect(maxActiveTotal).toBe(2);
    expect(sessionA.prompts).toEqual(["A1", "A2"]);
    expect(sessionB.prompts).toEqual(["B1"]);
    await expect(service.getManagedAgentHistory("agent-a")).resolves.toEqual([
      {
        role: "user",
        content: "Shape the bass",
        timestamp: "2026-08-08T00:00:00.000Z",
        eventId: "user-1",
        agentInstanceId: "agent-a",
        sdkSessionId: "session-a",
      },
      {
        role: "assistant",
        content: "Done shaping the bass",
        timestamp: "2026-08-08T00:00:04.000Z",
        eventId: "assistant-1",
        messageId: "message-1",
        agentInstanceId: "agent-a",
        sdkSessionId: "session-a",
      },
    ]);
    expect(received).toContainEqual({
      type: "agent.message_delta",
      content: "delta:A1",
      agentInstanceId: "agent-a",
      sdkSessionId: "session-a",
    });
    expect(received).toContainEqual({
      type: "operation.started",
      operationId: "tool-A1",
      label: "Inspect Ableton session",
      toolName: "ableton_session_inspect",
      arguments: {},
      agentInstanceId: "agent-a",
      sdkSessionId: "session-a",
    });
    expect(received).toContainEqual({
      type: "operation.completed",
      operationId: "tool-A1",
      summary: "Inspect Ableton session completed",
      toolName: "ableton_session_inspect",
      agentInstanceId: "agent-a",
      sdkSessionId: "session-a",
    });

    await service.stop();
  });

  it("routes signals by instance, preserves the legacy facade, and cold-reconfigures the same SDK session", async () => {
    const markDelivered = vi.fn(async () => undefined);
    let releaseManaged!: () => void;
    const blockedTurn = new Promise<void>((resolve) => {
      releaseManaged = resolve;
    });

    const defaultSession = createFakeSession("legacy-session", {
      onSend: async (prompt) => ({ data: { content: `legacy:${prompt}` } }),
    });
    let managedConfig: SessionConfig | undefined;
    const submittedContexts: string[] = [];
    const managedSession = createFakeSession("managed-session", {
      abort: async () => {
        releaseManaged();
      },
      onSend: async (prompt) => {
        const submitted = await managedConfig?.hooks?.onUserPromptSubmitted?.(
          {
            sessionId: "managed-session",
            timestamp: new Date(),
            workingDirectory: "/tmp",
            prompt,
          },
          { sessionId: "managed-session" },
        );
        submittedContexts.push(submitted?.additionalContext ?? "");
        if (prompt === "hold") {
          await blockedTurn;
          return undefined;
        }
        return { data: { content: `managed:${prompt}` } };
      },
    });
    const reconfiguredSession = createFakeSession("managed-session", {
      onSend: async (prompt) => ({
        data: { content: `reconfigured:${prompt}` },
      }),
    });

    let latestResumeConfig: ResumeSessionConfig | undefined;
    const stop = vi.fn(async () => undefined);
    const createSession = vi.fn(async (config: SessionConfig) => {
      const next = [defaultSession, managedSession][
        createSession.mock.calls.length - 1
      ];
      if (next === undefined) throw new Error("unexpected createSession call");
      if (next === managedSession) managedConfig = config;
      return next;
    });
    const resumeSession = vi.fn(
      async (sessionId: string, config: ResumeSessionConfig) => {
        latestResumeConfig = config;
        expect(sessionId).toBe("managed-session");
        return reconfiguredSession;
      },
    );
    const runtimeEvents: AgentRuntimeEvent[] = [];
    const getPreparedContext = vi.fn(
      (agentInstanceId: string, listener?: AgentEventListener) =>
        [
          `prepared:${agentInstanceId}:${listener?.id ?? "default"}`,
          '{"projectRevision":7,"freshness":"stale","identityPolicy":"guarded-exact-reference"}',
        ].join("\n"),
    );
    const service = new CopilotAgentService(
      baseOptions({
        runtimeObserver: {
          enqueue: (event) => runtimeEvents.push(event),
        },
        signalContext: {
          provider: {
            getPendingContexts: async () => [],
            markDelivered,
          },
        },
        preparedContextProvider: { getPreparedContext },
        clientFactory: () => ({
          createSession,
          resumeSession,
          stop,
        }),
      }),
    );

    await service.start();
    expect(service.sessionId).toBe("legacy-session");
    await expect(service.send("legacy")).resolves.toBe("legacy:legacy");

    const initial = configuration("managed", {
      label: "Managed Agent",
      description: "Initial managed session",
      systemPrompt: "Initial managed prompt",
      resolvedTools: ["ableton_session_inspect"],
    });
    await expect(service.createManagedAgent(initial)).resolves.toBe(
      "managed-session",
    );
    expect(service.getManagedAgentSessionId("managed")).toBe("managed-session");

    const pendingTurn = service.sendToManagedAgent("managed", "hold");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.cancelManagedAgent("managed")).resolves.toBe(true);
    await expect(service.cancel()).resolves.toBe(false);
    await expect(pendingTurn).rejects.toThrow("without an assistant response");

    const automatic = {
      deliveryId: "delivery-1",
      context: {
        assignmentId: "assignment-1",
        producerId: "producer-1",
        consumer: { kind: "agent-instance", id: "managed" },
        deliveryMode: "automatic-action",
        sequence: 1,
        capturedAt: 1_750_000_000_000,
        sourceIdentity: "Producer [managed]",
        content: "Kick on beat one",
      },
      usageInstruction: "Apply the observation safely.",
    } satisfies SignalTurnRequest;
    await expect(service.enqueueSignalTurn(automatic)).resolves.toContain(
      "Internal signal event",
    );
    expect(markDelivered).toHaveBeenCalledWith("managed", ["delivery-1"]);
    expect(managedSession.prompts.at(-1)).toContain("Internal signal event");

    const liveEventTurn = {
      deliveryId: "live-delivery-1",
      agentInstanceId: "managed",
      listener: {
        id: "event-listener.00000000-0000-4000-8000-000000000001",
        eventId: "live-event.00000000-0000-4000-8000-000000000001",
        enabled: true,
        responseMode: "automatic",
        messagePrefix: "Check the launch.",
      },
      occurrence: {
        occurrenceId: "00000000-0000-4000-8000-000000000003",
        eventId: "live-event.00000000-0000-4000-8000-000000000001",
        kind: "track.playing_clip_changed",
        sequence: 3,
        projectRevision: 8,
        observedAt: "2026-08-29T18:00:03.000Z",
        target: {
          trackReference: trackAReference,
          track: { name: "Keys" },
        },
        summary: "Keys started clip 1.",
        current: { state: "session-clip", slotIndex: 0 },
      },
    } satisfies LiveEventTurnRequest;
    await expect(
      service.enqueueLiveEventTurn(liveEventTurn),
    ).resolves.toContain('"slotIndex": 0');
    expect(managedSession.prompts.at(-1)).toContain(
      'Check the launch.\n{\n  "occurrenceId"',
    );
    expect(managedSession.prompts.at(-1)).not.toContain("Internal Live event");
    expect(managedSession.prompts.at(-1)).not.toContain(
      '"identityPolicy":"guarded-exact-reference"',
    );
    expect(getPreparedContext).toHaveBeenCalledWith(
      "managed",
      liveEventTurn.listener,
    );
    expect(submittedContexts.at(-1)).toContain(
      AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE,
    );
    expect(
      submittedContexts
        .slice(0, -1)
        .every(
          (context) =>
            !context.includes(AUTOMATIC_LIVE_EVENT_IDENTITY_GUIDANCE),
        ),
    ).toBe(true);
    const outputTurn = runtimeEvents.find(
      (event) =>
        event.type === "agent.turn.started" &&
        event.data.origin === "output.automatic",
    );
    expect(outputTurn?.trace).toMatchObject({
      traceId: "assignment-1",
      occurrenceIds: ["assignment-1"],
      deliveryIds: ["delivery-1"],
    });
    const liveEventRuntimeTurn = runtimeEvents.find(
      (event) =>
        event.type === "agent.turn.started" &&
        event.data.origin === "live-event.automatic",
    );
    expect(liveEventRuntimeTurn?.trace).toMatchObject({
      traceId: "00000000-0000-4000-8000-000000000003",
      occurrenceIds: ["00000000-0000-4000-8000-000000000003"],
      deliveryIds: ["live-delivery-1"],
    });
    expect(defaultSession.prompts).toEqual(["legacy"]);

    const updated = configuration("managed", {
      definitionName: "managed-updated",
      label: "Updated Managed Agent",
      description: "Updated managed session",
      systemPrompt: "Updated managed prompt",
      resolvedTools: ["ableton_session_inspect", "ableton_tracks_create"],
      skills: ["mix-balance"],
      availableSkills: [skillDescriptor("mix-balance")],
    });
    await service.reconfigureManagedAgent(updated);
    const updatedSnapshot = runtimeEvents
      .filter((event) => event.type === "agent.session.configuration")
      .at(-1)?.data;
    expect(updatedSnapshot).toMatchObject({
      customAgentPrompt: "Updated managed prompt",
    });
    expect(JSON.stringify(updatedSnapshot?.skills)).toContain(
      `"fingerprint":"${"a".repeat(64)}"`,
    );
    expect(JSON.stringify(updatedSnapshot?.tools)).toContain(
      '"name":"ableton_tracks_create"',
    );

    expect(managedSession.disconnect).toHaveBeenCalledOnce();
    expect(service.getManagedAgentSessionId("managed")).toBe("managed-session");
    expect(resumeSession).toHaveBeenCalledOnce();
    expect(latestResumeConfig?.agent).toBe("managed-updated");
    expect(latestResumeConfig?.availableTools).toEqual([
      "custom:ableton_session_inspect",
      "custom:ableton_tracks_create",
      "custom:set_sql_search",
      "custom:read_plan",
      "custom:write_plan",
      "custom:skill",
      "builtin:ask_user",
      "builtin:exit_plan_mode",
    ]);
    expect(latestResumeConfig?.customAgents).toEqual([
      {
        name: "managed-updated",
        displayName: "Updated Managed Agent",
        description: "Updated managed session",
        prompt:
          "Updated managed prompt\n\nFor questions about prior Live Sets, saves, devices, clips, or agent trajectories, use set_sql_search against the local read-only Set History views. Treat it as historical evidence and inspect the current Live Set before acting.",
        infer: false,
      },
    ]);
    expect(latestResumeConfig).not.toHaveProperty("skillDirectories");
    expect(latestResumeConfig?.systemMessage?.content).toContain(
      "name: mix-balance",
    );
    await expect(service.send("still legacy")).resolves.toBe(
      "legacy:still legacy",
    );

    await service.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});

it("forwards plan mode and resolves only the owning pending plan request", async () => {
  const events = new InMemoryEventPublisher();
  const received: AppEvent[] = [];
  const runtimeEvents: AgentRuntimeEvent[] = [];
  events.subscribe((event) => received.push(event));
  let managedConfig: SessionConfig | undefined;
  const defaultSession = createFakeSession("default-session");
  const managedSession = createFakeSession("managed-session");
  const createSession = vi
    .fn()
    .mockResolvedValueOnce(defaultSession)
    .mockImplementationOnce(async (config: SessionConfig) => {
      managedConfig = config;
      return managedSession;
    });
  const service = new CopilotAgentService(
    baseOptions({
      events,
      runtimeObserver: {
        enqueue: (event) => runtimeEvents.push(event),
      },
      clientFactory: () => ({
        createSession,
        resumeSession: vi.fn(async () => {
          throw new Error("resume not expected");
        }),
        stop: vi.fn(async () => undefined),
      }),
    }),
  );

  await service.start();
  await service.createManagedAgent(configuration("managed"));
  await service.sendToManagedAgent("managed", "Draft an arrangement", "plan");

  expect(managedSession.messages).toContainEqual({
    prompt: `Draft an arrangement\n\n${PLAN_REMINDER}`,
    agentMode: "plan",
  });
  expect(
    runtimeEvents.find((event) => event.type === "agent.turn.started")?.data,
  ).toMatchObject({
    prompt: `Draft an arrangement\n\n${PLAN_REMINDER}`,
    agentMode: "plan",
    planReminderApplied: true,
    planReminderVersion: PLAN_REMINDER_VERSION,
  });

  managedSession.emit({
    type: "session.mode_changed",
    id: "mode-event",
    parentId: null,
    timestamp: "2026-08-08T00:00:00.000Z",
    data: { previousMode: "interactive", newMode: "plan" },
  } as unknown as SessionEvent);
  expect(received).toContainEqual({
    type: "agent.mode_changed",
    previousMode: "interactive",
    mode: "plan",
    agentInstanceId: "managed",
    sdkSessionId: "managed-session",
  });
  await expect(
    service.resolveManagedAgentPlan("managed", {
      requestId: "unknown-request",
      approved: false,
    }),
  ).resolves.toBe(false);

  const plan = await service.writeManagedAgentPlan("managed", {
    content: "# Plan\n\nInspect, then arrange.",
  });
  if (!plan.exists) throw new Error("Expected plan artifact");

  const directResult = managedConfig?.onExitPlanModeRequest?.(
    {
      summary: "Direct arrangement plan",
      planContent: "# Plan\n\nInspect, then arrange.",
      recommendedAction: "autopilot",
      actions: ["interactive", "autopilot", "exit_only"],
    },
    { sessionId: "managed-session" },
  );
  expect(directResult).toBeDefined();
  await vi.waitFor(() =>
    expect(
      received.filter(
        (event) =>
          event.type === "agent.plan_approval_requested" &&
          event.request.summary === "Direct arrangement plan",
      ),
    ).toHaveLength(1),
  );
  const directRequest = received.find(
    (event) =>
      event.type === "agent.plan_approval_requested" &&
      event.request.summary === "Direct arrangement plan",
  );
  if (directRequest?.type !== "agent.plan_approval_requested") {
    throw new Error("Direct plan request was not published");
  }
  await expect(
    service.resolveManagedAgentPlan("managed", {
      requestId: directRequest.request.requestId,
      approved: true,
      planRevision: plan.revision,
      selectedAction: "interactive",
    }),
  ).resolves.toBe(true);
  await expect(directResult).resolves.toEqual({
    approved: true,
    selectedAction: "interactive",
  });
  expect(received).toContainEqual({
    type: "agent.plan_approval_completed",
    requestId: directRequest.request.requestId,
    approved: true,
    selectedAction: "interactive",
    agentInstanceId: "managed",
    sdkSessionId: "managed-session",
  });
});

it("bounds plan approval payloads and settles a pending managed request on cancellation", async () => {
  const turn = deferred<void>();
  const events = new InMemoryEventPublisher();
  const received: AppEvent[] = [];
  const runtimeEvents: AgentRuntimeEvent[] = [];
  events.subscribe((event) => received.push(event));
  let managedConfig: SessionConfig | undefined;
  const managedSession = createFakeSession("managed-session", {
    onSend: async () => {
      await turn.promise;
      return { data: { content: "cancelled turn settled" } };
    },
  });
  const createSession = vi
    .fn()
    .mockResolvedValueOnce(createFakeSession("default-session"))
    .mockImplementationOnce(async (config: SessionConfig) => {
      managedConfig = config;
      return managedSession;
    });
  const service = new CopilotAgentService(
    baseOptions({
      events,
      runtimeObserver: { enqueue: (event) => runtimeEvents.push(event) },
      clientFactory: () => ({
        createSession,
        resumeSession: vi.fn(async () => {
          throw new Error("resume not expected");
        }),
        stop: vi.fn(async () => undefined),
      }),
    }),
  );

  await service.start();
  await service.createManagedAgent(configuration("managed"));
  const response = service.sendToManagedAgent(
    "managed",
    "Prepare a bounded plan",
    "plan",
  );
  await vi.waitFor(() => expect(managedSession.send).toHaveBeenCalled());
  const plan = await service.writeManagedAgentPlan("managed", {
    content: "p".repeat(100_000),
  });
  if (!plan.exists) throw new Error("Expected plan artifact");
  const exitRequest = managedConfig?.onExitPlanModeRequest?.(
    {
      summary: "s".repeat(9_000),
      planContent: "p".repeat(110_000),
      recommendedAction: "interactive",
      actions: ["interactive", "exit_only"],
    },
    { sessionId: "managed-session" },
  );
  await vi.waitFor(() =>
    expect(
      received.some((event) => event.type === "agent.plan_approval_requested"),
    ).toBe(true),
  );
  const approval = received.find(
    (event) => event.type === "agent.plan_approval_requested",
  );
  if (approval?.type !== "agent.plan_approval_requested") {
    throw new Error("Plan approval was not published");
  }
  expect(approval.request.summary).toHaveLength(8_192);
  expect(approval.request.planContent).toHaveLength(100_000);

  await expect(service.cancelManagedAgent("managed")).resolves.toBe(true);
  await expect(exitRequest).resolves.toEqual({ approved: false });
  expect(managedSession.abort).toHaveBeenCalledOnce();
  expect(received).toContainEqual({
    type: "agent.plan_approval_completed",
    requestId: approval.request.requestId,
    approved: false,
    agentInstanceId: "managed",
    sdkSessionId: "managed-session",
  });
  expect(
    runtimeEvents.find(
      (event) => event.type === "agent.plan.resolution.cancelled",
    ),
  ).toMatchObject({
    sessionId: "managed-session",
    agentInstanceId: "managed",
    data: {
      requestId: approval.request.requestId,
      reason: "user_cancelled",
    },
  });
  expect(
    runtimeEvents.find(
      (event) =>
        event.type === "agent.turn.timeout.paused" &&
        event.data.reason === "plan_approval",
    ),
  ).toMatchObject({
    sessionId: "managed-session",
    agentInstanceId: "managed",
  });
  expect(
    runtimeEvents.find(
      (event) =>
        event.type === "agent.turn.timeout.cancelled" &&
        event.data.reason === "plan_approval",
    ),
  ).toMatchObject({
    sessionId: "managed-session",
    agentInstanceId: "managed",
    data: {
      cancellationReason: "user_cancelled",
      pendingHumanGateCount: 0,
    },
  });
  await expect(
    service.resolveManagedAgentPlan("managed", {
      requestId: approval.request.requestId,
      approved: true,
      selectedAction: "interactive",
    }),
  ).resolves.toBe(false);

  turn.resolve();
  await expect(response).resolves.toBe("cancelled turn settled");
  await service.stop();
});

it("always exposes bounded planning controls across empty and deduplicated agent tool lists", async () => {
  const sessions = [
    createFakeSession("default-session"),
    createFakeSession("empty-session"),
    createFakeSession("deduplicated-session"),
  ];
  const configs: SessionConfig[] = [];
  const createSession = vi.fn(async (config: SessionConfig) => {
    configs.push(config);
    const session = sessions[configs.length - 1];
    if (session === undefined) throw new Error("unexpected createSession call");
    return session;
  });
  const service = new CopilotAgentService(
    baseOptions({
      clientFactory: () => ({
        createSession,
        resumeSession: vi.fn(async () => {
          throw new Error("resume not expected");
        }),
        stop: vi.fn(async () => undefined),
      }),
    }),
  );

  await service.start();
  await service.createManagedAgent(
    configuration("empty", { resolvedTools: [] }),
  );
  await service.createManagedAgent(
    configuration("deduplicated", {
      resolvedTools: [
        "custom:ableton_session_inspect",
        "ableton_session_inspect",
      ],
    }),
  );

  expect(configs[1]?.availableTools).toEqual([
    "custom:set_sql_search",
    "custom:read_plan",
    "custom:write_plan",
    "builtin:ask_user",
    "builtin:exit_plan_mode",
  ]);
  expect(configs[1]?.customAgents?.[0]).not.toHaveProperty("tools");
  expect(configs[2]?.availableTools).toEqual([
    "custom:ableton_session_inspect",
    "custom:set_sql_search",
    "custom:read_plan",
    "custom:write_plan",
    "builtin:ask_user",
    "builtin:exit_plan_mode",
  ]);
  expect(configs[2]?.customAgents?.[0]).not.toHaveProperty("tools");
  for (const config of configs) {
    expect(config.availableTools).toContain("builtin:ask_user");
    expect(config.availableTools).not.toContain("builtin:task");
    expect(config.availableTools).not.toContain("builtin:task_complete");
    expect(config.availableTools).not.toContain("builtin:skill");
    expect(config.customAgents?.[0]).not.toHaveProperty("tools");
  }

  await service.stop();
});

it("blocks plan-mode mutations until interactive approval", async () => {
  const turn = deferred<void>();
  const events = new InMemoryEventPublisher();
  const received: AppEvent[] = [];
  events.subscribe((event) => received.push(event));
  const createTrack = vi.fn(async () => ({
    beforeTrackCount: 0,
    afterTrackCount: 1,
    track: {
      reference: "track-1",
      index: 0,
      name: "Approved track",
      kind: "midi" as const,
    },
    verified: true as const,
  }));
  let managedConfig: SessionConfig | undefined;
  const managedSession = createFakeSession("managed-session", {
    onSend: async () => {
      await turn.promise;
      return { data: { content: "done" } };
    },
  });
  const createSession = vi
    .fn()
    .mockResolvedValueOnce(createFakeSession("default-session"))
    .mockImplementationOnce(async (config: SessionConfig) => {
      managedConfig = config;
      return managedSession;
    });
  const service = new CopilotAgentService(
    baseOptions({
      events,
      getAbletonStatus: async () =>
        ({
          state: "connected",
          liveSetId: "project-1",
          liveSetName: "Test Set",
          saved: true,
        }) as never,
      createTrack,
      clientFactory: () => ({
        createSession,
        resumeSession: vi.fn(async () => {
          throw new Error("resume not expected");
        }),
        stop: vi.fn(async () => undefined),
      }),
    }),
  );

  await service.start();
  await service.createManagedAgent(configuration("managed"));
  const response = service.sendToManagedAgent(
    "managed",
    "Plan a new MIDI track",
    "plan",
  );
  await vi.waitFor(() => expect(managedSession.send).toHaveBeenCalled());
  const create = managedConfig?.tools?.find(
    ({ name }) => name === "ableton_tracks_create",
  );
  const inspect = managedConfig?.tools?.find(
    ({ name }) => name === "ableton_session_inspect",
  );
  const invocation = {
    sessionId: "managed-session",
    toolCallId: "tool-1",
    toolName: "ableton_tracks_create",
    arguments: {},
  };

  await expect(inspect?.handler?.({}, invocation)).resolves.toBeDefined();
  expect(
    managedConfig?.hooks?.onPreToolUse?.(
      {
        sessionId: "managed-session",
        timestamp: new Date(),
        workingDirectory: "/tmp",
        toolName: "exit_plan_mode",
        toolArgs: {
          summary: "Create the approved track",
          planContent: "Create one MIDI track.",
        },
      },
      { sessionId: "managed-session" },
    ),
  ).toBeUndefined();
  await expect(
    create?.handler?.({ kind: "midi", name: "Must not exist yet" }, invocation),
  ).rejects.toMatchObject({ code: "plan_mode_read_only" });
  expect(createTrack).not.toHaveBeenCalled();

  const plan = await service.writeManagedAgentPlan("managed", {
    content: "# Plan\n\nCreate one MIDI track.",
  });
  if (!plan.exists) throw new Error("Expected plan artifact");

  const exitRequest = managedConfig?.onExitPlanModeRequest?.(
    {
      summary: "Create the approved track",
      planContent: "# Plan\n\nCreate one MIDI track.",
      recommendedAction: "interactive",
      actions: ["interactive", "exit_only"],
    },
    { sessionId: "managed-session" },
  );
  await vi.waitFor(() =>
    expect(
      received.some((event) => event.type === "agent.plan_approval_requested"),
    ).toBe(true),
  );
  const approval = received.find(
    (event) => event.type === "agent.plan_approval_requested",
  );
  if (approval?.type !== "agent.plan_approval_requested") {
    throw new Error("Plan approval was not published");
  }
  await expect(
    service.resolveManagedAgentPlan("managed", {
      requestId: approval.request.requestId,
      approved: true,
      planRevision: plan.revision,
      selectedAction: "interactive",
    }),
  ).resolves.toBe(true);
  await expect(exitRequest).resolves.toEqual({
    approved: true,
    selectedAction: "interactive",
  });
  await expect(
    create?.handler?.({ kind: "midi", name: "Approved track" }, invocation),
  ).resolves.toMatchObject({ verified: true });
  expect(createTrack).toHaveBeenCalledOnce();

  turn.resolve();
  await expect(response).resolves.toBe("done");
  await service.stop();
});

function automaticLiveEvent(
  occurrenceId = "00000000-0000-4000-8000-000000000101",
): LiveEventTurnRequest {
  return {
    deliveryId: `delivery-${occurrenceId}`,
    agentInstanceId: "managed",
    listener: {
      id: "event-listener.00000000-0000-4000-8000-000000000001",
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      enabled: true,
      responseMode: "automatic",
      messagePrefix: "Check the launch.",
    },
    occurrence: {
      occurrenceId,
      eventId: "live-event.00000000-0000-4000-8000-000000000001",
      kind: "track.triggered_clip_changed",
      sequence: 1,
      observedAt: "2026-08-30T20:00:00.000Z",
      target: {
        trackReference: trackAReference,
        track: { name: "Lead drum" },
      },
      summary: "Queued pattern2 in scene 2",
      current: { state: "session-clip", slotIndex: 1, clipName: "pattern2" },
    },
  };
}

describe("CopilotAgentService model selection", () => {
  it("maps the live SDK model catalog and propagates discovery errors", async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([
        modelInfo("auto", {
          capabilities: {
            supports: {},
            limits: { max_context_window_tokens: 0 },
          } as ModelInfo["capabilities"],
        }),
        modelInfo("model-a"),
        modelInfo("partial", {
          capabilities: {
            supports: {},
            limits: { max_context_window_tokens: 0 },
          },
          supportedReasoningEfforts: [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ],
        } as unknown as Partial<ModelInfo>),
      ])
      .mockRejectedValueOnce(new Error("catalog unavailable"));
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession: vi.fn(async () => createFakeSession("default")),
          resumeSession: vi.fn(async () => {
            throw new Error("unused");
          }),
          listModels,
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();

    await expect(service.listModels()).resolves.toEqual([
      {
        id: "model-a",
        displayName: "Model model-a",
        policyState: "enabled",
        capabilities: {
          vision: true,
          reasoningEffort: true,
          maxPromptTokens: 32_000,
          maxContextWindowTokens: 64_000,
        },
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "partial",
        displayName: "Model partial",
        policyState: "enabled",
        capabilities: {
          vision: false,
          reasoningEffort: false,
        },
        supportedReasoningEfforts: [
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
    await expect(service.listModels()).rejects.toThrow("catalog unavailable");
    await service.stop();
  });

  it("keeps runtime defaults isolated from managed model and reasoning settings", async () => {
    const configs: SessionConfig[] = [];
    const resumeConfigs: ResumeSessionConfig[] = [];
    const createSession = vi.fn(async (config: SessionConfig) => {
      configs.push(config);
      return createFakeSession(`session-${configs.length}`);
    });
    const resumeSession = vi.fn(
      async (_sessionId: string, config: ResumeSessionConfig) => {
        resumeConfigs.push(config);
        return createFakeSession("resumed-session");
      },
    );
    const service = new CopilotAgentService(
      baseOptions({
        model: "runtime-default",
        reasoningEffort: "high",
        clientFactory: () => ({
          createSession,
          resumeSession,
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(configuration("sdk-default"));
    await service.createManagedAgent(
      configuration("explicit", {
        model: "model-b",
        reasoningEffort: "xhigh",
      }),
    );
    await service.resumeManagedAgent(
      configuration("resumed", {
        model: "model-c",
        reasoningEffort: "max",
      }),
      "resumed-session",
    );

    expect(configs[0]?.model).toBe("runtime-default");
    expect(configs[0]?.reasoningEffort).toBe("high");
    expect(configs[1]).not.toHaveProperty("model");
    expect(configs[1]).not.toHaveProperty("reasoningEffort");
    expect(configs[2]?.model).toBe("model-b");
    expect(configs[2]?.reasoningEffort).toBe("xhigh");
    expect(resumeConfigs[0]?.model).toBe("model-c");
    expect(resumeConfigs[0]?.reasoningEffort).toBe("max");
    await service.stop();
  });
});

describe("CopilotAgentService missing-session automatic recovery", () => {
  it("rotates once and retries an automatic event before any tool starts", async () => {
    const events = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    events.subscribe((event) => received.push(event));
    const sessions = [
      createFakeSession("default"),
      createFakeSession("missing", {
        onSend: async () => {
          throw new Error(
            "Request session.send failed with message: Session not found for sessionId: missing",
          );
        },
      }),
      createFakeSession("replacement", {
        onSend: async () => ({ data: { content: "recovered" } }),
      }),
    ];
    const createSession = vi.fn(async () => sessions.shift()!);
    const service = new CopilotAgentService(
      baseOptions({
        events,
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("unused");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(configuration("managed"));

    await expect(
      service.enqueueLiveEventTurn(automaticLiveEvent()),
    ).resolves.toBe("recovered");
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(received).toContainEqual({
      type: "agent.sdk_session_rotated",
      agentInstanceId: "managed",
      oldSdkSessionId: "missing",
      newSdkSessionId: "replacement",
      reason: "missing-session",
    });
    expect(
      received.filter(
        (event) => event.type === "agent.live_event_trigger_changed",
      ),
    ).toHaveLength(2);
    await service.stop();
  });

  it("does not retry after a tool may have mutated Live", async () => {
    const missing = createFakeSession("missing", {
      onSend: async (_prompt, emit) => {
        emit(toolStart("tool-1", "ableton_tracks_create"));
        throw new Error(
          "Request session.send failed with message: Session not found for sessionId: missing",
        );
      },
    });
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(createFakeSession("default"))
      .mockResolvedValueOnce(missing);
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("unused");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(configuration("managed"));
    await expect(
      service.enqueueLiveEventTurn(automaticLiveEvent()),
    ).rejects.toThrow("Session not found");
    expect(createSession).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("shares one replacement across concurrently queued automatic events", async () => {
    const missing = createFakeSession("missing", {
      onSend: async () => {
        throw new Error(
          "Request session.send failed with message: Session not found for sessionId: missing",
        );
      },
    });
    const replacement = createFakeSession("replacement", {
      onSend: async (prompt) => ({ data: { content: prompt } }),
    });
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(createFakeSession("default"))
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(replacement);
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("unused");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(configuration("managed"));
    await Promise.all([
      service.enqueueLiveEventTurn(automaticLiveEvent()),
      service.enqueueLiveEventTurn(
        automaticLiveEvent("00000000-0000-4000-8000-000000000102"),
      ),
    ]);
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(replacement.send).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  it("fails closed when replacement session creation fails", async () => {
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(createFakeSession("default"))
      .mockResolvedValueOnce(
        createFakeSession("missing", {
          onSend: async () => {
            throw new Error(
              "Request session.send failed with message: Session not found for sessionId: missing",
            );
          },
        }),
      )
      .mockRejectedValueOnce(new Error("replacement failed"));
    const service = new CopilotAgentService(
      baseOptions({
        clientFactory: () => ({
          createSession,
          resumeSession: vi.fn(async () => {
            throw new Error("unused");
          }),
          stop: vi.fn(async () => undefined),
        }),
      }),
    );
    await service.start();
    await service.createManagedAgent(configuration("managed"));
    await expect(
      service.enqueueLiveEventTurn(automaticLiveEvent()),
    ).rejects.toThrow("replacement failed");
    expect(service.getManagedAgentSessionId("managed")).toBe("missing");
    await service.stop();
  });
});
