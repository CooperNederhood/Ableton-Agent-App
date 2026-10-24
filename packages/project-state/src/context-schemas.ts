import { z } from "zod";
import {
  audioObservationKindSchema,
  storedAudioObservationSchema,
} from "@ableton-agent/protocol";

export const CONTEXT_LIMITS = Object.freeze({
  listenersPerPass: 8,
  pageSize: 100,
  revalidationsPerQuery: 100,
  entryBytes: 256 * 1_024,
  passBytes: 2 * 1_024 * 1_024,
  storeBytes: 32 * 1_024 * 1_024,
  pendingOperations: 32,
});

export const sessionContextStoreReferenceSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    relativePath: z.literal("context/entity-context.sqlite"),
    kinds: z
      .array(audioObservationKindSchema)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length)
      .readonly(),
  })
  .readonly();

export const SESSION_CONTEXT_STORE_REFERENCE =
  sessionContextStoreReferenceSchema.parse({
    schemaVersion: 2,
    relativePath: "context/entity-context.sqlite",
    kinds: [
      "audio-observation/v1",
      "audio-observation/v2",
      "session-audio-observation/v1",
    ],
  });

export type SessionContextStoreReference = z.infer<
  typeof sessionContextStoreReferenceSchema
>;

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const timestamp = z.iso.datetime();
const beat = z.number().finite().nonnegative();
const hash = z.string().min(1).max(256);

export const contextTraceSchema = z.strictObject({
  traceId: z.string().uuid(),
  correlationId: id,
  causationId: id,
});

export const contextRangeSchema = z
  .strictObject({ startBeat: beat, endBeat: beat })
  .refine((range) => range.endBeat >= range.startBeat, "Range must be ordered");

export const contextBindingEvidenceSchema = z.strictObject({
  version: z.literal(1),
  semanticLocator: z.strictObject({
    name: z.string().max(500),
    trackId: id.optional(),
    sceneIndex: z.number().int().nonnegative().optional(),
    arrangementRange: contextRangeSchema.optional(),
  }),
  sourceIdentity: z.string().min(1).max(2_000),
  sourceContentHash: hash.optional(),
  playbackSettingsHash: hash,
  upstreamProcessingHash: hash,
  routingHash: hash,
  dependencyScope: z.enum(["known", "unknown"]),
  previousRuntimeBindings: z.array(id).max(32),
});

export const contextSubjectSchema = z
  .strictObject({
    id,
    sessionId: id,
    liveSetId: id,
    kind: z.enum(["clip", "track", "arrangement-range"]),
    trackId: id.optional(),
    location: z.enum(["session", "arrangement", "track"]).optional(),
    binding: contextBindingEvidenceSchema,
  })
  .superRefine((subject, ctx) => {
    if (
      subject.kind === "clip" &&
      (subject.trackId === undefined ||
        !["session", "arrangement"].includes(subject.location ?? ""))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Clip subjects require exact track association and location",
      });
    }
    if (
      subject.kind === "arrangement-range" &&
      subject.binding.semanticLocator.arrangementRange === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Arrangement subjects require exact range evidence",
      });
    }
    if (
      subject.trackId !== undefined &&
      subject.binding.semanticLocator.trackId !== subject.trackId
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Subject track association disagrees with binding evidence",
      });
    }
  });

export const contextFreshnessSchema = z.enum([
  "fresh",
  "stale",
  "unknown",
  "unresolved",
  "historical",
]);

export const contextFreshnessAssessmentSchema = z.strictObject({
  status: contextFreshnessSchema,
  assessedAt: timestamp,
  reason: z.string().min(1).max(500),
});

export const listeningPassSchema = z
  .strictObject({
    id,
    sessionId: id,
    liveSetId: id,
    initiatorAgentId: id,
    listenerIds: z.array(id).min(1).max(CONTEXT_LIMITS.listenersPerPass),
    requestedMode: z.enum(["session", "arrangement"]),
    actualMode: z.enum(["session", "arrangement", "unknown"]),
    requestedRange: contextRangeSchema,
    actualRange: contextRangeSchema.nullable(),
    status: z.enum([
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    complete: z.boolean(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    endedAt: timestamp,
    interruptionReason: z.string().min(1).max(500).nullable(),
    trace: contextTraceSchema,
  })
  .superRefine((pass, ctx) => {
    if (new Set(pass.listenerIds).size !== pass.listenerIds.length) {
      ctx.addIssue({ code: "custom", message: "Listener IDs must be unique" });
    }
    if (pass.complete !== (pass.status === "completed")) {
      ctx.addIssue({
        code: "custom",
        message: "Only completed passes have complete coverage",
      });
    }
    if (
      pass.complete &&
      (pass.actualRange === null ||
        pass.startedAt === null ||
        pass.actualMode === "unknown")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Completed passes require measured playback coverage and capture timestamps",
      });
    }
    if (
      pass.endedAt < pass.createdAt ||
      (pass.startedAt !== null &&
        (pass.startedAt < pass.createdAt || pass.startedAt > pass.endedAt))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Pass timestamps must be ordered",
      });
    }
  });

// New kinds extend this discriminated union with a reviewed, bounded schema.
export const contextPayloadSchema = storedAudioObservationSchema;

