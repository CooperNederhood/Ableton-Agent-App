import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { commandCatalog } from "./catalog.js";
import { PROTOCOL_VERSION } from "./constants.js";
import { messageEnvelopeSchema } from "./schemas.js";

describe("generated protocol contracts", () => {
  it("keeps every command in the checked-in JSON Schema artifact", async () => {
    const document = JSON.parse(
      await readFile(
        new URL("../contracts/protocol.schema.json", import.meta.url),
        "utf8",
      ),
    ) as {
      protocolVersion: number;
      commands: Record<string, unknown>;
    };

    expect(document.protocolVersion).toBe(PROTOCOL_VERSION);
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
    ) as { producer: string; messages: unknown[] };

    expect(fixture.producer).toBe("typescript");
    expect(
      fixture.messages.map((message) => messageEnvelopeSchema.parse(message)),
    ).toHaveLength(5);
  });
});
