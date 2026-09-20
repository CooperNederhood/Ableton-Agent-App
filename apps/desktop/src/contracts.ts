import {
  MAX_LIVE_EVENTS_PER_SESSION,
  activeAgentInstanceSchema,
  agentReasoningEffortSchema,
  agentEventListenerSchema,
  liveEventDefinitionSchema,
  liveEventInitialStateSchema,
  liveEventOccurrenceSchema,
  liveEventResolutionSchema,
  outputSubscriptionSchema,
  type AgentEventListener,
  type LiveEventDefinition,
} from "@ableton-agent/agent-config/schemas";
import { inspectEventSelectionResultSchema } from "@ableton-agent/protocol";
import type {
  ConfigurationSnapshotPage,
  ConfigurationSnapshotQuery,
  JournalHealth,
  RetentionPolicy,
  RetentionResult,
  RootTracePage,
  RootTraceQuery,
  TelemetryEventPage,
} from "@ableton-agent/observability";
import { z } from "zod";
import type { AgentMode } from "@ableton-agent/shared";

const telemetryNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const telemetryEntityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const telemetryIdSchema = z.string().uuid();
const telemetryTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const sanitizedAttributesSchema = z.record(
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/u),
  z.unknown(),
);
const traceContextSchema = z
  .object({
    traceId: telemetryIdSchema,
    spanId: telemetryIdSchema,
    parentSpanId: telemetryIdSchema.optional(),
  })
  .strict();
const journaledTelemetryEventSchema = z
  .object({
    version: z.literal(1),
    id: telemetryIdSchema,
    occurredAt: telemetryTimestampSchema,
    name: telemetryNameSchema,
    category: telemetryNameSchema.optional(),
    source: telemetryNameSchema,
    stage: telemetryNameSchema.optional(),
    level: z.enum(["debug", "info", "warn", "error"]),
    outcome: z.enum(["success", "failure", "cancelled", "unknown"]).optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    correlationId: telemetryEntityIdSchema.optional(),
    causationId: telemetryEntityIdSchema.optional(),
    projectId: telemetryEntityIdSchema.optional(),
    sessionId: telemetryEntityIdSchema.optional(),
    activeAgentId: telemetryEntityIdSchema.optional(),
    liveEventId: telemetryEntityIdSchema.optional(),
    outputId: telemetryEntityIdSchema.optional(),
    toolName: telemetryNameSchema.optional(),
    trace: traceContextSchema.optional(),
    attributes: sanitizedAttributesSchema,
    sequence: z.number().int().positive(),
    recordedAt: telemetryTimestampSchema,
  })
  .strict();
const telemetryStringListSchema = z
  .array(telemetryNameSchema)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: "Filter values must be unique",
  });
const telemetryFilterShape = {
  names: telemetryStringListSchema.optional(),
  categories: telemetryStringListSchema.optional(),
  sources: telemetryStringListSchema.optional(),
  stages: telemetryStringListSchema.optional(),
  levels: z
    .array(z.enum(["debug", "info", "warn", "error"]))
    .min(1)
    .max(4)
    .optional(),
  outcomes: z
    .array(z.enum(["success", "failure", "cancelled", "unknown"]))
    .min(1)
    .max(4)
    .optional(),
  traceId: telemetryIdSchema.optional(),
  correlationId: telemetryEntityIdSchema.optional(),
  projectId: telemetryEntityIdSchema.optional(),
  sessionId: telemetryEntityIdSchema.optional(),
  activeAgentId: telemetryEntityIdSchema.optional(),
  liveEventId: telemetryEntityIdSchema.optional(),
  outputId: telemetryEntityIdSchema.optional(),
  toolName: telemetryNameSchema.optional(),
  from: telemetryTimestampSchema.optional(),
  to: telemetryTimestampSchema.optional(),
};
const validHistoryRange = (query: {
  from?: string | undefined;
  to?: string | undefined;
}): boolean =>
  query.from === undefined || query.to === undefined || query.from <= query.to;
const telemetryQuerySchema = z
  .object({
    ...telemetryFilterShape,
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(500).default(100),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .refine(validHistoryRange, {
    message: "'from' must not be later than 'to'",
    path: ["from"],
  });
const telemetryEventPageSchema = z
  .object({
    version: z.literal(1),
    items: z.array(journaledTelemetryEventSchema),
    nextCursor: z.string().min(1).optional(),
    page: z
      .object({
        limit: z.number().int().positive(),
        returnedItems: z.number().int().nonnegative(),
        totalItems: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        order: z.enum(["asc", "desc"]),
      })
      .strict(),
    trace: z
      .object({
        rootTraceId: telemetryIdSchema,
        totalEvents: z.number().int().nonnegative(),
        firstSequence: z.number().int().positive().nullable(),
        lastSequence: z.number().int().positive().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
const traceEventPageSchema = telemetryEventPageSchema.extend({
  trace: z
    .object({
      rootTraceId: telemetryIdSchema,
      totalEvents: z.number().int().nonnegative(),
      firstSequence: z.number().int().positive().nullable(),
      lastSequence: z.number().int().positive().nullable(),
    })
    .strict(),
});
const rootTraceSummarySchema = z
  .object({
    rootTraceId: telemetryIdSchema,
    eventCount: z.number().int().positive(),
    firstSequence: z.number().int().positive(),
    lastSequence: z.number().int().positive(),
    firstOccurredAt: telemetryTimestampSchema,
    lastOccurredAt: telemetryTimestampSchema,
    firstEventName: telemetryNameSchema,
    lastEventName: telemetryNameSchema,
    hasErrors: z.boolean(),
  })
  .strict();
const rootTracePageSchema = z
  .object({
    version: z.literal(1),
    items: z.array(rootTraceSummarySchema),
    nextCursor: z.string().min(1).optional(),
    page: z
      .object({
        limit: z.number().int().positive(),
        returnedItems: z.number().int().nonnegative(),
        totalItems: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        order: z.enum(["asc", "desc"]),
      })
      .strict(),
  })
  .strict();
const journaledConfigurationSnapshotSchema = z
  .object({
    version: z.literal(1),
    id: telemetryIdSchema,
    capturedAt: telemetryTimestampSchema,
    component: telemetryNameSchema,
    configurationVersion: z.string().min(1).max(64),
    projectId: telemetryEntityIdSchema.optional(),
    sessionId: telemetryEntityIdSchema.optional(),
    activeAgentId: telemetryEntityIdSchema.optional(),
    values: sanitizedAttributesSchema,
    sequence: z.number().int().positive(),
    recordedAt: telemetryTimestampSchema,
  })
  .strict();
const configurationSnapshotQuerySchema = z
  .object({
    components: telemetryStringListSchema.optional(),
    projectId: telemetryEntityIdSchema.optional(),
    sessionId: telemetryEntityIdSchema.optional(),
    activeAgentId: telemetryEntityIdSchema.optional(),
    from: telemetryTimestampSchema.optional(),
    to: telemetryTimestampSchema.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(500).default(100),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .refine(validHistoryRange, {
    message: "'from' must not be later than 'to'",
    path: ["from"],
  });
const configurationSnapshotPageSchema = z
  .object({
    version: z.literal(1),
    items: z.array(journaledConfigurationSnapshotSchema),
    nextCursor: z.string().min(1).optional(),
    page: z
      .object({
        limit: z.number().int().positive(),
        returnedItems: z.number().int().nonnegative(),
        totalItems: z.number().int().nonnegative(),
        hasMore: z.boolean(),
        order: z.enum(["asc", "desc"]),
      })
      .strict(),
  })
  .strict();
const retentionPolicySchema = z
  .object({
    maxAgeDays: z.number().finite().positive().default(30),
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(250 * 1024 * 1024),
  })
  .strict();
const retentionResultSchema = z
  .object({
    version: z.literal(1),
    deletedEvents: z.number().int().nonnegative(),
    deletedTraces: z.number().int().nonnegative(),
    deletedConfigurationSnapshots: z.number().int().nonnegative(),
    databaseBytes: z.number().int().nonnegative(),
    withinMaxBytes: z.boolean(),
  })
  .strict();
const journalHealthSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["healthy", "degraded", "closed"]),
    schemaVersion: z.number().int().nonnegative(),
    pendingWrites: z.number().int().nonnegative(),
    persistedEvents: z.number().int().nonnegative(),
    persistedConfigurationSnapshots: z.number().int().nonnegative(),
    rejectedWrites: z.number().int().nonnegative(),
    maxPendingWrites: z.number().int().positive(),
    databaseBytes: z.number().int().nonnegative(),
    oldestEventAt: telemetryTimestampSchema.nullable(),
    newestEventAt: telemetryTimestampSchema.nullable(),
    lastFlushAt: telemetryTimestampSchema.nullable(),
    lastError: z
      .object({
        code: z.enum([
          "closed",
          "conflict",
          "corrupt_database",
          "duplicate",
          "invalid_cursor",
          "io",
          "queue_full",
          "schema_version",
        ]),
        message: z.string().min(1).max(1_024),
        at: telemetryTimestampSchema,
      })
      .strict()
      .nullable(),
    retention: retentionPolicySchema,
  })
  .strict();

export type ApprovalDecision = "approve" | "deny";
export const lifecycleStates = [
  "stopped",
  "starting",
  "ready",
  "degraded",
  "stopping",
  "crashed",
] as const;
export type DesktopLifecycleState = (typeof lifecycleStates)[number];

export const contextChipSchema = z.object({
  id: z.string().min(1).max(512),
  kind: z.enum(["track", "clip", "range", "device", "section"]),
  label: z.string().min(1).max(160),
});
export type ContextChip = z.infer<typeof contextChipSchema>;

const connectionStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disconnected") }),
  z.object({ state: z.literal("connecting") }),
  z.object({
    state: z.literal("connected"),
    liveVersion: z.string(),
    remoteScriptVersion: z.string(),
    projectId: z.string(),
  }),
  z.object({
    state: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type DesktopConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["midi", "audio", "return", "master"]),
  color: z.string(),
  volume: z.number().min(0).max(1),
  pan: z.number().min(-1).max(1),
  muted: z.boolean(),
  clips: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sceneIndex: z.number().int().nonnegative(),
      lengthBeats: z.number().positive(),
      status: z.enum(["playing", "queued", "stopped"]),
    }),
  ),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      enabled: z.boolean(),
      parameters: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          value: z.number().min(0).max(1),
          displayValue: z.string(),
        }),
      ),
    }),
  ),
});
export type DesktopTrack = z.infer<typeof trackSchema>;

