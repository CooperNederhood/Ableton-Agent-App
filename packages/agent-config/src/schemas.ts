import { z } from "zod";

import {
  liveEventIdSchema,
  liveEventInitialStateSchema,
  liveEventInvalidationSchema,
  liveEventOccurrenceSchema,
  MAX_LIVE_EVENT_OCCURRENCE_BYTES,
  parameterInitialStateSchema,
  parameterValueStateSchema,
  playingClipInitialStateSchema,
  playingClipStateSchema,
  recordingInitialStateSchema,
  recordingStateSchema,
  triggeredClipInitialStateSchema,
  triggeredClipStateSchema,
} from "@ableton-agent/protocol";

export {
  liveEventIdSchema,
  liveEventInitialStateSchema,
  liveEventInvalidationSchema,
  liveEventOccurrenceSchema,
  MAX_LIVE_EVENT_OCCURRENCE_BYTES,
  parameterValueStateSchema,
  playingClipStateSchema,
  recordingStateSchema,
  triggeredClipStateSchema,
};
export type {
  LiveEventInitialStatePayload as LiveEventInitialState,
  LiveEventInvalidationPayload as LiveEventInvalidation,
  LiveEventOccurrencePayload as LiveEventOccurrence,
} from "@ableton-agent/protocol";

/** Producer/component limit shared with canonical signal-routing assignments. */
export const MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH = 256;
/** Maximum canonical encoded assignment ID length supported by signal routing. */
export const MAX_AGENT_ASSIGNMENT_ID_LENGTH = 4_121;
export const MAX_LIVE_EVENTS_PER_SESSION = 256;
export const MAX_EVENT_LISTENERS_PER_AGENT = 256;
export const MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH = 2_048;
export const MAX_LIVE_EVENT_HISTORY_LENGTH = 100;
export const MAX_PREPARED_CONTEXT_TRACKS = 128;

const producerIdSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH);
const assignmentIdSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_ASSIGNMENT_ID_LENGTH);
export const agentEventListenerIdSchema = z
  .string()
  .regex(
    /^event-listener\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );

const namedLocatorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  occurrence: z.number().int().nonnegative().default(0),
});

const preparedContextBase = {
  includeSessionClips: z.boolean().default(true),
};

export const preparedContextConfigurationSchema = z.discriminatedUnion(
  "scope",
  [
    z.object({
      ...preparedContextBase,
      scope: z.literal("whole-session"),
    }),
    z.object({
      ...preparedContextBase,
      scope: z.literal("selected-tracks"),
      tracks: z
        .array(z.object({ track: namedLocatorSchema }))
        .min(1)
        .max(MAX_PREPARED_CONTEXT_TRACKS)
        .superRefine((tracks, context) => {
          const keys = tracks.map(
            ({ track }) => `${track.name}\u0000${track.occurrence}`,
          );
          if (new Set(keys).size !== keys.length) {
            context.addIssue({
              code: "custom",
              message: "Prepared context track selectors must be unique",
            });
          }
        }),
    }),
  ],
);
export type PreparedContextConfiguration = z.infer<
  typeof preparedContextConfigurationSchema
>;

export const DEFAULT_PREPARED_CONTEXT: PreparedContextConfiguration = {
  scope: "whole-session",
  includeSessionClips: true,
};

export function resolvePreparedContextConfiguration(
  configuration: PreparedContextConfiguration | undefined,
): PreparedContextConfiguration {
  return configuration ?? DEFAULT_PREPARED_CONTEXT;
}

const liveEventDefinitionBase = {
  id: liveEventIdSchema,
  name: z.string().trim().min(1).max(160),
  projectId: z.string().min(1),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

const trackEventTargetSchema = z.object({
  track: namedLocatorSchema,
});

const parameterEventTargetSchema = trackEventTargetSchema.extend({
  device: namedLocatorSchema,
  parameter: namedLocatorSchema,
});

const observationPolicySchema = z.object({
  minimumNormalizedDelta: z.number().min(0).max(1),
  throttleMs: z.number().int().nonnegative().max(60_000),
});

const trackDisplayMetadataSchema = z.object({
  name: z.string().min(1).max(128),
  color: z.string().max(64).optional(),
});

export const liveEventResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unresolved"),
    reason: z.enum([
      "not-connected",
      "project-mismatch",
      "missing",
      "ambiguous",
    ]),
    detail: z.string().max(512).optional(),
  }),
  z.object({
    status: z.literal("resolved"),
    projectId: z.string().min(1),
    trackReference: z.string().uuid(),
    deviceReference: z.string().uuid().optional(),
    parameterReference: z.string().uuid().optional(),
    track: trackDisplayMetadataSchema,
  }),
  z.object({
    status: z.literal("invalidated"),
    reason: z.enum([
      "target-deleted",
      "target-replaced",
      "project-changed",
      "subscription-cleared",
      "unknown",
    ]),
    detail: z.string().max(512).optional(),
  }),
]);
export type LiveEventResolution = z.infer<typeof liveEventResolutionSchema>;

export const liveEventDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...liveEventDefinitionBase,
    kind: z.literal("parameter.value_changed"),
    classification: z.literal("continuous"),
    target: parameterEventTargetSchema,
    observationPolicy: observationPolicySchema,
    resolution: liveEventResolutionSchema.optional(),
    initialState: parameterInitialStateSchema.optional(),
  }),
  z.object({
    ...liveEventDefinitionBase,
    kind: z.literal("track.playing_clip_changed"),
    classification: z.literal("discrete"),
    target: trackEventTargetSchema,
    resolution: liveEventResolutionSchema.optional(),
    initialState: playingClipInitialStateSchema.optional(),
  }),
  z.object({
    ...liveEventDefinitionBase,
    kind: z.literal("track.triggered_clip_changed"),
    classification: z.literal("discrete"),
    target: trackEventTargetSchema,
    resolution: liveEventResolutionSchema.optional(),
    initialState: triggeredClipInitialStateSchema.optional(),
  }),
  z.object({
    ...liveEventDefinitionBase,
    kind: z.literal("track.recording_state_changed"),
    classification: z.literal("discrete"),
    target: trackEventTargetSchema,
    resolution: liveEventResolutionSchema.optional(),
    initialState: recordingInitialStateSchema.optional(),
  }),
]);
export type LiveEventDefinition = z.infer<typeof liveEventDefinitionSchema>;

