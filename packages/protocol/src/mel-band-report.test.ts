import { describe, expect, it } from "vitest";
import { MEL_BAND_PROFILE } from "./mel-band-profile.js";
import {
  melBandTimelineSchema,
  projectMelBandTimeline,
} from "./mel-band-timeline.js";
import {
  pageMelBandTimeline,
  MAX_MEL_BAND_REPORT_PAGE_BYTES,
  MAX_MEL_BAND_REPORT_PAGE_ROWS,
} from "./mel-band-report.js";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function fixture(count = 40, missing = false) {
  const support = (index: number) => ({
    startSample: index * 2_048,
    endSample: (index + 1) * 2_048,
  });
  const timeline = melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status: missing ? "failed" : "complete",
    sampleRate: 48_000,
    profile: MEL_BAND_PROFILE,
    sourceSupport: { startSample: 0, endSample: count * 2_048 },
    expectedRecords: count,
    frames: missing
      ? []
      : Array.from({ length: count }, (_, index) => ({
          index,
          support: support(index),
          magnitudes: [
            Array.from({ length: 24 }, (_, i) =>
              i % 2 ? 0.0000010000000000000002 : index + 1,
            ),
            Array.from({ length: 24 }, () => 0),
          ],
        })),
    gaps: missing
      ? [
          {
            firstIndex: 0,
            count,
            support: { startSample: 0, endSample: count * 2_048 },
            reason: "drain-timeout",
          },
        ]
      : [],
  });
  const rows = Array.from({ length: count }, (_, index) => ({
    ...support(index),
    startBeat: index / 4,
    endBeat: (index + 1) / 4,
  }));
  return { timeline, rows };
}

