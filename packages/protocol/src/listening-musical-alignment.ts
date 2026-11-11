import { z } from "zod";

export const listeningMusicalAlignmentSchema = z.strictObject({
  version: z.literal(1),
  coordinate: z.enum(["clip-local-beats", "transport-beats"]),
  meter: z.strictObject({
    numerator: z.number().int().min(1).max(128),
    denominator: z
      .number()
      .int()
      .min(1)
      .max(128)
      .refine(
        (value) => (value & (value - 1)) === 0,
        "Meter denominator must be a power of two",
      ),
  }),
  barOriginBeat: z.number().finite().min(-1_576_800).max(1_576_800),
  tempoBpm: z.number().finite().min(20).max(999),
  tempoEvidence: z.literal("message-rate-monitored-constant"),
  provenance: z.enum(["session-clip-markers/v1", "capture-snapshot/v1"]),
});
export type ListeningMusicalAlignment = z.infer<
  typeof listeningMusicalAlignmentSchema
>;

/** Call only after pass-owned source monitoring and its terminal seal succeeded. */
export function sessionMusicalAlignment(settings: {
  readonly tempoBpm: number | null;
  readonly clipSignatureNumerator: number | null;
  readonly clipSignatureDenominator: number | null;
  readonly startMarker: number | null;
  readonly loopStart: number | null;
}): ListeningMusicalAlignment | undefined {
  if (
    settings.tempoBpm === null ||
    settings.clipSignatureNumerator === null ||
    settings.clipSignatureDenominator === null ||
    settings.startMarker !== 0 ||
    settings.loopStart !== 0
  )
    return undefined;
  return listeningMusicalAlignmentSchema.parse({
    version: 1,
    coordinate: "clip-local-beats",
    meter: {
      numerator: settings.clipSignatureNumerator,
      denominator: settings.clipSignatureDenominator,
    },
    barOriginBeat: 0,
    tempoBpm: settings.tempoBpm,
    tempoEvidence: "message-rate-monitored-constant",
    provenance: "session-clip-markers/v1",
  });
}