export const projectSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  tempo: z.number().positive(),
  timeSignature: z.string(),
  tracks: z.array(trackSchema),
});
export type DesktopProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const desktopProjectIdentitySchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  saved: z.boolean(),
});
export type DesktopProjectIdentity = z.infer<
  typeof desktopProjectIdentitySchema
>;

export const projectTransitionDecisionSchema = z.enum([
  "resume-associated",
  "fork-current",
  "start-fresh",
]);
export type ProjectTransitionDecision = z.infer<
  typeof projectTransitionDecisionSchema
>;

export const pendingProjectTransitionSchema = z.object({
  token: z.string().uuid(),
  kind: z.enum(["associated", "unassociated"]),
  project: desktopProjectIdentitySchema,
  currentSessionId: z.string().min(1).optional(),
  associatedSession: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .optional(),
  decisions: z.array(projectTransitionDecisionSchema).min(1),
});
export type PendingProjectTransition = z.infer<
  typeof pendingProjectTransitionSchema
>;

export const outputDeliveryModeSchema = z.enum([
  "next-prompt",
  "automatic-analysis",
  "automatic-action",
]);
export type OutputDeliveryMode = z.infer<typeof outputDeliveryModeSchema>;

export const desktopOutputAssignmentSchema = outputSubscriptionSchema.extend({
  agentInstanceId: z.string().uuid().optional(),
});
export type DesktopOutputAssignment = z.infer<
  typeof desktopOutputAssignmentSchema
>;

export const desktopOutputConnectionSchema = z.object({
  connectionId: z.string().min(1),
  producerId: z.string().min(1),
  instanceId: z.string().min(1),
  displayName: z.string().min(1),
  signalKind: z.enum(["midi", "audio"]),
  state: z.enum(["connected", "stale", "disconnected"]),
  receiving: z.boolean(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  track: z
    .object({
      id: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      name: z.string().optional(),
    })
    .optional(),
  device: z
    .object({ id: z.string().optional(), name: z.string().optional() })
    .optional(),
});
export type DesktopOutputConnection = z.infer<
  typeof desktopOutputConnectionSchema
>;

export const latestAcceptedOutputSchema = z.object({
  assignmentId: z.string().min(1),
  producerId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
  summary: z.string().max(2048),
});
export type LatestAcceptedOutput = z.infer<typeof latestAcceptedOutputSchema>;

export const signalServiceStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("disabled"), detail: z.string() }),
  z.object({ state: z.literal("stopped") }),
  z.object({
    state: z.literal("listening"),
    host: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({ state: z.literal("error"), detail: z.string() }),
]);
export type SignalServiceStatus = z.infer<typeof signalServiceStatusSchema>;

export const desktopOutputsStateSchema = z.object({
  status: signalServiceStatusSchema,
  connections: z.array(desktopOutputConnectionSchema),
  assignments: z.array(desktopOutputAssignmentSchema),
  latest: z.array(latestAcceptedOutputSchema),
  activeSessionId: z.string().optional(),
});
export type DesktopOutputsState = z.infer<typeof desktopOutputsStateSchema>;

const liveEventLocatorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  occurrence: z.number().int().nonnegative().default(0),
});
const desktopTrackEventTargetSchema = z.object({
  track: liveEventLocatorSchema,
});
const desktopParameterEventTargetSchema = desktopTrackEventTargetSchema.extend({
  device: liveEventLocatorSchema,
  parameter: liveEventLocatorSchema,
});
const desktopLiveEventObservationPolicySchema = z.object({
  minimumNormalizedDelta: z.number().min(0).max(1),
  throttleMs: z.number().int().nonnegative().max(60_000),
});

export const liveEventDefinitionDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("parameter.value_changed"),
      classification: z.literal("continuous"),
      name: z.string().trim().min(1).max(160),
      enabled: z.boolean(),
      target: desktopParameterEventTargetSchema,
      observationPolicy: desktopLiveEventObservationPolicySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("track.playing_clip_changed"),
      classification: z.literal("discrete"),
      name: z.string().trim().min(1).max(160),
      enabled: z.boolean(),
      target: desktopTrackEventTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("track.triggered_clip_changed"),
      classification: z.literal("discrete"),
      name: z.string().trim().min(1).max(160),
      enabled: z.boolean(),
      target: desktopTrackEventTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("track.recording_state_changed"),
      classification: z.literal("discrete"),
      name: z.string().trim().min(1).max(160),
      enabled: z.boolean(),
      target: desktopTrackEventTargetSchema,
    })
    .strict(),
]);
export type LiveEventDefinitionDraft = z.infer<
  typeof liveEventDefinitionDraftSchema
>;

export const desktopAgentEventListenerSchema = z.object({
  agentInstanceId: z.string().uuid().optional(),
  agentLabel: z.string().min(1).max(128),
  listener: agentEventListenerSchema,
  preparedContextStatus: z
    .discriminatedUnion("state", [
      z.object({ state: z.literal("unavailable") }),
      z.object({
        state: z.enum(["fresh", "stale"]),
        capturedAt: z.string().datetime(),
        projectId: z.string().min(1),
        projectRevision: z.number().int().nonnegative().optional(),
        unresolvedTrackLocators: z.number().int().positive().optional(),
      }),
    ])
    .optional(),
});
export type DesktopAgentEventListener = z.infer<
  typeof desktopAgentEventListenerSchema
