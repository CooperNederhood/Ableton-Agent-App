import { z } from "zod";

const identifier = z.string().min(1).max(128);
const checkIdentifier = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u)
  .max(128);
const observedValue = z.union([
  z
    .number()
    .finite()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.string().max(256),
]);

export const listeningEvidenceValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("observed"),
    value: observedValue,
    truncated: z.literal(true).optional(),
    originalLength: z
      .number()
      .int()
      .min(257)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum([
      "not-reported",
      "not-reached",
      "unsupported",
      "invalid",
      "nonfinite",
      "dropped",
      "unknown",
    ]),
  }),
]);

export const listeningFailureFactSchema = z.strictObject({
  field: checkIdentifier,
  actual: listeningEvidenceValueSchema,
  expected: listeningEvidenceValueSchema.optional(),
  comparison: z
    .enum([
      "equal",
      "at-most",
      "less-than",
      "at-least",
      "present",
      "matches",
      "contains-all-bits",
    ])
    .optional(),
  unit: z
    .enum([
      "ms",
      "samples",
      "frames",
      "beats",
      "Hz",
      "count",
      "boolean",
      "identity",
      "state",
      "flags",
      "epoch",
      "fraction",
      "bpm",
    ])
    .optional(),
});

export const listeningFailureEvidenceSchema = z
  .strictObject({
    schema: z.literal("listening-failure/v1"),
    code: checkIdentifier,
    phase: z.enum([
      "validation",
      "preparation",
      "preflight",
      "arming",
      "launch",
      "capture",
      "post-binding",
      "publication",
      "cleanup",
    ]),
    component: z.enum([
      "tool",
      "binding",
      "native-controller",
      "native-assembler",
      "native-engine",
      "native-io",
      "producer-sdk",
      "ingress",
      "capture-runtime",
      "session-source",
      "listening-coordinator",
      "publication",
      "cleanup",
    ]),
    checkId: checkIdentifier,
    summary: z.string().min(1).max(1024),
    coverage: z.enum(["complete", "partial", "unavailable"]),
    coverageReasons: z
      .array(
        z.enum([
          "source-evidence-not-reported",
          "unsupported-source",
          "invalid-evidence",
          "missing-operands",
          "diagnostic-truncated",
          "diagnostic-dropped",
          "source-disconnected",
          "journal-unavailable",
        ]),
      )
      .max(8),
    facts: z.array(listeningFailureFactSchema).max(24),
    reference: z.strictObject({
      traceId: z.string().uuid(),
      passId: identifier,
      correlationId: identifier.optional(),
      causationId: identifier.optional(),
      jobId: identifier.optional(),
      requestId: identifier.optional(),
      diagnosticScope: checkIdentifier.optional(),
    }),
    listener: z
      .strictObject({
        listenerId: identifier,
        instanceId: identifier,
        connectionId: identifier,
        connectionEpoch: identifier,
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.coverage === "complete") {
      if (
        value.coverageReasons.length ||
        !value.facts.some((fact) => fact.actual.state === "observed")
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage"],
          message:
            "Complete evidence requires observed operands and no coverage gaps",
        });
      }
    } else if (!value.coverageReasons.length) {
      context.addIssue({
        code: "custom",
        path: ["coverageReasons"],
        message: "Incomplete evidence must explain its coverage gap",
      });
    }
  });

export type ListeningFailureEvidence = z.infer<
  typeof listeningFailureEvidenceSchema
>;
export type ListeningFailureFact = z.infer<typeof listeningFailureFactSchema>;

export function readListeningFailureEvidence(error: unknown):
  | { readonly status: "present"; readonly evidence: ListeningFailureEvidence }
  | { readonly status: "absent" }
  | {
      readonly status: "invalid";
      readonly reason: "schema" | "accessor" | "error-chain-limit";
    } {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || typeof current !== "object")
      return { status: "absent" };
    const evidence = Object.getOwnPropertyDescriptor(
      current,
      "failureEvidence",
    );
    if (evidence && !("value" in evidence))
      return { status: "invalid", reason: "accessor" };
    if (evidence?.value !== undefined) {
      const parsed = listeningFailureEvidenceSchema.safeParse(evidence.value);
      return parsed.success
        ? { status: "present", evidence: parsed.data }
        : { status: "invalid", reason: "schema" };
    }
    const errors = Object.getOwnPropertyDescriptor(current, "errors");
    if (
      current instanceof AggregateError &&
      Array.isArray(errors?.value) &&
      errors.value.length
    ) {
      current = errors.value[0];
      continue;
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    if (cause && !("value" in cause))
      return { status: "invalid", reason: "accessor" };
    if (cause?.value === undefined) return { status: "absent" };
    current = cause.value;
  }
  return { status: "invalid", reason: "error-chain-limit" };
}
