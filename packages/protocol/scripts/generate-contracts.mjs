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
  protocolErrorCodeSchema,
  requestEnvelopeSchema,
  successResponseEnvelopeSchema,
} from "../src/schemas.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDirectory = join(packageRoot, "contracts");
const requestId = "00000000-0000-4000-8000-000000000001";

function sampleFromSchema(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum !== undefined) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.anyOf !== undefined) {
    const candidate =
      schema.anyOf.find((entry) => entry.type !== "null") ?? schema.anyOf[0];
    return sampleFromSchema(candidate);
  }
  switch (schema.type) {
    case "object": {
      const propertyNames = Object.keys(schema.properties ?? {});
      const required = schema.required ?? [];
      const firstOptional = propertyNames.find(
        (name) => !required.includes(name),
      );
      const selected =
        firstOptional === undefined ? required : [...required, firstOptional];
      return Object.fromEntries(
        selected.map((name) => [
          name,
          sampleFromSchema(schema.properties[name]),
        ]),
      );
    }
    case "array": {
      const length = schema.minItems ?? 0;
      return Array.from({ length }, () => sampleFromSchema(schema.items));
    }
    case "string":
      if (schema.format === "uuid")
        return "00000000-0000-4000-8000-000000000099";
      if (schema.format === "uri") return "ableton://fixture";
      return "x".repeat(Math.max(1, schema.minLength ?? 0));
    case "integer":
    case "number": {
      const minimum =
        schema.minimum ??
        (schema.exclusiveMinimum === undefined
          ? 0
          : schema.exclusiveMinimum + 1);
      return schema.maximum === undefined
        ? minimum
        : Math.min(minimum, schema.maximum);
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      throw new Error(
        `Cannot generate fixture for schema ${JSON.stringify(schema)}`,
      );
  }
}

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
  errors: protocolErrorCodeSchema.options.map((code, index) =>
    failureResponseEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      kind: "response",
      requestId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      ok: false,
      error: {
        code,
        message: `Golden ${code} failure`,
        retryable: [
          "operation_timeout",
          "queue_full",
          "lom_error",
          "internal_error",
        ].includes(code),
        details: { fixture: true },
      },
    }),
  ),
};

const commandFixtures = {
  producer: "typescript",
  protocolVersion: PROTOCOL_VERSION,
  commands: Object.fromEntries(
    Object.entries(commandCatalog).map(([name, definition], index) => {
      const params = definition.params.parse(
        sampleFromSchema(z.toJSONSchema(definition.params)),
      );
      const result = definition.result.parse(
        sampleFromSchema(z.toJSONSchema(definition.result)),
      );
      const commandRequestId = `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`;
      return [
        name,
        {
          request: requestEnvelopeSchema.parse({
            protocolVersion: PROTOCOL_VERSION,
            kind: "request",
            requestId: commandRequestId,
            command: name,
            params,
          }),
          success: successResponseEnvelopeSchema.parse({
            protocolVersion: PROTOCOL_VERSION,
            kind: "response",
            requestId: commandRequestId,
            ok: true,
            result,
          }),
          failure: failureResponseEnvelopeSchema.parse({
            protocolVersion: PROTOCOL_VERSION,
            kind: "response",
            requestId: commandRequestId,
            ok: false,
            error: {
              code: "lom_error",
              message: `Golden ${name} failure`,
              retryable: true,
            },
          }),
        },
      ];
    }),
  ),
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
  [
    join(contractsDirectory, "command-fixtures.json"),
    await format(JSON.stringify(commandFixtures), { parser: "json" }),
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
