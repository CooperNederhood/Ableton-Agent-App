import { z } from "zod";
import {
  listeningFeatureSchema,
  listeningFeatureTypeSchema,
  MAX_CONTEXT_FEATURES_PER_DERIVATION,
  listeningFeatureDefinition,
} from "./listening-features.js";
import { listeningMusicalAlignmentSchema } from "./listening-musical-alignment.js";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
const contextTraceSchema = z.strictObject({
  traceId: z.string().uuid(),
  correlationId: id,
  causationId: id,
});
const contextFreshnessAssessmentSchema = z.strictObject({
  status: z.enum(["fresh", "stale", "unknown", "unresolved", "historical"]),
  assessedAt: z.iso.datetime(),
  reason: z.string().min(1).max(500),
});
const sample = z
  .number()
  .int()
  .nonnegative()
  .max(2 ** 44 - 1);
export const contextSegmentSchema = z
  .strictObject({
    id,
    entryId: id,
    sessionId: id,
    liveSetId: id,
    order: z.number().int().min(0).max(511),
    kind: z.enum(["unaligned", "short", "bar", "partial"]),
    coordinate: z.enum(["clip-local-beats", "transport-beats"]),
    startBeat: z.number().finite().nonnegative(),
    endBeat: z.number().finite().nonnegative(),
    startSample: sample,
    endSample: sample,
    sampleRate: z.union([z.literal(44_100), z.literal(48_000)]),
    alignment: listeningMusicalAlignmentSchema.nullable().optional(),
    alignmentReason: z
      .enum([
        "musical-bar-alignment-not-established",
        "musical-alignment-incompatible",
      ])
      .nullable(),
  })
  .refine(
    (value) =>
      value.endBeat > value.startBeat &&
      value.endSample > value.startSample &&
      (value.kind === "unaligned"
        ? value.alignment == null && value.alignmentReason !== null
        : value.alignment != null &&
          value.alignment.coordinate === value.coordinate &&
          value.alignmentReason === null),
  );

const storedFeatureSchema = z.preprocess((value) => {
  const previous = z
    .object({
      type: listeningFeatureTypeSchema,
      distanceUnits: z.undefined().optional(),
    })
    .passthrough()
    .safeParse(value);
  if (!previous.success) return value;
  const definition = listeningFeatureDefinition(previous.data.type);
  if (
    definition.profile === "pitch-profile/v1" ||
    definition.profile === "spectral-shape-profile/v1"
  )
    return value;
  // Read old stored definitions without rewriting their rows or deriving new types.
  return { ...previous.data, distanceUnits: definition.distanceUnits };
}, listeningFeatureSchema);

export const contextFeatureSchema = z.strictObject({
  id,
  entryId: id,
  segmentId: id,
  sessionId: id,
  liveSetId: id,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.iso.datetime(),
  trace: contextTraceSchema,
  feature: storedFeatureSchema,
  freshness: contextFreshnessAssessmentSchema.optional(),
  primarySubjectId: id.optional(),
});
export const contextFeatureDerivationSchema = z
  .strictObject({
    entryId: id,
    status: z.enum(["pending", "ready", "unavailable", "failed", "cancelled"]),
    definitionSet: z.enum([
      "peak-summary/v1",
      "stored-listening/v1",
      "qualified-listening/v1",
    ]),
    reason: z.string().max(512).nullable(),
    featureIds: z
      .array(id)
      .max(MAX_CONTEXT_FEATURES_PER_DERIVATION)
      .refine((values) => new Set(values).size === values.length),
  })
  .superRefine((value, context) => {
    const ready = value.status === "ready";
    const pending = value.status === "pending";
    if (
      (ready && (value.featureIds.length === 0 || value.reason !== null)) ||
      (pending && (value.featureIds.length !== 0 || value.reason !== null)) ||
      (!ready && !pending && value.reason === null) ||
      (["failed", "cancelled"].includes(value.status) &&
        value.featureIds.length !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid derivation status metadata",
      });
  });
export const contextFeatureQuerySchema = z.strictObject({
  entryId: id.optional(),
  featureType: listeningFeatureTypeSchema.optional(),
  includeHistorical: z.boolean().default(false),
  cursor: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const contextFeatureSearchSchema = z.strictObject({
  featureId: id,
  featureType: listeningFeatureTypeSchema.optional(),
  excludeEntryIds: z.array(id).max(100).default([]),
  includeHistorical: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(10),
  candidateLimit: z.number().int().min(1).max(1_000).default(1_000),
});
export type ContextSegment = z.infer<typeof contextSegmentSchema>;
export type ContextFeature = z.infer<typeof contextFeatureSchema>;
export type ContextFeatureDerivation = z.infer<
  typeof contextFeatureDerivationSchema
>;
export type ContextFeatureQuery = z.input<typeof contextFeatureQuerySchema>;
export type ContextFeatureSearch = z.input<typeof contextFeatureSearchSchema>;
export interface ContextFeatureSearchResult {
  readonly matches: readonly {
    readonly feature: ContextFeature;
    readonly distance: number;
  }[];
  readonly scannedCount: number;
  readonly comparableCount: number;
  /** SQL-eligible candidates after source/ownership filters, before live revalidation. */
  readonly eligibleCount: number;
  /** Scanned candidates rejected by revalidation or canonical comparison. */
  readonly excludedCount: number;
  readonly exhaustive: boolean;
  readonly limitsHit: readonly ("candidates" | "bytes" | "time")[];
  readonly exclusionReasons: Readonly<Record<string, number>>;
}
