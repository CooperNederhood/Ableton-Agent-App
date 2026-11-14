import { describe, expect, it } from "vitest";
import {
  createSyntheticMetricRecordStreamFixture,
  createSyntheticMetricRecordStreamTerminalProof,
} from "@ableton-agent/protocol/testing";
import {
  createMetricRecordStreamState,
  acceptMetricRecordChunk,
  metricRecordChunkDigest,
  metricRecordStreamManifestSchema,
  type MetricRecordChunk,
} from "@ableton-agent/protocol";
import { arrangementTestEvidence } from "./arrangement-test-support.js";
import {
  expandArrangementDescriptor,
  verifyPersistedArrangementStream,
} from "./arrangement-stream.js";
import { createDefaultAssertions } from "./assertions.js";
import type { AssertionInput } from "./contracts.js";
import { verifyArrangementCapture } from "./arrangement.js";

async function fixture(nonSilent = true) {
  const master = await createSyntheticMetricRecordStreamFixture();
  const descriptor = {
    ...master.descriptor,
    ownership: {
      ...master.descriptor.ownership,
      correlationId: master.descriptor.ownership.traceId,
    },
    source: {
      ...master.descriptor.source,
      target: {
        ...master.descriptor.source.target,
        kind: "regular" as const,
        index: 1,
      },
    },
  };
  let state = await createMetricRecordStreamState(descriptor);
  const chunks: MetricRecordChunk[] = [];
  for await (const original of master.chunks()) {
    const chunk = {
      ...original,
      ownership: descriptor.ownership,
      descriptorDigest: state.descriptorDigest,
      previousDigest: state.metrics.find(
        (metric) => metric.metric === original.metric,
      )!.lastDigest,
    };
    if (chunk.metric === "level" && nonSilent)
      for (const record of chunk.records) {
        record.rms = [0.1, 0.1];
        record.peak = [0.2, 0.2];
      }
    chunk.digest = await metricRecordChunkDigest(chunk);
    state = await acceptMetricRecordChunk(descriptor, state, chunk);
    chunks.push(chunk);
  }
  const manifest = metricRecordStreamManifestSchema.parse({
    ...master.manifest,
    ownership: descriptor.ownership,
    descriptorDigest: state.descriptorDigest,
    metrics: master.manifest.metrics.map((metric) => ({
      ...metric,
      ...state.metrics.find((prefix) => prefix.metric === metric.metric),
    })),
    nativeProof: createSyntheticMetricRecordStreamTerminalProof(descriptor),
  });
  const stream = {
    descriptor,
    state,
    manifest,
    chunks: () =>
      (async function* () {
        yield* structuredClone(chunks);
      })(),
  };
  const base = arrangementTestEvidence().baseline;
  const baseline = {
    ...base,
    listenerId: descriptor.ownership.listenerId,
    source: {
      ...base.source,
      trackId: descriptor.source.target.expectedReference,
      trackIndex: descriptor.source.target.index,
      startBeat: descriptor.geometry.startBeat,
      endBeat: descriptor.geometry.endBeat,
      clips: [
        {
          ...base.source.clips[0]!,
          startBeat: descriptor.geometry.startBeat,
          endBeat: descriptor.geometry.endBeat,
        },
      ],
    },
  };
  const input = {
    contextId: "context-1",
    descriptor,
    manifest: stream.manifest,
    persistedState: stream.state,
    baseline,
    chunks: stream.chunks(),
    operationId: "operation-1",
    expectedTraceId: descriptor.ownership.traceId,
    expectedCorrelationId: descriptor.ownership.correlationId,
    expectedCausationId: descriptor.ownership.causationId,
    playbackPlaying: true,
    sourceReleaseConfirmed: true,
    afterOwnedRestart: false,
    signal: new AbortController().signal,
  };
  return { stream, input };
}
describe("independent persisted Arrangement stream evidence", () => {
  it("replays original all-six records, counts, digests and complete native proof", async () => {
    const { input, stream } = await fixture();
    const result = await verifyPersistedArrangementStream(input);
    expect(result.capture.metrics).toHaveLength(6);
    expect(
      result.capture.metrics.every(
        (metric) => metric.receivedRecords === metric.expectedRecords,
      ),
    ).toBe(true);
    expect(result.proof.chunkCount).toBeGreaterThan(0);
    expect(result.capture.cleanup.transportPlaying).toBe(true);
    expect(result.capture.spectralCentroidFirstFrameEndSample).toBe(
      input.descriptor.algorithms.find(
        (item) => item.metric === "spectral-centroid",
      )?.algorithm?.firstFrameEndSample,
    );
    verifyArrangementCapture(result.capture, input.baseline, {
      operationId: input.operationId,
      traceId: input.expectedTraceId,
      causationId: input.expectedCausationId,
      tempoBpm: input.descriptor.geometry.tempoBpm,
      hostSampleRate: input.descriptor.geometry.sampleRate,
      playbackAfterCapture: "playing",
      metricRecords: Object.fromEntries(
        result.capture.metrics.map((metric) => [
          metric.name,
          metric.name === "spectral-centroid"
            ? "verified-fft-phase"
            : metric.expectedRecords,
        ]),
      ),
    });
    const restored = await verifyPersistedArrangementStream({
      ...input,
      chunks: stream.chunks(),
      afterOwnedRestart: true,
    });
    expect(restored.proof.recordsSha256).toBe(result.proof.recordsSha256);
  });
  it("rebuilds rows without trusting saved compact totals", async () => {
    const { input } = await fixture();
    const { rows, ...geometry } = input.descriptor.geometry;
    expect(rows.length).toBeGreaterThan(0);
    expect(
      expandArrangementDescriptor({ ...input.descriptor, geometry }),
    ).toEqual(input.descriptor);
    expect(() =>
      expandArrangementDescriptor({
        ...input.descriptor,
        geometry: { ...geometry, totalSamples: geometry.totalSamples + 1 },
      }),
    ).toThrow(/canonical/);
  });
  it.each([
    "missing",
    "duplicate",
    "changed-record",
    "persisted-counter",
    "wrong-owner",
    "phase-proof",
    "cleanup",
    "cancelled",
  ] as const)(
    "rejects %s instead of trusting completed manifest",
    async (failure) => {
      const { stream, input } = await fixture();
      const chunks = [];
      for await (const chunk of stream.chunks()) chunks.push(chunk);
      if (failure === "missing") chunks.pop();
      if (failure === "duplicate") chunks.splice(1, 0, chunks[0]!);
      if (failure === "changed-record")
        (chunks[0]!.records[0] as unknown as { index: number }).index = 999;
      const controller = new AbortController();
      if (failure === "cancelled") controller.abort();
      await expect(
        verifyPersistedArrangementStream({
          ...input,
          chunks: (async function* () {
            yield* chunks;
          })(),
          ...(failure === "persisted-counter" ? { persistedState: {} } : {}),
          ...(failure === "wrong-owner"
            ? { expectedTraceId: "another-owner" }
            : {}),
          ...(failure === "phase-proof"
            ? {
                manifest: {
                  ...input.manifest,
                  nativeProof: {
                    ...input.manifest.nativeProof,
                    spectrumPhase: null,
                  },
                },
              }
            : {}),
          ...(failure === "cleanup" ? { sourceReleaseConfirmed: false } : {}),
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    },
  );
  it("awaits durable evidence writes and propagates cleanup/write failures", async () => {
    const { input } = await fixture();
    await expect(
      verifyPersistedArrangementStream({
        ...input,
        onChunk: async () => {
          throw new Error("owned evidence write failed");
        },
      }),
    ).rejects.toThrow("owned evidence write failed");
  });
  it("rejects a complete all-six silent timeline", async () => {
    const { input } = await fixture(false);
    await expect(verifyPersistedArrangementStream(input)).rejects.toThrow(
      /silent/,
    );
  });
  it("registers strict restart equality assertion without permitting absent evidence", () => {
    const registry = createDefaultAssertions();
    expect(registry.names.has("arrangement-persistence")).toBe(true);
    expect(() =>
      registry.validate({
        name: "arrangement-persistence",
        parameters: { sourceId: "source", ignored: true },
      }),
    ).toThrow();
  });
  it("verifies unchanged original records after owned restart and rejects recapture or altered identities", async () => {
    const { input } = await fixture();
    const original = await verifyPersistedArrangementStream(input);
    const h = arrangementTestEvidence();
    const evidence = {
      schemaVersion: 1,
      capturePassIds: [original.proof.passId],
      arrangementContexts: [{ ...original.proof, afterOwnedRestart: true }],
    };
    const assertionInput = {
      fixture: h.fixture,
      baseline: { arrangementSources: { source: input.baseline } },
      turns: [{ arrangementCaptures: [original.capture] }],
      evidence,
    } as unknown as AssertionInput;
    const registry = createDefaultAssertions();
    const reference = {
      name: "arrangement-persistence",
      parameters: { sourceId: "source" },
    };
    expect(registry.evaluate(reference, assertionInput).passed).toBe(true);
    for (const patch of [
      { afterOwnedRestart: false },
      { contextId: "another" },
      { passId: "recaptured" },
      { recordsSha256: "f".repeat(64) },
      { manifestSha256: "f".repeat(64) },
      { chunkCount: 999 },
    ]) {
      const restored = { ...original.proof, afterOwnedRestart: true, ...patch };
      expect(
        registry.evaluate(reference, {
          ...assertionInput,
          evidence: {
            ...assertionInput.evidence!,
            arrangementContexts: [restored],
          },
        }).passed,
      ).toBe(false);
    }
    expect(
      registry.evaluate(reference, {
        ...assertionInput,
        evidence: {
          ...assertionInput.evidence!,
          capturePassIds: [original.proof.passId, "another"],
        },
      }).passed,
    ).toBe(false);
    expect(
      registry.evaluate(
        { ...reference, parameters: { sourceId: "absent" } },
        assertionInput,
      ).passed,
    ).toBe(false);
  });
});
