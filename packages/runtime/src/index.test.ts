import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { InMemoryEventPublisher } from "@ableton-agent/shared";
import { describe, expect, it, vi } from "vitest";
import {
  BASE_SYSTEM_MESSAGE,
  type AgentSessionConfiguration,
  type CopilotAgentServiceOptions,
} from "@ableton-agent/application";
import {
  agentHistoryRecordSchema,
  configurationSnapshotSchema,
  LocalObservabilityJournal,
  REDACTED_VALUE,
  sanitizeTelemetryAttributes,
  telemetryEventEnvelopeSchema,
  type AgentHistoryRecord,
  type ConfigurationSnapshot,
  type TelemetryEventEnvelope,
} from "@ableton-agent/observability";
import {
  currentCorrelationContext,
  withCorrelation,
  type CorrelationTraceContext,
} from "@ableton-agent/correlation";
import { stableTelemetryId } from "@ableton-agent/signal-routing";

import {
  createAbletonService,
  createAgentRuntime,
  parseAbletonPort,
  resolveAbletonSettingsFromEnvironment,
  resolveAgentSettingsFromEnvironment,
  RuntimeConfigurationError,
  UnconfiguredAbletonService,
} from "./index.js";

const validToken = "a".repeat(32);
type TestClient = ReturnType<
  NonNullable<CopilotAgentServiceOptions["clientFactory"]>
>;
type TestSession = Awaited<ReturnType<TestClient["createSession"]>>;
type TestSessionEvent = Parameters<Parameters<TestSession["on"]>[0]>[0];

describe("runtime configuration", () => {
  it("defaults the bridge port and rejects invalid values", () => {
    expect(parseAbletonPort(undefined)).toBe(8765);
    expect(parseAbletonPort("9000")).toBe(9000);
    for (const invalid of ["0", "65536", "8765.5", "not-a-port"]) {
      expect(() => parseAbletonPort(invalid)).toThrow(
        RuntimeConfigurationError,
      );
    }
  });

  it("reads token, port, and model from the environment", () => {
    expect(
      resolveAbletonSettingsFromEnvironment({
        ABLETON_AGENT_TOKEN: validToken,
        ABLETON_AGENT_PORT: "9100",
      }),
    ).toEqual({ token: validToken, port: 9100 });
    expect(resolveAbletonSettingsFromEnvironment({})).toEqual({ port: 8765 });
    expect(
      resolveAgentSettingsFromEnvironment({ ABLETON_AGENT_MODEL: "gpt-5.4" }),
    ).toEqual({ model: "gpt-5.4" });
    expect(resolveAgentSettingsFromEnvironment({})).toEqual({});
  });

  it("stands in for the bridge when no token is configured", async () => {
    const { ableton, configured } = createAbletonService(
      { port: 8765 },
      new InMemoryEventPublisher(),
    );

    expect(configured).toBe(false);
    expect(ableton).toBeInstanceOf(UnconfiguredAbletonService);
    await expect(ableton.getStatus()).resolves.toMatchObject({
      state: "error",
      code: "configuration_missing",
    });
    await expect(ableton.inspectSession()).rejects.toMatchObject({
      code: "configuration_missing",
    });
  });

  it("builds a real bridge when a token is configured", () => {
    const { ableton, configured } = createAbletonService(
      { token: validToken, port: 9000 },
      new InMemoryEventPublisher(),
    );

    expect(configured).toBe(true);
    expect(ableton).not.toBeInstanceOf(UnconfiguredAbletonService);
  });

  it("reports an unusable token as a configuration error", () => {
    expect(() =>
      createAbletonService(
        { token: "short", port: 8765 },
        new InMemoryEventPublisher(),
      ),
    ).toThrow(RuntimeConfigurationError);
  });
});

