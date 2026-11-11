import { describe, expect, it } from "vitest";
import {
  contextFeatureDerivationSchema,
  contextFeatureQuerySchema,
  contextFeatureSchema,
  contextFeatureSearchSchema,
  listeningFeatureTypeSchema,
  MAX_CONTEXT_FEATURES_PER_DERIVATION,
} from "./index.js";

describe("shared context feature contracts", () => {
  it("allows an optional bounded read-time primary subject reference", () => {
    expect(
      contextFeatureSchema.shape.primarySubjectId.parse(undefined),
    ).toBeUndefined();
    expect(contextFeatureSchema.shape.primarySubjectId.parse("subject:1")).toBe(
      "subject:1",
    );
    expect(() =>
      contextFeatureSchema.shape.primarySubjectId.parse("guessed/name"),
    ).toThrow();
    expect(() =>
      contextFeatureSchema.shape.primarySubjectId.parse("s".repeat(201)),
    ).toThrow();
  });

  it("exports strict trace and freshness contracts without a persistence dependency", () => {
    const trace = {
      traceId: "00000000-0000-4000-8000-000000000001",
      correlationId: "operation:1",
      causationId: "tool:1",
    };
    expect(contextFeatureSchema.shape.trace.parse(trace)).toEqual(trace);
    expect(() =>
      contextFeatureSchema.shape.trace.parse({ ...trace, raw: true }),
    ).toThrow();
    expect(() =>
      contextFeatureSchema.shape.trace.parse({ ...trace, traceId: "invalid" }),
    ).toThrow();
    for (const status of [
      "fresh",
      "stale",
      "unknown",
      "unresolved",
      "historical",
    ]) {
      const freshness = {
        status,
        assessedAt: "2026-11-06T15:00:00.000Z",
        reason: "Source assessment",
      };
      expect(contextFeatureSchema.shape.freshness.parse(freshness)).toEqual(
        freshness,
      );
    }
    expect(() =>
      contextFeatureSchema.shape.freshness.parse({
        status: "fresh",
        assessedAt: "2026-11-06T15:00:00.000Z",
        reason: "",
      }),
    ).toThrow();
  });

  it("preserves bounded query/search defaults and rejects unknown fields", () => {
    expect(contextFeatureQuerySchema.parse({})).toEqual({
      includeHistorical: false,
      limit: 20,
    });
    expect(
      contextFeatureSearchSchema.parse({ featureId: "feature:1" }),
    ).toEqual({
      featureId: "feature:1",
      excludeEntryIds: [],
      includeHistorical: false,
      limit: 10,
      candidateLimit: 1000,
    });
    expect(() =>
      contextFeatureSearchSchema.parse({
        featureId: "feature:1",
        candidateLimit: 1001,
      }),
    ).toThrow();
    expect(() =>
      contextFeatureQuerySchema.parse({ liveSetId: "set:other" }),
    ).toThrow();
    expect(() =>
      contextFeatureQuerySchema.parse({ cursor: "!invalid" }),
    ).toThrow();
  });

  it("preserves derivation terminal-state consistency", () => {
    const ready = {
      entryId: "entry:1",
      definitionSet: "peak-summary/v1",
      status: "ready",
      reason: null,
      featureIds: ["feature:1"],
    };
    expect(contextFeatureDerivationSchema.parse(ready)).toEqual(ready);
    expect(() =>
      contextFeatureDerivationSchema.parse({ ...ready, featureIds: [] }),
    ).toThrow();
    expect(() =>
      contextFeatureDerivationSchema.parse({
        ...ready,
        status: "failed",
        reason: "quota",
      }),
    ).toThrow();
    expect(
      contextFeatureDerivationSchema.parse({
        ...ready,
        status: "failed",
        reason: "quota",
        featureIds: [],
      }).status,
    ).toBe("failed");
  });

  it("exports all fifteen qualified types and accepts bounded multi-segment derivations", () => {
    expect(listeningFeatureTypeSchema.options).toHaveLength(15);
    expect(listeningFeatureTypeSchema.safeParse("pitch-grid/v1").success).toBe(
      true,
    );
    expect(
      listeningFeatureTypeSchema.safeParse("flatness-summary/v1").success,
    ).toBe(true);
    expect(
      contextFeatureQuerySchema.parse({ featureType: "mel-grid/v1" })
        .featureType,
    ).toBe("mel-grid/v1");
    const state = {
      entryId: "entry:1",
      definitionSet: "qualified-listening/v1",
      status: "ready",
      reason: null,
      featureIds: Array.from(
        { length: MAX_CONTEXT_FEATURES_PER_DERIVATION },
        (_, index) => `feature:${index}`,
      ),
    };
    expect(contextFeatureDerivationSchema.parse(state).featureIds).toHaveLength(
      7680,
    );
    expect(
      contextFeatureDerivationSchema.safeParse({
        ...state,
        featureIds: [...state.featureIds, "feature:overflow"],
      }).success,
    ).toBe(false);
  });
});
