import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH,
  MAX_AGENT_ASSIGNMENT_ID_LENGTH,
  agentDefinitionSchema,
  editScopeSchema,
  activeAgentInstanceSchema,
  outputSubscriptionSchema,
} from "./schemas.js";

describe("agent configuration schemas", () => {
  it("accepts a complete session-scoped definition", () => {
    expect(
      agentDefinitionSchema.parse({
        version: 1,
        name: "default",
        description: "General-purpose agent.",
        systemPrompt: "Help with the current Live Set.",
        tools: ["*"],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
      }),
    ).toMatchObject({ name: "default", editScope: ["session"] });
  });

  it("rejects session scope combined with tracks and duplicate selectors", () => {
    expect(
      editScopeSchema.safeParse([
        "session",
        { track: { name: "Drums", occurrence: 0 } },
      ]).success,
    ).toBe(false);
    expect(
      editScopeSchema.safeParse([
        { track: { name: "Drums", occurrence: 0 } },
        { track: { name: "Drums", occurrence: 0 } },
      ]).success,
    ).toBe(false);
  });

  it("uses the canonical component limit for producer channel ids", () => {
    const producerId = "p".repeat(MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH);
    const definition = {
      version: 1,
      name: "default",
      description: "General-purpose agent.",
      systemPrompt: "Help with the current Live Set.",
      tools: ["*"],
      editScope: ["session"],
      skills: [],
      inputChannels: [producerId],
    };
    const subscription = {
      assignmentId: "assignment",
      producerId,
      enabled: true,
      deliveryMode: "next-prompt",
      usageInstruction: "Use this output.",
      processingPolicyIds: [],
    };

    expect(agentDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(outputSubscriptionSchema.safeParse(subscription).success).toBe(true);
    expect(
      agentDefinitionSchema.safeParse({
        ...definition,
        inputChannels: [`${producerId}x`],
      }).success,
    ).toBe(false);
    expect(
      outputSubscriptionSchema.safeParse({
        ...subscription,
        producerId: `${producerId}x`,
      }).success,
    ).toBe(false);
    expect(
      outputSubscriptionSchema.safeParse({
        ...subscription,
        assignmentId: "a".repeat(MAX_AGENT_ASSIGNMENT_ID_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      outputSubscriptionSchema.safeParse({
        ...subscription,
        assignmentId: "a".repeat(MAX_AGENT_ASSIGNMENT_ID_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("defaults persisted active-agent auto approval safely", () => {
    const instance = activeAgentInstanceSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      definitionName: "default",
      definitionFingerprint: "a".repeat(64),
      label: "Default",
      lifecycle: "ready",
      config: {
        description: "General-purpose agent.",
        systemPrompt: "Help with the current Live Set.",
        tools: ["*"],
        resolvedTools: [],
        editScope: ["session"],
        skills: [],
        inputChannels: [],
      },
      boundTracks: [],
      outputSubscriptions: [],
      modified: false,
    });

    expect(instance.autoApprove).toBe(false);
  });
});
