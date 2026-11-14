import { describe, expect, it } from "vitest";
import {
  createSyntheticMetricRecordStreamFixture,
  createSyntheticMetricRecordStreamManifest,
  createSyntheticMetricRecordStreamTerminalProof,
} from "./testing.js";
import {
  acceptMetricRecordChunk,
  createMetricRecordStreamState,
  verifyMetricRecordStreamManifest,
} from "./metric-record-stream.js";
import { nativeMetricFirstSpectrumEndpoint } from "./native-metric-listening-schemas.js";

describe("bounded synthetic stream fixtures", () => {
  it("preserves supplied regular-track source identity while retaining the master default", async () => {
    const target = {
      kind: "regular" as const,
      index: 1,
      expectedReference: "00000000-0000-4000-8000-000000000099",
    };
    const fixture = await createSyntheticMetricRecordStreamFixture({
      target,
      requestedMetrics: ["level"],
    });
    expect(fixture.descriptor.source.target).toEqual(target);
    expect(fixture.admission.source.target).toEqual(target);
    await expect(
      verifyMetricRecordStreamManifest(
        fixture.descriptor,
        fixture.state,
        fixture.manifest,
      ),
    ).resolves.toEqual(fixture.manifest);
    const defaultFixture = await createSyntheticMetricRecordStreamFixture({
      requestedMetrics: ["level"],
    });
    expect(defaultFixture.descriptor.source.target.kind).toBe("master");
    expect(fixture.state.descriptorDigest).not.toBe(
      defaultFixture.state.descriptorDigest,
    );
    await expect(
      createSyntheticMetricRecordStreamFixture({
        target: { ...target, index: -1 },
      }),
    ).rejects.toThrow();
  });

  it("exports a schema-valid manifest convenience helper without retained timelines", async () => {
    const options = { seconds: 0.25, requestedMetrics: ["level"] as const };
    const fixture = await createSyntheticMetricRecordStreamFixture(options);
    const manifest = await createSyntheticMetricRecordStreamManifest(options);
    expect(manifest).toEqual(fixture.manifest);
    await expect(
      verifyMetricRecordStreamManifest(
        fixture.descriptor,
        fixture.state,
        manifest,
      ),
    ).resolves.toEqual(manifest);
    expect(manifest.limitations.join(" ")).toContain("Synthetic");
    expect(JSON.stringify(manifest)).not.toContain('"records":');
    await expect(
      createSyntheticMetricRecordStreamManifest({ recordsPerChunk: 257 }),
    ).rejects.toThrow("chunk_record_limit");
  });

  it("exports reentrant chunk iterators and small terminal state through the testing entry point", async () => {
    const fixture = await createSyntheticMetricRecordStreamFixture({
      seconds: 2,
      recordsPerChunk: 8,
    });
    let state = await createMetricRecordStreamState(fixture.descriptor);
    let count = 0;
    for await (const chunk of fixture.chunks()) {
      expect(chunk.records.length).toBeLessThanOrEqual(8);
      state = await acceptMetricRecordChunk(fixture.descriptor, state, chunk);
      count++;
    }
    expect(count).toBeGreaterThan(6);
    expect(state).toEqual(fixture.state);
    await expect(
      verifyMetricRecordStreamManifest(
        fixture.descriptor,
        state,
        fixture.manifest,
      ),
    ).resolves.toEqual(fixture.manifest);
    const first = await fixture.chunks().next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.chunkSequence).toBe(0);
    expect(JSON.stringify(fixture.admission)).not.toContain('"rows":');
    expect(JSON.stringify(fixture.manifest)).not.toContain('"records":');
  });

  it.each([44_100, 48_000] as const)(
    "constructs coherent running-terminal proofs at %i Hz with fractional musical coordinates",
    async (sampleRate) => {
      const fixture = await createSyntheticMetricRecordStreamFixture({
        sampleRate,
        tempoBpm: 137.3,
        startBeat: 3.9,
        requestedMetrics: ["pitch"],
      });
      expect(fixture.manifest.metrics).toHaveLength(1);
      expect(
        fixture.manifest.nativeProof.clock.frames.every((row) => row[0] === 1),
      ).toBe(true);
      expect(fixture.manifest.nativeProof.configuration[2]).toBe(
        sampleRate / 10,
      );
      expect(fixture.manifest.nativeProof.spectrumCleanup.phase).toBe(
        "disabled-confirmed",
      );
    },
  );

  it("honors supplied FFT phase and explicit cancelled-prefix source counters", async () => {
    const fixture = await createSyntheticMetricRecordStreamFixture();
    const descriptor = {
      ...fixture.descriptor,
      algorithms: fixture.descriptor.algorithms.map((item) =>
        item.metric === "spectral-centroid"
          ? {
              ...item,
              algorithm: {
                ...item.algorithm!,
                firstFrameEndSample:
                  fixture.descriptor.geometry.startSample + 777,
              },
            }
          : item,
      ),
    };
    const proof = createSyntheticMetricRecordStreamTerminalProof(descriptor, {
      status: "cancelled",
      capturedSamples: 100,
    });
    expect(proof.sourceEnd).toBe(descriptor.geometry.startSample + 100);
    expect(
      nativeMetricFirstSpectrumEndpoint(
        proof.spectrumPhase!,
        descriptor.geometry.startSample,
      ),
    ).toBe(descriptor.geometry.startSample + 777);
    expect(() =>
      createSyntheticMetricRecordStreamTerminalProof(descriptor, {
        capturedSamples: descriptor.geometry.totalSamples + 1,
      }),
    ).toThrow("captured_sample_limit");
  });

  it("rejects unsupported fixture chunk budgets instead of generating unbounded arrays", async () => {
    await expect(
      createSyntheticMetricRecordStreamFixture({
        recordsPerChunk: 257,
      }),
    ).rejects.toThrow("chunk_record_limit");
    await expect(
      createSyntheticMetricRecordStreamFixture({
        recordsPerChunk: 0,
      }),
    ).rejects.toThrow("chunk_record_limit");
  });
});
