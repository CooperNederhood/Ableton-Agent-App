import { describe, expect, it } from "vitest";
import { boundAnalyzerTimelineBytes } from "./analyzer-budget.js";
import {
  MAX_ANALYZER_SOURCE_SAMPLE,
  PITCH_PROFILE,
  SPECTRAL_SHAPE_PROFILE,
} from "./analyzer-profile.js";
import {
  classifyPitchEstimate,
  deriveAnalyzerTrailingSupport,
  pitchTimelineSchema,
  spectralShapeTimelineSchema,
} from "./analyzer-timeline.js";
import { encodedJsonBytes } from "./schema-byte-budget.js";

describe("schema-derived analyzer timeline byte bounds", () => {
  it.each(["pitch", "spectral-shape"] as const)(
    "bounds maximal valid %s frames, alternating gaps and all-gap overflow",
    (metric) => {
      const count = 703;
      const startSample = MAX_ANALYZER_SOURCE_SAMPLE - 48000 * 30;
      const support = (first: number, size = 1) => ({
        startSample: startSample + first * 2048,
        endSample: startSample + (first + size) * 2048,
      });
      const sourceSupport = {
        startSample,
        endSample: MAX_ANALYZER_SOURCE_SAMPLE,
      };
      const pitch = classifyPitchEstimate(
        -0.0000012345678901234567,
        -0.0000012345678901234567,
      );
      const spectral = {
        state: "valid",
        flatnessDb: -0.0000012345678901234567,
        spreadHz: 0.0000012345678901234567,
        rolloffHz: 0.0000012345678901234567,
      };
      const channel = metric === "pitch" ? pitch : spectral;
      const frames = Array.from({ length: count }, (_, index) => ({
        index,
        support: support(index),
        channels: [channel, channel],
      }));
      const gaps = Array.from({ length: count }, (_, firstIndex) => ({
        firstIndex,
        count: 1,
        support: support(firstIndex),
        reason: "dependency-unavailable",
      }));
      const base = {
        schema: `${metric}-timeline/v1`,
        profile: metric === "pitch" ? PITCH_PROFILE : SPECTRAL_SHAPE_PROFILE,
        sampleRate: 48000,
        sourceSupport,
        expectedRecords: count,
        trailingSupport: deriveAnalyzerTrailingSupport(sourceSupport),
      };
      const schema =
        metric === "pitch" ? pitchTimelineSchema : spectralShapeTimelineSchema;
      const bound = boundAnalyzerTimelineBytes(metric, count);
      for (const payload of [
        { ...base, status: "complete", frames, gaps: [] },
        {
          ...base,
          status: "partial",
          frames: frames.filter((frame) => frame.index % 2 === 0),
          gaps: gaps.filter((gap) => gap.firstIndex % 2 === 1),
        },
        { ...base, status: "failed", frames: [], gaps },
        {
          ...base,
          status: "failed",
          frames: [],
          gaps: [
            {
              firstIndex: 0,
              count,
              support: support(0, count),
              reason: "overflow",
            },
          ],
        },
      ]) {
        schema.parse(payload);
        expect(encodedJsonBytes(payload)).toBeLessThanOrEqual(bound);
      }
      expect(bound).toBeLessThan(512 * 1024);
    },
  );
  it("bounds empty-window overhead and rejects unbounded record counts", () => {
    expect(boundAnalyzerTimelineBytes("pitch", 0)).toBeGreaterThan(1000);
    for (const count of [-1, 0.5, 704, Infinity])
      expect(() => boundAnalyzerTimelineBytes("pitch", count)).toThrow();
    expect(
      boundAnalyzerTimelineBytes("pitch", 703) +
        boundAnalyzerTimelineBytes("spectral-shape", 703),
    ).toBeLessThan(1024 * 1024);
  });
});
