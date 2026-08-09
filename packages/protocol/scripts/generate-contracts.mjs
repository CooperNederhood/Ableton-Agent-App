import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { format } from "prettier";
import { z } from "zod";

import { commandCatalog } from "../src/catalog.ts";
import { PROTOCOL_VERSION } from "../src/constants.ts";
import {
  eventEnvelopeSchema,
  failureResponseEnvelopeSchema,
  messageEnvelopeSchema,
  requestEnvelopeSchema,
  successResponseEnvelopeSchema,
} from "../src/schemas.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDirectory = join(packageRoot, "contracts");
const requestId = "00000000-0000-4000-8000-000000000001";

const schemaDocument = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  protocolVersion: PROTOCOL_VERSION,
  envelopes: {
    message: z.toJSONSchema(messageEnvelopeSchema),
    request: z.toJSONSchema(requestEnvelopeSchema),
    successResponse: z.toJSONSchema(successResponseEnvelopeSchema),
    failureResponse: z.toJSONSchema(failureResponseEnvelopeSchema),
    event: z.toJSONSchema(eventEnvelopeSchema),
  },
  commands: Object.fromEntries(
    Object.entries(commandCatalog).map(([name, definition]) => [
      name,
      {
        mutates: definition.mutates,
        timeoutClass: definition.timeoutClass,
        params: z.toJSONSchema(definition.params),
        result: z.toJSONSchema(definition.result),
      },
    ]),
  ),
};

const fixtures = {
  producer: "typescript",
  protocolVersion: PROTOCOL_VERSION,
  messages: [
    requestEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId,
      command: "system.hello",
      params: {
        authenticationToken: "a".repeat(32),
        supportedProtocolVersions: [PROTOCOL_VERSION],
        appVersion: "0.1.0",
        eventSubscriptions: [],
      },
    }),
    requestEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000002",
      command: "system.ping",
      params: {},
      projectRevision: 4,
    }),
    successResponseEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId,
      ok: true,
      result: { selectedProtocolVersion: PROTOCOL_VERSION },
      projectRevision: 4,
      warnings: [],
    }),
    failureResponseEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId,
      ok: false,
      error: {
        code: "stale_reference",
        message: "The selected track changed",
        retryable: true,
        details: { expectedRevision: 3, actualRevision: 4 },
      },
    }),
    eventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "event",
      event: "project.changed",
      sequence: 7,
      payload: { reason: "track_added" },
      projectRevision: 4,
    }),
  ],
};

const outputs = new Map([
  [
    join(contractsDirectory, "protocol.schema.json"),
    await format(JSON.stringify(schemaDocument), { parser: "json" }),
  ],
  [
    join(contractsDirectory, "typescript-fixtures.json"),
    await format(JSON.stringify(fixtures), { parser: "json" }),
  ],
]);

if (process.argv.includes("--check")) {
  for (const [path, expected] of outputs) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error(
        `${path} is stale; run pnpm --filter @ableton-agent/protocol contracts:generate`,
      );
    }
  }
} else {
  await mkdir(contractsDirectory, { recursive: true });
  await Promise.all(
    [...outputs].map(([path, content]) => writeFile(path, content, "utf8")),
  );
}
