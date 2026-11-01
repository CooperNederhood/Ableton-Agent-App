import { z } from "zod";

/** Prototype only: no production publisher is enabled by these declarations. */
export const LISTENER_MEASUREMENT_COUNTER_MAX = 2 ** 44 - 1;
const counter = z.number().int().min(0).max(LISTENER_MEASUREMENT_COUNTER_MAX);
const sequence = counter.min(1);
const epoch = z.number().int().min(1).max(1_000_000);
const numeric = z
  .number()
  .finite()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const token = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z][A-Za-z0-9_./-]*$/);

export const listenerMeasurementDeclarationSchema = z
  .strictObject({
    version: z.literal(1),
    kind: token(64),
    algorithmVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/),
    sampleRate: z.union([z.literal(44_100), z.literal(48_000)]),
    hopSamples: z.number().int().min(1).max(65_536),
    windowSamples: z.number().int().min(1).max(65_536),
    width: z.number().int().min(1).max(64),
    capacity: z.number().int().min(1).max(128),
    fields: z
      .array(z.strictObject({ name: token(64), unit: token(32) }))
      .min(1)
      .max(64),
  })
  .superRefine((value, ctx) => {
    const envelope =
      value.kind === "native-envelope" || value.kind === "native-envelope/v2";
    const spectrum =
      value.kind === "native-spectrum" || value.kind === "native-spectrum/v2";
    if (
      value.fields.length !== value.width ||
      new Set(value.fields.map((field) => field.name)).size !==
        value.fields.length ||
      ((envelope || spectrum) &&
        (value.algorithmVersion !== "2.0.0" ||
          value.width !== (envelope ? 16 : 6) ||
          value.capacity !== (envelope ? 16 : 32)))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid measurement declaration dimensions or fields",
      });
    }
  });
export type ListenerMeasurementDeclaration = z.infer<
  typeof listenerMeasurementDeclarationSchema
>;

const recordShape = z.strictObject({
  version: z.literal(1),
  kind: token(64),
  epoch,
  sequence,
  startSample: counter,
  endSample: counter,
  values: z.array(numeric).min(1).max(64),
});
export type ListenerMeasurementRecord = z.infer<typeof recordShape>;

/** Unknown kinds require this explicitly validated declaration, never a generic JSON record. */
export function listenerMeasurementRecordSchema(
  declaration: ListenerMeasurementDeclaration,
) {
  const declared = listenerMeasurementDeclarationSchema.parse(declaration);
  return recordShape.superRefine((value, ctx) => {
    if (
      value.kind !== declared.kind ||
      value.values.length !== declared.width ||
      value.endSample < value.startSample
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Record does not match declared measurement",
      });
    }
  });
}

/** Validate a healthy row or coherent empty no-owner ABI; caller owns request/epoch history. */
export function listenerMeasurementReadbackSchema(
  declaration: ListenerMeasurementDeclaration,
) {
  const declared = listenerMeasurementDeclarationSchema.parse(declaration);
  return z
    .array(numeric)
    .length(declared.width + 14)
    .superRefine((row, ctx) => {
      const width = declared.width;
      if (row[1] === 0) {
        const empty =
          row[0] === 1 &&
          (row[2] === 0 || row[2] === 1) &&
          row[2] === row[width + 12] &&
          row
            .slice(1)
            .every(
              (value, index) =>
                index + 1 === 2 || index + 1 === width + 12 || value === 0,
            );
        if (!empty)
          ctx.addIssue({
            code: "custom",
            message: "Invalid uninitialized measurement readback",
          });
        return;
      }
      const valid =
        row[0] === 1 &&
        epoch.safeParse(row[1]).success &&
        sequence.safeParse(row[2]).success &&
        counter.safeParse(row[3]).success &&
        row[3]! <= 1_000_000 &&
        counter.safeParse(row[4]).success &&
        counter.safeParse(row[5]).success &&
        counter.safeParse(row[6]).success &&
        row[6]! >= row[5]! &&
        counter.safeParse(row[7]).success &&
        counter.safeParse(row[8]).success &&
        row[8]! <= row[7]! &&
        row[7]! - row[8]! <= declared.capacity &&
        row[9] === 0 &&
        row[1] === row[width + 13] &&
        row[2] === row[width + 12] &&
        row[3] === row[width + 11] &&
        row[4] === row[width + 10] &&
        (row[7]! < row[2]! || (row[3] === row[1] && row[4] === row[2]));
      if (!valid)
        ctx.addIssue({
          code: "custom",
          message: "Invalid or faulted measurement readback",
        });
    });
}
