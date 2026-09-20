import { z } from "zod";

export const OBSERVABILITY_CONTRACT_VERSION = 2 as const;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_DATABASE_BYTES = 250 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_WRITES = 10_000;
export const MAX_SANITIZED_STRING_CHARACTERS = 256 * 1024;
export const MAX_SANITIZED_DEPTH = 16;
export const MAX_SANITIZED_ARRAY_ITEMS = 4_096;
export const MAX_SANITIZED_OBJECT_FIELDS = 2_048;
export const MAX_SANITIZED_FIELD_NAME_CHARACTERS = 512;
export const MAX_ATTRIBUTES_BYTES = 2 * 1024 * 1024;
export const MAX_EVENT_BYTES = 2_250 * 1024;
export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 500;

export const isoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const telemetryNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);

export const sanitizedFieldNameSchema = z
  .string()
  .min(1)
  .max(MAX_SANITIZED_FIELD_NAME_CHARACTERS);

export const telemetryIdSchema = z.string().uuid();
export const telemetryEntityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);

export const sanitizedValueSchema = z
  .unknown()
  .superRefine((value, context) => {
    const active = new Set<object>();

    const inspect = (
      current: unknown,
      path: PropertyKey[],
      depth: number,
    ): void => {
      if (
        current === null ||
        typeof current === "boolean" ||
        (typeof current === "number" && Number.isFinite(current))
      ) {
        return;
      }
      if (typeof current === "string") {
        if (current.length > MAX_SANITIZED_STRING_CHARACTERS) {
          context.addIssue({
            code: "custom",
            message: `Sanitized strings cannot exceed ${MAX_SANITIZED_STRING_CHARACTERS} characters`,
            path,
          });
        }
        return;
      }
      if (depth > MAX_SANITIZED_DEPTH) {
        context.addIssue({
          code: "custom",
          message: `Sanitized values cannot exceed ${MAX_SANITIZED_DEPTH} levels`,
          path,
        });
        return;
      }
      if (Array.isArray(current)) {
        if (current.length > MAX_SANITIZED_ARRAY_ITEMS) {
          context.addIssue({
            code: "custom",
            message: `Sanitized arrays cannot contain more than ${MAX_SANITIZED_ARRAY_ITEMS} values`,
            path,
          });
        }
        if (active.has(current)) {
          context.addIssue({
            code: "custom",
            message: "Sanitized values cannot be circular",
            path,
          });
          return;
        }
        active.add(current);
        current.forEach((item, index) => {
          inspect(item, [...path, index], depth + 1);
        });
        active.delete(current);
        return;
      }
      if (
        typeof current !== "object" ||
        Object.getPrototypeOf(current) !== Object.prototype
      ) {
        context.addIssue({
          code: "custom",
          message: "Sanitized values must contain only JSON primitives",
          path,
        });
        return;
      }
      if (active.has(current)) {
        context.addIssue({
          code: "custom",
          message: "Sanitized values cannot be circular",
          path,
        });
        return;
      }
      active.add(current);
      const entries = Object.entries(current);
      if (entries.length > MAX_SANITIZED_OBJECT_FIELDS) {
        context.addIssue({
          code: "custom",
          message: `Sanitized objects cannot contain more than ${MAX_SANITIZED_OBJECT_FIELDS} fields`,
          path,
        });
      }
      for (const [key, item] of entries) {
        if (!sanitizedFieldNameSchema.safeParse(key).success) {
          context.addIssue({
            code: "custom",
            message: "Sanitized field names must be telemetry-safe identifiers",
            path: [...path, key],
          });
        }
        inspect(item, [...path, key], depth + 1);
      }
      active.delete(current);
    };

    inspect(value, [], 0);
  });

