import { InMemoryEventPublisher } from "@ableton-agent/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionConfiguration } from "@ableton-agent/application";

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
});

function fakeSession(sessionId: string) {
  return {
    sessionId,
    sendAndWait: () => Promise.resolve({ data: { content: "done" } }),
    abort: () => Promise.resolve(),
    disconnect: vi.fn(() => Promise.resolve()),
    on: () => () => undefined,
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
              sendAndWait: async () => {
                await pending;
                return undefined;
              },
              abort,
              disconnect: () => Promise.resolve(),
              on: () => () => undefined,
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
      definitionName: "compose",
      label: "Compose",
      description: "Compose MIDI phrases.",
      systemPrompt: "Compose MIDI phrases safely.",
      resolvedTools: ["ableton_session_inspect"],
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      skillDirectories: [],
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
      definitionName: "compose",
      label: "Compose",
      description: "Compose MIDI phrases.",
      systemPrompt: "Compose MIDI phrases safely.",
      resolvedTools: ["ableton_session_inspect"],
      editScope: ["session"],
      boundTracks: [],
      skills: [],
      skillDirectories: [],
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
