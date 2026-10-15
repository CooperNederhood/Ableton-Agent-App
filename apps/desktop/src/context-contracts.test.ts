import { describe, expect, it } from "vitest";
import {
  createSyntheticNativeListeningFixture,
  createSyntheticNativeListeningFixtureV2,
} from "@ableton-agent/protocol/testing";
import { contextOperationResultSchema } from "@ableton-agent/tools";
import { desktopContextDetailSchema } from "./context-contracts.js";

describe("versioned typed Desktop context details", () => {
  it.each([1, 2] as const)(
    "round-trips v%i without converting its timing claims",
    (version) => {
      const { observation } =
        version === 2
          ? createSyntheticNativeListeningFixtureV2()
          : createSyntheticNativeListeningFixture();
      const detail = {
        action: "get",
        entry: {
          contextId: "entry",
          passId: observation.passId,
          listenerId: observation.listenerId,
          subjectId: "subject",
          kind: observation.schema,
          createdAt: "2026-10-12T00:00:00.000Z",
          freshness: "unknown",
          summary: "Synthetic typed context fixture; not native acceptance",
        },
        observation,
      };
      const parsed = desktopContextDetailSchema.parse(
        contextOperationResultSchema.parse(detail),
      );
      expect(parsed).toEqual(detail);
      if (parsed.observation.schema === "audio-observation/v2") {
        expect(
          parsed.observation.alignment.verifiedAbsoluteErrorBoundSamples,
        ).toBeNull();
        expect(parsed.observation.algorithm).not.toHaveProperty(
          "timingUncertaintySamples",
        );
      } else {
        expect(parsed.observation.algorithm.timingUncertaintySamples).toBe(64);
        expect(parsed.observation).not.toHaveProperty("alignment");
      }
      const mismatched = {
        ...detail,
        entry: {
          ...detail.entry,
          kind: version === 2 ? "audio-observation/v1" : "audio-observation/v2",
        },
      };
      expect(desktopContextDetailSchema.safeParse(mismatched).success).toBe(
        false,
      );
      expect(contextOperationResultSchema.safeParse(mismatched).success).toBe(
        false,
      );
      for (const extra of [{ sql: "select *" }, { rawAudio: [1, 2] }]) {
        expect(
          desktopContextDetailSchema.safeParse({
            ...detail,
            ...extra,
          }).success,
        ).toBe(false);
      }
    },
  );
});
