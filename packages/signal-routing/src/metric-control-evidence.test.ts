import { describe, expect, it } from "vitest";
import {
  createContinuousMetricListeningGeometry,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
  nativeContinuousMetricArmProofSchema,
  nativeContinuousMetricListeningConfigSchema,
  nativeContinuousMetricReadyProofSchema,
} from "@ableton-agent/protocol";
import {
  listenerControlMetricSchema,
  listenerReplyMetricSchema,
} from "./listener-metric-contracts.js";
import { createSyntheticMetricWireFixture } from "./listener-metric-test-support.js";
import {
  assertMetricControlArm,
  assertMetricControlReady,
  legacyMetricControlExpectation,
  metricControlLaunchCoordinates,
  snapshotMetricControlExpectation,
} from "./metric-control-evidence.js";

function fixture(seconds: number) {
  const f = createSyntheticMetricWireFixture("arrangement");
  if (f.observation.source.view !== "arrangement") throw new Error("source");
  const geometry = createContinuousMetricListeningGeometry({
    captureMode: "arrangement-continuous",
    sampleRate: 48_000,
    vectorSize: 64,
    tempoBpm: 120,
    startBeat: 0,
    endBeat: seconds * 2,
    startSample: 0,
  });
  const config = nativeContinuousMetricListeningConfigSchema.parse({
    ...f.config,
    scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
    capability: METRIC_CONTINUOUS_LISTENING_CAPABILITY,
    captureMode: "arrangement-continuous",
    requestedMetrics: [
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ],
    geometry,
    sourceContext: {
      ...f.observation.source,
      transport: { startBeat: geometry.startBeat, endBeat: geometry.endBeat },
    },
    maxPendingChunks: 8,
    maxChunkBytes: 128 * 1024,
  });
  const ready = nativeContinuousMetricReadyProofSchema.parse({
    ...f.ready,
    scope: config.scope,
    config,
    analyzerProducerAbi: 3,
  });
  const fields = [...f.proof.armed.receipt.fields];
  fields[1] = geometry.totalSamples;
  fields[8] = geometry.endBeat;
  fields[9] = geometry.rows.length;
  const arm = nativeContinuousMetricArmProofSchema.parse({
    ...f.proof.armed,
    scope: config.scope,
    config,
    analyzerProducerAbi: 3,
    receipt: { ...f.proof.armed.receipt, fields, confirmedFields: fields },
  });
  const expected = snapshotMetricControlExpectation({
    ...ready.ownership,
    config,
  });
  return { f, config, ready, arm, expected };
}

describe("explicit continuous control and physical evidence", () => {
  it.each([180, 600])(
    "admits a %ss all-six request without widening legacy proofs",
    (seconds) => {
      const data = fixture(seconds);
      expect(
        listenerControlMetricSchema.parse({
          ...data.f.wire,
          type: "listener.control",
          action: "prepare",
          config: data.config,
        }).config,
      ).toEqual(data.config);
      for (const [status, payload] of [
        ["ready", { nativeReady: data.ready }],
        ["armed", { nativeArm: data.arm }],
      ] as const)
        expect(
          listenerReplyMetricSchema.safeParse({
            ...data.f.wire,
            type: "listener.reply",
            status,
            ...payload,
          }).success,
        ).toBe(true);
      expect(assertMetricControlReady(data.ready, data.expected)).toEqual(
        data.ready,
      );
      expect(assertMetricControlArm(data.arm, data.expected)).toEqual(data.arm);
      const launch = metricControlLaunchCoordinates(
        data.arm,
        data.f.proof.launched,
        data.expected,
      );
      expect(launch.endSample - launch.startSample).toBe(seconds * 48000);
      expect(() => legacyMetricControlExpectation(data.expected)).toThrow(
        "legacy_publication_forbidden",
      );
    },
  );
  it("rejects foreign ownership and a different admitted clock range", () => {
    const data = fixture(180);
    expect(() =>
      assertMetricControlReady(data.ready, {
        ...data.expected,
        correlationId: "foreign",
      }),
    ).toThrow();
    expect(() =>
      assertMetricControlArm(data.arm, {
        ...data.expected,
        nativeEpoch: data.expected.nativeEpoch! + 1,
      }),
    ).toThrow();
    const changed = structuredClone(data.arm);
    changed.receipt.fields[8] += 1;
    changed.receipt.confirmedFields[8] += 1;
    expect(() => assertMetricControlArm(changed, data.expected)).toThrow();
  });
  it("rejects over-limit spans and Session continuous configuration", () => {
    expect(() => fixture(601)).toThrow();
    const data = fixture(180);
    expect(
      nativeContinuousMetricListeningConfigSchema.safeParse({
        ...data.config,
        mode: "session",
      }).success,
    ).toBe(false);
  });
});
