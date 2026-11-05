import { describe, expect, it } from "vitest";
import {
  listenerRegistrationMetricSchema,
  type ListenerDescriptor,
} from "@ableton-agent/signal-routing";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import {
  createMetricCaptureBinding,
  validateMetricCaptureObservations,
} from "./metric-listening-config.js";

function fixture(mode: "arrangement" | "session", partial = false) {
  const data = createSyntheticMetricWireFixture(mode, partial);
  const descriptor: {
    -readonly [K in keyof ListenerDescriptor]: ListenerDescriptor[K];
  } = {
    connectionId: data.wire.connectionId,
    producer: {
      producerId: data.wire.listenerId,
      instanceId: "synthetic-metric-config-instance",
      displayName: "Synthetic listener",
      signalKind: "audio",
      schemaVersion: "metric-audio-observation/v1",
      track: { id: "500" },
      device: { id: "600" },
    },
    binding: { trackId: "500", deviceId: "600" },
    registration: listenerRegistrationMetricSchema.parse(data.registration),
    phase: "idle",
  };
  const input = {
    descriptor,
    source: data.observation.source,
    tempoBpm: data.config.geometry.tempoBpm,
    timingPolicy: data.config.timingPolicy,
  };
  const pass = {
    passId: data.wire.passId,
    trace: {
      traceId: data.wire.traceId,
      correlationId: data.wire.correlationId,
      causationId: data.wire.causationId,
    },
  };
  return { data, input, pass };
}

describe("application-owned metric capture configuration", () => {
  it.each(["arrangement", "session"] as const)(
    "freezes an explicit level-only %s request without silently dropping admitted analyzers",
    (mode) => {
      const { input } = fixture(mode);
      const requestedMetrics: ("level" | "attacks")[] = ["level"];
      const binding = createMetricCaptureBinding({
        ...input,
        requestedMetrics,
      });
      requestedMetrics.push("attacks");
      expect(binding.config.requestedMetrics).toEqual(["level"]);
      expect(binding.config.attacks).toBeUndefined();
      expect(Object.isFrozen(binding.config.requestedMetrics)).toBe(true);
    },
  );
  it.each(["arrangement", "session"] as const)(
    "freezes the %s source, grid and unchanged detector cadence",
    (mode) => {
      const { input, data } = fixture(mode);
      const binding = createMetricCaptureBinding(input);
      expect(binding.config.sourceContext).toEqual(data.observation.source);
      expect(binding.config.geometry).toEqual(data.config.geometry);
      expect(binding.config.requestedMetrics).toEqual([
        "level",
        "spectral-centroid",
        "attacks",
        "mel-bands",
      ]);
      expect(binding.config.attacks).toEqual({
        thresholdDb: 6,
        minSpacingSamples: 4800,
      });
      expect(Object.isFrozen(binding.config.sourceContext?.target)).toBe(true);
      expect(Object.isFrozen(binding.descriptor.producer)).toBe(true);
      input.descriptor.producer.displayName = "Changed after admission";
      input.source.transport.endBeat = 20;
      expect(binding.descriptor.producer.displayName).toBe(
        "Synthetic listener",
      );
      expect(binding.config.sourceContext?.transport.endBeat).not.toBe(20);
    },
  );

  it("uses the actual supported rate for the physical attack cadence", () => {
    const { input } = fixture("arrangement");
    input.descriptor.registration = listenerRegistrationMetricSchema.parse({
      ...input.descriptor.registration,
      sampleRate: 44_100,
      nativeStatus: {
        ...input.descriptor.registration.nativeStatus,
        readiness: "BLOCKED",
        reason: "fresh_per_pass_native_validation_required",
        executedGen: null,
      },
    });
    const binding = createMetricCaptureBinding(input);
    expect(binding.config.geometry.sampleRate).toBe(44_100);
    expect(binding.config.attacks?.minSpacingSamples).toBe(4410);
    expect(binding.config.geometry.reportBeats).toBe(0.25);
  });

  it("rejects an obsolete registration at the canonical boundary", () => {
    const { input } = fixture("arrangement");
    expect(
      listenerRegistrationMetricSchema.safeParse({
        ...input.descriptor.registration,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("does not bypass an analyzer-independent shared readiness failure", () => {
    const { input } = fixture("session");
    input.descriptor.registration = listenerRegistrationMetricSchema.parse({
      ...input.descriptor.registration,
      nativeStatus: {
        ...input.descriptor.registration.nativeStatus,
        readiness: "BLOCKED",
        reason: "dsp_disabled",
        executedGen: null,
      },
    });
    expect(() => createMetricCaptureBinding(input)).toThrow(
      "metric_listener_mode_unavailable",
    );
  });

  it("does not extend the thirty-second capture ceiling", () => {
    const { input } = fixture("arrangement");
    input.source.transport.endBeat = 61;
    expect(() => createMetricCaptureBinding(input)).toThrow();
  });
});

describe("metric observation publication binding", () => {
  it.each([
    ["arrangement", false],
    ["arrangement", true],
    ["session", false],
    ["session", true],
  ] as const)("retains honest %s partial=%s data", (mode, partial) => {
    const { input, data, pass } = fixture(mode, partial);
    const binding = createMetricCaptureBinding({
      ...input,
      requestedMetrics: data.config.requestedMetrics,
    });
    const validated = validateMetricCaptureObservations(
      [data.observation],
      [binding],
      pass,
    );
    expect(validated).toEqual([data.observation]);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated[0]?.metrics.level.records)).toBe(true);
  });

  it("rejects baseline-only evidence for a default four-metric capture", () => {
    const { input, data, pass } = fixture("session");
    const binding = createMetricCaptureBinding(input);
    expect(binding.config.requestedMetrics).toContain("mel-bands");
    expect(() =>
      validateMetricCaptureObservations([data.observation], [binding], pass),
    ).toThrow("invalid_metric_capture_observation");
  });

  it.each([
    "passId",
    "connectionId",
    "connectionEpoch",
    "traceId",
    "correlationId",
    "causationId",
  ] as const)("rejects an otherwise valid foreign %s", (key) => {
    const { input, data, pass } = fixture("arrangement");
    const binding = createMetricCaptureBinding(input);
    data.observation.ownership[key] = "10000000-0000-4000-8000-000000000001";
    expect(() =>
      validateMetricCaptureObservations([data.observation], [binding], pass),
    ).toThrow("invalid_metric_capture_observation");
  });

  it("rejects a self-consistent different Bridge source", () => {
    const { input, data, pass } = fixture("arrangement");
    const binding = createMetricCaptureBinding(input);
    if (data.observation.source.view !== "arrangement")
      throw new Error("Expected an Arrangement fixture");
    data.observation.source.target.expectedReference =
      "10000000-0000-4000-8000-000000000001";
    expect(() =>
      validateMetricCaptureObservations([data.observation], [binding], pass),
    ).toThrow("invalid_metric_capture_observation");
  });

  it("requires exactly one result per owned listener", () => {
    const { input, data, pass } = fixture("arrangement");
    const binding = createMetricCaptureBinding(input);
    expect(() =>
      validateMetricCaptureObservations([], [binding], pass),
    ).toThrow("invalid_metric_capture_observation");
    expect(() =>
      validateMetricCaptureObservations(
        [data.observation, data.observation],
        [binding, binding],
        pass,
      ),
    ).toThrow("invalid_metric_capture_observation");
  });
});
