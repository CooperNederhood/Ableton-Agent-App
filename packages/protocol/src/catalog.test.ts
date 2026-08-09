import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { commandCatalog, commandNames } from "./catalog.js";

function quotedCommands(source: string): string[] {
  return [
    ...source.matchAll(
      /"(?:system|session|transport|tracks|clips|arrangement|devices|browser)\.[a-z_]+"/g,
    ),
  ]
    .map(([match]) => match.slice(1, -1))
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
}

describe("command catalog", () => {
  it("defines valid metadata and schemas for every command", () => {
    expect(commandNames.length).toBeGreaterThan(0);
    for (const definition of Object.values(commandCatalog)) {
      expect(["normal", "long"]).toContain(definition.timeoutClass);
      expect(typeof definition.mutates).toBe("boolean");
      expect(typeof definition.params.safeParse).toBe("function");
      expect(typeof definition.result.safeParse).toBe("function");
    }
  });

  it("covers every command issued by the TypeScript bridge", () => {
    const bridgeSource = readFileSync(
      resolve(process.cwd(), "packages/bridge/src/index.ts"),
      "utf8",
    );
    expect(quotedCommands(bridgeSource)).toEqual([...commandNames].sort());
  });

  it("matches every Remote Script registry command", () => {
    const sources = [
      "remote-script/AbletonAgent/system_commands.py",
      "remote-script/AbletonAgent/device_commands.py",
      "remote-script/AbletonAgent/browser_commands.py",
    ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8"));
    const registered = quotedCommands(sources.join("\n"));
    const expected = commandNames
      .filter((name) => name !== "system.hello")
      .sort();
    expect(registered).toEqual(expected);
  });
});
