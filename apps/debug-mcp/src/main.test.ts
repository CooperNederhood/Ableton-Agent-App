import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AutomationControlServer } from "@ableton-agent/debug-control";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createDebugMcpServer, descriptorPathFromArgs } from "./main.js";

describe("debug MCP arguments", () => {
  it("requires one absolute descriptor path", () => {
    expect(
      descriptorPathFromArgs([
        "node",
        "main.js",
        "--descriptor",
        "/tmp/automation-endpoint.json",
      ]),
    ).toBe("/tmp/automation-endpoint.json");
    expect(() =>
      descriptorPathFromArgs(["node", "main.js", "--descriptor", "relative"]),
    ).toThrow("absolute");
  });

  it("registers and calls the bounded send_user_message tool", async () => {
    const directory = await mkdtemp(join(tmpdir(), "debug-mcp-"));
    const descriptorPath = join(directory, "endpoint.json");
    const control = new AutomationControlServer({
      descriptorPath,
      sendUserMessage: async () => ({
        accepted: true,
        messageId: "00000000-0000-4000-8000-000000000031",
      }),
    });
    await control.start();
    const server = createDebugMcpServer(descriptorPath);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "send_user_message" }],
      });
      const result = await client.callTool({
        name: "send_user_message",
        arguments: { message: "Inspect the visible app" },
      });
      expect(result).toMatchObject({
        structuredContent: {
          accepted: true,
          messageId: "00000000-0000-4000-8000-000000000031",
        },
      });
    } finally {
      await client.close();
      await server.close();
      await control.stop();
    }
  });
});
