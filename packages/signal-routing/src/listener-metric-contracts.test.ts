import { describe, expect, it } from "vitest";
import {
  assertNativeMetricSourceCoverage,
  createMetricListeningGeometry,
  MAX_AUDIO_OBSERVATION_BYTES,
  MAX_METRIC_RESULT_FRAME_BYTES,
  metricAudioObservationSchema,
} from "@ableton-agent/protocol";
import { createSyntheticMetricListeningObservation } from "@ableton-agent/protocol/testing";
import {
  LISTENER_CAPABILITY_METRIC,
  LISTENER_METRIC_ALGORITHM_VERSION,
  LISTENER_METRIC_PRODUCER_SCHEMA_VERSION,
  LISTENER_METRIC_SCOPE,
  LISTENER_VERSION_METRIC,
  listenerMetricProducerSchema,
  listenerMetricWireIdentitySchema,
  listenerControlMetricSchema,
  listenerRegistrationMetricSchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  nativeMetricLifecycleSchema,
} from "./listener-metric-contracts.js";
import {
  DEFAULT_MAX_INGRESS_FRAME_BYTES,
  outputProducerSchema,
} from "./contracts.js";
import { producerMessageSchema } from "./ingress-contracts.js";
import { createSyntheticMetricWireFixture as fixture } from "./listener-metric-test-support.js";