export const contextEntrySchema = z
  .strictObject({
    id,
    sessionId: id,
    liveSetId: id,
    passId: id,
    kind: audioObservationKindSchema,
    producer: z.strictObject({
      listenerId: id,
      deviceId: id,
      agentId: id,
      connectionEpoch: id,
      version: z.string().min(1).max(100),
    }),
    createdAt: timestamp,
    capturedAt: timestamp,
    trace: contextTraceSchema,
    payload: contextPayloadSchema,
  })
  .refine((entry) => entry.kind === entry.payload.schema, {
    message: "Context kind must match its registered payload schema",
  });

export const contextLinkSchema = z.strictObject({
  id,
  sessionId: id,
  liveSetId: id,
  entryId: id,
  subjectId: id,
  relationship: z.enum(["primary", "contributor"]),
  coverage: z.union([
    contextRangeSchema,
    z.strictObject({
      coordinate: z.literal("clip-local-beats"),
      iteration: z.literal(0),
      startBeat: z.literal(0),
      endBeat: z.number().finite().positive().max(4.001),
    }),
    z
      .strictObject({
        coordinate: z.literal("transport-beats"),
        startBeat: beat,
        endBeat: beat,
      })
      .refine((range) => range.endBeat >= range.startBeat),
  ]),
  attribution: z.enum(["exclusive", "mixed", "unknown"]),
  observedContributorIds: z.array(id).max(64),
  sourceFingerprint: contextBindingEvidenceSchema,
  freshness: contextFreshnessAssessmentSchema,
});

export const appendContextPassSchema = z.strictObject({
  pass: listeningPassSchema,
  subjects: z.array(contextSubjectSchema).max(256),
  entries: z.array(contextEntrySchema).max(CONTEXT_LIMITS.listenersPerPass),
  links: z.array(contextLinkSchema).max(512),
});

export const contextQuerySchema = z.strictObject({
  kind: audioObservationKindSchema.optional(),
  subjectId: id.optional(),
  entryId: id.optional(),
  listenerId: id.optional(),
  passId: id.optional(),
  range: contextRangeSchema.optional(),
  freshness: contextFreshnessSchema.optional(),
  includeHistorical: z.boolean().default(false),
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(CONTEXT_LIMITS.pageSize).default(25),
});

export const contextPruneSchema = z
  .strictObject({
    passIds: z.array(id).max(100).default([]),
    entryIds: z.array(id).max(100).default([]),
    trace: contextTraceSchema,
  })
  .refine(
    (selection) => selection.passIds.length + selection.entryIds.length > 0,
    "Prune requires explicit reviewed IDs",
  );

export type ContextTrace = z.infer<typeof contextTraceSchema>;
export type ContextRange = z.infer<typeof contextRangeSchema>;
export type ContextSubject = z.infer<typeof contextSubjectSchema>;
export type ContextBindingEvidence = z.infer<
  typeof contextBindingEvidenceSchema
>;
export type ContextFreshness = z.infer<typeof contextFreshnessSchema>;
export type ContextFreshnessAssessment = z.infer<
  typeof contextFreshnessAssessmentSchema
>;
export type ListeningPass = z.infer<typeof listeningPassSchema>;
export type ContextEntry = z.infer<typeof contextEntrySchema>;
export type ContextLink = z.infer<typeof contextLinkSchema>;
export type AppendContextPass = z.infer<typeof appendContextPassSchema>;
export type ContextQuery = z.input<typeof contextQuerySchema>;
export type ContextPrune = z.input<typeof contextPruneSchema>;

/** Rename alone and downstream processing are deliberately absent dependencies. */
export function assessContextFreshness(
  captured: ContextBindingEvidence,
  current: ContextBindingEvidence | undefined,
  uniquelyReconciled: boolean,
  assessedAt: string,
): ContextFreshnessAssessment {
  const original = contextBindingEvidenceSchema.parse(captured);
  const binding =
    current === undefined
      ? undefined
      : contextBindingEvidenceSchema.parse(current);
  let status: ContextFreshness;
  let reason: string;
  if (!uniquelyReconciled || binding === undefined) {
    status = "unresolved";
    reason = "Current entity binding is missing or ambiguous";
  } else if (
    original.dependencyScope !== "known" ||
    binding.dependencyScope !== "known" ||
    original.sourceContentHash === undefined ||
    binding.sourceContentHash === undefined
  ) {
    status = "unknown";
    reason = "Source content or dependency evidence is unverified";
  } else if (
    original.sourceIdentity !== binding.sourceIdentity ||
    original.sourceContentHash !== binding.sourceContentHash ||
    original.playbackSettingsHash !== binding.playbackSettingsHash ||
    original.upstreamProcessingHash !== binding.upstreamProcessingHash ||
    original.routingHash !== binding.routingHash ||
    original.semanticLocator.trackId !== binding.semanticLocator.trackId ||
    original.semanticLocator.sceneIndex !==
      binding.semanticLocator.sceneIndex ||
    JSON.stringify(original.semanticLocator.arrangementRange) !==
      JSON.stringify(binding.semanticLocator.arrangementRange)
  ) {
    status = "stale";
    reason =
      "Observed source, playback, placement, or upstream dependency changed";
  } else {
    status = "fresh";
    reason = "Unique entity binding and all observed dependencies verified";
  }
  return contextFreshnessAssessmentSchema.parse({ status, assessedAt, reason });
}
