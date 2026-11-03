import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  automationAcceptanceSchema,
  sendUserMessageRequestSchema,
} from "./contracts.js";

const target = {
  appSessionId: randomUUID(),
  agentInstanceId: randomUUID(),
  sdkSessionId: "sdk-conversation-1",
};
const request = {
  version: 1,
  id: randomUUID(),
  secret: "a".repeat(64),
  method: "send_user_message",
  trace: {
    traceId: randomUUID(),
    spanId: randomUUID(),
    correlationId: randomUUID(),
  },
  params: { message: "Inspect", expectedTarget: target },
};

describe("bounded automation target contract", () => {
  it("accepts legacy unpinned and complete pinned requests", () => {
    expect(
      sendUserMessageRequestSchema.parse(request).params.expectedTarget,
    ).toEqual(target);
    expect(
      sendUserMessageRequestSchema.parse({
        ...request,
        params: { message: "Inspect" },
      }).params.expectedTarget,
    ).toBeUndefined();
  });

  it.each([
    { ...target, sdkSessionId: "" },
    { ...target, sdkSessionId: "s".repeat(257) },
    { ...target, appSessionId: "invalid" },
    { ...target, agentInstanceId: undefined },
    { ...target, unexpected: true },
  ])(
    "rejects malformed, partial, or unbounded identity %j",
    (expectedTarget) => {
      expect(
        sendUserMessageRequestSchema.safeParse({
          ...request,
          params: { message: "Inspect", expectedTarget },
        }).success,
      ).toBe(false);
    },
  );

  it("requires complete assistant linkage when a turn is returned", () => {
    const acceptance = { accepted: true, messageId: randomUUID() };
    expect(automationAcceptanceSchema.safeParse(acceptance).success).toBe(true);
    expect(
      automationAcceptanceSchema.safeParse({
        ...acceptance,
        turn: { target },
      }).success,
    ).toBe(false);
    expect(
      automationAcceptanceSchema.safeParse({
        ...acceptance,
        turn: { target, assistantMessageId: randomUUID() },
      }).success,
    ).toBe(true);
  });
});
