import { z } from "zod";

export const MAX_NATIVE_LISTENING_SECONDS = 30;
export const MAX_NATIVE_LISTENING_WINDOWS = 300;

const inputSchema = z.strictObject({
  sampleRate: z.union([z.literal(44_100), z.literal(48_000)]),
  vectorSize: z
    .number()
    .int()
    .min(1)
    .max(1_024)
    .refine((value) => (value & (value - 1)) === 0),
  tempoBpm: z.number().finite().min(20).max(999),
  startBeat: z.number().finite().min(0).max(1_576_800),
  endBeat: z.number().finite().min(0).max(1_576_800),
});

export const nativeListeningGeometrySchema = inputSchema
  .extend({
    hopSamples: z.number().int().min(1).max(4_800),
    totalSamples: z.number().int().min(1).max(1_440_000),
  })
  .superRefine((value, ctx) => {
    const expected = Math.round(
      ((value.endBeat - value.startBeat) * value.sampleRate * 60) /
        value.tempoBpm,
    );
    if (
      value.endBeat <= value.startBeat ||
      value.hopSamples !== Math.round(value.sampleRate / 10) ||
      value.totalSamples !== expected ||
      value.totalSamples < value.hopSamples ||
      value.totalSamples > MAX_NATIVE_LISTENING_SECONDS * value.sampleRate ||
      Math.ceil(value.totalSamples / value.hopSamples) >
        MAX_NATIVE_LISTENING_WINDOWS
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unsupported native listening geometry",
      });
    }
  });

export type NativeListeningGeometry = z.infer<
  typeof nativeListeningGeometrySchema
>;

/** Arithmetic/metadata validation, not qualification of a physical host/vector. */
export function createNativeListeningGeometry(
  input: z.input<typeof inputSchema>,
): Readonly<NativeListeningGeometry> {
  const value = inputSchema.parse(input);
  return Object.freeze(
    nativeListeningGeometrySchema.parse({
      ...value,
      hopSamples: Math.round(value.sampleRate / 10),
      totalSamples: Math.round(
        ((value.endBeat - value.startBeat) * value.sampleRate * 60) /
          value.tempoBpm,
      ),
    }),
  );
}
