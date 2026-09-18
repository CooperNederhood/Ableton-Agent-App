import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  automationDiscoveryDescriptorSchema,
  type AutomationLifecycleEvent,
} from "./contracts.js";
import { sendAutomationMessage } from "./client.js";
import { AutomationControlServer } from "./server.js";

describe("automation control", () => {
  it("discovers, authenticates, and sends one bounded user message", async () => {
    const root = await mkdtemp(join(tmpdir(), "ableton-agent-automation-"));
    const descriptorPath = join(root, "endpoint.json");
    const sendUserMessage = vi.fn(async () => ({
      accepted: true as const,
      messageId: "00000000-0000-4000-8000-000000000010",
    }));
    const lifecycleEvents: AutomationLifecycleEvent[] = [];
    const server = new AutomationControlServer({
      descriptorPath,
      sendUserMessage,
      onLifecycle: (event) => lifecycleEvents.push(event),
    });
    await server.start();
    try {
      const result = await sendAutomationMessage({
        descriptorPath,
        message: "Create a drum rack",
      });
      expect(result).toMatchObject({
        accepted: true,
        messageId: "00000000-0000-4000-8000-000000000010",
      });
      expect(sendUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "send_user_message",
          params: { message: "Create a drum rack" },
        }),
      );
      expect(lifecycleEvents.map(({ stage }) => stage)).toEqual([
        "queued",
        "started",
        "completed",
      ]);
      const descriptor = automationDiscoveryDescriptorSchema.parse(
        JSON.parse(await readFile(descriptorPath, "utf8")),
      );
      expect(descriptor.host).toBe("127.0.0.1");
      expect(
        (await readFile(descriptor.secretPath, "utf8")).trim(),
      ).toHaveLength(64);
    } finally {
      await server.stop();
    }
    await expect(readFile(descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