>;

export const desktopLiveEventStateSchema = z.object({
  definition: liveEventDefinitionSchema,
  resolution: liveEventResolutionSchema,
  latestState: liveEventInitialStateSchema.optional(),
  history: z.array(liveEventOccurrenceSchema),
  listeners: z.array(desktopAgentEventListenerSchema),
});
export type DesktopLiveEventState = z.infer<typeof desktopLiveEventStateSchema>;

export const desktopEventsStateSchema = z.object({
  events: z.array(desktopLiveEventStateSchema),
  activeSessionId: z.string().min(1).optional(),
});
export type DesktopEventsState = z.infer<typeof desktopEventsStateSchema>;
export type LiveEventSelection = z.infer<
  typeof inspectEventSelectionResultSchema
>;

export const planSectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  startBar: z.number().int().positive(),
  endBar: z.number().int().positive(),
  tracks: z.array(z.string()),
  status: z.enum(["proposed", "approved", "completed", "partial", "failed"]),
});
export type PlanSection = z.infer<typeof planSectionSchema>;

export const approvalSchema = z.object({
  id: z.string(),
  title: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  changes: z.array(z.string()),
  destructive: z.boolean(),
});
export type ApprovalRequest = z.infer<typeof approvalSchema>;

export const operationSchema = z.object({
  id: z.string(),
  label: z.string(),
  toolName: z.string().min(1).max(128).optional(),
  status: z.enum(["running", "completed", "partial", "failed", "cancelled"]),
  detail: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  changed: z.array(z.string()).default([]),
  unchanged: z.array(z.string()).default([]),
  retryable: z.boolean().default(false),
  undoable: z.boolean().default(false),
  timestamp: z.number(),
});
export type OperationView = z.infer<typeof operationSchema>;

export const liveEventTriggerSchema = z.object({
  deliveryId: z.string().min(1).max(4_121),
  occurrenceId: z.string().uuid(),
  eventId: z.string().min(1).max(256),
  listenerId: z.string().min(1).max(4_121),
  agentInstanceId: z.string().uuid(),
  sdkSessionId: z.string().min(1),
  kind: z.string().min(1).max(128),
  sourceTrack: z.string().min(1).max(512),
  state: liveEventInitialStateSchema,
  observedAt: z.string().datetime(),
  messagePrefix: z.string().max(4_096).optional(),
  occurrence: z.string().max(12_000),
  summary: z.string().min(1).max(2_048),
  status: z.enum(["queued", "completed", "failed"]),
  updatedAt: z.string().datetime(),
  error: z.string().max(2_048).optional(),
});
export type LiveEventTrigger = z.infer<typeof liveEventTriggerSchema>;
export const MAX_AGENT_TRIGGER_HISTORY = 200;
export const agentModeSchema = z.enum(["interactive", "plan"]);
export const agentPlanExitActionSchema = z.enum(["exit_only", "interactive"]);
export type DesktopAgentMode = z.infer<typeof agentModeSchema>;

export const agentPlanApprovalSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    summary: z.string().max(8_192),
    planContent: z.string().max(100_000),
    planRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    planUpdatedAt: z.string().datetime(),
    recommendedAction: agentPlanExitActionSchema,
    actions: z.array(agentPlanExitActionSchema).min(1).max(2),
  })
  .strict();
export type DesktopAgentPlanApproval = z.infer<typeof agentPlanApprovalSchema>;

export const planArtifactSnapshotSchema = z.discriminatedUnion("exists", [
  z
    .object({
      exists: z.literal(false),
      productionSessionId: z.string().min(1).max(4_096),
    })
    .strict(),
  z
    .object({
      exists: z.literal(true),
      productionSessionId: z.string().min(1).max(4_096),
      content: z.string().max(100_000),
      revision: z.string().regex(/^[a-f0-9]{64}$/u),
      updatedAt: z.string().datetime(),
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(256 * 1024),
    })
    .strict(),
]);
export type DesktopPlanArtifactSnapshot = z.infer<
  typeof planArtifactSnapshotSchema
>;

const elicitationStringFieldSchema = z
  .object({
    type: z.literal("string"),
    title: z.string().max(512).optional(),
    description: z.string().max(2_048).optional(),
    enum: z.array(z.string().max(4_096)).max(100).optional(),
    enumNames: z.array(z.string().max(512)).max(100).optional(),
    oneOf: z
      .array(
        z.object({
          const: z.string().max(4_096),
          title: z.string().max(512),
        }),
      )
      .max(100)
      .optional(),
    allowFreeform: z.boolean().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().max(100_000).optional(),
    format: z.enum(["email", "uri", "date", "date-time"]).optional(),
    default: z.string().max(100_000).optional(),
  })
  .strict();
const elicitationArrayFieldSchema = z
  .object({
    type: z.literal("array"),
    title: z.string().max(512).optional(),
    description: z.string().max(2_048).optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().max(100).optional(),
    items: z.union([
      z
        .object({
          type: z.literal("string"),
          enum: z.array(z.string().max(4_096)).max(100),
        })
        .strict(),
      z
        .object({
          anyOf: z
            .array(
              z.object({
                const: z.string().max(4_096),
                title: z.string().max(512),
              }),
            )
            .max(100),
        })
        .strict(),
    ]),
    default: z.array(z.string().max(4_096)).max(100).optional(),
  })
  .strict();
const elicitationBooleanFieldSchema = z
  .object({
    type: z.literal("boolean"),
    title: z.string().max(512).optional(),
    description: z.string().max(2_048).optional(),
    default: z.boolean().optional(),
  })
  .strict();
const elicitationNumberFieldSchema = z
  .object({
    type: z.enum(["number", "integer"]),
    title: z.string().max(512).optional(),
    description: z.string().max(2_048).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    default: z.number().finite().optional(),
  })
  .strict();
export const agentElicitationRequestSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    message: z.string().min(1).max(8_192),
    properties: z
      .record(
        z.string().min(1).max(256),
        z.union([
          elicitationStringFieldSchema,
          elicitationArrayFieldSchema,
          elicitationBooleanFieldSchema,
          elicitationNumberFieldSchema,
        ]),
      )
      .refine((properties) => Object.keys(properties).length <= 32),
    required: z.array(z.string().min(1).max(256)).max(32),
  })
  .strict();
export type DesktopAgentElicitationRequest = z.infer<
  typeof agentElicitationRequestSchema
>;
export const agentElicitationValueSchema = z.union([
  z.string().max(100_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(4_096)).max(100),
]);

const forkedAgentHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string().min(1),
  eventId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  agentMode: agentModeSchema.optional(),
});

export const desktopActiveAgentSchema = activeAgentInstanceSchema.extend({
  mode: agentModeSchema.optional(),
  boundTracks: activeAgentInstanceSchema.shape.boundTracks.default([]),
  outputSubscriptions: z.array(desktopOutputAssignmentSchema).default([]),
  forkedHistory: z.array(forkedAgentHistoryMessageSchema).optional(),
  triggerHistory: z
    .array(liveEventTriggerSchema)
    .max(MAX_AGENT_TRIGGER_HISTORY)
    .optional(),
});
export type DesktopActiveAgent = z.infer<typeof desktopActiveAgentSchema>;

export const desktopAgentModelSchema = z
  .object({
    id: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    policyState: z.enum(["enabled", "disabled", "unconfigured"]),
    capabilities: z
      .object({
        vision: z.boolean(),
        reasoningEffort: z.boolean(),
        maxPromptTokens: z.number().int().positive().optional(),
        maxContextWindowTokens: z.number().int().positive().optional(),
      })
      .strict(),
    supportedReasoningEfforts: z.array(z.string().min(1).max(64)).max(16),
    defaultReasoningEffort: z.string().min(1).max(64).optional(),
  })
  .strict();