describe("agent runtime composition", () => {
  it("wires one event publisher through application, bridge, and agent", async () => {
    const runtime = createAgentRuntime({ ableton: { port: 8765 } });
    const states: string[] = [];
    runtime.application.subscribe((event) => {
      if (event.type === "lifecycle.changed") states.push(event.state);
    });

    await runtime.application.start({ startAgent: false });

    expect(runtime.abletonConfigured).toBe(false);
    expect(states).toEqual(["starting", "degraded"]);
    expect(runtime.application.agentSessionId).toBeUndefined();
    await expect(runtime.application.cancel()).resolves.toBe(false);
    await runtime.application.stop();
    expect(states.at(-1)).toBe("stopped");
  });

  it("uses an injected Ableton service without touching a socket", async () => {
    const events = new InMemoryEventPublisher();
    const runtime = createAgentRuntime({
      ableton: { port: 8765 },
      abletonService: new UnconfiguredAbletonService("no bridge in tests"),
      events,
    });

    await expect(runtime.ableton.getStatus()).resolves.toMatchObject({
      message: "no bridge in tests",
    });
    expect(runtime.events).toBe(events);
  });

  it("wires the non-blocking telemetry recorder into output routing", () => {
    const telemetry: TelemetryEventEnvelope[] = [];
    const runtime = createAgentRuntime({
      ableton: { port: 8765 },
      telemetry: {
        enqueue: (event) => {
          telemetry.push(telemetryEventEnvelopeSchema.parse(event));
        },
        enqueueConfigurationSnapshot: () => undefined,
      },
    });

    runtime.signals.upsertAssignment({
      assignmentId: "composition-test",
      producerId: "producer",
      consumer: { kind: "agent-instance", id: "agent" },
      deliveryMode: "next-prompt",
      enabled: true,
      usageInstruction: "Use this output.",
      processingPolicyIds: [],
    });

    expect(telemetry).toContainEqual(
      expect.objectContaining({
        name: "output.assignment.configured",
        source: "output-routing",
      }),
    );
  });

  it("maps exact agent runtime events to sanitized observability records", async () => {
    const telemetry: TelemetryEventEnvelope[] = [];
    const snapshots: ConfigurationSnapshot[] = [];
    const agentHistory: AgentHistoryRecord[] = [];
    const runtime = createAgentRuntime({
      ableton: { port: 8765 },
      agent: {
        clientFactory: () => ({
          createSession: () => Promise.resolve(fakeSession("sdk-session")),
          resumeSession: () => Promise.reject(new Error("not expected")),
          stop: () => Promise.resolve([]),
        }),
      },
      telemetry: {
        enqueue: (event) => {
          telemetry.push(event);
        },
        enqueueConfigurationSnapshot: (snapshot) => {
          snapshots.push(snapshot);
        },
      },
      currentAppSessionId: () => "app-session",
      agentHistory: {
        appendAgentHistory: (record) => {
          agentHistory.push(
            agentHistoryRecordSchema.parse(sanitizeTelemetryAttributes(record)),
          );
          return Promise.resolve();
        },
      },
    });

    await runtime.application.start();
    const credential = ["top", "secret", "token"].join("-");
    await runtime.application.send(
      `Preserve this exact user request. ${["Bearer", credential].join(" ")}`,
    );

    expect(
      telemetry.some(
        ({ name, source }) =>
          name === "agent.turn.completed" && source === "agent-runtime",
      ),
    ).toBe(true);
    telemetry.forEach((event) => telemetryEventEnvelopeSchema.parse(event));
    snapshots.forEach((snapshot) =>
      configurationSnapshotSchema.parse(snapshot),
    );
    const serializedTelemetry = JSON.stringify(telemetry);
    expect(serializedTelemetry).not.toContain(
      "Preserve this exact user request.",
    );
    expect(serializedTelemetry).not.toContain('"response":"done"');
    expect(serializedTelemetry).not.toContain(credential);
    const serializedAgentHistory = JSON.stringify(agentHistory);
    expect(serializedAgentHistory).toContain(
      "Preserve this exact user request.",
    );
    expect(serializedAgentHistory).toContain('"content":"done"');
    expect(serializedAgentHistory).toContain(REDACTED_VALUE);
    expect(serializedAgentHistory).not.toContain(credential);
    expect(agentHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent_session" }),
        expect.objectContaining({ kind: "turn", status: "completed" }),
        expect.objectContaining({ kind: "message", role: "user" }),
        expect.objectContaining({ kind: "message", role: "assistant" }),
      ]),
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.component).toBe("agent-runtime");
    expect(snapshots[0]?.configurationVersion).toBe("runtime-observer-v1");
    expect(snapshots[0]?.sessionId).toBe("sdk-session");
    expect(snapshots[0]?.liveSetId).toBeUndefined();
    expect(snapshots[0]?.liveProjectId).toBeUndefined();
    const configurationData = snapshots[0]?.values.data as
      Readonly<Record<string, unknown>> | undefined;
    const sdkSystemMessage = configurationData?.sdkSystemMessage as
      Readonly<Record<string, unknown>> | undefined;
    expect(sdkSystemMessage?.content).toBe(BASE_SYSTEM_MESSAGE);
    expect(configurationData?.customAgentPrompt).toBe(
      "Act as the general-purpose Ableton production agent for the current Live Set. Inspect when needed, then directly perform the user's requested supported edits with the available tools. Mutations are restricted by tool approval, edit scope, connection, and automatic-analysis policies. Follow the session system message and clearly report observed state, applied changes, and real limitations.",
    );
    expect(configurationData?.skills).toEqual([]);
    const configuredTools = configurationData?.tools as
      ReadonlyArray<Readonly<Record<string, unknown>>> | undefined;
    expect(configuredTools?.length).toBeGreaterThan(0);
    expect(typeof configuredTools?.[0]?.name).toBe("string");
    expect(typeof configuredTools?.[0]?.description).toBe("string");
    expect(typeof configuredTools?.[0]?.parameterSchema).toBe("object");
    expect(typeof configuredTools?.[0]?.available).toBe("boolean");
    expect(JSON.stringify(snapshots)).not.toContain(credential);
    await runtime.application.stop();
  });

  it("links a Live delivery through distinct turn and tool lifecycle spans", async () => {
    const telemetry: TelemetryEventEnvelope[] = [];
    const listeners = new Set<(event: TestSessionEvent) => void>();
    const emit = (event: TestSessionEvent): void => {
      for (const listener of listeners) listener(event);
    };
    let invocationContext: CorrelationTraceContext | undefined;
    const session = {
      sessionId: "sdk-session",
      send: async () => {
        emit({
          type: "tool.execution_start",
          id: "tool-start",
          parentId: null,
          timestamp: "2026-08-29T18:00:02.000Z",
          data: {
            toolCallId: "tool-call-1",
            toolName: "ableton_connection_status",
          },
        });
        invocationContext = withCorrelation("tool-call-1", () =>
          currentCorrelationContext(),
        );
        emit({
          type: "tool.execution_complete",
          id: "tool-complete",
          parentId: null,
          timestamp: "2026-08-29T18:00:03.000Z",
          data: { toolCallId: "tool-call-1", success: true },
        });
        emit({
          type: "assistant.message",
          id: "assistant",
          parentId: null,
          timestamp: "2026-08-29T18:00:04.000Z",
          data: { messageId: "message", content: "done" },
        });
        emit({
          type: "session.idle",
          id: "idle",
          parentId: null,
          timestamp: "2026-08-29T18:00:05.000Z",
          ephemeral: true,
          data: { mode: "interactive" },
        });
        return "message";
      },
      abort: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      on: (next: (event: TestSessionEvent) => void) => {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } satisfies TestSession;
    const runtime = createAgentRuntime({
      ableton: { port: 8765 },
      agent: {
        clientFactory: () => ({
          createSession: () => Promise.resolve(session),
          resumeSession: () => Promise.reject(new Error("not expected")),
          stop: () => Promise.resolve([]),
        }),
      },
      telemetry: {
        enqueue: (event) => telemetry.push(event),
        enqueueConfigurationSnapshot: () => undefined,
      },
    });
    const occurrenceId = "00000000-0000-4000-8000-000000000003";
    const eventId = "live-event.00000000-0000-4000-8000-000000000001";
    const deliveryId = "live-delivery-1";

    await runtime.application.start();
    const enqueueLiveEventTurn = runtime.agent.enqueueLiveEventTurn;
    if (enqueueLiveEventTurn === undefined) {
      throw new Error("Live Event turn delivery is unavailable");
    }
    await enqueueLiveEventTurn.call(runtime.agent, {
      deliveryId,
      agentInstanceId: "sdk-session",
      listener: {
        id: "event-listener.00000000-0000-4000-8000-000000000001",
        eventId,
        enabled: true,
        responseMode: "automatic",
        messagePrefix: "Inspect this event.",
      },
      occurrence: {
        occurrenceId,
        eventId,
        kind: "track.playing_clip_changed",
        sequence: 3,
        observedAt: "2026-08-29T18:00:01.000Z",
        target: {
          trackReference: "00000000-0000-4000-8000-000000000002",
          track: { name: "Keys" },
        },
        summary: "Keys started clip 1.",
        current: { state: "session-clip", slotIndex: 0 },
      },
    });

    const turnStarted = telemetry.find(
      ({ name }) => name === "agent.turn.started",
    );
    const turnCompleted = telemetry.find(
      ({ name }) => name === "agent.turn.completed",
    );
    const toolStarted = telemetry.find(
      ({ name }) => name === "agent.tool.started",
    );
    const toolCompleted = telemetry.find(
      ({ name }) => name === "agent.tool.completed",
    );
    expect(turnStarted).toMatchObject({
      correlationId: occurrenceId,
      causationId: deliveryId,
      trace: {
        traceId: occurrenceId,
        parentSpanId: stableTelemetryId(deliveryId),
      },
    });
    expect(turnCompleted?.trace?.spanId).toBe(turnStarted?.trace?.spanId);
    expect(toolStarted).toMatchObject({
      correlationId: "tool-call-1",
      toolName: "ableton_connection_status",
      trace: {
        traceId: occurrenceId,
        parentSpanId: turnStarted?.trace?.spanId,
      },
    });
    expect(typeof toolStarted?.causationId).toBe("string");
    expect(toolCompleted?.trace?.spanId).toBe(toolStarted?.trace?.spanId);
    expect(toolCompleted?.toolName).toBe("ableton_connection_status");
    expect(invocationContext).toMatchObject({
      correlationId: "tool-call-1",
      traceId: occurrenceId,
      parentSpanId: toolStarted?.trace?.spanId,
      toolName: "ableton_connection_status",
    });
    telemetry.forEach((event) => telemetryEventEnvelopeSchema.parse(event));
    await runtime.application.stop();
  });

  it("preserves an Output ingress trace on the dispatched agent turn", async () => {
    const telemetry: TelemetryEventEnvelope[] = [];
    const runtime = createAgentRuntime({
      ableton: { port: 8765 },
      agent: {
        clientFactory: () => ({
          createSession: () => Promise.resolve(fakeSession("sdk-session")),
          resumeSession: () => Promise.reject(new Error("not expected")),
          stop: () => Promise.resolve([]),
        }),
      },
      telemetry: {
        enqueue: (event) => telemetry.push(event),
        enqueueConfigurationSnapshot: () => undefined,
      },
    });
    const traceId = "00000000-0000-4000-8000-000000000010";

    await runtime.application.start();
    const enqueueSignalTurn = runtime.agent.enqueueSignalTurn;
    if (enqueueSignalTurn === undefined) {
      throw new Error("Output turn delivery is unavailable");
    }
    await enqueueSignalTurn.call(runtime.agent, {
      deliveryId: "output-delivery-1",
      context: {
        assignmentId: "assignment-1",
        producerId: "producer-1",
        consumer: { kind: "agent-instance", id: "sdk-session" },
        deliveryMode: "automatic-action",
        sequence: 1,
        capturedAt: 1_750_000_000_000,
        sourceIdentity: "Producer",
        content: "Kick on beat one",
        traceId,
      },
      usageInstruction: "Apply the observation.",
    });

    const turnStarted = telemetry.find(
      ({ name }) => name === "agent.turn.started",
    );
    const turnCompleted = telemetry.find(
      ({ name }) => name === "agent.turn.completed",
    );
    expect(turnStarted).toMatchObject({
      correlationId: "assignment-1",
      causationId: "output-delivery-1",
      outputId: "assignment-1",
      trace: {
        traceId,
        parentSpanId: stableTelemetryId("output-delivery-1"),
      },
    });
    expect(turnCompleted?.trace?.spanId).toBe(turnStarted?.trace?.spanId);
    telemetry.forEach((event) => telemetryEventEnvelopeSchema.parse(event));
    await runtime.application.stop();
  });

  it("indexes managed configuration snapshots for ownership lookup", async () => {
    const snapshots: ConfigurationSnapshot[] = [];
    const sessions = [fakeSession("session-1"), fakeSession("managed-sdk")];
    const runtime = createAgentRuntime({
      ableton: { port: 8765 },
      abletonService: Object.assign(
        new UnconfiguredAbletonService("no bridge in tests"),
        { getCurrentLiveSetId: () => "set-a" },
      ),
      currentLiveProjectId: () => "live-project-a",
      agent: {
        clientFactory: () => ({
          createSession: () =>
            Promise.resolve(
              sessions.shift() ?? fakeSession("unexpected-session"),
            ),
          resumeSession: () => Promise.reject(new Error("not expected")),
          stop: () => Promise.resolve([]),
        }),
      },
      telemetry: {
        enqueue: () => undefined,
        enqueueConfigurationSnapshot: (snapshot) => snapshots.push(snapshot),
      },
    });
    const configuration: AgentSessionConfiguration = {
      instanceId: "agent-a",
      productionSessionId: "production-a",
      definitionName: "compose",
      label: "Compose",
      description: "Compose MIDI phrases.",
      systemPrompt: "Compose MIDI phrases safely.",
      resolvedTools: ["ableton_session_inspect"],
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      availableSkills: [],
    };

    await runtime.application.start();
    await runtime.application.createManagedAgent(configuration);
    await runtime.application.stop();
    const managedSnapshot = snapshots.find(
      ({ sessionId, activeAgentId }) =>
        sessionId === "managed-sdk" && activeAgentId === "agent-a",
    );
    expect(managedSnapshot).toMatchObject({
      component: "agent-runtime",
      liveSetId: "set-a",
      liveProjectId: "live-project-a",
      sessionId: "managed-sdk",
      activeAgentId: "agent-a",
    });
    expect(managedSnapshot?.values.data).toMatchObject({
      customAgentPrompt: "Compose MIDI phrases safely.",
    });

    const directory = join(
      process.cwd(),
      "packages/runtime/.test-artifacts",
      `snapshot-ownership-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: true });
    const journal = await LocalObservabilityJournal.open({
      path: join(directory, "observability.sqlite"),
    });
    try {
      for (const snapshot of snapshots) {
        await journal.enqueueConfigurationSnapshot(snapshot);
      }
      const page = await journal.readConfigurationSnapshots({
        liveSetId: "set-a",
        liveProjectId: "live-project-a",
        sessionId: "managed-sdk",
        activeAgentId: "agent-a",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        liveSetId: "set-a",
        liveProjectId: "live-project-a",
        sessionId: "managed-sdk",
        activeAgentId: "agent-a",
      });
    } finally {
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function fakeSession(sessionId: string) {
  const listeners = new Set<(event: TestSessionEvent) => void>();
  const emit = (event: TestSessionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return {
    sessionId,
    send: async () => {
      emit({
        type: "assistant.message",
        id: "assistant",
        parentId: null,
        timestamp: new Date().toISOString(),
        data: { messageId: "message", content: "done" },
      });
      emit({
        type: "session.idle",
        id: "idle",
        parentId: null,
        timestamp: new Date().toISOString(),
        ephemeral: true,
        data: { mode: "interactive" },
      });
      return "message";
    },
    abort: () => Promise.resolve(),
    disconnect: vi.fn(() => Promise.resolve()),
    on: (listener: (event: TestSessionEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function runtimeWithSessions(
  sessions: ReturnType<typeof fakeSession>[],
  overrides: {
    resumeSession?: (
      sessionId: string,
    ) => Promise<ReturnType<typeof fakeSession>>;
  } = {},
) {
  const queue = [...sessions];
  return createAgentRuntime({
    ableton: { port: 8765 },
    agent: {
      clientFactory: () => ({
        createSession: () =>
          Promise.resolve(queue.shift() ?? fakeSession("unexpected")),
        resumeSession: (sessionId) =>
          overrides.resumeSession
            ? overrides.resumeSession(sessionId)
            : Promise.reject(new Error("resume not expected")),
        stop: () => Promise.resolve([]),
      }),
    },
  });
}

describe("composed agent session control", () => {
  it("exposes the session id and replaces it on create", async () => {
    const first = fakeSession("session-1");
    const { application } = runtimeWithSessions([
      first,
      fakeSession("session-2"),
    ]);

    await application.start();
    expect(application.agentSessionId).toBe("session-1");
    await expect(application.createAgentSession()).resolves.toBe("session-2");
    expect(application.agentSessionId).toBe("session-2");
    expect(first.disconnect).toHaveBeenCalledOnce();
    await application.stop();
    expect(application.agentSessionId).toBeUndefined();
  });

  it("resumes a stored session once and skips redundant resumes", async () => {
    const resumeSession = vi.fn((sessionId: string) =>
      Promise.resolve(fakeSession(sessionId)),
    );
    const { application } = runtimeWithSessions([fakeSession("session-1")], {
      resumeSession,
    });

    await application.start();
    await application.resumeAgentSession("session-9");
    expect(application.agentSessionId).toBe("session-9");
    await application.resumeAgentSession("session-9");
    expect(resumeSession).toHaveBeenCalledOnce();
    await application.stop();
  });

  it("cancels only while a turn is in flight", async () => {
    let release!: () => void;
    const listeners = new Set<(event: TestSessionEvent) => void>();
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = vi.fn(() => {
      release();
      return Promise.resolve();
    });
    const { application } = createAgentRuntime({
      ableton: { port: 8765 },
      agent: {
        clientFactory: () => ({
          createSession: () =>
            Promise.resolve({
              sessionId: "session-1",
              send: async () => {
                await pending;
                for (const listener of listeners) {
                  listener({
                    type: "session.idle",
                    id: "idle",
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    ephemeral: true,
                    data: { mode: "interactive" },
                  });
                }
                return "message";
              },
              abort,
              disconnect: () => Promise.resolve(),
              on: (listener: (event: TestSessionEvent) => void) => {
                listeners.add(listener);
                return () => {
                  listeners.delete(listener);
                };
              },
            }),
          resumeSession: () => Promise.reject(new Error("resume not expected")),
          stop: () => Promise.resolve([]),
        }),
      },
    });

    await application.start();
    await expect(application.cancel()).resolves.toBe(false);
    const turn = application.send("Long running");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(application.cancel()).resolves.toBe(true);
    await expect(turn).rejects.toThrow("without an assistant response");
    expect(abort).toHaveBeenCalledOnce();
    await expect(application.cancel()).resolves.toBe(false);
    await application.stop();
  });

  it("keeps active signal targets synchronized for default and managed agents", async () => {
    const runtime = runtimeWithSessions([
      fakeSession("session-1"),
      fakeSession("managed-sdk"),
      fakeSession("session-2"),
    ]);
    const syncSignals = vi.spyOn(runtime.signals, "setActiveAgentInstances");
    const configuration: AgentSessionConfiguration = {
      instanceId: "agent-a",
      productionSessionId: "production-a",
      definitionName: "compose",
      label: "Compose",
      description: "Compose MIDI phrases.",
      systemPrompt: "Compose MIDI phrases safely.",
      resolvedTools: ["ableton_session_inspect"],
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      availableSkills: [],
    };

    await runtime.application.start();
    expect(syncSignals).toHaveBeenLastCalledWith(["session-1"]);

    await expect(
      runtime.application.createManagedAgent(configuration),
    ).resolves.toBe("managed-sdk");
    expect(syncSignals).toHaveBeenLastCalledWith(["session-1", "agent-a"]);

    await expect(runtime.application.createAgentSession()).resolves.toBe(
      "session-2",
    );
    expect(syncSignals).toHaveBeenLastCalledWith(["session-2", "agent-a"]);

    await runtime.application.deactivateManagedAgent("agent-a");
    expect(syncSignals).toHaveBeenLastCalledWith(["session-2"]);

    await runtime.application.stop();
    expect(syncSignals).toHaveBeenLastCalledWith([]);
  });

  it("preserves signal identity when managed-agent reconfiguration rolls back", async () => {
    const oldSession = fakeSession("managed-sdk");
    const replacement = fakeSession("managed-sdk");
    let failResume = true;
    const runtime = runtimeWithSessions(
      [fakeSession("session-1"), oldSession],
      {
        resumeSession: async () => {
          if (failResume) throw new Error("resume failed");
          return replacement;
        },
      },
    );
    const syncSignals = vi.spyOn(runtime.signals, "setActiveAgentInstances");
    const initial: AgentSessionConfiguration = {
      instanceId: "agent-a",
      productionSessionId: "production-a",
      definitionName: "compose",
      label: "Compose",
      description: "Compose MIDI phrases.",
      systemPrompt: "Compose MIDI phrases safely.",
      resolvedTools: ["ableton_session_inspect"],
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      availableSkills: [],
    };

    await runtime.application.start();
    await runtime.application.createManagedAgent(initial);
    syncSignals.mockClear();

    await expect(
      runtime.application.reconfigureManagedAgent({
        ...initial,
        definitionName: "compose-updated",
      }),
    ).rejects.toThrow("resume failed");
    expect(syncSignals).not.toHaveBeenCalled();
    await expect(
      runtime.application.sendToManagedAgent("agent-a", "still works"),
    ).resolves.toBe("done");
    expect(oldSession.disconnect).not.toHaveBeenCalled();

    failResume = false;
    await runtime.application.reconfigureManagedAgent({
      ...initial,
      definitionName: "compose-updated",
    });
    expect(syncSignals).toHaveBeenCalledOnce();
    expect(syncSignals).toHaveBeenLastCalledWith(["session-1", "agent-a"]);
    expect(oldSession.disconnect).toHaveBeenCalledOnce();
    await runtime.application.stop();
  });
});
