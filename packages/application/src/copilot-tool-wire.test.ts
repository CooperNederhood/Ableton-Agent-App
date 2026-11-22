import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentSchemaActionVariant,
  type AbletonToolServices,
  createAbletonTools,
  scopeAbletonTools,
} from "@ableton-agent/tools";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";

const name = "ableton_devices";
const allActions = [
  "find-position",
  "inspect",
  "inspect-chain-mixer",
  "inspect-drum-pad-chain-devices",
  "inspect-drum-pad-chains",
  "inspect-drum-rack-pads",
  "inspect-parameters",
  "inspect-rack-chain-devices",
  "inspect-rack-chains",
  "move",
  "set-chain-mixer",
  "set-chain-properties",
  "set-enabled",
  "set-parameter",
];
const restrictedActions = ["inspect-chain-mixer", "inspect-parameters"];
const model = "wire-test";

function providerReply(api: "completions" | "responses"): string {
  if (api === "completions") {
    return JSON.stringify({
      id: "wire-chat",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    });
  }
  return JSON.stringify({
    id: "resp_wire",
    object: "response",
    model,
    output: [
      {
        id: "msg_wire",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      },
    ],
    status: "completed",
  });
}

describe.each(["completions", "responses"] as const)(
  "Copilot %s grouped tool wire contract",
  (api) => {
    it.each(["full", "restricted"] as const)(
      "preserves action discovery in %s scope",
      async (scope) => {
        const unexpectedCalls: string[] = [];
        const services = new Proxy({} as AbletonToolServices, {
          get(_target, key) {
            return () => {
              unexpectedCalls.push(String(key));
              throw new Error(`Unexpected Live call: ${String(key)}`);
            };
          },
        });
        const tools = scopeAbletonTools(createAbletonTools(services), {
          allowedToolNames: [name],
          ...(scope === "restricted"
            ? {
                allowedOperationIds: [
                  "devices.inspect_chain_mixer",
                  "devices.inspect_parameters",
                ],
              }
            : {}),
        });
        expect(tools.map((tool) => tool.name)).toEqual([name]);
        const requests: { path: string | undefined; body: unknown }[] = [];
        const server = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
            requests.push({ path: request.url, body });
            response.writeHead(200, { "content-type": "application/json" });
            response.end(providerReply(api));
          });
        });
        const baseDirectory = await mkdtemp(join(tmpdir(), "copilot-wire-"));
        const client = new CopilotClient({
          mode: "empty",
          baseDirectory,
          useLoggedInUser: false,
        });
        let session: CopilotSession | undefined;
        try {
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const address = server.address();
          if (address === null || typeof address === "string") {
            throw new Error("Expected loopback TCP address");
          }
          session = await client.createSession({
            model,
            tools,
            availableTools: [name],
            workingDirectory: baseDirectory,
            provider: {
              type: "openai",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              wireApi: api,
              apiKey: "synthetic",
            },
            onPermissionRequest: () => ({ kind: "reject" }),
          });
          await session.sendAndWait(
            { prompt: "Reply OK without tools." },
            8000,
          );
          const path =
            api === "completions" ? "/v1/chat/completions" : "/v1/responses";
          expect(requests.map((request) => request.path)).toEqual([path]);
          const { tools: wireTools } = requests[0]?.body as {
            tools: {
              type: string;
              name?: string;
              function?: WireDefinition;
            }[];
          };
          const entry = wireTools.find((tool) =>
            api === "completions"
              ? tool.function?.name === name
              : tool.name === name,
          );
          expect(entry?.type).toBe("function");
          const definition = (
            api === "completions" ? entry?.function : entry
          ) as WireDefinition;
          expect(definition).toMatchObject({
            name,
            description: tools[0]?.description,
          });
          const action = definition.parameters.properties.action;
          const actions = scope === "full" ? allActions : restrictedActions;
          expect(action.enum?.slice().sort()).toEqual(actions);
          expect(action).not.toHaveProperty("const");
          expect(definition.description).not.toContain("inspect-chain-mixer");
          const match = /^\{(?:oneOf|anyOf): (\[.*\])\}$/s.exec(
            definition.parameters.description,
          );
          const branches =
            definition.parameters.oneOf ??
            definition.parameters.anyOf ??
            (match?.[1] === undefined
              ? []
              : (JSON.parse(match[1]) as WireBranch[]));
          expect(
            branches.map((branch) => branch.properties.action.const).sort(),
          ).toEqual(actions);
          const variant = (action: string) =>
            agentSchemaActionVariant(
              { properties: definition.parameters.properties, oneOf: branches },
              action,
            ) as WireBranch | undefined;
          const mixer = variant("inspect-chain-mixer");
          expect(mixer?.required).toEqual(["target", "action"]);
          expect(mixer?.properties.target?.oneOf?.length).toBeGreaterThan(0);
          const parameters = variant("inspect-parameters");
          for (const field of [
            "deviceIndex",
            "expectedDeviceReference",
            "expectedDeviceName",
            "action",
          ]) {
            expect(parameters?.required).toContain(field);
          }
          expect(unexpectedCalls).toEqual([]);
        } finally {
          try {
            await session?.disconnect();
          } finally {
            try {
              await client.stop();
            } finally {
              server.closeAllConnections();
              await new Promise<void>((resolve) =>
                server.close(() => resolve()),
              );
              await rm(baseDirectory, { recursive: true, force: true });
            }
          }
        }
      },
      20_000,
    );

    interface WireDefinition {
      name: string;
      description: string;
      parameters: {
        description: string;
        properties: { action: { enum?: string[] } } & Record<string, unknown>;
        oneOf?: WireBranch[];
        anyOf?: WireBranch[];
      };
    }

    interface WireBranch {
      properties: { action: { const: string }; target?: { oneOf?: unknown[] } };
      required: string[];
    }
  },
);
