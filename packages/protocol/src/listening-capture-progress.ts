import { z } from "zod";

export const listeningCaptureProgressSchema = z
  .strictObject({
    sampleRate: z.union([z.literal(44_100), z.literal(48_000)]),
    requestedSamples: z.number().int().min(1).max(28_800_000),
    persistedSamples: z.number().int().min(0).max(28_800_000),
    persistedChunks: z.number().int().min(0).max(1_000_000),
  })
  .refine(
    (progress) => progress.persistedSamples <= progress.requestedSamples,
    "Durable coverage cannot exceed the requested capture",
  );
export type ListeningCaptureProgress = z.infer<
  typeof listeningCaptureProgressSchema
>;
