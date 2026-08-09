import { describe, expect, it } from "vitest";

import { appEventSchema, ipcSchemas, preferencesSchema } from "./contracts";

describe("desktop IPC contracts", () => {
  it("rejects empty prompts and unknown request properties", () => {
    expect(() =>
      ipcSchemas["agent:send"].request.parse({
        message: "",
        context: [],
        mode: "explore",
      }),
    ).toThrow();
    expect(() =>
      ipcSchemas["agent:send"].request.parse({
        message: "hello",
        context: [],
        mode: "unsafe",
      }),
    ).toThrow();
  });

  it("validates event boundaries", () => {
    expect(
      appEventSchema.safeParse({
        type: "agent.message_delta",
        messageId: "1",
        content: "a",
      }).success,
    ).toBe(true);
    expect(
      appEventSchema.safeParse({ type: "agent.message_delta", content: "a" })
        .success,
    ).toBe(false);
    expect(
      appEventSchema.safeParse({ type: "node.execute", command: "rm" }).success,
    ).toBe(false);
  });

  it("migrates missing version-one preferences through defaults", () => {
    expect(preferencesSchema.parse({}).abletonPort).toBe(8765);
  });
});
