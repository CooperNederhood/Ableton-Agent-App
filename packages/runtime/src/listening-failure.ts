import {
  listeningFailureEvidenceSchema,
  type ListeningFailureEvidence,
  type ListeningFailureFact,
} from "@ableton-agent/protocol";
import { sanitizePersistedText } from "@ableton-agent/observability";
import type { ListenerDescriptor } from "@ableton-agent/signal-routing";
import { ListeningFailure } from "@ableton-agent/application";

export class ListeningRuntimeRejection extends ListeningFailure {
  constructor(
    code: string,
    detail: string | undefined,
    readonly rejectionFacts: readonly ListeningFailureFact[],
  ) {
    super(code, detail ? `${code}: ${detail}` : code);
  }
}

export function denyListening(
  code: string,
  detail?: string,
  facts: readonly ListeningFailureFact[] = [],
): never {
  throw new ListeningRuntimeRejection(code, detail, facts);
}

interface CaptureFailureInput {
  readonly code: string;
  readonly message: string;
  readonly phase: ListeningFailureEvidence["phase"];
  readonly checkId: string;
  readonly trace: {
    readonly traceId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
  readonly passId: string;
  readonly jobId?: string;
  readonly requestId?: string;
  readonly listener?: ListenerDescriptor;
  readonly facts?: readonly ListeningFailureFact[];
  readonly component?: ListeningFailureEvidence["component"];
  readonly coverage?: ListeningFailureEvidence["coverage"];
  readonly coverageReasons?: ListeningFailureEvidence["coverageReasons"];
}

export function failureFact(
  field: string,
  actual: unknown,
  expected?: unknown,
  options: Pick<ListeningFailureFact, "comparison" | "unit"> = {},
): ListeningFailureFact {
  return {
    field,
    actual: factValue(actual),
    ...(expected === undefined ? {} : { expected: factValue(expected) }),
    ...options,
  };
}

function factValue(value: unknown): ListeningFailureFact["actual"] {
  if (
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  )
    return { state: "observed", value };
  if (typeof value === "string") {
    const sanitized = sanitizePersistedText(value);
    return sanitized.length <= 256
      ? { state: "observed", value: sanitized }
      : {
          state: "observed",
          value: `${sanitized.slice(0, 244)} [Truncated]`,
          truncated: true,
          originalLength: sanitized.length,
        };
  }
  return {
    state: "unavailable",
    reason:
      value === null || value === undefined
        ? "not-reported"
        : typeof value === "number" && !Number.isFinite(value)
          ? "nonfinite"
          : "invalid",
  };
}

export function captureFailureEvidence(
  input: CaptureFailureInput,
): ListeningFailureEvidence {
  const identity = (value: string) =>
    sanitizePersistedText(value).slice(0, 128);
  const facts = (input.facts ?? []).map((fact) => ({
    ...fact,
    actual:
      fact.actual.state === "observed"
        ? { ...fact.actual, ...factValue(fact.actual.value) }
        : fact.actual,
    ...(fact.expected === undefined
      ? {}
      : {
          expected:
            fact.expected.state === "observed"
              ? { ...fact.expected, ...factValue(fact.expected.value) }
              : fact.expected,
        }),
  }));
  const truncated =
    facts.length > 24 ||
    facts.some(
      (fact) =>
        (fact.actual.state === "observed" && fact.actual.truncated) ||
        (fact.expected?.state === "observed" && fact.expected.truncated),
    );
  const unavailable = facts.some(
    (fact) =>
      fact.actual.state === "unavailable" ||
      fact.expected?.state === "unavailable",
  );
  const requestedCoverage = input.coverage ?? "unavailable";
  const coverageReasons = [
    ...new Set([
      ...(input.coverageReasons ??
        (requestedCoverage === "unavailable"
          ? ["source-evidence-not-reported" as const]
          : [])),
      ...(truncated ? ["diagnostic-truncated" as const] : []),
      ...(requestedCoverage === "complete" && unavailable
        ? ["missing-operands" as const]
        : []),
    ]),
  ];
  const message = sanitizePersistedText(input.message);
  const evidence = listeningFailureEvidenceSchema.parse({
    schema: "listening-failure/v1",
    code:
      /^[a-z][a-z0-9_-]*$/u.test(message) && message.length <= 128
        ? message
        : input.code,
    phase: input.phase,
    component: input.component ?? "capture-runtime",
    checkId: input.checkId,
    summary: message.slice(0, 1024),
    coverage:
      requestedCoverage === "complete" && coverageReasons.length
        ? "partial"
        : requestedCoverage,
    coverageReasons,
    facts: facts.slice(0, 24),
    reference: {
      traceId: input.trace.traceId,
      correlationId: identity(input.trace.correlationId),
      causationId: identity(input.trace.causationId),
      passId: identity(input.passId),
      ...(input.jobId === undefined ? {} : { jobId: identity(input.jobId) }),
      ...(input.requestId === undefined
        ? {}
        : { requestId: identity(input.requestId) }),
    },
    ...(input.listener === undefined
      ? {}
      : {
          listener: {
            listenerId: identity(input.listener.producer.producerId),
            instanceId: identity(input.listener.producer.instanceId),
            connectionId: identity(input.listener.connectionId),
            connectionEpoch: identity(
              input.listener.registration.connectionEpoch,
            ),
          },
        }),
  });
  const freeze = (value: object): void => {
    for (const child of Object.values<unknown>({ ...value }))
      if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(evidence);
  return evidence;
}
