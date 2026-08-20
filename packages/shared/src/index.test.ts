import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  InMemoryEventPublisher,
  noopLogger,
  ShutdownCoordinator,
  ShutdownError,
  systemClock,
  type AgentEventAttribution,
  type AppEvent,
  type ConfigurationStore,
  type SecureStorage,
  type ShutdownParticipant,
} from "./index.js";

describe("shared runtime contracts", () => {
  it("publishes events and removes subscriptions deterministically", () => {
    const publisher = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    const unsubscribe = publisher.subscribe((event) => received.push(event));

    publisher.publish({ type: "lifecycle.changed", state: "ready" });
    publisher.publish({
      type: "agent.message_complete",
      content: "done",
      agentInstanceId: "agent-1",
      sdkSessionId: "sdk-session-1",
    });
    unsubscribe();
    publisher.publish({ type: "lifecycle.changed", state: "stopped" });

    expect(received).toEqual([
      { type: "lifecycle.changed", state: "ready" },
      {
        type: "agent.message_complete",
        content: "done",
        agentInstanceId: "agent-1",
        sdkSessionId: "sdk-session-1",
      },
    ]);
  });

  it("preserves optional attribution for concurrent SDK sessions", () => {
    const publisher = new InMemoryEventPublisher();
    const received: AppEvent[] = [];
    publisher.subscribe((event) => received.push(event));

    const events = [
      {
        type: "agent.message_delta",
        content: "first",
        agentInstanceId: "agent-1",
        sdkSessionId: "sdk-session-1",
      },
      {
        type: "agent.message_complete",
        content: "second",
        agentInstanceId: "agent-1",
        sdkSessionId: "sdk-session-2",
      },
      {
        type: "operation.started",
        operationId: "operation-1",
        label: "Edit track",
        agentInstanceId: "agent-1",
        sdkSessionId: "sdk-session-1",
      },
      {
        type: "operation.completed",
        operationId: "operation-1",
        summary: "Edited track",
        agentInstanceId: "agent-1",
        sdkSessionId: "sdk-session-2",
      },
      {
        type: "operation.failed",
        operationId: "operation-2",
        code: "tool_failed",
        message: "Tool failed",
        agentInstanceId: "agent-2",
        sdkSessionId: "sdk-session-2",
      },
    ] satisfies AppEvent[];

    for (const event of events) publisher.publish(event);

    expect(received).toEqual(events);
    expect(
      received
        .filter(
          (event) =>
            "sdkSessionId" in event && event.sdkSessionId === "sdk-session-2",
        )
        .map(({ type }) => type),
    ).toEqual([
      "agent.message_complete",
      "operation.completed",
      "operation.failed",
    ]);
  });

  it("keeps legacy agent and operation events valid without attribution", () => {
    const legacyEvents = [
      { type: "agent.message_delta", content: "partial" },
      { type: "agent.message_complete", content: "complete" },
      {
        type: "operation.started",
        operationId: "operation-1",
        label: "Edit track",
      },
      {
        type: "operation.completed",
        operationId: "operation-1",
        summary: "Edited track",
      },
      {
        type: "operation.failed",
        operationId: "operation-2",
        code: "tool_failed",
        message: "Tool failed",
      },
    ] satisfies AppEvent[];

    expect(legacyEvents).toHaveLength(5);

    type AttributableEvent = Extract<
      AppEvent,
      { type: `agent.${string}` | `operation.${string}` }
    >;
    expectTypeOf<AttributableEvent>().toMatchTypeOf<AgentEventAttribution>();
    expectTypeOf<AgentEventAttribution>().toMatchTypeOf<{
      agentInstanceId?: string;
      sdkSessionId?: string;
    }>();
  });

  it("provides side-effect-safe default runtime adapters", () => {
    const before = Date.now();
    expect(systemClock.nowMs()).toBeGreaterThanOrEqual(before);
    expect(systemClock.now()).toBeInstanceOf(Date);
    expect(() =>
      noopLogger.info("ready", { projectId: "local" }),
    ).not.toThrow();
  });

  it("keeps configuration, secrets, and shutdown behind narrow interfaces", async () => {
    const configuration: ConfigurationStore<{ mode: string }> = {
      load: vi.fn(() => Promise.resolve({ mode: "explore" })),
      save: vi.fn(() => Promise.resolve()),
    };
    const secureStorage: SecureStorage = {
      get: vi.fn(() => Promise.resolve("secret")),
      set: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    };
    const shutdown = vi.fn(() => Promise.resolve());
    const participant: ShutdownParticipant = {
      name: "bridge",
      shutdown,
    };

    expect(await configuration.load()).toEqual({ mode: "explore" });
    expect(await secureStorage.get("token")).toBe("secret");
    await participant.shutdown(new AbortController().signal);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("shuts down in reverse registration order and propagates cancellation", async () => {
    const coordinator = new ShutdownCoordinator();
    const controller = new AbortController();
    const order: string[] = [];
    coordinator.register({
      name: "bridge",
      shutdown: (signal) => {
        order.push(`bridge:${signal.aborted}`);
        return Promise.resolve();
      },
    });
    coordinator.register({
      name: "agent",
      shutdown: (signal) => {
        order.push(`agent:${signal.aborted}`);
        return Promise.resolve();
      },
    });
    controller.abort();

    const first = coordinator.shutdown(controller.signal);
    const second = coordinator.shutdown(new AbortController().signal);
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(order).toEqual(["agent:true", "bridge:true"]);
  });

  it("continues shutdown after failures and reports every participant", async () => {
    const coordinator = new ShutdownCoordinator();
    const stopped: string[] = [];
    coordinator.register({
      name: "bridge",
      shutdown: () => {
        stopped.push("bridge");
        return Promise.reject(new Error("bridge failed"));
      },
    });
    coordinator.register({
      name: "agent",
      shutdown: () => {
        stopped.push("agent");
        return Promise.reject(new Error("agent failed"));
      },
    });

    const failure = await coordinator
      .shutdown(new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ShutdownError);
    if (!(failure instanceof ShutdownError)) {
      throw new Error("Expected ShutdownError");
    }
    expect(failure.failures.map(({ participant }) => participant)).toEqual([
      "agent",
      "bridge",
    ]);
    expect(failure.failures.every(({ error }) => error instanceof Error)).toBe(
      true,
    );
    expect(stopped).toEqual(["agent", "bridge"]);
  });
});
