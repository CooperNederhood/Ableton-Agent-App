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
type Binding = Parameters<Factory>[1]["bindings"][number];
type Capture = {
  readonly binding: Binding;
  readonly subject: Binding["primary"];
  readonly contextId: string;
  owner?: MetricCaptureOwner;
  beginTask?: Promise<void>;
  sealed?: MetricRecordStreamManifest;
};

/** Storage allocation is delayed until each verified native descriptor arrives. */
export const createStorageMetricStreamPublication: Factory = (
  repository,
  input,
  signal,
): MetricStreamPublication => {
  const frozen = structuredClone(input);
  const storage = repository.incrementalMetrics;
  if (!storage || frozen.bindings.length < 1 || frozen.bindings.length > 8)
    throw new Error("metric_persistence_unavailable");
  const captures = new Map<string, Capture>();
  const modes = new Set<"session" | "arrangement">();
  for (const binding of frozen.bindings) {
    const subject = contextSubjectSchema.parse(binding.primary);
    const mode =
      subject.kind === "clip" && subject.location === "session"
        ? "session"
        : "arrangement";
    if (
      captures.has(binding.listenerId) ||
      subject.sessionId !== frozen.owner.sessionId ||
      subject.liveSetId !== frozen.owner.liveSetId ||
      (mode === "arrangement" &&
        (subject.kind !== "arrangement-range" ||
          !isDeepStrictEqual(
            subject.binding.semanticLocator.arrangementRange,
            frozen.requestedRange,
          )))
    )
      throw new Error("invalid_stream_publication_subject");
    modes.add(mode);
    captures.set(binding.listenerId, {
      binding,
      subject,
      contextId: randomUUID(),
    });
  }
  if (modes.size !== 1 || (modes.has("session") && captures.size !== 1))
    throw new Error("invalid_stream_publication_mode");
  const mode = modes.has("session") ? "session" : "arrangement";
  const operation = {
    trace: frozen.trace,
    activeAgentId: frozen.owner.agentId,
  };
  let abortTask: Promise<void> | undefined;
  let aborted = false;
  let publishing = false;
  let published = false;
  const provisional = listeningPassSchema.parse({
    id: frozen.passId,
    sessionId: frozen.owner.sessionId,
    liveSetId: frozen.owner.liveSetId,
    initiatorAgentId: frozen.owner.agentId,
    listenerIds: [...captures.keys()],
    requestedMode: mode,
    actualMode: "unknown",
    requestedRange: frozen.requestedRange,
    actualRange: null,
    status: "interrupted",
    complete: false,
    createdAt: frozen.createdAt,
    startedAt: null,
    endedAt: frozen.createdAt,
    interruptionReason: "Metric capture not yet published",
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
  function captureFor(listenerId: string): Capture {
    assertRepository();
    const capture = captures.get(listenerId);
    if (!capture) throw new Error("invalid_stream_publication_listener");
    return capture;
  }
  function activeOwner(capture: Capture): MetricCaptureOwner {
    assertRepository();
    signal.throwIfAborted();
    if (!capture.owner || aborted || published || publishing)
      throw new Error("invalid_stream_publication_lifecycle");
    return capture.owner;
  }
  assertRepository();
  return {
    sink: {
      begin(raw) {
        const capture = captureFor(raw.ownership.listenerId);
        if (capture.beginTask || aborted || published || publishing)
          return Promise.reject(
            new Error("invalid_stream_publication_lifecycle"),
          );
        capture.beginTask = (async () => {
          signal.throwIfAborted();
          const descriptor = metricRecordStreamDescriptorSchema.parse(raw);
          const identity = descriptor.ownership;
          const range =
            descriptor.source.view === "session"
              ? descriptor.source.coordinate
              : descriptor.geometry;
          if (
            identity.passId !== frozen.passId ||
            identity.connectionEpoch !== capture.binding.connectionEpoch ||
            identity.traceId !== frozen.trace.traceId ||
            identity.correlationId !== frozen.trace.correlationId ||
            identity.causationId !== frozen.trace.causationId ||
            descriptor.source.view !== mode ||
            range.startBeat !== frozen.requestedRange.startBeat ||
            range.endBeat !== frozen.requestedRange.endBeat ||
            !capture.subject.binding.previousRuntimeBindings.includes(
              descriptor.source.view === "session"
                ? descriptor.source.clipReference
                : descriptor.source.target.expectedReference,
            )
          )
            throw new Error("invalid_stream_publication_identity");
          capture.owner = await storage.beginMetricCapture(
            {
              metadata: {
                id: capture.contextId,
                pass: provisional,
                subject: capture.subject,
                contributors: [...capture.binding.contributors],
                ...(capture.binding.musicalAlignment
                  ? { musicalAlignment: capture.binding.musicalAlignment }
                  : {}),
                producer: {
                  listenerId: capture.binding.listenerId,
                  deviceId: capture.binding.deviceReference,
                  agentId: frozen.owner.agentId,
                  connectionEpoch: capture.binding.connectionEpoch,
                  version: capture.binding.version,
                },
                trace: frozen.trace,
              },
              descriptor,
            },
            { ...operation, signal },
          );
        })();
        return capture.beginTask;
      },
      async append(chunk) {
        const capture = captureFor(chunk.ownership.listenerId);
        const owner = activeOwner(capture);
        if (capture.sealed)
          throw new Error("stream_publication_already_sealed");
        await storage.appendMetricChunk(owner, chunk, { ...operation, signal });
      },
      async finalize(manifest) {
        const capture = captureFor(manifest.ownership.listenerId);
        const owner = activeOwner(capture);
        if (capture.sealed)
          throw new Error("stream_publication_already_sealed");
        await storage.sealMetricCapture(owner, manifest, {
          ...operation,
          signal,
        });
        capture.sealed = structuredClone(manifest);
      },
      abort(reason) {
        if (published) return Promise.resolve();
        aborted = true;
        abortTask ??= (async () => {
          const errors: unknown[] = [];
          for (const capture of captures.values()) {
            await capture.beginTask?.catch(() => {});
            if (!capture.owner) continue;
            try {
              await storage.terminateMetricCapture(
                capture.owner,
                signal.aborted ? "cancelled" : "failed",
                sanitizePersistedText(reason).slice(0, 500) ||
                  "Capture aborted",
                operation,
              );
            } catch (error) {
              const terminal = await storage.getMetricCapture(
                capture.contextId,
                operation,
              );
              if (
                !terminal ||
                !["failed", "cancelled", "interrupted"].includes(
                  terminal.status,
                ) ||
                terminal.metadata.id !== capture.contextId ||
                terminal.metadata.pass.id !== frozen.passId ||
                terminal.metadata.pass.complete ||
                terminal.metadata.subject.id !== capture.subject.id ||
                terminal.metadata.producer.listenerId !==
                  capture.binding.listenerId ||
                !isDeepStrictEqual(terminal.metadata.trace, frozen.trace)
              )
                errors.push(error);
            }
          }
          if (errors.length)
            throw new AggregateError(errors, "Metric capture cleanup failed");
        })();
        return abortTask;
      },
    },
    async publish(publication) {
      publication.signal.throwIfAborted();
      const finalizations = [...captures.values()].map((capture) => {
        const owner = activeOwner(capture);
        if (
          !capture.sealed ||
          !isDeepStrictEqual(
            publication.manifests.find(
              (manifest) =>
                manifest.ownership.listenerId === capture.binding.listenerId,
            ),
            capture.sealed,
          )
        )
          throw new Error("invalid_stream_publication_manifest");
        return { owner, manifest: capture.sealed };
      });
      if (publication.manifests.length !== captures.size)
        throw new Error("invalid_stream_publication_manifest");
      publishing = true;
      const complete = publication.manifests.every(
        (manifest) => manifest.outcome === "complete",
      );
      const pass = listeningPassSchema.parse({
        ...provisional,
        actualMode: mode,
        actualRange: frozen.requestedRange,
        status: complete ? "completed" : "partial",
        complete,
        startedAt: publication.startedAt,
        endedAt: publication.endedAt,
        interruptionReason: null,
      });
      const receipts = await storage.finalizeMetricCaptures(
        finalizations,
        pass,
        { ...operation, signal: publication.signal },
      );
      if (receipts.length !== captures.size)
        throw new Error("invalid_stream_publication_receipt");
      const ids = new Set<string>();
      for (const raw of receipts) {
        const receipt = metricCapturePublicationSchema.parse(raw);
        const capture = captures.get(receipt.listenerId);
        if (
          !capture ||
          ids.has(receipt.contextId) ||
          receipt.contextId !== capture.contextId ||
          receipt.passId !== frozen.passId ||
          receipt.subjectId !== capture.subject.id
        )
          throw new Error("invalid_stream_publication_receipt");
        ids.add(receipt.contextId);
      }
      published = true;
      return [...ids];
    },
  };
};
