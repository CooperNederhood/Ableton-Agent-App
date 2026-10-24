import { z } from "zod";
import {
  workflowClipTargetSchema,
  workflowTrackTargetSchema,
} from "./workflow-adapter-schemas.js";

const coordinate = z.number().finite().min(-1_576_800).max(1_576_800);
const slot = z.number().int().min(-2).max(255).nullable();
const boundedIndex = z.number().int().min(0).max(255);
const target = z.strictObject({
  ...workflowClipTargetSchema.options[0].shape,
  track: z.strictObject({
    ...workflowTrackTargetSchema.shape,
    kind: z.literal("regular"),
    index: boundedIndex,
  }),
  sceneIndex: boundedIndex,
});
export const inspectSessionListeningSourceParamsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  queryId: z.string().uuid(),
  target,
});
const state = z.strictObject({
  transportPlaying: z.boolean().nullable(),
  globalBeat: coordinate.nullable(),
  startTimeBeats: coordinate.nullable(),
  playingPosition: coordinate.nullable(),
  targetPlaying: z.boolean().nullable(),
  targetTriggered: z.boolean().nullable(),
  targetRecording: z.boolean().nullable(),
  playingSlotIndex: slot,
  firedSlotIndex: slot,
  selectedClipReference: z.string().uuid().nullable(),
});

/** Deferred LOM readings only; no native clock, launch or readiness authority. */
export const inspectSessionListeningSourceResultSchema = z
  .strictObject({
    ...inspectSessionListeningSourceParamsSchema.shape,
    projectRevision: z.number().int().nonnegative(),
    evidence: z.literal("message-rate-only"),
    nativeAlignment: z.literal("unverified"),
    sourceKind: z.enum(["midi", "warped-audio", "unwarped-audio", "unknown"]),
    positionUnit: z.enum(["beats", "seconds"]).nullable(),
    before: state,
    after: state,
    settings: z.strictObject({
      tempoBpm: z.number().finite().positive().nullable(),
      signatureNumerator: z.number().int().min(1).max(128).nullable(),
      signatureDenominator: z.number().int().min(1).max(128).nullable(),
      globalQuantization: z.number().int().min(0).max(14).nullable(),
      launchQuantization: z
        .number()
        .int()
        .min(0)
        .max(14)
        .nullable()
        .describe(
          "Canonical Max ordinal normalized from public Live.Clip.ClipLaunchQuantization members: 0=Global, 1=None, 5=1 Bar; null when native mapping is unavailable or ambiguous.",
        ),
      launchMode: z.number().int().min(0).max(3).nullable(),
      legato: z.boolean().nullable(),
      followActionEnabled: z.boolean().nullable(),
      startMarker: coordinate.nullable(),
      endMarker: coordinate.nullable(),
      loopStart: coordinate.nullable(),
      loopEnd: coordinate.nullable(),
      looping: z.boolean().nullable(),
    }),
  })
  .refine(
    (value) =>
      value.positionUnit ===
      (value.sourceKind === "unknown"
        ? null
        : value.sourceKind === "unwarped-audio"
          ? "seconds"
          : "beats"),
    "Position units must agree with the independently observed clip type",
  );
export type InspectSessionListeningSourceParams = z.infer<
  typeof inspectSessionListeningSourceParamsSchema
>;
export type InspectSessionListeningSourceResult = z.infer<
  typeof inspectSessionListeningSourceResultSchema
>;
