import { isAbsolute } from "node:path";

import { sendAutomationMessage } from "@ableton-agent/debug-control";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function descriptorPathFromArgs(argv: readonly string[]): string {
  const index = argv.indexOf("--descriptor");
  if (index < 0 || argv[index + 1] === undefined) {
    throw new Error("--descriptor requires an absolute discovery file path");
  }
  if (argv.indexOf("--descriptor", index + 1) >= 0) {
    throw new Error("--descriptor may only be specified once");
  }
  const path = argv[index + 1]!;
  if (!isAbsolute(path)) {
    throw new Error("--descriptor requires an absolute discovery file path");
  }
  return path;
}

export function createDebugMcpServer(descriptorPath: string): McpServer {
  const server = new McpServer({
    name: "ableton-agent-desktop-debug",
    version: "0.1.0",
  });
  server.registerTool(
    "send_user_message",
    {
      title: "Send Ableton Agent user message",
      description:
        "Send a plain user message to the currently selected agent in the running visible Ableton Agent desktop app.",
      inputSchema: {
        message: z.string().trim().min(1).max(16_000),
      },
    },
    async ({ message }) => {
      try {
        const result = await sendAutomationMessage({
          descriptorPath,
          message,
        });
        return {
          content: [
            {
              type: "text",
              text: `Message accepted by the visible desktop app (messageId: ${result.messageId}).`,
            },
          ],
          structuredContent: {
            accepted: true,
            messageId: result.messageId,
            traceId: result.trace.traceId,
            correlationId: result.trace.correlationId,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: message.slice(0, 512) }],
        };
      }
    },
  );
  return server;
}

async function main(): Promise<void> {
  const descriptorPath = descriptorPathFromArgs(process.argv);
  const server = createDebugMcpServer(descriptorPath);
  await server.connect(new StdioServerTransport());
}

if (process.env.VITEST === undefined) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
