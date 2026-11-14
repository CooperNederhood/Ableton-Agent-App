/* global module, Buffer */
"use strict";

// Node/control-thread record transport. Never called by the audio callback.
// The canonical codec owns wire types, digesting, coverage and attack replay.
// A successful send means accepted by the existing writer, NOT durable storage.
// Runtime must durably stage all chunks and verify the terminal before success.
function createMetricRecordProducer({ codec, descriptor, send, onFailure }) {
  const parsed = codec.metricRecordStreamDescriptorSchema.parse(descriptor);
  if (typeof send !== "function" || typeof onFailure !== "function")
    throw new Error("metric_stream_callbacks_required");
  const buffers = new Map(
    parsed.requestedMetrics.map((metric) => [
      metric,
      { records: [], gaps: [], entries: 0 },
    ]),
  );
  const queue = [];
  let state = null;
  let failure = null;
  let cancelled = false;
  let closing = false;
  let complete = false;
  let running = null;
  let pendingHighWater = 0;
  let lastFlushTime = null;
  const immutable = (value) =>
    JSON.parse(
      JSON.stringify(value, (_key, child) => {
        if (
          (typeof child === "number" && !Number.isFinite(child)) ||
          ["undefined", "function", "symbol", "bigint"].includes(typeof child)
        )
          throw new Error("metric_stream_invalid_record");
        return child;
      }),
    );
  function fail(error) {
    if (!failure && !cancelled) {
      failure =
        error instanceof Error && /^[a-z][a-z0-9_]{0,127}$/.test(error.message)
          ? error.message
          : "metric_stream_integrity_failed";
      // Reserved control/terminal delivery is controller-owned, not queued
      // behind data here. Never retry a failed/ambiguous publication.
      queue.length = 0;
      for (const b of buffers.values()) {
        b.records.length = b.gaps.length = b.entries = 0;
      }
      onFailure(failure);
    }
    return false;
  }
  const ready = Promise.resolve()
    .then(async () => {
      state = await codec.createMetricRecordStreamState(parsed);
      if (cancelled || failure) return;
      if (
        (await send({
          status: "progress",
          metricStream: codec.compactMetricRecordStreamDescriptor(parsed),
        })) !== true
      )
        throw new Error("metric_stream_descriptor_delivery_failed");
    })
    .catch(fail);
  function pump() {
    if (running) return running;
    running = Promise.resolve()
      .then(async () => {
        await ready;
        while (queue.length && !failure && !cancelled) {
          const batch = queue[0];
          const metricState = state.metrics.find(
            (m) => m.metric === batch.metric,
          );
          const candidate = {
            schema: "metric-record-chunk/v1",
            descriptorDigest: state.descriptorDigest,
            ownership: parsed.ownership,
            metric: batch.metric,
            chunkSequence: metricState.nextChunkSequence,
            recordOffset: metricState.nextRecordOffset,
            slotOffset: metricState.nextIndex,
            previousDigest: metricState.lastDigest,
            digest: "0".repeat(64),
            records: batch.records,
            gaps: batch.gaps,
          };
          candidate.digest = await codec.metricRecordChunkDigest(candidate);
          const chunk = codec.metricRecordChunkSchema.parse(candidate);
          const next = await codec.acceptMetricRecordChunk(
            parsed,
            state,
            chunk,
          );
          if (cancelled || failure) break;
          if ((await send({ status: "progress", metricChunk: chunk })) !== true)
            throw new Error("metric_stream_chunk_delivery_failed");
          if (cancelled || failure) break;
          state = next;
          queue.shift(); // discard ONLY after this writer accepted the exact chunk
        }
      })
      .catch(fail)
      .finally(() => {
        running = null;
      });
    return running;
  }
  function enqueue(metric) {
    const b = buffers.get(metric);
    if (!b.entries) return true;
    if (queue.length >= parsed.maxPendingChunks)
      return fail(new Error("metric_stream_pending_overflow"));
    queue.push({ metric, records: b.records, gaps: b.gaps });
    pendingHighWater = Math.max(pendingHighWater, queue.length);
    b.records = [];
    b.gaps = [];
    b.entries = 0;
    void pump();
    return true;
  }
  function append(metric, value, gap) {
    if (closing || cancelled || failure || complete) return false;
    const b = buffers.get(metric);
    if (!b) return fail(new Error("metric_stream_unrequested_metric"));
    // Conservative 96KiB entry budget leaves room for ownership, hashes and
    // envelope under the canonical 128KiB bound. Oversized records fail, never
    // trim bands or downsample. Max 256 entries is separately enforced.
    let copy;
    try {
      copy = immutable(value);
    } catch (error) {
      return fail(error);
    }
    const bytes = (entry) => Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (bytes(copy) > 96 * 1024)
      return fail(new Error("metric_stream_record_oversize"));
    const combined = [...b.records, ...b.gaps, copy];
    if (b.entries && (b.entries === 256 || bytes(combined) > 96 * 1024))
      if (!enqueue(metric)) return false;
    (gap ? b.gaps : b.records).push(copy);
    b.entries++;
    return true;
  }
  return Object.freeze({
    ingest: (metric, record) => append(metric, record, false),
    gap: (metric, gap) => append(metric, gap, true),
    tick(now) {
      if (closing || cancelled || failure || complete) return false;
      if (!Number.isFinite(now))
        return fail(new Error("metric_stream_invalid_flush_clock"));
      if (lastFlushTime === null) lastFlushTime = now;
      if (now < lastFlushTime)
        return fail(new Error("metric_stream_flush_clock_reversed"));
      if (now - lastFlushTime < 5000) return true;
      lastFlushTime = now;
      // Control-thread timer, not DSP: publish short tails even when a family
      // never fills a 256-entry batch before the runtime inactivity deadline.
      // Keep the SAME global queue cap; slow durable ACKs fail explicitly.
      for (const metric of parsed.requestedMetrics)
        if (!enqueue(metric)) return false;
      return true;
    },
    async flush() {
      if (failure || cancelled || complete) return false;
      // Await each family, rather than overfilling a queue with final tails.
      for (const metric of parsed.requestedMetrics) {
        if (!enqueue(metric)) return false;
        await pump();
        if (failure || cancelled) return false;
      }
      return true;
    },
    async finalize(nativeProof, limitations = []) {
      if (closing || cancelled || failure || complete)
        throw new Error(failure || "metric_stream_closed");
      closing = true;
      try {
        for (const metric of parsed.requestedMetrics) {
          if (!enqueue(metric)) throw new Error(failure);
          await pump();
          if (failure || cancelled)
            throw new Error(failure || "metric_stream_cancelled");
        }
        const proof =
          codec.metricRecordStreamTerminalProofSchema.parse(nativeProof);
        const metrics = state.metrics.map((m) => {
          const algorithm = parsed.algorithms.find(
            (a) => a.metric === m.metric,
          );
          return {
            ...m,
            status:
              algorithm.availability === "unavailable"
                ? "failed"
                : m.missingRecords === 0
                  ? "complete"
                  : m.nextRecordOffset
                    ? "partial"
                    : "failed",
            expectedRecords: codec.metricRecordStreamExpectedCoverage(
              parsed,
              m.metric,
            ).expectedRecords,
            availability: algorithm.availability,
            trailingSupport: codec.metricRecordStreamCapturedTrailingSupport(
              parsed,
              m.metric,
              proof.sourceEnd,
            ),
          };
        });
        const manifest = codec.metricRecordStreamManifestSchema.parse({
          schema: "metric-record-stream-manifest/v1",
          descriptorDigest: state.descriptorDigest,
          ownership: parsed.ownership,
          outcome:
            proof.status === "cancelled"
              ? "cancelled"
              : proof.status === "completed" &&
                  metrics.every((m) => m.status === "complete")
                ? "complete"
                : metrics.some(
                      (m) => m.nextRecordOffset || m.status === "complete",
                    )
                  ? "partial"
                  : "failed",
          algorithms: parsed.algorithms,
          metrics,
          nativeProof: proof,
          limitations,
        });
        await codec.verifyMetricRecordStreamManifest(parsed, state, manifest);
        if (cancelled || failure)
          throw new Error(failure || "metric_stream_cancelled");
        // Separate reserved terminal path, never a duplicate full observation.
        if (
          (await send({
            status:
              manifest.outcome === "complete" ? "completed" : manifest.outcome,
            metricManifest: manifest,
          })) !== true
        ) {
          fail(new Error("metric_stream_terminal_delivery_failed"));
          throw new Error(failure);
        }
        if (cancelled || failure)
          throw new Error(failure || "metric_stream_cancelled");
        complete = true;
        return manifest;
      } catch (error) {
        fail(error);
        throw new Error(failure || "metric_stream_cancelled");
      }
    },
    cancel() {
      if (complete || cancelled) return false;
      cancelled = true;
      queue.length = 0;
      for (const b of buffers.values())
        b.records.length = b.gaps.length = b.entries = 0;
      return true; // not physical native cleanup evidence
    },
    snapshot() {
      return Object.freeze({
        pendingChunks: queue.length,
        pendingHighWater,
        bufferedEntries: [...buffers.values()].reduce(
          (n, b) => n + b.entries,
          0,
        ),
        failure,
        cancelled,
        complete,
        state: state === null ? null : immutable(state),
      });
    },
  });
}

module.exports = Object.freeze({ createMetricRecordProducer });
