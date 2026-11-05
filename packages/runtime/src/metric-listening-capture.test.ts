import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createMetricObservationReportRows,
  MAX_METRIC_RESULT_FRAME_BYTES,
  metricAudioObservationSchema,
  nativeMetricListeningConfigSchema,
  nativeMetricObservationMetricSchema,
  MEL_BAND_PROFILE,
  melBandTimelineSchema,
  readListeningFailureEvidence,
} from "@ableton-agent/protocol";
import type { TelemetryEventEnvelope } from "@ableton-agent/observability";
import {
  listenerControlMetricSchema,
  listenerMetricWireIdentitySchema,
  listenerRegistrationMetricSchema,
  listenerReplyMetricSchema,
  listenerResultMetricSchema,
  InMemoryConnectionRegistry,
  SignalIngressServer,
  SignalRouter,
  type ListenerDescriptor,
  type ListenerService,
} from "@ableton-agent/signal-routing";
import {
  bindMetricFixtureToControl,
  createSyntheticMetricWireFixture,
} from "@ableton-agent/signal-routing/testing";
import { captureFailureEvidence, failureFact } from "./listening-failure.js";
import {
  createSyntheticMetricListenerPeer,
  SyntheticMetricListenerPeer,
} from "./metric-listening-test-support.js";
import {
  MetricListeningBudgetError,
  prepareMetricListenerCapture,
  type MetricListeningCaptureProgress,
  type PrepareMetricListenerCaptureInput,
} from "./metric-listening-capture.js";

type Fixture = ReturnType<typeof createSyntheticMetricWireFixture>;
const trace = {
  traceId: "11111111-1111-4111-8111-111111111111",
  correlationId: "metric-correlation",
  causationId: "metric-cause",
};
afterEach(() => {
  vi.useRealTimers();
});

function seed(
  mode: "arrangement" | "session",
  partial = false,
  geometry: false | { tempoBpm: number; endBeat: number } = false,
): Fixture {
  const f = createSyntheticMetricWireFixture(mode, partial, geometry);
  if (f.observation.source.view === "arrangement")
    f.observation.source.target = {
      kind: "regular",
      index: 0,
      expectedReference: randomUUID(),
    };
  const config = nativeMetricListeningConfigSchema.parse({
    ...f.config,
    sourceContext: f.observation.source,
  });
  f.config = config;
  f.ready.config = structuredClone(config);
  f.proof.armed.config = structuredClone(config);
  return f;
}

class Service extends SyntheticMetricListenerPeer {
  readonly telemetry: TelemetryEventEnvelope[] = [];
  readonly abort = new AbortController();
  readonly input: PrepareMetricListenerCaptureInput;
  constructor(
    mode: "arrangement" | "session" = "arrangement",
    partial = false,
    geometry: false | { tempoBpm: number; endBeat: number } = false,
  ) {
    const data = seed(mode, partial, geometry);
    const descriptor: ListenerDescriptor = {
      connectionId: randomUUID(),
      binding: { trackId: "17", deviceId: "29" },
      producer: {
        producerId: "metric-listener",
        instanceId: randomUUID(),
        displayName: "Synthetic listener",
        signalKind: "audio",
        schemaVersion: "metric-audio-observation/v1",
        track: { id: "17" },
        device: { id: "29" },
      },
      registration: listenerRegistrationMetricSchema.parse({
        ...data.registration,
        connectionEpoch: randomUUID(),
        nativeStatus: {
          ...data.registration.nativeStatus,
          readiness: "BLOCKED",
          executedGen: null,
          reason: "fresh_per_pass_native_validation_required",
        },
      }),
      phase: "idle",
    };
    super(descriptor, data);
    this.input = {
      bindings: [
        {
          descriptor: structuredClone(this.descriptor),
          config: this.data.config,
        },
      ],
      trace,
      passId: "metric-pass",
      signal: this.abort.signal,
      controlTimeoutMs: 200,
      cleanupTimeoutMs: 100,
      resultTimeoutMs: 1000,
      telemetry: {
        enqueue: (event) => {
          this.telemetry.push(event);
          return true;
        },
      },
    };
  }
}

