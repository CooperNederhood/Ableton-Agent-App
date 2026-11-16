import { describe, expect, it } from "vitest";
import { createSyntheticAnalyzerReadiness } from "@ableton-agent/protocol/testing";
import {
  METRIC_RECORD_STREAM_CAPABILITY,
  METRIC_CONTINUOUS_LISTENING_CAPABILITY,
  NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
} from "@ableton-agent/protocol";
import {
  listenerRegistrationMetricSchema,
  type ListenerDescriptor,
} from "@ableton-agent/signal-routing";
import { createSyntheticMetricWireFixture } from "@ableton-agent/signal-routing/testing";
import { createMetricCaptureBinding } from "./metric-listening-config.js";
import { withSyntheticMetricStreamRegistration } from "./metric-listening-test-support.js";

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
  return { data, input };
}

function admittedFixture(mode: "arrangement" | "session") {
  const value = fixture(mode);
  value.input.descriptor.registration = withSyntheticMetricStreamRegistration(
    value.input.descriptor.registration,
  );
  return value;
}

describe("application-owned metric capture configuration", () => {
  it.each([
    ["arrangement", 1.875],
    ["arrangement", 30],
    ["arrangement", 30.001],
    ["arrangement", 37.5],
    ["session", 1.875],
    ["session", 30],
    ["session", 30.001],
    ["session", 37.5],
  ] as const)(
    "consolidation: %s %ss uses the canonical stream and identical analyzer request",
    (mode, seconds) => {
      const { input } = fixture(mode);
      input.tempoBpm = 128;
      input.source.transport.startBeat = mode === "session" ? 16 : 0;
      input.source.transport.endBeat =
        input.source.transport.startBeat + (seconds * input.tempoBpm) / 60;
      if (input.source.view === "session") {
        input.source.coordinate.startBeat = 0;
        input.source.coordinate.endBeat = (seconds * input.tempoBpm) / 60;
        input.source.clipStartTimeBeats = 16;
      }
      input.descriptor.registration = listenerRegistrationMetricSchema.parse({
        ...input.descriptor.registration,
        capabilities: [
          ...input.descriptor.registration.capabilities,
          "audio-listener/analyzer-timelines-v1",
          METRIC_CONTINUOUS_LISTENING_CAPABILITY,
        ],
        analyzerReadiness: createSyntheticAnalyzerReadiness(),
        nativeStatus: {
          ...input.descriptor.registration.nativeStatus,
          version: 6,
          scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
          readiness: "BLOCKED",
          reason: "fresh_per_pass_native_validation_required",
          executedGen: null,
          maxAudioDurationMs: 600_000,
          maxSessionAudioDurationMs: 600_000,
          maxReportRows: 39_961,
          maxSessionReportRows: 39_961,
          streamCapability: METRIC_RECORD_STREAM_CAPABILITY,
        },
      });
      const binding = createMetricCaptureBinding({
        ...input,
        ...(mode === "session" ? { stoppedBeat: 16 } : {}),
      });
      expect(binding.config.scope).toBe(
        NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
      );
      expect(binding.config.mode).toBe(mode);
      expect(binding.config.sourceContext).toEqual(input.source);
      expect(binding.config.geometry.startBeat).toBe(
        input.source.transport.startBeat,
      );
      expect(binding.config.geometry.endBeat).toBe(
        input.source.transport.endBeat,
      );
      if (binding.config.mode === "session") {
        expect(binding.config.stoppedBeat).toBe(16);
        expect(binding.config.sourceContext).toMatchObject({
          coordinate: {
            unit: "beats",
            iteration: 0,
            startBeat: 0,
            endBeat: (seconds * input.tempoBpm) / 60,
          },
          clipStartTimeBeats: 16,
          synchronization: "transport-coupled-first-iteration",
        });
      }
      expect(binding.config.geometry.totalSamples).toBe(
        Math.round(seconds * 48_000),
      );
      expect(binding.config.requestedMetrics).toEqual([
        "level",
        "spectral-centroid",
        "attacks",
        "mel-bands",
        "pitch",
        "spectral-shape",
      ]);
      expect(binding.config.attacks).toEqual({
        thresholdDb: 6,
        minSpacingSamples: 4800,
      });
    },
  );
  it.each([180, 600])(
    "builds a %ss all-six continuous config only from explicit producer status",
    (seconds) => {
      const { input } = fixture("arrangement");
      input.source.transport.endBeat =
        input.source.transport.startBeat + (seconds * input.tempoBpm) / 60;
      input.descriptor.registration = listenerRegistrationMetricSchema.parse({
        ...input.descriptor.registration,
        capabilities: [
          ...input.descriptor.registration.capabilities,
          "audio-listener/analyzer-timelines-v1",
          METRIC_CONTINUOUS_LISTENING_CAPABILITY,
        ],
        analyzerReadiness: createSyntheticAnalyzerReadiness(),
        nativeStatus: {
          ...input.descriptor.registration.nativeStatus,
          version: 6,
          scope: NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
          readiness: "BLOCKED",
          reason: "fresh_per_pass_native_validation_required",
          executedGen: null,
          maxAudioDurationMs: 600_000,
          maxSessionAudioDurationMs: 600_000,
          maxReportRows: 39_961,
          maxSessionReportRows: 39_961,
          streamCapability: METRIC_RECORD_STREAM_CAPABILITY,
        },
      });
      const binding = createMetricCaptureBinding(input);
      expect(binding.config.scope).toBe(
        NATIVE_CONTINUOUS_METRIC_LISTENING_SCOPE,
      );
      expect(binding.config.geometry.totalSamples).toBe(seconds * 48_000);
      expect(binding.config.requestedMetrics).toHaveLength(6);
      expect(binding.config.geometry.startSample).toBe(0);
    },
  );
  it.each(["arrangement", "session"] as const)(
    "does not silently split or fall back for unsupported continuous %s capture",
    (mode) => {
      const { input } = fixture(mode);
      input.source.transport.endBeat =
        input.source.transport.startBeat + (180 * input.tempoBpm) / 60;
      expect(() => createMetricCaptureBinding(input)).toThrow(
        "continuous_metric_stream_unavailable",
      );
    },
  );
  it("requests authoritative analyzers by default only after producer capability admission", () => {
    const { input } = admittedFixture("session");
    const binding = createMetricCaptureBinding(input);
    expect(binding.descriptor.registration).toHaveProperty(
      "analyzerReadiness",
      createSyntheticAnalyzerReadiness(),
    );
    expect(
      Object.isFrozen(binding.descriptor.registration.analyzerReadiness),
    ).toBe(true);
    expect(binding.config.requestedMetrics).toEqual([
      "level",
      "spectral-centroid",
      "attacks",
      "mel-bands",
      "pitch",
      "spectral-shape",
    ]);
  });
  it("rejects a capability-only descriptor before admitting analyzer capture defaults", () => {
    const { input } = fixture("session");
    Object.assign(input.descriptor.registration, {
      capabilities: [
        ...input.descriptor.registration.capabilities,
        "audio-listener/analyzer-timelines-v1",
      ],
    });
    expect(() => createMetricCaptureBinding(input)).toThrow(
      "readiness receipt",
    );
  });
  it.each(["pitch", "spectral-shape"] as const)(
    "denies explicit %s requests against old diagnostic-only capabilities",
    (metric) => {
      const { input } = fixture("arrangement");
      expect(() =>
        createMetricCaptureBinding({ ...input, requestedMetrics: [metric] }),
      ).toThrow("continuous_metric_stream_unavailable");
    },
  );
  it.each(["arrangement", "session"] as const)(
    "freezes an explicit level-only %s request without silently dropping admitted analyzers",
    (mode) => {
      const { input } = admittedFixture(mode);
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
      const { input, data } = admittedFixture(mode);
      const binding = createMetricCaptureBinding(input);
      expect(binding.config.sourceContext).toEqual(data.observation.source);
      expect(binding.config.geometry).toMatchObject({
        sampleRate: data.config.geometry.sampleRate,
        totalSamples: data.config.geometry.totalSamples,
        startBeat: data.config.geometry.startBeat,
        endBeat: data.config.geometry.endBeat,
        captureMode: "finite-metric-stream",
      });
      expect(binding.config.requestedMetrics).toEqual([
        "level",
        "spectral-centroid",
        "attacks",
        "mel-bands",
        "pitch",
        "spectral-shape",
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
    const { input } = admittedFixture("arrangement");
    input.descriptor.registration = listenerRegistrationMetricSchema.parse({
      ...input.descriptor.registration,
      sampleRate: 44_100,
      analyzerReadiness: {
        ...createSyntheticAnalyzerReadiness(),
        sampleRate: 44_100,
      },
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
    const { input } = admittedFixture("session");
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

  it("rejects ranges beyond the finite 600-second acquisition ceiling", () => {
    const { input } = admittedFixture("arrangement");
    input.source.transport.endBeat = 1200.001;
    expect(() => createMetricCaptureBinding(input)).toThrow();
  });
});
