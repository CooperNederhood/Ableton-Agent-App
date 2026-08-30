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
import { recordSignalTelemetry, stableTelemetryId } from "./telemetry.js";
import type { NonBlockingObservabilityRecorder } from "@ableton-agent/observability";

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
  readonly telemetry?: Pick<NonBlockingObservabilityRecorder, "enqueue">;
  readonly now?: () => Date;
}

export class SignalRouter {
  readonly #registry: InMemoryConnectionRegistry;
  readonly #maxInboxSize: number;
  readonly #filters: readonly SignalFilter[];
  readonly #translators = new Map<SignalKind, SignalTranslator>();
  readonly #assignments = new Map<string, OutputAssignment>();
  readonly #inboxes = new Map<string, TranslatedSignalContext[]>();
  readonly publisher: SignalRoutingSummaryPublisher;
  readonly #telemetry:
    Pick<NonBlockingObservabilityRecorder, "enqueue"> | undefined;
  readonly #now: () => Date;

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
    this.#telemetry = options.telemetry;
    this.#now = options.now ?? (() => new Date());
  }

  upsertAssignment(input: OutputAssignment): OutputAssignment {
    const assignment = outputAssignmentSchema.parse(input);
    this.#assignments.set(assignment.assignmentId, assignment);
    if (!this.#inboxes.has(assignment.assignmentId)) {
      this.#inboxes.set(assignment.assignmentId, []);
    }
    this.publisher.publishAssignments(this.listAssignments());
    recordSignalTelemetry(this.#telemetry, {
      name: "output.assignment.configured",
      source: "output-routing",
      correlationId: assignment.assignmentId,
      ...(assignment.consumer.kind === "agent-instance"
        ? { activeAgentId: assignment.consumer.id }
        : {}),
      outputId: assignment.assignmentId,
      attributes: {
        assignmentId: assignment.assignmentId,
        producerId: assignment.producerId,
        consumerId: assignment.consumer.id,
        consumerKind: assignment.consumer.kind,
        deliveryMode: assignment.deliveryMode,
        enabled: assignment.enabled,
      },
    });
    return assignment;
  }

  removeAssignment(assignmentId: string): boolean {
    this.#inboxes.delete(assignmentId);
    const removed = this.#assignments.delete(assignmentId);
    if (removed) {
      this.publisher.publishAssignments(this.listAssignments());
      recordSignalTelemetry(this.#telemetry, {
        name: "output.assignment.removed",
        source: "output-routing",
        correlationId: assignmentId,
        outputId: assignmentId,
        attributes: { assignmentId },
      });
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
    for (const context of inbox) {
      this.#recordQueueEvent("output.queue.drained", assignmentId, context);
    }
    return inbox;
  }

  acknowledge(
    assignmentId: string,
    sequences: readonly number[],
  ): readonly TranslatedSignalContext[] {
    const acknowledged = new Set(sequences);
    const currentInbox = this.#inboxes.get(assignmentId) ?? [];
    const nextInbox = currentInbox.filter(
      (context) => !acknowledged.has(context.sequence),
    );
    this.#inboxes.set(assignmentId, nextInbox);
    for (const context of currentInbox) {
      if (acknowledged.has(context.sequence)) {
        this.#recordQueueEvent(
          "output.queue.acknowledged",
          assignmentId,
          context,
        );
      }
    }
    this.publisher.publishInbox(assignmentId, nextInbox);
    return nextInbox;
  }

  route(input: unknown): RouteResult {
    const startedAt = this.#now().getTime();
    const validation = validateSignalEnvelope(input);
    if (!validation.success) {
      recordSignalTelemetry(this.#telemetry, {
        name: "output.validation.failed",
        source: "output-routing",
        level: "warn",
        outcome: "failure",
        durationMs: this.#now().getTime() - startedAt,
        attributes: {
          ...(!validation.decision.accepted
            ? { code: validation.decision.code }
            : {}),
          reason: validation.decision.reason,
        },
      });
      return {
        accepted: false,
        decisions: [validation.decision],
        deliveries: [],
      };
    }
    const envelope =
      validation.envelope.receivedAt === undefined
        ? { ...validation.envelope, receivedAt: startedAt }
        : validation.envelope;
    const traceId = this.#traceId(envelope);
    recordSignalTelemetry(this.#telemetry, {
      name: "output.validation.completed",
      source: "output-routing",
      outcome: "success",
      durationMs: this.#now().getTime() - startedAt,
      trace: { traceId, spanId: traceId },
      attributes: this.#envelopeAttributes(envelope),
    });
    const result = this.#routeValidated(envelope);
    recordSignalTelemetry(this.#telemetry, {
      name: "output.routing.completed",
      source: "output-routing",
      level: result.accepted ? "info" : "warn",
      outcome: result.accepted ? "success" : "failure",
      durationMs: this.#now().getTime() - startedAt,
      trace: {
        traceId,
        spanId: stableTelemetryId(`${traceId}:routing`),
        parentSpanId: traceId,
      },
      attributes: {
        ...this.#envelopeAttributes(envelope),
        assignmentCount: result.deliveries.length,
      },
    });
    return result;
  }

  #routeValidated(envelope: SignalEnvelope): RouteResult {
    const connection = this.#registry.get(envelope.connectionId);
    if (connection === undefined || connection.status !== "connected") {
      const decision: FilterDecision = {
        accepted: false,
        code: "connection-unavailable",
        reason: `Connection ${envelope.connectionId} is not connected`,
      };
      this.#recordFilter(envelope, decision, "connection");
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
      this.#recordFilter(envelope, decision, "producer-schema");
      return { accepted: false, decisions: [decision], deliveries: [] };
    }

    const decisions: FilterDecision[] = [];
    for (const filter of this.#filters) {
      const decision = filter.evaluate(envelope, { connection });
      decisions.push(decision);
      this.#recordFilter(envelope, decision, filter.constructor.name);
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
      const traceId = this.#traceId(envelope);
      const spanId = stableTelemetryId(
        `output-assignment:${assignment.assignmentId}:${envelope.sequence}`,
      );
      recordSignalTelemetry(this.#telemetry, {
        name: "output.assignment.matched",
        source: "output-routing",
        correlationId: assignment.assignmentId,
        ...(assignment.consumer.kind === "agent-instance"
          ? { activeAgentId: assignment.consumer.id }
          : {}),
        outputId: assignment.assignmentId,
        trace: { traceId, spanId, parentSpanId: traceId },
        attributes: {
          ...this.#envelopeAttributes(envelope),
          assignmentId: assignment.assignmentId,
          consumerId: assignment.consumer.id,
          deliveryMode: assignment.deliveryMode,
        },
      });
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
        recordSignalTelemetry(this.#telemetry, {
          name: "output.queue.dropped",
          source: "output-routing",
          correlationId: assignment.assignmentId,
          ...(assignment.consumer.kind === "agent-instance"
            ? { activeAgentId: assignment.consumer.id }
            : {}),
          outputId: assignment.assignmentId,
          level: "warn",
          outcome: "failure",
          trace: { traceId, spanId, parentSpanId: traceId },
          attributes: {
            ...this.#envelopeAttributes(envelope),
            assignmentId: assignment.assignmentId,
            reason: "queue-bound",
            queueSize: inbox.length,
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
        recordSignalTelemetry(this.#telemetry, {
          name: "output.translation.failed",
          source: "output-routing",
          correlationId: assignment.assignmentId,
          ...(assignment.consumer.kind === "agent-instance"
            ? { activeAgentId: assignment.consumer.id }
            : {}),
          outputId: assignment.assignmentId,
          level: "warn",
          outcome: "failure",
          trace: { traceId, spanId, parentSpanId: traceId },
          attributes: {
            ...this.#envelopeAttributes(envelope),
            assignmentId: assignment.assignmentId,
            reason: "translator-unavailable",
          },
        });
        continue;
      }
      try {
        const translationStartedAt = this.#now().getTime();
        const translated = translator.translate({
          envelope,
          connection,
          assignment,
        });
        const traced = {
          ...translated,
          receivedAt: envelope.receivedAt,
          traceId,
        };
        recordSignalTelemetry(this.#telemetry, {
          name: "output.translation.completed",
          source: "output-routing",
          correlationId: assignment.assignmentId,
          ...(assignment.consumer.kind === "agent-instance"
            ? { activeAgentId: assignment.consumer.id }
            : {}),
          outputId: assignment.assignmentId,
          outcome: "success",
          durationMs: this.#now().getTime() - translationStartedAt,
          trace: { traceId, spanId, parentSpanId: traceId },
          attributes: {
            ...this.#envelopeAttributes(envelope),
            assignmentId: assignment.assignmentId,
          },
        });
        if (coalesces && inbox.length > 0) {
          for (const displaced of inbox) {
            this.#recordQueueEvent(
              "output.queue.coalesced",
              assignment.assignmentId,
              displaced,
            );
          }
        }
        const nextInbox = coalesces ? [traced] : [...inbox, traced];
        this.#inboxes.set(assignment.assignmentId, nextInbox);
        this.#recordQueueEvent(
          coalesces
            ? "output.queue.coalescing-completed"
            : "output.queue.enqueued",
          assignment.assignmentId,
          traced,
        );
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
        recordSignalTelemetry(this.#telemetry, {
          name: "output.translation.failed",
          source: "output-routing",
          correlationId: assignment.assignmentId,
          ...(assignment.consumer.kind === "agent-instance"
            ? { activeAgentId: assignment.consumer.id }
            : {}),
          outputId: assignment.assignmentId,
          level: "warn",
          outcome: "failure",
          trace: { traceId, spanId, parentSpanId: traceId },
          attributes: {
            ...this.#envelopeAttributes(envelope),
            assignmentId: assignment.assignmentId,
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

  #traceId(envelope: SignalEnvelope): string {
    return stableTelemetryId(
      `output-signal:${envelope.connectionId}:${envelope.sequence}`,
    );
  }

  #envelopeAttributes(envelope: SignalEnvelope) {
    return {
      connectionId: envelope.connectionId,
      sequence: envelope.sequence,
      capturedAt: envelope.capturedAt,
      schema: envelope.payload.schema,
    };
  }

  #recordFilter(
    envelope: SignalEnvelope,
    decision: FilterDecision,
    filter: string,
  ): void {
    const traceId = this.#traceId(envelope);
    recordSignalTelemetry(this.#telemetry, {
      name: "output.filter.decision",
      source: "output-routing",
      level: decision.accepted ? "debug" : "warn",
      outcome: decision.accepted ? "success" : "failure",
      trace: {
        traceId,
        spanId: stableTelemetryId(
          `${traceId}:filter:${filter}:${decision.accepted}`,
        ),
        parentSpanId: traceId,
      },
      attributes: {
        ...this.#envelopeAttributes(envelope),
        filter,
        accepted: decision.accepted,
        ...(decision.accepted ? {} : { code: decision.code }),
      },
    });
  }

  #recordQueueEvent(
    name: string,
    assignmentId: string,
    context: TranslatedSignalContext,
  ): void {
    const traceId =
      context.traceId ??
      stableTelemetryId(
        `output-context:${context.producerId}:${context.sequence}`,
      );
    recordSignalTelemetry(this.#telemetry, {
      name,
      source: "output-routing",
      correlationId: assignmentId,
      ...(context.consumer.kind === "agent-instance"
        ? { activeAgentId: context.consumer.id }
        : {}),
      outputId: assignmentId,
      trace: {
        traceId,
        spanId: stableTelemetryId(
          `${traceId}:queue:${assignmentId}:${context.sequence}:${name}`,
        ),
        parentSpanId: traceId,
      },
      attributes: {
        assignmentId,
        producerId: context.producerId,
        consumerId: context.consumer.id,
        sequence: context.sequence,
        deliveryMode: context.deliveryMode,
      },
    });
  }
}
