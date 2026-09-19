import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendAutomationMessage } from "@ableton-agent/debug-control";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import { describe, expect, it, vi } from "vitest";

import {
  applyAutomationStartup,
  createDesktopAutomationServer,
} from "./automation-host.js";
import type { HeadlessDesktopService } from "./headless-desktop-service.js";

describe("desktop automation startup", () => {
  it("selects an existing definition and applies YOLO", async () => {
    const selected = {
      id: "00000000-0000-4000-8000-000000000001",
      definitionName: "mix",
    };
    const listActiveAgents = vi.fn(async () => [selected]);
    const selectActiveAgent = vi.fn(async () => selected);
    const createActiveAgent = vi.fn();
    const setAutoApproval = vi.fn(async () => ({
      instances: [],
      session: {},
    }));
    const service = {
      listActiveAgents,
      selectActiveAgent,
      createActiveAgent,
      setAutoApproval,
    } as unknown as HeadlessDesktopService;

    await applyAutomationStartup(service, {
      profilePath: "/tmp/profile",
      descriptorPath: "/tmp/profile/endpoint.json",
      agentDefinition: "mix",
      yolo: true,
    });

    expect(selectActiveAgent).toHaveBeenCalledWith(selected.id);
    expect(createActiveAgent).not.toHaveBeenCalled();
    expect(setAutoApproval).toHaveBeenCalledWith(selected.id, true);
  });

  it("creates a missing requested definition", async () => {
    const created = {
      id: "00000000-0000-4000-8000-000000000002",
      definitionName: "sound",
    };
    const listActiveAgents = vi.fn(async () => []);
    const selectActiveAgent = vi.fn();
    const createActiveAgent = vi.fn(async () => created);
    const setAutoApproval = vi.fn();
    const service = {
      listActiveAgents,
      selectActiveAgent,
      createActiveAgent,
      setAutoApproval,
    } as unknown as HeadlessDesktopService;

    await applyAutomationStartup(service, {
      profilePath: "/tmp/profile",
      descriptorPath: "/tmp/profile/endpoint.json",
      agentDefinition: "sound",
      yolo: false,
    });

    expect(createActiveAgent).toHaveBeenCalledWith("sound");
    expect(selectActiveAgent).not.toHaveBeenCalled();
  });

  it("records bounded correlated ingress lifecycle events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-automation-host-"));
    const descriptorPath = join(directory, "endpoint.json");
    let received: Parameters<HeadlessDesktopService["send"]> | undefined;
    const send = vi.fn(
      async (...args: Parameters<HeadlessDesktopService["send"]>) => {
        received = args;
        return {
          accepted: true as const,
          messageId: "00000000-0000-4000-8000-000000000021",
        };
      },
    );
    const events: TelemetryEventEnvelope[] = [];
    const server = createDesktopAutomationServer({
      service: { send } as unknown as HeadlessDesktopService,
      launch: {
        profilePath: directory,
        descriptorPath,
        yolo: false,
      },
      telemetry: {
        enqueue: (event) => events.push(event),
        enqueueConfigurationSnapshot: vi.fn(),
      },
    });
    await server.start();
    try {
      const result = await sendAutomationMessage({
        descriptorPath,
        message: "Inspect the selected track",
      });
      expect(result.accepted).toBe(true);
      expect(received?.[0]).toBe("Inspect the selected track");
      expect(received?.[1]).toEqual([]);
      expect(received?.[2]).toMatchObject({
        origin: "automation",
        trace: {
          traceId: result.trace.traceId,
          correlationId: result.trace.correlationId,
        },
      });
      expect(events.map(({ stage }) => stage)).toEqual([
        "queued",
        "started",
        "completed",
      ]);
      const completed = events.find(({ stage }) => stage === "completed");
      expect(completed).toMatchObject({
        name: "desktop.automation_message",
        correlationId: result.trace.correlationId,
        attributes: {
          message_characters: 26,
          message_id: "00000000-0000-4000-8000-000000000021",
          request_id: received?.[2]?.requestId,
        },
      });
    } finally {
      await server.stop();
    }
  });
});