describe("wire5 independent metric contracts", () => {
  it.each(["flatness", "spread"])(
    "registers %s only as a bounded diagnostic, never as a frame-qualified metric observation",
    (descriptor) => {
      const f = fixture();
      const lifecycle = {
        scope: LISTENER_METRIC_SCOPE,
        metric: `spectral-${descriptor}`,
        eventId: f.wire.generation,
        causationId: f.wire.causationId,
        generation: f.wire.generation,
        nativeEpoch: f.proof.armed.ownership.nativeEpoch,
        stage: "progress",
        phase: "capture",
        elapsedMs: 200,
        durationMs: 200,
        frames: 0,
        reason: `${descriptor}_smoke_output`,
        facts: [
          {
            field: `${descriptor}.support`,
            actual: { state: "observed", value: "unqualified" },
          },
          {
            field: `${descriptor}.left${descriptor === "spread" ? "Hz" : "Db"}`,
            actual: {
              state: "observed",
              value: descriptor === "spread" ? 1500 : -42,
            },
          },
          {
            field: `${descriptor}.right${descriptor === "spread" ? "Hz" : "Db"}`,
            actual: {
              state: "observed",
              value: descriptor === "spread" ? 3000 : -7,
            },
          },
        ],
      };
      expect(nativeMetricLifecycleSchema.safeParse(lifecycle).success).toBe(
        true,
      );
      expect(
        listenerResultMetricSchema.safeParse({
          ...f.wire,
          type: "listener.result",
          status: "progress",
          nativeLifecycle: lifecycle,
        }).success,
      ).toBe(true);
      expect(
        nativeMetricLifecycleSchema.safeParse({
          ...lifecycle,
          metric: "unregistered",
        }).success,
      ).toBe(false);
      expect(
        listenerControlMetricSchema.safeParse({
          ...f.wire,
          type: "listener.control",
          action: "prepare",
          config: { ...f.config, requestedMetrics: [`spectral-${descriptor}`] },
        }).success,
      ).toBe(false);
      expect(
        metricAudioObservationSchema.safeParse({
          ...f.observation,
          metrics: {
            ...f.observation.metrics,
            [`spectral-${descriptor}`]: { records: [] },
          },
        }).success,
      ).toBe(false);
    },
  );
  it.each(["arrangement", "session"] as const)(
    "requires counter-bound FFT phase and confirmed owned cleanup for complete/partial %s publications",
    (mode) => {
      for (const partial of [false, true]) {
        const f = fixture(mode, partial);
        const terminal = {
          ...f.wire,
          type: "listener.result",
          status: partial ? "partial" : "completed",
          observation: f.observation,
          nativeSourceCoverage: f.proof,
        };
        expect(listenerResultMetricSchema.safeParse(terminal).success).toBe(
          true,
        );
        for (const fault of [
          "missing-phase",
          "missing-cleanup",
          "foreign-phase-owner",
          "foreign-cleanup-owner",
          "foreign-cleanup-epoch",
          "pending-cleanup",
          "torn-phase",
          "wrong-phase-cadence",
          "uncleared-bank",
          "stale-cleanup-receipt",
        ]) {
          const proof = structuredClone(f.proof);
          if (fault === "missing-phase") delete proof.spectrumPhase;
          if (fault === "missing-cleanup") delete proof.spectrumCleanup;
          if (fault === "foreign-phase-owner")
            proof.spectrumPhase!.ownership.generation =
              "11111111-1111-4111-8111-111111111111";
          if (fault === "foreign-cleanup-owner")
            proof.spectrumCleanup!.generation =
              "11111111-1111-4111-8111-111111111111";
          if (fault === "foreign-cleanup-epoch")
            proof.spectrumCleanup!.nativeEpoch++;
          if (fault === "pending-cleanup")
            proof.spectrumCleanup!.status = "pending";
          if (fault === "torn-phase") proof.spectrumPhase!.acquisitions[0][2]++;
          if (fault === "wrong-phase-cadence")
            for (const acquisition of proof.spectrumPhase!.acquisitions)
              for (const index of [1, 2, 3] as const) acquisition[index]--;
          if (fault === "uncleared-bank")
            proof.spectrumCleanup!.receipt.value!.raw[1] = 1;
          if (fault === "stale-cleanup-receipt")
            proof.spectrumCleanup!.receipt = structuredClone(
              proof.spectrumCleanup!.watermarkReceipt,
            );
          expect(
            listenerResultMetricSchema.safeParse({
              ...terminal,
              nativeSourceCoverage: proof,
            }).success,
            fault,
          ).toBe(false);
        }
      }
    },
  );

  it.each(["level", "spectral-centroid", "attacks"] as const)(
    "continues healthy capture with attributable %s failure/cancellation progress",
    (metric) => {
      const f = fixture();
      for (const stage of ["failed", "cancelled"] as const) {
        const lifecycle = {
          scope: LISTENER_METRIC_SCOPE,
          metric,
          eventId: f.wire.traceId,
          causationId: "synthetic-metric-stage-parent",
          generation: f.wire.generation,
          nativeEpoch: f.proof.launched.ownership.nativeEpoch,
          stage,
          phase: "capture",
          reason: "synthetic_metric_unavailable",
          elapsedMs: 100,
          frames: 1,
        };
        const progress = {
          ...f.wire,
          type: "listener.result",
          status: "progress",
          nativeLaunch: f.proof.launched,
          nativeLifecycle: lifecycle,
        };
        expect(listenerResultMetricSchema.parse(progress)).toEqual(progress);
        expect(
          listenerResultMetricSchema.safeParse({
            ...progress,
            nativeLaunch: undefined,
          }).success,
        ).toBe(true);
        for (const patch of [
          { metric: undefined },
          { metric: "shared" },
          { metric: "unknown" },
          { reason: undefined },
          { reason: "" },
          { reason: "not a bounded reason code" },
          { generation: "11111111-1111-4111-8111-111111111111" },
          { nativeEpoch: 0 },
          { nativeEpoch: lifecycle.nativeEpoch + 1 },
          { phase: "unknown" },
          { rawDiagnostics: { unbounded: "not admitted" } },
        ]) {
          expect(
            listenerResultMetricSchema.safeParse({
              ...progress,
              nativeLifecycle: { ...lifecycle, ...patch },
            }).success,
          ).toBe(false);
        }
        expect(
          listenerResultMetricSchema.safeParse({
            ...progress,
            nativeLaunch: {
              ...f.proof.launched,
              ownership: {
                ...f.proof.launched.ownership,
                passId: "foreign-shared-owner",
              },
            },
          }).success,
        ).toBe(false);
        expect(
          listenerResultMetricSchema.safeParse({
            ...progress,
            protocolVersion: 2,
          }).success,
        ).toBe(false);
        const terminal = {
          ...progress,
          status: stage,
          reason: "synthetic_global_termination",
          nativeLaunch: undefined,
        };
        expect(listenerResultMetricSchema.safeParse(terminal).success).toBe(
          true,
        );
        expect(
          listenerResultMetricSchema.safeParse({
            ...terminal,
            status: stage === "failed" ? "cancelled" : "failed",
          }).success,
        ).toBe(false);
      }
    },
  );

  it("keeps prepare readiness unarmed and never treats old launch/config histories as the new pass", () => {
    const f = fixture();
    const reply = {
      ...f.wire,
      type: "listener.reply",
      status: "ready",
      nativeReady: f.ready,
    };
    expect(listenerReplyMetricSchema.safeParse(reply).success).toBe(true);
    expect(f.ready.configurationEvidence).toBe("admitted-not-executed");
    expect(f.ready.idle.timing[0]).toBe(0);
    expect(f.ready.idle.timing[3]).toBe(0);
    expect(f.ready.idle.fields[10]).toBe(0);
    expect(f.ready.idle.fields[6]).toBe(0);
    expect(
      listenerReplyMetricSchema.safeParse({
        ...reply,
        nativeReady: f.proof.armed,
      }).success,
    ).toBe(false);
    expect(
      listenerReplyMetricSchema.safeParse({
        ...f.wire,
        type: "listener.reply",
        status: "armed",
        nativeArm: f.ready,
      }).success,
    ).toBe(false);
    const old = structuredClone(f.ready);
    old.ownership.nativeEpoch = 8;
    old.idle.fields = [7, 1000, 4800, 90, 0.5, 128, 1, 3.5, 3.53125, 1, 0, 7];
    old.idle.confirmedFields = [...old.idle.fields];
    old.idle.timing = [0, 1064, 4, 0, 64, 100000, 101000, 3];
    old.idle.confirmedTiming = [...old.idle.timing];
    expect(
      listenerReplyMetricSchema.safeParse({ ...reply, nativeReady: old })
        .success,
    ).toBe(true);
    for (const mutate of [
      (proof: typeof f.ready) => {
        Reflect.set(proof.idle.timing, 0, 1);
        Reflect.set(proof.idle.confirmedTiming, 0, 1);
      },
      (proof: typeof f.ready) => {
        Reflect.set(proof.idle.fields, 10, 1);
        Reflect.set(proof.idle.confirmedFields, 10, 1);
      },
      (proof: typeof f.ready) => {
        proof.idle.confirmedTimingCounter = proof.idle.timingCounter;
      },
    ]) {
      const invalid = structuredClone(f.ready);
      mutate(invalid);
      expect(
        listenerReplyMetricSchema.safeParse({ ...reply, nativeReady: invalid })
          .success,
      ).toBe(false);
    }
  });

  it.each([false, true])(
    "binds Node detector settings to frozen prepare admission (partial=%s)",
    (partial) => {
      const f = fixture("arrangement", partial);
      const prepare = {
        ...f.wire,
        type: "listener.control",
        action: "prepare",
        config: f.config,
      };
      expect(
        listenerControlMetricSchema.safeParse({
          ...prepare,
          config: { ...f.config, attacks: undefined },
        }).success,
      ).toBe(false);
      for (const field of ["thresholdDb", "minSpacingSamples"] as const) {
        const observation = structuredClone(f.observation);
        const algorithm = observation.metrics.attacks.algorithm;
        if (algorithm === null)
          throw new Error("Synthetic fixture requires attack settings");
        algorithm[field]++;
        expect(
          metricAudioObservationSchema.safeParse(observation).success,
        ).toBe(true);
        expect(
          listenerResultMetricSchema.safeParse({
            ...f.wire,
            type: "listener.result",
            status: partial ? "partial" : "completed",
            observation,
            nativeSourceCoverage: f.proof,
          }).success,
        ).toBe(false);
      }
    },
  );

  it("rebases the local prepare grid only to verified native origin, never the diagnostic host offset", () => {
    const f = fixture();
    const coordinates = assertNativeMetricSourceCoverage(f.proof, {
      ...f.proof.armed.ownership,
      config: f.config,
    });
    expect(f.config.geometry.startSample).toBe(0);
    expect(coordinates.originCounter).toBe(200_000);
    expect(coordinates.startSample).toBe(200_000);
    expect(coordinates.hostStartSample).toBe(1_000_000);
    expect(f.observation.geometry.startSample).toBe(coordinates.originCounter);
    expect(f.observation.sourceCoverage.startSample).toBe(
      coordinates.originCounter,
    );
    for (const startSample of [0, coordinates.hostStartSample]) {
      const observation = createSyntheticMetricListeningObservation({
        startSample,
      });
      observation.alignment = f.observation.alignment;
      expect(metricAudioObservationSchema.safeParse(observation).success).toBe(
        true,
      );
      expect(
        listenerResultMetricSchema.safeParse({
          ...f.wire,
          type: "listener.result",
          status: "completed",
          observation,
          nativeSourceCoverage: f.proof,
        }).success,
      ).toBe(false);
    }
  });

  it("requires executed ABI3/config1 readiness without claiming universal metric readiness", () => {
    const f = fixture();
    expect(listenerRegistrationMetricSchema.parse(f.registration)).toEqual(
      f.registration,
    );
    for (const patch of [
      { capabilities: ["audio-listener/retention-v1"] },
      {
        capabilities: [
          LISTENER_CAPABILITY_METRIC,
          "audio-listener/retention-v1",
        ],
      },
      { algorithmVersion: "2.0.0" },
      { vectorSize: 128 },
      { sampleRate: 96_000 },
      { deviceCanonicalPath: "live_set tracks 1 devices 0" },
      { nativeStatus: { ...f.registration.nativeStatus, executedGen: null } },
      {
        nativeStatus: {
          ...f.registration.nativeStatus,
          executedGen: undefined,
        },
      },
      {
        nativeStatus: {
          ...f.registration.nativeStatus,
          executedGen: f.proof.armed.receipt,
        },
      },
      { connectionEpoch: "11111111-1111-4111-8111-111111111111" },
      { nativeStatus: { ...f.registration.nativeStatus, abiVersion: 2 } },
    ])
      expect(
        listenerRegistrationMetricSchema.safeParse({
          ...f.registration,
          ...patch,
        }).success,
      ).toBe(false);
    const blocked = {
      ...f.registration,
      sampleRate: 96_000,
      nativeStatus: {
        ...f.registration.nativeStatus,
        readiness: "BLOCKED",
        executedGen: null,
        reason: "unsupported_dsp_geometry",
      },
    };
    expect(listenerRegistrationMetricSchema.safeParse(blocked).success).toBe(
      true,
    );
    expect(
      listenerRegistrationMetricSchema.safeParse({
        ...blocked,
        nativeStatus: { ...blocked.nativeStatus, executedGen: undefined },
      }).success,
    ).toBe(true);
    expect(
      listenerRegistrationMetricSchema.safeParse({
        ...blocked,
        nativeStatus: { ...blocked.nativeStatus, reason: undefined },
      }).success,
    ).toBe(false);
  });

  it.each(["arrangement", "session"] as const)(
    "validates exact %s controls, ready/arm proofs and complete/partial publications",
    (mode) => {
      for (const partial of [false, true]) {
        const f = fixture(mode, partial);
        const prepare = {
          ...f.wire,
          type: "listener.control",
          action: "prepare",
          config: f.config,
        };
        expect(listenerControlMetricSchema.parse(prepare)).toEqual(prepare);
        for (const action of ["arm", "cancel"]) {
          expect(
            listenerControlMetricSchema.safeParse({
              ...prepare,
              action,
              config: undefined,
            }).success,
          ).toBe(true);
          expect(
            listenerControlMetricSchema.safeParse({ ...prepare, action })
              .success,
          ).toBe(false);
        }
        expect(
          listenerControlMetricSchema.safeParse({
            ...prepare,
            config: undefined,
          }).success,
        ).toBe(false);
        expect(
          listenerControlMetricSchema.safeParse({
            ...prepare,
            mode: mode === "session" ? "arrangement" : "session",
          }).success,
        ).toBe(false);
        for (const [status, key] of [
          ["ready", "nativeReady"],
          ["armed", "nativeArm"],
        ] as const) {
          const reply = {
            ...f.wire,
            type: "listener.reply",
            status,
            [key]: status === "ready" ? f.ready : f.proof.armed,
          };
          expect(listenerReplyMetricSchema.parse(reply)).toEqual(reply);
          expect(
            listenerReplyMetricSchema.safeParse({ ...reply, [key]: undefined })
              .success,
          ).toBe(false);
          expect(
            listenerReplyMetricSchema.safeParse({
              ...reply,
              generation: "11111111-1111-4111-8111-111111111111",
            }).success,
          ).toBe(false);
          expect(
            listenerReplyMetricSchema.safeParse({
              ...reply,
              mode: mode === "session" ? "arrangement" : "session",
            }).success,
          ).toBe(false);
        }
        const result = {
          ...f.wire,
          type: "listener.result",
          status: partial ? "partial" : "completed",
          observation: f.observation,
          nativeSourceCoverage: f.proof,
        };
        expect(listenerResultMetricSchema.parse(result)).toEqual(result);
        expect(producerMessageSchema.safeParse(result).success).toBe(true);
        expect(f.observation.limitations).toContain(
          "Synthetic contract fixture; not actual audio evidence",
        );
        for (const patch of [
          { observation: undefined },
          { nativeSourceCoverage: undefined },
          { status: partial ? "completed" : "partial" },
          { mode: mode === "session" ? "arrangement" : "session" },
          { nativeCapture: f.proof },
        ])
          expect(
            listenerResultMetricSchema.safeParse({ ...result, ...patch })
              .success,
          ).toBe(false);
        for (const field of [
          "listenerId",
          "passId",
          "correlationId",
          "causationId",
        ] as const) {
          expect(
            listenerResultMetricSchema.safeParse({
              ...result,
              [field]: "foreign-owner",
            }).success,
          ).toBe(false);
        }
        for (const field of [
          "connectionId",
          "connectionEpoch",
          "generation",
          "traceId",
        ] as const) {
          expect(
            listenerResultMetricSchema.safeParse({
              ...result,
              [field]: "11111111-1111-4111-8111-111111111111",
            }).success,
          ).toBe(false);
        }
        expect(
          listenerControlMetricSchema.safeParse({
            ...prepare,
            listenerVersion: 4,
          }).success,
        ).toBe(false);
      }
    },
  );

  it("bounds progress and fails/cancels honestly without retaining misleading observations", () => {
    const f = fixture();
    const lifecycle = {
      scope: LISTENER_METRIC_SCOPE,
      eventId: f.wire.traceId,
      causationId: "synthetic-native-stage-parent",
      generation: f.wire.generation,
      nativeEpoch: 1,
      stage: "progress",
      phase: "capture",
      elapsedMs: 10,
      frames: 1,
    };
    const progress = {
      ...f.wire,
      type: "listener.result",
      status: "progress",
      nativeLaunch: f.proof.launched,
      nativeLifecycle: lifecycle,
    };
    expect(listenerResultMetricSchema.safeParse(progress).success).toBe(true);
    for (const patch of [
      { observation: f.observation },
      { nativeSourceCoverage: f.proof },
      { nativeLaunch: undefined, nativeLifecycle: undefined },
      { nativeLifecycle: { ...lifecycle, frames: 2_001 } },
      { nativeLifecycle: { ...lifecycle, causationId: "" } },
      {
        nativeLifecycle: {
          ...lifecycle,
          generation: "11111111-1111-4111-8111-111111111111",
        },
      },
      {
        nativeLifecycle: {
          ...lifecycle,
          stage: "failed",
          reason: "capture_failed",
        },
      },
      {
        nativeLaunch: {
          ...f.proof.launched,
          ownership: { ...f.proof.launched.ownership, passId: "foreign" },
        },
      },
    ])
      expect(
        listenerResultMetricSchema.safeParse({ ...progress, ...patch }).success,
      ).toBe(false);
    for (const status of ["failed", "cancelled"]) {
      const result = {
        ...f.wire,
        type: "listener.result",
        status,
        reason: "synthetic_native_unavailable",
      };
      const reply = { ...result, type: "listener.reply" };
      expect(listenerResultMetricSchema.safeParse(result).success).toBe(true);
      expect(listenerReplyMetricSchema.safeParse(reply).success).toBe(true);
      for (const reason of [undefined, "", "x".repeat(513)]) {
        expect(
          listenerResultMetricSchema.safeParse({ ...result, reason }).success,
        ).toBe(false);
        expect(
          listenerReplyMetricSchema.safeParse({ ...reply, reason }).success,
        ).toBe(false);
      }
      for (const patch of [
        { observation: f.observation },
        { nativeSourceCoverage: f.proof },
        { nativeLaunch: f.proof.launched },
      ]) {
        expect(
          listenerResultMetricSchema.safeParse({ ...result, ...patch }).success,
        ).toBe(false);
      }
      expect(
        listenerReplyMetricSchema.safeParse({
          ...reply,
          nativeArm: f.proof.armed,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects foreign/malformed coverage, empty partial data and unchunked oversized publications", () => {
    const f = fixture("arrangement", true);
    const result = {
      ...f.wire,
      type: "listener.result",
      status: "partial",
      observation: f.observation,
      nativeSourceCoverage: f.proof,
    };
    const malformed = structuredClone(f.proof);
    malformed.completion.timing[3] = 1;
    malformed.completion.confirmedTiming[3] = 1;
    expect(
      listenerResultMetricSchema.safeParse({
        ...result,
        nativeSourceCoverage: malformed,
      }).success,
    ).toBe(false);
    const empty = structuredClone(f.observation);
    for (const metric of Object.values(empty.metrics)) metric.records = [];
    expect(
      listenerResultMetricSchema.safeParse({ ...result, observation: empty })
        .success,
    ).toBe(false);
    expect(
      listenerResultMetricSchema.safeParse({
        ...result,
        observation: {
          ...f.observation,
          schema: "audio-observation/v2",
          complete: false,
        },
      }).success,
    ).toBe(false);
    const large = fixture("arrangement", false, true);
    expect(
      metricAudioObservationSchema.safeParse(large.observation).success,
    ).toBe(true);
    expect(MAX_AUDIO_OBSERVATION_BYTES).toBe(256 * 1_024);
    expect(
      new TextEncoder().encode(JSON.stringify(large.observation)).byteLength,
    ).toBeLessThanOrEqual(MAX_AUDIO_OBSERVATION_BYTES);
    const oversized = {
      ...large.wire,
      type: "listener.result",
      status: "completed",
      observation: large.observation,
      nativeSourceCoverage: large.proof,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeGreaterThan(DEFAULT_MAX_INGRESS_FRAME_BYTES);
    expect(listenerResultMetricSchema.safeParse(oversized).success).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
    ).toBeLessThan(MAX_METRIC_RESULT_FRAME_BYTES);
    const config = {
      ...f.config,
      geometry: createMetricListeningGeometry({
        sampleRate: 48_000,
        vectorSize: 64,
        tempoBpm: 999,
        startBeat: 0,
        endBeat: 499.5,
        startSample: 0,
      }),
    };
    const prepare = {
      ...f.wire,
      type: "listener.control",
      action: "prepare",
      config,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(prepare)).byteLength,
    ).toBeGreaterThan(DEFAULT_MAX_INGRESS_FRAME_BYTES);
    expect(listenerControlMetricSchema.safeParse(prepare).success).toBe(true);
  });
});

describe("unadvertised independent metric listener family", () => {
  it("requires explicit mode, UUID ownership/trace, pass/job/request and a bounded wire sequence", () => {
    const uuid = "00000000-0000-4000-8000-000000000001";
    const identity = {
      protocolVersion: 1,
      listenerVersion: 5,
      mode: "arrangement",
      listenerId: "synthetic-listener",
      connectionId: uuid,
      connectionEpoch: uuid,
      generation: uuid,
      requestId: "synthetic-request",
      jobId: "synthetic-job",
      passId: "synthetic-pass",
      traceId: uuid,
      correlationId: "synthetic-correlation",
      causationId: "synthetic-causation",
      sequence: 0,
    };
    expect(listenerMetricWireIdentitySchema.parse(identity)).toEqual(identity);
    for (const [field, values] of Object.entries({
      listenerVersion: [1, 2, 3, 4, "5", undefined],
      mode: ["unknown", "", undefined],
      listenerId: ["", "x".repeat(129), undefined],
      connectionId: ["foreign", "", undefined],
      connectionEpoch: ["foreign", "", undefined],
      generation: [1, "foreign", "", undefined],
      traceId: ["foreign", "", undefined],
      jobId: ["", undefined],
      passId: ["", undefined],
      requestId: ["", undefined],
      correlationId: ["", undefined],
      causationId: ["", undefined],
      sequence: [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity, undefined],
    })) {
      for (const value of values) {
        expect(
          listenerMetricWireIdentitySchema.safeParse({
            ...identity,
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
    expect(
      listenerMetricWireIdentitySchema.safeParse({
        ...identity,
        mode: "session",
        sequence: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    expect(
      listenerMetricWireIdentitySchema.safeParse({
        ...identity,
        nativeCapture: {},
      }).success,
    ).toBe(false);
  });

  it("uses a separate version, scope, capability, algorithm and producer schema", () => {
    expect(LISTENER_VERSION_METRIC).toBe(5);
    expect(LISTENER_CAPABILITY_METRIC).toBe(
      "audio-listener/independent-metric-timelines-v1",
    );
    expect(LISTENER_METRIC_SCOPE).toBe("independent-metric-timelines/v1");
    expect(LISTENER_METRIC_ALGORITHM_VERSION).toBe("3.0.0");
    expect(LISTENER_METRIC_PRODUCER_SCHEMA_VERSION).toBe(
      "metric-audio-observation/v1",
    );
    const producer = {
      producerId: "synthetic-producer",
      instanceId: "synthetic-instance",
      displayName: "Synthetic wire contract fixture; not actual audio evidence",
      signalKind: "audio",
      schemaVersion: LISTENER_METRIC_PRODUCER_SCHEMA_VERSION,
    };
    expect(listenerMetricProducerSchema.parse(producer)).toEqual(producer);
    expect(outputProducerSchema.safeParse(producer).success).toBe(true);
    for (const schemaVersion of [
      "audio-observation/v1",
      "audio-observation/v2",
      "session-audio-observation/v1",
    ]) {
      expect(
        listenerMetricProducerSchema.safeParse({ ...producer, schemaVersion })
          .success,
      ).toBe(false);
    }
    expect(
      listenerMetricProducerSchema.safeParse({
        ...producer,
        signalKind: "midi",
      }).success,
    ).toBe(false);
    expect(
      listenerMetricProducerSchema.safeParse({
        ...producer,
        capabilities: { unbounded: "x".repeat(128 * 1_024) },
      }).success,
    ).toBe(false);
  });
});
