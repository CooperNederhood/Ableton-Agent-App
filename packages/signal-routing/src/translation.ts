import type {
  AudioSignalReference,
  MidiSampleV1,
  OutputAssignment,
  OutputConnection,
  SignalEnvelope,
  SignalKind,
  TranslatedSignalContext,
} from "./contracts.js";

export interface SignalTranslationInput {
  readonly envelope: SignalEnvelope;
  readonly connection: OutputConnection;
  readonly assignment: OutputAssignment;
}

export interface SignalTranslator {
  readonly signalKind: SignalKind;
  translate(input: SignalTranslationInput): TranslatedSignalContext;
}

export class UnsupportedSignalPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSignalPayloadError";
  }
}

function noteDescription(note: MidiSampleV1["notes"][number]): string {
  const continuation = [
    note.continued_from_previous ? "continued-from-previous" : undefined,
    note.continues_into_next ? "continues-into-next" : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(",");
  const suffix = continuation.length === 0 ? "" : ` ${continuation}`;
  return `beat +${note.onset_beats}: ${note.name} (MIDI ${note.pitch}), channel ${note.channel}, velocity ${note.velocity}, duration ${note.duration_beats} beats${suffix}`;
}

export class MidiSignalTranslator implements SignalTranslator {
  readonly signalKind = "midi" as const;

  translate(input: SignalTranslationInput): TranslatedSignalContext {
    if (input.envelope.payload.schema !== "midi-sample/v1") {
      throw new UnsupportedSignalPayloadError(
        `MIDI translator does not support ${input.envelope.payload.schema}`,
      );
    }
    const sample = input.envelope.payload;
    const producer = input.connection.producer;
    const sourceIdentity = `${producer.displayName} [producer=${producer.producerId}, instance=${producer.instanceId}]`;
    const notes = [...sample.notes]
      .sort(
        (left, right) =>
          left.onset_beats - right.onset_beats ||
          left.channel - right.channel ||
          left.pitch - right.pitch,
      )
      .map(noteDescription);
    const content = [
      `MIDI source: ${sourceIdentity}`,
      `Window: ${sample.start_beat}-${sample.end_beat} beats (${sample.length_beats} beats), ${sample.complete ? "complete" : `partial: ${sample.end_reason}`}.`,
      `Notes (${notes.length}):`,
      ...(notes.length === 0 ? ["(none)"] : notes),
    ].join("\n");
    return {
      assignmentId: input.assignment.assignmentId,
      producerId: producer.producerId,
      consumer: input.assignment.consumer,
      deliveryMode: input.assignment.deliveryMode,
      sequence: input.envelope.sequence,
      capturedAt: input.envelope.capturedAt,
      sourceIdentity,
      content,
    };
  }
}

export class AudioSignalTranslator implements SignalTranslator {
  readonly signalKind = "audio" as const;

  translate(input: SignalTranslationInput): TranslatedSignalContext {
    const payload = input.envelope.payload as AudioSignalReference;
    throw new UnsupportedSignalPayloadError(
      `Audio payload delivery is not supported yet (${payload.schema}); raw PCM is never accepted`,
    );
  }
}