export const sanitizedAttributesSchema = z
  .record(sanitizedFieldNameSchema, z.unknown())
  .superRefine((value, context) => {
    const sanitized = sanitizedValueSchema.safeParse(value);
    if (!sanitized.success) {
      for (const issue of sanitized.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Sanitized attributes must be JSON serializable",
      });
      return;
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_ATTRIBUTES_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Sanitized attributes cannot exceed ${MAX_ATTRIBUTES_BYTES} bytes`,
      });
    }
  });

export const traceContextSchema = z
  .object({
    traceId: telemetryIdSchema,
    spanId: telemetryIdSchema,
    parentSpanId: telemetryIdSchema.optional(),
  })
  .strict()
  .refine((trace) => trace.parentSpanId !== trace.spanId, {
    message: "A span cannot be its own parent",
    path: ["parentSpanId"],
  });

export const telemetryEventEnvelopeSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    id: telemetryIdSchema,
    occurredAt: isoTimestampSchema,
    name: telemetryNameSchema,
    category: telemetryNameSchema.optional(),
    source: telemetryNameSchema,
    stage: telemetryNameSchema.optional(),
    level: z.enum(["debug", "info", "warn", "error"]),
    outcome: z.enum(["success", "failure", "cancelled", "unknown"]).optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    correlationId: telemetryEntityIdSchema.optional(),
    causationId: telemetryEntityIdSchema.optional(),
    liveSetId: telemetryEntityIdSchema.optional(),
    liveProjectId: telemetryEntityIdSchema.optional(),
    sessionId: telemetryEntityIdSchema.optional(),
    activeAgentId: telemetryEntityIdSchema.optional(),
    liveEventId: telemetryEntityIdSchema.optional(),
    outputId: telemetryEntityIdSchema.optional(),
    toolName: telemetryNameSchema.optional(),
    trace: traceContextSchema.optional(),
    attributes: sanitizedAttributesSchema,
  })
  .strict()
  .superRefine((event, context) => {
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Telemetry events must be JSON serializable",
      });
      return;
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_EVENT_BYTES) {
      context.addIssue({
        code: "custom",
        message: `Telemetry events cannot exceed ${MAX_EVENT_BYTES} bytes`,
      });
    }
  });

export const journaledTelemetryEventSchema =
  telemetryEventEnvelopeSchema.extend({
    sequence: z.number().int().positive(),
    recordedAt: isoTimestampSchema,
  });

export const configurationSnapshotSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    id: telemetryIdSchema,
    capturedAt: isoTimestampSchema,
    component: telemetryNameSchema,
    configurationVersion: z.string().min(1).max(64),
    liveSetId: telemetryEntityIdSchema.optional(),
    liveProjectId: telemetryEntityIdSchema.optional(),
    sessionId: telemetryEntityIdSchema.optional(),
    activeAgentId: telemetryEntityIdSchema.optional(),
    values: sanitizedAttributesSchema,
  })
  .strict();

export const journaledConfigurationSnapshotSchema =
  configurationSnapshotSchema.extend({
    sequence: z.number().int().positive(),
    recordedAt: isoTimestampSchema,
  });

const stringFilterSchema = z
  .array(telemetryNameSchema)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: "Filter values must be unique",
  });

const telemetryFilterShape = {
  names: stringFilterSchema.optional(),
  categories: stringFilterSchema.optional(),
  sources: stringFilterSchema.optional(),
  stages: stringFilterSchema.optional(),
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
  liveSetId: telemetryEntityIdSchema.optional(),
  liveProjectId: telemetryEntityIdSchema.optional(),
  sessionId: telemetryEntityIdSchema.optional(),
  activeAgentId: telemetryEntityIdSchema.optional(),
  liveEventId: telemetryEntityIdSchema.optional(),
  outputId: telemetryEntityIdSchema.optional(),
  toolName: telemetryNameSchema.optional(),
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
};

const validTimeRange = (query: {
  from?: string | undefined;
  to?: string | undefined;
}): boolean =>
  query.from === undefined || query.to === undefined || query.from <= query.to;

export const telemetryQuerySchema = z
  .object({
    ...telemetryFilterShape,
    cursor: z.string().min(1).max(256).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUERY_LIMIT)
      .default(DEFAULT_QUERY_LIMIT),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .refine(validTimeRange, {
    message: "'from' must not be later than 'to'",
    path: ["from"],
  });

export const telemetryDeleteFilterSchema = z
  .object(telemetryFilterShape)
  .strict()
  .refine(validTimeRange, {
    message: "'from' must not be later than 'to'",
    path: ["from"],
  });

const configurationSnapshotFilterShape = {
  components: stringFilterSchema.optional(),
  liveSetId: telemetryEntityIdSchema.optional(),
  liveProjectId: telemetryEntityIdSchema.optional(),
  sessionId: telemetryEntityIdSchema.optional(),
  activeAgentId: telemetryEntityIdSchema.optional(),
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
};

export const configurationSnapshotQuerySchema = z
  .object({
    ...configurationSnapshotFilterShape,
    cursor: z.string().min(1).max(256).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_QUERY_LIMIT)
      .default(DEFAULT_QUERY_LIMIT),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .refine(validTimeRange, {
    message: "'from' must not be later than 'to'",
    path: ["from"],
  });

export const configurationSnapshotDeleteFilterSchema = z
  .object(configurationSnapshotFilterShape)
  .strict()
  .refine(validTimeRange, {
    message: "'from' must not be later than 'to'",
    path: ["from"],
  });

export const retentionPolicySchema = z
  .object({
    maxAgeDays: z.number().finite().positive().default(DEFAULT_RETENTION_DAYS),
    maxBytes: z.number().int().positive().default(DEFAULT_MAX_DATABASE_BYTES),
  })
  .strict();

export const retentionResultSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    deletedEvents: z.number().int().nonnegative(),
    deletedTraces: z.number().int().nonnegative(),
    deletedConfigurationSnapshots: z.number().int().nonnegative(),
    databaseBytes: z.number().int().nonnegative(),
    minimumDatabaseBytes: z.number().int().nonnegative().optional(),
    withinMaxBytes: z.boolean(),
    sizeLimitReason: z.literal("schema-minimum").nullable().optional(),
  })
  .strict();

export const journalFailureCodeSchema = z.enum([
  "closed",
  "conflict",
  "corrupt_database",
  "duplicate",
  "invalid_cursor",
  "io",
  "queue_full",
  "schema_version",
]);

export const journalHealthSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    status: z.enum(["healthy", "degraded", "closed"]),
    schemaVersion: z.number().int().nonnegative(),
    pendingWrites: z.number().int().nonnegative(),
    persistedEvents: z.number().int().nonnegative(),
    persistedConfigurationSnapshots: z.number().int().nonnegative(),
    rejectedWrites: z.number().int().nonnegative(),
    maxPendingWrites: z.number().int().positive(),
    databaseBytes: z.number().int().nonnegative(),
    oldestEventAt: isoTimestampSchema.nullable(),
    newestEventAt: isoTimestampSchema.nullable(),
    lastFlushAt: isoTimestampSchema.nullable(),
    lastError: z
      .object({
        code: journalFailureCodeSchema,
        message: z.string().min(1).max(1_024),
        at: isoTimestampSchema,
      })
      .strict()
      .nullable(),
    retention: retentionPolicySchema,
  })
  .strict();

export const pageMetadataSchema = z
  .object({
    limit: z.number().int().positive(),
    returnedItems: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    order: z.enum(["asc", "desc"]),
  })
  .strict();

export const tracePageMetadataSchema = z
  .object({
    rootTraceId: telemetryIdSchema,
    totalEvents: z.number().int().nonnegative(),
    firstSequence: z.number().int().positive().nullable(),
    lastSequence: z.number().int().positive().nullable(),
  })
  .strict();

export const telemetryEventPageSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    items: z.array(journaledTelemetryEventSchema),
    nextCursor: z.string().min(1).optional(),
    page: pageMetadataSchema,
    trace: tracePageMetadataSchema.optional(),
  })
  .strict();

export const configurationSnapshotPageSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    items: z.array(journaledConfigurationSnapshotSchema),
    nextCursor: z.string().min(1).optional(),
    page: pageMetadataSchema,
  })
  .strict();

export const rootTraceSummarySchema = z
  .object({
    rootTraceId: telemetryIdSchema,
    eventCount: z.number().int().positive(),
    firstSequence: z.number().int().positive(),
    lastSequence: z.number().int().positive(),
    firstOccurredAt: isoTimestampSchema,
    lastOccurredAt: isoTimestampSchema,
    firstEventName: telemetryNameSchema,
    lastEventName: telemetryNameSchema,
    hasErrors: z.boolean(),
  })
  .strict();

export const rootTraceQuerySchema = telemetryQuerySchema;

export const rootTracePageSchema = z
  .object({
    version: z.literal(OBSERVABILITY_CONTRACT_VERSION),
    items: z.array(rootTraceSummarySchema),
    nextCursor: z.string().min(1).optional(),
    page: pageMetadataSchema,
  })
  .strict();

export type SanitizedValue = z.infer<typeof sanitizedValueSchema>;
export type SanitizedAttributes = z.infer<typeof sanitizedAttributesSchema>;
export type TraceContext = z.infer<typeof traceContextSchema>;
export type TelemetryEventEnvelope = z.infer<
  typeof telemetryEventEnvelopeSchema
>;
export type JournaledTelemetryEvent = z.infer<
  typeof journaledTelemetryEventSchema
>;
export type ConfigurationSnapshot = z.infer<typeof configurationSnapshotSchema>;
export type JournaledConfigurationSnapshot = z.infer<
  typeof journaledConfigurationSnapshotSchema
>;
export type TelemetryQuery = z.input<typeof telemetryQuerySchema>;
export type ParsedTelemetryQuery = z.output<typeof telemetryQuerySchema>;
export type TelemetryDeleteFilter = z.input<typeof telemetryDeleteFilterSchema>;
export type ConfigurationSnapshotQuery = z.input<
  typeof configurationSnapshotQuerySchema
>;
export type ConfigurationSnapshotDeleteFilter = z.input<
  typeof configurationSnapshotDeleteFilterSchema
>;
export type ParsedConfigurationSnapshotQuery = z.output<
  typeof configurationSnapshotQuerySchema
>;
export type RetentionPolicy = z.output<typeof retentionPolicySchema>;
export type RetentionPolicyInput = z.input<typeof retentionPolicySchema>;
export type RetentionResult = z.infer<typeof retentionResultSchema>;
export type JournalHealth = z.infer<typeof journalHealthSchema>;
export type JournalFailureCode = z.infer<typeof journalFailureCodeSchema>;
export type PageMetadata = z.infer<typeof pageMetadataSchema>;
export type TracePageMetadata = z.infer<typeof tracePageMetadataSchema>;
export type TelemetryEventPage = z.infer<typeof telemetryEventPageSchema>;
export type ConfigurationSnapshotPage = z.infer<
  typeof configurationSnapshotPageSchema
>;
export type RootTraceSummary = z.infer<typeof rootTraceSummarySchema>;
export type RootTraceQuery = z.input<typeof rootTraceQuerySchema>;
export type ParsedRootTraceQuery = z.output<typeof rootTraceQuerySchema>;
export type RootTracePage = z.infer<typeof rootTracePageSchema>;