describe("real version5 ListenerService orchestration", () => {
  it.each([0.2, 0.01])(
    "accepts explicit mel-only valid/no-frame evidence for %s beats without native-record assumptions",
    async (endBeat) => {
      const s = new Service("arrangement", false, { tempoBpm: 120, endBeat });
      s.data.config.requestedMetrics = ["mel-bands"];
      s.data.config.attacks = null;
      s.data.ready.config = structuredClone(s.data.config);
      s.data.proof.armed.config = structuredClone(s.data.config);
      const observation = s.data.observation;
      observation.requestedMetrics = ["mel-bands"];
      for (const name of nativeMetricObservationMetricSchema.options) {
        observation.metrics[name].status = "not-requested";
        observation.metrics[name].algorithm = null;
        observation.metrics[name].records = [];
        observation.metrics[name].gaps = [];
        observation.metrics[name].limitations = [];
        observation.metrics[name].expectedRecords = 0;
      }
      const expectedRecords = Math.floor(
        observation.geometry.totalSamples / 2_048,
      );
      observation.metrics["mel-bands"] = melBandTimelineSchema.parse({
        schema: "mel-band-timeline/v1",
        status: "complete",
        profile: MEL_BAND_PROFILE,
        sampleRate: observation.geometry.sampleRate,
        sourceSupport: observation.sourceCoverage,
        expectedRecords,
        frames: Array.from({ length: expectedRecords }, (_, index) => ({
          index,
          support: {
            startSample: observation.geometry.startSample + index * 2_048,
            endSample: observation.geometry.startSample + (index + 1) * 2_048,
          },
          magnitudes: [Array<number>(24).fill(1), Array<number>(24).fill(2)],
        })),
        gaps: [],
      });
      observation.rows = createMetricObservationReportRows(observation);
      const prepared = await prepareMetricListenerCapture(s, s.input);
      s.launch();
      await prepared.nativeLaunch;
      s.complete();
      const [result] = await prepared.result;
      expect(result?.metrics["mel-bands"]?.expectedRecords).toBe(
        expectedRecords,
      );
      expect(result?.metrics.level.status).toBe("not-requested");
      await prepared.disarm();
      expect(s.subscribers.size).toBe(0);
    },
  );
  it.each([false, true])(
    "retains thirty-second complete/partial results larger than the old frame ceiling (partial=%s)",
    async (partial) => {
      const s = new Service("session", partial, {
        tempoBpm: 128,
        endBeat: 64,
      });
      expect(
        Buffer.byteLength(JSON.stringify(s.data.observation)),
      ).toBeGreaterThan(128 * 1024);
      const prepared = await prepareMetricListenerCapture(s, s.input);
      s.launch();
      await prepared.nativeLaunch;
      s.complete();
      const [observation] = await prepared.result;
      expect(observation?.rows).toHaveLength(256);
      expect(observation?.metrics).toEqual(s.data.observation.metrics);
      expect(observation?.ownership.traceId).toBe(trace.traceId);
      expect(observation?.outcome).toBe(partial ? "partial" : "complete");
      await prepared.disarm();
      expect(s.subscribers.size).toBe(0);
    },
  );

  it("exposes only implemented capture progress stages", () => {
    expectTypeOf<MetricListeningCaptureProgress["stage"]>().toEqualTypeOf<
      "preparing" | "arming" | "capturing" | "completed"
    >();
  });

  for (const mode of ["arrangement", "session"] as const)
    for (const partial of [false, true])
      it(`${mode} retains ${partial ? "partial" : "complete"} canonical independent metrics`, async () => {
        const s = new Service(mode, partial);
        const prepared = await prepareMetricListenerCapture(s, s.input);
        expect(s.calls.map((c) => c.action)).toEqual(["prepare", "arm"]);
        expect(prepared.observationContract).toBe(
          "independent-metric-timelines/v1",
        );
        s.launch();
        await prepared.nativeLaunch;
        s.complete();
        const [observation] = await prepared.result;
        expect(observation?.outcome).toBe(partial ? "partial" : "complete");
        expect(observation?.source).toEqual(
          s.input.bindings[0]!.config.sourceContext,
        );
        expect(Object.isFrozen(observation?.metrics.level.records)).toBe(true);
        await prepared.disarm();
        await prepared.disarm();
        expect(s.subscribers.size).toBe(0);
      });

  for (const mode of ["arrangement", "session"] as const)
    for (const partial of [false, true])
      it(`shares the ${mode} ${partial ? "partial" : "complete"} peer with host-compatible service wrappers`, async () => {
        const s = new Service(mode, partial);
        const controls: string[] = [];
        const peer = createSyntheticMetricListenerPeer(
          s.descriptor,
          s.data,
          (action) => controls.push(action),
        );
        const prepared = await prepareMetricListenerCapture(
          { ...peer.service },
          s.input,
        );
        peer.launch();
        await prepared.nativeLaunch;
        peer.complete();
        expect((await prepared.result)[0]?.outcome).toBe(
          partial ? "partial" : "complete",
        );
        await prepared.disarm();
        expect(controls).toEqual(["prepare", "arm"]);
        expect(peer.subscribers.size).toBe(0);
      });

  it("shares cancelled-result-before-reply behavior with host peers", async () => {
    const s = new Service();
    const controls: string[] = [];
    const peer = createSyntheticMetricListenerPeer(
      s.descriptor,
      s.data,
      (action) => controls.push(action),
    );
    const prepared = await prepareMetricListenerCapture(peer.service, s.input);
    s.abort.abort();
    await expect(prepared.result).rejects.toMatchObject({ code: "cancelled" });
    await prepared.disarm();
    expect(controls).toEqual(["prepare", "arm", "cancel"]);
    expect(peer.subscribers.size).toBe(0);
  });

  it("uses fresh generations when the shared peer is reused after confirmed completion", async () => {
    const s = new Service();
    const peer = createSyntheticMetricListenerPeer(
      s.descriptor,
      s.data,
      () => {},
    );
    const generations: string[] = [];
    for (const passId of ["shared-pass-1", "shared-pass-2"]) {
      const prepared = await prepareMetricListenerCapture(peer.service, {
        ...s.input,
        passId,
      });
      peer.launch();
      peer.complete();
      generations.push((await prepared.result)[0]!.ownership.generation);
      await prepared.disarm();
      expect(peer.subscribers.size).toBe(0);
    }
    expect(new Set(generations).size).toBe(2);
  });

  it("bounds shared peer subscribers and invalid control history without a result queue", async () => {
    const s = new Service();
    const unsubscribe = Array.from({ length: 16 }, () =>
      s.onListenerResult(() => {}),
    );
    expect(() => s.onListenerResult(() => {})).toThrow("subscriber quota");
    unsubscribe.forEach((release) => release());
    expect(s.subscribers.size).toBe(0);
    for (let index = 0; index < 64; index++)
      await expect(
        s.requestListenerControl(s.descriptor.connectionId, {
          ...trace,
          jobId: "unprepared-job",
          passId: "unprepared-pass",
          action: "arm",
        }),
      ).rejects.toBeInstanceOf(Error);
    await expect(
      s.requestListenerControl(s.descriptor.connectionId, {
        ...trace,
        jobId: "unprepared-job",
        passId: "unprepared-pass",
        action: "arm",
      }),
    ).rejects.toThrow("control quota");
    expect(s.calls).toHaveLength(64);
    expect(s.controls).toHaveLength(0);
  });

  it("accepts independent metric failure progress before ready and before arm reply acknowledgement", async () => {
    const s = new Service("arrangement", true);
    s.prepareHook = () => {
      s.emit(
        s.event({
          nativeLifecycle: s.lifecycle({
            metric: "spectral-centroid",
            stage: "failed",
            reason: "analyzer_failed",
          }),
        }),
      );
    };
    s.armHook = () => {
      s.launch();
      s.complete();
    };
    const prepared = await prepareMetricListenerCapture(s, s.input);
    await expect(prepared.nativeLaunch).resolves.toBeUndefined();
    await expect(prepared.result).resolves.toMatchObject([
      { outcome: "partial" },
    ]);
    await prepared.disarm();
  });

  it("preserves measured silence and genuinely empty attack detections", async () => {
    const s = new Service();
    for (const r of s.data.observation.metrics.level.records) {
      r.peak = [0, 0];
      r.rms = [0, 0];
    }
    for (const r of s.data.observation.metrics["spectral-centroid"].records) {
      r.centroidHz = null;
      r.spectralEnergy = 0;
    }
    for (const r of s.data.observation.metrics.attacks.records) {
      r.inputLevel = { peak: [0, 0], rms: [0, 0] };
      r.events = [];
    }
    s.data.observation.rows = createMetricObservationReportRows(
      s.data.observation,
    );
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.launch();
    s.complete();
    expect((await prepared.result)[0]?.metrics.attacks.status).toBe("complete");
    await prepared.disarm();
  });

  it("denies missing inspected source metadata and mixed/duplicate/stale listeners before controls", async () => {
    const s = new Service();
    const absent = structuredClone(s.input.bindings[0]!.config);
    delete absent.sourceContext;
    for (const bindings of [
      [{ descriptor: s.descriptor, config: absent }],
      [s.input.bindings[0]!, s.input.bindings[0]!],
      [
        {
          descriptor: { ...s.descriptor, phase: "armed" as const },
          config: s.data.config,
        },
      ],
      [
        {
          descriptor: {
            ...s.descriptor,
            registration: { ...s.data.registration, version: 4 },
          },
          config: s.data.config,
        },
      ],
    ]) {
      await expect(
        prepareMetricListenerCapture(s, {
          ...s.input,
          bindings: bindings as PrepareMetricListenerCaptureInput["bindings"],
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(s.calls).toEqual([]);
    }
  });

  it("rejects terminal self-consistent source replacement against the frozen Bridge-inspected intent", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.launch();
    await prepared.nativeLaunch;
    const foreign = structuredClone(s.data);
    if (foreign.observation.source.view !== "arrangement")
      throw new Error("fixture");
    foreign.observation.source.target.expectedReference = randomUUID();
    foreign.proof.armed.config.sourceContext = structuredClone(
      foreign.observation.source,
    );
    const message = listenerResultMetricSchema.parse({
      ...s.event({
        status: "completed",
        observation: s.data.observation,
        nativeSourceCoverage: s.data.proof,
      }),
      observation: foreign.observation,
      nativeSourceCoverage: foreign.proof,
    });
    s.emit(message);
    await expect(prepared.result).rejects.toBeInstanceOf(Error);
    await prepared.disarm();
  });

  it("rejects exact duplicate progress, sequence gaps and foreign generations", async () => {
    for (const change of ["duplicate", "gap", "generation"] as const) {
      const s = new Service();
      const prepared = await prepareMetricListenerCapture(s, s.input);
      const message = s.event({ nativeLifecycle: s.lifecycle() });
      if (change === "duplicate") {
        s.emit(message);
        s.emit(message);
      }
      if (change === "gap")
        s.emit({ ...message, sequence: message.sequence + 1 });
      if (change === "generation") {
        const generation = randomUUID();
        s.emit({
          ...message,
          generation,
          nativeLifecycle: { ...message.nativeLifecycle!, generation },
        });
      }
      await expect(prepared.result).rejects.toBeInstanceOf(Error);
      if (change === "duplicate") await prepared.disarm();
      else await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
    }
  });

  it("rejects cancellation before controls, confirms in-flight capture cancellation and seals success", async () => {
    const before = new Service();
    before.abort.abort();
    await expect(
      prepareMetricListenerCapture(before, before.input),
    ).rejects.toBeInstanceOf(Error);
    expect(before.calls).toHaveLength(0);
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.abort.abort();
    await expect(prepared.result).rejects.toBeInstanceOf(Error);
    await prepared.disarm();
    await prepared.disarm();
    expect(s.calls.filter((c) => c.action === "cancel")).toHaveLength(1);
    const ended = new Service();
    const done = await prepareMetricListenerCapture(ended, ended.input);
    ended.launch();
    ended.complete();
    const result = await done.result;
    ended.abort.abort();
    await done.disarm();
    expect(await done.result).toBe(result);
  });

  it("has one absolute deadline covering prepare and arm without progress resets", async () => {
    vi.useFakeTimers();
    const s = new Service();
    s.prepareHook = () => new Promise((resolve) => setTimeout(resolve, 60));
    const pending = prepareMetricListenerCapture(s, {
      ...s.input,
      resultTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(60);
    const prepared = await pending;
    s.emit(s.event({ nativeLifecycle: s.lifecycle() }));
    const failed = expect(prepared.result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(40);
    await failed;
    await prepared.disarm();
  });

  it("fails global prepare progress promptly even when the pending control reply never arrives", async () => {
    vi.useFakeTimers();
    const s = new Service();
    s.prepareHook = () => {
      s.emit(s.event({ status: "failed", reason: "native_global_failure" }));
      return new Promise(() => {});
    };
    const failure = prepareMetricListenerCapture(s, {
      ...s.input,
      controlTimeoutMs: 1000,
    });
    const assertion = expect(failure).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(s.calls.map((c) => c.action)).toContain("cancel");
  });

  it("lost arm reply remains execution-unknown even when cancel is acknowledged", async () => {
    vi.useFakeTimers();
    const s = new Service();
    let late!: () => void;
    s.armHook = () =>
      new Promise((resolve) => {
        late = resolve;
      });
    const pending = prepareMetricListenerCapture(s, {
      ...s.input,
      controlTimeoutMs: 20,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: "metric-capture-cleanup-uncertain",
    });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    late();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      s.telemetry.some((e) => e.attributes?.lateControlCompletion === true),
    ).toBe(true);
    expect(s.subscribers.size).toBe(0);
  });

  it("rejects uncertain cleanup and never cancels a reconnected/replacement instance", async () => {
    vi.useFakeTimers();
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.descriptor.producer = {
      ...s.descriptor.producer,
      instanceId: randomUUID(),
    };
    const assertion = expect(prepared.result).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
    expect(s.calls.filter((c) => c.action === "cancel")).toHaveLength(0);
  });

  it("keeps owned ingress failure facts, redacted and attributable, after source disconnect", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    const evidence = captureFailureEvidence({
      code: "output-backpressure",
      message: "output-backpressure",
      phase: "capture",
      component: "ingress",
      checkId: "ingress.backpressure",
      trace,
      passId: prepared.passId,
      jobId: prepared.jobId,
      listener: s.descriptor,
      facts: [failureFact("ingress.actual", "Bearer synthetic-private-token")],
    });
    s.emit(
      s.event({ status: "failed", reason: "output_backpressure" }),
      evidence,
    );
    const error: unknown = await prepared.result.catch(
      (cause: unknown) => cause,
    );
    const read = readListeningFailureEvidence(error);
    expect(read.status).toBe("present");
    if (read.status !== "present") throw new Error("evidence");
    expect(read.evidence.reference.jobId).toBe(prepared.jobId);
    expect(read.evidence.code).toBe("output-backpressure");
    expect(read.evidence.component).toBe("ingress");
    expect(read.evidence.facts[0]?.field).toBe("ingress.actual");
    expect(JSON.stringify(read.evidence)).not.toContain(
      "synthetic-private-token",
    );
    await expect(prepared.disarm()).resolves.toBeUndefined();
  });

  it("emits stage-owned timings and terminal outcomes, never queued/progress success", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    for (let index = 0; index < 100; index++)
      s.emit(s.event({ nativeLifecycle: s.lifecycle() }));
    s.launch();
    s.complete();
    await prepared.result;
    await prepared.disarm();
    for (const event of s.telemetry) {
      if (/\.(queued|started|progress)$/.test(event.name)) {
        expect(event.outcome).toBeUndefined();
        expect(event.durationMs).toBeUndefined();
      }
      if (event.name.endsWith(".completed"))
        expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.correlationId).toBe(trace.correlationId);
      expect(event.trace?.traceId).toBe(trace.traceId);
      expect(event.attributes?.jobId).toBe(prepared.jobId);
    }
    expect(
      s.telemetry.filter((e) => e.name.endsWith(".progress")).length,
    ).toBeLessThan(20);
    expect(
      metricAudioObservationSchema.safeParse((await prepared.result)[0])
        .success,
    ).toBe(true);
  });

  it("exposes typed canonical budget denial before arm without reducing capture", async () => {
    const s = new Service();
    const large = createSyntheticMetricWireFixture("arrangement", false, {
      tempoBpm: 999,
      endBeat: 499.5,
    });
    large.observation.source = structuredClone(s.data.observation.source);
    large.observation.source.transport.endBeat = large.config.geometry.endBeat;
    large.config.sourceContext = large.observation.source;
    large.ready.config = structuredClone(large.config);
    large.proof.armed.config = structuredClone(large.config);
    s.data = large;
    const failed = await prepareMetricListenerCapture(s, {
      ...s.input,
      bindings: [{ descriptor: s.descriptor, config: large.config }],
    }).catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(MetricListeningBudgetError);
    expect(s.calls.map((c) => c.action)).not.toContain("arm");
    expect(s.calls.map((c) => c.action)).toContain("cancel");
  });

  it("prepares every independent Arrangement binding before arming any listener", async () => {
    const a = new Service(),
      b = new Service();
    b.descriptor.producer = {
      ...b.descriptor.producer,
      producerId: "metric-b",
      track: { id: "18" },
      device: { id: "30" },
    };
    b.descriptor.binding = { trackId: "18", deviceId: "30" };
    b.descriptor.registration = {
      ...b.descriptor.registration,
      trackCanonicalPath: "live_set tracks 1",
      deviceCanonicalPath: "live_set tracks 1 devices 0",
    };
    if (b.data.observation.source.view !== "arrangement")
      throw new Error("fixture");
    b.data.observation.source.target.index = 1;
    b.data.config.sourceContext = structuredClone(b.data.observation.source);
    b.data.ready.config = structuredClone(b.data.config);
    b.data.proof.armed.config = structuredClone(b.data.config);
    const order: string[] = [];
    const service: ListenerService = {
      inspectListeners: () => [
        ...a.inspectListeners(),
        ...b.inspectListeners(),
      ],
      onListenerResult(callback) {
        const unsubscribers = [
          a.onListenerResult(callback),
          b.onListenerResult(callback),
        ];
        return () => {
          unsubscribers.forEach((unsubscribe) => unsubscribe());
        };
      },
      requestListenerControl(connection, input) {
        const s = connection === a.descriptor.connectionId ? a : b;
        order.push(`${s.descriptor.producer.producerId}:${input.action}`);
        return s.requestListenerControl(connection, input);
      },
    };
    const prepared = await prepareMetricListenerCapture(service, {
      ...a.input,
      bindings: [a, b].map((s) => ({
        descriptor: s.descriptor,
        config: s.data.config,
      })),
    });
    expect(order).toEqual([
      "metric-listener:prepare",
      "metric-b:prepare",
      "metric-listener:arm",
      "metric-b:arm",
    ]);
    a.launch();
    b.launch();
    await prepared.nativeLaunch;
    a.complete();
    b.complete();
    expect(await prepared.result).toHaveLength(2);
    await prepared.disarm();
  });

  it("does not accept a self-consistent different ready configuration", async () => {
    const s = new Service();
    s.prepareHook = () => {
      const source = s.data.ready.config.sourceContext;
      if (source?.view !== "arrangement") throw new Error("fixture");
      source.target.expectedReference = randomUUID();
    };
    await expect(
      prepareMetricListenerCapture(s, s.input),
    ).rejects.toBeInstanceOf(Error);
    expect(s.calls.some((c) => c.action === "arm")).toBe(false);
  });

  it("pins the reserved ready epoch instead of sourcing it from the arm or launch", async () => {
    for (const stage of ["arm", "launch"] as const) {
      const s = new Service();
      if (stage === "arm")
        s.armHook = (reply) => {
          if (reply.listenerVersion !== 5 || !reply.nativeArm)
            throw new Error("fixture");
          const arm = reply.nativeArm;
          arm.ownership.nativeEpoch++;
          for (const fields of [
            arm.receipt.fields,
            arm.receipt.confirmedFields,
          ])
            fields[0] = fields[10] = fields[11] = arm.ownership.nativeEpoch;
          arm.receipt.timing[0] = arm.receipt.confirmedTiming[0] =
            arm.ownership.nativeEpoch;
          listenerReplyMetricSchema.parse(reply);
        };
      if (stage === "arm") {
        await expect(
          prepareMetricListenerCapture(s, s.input),
        ).rejects.toBeInstanceOf(Error);
      } else {
        const prepared = await prepareMetricListenerCapture(s, s.input);
        s.data.proof.launched.ownership.nativeEpoch++;
        s.data.proof.launched.timing[0]++;
        s.launch();
        await expect(prepared.result).rejects.toBeInstanceOf(Error);
        await expect(prepared.disarm()).resolves.toBeUndefined();
      }
    }
  });

  it("uses canonical strict timing guards before any arm", async () => {
    const s = new Service();
    s.data.config.timingPolicy = {
      mode: "strict",
      maxClockDisagreementSamples: 0,
    };
    s.data.ready.config = structuredClone(s.data.config);
    s.data.proof.armed.config = structuredClone(s.data.config);
    s.prepareHook = () => {
      const row = s.data.ready.before.frames[1]!;
      row[2]++;
      row[9]++;
    };
    await expect(
      prepareMetricListenerCapture(s, s.input),
    ).rejects.toBeInstanceOf(Error);
    expect(s.calls.some((c) => c.action === "arm")).toBe(false);
  });

  it("rejects terminal claims with no useful timelines instead of promoting state/readiness", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.launch();
    const terminal = s.event({
      status: "completed",
      observation: s.data.observation,
      nativeSourceCoverage: s.data.proof,
    });
    const empty = structuredClone(s.data.observation);
    for (const name of nativeMetricObservationMetricSchema.options)
      empty.metrics[name].records.length = 0;
    s.emit({ ...terminal, observation: empty });
    await expect(prepared.result).rejects.toBeInstanceOf(Error);
    await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
  });

  it("never resolves success after unsubscribe failure and drops its retained late callback", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.unsubscribeHook = () => {
      throw new Error("controlled unsubscribe failure");
    };
    s.launch();
    s.complete();
    await expect(prepared.result).rejects.toBeInstanceOf(Error);
    const count = s.telemetry.length;
    s.emit(s.event({ nativeLifecycle: s.lifecycle() }));
    expect(s.telemetry.length).toBe(count);
    await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
    s.subscribers.clear();
  });

  it("cannot claim confirmed cleanup when cancellation fails or its reply is lost", async () => {
    vi.useFakeTimers();
    for (const missing of [false, true]) {
      const s = new Service();
      s.cancelHook = () =>
        missing
          ? new Promise(() => {})
          : Promise.reject(new Error("cancel failed"));
      const prepared = await prepareMetricListenerCapture(s, s.input);
      const result = expect(prepared.result).rejects.toMatchObject({
        code: "metric-capture-cleanup-uncertain",
      });

      s.abort.abort();
      await vi.advanceTimersByTimeAsync(101);
      await result;
      await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
      await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
      expect(s.calls.filter((c) => c.action === "cancel")).toHaveLength(1);
    }
  });

  it("confirms SDK-style cancellation when owned results precede the cancel reply", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.cancelHook = () => {
      s.emit(
        s.event({
          nativeLifecycle: s.lifecycle({
            phase: "capture",
            stage: "cancelled",
            metric: "spectral-centroid",
            reason: "cancelled",
          }),
        }),
      );
      s.emit(s.event({ status: "cancelled", reason: "cancelled" }));
    };
    s.abort.abort();
    await expect(prepared.result).rejects.toMatchObject({ code: "cancelled" });
    await prepared.disarm();
    await prepared.disarm();
    expect(
      s.calls.filter((control) => control.action === "cancel"),
    ).toHaveLength(1);
    expect(s.subscribers.size).toBe(0);
  });

  it.each([
    ["generation", "foreign-metric-message"],
    ["epoch", "foreign-native-epoch"],
    ["duplicate", "result-sequence-gap-or-replay"],
    ["native-failure", "cleanup-native-failed"],
    ["overflow", "result-overflow"],
  ])(
    "cannot hide %s cleanup ingress behind an acknowledged cancel",
    async (fault, code) => {
      const s = new Service();
      const progress = vi.fn();
      const prepared = await prepareMetricListenerCapture(s, {
        ...s.input,
        onProgress: progress,
      });
      const progressCount = progress.mock.calls.length;
      s.cancelHook = () => {
        let message = s.event(
          fault === "native-failure"
            ? { status: "failed", reason: "native_cleanup_unconfirmed" }
            : { nativeLifecycle: s.lifecycle() },
        );
        if (fault === "generation") {
          message = { ...message, generation: randomUUID() };
          message.nativeLifecycle!.generation = message.generation;
        }
        if (fault === "epoch") message.nativeLifecycle!.nativeEpoch++;
        if (fault === "duplicate") message.sequence--;
        if (fault === "overflow")
          message.requestId = "x".repeat(MAX_METRIC_RESULT_FRAME_BYTES);
        s.emit(message);
      };
      s.abort.abort();
      const failure: unknown = await prepared.result.catch(
        (cause: unknown) => cause,
      );
      expect(failure).toMatchObject({
        code: "metric-capture-cleanup-uncertain",
      });
      if (!(failure instanceof AggregateError))
        throw new Error("expected uncertain cleanup");
      expect(
        failure.errors.some(
          (cause: unknown) =>
            cause instanceof Error && "code" in cause && cause.code === code,
        ),
      ).toBe(true);
      await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
      expect(
        s.calls.filter((control) => control.action === "cancel"),
      ).toHaveLength(1);
      expect(progress).toHaveBeenCalledTimes(progressCount);
      expect(
        s.telemetry.some(
          (event) =>
            event.name === "listening.metric-capture.failed" &&
            event.attributes?.action === "cancel-ingress",
        ),
      ).toBe(true);
    },
  );

  it("retains attributed redacted ingress cleanup evidence instead of trusting a later cancel ACK", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.cancelHook = () => {
      s.emit(
        s.event({ status: "failed", reason: "native_cleanup_unconfirmed" }),
        captureFailureEvidence({
          code: "native-cleanup-unconfirmed",
          message: "native-cleanup-unconfirmed",
          phase: "cleanup",
          component: "ingress",
          checkId: "ingress.native-cleanup",
          trace,
          passId: prepared.passId,
          jobId: prepared.jobId,
          listener: s.descriptor,
          facts: [
            failureFact(
              "native.actual",
              "Authorization: Bearer synthetic-private-token",
            ),
          ],
        }),
      );
    };
    s.abort.abort();
    const failure: unknown = await prepared.result.catch(
      (cause: unknown) => cause,
    );
    if (!(failure instanceof AggregateError))
      throw new Error("expected uncertain cleanup");
    const evidence = failure.errors
      .map((cause: unknown) => readListeningFailureEvidence(cause))
      .find(
        (read) =>
          read.status === "present" &&
          read.evidence.code === "native-cleanup-unconfirmed",
      );
    expect(evidence?.status).toBe("present");
    if (evidence?.status !== "present")
      throw new Error("expected owned ingress evidence");
    expect(evidence.evidence.reference.jobId).toBe(prepared.jobId);
    expect(evidence.evidence.listener?.connectionId).toBe(
      s.descriptor.connectionId,
    );
    expect(evidence.evidence.phase).toBe("cleanup");
    expect(JSON.stringify([evidence, s.telemetry])).not.toContain(
      "synthetic-private-token",
    );
    await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
  });

  it("bounds startup staging rather than queuing arbitrarily many pre-ready packets", async () => {
    const s = new Service();
    s.prepareHook = () => {
      for (let index = 0; index < 33; index++)
        s.emit(s.event({ nativeLifecycle: s.lifecycle() }));
    };
    await expect(
      prepareMetricListenerCapture(s, s.input),
    ).rejects.toBeInstanceOf(Error);
    expect(s.calls.some((c) => c.action === "arm")).toBe(false);
  });

  it("cancellation during prepare cannot leak into arm or become confirmed success after a late ready", async () => {
    const s = new Service();
    s.prepareHook = () => {
      s.abort.abort();
    };
    await expect(
      prepareMetricListenerCapture(s, s.input),
    ).rejects.toMatchObject({
      code: "metric-capture-cleanup-uncertain",
    });
    expect(s.calls.map((control) => control.action)).toEqual([
      "prepare",
      "cancel",
    ]);
    expect(s.subscribers.size).toBe(0);
  });

  it("honors cancellation from the completion callback before sealing the result", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, {
      ...s.input,
      onProgress: (progress) => {
        if (progress.stage === "completed") s.abort.abort();
      },
    });
    s.launch();
    s.complete();
    await expect(prepared.result).rejects.toMatchObject({ code: "cancelled" });
    await prepared.disarm();
    expect(
      s.telemetry.some(
        (event) =>
          event.name.endsWith(".completed") &&
          event.attributes?.action === "capture",
      ),
    ).toBe(false);
  });

  it("does not accept an old terminal after a foreign job has replaced its owner", async () => {
    const s = new Service();
    const prepared = await prepareMetricListenerCapture(s, s.input);
    s.launch();
    const terminal = s.event({
      status: "completed",
      observation: s.data.observation,
      nativeSourceCoverage: s.data.proof,
    });
    s.descriptor.jobId = "replacement-job";
    s.descriptor.passId = "replacement-pass";
    for (const subscriber of s.subscribers)
      subscriber({
        connectionId: s.descriptor.connectionId,
        producer: s.descriptor.producer,
        binding: s.descriptor.binding,
        result: terminal,
      });
    await expect(prepared.result).rejects.toBeInstanceOf(Error);
    await expect(prepared.disarm()).rejects.toBeInstanceOf(Error);
    expect(
      s.calls.filter((control) => control.action === "cancel"),
    ).toHaveLength(0);
  });

  it("freezes configuration/trace and the public handle without freezing or reinterpreting caller data", async () => {
    const s = new Service();
    const original = structuredClone(s.data.config);
    const mutableTrace = { ...trace };
    const prepared = await prepareMetricListenerCapture(s, {
      ...s.input,
      trace: mutableTrace,
      bindings: [{ descriptor: s.descriptor, config: original }],
    });
    if (original.sourceContext?.view !== "arrangement")
      throw new Error("fixture");
    original.sourceContext.target.expectedReference = randomUUID();
    mutableTrace.correlationId = "changed";
    s.launch();
    s.complete();
    const [observation] = await prepared.result;
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(observation?.source).not.toEqual(original.sourceContext);
    expect(observation?.ownership.correlationId).toBe(trace.correlationId);
    expect(() =>
      observation!.metrics.level.records.push(
        structuredClone(observation!.metrics.level.records[0]!),
      ),
    ).toThrow();
    await prepared.disarm();
  });

  for (const mode of ["arrangement", "session"] as const)
    for (const cancel of [false, true])
      it(`executes ${mode} ${cancel ? "cancellation" : "completion"} over opt-in TCP ListenerService with coalesced ingress`, async () => {
        let data = seed(mode, mode === "arrangement");
        const secret = "synthetic-runtime-metric-test-secret";
        const registry = new InMemoryConnectionRegistry({
          staleAfterMs: 100_000,
        });
        const server = new SignalIngressServer({
          secret,
          registry,
          router: new SignalRouter({ registry }),
          port: 0,
          independentMetricListeners: true,
        });
        const endpoint = await server.start();
        const socket = connect(endpoint);
        let failed!: (cause: Error) => void, hello!: () => void;
        const fault = new Promise<never>((_, reject) => {
          failed = reject;
        });
        void fault.catch(() => {});
        const registered = new Promise<void>((resolve) => {
          hello = resolve;
        });
        let buffered = "",
          sequence = 0;
        const write = (values: readonly unknown[]) => {
          socket.write(
            values.map((value) => JSON.stringify(value)).join("\n") + "\n",
          );
        };
        socket.setEncoding("utf8");
        socket.on("error", failed);
        socket.on("data", (chunk: string) => {
          try {
            buffered += chunk;
            for (let end; (end = buffered.indexOf("\n")) >= 0;) {
              const value: unknown = JSON.parse(buffered.slice(0, end));
              buffered = buffered.slice(end + 1);
              if (
                value !== null &&
                typeof value === "object" &&
                Reflect.get(value, "type") === "producer.ack"
              ) {
                if (Reflect.get(value, "action") === "hello") hello();
                continue;
              }
              const control = listenerControlMetricSchema.parse(value);
              const wire = listenerMetricWireIdentitySchema.parse(
                Object.fromEntries(
                  Object.keys(listenerMetricWireIdentitySchema.shape).map(
                    (key) => [key, Reflect.get(control, key)],
                  ),
                ),
              );
              if (control.action === "prepare")
                data = bindMetricFixtureToControl(data, control);
              const progress = () =>
                listenerResultMetricSchema.parse({
                  ...wire,
                  type: "listener.result",
                  requestId: randomUUID(),
                  sequence: sequence++,
                  status: "progress",
                  nativeLifecycle: {
                    eventId: randomUUID(),
                    causationId: trace.causationId,
                    scope: "independent-metric-timelines/v1",
                    stage: "progress",
                    generation: wire.generation,
                    nativeEpoch: data.ready.ownership.nativeEpoch,
                    phase: "preflight",
                    metric: "level",
                    elapsedMs: 10,
                    frames: 0,
                  },
                });
              const preReady =
                control.action === "prepare" ? progress() : undefined;
              const cancelled =
                control.action === "cancel"
                  ? listenerResultMetricSchema.parse({
                      ...wire,
                      type: "listener.result",
                      requestId: randomUUID(),
                      sequence: sequence++,
                      status: "cancelled",
                      reason: "cancelled",
                    })
                  : undefined;
              const reply = listenerReplyMetricSchema.parse({
                ...wire,
                type: "listener.reply",
                sequence: sequence++,
                status:
                  control.action === "prepare"
                    ? "ready"
                    : control.action === "arm"
                      ? "armed"
                      : "cancelled",
                ...(control.action === "prepare"
                  ? { nativeReady: data.ready }
                  : {}),
                ...(control.action === "arm"
                  ? { nativeArm: data.proof.armed }
                  : {}),
                ...(control.action === "cancel" ? { reason: "cancelled" } : {}),
              });
              if (control.action === "prepare")
                write([preReady, reply, progress()]);
              else if (control.action !== "arm") write([cancelled, reply]);
              else
                write([
                  reply,
                  listenerResultMetricSchema.parse({
                    ...wire,
                    type: "listener.result",
                    requestId: randomUUID(),
                    sequence: sequence++,
                    status: "progress",
                    nativeLaunch: data.proof.launched,
                  }),
                  ...(!cancel
                    ? [
                        listenerResultMetricSchema.parse({
                          ...wire,
                          type: "listener.result",
                          requestId: randomUUID(),
                          sequence: sequence++,
                          status:
                            data.observation.outcome === "partial"
                              ? "partial"
                              : "completed",
                          observation: data.observation,
                          nativeSourceCoverage: data.proof,
                        }),
                      ]
                    : []),
                ]);
            }
          } catch (cause) {
            failed(
              cause instanceof Error ? cause : new Error("TCP peer failed"),
            );
          }
        });
        try {
          await Promise.race([
            new Promise<void>((resolve) => socket.once("connect", resolve)),
            fault,
          ]);
          write([
            {
              type: "producer.hello",
              protocolVersion: 1,
              requestId: "hello",
              secret,
              producer: {
                producerId: "metric-listener",
                instanceId: randomUUID(),
                displayName: "TCP metric fixture",
                signalKind: "audio",
                schemaVersion: "metric-audio-observation/v1",
                track: { id: "17" },
                device: { id: "29" },
              },
              listener: listenerRegistrationMetricSchema.parse({
                ...data.registration,
                nativeStatus: {
                  ...data.registration.nativeStatus,
                  readiness: "BLOCKED",
                  executedGen: null,
                  reason: "fresh_per_pass_native_validation_required",
                },
              }),
            },
          ]);
          await Promise.race([registered, fault]);
          const descriptor = server.inspectListeners()[0]!;
          const abort = new AbortController();
          const prepared = await Promise.race([
            prepareMetricListenerCapture(server, {
              bindings: [{ descriptor, config: data.config }],
              trace,
              passId: "tcp-pass",
              signal: abort.signal,
              controlTimeoutMs: 1000,
              resultTimeoutMs: 2000,
            }),
            fault,
          ]);
          await Promise.race([prepared.nativeLaunch, fault]);
          if (cancel) {
            abort.abort();
            await expect(
              Promise.race([prepared.result, fault]),
            ).rejects.toMatchObject({
              code: "cancelled",
            });
          } else {
            const results = await Promise.race([prepared.result, fault]);
            expect(results[0]?.outcome).toBe(
              mode === "arrangement" ? "partial" : "complete",
            );
          }
          await prepared.disarm();
        } finally {
          socket.destroy();
          await server.stop();
        }
      });
});
