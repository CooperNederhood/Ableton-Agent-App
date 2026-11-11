import { z } from "zod";
import { MAX_ANALYZER_FRAMES } from "./analyzer-profile.js";
import {
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
} from "./analyzer-timeline.js";
import {
  boundJsonSchemaBytes,
  encodedJsonBytes,
  jsonArrayByteBound,
  jsonSchemaItem,
  jsonSchemaProperty,
  toBoundJsonSchema,
} from "./schema-byte-budget.js";

export const analyzerMetricSchema = z.enum(["pitch", "spectral-shape"]);
export type AnalyzerMetric = z.infer<typeof analyzerMetricSchema>;
const expectedRecordsSchema = z.number().int().min(0).max(MAX_ANALYZER_FRAMES);
const schemas = {
  pitch: toBoundJsonSchema(pitchTimelineSchema),
  "spectral-shape": toBoundJsonSchema(spectralShapeTimelineSchema),
} as const;

/** UTF-8 compact JSON upper bound for complete, partial OR failed timelines.
 * Each full slot has one frame or gap, never both. This reserves maximal raw
 * signed finite numbers, all metadata and explicit tail. It is not whole-
 * observation admission: callers must SUM requested metrics and the envelope
 * against the unchanged 2 MiB limit, and apply the separate report-page bound. */
export function boundAnalyzerTimelineBytes(
  metric: AnalyzerMetric,
  expectedRecords: number,
): number {
  const kind = analyzerMetricSchema.parse(metric);
  const count = expectedRecordsSchema.parse(expectedRecords);
  const schema = schemas[kind];
  const frameBytes = boundJsonSchemaBytes(
    jsonSchemaItem(jsonSchemaProperty(schema, "frames")),
  );
  const gapBytes = boundJsonSchemaBytes(
    jsonSchemaItem(jsonSchemaProperty(schema, "gaps")),
  );
  // Both arrays' punctuation is included even for all-gap/all-frame cases.
  const slotsBytes = jsonArrayByteBound(count, Math.max(frameBytes, gapBytes));
  return boundJsonSchemaBytes(schema, "", (path) => {
    if (path === "frames") return slotsBytes;
    if (path === "gaps") return 2;
    if (path === "expectedRecords") return encodedJsonBytes(count);
    return undefined;
  });
}