export type DesktopAgentModel = z.infer<typeof desktopAgentModelSchema>;
export const desktopAgentModelsSchema = z
  .array(desktopAgentModelSchema)
  .max(256);

export const desktopAgentConversationSettingsSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    reasoningEffort: agentReasoningEffortSchema.optional(),
  })
  .strict();
export type DesktopAgentConversationSettings = z.infer<
  typeof desktopAgentConversationSettingsSchema
>;

export const autoApprovalTargetSchema = z.union([
  z.literal("all"),
  z.string().uuid(),
]);
export type AutoApprovalTarget = z.infer<typeof autoApprovalTargetSchema>;

export const desktopAgentConfigOverridesSchema =
  desktopActiveAgentSchema.shape.config.partial().strict();
export type DesktopAgentConfigOverrides = z.infer<
  typeof desktopAgentConfigOverridesSchema
>;

export const desktopAgentHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string().min(1),
  eventId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  agentInstanceId: z.string().uuid(),
  sdkSessionId: z.string().min(1).optional(),
  agentMode: agentModeSchema.optional(),
});
export type DesktopAgentHistoryMessage = z.infer<
  typeof desktopAgentHistoryMessageSchema
>;

export const sessionSchema = z
  .object({
    version: z.literal(3),
    id: z.string().min(1),
    title: z.string().min(1),
    updatedAt: z.string().min(1),
    projectName: z.string().min(1),
    projectId: z.string().optional(),
    activeAgents: z.array(desktopActiveAgentSchema).default([]),
    selectedAgentInstanceId: z.string().uuid().optional(),
    productionPlan: z.array(planSectionSchema).default([]),
    outputAssignments: z.array(desktopOutputAssignmentSchema).default([]),
    liveEvents: z
      .array(liveEventDefinitionSchema)
      .max(MAX_LIVE_EVENTS_PER_SESSION)
      .default([]),
  })
  .superRefine((session, context) => {
    const instanceIds = session.activeAgents.map(({ id }) => id);
    if (new Set(instanceIds).size !== instanceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["activeAgents"],
        message: "Active agent instance IDs must be unique",
      });
    }
    if (
      session.selectedAgentInstanceId !== undefined &&
      !instanceIds.includes(session.selectedAgentInstanceId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedAgentInstanceId"],
        message: "Selected agent instance must belong to the session",
      });
    }
    if (
      session.activeAgents.length > 0 &&
      session.selectedAgentInstanceId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedAgentInstanceId"],
        message: "A session with active agents must select one",
      });
    }
    const eventIds = session.liveEvents.map(({ id }) => id);
    if (new Set(eventIds).size !== eventIds.length) {
      context.addIssue({
        code: "custom",
        path: ["liveEvents"],
        message: "Live event IDs must be unique",
      });
    }
    const eventIdSet = new Set(eventIds);
    const listenerIds = new Set<string>();
    for (const [agentIndex, agent] of session.activeAgents.entries()) {
      for (const [listenerIndex, listener] of agent.eventListeners.entries()) {
        if (listenerIds.has(listener.id)) {
          context.addIssue({
            code: "custom",
            path: [
              "activeAgents",
              agentIndex,
              "eventListeners",
              listenerIndex,
              "id",
            ],
            message: "Agent event listener IDs must be unique",
          });
        }
        listenerIds.add(listener.id);
        if (!eventIdSet.has(listener.eventId)) {
          context.addIssue({
            code: "custom",
            path: [
              "activeAgents",
              agentIndex,
              "eventListeners",
              listenerIndex,
              "eventId",
            ],
            message: "Agent event listeners must reference a session event",
          });
        }
      }
    }
  });
export type DesktopSession = z.infer<typeof sessionSchema>;

export const versionTwoSessionSchema = z.object({
  version: z.literal(2),
  id: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string().min(1),
  projectName: z.string().min(1),
  projectId: z.string().optional(),
  activeAgents: z.array(desktopActiveAgentSchema).default([]),
  selectedAgentInstanceId: z.string().uuid().optional(),
  productionPlan: z.array(planSectionSchema).default([]),
  outputAssignments: z.array(desktopOutputAssignmentSchema).default([]),
});

export const desktopAutoApprovalUpdateSchema = z.object({
  instances: z.array(desktopActiveAgentSchema),
  session: sessionSchema,
});
export type DesktopAutoApprovalUpdate = z.infer<
  typeof desktopAutoApprovalUpdateSchema
>;

export const preferencesSchema = z.object({
  version: z.literal(1).default(1),
  approvalPolicy: z
    .enum(["always", "risky", "never", "approve-all"])
    .default("risky"),
  abletonPort: z.number().int().min(1).max(65535).default(8765),
  signalPort: z.number().int().min(1).max(65535).default(45832),
  remoteScriptLocation: z.string().default("Auto-detect"),
  loggingLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  agentTurnTimeoutMinutes: z.number().int().min(1).max(120).default(10),
  agentReasoningVisibility: z
    .enum(["none", "concise", "detailed"])
    .default("concise"),
  eventHistoryEnabled: z.boolean().default(true),
  eventHistoryRetentionDays: z.number().finite().positive().default(30),
  eventHistoryMaxBytes: z
    .number()
    .int()
    .positive()
    .default(250 * 1024 * 1024),
  eventsViewMode: z.enum(["live", "history"]).default("live"),
  workflowDensity: z.enum(["compact", "comfortable"]).default("comfortable"),
  alwaysOnTop: z.boolean().default(false),
});
export type DesktopPreferences = z.infer<typeof preferencesSchema>;

export const diagnosticCheckSchema = z.object({
  label: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  detail: z.string(),
});
export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>;

export const desktopDiagnosticsReportSchema = z.object({
  checks: z.array(diagnosticCheckSchema),
  storage: z.object({
    version: z.number().int().positive(),
    root: z.string().min(1),
    profile: z.string().min(1),
    profileRoot: z.string().min(1),
    migrationStatus: z.enum(["completed", "not-needed", "failed"]),
  }),
  logging: z.object({
    level: z.enum(["error", "warn", "info", "debug"]),
    fileName: z.string().min(1),
    filePath: z.string().min(1),
    environmentOverride: z.boolean().optional(),
  }),
});
export type DesktopDiagnosticsReport = z.infer<
  typeof desktopDiagnosticsReportSchema
>;

const desktopTrackScopeSelectorSchema = z.object({
  track: z.object({
    name: z.string().min(1),
    occurrence: z.number().int().nonnegative(),
  }),
});

export const desktopAgentDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string().min(1)),
  resolvedTools: z.array(z.string().min(1)),
  editScope: z.array(
    z.union([z.literal("session"), desktopTrackScopeSelectorSchema]),
  ),
  skills: z.array(z.string().min(1)),
  inputChannels: z.array(z.string().min(1)),
  sourceFile: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type DesktopAgentDefinition = z.infer<
  typeof desktopAgentDefinitionSchema
>;

export const desktopAgentCatalogSchema = z.object({
  definitions: z.array(desktopAgentDefinitionSchema).default([]),
  skills: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        sourceFile: z.string().min(1),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .default([]),
  diagnostics: z
    .array(
      z.object({
        sourceFile: z.string().min(1),
        code: z.string().min(1),
        message: z.string().min(1),
      }),
    )
    .default([]),
});
export type DesktopAgentCatalog = z.infer<typeof desktopAgentCatalogSchema>;

export const desktopArtifactKindSchema = z.enum(["agent", "skill"]);
export type DesktopArtifactKind = z.infer<typeof desktopArtifactKindSchema>;

