import { describe, expect, it, vi } from "vitest";
import type { SessionConfig } from "@github/copilot-sdk";

import {
  InMemoryEventPublisher,
  noopLogger,
  type AppEvent,
} from "@ableton-agent/shared";

import {
  CopilotAgentService,
  HeadlessApplication,
  type AbletonService,
  type AgentService,
} from "./index.js";

function services(status: Awaited<ReturnType<AbletonService["getStatus"]>>) {
  const agent: AgentService = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    send: vi.fn(async (prompt) => `reply:${prompt}`),
  };
  const ableton: AbletonService = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => status),
  };
  const events = new InMemoryEventPublisher();
  return { agent, ableton, events, logger: noopLogger };
}

describe("HeadlessApplication", () => {
  it("starts services and publishes lifecycle in order", async () => {
    const deps = services({ state: "disconnected" });
    const events: AppEvent[] = [];
    deps.events.subscribe((event) => events.push(event));
    const application = new HeadlessApplication(deps);

    await application.start();

    expect(application.state).toBe("degraded");
    expect(events.map((event) => event.type)).toEqual([
      "lifecycle.changed",
      "ableton.connection_changed",
      "lifecycle.changed",
    ]);
  });

  it("enters degraded state when Ableton reports an error", async () => {
    const application = new HeadlessApplication(
      services({ state: "error", code: "offline", message: "not connected" }),
    );
    await application.start();
    expect(application.state).toBe("degraded");
  });

  it("stops the agent before the Ableton service", async () => {
    const order: string[] = [];
    const deps = services({ state: "disconnected" });
    deps.agent.stop = vi.fn(async () => {
      order.push("agent");
    });
    deps.ableton.stop = vi.fn(async () => {
      order.push("ableton");
    });
    const application = new HeadlessApplication(deps);

    await application.start();
    await application.stop();

    expect(order).toEqual(["agent", "ableton"]);
    expect(application.state).toBe("stopped");
  });
});

describe("CopilotAgentService", () => {
  it("creates a restricted session and forwards a prompt", async () => {
    let config: SessionConfig | undefined;
    const disconnect = vi.fn(() => Promise.resolve());
    const stop = vi.fn(() => Promise.resolve([]));
    const sendAndWait = vi.fn(() =>
      Promise.resolve({ data: { content: "Ableton is connected." } }),
    );
    const service = new CopilotAgentService({
      events: new InMemoryEventPublisher(),
      getAbletonStatus: () =>
        Promise.resolve({
          state: "connected",
          liveVersion: "12.1",
          remoteScriptVersion: "0.1.0",
          projectId: "project",
        }),
      clientFactory: () => ({
        createSession: (received) => {
          config = received;
          return Promise.resolve({
            sendAndWait,
            disconnect,
            on: () => () => undefined,
          });
        },
        stop,
      }),
    });

    await service.start();
    const response = await service.send("Check the connection");
    await service.stop();

    expect(response).toBe("Ableton is connected.");
    expect(config?.availableTools).toEqual([
      "custom:ableton_connection_status",
    ]);
    expect(config?.tools).toHaveLength(1);
    expect(sendAndWait).toHaveBeenCalledWith("Check the connection");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
