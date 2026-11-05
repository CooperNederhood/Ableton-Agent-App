import { z } from "zod";
import { MAX_METRIC_REPORT_ROWS } from "./metric-listening-geometry.js";
import {
  MAX_METRIC_REPORT_PAGE_BYTES,
  MAX_METRIC_REPORT_PAGE_ROWS,
} from "./metric-listening-report.js";
import {
  projectMelBandTimeline,
  type MelBandTimeline,
  type MelBandTimelineReport,
} from "./mel-band-timeline.js";
import { encodedJsonBytes } from "./schema-byte-budget.js";

export const MAX_MEL_BAND_REPORT_PAGE_BYTES = MAX_METRIC_REPORT_PAGE_BYTES;
export const MAX_MEL_BAND_REPORT_PAGE_ROWS = MAX_METRIC_REPORT_PAGE_ROWS;
export const melBandReportPageOptionsSchema = z
  .strictObject({
    offset: z.number().int().min(0).max(MAX_METRIC_REPORT_ROWS).default(0),
    rowLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MEL_BAND_REPORT_PAGE_ROWS)
      .default(MAX_MEL_BAND_REPORT_PAGE_ROWS),
    byteLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MEL_BAND_REPORT_PAGE_BYTES)
      .default(MAX_MEL_BAND_REPORT_PAGE_BYTES),
  })
  .readonly();
export type MelBandReportPageOptions = z.input<
  typeof melBandReportPageOptionsSchema
>;
export type MelBandReportPage = Readonly<
  Omit<MelBandTimelineReport, "schema"> & {
    schema: "mel-band-report-page/v1";
    totalRows: number;
    offset: number;
    nextOffset: number | null;
    pageBudget: Readonly<{
      byteLimit: number;
      requestedRowLimit: number;
      byteLimited: boolean;
    }>;
  }
>;

/** Lossless whole-row pages; a row that cannot fit is an explicit failure. */
export function pageMelBandTimeline(
  timeline: MelBandTimeline,
  rowBoundaries: unknown,
  options: unknown = {},
): MelBandReportPage {
  const { offset, rowLimit, byteLimit } =
    melBandReportPageOptionsSchema.parse(options);
  const report = projectMelBandTimeline(timeline, rowBoundaries);
  const totalRows = report.rows.length;
  if (offset > totalRows)
    throw new RangeError("mel_band_report_offset_out_of_range");
  const requestedCount = Math.min(rowLimit, totalRows - offset);
  const page = (count: number): MelBandReportPage =>
    Object.freeze({
      ...report,
      schema: "mel-band-report-page/v1",
      totalRows,
      offset,
      nextOffset: offset + count < totalRows ? offset + count : null,
      pageBudget: Object.freeze({
        byteLimit,
        requestedRowLimit: rowLimit,
        byteLimited: count < requestedCount,
      }),
      rows: Object.freeze(report.rows.slice(offset, offset + count)),
    });
  if (requestedCount === 0) {
    const empty = page(0);
    if (encodedJsonBytes(empty) > byteLimit)
      throw new RangeError("mel_band_report_metadata_exceeds_byte_limit");
    return empty;
  }
  // At most 32 candidates. Measure the actual final envelope, including its
  // continuation and byteLimited flag, instead of estimating row-only bytes.
  for (let count = requestedCount; count > 0; count--) {
    const candidate = page(count);
    if (encodedJsonBytes(candidate) <= byteLimit) return candidate;
  }
  throw new RangeError("mel_band_report_row_exceeds_byte_limit");
}
