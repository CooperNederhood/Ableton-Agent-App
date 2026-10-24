import { z } from "zod";
import {
  inspectSessionListeningSourceParamsSchema,
  inspectSessionListeningSourceResultSchema,
} from "./session-listening-source-schemas.js";
import { workflowDeviceTargetSchema } from "./workflow-adapter-schemas.js";

const identity = {
  schemaVersion: z.literal(1),
  ownerId: z.string().uuid(),
  passId: z.string().uuid(),
};
const durationBeats = z.number().finite().positive().max(4);
const globalBeat = z.number().finite().min(0).max(1_576_800);
const target = inspectSessionListeningSourceParamsSchema.shape.target;

export const prepareSessionListeningPassParamsSchema = z
  .strictObject({
    ...identity,
    action: z.literal("prepare"),
    expectedLiveSetId: z.string().min(1).max(128),
    expectedProjectRevision: z.number().int().nonnegative(),
    target,
    listener: z.strictObject({
      ...workflowDeviceTargetSchema.shape,
      track: target.shape.track,
      deviceIndex: z.number().int().min(0).max(31),
    }),
    durationBeats,
    timingAnchor: z.strictObject({ globalBeat }),
  })
  .refine(
    (value) =>
      value.listener.track.kind === value.target.track.kind &&
      value.listener.track.index === value.target.track.index &&
      value.listener.track.expectedReference ===
        value.target.track.expectedReference &&
      value.listener.track.expectedName === value.target.track.expectedName,
    "Listener must independently resolve to the exact source track",
  );

export const launchSessionListeningPassParamsSchema = z.strictObject({
  ...identity,
  action: z.literal("launch"),
});
export const inspectSessionListeningPassParamsSchema = z.strictObject({
  ...identity,
  action: z.literal("inspect"),
});
export const releaseSessionListeningPassParamsSchema = z.strictObject({
  ...identity,
  action: z.literal("release"),
  reason: z.enum(["completed", "cancelled"]),
});

/** Convenient local dispatch union; only the granular launch command mutates. */
export const sessionListeningPassParamsSchema = z.discriminatedUnion("action", [
  prepareSessionListeningPassParamsSchema,
  launchSessionListeningPassParamsSchema,
  inspectSessionListeningPassParamsSchema,
  releaseSessionListeningPassParamsSchema,
]);

/** Polled LOM origin plus event evidence, never native/sample-clock authority. */
export const sessionListeningPassResultSchema = z
  .strictObject({
    ...identity,
    status: z.enum([
      "prepared",
      "accepted",
      "queued",
      "playing",
      "unverified",
      "invalidated",
      "released",
      "cancelled",
      "expired",
    ]),
    mutationState: z.enum([
      "not-attempted",
      "indeterminate",
      "observed-playing",
    ]),
    reason: z.string().min(1).max(512).nullable(),
    cleanupPolicy: z.literal("leave-running"),
    evidence: z.literal("message-rate-only"),
    nativeAlignment: z.literal("unverified"),
    lastObservedSource: inspectSessionListeningSourceResultSchema.shape.after,
    sourceEpoch: z
      .strictObject({
        startTimeBeats: globalBeat,
        clipReference: z.string().uuid(),
        observedGlobalBeat: globalBeat,
      })
      .nullable(),
    followActionState: z.enum(["known-disabled", "unknown"]),
    limitations: z.array(z.string().min(1).max(512)).min(1).max(4),
    durationBeats,
    expiresInMs: z.number().int().min(0).max(40_000),
  })
  .refine(
    (value) =>
      (value.sourceEpoch !== null) ===
        (value.mutationState === "observed-playing") &&
      (value.status !== "playing" || value.sourceEpoch !== null) &&
      (value.status !== "prepared" ||
        value.mutationState === "not-attempted") &&
      (value.sourceEpoch === null ||
        value.sourceEpoch.startTimeBeats <=
          value.sourceEpoch.observedGlobalBeat) &&
      (value.followActionState !== "unknown" || value.limitations.length >= 2),
    "Playing requires an observed exact source epoch; unknown follow state needs an explicit limitation",
  );

export type SessionListeningPassParams = z.infer<
  typeof sessionListeningPassParamsSchema
>;
export type PrepareSessionListeningPassParams = z.infer<
  typeof prepareSessionListeningPassParamsSchema
>;
export type LaunchSessionListeningPassParams = z.infer<
  typeof launchSessionListeningPassParamsSchema
>;
export type InspectSessionListeningPassParams = z.infer<
  typeof inspectSessionListeningPassParamsSchema
>;
export type ReleaseSessionListeningPassParams = z.infer<
  typeof releaseSessionListeningPassParamsSchema
>;
export type SessionListeningPassResult = z.infer<
  typeof sessionListeningPassResultSchema
>;
