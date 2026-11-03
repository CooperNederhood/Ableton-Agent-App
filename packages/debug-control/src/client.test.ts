import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sendAutomationMessage } from "./client.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function endpoint(reply: (request: { id: string }) => string) {
  const root = join(process.cwd(), `.automation-client-test-${randomUUID()}`);
  directories.push(root);
  await mkdir(root);
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        socket.end(reply(JSON.parse(input) as { id: string }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const secretPath = join(root, "secret");
  const descriptorPath = join(root, "endpoint.json");
  await writeFile(secretPath, "a".repeat(64));
  await writeFile(
    descriptorPath,
    JSON.stringify({
      version: 1,
      host: "127.0.0.1",
      port: address.port,
      secretPath,
      processId: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  return descriptorPath;
}

describe("automation response integrity", () => {
  it.each([true, false])(
    "rejects a stale response ID (ok=%s) without retrying",
    async (ok) => {
      let requests = 0;
      const descriptorPath = await endpoint(() => {
        requests += 1;
        return (
          JSON.stringify({
            version: 1,
            id: randomUUID(),
            ok,
            ...(ok
              ? { result: { accepted: true, messageId: randomUUID() } }
              : { error: { code: "busy", message: "Other request" } }),
          }) + "\n"
        );
      });
      await expect(
        sendAutomationMessage({ descriptorPath, message: "One turn" }),
      ).rejects.toMatchObject({ code: "protocol" });
      expect(requests).toBe(1);
    },
  );

  it.each(["not-json\n", '{"ok":true}\n', ""])(
    "rejects malformed or lost acknowledgement %j",
    async (response) => {
      const descriptorPath = await endpoint(() => response);
      await expect(
        sendAutomationMessage({ descriptorPath, message: "One turn" }),
      ).rejects.toMatchObject({ code: "protocol" });
    },
  );

  it("does not echo untrusted response payloads in protocol errors", async () => {
    const credential = "Bearer super-secret-test-credential";
    const descriptorPath = await endpoint(() => `${credential}\n`);
    const error = await sendAutomationMessage({
      descriptorPath,
      message: "One turn",
    }).catch((error: unknown) => error);
    expect(String(error)).not.toContain(credential);
    expect(await readFile(descriptorPath, "utf8")).toContain("127.0.0.1");
  });

  it.each(["missing", "different"] as const)(
    "rejects a %s accepted target when submission was pinned",
    async (kind) => {
      const expectedTarget = {
        appSessionId: randomUUID(),
        agentInstanceId: randomUUID(),
        sdkSessionId: "conversation-1",
      };
      const descriptorPath = await endpoint(
        ({ id }) =>
          JSON.stringify({
            version: 1,
            id,
            ok: true,
            result: {
              accepted: true,
              messageId: randomUUID(),
              ...(kind === "missing"
                ? {}
                : {
                    turn: {
                      assistantMessageId: randomUUID(),
                      target: {
                        ...expectedTarget,
                        sdkSessionId: "conversation-2",
                      },
                    },
                  }),
            },
          }) + "\n",
      );
      await expect(
        sendAutomationMessage({
          descriptorPath,
          message: "One turn",
          expectedTarget,
        }),
      ).rejects.toMatchObject({ code: "protocol" });
    },
  );
});