export const agentEventListenerSchema = z.object({
  id: agentEventListenerIdSchema,
  eventId: liveEventIdSchema,
  enabled: z.boolean(),
  responseMode: z.enum(["next-prompt", "automatic"]),
  messagePrefix: z
    .string()
    .trim()
    .min(1)
    .max(MAX_LIVE_EVENT_MESSAGE_PREFIX_LENGTH)
    .optional(),
  preparedContext: preparedContextConfigurationSchema.optional(),
});
export type AgentEventListener = z.infer<typeof agentEventListenerSchema>;

export const agentDefinitionNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/u,
    "Agent names must be lowercase identifiers using letters, numbers, and hyphens",
  );

export const skillNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/u,
    "Skill names must be lowercase identifiers using letters, numbers, and hyphens",
  );

export const toolPatternSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.*:-]+$/u, "Invalid tool pattern");

export const trackScopeSelectorSchema = z.object({
  track: z.object({
    name: z.string().trim().min(1).max(128),
    occurrence: z.number().int().nonnegative().default(0),
  }),
});
export type TrackScopeSelector = z.infer<typeof trackScopeSelectorSchema>;

export const editScopeEntrySchema = z.union([
  z.literal("session"),
  trackScopeSelectorSchema,
]);
export type EditScopeEntry = z.infer<typeof editScopeEntrySchema>;

export const editScopeSchema = z
  .array(editScopeEntrySchema)
  .min(1)
  .max(128)
  .superRefine((entries, context) => {
    const hasSession = entries.includes("session");
    if (hasSession && entries.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Session scope cannot be combined with track scopes",
      });
    }
    const selectors = entries.filter(
      (entry): entry is TrackScopeSelector => entry !== "session",
    );
    const keys = selectors.map(
      ({ track }) => `${track.name}\u0000${track.occurrence}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Track scope selectors must be unique",
      });
    }
  });

export const agentDefinitionSchema = z.object({
  version: z.literal(1),
  name: agentDefinitionNameSchema,
  description: z.string().trim().min(1).max(512),
  systemPrompt: z.string().trim().min(1).max(64_000),
  tools: z.array(toolPatternSchema).min(1).max(256),
  editScope: editScopeSchema,
  skills: z.array(skillNameSchema).max(128),
  inputChannels: z
    .array(z.string().trim().min(1).max(MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH))
    .max(256),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const skillMetadataSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(512),
});
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

export const definitionDiagnosticSchema = z.object({
  sourcePath: z.string().min(1),
  code: z.enum([
    "read_failed",
    "file_too_large",
    "invalid_yaml",
    "invalid_definition",
    "duplicate_agent",
    "invalid_skill",
    "duplicate_skill",
    "unknown_skill",
    "unmatched_tool_pattern",
  ]),
  message: z.string().min(1),
});
export type DefinitionDiagnostic = z.infer<typeof definitionDiagnosticSchema>;

export const boundTrackScopeSchema = z.object({
  selector: trackScopeSelectorSchema,
  projectId: z.string().min(1),
  trackReference: z.string().uuid(),
  trackIndex: z.number().int().nonnegative(),
  expectedName: z.string().min(1),
});
export type BoundTrackScope = z.infer<typeof boundTrackScopeSchema>;

export const outputSubscriptionSchema = z.object({
  assignmentId: assignmentIdSchema,
  producerId: producerIdSchema,
  enabled: z.boolean(),
  deliveryMode: z.enum([
    "next-prompt",
    "automatic-analysis",
    "automatic-action",
  ]),
  usageInstruction: z.string().min(1).max(4096),
  processingPolicyIds: z.array(z.string().min(1)).max(64),
});
export type OutputSubscription = z.infer<typeof outputSubscriptionSchema>;

export const activeAgentConfigSchema = agentDefinitionSchema
  .omit({ version: true, name: true })
  .extend({
    resolvedTools: z.array(z.string().min(1)).max(256),
    resolvedOperations: z.array(z.string().min(1)).max(512).optional(),
  });
export type ActiveAgentConfig = z.infer<typeof activeAgentConfigSchema>;

export const agentReasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type AgentReasoningEffort = z.infer<typeof agentReasoningEffortSchema>;

export const activeAgentInstanceSchema = z.object({
  id: z.string().uuid(),
  definitionName: agentDefinitionNameSchema,
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  label: z.string().trim().min(1).max(128),
  autoApprove: z.boolean().default(false),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: agentReasoningEffortSchema.optional(),
  sdkSessionId: z.string().min(1).optional(),
  lifecycle: z.enum(["starting", "ready", "busy", "blocked", "failed"]),
  config: activeAgentConfigSchema,
  boundTracks: z.array(boundTrackScopeSchema).max(128),
  outputSubscriptions: z.array(outputSubscriptionSchema).max(256),
  eventListeners: z
    .array(agentEventListenerSchema)
    .max(MAX_EVENT_LISTENERS_PER_AGENT)
    .default([]),
  modified: z.boolean(),
});
export type ActiveAgentInstance = z.infer<typeof activeAgentInstanceSchema>;
