import { describe, expect, it, vi } from "vitest";
import type {
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";

import { InMemoryEventPublisher, type AppEvent } from "@ableton-agent/shared";

import {
  CopilotAgentService,
  type AgentSessionConfiguration,
  type CopilotAgentServiceOptions,
} from "./index.js";
import type { SignalTurnRequest } from "./signal-delivery.js";

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

function configuration(
  instanceId: string,
  overrides: Partial<Omit<AgentSessionConfiguration, "instanceId">> = {},
): AgentSessionConfiguration {
  return {
    instanceId,
    definitionName: `${instanceId}-definition`,
    label: `Agent ${instanceId}`,
    description: `Description for ${instanceId}`,
    systemPrompt: `System prompt for ${instanceId}`,
    resolvedTools: ["ableton_session_inspect", "ableton_tracks_create"],
    editScope: ["session"],
    boundTracks: [],
    skills: [],
    skillDirectories: [],
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<CopilotAgentServiceOptions>,
): CopilotAgentServiceOptions {
  return {
    events: new InMemoryEventPublisher(),
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
    abort?: () => Promise<void>;
  } = {},
) {
  let listener: ((event: SessionEvent) => void) | undefined;
  const prompts: string[] = [];
  const disconnect = vi.fn(async () => undefined);
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const sendAndWait = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    if (options.onSend !== undefined) {
      return await options.onSend(prompt, (event) => listener?.(event));
    }
    return { data: { content: `reply:${sessionId}:${prompt}` } };
  });
  return {
    sessionId,
    prompts,
    emit: (event: SessionEvent) => listener?.(event),
    sendAndWait,
    abort,
    disconnect,
    on: (receivedListener: (event: SessionEvent) => void) => {
      listener = receivedListener;
      return () => {
        if (listener === receivedListener) listener = undefined;
      };
    },
    ...(options.history === undefined
      ? {}
      : { getEvents: vi.fn(async () => options.history!) }),
  };
}

describe("CopilotAgentService managed sessions", () => {
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
          skillDirectories: ["/repo/skills"],
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
            projectId,
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
            projectId: "project-1",
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

  it("configures and invokes only the selected managed agent's canonical skills", async () => {
    const defaultSession = createFakeSession("default-session");
    const midiSession = createFakeSession("midi-session");
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
        skillDirectories: ["/repo/midi-skills"],
        availableSkills: ["midi-compose", "mix-review"],
      }),
    );
    await service.createManagedAgent(
      configuration("mix-agent", {
        skills: ["mix-review"],
        skillDirectories: ["/repo/mix-skills"],
        availableSkills: ["midi-compose", "mix-review"],
      }),
    );

    const midiConfig = createSession.mock.calls[1]?.[0];
    const mixConfig = createSession.mock.calls[2]?.[0];
    expect(midiConfig?.customAgents?.[0]?.skills).toEqual(["midi-compose"]);
    expect(midiConfig?.skillDirectories).toEqual(["/repo/midi-skills"]);
    expect(mixConfig?.customAgents?.[0]?.skills).toEqual(["mix-review"]);
    expect(mixConfig?.skillDirectories).toEqual(["/repo/mix-skills"]);

    await expect(
      service.invokeManagedAgentSkill(
        "midi-agent",
        "/midi-compose keep the pickup notes and syncopation",
      ),
    ).resolves.toBe(
      "reply:midi-session:/midi-compose keep the pickup notes and syncopation",
    );
    await expect(
      service.sendToManagedAgent("mix-agent", "/mix-review preserve dynamics"),
    ).resolves.toBe("reply:mix-session:/mix-review preserve dynamics");
    await expect(
      service.sendToManagedAgent("midi-agent", "Write a legacy prompt"),
    ).resolves.toBe("reply:midi-session:Write a legacy prompt");

    expect(midiSession.prompts).toEqual([
      "/midi-compose keep the pickup notes and syncopation",
      "Write a legacy prompt",
    ]);
    expect(mixSession.prompts).toEqual(["/mix-review preserve dynamics"]);
    await expect(
      service.invokeManagedAgentSkill("midi-agent", "/mix-review rebalance"),
    ).rejects.toThrow(
      "Skill '/mix-review' is not assigned to managed agent 'midi-agent'.",
    );
    await expect(
      service.invokeManagedAgentSkill("midi-agent", "/unknown-skill request"),
    ).rejects.toThrow("Unknown skill '/unknown-skill'.");
    await expect(
      service.sendToManagedAgent("midi-agent", "/Not-A-Skill request"),
    ).rejects.toThrow("Invalid skill invocation");
    expect(midiSession.prompts).toHaveLength(2);

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
    const managedSession = createFakeSession("managed-session", {
      abort: async () => {
        releaseManaged();
      },
      onSend: async (prompt) => {
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
      void config;
      const next = [defaultSession, managedSession][
        createSession.mock.calls.length - 1
      ];
      if (next === undefined) throw new Error("unexpected createSession call");
      return next;
    });
    const resumeSession = vi.fn(
      async (sessionId: string, config: ResumeSessionConfig) => {
        latestResumeConfig = config;
        expect(sessionId).toBe("managed-session");
        return reconfiguredSession;
      },
    );
    const service = new CopilotAgentService(
      baseOptions({
        signalContext: {
          provider: {
            getPendingContexts: async () => [],
            markDelivered,
          },
        },
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

    const updated = configuration("managed", {
      definitionName: "managed-updated",
      label: "Updated Managed Agent",
      description: "Updated managed session",
      systemPrompt: "Updated managed prompt",
      resolvedTools: ["ableton_session_inspect", "ableton_tracks_create"],
      skills: ["mix-balance"],
      skillDirectories: ["/repo/skills"],
    });
    await service.reconfigureManagedAgent(updated);

    expect(managedSession.disconnect).toHaveBeenCalledOnce();
    expect(service.getManagedAgentSessionId("managed")).toBe("managed-session");
    expect(resumeSession).toHaveBeenCalledOnce();
    expect(latestResumeConfig?.agent).toBe("managed-updated");
    expect(latestResumeConfig?.availableTools).toEqual([
      "custom:ableton_session_inspect",
      "custom:ableton_tracks_create",
    ]);
    expect(latestResumeConfig?.customAgents).toEqual([
      {
        name: "managed-updated",
        displayName: "Updated Managed Agent",
        description: "Updated managed session",
        prompt: "Updated managed prompt",
        tools: ["ableton_session_inspect", "ableton_tracks_create"],
        infer: false,
        skills: ["mix-balance"],
      },
    ]);
    expect(latestResumeConfig?.skillDirectories).toEqual(["/repo/skills"]);
    await expect(service.send("still legacy")).resolves.toBe(
      "legacy:still legacy",
    );

    await service.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
