import { z } from "zod";

export const sessionListeningLaunchDetailSchema = z
  .strictObject({
    state: z.enum([
      "requested",
      "queued",
      "observed",
      "verified",
      "indeterminate",
    ]),
    mutationState: z.enum([
      "not-attempted",
      "indeterminate",
      "observed-playing",
    ]),
  })
  .refine(
    (value) =>
      !["observed", "verified"].includes(value.state) ||
      value.mutationState === "observed-playing",
    "Observed or verified launch requires an exact playing-source witness",
  );

export const sessionListeningJobDetailSchema = z.strictObject({
  clipName: z.string().max(128),
  trackName: z.string().max(128),
  sceneIndex: z.number().int().min(0).max(255),
  durationBeats: z.number().finite().positive().max(4),
  launch: sessionListeningLaunchDetailSchema.optional(),
});

export type SessionListeningLaunchDetail = z.infer<
  typeof sessionListeningLaunchDetailSchema
>;
export type SessionListeningJobDetail = z.infer<
  typeof sessionListeningJobDetailSchema
>;
