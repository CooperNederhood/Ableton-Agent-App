import {
  MAX_SIGNAL_PAYLOAD_BYTES,
  type FilterDecision,
  type OutputConnection,
  type SignalEnvelope,
  signalEnvelopeSchema,
} from "./contracts.js";

export interface SignalFilterContext {
  readonly connection: OutputConnection;
}

export interface SignalFilter {
  evaluate(
    envelope: SignalEnvelope,
    context: SignalFilterContext,
  ): FilterDecision;
}

export function validateSignalEnvelope(
  input: unknown,
):
  | { readonly success: true; readonly envelope: SignalEnvelope }
  | { readonly success: false; readonly decision: FilterDecision } {
  const parsed = signalEnvelopeSchema.safeParse(input);
  if (parsed.success) {
    return { success: true, envelope: parsed.data };
  }
  const payloadTooLarge = parsed.error.issues.some((issue) =>
    issue.message.includes(`exceeds ${MAX_SIGNAL_PAYLOAD_BYTES}`),
  );
  return {
    success: false,
    decision: {
      accepted: false,
      code: payloadTooLarge ? "payload-too-large" : "invalid-schema",
      reason: parsed.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "envelope"}: ${issue.message}`,
        )
        .join("; "),
    },
  };
}

export class SequenceReplayFilter implements SignalFilter {
  readonly #lastSequence = new Map<string, number>();

  evaluate(envelope: SignalEnvelope): FilterDecision {
    const previous = this.#lastSequence.get(envelope.connectionId);
    if (previous !== undefined && envelope.sequence <= previous) {
      return {
        accepted: false,
        code: "sequence-replay",
        reason: `Sequence ${envelope.sequence} is not newer than ${previous}`,
      };
    }
    this.#lastSequence.set(envelope.connectionId, envelope.sequence);
    return { accepted: true, reason: "Sequence is newer than the last frame" };
  }
}

export class ExactDuplicateWindowFilter implements SignalFilter {
  readonly #seenByProducer = new Map<string, string[]>();
  readonly #windowSize: number;

  constructor(windowSize = 32) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError("Duplicate window size must be a positive integer");
    }
    this.#windowSize = windowSize;
  }

  evaluate(
    envelope: SignalEnvelope,
    context: SignalFilterContext,
  ): FilterDecision {
    const fingerprint = JSON.stringify(envelope.payload);
    const producerId = context.connection.producer.producerId;
    const seen = this.#seenByProducer.get(producerId) ?? [];
    if (seen.includes(fingerprint)) {
      return {
        accepted: false,
        code: "exact-duplicate",
        reason: `Payload exactly duplicates one of the last ${this.#windowSize} windows`,
      };
    }
    seen.push(fingerprint);
    if (seen.length > this.#windowSize) {
      seen.shift();
    }
    this.#seenByProducer.set(producerId, seen);
    return { accepted: true, reason: "Payload is not an exact duplicate" };
  }
}