export const desktopArtifactScopeSchema = z.enum([
  "system",
  "profile",
  "session",
]);
export type DesktopArtifactScope = z.infer<typeof desktopArtifactScopeSchema>;

export const desktopArtifactOriginSchema = z.enum([
  "bundled",
  "system",
  "profile",
  "session",
]);
export type DesktopArtifactOrigin = z.infer<typeof desktopArtifactOriginSchema>;

export const desktopScopedArtifactSchema = z
  .object({
    kind: desktopArtifactKindSchema,
    name: z.string().min(1).max(128),
    description: z.string().max(2_048).default(""),
    scope: desktopArtifactScopeSchema,
    origin: desktopArtifactOriginSchema,
    state: z.enum(["local", "inherited", "overridden", "disabled"]),
    sourceFile: z.string().min(1).max(512),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    profile: z.string().min(1).max(64).optional(),
    sessionId: z.string().min(1).max(4_096).optional(),
    overriddenOrigins: z.array(desktopArtifactOriginSchema).max(4).default([]),
    diagnostics: z.array(z.string().max(2_048)).max(20).default([]),
  })
  .strict();
export type DesktopScopedArtifact = z.infer<typeof desktopScopedArtifactSchema>;

export const desktopProfileSessionSummarySchema = z
  .object({
    id: z.string().min(1).max(4_096),
    title: z.string().min(1).max(512),
    active: z.boolean(),
  })
  .strict();
export type DesktopProfileSessionSummary = z.infer<
  typeof desktopProfileSessionSummarySchema
>;

export const desktopProfileSummarySchema = z
  .object({
    name: z.string().min(1).max(64),
    active: z.boolean(),
    reserved: z.boolean(),
    sessionCount: z.number().int().nonnegative(),
    sessions: z.array(desktopProfileSessionSummarySchema).max(10_000),
  })
  .strict();
export type DesktopProfileSummary = z.infer<typeof desktopProfileSummarySchema>;

export const desktopProfileManagerSnapshotSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    activeProfile: z.string().min(1).max(64),
    selectedProfile: z.string().min(1).max(64),
    activeSessionId: z.string().min(1).optional(),
    switchingDisabledReason: z.string().max(2_048).optional(),
    profiles: z.array(desktopProfileSummarySchema).max(128),
    artifacts: z.array(desktopScopedArtifactSchema).max(2_000),
  })
  .strict();
export type DesktopProfileManagerSnapshot = z.infer<
  typeof desktopProfileManagerSnapshotSchema
>;

export const desktopArtifactLocationSchema = z
  .object({
    scope: desktopArtifactOriginSchema,
    profile: z.string().min(1).max(64).optional(),
    sessionId: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export type DesktopArtifactLocation = z.infer<
  typeof desktopArtifactLocationSchema
>;

export const desktopArtifactConflictSchema = z
  .object({
    kind: desktopArtifactKindSchema,
    name: z.string().min(1).max(128),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    destinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceDescription: z.string().max(2_048),
    destinationDescription: z.string().max(2_048),
    suggestedName: z.string().min(1).max(128),
  })
  .strict();
export type DesktopArtifactConflict = z.infer<
  typeof desktopArtifactConflictSchema
>;

export const desktopArtifactMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        snapshot: desktopProfileManagerSnapshotSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("conflict"),
        conflict: desktopArtifactConflictSchema,
      })
      .strict(),
  ],
);
export type DesktopArtifactMutationResult = z.infer<
  typeof desktopArtifactMutationResultSchema
>;

const profileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u);

const artifactMutationBaseSchema = z
  .object({
    kind: desktopArtifactKindSchema,
    name: z.string().min(1).max(128),
    source: desktopArtifactLocationSchema,
    destination: desktopArtifactLocationSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    conflictResolution: z.enum(["replace", "rename"]).optional(),
    renamedName: z.string().min(1).max(128).optional(),
  })
  .strict();

