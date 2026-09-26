import { describe, expect, it } from "vitest";

import {
  MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH,
  MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH,
  MAX_AGENT_ASSIGNMENT_ID_LENGTH,
  agentEventListenerSchema,
  agentDefinitionSchema,
  editScopeSchema,
  activeAgentInstanceSchema,
  liveEventDefinitionSchema,
  liveEventInitialStateSchema,
  liveEventInvalidationSchema,
  liveEventOccurrenceSchema,
  liveEventResolutionSchema,
  outputSubscriptionSchema,
  resolvePreparedContextConfiguration,
} from "./schemas.js";
import {
  createAgentEventListenerId,
  createLiveEventId,
} from "./live-event-id.js";

describe("agent configuration schemas", () => {
  it("accepts a complete session-scoped definition", () => {
    const parsed = agentDefinitionSchema.parse({
      version: 1,
      name: "default",
      description: "General-purpose agent.",
      systemPrompt: "Help with the current Live Set.",
      tools: ["*"],
      editScope: ["session"],
      skills: [],
      inputChannels: [],
    });
    expect(parsed).toMatchObject({
      version: 2,
      name: "default",
      label: "Default",
      editScope: ["session"],
      model: null,
      reasoningEffort: null,
      autoApprove: false,
      eventListeners: [],
    });
  });

  it("accepts bounded version-two definition-owned defaults", () => {
    const eventId = createLiveEventId("00000000-0000-4000-8000-000000000001");
    const parsed = agentDefinitionSchema.parse({
      version: 2,
      name: "mix",
      label: "Mix reviewer",
      description: "Review the mix.",
      systemPrompt: "Review the current Live Set.",
      tools: ["ableton_*"],
      editScope: ["session"],
      skills: [],
      inputChannels: [],
      model: "model-a",
      reasoningEffort: "high",
      autoApprove: true,
      eventListeners: [
        {
          id: createAgentEventListenerId(
            "00000000-0000-4000-8000-000000000002",
          ),
          eventId,
          enabled: true,
          responseMode: "automatic",
        },
      ],
    });

    expect(parsed).toMatchObject({
      label: "Mix reviewer",
      model: "model-a",
      reasoningEffort: "high",
      autoApprove: true,
      eventListeners: [{ eventId }],
    });
    expect(
      agentDefinitionSchema.safeParse({ ...parsed, label: "x".repeat(129) })
        .success,
    ).toBe(false);
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
      model: "model-a",
      reasoningEffort: "max",
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
    expect(instance.model).toBe("model-a");
    expect(instance.reasoningEffort).toBe("max");
    expect(
      activeAgentInstanceSchema.safeParse({
        ...instance,
        reasoningEffort: "minimal",
      }).success,
    ).toBe(false);
  });

  it("validates every live event definition kind as a discriminated union", () => {
    const common = {
      id: createLiveEventId("00000000-0000-4000-8000-000000000001"),
      name: "Watched source",
      projectId: "project-1",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const trackTarget = {
      track: { name: "Drums", occurrence: 0 },
    };
    const definitions = [
      {
        ...common,
        kind: "parameter.value_changed",
        classification: "continuous",
        target: {
          ...trackTarget,
          device: { name: "Rack", occurrence: 0 },
          parameter: { name: "Macro 1", occurrence: 0 },
        },
        observationPolicy: {
          minimumNormalizedDelta: 0.01,
          throttleMs: 50,
        },
      },
      {
        ...common,
        kind: "track.playing_clip_changed",
        classification: "discrete",
        target: trackTarget,
      },
      {
        ...common,
        kind: "track.triggered_clip_changed",
        classification: "discrete",
        target: trackTarget,
      },
      {
        ...common,
        kind: "track.recording_state_changed",
        classification: "discrete",
        target: trackTarget,
      },
    ];

    for (const definition of definitions) {
      expect(liveEventDefinitionSchema.safeParse(definition).success).toBe(
        true,
      );
    }
    expect(
      liveEventDefinitionSchema.safeParse({
        ...definitions[1],
        classification: "continuous",
      }).success,
    ).toBe(false);
  });

  it("validates live event runtime boundary records", () => {
    const eventId = createLiveEventId("00000000-0000-4000-8000-000000000001");
    expect(
      liveEventResolutionSchema.safeParse({
        status: "resolved",
        projectId: "project-1",
        trackReference: "00000000-0000-4000-8000-000000000010",
        track: { name: "Drums" },
      }).success,
    ).toBe(true);
    expect(
      liveEventInitialStateSchema.safeParse({
        kind: "track.playing_clip_changed",
        state: { state: "stopped" },
      }).success,
    ).toBe(true);
    expect(
      liveEventOccurrenceSchema.safeParse({
        occurrenceId: "00000000-0000-4000-8000-000000000020",
        eventId,
        kind: "track.recording_state_changed",
        sequence: 7,
        observedAt: "2026-01-01T00:00:00.000Z",
        target: {
          trackReference: "00000000-0000-4000-8000-000000000010",
          track: { name: "Drums" },
        },
        summary: "Drums started recording.",
        previous: { recording: false, source: "track" },
        current: { recording: true, source: "track" },
      }).success,
    ).toBe(true);
    expect(
      liveEventInvalidationSchema.safeParse({
        eventId,
        observedAt: "2026-01-01T00:00:00.000Z",
        reason: "target-deleted",
      }).success,
    ).toBe(true);
  });

  it("keeps event and listener IDs distinct and bounds listener prefixes", () => {
    const uuid = "00000000-0000-4000-8000-000000000001";
    const eventId = createLiveEventId(uuid);
    const listenerId = createAgentEventListenerId(uuid);
    expect(eventId).not.toBe(listenerId);
    expect(eventId.startsWith("live-event.")).toBe(true);
    expect(listenerId.startsWith("event-listener.")).toBe(true);
    expect(
      agentEventListenerSchema.safeParse({
        id: listenerId,
        eventId,
        enabled: true,
        responseMode: "automatic",
        messagePrefix: "When this changes:",
      }).success,
    ).toBe(true);
    expect(
      agentEventListenerSchema.safeParse({
        id: listenerId,
        eventId,
        enabled: true,
        responseMode: "automatic",
        messagePrefix: "x".repeat(MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("keeps listeners without prepared context backward compatible", () => {
    const parsed = agentEventListenerSchema.parse({
      id: createAgentEventListenerId("00000000-0000-4000-8000-000000000001"),
      eventId: createLiveEventId("00000000-0000-4000-8000-000000000002"),
      enabled: true,
      responseMode: "next-prompt",
    });

    expect(parsed.preparedContext).toBeUndefined();
    expect(resolvePreparedContextConfiguration(parsed.preparedContext)).toEqual(
      {
        scope: "whole-session",
        includeSessionClips: true,
      },
    );
  });
});
