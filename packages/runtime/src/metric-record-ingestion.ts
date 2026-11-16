import { isDeepStrictEqual } from "node:util";
import { sanitizePersistedText } from "@ableton-agent/observability";
import {
  acceptMetricRecordChunk,
  createMetricRecordStreamState,
  metricRecordChunkSchema,
  metricRecordStreamDescriptorSchema,
  metricRecordStreamAlignment,
  verifyMetricRecordStreamManifest,
  type MetricRecordChunk,
  type MetricRecordStreamDescriptor,
  type MetricRecordStreamManifest,
  type MetricRecordStreamState,
  type ListeningCaptureProgress,
} from "@ableton-agent/protocol";

/** Implementations resolve writes only after the staged transaction is durable. */
export interface MetricRecordStagedSink {
  begin(descriptor: MetricRecordStreamDescriptor): Promise<void>;
  append(chunk: MetricRecordChunk): Promise<void>;
  finalize(manifest: MetricRecordStreamManifest): Promise<void>;
  abort(reason: string): Promise<void>;
}

/**
 * One immutable source and at most one bounded record chunk in flight. The
 * retained state contains digests/counts only, never accumulated observations.
 */
export class MetricRecordIngestion {
  readonly #expected: Pick<
    MetricRecordStreamDescriptor,
    "ownership" | "source" | "geometry" | "requestedMetrics" | "timingPolicy"
  >;
  #descriptor: MetricRecordStreamDescriptor | undefined;
  #state: MetricRecordStreamState | undefined;
  #alignment: ReturnType<typeof metricRecordStreamAlignment> | undefined;
  #busy = false;
  #terminal = false;
  #failed = false;
  #begun = false;
  #abortTask: Promise<void> | undefined;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | undefined;

  constructor(
    readonly sink: MetricRecordStagedSink,
    expected: Pick<
      MetricRecordStreamDescriptor,
      "ownership" | "source" | "geometry" | "requestedMetrics" | "timingPolicy"
    >,
  ) {
    this.#expected = structuredClone(expected);
  }

  get progress(): Readonly<{
    chunks: number;
    records: number;
    missingRecords: number;
  }> {
    const metrics = this.#state?.metrics ?? [];
    return Object.freeze({
      chunks: metrics.reduce((sum, item) => sum + item.nextChunkSequence, 0),
      records: metrics.reduce((sum, item) => sum + item.nextRecordOffset, 0),
      missingRecords: metrics.reduce(
        (sum, item) => sum + item.missingRecords,
        0,
      ),
    });
  }

  get alignment() {
    return this.#alignment;
  }

  get coverage(): ListeningCaptureProgress | undefined {
    if (!this.#descriptor || !this.#state) return undefined;
    const g = this.#descriptor.geometry;
    const persistedSamples = this.#terminal
      ? g.totalSamples
      : Math.min(
          ...this.#state.metrics.map((metric) =>
            metric.missingRecords > 0
              ? 0
              : Math.max(
                  0,
                  (metric.lastRecordEndSample ?? g.startSample) - g.startSample,
                ),
          ),
        );
    return {
      sampleRate: g.sampleRate,
      requestedSamples: g.totalSamples,
      persistedSamples: Math.min(g.totalSamples, persistedSamples),
      persistedChunks: this.progress.chunks,
    };
  }

  #enter(): void {
    if (this.#terminal || this.#failed)
      throw new Error("metric-stream-after-terminal");
    if (this.#busy) {
      this.#failed = true;
      throw new Error("metric-stream-backpressure");
    }
    this.#busy = true;
    this.#idle = new Promise((resolve) => {
      this.#resolveIdle = resolve;
    });
  }

  #leave(): void {
    this.#busy = false;
    this.#resolveIdle?.();
    this.#resolveIdle = undefined;
  }

  async begin(raw: MetricRecordStreamDescriptor): Promise<void> {
    this.#enter();
    try {
      if (this.#descriptor !== undefined)
        throw new Error("metric-stream-descriptor-replaced");
      const descriptor = metricRecordStreamDescriptorSchema.parse(raw);
      for (const key of [
        "ownership",
        "source",
        "geometry",
        "requestedMetrics",
        "timingPolicy",
      ] as const)
        if (!isDeepStrictEqual(descriptor[key], this.#expected[key]))
          throw new Error(`metric-stream-${key}-changed`);
      const state = await createMetricRecordStreamState(descriptor);
      this.#begun = true;
      await this.sink.begin(descriptor);
      if (this.#failed) throw new Error("metric-stream-aborted");
      this.#descriptor = descriptor;
      this.#state = state;
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#leave();
    }
  }

  async append(raw: MetricRecordChunk): Promise<void> {
    this.#enter();
    try {
      if (!this.#descriptor || !this.#state)
        throw new Error("metric-stream-descriptor-required");
      const chunk = metricRecordChunkSchema.parse(raw);
      const next = await acceptMetricRecordChunk(
        this.#descriptor,
        this.#state,
        chunk,
      );
      await this.sink.append(chunk);
      if (this.#failed) throw new Error("metric-stream-aborted");
      this.#state = next;
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#leave();
    }
  }

  async finalize(
    raw: MetricRecordStreamManifest,
  ): Promise<MetricRecordStreamManifest> {
    this.#enter();
    try {
      if (!this.#descriptor || !this.#state)
        throw new Error("metric-stream-descriptor-required");
      const manifest = await verifyMetricRecordStreamManifest(
        this.#descriptor,
        this.#state,
        raw,
      );
      if (
        !["complete", "partial"].includes(manifest.outcome) ||
        manifest.nativeProof.status !== "completed"
      )
        throw new Error("metric-stream-incomplete");
      await this.sink.finalize(manifest);
      if (this.#failed) throw new Error("metric-stream-aborted");
      this.#alignment = metricRecordStreamAlignment(this.#descriptor, manifest);
      this.#terminal = true;
      return manifest;
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#leave();
    }
  }

  abort(reason: string): Promise<void> {
    this.#failed = true;
    if (this.#terminal) return Promise.resolve();
    this.#abortTask ??= (async () => {
      await this.#idle;
      if (this.#begun)
        await this.sink.abort(sanitizePersistedText(reason).slice(0, 240));
    })();
    return this.#abortTask;
  }
}