export const appEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("lifecycle.changed"),
    state: z.enum(lifecycleStates),
  }),
  z.object({
    type: z.literal("ableton.connection_changed"),
    status: connectionStatusSchema,
  }),
  z.object({
    type: z.literal("agent.message_delta"),
    messageId: z.string(),
    content: z.string(),
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.message_complete"),
    messageId: z.string(),
    content: z.string(),
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.working_update"),
    messageId: z.string(),
    update: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("started"),
        activityId: z.string().uuid(),
        occurredAt: z.string().datetime(),
      }),
      z.object({
        kind: z.literal("intent"),
        activityId: z.string().uuid(),
        content: z.string().max(16_000),
        occurredAt: z.string().datetime(),
      }),
      z.object({
        kind: z.literal("reasoning_delta"),
        activityId: z.string().uuid(),
        reasoningId: z.string().min(1).max(256),
        content: z.string().max(16_000),
        occurredAt: z.string().datetime(),
      }),
      z.object({
        kind: z.literal("reasoning_complete"),
        activityId: z.string().uuid(),
        reasoningId: z.string().min(1).max(256),
        content: z.string().max(16_000),
        occurredAt: z.string().datetime(),
      }),
      z.object({
        kind: z.literal("streaming"),
        activityId: z.string().uuid(),
        totalResponseSizeBytes: z.number().int().nonnegative(),
        occurredAt: z.string().datetime(),
      }),
      z.object({
        kind: z.literal("finished"),
        activityId: z.string().uuid(),
        outcome: z.enum(["completed", "failed", "cancelled"]),
        detail: z.string().max(16_000).optional(),
        occurredAt: z.string().datetime(),
      }),
    ]),
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.user_message_submitted"),
    messageId: z.string().uuid(),
    content: z.string().min(1).max(16_000),
    agentInstanceId: z.string().uuid().optional(),
    agentMode: agentModeSchema,
    origin: z.literal("automation"),
    timestamp: z.number().finite().nonnegative(),
    traceId: z.string().uuid(),
    correlationId: z.string().uuid(),
    causationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("agent.mode_changed"),
    mode: agentModeSchema,
    previousMode: agentModeSchema,
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.plan_changed"),
    operation: z.string().min(1).max(256),
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.plan_approval_requested"),
    request: agentPlanApprovalSchema,
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.plan_artifact_changed"),
    artifact: planArtifactSnapshotSchema,
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.plan_approval_completed"),
    requestId: z.string().min(1).max(256),
    approved: z.boolean(),
    selectedAction: agentPlanExitActionSchema.optional(),
    feedback: z.string().max(8_192).optional(),
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.elicitation_requested"),
    request: agentElicitationRequestSchema,
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.elicitation_completed"),
    requestId: z.string().min(1).max(256),
    action: z.enum(["accept", "decline", "cancel"]),
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("operation.changed"),
    operation: operationSchema,
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("agent.instance_changed"),
    instance: desktopActiveAgentSchema,
    change: z.enum([
      "created",
      "renamed",
      "configured",
      "reset",
      "selected",
      "deactivated",
      "lifecycle",
      "session-rotated",
      "conversation-settings-changed",
      "mode-changed",
    ]),
  }),
  z.object({
    type: z.literal("agent.live_event_trigger_changed"),
    trigger: liveEventTriggerSchema,
  }),
  z.object({
    type: z.literal("agent.history_hydrated"),
    agentInstanceId: z.string().uuid(),
    sdkSessionId: z.string().min(1).optional(),
    history: z.array(desktopAgentHistoryMessageSchema),
  }),
  z.object({
    type: z.literal("approval.requested"),
    approval: approvalSchema,
    agentInstanceId: z.string().uuid().optional(),
    sdkSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("project.snapshot_changed"),
    snapshot: projectSnapshotSchema,
  }),
  z.object({
    type: z.literal("sessions.changed"),
    sessions: z.array(sessionSchema),
    activeSessionId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("session.context_restored"),
    session: sessionSchema,
  }),
  z.object({
    type: z.literal("project.transition_requested"),
    transition: pendingProjectTransitionSchema,
  }),
  z.object({
    type: z.literal("project.transition_cleared"),
    token: z.string().uuid(),
  }),
  z.object({
    type: z.literal("preferences.changed"),
    preferences: preferencesSchema,
  }),
  z.object({
    type: z.literal("outputs.changed"),
    outputs: desktopOutputsStateSchema,
  }),
  z.object({
    type: z.literal("events.changed"),
    events: desktopEventsStateSchema,
  }),
  z.object({
    type: z.literal("agents.catalog_changed"),
    catalog: desktopAgentCatalogSchema,
  }),
  z.object({
    type: z.literal("diagnostic"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
]);
export type DesktopAppEvent = z.infer<typeof appEventSchema>;

export const ipcSchemas = {
  "app:lifecycle": {
    request: z.object({}),
    response: z.object({
      state: z.enum(lifecycleStates),
    }),
  },
  "agent:send": {
    request: z.object({
      message: z.string().trim().min(1).max(20_000),
      context: z.array(contextChipSchema).max(20),
    }),
    response: z.object({ accepted: z.literal(true), messageId: z.string() }),
  },
  "agent:cancel": {
    request: z.object({}),
    response: z.object({ cancelled: z.boolean() }),
  },
  "agent:create-session": {
    request: z.object({}),
    response: z.object({ sessionId: z.string() }),
  },
  "agent:sessions": {
    request: z.object({}),
    response: z.array(sessionSchema),
  },
  "agent:resume-session": {
    request: z.object({ sessionId: z.string().min(1) }),
    response: z.object({ resumed: z.literal(true) }),
  },
  "agent:close-session": {
    request: z.object({}).strict(),
    response: z.object({ closed: z.literal(true) }).strict(),
  },
  "agents:catalog": {
    request: z.object({}),
    response: desktopAgentCatalogSchema,
  },
  "agents:refresh": {
    request: z.object({}),
    response: desktopAgentCatalogSchema,
  },
  "agents:active": {
    request: z.object({}),
    response: z.array(desktopActiveAgentSchema),
  },
  "agents:models": {
    request: z.object({}).strict(),
    response: desktopAgentModelsSchema,
  },
  "agents:create": {
    request: z.object({ definitionName: z.string().min(1) }).strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:rename": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        label: z.string().trim().min(1).max(128),
      })
      .strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:configure": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        overrides: desktopAgentConfigOverridesSchema,
      })
      .strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:reset": {
    request: z.object({ instanceId: z.string().uuid() }).strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:select": {
    request: z.object({ instanceId: z.string().uuid() }).strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:set-conversation-settings": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        settings: desktopAgentConversationSettingsSchema,
      })
      .strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:set-auto-approval": {
    request: z
      .object({
        target: autoApprovalTargetSchema,
        enabled: z.boolean(),
      })
      .strict(),
    response: desktopAutoApprovalUpdateSchema,
  },
  "agents:deactivate": {
    request: z.object({ instanceId: z.string().uuid() }).strict(),
    response: z.object({ deactivated: z.literal(true) }),
  },
  "agents:history": {
    request: z.object({ instanceId: z.string().uuid() }).strict(),
    response: z.array(desktopAgentHistoryMessageSchema),
  },
  "agents:send": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        message: z.string().trim().min(1).max(20_000),
        context: z.array(contextChipSchema).max(20),
        agentMode: agentModeSchema.optional(),
      })
      .strict(),
    response: z.object({ accepted: z.literal(true), messageId: z.string() }),
  },
  "agents:set-mode": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        mode: agentModeSchema,
      })
      .strict(),
    response: desktopActiveAgentSchema,
  },
  "agents:resolve-plan": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        requestId: z.string().min(1).max(256),
        approved: z.boolean(),
        planRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
        selectedAction: agentPlanExitActionSchema.optional(),
        feedback: z.string().trim().max(8_192).optional(),
      })
      .strict(),
    response: z.object({ resolved: z.boolean() }),
  },
  "agents:read-plan": {
    request: z.object({ instanceId: z.string().uuid() }).strict(),
    response: planArtifactSnapshotSchema,
  },
  "agents:write-plan": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        content: z.string().min(1).max(100_000),
        expectedRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .optional(),
      })
      .strict(),
    response: planArtifactSnapshotSchema,
  },
  "agents:resolve-elicitation": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        requestId: z.string().min(1).max(256),
        action: z.enum(["accept", "decline", "cancel"]),
        content: z
          .record(z.string().min(1).max(256), agentElicitationValueSchema)
          .optional(),
      })
      .strict(),
    response: z.object({ resolved: z.boolean() }),
  },
  "agents:invoke-skill": {
    request: z
      .object({
        instanceId: z.string().uuid(),
        skillName: z.string().min(1),
        request: z.string().max(20_000).default(""),
        context: z.array(contextChipSchema).max(20),
        agentMode: agentModeSchema.optional(),
      })
      .strict(),
    response: z.object({ accepted: z.literal(true), messageId: z.string() }),
  },
  "agents:cancel": {
    request: z.object({ instanceId: z.string().uuid() }).strict(),
    response: z.object({ cancelled: z.boolean() }),
  },
  "profiles:get": {
    request: z
      .object({ selectedProfile: profileNameSchema.optional() })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "profiles:create": {
    request: z
      .object({
        name: profileNameSchema,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "profiles:rename": {
    request: z
      .object({
        name: profileNameSchema,
        newName: profileNameSchema,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "profiles:delete": {
    request: z
      .object({
        name: profileNameSchema,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "profiles:switch": {
    request: z
      .object({
        name: profileNameSchema,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: z.object({ switching: z.literal(true) }).strict(),
  },
  "profiles:copy-artifact": {
    request: artifactMutationBaseSchema,
    response: desktopArtifactMutationResultSchema,
  },
  "profiles:move-artifact": {
    request: artifactMutationBaseSchema,
    response: desktopArtifactMutationResultSchema,
  },
  "profiles:rename-artifact": {
    request: z
      .object({
        kind: desktopArtifactKindSchema,
        name: z.string().min(1).max(128),
        newName: z.string().min(1).max(128),
        location: desktopArtifactLocationSchema,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "profiles:delete-artifact": {
    request: z
      .object({
        kind: desktopArtifactKindSchema,
        name: z.string().min(1).max(128),
        location: desktopArtifactLocationSchema,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "profiles:set-artifact-disabled": {
    request: z
      .object({
        kind: desktopArtifactKindSchema,
        name: z.string().min(1).max(128),
        location: desktopArtifactLocationSchema,
        disabled: z.boolean(),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    response: desktopProfileManagerSnapshotSchema,
  },
  "ableton:connect": {
    request: z.object({}),
    response: connectionStatusSchema,
  },
  "ableton:status": { request: z.object({}), response: connectionStatusSchema },
  "ableton:capabilities": {
    request: z.object({}),
    response: z.array(z.string()),
  },
  "ableton:snapshot": {
    request: z.object({}),
    response: projectSnapshotSchema,
  },
  "diagnostics:get": {
    request: z.object({}),
    response: desktopDiagnosticsReportSchema,
  },
  "diagnostics:reveal-log": {
    request: z.object({}),
    response: z.object({ revealed: z.literal(true) }),
  },
  "diagnostics:export-support-bundle": {
    request: z.object({}),
    response: z.discriminatedUnion("status", [
      z.object({ status: z.literal("cancelled") }),
      z.object({ status: z.literal("saved"), filePath: z.string().min(1) }),
    ]),
  },
  "diagnostics:copy-summary": {
    request: z.object({}),
    response: z.object({ copied: z.literal(true) }),
  },
  "approvals:resolve": {
    request: z.object({
      id: z.string(),
      decision: z.enum(["approve", "deny"]),
    }),
    response: z.object({ resolved: z.boolean() }),
  },
  "preferences:get": { request: z.object({}), response: preferencesSchema },
  "preferences:set": {
    request: preferencesSchema,
    response: preferencesSchema,
  },
  "project:set-context": {
    request: z.object({ context: z.array(contextChipSchema).max(20) }),
    response: z.object({ updated: z.literal(true) }),
  },
  "project:resolve-transition": {
    request: z
      .object({
        token: z.string().uuid(),
        decision: projectTransitionDecisionSchema,
      })
      .strict(),
    response: z.object({ session: sessionSchema }),
  },
  "plan:update": {
    request: z.object({ sections: z.array(planSectionSchema).max(100) }),
    response: z.object({ updated: z.literal(true) }),
  },
  "operation:retry": {
    request: z.object({ id: z.string() }),
    response: z.object({ accepted: z.boolean() }),
  },
  "operation:undo": {
    request: z.object({ id: z.string() }),
    response: z.object({ accepted: z.boolean() }),
  },
  "outputs:list": {
    request: z.object({}),
    response: desktopOutputsStateSchema,
  },
  "outputs:assign": {
    request: z.object({
      agentInstanceId: z.string().uuid(),
      producerId: z.string().min(1),
    }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:unassign": {
    request: z.object({
      agentInstanceId: z.string().uuid(),
      producerId: z.string().min(1),
    }),
    response: z.object({ removed: z.boolean() }),
  },
  "outputs:set-enabled": {
    request: z.object({
      agentInstanceId: z.string().uuid(),
      producerId: z.string().min(1),
      enabled: z.boolean(),
    }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:set-delivery-mode": {
    request: z.object({
      agentInstanceId: z.string().uuid(),
      producerId: z.string().min(1),
      deliveryMode: outputDeliveryModeSchema,
    }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:set-usage-instruction": {
    request: z.object({
      agentInstanceId: z.string().uuid(),
      producerId: z.string().min(1),
      usageInstruction: z.string().trim().min(1).max(4096),
    }),
    response: desktopOutputAssignmentSchema,
  },
  "outputs:set-processing-policies": {
    request: z.object({
      agentInstanceId: z.string().uuid(),
      producerId: z.string().min(1),
      processingPolicyIds: z.array(z.string().min(1)).max(64),
    }),
    response: desktopOutputAssignmentSchema,
  },
  "events:list": {
    request: z.object({}).strict(),
    response: desktopEventsStateSchema,
  },
  "events:inspect-selection": {
    request: z.object({}).strict(),
    response: inspectEventSelectionResultSchema,
  },
  "events:create": {
    request: z.object({ definition: liveEventDefinitionDraftSchema }).strict(),
    response: liveEventDefinitionSchema,
  },
  "events:update": {
    request: z
      .object({
        eventId: liveEventDefinitionSchema.options[0].shape.id,
        definition: liveEventDefinitionDraftSchema,
      })
      .strict(),
    response: liveEventDefinitionSchema,
  },
  "events:enable": {
    request: z
      .object({ eventId: liveEventDefinitionSchema.options[0].shape.id })
      .strict(),
    response: liveEventDefinitionSchema,
  },
  "events:disable": {
    request: z
      .object({ eventId: liveEventDefinitionSchema.options[0].shape.id })
      .strict(),
    response: liveEventDefinitionSchema,
  },
  "events:delete": {
    request: z
      .object({ eventId: liveEventDefinitionSchema.options[0].shape.id })
      .strict(),
    response: z.object({ removed: z.boolean() }),
  },
  "events:assign-listener": {
    request: z
      .object({
        agentInstanceId: z.string().uuid(),
        eventId: liveEventDefinitionSchema.options[0].shape.id,
        enabled: z.boolean(),
        responseMode: agentEventListenerSchema.shape.responseMode,
        messagePrefix: agentEventListenerSchema.shape.messagePrefix,
        preparedContext: agentEventListenerSchema.shape.preparedContext,
      })
      .strict(),
    response: desktopAgentEventListenerSchema,
  },
  "events:unassign-listener": {
    request: z
      .object({
        agentInstanceId: z.string().uuid(),
        eventId: liveEventDefinitionSchema.options[0].shape.id,
      })
      .strict(),
    response: z.object({ removed: z.boolean() }),
  },
  "events:update-listener": {
    request: z
      .object({
        agentInstanceId: z.string().uuid(),
        eventId: liveEventDefinitionSchema.options[0].shape.id,
        enabled: z.boolean().optional(),
        responseMode: agentEventListenerSchema.shape.responseMode.optional(),
        messagePrefix: z
          .union([agentEventListenerSchema.shape.messagePrefix, z.null()])
          .optional(),
        preparedContext:
          agentEventListenerSchema.shape.preparedContext.optional(),
      })
      .strict()
      .refine(
        ({ enabled, responseMode, messagePrefix, preparedContext }) =>
          enabled !== undefined ||
          responseMode !== undefined ||
          messagePrefix !== undefined ||
          preparedContext !== undefined,
        "At least one listener setting must be provided",
      ),
    response: desktopAgentEventListenerSchema,
  },
  "event-history:search": {
    request: telemetryQuerySchema,
    response: rootTracePageSchema,
  },
  "event-history:trace": {
    request: z
      .object({
        traceId: telemetryIdSchema,
        cursor: z.string().min(1).max(256).optional(),
        limit: z.number().int().min(1).max(500).default(500),
        order: z.enum(["asc", "desc"]).default("asc"),
      })
      .strict(),
    response: traceEventPageSchema,
  },
  "event-history:configurations": {
    request: configurationSnapshotQuerySchema,
    response: configurationSnapshotPageSchema,
  },
  "event-history:health": {
    request: z.object({}).strict(),
    response: journalHealthSchema,
  },
  "event-history:get-retention": {
    request: z.object({}).strict(),
    response: retentionPolicySchema,
  },
  "event-history:set-retention": {
    request: retentionPolicySchema,
    response: retentionPolicySchema,
  },
  "event-history:prune": {
    request: z.object({}).strict(),
    response: retentionResultSchema,
  },
  "event-history:delete-trace": {
    request: z.object({ traceId: telemetryIdSchema }).strict(),
    response: z
      .object({ deletedEvents: z.number().int().nonnegative() })
      .strict(),
  },
  "event-history:clear": {
    request: z.object({}).strict(),
    response: z
      .object({
        deletedEvents: z.number().int().nonnegative(),
        deletedConfigurationSnapshots: z.number().int().nonnegative(),
      })
      .strict(),
  },
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type RequestOf<C extends IpcChannel> = z.infer<
  (typeof ipcSchemas)[C]["request"]
>;
export type ResponseOf<C extends IpcChannel> = z.infer<
  (typeof ipcSchemas)[C]["response"]
>;

export interface DesktopApi {
  lifecycle: {
    get(): Promise<DesktopLifecycleState>;
  };
  agent: {
    send(
      message: string,
      context: ContextChip[],
    ): Promise<{ accepted: true; messageId: string }>;
    cancel(): Promise<{ cancelled: boolean }>;
    createSession(): Promise<string>;
    getSessions(): Promise<DesktopSession[]>;
    resumeSession(sessionId: string): Promise<void>;
    closeSession(): Promise<void>;
  };
  agents: {
    getCatalog(): Promise<DesktopAgentCatalog>;
    refreshCatalog(): Promise<DesktopAgentCatalog>;
    listActive(): Promise<DesktopActiveAgent[]>;
    listModels(): Promise<DesktopAgentModel[]>;
    create(definitionName: string): Promise<DesktopActiveAgent>;
    rename(instanceId: string, label: string): Promise<DesktopActiveAgent>;
    configure(
      instanceId: string,
      overrides: DesktopAgentConfigOverrides,
    ): Promise<DesktopActiveAgent>;
    reset(instanceId: string): Promise<DesktopActiveAgent>;
    select(instanceId: string): Promise<DesktopActiveAgent>;
    setConversationSettings(
      instanceId: string,
      settings: DesktopAgentConversationSettings,
    ): Promise<DesktopActiveAgent>;
    setAutoApproval(
      target: AutoApprovalTarget,
      enabled: boolean,
    ): Promise<DesktopAutoApprovalUpdate>;
    deactivate(instanceId: string): Promise<void>;
    hydrateHistory(instanceId: string): Promise<DesktopAgentHistoryMessage[]>;
    send(
      instanceId: string,
      message: string,
      context: ContextChip[],
      agentMode?: AgentMode,
    ): Promise<{ accepted: true; messageId: string }>;
    setMode(
      instanceId: string,
      mode: DesktopAgentMode,
    ): Promise<DesktopActiveAgent>;
    resolvePlan(
      instanceId: string,
      request: {
        requestId: string;
        approved: boolean;
        planRevision?: string;
        selectedAction?: "exit_only" | "interactive";
        feedback?: string;
      },
    ): Promise<boolean>;
    readPlan(instanceId: string): Promise<DesktopPlanArtifactSnapshot>;
    writePlan(
      instanceId: string,
      input: { content: string; expectedRevision?: string },
    ): Promise<DesktopPlanArtifactSnapshot>;
    resolveElicitation(
      instanceId: string,
      request: {
        requestId: string;
        action: "accept" | "decline" | "cancel";
        content?: Readonly<
          Record<string, string | number | boolean | string[]>
        >;
      },
    ): Promise<boolean>;
    invokeSkill(
      instanceId: string,
      skillName: string,
      request: string,
      context: ContextChip[],
      agentMode?: AgentMode,
    ): Promise<{ accepted: true; messageId: string }>;
    cancel(instanceId: string): Promise<{ cancelled: boolean }>;
  };
  profiles: {
    get(selectedProfile?: string): Promise<DesktopProfileManagerSnapshot>;
    create(
      name: string,
      expectedRevision: string,
    ): Promise<DesktopProfileManagerSnapshot>;
    rename(
      name: string,
      newName: string,
      expectedRevision: string,
    ): Promise<DesktopProfileManagerSnapshot>;
    delete(
      name: string,
      expectedRevision: string,
    ): Promise<DesktopProfileManagerSnapshot>;
    switch(name: string, expectedRevision: string): Promise<void>;
    copyArtifact(
      request: z.input<typeof artifactMutationBaseSchema>,
    ): Promise<DesktopArtifactMutationResult>;
    moveArtifact(
      request: z.input<typeof artifactMutationBaseSchema>,
    ): Promise<DesktopArtifactMutationResult>;
    renameArtifact(request: {
      kind: DesktopArtifactKind;
      name: string;
      newName: string;
      location: DesktopArtifactLocation;
      expectedRevision: string;
    }): Promise<DesktopProfileManagerSnapshot>;
    deleteArtifact(request: {
      kind: DesktopArtifactKind;
      name: string;
      location: DesktopArtifactLocation;
      expectedRevision: string;
    }): Promise<DesktopProfileManagerSnapshot>;
    setArtifactDisabled(request: {
      kind: DesktopArtifactKind;
      name: string;
      location: DesktopArtifactLocation;
      disabled: boolean;
      expectedRevision: string;
    }): Promise<DesktopProfileManagerSnapshot>;
  };
  ableton: {
    connect(): Promise<DesktopConnectionStatus>;
    getStatus(): Promise<DesktopConnectionStatus>;
    getCapabilities(): Promise<string[]>;
    requestSnapshot(): Promise<DesktopProjectSnapshot>;
  };
  approvals: {
    resolve(id: string, decision: ApprovalDecision): Promise<boolean>;
  };
  diagnostics: {
    get(): Promise<DesktopDiagnosticsReport>;
    revealLog(): Promise<void>;
    exportSupportBundle(): Promise<
      { status: "cancelled" } | { status: "saved"; filePath: string }
    >;
    copySummary(): Promise<void>;
  };
  preferences: {
    get(): Promise<DesktopPreferences>;
    set(value: DesktopPreferences): Promise<DesktopPreferences>;
  };
  project: {
    setContext(context: ContextChip[]): Promise<void>;
    resolveTransition(
      token: string,
      decision: ProjectTransitionDecision,
    ): Promise<DesktopSession>;
  };
  plan: { update(sections: PlanSection[]): Promise<void> };
  operations: {
    retry(id: string): Promise<boolean>;
    undo(id: string): Promise<boolean>;
  };
  outputs: {
    list(): Promise<DesktopOutputsState>;
    assign(
      agentInstanceId: string,
      producerId: string,
    ): Promise<DesktopOutputAssignment>;
    unassign(agentInstanceId: string, producerId: string): Promise<boolean>;
    setEnabled(
      agentInstanceId: string,
      producerId: string,
      enabled: boolean,
    ): Promise<DesktopOutputAssignment>;
    setDeliveryMode(
      agentInstanceId: string,
      producerId: string,
      deliveryMode: OutputDeliveryMode,
    ): Promise<DesktopOutputAssignment>;
    setUsageInstruction(
      agentInstanceId: string,
      producerId: string,
      usageInstruction: string,
    ): Promise<DesktopOutputAssignment>;
    setProcessingPolicies(
      agentInstanceId: string,
      producerId: string,
      processingPolicyIds: string[],
    ): Promise<DesktopOutputAssignment>;
  };
  events: {
    list(): Promise<DesktopEventsState>;
    inspectSelection(): Promise<LiveEventSelection>;
    create(definition: LiveEventDefinitionDraft): Promise<LiveEventDefinition>;
    update(
      eventId: string,
      definition: LiveEventDefinitionDraft,
    ): Promise<LiveEventDefinition>;
    enable(eventId: string): Promise<LiveEventDefinition>;
    disable(eventId: string): Promise<LiveEventDefinition>;
    delete(eventId: string): Promise<boolean>;
    assignListener(
      agentInstanceId: string,
      eventId: string,
      settings: Pick<
        AgentEventListener,
        "enabled" | "responseMode" | "messagePrefix" | "preparedContext"
      >,
    ): Promise<DesktopAgentEventListener>;
    unassignListener(
      agentInstanceId: string,
      eventId: string,
    ): Promise<boolean>;
    updateListener(
      agentInstanceId: string,
      eventId: string,
      settings: Partial<
        Pick<AgentEventListener, "enabled" | "responseMode"> & {
          messagePrefix: string | null;
          preparedContext: AgentEventListener["preparedContext"];
        }
      >,
    ): Promise<DesktopAgentEventListener>;
    subscribe(handler: (event: DesktopAppEvent) => void): () => void;
  };
  eventHistory: {
    search(query?: RootTraceQuery): Promise<RootTracePage>;
    trace(
      traceId: string,
      options?: { cursor?: string; limit?: number; order?: "asc" | "desc" },
    ): Promise<EventTracePage>;
    configurations(
      query?: ConfigurationSnapshotQuery,
    ): Promise<ConfigurationSnapshotPage>;
    health(): Promise<JournalHealth>;
    getRetention(): Promise<RetentionPolicy>;
    setRetention(policy: RetentionPolicy): Promise<RetentionPolicy>;
    prune(): Promise<RetentionResult>;
    deleteTrace(traceId: string): Promise<number>;
    clear(): Promise<{
      deletedEvents: number;
      deletedConfigurationSnapshots: number;
    }>;
  };
}

export type EventTracePage = TelemetryEventPage & {
  trace: NonNullable<TelemetryEventPage["trace"]>;
};

export type {
  ConfigurationSnapshotPage,
  ConfigurationSnapshotQuery,
  JournalHealth,
  RetentionPolicy,
  RetentionResult,
  RootTracePage,
  RootTraceQuery,
  TelemetryEventPage,
};
