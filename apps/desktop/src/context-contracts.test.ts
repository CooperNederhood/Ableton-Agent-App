import { describe, expect, it } from "vitest";
import { createSyntheticMetricRecordStreamFixture } from "@ableton-agent/protocol/testing";
import { contextOperationResultSchema } from "@ableton-agent/tools";
import { desktopContextDetailSchema } from "./context-contracts.js";

describe("typed Desktop stream context", () => {
  it("round-trips the current bounded reference and rejects obsolete formats and extra payloads", async () => {
    const fixture = await createSyntheticMetricRecordStreamFixture();
    const { rows, ...geometry } = fixture.descriptor.geometry;
    void rows;
    const detail = {
      action: "get",
      entry: {
        contextId: "entry",
        passId: fixture.descriptor.ownership.passId,
        listenerId: fixture.descriptor.ownership.listenerId,
        subjectId: "subject",
        kind: "metric-record-stream-context/v1",
        createdAt: "2026-10-12T00:00:00.000Z",
        freshness: "unknown",
        summary: "Synthetic stream fixture, not native acceptance",
      },
      observation: {
        schema: "metric-record-stream-context/v1",
        captureId: "capture",
        descriptorDigest: fixture.state.descriptorDigest,
        descriptor: { ...fixture.descriptor, geometry },
      },
    };
    expect(
      desktopContextDetailSchema.parse(
        contextOperationResultSchema.parse(detail),
      ),
    ).toEqual(detail);
    for (const kind of [
      "audio-observation/v1",
      "audio-observation/v2",
      "session-audio-observation/v1",
      "metric-audio-observation/v1",
    ])
      expect(
        desktopContextDetailSchema.safeParse({
          ...detail,
          entry: { ...detail.entry, kind },
          observation: { ...detail.observation, schema: kind },
        }).success,
      ).toBe(false);
    for (const extra of [{ sql: "select *" }, { rawAudio: [1, 2] }])
      expect(
        desktopContextDetailSchema.safeParse({ ...detail, ...extra }).success,
      ).toBe(false);
    expect(
      desktopContextDetailSchema.safeParse({
        ...detail,
        observation: {
          ...detail.observation,
          descriptor: fixture.descriptor,
        },
      }).success,
    ).toBe(false);
  });
});
