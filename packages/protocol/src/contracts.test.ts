import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { commandCatalog } from "./catalog.js";
import { PROTOCOL_VERSION } from "./constants.js";
import { inspectListeningContextParamsSchema } from "./listening-live-schemas.js";
import {
  sessionListeningPassParamsSchema,
  sessionListeningPassResultSchema,
} from "./session-listening-pass-schemas.js";
import {
  failureResponseEnvelopeSchema,
  messageEnvelopeSchema,
  protocolErrorCodeSchema,
  requestEnvelopeSchema,
  successResponseEnvelopeSchema,
} from "./schemas.js";

describe("generated protocol contracts", () => {
  it("keeps granular Session fixtures truthful about source and mutation authority", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../contracts/command-fixtures.json", import.meta.url),
        "utf8",
      ),
    ) as {
      commands: Record<string, { request: unknown; success: unknown }>;
    };
    for (const action of ["prepare", "launch", "inspect", "release"] as const) {
      const name = `listening.${action}_session_pass`;
      const messages = fixture.commands[name];
      if (messages === undefined) {
        throw new Error(`Missing command fixture for ${name}`);
      }
      const request = requestEnvelopeSchema.parse(messages.request);
      const params = sessionListeningPassParamsSchema.parse(request.params);
      const success = successResponseEnvelopeSchema.parse(messages.success);
      const result = sessionListeningPassResultSchema.parse(success.result);
      expect(params.action).toBe(action);
      expect(result.nativeAlignment).toBe("unverified");
      expect(result.evidence).toBe("message-rate-only");
      expect(result.cleanupPolicy).toBe("leave-running");
      expect(result.followActionState).toBe("unknown");
      expect(result.limitations).toHaveLength(2);
      expect(result.limitations[0]).toContain("Clip.start_time is polled");
      expect(result.limitations[0]).toContain(
        "changes between observations may be missed",
      );
      expect(result.ownerId).toBe(params.ownerId);
      expect(result.passId).toBe(params.passId);
      if (action === "launch" || action === "inspect") {
        expect(result.status).toBe("playing");
        expect(result.mutationState).toBe("observed-playing");
        expect(result.sourceEpoch?.clipReference).toBe(
          result.lastObservedSource.selectedClipReference,
        );
        expect(result.sourceEpoch?.startTimeBeats).toBe(
          result.lastObservedSource.startTimeBeats,
        );
      } else {
        expect(result.sourceEpoch).toBeNull();
        expect(result.mutationState).toBe("not-attempted");
      }
    }
  });

  it("round-trips the canonical listening path discovery fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../contracts/command-fixtures.json", import.meta.url),
        "utf8",
      ),
    ) as { commands: Record<string, { canonicalPathRequest?: unknown }> };
    const request = requestEnvelopeSchema.parse(
      fixture.commands["listening.inspect_context"]?.canonicalPathRequest,
    );
    const params = inspectListeningContextParamsSchema.parse(request.params);
    expect(params.listeners).toEqual([
      { canonicalPath: "live_set tracks 0 devices 0" },
    ]);
    expect(params.bindingQueryId).toBeDefined();
  });
  it("keeps every command in the checked-in JSON Schema artifact", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/protocol.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      protocolVersion: number;
      envelopes: Record<string, unknown>;
      commands: Record<string, unknown>;
    };

    expect(document.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(document.envelopes).toHaveProperty("liveSetSaveObserved");
    expect(Object.keys(document.commands).sort()).toEqual(
      Object.keys(commandCatalog).sort(),
    );
  });

  it("parses every TypeScript-produced cross-language fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../contracts/typescript-fixtures.json", import.meta.url),
        "utf8",
      ),
    ) as { producer: string; messages: unknown[]; errors: unknown[] };

    expect(fixture.producer).toBe("typescript");
    expect(
      fixture.messages.map((message) => messageEnvelopeSchema.parse(message)),
    ).toHaveLength(8);
    const errors = fixture.errors.map((message) =>
      failureResponseEnvelopeSchema.parse(message),
    );
    expect(errors.map((message) => message.error.code).sort()).toEqual(
      [...protocolErrorCodeSchema.options].sort(),
    );
  });

  it("validates request, success, and failure fixtures for every command", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../contracts/command-fixtures.json", import.meta.url),
        "utf8",
      ),
    ) as {
      commands: Record<
        string,
        { request: unknown; success: unknown; failure: unknown }
      >;
    };

    expect(Object.keys(fixture.commands).sort()).toEqual(
      Object.keys(commandCatalog).sort(),
    );
    for (const [name, definition] of Object.entries(commandCatalog)) {
      const messages = fixture.commands[name];
      if (messages === undefined) {
        throw new Error(`Missing command fixture for ${name}`);
      }
      const request = requestEnvelopeSchema.parse(messages.request);
      const success = successResponseEnvelopeSchema.parse(messages.success);
      failureResponseEnvelopeSchema.parse(messages.failure);
      definition.params.parse(request.params);
      definition.result.parse(success.result);
    }
  });
});