describe("lossless standalone mel-band report pages", () => {
  it("pages complete rows with fixed metadata once and stable reopen behavior", () => {
    const { timeline, rows } = fixture();
    const first = pageMelBandTimeline(timeline, rows);
    expect(first.rows.length).toBeLessThanOrEqual(32);
    expect(first.totalRows).toBe(40);
    expect(first.offset).toBe(0);
    expect(first.nextOffset).toBe(first.rows.length);
    expect(first.profile).toEqual(MEL_BAND_PROFILE);
    expect(JSON.stringify(first).match(/"mel-band-profile\/v1"/g)).toHaveLength(
      1,
    );
    expect(bytes(first)).toBeLessThanOrEqual(MAX_MEL_BAND_REPORT_PAGE_BYTES);
    expect(first.pageBudget.requestedRowLimit).toBe(
      MAX_MEL_BAND_REPORT_PAGE_ROWS,
    );
    expect(pageMelBandTimeline(timeline, rows)).toEqual(first);
    const collected = [...first.rows];
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = pageMelBandTimeline(timeline, rows, { offset });
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.length).toBeLessThanOrEqual(32);
      expect(bytes(page)).toBeLessThanOrEqual(MAX_MEL_BAND_REPORT_PAGE_BYTES);
      collected.push(...page.rows);
      offset = page.nextOffset;
    }
    expect(collected).toEqual(projectMelBandTimeline(timeline, rows).rows);
    expect(
      collected
        .flatMap((row) => row.frames)
        .map((frame) => frame.analysis.magnitudes),
    ).toEqual(timeline.frames.map((frame) => frame.magnitudes));
    expect(pageMelBandTimeline(timeline, rows, { offset: 40 }).rows).toEqual(
      [],
    );
  });

  it("uses an exact byte boundary and rejects one byte less for one full row", () => {
    const { timeline } = fixture(1);
    const rows = [
      { startSample: 0, endSample: 2_048, startBeat: 0, endBeat: 1 },
    ];
    const page = pageMelBandTimeline(timeline, rows, { rowLimit: 1 });
    let byteLimit = bytes(page);
    for (let i = 0; i < 4; i++)
      byteLimit = bytes({
        ...page,
        pageBudget: { ...page.pageBudget, byteLimit },
      });
    const exact = pageMelBandTimeline(timeline, rows, {
      rowLimit: 1,
      byteLimit,
    });
    expect(bytes(exact)).toBe(byteLimit);
    expect(() =>
      pageMelBandTimeline(timeline, rows, {
        rowLimit: 1,
        byteLimit: byteLimit - 1,
      }),
    ).toThrow("mel_band_report_row_exceeds_byte_limit");
  });

  it("reduces only the number of whole rows in a byte-limited page", () => {
    const { timeline, rows } = fixture();
    const baseline = pageMelBandTimeline(timeline, rows, { rowLimit: 1 });
    const page = pageMelBandTimeline(timeline, rows, {
      byteLimit: bytes(baseline) + 100,
    });
    expect(page.pageBudget.byteLimited).toBe(true);
    expect(page.rows).toEqual(
      projectMelBandTimeline(timeline, rows).rows.slice(0, page.rows.length),
    );
    expect(page.nextOffset).toBe(page.rows.length);
    expect(bytes(page)).toBeLessThanOrEqual(page.pageBudget.byteLimit);
  });

  it("rejects a full 703-frame row instead of trimming frames or bands", () => {
    const { timeline } = fixture(703);
    expect(() =>
      pageMelBandTimeline(timeline, [
        {
          startSample: 0,
          endSample: 703 * 2_048,
          startBeat: 0,
          endBeat: 60,
        },
      ]),
    ).toThrow("mel_band_report_row_exceeds_byte_limit");
  });

  it("pages all 703 frame slots without loss at the maximum capture duration", () => {
    const { timeline, rows } = fixture(703);
    const captured = {
      ...timeline,
      sourceSupport: { startSample: 0, endSample: 48_000 * 30 },
    };
    rows[rows.length - 1]!.endSample = 48_000 * 30;
    let offset: number | null = 0;
    let frameCount = 0;
    while (offset !== null) {
      const page = pageMelBandTimeline(
        melBandTimelineSchema.parse(captured),
        rows,
        { offset },
      );
      frameCount += page.rows.reduce((sum, row) => sum + row.recordCount, 0);
      expect(bytes(page)).toBeLessThanOrEqual(MAX_MEL_BAND_REPORT_PAGE_BYTES);
      offset = page.nextOffset;
    }
    expect(frameCount).toBe(703);
  });

  it("distinguishes no-frame short captures from explicit all-gap failure", () => {
    const { timeline, rows } = fixture(1, true);
    const failed = pageMelBandTimeline(timeline, rows);
    expect(failed.status).toBe("failed");
    expect(failed.rows[0]!.gapCount).toBe(1);
    expect(failed.rows[0]!.gaps[0]!.reason).toBe("drain-timeout");
    expect(failed.rows[0]!.aggregation).toEqual({
      status: "no-frames",
      frameCount: 0,
    });
    const short = melBandTimelineSchema.parse({
      ...timeline,
      status: "complete",
      expectedRecords: 0,
      gaps: [],
      sourceSupport: { startSample: 0, endSample: 10 },
    });
    const empty = pageMelBandTimeline(short, [{ ...rows[0], endSample: 10 }]);
    expect(empty.status).toBe("complete");
    expect(empty.rows[0]!.gaps).toEqual([]);
    expect(empty.rows[0]!.aggregation).toEqual({
      status: "no-frames",
      frameCount: 0,
    });
    expect(empty.trailingSupport).toEqual(short.sourceSupport);
  });

  it("preserves partial single-slot gaps and all matching retained vectors across pages", () => {
    const { timeline, rows } = fixture(3);
    const partial = melBandTimelineSchema.parse({
      ...timeline,
      status: "partial",
      frames: timeline.frames.filter((frame) => frame.index !== 1),
      gaps: [
        {
          firstIndex: 1,
          count: 1,
          support: { startSample: 2_048, endSample: 4_096 },
          reason: "malformed-record",
        },
      ],
    });
    const pages = [0, 1, 2].map((offset) =>
      pageMelBandTimeline(partial, rows, { offset, rowLimit: 1 }),
    );
    expect(pages.every((page) => page.status === "partial")).toBe(true);
    expect(pages.flatMap((page) => page.rows)).toEqual(
      projectMelBandTimeline(partial, rows).rows,
    );
    expect(
      pages.flatMap((page) => page.rows.flatMap((row) => row.gaps)),
    ).toEqual(partial.gaps);
    expect(
      pages
        .flatMap((page) => page.rows.flatMap((row) => row.frames))
        .map((frame) => frame.analysis.magnitudes),
    ).toEqual(partial.frames.map((frame) => frame.magnitudes));
  });

  it.each([
    { offset: -1 },
    { offset: 1.5 },
    { offset: 41 },
    { offset: 2_001 },
    { rowLimit: 0 },
    { rowLimit: 33 },
    { rowLimit: Infinity },
    { rowLimit: 1.1 },
    { byteLimit: 0 },
    { byteLimit: -1 },
    { byteLimit: NaN },
    { byteLimit: 1.1 },
    { byteLimit: MAX_MEL_BAND_REPORT_PAGE_BYTES + 1 },
    { extra: true },
  ])("rejects invalid page operands %#", (options) => {
    const { timeline, rows } = fixture();
    expect(() => pageMelBandTimeline(timeline, rows, options)).toThrow();
  });

  it("fails explicitly when even page metadata cannot fit and freezes results", () => {
    const { timeline, rows } = fixture(1);
    expect(() =>
      pageMelBandTimeline(timeline, rows, { offset: 1, byteLimit: 1 }),
    ).toThrow("mel_band_report_metadata_exceeds_byte_limit");
    const page = pageMelBandTimeline(timeline, rows);
    const check = (value: unknown) => {
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(check);
      }
    };
    check(page);
  });
});
