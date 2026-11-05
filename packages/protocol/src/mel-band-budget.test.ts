import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  admitMelBandBudget,
  MAX_MEL_BAND_TIMELINE_BYTES,
} from "./mel-band-budget.js";
import {
  MAX_MEL_BAND_MAGNITUDE,
  MEL_BAND_PROFILE,
} from "./mel-band-profile.js";
import { melBandTimelineSchema } from "./mel-band-timeline.js";
import {
  boundJsonSchemaBytes,
  toBoundJsonSchema,
} from "./schema-byte-budget.js";

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const input = (
  sampleRate: 44_100 | 48_000 = 48_000,
  length = sampleRate * 30,
) => ({
  sampleRate,
  sourceSupport: { startSample: 2 ** 44 - 1 - length, endSample: 2 ** 44 - 1 },
  profile: MEL_BAND_PROFILE,
  byteLimit: MAX_MEL_BAND_TIMELINE_BYTES,
});
const timeline = (
  config: ReturnType<typeof input>,
  retained: (index: number) => boolean,
) => {
  const expectedRecords = Math.floor(
    (config.sourceSupport.endSample - config.sourceSupport.startSample) / 2_048,
  );
  const frames = [];
  const gaps = [];
  for (let index = 0; index < expectedRecords; index++) {
    const support = {
      startSample: config.sourceSupport.startSample + index * 2_048,
      endSample: config.sourceSupport.startSample + (index + 1) * 2_048,
    };
    if (retained(index))
      frames.push({
        index,
        support,
        magnitudes: Array.from({ length: 2 }, () =>
          Array.from(
            { length: 24 },
            (_, i) =>
              [
                0.0000010000000000000002,
                MAX_MEL_BAND_MAGNITUDE,
                Number.MIN_VALUE,
              ][i % 3],
          ),
        ),
      });
    else
      gaps.push({
        firstIndex: index,
        count: 1,
        support,
        reason: "dependency-unavailable",
      });
  }
  return melBandTimelineSchema.parse({
    schema: "mel-band-timeline/v1",
    status:
      gaps.length === 0
        ? "complete"
        : frames.length === 0
          ? "failed"
          : "partial",
    sampleRate: config.sampleRate,
    sourceSupport: config.sourceSupport,
    profile: config.profile,
    expectedRecords,
    frames,
    gaps,
  });
};

describe("pre-capture standalone mel-band byte admission", () => {
  it.each([44_100, 48_000] as const)(
    "bounds full and partial thirty-second timelines at %i Hz",
    (sampleRate) => {
      const config = input(sampleRate);
      const budget = admitMelBandBudget(config);
      expect(budget.admitted).toBe(true);
      expect(budget.operands.expectedRecords).toBe(
        sampleRate === 48_000 ? 703 : 645,
      );
      expect(budget.operands.positiveNumberCharacters).toBe(24);
      expect(budget.operands.sampleCharacters).toBe(14);
      expect(budget.operands.profileBytes).toBe(bytes(MEL_BAND_PROFILE));
      for (const retained of [
        () => true,
        () => false,
        (index: number) => index % 2 === 0,
        (index: number) => index !== 1,
      ]) {
        const value = timeline(config, retained);
        expect(bytes(value)).toBeLessThanOrEqual(
          budget.upperBounds[
            value.status === "complete" ? "complete" : "partial"
          ],
        );
      }
      const n = budget.operands.expectedRecords;
      const frame = budget.operands.frameBytes;
      const gap = budget.operands.gapBytes;
      const array = (count: number, item: number) =>
        2 + count * item + Math.max(0, count - 1);
      expect(budget.operands.completeSlotsBytes).toBe(array(n, frame) + 2);
      expect(budget.operands.partialSlotsBytes).toBe(
        Math.max(
          ...Array.from(
            { length: n },
            (_, records) => array(records, frame) + array(n - records, gap),
          ),
        ),
      );
      expect(budget.operands.partialSlotsBytes).toBeLessThan(
        array(n, frame) + array(n, gap),
      );
    },
  );

  it("uses the existing number/string bounding engine and fails closed on unbounded strings", () => {
    expect(
      boundJsonSchemaBytes(
        toBoundJsonSchema(
          z.number().finite().min(0).max(MAX_MEL_BAND_MAGNITUDE),
        ),
      ),
    ).toBe(24);
    expect(bytes(0.0000010000000000000002)).toBe(24);
    expect(() => boundJsonSchemaBytes(toBoundJsonSchema(z.string()))).toThrow(
      "metric_budget_unbounded_schema",
    );
    const escaped = "\u0000".repeat(4);
    expect(boundJsonSchemaBytes(toBoundJsonSchema(z.string().max(4)))).toBe(
      bytes(escaped),
    );
    expect(() =>
      admitMelBandBudget({
        ...input(),
        profile: { ...MEL_BAND_PROFILE, label: escaped },
      }),
    ).toThrow();
  });

  it("admits the exact bound and explicitly denies one byte below without reduction", () => {
    const budget = admitMelBandBudget(input());
    const required = Math.max(...Object.values(budget.upperBounds));
    expect(
      admitMelBandBudget({ ...input(), byteLimit: required }).admitted,
    ).toBe(true);
    const denied = admitMelBandBudget({ ...input(), byteLimit: required - 1 });
    expect(denied.admitted).toBe(false);
    if (denied.admitted) throw new Error("Expected denial");
    expect(denied.reason).toBe("mel_band_timeline_budget_exceeded");
    expect(denied.upperBounds).toEqual(budget.upperBounds);
    expect(denied.violations).toContainEqual({
      outcome: "complete",
      upperBoundBytes: budget.upperBounds.complete,
      byteLimit: required - 1,
      excessBytes: 1,
    });
    expect(denied.operands.expectedRecords).toBe(703);
  });

  it.each([1, 2_047, 2_048, 2_049])(
    "bounds short capture metadata and all-gap outcomes for %i samples",
    (length) => {
      const config = input(48_000, length);
      const budget = admitMelBandBudget(config);
      expect(bytes(timeline(config, () => true))).toBeLessThanOrEqual(
        budget.upperBounds.complete,
      );
      const missing = timeline(config, () => false);
      expect(bytes(missing)).toBeLessThanOrEqual(
        budget.upperBounds[
          missing.status === "complete" ? "complete" : "partial"
        ],
      );
    },
  );

  it.each([
    { byteLimit: 0 },
    { byteLimit: -1 },
    { byteLimit: 1.5 },
    { byteLimit: Infinity },
    { byteLimit: MAX_MEL_BAND_TIMELINE_BYTES + 1 },
    { byteLimit: undefined },
    { sampleRate: 96_000 },
    { profile: { ...MEL_BAND_PROFILE, scale: 1 } },
    { sourceSupport: { startSample: 0, endSample: 48_000 * 30 + 1 } },
    { sourceSupport: { startSample: 0, endSample: 0 } },
    { extra: true },
  ])("rejects malformed or out-of-policy admission %#", (change) => {
    expect(() => admitMelBandBudget({ ...input(), ...change })).toThrow();
  });

  it("freezes its validated snapshot without freezing caller objects", () => {
    const config = input();
    const budget = admitMelBandBudget(config);
    config.sourceSupport.startSample = 0;
    expect(budget.snapshot.sourceSupport.startSample).not.toBe(0);
    const check = (value: unknown) => {
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(check);
      }
    };
    check(budget);
  });
});
