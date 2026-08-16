import type {
  FilterDecision,
  OutputAssignment,
  SignalEnvelope,
  SignalKind,
  TranslatedSignalContext,
} from "./contracts.js";
import { outputAssignmentSchema } from "./contracts.js";
import {
  ExactDuplicateWindowFilter,
  SequenceReplayFilter,
  type SignalFilter,
  validateSignalEnvelope,
} from "./filters.js";
import type { InMemoryConnectionRegistry } from "./registry.js";
import { SignalRoutingSummaryPublisher } from "./summaries.js";
import {
  AudioSignalTranslator,
  MidiSignalTranslator,
  type SignalTranslator,
  UnsupportedSignalPayloadError,
} from "./translation.js";

export interface AssignmentDeliveryResult {
  readonly assignmentId: string;
  readonly decision: FilterDecision;
}

export interface RouteResult {
  readonly accepted: boolean;
  readonly decisions: readonly FilterDecision[];
  readonly deliveries: readonly AssignmentDeliveryResult[];
}

export interface SignalRouterOptions {
  readonly registry: InMemoryConnectionRegistry;
  readonly maxInboxSize?: number;
  readonly filters?: readonly SignalFilter[];
  readonly translators?: readonly SignalTranslator[];
  readonly publisher?: SignalRoutingSummaryPublisher;
}

export class SignalRouter {
  readonly #registry: InMemoryConnectionRegistry;
  readonly #maxInboxSize: number;
  readonly #filters: readonly SignalFilter[];
  readonly #translators = new Map<SignalKind, SignalTranslator>();
  readonly #assignments = new Map<string, OutputAssignment>();
  readonly #inboxes = new Map<string, TranslatedSignalContext[]>();
  readonly publisher: SignalRoutingSummaryPublisher;

  constructor(options: SignalRouterOptions) {
    this.#registry = options.registry;
    this.#maxInboxSize = options.maxInboxSize ?? 16;
    if (!Number.isInteger(this.#maxInboxSize) || this.#maxInboxSize <= 0) {
      throw new RangeError("maxInboxSize must be a positive integer");
    }
    this.#filters = options.filters ?? [
      new SequenceReplayFilter(),
      new ExactDuplicateWindowFilter(),
    ];
    for (const translator of options.translators ?? [
      new MidiSignalTranslator(),
      new AudioSignalTranslator(),
    ]) {
      this.#translators.set(translator.signalKind, translator);
    }
    this.publisher = options.publisher ?? new SignalRoutingSummaryPublisher();
  }

  upsertAssignment(input: OutputAssignment): OutputAssignment {
    const assignment = outputAssignmentSchema.parse(input);
    this.#assignments.set(assignment.assignmentId, assignment);
    if (!this.#inboxes.has(assignment.assignmentId)) {
      this.#inboxes.set(assignment.assignmentId, []);
    }
    this.publisher.publishAssignments(this.listAssignments());
    return assignment;
  }

  removeAssignment(assignmentId: string): boolean {
    this.#inboxes.delete(assignmentId);
    const removed = this.#assignments.delete(assignmentId);
    if (removed) {
      this.publisher.publishAssignments(this.listAssignments());
    }
    return removed;
  }

  listAssignments(): readonly OutputAssignment[] {
    return [...this.#assignments.values()];
  }

  inbox(assignmentId: string): readonly TranslatedSignalContext[] {
    return [...(this.#inboxes.get(assignmentId) ?? [])];
  }

  drain(assignmentId: string): readonly TranslatedSignalContext[] {
    const inbox = this.#inboxes.get(assignmentId) ?? [];
    this.#inboxes.set(assignmentId, []);
    this.publisher.publishInbox(assignmentId, []);
    return inbox;
  }

  acknowledge(
    assignmentId: string,
    sequences: readonly number[],
  ): readonly TranslatedSignalContext[] {
    const acknowledged = new Set(sequences);
    const nextInbox = (this.#inboxes.get(assignmentId) ?? []).filter(
      (context) => !acknowledged.has(context.sequence),
    );
    this.#inboxes.set(assignmentId, nextInbox);
    this.publisher.publishInbox(assignmentId, nextInbox);
    return nextInbox;
  }

  route(input: unknown): RouteResult {
    const validation = validateSignalEnvelope(input);
    if (!validation.success) {
      return {
        accepted: false,
        decisions: [validation.decision],
        deliveries: [],
      };
    }
    return this.#routeValidated(validation.envelope);
  }

  #routeValidated(envelope: SignalEnvelope): RouteResult {
    const connection = this.#registry.get(envelope.connectionId);
    if (connection === undefined || connection.status !== "connected") {
      const decision: FilterDecision = {
        accepted: false,
        code: "connection-unavailable",
        reason: `Connection ${envelope.connectionId} is not connected`,
      };
      return { accepted: false, decisions: [decision], deliveries: [] };
    }
    const expectedSchema =
      connection.producer.signalKind === "midi"
        ? "midi-sample/v1"
        : "audio-reference/v1";
    if (envelope.payload.schema !== expectedSchema) {
      const decision: FilterDecision = {
        accepted: false,
        code: "producer-mismatch",
        reason: `Producer expects ${expectedSchema}, received ${envelope.payload.schema}`,
      };
      return { accepted: false, decisions: [decision], deliveries: [] };
    }

    const decisions: FilterDecision[] = [];
    for (const filter of this.#filters) {
      const decision = filter.evaluate(envelope, { connection });
      decisions.push(decision);
      if (!decision.accepted) {
        return { accepted: false, decisions, deliveries: [] };
      }
    }

    const deliveries: AssignmentDeliveryResult[] = [];
    const assignments = this.listAssignments().filter(
      (assignment) =>
        assignment.enabled &&
        assignment.producerId === connection.producer.producerId,
    );
    for (const assignment of assignments) {
      const inbox = this.#inboxes.get(assignment.assignmentId) ?? [];
      const coalesces =
        assignment.processingPolicyIds.includes("latest-window");
      if (!coalesces && inbox.length >= this.#maxInboxSize) {
        deliveries.push({
          assignmentId: assignment.assignmentId,
          decision: {
            accepted: false,
            code: "queue-bound",
            reason: `Inbox reached its ${this.#maxInboxSize}-item bound`,
          },
        });
        continue;
      }
      const translator = this.#translators.get(connection.producer.signalKind);
      if (translator === undefined) {
        deliveries.push({
          assignmentId: assignment.assignmentId,
          decision: {
            accepted: false,
            code: "unsupported-payload",
            reason: `No translator for ${connection.producer.signalKind}`,
          },
        });
        continue;
      }
      try {
        const translated = translator.translate({
          envelope,
          connection,
          assignment,
        });
        const nextInbox = coalesces ? [translated] : [...inbox, translated];
        this.#inboxes.set(assignment.assignmentId, nextInbox);
        this.publisher.publishInbox(assignment.assignmentId, nextInbox);
        deliveries.push({
          assignmentId: assignment.assignmentId,
          decision: {
            accepted: true,
            reason: coalesces
              ? "Delivered by replacing the latest window"
              : "Delivered to the bounded inbox",
          },
        });
      } catch (error) {
        if (!(error instanceof UnsupportedSignalPayloadError)) {
          throw error;
        }
        deliveries.push({
          assignmentId: assignment.assignmentId,
          decision: {
            accepted: false,
            code: "unsupported-payload",
            reason: error.message,
          },
        });
      }
    }
    return {
      accepted: deliveries.every(({ decision }) => decision.accepted),
      decisions,
      deliveries,
    };
  }
}
