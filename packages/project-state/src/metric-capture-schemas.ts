import { z } from "zod";
import {
  metricRecordStreamDescriptorSchema,
  metricRecordStreamStateSchema,
  metricRecordStreamManifestSchema,
  metricRecordChunkSchema,
  metricContinuousListeningGeometrySchema,
  type MetricRecordStreamManifest,
  type MetricRecordStreamState,
  type MetricRecordChunk,
} from "@ableton-agent/protocol";
import {
  contextEntrySchema,
  contextSubjectSchema,
  contextTraceSchema,
  listeningPassSchema,
} from "./context-schemas.js";

export const METRIC_CAPTURE_STORAGE_LIMITS = Object.freeze({
  metadataBytes: 64 * 1_024,
  overviewBytes: 256 * 1_024,
  pageBytes: 1 * 1_024 * 1_024,
  pageChunks: 16,
});
export const METRIC_CAPTURE_CONTEXT_KIND =
  "metric-record-stream-context/v1" as const;

export const metricCaptureOwnerSchema = z.strictObject({
  captureId: contextSubjectSchema.shape.id,
  ownerToken: z.uuid(),
});
export type MetricCaptureOwner = z.infer<typeof metricCaptureOwnerSchema>;

export const metricCaptureStatusSchema = z.enum([
  "staging",
  "sealed",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type MetricCaptureStatus = z.infer<typeof metricCaptureStatusSchema>;

export const metricCaptureMetadataSchema = z.strictObject({
  id: contextSubjectSchema.shape.id,
  pass: listeningPassSchema,
  subject: contextSubjectSchema,
  producer: contextEntrySchema.shape.producer,
  trace: contextTraceSchema,
});
export type MetricCaptureMetadata = z.infer<typeof metricCaptureMetadataSchema>;

export const metricChunkQuerySchema = z.strictObject({
  captureId: contextSubjectSchema.shape.id,
  afterSequence: z.number().int().min(-1).default(-1),
  limit: z
    .number()
    .int()
    .min(1)
    .max(METRIC_CAPTURE_STORAGE_LIMITS.pageChunks)
    .default(4),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(METRIC_CAPTURE_STORAGE_LIMITS.pageBytes)
    .default(METRIC_CAPTURE_STORAGE_LIMITS.pageBytes),
  metric: z
    .enum([
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ])
    .optional(),
  range: z
    .strictObject({
      startSample: z.number().int().nonnegative(),
      endSample: z.number().int().positive(),
    })
    .refine((value) => value.endSample > value.startSample)
    .optional(),
});
export type MetricChunkQuery = z.input<typeof metricChunkQuerySchema>;

export const metricCaptureQuerySchema = z.strictObject({
  afterId: contextSubjectSchema.shape.id.optional(),
  passId: contextSubjectSchema.shape.id.optional(),
  subjectId: contextSubjectSchema.shape.id.optional(),
  listenerId: contextSubjectSchema.shape.id.optional(),
  status: metricCaptureStatusSchema.default("completed"),
  limit: z.number().int().min(1).max(16).default(4),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(METRIC_CAPTURE_STORAGE_LIMITS.pageBytes)
    .default(METRIC_CAPTURE_STORAGE_LIMITS.pageBytes),
});
export type MetricCaptureQuery = z.input<typeof metricCaptureQuerySchema>;

export const metricCaptureStartSchema = z.strictObject({
  metadata: metricCaptureMetadataSchema,
  descriptor: metricRecordStreamDescriptorSchema,
});
export type MetricCaptureStart = z.infer<typeof metricCaptureStartSchema>;

const { rows: _geometryRows, ...geometrySummaryShape } =
  metricContinuousListeningGeometrySchema.shape;
void _geometryRows;
export const metricCaptureDescriptorSummarySchema = z.strictObject({
  ...metricRecordStreamDescriptorSchema.shape,
  geometry: z.strictObject(geometrySummaryShape),
});
export type MetricCaptureDescriptorSummary = z.infer<
  typeof metricCaptureDescriptorSummarySchema
>;

export const metricCaptureRecordSchema = z
  .strictObject({
    kind: z.literal(METRIC_CAPTURE_CONTEXT_KIND),
    metadata: metricCaptureMetadataSchema,
    descriptor: metricCaptureDescriptorSummarySchema,
    state: metricRecordStreamStateSchema,
    status: metricCaptureStatusSchema,
    chunkCount: z.number().int().nonnegative(),
    storedBytes: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    reason: z.string().max(500).nullable(),
    manifest: metricRecordStreamManifestSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (
      (value.status === "completed" || value.status === "sealed") !==
        (value.manifest?.outcome === "complete") ||
      value.metadata.pass.complete !== (value.status === "completed")
    )
      context.addIssue({
        code: "custom",
        message:
          "Only verified terminal manifests publish complete capture context",
      });
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      METRIC_CAPTURE_STORAGE_LIMITS.overviewBytes
    )
      context.addIssue({
        code: "custom",
        message: "Metric capture overview exceeds its bounded projection",
      });
  });

export interface MetricCaptureRecord {
  readonly kind: typeof METRIC_CAPTURE_CONTEXT_KIND;
  readonly metadata: MetricCaptureMetadata;
  readonly descriptor: MetricCaptureDescriptorSummary;
  readonly state: MetricRecordStreamState;
  readonly status: MetricCaptureStatus;
  readonly chunkCount: number;
  readonly storedBytes: number;
  readonly updatedAt: string;
  readonly reason: string | null;
  readonly manifest: MetricRecordStreamManifest | null;
}

export const metricCapturePublicationSchema = z.strictObject({
  contextId: contextSubjectSchema.shape.id,
  kind: z.literal(METRIC_CAPTURE_CONTEXT_KIND),
  passId: contextSubjectSchema.shape.id,
  subjectId: contextSubjectSchema.shape.id,
  listenerId: contextSubjectSchema.shape.id,
});
export type MetricCapturePublication = z.infer<
  typeof metricCapturePublicationSchema
>;

export interface MetricChunkPage {
  readonly items: readonly MetricRecordChunk[];
  readonly nextSequence?: number;
  readonly encodedBytes: number;
}

export interface MetricCapturePage {
  readonly items: readonly MetricCaptureRecord[];
  readonly nextId?: string;
  readonly encodedBytes: number;
}

export const metricChunkPageSchema = z
  .strictObject({
    items: z
      .array(metricRecordChunkSchema)
      .max(METRIC_CAPTURE_STORAGE_LIMITS.pageChunks),
    nextSequence: z.number().int().nonnegative().optional(),
    encodedBytes: z
      .number()
      .int()
      .min(2)
      .max(METRIC_CAPTURE_STORAGE_LIMITS.pageBytes),
  })
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value.items)).byteLength !==
      value.encodedBytes
    )
      context.addIssue({
        code: "custom",
        message: "Metric page byte accounting must match its immutable records",
      });
  });

export const metricCapturePageSchema = z
  .strictObject({
    items: z.array(metricCaptureRecordSchema).max(16),
    nextId: contextSubjectSchema.shape.id.optional(),
    encodedBytes: z
      .number()
      .int()
      .min(2)
      .max(METRIC_CAPTURE_STORAGE_LIMITS.pageBytes),
  })
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value.items)).byteLength !==
      value.encodedBytes
    )
      context.addIssue({
        code: "custom",
        message: "Metric inventory byte accounting must match its overviews",
      });
  });
