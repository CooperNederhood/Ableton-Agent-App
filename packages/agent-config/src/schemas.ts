import { z } from "zod";

/** Producer/component limit shared with canonical signal-routing assignments. */
export const MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH = 256;
/** Maximum canonical encoded assignment ID length supported by signal routing. */
export const MAX_AGENT_ASSIGNMENT_ID_LENGTH = 4_121;

const producerIdSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_ASSIGNMENT_COMPONENT_LENGTH);
const assignmentIdSchema = z
  .string()
  .min(1)
  .max(MAX_AGENT_ASSIGNMENT_ID_LENGTH);

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
  });
export type ActiveAgentConfig = z.infer<typeof activeAgentConfigSchema>;

export const activeAgentInstanceSchema = z.object({
  id: z.string().uuid(),
  definitionName: agentDefinitionNameSchema,
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  label: z.string().trim().min(1).max(128),
  autoApprove: z.boolean().default(false),
  sdkSessionId: z.string().min(1).optional(),
  lifecycle: z.enum(["starting", "ready", "busy", "blocked", "failed"]),
  config: activeAgentConfigSchema,
  boundTracks: z.array(boundTrackScopeSchema).max(128),
  outputSubscriptions: z.array(outputSubscriptionSchema).max(256),
  modified: z.boolean(),
});
export type ActiveAgentInstance = z.infer<typeof activeAgentInstanceSchema>;
