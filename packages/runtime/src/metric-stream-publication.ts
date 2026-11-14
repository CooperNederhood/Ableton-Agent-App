import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  contextSubjectSchema,
  listeningPassSchema,
  metricCapturePublicationSchema,
  type MetricCaptureOwner,
} from "@ableton-agent/project-state";
import { sanitizePersistedText } from "@ableton-agent/observability";
import {
  metricRecordStreamDescriptorSchema,
  type MetricRecordStreamManifest,
} from "@ableton-agent/protocol";
import type {
  ListeningRuntimeHostOptions,
  MetricStreamPublication,
} from "./listening-runtime-host.js";

type Factory = NonNullable<
  ListeningRuntimeHostOptions["createMetricStreamPublication"]
>;

/** Storage allocation is delayed until a verified native descriptor arrives. */
export const createStorageMetricStreamPublication: Factory = (
  repository,
  input,
  signal,
): MetricStreamPublication => {
  const frozen = structuredClone(input);
  const storage = repository.incrementalMetrics;
  const binding = frozen.bindings[0];
  if (!storage || frozen.bindings.length !== 1 || !binding)
    throw new Error("continuous_metric_persistence_unavailable");
  const subject = contextSubjectSchema.parse(binding.primary);
  if (
    subject.kind !== "arrangement-range" ||
    subject.sessionId !== frozen.owner.sessionId ||
    subject.liveSetId !== frozen.owner.liveSetId ||
    !isDeepStrictEqual(
      subject.binding.semanticLocator.arrangementRange,
      frozen.requestedRange,
    )
  )
    throw new Error("invalid_stream_publication_subject");

  const contextId = randomUUID();
  const operation = {
    trace: frozen.trace,
    activeAgentId: frozen.owner.agentId,
  };
  let owner: MetricCaptureOwner | undefined;
  let beginTask: Promise<void> | undefined;
  let abortTask: Promise<void> | undefined;
  let sealed: MetricRecordStreamManifest | undefined;
  let aborted = false;
  let publishing = false;
  let published = false;
  const provisional = listeningPassSchema.parse({
    id: frozen.passId,
    sessionId: frozen.owner.sessionId,
    liveSetId: frozen.owner.liveSetId,
    initiatorAgentId: frozen.owner.agentId,
    listenerIds: [binding.listenerId],
    requestedMode: "arrangement",
    actualMode: "unknown",
    requestedRange: frozen.requestedRange,
    actualRange: null,
    status: "interrupted",
    complete: false,
    createdAt: frozen.createdAt,
    startedAt: null,
    endedAt: frozen.createdAt,
    interruptionReason: "Continuous metric capture not yet published",
    trace: frozen.trace,
  });
  function assertRepository() {
    if (
      repository.sessionId !== frozen.owner.sessionId ||
      repository.liveSetId !== frozen.owner.liveSetId ||
      repository.incrementalMetrics !== storage
    )
      throw new Error("stream_publication_repository_changed");
  }
  function activeOwner() {
    assertRepository();
    signal.throwIfAborted();
    if (!owner || aborted || published || publishing)
      throw new Error("invalid_stream_publication_lifecycle");
    return owner;
  }
  assertRepository();
  return {
    sink: {
      begin(raw) {
        if (beginTask || aborted || published)
          return Promise.reject(
            new Error("invalid_stream_publication_lifecycle"),
          );
        beginTask = (async () => {
          assertRepository();
          signal.throwIfAborted();
          const descriptor = metricRecordStreamDescriptorSchema.parse(raw);
          const identity = descriptor.ownership;
          if (
            identity.passId !== frozen.passId ||
            identity.listenerId !== binding.listenerId ||
            identity.connectionEpoch !== binding.connectionEpoch ||
            identity.traceId !== frozen.trace.traceId ||
            identity.correlationId !== frozen.trace.correlationId ||
            identity.causationId !== frozen.trace.causationId ||
            descriptor.geometry.startBeat !== frozen.requestedRange.startBeat ||
            descriptor.geometry.endBeat !== frozen.requestedRange.endBeat ||
            !subject.binding.previousRuntimeBindings.includes(
              descriptor.source.target.expectedReference,
            )
          )
            throw new Error("invalid_stream_publication_identity");
          owner = await storage.beginMetricCapture(
            {
              metadata: {
                id: contextId,
                pass: provisional,
                subject,
                producer: {
                  listenerId: binding.listenerId,
                  deviceId: binding.deviceReference,
                  agentId: frozen.owner.agentId,
                  connectionEpoch: binding.connectionEpoch,
                  version: binding.version,
                },
                trace: frozen.trace,
              },
              descriptor,
            },
            { ...operation, signal },
          );
        })();
        return beginTask;
      },
      async append(chunk) {
        const captureOwner = activeOwner();
        if (sealed) throw new Error("stream_publication_already_sealed");
        await storage.appendMetricChunk(captureOwner, chunk, {
          ...operation,
          signal,
        });
      },
      async finalize(manifest) {
        const captureOwner = activeOwner();
        if (sealed) throw new Error("stream_publication_already_sealed");
        await storage.sealMetricCapture(captureOwner, manifest, {
          ...operation,
          signal,
        });
        sealed = structuredClone(manifest);
      },
      abort(reason) {
        if (published) return Promise.resolve();
        aborted = true;
        abortTask ??= (async () => {
          await beginTask?.catch(() => {});
          if (!owner) return;
          // Cleanup must survive cancellation of the capture's operation signal.
          try {
            await storage.terminateMetricCapture(
              owner,
              signal.aborted ? "cancelled" : "failed",
              sanitizePersistedText(reason).slice(0, 500) || "Capture aborted",
              operation,
            );
          } catch (error) {
            // A failed durable verification may already have revoked its owner.
            const terminal = await storage.getMetricCapture(
              owner.captureId,
              operation,
            );
            if (
              !terminal ||
              !["failed", "cancelled", "interrupted"].includes(
                terminal.status,
              ) ||
              terminal.metadata.id !== contextId ||
              terminal.metadata.pass.id !== frozen.passId ||
              terminal.metadata.pass.complete ||
              terminal.metadata.subject.id !== subject.id ||
              terminal.metadata.producer.listenerId !== binding.listenerId ||
              !isDeepStrictEqual(terminal.metadata.trace, frozen.trace)
            )
              throw error;
          }
        })();
        return abortTask;
      },
    },
    async publish(publication) {
      const captureOwner = activeOwner();
      publication.signal.throwIfAborted();
      if (
        !sealed ||
        publication.manifests.length !== 1 ||
        !isDeepStrictEqual(publication.manifests[0], sealed)
      )
        throw new Error("invalid_stream_publication_manifest");
      publishing = true;
      const pass = listeningPassSchema.parse({
        ...provisional,
        actualMode: "arrangement",
        actualRange: frozen.requestedRange,
        status: "completed",
        complete: true,
        startedAt: publication.startedAt,
        endedAt: publication.endedAt,
        interruptionReason: null,
      });
      const receipt = metricCapturePublicationSchema.parse(
        await storage.finalizeMetricCapture(captureOwner, sealed, pass, {
          ...operation,
          signal: publication.signal,
        }),
      );
      if (
        receipt.contextId !== contextId ||
        receipt.passId !== frozen.passId ||
        receipt.listenerId !== binding.listenerId ||
        receipt.subjectId !== subject.id
      )
        throw new Error("invalid_stream_publication_receipt");
      published = true;
      return [receipt.contextId];
    },
  };
};
